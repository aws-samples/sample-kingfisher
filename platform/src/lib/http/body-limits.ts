// 应用接口「一次请求最多能带多大的请求体」的唯一作者(零服务端 import:网关、路由、页面与判据共用)。
//
// 【缺陷原形(2026-11-26 真实客户反馈)】离线作业脚本约 160 行以上保存不了:平台边缘把一切超过 8KB 的请求体拦成一张 403 HTML 页,
//   应用层一个字都说不上,页面提示的还是「请求过多」;放行靠一张只会精确匹配路径的清单,带 id 的保存路由一条都登记不进来
//   (编排画布、报表、同步任务、作业依赖文件上传同类)。
// 【规则】边缘只对页面 / 静态资源与登录前接口按大小拦(infra `waf-stack.ts`);登录后的应用接口(`/api/` 之下)由这里统一给上限、统一用人话报:
//   · 缺省上限 `DEFAULT_MAX_BODY_BYTES`;个别上传路由的上限写在 `BODY_LIMIT_RULES`(闭合清单,新增上传路由在这里登记一行)。
//   · 网关在登录校验通过之后判:超限 ⇒ 413 + 人话(`bodyTooLargeMessage`),不进路由。
//   · 存储层单条记录的上限(DynamoDB 400KB)比请求体上限小:写库时超了由 `storeItemTooLarge*` 改成人话(`api-response.ts` 统一识别)。
// 【与框架的关系】框架在网关运行之前就把请求体缓冲进内存,最多 `GATEWAY_BUFFER_LIMIT_BYTES`(框架缺省值,本项目没有改),
//   超过的部分网关与路由都读不到(到路由手里是截断的)。⇒ 这里的每一个上限都必须比它小一截
//   (`TRUNCATION_DETECT_MARGIN_BYTES`):否则超限的请求到网关时已被截断,数字节数也数不出「超了」,用户拿不到那句人话。判据钉住。
//   所以经平台进程上传的文件如实收在 `PAGE_UPLOAD_MAX_FILE_BYTES` 之内;更大的文件不经平台进程(放进 S3 后填地址)。
//   调大框架那个上限 = 没登录的请求也能让进程缓冲那么多(缓冲发生在登录校验之前),是安全取舍,不许顺手改。

const MB = 1024 * 1024;

/**
 * 登录前就能打到的公开接口的前缀。它与内部回环接口(`lib/scheduler/internal-source.ts` 的 `INTERNAL_API_PREFIX`)不经网关的登录校验,
 * 所以也不归这里管:边缘对这两个前缀照旧按 8KB 拦(infra `waf-stack.ts` 的 `EDGE_SIZE_LIMITED_API_PREFIXES`,判据钉两边逐字相同)。
 */
export const PUBLIC_API_PREFIX = "/api/public/";

/** 登录后的应用接口一次请求体的缺省上限。 */
export const DEFAULT_MAX_BODY_BYTES = 4 * MB;

/** 框架交给网关 / 路由的请求体最多这么多字节(Next.js `experimental.middlewareClientMaxBodySize` 的缺省值)。 */
export const GATEWAY_BUFFER_LIMIT_BYTES = 10 * MB;

/**
 * 每个上限都要比框架缓冲上限至少小这么多:请求头里没有长度时网关靠数字节判超限,而被框架截断的请求体数出来最多只到缓冲上限
 * (还会少掉撞线的那一块)⇒ 上限离缓冲上限太近就分不清「正好没超」与「已被截断」。
 */
export const TRUNCATION_DETECT_MARGIN_BYTES = 1 * MB;

/** 经平台进程上传的单个文件的上限(连接器 JAR、作业依赖文件共用;路由读完文件后自己再核一次)。 */
export const PAGE_UPLOAD_MAX_FILE_BYTES = 8 * MB;

/** 上传路由的请求体上限 = 文件上限 + multipart 包装的余量。 */
export const PAGE_UPLOAD_MAX_BODY_BYTES = PAGE_UPLOAD_MAX_FILE_BYTES + 1 * MB;

/** 保存问数会话卡片的请求体上限(正文含整段对话的全部结果行,比普通保存大)。 */
export const GENBI_CARD_MAX_BODY_BYTES = 9 * MB;

