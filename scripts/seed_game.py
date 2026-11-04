"""
游戏广告转化分析造数 Glue Job(Glue 5.1)—— 幂等灌 7 张关联表到源 MySQL gamedata 库。
在 Glue 容器内运行(VPC 私有子网连 RDS),符合"造数走 Glue 不本机直连 DB"红线。
依赖 pymysql:--additional-python-modules pymysql 运行时安装。凭证从 Secrets Manager 读,不硬编码。

游戏买量分析场景 7 表(可算:广告转化率 install/click、ROAS 充值/花费、留存、付费率):
  ad_channels    6          广告渠道(Google/Meta/TikTok/AppLovin/Unity/Organic)
  ad_campaigns   ~40        广告活动(挂渠道,含花费/目标国家)
  player_events  ~8500000   玩家行为事件流(最大事实表:login/battle/level_up/item_use/purchase 等)
  ad_events      ~2000000   曝光/点击流水(impression/click,含渠道/国家/OS/花费)
  game_sessions  ~800000    游戏会话(玩家/时长/到达关卡)
  players        ~100000    玩家(含归因来源渠道/活动,安装时间/国家/OS/是否付费)
  payments       ~60000     充值(玩家/金额/时间/道具)
表量级(贴近真实手游):行为事件 >> 广告曝光 > 会话 > 玩家 > 付费。
关联:ad_campaigns.channel_id→ad_channels / ad_events.campaign_id→ad_campaigns /
      players.source_campaign_id→ad_campaigns / game_sessions.player_id→players /
      payments.player_id→players / player_events.player_id→players
"""
import os, sys, json, random, datetime
import boto3
from awsglue.utils import getResolvedOptions

args = getResolvedOptions(sys.argv, ["JOB_NAME", "secret_arn", "host", "database"])
SECRET_ARN = args["secret_arn"]; HOST = args["host"]; DB = args["database"]

sm = boto3.client("secretsmanager", region_name="us-east-1")
sec = json.loads(sm.get_secret_value(SecretId=SECRET_ARN)["SecretString"])
USER = sec["username"]; PWD = sec["password"]; PORT = int(sec.get("port", 3306))

import pymysql
random.seed(42)  # 可复现

conn = pymysql.connect(host=HOST, port=PORT, user=USER, password=PWD, autocommit=False, charset="utf8mb4")
cur = conn.cursor()

# ── 基建前置(根因治理·坑3):RDS binlog 保留窗口 ─────────────────────────────
# RDS binlog 保留由存储过程控制,**默认 NULL = 备份完尽快清**(参数组的 binlog_expire_logs_seconds
# 是引擎默认值,对 RDS 不生效)。Flink CDC / DMS CDC 作业【从快照或断点恢复】时若超出该窗口,
# 源端位点已回收 → `IllegalStateException: ... binlog ... no longer available on the server`
# → 崩溃循环且**不自愈**。实测 2026-07-25:相隔 1h54m 位点即消失。声明式设 72h,幂等。
# 见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md §9。
BINLOG_RETENTION_HOURS = int(os.environ.get("BGP_BINLOG_RETENTION_HOURS", "72"))
try:
    cur.execute("CALL mysql.rds_set_configuration('binlog retention hours', %s)", (BINLOG_RETENTION_HOURS,))
    conn.commit()
    cur.execute("CALL mysql.rds_show_configuration")
    shown = {r[0]: r[1] for r in cur.fetchall()}
    print(f"[binlog] retention hours 已设为 {BINLOG_RETENTION_HOURS}(实读: {shown.get('binlog retention hours')})")
except Exception as e:
    print(f"[binlog] WARN 设置 binlog retention 失败(非 RDS 或权限不足?): {e}")

print(f"Connected to {HOST}:{PORT}, ensuring database {DB} ...")
cur.execute(f"CREATE DATABASE IF NOT EXISTS {DB} CHARACTER SET utf8mb4")
cur.execute(f"USE {DB}")

# 幂等:先删后建(子表先删)
for t in ["player_events", "payments", "game_sessions", "players", "ad_events", "ad_campaigns", "ad_channels"]:
    cur.execute(f"DROP TABLE IF EXISTS {t}")
print("Dropped old tables.")

