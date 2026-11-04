// @kf-batch 50-WP31-seq5-dataplane-role
// WP-31 序 5(L5「能力即授权」)—— 数据面凭证 = 代入**该区那一个执行环境**的平台数据面角色。
//
// ── 为什么 ───────────────────────────────────────────────────────────────────────
// 序 1–4 让「落点写错」在代码层当场暴露(类型必填 / 入口 400 / 越区断言)。但代码层的断言**可以被绕过**
// (散建客户端、非 SDK 通道、断言本身的 bug)。L5 把第二道闸放进 IAM:平台 TaskRole 最终(序 5 第三刀)
// **对任何区都不持有数据面权限**,只能经工厂代入「该 target 的平台数据面角色」—— 角色 = 资源只限本 target ∧
// `aws:RequestedRegion = 该区`。落点错 ⇒ 拿到的是别的 target 的凭证 ⇒ 碰不到本 target 以外的东西。
//
// ── 三态(显式开关,不是缺省回落)───────────────────────────────────────────────
//   taskrole  —— 现状(第一刀部署时的缺省):数据面客户端照旧用任务角色。
//   observe   —— 先用数据面角色发;**被 IAM 拒**就记一条 `place.creds.denied`(服务 / 区 / target / AWS 原话,
//                原话里带 action 与资源 ARN)再用任务角色重发 ⇒ 功能不受影响,一轮全量硬门拿到**角色策略缺口的完整清单**
//                (与序 2「先观测再拦截」同一路数:用事实而不是 grep 量出改造面)。
//   enforce   —— 只用数据面角色(第三刀;同时收回 TaskRole 的数据面直授)。
//   只认这三个字面值;拼错一律 taskrole(与 `BGP_PLACE_GUARD` 同语义:拼错不许变成「半开」的第四态)。
//
// ── 🔴 「身份敏感」的调用在 observe 下不试角色 ──────────────────────────────────────
// 有两类调用**被拒不在 API 那一刻**,observe 的「拒了就重发」接不住:
//   ① Athena `StartQueryExecution` —— 查询异步执行时用**调用者身份**读 S3 / Glue / S3 Tables,权限不够是几秒后
//      查询状态 FAILED,API 本身 200;
//   ② Redshift Data 不带 `SecretArn` / `DbUser` 的语句 —— 用**调用者 IAM 身份**当库用户(`IAMR:<角色名>`),
//      换身份 = 换库用户 = 换表属主 / 授权,不是 AccessDenied 而是行为静默改变。
// ⇒ observe 下这两类直接走任务角色并记 `place.creds.identity-sensitive`(计数,第三刀前要靠 IAM 模拟门逐条核)。
//
// ── 角色在哪 ──────────────────────────────────────────────────────────────────────
// 名字只来自命名 SSOT(`platformDataRole`):主控区 `bgp-platform-data-role`、其余 `BgpExecEnv-<slug>-platform-data-role`。
// 「这个区的角色」= 该区**唯一**一个未删除的执行环境(用户拍板「一区一套」;注册守卫硬拒第二个)的那一个 ——
// 不读描述符字段,ARN 由 targetId + 账号派生(与 infra 同一个命名真源,parity 门禁钉住)。
import { resourceName } from "@/lib/aws/naming";
import { isRoleArn } from "@/lib/execution-role/resolve";

export type DataPlaneCredsMode = "taskrole" | "observe" | "enforce";

export function dataPlaneCredsMode(): DataPlaneCredsMode {
  const v = process.env.BGP_DATAPLANE_CREDS;
  return v === "observe" || v === "enforce" ? v : "taskrole";
}

/** 该区没有(或不止一个)执行环境 ⇒ 没有可代入的数据面角色。 */
export class DataPlaneRoleUnresolved extends Error {
  constructor(public readonly region: string, public readonly reason: string) {
    super(`区 ${region} 取不到平台数据面角色:${reason}`);
    this.name = "DataPlaneRoleUnresolved";
  }
}

export interface DataPlaneRole {
  targetId: string;
  roleArn: string;
}

/** 区 → 角色(注册表 + 账号)。注入点只为单测;运行时恒为 `resolveFromRegistry`。 */
type RoleResolver = (region: string) => Promise<DataPlaneRole>;

const ROLE_TTL_MS = 5 * 60_000;
const roleCache = new Map<string, { v: DataPlaneRole; at: number }>();

/** 纯函数:该区的注册行 + 控制面账号 ⇒ 角色(「一区一套」:未删除的恰好一个)。 */
export function pickDataPlaneRole(
  region: string,
  rows: ReadonlyArray<{ targetId: string; region: string; status: string }>,
  ctx: { accountId: string; partition: string }
): DataPlaneRole {
  const live = rows.filter((t) => t.region === region && t.status !== "deleted");
  if (live.length === 0) throw new DataPlaneRoleUnresolved(region, "该区没有执行环境");
  if (live.length > 1) {
    throw new DataPlaneRoleUnresolved(region, `该区有 ${live.length} 个未删除的执行环境(${live.map((t) => t.targetId).join(", ")})—— 违反「一区一套」`);
  }
  const targetId = live[0].targetId;
  return { targetId, roleArn: `arn:${ctx.partition}:iam::${ctx.accountId}:role/${resourceName("platformDataRole", { targetId })}` };
}

