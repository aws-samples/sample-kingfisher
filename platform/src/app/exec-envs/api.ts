// @kf-batch 50-P50.2c-control-api
// 执行环境管理页的**客户端侧**类型与取数帮手(50 INTERACTION §1;API 合同 = 50 SPEC §2.1)。
//
// 🔴 本文件不 import registry.ts / deploy-control.ts —— 那两个模块顶层构造 AWS SDK client,
//    进客户端 bundle 既臃肿又无意义;页面只消费 HTTP API,类型在这里按 SPEC 形状收敛。
//    (`implemented-components` 是**零依赖**模块,可以安全 import —— 它就是为了让服务端与界面
//     共用同一份"哪些组件已实现"而拆出来的。)
import { isComponentImplemented, isComponentRetired } from "@/lib/exec-env/implemented-components";

/** 注册表 item 的页面消费子集(全量形状见 lib/exec-env/registry.ts 的 ExecutionTarget)。 */
export interface ExecEnvTarget {
  targetId: string;
  region: string;
  partition?: string;
  accountId?: string;
  cellId?: string;
  stage?: string;
  jurisdiction?: string;
  /** @kf-batch 50-W5-seg1-WP10a 项目白名单(通用;缺省全部项目) */
  access?: { mode: "all-projects" } | { mode: "allowlist"; projects: string[] };
  /** @kf-batch 50-W5-seg1-WP10a 注册跨法域 target 时 admin 对免责告知的同意(只读、不可改) */
  residencyAck?: { by: string; at: string; version: string; textHash: string };
  displayName?: string;
  status: string;
  components?: string[];
  isHome?: boolean;
  ready?: boolean;
  updatedAt?: string;
  lastBuildId?: string;
  lastOperationId?: string;
  /** @kf-batch 50-init-region-enablement 控制面是否已放行该 region(服务端算;false ⇒ 抽屉顶部 Alert + 运维命令) */
  controlPlaneRegionEnabled?: boolean;
  version?: number;
  probe?: { at?: string; ok?: boolean; items?: Array<{ name: string; ok: boolean; error?: string }> };
  /**
   * 🔴 P50.3b 双轴(SPEC §1.1):`status`/`ready` 是**派生投影**,真相在 spec/observed。
   * 客户端只读自己要用的两个字段:`spec.intent`(排空按钮的状态)与 `observed.phase`(阶段文案)。
   * 存量 legacy 描述符两者都缺 ⇒ 调用方**必须**有退路(不许猜成 serve —— 那会把正在退役的环境说成在服务)。
   */
  spec?: { intent?: string; desiredComponents?: string[]; desiredTemplateVersion?: string };
  /** @kf-batch 50-WP15-airflow-serverless(施工序 6):两者都装时走哪个调度器;缺省 serverless(SPEC §3.15) */
  schedulerPreference?: "serverless" | "mwaa";
  /** @kf-batch 50-WP15-airflow-serverless(K-5):网络规模 standard(2 NAT)/ economy(1 NAT);缺省 standard */
  observed?: { phase?: string; health?: string; components?: string[]; baselineRef?: string };
  /**
   * 🔴 **只读**可服务性(服务端 `describeServiceability`,与数据面准入**同一内核**)。
   * 为什么必须单独有这一段:`status` 徽标只是 生命周期×健康 的投影,**不含新鲜度(stale)与残留部署锁**
   * ⇒ 会出现"徽标写着运行中、数据面其实一律拒收"。`reason` 逐字就是数据面的拒因。
   * 旧后端可能没有这个字段 ⇒ 前端**必须**能缺省降级:卡片上什么都不打、详情里如实写"未知",
   * **既不装作可承接、也不误报不可承接**(两个方向都会把人带错)。
   */
  serviceability?: {
    usable: boolean;
    reason: string | null;
    ageSeconds: number | null;
    freshnessMaxAgeSeconds: number;
    staleExempt: boolean;
  };
  /** @kf-batch 50-WP9a-durable-jobs 凭证隔离状态机(50 SPEC §3.9b;只读展示,写只经专用端点) */
  credentialIsolationState?: "legacy-seeded" | "provisioning" | "isolated";
  credentialEpoch?: number;
  provisioningDeadlineAt?: string;
}