/** 字节数的人话写法:不足 1MB 用 KB,否则 MB(一位小数)。 */
export function formatBytes(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

function sizeClause(actualBytes?: number): string {
  return typeof actualBytes === "number" && actualBytes > 0 ? `有 ${formatBytes(actualBytes)},` : "";
}

/** 上传的文件超过页面上传上限时的那句话(网关按请求体判、路由按文件判,说的是同一句)。 */
function pageUploadTooLargeMessage(actualBytes: number | undefined, nextStep: string): string {
  return `这个文件${sizeClause(actualBytes)}超过了页面上传的上限 ${formatBytes(PAGE_UPLOAD_MAX_FILE_BYTES)},没有上传。${nextStep}`;
}

/** 连接器 JAR 只有「上传」这一个入口 ⇒ 没有可指的下一步,只说事实。 */
export function flinkConnectorTooLargeMessage(actualBytes?: number): string {
  return pageUploadTooLargeMessage(actualBytes, "");
}

/** 作业依赖文件可以直接填 S3 地址 ⇒ 指这条路。 */
export function etlDepTooLargeMessage(actualBytes?: number): string {
  return pageUploadTooLargeMessage(actualBytes, "更大的依赖文件请先放进 S3,再把它的地址填进「依赖库」一栏。");
}

export function genbiCardTooLargeMessage(actualBytes?: number): string {
  return `这段对话的内容${sizeClause(actualBytes)}超过了单张卡片一次可保存的上限 ${formatBytes(GENBI_CARD_MAX_BODY_BYTES)},没有保存。`;
}

export interface BodyLimitRule {
  name: string;
  method: string;
  /** 路径以它开头 */
  prefix: string;
  /** 路径以它结尾(空串 = 路径必须与 prefix 完全相同) */
  suffix: string;
  /** prefix 与 suffix 之间恰好夹几段(每段非空、不含 `/`) */
  middleSegments: number;
  /** 请求体上限(网关按它判) */
  maxBytes: number;
  /** 超限时给用户的那句话(`actualBytes` = 请求头里的长度;不知道时不传) */
  tooLargeMessage: (actualBytes?: number) => string;
  why: string;
}

/** 上限与缺省不同的路由(闭合清单;每行都大于缺省上限、且比框架缓冲上限小一截 —— 判据钉住)。 */
export const BODY_LIMIT_RULES: readonly BodyLimitRule[] = [
  {
    name: "flink-connector-upload",
    method: "POST",
    prefix: "/api/flink/connectors",
    suffix: "",
    middleSegments: 0,
    maxBytes: PAGE_UPLOAD_MAX_BODY_BYTES,
    tooLargeMessage: flinkConnectorTooLargeMessage,
    why: "上传 Flink 连接器 JAR(路由自己再核文件大小)",
  },
  {
    name: "etl-job-dep-upload",
    method: "POST",
    prefix: "/api/etl-jobs/",
    suffix: "/deps",
    middleSegments: 1,
    maxBytes: PAGE_UPLOAD_MAX_BODY_BYTES,
    tooLargeMessage: etlDepTooLargeMessage,
    why: "上传离线作业的依赖文件(路由自己再核文件大小)",
  },
  {
    name: "genbi-card-save",
    method: "POST",
    prefix: "/api/genbi/cards",
    suffix: "",
    middleSegments: 0,
    maxBytes: GENBI_CARD_MAX_BODY_BYTES,
    tooLargeMessage: genbiCardTooLargeMessage,
    why: "保存问数会话卡片:正文含整段对话的全部结果行",
  },
];

function ruleMatches(rule: BodyLimitRule, pathname: string, method: string): boolean {
  if (rule.method !== method) return false;
  if (rule.middleSegments === 0 && rule.suffix === "") return pathname === rule.prefix;
  if (!pathname.startsWith(rule.prefix) || !pathname.endsWith(rule.suffix)) return false;
  const middle = pathname.slice(rule.prefix.length, pathname.length - rule.suffix.length);
  if (middle.length === 0) return false;
  const segments = middle.split("/");
  return segments.length === rule.middleSegments && segments.every((s) => s.length > 0);
}

function ruleFor(pathname: string, method: string): BodyLimitRule | undefined {
  const m = method.toUpperCase();
  return BODY_LIMIT_RULES.find((rule) => ruleMatches(rule, pathname, m));
}

/** 这条路由一次请求体的上限(字节)。 */
export function maxBodyBytesFor(pathname: string, method: string): number {
  return ruleFor(pathname, method)?.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
}

/** 会带请求体的方法(其余方法不判大小)。 */
export function methodCarriesBody(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export const PAYLOAD_TOO_LARGE_CODE = "PAYLOAD_TOO_LARGE" as const;

/** 「太大了」之后的下一步(请求体超限与单条记录超限共用一句)。 */
const TOO_LARGE_NEXT_STEP = "请精简内容(离线作业的大段脚本可以拆成依赖文件放进脚本桶后在作业里引用,或拆成多个作业)";

/** 普通保存请求的请求体超过上限时给用户的那句话(`actualBytes` 不知道时只说上限)。 */
export function bodyTooLargeMessage(limitBytes: number, actualBytes?: number): string {
  return `这次提交的内容${sizeClause(actualBytes)}超过了一次可提交的上限 ${formatBytes(limitBytes)},没有保存。${TOO_LARGE_NEXT_STEP}`;
}

/** 这条路由超限时给用户的那句话:上限表里的路由说自己的,其余说缺省的。 */
export function tooLargeMessageFor(pathname: string, method: string, actualBytes?: number): string {
  const rule = ruleFor(pathname, method);
  return rule ? rule.tooLargeMessage(actualBytes) : bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES, actualBytes);
}

export type BodySizeVerdict = { ok: true } | { ok: false; limitBytes: number; actualBytes?: number; message: string };

/**
 * 按 `Content-Length` 判这次请求体是否超限。
 * 回 `null` = 请求头里没有可用的长度(分块传输等)⇒ 调用方要自己数实际读到的字节(`exceedsWhenCounted`)。
 */
export function bodySizeVerdictByHeader(pathname: string, method: string, contentLength: string | null | undefined): BodySizeVerdict | null {
  if (!methodCarriesBody(method)) return { ok: true };
  const raw = (contentLength ?? "").trim();
  if (raw === "" || !/^\d{1,15}$/.test(raw)) return null;
  const actual = Number(raw);
  const limit = maxBodyBytesFor(pathname, method);
  if (actual <= limit) return { ok: true };
  return { ok: false, limitBytes: limit, actualBytes: actual, message: tooLargeMessageFor(pathname, method, actual) };
}

/** 没有 `Content-Length` 时:数到的字节数一旦超过上限就判超限(数到多少算多少,不需要读完)。 */
export function bodySizeVerdictByCount(pathname: string, method: string, countedBytes: number): BodySizeVerdict {
  const limit = maxBodyBytesFor(pathname, method);
  if (countedBytes <= limit) return { ok: true };
  return { ok: false, limitBytes: limit, message: tooLargeMessageFor(pathname, method) };
}

// ── 存储层:单条记录超过 400KB ─────────────────────────────────────────────────────────────────────

/** DynamoDB 单条记录的上限(服务硬限制)。 */
export const STORE_ITEM_MAX_BYTES = 400 * 1024;

/**
 * 存储服务报「这次写入太大」的原话。同一件事在不同大小上是不同的说法(2026-11-27 测试账号页面实测,离线作业保存一段脚本):
 *   · 约 700KB:`Item size to update has exceeded the maximum allowed size`(整条记录超过 400KB;新建时是 `Item size has exceeded …`);
 *   · 约 2MB:`Invalid UpdateExpression: Expression size has exceeded the maximum allowed size;`;
 *   · 约 3.3MB:`ExpressionAttributeValues exceeds max size`(这次更新带的值加起来超过上限,记录的大小还没算就先被拒了)。
 * 对用户是同一件事:内容超过了单条记录可保存的大小。只认写路径上的这几句,读路径上的表达式超限不归这里。
 * 新量到一种说法就在这里加一行(页面判据对三类保存各量三档大小)。
 */
const STORE_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /Item size (?:to update )?has exceeded the maximum allowed size/i,
  /Invalid UpdateExpression: Expression size has exceeded the maximum allowed size/i,
  /ExpressionAttributeValues exceeds max size/i,
];

export function isStoreItemTooLarge(message: unknown): boolean {
  return typeof message === "string" && STORE_TOO_LARGE_PATTERNS.some((p) => p.test(message));
}

export const STORE_ITEM_TOO_LARGE_MESSAGE = `内容超过了单条记录可保存的大小(约 ${formatBytes(STORE_ITEM_MAX_BYTES)}),没有保存。${TOO_LARGE_NEXT_STEP}`;