async function resolveFromRegistry(region: string): Promise<DataPlaneRole> {
  // 动态 import:registry → dynamodb → clients → 本文件,静态 import 会成环
  const { listTargetsByRegion } = await import("@/lib/exec-env/registry");
  const { getControlPlaneContext } = await import("@/lib/exec-env/aws-context");
  return pickDataPlaneRole(region, await listTargetsByRegion(region), await getControlPlaneContext());
}

let resolver: RoleResolver = resolveFromRegistry;

export async function dataPlaneRoleFor(region: string): Promise<DataPlaneRole> {
  const hit = roleCache.get(region);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.v;
  const v = await resolver(region);
  roleCache.set(region, { v, at: Date.now() });
  return v;
}

export interface TempCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}
/** 代入一次(由工厂注入:STS 客户端只许在工厂里建)。 */
export type AssumeFn = (roleArn: string, sessionName: string) => Promise<TempCreds>;

const REFRESH_BEFORE_MS = 5 * 60_000;
const credCache = new Map<string, TempCreds>();
const inflight = new Map<string, Promise<TempCreds>>();

/**
 * 交给 SDK 的过期时间封顶(🔴 SDK 自己按 `expiration` 缓存凭证、过期前 5 分钟才回来问 —— 给它真实的 1 小时,
 * 同区删了重注册后它会拿旧角色的凭证用满 1 小时;装配层判据当场抓到)。封顶 10 分钟 ⇒ SDK 每 ≤5 分钟回问一次,
 * 本 provider 自己的缓存让回问几乎零成本,而「区 → 角色」每 5 分钟重解析一次。
 */
const SDK_EXPIRY_CAP_MS = ROLE_TTL_MS + 5 * 60_000;

/** SDK `credentials` 选项:按角色缓存,过期前 5 分钟刷新;同角色并发只代入一次。 */
export function roleCredentialProvider(region: string, assume: AssumeFn): () => Promise<TempCreds> {
  const capped = (c: TempCreds): TempCreds => ({ ...c, expiration: new Date(Math.min(c.expiration.getTime(), Date.now() + SDK_EXPIRY_CAP_MS)) });
  return async () => capped(await rawRoleCredentials(region, assume));
}

async function rawRoleCredentials(region: string, assume: AssumeFn): Promise<TempCreds> {
  // 🔴 凭证按**角色 ARN** 缓存(不按区):同区删了重注册是新 targetId ⇒ 新角色,旧凭证不许被继续拿来用
  const role = await dataPlaneRoleFor(region);
  const hit = credCache.get(role.roleArn);
  if (hit && hit.expiration.getTime() - Date.now() > REFRESH_BEFORE_MS) return hit;
  let p = inflight.get(role.roleArn);
  if (!p) {
    p = (async () => {
      const c = await assume(role.roleArn, `bgp-platform-${role.targetId}`.slice(0, 64));
      credCache.set(role.roleArn, c);
      return c;
    })().finally(() => inflight.delete(role.roleArn));
    inflight.set(role.roleArn, p);
  }
  return p;
}

const DENIED_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "UnauthorizedOperation",
  "UnauthorizedException",
  "AuthorizationError",
  "AuthorizationErrorException",
  "NotAuthorized",
]);

/** IAM 拒绝(数据面角色缺权限)?—— 只认 AWS 自己的拒绝形态,别的错误原样抛(不许把业务错误重发一遍)。 */
export function isIamDenied(e: unknown): boolean {
  const x = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
  if (!x) return false;
  if (DENIED_NAMES.has(String(x.name ?? "")) || DENIED_NAMES.has(String(x.Code ?? ""))) return true;
  return x.$metadata?.httpStatusCode === 403 && /not authorized|access ?denied/i.test(String(x.message ?? ""));
}

/** 取不到角色凭证本身(该区无环境 / 代入被拒 / 角色还没部署)。 */
function isCredsUnavailable(e: unknown): boolean {
  const x = e as { name?: string } | null;
  return x?.name === "DataPlaneRoleUnresolved" || x?.name === "CredentialsProviderError";
}

/** 见文件头「身份敏感」:被拒不在 API 那一刻 ⇒ observe 下不试角色。 */
export function isIdentitySensitive(input: unknown): boolean {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.QueryString === "string") return true; // Athena StartQueryExecution
  const hasSql = typeof i.Sql === "string" || Array.isArray(i.Sqls);
  if (hasSql && !i.SecretArn && !i.DbUser) return true;
  return passesRole(i);
}