/** GET build-status 的响应形状(SPEC §2.1;observedVersion 恒 null,真源归切片 e)。 */
export interface BuildStatus {
  phase: string;
  stacks: Array<{ name: string; status: string; failureReason?: string }>;
  logsTail: string;
  observedVersion: null;
}

/** POST probe 的预期响应形状(切片 e 并行交付;404 = 尚未上线,页面须友好降级)。 */
export interface ProbeResult {
  probe: { at: string; ok: boolean; items: Array<{ name: string; ok: boolean; error?: string }> };
  finalized?: boolean;
  ready?: boolean;
  status?: string;
  /** @kf-batch 50-init-region-enablement 完成序(finalize)失败的**真因**(init 段 I-4:9 行红只是衍生症状);页面必须渲染它 */
  finalizeError?: string;
  /** 该 target 的 region 是否已被控制面放行(false ⇒ finalizeError 前缀已带运维命令) */
  regionEnabled?: boolean;
}

export class ApiError extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly code?: string,
    /** apiError 的 detail 透传(seed-home 的 probe 红项从这里取)。 */
    readonly detail?: unknown
  ) {
    super(msg);
  }
}

/**
 * 统一解包 apiOk/apiError 形状(`{success:true,data}` / `{success:false,error:{message,code}}`)。
 * 401/403 的文案在这里统一(网关 bgp-admin 强制,非管理员整页都会撞到)。
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: { success?: boolean; data?: T; error?: { message?: string; code?: string; detail?: unknown } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON(如网关 403 纯文本)走下面的兜底 */
  }
  if (res.ok && body?.success === true) return body.data as T;
  const msg =
    body?.error?.message ||
    (res.status === 401
      ? "未登录或登录态已失效"
      : res.status === 403
        ? "仅平台管理员(bgp-admin)可管理执行环境"
        : `请求失败(HTTP ${res.status})`);
  throw new ApiError(msg, res.status, body?.error?.code, body?.error?.detail);
}

export const listTargets = () => apiFetch<ExecEnvTarget[]>("/api/admin/exec-envs");
export const getTarget = (id: string) => apiFetch<ExecEnvTarget>(`/api/admin/exec-envs/${encodeURIComponent(id)}`);
export const getBuildStatus = (id: string, buildId?: string) =>
  apiFetch<BuildStatus>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/build-status` +
      // 🔴 P50.2e3:向导刚触发部署时显式带 buildId —— 首拉若靠注册表的 lastBuildId,会与 broker
      //    的回写竞态,拿到 phase="none" 被 BuildProgress 当终态停轮询(页面永远「当前无构建」,实测)。
      (buildId ? `?buildId=${encodeURIComponent(buildId)}` : "")
  );

export interface RegisterInput {
  /** @kf-batch 50-WP15-airflow-serverless(K-5):网络规模;缺省 standard */
  networkProfile?: "standard" | "economy";
  region: string;
  // 🔴 用户拍板(2026-09-01):accountId/partition **不由客户端提供**(服务端自取;带上会被 400)。
  //    执行环境严格限定控制面同账号的不同 region。
  cellId?: string;
  stage?: string;
  jurisdiction: string;
  components: string[];
  /** @kf-batch 50-W5-seg1-WP10a 跨法域注册必带(当前版本的免责告知同意) */
  residencyAck?: { version: string; textHash: string };
}
/** home seed(SPEC §1.1 的 seed 入口;bgp-admin 显式动作):真探全绿才落库。 */
export const seedHome = () =>
  apiFetch<{ targetId: string; outcome: { outcome: string }; probe: { ok: boolean; items: Array<{ name: string; ok: boolean; error?: string }> } }>(
    "/api/admin/exec-envs/seed-home",
    { method: "POST" }
  );

export const registerTarget = (input: RegisterInput) =>
  apiFetch<{ targetId: string; status: string; controlPlaneRegionEnabled?: boolean; notice?: string }>("/api/admin/exec-envs/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
/**
 * 触发部署。@kf-batch 50-W5-seg1-WP3:已启用 target 的「重新部署」= 升级,先 `previewComponents(id, 已装全集)` 看计划,
 * 计划需审批时带 `approvedPlanHash`(SPEC §2.1 v3.21;不带也能发起 —— 真判要不要审批的是 build 侧重算)。
 */
export const deployTarget = (id: string, approvedPlanHash?: string) =>
  apiFetch<{ buildId: string; lockEpoch: number; operationId: string }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/deploy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approvedPlanHash ? { approvedPlanHash } : {}),
    }
  );
export const probeTarget = (id: string) =>
  apiFetch<ProbeResult>(`/api/admin/exec-envs/${encodeURIComponent(id)}/probe`, { method: "POST" });
/**
 * 补充部署(SPEC §2.1 add-components):`components` 是**全集**语义(部署后想要的组件集),
 * 不是增量 —— 服务端按"只增不减"校验。
 */
export const addComponents = (id: string, components: string[], approvedPlanHash?: string) =>
  apiFetch<{ buildId: string; lockEpoch: number; operationId: string; added: string[]; components: string[] }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/add-components`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 🔴 P0-E(SPEC §3.5c ③):`approvedPlanHash` 只在管理员**看过预演计划并批准**后才带。
      //    不带也能发起 —— 真正判"要不要审批"的是 **build 侧重算**(平台这一侧可能被绕)。
      body: JSON.stringify({ components, ...(approvedPlanHash ? { approvedPlanHash } : {}) }),
    }
  );

