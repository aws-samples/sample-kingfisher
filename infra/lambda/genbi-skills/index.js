// 主 handler：按 Gateway 传入的工具名分发到对应技能。
const H = require("./rs.js");
const dns = require("dns").promises;
const net = require("net");
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
// @genbi/core 编译产物:口径 grounding 检索(过滤+相关性排序+截断)与 body→definition 映射
// 收敛于 core,与平台 getContextForGrounding 共用同一算法（消灭 Lambda 本地副本）。
const { filterAndRankContext, contextToGroundingItems } = require("./core-dist/context-format");
// Athena/Trino 只读守卫:放行 SHOW/DESCRIBE/EXPLAIN 元数据语句(Redshift 版 sanitizeSelect
// 会误拒),写/DDL 仍全拒。与平台 athena/sql-guard 共用同一份(消灭 Athena 守卫方言副本)。
const { sanitizeReadOnly } = require("./core-dist/sql-guard");

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const CTX_TABLE = process.env.GENBI_CONTEXT_TABLE || "bgp-genbi-context";
const SKILLS_TABLE = process.env.GENBI_SKILLS_TABLE || "bgp-genbi-skills";
// HTTP 技能出站域名白名单（逗号分隔；为空表示不限定域名，仍受内网 IP 守卫约束）。
const HTTP_ALLOWLIST = (process.env.GENBI_HTTP_ALLOWLIST || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const HTTP_TIMEOUT_MS = parseInt(process.env.GENBI_HTTP_TIMEOUT_MS || "8000", 10);
const HTTP_MAX_BYTES = parseInt(process.env.GENBI_HTTP_MAX_BYTES || "200000", 10);

// ── OpenMetadata 只读描述(供容器 retrieval 语义检索用；当前阶段3 路线B)──
// 容器(AgentCore Runtime)非 VPC、无 secretsmanager 权限;OM 读取放在此 Lambda(有 secretsmanager
// + 公网出站),容器经 MCP 工具 fetch_om_descriptions 取表描述,自己只做 LLM 重排。与平台
// lib/openmetadata/om-client.ts 同源认证(bot token 优先,回退 admin basic-auth 登录)。
const OM_URL = (process.env.OPENMETADATA_URL || "").replace(/\/$/, "");
const OM_BOT_SECRET_ID = process.env.OM_BOT_SECRET_ID || "bgp/om/ingestion-bot-token";
const OM_ADMIN_EMAIL = process.env.OM_ADMIN_EMAIL || "admin@open-metadata.org";
// 🔴 生产上线批次 A:管理员口令从 Secrets Manager 读(与平台 om-client 同一个密钥),不再缺省成出厂口令 admin。
const OM_ADMIN_SECRET_ID = process.env.OM_ADMIN_SECRET_ID || "bgp/om/admin-password";
async function omAdminPassword() {
  if (process.env.OM_ADMIN_PASSWORD) return process.env.OM_ADMIN_PASSWORD;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
    const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: OM_ADMIN_SECRET_ID }));
    return (SecretString || "").trim();
  } catch { return ""; }
}

