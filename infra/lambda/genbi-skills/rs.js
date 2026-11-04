// 模块 26 — GenBI on AgentCore：Gateway 技能(skills) Lambda。
// 作为 AgentCore Gateway 的 Lambda target，把"执行只读 SQL / 探查 schema"暴露为 MCP 工具。
// 工具名由 Gateway 经 context.clientContext.Custom.bedrockAgentCoreToolName 传入
//（形如 "<targetName>___<toolName>"）；event 即工具入参(对应 ToolDefinition.InputSchema)。
// 只读、复用平台既有 sql-guard 规则。Lambda Node20 运行时自带 @aws-sdk v3。

const {
  RedshiftDataClient, ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand,
} = require("@aws-sdk/client-redshift-data");
const {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");
const { SecretsManagerClient, DescribeSecretCommand } = require("@aws-sdk/client-secrets-manager");
// @genbi/core 编译产物(CJS,由 scripts/genbi-core-prebuild.sh 从 platform/src/lib/genbi/core 生成)。
// 阶段2:SQL 守卫 sanitizeSelect 与 introspect 用的 SCHEMA_SQL 收敛于 core,消灭本地逐字副本。
const { sanitizeSelect } = require("./core-dist/sql-guard");
const { SCHEMA_SQL } = require("./core-dist/catalog");
// @kf-batch 50-WP31-place-first-class —— 序 4(L6):PlaceWire 读取函数(与平台 / 容器同源)
const { readPlaceWire, placeWireLeg } = require("./core-dist/place-wire");

const REGION = process.env.AWS_REGION || "us-east-1";
const RS_SECRET_NAME = process.env.REDSHIFT_SECRET_NAME || "redshift!bgp-namespace-admin";
// @kf-batch 50-WP31-place-first-class —— 序 4(L6):原来这里还有 REDSHIFT_WORKGROUP / REDSHIFT_DATABASE / ATHENA_WORKGROUP /
//   S3TABLES_CATALOG / S3TABLES_BUCKET 五个主控区缺省值(落点入参缺失时的回落)—— 落点改为必填后它们没有读者了,删掉,
//   免得以后有人又拿它们当「没给就用这个」。
const S3T_NAMESPACE = process.env.S3TABLES_NAMESPACE || "ecommerce";
const MAX_ROWS = parseInt(process.env.GENBI_MAX_ROWS || "200", 10);

// @kf-batch 50-B26-lake-place —— Athena 客户端也按区缓存(原来是一个模块级主控区客户端 ⇒ 别的区问数据湖全落回主控区)。
// 🔴 本文件对 `new AthenaClient` 只此一处(工厂);调用方一律经 `athenaClientFor(place.region)`。
const _athenaClients = new Map();
function athenaClientFor(region) {
  const r = region || REGION;
  let c = _athenaClients.get(r);
  if (!c) { c = new AthenaClient({ region: r }); _athenaClients.set(r, c); }
  return c;
}
const sm = new SecretsManagerClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// @kf-batch 50-WP2-one-agentcore-one-om
// 🔴🔴 **用户 2026-09-10 拍板:「不管你怎么设计,我的要求是:都走同一个 AgentCore 即可。」**
//
// 于是这个技能 Lambda 必须能在**任意执行环境的数仓**上取数,而不是只会用自己 env 里的那一套
// (`AWS_REGION` / `REDSHIFT_WORKGROUP` / 托管 admin 密钥名 —— 那三样全是主控区的)。
// 做法:**落点由调用方逐次传进来**(平台解析好 → 容器**确定性地**注入每次工具调用,不由模型决定),
// (@kf-batch 50-WP31-place-first-class 序 4:原来「缺省回落 env = 主控区」已删 —— 落点必填,见下方 wireOf。)
//
// 🔴 为什么落点必须由平台算、而不是这里现算:「哪个 target 用哪个 workgroup / 哪把密钥」的唯一权威是
// 注册表描述符 + `resolveRedshiftBinding`(50 SPEC §3.1a/§3.9)。在 Lambda 里再实现一遍 = 第二份落点逻辑,
// 而这类副本的失效形态是**静默打回主控区**(见 50 SPEC §3.4.1)。
// 🔴 传的是 secret **ARN**(不是密钥值);读它要 IAM,权限仍由本函数的角色控制。
// 🔴 模块级 `rs` 客户端也走这个缓存 ⇒ 本文件**只剩一处** `new RedshiftDataClient`
//    (infra 侧那道「裸客户端冻结」门禁的计数不变;缓存本身就是这个文件的工厂)。
const _rsClients = new Map();
function rsClientFor(region) {
  const r = region || REGION;
  let c = _rsClients.get(r);
  if (!c) { c = new RedshiftDataClient({ region: r }); _rsClients.set(r, c); }
  return c;
}

// @kf-batch 50-WP31-place-first-class —— 序 4(L6):🔴🔴 落点从**一个** `place` 入参读(PlaceWire v1 的 JSON 文本),
//   原来的 rs* / ath* 八个平面字段合并于此;读取函数与平台、AgentCore 容器**同一份源**(core-dist/place-wire.js)。
//   🔴 **没有缺省值**:原来「入参里没有 ⇒ 回落 env(AWS_REGION / REDSHIFT_WORKGROUP / ATHENA_WORKGROUP = 主控区)」——
//   Gateway 按 InputSchema 过滤掉入参、或容器漏注入时,取数就静默打回主控区(B-26 / 2026-09-10 两次真环境坐实)。
//   现在缺 / 不合法 / 缺这条腿 ⇒ 抛 PlaceWireInvalid,工具返回错误,模型与页面都看得见。
function wireOf(args) {
  const a = (args && typeof args === "object") ? args : {};
  return readPlaceWire(a.place);
}

/** 数仓落点(形状与改动前一致:region / workgroup / database / secretArn)。 */
function placeOf(args) {
  const w = wireOf(args);
  const r = placeWireLeg(w, "redshift");
  return { region: w.region, workgroup: r.workgroup, database: r.database, secretArn: r.secretArn || null };
}

/** 数据湖落点(形状与改动前一致:region / workgroup / outputLocation / catalogRef)。 */
function athPlaceOf(args) {
  const w = wireOf(args);
  const a = placeWireLeg(w, "athena");
  return { region: w.region, workgroup: a.workgroup, outputLocation: a.outputLocation, catalogRef: a.catalogRef };
}

// 统一用 Redshift 托管 admin 密钥(superuser)执行，避免跨执行身份的表属主权限问题
// （与平台 lib/redshift/admin-secret 一致）。按名解析完整 ARN 并缓存。
let _secretArn;
async function getSecretArn() {
  if (_secretArn !== undefined) return _secretArn;
  try {
    const d = await sm.send(new DescribeSecretCommand({ SecretId: RS_SECRET_NAME }));
    _secretArn = d.ARN || null;
  } catch { _secretArn = null; }
  return _secretArn;
}

// 只读 SQL 守卫 sanitizeSelect 已收敛至 @genbi/core（见顶部 require）。
const cell = (c) => { if (c == null) return null; if (c.isNull) return null; const v = Object.values(c)[0]; return v == null ? null : String(v); };

// ── Redshift 只读执行 ──
async function runRedshiftSql(sql, args) {
  const g = sanitizeSelect(sql, MAX_ROWS);
  if (!g.ok) return { success: false, error: g.error };
  const place = placeOf(args);
  // @kf-batch 50-WP4ter-coverage —— 🔴 **落点可观测**(2026-09-10 真环境教训):
  // 落点丢了不会报错,只会在**另一个区**跑完并把结果当成对的;上一次排查花了很久才定位,
  // 就因为这一层完全没有痕迹。⇒ 每次执行都打一行「用的是哪个区/工作组、落点是不是从入参来的」。
  // 只打身份形态,不打 secret 值(与错误脱敏同一条纪律)。
  try {
    console.log(JSON.stringify({
      tag: "rs-place", region: place.region, workgroup: place.workgroup, database: place.database,
      fromArgs: true, hasSecret: !!place.secretArn,
      argKeys: Object.keys(args && typeof args === "object" ? args : {}).sort(),
    }));
  } catch (_) { /* 日志绝不影响执行 */ }
  const client = rsClientFor(place.region);
  // @kf-batch 50-B26-lake-place —— 回报真落点(容器汇总成 `_meta.ranIn`,页面据此说「这次在哪执行」)
  const ranIn = { engine: "redshift", region: place.region, workgroup: place.workgroup };
  const SecretArn = place.secretArn || (await getSecretArn());
  const { Id } = await client.send(new ExecuteStatementCommand({
    Sql: g.sql, WorkgroupName: place.workgroup, Database: place.database,
    ...(SecretArn ? { SecretArn } : {}),
  }));
  for (let i = 0; i < 40; i++) {
    await sleep(800);
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") {
      const r = await client.send(new GetStatementResultCommand({ Id }));
      return { success: true, columns: (r.ColumnMetadata || []).map((c) => c.name || ""),
        rows: (r.Records || []).map((row) => row.map(cell)), rowCount: r.TotalNumRows ?? (r.Records || []).length, ranIn };
    }
    if (d.Status === "FAILED" || d.Status === "ABORTED") return { success: false, error: d.Error || d.Status, ranIn };
  }
  return { success: false, error: "查询超时", ranIn };
}