/** 🔴 P0-E 一条变更的呈现形状(与服务端 `ImpactReason` 一致)。 */
export interface ImpactReasonView {
  stackName: string;
  logicalResourceId: string;
  resourceType: string;
  action: string;
  replacement?: string;
  why: string;
  stateful: boolean;
  requiresApproval: boolean;
}

export interface ImpactVerdictView {
  target: string;
  planHash: string;
  disruptive: boolean;
  requiresApproval: boolean;
  changeCount: number;
  stackCount: number;
  baseline?: { state: string; disruptive: boolean; requiresApproval: boolean; why: string };
  sourceRef?: string;
  baselineRef?: string;
  reasons: ImpactReasonView[];
}

/**
 * 🔴 P0-E 第一阶段:**预演**(SPEC §3.5c ①)。只创建 change set 不执行 ⇒ 不改任何东西、不上锁。
 * 返回 buildId;裁决要用 `getPreviewVerdict` 轮询(预演本身要跑 cdk synth,约 1–3 分钟)。
 */
export const previewComponents = (id: string, components: string[]) =>
  apiFetch<{ buildId: string; operationId: string; components: string[]; added: string[]; mode: string }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/preview`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ components }) }
  );

/**
 * 取预演裁决。三态:`pending`(还在跑)/ `unavailable`(跑完了但取不到裁决)/ `ready`(有裁决)。
 * 🔴 `unavailable` **绝不当成"没有影响"** —— 调用方按 fail-closed 提示人工排查。
 */
export const getPreviewVerdict = (id: string, buildId: string) =>
  apiFetch<{ state: "pending" | "unavailable" | "ready"; buildPhase?: string; hint?: string; verdict?: ImpactVerdictView; summary?: string }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/preview?buildId=${encodeURIComponent(buildId)}`
  );
/**
 * 🔴 P50.3b-4:排空 / 回服务(SPEC §1.1 双轴:spec 由人写,phase 由控制器驱动)。
 * `drain` = 停止承接**新**工作(准入**同步**生效);`serve` = 恢复承接意图(phase 需下一次**全绿探活**才回 ready)。
 * 🔴 只这两个值 —— 退役/删除走 §4.6 销毁流程,不许只改标记(否则造出"标成已退役而资源全在"的谎)。
 */
/**
 * @kf-batch 50-W5-seg1-WP10a 设置项目白名单(SPEC §2.1 v3.22 `POST .../access`,全集语义,bgp-admin)。
 * 通用:任何 target 都可设;`{mode:"all-projects"}` 回缺省。
 */