// 🔴🔴 Athena 两个工具原来用模块级主控区客户端 + 主控区工作组 + 主控区联邦目录前缀 ⇒ 别的区问数据湖全落回主控区。
//   现在落点逐次从入参取(`H.athPlaceOf(args)`,容器在唯一漏斗里注入),并把**真落点**回报给容器(`ranIn`)。
async function athenaQuery(sql, database, args) {
  // Athena 用 Trino 方言只读守卫(放行 SHOW/DESCRIBE/EXPLAIN 元数据语句;此前误用 Redshift 版
  // sanitizeSelect 会把这些合法只读语句拒掉)。写/DDL 仍全拒。
  const g = sanitizeReadOnly(sql, H.MAX_ROWS);
  if (!g.ok) return { success: false, error: g.error };
  const place = H.athPlaceOf(args);
  const ranIn = { engine: "athena", region: place.region, workgroup: place.workgroup };
  try {
    console.log(JSON.stringify({ tag: "ath-place", region: place.region, workgroup: place.workgroup, catalogRef: place.catalogRef,
      fromArgs: !!(args && (args.athRegion || args.athWorkgroup)) }));
  } catch (_) { /* 日志绝不影响执行 */ }
  const athena = H.athenaClientFor(place.region);
  const start = await athena.send(new H.StartQueryExecutionCommand({
    QueryString: g.sql, WorkGroup: place.workgroup,
    QueryExecutionContext: { Catalog: place.catalogRef, Database: database || H.S3T_NAMESPACE },
    ...(place.outputLocation ? { ResultConfiguration: { OutputLocation: place.outputLocation } } : {}),
  }));
  const qid = start.QueryExecutionId;
  for (let i = 0; i < 50; i++) {
    await H.sleep(900);
    const ex = await athena.send(new H.GetQueryExecutionCommand({ QueryExecutionId: qid }));
    const st = ex.QueryExecution?.Status?.State;
    if (st === "SUCCEEDED") {
      const r = await athena.send(new H.GetQueryResultsCommand({ QueryExecutionId: qid, MaxResults: H.MAX_ROWS + 1 }));
      const rowsRaw = r.ResultSet?.Rows || [];
      const columns = (rowsRaw[0]?.Data || []).map((d) => d.VarCharValue ?? "");
      const rows = rowsRaw.slice(1).map((row) => (row.Data || []).map((d) => (d.VarCharValue ?? null)));
      return { success: true, columns, rows, rowCount: rows.length, ranIn };
    }
    if (st === "FAILED" || st === "CANCELLED")
      return { success: false, error: ex.QueryExecution?.Status?.StateChangeReason || st, ranIn };
  }
  return { success: false, error: "Athena 查询超时", ranIn };
}

async function introspectS3Tables(namespace, args) {
  // 命名空间优先用调用方传入(前端选中的 gamedata 等);未传回退默认常量。
  // 此前写死 S3T_NAMESPACE(默认 ecommerce),游戏环境无该命名空间 → S3Tables 404。
  const ns = (namespace && String(namespace).trim()) || H.S3T_NAMESPACE;
  const ref = `"${H.athPlaceOf(args).catalogRef}"`; // 联邦目录前缀(双引号内含斜杠)—— 🔴 该区的,不是主控区常量
  const sql = `SELECT table_name, column_name, data_type FROM ${ref}.information_schema.columns
    WHERE table_schema = '${ns}' ORDER BY table_name, ordinal_position`;
  const out = await athenaQuery(sql, ns, args);
  if (!out.success) return out;
  const map = {};
  for (const row of out.rows) {
    const [t, col, ty] = row;
    if (!t) continue;
    if (!map[t]) map[t] = { schema: ns, table: t, columns: [] };
    if (col) map[t].columns.push({ name: col, type: ty });
  }
  return { success: true, tables: Object.values(map) };
}

function toolNameOf(context) {
  // AgentCore Gateway 把工具名放在 clientContext.Custom.bedrockAgentCoreToolName（"<target>___<tool>"）。
  const raw = context?.clientContext?.Custom?.bedrockAgentCoreToolName
    || context?.clientContext?.custom?.bedrockAgentCoreToolName || "";
  const parts = String(raw).split("___");
  return parts[parts.length - 1] || raw;
}