// SCHEMA_SQL 已收敛至 @genbi/core（见顶部 require）。
async function introspectRedshift(args) {
  const place = placeOf(args);
  const client = rsClientFor(place.region);
  const SecretArn = place.secretArn || (await getSecretArn());
  const { Id } = await client.send(new ExecuteStatementCommand({
    Sql: SCHEMA_SQL, WorkgroupName: place.workgroup, Database: place.database,
    ...(SecretArn ? { SecretArn } : {}),
  }));
  for (let i = 0; i < 40; i++) {
    await sleep(800);
    const d = await client.send(new DescribeStatementCommand({ Id }));
    if (d.Status === "FINISHED") {
      const r = await client.send(new GetStatementResultCommand({ Id }));
      const map = {};
      for (const row of r.Records || []) {
        const s = cell(row[0]), t = cell(row[1]), col = cell(row[2]), ty = cell(row[3]);
        if (!s || !t) continue;
        const k = `${s}.${t}`; if (!map[k]) map[k] = { schema: s, table: t, columns: [] };
        if (col) map[k].columns.push({ name: col, type: ty });
      }
      return { success: true, tables: Object.values(map) };
    }
    if (d.Status === "FAILED" || d.Status === "ABORTED") return { success: false, error: d.Error || d.Status };
  }
  return { success: false, error: "schema 探查超时" };
}

module.exports = { sanitizeSelect, runRedshiftSql, introspectRedshift, placeOf, athPlaceOf, athenaClientFor, StartQueryExecutionCommand,
  GetQueryExecutionCommand, GetQueryResultsCommand, sleep, MAX_ROWS, S3T_NAMESPACE };