// @kf-batch 50-WP9a-durable-jobs —— 延期 provisioning 截止(50 SPEC §3.9b 专用操作;服务端校验前态 + epoch + ≤30 天 + 审计)
export const extendProvisioningDeadline = (
  id: string,
  body: { extendDays: number; reason: string; expectedEpoch?: number }
) =>
  apiFetch<{ targetId: string; fromDeadline: string | null; provisioningDeadlineAt: string; epoch: number; operationId: string }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/provisioning-deadline`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );

export const setTargetAccess = (id: string, access: { mode: "all-projects" } | { mode: "allowlist"; projects: string[] }) =>
  apiFetch<{ targetId: string; access: { mode: "all-projects" } | { mode: "allowlist"; projects: string[] } }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/access`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(access) }
  );
export const setTargetIntent = (id: string, intent: "serve" | "drain") =>
  apiFetch<{ targetId: string; intent: string; phase?: string; status?: string; note: string }>(
    `/api/admin/exec-envs/${encodeURIComponent(id)}/intent`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent }) }
  );

export const enableTarget = (id: string) =>
  apiFetch<{ targetId: string; status: string }>(`/api/admin/exec-envs/${encodeURIComponent(id)}/enable`, {
    method: "POST",
  });

/**
 * 🔴 P50.3b-2b:失败会话恢复(SPEC §3.5b)。
 * 页面**不自己判断**"能不能恢复" —— 判据只有一处(服务端 `assessRecovery`),GET 回什么就渲染什么,
 * 否则会出现"页面说可以恢复、接口却拒"。
 */
export interface RecoveryStatus {
  /** 有在途会话/残留锁 ⇒ 禁止再发新部署(禁静默重试);与 needed 是两件事。 */
  sessionInFlight: boolean;
  /** 真的需要人处理(失败终止 / attach 丢响应 / startUncertain / 形态坏);正常在途部署为 false。 */
  needed: boolean;
  recoverableNow: boolean;
  reason: string;
  kind?: string;
  operationId?: string;
  buildStatus?: string;
  earliestRecoverAt?: string;
  cfn?: { stable: boolean; blockers: string[]; stacks: Array<{ name: string; status: string; pendingChangeSets: number; failureReason?: string }>; checkedAt: string };
}

export const getRecoveryStatus = (id: string) =>
  apiFetch<RecoveryStatus>(`/api/admin/exec-envs/${encodeURIComponent(id)}/recover`);