// ── fetch_om_descriptions 工具(当前阶段3 路线B):读 OpenMetadata 表描述供容器 retrieval ──
// 认证与平台 om-client.ts 同源:优先 SecretsManager 里的 ingestion-bot JWT,回退 admin basic-auth 登录。
// best-effort:任何失败返回空 map,retrieval 侧会回退全表 grounding,绝不阻断问数。
let _omToken = null, _omTokenExpiry = 0;
async function getOmToken() {
  const now = Date.now();
  if (_omToken && now < _omTokenExpiry) return _omToken;
  // 1) 优先 bot token(SecretsManager;Lambda 已有 secretsmanager 权限)
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
    const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: OM_BOT_SECRET_ID }));
    const bot = (SecretString || "").trim();
    if (bot) { _omToken = bot; _omTokenExpiry = now + 3600 * 1000; return bot; }
  } catch { /* secret 不存在/无权 → 回退 admin 登录 */ }
  // 2) 回退 admin basic-auth 登录(与 om-client.ts 一致:密码 base64)
  if (!OM_URL) return "";
  const adminPw = await omAdminPassword();
  if (!adminPw) return ""; // 读不到口令 ⇒ 不登录(绝不拿出厂口令去试)
  try {
    const res = await fetch(`${OM_URL}/api/v1/users/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: OM_ADMIN_EMAIL, password: Buffer.from(adminPw).toString("base64") }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    _omToken = data.accessToken || "";
    _omTokenExpiry = now + ((data.expiryDuration || 3600) * 1000) - 300000;
    return _omToken || "";
  } catch { return ""; }
}
async function fetchOmDescriptions() {
  // 返回 { tableName(lowercase): description }。与平台 retrieval.ts fetchOmDescriptions 同契约。
  if (!OM_URL) return { success: true, descriptions: {} };
  const token = await getOmToken();
  if (!token) return { success: true, descriptions: {} };
  try {
    const res = await fetch(`${OM_URL}/api/v1/tables?fields=description&limit=500`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { success: true, descriptions: {} };
    const data = await res.json();
    const out = {};
    for (const t of (data && data.data) || []) {
      const name = (t.name || "").toLowerCase();
      const desc = (t.description || "").trim();
      if (name && desc) out[name] = desc;
    }
    return { success: true, descriptions: out };
  } catch { return { success: true, descriptions: {} }; }
}

async function lookupBusinessContext(args) {
  // 查业务知识/口径/规则:项目 + global。返回紧凑条目供 Agent grounding。
  // 只保留 DynamoDB 读取(IO);过滤/相关性排序/截断 + body→definition 映射均走 @genbi/core
  // (与平台 getContextForGrounding 共用同一算法,消灭跨语言副本)。
  const projectId = (args && args.projectId) || "proj-default";
  const keywords = (args && args.keywords) || "";
  const queryPk = async (pk) => {
    try {
      const r = await ddb.send(new QueryCommand({
        TableName: CTX_TABLE,
        KeyConditionExpression: "projectId = :p",
        ExpressionAttributeValues: { ":p": { S: pk } },
      }));
      return (r.Items || []).map((it) => unmarshall(it));
    } catch { return []; }
  };
  const raw = [...(await queryPk(projectId)), ...(projectId === "global" ? [] : await queryPk("global"))];
  const entries = filterAndRankContext(raw, keywords);
  return { success: true, count: entries.length, entries: contextToGroundingItems(entries) };
}

// ── 数据驱动注册技能(零部署热加载):列举 + 执行 ──
async function listSkillRows(projectId) {
  const q = async (pk) => {
    try {
      const r = await ddb.send(new QueryCommand({ TableName: SKILLS_TABLE, KeyConditionExpression: "projectId = :p", ExpressionAttributeValues: { ":p": { S: pk } } }));
      return (r.Items || []).map((it) => unmarshall(it));
    } catch { return []; }
  };
  return [...(await q(projectId)), ...(projectId === "global" ? [] : await q("global"))];
}
async function listRegisteredSkills(args) {
  const rows = (await listSkillRows((args && args.projectId) || "proj-default")).filter((s) => s.enabled !== false);
  return {
    success: true, count: rows.length,
    skills: rows.map((s) => ({
      name: s.name, description: s.description,
      kind: s.kind === "http" ? "http" : "sql",
      engine: s.kind === "http" ? "http(外部API)" : s.engine,
      params: (s.params || []).map((p) => ({ name: p.name, type: p.type, description: p.description, required: p.required })),
    })),
  };
}

// 参数渲染：SQL 模板用（标识符/数字校验，字符串加单引号转义）。
function renderTemplate(tpl, params, paramDefs) {
  const types = {}; (paramDefs || []).forEach((p) => { types[p.name] = p.type; });
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name) => {
    const t = types[name] || "string";
    const v = params ? params[name] : undefined;
    if (v === undefined || v === null || v === "") throw new Error(`缺少参数 ${name}`);
    if (t === "number") { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`); return String(n); }
    if (t === "identifier") { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(v))) throw new Error(`参数 ${name} 非法标识符`); return String(v); }
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