cur.execute("""
CREATE TABLE ad_channels (
  channel_id    INT PRIMARY KEY,
  channel_name  VARCHAR(40) NOT NULL,
  channel_type  VARCHAR(20) NOT NULL,          -- paid / organic
  created_at    DATETIME NOT NULL
)""")
cur.execute("""
CREATE TABLE ad_campaigns (
  campaign_id     INT PRIMARY KEY,
  channel_id      INT NOT NULL,
  campaign_name   VARCHAR(80) NOT NULL,
  target_country  VARCHAR(8) NOT NULL,
  cost_usd        DECIMAL(14,2) NOT NULL,       -- 活动总花费
  start_date      DATE NOT NULL,
  status          VARCHAR(16) NOT NULL,
  KEY idx_channel (channel_id)
)""")
cur.execute("""
CREATE TABLE ad_events (
  event_id     BIGINT PRIMARY KEY,
  campaign_id  INT NOT NULL,
  channel_id   INT NOT NULL,
  device_id    VARCHAR(40) NOT NULL,
  event_type   VARCHAR(16) NOT NULL,            -- impression / click
  country      VARCHAR(8) NOT NULL,
  os           VARCHAR(12) NOT NULL,            -- iOS / Android
  cost_usd     DECIMAL(10,4) NOT NULL,          -- 单次曝光/点击成本
  event_time   DATETIME NOT NULL,
  KEY idx_campaign (campaign_id),
  KEY idx_time (event_time)
)""")
cur.execute("""
CREATE TABLE players (
  player_id          BIGINT PRIMARY KEY,
  install_time       DATETIME NOT NULL,
  source_channel_id  INT NOT NULL,
  source_campaign_id INT,                       -- 归因活动(organic 为 NULL)
  country            VARCHAR(8) NOT NULL,
  os                 VARCHAR(12) NOT NULL,
  is_paying          TINYINT NOT NULL DEFAULT 0,
  KEY idx_src_ch (source_channel_id),
  KEY idx_install (install_time)
)""")
cur.execute("""
CREATE TABLE game_sessions (
  session_id    BIGINT PRIMARY KEY,
  player_id     BIGINT NOT NULL,
  start_time    DATETIME NOT NULL,
  duration_sec  INT NOT NULL,
  level_reached INT NOT NULL,
  KEY idx_player (player_id)
)""")
cur.execute("""
CREATE TABLE payments (
  payment_id  BIGINT PRIMARY KEY,
  player_id   BIGINT NOT NULL,
  amount_usd  DECIMAL(10,2) NOT NULL,
  product_id  VARCHAR(24) NOT NULL,             -- gems_pack_s / m / l / vip
  pay_time    DATETIME NOT NULL,
  KEY idx_player (player_id)
)""")
cur.execute("""
CREATE TABLE player_events (
  event_id    BIGINT PRIMARY KEY,
  player_id   BIGINT NOT NULL,
  event_name  VARCHAR(24) NOT NULL,             -- login / level_up / purchase / tutorial_done
  level       INT NOT NULL,
  event_time  DATETIME NOT NULL,
  KEY idx_player (player_id)
)""")
print("Created 7 tables.")

# ── ad_channels 6 ────────────────────────────────────────────────────────────
CHANNELS = [
    (1, "Google Ads", "paid"), (2, "Meta Ads", "paid"), (3, "TikTok Ads", "paid"),
    (4, "AppLovin", "paid"), (5, "Unity Ads", "paid"), (6, "Organic", "organic"),
]
base_day = datetime.datetime(2026, 6, 1, 8, 0, 0)
cur.executemany("INSERT INTO ad_channels VALUES (%s,%s,%s,%s)",
                [(c[0], c[1], c[2], base_day + datetime.timedelta(minutes=c[0])) for c in CHANNELS])
print(f"ad_channels: {len(CHANNELS)}")

COUNTRIES = ["US", "JP", "KR", "DE", "GB", "BR", "IN", "CN"]
OSES = ["iOS", "Android"]

# ── ad_campaigns ~40(每付费渠道 8 个活动;organic 无活动) ─────────────────────
camp_rows = []
camp_country = {}     # campaign_id -> country
camp_channel = {}     # campaign_id -> channel_id
paid_campaigns = []
cid = 1
for ch in CHANNELS:
    if ch[2] == "organic":
        continue
    for k in range(8):
        country = random.choice(COUNTRIES)
        cost = round(random.uniform(2000, 50000), 2)
        start = datetime.date(2026, 6, 10) + datetime.timedelta(days=random.randint(0, 5))
        status = random.choices(["active", "paused", "ended"], weights=[0.6, 0.2, 0.2])[0]
        camp_rows.append((cid, ch[0], f"{ch[1]}-{country}-{k+1}", country, cost, start, status))
        camp_country[cid] = country
        camp_channel[cid] = ch[0]
        paid_campaigns.append(cid)
        cid += 1