/** 恢复:必须点名会话 + 显式确认(服务端 fence 会再核一遍,期间开了新会话必失败)。 */
export const recoverTarget = (id: string, expectedOperationId: string, decisionId: string) =>
  apiFetch<{
    recovered: boolean;
    mode: string;
    kind: string;
    buildStatus: string;
    status?: string;
    ready?: boolean;
    note?: string;
  }>(`/api/admin/exec-envs/${encodeURIComponent(id)}/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedOperationId, decisionId, confirm: true }),
  });

/** 状态机 → 徽标(SPEC §1.1 状态机;色板照 INTERACTION §1.1:active 绿/initializing 蓝转/…)。 */
export const STATUS_META: Record<string, { color: string; label: string }> = {
  registered: { color: "default", label: "已注册" },
  initializing: { color: "processing", label: "部署中" },
  testing: { color: "cyan", label: "测试中" },
  active: { color: "success", label: "运行中" },
  degraded: { color: "warning", label: "降级" },
  failed: { color: "error", label: "失败" },
  upgrading: { color: "processing", label: "升级中" },
  draining: { color: "orange", label: "排空中" },
  decommissioning: { color: "orange", label: "销毁中" },
  deleted: { color: "default", label: "已删除" },
};

/**
 * 组件的 UI 元数据(标签/释义/预估成本文案照 INTERACTION §1.2)。
 * 🔴 权威枚举 = SPEC §1.1 / registry.ts 的 TARGET_COMPONENTS —— 这里是**展示层副本**(不 import
 *    registry,见文件头),漂移风险仅限文案。
 * 🔴 **`available` 不再手写**:它 = `isComponentImplemented()`(`lib/exec-env/implemented-components`
 *    的零依赖 SSOT,服务端 add-components 校验用的是同一份)。P50.2 时代这里手写 false,与服务端
 *    各持一份判断 ⇒ 放开组件时必然漏改一边,现在改成派生(change-safety A1)。
 */
export const COMPONENT_META: Array<{ key: string; label: string; desc: string; cost: string; available: boolean; retired?: boolean }> = [
  { key: "core", label: "core", desc: "计算+存储+网络+数据湖(必装)", cost: "零出网,无 NAT 常驻费用" },
  { key: "redshift", label: "redshift", desc: "Redshift Serverless 数据仓库", cost: "按用量(RPU),空闲不计费" },
  { key: "kafka", label: "kafka(MSK)", desc: "流消息源", cost: "≈$180/月起" },
  // @kf-batch 50-WP13-mwaa-region —— 用户拍板:每个区域的定时任务由本区域的 MWAA 执行;非 home 区要配调度 / 编排必装
  // @kf-batch 50-WP17-serverless-workflow —— 🔴 用户 2026-09-11 拍板:「后面也不部署普通版本的 mwaa 了。」
  //   **不再提供新装**(向导不可勾),但**存量环境照旧可用** —— 所以这一行刻意**留着**并写清原因:
  //   让手上已经有 mwaa 的人看得懂「为什么它在这儿却勾不了」,比让它凭空消失诚实。
  { key: "mwaa", label: "mwaa", desc: "定时调度 / 编排(经典 Airflow,常驻)—— 已停止提供:请用 airflow-serverless;已装的环境照旧可用", cost: "≈$350/月(常驻)" },
  // @kf-batch 50-WP15-airflow-serverless —— 用户拍板:经典 MWAA 保留、新增 serverless 入口;两者都装时 serverless 优先
  { key: "airflow-serverless", label: "airflow-serverless", desc: "定时调度 / 编排(Serverless Airflow;按任务秒计费、最少 1 分钟;分钟级开通,零常驻)", cost: "按任务运行秒数,空闲 $0" },
  { key: "dms", label: "dms", desc: "数据迁移/CDC", cost: "子网组免费,复制实例按需" },
  { key: "flink", label: "flink", desc: "流计算(MSAF)", cost: "角色免费,作业按 KPU" },
  { key: "agentcore", label: "agentcore", desc: "本 region 问数三件套", cost: "按调用" },
  { key: "residency-api", label: "residency-api", desc: "区域审计 / 结果存储(非 home 法域必装 —— 技术前置,不是审批;WP-10a)", cost: "DDB 按量 + S3 桶,近零" },
].map((c) => ({ ...c, available: isComponentImplemented(c.key) && !isComponentRetired(c.key), retired: isComponentRetired(c.key) }));

// (P50.2e2:客户端不再提供 partition —— partitionForRegion 客户端副本已删,权威在 registry.ts)

/**
 * 预览用 targetId(**仅展示**):真 id 由服务端生成(可能是 `_b`/`_c` 进位),这里按
 * registry.regionAbbrev 同规则推第一候选,让 Step1 的命名预览有真实形状可看。
 * 🔴 不是命名权威 —— 名字模板全部经 `@/lib/aws/naming`(SSOT),本函数只产 slug 候选。
 */
export function previewTargetId(region: string): string {
  const seg = region.split("-");
  const abbrev = seg[0] + seg.slice(1, -1).map((s) => s[0]).join("") + seg[seg.length - 1];
  return `tgt_${abbrev}_a`;
}


/** @kf-batch 50-WP15-airflow-serverless(施工序 6):改调度器偏好(只影响之后的发布;已发布作业保持原调度器直到重新发布)。 */
export const setTargetSchedulerPreference = (targetId: string, schedulerPreference: "serverless" | "mwaa", expectedVersion: number) =>
  apiFetch<{ schedulerPreference: string; changed: boolean; hint: string }>(`/api/admin/exec-envs/${encodeURIComponent(targetId)}/scheduler-preference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schedulerPreference, expectedVersion }),
  });

// @kf-batch 50-WP27b-n-region-auto
/** 新建执行环境可选的 region —— **从账号真值派生**(`ec2:DescribeRegions` + 注册表占位),
 *  不是写死的候选表。已被占的区一并回,界面要「列出来但点不动」并写明占位者。 */