// 参数渲染：HTTP 技能用。mode=url → encodeURIComponent；mode=body → JSON 字符串转义（作者自行加引号）。
function renderHttp(tpl, params, paramDefs, mode) {
  const types = {}; (paramDefs || []).forEach((p) => { types[p.name] = p.type; });
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name) => {
    const t = types[name] || "string";
    const v = params ? params[name] : undefined;
    if (v === undefined || v === null || v === "") throw new Error(`缺少参数 ${name}`);
    if (t === "number") { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字`); return String(n); }
    if (t === "identifier") { if (!/^[A-Za-z0-9_.-]+$/.test(String(v))) throw new Error(`参数 ${name} 非法标识符`); return String(v); }
    const s = String(v);
    if (mode === "url") return encodeURIComponent(s);
    // body(JSON 上下文)：转义但不加外层引号，模板作者写 "{{name}}"。
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  });
}

// ── SSRF 守卫 ──
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;                 // link-local（含 169.254.169.254 元数据）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80")) return true;                       // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA
    if (low.startsWith("::ffff:")) return isPrivateIp(low.replace("::ffff:", ""));
    return false;
  }
  return true; // 解析不出 → 保守拒绝
}
function hostAllowed(host) {
  if (HTTP_ALLOWLIST.length === 0) return true;
  const h = host.toLowerCase();
  return HTTP_ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function fmtCell(v) { if (v == null) return null; if (typeof v === "object") return JSON.stringify(v); return String(v); }
function httpJsonToTable(json, resultPath) {
  const data = getPath(json, resultPath);
  if (Array.isArray(data)) {
    if (data.length === 0) return { success: true, columns: [], rows: [], rowCount: 0 };
    if (data[0] && typeof data[0] === "object") {
      const cols = Array.from(new Set(data.flatMap((o) => Object.keys(o || {})))).slice(0, 60);
      const rows = data.slice(0, H.MAX_ROWS).map((o) => cols.map((c) => fmtCell(o ? o[c] : null)));
      return { success: true, columns: cols, rows, rowCount: rows.length };
    }
    return { success: true, columns: ["value"], rows: data.slice(0, H.MAX_ROWS).map((v) => [fmtCell(v)]), rowCount: Math.min(data.length, H.MAX_ROWS) };
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data).slice(0, H.MAX_ROWS);
    return { success: true, columns: ["key", "value"], rows: keys.map((k) => [k, fmtCell(data[k])]), rowCount: keys.length };
  }
  return { success: true, columns: ["value"], rows: [[fmtCell(data)]], rowCount: 1 };
}

// HTTP/外部 API 技能执行（含 SSRF 守卫：https-only + 域名白名单 + 内网 IP 拒绝 + 禁重定向 + 超时 + 限长）。
async function executeHttpSkill(s, params) {
  const cfg = s.http || {};
  if (!cfg.urlTemplate) return { success: false, error: "HTTP 技能缺少 urlTemplate" };
  let url;
  try { url = renderHttp(cfg.urlTemplate, params, s.params, "url"); }
  catch (e) { return { success: false, error: e.message }; }
  let u;
  try { u = new URL(url); } catch { return { success: false, error: "非法 URL" }; }
  if (u.protocol !== "https:") return { success: false, error: "只允许 https 出站请求" };
  if (!hostAllowed(u.hostname)) return { success: false, error: `域名不在允许列表: ${u.hostname}` };
  // DNS 解析后逐地址校验，拒绝解析到内网/链路本地/元数据地址（防 SSRF）。
  let addrs = [];
  try { addrs = (await dns.lookup(u.hostname, { all: true })).map((a) => a.address); }
  catch { return { success: false, error: `DNS 解析失败: ${u.hostname}` }; }
  if (!addrs.length || addrs.some(isPrivateIp)) return { success: false, error: "目标解析到内网/受限地址，已拒绝" };

  const method = (cfg.method || "GET").toUpperCase();
  const headers = { Accept: "application/json", ...(cfg.headers || {}) };
  let body;
  if (["POST", "PUT", "PATCH"].includes(method) && cfg.bodyTemplate) {
    try { body = renderHttp(cfg.bodyTemplate, params, s.params, "body"); }
    catch (e) { return { success: false, error: e.message }; }
    if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let resp, text;
  try {
    resp = await fetch(u.toString(), { method, headers, body, signal: ctrl.signal, redirect: "error" });
    text = await resp.text();
  } catch (e) {
    clearTimeout(timer);
    return { success: false, error: `请求失败: ${String(e && e.message ? e.message : e).slice(0, 200)}` };
  }
  clearTimeout(timer);
  if (text && text.length > HTTP_MAX_BYTES) text = text.slice(0, HTTP_MAX_BYTES);
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${(text || "").slice(0, 300)}` };
  let json;
  try { json = JSON.parse(text); } catch { return { success: true, columns: ["response"], rows: [[(text || "").slice(0, 4000)]], rowCount: 1 }; }
  return httpJsonToTable(json, cfg.resultPath);
}