cur.executemany("INSERT INTO ad_campaigns VALUES (%s,%s,%s,%s,%s,%s,%s)", camp_rows)
conn.commit()
print(f"ad_campaigns: {len(camp_rows)}")

START = datetime.datetime(2026, 6, 15, 0, 0, 0)
SPAN_SEC = 14 * 24 * 3600  # 两周

# ── ad_events ~2M(impression 多、click 少;click 后部分转化为 install) ──────
# 设计:每活动一批曝光,点击率 ~4%,点击里 ~35% 转化成玩家(install)。
N_AD = 2000000
BATCH = 5000
ad_buf = []
ad_id = 1
# 记录部分 click 事件,作为后续 install 的归因来源
click_pool = []   # (campaign_id, channel_id, country, os, click_time, device_id)
def flush_ad():
    global ad_buf
    if ad_buf:
        cur.executemany("INSERT INTO ad_events VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", ad_buf)
        ad_buf = []
        conn.commit()
for _ in range(N_AD):
    camp = random.choice(paid_campaigns)
    ch = camp_channel[camp]
    country = camp_country[camp] if random.random() < 0.7 else random.choice(COUNTRIES)
    os_ = random.choice(OSES)
    et = "click" if random.random() < 0.04 else "impression"
    cost = round(random.uniform(0.3, 2.5), 4) if et == "click" else round(random.uniform(0.002, 0.02), 4)
    t = START + datetime.timedelta(seconds=random.randint(0, SPAN_SEC - 1))
    dev = f"dev-{random.randint(1, 1500000):07d}"
    ad_buf.append((ad_id, camp, ch, dev, et, country, os_, cost, t))
    if et == "click" and random.random() < 0.35 and len(click_pool) < 80000:
        click_pool.append((camp, ch, country, os_, t, dev))
    ad_id += 1
    if len(ad_buf) >= BATCH:
        flush_ad()
flush_ad()
print(f"ad_events: {ad_id-1}  (click->install pool: {len(click_pool)})")

# ── players ~100k(归因:一部分来自 click_pool 买量,其余 organic 自然量) ──────
N_ORGANIC = 72000
players = []          # player_id list
player_install = {}   # pid -> install_time
player_country = {}
player_os = {}
pid = 1
pl_buf = []
def flush_pl():
    global pl_buf
    if pl_buf:
        cur.executemany("INSERT INTO players VALUES (%s,%s,%s,%s,%s,%s,%s)", pl_buf)
        pl_buf = []
        conn.commit()
# 归因玩家(install 时间 = click 时间后 0-2 小时)
for (camp, ch, country, os_, ctime, dev) in click_pool:
    install = ctime + datetime.timedelta(seconds=random.randint(60, 7200))
    pl_buf.append((pid, install, ch, camp, country, os_, 0))
    players.append(pid); player_install[pid] = install; player_country[pid] = country; player_os[pid] = os_
    pid += 1
    if len(pl_buf) >= BATCH: flush_pl()
# 自然量玩家(organic channel=6,无归因活动)
for _ in range(N_ORGANIC):
    install = START + datetime.timedelta(seconds=random.randint(0, SPAN_SEC - 1))
    country = random.choice(COUNTRIES); os_ = random.choice(OSES)
    pl_buf.append((pid, install, 6, None, country, os_, 0))
    players.append(pid); player_install[pid] = install; player_country[pid] = country; player_os[pid] = os_
    pid += 1
    if len(pl_buf) >= BATCH: flush_pl()
flush_pl()
print(f"players: {len(players)}")

# ── payments ~60k(~18% 玩家付费,付费者 1-6 笔) ──────────────────────────────
PRODUCTS = ["gems_pack_s", "gems_pack_m", "gems_pack_l", "vip_month", "starter_pack"]
PRICE = {"gems_pack_s": 4.99, "gems_pack_m": 19.99, "gems_pack_l": 49.99, "vip_month": 9.99, "starter_pack": 2.99}
pay_id = 1
pay_buf = []
paying_players = set()
def flush_pay():
    global pay_buf
    if pay_buf:
        cur.executemany("INSERT INTO payments VALUES (%s,%s,%s,%s,%s)", pay_buf)
        pay_buf = []
        conn.commit()