/**
 * 🔴 B-49(序 36 第二十五轮真环境):请求里带了要**交给服务**的 IAM 角色 ARN(PassRole:DMS endpoint 的
 *   SecretsManagerAccessRoleArn / EMR executionRoleArn / Flink ServiceExecutionRole …)⇒ 服务按**调用者**核 iam:PassRole。
 *   有的服务被拒时**不回 AccessDenied**:DMS CreateEndpoint 回 `InvalidParameterValueException: SecretsManagerSecretId is invalid`
 *   ⇒ observe 认不出是权限、不回落 ⇒ 实时任务起不来(observe 号称「功能不变」被打破)。
 *   ⇒ 带角色 ARN 的请求一律按身份敏感:observe 直接用任务角色并记 identity-sensitive(清单 = 第二刀给数据面角色补 PassRole 的输入)。
 */
// 序 72 B-139:角色 ARN 形态单一作者(lib/execution-role/resolve.ts);此处原有一份前缀版正则,已收口
function passesRole(v: unknown, depth = 0): boolean {
  if (typeof v === "string") return isRoleArn(v);
  if (depth > 6 || v === null || typeof v !== "object") return false;
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
    if (passesRole(x, depth + 1)) return true;
  }
  return false;
}

type Sink = (line: Record<string, unknown>) => void;
const stdoutSink: Sink = (line) => {
  try {
    process.stdout.write(JSON.stringify(line) + "\n");
  } catch {
    /* 记账永不抛 */
  }
};
let sink: Sink = stdoutSink;

const DEDUPE_MS = 60_000;
const recent = new Map<string, number>();
const counts = new Map<string, number>();

function note(event: "denied" | "unavailable" | "identity-sensitive", f: { service: string; region: string; operation: string; detail?: string }): void {
  const k = `${event}|${f.service}|${f.operation}|${f.region}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
  const now = Date.now();
  const last = recent.get(k);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recent.set(k, now);
  if (recent.size > 2000) recent.clear();
  const role = roleCache.get(f.region)?.v;
  sink({
    event: `place.creds.${event}`,
    // EMF:BGP/Place DataPlaneRoleGap{Event} —— 第三刀的前提是 denied + unavailable 整轮为 0
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{ Namespace: "BGP/Place", Dimensions: [["Event"]], Metrics: [{ Name: "DataPlaneRoleGap", Unit: "Count" }] }],
    },
    Event: event,
    DataPlaneRoleGap: 1,
    service: f.service,
    operation: f.operation,
    region: f.region,
    targetId: role?.targetId ?? null,
    // AWS 原话(带 action 与资源 ARN,不含任何数据值)—— 这就是缺口清单的内容
    detail: (f.detail ?? "").slice(0, 600),
  });
}

interface Sendable {
  send: (command: unknown, ...rest: unknown[]) => Promise<unknown>;
  config?: { serviceId?: string };
}

function operationOf(command: unknown): string {
  // 🔴 B-47:Next 产物里类名被压成单字母(真环境 operation 全是 "C" / "s")⇒ 先读 SDK 命令自带的操作模式
  //   `schema = [9, 命名空间, 操作名, …]`(不受压缩影响),读不到才退回类名
  const sc = (command as { schema?: unknown })?.schema;
  if (Array.isArray(sc) && sc[0] === 9 && typeof sc[2] === "string" && sc[2]) return sc[2];
  const n = (command as { constructor?: { name?: string } })?.constructor?.name ?? "?";
  return n.endsWith("Command") ? n.slice(0, -"Command".length) : n;
}

/**
 * observe 模式:`primary`(数据面角色凭证)先发;IAM 拒 / 取不到角色 ⇒ 记账后用 `fallback`(任务角色)重发。
 * 🔴 改的是**实例**的 `send`(不换对象)⇒ `instanceof` 与分页器照旧认得它。
 */
export function withObserveFallback<C>(primary: C, fallback: C, region: string): C {
  const p = primary as unknown as Sendable;
  const f = fallback as unknown as Sendable;
  const orig = p.send.bind(p);
  const service = String(p.config?.serviceId ?? "?");
  p.send = async (command: unknown, ...rest: unknown[]) => {
    const operation = operationOf(command);
    if (isIdentitySensitive((command as { input?: unknown })?.input)) {
      note("identity-sensitive", { service, region, operation });
      return f.send(command, ...rest);
    }
    try {
      return await orig(command, ...rest);
    } catch (e) {
      if (isIamDenied(e)) {
        note("denied", { service, region, operation, detail: String((e as Error)?.message ?? e) });
        return f.send(command, ...rest);
      }
      if (isCredsUnavailable(e)) {
        note("unavailable", { service, region, operation, detail: String((e as Error)?.message ?? e) });
        return f.send(command, ...rest);
      }
      throw e;
    }
  };
  return primary;
}

/** 汇总(单测 / 排障)。 */
export function dataPlaneCredsSummary(): Record<string, number> {
  return Object.fromEntries(counts);
}

/** 单测用。 */
export function __setDataPlaneCredsTestHooks(h: { resolver?: RoleResolver; sink?: Sink } | null): void {
  resolver = h?.resolver ?? resolveFromRegistry;
  sink = h?.sink ?? stdoutSink;
  roleCache.clear();
  credCache.clear();
  inflight.clear();
  recent.clear();
  counts.clear();
}