async function runRegisteredSkill(args) {
  const projectId = (args && args.projectId) || "proj-default";
  const skillName = (args && (args.skill || args.name)) || "";
  if (!skillName) return { success: false, error: "缺少 skill 名" };
  const s = (await listSkillRows(projectId)).find((x) => x.name === skillName && x.enabled !== false);
  if (!s) return { success: false, error: `未找到注册技能: ${skillName}` };
  if (s.kind === "http") return await executeHttpSkill(s, (args && args.params) || {});
  // 默认 SQL 模板技能
  let sql;
  try { sql = renderTemplate(s.sqlTemplate, (args && args.params) || {}, s.params || []); }
  catch (e) { return { success: false, error: e.message }; }
  const out = s.engine === "athena" ? await athenaQuery(sql, undefined, args) : await H.runRedshiftSql(sql, args);
  // 回传渲染后的实际 SQL,供 agent/前端「查看生成的 SQL」展示(命中技能时此前顶层 sql 为空 → 不显示)。
  return { ...out, sql };
}

// ── Observability：每次工具调用发 CloudWatch EMF 指标（namespace BGP/GenBI）。──
// EMF 由 Lambda 日志自动抽取为指标，无需 PutMetricData 权限、零额外时延。
function emitToolMetric(dimName, dimVal, isError) {
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: "BGP/GenBI",
          Dimensions: [[dimName]],
          Metrics: [{ Name: "Calls", Unit: "Count" }, { Name: "Errors", Unit: "Count" }],
        }],
      },
      [dimName]: dimVal,
      Calls: 1,
      Errors: isError ? 1 : 0,
    }));
  } catch { /* 指标失败绝不影响技能执行 */ }
}

exports.handler = async (event, context) => {
  const tool = toolNameOf(context);
  const args = event && typeof event === "object" ? event : {};
  let result;
  try {
    switch (tool) {
      // 落点随 args 传下去(容器确定性注入,不由模型决定)
      case "run_redshift_sql": result = await H.runRedshiftSql(args.sql || "", args); break;
      case "introspect_redshift_schema": result = await H.introspectRedshift(args); break;
      // Athena 两个工具也随 args 拿落点(与 Redshift 同一手法)
      case "run_athena_sql": result = await athenaQuery(args.sql || "", args.namespace || args.database, args); break;
      case "introspect_s3tables_schema": result = await introspectS3Tables(args.namespace || args.database, args); break;
      case "lookup_business_context": result = await lookupBusinessContext(args); break;
      case "fetch_om_descriptions": result = await fetchOmDescriptions(); break;
      case "list_registered_skills": result = await listRegisteredSkills(args); break;
      case "run_registered_skill": result = await runRegisteredSkill(args); break;
      default: result = { success: false, error: `unknown tool: ${tool}` };
    }
  } catch (e) {
    result = { success: false, error: e && e.message ? e.message : String(e) };
  }
  // 计入 Observability：按工具名计数；注册技能再按技能名细分。
  const isErr = !result || result.success === false;
  emitToolMetric("ToolName", tool || "unknown", isErr);
  if (tool === "run_registered_skill" && args && args.skill) emitToolMetric("Skill", String(args.skill), isErr);
  return result;
};
