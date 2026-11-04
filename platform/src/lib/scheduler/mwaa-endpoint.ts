// @kf-batch 50-WP13-mwaa-region
// **MWAA 端点解析器 —— 「哪个 target 用哪一套 Airflow(环境名 + DAG 桶 + region)」的唯一作者**(50 SPEC v3.26 §3.14)。
//
// 【为什么必须单独一个文件】用户拍板(2026-09-06,DESIGN §18 决策 6sexies):「每个区域的定时任务都是自己区域的 MWAA 执行的,
//   不允许跨区域调度。」此前 `MWAA_ENV_NAME` / `MWAA_DAG_BUCKET` 字面散在 **14 处**,每一处都默认「只有 home 有 MWAA」——
//   扇出把全部 target 的 DAG 写进 home 桶、由 home Airflow 跨区触发,正是用户点名的漏洞。修法若是「14 处各自加一段
//   非 home 分支」,漏一处就复发。⇒ 三元「环境 / 桶 / region」只在这里产生,其余消费者一律拿 `MwaaEndpoint` 走;
//   `mwaa-wiring-guard.test.ts` 用 grep 钉「env 字面只许出现在本文件」。
//
// 【home 逐字节不变】`homeMwaaEndpoint()` 读的就是原来那两个 env 与同样的兜底字面 —— 存量 home 路径产物 / key / 环境名一个字节不变。
// 【非 home fail-closed】描述符 `components ∌ mwaa` 或资源袋缺 `dagBucket` / `mwaaEnvName` ⇒ 抛 `MwaaNotInstalled`,
//   绝不回落 home(回落 = 把该区任务塞回 home 调度 = 用户明令禁止的跨区域调度)。
// 【一次列全】`requireMwaaForTargets` 把所有缺失 target 一起列(交互宪法 B6「前置校验提前告知」),路由据此回 409 + 直达补装。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { MWAAClient, CreateCliTokenCommand } from "@aws-sdk/client-mwaa";
import { apiError } from "@/lib/api-response";
import { getTargetRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import { HOME_TARGET_ID, assertTargetId, isHome } from "@/lib/exec-env/target-id";
// @kf-batch 50-WP31-place-first-class 序 31 第二刀 ②:端点解析 = 「这个工作流的产物在哪个区」的落点决策 ⇒ 在唯一作者这里记账。
//   第四十三轮 observe:DELETE /api/workflow/<id> 撤 DAG 的 s3.DeleteObject 落在该区的 workflow 桶上(没越区),
//   却因为撤回链只经 bindingTargets()(纯解析,不记决策)⇒ 未归因。发布 / 触发 / 取日志同一条链,一处记齐。
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(三个端点解析入口共用一个名字:它们回答的是同一个问题)。 */
export const SCHEDULER_ENDPOINT_VIA = "schedulerEndpointFor";

/** 一套 Airflow 的三元 + 归属。🔴 类型让「桶 / 环境 / region」不可拆传(不再有「只传 region 而桶还是 home」的形态)。 */
export interface MwaaEndpoint {
  targetId: string;
  region: string;
  envName: string;
  dagBucket: string;
  home: boolean;
}

export interface MwaaMissing {
  targetId: string;
  region: string;
  displayName?: string;
  /** 面向用户的缺失原因(未装 / 装了但资源袋没回写) */
  reason: string;
}

// @kf-batch 50-WP15-airflow-serverless(SPEC v3.27 §2.1 订正):拒因泛化为「缺**任一**调度组件」⇒ 码改 SCHEDULER_NOT_INSTALLED;
//    旧码 MWAA_NOT_INSTALLED 作别名保留一版(客户端两个都认:lib/scheduler/mwaa-missing.ts)。
export const SCHEDULER_NOT_INSTALLED_CODE = "SCHEDULER_NOT_INSTALLED" as const;
export const LEGACY_MWAA_NOT_INSTALLED_CODE = "MWAA_NOT_INSTALLED" as const;
/** 历史名(WP-13 引入):值已随 v3.27 改为 SCHEDULER_NOT_INSTALLED。 */
export const MWAA_NOT_INSTALLED_CODE = SCHEDULER_NOT_INSTALLED_CODE;
export const SCHEDULER_OPTIONS = ["airflow-serverless", "mwaa"] as const;

/** @kf-batch 50-WP15-airflow-serverless:MWAA Serverless 端点(该 target 的定义桶 / 角色 / SG / 子网;workflow 由平台按作业建)。 */
export interface ServerlessEndpoint {
  kind: "serverless";
  targetId: string;
  region: string;
  workflowBucket: string;
  roleArn: string;
  sgId: string;
  subnetIds: string[];
  home: boolean;
}
/** 调度端点联合:经典 MWAA(无 kind 字段,保留 WP-13 形状)或 serverless。 */
export type SchedulerEndpoint = MwaaEndpoint | ServerlessEndpoint;
export function isServerlessEndpoint(ep: SchedulerEndpoint): ep is ServerlessEndpoint {
  return (ep as { kind?: unknown }).kind === "serverless";
}

/** 缺 MWAA 的非 home target(一次列全)。路由用 `mwaaErrorResponse` 映射 409。 */
export class MwaaNotInstalled extends Error {
  readonly code = MWAA_NOT_INSTALLED_CODE;
  constructor(readonly missing: MwaaMissing[]) {
    super(
      `以下执行环境未安装调度组件,无法在该区域配置定时 / 编排:` +
        missing.map((m) => `${m.region} · ${m.targetId}${m.displayName ? `(${m.displayName})` : ""}〔${m.reason}〕`).join(";") +
        `。每个区域的定时任务只能由本区域的调度器执行,请先到执行环境补装 airflow-serverless(推荐,分钟级)或 mwaa 组件。`
    );
    this.name = "MwaaNotInstalled";
  }
}

/** 补装入口深链(INTERACTION v2.18 §2.2a:列表页读 query 自动开抽屉、高亮 mwaa 行)。 */
export function mwaaFixHref(targetId: string, component: "airflow-serverless" | "mwaa" = "airflow-serverless"): string {
  return `/exec-envs?target=${encodeURIComponent(targetId)}&highlight=${component}`;
}

/**
 * home 的 Airflow —— **唯一**读 env 的地方(与改动前 14 处的读法与兜底字面逐字节相同)。
 * 同步函数:调用方(模块级常量、settings 展示)不必 await。
 */
export function homeMwaaEndpoint(): MwaaEndpoint {
  return {
    targetId: HOME_TARGET_ID,
    region: homeRegion(),
    envName: process.env.MWAA_ENV_NAME || "bgp-mwaa",
    dagBucket: process.env.MWAA_DAG_BUCKET || "bgp-mwaa-dags",
    home: true,
  };
}

/** 兼容旧响应字段 `bucket`(home 口径)—— 行级 rows[].bucket 才是各区真值。 */
export function mwaaDagBucketOfHome(): string {
  return homeMwaaEndpoint().dagBucket;
}

/** settings 页「是否配置」的口径(原来是 `process.env.MWAA_DAG_BUCKET || "未配置"`;字面收进本文件)。 */
export function homeMwaaConfigured(): boolean {
  return Boolean(process.env.MWAA_DAG_BUCKET);
}

/** 描述符 → 缺失原因(null = 装齐)。纯函数,单测直接打。 */
export function mwaaMissingReason(t: Pick<ExecutionTarget, "components" | "resources">): string | null {
  const comps = Array.isArray(t.components) ? t.components : [];
  if (!comps.includes("mwaa")) return "未安装 mwaa 组件";
  const res = (t.resources ?? {}) as Record<string, unknown>;
  if (typeof res.dagBucket !== "string" || !res.dagBucket) return "mwaa 组件缺 dagBucket(先在详情页「检测初始化」回写资源袋)";
  if (typeof res.mwaaEnvName !== "string" || !res.mwaaEnvName) return "mwaa 组件缺 mwaaEnvName(先在详情页「检测初始化」回写资源袋)";
  return null;
}

// @kf-batch 50-WP15-airflow-serverless ────────────────────────────────────────────────────────
/** 描述符 → serverless 缺失原因(null = 装齐)。纯函数,单测直接打。 */
export function serverlessMissingReason(t: Pick<ExecutionTarget, "components" | "resources">): string | null {
  const comps = Array.isArray(t.components) ? t.components : [];
  if (!comps.includes("airflow-serverless")) return "未安装 airflow-serverless 组件";
  const res = (t.resources ?? {}) as Record<string, unknown>;
  for (const k of ["workflowBucket", "airflowServerlessRoleArn", "airflowServerlessSgId"]) {
    if (typeof res[k] !== "string" || !res[k]) return `airflow-serverless 组件缺 ${k}(先在详情页「检测初始化」回写资源袋)`;
  }
  const subnets = Array.isArray(res.privateSubnetIds) ? res.privateSubnetIds : Array.isArray(res.emrSubnetIds) ? res.emrSubnetIds : [];
  if (subnets.length < 2) return "描述符缺私有子网(privateSubnetIds / emrSubnetIds 至少 2 个)—— serverless workflow 必须 VPC 模式";
  return null;
}

function serverlessEndpointOf(t: ExecutionTarget, home: boolean): ServerlessEndpoint {
  const res = t.resources as Record<string, unknown>;
  const subnets = (Array.isArray(res.privateSubnetIds) ? res.privateSubnetIds : (res.emrSubnetIds as unknown[])).map(String);
  return {
    kind: "serverless",
    targetId: t.targetId,
    region: t.region,
    workflowBucket: String(res.workflowBucket),
    roleArn: String(res.airflowServerlessRoleArn),
    sgId: String(res.airflowServerlessSgId),
    subnetIds: subnets.slice(0, 2),
    home,
  };
}

// @kf-batch 50-WP15-airflow-serverless(施工序 6):值域 SSOT 搬到叶子模块 lib/exec-env/scheduler-preference.ts(zod / 写通道 / 前端同源)
export type { SchedulerPreference } from "@/lib/exec-env/scheduler-preference";
import type { SchedulerPreference } from "@/lib/exec-env/scheduler-preference";

/**
 * 某 target 用哪个调度器(SPEC v3.27 §3.15):两者都装 ⇒ prefer ?? 描述符 schedulerPreference ?? serverless;只装一个 ⇒ 它;
 * 都缺 ⇒ throw MwaaNotInstalled(code SCHEDULER_NOT_INSTALLED,两种缺因一起列)。home:描述符声称了 airflow-serverless 就走它,否则经典 env。
 */
export async function schedulerEndpointFor(targetId: string, prefer?: SchedulerPreference): Promise<SchedulerEndpoint> {
  const tid = isHome(targetId) ? HOME_TARGET_ID : assertTargetId(targetId);
  notePlaceDecision({ targetId: tid, via: SCHEDULER_ENDPOINT_VIA }); // 第一个 await 之前(D11)
  const t = await getTargetRaw(tid);
  if (isHome(tid)) {
    if (t && serverlessMissingReason(t) === null && (prefer ?? (t as { schedulerPreference?: SchedulerPreference }).schedulerPreference ?? "serverless") === "serverless") {
      return serverlessEndpointOf(t, true);
    }
    return homeMwaaEndpoint();
  }
  if (!t) throw new MwaaNotInstalled([{ targetId: tid, region: "?", reason: "执行目标不存在" }]);
  const slsReason = serverlessMissingReason(t);
  const mwaaReason = mwaaMissingReason(t);
  const pref: SchedulerPreference = prefer ?? (t as { schedulerPreference?: SchedulerPreference }).schedulerPreference ?? "serverless";
  if (slsReason === null && mwaaReason === null) {
    return pref === "mwaa"
      ? { targetId: tid, region: t.region, envName: String((t.resources as Record<string, unknown>).mwaaEnvName), dagBucket: String((t.resources as Record<string, unknown>).dagBucket), home: false }
      : serverlessEndpointOf(t, false);
  }
  if (slsReason === null) return serverlessEndpointOf(t, false);
  if (mwaaReason === null) return { targetId: tid, region: t.region, envName: String((t.resources as Record<string, unknown>).mwaaEnvName), dagBucket: String((t.resources as Record<string, unknown>).dagBucket), home: false };
  throw new MwaaNotInstalled([{ targetId: tid, region: t.region, displayName: t.displayName, reason: `${slsReason};${mwaaReason}` }]);
}

/** 某 target 的 serverless 端点(下线时按台账 scheduler 取);缺即抛。 */
export async function serverlessEndpointFor(targetId: string): Promise<ServerlessEndpoint> {
  const tid = isHome(targetId) ? HOME_TARGET_ID : assertTargetId(targetId);
  notePlaceDecision({ targetId: tid, via: SCHEDULER_ENDPOINT_VIA });
  const t = await getTargetRaw(tid);
  if (!t) throw new MwaaNotInstalled([{ targetId: tid, region: "?", reason: "执行目标不存在" }]);
  const reason = serverlessMissingReason(t);
  if (reason) throw new MwaaNotInstalled([{ targetId: tid, region: t.region, displayName: t.displayName, reason }]);
  return serverlessEndpointOf(t, isHome(tid));
}

/** 某 target 的 Airflow。home ⇒ env;非 home ⇒ 描述符,缺即抛 `MwaaNotInstalled`(不回落 home)。 */
export async function mwaaEndpointFor(targetId: string): Promise<MwaaEndpoint> {
  if (isHome(targetId)) {
    notePlaceDecision({ targetId: HOME_TARGET_ID, via: SCHEDULER_ENDPOINT_VIA });
    return homeMwaaEndpoint();
  }
  const tid = assertTargetId(targetId);
  notePlaceDecision({ targetId: tid, via: SCHEDULER_ENDPOINT_VIA });
  const t = await getTargetRaw(tid);
  if (!t) throw new MwaaNotInstalled([{ targetId: tid, region: "?", reason: "执行目标不存在" }]);
  const reason = mwaaMissingReason(t);
  if (reason) throw new MwaaNotInstalled([{ targetId: tid, region: t.region, displayName: t.displayName, reason }]);
  const res = t.resources as Record<string, string>;
  return { targetId: tid, region: t.region, envName: res.mwaaEnvName, dagBucket: res.dagBucket, home: false };
}

/**
 * 一次核全部 target,缺的**一起**列(宪法 B6);全齐 ⇒ 返回 targetId → endpoint 的表。
 * 🔴 调用方必须在**任何写副作用之前**调它(S3 Put / Glue 建作业 / application):缺 MWAA 时零产物(ACCEPTANCE E-208)。
 */
export async function requireMwaaForTargets(targets: readonly string[]): Promise<Map<string, SchedulerEndpoint>> {
  // @kf-batch 50-WP15-airflow-serverless:名字沿用(wiring 守卫钉的就是它),语义 = 「任一调度组件」(schedulerEndpointFor)
  const out = new Map<string, SchedulerEndpoint>();
  const missing: MwaaMissing[] = [];
  for (const tid of Array.from(new Set(targets))) {
    try {
      out.set(tid, await schedulerEndpointFor(tid));
    } catch (e) {
      if (e instanceof MwaaNotInstalled) missing.push(...e.missing);
      else throw e;
    }
  }
  if (missing.length > 0) throw new MwaaNotInstalled(missing);
  return out;
}
/** 语义更贴切的别名(SPEC v3.27 §3.15)。 */
export const requireSchedulerForTargets = requireMwaaForTargets;

/** 409 `SCHEDULER_NOT_INSTALLED`(SPEC v3.27 §2.1;旧码 MWAA_NOT_INSTALLED 见 detail.legacyCode):`detail.missing[]` + `detail.options` + `detail.fix{label, href}`。 */
export function mwaaErrorResponse(e: MwaaNotInstalled) {
  return apiError(e.message, 409, {
    code: SCHEDULER_NOT_INSTALLED_CODE,
    detail: {
      missing: e.missing,
      options: [...SCHEDULER_OPTIONS],
      legacyCode: LEGACY_MWAA_NOT_INSTALLED_CODE,
      fix: { label: "去执行环境补装调度", href: mwaaFixHref(e.missing[0]?.targetId ?? HOME_TARGET_ID) },
    },
  });
}

// ── Airflow CLI(CreateCliToken 在 **endpoint 所在 region**)────────────────────────────
const clients = new Map<string, MWAAClient>();
// @kf-batch 50-WP4quater-reads(工单 SC-3)—— 导出:编排的任务日志路由要用 `InvokeRestApi`,
// 那是本文件的 `mwaaCli`(CLI 通道)覆盖不到的第二种调用形态。让它复用**同一份按区客户端缓存**,
// 而不是在那个路由里再 new 一个(new 一个就又多了一处「默认主控区」的来源)。
export function mwaaClientFor(region: string): MWAAClient {
  let c = clients.get(region);
  if (!c) {
    c = sdkClient("data-plane", MWAAClient, { region });
    clients.set(region, c);
  }
  return c;
}

export interface MwaaCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 对某套 Airflow 跑一条 CLI(`dags list -o json` / `dags pause <id>` / `dags unpause <id>` / `dags trigger <id>`)。 */
export async function mwaaCli(ep: MwaaEndpoint, command: string): Promise<MwaaCliResult> {
  const { CliToken, WebServerHostname } = await mwaaClientFor(ep.region).send(new CreateCliTokenCommand({ Name: ep.envName }));
  const res = await fetch(`https://${WebServerHostname}/aws_mwaa/cli`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CliToken}`, "Content-Type": "text/plain" },
    body: command,
  });
  let stdout = "";
  let stderr = "";
  try {
    const b = (await res.json()) as { stdout?: string; stderr?: string };
    stdout = Buffer.from(b.stdout || "", "base64").toString();
    stderr = Buffer.from(b.stderr || "", "base64").toString();
  } catch {
    /* 非 JSON 响应:只留 ok */
  }
  return { ok: res.ok, stdout, stderr };
}

/**
 * 等 Airflow 加载到这些 DAG 后逐个 unpause(原来四处各抄一份的 18×10s 轮询,收成一份)。
 * best-effort:任何异常都吞(调用方 fire-and-forget);返回已解挂的 dagId。
 */
export async function unpauseWhenLoaded(
  ep: SchedulerEndpoint,
  dagIds: readonly string[],
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<string[]> {
  // @kf-batch 50-WP15-airflow-serverless:serverless workflow 建时即 TriggerMode=scheduled,无「解挂」概念
  if (isServerlessEndpoint(ep)) return [...dagIds];
  const attempts = opts.attempts ?? 18;
  const intervalMs = opts.intervalMs ?? 10_000;
  const pending = new Set(dagIds);
  const done: string[] = [];
  try {
    for (let i = 0; i < attempts && pending.size > 0; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const { stdout } = await mwaaCli(ep, "dags list -o json");
      for (const dagId of Array.from(pending)) {
        if (!stdout.includes(dagId)) continue;
        await mwaaCli(ep, `dags unpause ${dagId}`);
        pending.delete(dagId);
        done.push(dagId);
      }
    }
  } catch {
    /* best-effort */
  }
  return done;
}
