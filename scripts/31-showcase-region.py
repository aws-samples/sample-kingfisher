#!/usr/bin/env python3
"""
31-showcase-region.py —— 在**某个执行环境自己的 region** 用产品 API 建出一套**长期保留**的示范对象,
并(stage=run/all)把它们真跑到成功:数据源 → 同步任务 → 三引擎离线 ETL → 编排(发布 + 定时 + 触发一次)
→ 数据治理(质量规则 + 评估)→ 数据建模(码表落地 / 维度表应用)。

    python3 scripts/31-showcase-region.py --profile temp-account --target tgt_usw2_a [--stage create|run|all]

为什么有这个脚本(用户 2026-09-18 原话:「造数据、跑数据、计算、ETL、编排、数据治理、数据建模,
这些都全部在多个 region 下发执行,都要成功」,而他打开网站切到第二个区看到的是**空的**):
  · 无头验收(qa-game/verify)自造夹具、验完删净 ⇒ 判据全绿,用户眼里什么都没有;
  · 这里建的对象**不删**,就是用户切到该区视角应当看见的那一套;名字带 `Showcase-<slug>-` 前缀,幂等(按名复用)。
数据前置:该区湖里要有 `23-seed-game-region.sh` 造好的 gamedata parquet(非 home);home 用真源库
(`22-seed-game.sh` 灌好的 RDS MySQL gamedata)。
🔴 一切落点(region / 桶 / 工作组 / 凭证)都由**平台按执行环境解析**,本脚本一个落点值都不传(留空);
   只有「章」(targetId / targets)是本脚本给的 —— 它就是「在哪个区跑」的唯一表达。
🔴 只写用户指名的 profile;账号号不进任何输出文件。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

import boto3

HOME_TARGET = "tgt_home"
# 🔴 示范对象**自己的** schema / S3Tables namespace:不写 `public` / `gamedata`。
# 理由(2026-09-18 真环境):源侧 schema 一变(列名对齐主控区),既有 `public.*` / `gamedata.*` 目标表
# 就成了旧列的表,而同步是 DELETE + INSERT 不重建表 ⇒ 产品**响亮报** INSERT_COLUMN_ARITY_MISMATCH
# (这是对的行为)。示范对象独占一个 schema/namespace ⇒ 首次即新建、重跑幂等、**零删除**,
# 也不与验收段(它们用带时间戳的表名)和既有数据集抢名字。
SHOWCASE_SCHEMA = "showcase"
TABLES = ["ad_channels", "ad_campaigns", "players", "game_sessions", "payments", "player_events"]
HOME_ALL_TABLES = ["ad_channels", "ad_campaigns", "ad_events", "players", "game_sessions", "payments", "player_events"]


def log(msg: str) -> None:
    print(f"[showcase] {msg}", flush=True)


# ── AWS 侧真值(注册表 / CFN 输出 / Cognito)────────────────────────────────────
def cfn_out(cf, stack: str, key: str) -> str:
    try:
        outs = cf.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs") or []
    except Exception:
        return ""
    for o in outs:
        if o.get("OutputKey") == key:
            return o.get("OutputValue") or ""
    return ""


def target_row(ddb, tid: str) -> dict:
    r = ddb.get_item(TableName="bgp-execution-envs", Key={"pk": {"S": "env"}, "sk": {"S": tid}}).get("Item")
    if not r:
        raise SystemExit(f"注册表里没有执行环境 {tid}(先在「执行环境」页注册并部署完成)")
    res = {k: (list(v.values())[0]) for k, v in (r.get("resources", {}).get("M") or {}).items() if "S" in v}
    return {"targetId": tid, "region": r["region"]["S"], "status": (r.get("status") or {}).get("S"), "resources": res}


def admin_password(profile: str) -> str:
    pw = os.environ.get("BGP_ADMIN_PASSWORD", "")
    if pw:
        return pw
    f = os.environ.get("BGP_PW_FILE", f"/tmp/bgp-cognito-pw-{profile}.json")
    try:
        return json.load(open(f))["admin"]
    except Exception:
        raise SystemExit(f"拿不到 admin 口令:env BGP_ADMIN_PASSWORD 未设,且 {f} 里也没有")


# ── 平台 API(Bearer)──────────────────────────────────────────────────────────
# 模块 55 长操作统一框架(platform/src/lib/long-ops/protocol.ts):已接入的路由在 45 秒内没到终态就回
# **202 + `protocol:"long-op/1"`**(建源 B-129 · 引擎作业「运行」B-136 · 编排发布 / 触发 · Flink 启停 …),
# 浏览器里由全局 fetch 拦截器轮询 `GET /api/long-ops/<taskId>` 到终态再整形成与同步响应同形的状态码 / 信封。
# 这里按 lib/long-ops/client/follow.ts 同一口径整形,调用点零改动 —— 判据看到的 HTTP 状态与页面用户看到的逐字一致。
# 🔴 2026-10-29 B-136 之前 EMR「运行」冷启动在请求路径上等 ~60s ⇒ 这里拿到的是 CloudFront 504 HTML;接成长操作后
#   同一处会拿到 202,不跟进就会把「正在后台提交」误判成红(判据自己的缺陷,不是产品)。
LONG_OP_PROTOCOL = "long-op/1"
LONG_OPS_API = "/api/long-ops"
LONG_OP_TIMEOUT_MESSAGE = "操作超过 5 分钟已自动终止,请缩小范围后重试"


class Api:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.h = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-bgp-project": "proj-default",
            "x-bgp-env": "dev",
        }
        # 最近一次 call 是否经由 202 轮询整形(taskId;None = 同步响应)—— 收官表据此标明「这条走了长操作」
        self.last_long_op: str | None = None

    def _raw(self, method: str, path: str, body=None, timeout: int = 180):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=self.h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # nosec B310 # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected —— 目标是本平台 CloudFront 地址(来自栈输出),开发机脚本
                txt = r.read().decode()
                return r.status, (json.loads(txt) if txt else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors="replace")
            try:
                return e.code, json.loads(txt)
            except Exception:
                return e.code, {"raw": txt[:500]}

    def call(self, method: str, path: str, body=None, timeout: int = 180):
        self.last_long_op = None
        st, j = self._raw(method, path, body, timeout)
        d = data_of(j)
        if st == 202 and isinstance(d, dict) and d.get("protocol") == LONG_OP_PROTOCOL and d.get("taskId"):
            return self._follow_long_op(d)
        return st, j

    def _follow_long_op(self, accepted: dict):
        """轮询到终态并按 follow.ts 的 terminalToResponse 整形(succeeded ⇒ resultStatus ?? 200 + 信封 / rawBody 原样;
        failed ⇒ errorStatus ?? 500 + errorBody 原信封;timeout ⇒ 504)。轮询请求本身非 200 ⇒ 如实回那次的状态。"""
        task_id = str(accepted["taskId"])
        self.last_long_op = task_id
        log(f"  … 「{accepted.get('label') or accepted.get('kind')}」走长操作 202(taskId={task_id}),轮询到终态")
        t0 = time.time()
        while time.time() - t0 < 330:  # 服务端天花板 300s + 余量
            time.sleep(2)
            st, j = self._raw("GET", f"{LONG_OPS_API}/{task_id}", None, 60)
            if st != 200:
                return st, j
            state = data_of(j) or {}
            status = state.get("status") if isinstance(state, dict) else None
            if status == "succeeded":
                rs = int(state.get("resultStatus") or 200)
                if state.get("resultRaw"):
                    return rs, state.get("result")
                out = {"success": True, "data": state.get("result")}
                if isinstance(j, dict) and j.get("_meta") is not None:
                    out["_meta"] = j["_meta"]
                return rs, out
            if status == "failed":
                es = int(state.get("errorStatus") or 500)
                eb = state.get("errorBody")
                if isinstance(eb, dict):
                    return es, eb
                return es, {"success": False, "status": es, "error": {"message": state.get("error") or "执行失败", "code": "UPSTREAM_ERROR"}}
            if status == "timeout":
                break
        return 504, {"success": False, "status": 504, "error": {"message": LONG_OP_TIMEOUT_MESSAGE, "code": "UPSTREAM_TIMEOUT"}}

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body):
        return self.call("POST", path, body)


def data_of(j):
    return j.get("data") if isinstance(j, dict) and "data" in j else j


def as_rows(j):
    d = data_of(j)
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("items", "rows", "runs", "jobs", "tasks"):
            if isinstance(d.get(k), list):
                return d[k]
    return []


def err_text(j) -> str:
    if not isinstance(j, dict):
        return str(j)[:300]
    e = j.get("error")
    if isinstance(e, dict):
        return f"{e.get('code')}: {e.get('message')}"[:300]
    return str(e or j.get("raw") or j)[:300]


class Ledger:
    """收官表:每个能力一行,状态 ok / fail / gap(合同已登记的缺口)。"""

    def __init__(self):
        self.rows = []

    def add(self, cap: str, name: str, ok, evidence: str, gap: bool = False):
        st = "gap" if gap else ("ok" if ok else "fail")
        self.rows.append((cap, name, st, evidence))
        mark = {"ok": "✅", "fail": "❌", "gap": "⚠️"}[st]
        log(f"{mark} {cap} · {name} · {evidence}")

    def failed(self):
        return [r for r in self.rows if r[2] == "fail"]


# 复用既有对象时**可以更新**的字段(按端点)。刻意是显式清单而不是「整包重放」:
# 整包重放会把 ownerTargetId / targets 这类**不可改**的维度也塞回去,被服务端拒或更糟 —— 静默改绑。
UPDATABLE = {
    "sync": ("targetType", "syncMode", "writeMode", "channel", "sourceDatabase", "sourceTables",
             "targetTableNames", "redshiftConfig", "s3Config"),
    "etl-jobs": ("script", "targets", "glueConfig", "cronExpression"),
    "emr-serverless": ("script", "targets"),
    "workflow": ("dagDefinition", "targets", "cronExpression"),
}


def ensure(api: Api, led: Ledger, cap: str, list_path: str, name: str, create_path: str, payload: dict, id_field: str):
    """幂等建对象:先按 name 在清单里找,找到即复用;否则创建。回 id 或 None。"""
    st, j = api.get(list_path)
    for row in as_rows(j):
        if isinstance(row, dict) and row.get("name") == name and row.get(id_field):
            oid = row[id_field]
            # 🔴 复用时必须把**定义**更新进去 —— 而且要覆盖**每一种**对象。真环境实测(2026-09-18):
            #    上一版只给 etl-jobs / emr-serverless / workflow 做了 PUT,**漏了同步任务** ⇒ 同步仍按旧的
            #    `public` schema 跑、ETL 已指向新建的 `showcase` ⇒ 两边说的不是一件事,四条链一起红。
            #    「更新只接了一半」比不更新更难查:一半是新的,报错却出现在另一半上。
            kind = create_path.split("?")[0].rstrip("/").split("/")[-1]
            upd = {k: payload[k] for k in UPDATABLE.get(kind, ()) if k in payload}
            if upd:
                ust, uj = api.call("PUT", f"{create_path.split('?')[0]}/{oid}", upd)
                log(f"= {cap} {name} 已存在 {id_field}={oid}(复用;定义更新 HTTP {ust}"
                    f"{'' if ust == 200 else ' ' + err_text(uj)})")
            else:
                log(f"= {cap} {name} 已存在 {id_field}={oid}(复用;该类型无可更新定义)")
            return oid
    st, j = api.post(create_path, payload)
    d = data_of(j) or {}
    oid = d.get(id_field) if isinstance(d, dict) else None
    if st not in (200, 201) or not oid:
        led.add(cap, name, False, f"创建失败 HTTP {st} {err_text(j)}")
        return None
    log(f"+ {cap} {name} 创建 {id_field}={oid}")
    return oid


# ── 业务脚本(与本地 30-seed-tasks 同一套口径:真实多表指标,不是单表镜像)────────
ROI_DROP = f"DROP TABLE IF EXISTS {SHOWCASE_SCHEMA}.dws_channel_roi_daily"
ROI_CTAS = f"""CREATE TABLE {SHOWCASE_SCHEMA}.dws_channel_roi_daily AS
WITH spend AS (
  SELECT c.channel_id, ch.channel_name, ch.channel_type,
         SUM(c.cost_usd) AS cost_usd, COUNT(DISTINCT c.campaign_id) AS campaigns
  FROM {SHOWCASE_SCHEMA}.ad_campaigns c JOIN {SHOWCASE_SCHEMA}.ad_channels ch ON ch.channel_id = c.channel_id
  GROUP BY c.channel_id, ch.channel_name, ch.channel_type
),
installs AS (
  SELECT source_channel_id AS channel_id, COUNT(*) AS installs,
         SUM(CASE WHEN is_paying = 1 THEN 1 ELSE 0 END) AS payers
  FROM {SHOWCASE_SCHEMA}.players GROUP BY source_channel_id
),
revenue AS (
  SELECT pl.source_channel_id AS channel_id, SUM(pay.amount_usd) AS revenue_usd
  FROM {SHOWCASE_SCHEMA}.payments pay JOIN {SHOWCASE_SCHEMA}.players pl ON pl.player_id = pay.player_id
  GROUP BY pl.source_channel_id
)
SELECT s.channel_id, s.channel_name, s.channel_type, s.campaigns, s.cost_usd,
       COALESCE(i.installs, 0) AS installs, COALESCE(i.payers, 0) AS payers,
       ROUND(s.cost_usd / NULLIF(i.installs, 0), 4) AS cpi_usd,
       ROUND(100.0 * i.payers / NULLIF(i.installs, 0), 2) AS pay_rate_pct,
       COALESCE(r.revenue_usd, 0) AS revenue_usd,
       ROUND(COALESCE(r.revenue_usd, 0) / NULLIF(s.cost_usd, 0), 4) AS roas
