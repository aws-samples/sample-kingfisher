// 数据源「经自己的 Glue 连接」探测与发现表(唯一作者)。
//
// 【缺陷原形(2026-10-13 客户生产环境)】客户源库在客户自己的 VPC(192.168.0.0/16),平台控制面 ECS 在平台 VPC(10.0.0.0/16),
//   两者无 peering ⇒ 控制面直连**本来就到不了**。而页面「检测」(DS-05 心跳)与「浏览表」都是控制面直连:
//   检测把源刷成 unreachable、浏览表 0 张;同一条 Glue 连接(子网 + 安全组在客户 VPC)跑的同步作业却一切正常。
// 【规则】探测与发现表都走**数据源自己的 Glue 连接**,且是**同一个载体**:
//   · 发现表 = 一次性 Glue 作业 `bgp-ds-discover-<源 id 尾 12 位>`(平台缺省 Glue 版本,2×G.1X,挂同一条连接),用与同步作业**同一份**
//     JDBC URL / driver / secret 读 information_schema,结果 JSON 落该区脚本桶 `discover/<源 id>/<库>.json`,平台读回并缓存在源行;
//   · 探测 = 起(或复用在跑的)一次发现作业:作业成功 ⇒ 源可达(顺带把表清单带回来);作业失败 ⇒ 源不可达,错误 = Glue 的 ErrorMessage。
//     🔴 **不用 Glue TestConnection**:2026-10-13 temp-account 真环境实测,平台建的是传统 JDBC 连接,TestConnection 直接回
//     「ValidationException: This operation is only supported for the Unified Connections」,GetConnection 也没有 Status /
//     LastConnectionValidationTime 字段 ⇒ 那条路对本平台的连接**不存在载体**;发现作业在真环境已跑通,就用它。
//   · 探测的推进不只靠页面轮询:列表 / 单条读取碰到「验证中」的行也会读一次作业状态并落结论(用户离开页面也能看到结果)。
//   · probeVia = auto(缺省):先控制面直连,**连不上且有 Glue 连接**才走这里;glue-connection:直接走这里。
//   🔴 不改客户任何网络对象(安全组 / 路由 / peering);不把控制面直连的失败当成「源不可达」写回状态。
import { StartJobRunCommand, GetJobRunCommand, GetJobRunsCommand } from "@aws-sdk/client-glue";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { glueClientFor, s3ClientFor } from "@/lib/exec-env/target-clients";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { upsertGlueJob, type GlueJobDefinition } from "@/lib/aws/glue-job-upsert";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
// 读在途发现作业(`readDiscovery` 用的是记录里的 region,不经 resolveGlueBinding)也替这条源所在区做事 ⇒ 推进入口先记落点决策
import { noteDatasourceRowPlace } from "@/lib/datasource/ds-place";
// 发现作业起之前核对 / 自愈源的外部网络对象(平台组 / 连接被平台外删除 ⇒ 按源行重建接回;用户自带缺失 ⇒ 可读失败)
import { reconcileDatasourceNetwork, DatasourceNetworkBrokenError } from "@/lib/datasource/network-reconcile";
import type { DataSource } from "@/types/datasource";
// 发现作业的 Glue 版本跟平台缺省走(单一作者;缺省 = 清单最高)
import { GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";

/** 发现作业等待上限(作业本身 Timeout 15 分钟;超过 ⇒ timeout:浏览表按失败处理,探测按 unknown 处理 —— 不猜可达 / 不可达)。 */
export const GLUE_DISCOVERY_BUDGET_MS = 16 * 60_000;
/** 发现脚本里 JDBC 登录 / 读取的超时(秒):源 host 不通时让作业在十几秒内失败,而不是等内核 TCP 重试两分钟。 */
export const GLUE_DISCOVERY_CONNECT_TIMEOUT_S = 15;
export const GLUE_DISCOVERY_SOCKET_TIMEOUT_S = 120;
/** 发现作业的 Glue 定义常量(单一处)。 */
export const GLUE_DISCOVERY_JOB = { glueVersion: GLUE_VERSION_DEFAULT, workerType: "G.1X", numberOfWorkers: 2, timeoutMinutes: 15 } as const;

export type GlueReachDs = Pick<DataSource, "datasourceId" | "type" | "host" | "port" | "database" | "username" | "jdbcParams" | "secretArn" | "glueConnectionName" | "ownerTargetId" | "probeVia" | "connection" | "heartbeat" | "discovery" | "discoveredSchema" | "networkConfig" | "networkState" | "networkIssue" | "healCount">;

/** 这条源能不能走 Glue 连接:JDBC 范式 + 有 Glue 连接。 */
export function dsCanUseGlueReach(ds: Pick<GlueReachDs, "type" | "glueConnectionName">): boolean {
  if (!ds.glueConnectionName) return false;
  if (!isDataSourceType(ds.type)) return false;
  return getProvider(ds.type).capabilities.paradigm === "jdbc";
}

/** 探测方式(存量行没有这个键 ⇒ auto)。 */
export function dsProbeVia(ds: Pick<GlueReachDs, "probeVia">): "auto" | "glue-connection" {
  return ds.probeVia === "glue-connection" ? "glue-connection" : "auto";
}

async function bindingOf(ds: Pick<GlueReachDs, "ownerTargetId">) {
  return resolveGlueBinding({ targetId: targetOfStamp(ds.ownerTargetId) });
}

// ── 发现表:一次性 Glue 作业 ────────────────────────────────────────────────────────────

export function discoveryJobName(datasourceId: string): string {
  return `bgp-ds-discover-${datasourceId.slice(-12)}`;
}

const DB_NAME_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/;
export function assertDiscoveryDatabase(db: unknown): string {
  const s = typeof db === "string" ? db.trim() : "";
  if (!s || !DB_NAME_RE.test(s)) throw new Error(`库名不合法:${JSON.stringify(db)}`);
  return s;
}

/**
 * 各 JDBC 源读 information_schema 的 SQL(与 datasource-spi/jdbc/<type>.ts 的 introspect 同一口径:
 * PG 非 public / SQL Server 非 dbo 的表名带 schema 前缀;Oracle 限登录用户的 schema)。
 * 统一列别名:tbl_schema / tbl_name / col_name / col_type / col_nullable / col_key / col_comment / col_pos;`__DB__` 由脚本替换。
 */
export function discoverySqlFor(dbType: string): string {
  switch (dbType) {
    case "mysql":
      return "SELECT TABLE_SCHEMA AS tbl_schema, TABLE_NAME AS tbl_name, COLUMN_NAME AS col_name, COLUMN_TYPE AS col_type, IS_NULLABLE AS col_nullable, COLUMN_KEY AS col_key, COLUMN_COMMENT AS col_comment, ORDINAL_POSITION AS col_pos FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '__DB__'";
    case "postgresql":
      return "SELECT table_schema AS tbl_schema, table_name AS tbl_name, column_name AS col_name, data_type AS col_type, is_nullable AS col_nullable, '' AS col_key, '' AS col_comment, ordinal_position AS col_pos FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')";
    case "sqlserver":
      return "SELECT TABLE_SCHEMA AS tbl_schema, TABLE_NAME AS tbl_name, COLUMN_NAME AS col_name, DATA_TYPE AS col_type, IS_NULLABLE AS col_nullable, '' AS col_key, '' AS col_comment, ORDINAL_POSITION AS col_pos FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG = '__DB__'";
    case "oracle":
      return "SELECT OWNER AS tbl_schema, TABLE_NAME AS tbl_name, COLUMN_NAME AS col_name, DATA_TYPE AS col_type, NULLABLE AS col_nullable, '' AS col_key, '' AS col_comment, COLUMN_ID AS col_pos FROM ALL_TAB_COLUMNS WHERE OWNER = USER";
    default:
      throw new Error(`数据源类型 ${dbType} 不支持经 Glue 连接发现表`);
  }
}

/** 哪个 schema 名算「缺省」(表名不带前缀)。 */
function defaultSchemaFor(dbType: string): string {
  return dbType === "postgresql" ? "public" : dbType === "sqlserver" ? "dbo" : "";
}

/**
 * 各 JDBC driver 的登录 / 读取超时属性(Spark JDBC 会把它不认识的 option 原样交给 driver 当连接属性)。
 * 闭合清单:四种源各自的属性名与单位都不同(MySQL / Oracle 毫秒,PG / SQL Server 秒),未知类型拒 —— 不许静默无超时。
 */
export function jdbcTimeoutOptionsFor(dbType: string): Array<[string, string]> {
  const c = GLUE_DISCOVERY_CONNECT_TIMEOUT_S, s = GLUE_DISCOVERY_SOCKET_TIMEOUT_S;
  switch (dbType) {
    case "mysql": return [["connectTimeout", String(c * 1000)], ["socketTimeout", String(s * 1000)]];
    case "postgresql": return [["connectTimeout", String(c)], ["socketTimeout", String(s)]];
    case "sqlserver": return [["loginTimeout", String(c)], ["socketTimeout", String(s * 1000)]];
    case "oracle": return [["oracle.net.CONNECT_TIMEOUT", String(c * 1000)], ["oracle.jdbc.ReadTimeout", String(s * 1000)]];
    default: throw new Error(`数据源类型 ${dbType} 不支持经 Glue 连接发现表`);
  }
}

export interface DiscoveryScriptArgs {
  dbType: string;
  jdbcUrl: string;
  driverClass: string;
  secretArn: string;
  region: string;
}

/** 发现脚本(PySpark;Glue 版本 = GLUE_DISCOVERY_JOB.glueVersion):读 secret → Spark JDBC 读 information_schema → 归一成表 / 列 → JSON 落 --result_uri。 */
export function buildDiscoveryScript(a: DiscoveryScriptArgs): string {
  const sql = discoverySqlFor(a.dbType);
  const defSchema = defaultSchemaFor(a.dbType);
  const timeoutOpts = jdbcTimeoutOptionsFor(a.dbType).map(([k, v]) => `\n      .option(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join("");
  return `# 数据源表发现(经数据源自己的 Glue 连接跑;与同步作业同一份 JDBC URL / driver / secret)
# 同一个作业也是「检测」的载体:成功 = 源可达(表清单顺带带回),失败 = 源不可达(登录 / 读取超时见下面的 driver 超时属性)
import sys, json, datetime, boto3
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext

args = getResolvedOptions(sys.argv, ["JOB_NAME", "result_uri", "database"])
sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session

sm = boto3.client("secretsmanager", region_name=${JSON.stringify(a.region)})
secret = json.loads(sm.get_secret_value(SecretId=${JSON.stringify(a.secretArn)})["SecretString"])
db_name = args["database"]
if not all(ch.isalnum() or ch in "_$.-" for ch in db_name):
    raise SystemExit("illegal database name: %r" % db_name)
query = ${JSON.stringify(sql)}.replace("__DB__", db_name)
df = (spark.read.format("jdbc")
      .option("url", ${JSON.stringify(a.jdbcUrl)})
      .option("driver", ${JSON.stringify(a.driverClass)})
      .option("user", secret["username"])
      .option("password", secret["password"])${timeoutOpts}
      .option("dbtable", "(" + query + ") t")
      .load())
rows = df.collect()
DEFAULT_SCHEMA = ${JSON.stringify(defSchema)}
tables = {}
for r in sorted(rows, key=lambda x: (str(x["tbl_schema"] or ""), str(x["tbl_name"] or ""), int(x["col_pos"] or 0))):
    schema = str(r["tbl_schema"] or "")
    name = str(r["tbl_name"] or "")
    full = name if (not DEFAULT_SCHEMA or schema == DEFAULT_SCHEMA or not schema) else schema + "." + name
    t = tables.setdefault(full, {"name": full, "database": db_name, "columns": []})
    nullable = str(r["col_nullable"] or "").upper()
    t["columns"].append({
        "name": str(r["col_name"] or ""),
        "type": str(r["col_type"] or ""),
        "nullable": nullable in ("YES", "Y"),
        "key": str(r["col_key"] or ""),
        "comment": str(r["col_comment"] or ""),
    })
# Python 3.13(Glue 6.0)起 datetime.utcnow() 已弃用 ⇒ 用带时区的 now(UTC),输出形状不变
out = {"database": db_name, "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "via": "glue-discovery",
       "tables": [tables[k] for k in sorted(tables.keys())]}
uri = args["result_uri"]
assert uri.startswith("s3://"), uri
bucket, key = uri[5:].split("/", 1)
boto3.client("s3", region_name=${JSON.stringify(a.region)}).put_object(Bucket=bucket, Key=key, Body=json.dumps(out).encode("utf-8"), ContentType="application/json")
print("DISCOVERY_DONE tables=%d" % len(out["tables"]))
`;
}

export type DiscoveryRecord = NonNullable<DataSource["discovery"]>;
export type DiscoveredSchema = NonNullable<DataSource["discoveredSchema"]>;

/** StartJobRun 撞 Glue 并发上限时的退避参数(单一处;单测钉它)。 */
export const GLUE_CONCURRENT_RETRY = { attempts: 4, backoffMs: 5_000 } as const;
/** Glue 里「还占着并发名额」的运行状态(终态 SUCCEEDED / FAILED / STOPPED / TIMEOUT / ERROR 不算)。 */
export const GLUE_ACTIVE_RUN_STATES: ReadonlySet<string> = new Set(["STARTING", "RUNNING", "STOPPING", "WAITING"]);

export function isConcurrentRunsExceeded(e: unknown): boolean {
  const name = String((e as { name?: unknown })?.name || "");
  const msg = String((e as { message?: unknown })?.message || "");
  return name === "ConcurrentRunsExceededException" || /Concurrent runs exceeded/i.test(msg);
}

/**
 * 起一次作业运行;撞 `ConcurrentRunsExceededException`(作业定义 MaxConcurrentRuns=1)时**不**把它当失败抛给用户:
 *   ① 先看这个作业有没有**在途**运行(别人 / 页面另一处刚起的那次,且 `--database` 相同)⇒ 认领它(它的结论就是这次要的);
 *   ② 没有在途运行(Glue 的并发计数在上一次运行**刚结束后**会滞后几十秒才释放)⇒ 退避 backoffMs 再起,最多 attempts 次;
 *   ③ 仍被拒 ⇒ 原错误抛出(调用方照旧 502,如实)。其它错误一律直接抛,不吞。
 * 🔴 (2026-10-18 第三十九轮硬门 s38 70f,CloudTrail 坐实):同一发现作业 07:32:04Z 起一次(SUCCEEDED),07:34:13Z 用户再
 *   「刷新」时 StartJobRun 被拒 ConcurrentRunsExceededException ⇒ 页面收到 502「经 Glue 连接发现表失败: Concurrent runs exceeded.」。
 *   用户在表刚发现完就点刷新是正常操作,不该看到这个。认领 / 退避的算法只写在这里,`startDiscovery` 必须经它起运行。
 */
/** 只要求「能 send」:真 GlueClient 与单测里的假客户端都满足(GlueClient.send 是重载泛型,unknown 签名接不住它)。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GlueSender = { send: (cmd: any) => Promise<any> };

export async function startRunAdoptingConcurrent(
  glue: GlueSender,
  jobName: string,
  args: Record<string, string>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ jobRunId: string; adopted: boolean }> {
  let lastErr: unknown;
  for (let i = 0; i < GLUE_CONCURRENT_RETRY.attempts; i++) {
    try {
      const started = (await glue.send(new StartJobRunCommand({ JobName: jobName, Arguments: args }))) as { JobRunId?: string };
      return { jobRunId: started.JobRunId || "", adopted: false };
    } catch (e) {
      if (!isConcurrentRunsExceeded(e)) throw e;
      lastErr = e;
      const runs = (await glue.send(new GetJobRunsCommand({ JobName: jobName, MaxResults: 5 }))) as {
        JobRuns?: Array<{ Id?: string; JobRunState?: string; Arguments?: Record<string, string> }>;
      };
      const active = (runs.JobRuns || []).find(
        (r) => GLUE_ACTIVE_RUN_STATES.has(String(r.JobRunState || "")) && String(r.Arguments?.["--database"] || "") === String(args["--database"] || ""),
      );
      if (active?.Id) return { jobRunId: active.Id, adopted: true };
      if (i < GLUE_CONCURRENT_RETRY.attempts - 1) await sleep(GLUE_CONCURRENT_RETRY.backoffMs);
    }
  }
  throw lastErr;
}

/** 起一次发现:生成脚本 → 写脚本桶 → 建 / 更新作业(upsertGlueJob,与同步作业同一作者)→ StartJobRun(经 startRunAdoptingConcurrent)。 */
export async function startDiscovery(ds: GlueReachDs, database: string): Promise<DiscoveryRecord> {
  if (!dsCanUseGlueReach(ds)) throw new Error("该数据源没有 Glue 连接或不是 JDBC 源,无法经 Glue 连接发现表");
  if (!ds.secretArn) throw new Error("该数据源没有凭证(secretArn),发现作业无法登录源库");
  const db = assertDiscoveryDatabase(database);
  const b = await bindingOf(ds);
  const glue = await glueClientFor(b.region);
  const s3 = await s3ClientFor(b.region);
  const cm = getProvider(ds.type).buildConnection(toSourceRef(ds as unknown as Parameters<typeof toSourceRef>[0]));
  if (!cm.jdbcUrl || !cm.driverClass) throw new Error(`数据源类型 ${ds.type} 没有 JDBC 连接模型,无法经 Glue 连接发现表`);
  // 发现作业要经数据源自己的 Glue 连接登录源库 ⇒ 连接 / 平台组 / 子网先核对自愈(与同步启动核心同一作者);
  //   用户自带对象 / 密钥缺失 ⇒ 抛类型化错误,调用方(reachability-probe / tables 路由)按可读失败落心跳,不冒 500 / 不留「测试中」。
  const net = await reconcileDatasourceNetwork(ds, { via: "ds.discovery" });
  if (net.kind === "broken") throw new DatasourceNetworkBrokenError(net.issue);
  const script = buildDiscoveryScript({ dbType: ds.type, jdbcUrl: cm.jdbcUrl, driverClass: cm.driverClass, secretArn: ds.secretArn, region: b.region });
  const bucket = b.scriptsBucket;
  const scriptKey = `glue-scripts/discover-${ds.datasourceId}.py`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: scriptKey, Body: script }));
  const jobName = discoveryJobName(ds.datasourceId);
  const def: GlueJobDefinition = {
    Role: b.roleArn,
    Description: `数据源 ${ds.datasourceId} 经 Glue 连接发现表(平台托管,勿手工运行)`,
    Command: { Name: "glueetl", ScriptLocation: `s3://${bucket}/${scriptKey}`, PythonVersion: "3" },
    GlueVersion: GLUE_DISCOVERY_JOB.glueVersion,
    NumberOfWorkers: GLUE_DISCOVERY_JOB.numberOfWorkers,
    WorkerType: GLUE_DISCOVERY_JOB.workerType,
    Timeout: GLUE_DISCOVERY_JOB.timeoutMinutes,
    MaxRetries: 0,
    ExecutionProperty: { MaxConcurrentRuns: 1 },
    DefaultArguments: { "--job-language": "python", "--TempDir": `s3://${bucket}/temp/` },
    Connections: { Connections: [ds.glueConnectionName!] },
  };
  await upsertGlueJob(glue, jobName, def);
  const resultKey = `discover/${ds.datasourceId}/${db}.json`;
  const started = await startRunAdoptingConcurrent(glue, jobName, { "--result_uri": `s3://${bucket}/${resultKey}`, "--database": db });
  return {
    state: "running", jobName, jobRunId: started.jobRunId, startedAt: new Date().toISOString(),
    database: db, bucket, resultKey, region: b.region,
  };
}

export type DiscoveryRead =
  | { state: "running" }
  | { state: "succeeded"; schema: DiscoveredSchema }
  | { state: "failed"; error: string }
  /** 超过 GLUE_DISCOVERY_BUDGET_MS 还没终态:浏览表按失败处理;探测按 unknown 处理(不猜) */
  | { state: "timeout"; error: string };

/** 读发现作业:RUNNING ⇒ running;SUCCEEDED ⇒ 读结果 JSON;其余终态 ⇒ failed(带 Glue 的 ErrorMessage);超预算 ⇒ timeout。 */
export async function readDiscovery(rec: DiscoveryRecord, now: Date = new Date()): Promise<DiscoveryRead> {
  const glue = await glueClientFor(rec.region);
  const r = (await glue.send(new GetJobRunCommand({ JobName: rec.jobName, RunId: rec.jobRunId }))) as {
    JobRun?: { JobRunState?: string; ErrorMessage?: string };
  };
  const state = String(r.JobRun?.JobRunState ?? "");
  if (state === "SUCCEEDED") {
    const s3 = await s3ClientFor(rec.region);
    const obj = (await s3.send(new GetObjectCommand({ Bucket: rec.bucket, Key: rec.resultKey }))) as { Body?: { transformToString(): Promise<string> } };
    const text = obj.Body ? await obj.Body.transformToString() : "";
    let parsed: { database?: string; generatedAt?: string; tables?: DiscoveredSchema["tables"] };
    try { parsed = JSON.parse(text); } catch { return { state: "failed", error: "发现作业成功但结果 JSON 解析失败" }; }
    return {
      state: "succeeded",
      schema: { at: parsed.generatedAt || now.toISOString(), database: parsed.database || rec.database, via: "glue-discovery", tables: Array.isArray(parsed.tables) ? parsed.tables : [] },
    };
  }
  if (["FAILED", "STOPPED", "TIMEOUT", "ERROR", "STOPPING"].includes(state)) {
    return { state: "failed", error: r.JobRun?.ErrorMessage || `发现作业 ${state}` };
  }
  if (now.getTime() - new Date(rec.startedAt).getTime() > GLUE_DISCOVERY_BUDGET_MS) {
    return { state: "timeout", error: `发现作业 ${Math.round(GLUE_DISCOVERY_BUDGET_MS / 60_000)} 分钟内没有结束(最近状态 ${state || "无"})` };
  }
  return { state: "running" };
}

// ── 推进一步(浏览表 / 向导 / 检测共用;落库由调用方的 persist 执行,本模块只管 Glue)─────────────────

// 回写函数回「patched / gone」(源已删即丢弃),这里只关心它完成,不关心结论
export type DiscoveryPersist = (patch: Record<string, unknown>) => Promise<unknown>;

export type DiscoveryStep =
  | { kind: "running"; rec: DiscoveryRecord; started: boolean }
  | { kind: "succeeded"; rec: DiscoveryRecord; schema: DiscoveredSchema }
  | { kind: "failed"; rec: DiscoveryRecord; error: string; timedOut: boolean }
  | { kind: "cached"; schema: DiscoveredSchema };

/** 把一次已有终态的读取结果落到源行(发现记录 + 成功时的表清单),返回落库后的记录。 */
async function settleDiscovery(rec: DiscoveryRecord, r: Exclude<DiscoveryRead, { state: "running" }>, persist: DiscoveryPersist): Promise<DiscoveryStep> {
  const finishedAt = new Date().toISOString();
  if (r.state === "succeeded") {
    const done: DiscoveryRecord = { ...rec, state: "succeeded", finishedAt };
    await persist({ discovery: done, discoveredSchema: r.schema });
    return { kind: "succeeded", rec: done, schema: r.schema };
  }
  const failed: DiscoveryRecord = { ...rec, state: "failed", finishedAt, error: r.error };
  await persist({ discovery: failed });
  return { kind: "failed", rec: failed, error: r.error, timedOut: r.state === "timeout" };
}

/**
 * 推进一步发现:
 *   在跑(同一个库)⇒ 读一次状态,终态落库;有缓存且不要求刷新 ⇒ cached;否则起新的一次(落库 running)。
 */
export async function advanceDiscovery(ds: GlueReachDs, database: string, opts: { refresh: boolean; persist: DiscoveryPersist }): Promise<DiscoveryStep> {
  noteDatasourceRowPlace(ds);
  const db = String(database || "");
  const rec = ds.discovery;
  if (rec && rec.state === "running" && rec.database === db) {
    const r = await readDiscovery(rec);
    if (r.state === "running") return { kind: "running", rec, started: false };
    return settleDiscovery(rec, r, opts.persist);
  }
  const cached = ds.discoveredSchema;
  if (!opts.refresh && cached && cached.database === db) return { kind: "cached", schema: cached };
  const started = await startDiscovery(ds, db);
  await opts.persist({ discovery: started });
  return { kind: "running", rec: started, started: true };
}

// ── 探测(「检测」按钮经 Glue 连接那一段)= 同一个发现作业 ─────────────────────────────────────

export type GlueProbeStart = { startedAt: string; jobRunId: string; reused: boolean };

/**
 * 发起探测:已有一次发现作业在跑 ⇒ 复用它(它的结论就是这次探测的结论);否则起新的一次(即使有缓存的表清单 —— 「检测」要的是现在)。
 * 前一次已经结束但还没人读 ⇒ 先把它的结论落库,再起新的。
 */
export async function startGlueProbe(ds: GlueReachDs, persist: DiscoveryPersist): Promise<GlueProbeStart> {
  noteDatasourceRowPlace(ds); // 建源收口 / 检测起探都从这里打 Glue(第一个 await 之前)
  if (!dsCanUseGlueReach(ds)) throw new Error("该数据源没有 Glue 连接或不是 JDBC 源,无法经 Glue 连接探测");
  const rec = ds.discovery;
  if (rec && rec.state === "running") {
    const r = await readDiscovery(rec);
    if (r.state === "running") return { startedAt: rec.startedAt, jobRunId: rec.jobRunId, reused: true };
    await settleDiscovery(rec, r, persist);
  }
  if (!String(ds.database || "").trim()) throw new Error("数据源没有填写数据库名,无法经 Glue 连接探测(发现作业要登录到具体的库)");
  const started = await startDiscovery(ds, String(ds.database));
  await persist({ discovery: started });
  return { startedAt: started.startedAt, jobRunId: started.jobRunId, reused: false };
}

export type GlueProbeRead =
  | { state: "testing" }
  | { state: "settled"; reachable: boolean; reason?: string; validatedAt: string }
  | { state: "unknown"; reason: string };

/**
 * 读探测结论:看源行上的发现记录 ——
 *   在跑 ⇒ 读作业状态(终态落库);已结束且结束时间不早于本次起点(放 10s 余量)⇒ 直接用它;
 *   超预算 / 记录没了 / 结束时间早于起点 ⇒ unknown(如实说没结果,不猜)。
 */
export async function readGlueProbe(ds: GlueReachDs, hb: { startedAt: string }, persist: DiscoveryPersist): Promise<GlueProbeRead> {
  noteDatasourceRowPlace(ds); // 列表 / 单条 / 心跳 GET 经 settleGlueProbeRows 推进「验证中」行 ⇒ GetJobRun 在这里(2026-10-23 …9435 复验:`glue.GetJobRun /api/datasources` 仍未归因的根因 —— 此前只在 advanceDiscovery 记)
  const rec = ds.discovery;
  if (!rec) return { state: "unknown", reason: "探测对应的发现作业记录不存在(可能已被删除),请再点一次「检测」" };
  const started = new Date(hb.startedAt).getTime();
  let step: DiscoveryStep;
  if (rec.state === "running") {
    const r = await readDiscovery(rec);
    if (r.state === "running") return { state: "testing" };
    step = await settleDiscovery(rec, r, persist);
  } else {
    const finishedAt = rec.finishedAt ? new Date(rec.finishedAt).getTime() : NaN;
    if (!(finishedAt >= started - 10_000)) {
      return { state: "unknown", reason: "本次探测起点之后没有新的发现作业结果,请再点一次「检测」" };
    }
    step = rec.state === "succeeded"
      ? { kind: "succeeded", rec, schema: ds.discoveredSchema ?? { at: rec.finishedAt!, database: rec.database, via: "glue-discovery", tables: [] } }
      : { kind: "failed", rec, error: rec.error || "发现作业失败(未给出原因)", timedOut: false };
  }
  if (step.kind === "succeeded") return { state: "settled", reachable: true, validatedAt: step.rec.finishedAt! };
  if (step.kind === "failed" && step.timedOut) return { state: "unknown", reason: step.error };
  if (step.kind === "failed") return { state: "settled", reachable: false, reason: step.error, validatedAt: step.rec.finishedAt! };
  return { state: "testing" };
}

/**
 * 删数据源时连带撤掉发现作业与它的脚本 / 结果对象(同一原则:删对象不留孤儿)。
 * 最佳努力:作业不存在不算错;别的错记日志不阻塞删行(返回残留清单让调用方写进日志)。
 */
export async function teardownDiscoveryArtifacts(ds: Pick<GlueReachDs, "datasourceId" | "ownerTargetId" | "discovery">): Promise<string[]> {
  const left: string[] = [];
  let b: Awaited<ReturnType<typeof resolveGlueBinding>>;
  try {
    b = await bindingOf(ds);
  } catch (e) {
    return [`落点解析失败,发现作业 ${discoveryJobName(ds.datasourceId)} 未清理:${String((e as Error)?.message || e).slice(0, 120)}`];
  }
  const glue = await glueClientFor(b.region);
  const s3 = await s3ClientFor(b.region);
  const jobName = discoveryJobName(ds.datasourceId);
  try {
    const { DeleteJobCommand } = await import("@aws-sdk/client-glue");
    await glue.send(new DeleteJobCommand({ JobName: jobName }));
  } catch (e: unknown) {
    const err = (e ?? {}) as { name?: string; message?: string };
    if (!(err.name === "EntityNotFoundException" || /not found/i.test(String(err.message ?? "")))) left.push(`Glue 作业 ${jobName}:${String(err.message ?? err.name).slice(0, 120)}`);
  }
  try {
    const { DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new DeleteObjectCommand({ Bucket: b.scriptsBucket, Key: `glue-scripts/discover-${ds.datasourceId}.py` }));
    const prefix = `discover/${ds.datasourceId}/`;
    const listed = (await s3.send(new ListObjectsV2Command({ Bucket: b.scriptsBucket, Prefix: prefix }))) as { Contents?: Array<{ Key?: string }> };
    const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: b.scriptsBucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
  } catch (e: unknown) {
    left.push(`脚本桶 ${b.scriptsBucket} 的发现脚本 / 结果:${String((e as Error)?.message || e).slice(0, 120)}`);
  }
  return left;
}

/** 页面 / 接口统一用的一句说明。 */
export function glueReachNote(kind: "probe" | "discovery", controlPlaneError?: string | null): string {
  const cp = controlPlaneError ? `控制面直连不到该源(${controlPlaneError.slice(0, 120)});源在自有网络时这是正常的。` : "";
  return kind === "probe"
    ? `${cp}已改经数据源自己的 Glue 连接探测(一次性 Glue 作业在该连接的子网 / 安全组里登录源库,成功即顺带带回表清单,通常 1–3 分钟)。`
    : `${cp}已改经数据源自己的 Glue 连接发现表(一次性 Glue 作业读 information_schema,通常 1–3 分钟)。`;
}
