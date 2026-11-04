// (用户 2026-10-15 反馈 ③「数据源缺少 JDBC 连接参数化配置」+ ①「同步遇到空时间戳脏数据报错」)
// 🔴 「附加 JDBC 连接参数」的**唯一作者**:解析 / 校验 / 与方言默认参数合并 / 拼到 URL 上。
//   前端表单(DataSourceModal)、建源 / 编辑路由、provider.buildConnection 都 import 这里,不许各自再写一份正则。
//   纯模块:不引 Node / AWS 依赖,前端 bundle 可直接 import。
//
// 为什么存在:
//   · ① MySQL 里 `0000-00-00 00:00:00` 这类零值日期 / 时间戳(老业务库的「空时间戳」)经 Connector/J 读取时默认抛
//     `Zero date value prohibited`,Spark JDBC 读到这一行整个同步作业就失败(真环境 2026-10-15 p44a 坐实)。
//     Connector/J 的标准解法是连接参数 `zeroDateTimeBehavior=CONVERT_TO_NULL`(零值按 NULL 读入,不丢行、不改好数据),
//     所以 MySQL 方言带这个**默认参数**(mysql.ts `defaultParams`);用户填了同名参数以用户的为准。
//   · ③ 客户源库经常要带 `useSSL=false` / `serverTimezone=…` / `connectTimeout=…` 之类驱动参数,此前 URL 固定是
//     `jdbc:<方言>://host:port/db`,没有任何入口。
//
// 形态:用户填一段 `k=v&k=v`(也接受 `;` 或换行分隔,SQL Server 用户习惯分号);落库存归一化后的 `k=v&k=v`;
//   拼 URL 时按方言风格:mysql / postgresql / oracle 用 `?k=v&k=v`,sqlserver 用 `;k=v;k=v`。
//   键:`[A-Za-z_][A-Za-z0-9_.-]*`;值:不许空白 / 引号 / 反斜杠 / `#` / `?` / `&` / `;`(URL 要嵌进 Glue 脚本的 Python 字符串字面量与
//   Glue 连接属性,这些字符会破坏字面量或被解析成下一个参数);同名键(大小写不敏感)只许出现一次;最多 30 对。

export type JdbcParamPair = readonly [key: string, value: string];
export type JdbcParamStyle = "query" | "semicolon";

export const JDBC_PARAMS_MAX_PAIRS = 30;
export const JDBC_PARAMS_MAX_LEN = 1000;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const VALUE_BAD_RE = /[\s"'\\#?&;]/;

export type JdbcParamsParse =
  | { ok: true; pairs: JdbcParamPair[]; normalized: string }
  | { ok: false; error: string };

/** 解析用户输入(string / null / undefined);空 ⇒ ok 且 pairs=[]、normalized=""。 */
export function parseJdbcParams(raw: unknown): JdbcParamsParse {
  if (raw === undefined || raw === null) return { ok: true, pairs: [], normalized: "" };
  if (typeof raw !== "string") return { ok: false, error: "附加 JDBC 参数必须是字符串(形如 k1=v1&k2=v2)" };
  const text = raw.trim();
  if (!text) return { ok: true, pairs: [], normalized: "" };
  if (text.length > JDBC_PARAMS_MAX_LEN) return { ok: false, error: `附加 JDBC 参数过长(${text.length} > ${JDBC_PARAMS_MAX_LEN} 字符)` };
  const parts = text.replace(/^[?;&]+/, "").split(/[&;\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > JDBC_PARAMS_MAX_PAIRS) return { ok: false, error: `附加 JDBC 参数最多 ${JDBC_PARAMS_MAX_PAIRS} 对(给了 ${parts.length} 对)` };
  const pairs: JdbcParamPair[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) return { ok: false, error: `附加 JDBC 参数「${p}」不是 k=v 形式` };
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) return { ok: false, error: `附加 JDBC 参数名「${key}」不合法(只许字母 / 数字 / _ . -,以字母或 _ 开头)` };
    if (!value) return { ok: false, error: `附加 JDBC 参数「${key}」缺少值` };
    if (VALUE_BAD_RE.test(value)) return { ok: false, error: `附加 JDBC 参数「${key}」的值含有不允许的字符(空白 / 引号 / 反斜杠 / # ? & ;)` };
    const lk = key.toLowerCase();
    if (seen.has(lk)) return { ok: false, error: `附加 JDBC 参数「${key}」重复` };
    seen.add(lk);
    pairs.push([key, value]);
  }
  return { ok: true, pairs, normalized: pairs.map(([k, v]) => `${k}=${v}`).join("&") };
}

/** 方言默认参数 + 用户参数:默认在前;用户填了同名键(大小写不敏感)以用户的为准(覆盖,不重复)。 */
export function mergeJdbcParams(defaults: Readonly<Record<string, string>> | undefined, user: readonly JdbcParamPair[]): JdbcParamPair[] {
  const userKeys = new Set(user.map(([k]) => k.toLowerCase()));
  const out: JdbcParamPair[] = [];
  for (const [k, v] of Object.entries(defaults || {})) if (!userKeys.has(k.toLowerCase())) out.push([k, v]);
  for (const p of user) out.push(p);
  return out;
}

/** 把参数拼到基础 URL 上(基础 URL 不含参数);没有参数 ⇒ 原样返回。 */
export function appendJdbcParams(baseUrl: string, pairs: readonly JdbcParamPair[], style: JdbcParamStyle): string {
  if (!baseUrl || pairs.length === 0) return baseUrl;
  const body = pairs.map(([k, v]) => `${k}=${v}`);
  return style === "semicolon" ? `${baseUrl};${body.join(";")}` : `${baseUrl}?${body.join("&")}`;
}

/** 一步到位:基础 URL + 方言默认 + 用户参数字符串(已校验过的;没校验过的传进来会抛,路由层必须先 parseJdbcParams)。 */
export function buildJdbcUrlWithParams(baseUrl: string, style: JdbcParamStyle, defaults: Readonly<Record<string, string>> | undefined, userParams: unknown): string {
  const parsed = parseJdbcParams(userParams);
  if (!parsed.ok) throw new Error(parsed.error);
  return appendJdbcParams(baseUrl, mergeJdbcParams(defaults, parsed.pairs), style);
}