FROM spend s LEFT JOIN installs i ON i.channel_id = s.channel_id
LEFT JOIN revenue r ON r.channel_id = s.channel_id
ORDER BY roas DESC"""

# 离线作业(Redshift SQL):DROP + CTAS 放同一事务,避免重跑撞 OID(cookbook redshift.concurrent-oid)
ROI_JOB_SQL = f"BEGIN;\n{ROI_DROP};\n{ROI_CTAS};\nCOMMIT;"

GLUE_RETENTION = (r'''import sys
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import functions as F
args = getResolvedOptions(sys.argv, ["JOB_NAME"])
sc = SparkContext(); glueContext = GlueContext(sc); spark = glueContext.spark_session
job = Job(glueContext); job.init(args["JOB_NAME"], args)
# S3 Tables 目录由平台按执行环境注入:在哪个区跑就读哪个区的表桶
players  = spark.table("s3tablescatalog.gamedata.players")
sessions = spark.table("s3tablescatalog.gamedata.game_sessions")
payments = spark.table("s3tablescatalog.gamedata.payments")
p = players.select("player_id", "source_channel_id", "install_time")
s = sessions.select("player_id", "start_time")
d1 = (p.join(s, "player_id", "left")
      .withColumn("gap_h", (F.col("start_time").cast("long") - F.col("install_time").cast("long")) / 3600.0)
      .withColumn("d1", F.when((F.col("gap_h") >= 24) & (F.col("gap_h") < 48), 1).otherwise(0))
      .groupBy("player_id", "source_channel_id").agg(F.max("d1").alias("retained_d1")))
pay = payments.groupBy("player_id").agg(F.sum("amount_usd").alias("ltv"))
base = p.join(d1.select("player_id", "retained_d1"), "player_id", "left").join(pay, "player_id", "left")
result = (base.groupBy("source_channel_id")
          .agg(F.count("*").alias("installs"),
               F.sum(F.coalesce("retained_d1", F.lit(0))).alias("retained_d1"),
               F.count(pay["ltv"]).alias("payers"),
               F.sum(F.coalesce("ltv", F.lit(0.0))).alias("total_revenue"))
          .withColumn("d1_retention_pct",
                      F.when(F.col("installs") > 0, F.round(100.0 * F.col("retained_d1") / F.col("installs"), 2)))
          .withColumn("arpu",
                      F.when(F.col("installs") > 0, F.round(F.col("total_revenue") / F.col("installs"), 4))))
result.show(truncate=False)
spark.sql("CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.gamedata")
result.writeTo("s3tablescatalog.gamedata.dws_channel_retention_ltv").using("iceberg").createOrReplace()
job.commit()
'''.replace("s3tablescatalog.gamedata", f"s3tablescatalog.{SHOWCASE_SCHEMA}"))

EMR_FUNNEL = (r'''from pyspark.sql import SparkSession
from pyspark.sql import functions as F
spark = SparkSession.builder.appName("showcase-behavior-funnel").getOrCreate()
events  = spark.table("s3tablescatalog.gamedata.player_events")
players = spark.table("s3tablescatalog.gamedata.players")
# 漏斗 login → level_up → purchase(event_name 取值集合与 seed_game.py 一致)
stage = (events.groupBy("player_id").agg(
    F.max(F.when(F.col("event_name") == "login", 1).otherwise(0)).alias("login"),
    F.max(F.when(F.col("event_name") == "level_up", 1).otherwise(0)).alias("battle"),
    F.max(F.when(F.col("event_name") == "purchase", 1).otherwise(0)).alias("purchase")))
joined = players.select("player_id", F.col("source_channel_id").alias("channel_id")).join(stage, "player_id", "left")
funnel = (joined.groupBy("channel_id").agg(
    F.count("*").alias("players"),
    F.sum(F.coalesce("login", F.lit(0))).alias("login_users"),
    F.sum(F.coalesce("battle", F.lit(0))).alias("battle_users"),
    F.sum(F.coalesce("purchase", F.lit(0))).alias("purchase_users"))
  # 🔴 分母可能为 0(某个渠道当期没有 login/level_up):Spark 的 ANSI 模式对 0 分母**直接报错**
  #    (DIVIDE_BY_ZERO,真环境实测),不是给 NULL ⇒ 必须显式守卫,别指望默认行为容忍。
  .withColumn("login_to_levelup_pct",
              F.when(F.col("login_users") > 0, F.round(100.0 * F.col("battle_users") / F.col("login_users"), 2)))
  .withColumn("levelup_to_purchase_pct",
              F.when(F.col("battle_users") > 0, F.round(100.0 * F.col("purchase_users") / F.col("battle_users"), 2))))
funnel.show(truncate=False)
spark.sql("CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.gamedata")
funnel.writeTo("s3tablescatalog.gamedata.dws_channel_behavior_funnel").using("iceberg").createOrReplace()
spark.stop()
'''.replace("s3tablescatalog.gamedata", f"s3tablescatalog.{SHOWCASE_SCHEMA}"))


# ── 等终态 ─────────────────────────────────────────────────────────────────────
TERMINAL = ("succeeded", "failed", "stopped")


def wait_runs(api: Api, list_path: str, run_ids: list, budget: int, label: str) -> dict:
    """等一组 runId 全到终态(逐条等;只等第一条 = 没验第二个)。回 {runId: {status, targetId, error}}"""
    want = [r for r in run_ids if r]
    got: dict = {}
    t0 = time.time()
    while want and time.time() - t0 < budget and len(got) < len(want):
        time.sleep(15)
        st, j = api.get(list_path)
        for x in as_rows(j):
            if isinstance(x, dict) and x.get("runId") in want and str(x.get("status")) in TERMINAL:
                got[x["runId"]] = {"status": x["status"], "targetId": x.get("targetId"), "error": str(x.get("error") or "")[:200]}
        if int(time.time() - t0) % 120 < 15:
            log(f"  … {label} 等待中 {len(got)}/{len(want)} 到终态({int(time.time() - t0)}s)")
    return got


def wait_ddb_runs(ddb_home, task_id: str, since_iso: str, budget: int, label: str) -> list:
    """编排 run 的真值源 = bgp-task-runs(taskId=workflowId);等所有 startedAt>=since 的行到终态。"""
    t0 = time.time()
    rows: list = []
    while time.time() - t0 < budget:
        time.sleep(15)
        q = ddb_home.query(TableName="bgp-task-runs", KeyConditionExpression="taskId = :t",
                           ExpressionAttributeValues={":t": {"S": task_id}})
        rows = []
        for it in q.get("Items", []):
            g = lambda k: (it.get(k) or {}).get("S") or ""
            if g("startedAt") >= since_iso:
                rows.append({"runId": g("runId"), "status": g("status"), "targetId": g("targetId"), "error": g("error")[:200]})
        if rows and all(r["status"] in TERMINAL for r in rows):
            return rows
        if int(time.time() - t0) % 120 < 15:
            log(f"  … {label} 等待中 {len([r for r in rows if r['status'] in TERMINAL])}/{len(rows)}({int(time.time() - t0)}s)")
    return rows


# ── 主流程 ─────────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="temp-account")
    ap.add_argument("--target", required=True, help="执行环境 id,如 tgt_home / tgt_usw2_a")
    ap.add_argument("--stage", default="all", choices=["create", "run", "all"])
    ap.add_argument("--home-region", default=os.environ.get("KF_HOME_REGION", "us-east-1"))
    ap.add_argument("--only", default="",
                    help="只跑这些环节(逗号分隔):sync,etl,emr,workflow,gov,model,realtime,genbi;缺省全跑")
    ap.add_argument("--sync-budget", type=int, default=1800)
    ap.add_argument("--etl-budget", type=int, default=1500)
    a = ap.parse_args()

    _only = {x.strip() for x in a.only.split(",") if x.strip()}
    def want(stage: str) -> bool:
        return not _only or stage in _only

    sess = boto3.Session(profile_name=a.profile, region_name=a.home_region)
    cf = sess.client("cloudformation")
    ddb = sess.client("dynamodb")
    cog = sess.client("cognito-idp")

    t = target_row(ddb, a.target)
    tid, region, res = t["targetId"], t["region"], t["resources"]
    slug = tid.replace("tgt_", "").replace("_", "-")
    P = f"Showcase-{slug}"
    is_home = tid == HOME_TARGET
    log(f"target={tid} region={region} status={t['status']} 湖桶={res.get('datalakeBucket', '(home 走 env)')}")

    base = cfn_out(cf, "BgpPlatformStack", "PlatformUrl")
    client_id = cfn_out(cf, "BgpAuthStack", "ClientId")
    if not base or not client_id:
        raise SystemExit("读不到 BgpPlatformStack.PlatformUrl / BgpAuthStack.ClientId(平台未部署?)")
    tok = cog.initiate_auth(AuthFlow="USER_PASSWORD_AUTH", ClientId=client_id,
                            AuthParameters={"USERNAME": "admin", "PASSWORD": admin_password(a.profile)})
    api = Api(base, tok["AuthenticationResult"]["IdToken"])
    led = Ledger()
    # 按名查重用全量视角(列表路由要求带 ?scope=;按区过滤会把「已建在别处」的同名对象漏掉而重复建)
    scope = "?scope=global"

    # ── 1) 数据源(章 = 该区)────────────────────────────────────────────────
    ds_ids: dict = {}
    if is_home:
        host = cfn_out(cf, "BgpRdsStack", "RdsEndpoint")
        secret = cfn_out(cf, "BgpRdsStack", "RdsSecretArn")
        if not host or not secret:
            raise SystemExit("home 缺 BgpRdsStack 输出(RdsEndpoint / RdsSecretArn)")
        d = ensure(api, led, "数据源", f"/api/datasources{scope}", f"{P}-GameData-MySQL", "/api/datasources",
                   {"name": f"{P}-GameData-MySQL", "type": "mysql", "host": host, "port": 3306,
                    "database": "gamedata", "rdsSecretArn": secret, "env": "dev", "tags": ["showcase"], "targetId": tid},
                   "datasourceId")
        if d:
            ds_ids["__all__"] = d
    else:
        lake = res.get("datalakeBucket")
        if not lake:
            raise SystemExit(f"{tid} 的资源袋没有 datalakeBucket")
        for tb in TABLES:
            d = ensure(api, led, "数据源", f"/api/datasources{scope}", f"{P}-S3-{tb}", "/api/datasources",
                       {"name": f"{P}-S3-{tb}", "type": "s3", "env": "dev", "tags": ["showcase"], "targetId": tid,
                        "connection": {"bucket": lake, "prefix": f"gamedata/{tb}/", "format": "parquet"}},
                       "datasourceId")
            if d:
                ds_ids[tb] = d
    # 章核对(DDB 真值):ownerTargetId 必须逐字 = tid
    bad_owner = []
    for k, dsid in ds_ids.items():
        r = ddb.get_item(TableName="bgp-datasources", Key={"userId": {"S": "default-user"}, "datasourceId": {"S": dsid}}).get("Item") or {}
        owner = (r.get("ownerTargetId") or {}).get("S")
        if owner != tid:
            bad_owner.append(f"{k}:{owner}")
    led.add("数据源", f"{len(ds_ids)} 个源章 = {tid}", ds_ids and not bad_owner,
            f"ownerTargetId 逐字核对:{'全部 ' + tid if not bad_owner else '不符 ' + str(bad_owner)}")

    # ── 2) 同步任务(章从源派生;落点全留空由平台解析)────────────────────────
    sync_ids: dict = {}
    if is_home and ds_ids.get("__all__"):
        s = ensure(api, led, "同步", f"/api/sync{scope}", f"{P}-GameSync-7tables", "/api/sync",
                   {"name": f"{P}-GameSync-7tables", "datasourceId": ds_ids["__all__"], "sourceDatabase": "gamedata",
                    "sourceTables": HOME_ALL_TABLES, "targetType": "both", "syncMode": "full", "writeMode": "overwrite",
                    "channel": "glue", "redshiftConfig": {"schema": SHOWCASE_SCHEMA}, "s3Config": {"namespace": SHOWCASE_SCHEMA}},
                   "taskId")
        if s:
            sync_ids["__all__"] = s
    else:
        for tb, dsid in ds_ids.items():
            s = ensure(api, led, "同步", f"/api/sync{scope}", f"{P}-Sync-{tb}", "/api/sync",
                       {"name": f"{P}-Sync-{tb}", "datasourceId": dsid, "sourceDatabase": "gamedata",
                        "sourceTables": [tb], "targetType": "both", "syncMode": "full", "writeMode": "overwrite",
                        "channel": "glue", "redshiftConfig": {"schema": SHOWCASE_SCHEMA}, "s3Config": {"namespace": SHOWCASE_SCHEMA}},
                       "taskId")
            if s:
                sync_ids[tb] = s
    bad_ch = []
    for k, sid in sync_ids.items():
        r = ddb.get_item(TableName="bgp-sync-tasks", Key={"userId": {"S": "default-user"}, "taskId": {"S": sid}}).get("Item") or {}
        chs = [list(x.values())[0] for x in (r.get("targets") or {}).get("L", [])]
        if chs != [tid]:
            bad_ch.append(f"{k}:{chs}")
    led.add("同步", f"{len(sync_ids)} 个任务章 = [{tid}]", sync_ids and not bad_ch,
            f"targets 逐字核对:{'全部 [' + tid + ']' if not bad_ch else '不符 ' + str(bad_ch)}")

    # ── 3) 离线 ETL 三引擎(targets = [tid];落点由平台解析)────────────────────
    rs_job = ensure(api, led, "ETL", f"/api/etl-jobs{scope}", f"{P}-ETL-ChannelROI", "/api/etl-jobs",
                    {"name": f"{P}-ETL-ChannelROI", "type": "redshift", "targets": [tid], "script": ROI_JOB_SQL,
                     "description": "渠道买量日报:CPI / ROAS / 付费率(4 表 JOIN)"}, "jobId")
    glue_job = ensure(api, led, "ETL", f"/api/etl-jobs{scope}", f"{P}-ETL-RetentionLTV", "/api/etl-jobs",
                      {"name": f"{P}-ETL-RetentionLTV", "type": "glue", "targets": [tid], "script": GLUE_RETENTION,
                       "description": "渠道次留 + LTV(players × sessions × payments,读写 S3 Tables)",
                       "glueConfig": {"numberOfWorkers": 2, "workerType": "G.1X", "timeoutMinutes": 30}}, "jobId")
    emr_job = ensure(api, led, "计算", f"/api/engines/emr-serverless{scope}", f"{P}-EMR-BehaviorFunnel",
                     "/api/engines/emr-serverless",
                     {"name": f"{P}-EMR-BehaviorFunnel", "targets": [tid], "script": EMR_FUNNEL,
                      "description": "渠道行为漏斗 login → battle → purchase(最大事实表 player_events)"}, "jobId")

    # ── 4) 编排:两个 SQL 节点(原子重算 → ANALYZE)+ 每日定时;发布到该区的 MWAA Serverless ────
    # 🔴 B-66(2026-10-12 第二十九轮真环境坐实):原来是「DROP 节点 → CTAS 节点」,两个节点 = 两个事务,每次运行都有
    #   一两分钟 dws_channel_roi_daily **不存在**的窗口;同一时刻定时刷新的问数卡片(以及任何读这张表的人)报
    #   `relation does not exist`。根治在产品侧:工作流 SQL 节点多语句 ⇒ 单事务(batch_execute_statement)。
    #   示范对象随之改成一个节点里 DROP + CTAS(原子),第二个节点 ANALYZE 刷统计信息 —— 仍是「2 节点 / 1 连线」。
    #   复用已存在的工作流时 ensure 会把 dagDefinition PUT 回去(UPDATABLE),run 阶段再 publish ⇒ 存量升级无需手工。
    wf_id = ensure(api, led, "编排", f"/api/workflow{scope}", f"{P}-Flow-ROI-Daily", "/api/workflow",
                   {"name": f"{P}-Flow-ROI-Daily", "description": "每日重算渠道 ROI 日报(示范,长期保留)",
                    "targetId": tid, "cronExpression": "0 3 * * *",
                    "dagDefinition": {"nodes": [{"id": "n_rebuild", "type": "sql", "data": {"sql": f"{ROI_DROP};\n{ROI_CTAS}"}},
                                                {"id": "n_analyze", "type": "sql",
                                                 "data": {"sql": f"ANALYZE {SHOWCASE_SCHEMA}.dws_channel_roi_daily"}}],
                                      "edges": [{"source": "n_rebuild", "target": "n_analyze"}]}},
                   "workflowId")

    # ── 6) 数据建模:码表落地 + 维度表应用(targets = [tid])────────────────────
    ct_id = ensure(api, led, "建模", f"/api/modeling/codetables{scope}", f"{P}-dim_code_channel_type", "/api/modeling/codetables",
                   {"name": f"{P}-dim_code_channel_type", "code": f"showcase_channel_type_{slug.replace('-', '_')}",
                    "values": [{"value": "paid_social", "label": "付费社交"}, {"value": "paid_search", "label": "付费搜索"},
                               {"value": "video", "label": "视频"}, {"value": "organic", "label": "自然量"}]},
                   "codeTableId")
    dim_id = ensure(api, led, "建模", f"/api/modeling/dimensions{scope}", f"{P}-dim_channel", "/api/modeling/dimensions",
                    {"name": f"{P}-dim_channel", "schema": "public", "physicalTable": f"dim_channel_{slug.replace('-', '_')}",
                     "tableType": "dimension",
                     "columns": [{"name": "channel_id", "dataType": "INTEGER", "isPrimaryKey": True},
                                 {"name": "channel_name", "dataType": "VARCHAR", "length": 128},
                                 {"name": "channel_type", "dataType": "VARCHAR", "length": 32}]},
                    "modelTableId")

    # ── 7) 实时计算(模块 32):该区**自己的** Kinesis 源流 + 长期保留的流作业 ──────────
    # @kf-batch 50-WP27-9cap-matrix
    # 🔴 为什么要有这一段(WP-27 立包理由):实时计算原来**不在能力矩阵里**,只由「自造夹具、验完删净」
    #   的硬门段覆盖 ⇒ 用户切到某个区,实时计算页是空的(或只剩几个停掉的夹具)。这里建的对象**不删**。
    # 🔴 流式作业天生「一区一个应用」⇒ 每个区各建一条源流 + 一个作业,名字带区。
    # 🔴 源流由**产品自己**按需新建(`provision: true`):平台刻意不建固定流,所以「那个区有没有流」
    #   本身就是一条要验的能力。这一段同时是 2026-09-19 那三处 region 缺陷的真环境看守:
    #   建流(kinesis:CreateStream on 该区)/ 造数(PutRecords 打到**该区**)/ 日志组(该区)。
    rt_ds = rt_job = None
    if want("realtime"):
        rt_ds = ensure(api, led, "实时", f"/api/datasources{scope}", f"{P}-RT-Stream", "/api/datasources",
                       {"name": f"{P}-RT-Stream", "type": "kinesis", "env": "dev", "tags": ["showcase"],
                        "targetId": tid, "provision": True,
                        # 🔴 连接袋**不传 region**:物理区由「章」派生(平台会用 targetId 的 region 覆盖);
                        #   传了不一致的 region 平台会当场拒(那正是 WP-27 同批修的洞)。
                        "connection": {"streamName": f"bgp-showcase-{slug}-rt", "shardCount": 1}},
                       "datasourceId")
        if rt_ds:
            # sql 刻意留空 ⇒ 用**产品自己的**默认 Flink SQL(1 分钟滚动窗口按 region 聚合金额),
            # 它与「造数」端点注入的 {region, amount, ts} 形状天然对齐。
            rt_job = ensure(api, led, "实时", f"/api/flink/jobs{scope}", f"{P}-RT-OrderAmount1m", "/api/flink/jobs",
                            {"name": f"{P}-RT-OrderAmount1m", "sourceType": "kinesis", "sinkType": "s3",
                             "sourceDatasourceId": rt_ds, "targets": [tid],
                             "description": "实时订单金额 1 分钟滚动窗口聚合(示范,长期保留、保持运行)"},
                            "jobId")
        # 章核对:作业行上的 targets 必须逐字 = [tid](流式作业一区一个,绝不许挂两个区)
        if rt_job:
            r = ddb.get_item(TableName="bgp-flink-jobs",
                             Key={"userId": {"S": "default-user"}, "jobId": {"S": rt_job}}).get("Item") or {}
            tg = [list(x.values())[0] for x in (r.get("targets") or {}).get("L", [])]
            led.add("实时", f"{P}-RT-OrderAmount1m 章 = [{tid}]", tg == [tid],
                    f"targets 逐字核对:{tg}")

    if a.stage == "create":
        return finish(led, tid)

    # ═══════════════════════════ run 阶段:真跑到成功 ═══════════════════════════
    # ── 同步:全部启动,再逐条等终态 ──
    started = {}
    for k, sid in (sync_ids.items() if want("sync") else ()):
        st, j = api.post(f"/api/sync/{sid}/start", {})
        d = data_of(j) or {}
        if st == 200 and isinstance(d, dict) and d.get("runId"):
            started[k] = (sid, d["runId"], d.get("jobName"))
            log(f"▶ 同步 {k} 启动 run={d['runId']} job={d.get('jobName')}")
        else:
            led.add("同步", f"{P} {k} 启动", False, f"HTTP {st} {err_text(j)}")
    t0 = time.time()
    for k, (sid, rid, job) in started.items():
        got = {}
        while time.time() - t0 < a.sync_budget:
            st, j = api.get(f"/api/sync/{sid}/runs")
            for x in as_rows(j):
                if isinstance(x, dict) and x.get("runId") == rid and str(x.get("status")) in TERMINAL:
                    got = x
            if got:
                break
            time.sleep(15)
        ok = str(got.get("status")) == "succeeded"
        led.add("同步", f"{P} {k}", ok,
                f"run={rid} 终态={got.get('status') or '超时未到终态'} rowsRead={(got.get('metrics') or {}).get('rowsRead')} "
                f"targetId={got.get('targetId')} {str(got.get('error') or '')[:160]}")
    if led.failed():
        log("同步有失败 ⇒ 后续 ETL 会缺表,仍继续跑以便把失败面一次看全")

    # ── ETL:Redshift / Glue(etl-jobs)+ EMR(engines)──
    for cap, jid, lp in ((("ETL", rs_job, "/api/etl-jobs"), ("ETL", glue_job, "/api/etl-jobs")) if want("etl") else ()):
        if not jid:
            continue
        st, j = api.post(f"{lp}/{jid}/run", {})
        d = data_of(j) or {}
        runs = [x.get("runId") for x in (d.get("runs") or []) if isinstance(x, dict)] if isinstance(d, dict) else []
        if st != 200 or not runs:
            led.add(cap, f"{lp}/{jid} 运行", False, f"HTTP {st} {err_text(j)} runs={runs}")
            continue
        got = wait_runs(api, f"{lp}/{jid}/runs", runs, a.etl_budget, f"{cap} {jid}")
        mine = list(got.values())
        ok = bool(mine) and all(m["status"] == "succeeded" for m in mine) and all(m.get("targetId") == tid for m in mine)
        led.add(cap, f"{P} 作业 {jid}", ok, f"runs={[(m['status'], m.get('targetId'), m.get('error')) for m in mine] or '超时未到终态'}")
    if emr_job and want("emr"):
        since = time.strftime("%Y-%m-%dT%H:%M", time.gmtime(time.time() - 60))
        st, j = api.post(f"/api/engines/emr-serverless/{emr_job}/run", {})
        via = f"经长操作 202 轮询(taskId={api.last_long_op})" if api.last_long_op else "同步响应"
        if st != 200:
            led.add("计算", f"{P} EMR 运行", False, f"HTTP {st}({via}){err_text(j)}")
        else:
            log(f"  · EMR 运行已提交:HTTP 200({via})")
            # EMR 的 run 响应不带 runs(实测),run 列表才是真值源
            rids: list = []
            t1 = time.time()
            while time.time() - t1 < 300 and not rids:
                time.sleep(10)
                st2, j2 = api.get(f"/api/engines/emr-serverless/{emr_job}/runs")
                rids = [x.get("runId") for x in as_rows(j2)
                        if isinstance(x, dict) and str(x.get("startedAt") or x.get("createdAt") or "") >= since]
            got = wait_runs(api, f"/api/engines/emr-serverless/{emr_job}/runs", rids, a.etl_budget + 600, "EMR")
            mine = list(got.values())
            ok = bool(mine) and all(m["status"] == "succeeded" for m in mine) and all(m.get("targetId") == tid for m in mine)
            led.add("计算", f"{P} EMR 作业 {emr_job}", ok, f"runs={[(m['status'], m.get('targetId'), m.get('error')) for m in mine] or '超时未到终态'}")

    # ── 编排:发布(该区 MWAA Serverless)→ 触发一次 → 等终态(真值源 bgp-task-runs)──
    if wf_id and want("workflow"):
        st, j = api.post(f"/api/workflow/{wf_id}/publish", {})
        d = data_of(j) or {}
        pub_ok = st == 200 and isinstance(d, dict) and (d.get("dagId") or d.get("perTarget"))
        led.add("编排", f"{P} 发布", pub_ok, f"HTTP {st} dagId={d.get('dagId') if isinstance(d, dict) else None} scheduler={d.get('scheduler') if isinstance(d, dict) else None} {err_text(j) if not pub_ok else ''}")
        if pub_ok:
            since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 30))
            st, j = api.post(f"/api/workflow/{wf_id}/trigger", {})
            d = data_of(j) or {}
            if st != 200:
                led.add("编排", f"{P} 触发", False, f"HTTP {st} {err_text(j)}")
            else:
                rows = wait_ddb_runs(ddb, wf_id, since, 1500, "编排")
                ok = bool(rows) and all(r["status"] == "succeeded" for r in rows) and all(r["targetId"] == tid for r in rows)
                led.add("编排", f"{P} 触发一次 + 每日 03:00 定时", ok,
                        f"runs={[(r['status'], r['targetId'], r['error']) for r in rows] or '超时未到终态'}")

    # ── 治理:把该区的表推进 OM(非 home)→ 目录取 fqn → 质量规则 → 评估 ──
    if not is_home and want("gov"):
        st, j = api.post("/api/admin/metadata-mirror", {"targetId": tid, "sources": ["glue", "redshift"]})
        om = ((data_of(j) or {}).get("om") or {}) if isinstance(data_of(j), dict) else {}
        led.add("治理", f"{P} 元数据镜像 → OM", st == 200 and int(om.get("errors") or 0) == 0,
                f"HTTP {st} tables={om.get('tables')} errors={om.get('errors')} {err_text(j) if st != 200 else ''}")
    fqn = ""
    for _ in range(6 if want("gov") else 0):
        st, j = api.get(f"/api/governance/catalog?keyword=dws_channel_roi_daily&scope={tid}")
        rows = [x for x in as_rows(j) if isinstance(x, dict) and str(x.get("name") or "").endswith("dws_channel_roi_daily")]
        if rows:
            fqn = str(rows[0].get("fqn") or "")
            break
        time.sleep(10)
    if want("gov") and not fqn:
        led.add("治理", f"{P} 目录里找 dws_channel_roi_daily", False, f"scope={tid} 目录里没有该表(ETL 没成功 / 镜像未推进)")
    elif want("gov"):
        st, j = api.get(f"/api/governance/quality-rules?fqn={urllib.request.quote(fqn)}&scope={tid}")
        rule = next((x for x in as_rows(j) if isinstance(x, dict) and x.get("type") == "row_count"), None)
        if not rule:
            st, j = api.post("/api/governance/quality-rules",
                             {"fqn": fqn, "targetId": tid, "type": "row_count", "params": {"min": 1}, "severity": "medium", "weight": 1})
            rule = data_of(j) if st in (200, 201) else None
        if not rule:
            led.add("治理", f"{P} 质量规则", False, f"HTTP {st} {err_text(j)}")
        else:
            st, j = api.post("/api/governance/quality-run", {"fqn": fqn, "targetId": tid})
            d = data_of(j) or {}
            results = d.get("results") or [] if isinstance(d, dict) else []
            sts = [str(x.get("status")) for x in results]
            led.add("治理", f"{P} 质量规则 row_count≥1 评估", st == 200 and sts and all(s_ != "error" for s_ in sts),
                    f"fqn={fqn} results={sts} {[str(x.get('message') or '')[:80] for x in results]}")

    # ── 建模:落地到该区(WP-11b 已交付:非 home 与 home 同样必须 ok;credential-gap 不再是合法态)──
    if ct_id and want("model"):
        st, j = api.post(f"/api/modeling/codetables/{ct_id}/land", {"targets": [tid]})
        r = ddb.get_item(TableName="bgp-code-tables", Key={"pk": {"S": "codetable"}, "codeTableId": {"S": ct_id}}).get("Item") or {}
        lbt = ((r.get("landedByTarget") or {}).get("M") or {}).get(tid, {}).get("M") or {}
        status = (lbt.get("status") or {}).get("S")
        led.add("建模", f"{P} 码表落地", status == "ok", f"HTTP {st} landedByTarget[{tid}].status={status} {(lbt.get('error') or {}).get('S', '')[:120]}")
    if dim_id and want("model"):
        st, j = api.post(f"/api/modeling/dimensions/{dim_id}/apply", {"targets": [tid]})
        d = data_of(j) or {}
        status = ((d.get("landedByTarget") or {}).get(tid) or {}).get("status") if isinstance(d, dict) else None
        led.add("建模", f"{P} 维度表应用", status == "ok", f"HTTP {st} landedByTarget[{tid}].status={status} {err_text(j) if st != 200 else ''}")

    # ── 7run) 实时计算:启动 → 等 MSAF RUNNING → 造数 → 读到聚合结果;🔴 **跑完不停** ──────
    # @kf-batch 50-WP27-9cap-matrix
    # 🔴 与其它能力不同:流式作业的「成功」不是终态 succeeded,而是**持续 RUNNING**。
    #   所以这一段刻意**不停止、不删除** —— 用户切到那个区就应当看见一个正在跑的流作业。
    #   ⚠️ 代价要说清:MSAF 应用按 KPU-小时计费 + 每条 provisioned 流 1 shard 也在计费。
    if rt_job and want("realtime"):
        # 🔴 幂等:示范对象是**长期保留并保持运行**的,重跑时它很可能已经 RUNNING ——
        #   再点一次启动会撞 MSAF 的 ResourceInUse,把「已经在跑」误报成「启动失败」。
        st0, j0 = api.get(f"/api/flink/jobs/{rt_job}/status")
        already = str((data_of(j0) or {}).get("appStatus") or "") == "RUNNING"
        st, j = (200, {}) if already else api.post(f"/api/flink/jobs/{rt_job}/start", {})
        if already:
            log("  … 流作业已经是 RUNNING(示范对象保持运行)⇒ 跳过启动")
        # 🔴 启动是**异步**的:产品回 **202 Accepted**(MSAF 应用 STARTING→RUNNING 约 1–3 分钟),
        #   不是 200。第一版按 200/201 判 ⇒ 当场判红而应用其实正常起着(判据自己的 bug,不是产品)。
        if st not in (200, 201, 202):
            led.add("实时", f"{P} 流作业启动", False, f"HTTP {st} {err_text(j)}")
        else:
            app_status, t0 = "", time.time()
            while time.time() - t0 < 900:
                time.sleep(20)
                st2, j2 = api.get(f"/api/flink/jobs/{rt_job}/status")
                app_status = str((data_of(j2) or {}).get("appStatus") or "")
                if app_status in ("RUNNING", "READY", "STOPPED") or "FAIL" in app_status.upper():
                    if app_status == "RUNNING":
                        break
                if int(time.time() - t0) % 120 < 20:
                    log(f"  … 实时作业等 RUNNING,现在 appStatus={app_status or '?'}({int(time.time() - t0)}s)")
            led.add("实时", f"{P} 流作业跑到 RUNNING(长期保持)", app_status == "RUNNING",
                    f"MSAF appStatus={app_status or '超时未到 RUNNING'}")
            # 造数:🔴 回执必须复述落点 —— 「造数成功」在多区下本身没有信息量(它可能成功地打错了区)
            st3, j3 = api.post(f"/api/flink/jobs/{rt_job}/produce", {"count": 300, "spanMinutes": 3})
            d3 = data_of(j3) or {}
            same_region = str(d3.get("region") or "") == region and str(d3.get("targetId") or "") == tid
            led.add("实时", f"{P} 造数打到**本区**的流", st3 == 200 and int(d3.get("failed") or 0) == 0 and same_region,
                    f"HTTP {st3} produced={d3.get('produced')} failed={d3.get('failed')} "
                    f"stream={d3.get('stream')} 回执落点={d3.get('targetId')}/{d3.get('region')}(应为 {tid}/{region})")
            # 窗口关闭需要 watermark 推进:1 分钟窗口 + 30s 滚动 ⇒ 给 4 分钟
            cnt, t1 = 0, time.time()
            while time.time() - t1 < 300:
                time.sleep(30)
                st4, j4 = api.get(f"/api/flink/jobs/{rt_job}/status")
                cnt = int((data_of(j4) or {}).get("resultCount") or 0)
                if cnt > 0:
                    break
            led.add("实时", f"{P} 聚合结果真落到本区的湖", cnt > 0,
                    f"1 分钟滚动窗口产出行数={cnt}(0 = 窗口没关 / 没消费到数据)")

    # ── 8run) 智能问数(模块 54):在该区问一次 + **保存成会话卡片**(长期保留、切区看得见)──────
    # @kf-batch 50-WP27-9cap-matrix
    # 🔴 为什么必须落成**卡片**而不是只留一条历史:历史是内部台账,用户在页面上看到的「我的问数」是卡片;
    #   而卡片的正文按设计**存在该区**(54 DESIGN:标题与正文都留在各自的区)—— 这正是要验的驻留语义。
    if want("genbi"):
        conv = f"showcase-{slug}-ask"
        q = (f"showcase.dws_channel_roi_daily 表里 roas 最高的三个渠道分别是什么?"
             f"请给出 channel_name 与 roas。")
        st, j = api.call("POST", "/api/genbi/ask",
                         {"question": q, "targetId": tid, "engine": "redshift",
                          "database": res.get("redshiftDatabase") or "dev", "conversationId": conv},
                         timeout=300)
        d = data_of(j) or {}
        # 🔴 问数可能是**异步**的(部署开了 `GENBI_ASYNC`):回 **202 + {taskId, status:"pending"}**,
        #   真正的执行由轮询 `GET /api/genbi/tasks/<id>` 抢占驱动(模块 38:躲 CloudFront 60s 墙)。
        #   第一版按同步写 ⇒ 拿到 202 就判红,而问数其实跑得很好(判据自己的 bug,不是产品)。
        #   🔴 两条分支都要能过:开关状态不该决定判据成败。
        if st == 202 and isinstance(d, dict) and d.get("taskId"):
            task_id = d["taskId"]
            log(f"  … 问数是异步模式(taskId={task_id}),轮询到终态")
            t0 = time.time()
            while time.time() - t0 < 600:
                time.sleep(8)
                stp, jp = api.get(f"/api/genbi/tasks/{task_id}")
                dp = data_of(jp) or {}
                status = str(dp.get("status") or "")
                if status in ("succeeded", "failed", "error"):
                    d = (dp.get("result") or {}) if status == "succeeded" else {"__err": dp}
                    break
        ran_in = ((d.get("_meta") or {}).get("targetId")) if isinstance(d, dict) else None
        ok_ask = bool(d.get("answer"))
        led.add("问数", f"{P} 在本区问一次数", ok_ask,
                f"HTTP {st} 有答案={bool(d.get('answer'))} sql={str(d.get('sql') or '')[:60]!r} "
                f"真跑在={ran_in or '(未回显)'} {err_text(j) if not ok_ask else ''}")
        if ok_ask:
            st5, j5 = api.post("/api/genbi/cards",
                               {"conversationId": conv, "title": f"{P}-Ask-渠道 ROAS Top3",
                                "targetId": tid, "engine": "redshift",
                                "database": res.get("redshiftDatabase") or "dev",
                                "turns": [{"i": 0, "question": q,
                                           "askedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                           "result": d}]})
            d5 = data_of(j5) or {}
            card_id = d5.get("cardId") if isinstance(d5, dict) else None
            # 章核对(DDB 真值):卡片指针上的落点必须逐字 = tid(正文按设计存在那个区)
            owner = ""
            if card_id:
                for it in ddb.scan(TableName="bgp-genbi-cards").get("Items", []):
                    if (it.get("cardId") or {}).get("S") == card_id:
                        owner = (it.get("targetId") or {}).get("S") or ""
                        break
            led.add("问数", f"{P}-Ask-* 会话卡片已保存且章 = {tid}", bool(card_id) and owner == tid,
                    f"HTTP {st5} cardId={card_id} 卡片落点={owner or '(读不到)'} {err_text(j5) if not card_id else ''}")

    return finish(led, tid)


def finish(led: Ledger, tid: str) -> int:
    print()
    print(f"## {tid} 示范对象收官表")
    print("| 能力 | 对象 | 状态 | 证据 |")
    print("|---|---|---|---|")
    for cap, name, st, ev in led.rows:
        mark = {"ok": "✅", "fail": "❌", "gap": "⚠️ 合同缺口"}[st]
        print(f"| {cap} | {name} | {mark} | {ev.replace('|', '/')} |")
    n_fail = len(led.failed())
    n_gap = len([r for r in led.rows if r[2] == "gap"])
    print(f"\n{'❌' if n_fail else '✅'} {tid}:失败 {n_fail} · 合同缺口 {n_gap} · 共 {len(led.rows)} 行")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