for p in players:
    if random.random() < 0.18:
        paying_players.add(p)
        n = random.randint(1, 6)
        for _ in range(n):
            prod = random.choices(PRODUCTS, weights=[0.35, 0.25, 0.12, 0.13, 0.15])[0]
            pt = player_install[p] + datetime.timedelta(seconds=random.randint(3600, SPAN_SEC))
            pay_buf.append((pay_id, p, PRICE[prod], prod, pt))
            pay_id += 1
        if len(pay_buf) >= BATCH: flush_pay()
flush_pay()
print(f"payments: {pay_id-1}  (paying players: {len(paying_players)})")

# 回填 players.is_paying
if paying_players:
    ids = list(paying_players)
    for i in range(0, len(ids), 1000):
        chunk = ids[i:i+1000]
        cur.execute(f"UPDATE players SET is_paying=1 WHERE player_id IN ({','.join(map(str,chunk))})")  # nosec B608 —— chunk 是脚本自己生成的整数 id
    conn.commit()
print("players.is_paying updated.")

# ── game_sessions ~800k(每玩家 1-15 次会话) ─────────────────────────────────
sess_id = 1
sess_buf = []
def flush_sess():
    global sess_buf
    if sess_buf:
        cur.executemany("INSERT INTO game_sessions VALUES (%s,%s,%s,%s,%s)", sess_buf)
        sess_buf = []
        conn.commit()
player_maxlevel = {}
for p in players:
    n = random.randint(1, 15)
    lvl = 1
    for _ in range(n):
        st = player_install[p] + datetime.timedelta(seconds=random.randint(0, SPAN_SEC))
        dur = random.randint(30, 3600)
        lvl = min(60, lvl + random.randint(0, 4))
        sess_buf.append((sess_id, p, st, dur, lvl))
        sess_id += 1
    player_maxlevel[p] = lvl
    if len(sess_buf) >= BATCH: flush_sess()
flush_sess()
print(f"game_sessions: {sess_id-1}")

# ── player_events ~8M(行为事件流是最大的事实表 —— 每玩家 20-150 条) ──────────
# 行为埋点是游戏分析的"消防栓":每次会话产生多条事件,故此表远大于会话/付费/广告曝光。
# 事件类型贴近真实手游埋点;purchase 仅付费玩家高权重(与 payments 呼应)。
EV_NAMES  = ["login", "session_start", "battle_start", "battle_end", "level_up",
             "item_use", "tutorial_done", "quest_complete", "ad_watched",
             "friend_invite", "logout", "purchase"]
EV_W_PAY  = [0.14, 0.14, 0.16, 0.15, 0.10, 0.10, 0.02, 0.05, 0.05, 0.02, 0.05, 0.02]
EV_W_FREE = [0.15, 0.15, 0.17, 0.16, 0.10, 0.10, 0.02, 0.05, 0.05, 0.02, 0.03, 0.00]
ev_id = 1
ev_buf = []
def flush_ev():
    global ev_buf
    if ev_buf:
        cur.executemany("INSERT INTO player_events VALUES (%s,%s,%s,%s,%s)", ev_buf)
        ev_buf = []
        conn.commit()
for p in players:
    # 事件量随参与度(会话数近似)放大;付费玩家更活跃
    n = random.randint(20, 150) + (random.randint(0, 60) if p in paying_players else 0)
    w = EV_W_PAY if p in paying_players else EV_W_FREE
    maxlvl = player_maxlevel.get(p, 1)
    for _ in range(n):
        name = random.choices(EV_NAMES, weights=w)[0]
        et = player_install[p] + datetime.timedelta(seconds=random.randint(0, SPAN_SEC))
        ev_buf.append((ev_id, p, name, random.randint(1, maxlvl), et))
        ev_id += 1
    if len(ev_buf) >= BATCH: flush_ev()
flush_ev()
print(f"player_events: {ev_id-1}")

# 汇总校验
cur.execute("SELECT (SELECT count(*) FROM ad_channels),(SELECT count(*) FROM ad_campaigns),(SELECT count(*) FROM ad_events),(SELECT count(*) FROM players),(SELECT count(*) FROM game_sessions),(SELECT count(*) FROM payments),(SELECT count(*) FROM player_events)")
print("FINAL COUNTS (channels,campaigns,ad_events,players,sessions,payments,player_events):", cur.fetchone())
conn.commit()
cur.close(); conn.close()
print("Game ad-analytics dataset loaded into gamedata.")
