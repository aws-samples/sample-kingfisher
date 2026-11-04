"""
电商造数 Glue Job(Glue 5.1)—— 幂等灌 4 张关联表到源 MySQL ecommerce 库。
在 Glue 容器内运行(VPC 私有子网连 RDS),符合"造数走 Glue 不本机直连 DB"红线。
依赖 pymysql:--additional-python-modules pymysql 运行时安装。
凭证从 Secrets Manager 读(--secret_arn),不硬编码。

电商场景表(用户指定规模):
  products     50        产品 SKU(sku 编码/品名/类目/品牌/单价)
  fx_rates     70        汇率(5 币种 × 14 天)
  orders       100000    订单(2026-06-15 ~ 2026-06-28 两周)
  order_items  ~30万     订单明细(每单 1-5 行)
关联:order_items.order_id→orders / order_items.product_id→products /
      orders.currency+DATE(created_at)→fx_rates.currency+rate_date
"""
import os, sys, json, random, datetime
import boto3
from awsglue.utils import getResolvedOptions

args = getResolvedOptions(sys.argv, ["JOB_NAME", "secret_arn", "host", "database"])
SECRET_ARN = args["secret_arn"]
HOST = args["host"]
DB = args["database"]

sm = boto3.client("secretsmanager", region_name="us-east-1")
sec = json.loads(sm.get_secret_value(SecretId=SECRET_ARN)["SecretString"])
USER = sec["username"]
PWD = sec["password"]
PORT = int(sec.get("port", 3306))

import pymysql

# 固定随机种子,保证可复现
random.seed(42)

conn = pymysql.connect(host=HOST, port=PORT, user=USER, password=PWD, autocommit=False, charset="utf8mb4")
cur = conn.cursor()

# ── 基建前置(根因治理·坑3):RDS binlog 保留窗口 ─────────────────────────────
# 为什么:RDS 的 binlog 保留由存储过程 mysql.rds_set_configuration('binlog retention hours', N)
# 控制,**默认 NULL = 备份完就尽快清**(参数组里的 binlog_expire_logs_seconds=2592000 是引擎默认值,
# 对 RDS 不生效)。后果:Flink CDC / DMS CDC 作业【从快照或断点恢复】时,若距上次运行超过这个窗口,
# 源端 binlog 位点已被回收 → `IllegalStateException: The connector is trying to read binlog
# starting at ... but this is no longer available on the server` → 作业崩溃循环且**不自愈**。
# 实测(2026-07-25):作业 11:13 打快照、13:07 恢复(相隔 1h54m),位点即已消失 → fullRestarts 持续攀升。
# 治理:声明式设为 72h,让"停一两天再启动"的常规运维不会踩位点过期。幂等(重复设置无副作用)。
# 见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md §9(binlog 保留缺陷)。
BINLOG_RETENTION_HOURS = int(os.environ.get("BGP_BINLOG_RETENTION_HOURS", "72"))
try:
    cur.execute("CALL mysql.rds_set_configuration('binlog retention hours', %s)", (BINLOG_RETENTION_HOURS,))
    conn.commit()
    cur.execute("CALL mysql.rds_show_configuration")
    shown = {r[0]: r[1] for r in cur.fetchall()}
    print(f"[binlog] retention hours 已设为 {BINLOG_RETENTION_HOURS}(实读: {shown.get('binlog retention hours')})")
except Exception as e:
    # 非致命:非 RDS(如自建 MySQL)无此存储过程。造数本身不依赖它,只降级告警。
    print(f"[binlog] WARN 设置 binlog retention 失败(非 RDS 或权限不足?): {e}")

print(f"Connected to {HOST}:{PORT}, ensuring database {DB} ...")
cur.execute(f"CREATE DATABASE IF NOT EXISTS {DB} CHARACTER SET utf8mb4")
cur.execute(f"USE {DB}")

# ── 幂等:先删后建(子表先删) ──────────────────────────────────────────────
for t in ["order_items", "orders", "products", "fx_rates"]:
    cur.execute(f"DROP TABLE IF EXISTS {t}")
print("Dropped old tables.")

cur.execute("""
CREATE TABLE products (
  product_id   INT PRIMARY KEY,
  sku          VARCHAR(32)  NOT NULL UNIQUE,
  product_name VARCHAR(120) NOT NULL,
  category     VARCHAR(40)  NOT NULL,
  brand        VARCHAR(40)  NOT NULL,
  unit_price   DECIMAL(12,2) NOT NULL,
  status       VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at   DATETIME NOT NULL
)""")

cur.execute("""
CREATE TABLE fx_rates (
  rate_id    INT PRIMARY KEY,
  currency   VARCHAR(8)  NOT NULL,
  rate_date  DATE        NOT NULL,
  rate_to_usd DECIMAL(12,6) NOT NULL,
  UNIQUE KEY uk_ccy_date (currency, rate_date)
)""")

cur.execute("""
CREATE TABLE orders (
  order_id     BIGINT PRIMARY KEY,
  customer_id  INT NOT NULL,
  region       VARCHAR(20) NOT NULL,
  channel      VARCHAR(20) NOT NULL,
  status       VARCHAR(16) NOT NULL,
  currency     VARCHAR(8)  NOT NULL,
  order_amount DECIMAL(14,2) NOT NULL,
  created_at   DATETIME NOT NULL,
  updated_at   DATETIME NOT NULL,
  KEY idx_created (created_at)
)""")