export const getCandidateRegions = () =>
  apiFetch<{
    regions: string[];
    occupied: Array<{ region: string; targetId: string; status: string }>;
    available: string[];
    // 序 48:控制面已放行(含预授权候选区)的区 —— 在这些区新建不需要运维放行
    controlPlaneEnabled?: string[];
    // @kf-batch 50-B40-candidate-blocked
    blocked?: Array<{ region: string; actions: string[]; layer: string; reason: string }>;
    orgPolicy?: { principal: string | null; unverified: Array<{ region: string; reason: string }>; checkedAt: string; source: string };
    source: string;
    note: string;
    queriedAt: string;
  }>("/api/admin/exec-envs/candidate-regions", { cache: "no-store" });

// ══ @kf-batch 50-WP30-decommission —— 删除执行环境(路 B)的取数帮手(合同:WORK-PACKAGES WP-30 ③ / SPEC §2.1)══

export interface DeleteImpactItem { kind: string; label: string; id: string; name: string; projectId?: string }
export interface RetainedResourceView { kind: string; name: string; note: string }
export interface DeletePreviewView {
  targetId: string;
  region: string;
  stage: "serving" | "drained" | "pending-approval" | "approved" | "destroying" | "stuck" | "deleted" | "never-deployed";
  pendingApprovalId?: string;
  blockers: string[];
  impact: {
    counts: { bindings: number | null; schedules: number | null; runningRuns: number | null };
    bindings: DeleteImpactItem[];
    schedules: DeleteImpactItem[];
    runningRuns: Array<{ taskId: string; runId: string; taskType?: string }>;
    unresolved: Array<{ source: string; error: string }>;
    retained: RetainedResourceView[];
    truncated: boolean;
    computedAt: string;
    previewHash: string;
    clear: boolean;
  };
}
export interface DecommissionViewDto {
  targetId: string;
  phase: string;
  status: string;
  state: "not-decommissioning" | "running" | "settled-gone" | "settled-stuck" | "stuck" | "deleted";
  buildPhase?: string;
  lastError?: string;
  lastDestroy?: {
    outcome: "gone" | "stuck";
    buildStatus: string;
    checkedAt: string;
    remaining: string[];
    unverifiable: string[];
    stuck?: { step?: string; resource: string; reason: string };
    retained: RetainedResourceView[];
    finalSnapshot?: { name: string; state: string };
  };
  plan?: { approvalId: string; finalSnapshotName: string; approvedBy: string; approvedAt: string; retained: RetainedResourceView[] };
}

const envUrl = (id: string, sub: string) => `/api/admin/exec-envs/${encodeURIComponent(id)}/${sub}`;
const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const getDeletePreview = (id: string) => apiFetch<DeletePreviewView>(envUrl(id, "delete-preview"), { cache: "no-store" });
export const drainForDelete = (id: string, reason: string) => apiFetch<{ note: string }>(envUrl(id, "drain"), postJson({ reason }));
export const requestDeleteTarget = (id: string, confirm: string, previewHash: string) =>
  apiFetch<{ approvalId: string; note: string }>(envUrl(id, "delete-request"), postJson({ confirm, previewHash }));
export const retryDestroyTarget = (id: string, confirm: string) => apiFetch<{ buildId: string; note: string }>(envUrl(id, "destroy-retry"), postJson({ confirm }));
export const observeDestroy = (id: string) => apiFetch<DecommissionViewDto>(envUrl(id, "destroy-observe"), postJson({}));

/** 「去解绑」直达:每类资源去它自己的列表页(找到那一行后改绑定 / 停调度 / 等运行结束)。 */
export const IMPACT_KIND_HREF: Record<string, string> = {
  datasource: "/datasources",
  sync: "/sync",
  "etl-job": "/etl-jobs",
  "engine-job": "/etl-jobs",
  "flink-job": "/realtime-compute",
  workflow: "/workflow",
  "redshift-task": "/redshift",
  "model-table": "/modeling",
  "code-table": "/modeling",
  "backfill-plan": "/backfill",
  "action-schedule": "/governance",
};