cur.execute("""
CREATE TABLE order_items (
  item_id     BIGINT PRIMARY KEY,
  order_id    BIGINT NOT NULL,
  product_id  INT NOT NULL,
  sku         VARCHAR(32) NOT NULL,
  quantity    INT NOT NULL,
  unit_price  DECIMAL(12,2) NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  KEY idx_order (order_id)
)""")
print("Created 4 tables.")

# ── products 50(含 SKU 编码/品牌) ─────────────────────────────────────────
CATEGORIES = ["Electronics", "Books", "Home", "Toys", "Apparel", "Grocery", "Sports", "Beauty"]
BRANDS = ["Aurora", "Nimbus", "Vertex", "Solace", "Pinnacle", "Harbor", "Zephyr", "Crest"]
prod_rows = []
prod_price = {}
prod_sku = {}
base_day = datetime.datetime(2026, 6, 1, 9, 0, 0)
for pid in range(1, 51):
    price = round(random.uniform(5, 2000), 2)
    cat = random.choice(CATEGORIES)
    sku = f"SKU-{cat[:3].upper()}-{pid:05d}"
    prod_price[pid] = price
    prod_sku[pid] = sku
    prod_rows.append((pid, sku, f"Product-{pid:03d}", cat, random.choice(BRANDS), price, "active",
                      base_day + datetime.timedelta(minutes=pid)))
cur.executemany("INSERT INTO products VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", prod_rows)
print(f"products: {len(prod_rows)}")

# ── fx_rates 70(5 币种 × 14 天) ──────────────────────────────────────────
CURRENCIES = {"USD": 1.0, "EUR": 1.08, "GBP": 1.27, "JPY": 0.0064, "CNY": 0.14}
fx_rows = []
rid = 1
for d in range(14):
    rate_date = datetime.date(2026, 6, 15) + datetime.timedelta(days=d)
    for ccy, base in CURRENCIES.items():
        jitter = base * random.uniform(0.98, 1.02)
        fx_rows.append((rid, ccy, rate_date, round(jitter, 6)))
        rid += 1
cur.executemany("INSERT INTO fx_rates VALUES (%s,%s,%s,%s)", fx_rows)
print(f"fx_rates: {len(fx_rows)}")

# ── orders 10万(两周) + order_items(每单 1-5 行) ────────────────────────
REGIONS = ["North", "South", "East", "West", "Central"]
CHANNELS = ["web", "app", "store", "partner"]
STATUS = ["paid", "pending", "shipped", "cancelled", "refunded"]
STATUS_W = [0.55, 0.15, 0.20, 0.07, 0.03]
CCY_LIST = list(CURRENCIES.keys())

N_ORDERS = 100000
START = datetime.datetime(2026, 6, 15, 0, 0, 0)
SPAN_SEC = 14 * 24 * 3600

BATCH = 5000
order_buf = []
item_buf = []
item_id = 1
total_items = 0

def flush():
    global order_buf, item_buf
    if order_buf:
        cur.executemany("INSERT INTO orders VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", order_buf)
        order_buf = []
    if item_buf:
        cur.executemany("INSERT INTO order_items VALUES (%s,%s,%s,%s,%s,%s,%s)", item_buf)
        item_buf = []
    conn.commit()

for oid in range(1, N_ORDERS + 1):
    created = START + datetime.timedelta(seconds=random.randint(0, SPAN_SEC - 1))
    status = random.choices(STATUS, weights=STATUS_W)[0]
    ccy = random.choice(CCY_LIST)
    n_items = random.randint(1, 5)
    order_amt = 0.0
    for _ in range(n_items):
        pid = random.randint(1, 50)
        qty = random.randint(1, 6)
        up = prod_price[pid]
        amt = round(up * qty, 2)
        order_amt += amt
        item_buf.append((item_id, oid, pid, prod_sku[pid], qty, up, amt))
        item_id += 1
    updated = created + datetime.timedelta(minutes=random.randint(0, 240))
    order_buf.append((oid, random.randint(1, 5000), random.choice(REGIONS), random.choice(CHANNELS),
                      status, ccy, round(order_amt, 2), created, updated))
    total_items += n_items
    if oid % BATCH == 0:
        flush()
        if oid % 20000 == 0:
            print(f"  orders progress: {oid}/{N_ORDERS}")
flush()
print(f"orders: {N_ORDERS}")
print(f"order_items: {total_items}")

# ── 核验行数(铁证输出) ────────────────────────────────────────────────────
for t in ["products", "fx_rates", "orders", "order_items"]:
    cur.execute(f"SELECT COUNT(*) FROM {t}")  # nosec B608 —— 表名来自脚本内常量列表,非用户输入
    print(f"VERIFY {t} = {cur.fetchone()[0]}")
cur.execute("SELECT MIN(created_at), MAX(created_at) FROM orders")
mn, mx = cur.fetchone()
print(f"VERIFY orders date range: {mn} .. {mx}")
cur.execute("SELECT COUNT(DISTINCT customer_id) FROM orders")
print(f"VERIFY distinct customers = {cur.fetchone()[0]}")
cur.execute("SELECT status, COUNT(*) FROM orders GROUP BY status")
print(f"VERIFY status dist = {cur.fetchall()}")
cur.execute("SELECT COUNT(*) FROM order_items oi JOIN products p ON oi.product_id=p.product_id AND oi.sku=p.sku")
print(f"VERIFY item-sku join = {cur.fetchone()[0]}")

cur.close()
conn.close()
print("SEED DONE.")
