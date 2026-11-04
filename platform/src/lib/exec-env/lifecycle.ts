// 执行环境状态机的【唯一权威】—— 期望态(spec)/ 观测态(observed)分离 + 单一写通道。
//
// 合同:SPEC §1.1 v3.15(status 降派生投影 + spec/observed 双轴 + phase 转移表);台账 DESIGN §20.23。
//
// 【为什么有这个文件(根因,不是补丁)】v3.14 前根本没有"状态机"这个东西,只有一个 `status` 字段
//   同时扛【生命周期 × 健康 × 在途操作】三种正交语义,又被 6 处各自硬编码前态地写(broker 无条件置位 /
//   seed 直落 active / register 直落 registered / markTargetTested 认 2 态 / enableTarget 认 1 态 /
//   probe route 又抄一份 2 态)⇒ 每长一条业务路径必漏一个前态组合。bug #9(补充部署回写被维修态门拒)
//   与 bug #11(补充部署后回不到 active)是同一机制两次发作;真环境已造出 `status=initializing ∧ ready=true`
//   的不可能形态。⇒ 拆成 spec/observed + 单一控制器,从结构上消除病根:新增写入方 = 往转移表加一条边 +
//   调 transitionPhase,漏不掉。
//
// 🔴 模块边界(避免与 registry.ts 循环引用):本文件是【低层】——
//   · 只 `import type`(编译期擦除,无运行时依赖)引 registry 的 `TargetStatus`/`ExecutionTarget`;
//   · DB 客户端引自 `@/lib/aws/dynamodb`、身份工具引自 `target-id`(都是低层);
//   · registry.ts 反过来引本文件的【值】(转移表/纯派生/单写通道)。运行时依赖方向 registry → lifecycle 单向。
//
// 🔴 本文件是全仓【唯一】写 `observed.phase` / `spec` 的地方(AST 门禁钉:lifecycle.ts 之外的 status/phase
//    写点必须为 0)。任何"改状态"都必须经 transitionPhase / writeSpec,绝不允许别处内联条件写。

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { assertTargetId } from "@/lib/exec-env/target-id";
import {
  isGreenProbeForComponents,
  componentForProbeItem,
  sameComponentSet,
  componentSetKey,
} from "@/lib/exec-env/component-contract";
import { orderComponents } from "@/lib/exec-env/implemented-components";
import { SCHEDULER_PREFERENCES, isSchedulerPreference, isWritableSchedulerPreference, retiredSchedulerPreferenceMessage, type SchedulerPreference } from "@/lib/exec-env/scheduler-preference";
import type { TargetStatus, ExecutionTarget } from "@/lib/exec-env/registry";

/** 单分区常量 pk(与 registry.ts 同,SPEC §1.1)。 */
const PK = "env";

// ══════════════════════════════════════════════════════════════════════════════
// 三条正交轴的词表(先有数组再派生类型 —— 与 TARGET_STATUSES 同款,zod 与 TS 用同一份事实)
// ══════════════════════════════════════════════════════════════════════════════

/** 生命周期阶段(observed,由控制器唯一驱动)。健康在 health 轴、退役意图在 spec.intent,都不占 phase。 */
export const TARGET_PHASES = [
  "registered", // item 存在,尚未部署任何栈
  "provisioning", // 首次部署在途(build 跑着 / 刚失败待重试)
  "verifying", // 已部署,待探活确认
  "ready", // 已验证,可服务(健康与否看 health 轴;升级中看 operation)
  "draining", // 排空中(spec.intent=drain/delete;只收尾在途、拒新工作)
  "decommissioning", // 销毁中
  "gone", // 已删除(tombstone)
] as const;
export type TargetPhase = (typeof TARGET_PHASES)[number];

/** 健康(observed,由探活得出,可 flap)。注意 `degraded` 仍可服务(与旧 RUNTIME_USABLE_STATUS 一致)。 */
export const TARGET_HEALTHS = ["unknown", "healthy", "degraded"] as const;
export type TargetHealth = (typeof TARGET_HEALTHS)[number];

/** 意图(spec,人/API 声明该 target 最终该干什么)。默认 serve。 */
export const TARGET_INTENTS = ["serve", "drain", "delete"] as const;
export type TargetIntent = (typeof TARGET_INTENTS)[number];

/**
 * 在途部署/排空会话(broker 开、完成方/reconciler 清)。
 * 🔴 `disruptive` = 本次是否触及 core 有状态栈(Redshift/MWAA;§12.6 / P0-E)。
 *    **基线校验(批 3)落地前恒 `true`** ⇒ fail-closed:部署期一律不承接新工作(见 serviceabilityReason)。
 */
export interface DeployOperation {
  /** +`destroy`(下线销毁会话;broker 开、平台收口 `settleDestroy` 清) */
  kind: "deploy" | "drain" | "destroy";
  operationId: string;
  /** 🔴 v2 审核(§4.1):epoch 进 operation —— 完成方才能证明自己清的是**同一次**部署会话,而非后启动的新 operation。 */
  lockEpoch: number;
  /** deploy 必填:sha256(canonical identity/policy/resources/agentcore 快照);完成方核对部署期间基线未被顶替。 */
  openSnapshotHash?: string;
  buildId?: string;
  startedAt: string;
  /** 🔴 P0-E 未落地前**恒 true**(§10.2):无法证明"只增不改"就一律阻断准入,fail-closed。 */
  disruptive: boolean;
  /**
   * 🔴 P0-E ④(SPEC §3.5c):本次部署所用的**源包身份**(CodeBuild 项目/broker 的 `EXEC_ENV_SOURCE_REF`)。
   * broker 开 operation 时转录;**成功栅栏**把它提升为 `observed.baselineRef`;失败一律不动
   * (与"失败不动 phase"同一条原则:没成功就不许改写"现实是哪一版")。缺失 ⇒ 基线判定按 fail-closed 处理。
   */
  sourceRef?: string;
  /** StartBuild 抛错=受理未知(§4.5):记录但**不清 operation/锁**,留阻断待恢复器核查。 */
  startUncertain?: { at: string; message: string };
  /** StartBuild 成功但 attach buildId 失败:候选 buildId 待 5min 窗口内幂等补 attach。 */
  attachUncertain?: { at: string; message: string; candidateBuildId: string };
}

/** 期望态:API / broker 只写这里(声明意图,不写观测)。 */
export interface TargetSpec {
  intent: TargetIntent;
  /** 想装哪些组件(必含 core)。补上 SPEC §3.5 承诺却无落点的 desired。 */
  desiredComponents: string[];
  /** 想要的模板版本(升级走显式波次;批 3)。 */
  desiredTemplateVersion?: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// 探活结果 canonical 类型 + zod schema —— 全仓【唯一权威】(registry/probe-runner/deploy-control 复用)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 **严格 canonical ISO-8601 UTC 瞬时**:必须是 `YYYY-MM-DDTHH:mm:ss.sssZ` 且 round-trip 稳定
 *    (`new Date(Date.parse(v)).toISOString() === v`)。
 * 【为什么必须 canonical】完成态 fence 用 `probe.at` 做**逐字节等值**条件写(`#probe.#at = :probeAt`),
 *    松格式(缺毫秒 / 带偏移 `+00:00` / 多余精度)会让两次序列化不一致 ⇒ 完成写永远 ConditionalCheckFailed
 *    或(更糟)不同实例写出不同串。写侧一律用 `new Date().toISOString()`,天然 canonical。
 */
export function isStrictIsoInstant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}

/** 探活单项。 */
export const ProbeItemSchema = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
});

/** 探活结果(SPEC §1.1 `probe`)。**唯一权威**:registry/probe-runner/deploy-control 都消费它。 */
export const ProbeResultSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  items: z.array(ProbeItemSchema).min(1),
});

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/** 描述符缺 spec/observed 或 probe 形态坏时抛;写入方 fail-closed(零 DDB 写)。 */
export class ProbeResultInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProbeResultInvalidError";
  }
}

/**
 * 🔴 canonical 解析:结构合法 + `at` canonical + `ok === items.every(ok)`;任一违反即抛。
 * writeProbeResult / reconcileAfterProbe 在构造**任何** UpdateCommand 前先调它 —— 坏 probe 零 DDB 写。
 * (空 items 的 `every()` 恒 true 会造假绿 ⇒ schema 已 `.min(1)` 挡掉。)
 */
export function parseProbeResult(probe: unknown): ProbeResult {
  const parsed = ProbeResultSchema.safeParse(probe);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ProbeResultInvalidError(`probe 形态非法:${first?.path?.join(".") || "(根)"} —— ${first?.message}`);
  }
  if (!isStrictIsoInstant(parsed.data.at)) {
    throw new ProbeResultInvalidError(`probe.at 不是 canonical ISO 瞬时(YYYY-MM-DDTHH:mm:ss.sssZ):${JSON.stringify(parsed.data.at)}`);
  }
  const everyOk = parsed.data.items.every((i) => i.ok);
  if (parsed.data.ok !== everyOk) {
    throw new ProbeResultInvalidError(`probe.ok(${parsed.data.ok})与 items 全绿与否(${everyOk})矛盾 —— 拒绝自相矛盾的探活结果`);
  }
  return parsed.data;
}

/** 组件集 schema(必含 core;完成态 fence 的 desired/observed 都要过它)。 */
export const DesiredComponentsSchema = z
  .array(z.string().min(1))
  .min(1)
  .refine((a) => a.includes("core"), "组件集必含 core");
export const ObservedComponentsSchema = DesiredComponentsSchema;

/** 探活真实读取的输入快照(region/account/partition/组件/资源/agentcore)——完成态 fence 绑定它防同版本旧绿清新态。 */
export interface ProbeInputSnapshot {
  region: string;
  accountId: string;
  partition: string;
  components: string[];
  resources: Record<string, unknown> | undefined;
  agentcore: Record<string, unknown> | undefined;
}

export const ProbeInputSnapshotSchema = z.object({
  region: z.string().min(1),
  accountId: z.string().min(1),
  partition: z.string().min(1),
  components: z.array(z.string().min(1)).min(1),
  resources: z.record(z.string(), z.unknown()).optional(),
  agentcore: z.record(z.string(), z.unknown()).optional(),
});

// ══════════════════════════════════════════════════════════════════════════════
// 完成态 / 收养 fence 类型(§20:transitionPhase 的**受限自转授权** + exact 完成写绑定)
// —— bug#11 真正闭合的核心:completion 以 version+phase+opId+epoch+**本次 probe 身份** 一次条件写,
//    operation + deploy 锁**同写清**;任何证据在途变化都让完成写 ConditionalCheckFailed(fail-closed)。
// ══════════════════════════════════════════════════════════════════════════════

/** 一次「精确全绿」证据:probe.at 为 canonical、desired===observed、probe 项**精确覆盖**组件(见 isGreenProbeForComponents)。 */
export interface ExactGreenLifecycleEvidence {
  probeAt: string;
  probe: ProbeResult;
  desiredComponents: string[];
  observedComponents: string[];
  probeInput: ProbeInputSnapshot;
}

/** modern 完成 deploy 的 fence:绑 operation tuple + 本次 probe 身份;一次条件写清 operation + 顶层 deploy 锁。 */
export interface DeploymentCompletionFence extends ExactGreenLifecycleEvidence {
  operationId: string;
  lockEpoch: number;
  openSnapshotHash: string;
  buildId: string;
  startedAt: string;
}

/** legacy(e99/initial)完成会话 tuple:route 已核 exact SUCCEEDED build 时携此,同一 Update 清锁。 */
export interface LegacySessionFence {
  lockEpoch: number;
  lockToken: string;
  operationId: string;
  buildId: string;
}

/** 三种 legacy 收养模式(见 adoptLegacyAfterFreshProbe / probe route captureProbeEvidence)。 */
export type LegacyProbeMode = "stable" | "e99" | "initial";

/** legacy 首写收养 fence:`stable` 无 session(证明无残留锁);`e99`/`initial` 必携 exact session tuple。 */
export type LegacyCompletionFence = ExactGreenLifecycleEvidence &
  ({ mode: "stable"; session?: never } | { mode: "e99" | "initial"; session: LegacySessionFence });

/** 人工 enable(verifying→ready)fence:**必须本次请求 fresh probe 生成**,绝不读历史 `probe.ok`。 */
export interface EnableLifecycleFence extends ExactGreenLifecycleEvidence {
  expectedVersion: number;
  fromPhase: "verifying";
}

/**
 * 弃置授权:`registered|provisioning → gone`。
 * `noStacksVerifiedAt` = 本次**真查** CFN 的时刻(目标 region 无 `BgpExecEnv-<slug>-*` 任何非 DELETE_COMPLETE 栈)——
 * 资源事实由调用方现查,条件写只能钉描述符侧的事实(无 operation / 无锁 / 从没 ready / 无资源袋)。
 */
export interface DiscardFence {
  expectedVersion: number;
  fromPhase: "registered" | "provisioning";
  noStacksVerifiedAt: string;
}

/** DynamoDB 条件写因 version/phase/session/probe/input fence 变化而拒(并发冲突)。route 转 structured 200。 */
export class LifecycleConflictError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LifecycleConflictError";
  }
}

/** transition 提交结果**未知**(send 抛错且 strong-read postcondition 也无法证明成败)。进外层 502/告警。 */
export class LifecycleCommitUncertainError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LifecycleCommitUncertainError";
  }
}

/** 观测态:唯一由 reconciler / 控制器写(经 transitionPhase)。 */
export interface TargetObserved {
  phase: TargetPhase;
  health: TargetHealth;
  /** 真读到栈的组件(observed;取代旧顶层 `components` 的纯 observed 语义)。 */
  components: string[];
  /**
   * DescribeStacks 回写(复活死字段 observedVersion)。
   * ⚠️ 语义是「该 target 各栈 `LastUpdatedTime` 的最大值」= **时间戳**,不是源身份 ——
   *    **别拿它当 baselineRef 用**(混用会得到一个看着有值、实际永不相等的"基线",比没有更糟)。
   */
  templateVersion?: string;
  /**
   * 🔴 P0-E ④(SPEC §3.5c v3.6):**上次成功部署所用的源包身份**("现实里装的是哪一份源")。
   * 唯一写入方 = **成功栅栏**(与 `observed.components` 同一次条件写);失败一律不动。
   * 判定:与本次 `EXEC_ENV_SOURCE_REF` 相等 ⇒ 源零漂移、既有栈天然 no-op;不等且无
   * `spec.desiredTemplateVersion` 波次授权 ⇒ 必须审批。缺失 ⇒ disruptive 但**不**要求审批
   * (否则全新 env 首装被自己挡死)。
   */
  baselineRef?: string;
  probe?: ProbeResult;
  operation?: DeployOperation;
  lastReconcileAt?: string;
  lastError?: string;
  /** 🔴 2a:连续探活未全绿次数(health 降级抖动防护;全绿即清 0)。周期 reconciler 维护。 */
  unhealthyStreak?: number;
  /** 🔴 2b:上一次失败会话的**已核验**处置(唯一失败写入方 `recordOperationFailure` 写)。诊断/审计用,不参与准入判定。 */
  lastFailure?: ObservedFailureRecord;
}

/**
 * 🔴 2b:失败会话的落库记录(SPEC §3.5b)。**全部字段都是"查出来的"**,不是调用方声明的意图
 * `buildStatus` 来自对 exact buildId 的 CodeBuild 查询(无 buildId 时为 `"no-build"`),
 * `stacks`/`checkedAt` 来自 `describeStackDisposition`,`decisionId`/`decidedBy` 来自管理员显式确认。
 */
export interface ObservedFailureRecord {
  at: string;
  operationId: string;
  lockEpoch: number;
  buildId?: string;
  buildStatus: string;
  checkedAt: string;
  stacks: Array<{ name: string; status: string; pendingChangeSets: number }>;
  decisionId: string;
  decidedBy: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// phase 权威转移表(SPEC §1.1 v3.15)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 每个 phase 的合法后继。**这是"状态机"的唯一定义**;门禁钉:每个 TARGET_PHASES 成员都有条目、
 * 边目标合法、`gone` 无出边、表里没有 `ready→provisioning` 这种老路。
 *
 * 关键设计(直接杀死 bug #11):**对已就绪(ready)的 target 做补充部署,phase 不离开 `ready`** ——
 *   升级只置 `observed.operation`,准入由 operation.disruptive 决定;operation 一清,准入自动恢复。
 *   "回哪个状态"这个问题在正确模型里根本不存在(不像旧实现要记 resumeStatus 再猜回去)。
 * 失败不新增 `failed` phase:首次部署失败 = 留在 `provisioning` + 置 `observed.lastError`(投影为 "failed"),
 *   重试 = provisioning→provisioning 幂等自转(清 lastError)。
 */
export const PHASE_EDGES: Record<TargetPhase, readonly TargetPhase[]> = {
  // `→ gone` 是**弃置**:从没装出来、目标区无本 slug 栈的环境直接退役。
  //   🔴 这两条边**只能**由 `DiscardFence` 授权(transitionPhase 里与 enableFence 同一手法:边 ⇔ fence 成对),
  //   条件写里再钉「无 operation / 无部署锁 / 从没 ready / 无资源袋」—— 不许被普通转移顺手走掉。
  registered: ["provisioning", "gone"],
  // `→ decommissioning` 四条边(provisioning / verifying / ready / draining):
  //   装过(或装了一半、有栈)的环境经删除审批后进入销毁。🔴 这些边**只能**由 broker 的 destroy 开会话走
  //   (与部署锁、destroy operation 同一次条件写;validate.mjs planDestroyOpen),`transitionPhase` 一律拒 ——
  //   否则任何调用方都能把一个资源还在的环境标成「销毁中」(tombstone 谎的前一步)。
  provisioning: ["verifying", "gone", "decommissioning"], // 成功进 verifying;失败留 provisioning+lastError;重试走幂等自转
  verifying: ["ready", "provisioning", "decommissioning"], // 探活绿→ready;探活红或需重部→退回 provisioning
  ready: ["draining", "decommissioning"], // 🔴 升级不改 phase(只置 operation);健康在 health 轴。退役才离开 ready
  // 🔴 4:`draining → ready` 是**回服务**(un-drain)。排空是**运维动作**(维护/腾挪前先停接新活),
  //    做完就该能放回来;原表只有 `draining → decommissioning` ⇒ 排空成了**单向门**,一旦排空只能走向销毁,
  //    这会逼运维不敢用排空(于是他们改去做更危险的事:直接改状态或干脆不排空)。
  //    回服务仍要过**同一条证据路**(fresh 全绿探活),不是把标记翻回去就算。
  draining: ["decommissioning", "ready"],
  decommissioning: ["gone"],
  gone: [], // 终态
};

/** 转移是否合法(自转视为合法幂等,供 reconciler 重复回写不报错)。 */
export function isValidPhaseTransition(from: TargetPhase, to: TargetPhase): boolean {
  if (from === to) return true;
  return (PHASE_EDGES[from] ?? []).includes(to);
}

// ══════════════════════════════════════════════════════════════════════════════
// 派生投影 —— 让旧 status/ready/components readers 过渡期照旧工作(加法式迁移)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 `status` 派生投影:(spec, observed) → 旧 10 态枚举。**全函数**(TS 穷尽 phase);
 * 旧 10 态**每个都可达**(门禁钉,防漏态):
 *   registered←registered/无err · initializing←provisioning/无err · testing←verifying ·
 *   active←ready/无op/healthy · degraded←ready/无op/degraded · failed←(registered|provisioning)+lastError ·
 *   upgrading←ready+op · draining←draining · decommissioning←decommissioning · deleted←gone
 */
export function deriveStatusProjection(spec: TargetSpec, observed: TargetObserved): TargetStatus {
  // 🔴 **intent 优先于"服务中"类 phase**(2026-09-03 真环境实测揪出:本函数**收了 `spec` 却从不读它**)。
  //    症状:排空后 `intent=drain` 而 phase 还在 ready ⇒ 顶层投影仍是 `active`。
  //    后果不只是页面显示错 —— 兼容投影**本来就是给老 readers 用的**,它们按 `status ∈ {active,degraded}`
  //    判可用 ⇒ 对**已排空**的环境 fail-open(真正的准入 `serviceabilityReason` 是对的,但投影在骗人)。
  //    ⇒ 意图一旦不是 serve,顶层 status 绝不能再写 active/testing/initializing 之类"在服务/在上线"的值。
  //    🔴 刻意统一投成 `draining`(而不是按 intent=delete 投 `decommissioning`):`draining` 说的是
  //    "不再承接新工作",**逐字为真**;而 `decommissioning` 暗示"正在销毁",在什么都没销毁时是谎。
  //    真正进入销毁由 phase 转移(§4.6 流程)体现,那时 phase 本身就是 decommissioning。
  if (spec.intent !== "serve" && ["registered", "provisioning", "verifying", "ready"].includes(observed.phase)) {
    return "draining";
  }
  switch (observed.phase) {
    case "registered":
      return observed.lastError ? "failed" : "registered";
    case "provisioning":
      return observed.lastError ? "failed" : "initializing";
    case "verifying":
      return "testing";
    case "ready":
      // 升级中(有在途 operation)→ upgrading
      if (observed.operation) return "upgrading";
      // 🔴 v2 审核(矛盾 C):**只有 health===healthy 才投影 active**;degraded/unknown 都不投 active
      //    (unknown 由 serviceabilityReason fail-closed 拒服务;投影也绝不把 ready+unknown 冒充成 active)。
      return observed.health === "healthy" ? "active" : "degraded";
    case "draining":
      return "draining";
    case "decommissioning":
      return "decommissioning";
    case "gone":
      return "deleted";
  }
}

/** 🔴 `ready` 派生投影 = "曾整包写完过"(phase 到过 ready 之后的阶段)。 */
export function deriveReady(observed: TargetObserved): boolean {
  return observed.phase === "ready" || observed.phase === "draining" || observed.phase === "decommissioning";
}

/**
 * 🔴 **物化投影**:由 post-image 双轴算出要写进 DDB 顶层的兼容字段 `{status, ready, components}`。
 * 单一写入方(transitionPhase)物化,老 readers(admin 路由 `apiOk(target)` / UI `target.status/ready/components`)
 * **零改动**读它。这就是"加法式迁移"的关键:真源是 spec/observed,顶层三字段是它的镜像。
 */
export function materializedProjection(
  spec: TargetSpec,
  observed: TargetObserved
): { status: TargetStatus; ready: boolean; components: string[] } {
  return {
    status: deriveStatusProjection(spec, observed),
    ready: deriveReady(observed),
    components: [...observed.components],
  };
}

/**
 * 🔴 **可服务性判定的正交部分**(intent × phase × operation;**不含新鲜度**)。
 * 新鲜度(stale/未来时钟)留在 registry.unusableReason —— 它持有时间源解析(descriptorAgeMs)且 home 豁免,
 * 本纯函数不碰时钟。返回不可服务的原因串,或 null(这一部分通过)。
 *
 * 🔴 v2 审核收敛后拒绝条件:intent≠serve / phase≠ready / health∉{healthy,degraded}(unknown fail-closed,矛盾 C)/
 *    **任何** observed.operation 在途(§20.2:不只 disruptive —— 损坏数据写 disruptive=false 也拒)。degraded 仍可服务。
 */
export function serviceabilityReason(spec: TargetSpec, observed: TargetObserved): string | null {
  // 拒因开头固定为「该执行环境已停止承接」—— 绑定 / 调度 / 运行三个入口
  //   都经 requireReadyTarget → 本函数,页面原样显示这一句(ED-B1;用户看得懂,不是 intent=drain 这种内部词)。
  if (spec.intent !== "serve") {
    return `该执行环境已停止承接(${spec.intent === "delete" ? "已批准删除,等待 / 正在销毁" : "已排空"};intent=${spec.intent})—— 不承接新绑定、新调度、新运行`;
  }
  if (observed.phase !== "ready") return `阶段不可承接新工作(phase=${observed.phase})`;
  // 🔴 v2 审核(矛盾 C):health **fail-closed**。旧 RUNTIME_USABLE_STATUS 只认 {active,degraded};
  //    对齐语义 = healthy/degraded 可服务、**unknown 不可服务**(绝不让 `ready+unknown` 被当 active 放行)。
  if (observed.health !== "healthy" && observed.health !== "degraded") {
    return `健康状态未知或不可服务(health=${observed.health})—— fail-closed,不承接新工作直到探活确认`;
  }
  // 🔴 v2 审核(§20.2 / 拒绝清单 #13):拒**任何** operation,不只 disruptive —— 损坏数据把 disruptive
  //    写成 false 也不许放行;P0-E 落地前 disruptive 恒 true,语义等价但 fail-closed。
  if (observed.operation !== undefined) {
    return `在途生命周期操作未完成(operation=${observed.operation.kind},不承接新工作直到完成)`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 2a:周期 reconciler 的 health 派生(fail-open 反转禁令的核心)
// ══════════════════════════════════════════════════════════════════════════════

/** 🔴 连续 N 次探活未全绿才降级 health(防单次瞬时失败误杀健康 region;全绿即清 0)。 */
export const HEALTH_DOWNGRADE_STREAK = 2;

/**
 * 🔴🔴 **fail-open 反转禁令的落点**(SPEC §3.5a / DESIGN §20.24):
 * reconciler 每 tick 自动刷新 `probe.at` 后 `fresh(probe)` 恒真;若不据**本次** probe 回写 `observed.health`,
 * 一个探活变红(资源没了)的 region 会永远"新鲜 + active" = 把 fail-closed 反转成 fail-open。故用本次 probe 派生:
 *   - 全绿且**精确覆盖**组件(isGreenProbeForComponents)⇒ `healthy`,streak 清 0;
 *   - 未全绿 ⇒ streak++;仅当 streak ≥ HEALTH_DOWNGRADE_STREAK 才降级(抖动窗口内保持原 health):
 *       · core 探活项全绿 ⇒ `degraded`(核心可服务、某组件降级,仍承接);
 *       · core 探活项有红 ⇒ `unknown`(fail-closed,serviceabilityReason 拒;ROADMAP "down 语义"在本 enum 即 unknown)。
 * 降级窗口 ≤ HEALTH_DOWNGRADE_STREAK × tick 周期,仍远 < 15min stale 阈值 ⇒ 比旧"等 stale"更快 fail-closed。
 * 🔴 纯函数(无 IO):便于确定性单测穷举 green/streak/core-red 三维。
 */
export function deriveHealthFromProbe(
  observed: TargetObserved,
  probe: ProbeResult
): { health: TargetHealth; unhealthyStreak: number } {
  const green = probe.ok && isGreenProbeForComponents(observed.components, probe.items);
  if (green) return { health: "healthy", unhealthyStreak: 0 };
  const streak = (observed.unhealthyStreak ?? 0) + 1;
  if (streak < HEALTH_DOWNGRADE_STREAK) {
    // 抖动窗口内:还没到降级阈值 ⇒ 保持原 health,只累加 streak(单次瞬时失败不误杀)。
    return { health: observed.health, unhealthyStreak: streak };
  }
  const coreGreen = probe.items
    .filter((it) => componentForProbeItem(it.name) === "core")
    .every((it) => it.ok === true);
  return { health: coreGreen ? "degraded" : "unknown", unhealthyStreak: streak };
}

// ══════════════════════════════════════════════════════════════════════════════
// 收养存量(控制器把缺 spec/observed 的 legacy item 推断成双轴 —— 不是 hack,是控制器"观测现实"的本职)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 存量 item(有 legacy `status`/`ready`/`components`/`probe`、无 `spec`/`observed`)→ 推断双轴。
 *
 * 自愈的关键判据(直接修复真环境 `tgt_usw2_a` 的 `initializing∧ready=true∧probe绿` 卡死形态):
 *   **`ready===true` ∧(home 豁免 probe / 非 home 则 probe.ok===true)∧ status∉退役态 ⇒ phase=ready**
 *   —— `ready=true` 证明曾整包写完过、`probe.ok` 证明资源真在,那就是 ready,不管卡住的 status 标签。
 * 这不是放宽 enable 前置(enable 走 transitionPhase 的正常边);这是控制器如实"观测"一个既存现实。
 */
export function adoptLegacy(t: ExecutionTarget): { spec: TargetSpec; observed: TargetObserved } {
  const status = t.status;
  const components = Array.isArray(t.components) && t.components.length ? [...t.components] : ["core"];
  const probe = t.probe as ProbeResult | undefined;
  const retiring = status === "draining" || status === "decommissioning" || status === "deleted";
  const servingStatus = status === "active" || status === "degraded";
  // 🔴 v2 审核(拒绝清单 #12 / 报告 §20 line 2773):**保守收养,绝不据 stored `probe.ok` 把卡死项推成 ready**。
  //    只有【曾真正服务(status=active/degraded)∧ ready===true ∧ 非退役】才收养成 ready ——
  //    这类是 home 那种真在服务的存量,信其继续可服务。
  //    而 `initializing/upgrading` 卡死的存量(bug#11 真环境 tgt_usw2_a):**不**在这里自愈成 ready
  //    (旧实现据 stored probe 推 ready = fail-open,被拒绝清单 #12 明令禁止);它落非服务态(fallback
  //    provisioning + health=unknown),由 **probe route 本次 fresh green** 经 `adoptLegacyAfterFreshProbe`
  //    (Steps 3-4 交付,携 LegacyCompletionFence)物化成 ready ——"只凭本次探活自愈"。
  //    刻意**不**自愈 `testing`:它是"待人工启用",自愈成 ready = 跳过 enable(§20.23 明确不许)。
  const provenReady = t.ready === true && servingStatus && !retiring;
  const phase: TargetPhase = provenReady ? "ready" : legacyFallbackPhase(status);

  const intent: TargetIntent = status === "deleted" || status === "decommissioning" ? "delete" : status === "draining" ? "drain" : "serve";
  // 🔴🔴 2a fail-open 反转禁令(**legacy 侧**,re-audit 揪出):周期 reconciler 会对 legacy target 也无条件
  //    刷新顶层 `probe.at`(writeProbeResult),废掉了"红探活 15min 后 stale 掉线"这条唯一安全网。若这里仍从 status
  //    派生 healthy 而无视 stored `probe.ok`,红探活(资源死了)的 legacy active 目标会"新鲜 + healthy"永远被准入 = fail-open。
  //    ⇒ **据 stored `probe.ok` DEMOTE**:红探活 ⇒ health=unknown(fail-closed,serviceabilityReason 拒)。
  // 🔴 只降级、不提升:拒绝清单 #12 只禁"据 stored probe.ok **推成 ready**",**降级不在禁列**(demote 只会更保守);
  //    phase 仍按 status/ready 派生(不碰 #12),自愈仍只走 adoptLegacyAfterFreshProbe 的本次 fresh green。
  // 🔴 **仅非 home**:与 stale 豁免同口径(unusableReason 的新鲜度分支也 `if (!isHome)`)——home 的可服务性语义
  //    (始终可服务、无"探活失联"失败模式)是**既有行为、本批不改**;reconciler 引入的 fail-open 回归只发生在
  //    非 home legacy(agent 复现用的就是 tgt_usw2_a)。home 是 legacy 时红探活仍 healthy,避免"全平台 fail-closed"。
  const probeRed = t.targetId !== "tgt_home" && probe?.ok === false;
  const health: TargetHealth =
    phase !== "ready" ? "unknown" : probeRed ? "unknown" : status === "degraded" ? "degraded" : "healthy";
  const lastError = status === "failed" ? "(legacy: status=failed;收养时无原文)" : undefined;

  return {
    spec: { intent, desiredComponents: components },
    observed: {
      phase,
      health,
      components,
      ...(probe ? { probe } : {}),
      ...(lastError ? { lastError } : {}),
    },
  };
}

/**
 * 🔴 **只凭本次 fresh green probe 收养存量**(初装 legacy 完成路;§21.4)——与保守的 `adoptLegacy` 的区别
 *    `adoptLegacy` 绝不据 stored probe 推 ready(拒绝清单 #12);本函数由 **probe route 本次真探全绿** 授权,
 *    经 `reconcileAfterProbe` 携 `LegacyCompletionFence` 一次条件写物化。三种 mode:
 *      · `stable`  = 曾真服务(active/degraded)且 ready ⇒ phase=ready(继续服务);
 *      · `e99`     = initializing/upgrading 卡死但 ready(bug#11 真环境 `tgt_usw2_a` 形态)⇒ phase=ready(自愈);
 *      · `initial` = 初装 !ready ⇒ phase=verifying(等人工 enable,与 modern 初装同口径,**不跳过 enable**)。
 *    health 一律 healthy(本次探活精确全绿是调用前置);operation 恒无(legacy 无双轴)。
 *    真实 phase 采纳由 reconcileAfterProbe 的 `to` 映射(ready→ready 自转 / verifying→verifying 自转,均携 fence)。
 */
export function adoptLegacyAfterFreshProbe(
  t: ExecutionTarget,
  probe: ProbeResult,
  mode: LegacyProbeMode
): { spec: TargetSpec; observed: TargetObserved } {
  // 🔴 落库前过**规范序**(orderComponents):不然收养出来的 `spec.desiredComponents` 是 legacy 原始序、
  //    而 `observed.components` 是规范序 ⇒ 同一个集合在库里长得不一样(页面"想要 vs 实际"看着像不一致)。
  //    判定侧已按集合比(sameComponentSet),这里只是让**持久化数据**也规范,减少后来人被误导。
  const components = orderComponents(
    Array.isArray(t.components) && t.components.length ? [...t.components] : ["core"]
  );
  const phase: TargetPhase = mode === "initial" ? "verifying" : "ready";
  return {
    spec: { intent: "serve", desiredComponents: components },
    observed: { phase, health: "healthy", components, probe },
  };
}

/**
 * legacy status → phase 的【未 provenReady 兜底】映射(provenReady 的情形在 adoptLegacy 里已置 ready)。
 * 🔴 `active`/`degraded` 落到这里 = `ready!==true` 的矛盾存量 ⇒ 视为 `provisioning`(未整包写完),fail-closed。
 */
function legacyFallbackPhase(status: TargetStatus): TargetPhase {
  switch (status) {
    case "registered":
      return "registered";
    case "testing":
      return "verifying";
    case "draining":
      return "draining";
    case "decommissioning":
      return "decommissioning";
    case "deleted":
      return "gone";
    // initializing / upgrading / failed / active / degraded(未 provenReady)一律 provisioning(未就绪)
    default:
      return "provisioning";
  }
}

/** 描述符分类结果(v2 审核矛盾 D:严格区分 legacy/modern/invalid,**不把半写 modern 当 legacy 猜**)。 */
export type DescriptorClass =
  | { kind: "legacy"; spec: TargetSpec; observed: TargetObserved }
  | { kind: "modern"; spec: TargetSpec; observed: TargetObserved }
  | { kind: "invalid"; reason: string };

/** modern item 的 runtime schema 校验:字段非法即返回原因(否则 null)。 */
function modernSchemaViolation(spec: TargetSpec, observed: TargetObserved): string | null {
  if (!spec || typeof spec !== "object") return "spec 不是对象";
  if (!(TARGET_INTENTS as readonly string[]).includes(spec.intent)) return `spec.intent 非法:${String(spec.intent)}`;
  if (!Array.isArray(spec.desiredComponents) || !spec.desiredComponents.includes("core")) {
    return "spec.desiredComponents 须为含 core 的数组";
  }
  if (!observed || typeof observed !== "object") return "observed 不是对象";
  if (!(TARGET_PHASES as readonly string[]).includes(observed.phase)) return `observed.phase 非法:${String(observed.phase)}`;
  if (!(TARGET_HEALTHS as readonly string[]).includes(observed.health)) return `observed.health 非法:${String(observed.health)}`;
  if (!Array.isArray(observed.components) || !observed.components.includes("core")) {
    return "observed.components 须为含 core 的数组";
  }
  return null;
}

/**
 * 🔴 **三分类**(v2 审核矛盾 D):
 *   - `legacy`  = `spec` 与 `observed` **都不存在** ⇒ 按 legacy 字段收养(`adoptLegacy`);
 *   - `modern`  = 两者都存在且 runtime schema 合法 ⇒ 现代状态机;
 *   - `invalid` = **只存在一侧**(半写)/ 字段非法 ⇒ **fail-closed**,绝不按 legacy 猜
 *     (旧实现只要拿不齐就回落 adoptLegacy,会把"只写了一半的新 item"误当 legacy)。
 */
export function classifyDescriptor(t: ExecutionTarget): DescriptorClass {
  const hasSpec = t.spec !== undefined && t.spec !== null;
  const hasObs = t.observed !== undefined && t.observed !== null;
  if (!hasSpec && !hasObs) {
    const { spec, observed } = adoptLegacy(t);
    return { kind: "legacy", spec, observed };
  }
  if (hasSpec !== hasObs) {
    return {
      kind: "invalid",
      reason: `spec/observed 只存在一侧(spec=${hasSpec} observed=${hasObs})—— 半写形态,fail-closed 不按 legacy 猜`,
    };
  }
  const spec = t.spec as TargetSpec;
  const observed = t.observed as TargetObserved;
  const v = modernSchemaViolation(spec, observed);
  if (v) return { kind: "invalid", reason: `modern 描述符 schema 非法:${v}` };
  return { kind: "modern", spec, observed };
}

/** 描述符形态非法(半写/字段坏);写入方 catch 或直接冒泡 = fail-closed。 */
export class DescriptorInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DescriptorInvalidError";
  }
}

/**
 * 取双轴:legacy/modern 返回 `{spec, observed}`;**invalid 抛 `DescriptorInvalidError`**(写入方 fail-closed)。
 * 🔴 只读准入方(`unusableReason`)应改用 `classifyDescriptor`,把 invalid 当"不可用"返回原因,而**不是**抛。
 */
export function specObservedOf(t: ExecutionTarget): { spec: TargetSpec; observed: TargetObserved } {
  const c = classifyDescriptor(t);
  if (c.kind === "invalid") throw new DescriptorInvalidError(c.reason);
  return { spec: c.spec, observed: c.observed };
}

// ══════════════════════════════════════════════════════════════════════════════
// 单一写通道 —— 全仓唯一写 observed / spec 的地方
// ══════════════════════════════════════════════════════════════════════════════

/** 前置不满足(转移非法 / 乐观锁 / 前态不符)。调用方映射 409。 */
export class PhaseTransitionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PhaseTransitionError";
  }
}

/**
 * transitionPhase 的额外条件绑定(读到写之间由 DDB 拒,防 TOCTOU)。path 支持嵌套如 `probe.ok`。
 * 🔴 判别联合(v2 审核 §20.3):`equals` 绑值 / `absent` 绑属性缺失 —— 后者用于 legacy `ready` 缺属性,
 *    绝不向 DynamoDB 传 `equals: undefined`(会被拒或误判为存在)。
 */
export type TransitionGuard =
  | { path: string; equals: unknown }
  | { path: string; absent: true };

// ══════════════════════════════════════════════════════════════════════════════
// 完成态 fence 的校验 + 提交后 exact post-image 强读(§20)—— transitionPhase 私有
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 校验一次「精确全绿」证据:probe canonical + ok===true + probe.at===probeAt + desired===observed +
 *    probeInput.components===observed + probe 项**精确覆盖**组件(isGreenProbeForComponents)。任一不满足即抛。
 */
function validateExactGreenLifecycleEvidence(
  evidence: ExactGreenLifecycleEvidence,
  label: string
): { probe: ProbeResult; desired: string[]; observed: string[]; probeInput: ProbeInputSnapshot } {
  const parsedProbe = ProbeResultSchema.safeParse(evidence.probe);
  const parsedDesired = DesiredComponentsSchema.safeParse(evidence.desiredComponents);
  const parsedObserved = ObservedComponentsSchema.safeParse(evidence.observedComponents);
  const parsedProbeInput = ProbeInputSnapshotSchema.safeParse(evidence.probeInput);
  if (
    !isStrictIsoInstant(evidence.probeAt) ||
    !parsedProbe.success ||
    parsedProbe.data.ok !== true ||
    parsedProbe.data.at !== evidence.probeAt ||
    !parsedDesired.success ||
    !parsedObserved.success ||
    !parsedProbeInput.success ||
    // 🔴 组件清单按**集合**比(`sameComponentSet`),不按字节比 —— 详见 component-contract.ts 里
    //    `componentSetKey` 的根因说明:原来的 `JSON.stringify` 相等让 home 的真实清单
    //    (`core,redshift,mwaa,dms,flink,agentcore` vs 规范序)永不相等 ⇒ 探活必炸、收养写不进 observed;
    //    modern 路径同族(broker 存客户端次序)⇒ 部署完成永久失败。集合不同**照样判不等**。
    !sameComponentSet(parsedDesired.data, parsedObserved.data) ||
    !sameComponentSet(parsedProbeInput.data.components, parsedObserved.data) ||
    !isGreenProbeForComponents(parsedProbeInput.data.components, parsedProbe.data.items)
  ) {
    throw new PhaseTransitionError(
      `${label} 的 probe/desired/observed/input 非法或未精确覆盖组件` +
        `(desired=${componentSetKey(parsedDesired.success ? parsedDesired.data : [])}` +
        ` observed=${componentSetKey(parsedObserved.success ? parsedObserved.data : [])}` +
        ` input=${componentSetKey(parsedProbeInput.success ? parsedProbeInput.data.components : [])}` +
        ` probeOk=${String(parsedProbe.success ? parsedProbe.data.ok : "parse-fail")})`
    );
  }
  return {
    probe: parsedProbe.data,
    desired: parsedDesired.data,
    observed: parsedObserved.data,
    // 显式补齐所有键(zod `.optional()` 让 resources/agentcore 键可缺;ProbeInputSnapshot 要求键在、值可 undefined)。
    probeInput: {
      region: parsedProbeInput.data.region,
      accountId: parsedProbeInput.data.accountId,
      partition: parsedProbeInput.data.partition,
      components: parsedProbeInput.data.components,
      resources: parsedProbeInput.data.resources,
      agentcore: parsedProbeInput.data.agentcore,
    },
  };
}

/**
 * 稳定序列化(递归键排序)—— **全仓比较"结构相同吗"的唯一口径**。
 *
 * 🔴 【2026-09-03 真环境 P0,记在这儿别再犯】DynamoDB 的 Map 属性**不保证键序**:对象写进去再读回来,
 * 键序可能与内存里的不同 ⇒ "内存对象 vs DDB 往返对象"用裸 `JSON.stringify` 比 **必不相等**。
 * `enableTarget` 的 fence 最后一项当时正是裸 stringify(`fence.probe` 是 `runProbe()` 内存对象,
 * `current.probe` 是 DDB 读回来的)⇒ **页面点「启用」每次必 409**、永久自锁,且拒因文案完全不指向真原因。
 * 讽刺的是本文件早就有这个函数(注释写着"避免属性顺序造成的假 mismatch"),偏偏那一处没用它。
 *
 * ⇒ **规则**:跨来源(内存 ↔ DDB)比较一律走本函数;裸 `JSON.stringify` 只许用于**同源**比较。
 * 🔴 已导出:registry.ts 的 `reconcileCanonicalJson` 委托到这里(消掉第二份逐字相同的实现)。
 */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value)) ?? "__undefined__";
}

/**
 * 🔴 4:**`spec.intent` 的唯一写入方**(SPEC §1.1 双轴模型:spec 由人/API 写,observed 只由控制器写)。
 *
 * 【它买到什么】排空(drain)= "这个 target 不再承接**新**工作,在途的让它跑完"。准入判定读
 * `serviceabilityReason(spec, observed)`,`intent ≠ serve` **立刻**判不可用 ⇒ 不必等 reconciler 改 phase,
 * 停接新活是**同步生效**的。phase 由 reconciler 随后驱动到 `draining`(那是观测态,归控制器)。
 *
 * 🔴 **只允许 `serve ⟷ drain`**:`delete` 会把 phase 推向 `decommissioning/gone`,而**真正销毁栈**
 * (影响预览 → 输名强确认 → 审批 → 销毁,数据桶 RETAIN)是 §4.6 的流程。这一批要是放开 `delete`,
 * 就会把 target 标成"已退役"而**资源还都在** —— 那是比不做更糟的谎(tombstone 骗人)。
 *
 * 🔴 **在途部署会话期间一律拒**:完成栅栏的后像校验断言 `post.spec.intent === "serve"`
 * (见 completionFence 分支)⇒ 部署途中把 intent 改成 drain,那次部署就**永远完不成**、
 * 变成需要 2b 人工恢复的滞留会话。这是两条机制互咬,必须在入口挡住而不是事后补救。
 *
 * @returns `{written:true}`;前置不满足抛 `PhaseTransitionError`(调用方映射 409)。
 */
export async function setSpecIntent(
  targetId: string,
  intent: TargetIntent,
  opts: { expectedVersion: number }
): Promise<{ written: true; phaseHint: TargetPhase }> {
  assertTargetId(targetId);
  if (intent !== "serve" && intent !== "drain") {
    throw new PhaseTransitionError(
      `intent 只允许 serve / drain(收到 ${String(intent)})—— delete 必须走 §4.6 删除流程` +
        `(影响预览 → 输名强确认 → 审批 → 销毁;数据桶 RETAIN),不能只改标记`
    );
  }
  const current = await getLifecycleRaw(targetId);
  if (!current) throw new PhaseTransitionError(`执行目标不存在:${targetId}`);
  if (current.version !== opts.expectedVersion) {
    throw new PhaseTransitionError(
      `版本已变(读到 ${String(current.version)} ≠ 期望 ${opts.expectedVersion})—— 有并发操作,请刷新重试`
    );
  }
  const cls = classifyDescriptor(current);
  if (cls.kind === "invalid") throw new PhaseTransitionError(`描述符形态非法(fail-closed):${cls.reason}`);
  const { spec, observed } = cls;
  // 🔴 删除一经批准(intent=delete)就是单向门:不许借「恢复承接」把一个
  //   正在 / 即将销毁的环境放回服务(审批人批的是「删掉它」,不是「排空一会儿」)。要留着它 = 驳回审批,而不是改意图。
  if (spec.intent === "delete") {
    throw new PhaseTransitionError("该执行环境的删除已经批准(intent=delete)—— 不能再改回承接 / 排空;销毁卡住请在详情页「重试销毁」");
  }
  if (observed.operation) {
    throw new PhaseTransitionError(
      `该 target 有在途部署会话(${observed.operation.operationId})—— 部署途中改 intent 会让完成栅栏永远合不上` +
        `(那次部署将滞留成需人工恢复的会话)。等它收口后再排空`
    );
  }
  if (spec.intent === intent) {
    // 幂等:已经是目标意图 ⇒ 不写,但也不报错(重复点按钮不该报红)。
    return { written: true, phaseHint: observed.phase };
  }

  const postSpec: TargetSpec = { ...spec, intent };
  const proj = materializedProjection(postSpec, observed);
  const names: Record<string, string> = {
    "#sp": "spec",
    "#o": "observed",
    "#op": "operation",
    "#st": "status",
    "#r": "ready",
    "#c": "components",
    "#v": "version",
  };
  const values: Record<string, unknown> = {
    ":spec": postSpec,
    ":status": proj.status,
    ":ready": proj.ready,
    ":components": proj.components,
    ":expected": opts.expectedVersion,
    ":next": opts.expectedVersion + 1,
    ":t": new Date().toISOString(),
  };
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        // 🔴 spec 与投影**同一次**写(否则会出现"意图已改、status 还说 active"的中间态);
        //    version **要涨**(它是管理面操作,和 telemetry 那种高频观测写不同,必须与其它管理操作互斥)。
        UpdateExpression: "SET #sp = :spec, #st = :status, #r = :ready, #c = :components, #v = :next, updatedAt = :t",
        ConditionExpression: [
          "attribute_exists(sk)",
          "attribute_exists(#o)",
          "#v = :expected",
          // 🔴 条件里再挡一次在途会话:上面的内存检查与这次写之间仍有 TOCTOU 窗口
          "attribute_not_exists(#o.#op)",
        ].join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new PhaseTransitionError(
        "写入被条件拒绝:期间出现了并发操作(版本变化 / 在途部署会话出现)—— 请刷新后重试"
      );
    }
    throw error;
  }
  return { written: true, phaseHint: observed.phase };
}

// (K-5 网络规模)
// `setNetworkProfile` **已删除** —— 执行环境零出网,NAT 恒为 0,
// 没有可调的档;对应路由 POST .../network-profile 已改回 410(SPEC §3.16-E)。

/**
 * 顶层 `schedulerPreference` 的**唯一**写入方(INTERACTION §2.2b「调度器偏好」;SPEC §3.15)。
 * 只改**之后**发布走哪个调度器(已发布产物保持原调度器直到重新发布);不碰 spec / observed / status / ready / components 投影。
 * 条件写:version = :expected ∧ attribute_not_exists(observed.operation) ∧ attribute_not_exists(deployLockOperationId)
 * (与 setNetworkProfile 同一机制互咬理由:部署途中改偏好会让本次发布与期望不一致)。home 也允许(home 两者都装时同样要选)。
 */
export async function setSchedulerPreference(
  targetId: string,
  preference: SchedulerPreference,
  opts: { expectedVersion: number }
): Promise<{ written: true; changed: boolean }> {
  assertTargetId(targetId);
  if (!isSchedulerPreference(preference)) {
    throw new PhaseTransitionError(`schedulerPreference 只允许 ${SCHEDULER_PREFERENCES.join(" / ")}(收到 ${String(preference)})`);
  }
  // 🔴🔴 写侧值域(见 scheduler-preference.ts 那段):经典 MWAA 已整体下线 ⇒ **写不进**。
  //   校验放在这个**唯一写通道**里而不是只放路由上:新调用方自动被管住。
  if (!isWritableSchedulerPreference(preference)) {
    throw new PhaseTransitionError(retiredSchedulerPreferenceMessage(String(preference)));
  }
  const current = await getLifecycleRaw(targetId);
  if (!current) throw new PhaseTransitionError(`执行目标不存在:${targetId}`);
  if (current.version !== opts.expectedVersion) {
    throw new PhaseTransitionError(`版本已变(读到 ${String(current.version)} ≠ 期望 ${opts.expectedVersion})—— 有并发操作,请刷新重试`);
  }
  const op = (current as { observed?: { operation?: { operationId?: string } } }).observed?.operation;
  if (op || current.deployLockOperationId !== undefined) {
    throw new PhaseTransitionError(`该 target 有在途部署会话(${op?.operationId ?? current.deployLockOperationId ?? "?"})—— 等它收口后再改调度器偏好`);
  }
  if (((current as { schedulerPreference?: string }).schedulerPreference ?? "serverless") === preference) {
    return { written: true, changed: false };
  }
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: "SET #sp = :sp, #v = :next, updatedAt = :t",
        ConditionExpression: ["attribute_exists(sk)", "#v = :expected", "attribute_not_exists(#o.#op)", "attribute_not_exists(#lock)"].join(" AND "),
        ExpressionAttributeNames: { "#sp": "schedulerPreference", "#v": "version", "#o": "observed", "#op": "operation", "#lock": "deployLockOperationId" },
        ExpressionAttributeValues: { ":sp": preference, ":expected": opts.expectedVersion, ":next": opts.expectedVersion + 1, ":t": new Date().toISOString() },
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new PhaseTransitionError("写入被条件拒绝:期间出现了并发操作(版本变化 / 在途部署会话出现)—— 请刷新后重试");
    }
    throw error;
  }
  return { written: true, changed: true };
}

async function getLifecycleRaw(targetId: string): Promise<ExecutionTarget | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      ConsistentRead: true,
    })
  );
  return Item as ExecutionTarget | undefined;
}

type TransitionPostcondition = "match" | "mismatch" | "read-error";

/**
 * transition send 失败后的 **exact post-image 强读判定**:SDK 内部重试可能先已提交、随后因 version
 * fence 收到 ConditionalCheckFailed。`match` = 幂等成功(不得再写);`mismatch` = 确认没提交;
 * `read-error` = 连 strong-read 都失败 ⇒ 结果未知。
 */
async function transitionPostcondition(
  targetId: string,
  opts: {
    expectedVersion: number;
    post: { spec: TargetSpec; observed: TargetObserved };
    completionFence?: DeploymentCompletionFence;
    legacyCompletionFence?: LegacyCompletionFence;
    enableFence?: EnableLifecycleFence;
  },
  projection: { status: TargetStatus; ready: boolean; components: string[] }
): Promise<TransitionPostcondition> {
  let current: ExecutionTarget | undefined;
  try {
    current = await getLifecycleRaw(targetId);
  } catch {
    return "read-error";
  }
  const baseMatches = Boolean(
    current &&
      current.version === opts.expectedVersion + 1 &&
      canonicalJson(current.spec) === canonicalJson(opts.post.spec) &&
      canonicalJson(current.observed) === canonicalJson(opts.post.observed) &&
      current.status === projection.status &&
      current.ready === projection.ready &&
      canonicalJson(current.components) === canonicalJson(projection.components)
  );
  if (!baseMatches || !current) return "mismatch";

  const evidence = opts.completionFence ?? opts.legacyCompletionFence ?? opts.enableFence;
  if (!evidence) return "match"; // ordinary transition 的 exact post-image。
  const probeInput = evidence.probeInput;
  const commonMatches =
    current.region === probeInput.region &&
    current.accountId === probeInput.accountId &&
    current.partition === probeInput.partition &&
    canonicalJson(current.resources) === canonicalJson(probeInput.resources) &&
    canonicalJson(current.agentcore) === canonicalJson(probeInput.agentcore) &&
    canonicalJson(current.components) === canonicalJson(probeInput.components) &&
    canonicalJson(current.probe) === canonicalJson(evidence.probe) &&
    current.deployLockToken === undefined &&
    current.deployLockExpiresAt === undefined &&
    current.deployLockOperationId === undefined;
  if (!commonMatches) return "mismatch";

  if (opts.completionFence) {
    return current.lockEpoch === opts.completionFence.lockEpoch &&
      current.lastOperationId === opts.completionFence.operationId &&
      current.lastBuildId === opts.completionFence.buildId
      ? "match"
      : "mismatch";
  }
  if (opts.enableFence) return "match";
  const legacy = opts.legacyCompletionFence;
  if (!legacy) return "mismatch";
  if (legacy.mode !== "stable") {
    return current.lockEpoch === legacy.session.lockEpoch &&
      current.lastOperationId === legacy.session.operationId &&
      current.lastBuildId === legacy.session.buildId
      ? "match"
      : "mismatch";
  }
  return "match"; // stable legacy 要求无 residual lock,已由 commonMatches 证明。
}

/**
 * 🔴 **唯一**驱动 `observed.phase` / `spec` 的写通道 —— 全仓其它地方一律不许写 `observed.phase`/`spec`/
 *    `status`/`ready`(AST 门禁钉:lifecycle.ts 之外为 0)。
 *
 * 调用方给出**完整的 post-image**(`post.spec` + `post.observed`),本函数在**同一次条件写**里:
 *   ① 写权威双轴 `observed = post.observed`、`spec = post.spec`;
 *   ② **物化**顶层兼容投影 `status`/`ready`/`components`(= materializedProjection,老 readers 读它);
 *   ③ `version` 单调 +1(乐观锁)、`updatedAt`。
 *
 * 条件:`version = expected` ∧(正常:`observed.phase = from`;首写收养 `ifAbsent`:`attribute_not_exists(observed)`)
 *        ∧ 逐条 guards。转移合法性(from→post.observed.phase)先由 PHASE_EDGES 校验,非法**在任何 DDB 调用之前**抛。
 *
 * @param opts.from     当前(pre-image)phase,用作 TOCTOU 前态守卫;`ifAbsent` 时仅用于转移合法性校验
 * @param opts.ifAbsent 首写收养:该 item 尚无 `observed`(存量 legacy)⇒ 条件改 `attribute_not_exists(observed)`
 * @param opts.post     完整 post-image(spec + observed);observed.phase 即目标 phase
 * @param opts.guards   额外前置条件(基于 pre-image,如 `{path:"probe.ok", equals:true}`)
 */
export async function transitionPhase(
  targetId: string,
  opts: {
    from: TargetPhase;
    ifAbsent?: boolean;
    post: { spec: TargetSpec; observed: TargetObserved };
    expectedVersion: number;
    guards?: TransitionGuard[];
    /** modern 完成 deploy(provisioning→verifying / ready→ready 自转)。清 operation + 顶层锁。 */
    completionFence?: DeploymentCompletionFence;
    /** legacy 首写收养(ifAbsent 必成对)。stable 无 session;e99/initial 携 session tuple 并清锁。 */
    legacyCompletionFence?: LegacyCompletionFence;
    /** 人工 enable(verifying→ready)本次 fresh probe fence。 */
    enableFence?: EnableLifecycleFence;
    /** 弃置(registered|provisioning→gone)fence;与那两条边成对 */
    discardFence?: DiscardFence;
    reason: string;
  }
): Promise<void> {
  assertTargetId(targetId);
  if (typeof opts.expectedVersion !== "number" || !Number.isInteger(opts.expectedVersion)) {
    throw new PhaseTransitionError(`expectedVersion 须为整数(收到 ${String(opts.expectedVersion)})`);
  }

  // ── 🔴 受限自转 gate(§20.3):不全局放开 self-transition,只许"完成 deploy"/"legacy 首写收养"/"enable" ──
  //    当前 PHASE_EDGES.ready 不含 ready、verifying 不含 verifying;若原封 isValidPhaseTransition 会拒完成写。
  const to = opts.post.observed.phase;
  const isSelf = opts.from === to;
  const isProtectedSelf = isSelf && (to === "ready" || to === "verifying");
  const hasExactLegacyFence = opts.ifAbsent === true && opts.legacyCompletionFence !== undefined;
  const allowedProtectedSelf =
    isProtectedSelf && (hasExactLegacyFence || (to === "ready" && opts.completionFence !== undefined));
  const isEnableTransition = opts.from === "verifying" && to === "ready";

  if ((opts.ifAbsent === true) !== (opts.legacyCompletionFence !== undefined)) {
    throw new PhaseTransitionError("ifAbsent legacy adoption 与 LegacyCompletionFence 必须成对出现");
  }
  if (isEnableTransition !== (opts.enableFence !== undefined)) {
    throw new PhaseTransitionError("verifying→ready 只能由 fresh EnableLifecycleFence 授权,且 fence 不得用于其它边");
  }
  // 弃置边 ⇔ DiscardFence 成对(同 enable 手法)
  const isDiscardTransition = (opts.from === "registered" || opts.from === "provisioning") && to === "gone";
  if (isDiscardTransition !== (opts.discardFence !== undefined)) {
    throw new PhaseTransitionError("registered|provisioning→gone 只能由 DiscardFence(弃置)授权,且 fence 不得用于其它边");
  }
  // 进入销毁 / 销毁收口都不走这里:前者归 broker(destroy 开会话),
  //   后者归 `settleDestroy`(带 destroy 会话 fence + 真查 AWS 的时刻)。
  if (to === "decommissioning" || (opts.from === "decommissioning" && to === "gone")) {
    throw new PhaseTransitionError(
      `${opts.from}→${to} 不经 transitionPhase:进入销毁只能由 broker 的 destroy 开会话完成,销毁收口只能经 settleDestroy(带会话 fence 与 AWS 真值)`
    );
  }
  if ((isProtectedSelf && !allowedProtectedSelf) || (!isSelf && !isValidPhaseTransition(opts.from, to))) {
    throw new PhaseTransitionError(
      `非法状态转移 ${opts.from}→${to}(不是受限 completion/adoption/enable commit;PHASE_EDGES 合法后继:${(PHASE_EDGES[opts.from] ?? []).join("/") || "无(终态)"})`
    );
  }

  const proj = materializedProjection(opts.post.spec, opts.post.observed);
  // 🔴 v2 审核(§20.3):names/values/conds **按分支构造** —— DynamoDB 拒绝未被表达式使用的
  //    ExpressionAttributeNames/Values。ifAbsent 首写收养时**不得**再传 `#ph`/`:from`(它们只在前态守卫里用),
  //    否则真环境抛 ValidationException(unit mock 测不出;收养存量那条路必炸)。
  const names: Record<string, string> = {
    "#o": "observed",
    "#sp": "spec",
    "#st": "status",
    "#r": "ready",
    "#c": "components",
    "#v": "version",
  };
  const values: Record<string, unknown> = {
    ":obs": opts.post.observed,
    ":spec": opts.post.spec,
    ":status": proj.status,
    ":ready": proj.ready,
    ":components": proj.components,
    ":expected": opts.expectedVersion,
    ":next": opts.expectedVersion + 1,
    ":t": new Date().toISOString(),
  };

  // 条件:版本 +(首写收养 attribute_not_exists(observed,spec) / 或前态 phase)+ 逐条 guard
  const conds = ["attribute_exists(sk)", "#v = :expected"];
  if (opts.ifAbsent) {
    conds.push("attribute_not_exists(#o)", "attribute_not_exists(#sp)");
  } else {
    names["#ph"] = "phase";
    values[":from"] = opts.from;
    conds.push("#o.#ph = :from");
  }
  // guards:判别联合 {path,equals}|{path,absent} —— 按分支构造,绝不向 DynamoDB 传 undefined
  //   (v2 审核 §20.3:legacy `ready` 属性缺失只能用 absent 表达,不能塞 equals:undefined);
  //   alias 用**部件下标** `#g<g>_<i>`(非属性名),避免属性名含非法字符时生成坏 alias。
  let g = 0;
  for (const guard of opts.guards ?? []) {
    const parts = guard.path.split(".");
    if (!guard.path || parts.some((p) => !p)) {
      throw new PhaseTransitionError(`guard path 非法:${JSON.stringify(guard.path)}`);
    }
    const namePath = parts
      .map((p, i) => {
        const gn = `#g${g}_${i}`;
        names[gn] = p;
        return gn;
      })
      .join(".");
    if ("absent" in guard) {
      conds.push(`attribute_not_exists(${namePath})`);
    } else {
      if (guard.equals === undefined) {
        throw new PhaseTransitionError(`guard ${guard.path} 的 equals 不得为 undefined;属性缺失请用 absent:true`);
      }
      const gv = `:g${g}`;
      values[gv] = guard.equals;
      conds.push(`${namePath} = ${gv}`);
    }
    g++;
  }

  // ══ 完成态 fence 构造(§20)——追加 names/values/conds,生成 removeClause(清顶层 deploy 锁) ══
  let removeClause = "";
  const fence = opts.completionFence;
  if (fence) {
    const legalCompletionShape =
      (opts.from === "provisioning" && to === "verifying") || (opts.from === "ready" && to === "ready");
    if (
      !legalCompletionShape ||
      opts.post.spec.intent !== "serve" ||
      opts.post.observed.health !== "healthy" ||
      JSON.stringify(opts.post.spec.desiredComponents) !== JSON.stringify(fence.desiredComponents) ||
      JSON.stringify(opts.post.observed.components) !== JSON.stringify(fence.observedComponents) ||
      JSON.stringify(opts.post.observed.probe) !== JSON.stringify(fence.probe)
    ) {
      throw new PhaseTransitionError(
        "completionFence 只允许 provisioning→verifying/ready→ready 且 post-image 必须匹配 fence"
      );
    }
    if (opts.post.observed.operation) {
      throw new PhaseTransitionError("完成部署的 post-image 必须清除 observed.operation");
    }
    validateExactGreenLifecycleEvidence(fence, "completionFence");
    if (
      !Number.isInteger(fence.lockEpoch) ||
      fence.lockEpoch < 1 ||
      !/^[a-f0-9]{64}$/.test(fence.openSnapshotHash) ||
      !fence.operationId ||
      !fence.buildId ||
      !isStrictIsoInstant(fence.startedAt)
    ) {
      throw new PhaseTransitionError("completionFence 的 operation tuple 非法");
    }

    Object.assign(names, {
      "#operation": "operation",
      "#operationKind": "kind",
      "#operationId": "operationId",
      "#operationEpoch": "lockEpoch",
      "#operationOpenSnapshotHash": "openSnapshotHash",
      "#buildId": "buildId",
      "#operationStartedAt": "startedAt",
      "#operationDisruptive": "disruptive",
      "#intent": "intent",
      "#observedComponents": "components",
      "#topLockEpoch": "lockEpoch",
      "#deployLockToken": "deployLockToken",
      "#deployLockOperationId": "deployLockOperationId",
      "#topLastOperationId": "lastOperationId",
      "#topLastBuildId": "lastBuildId",
      "#probe": "probe",
      "#probeAt": "at",
      "#probeOk": "ok",
      "#desiredComponents": "desiredComponents",
      "#fenceRegion": "region",
      "#fenceAccountId": "accountId",
      "#fencePartition": "partition",
      "#fenceResources": "resources",
      "#fenceAgentcore": "agentcore",
    });
    Object.assign(values, {
      ":fenceOperationId": fence.operationId,
      ":fenceDeployKind": "deploy",
      ":fenceEpoch": fence.lockEpoch,
      ":fenceOpenSnapshotHash": fence.openSnapshotHash,
      ":fenceBuildId": fence.buildId,
      ":fenceStartedAt": fence.startedAt,
      ":fenceDisruptive": true,
      ":fenceProbeAt": fence.probeAt,
      ":fenceProbeOk": true,
      ":fenceProbe": fence.probe,
      ":fenceServe": "serve",
      ":fenceDesired": fence.desiredComponents,
      ":fenceObservedComponents": fence.observedComponents,
      ":fenceRegion": fence.probeInput.region,
      ":fenceAccountId": fence.probeInput.accountId,
      ":fencePartition": fence.probeInput.partition,
      ":fenceTopComponents": fence.probeInput.components,
    });

    conds.push("#o.#operation.#operationKind = :fenceDeployKind");
    conds.push("#o.#operation.#operationId = :fenceOperationId");
    conds.push("#o.#operation.#operationEpoch = :fenceEpoch");
    conds.push("#o.#operation.#operationOpenSnapshotHash = :fenceOpenSnapshotHash");
    conds.push("#o.#operation.#buildId = :fenceBuildId");
    conds.push("#o.#operation.#operationStartedAt = :fenceStartedAt");
    conds.push("#o.#operation.#operationDisruptive = :fenceDisruptive");
    conds.push("#sp.#intent = :fenceServe");
    conds.push("#sp.#desiredComponents = :fenceDesired");
    conds.push("#o.#observedComponents = :fenceObservedComponents");
    conds.push("#topLockEpoch = :fenceEpoch");
    conds.push("#deployLockToken = :fenceOperationId");
    conds.push("#deployLockOperationId = :fenceOperationId");
    conds.push("#topLastOperationId = :fenceOperationId");
    conds.push("#topLastBuildId = :fenceBuildId");
    conds.push("#probe = :fenceProbe");
    conds.push("#probe.#probeOk = :fenceProbeOk");
    conds.push("#probe.#probeAt = :fenceProbeAt");
    conds.push("#fenceRegion = :fenceRegion");
    conds.push("#fenceAccountId = :fenceAccountId");
    conds.push("#fencePartition = :fencePartition");
    conds.push("#c = :fenceTopComponents");
    if (fence.probeInput.resources === undefined) {
      conds.push("attribute_not_exists(#fenceResources)");
    } else {
      values[":fenceResources"] = fence.probeInput.resources;
      conds.push("#fenceResources = :fenceResources");
    }
    if (fence.probeInput.agentcore === undefined) {
      conds.push("attribute_not_exists(#fenceAgentcore)");
    } else {
      values[":fenceAgentcore"] = fence.probeInput.agentcore;
      conds.push("#fenceAgentcore = :fenceAgentcore");
    }

    removeClause = " REMOVE deployLockToken, deployLockExpiresAt, #deployLockOperationId";
  }

  const legacyFence = opts.legacyCompletionFence;
  if (legacyFence) {
    validateExactGreenLifecycleEvidence(legacyFence, "legacyCompletionFence");
    const session = legacyFence.mode === "stable" ? undefined : legacyFence.session;
    if (
      fence ||
      opts.enableFence ||
      opts.ifAbsent !== true ||
      opts.post.observed.operation !== undefined ||
      opts.post.spec.intent !== "serve" ||
      opts.post.observed.health !== "healthy" ||
      JSON.stringify(opts.post.spec.desiredComponents) !== JSON.stringify(legacyFence.desiredComponents) ||
      JSON.stringify(opts.post.observed.components) !== JSON.stringify(legacyFence.observedComponents) ||
      JSON.stringify(opts.post.observed.probe) !== JSON.stringify(legacyFence.probe) ||
      (legacyFence.mode === "stable" && legacyFence.session !== undefined) ||
      (legacyFence.mode !== "stable" &&
        (!session ||
          !Number.isInteger(session.lockEpoch) ||
          session.lockEpoch < 1 ||
          !session.lockToken ||
          !session.operationId ||
          !session.buildId))
    ) {
      throw new PhaseTransitionError(
        "legacyCompletionFence 只允许 exact fresh-probe adoption;stable 必须无 session,E99/initial 必须携 exact lock/build tuple"
      );
    }
    // 🔴 (超出 reviewer 参考实现的修正)names **按分支构造**:#legacyTopEpoch/#legacyLastOperation/#legacyLastBuild
    //    只在 session(e99/initial)分支用到;stable 分支若也预放会造 unused-names → 真环境 ValidationException
    //    (与 §20.3 首写按分支构造同理,mock 测不出;§18/mine-reviewer 教训:参考实现也要逐行核)。
    Object.assign(names, {
      "#legacyToken": "deployLockToken",
      "#legacyExpiry": "deployLockExpiresAt",
      "#legacyOwner": "deployLockOperationId",
      "#legacyProbe": "probe",
      "#legacyProbeAt": "at",
      "#legacyProbeOk": "ok",
      "#legacyRegion": "region",
      "#legacyAccountId": "accountId",
      "#legacyPartition": "partition",
      "#legacyResources": "resources",
      "#legacyAgentcore": "agentcore",
    });
    Object.assign(values, {
      ":legacyProbe": legacyFence.probe,
      ":legacyProbeAt": legacyFence.probeAt,
      ":legacyProbeOk": true,
      ":legacyRegion": legacyFence.probeInput.region,
      ":legacyAccountId": legacyFence.probeInput.accountId,
      ":legacyPartition": legacyFence.probeInput.partition,
      ":legacyTopComponents": legacyFence.probeInput.components,
    });
    conds.push("#legacyProbe = :legacyProbe");
    conds.push("#legacyProbe.#legacyProbeAt = :legacyProbeAt");
    conds.push("#legacyProbe.#legacyProbeOk = :legacyProbeOk");
    conds.push("#legacyRegion = :legacyRegion");
    conds.push("#legacyAccountId = :legacyAccountId");
    conds.push("#legacyPartition = :legacyPartition");
    conds.push("#c = :legacyTopComponents");
    if (legacyFence.probeInput.resources === undefined) {
      conds.push("attribute_not_exists(#legacyResources)");
    } else {
      values[":legacyResources"] = legacyFence.probeInput.resources;
      conds.push("#legacyResources = :legacyResources");
    }
    if (legacyFence.probeInput.agentcore === undefined) {
      conds.push("attribute_not_exists(#legacyAgentcore)");
    } else {
      values[":legacyAgentcore"] = legacyFence.probeInput.agentcore;
      conds.push("#legacyAgentcore = :legacyAgentcore");
    }
    if (legacyFence.mode === "stable") {
      conds.push("attribute_not_exists(#legacyToken)");
      conds.push("attribute_not_exists(#legacyExpiry)");
      conds.push("attribute_not_exists(#legacyOwner)");
    } else {
      if (!session) {
        throw new PhaseTransitionError("legacy session fence 缺 tuple");
      }
      Object.assign(names, {
        "#legacyTopEpoch": "lockEpoch",
        "#legacyLastOperation": "lastOperationId",
        "#legacyLastBuild": "lastBuildId",
      });
      Object.assign(values, {
        ":legacyEpoch": session.lockEpoch,
        ":legacyToken": session.lockToken,
        ":legacyOperation": session.operationId,
        ":legacyBuild": session.buildId,
      });
      conds.push("#legacyTopEpoch = :legacyEpoch");
      conds.push("#legacyToken = :legacyToken");
      conds.push("#legacyOwner = :legacyOperation");
      conds.push("#legacyLastOperation = :legacyOperation");
      conds.push("#legacyLastBuild = :legacyBuild");
      removeClause = " REMOVE #legacyToken, #legacyExpiry, #legacyOwner";
    }
  }

  // ══ —— 弃置 fence:描述符侧的四条事实全部钉进同一次条件写 ══
  const discardFence = opts.discardFence;
  if (discardFence) {
    if (
      fence || legacyFence || opts.enableFence || opts.ifAbsent === true ||
      discardFence.expectedVersion !== opts.expectedVersion ||
      discardFence.fromPhase !== opts.from ||
      opts.post.spec.intent !== "delete" ||
      opts.post.observed.phase !== "gone" ||
      opts.post.observed.operation !== undefined ||
      !isStrictIsoInstant(discardFence.noStacksVerifiedAt)
    ) {
      throw new PhaseTransitionError("discardFence 只允许 registered|provisioning→gone,post-image 必须 intent=delete、无 operation,且带真查 CFN 的时刻");
    }
    Object.assign(names, { "#dOperation": "operation", "#dLock": "deployLockToken", "#dResources": "resources" });
    values[":dTrue"] = true;
    conds.push("attribute_not_exists(#o.#dOperation)");   // 没有在途/未收口的部署会话
    conds.push("attribute_not_exists(#dLock)");            // 部署锁已释放
    conds.push("attribute_not_exists(#dResources)");       // 从没 finalize 出资源袋
    // 从没整包就绪过(ready 投影恒 false)。🔴 写成 OR:DynamoDB 对**不存在**的属性做 `<>` 比较结果为假,
    //   单写 `#r <> :dTrue` 会把「ready 缺失」的存量描述符误拒
    conds.push("(attribute_not_exists(#r) OR #r <> :dTrue)");
  }

  const enableFence = opts.enableFence;
  if (enableFence) {
    validateExactGreenLifecycleEvidence(enableFence, "EnableLifecycleFence");
    if (
      fence ||
      legacyFence ||
      opts.ifAbsent === true ||
      enableFence.expectedVersion !== opts.expectedVersion ||
      opts.from !== "verifying" ||
      to !== "ready" ||
      opts.post.spec.intent !== "serve" ||
      opts.post.observed.phase !== "ready" ||
      opts.post.observed.health !== "healthy" ||
      opts.post.observed.operation !== undefined ||
      // 🔴 组件清单按**集合**比、probe 按 **canonical** 比(见 canonicalJson 的根因说明):
      //    `opts.post.observed.probe` 来自 DDB 读回的 observed,而 `enableFence.probe` 是本次 runProbe 的
      //    内存对象 ⇒ 裸 stringify 必不相等 ⇒ 启用永久 409(真环境实测)。
      !sameComponentSet(opts.post.spec.desiredComponents, enableFence.desiredComponents) ||
      !sameComponentSet(opts.post.observed.components, enableFence.observedComponents) ||
      canonicalJson(opts.post.observed.probe) !== canonicalJson(enableFence.probe)
    ) {
      throw new PhaseTransitionError("EnableLifecycleFence 只允许 fresh exact-green verifying→ready");
    }
    Object.assign(names, {
      "#enableOperation": "operation",
      "#enableIntent": "intent",
      "#enableDesired": "desiredComponents",
      "#enableObservedComponents": "components",
      "#enableTopProbe": "probe",
      "#enableStatus": "status",
      "#enableReady": "ready",
      "#enableProbeAt": "at",
      "#enableProbeOk": "ok",
      "#enableToken": "deployLockToken",
      "#enableExpiry": "deployLockExpiresAt",
      "#enableOwner": "deployLockOperationId",
      "#enableRegion": "region",
      "#enableAccountId": "accountId",
      "#enablePartition": "partition",
      "#enableResources": "resources",
      "#enableAgentcore": "agentcore",
    });
    Object.assign(values, {
      ":enableServe": "serve",
      ":enableDesired": enableFence.desiredComponents,
      ":enableObserved": enableFence.observedComponents,
      ":enableProbe": enableFence.probe,
      ":enableTesting": "testing",
      ":enableReadyFalse": false,
      ":enableProbeAt": enableFence.probeAt,
      ":enableProbeOk": true,
      ":enableRegion": enableFence.probeInput.region,
      ":enableAccountId": enableFence.probeInput.accountId,
      ":enablePartition": enableFence.probeInput.partition,
      ":enableTopComponents": enableFence.probeInput.components,
    });
    conds.push("attribute_not_exists(#o.#enableOperation)");
    conds.push("#sp.#enableIntent = :enableServe");
    conds.push("#sp.#enableDesired = :enableDesired");
    conds.push("#o.#enableObservedComponents = :enableObserved");
    conds.push("#enableTopProbe = :enableProbe");
    conds.push("#enableStatus = :enableTesting");
    conds.push("#enableReady = :enableReadyFalse");
    conds.push("#enableTopProbe.#enableProbeAt = :enableProbeAt");
    conds.push("#enableTopProbe.#enableProbeOk = :enableProbeOk");
    conds.push("attribute_not_exists(#enableToken)");
    conds.push("attribute_not_exists(#enableExpiry)");
    conds.push("attribute_not_exists(#enableOwner)");
    conds.push("#enableRegion = :enableRegion");
    conds.push("#enableAccountId = :enableAccountId");
    conds.push("#enablePartition = :enablePartition");
    conds.push("#c = :enableTopComponents");
    if (enableFence.probeInput.resources === undefined) {
      conds.push("attribute_not_exists(#enableResources)");
    } else {
      values[":enableResources"] = enableFence.probeInput.resources;
      conds.push("#enableResources = :enableResources");
    }
    if (enableFence.probeInput.agentcore === undefined) {
      conds.push("attribute_not_exists(#enableAgentcore)");
    } else {
      values[":enableAgentcore"] = enableFence.probeInput.agentcore;
      conds.push("#enableAgentcore = :enableAgentcore");
    }
  }

  const commandInput = {
    TableName: TABLES.EXECUTION_ENVS,
    Key: { pk: PK, sk: targetId },
    UpdateExpression:
      "SET #o = :obs, #sp = :spec, #st = :status, #r = :ready, " +
      "#c = :components, #v = :next, updatedAt = :t" +
      removeClause,
    ConditionExpression: conds.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };

  try {
    await docClient.send(new UpdateCommand(commandInput));
  } catch (error: unknown) {
    // 🔴 §20:SDK 内部重试可能先已提交、随后因 version fence 收到 ConditionalCheckFailed;
    //    普通 transition 与 completion 的**任何** send error 都先查 exact post-image。
    const postcondition = await transitionPostcondition(targetId, opts, proj);
    if (postcondition === "match") return; // 幂等成功;不得再发第二次 Update。
    if (postcondition === "read-error") {
      throw new LifecycleCommitUncertainError("transition 提交结果未知,且 strong-read postcondition 自身失败");
    }
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecycleConflictError(
        `version/phase/session/probe/input fence 已变化(${opts.from}→${to};${opts.reason})`
      );
    }
    throw new LifecycleCommitUncertainError("transition 提交结果未知且 exact post-image 已确认不匹配");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 2a:observed 的【周期 telemetry 窄通道】—— reconciler 稳态回写 health/observedVersion
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 🔴 加在本文件(全仓唯一写 observed 的地方,守 AST 门禁)。与 transitionPhase **正交**:
 *   - 只碰 `observed.{health, probe, templateVersion, unhealthyStreak, lastReconcileAt}` + 重新物化顶层 `status`/`ready`;
 *   - **phase 不变、operation 不碰、🔴 不涨 version**(ROADMAP「probe/health 不抢 version」——涨了会与管理操作乐观锁打架);
 *   - 条件守卫:仍 modern ∧ phase=ready ∧ **无 operation**(`attribute_not_exists(observed.operation)`,绝不与在途 deploy 抢写)∧ version 未变。
 *   - 冲突(operation 出现 / phase 变 / 降级为 legacy / version 变)⇒ **跳过不报错**(下 tick 再来;reconcileAfterProbe 幂等)。
 *
 * 🔴 **fail-open 反转禁令的落点**:reconciler 每 tick 调它,把本次 probe 的 health(deriveHealthFromProbe)写进 observed,
 *    使得"probe.at 新鲜"与"health 真实"同步 —— 只刷 probe.at 不回写 health = 探活红的 region 永远 active = fail-open。
 *
 * @returns `{written:true}` 或 `{written:false, reason}`(跳过原因;raced=并发被拒,正常)
 */
export async function reconcileTelemetry(
  targetId: string,
  input: { probe: ProbeResult; templateVersion?: string }
): Promise<{ written: boolean; reason?: string }> {
  assertTargetId(targetId);
  parseProbeResult(input.probe); // 坏 probe 零 DDB 写(canonical at / 非空 items / ok===every(ok))
  const current = await getLifecycleRaw(targetId);
  if (!current) return { written: false, reason: "not-found" };
  if (!Number.isInteger(current.version)) return { written: false, reason: "no-version" };
  const cls = classifyDescriptor(current);
  if (cls.kind !== "modern") return { written: false, reason: `not-modern:${cls.kind}` };
  const { spec, observed } = cls;
  if (observed.operation) return { written: false, reason: "operation-in-flight" };
  if (observed.phase !== "ready") return { written: false, reason: `phase=${observed.phase}` };

  const { health, unhealthyStreak } = deriveHealthFromProbe(observed, input.probe);
  const postObserved: TargetObserved = {
    ...observed,
    health,
    unhealthyStreak,
    probe: input.probe,
    lastReconcileAt: new Date().toISOString(),
    ...(input.templateVersion !== undefined ? { templateVersion: input.templateVersion } : {}),
  };
  // 🔴 `lastError` 语义 = **当前未消解的错误**;探活回到 healthy 就说明它已被现实覆盖 ⇒ 清掉,
  //    否则恢复后的 active target 会一直挂着上一次失败文案(误导运维)。
  //    历史不丢:`lastFailure`(谁在何时据什么处置清了哪次会话)刻意保留。
  //    ⚠️ phase 只可能是 ready(上面已 gate),而 ready 的投影不看 lastError ⇒ 清它不改 status。
  if (health === "healthy" && postObserved.lastError !== undefined) delete postObserved.lastError;
  const proj = materializedProjection(spec, postObserved);

  const names: Record<string, string> = {
    "#o": "observed",
    "#ph": "phase",
    "#op": "operation",
    "#st": "status",
    "#r": "ready",
    "#c": "components",
    "#v": "version",
  };
  const values: Record<string, unknown> = {
    ":obs": postObserved,
    ":status": proj.status,
    ":ready": proj.ready,
    ":components": proj.components,
    ":expected": current.version,
    ":readyPhase": "ready",
    ":t": new Date().toISOString(),
  };
  // 条件:仍 modern(observed 在)∧ version 未变(不涨,只做前置守卫)∧ phase 仍 ready ∧ 无 operation。
  const conds = [
    "attribute_exists(sk)",
    "attribute_exists(#o)",
    "#v = :expected",
    "#o.#ph = :readyPhase",
    "attribute_not_exists(#o.#op)",
  ];

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: "SET #o = :obs, #st = :status, #r = :ready, #c = :components, updatedAt = :t",
        ConditionExpression: conds.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return { written: true };
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      // 并发转移 / operation 出现 / phase 变 ⇒ 跳过,下 tick 再来(telemetry 不与生命周期转移抢写)。
      return { written: false, reason: "raced" };
    }
    throw error;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 2b:**唯一的失败路径写入方** —— 清在途会话 + 落已核验失败(SPEC §3.5b / 审核 §19.8)
// ══════════════════════════════════════════════════════════════════════════════

/** 恢复前置/形状不满足(调用方给的 fence 与真 item 不符、或压根没有待恢复会话)⇒ 路由映射 400。 */
export class FailureRecoveryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FailureRecoveryError";
  }
}

/**
 * 🔴 **已核验的外部处置** —— 由恢复端点**查出来**再传进来,本函数不自己查(保持 lifecycle.ts 零 AWS 依赖:
 * 它只有 DynamoDB 客户端;CodeBuild/CloudFormation 查询在 deploy-control.ts)。
 * 🔴 但本函数**校验它的形状**:`buildStatus` 必须是终态词或 `"no-build"`,绝不接受 `IN_PROGRESS`/空串 ——
 *    即使调用方写错,也不可能靠它清掉一个还在跑的会话(纵深防御,不只依赖路由的顺序正确)。
 */
export interface VerifiedFailureDisposition {
  /** exact build 的终态(`FAILED`/`FAULT`/`STOPPED`/`TIMED_OUT`);operation 无 buildId 时为 `"no-build"`。 */
  buildStatus: string;
  /** `describeStackDisposition` 的时刻与逐栈快照(留痕:恢复时基础设施到底是什么样)。 */
  checkedAt: string;
  stacks: Array<{ name: string; status: string; pendingChangeSets: number }>;
}

/** 管理员显式决定(审核 §19.8 ⑤:禁止静默自动恢复)。 */
export interface FailureRecoveryDecision {
  decisionId: string;
  decidedBy: string;
}

/** CodeBuild **失败**终态(与 broker `TERMINAL_BUILD_STATUS` 去掉 SUCCEEDED 同集)。 */
export const FAILED_BUILD_STATUSES = ["FAILED", "FAULT", "STOPPED", "TIMED_OUT"] as const;
/** 压根没有可查的 build(startUncertain:open 成功但 StartBuild 结果未知)。 */
export const NO_BUILD_STATUS = "no-build";
/**
 * CodeBuild 里**查不到**该 buildId(记录过期/项目被重建)。
 * 🔴 与 `no-build` 同样是"可以清锁"的定性结论 —— 记录都不存在 ⇒ 结构上不可能有 build 在跑;
 *    若把它当"状态未定"就又造一个"有锁 + 无出路"的永久卡死门(deploy-control.BUILD_NOT_FOUND 同值)。
 */
export const BUILD_RECORD_MISSING = "not-found";

/**
 * 🔴 失败恢复 fence:**modern / legacy 判别联合**(与 completionFence / legacyCompletionFence 同款分治)。
 * 每个字段都会成为条件写的绑定值 ⇒ 恢复端点做外部核查(build/CFN)与本次写入之间**任何**漂移都让写失败。
 */
export type OperationFailureFence =
  | {
      mode: "modern";
      region: string;
      accountId: string;
      partition: string;
      expectedVersion: number;
      /** pre-image phase(条件绑定;post-image **保持同值**,失败不动生命周期轴)。 */
      fromPhase: TargetPhase;
      operationId: string;
      lockEpoch: number;
      openSnapshotHash: string;
      /** 有则逐字绑定;**无**则条件要求 `observed.operation.buildId` 属性缺失(startUncertain 形态)。 */
      buildId?: string;
      startedAt: string;
      desiredComponents: string[];
      observedComponents: string[];
    }
  | {
      mode: "legacy";
      region: string;
      accountId: string;
      partition: string;
      expectedVersion: number;
      lockEpoch: number;
      lockToken: string;
      /** 顶层 `deployLockOperationId`(= `lastOperationId`,同 holder)。 */
      operationId: string;
      buildId?: string;
      status: TargetStatus;
      components: string[];
    };

/**
 * 🔴🔴 **全仓唯一能在"非成功"结局下清掉 `observed.operation` / 顶层部署锁的地方**(SPEC §3.5b)。
 *
 * 【为什么必须存在(单一根因)】在它之前,operation 与锁的**唯一**清除者是"成功完成 fence"⇒ build 失败 /
 *   CFN 回滚 / attach 结果不明 / startUncertain 超窗 / 进程崩在 open 之后,**全部**落进同一个洞:
 *   target 永久"有锁 ⇒ 不承接新工作",而唯一出路是手改 DDB(红线禁止)。
 *
 * 【三条铁律】
 *   ① 🔴 **`phase` 一律不动**(post-image 的 phase === fence.fromPhase)。失败是**健康**事件,不是生命周期事件:
 *      初装失败留 `provisioning`+`lastError`(投影 failed,须显式重试);升级失败留 `ready` 但 `health=unknown`
 *      ⇒ `serviceabilityReason` fail-closed 拒服务,而"能否回到可服务"**交给下一次真探活**(≤4min 后 reconciler 就跑)。
 *      ⇒ 审核 §19.8「只有验证回到 baseline 才可回 ready」被结构性满足,且不会造出 `ready→provisioning` 这种非法边。
 *   ② 🔴 **必须携已核验处置 + 显式管理员决定**:`buildStatus` 只收终态词/`no-build`(本函数自校验),
 *      `decisionId`/`decidedBy` 必填 ⇒ 没有任何"自动清锁"路径(审核 §19.8 第 5 条)。
 *   ③ 🔴 **legacy 不写 observed**:该 item 还没有双轴,写它就等于收养,而收养必须靠一次 fresh green
 *      (§20.23-R 拒绝清单 #12)⇒ legacy 只 REMOVE 顶层锁三件套,失败详情落**审计**;之后它就是普通 legacy item,
 *      下次探活按既有收养路自愈。
 */
export async function recordOperationFailure(
  targetId: string,
  input: {
    fence: OperationFailureFence;
    disposition: VerifiedFailureDisposition;
    decision: FailureRecoveryDecision;
  }
): Promise<{ cleared: true; mode: OperationFailureFence["mode"] }> {
  assertTargetId(targetId);
  const { fence, disposition, decision } = input;

  // ── ② 纵深防御:处置/决定的形状先过,再看 DDB(调用方顺序写错也不可能清掉在跑的会话)──
  //
  // 🔴 判据**按"完成 fence 是否结构上可行"分叉**,不是一句"SUCCEEDED 一律拒":
  //   · fence.buildId **在** ⇒ 完成 fence 可行(它要求 exact buildId)⇒ **只许失败终态**;
  //     SUCCEEDED 必须走「检测初始化」finalize,恢复端点绝不能变成绕过完成 fence 的清锁后门。
  //   · fence.buildId **缺**(startUncertain / attach 丢响应)⇒ 完成 fence **结构上不可能**
  //     ⇒ 恢复是唯一出路,与那次 build 最终成没成无关(成了也只能靠"重跑幂等部署"补 —— 但锁必须先能解开,
  //     否则就是我们刚治的那个"永久卡死"再生一个新入口)。此时仍要求 buildStatus 是**已定性**的词。
  const failed = FAILED_BUILD_STATUSES as readonly string[];
  const buildStatusOk =
    fence.buildId !== undefined
      ? failed.includes(disposition.buildStatus) || disposition.buildStatus === BUILD_RECORD_MISSING
      : failed.includes(disposition.buildStatus) ||
        disposition.buildStatus === "SUCCEEDED" ||
        disposition.buildStatus === BUILD_RECORD_MISSING ||
        disposition.buildStatus === NO_BUILD_STATUS;
  if (!buildStatusOk) {
    throw new FailureRecoveryError(
      `buildStatus=${JSON.stringify(disposition.buildStatus)} 不允许清锁` +
        (fence.buildId !== undefined
          ? `(本会话有 exact buildId ⇒ 只许 ${failed.join("/")}/${BUILD_RECORD_MISSING};SUCCEEDED 请走「检测初始化」完成路)`
          : `(本会话无 buildId ⇒ 只许 ${failed.join("/")}/SUCCEEDED/${BUILD_RECORD_MISSING}/${NO_BUILD_STATUS})`) +
        " —— IN_PROGRESS/UNKNOWN 等未定性状态一律不许清锁"
    );
  }
  if (!isStrictIsoInstant(disposition.checkedAt) || !Array.isArray(disposition.stacks)) {
    throw new FailureRecoveryError("已核验处置形状非法(checkedAt 须 canonical ISO;stacks 须数组)");
  }
  if (
    typeof decision.decisionId !== "string" ||
    decision.decisionId.length === 0 ||
    typeof decision.decidedBy !== "string" ||
    decision.decidedBy.length === 0
  ) {
    throw new FailureRecoveryError("缺显式管理员决定(decisionId + decidedBy 必填)—— 禁止静默自动恢复");
  }
  if (!Number.isInteger(fence.expectedVersion)) {
    throw new FailureRecoveryError("fence.expectedVersion 须为整数");
  }

  const current = await getLifecycleRaw(targetId);
  if (!current) throw new FailureRecoveryError(`执行目标不存在:${targetId}`);
  if (current.version !== fence.expectedVersion) {
    throw new LifecycleConflictError(
      `version 已变化(读到 ${String(current.version)},fence 期望 ${fence.expectedVersion})—— 期间有别的写入`
    );
  }
  if (
    current.region !== fence.region ||
    current.accountId !== fence.accountId ||
    current.partition !== fence.partition
  ) {
    throw new FailureRecoveryError("外部身份(region/accountId/partition)与 fence 不符 —— 拒绝跨目标恢复");
  }

  const names: Record<string, string> = {
    "#v": "version",
    "#topEpoch": "lockEpoch",
    "#token": "deployLockToken",
    "#owner": "deployLockOperationId",
    "#expiry": "deployLockExpiresAt",
    "#region": "region",
    "#account": "accountId",
    "#partition": "partition",
  };
  const values: Record<string, unknown> = {
    ":expected": fence.expectedVersion,
    ":next": fence.expectedVersion + 1,
    ":t": new Date().toISOString(),
    ":fenceEpoch": fence.lockEpoch,
    ":fenceOperationId": fence.operationId,
    ":fenceRegion": fence.region,
    ":fenceAccount": fence.accountId,
    ":fencePartition": fence.partition,
  };
  const conds = [
    "attribute_exists(sk)",
    "#v = :expected",
    "#topEpoch = :fenceEpoch",
    "#owner = :fenceOperationId",
    "#region = :fenceRegion",
    "#account = :fenceAccount",
    "#partition = :fencePartition",
  ];
  const failureRecord: ObservedFailureRecord = {
    at: new Date().toISOString(),
    operationId: fence.operationId,
    lockEpoch: fence.lockEpoch,
    ...(fence.buildId !== undefined ? { buildId: fence.buildId } : {}),
    buildStatus: disposition.buildStatus,
    checkedAt: disposition.checkedAt,
    stacks: disposition.stacks,
    decisionId: decision.decisionId,
    decidedBy: decision.decidedBy,
  };
  let setClause: string;
  let post: { spec: TargetSpec; observed: TargetObserved } | undefined;
  let proj: { status: TargetStatus; ready: boolean; components: string[] } | undefined;

  if (fence.mode === "modern") {
    const cls = classifyDescriptor(current);
    if (cls.kind !== "modern") {
      throw new FailureRecoveryError(`modern 恢复要求 modern 描述符(实为 ${cls.kind})`);
    }
    const { spec, observed } = cls;
    const operation = observed.operation;
    if (!operation) throw new FailureRecoveryError("没有在途 operation —— 无待恢复会话");
    if (
      operation.kind !== "deploy" ||
      operation.operationId !== fence.operationId ||
      operation.lockEpoch !== fence.lockEpoch ||
      operation.openSnapshotHash !== fence.openSnapshotHash ||
      operation.startedAt !== fence.startedAt ||
      operation.buildId !== fence.buildId ||
      observed.phase !== fence.fromPhase ||
      JSON.stringify(spec.desiredComponents) !== JSON.stringify(fence.desiredComponents) ||
      JSON.stringify(observed.components) !== JSON.stringify(fence.observedComponents) ||
      current.lockEpoch !== fence.lockEpoch ||
      current.deployLockToken !== fence.operationId ||
      current.deployLockOperationId !== fence.operationId
    ) {
      throw new LifecycleConflictError(
        "在途会话与 fence 不符(operation tuple / phase / 组件集 / 顶层锁)—— 期间会话已变,拒绝误清"
      );
    }
    if (!/^[a-f0-9]{64}$/.test(fence.openSnapshotHash) || !Number.isInteger(fence.lockEpoch) || fence.lockEpoch < 1) {
      throw new FailureRecoveryError("fence 的 operation tuple 非法(openSnapshotHash / lockEpoch)");
    }
    // ── ① post-image:清 operation、health→unknown(fail-closed)、记失败;**phase 保持不变** ──
    const { operation: _cleared, ...restObserved } = observed;
    const postObserved: TargetObserved = {
      ...restObserved,
      phase: fence.fromPhase,
      health: "unknown",
      unhealthyStreak: 0,
      lastError:
        `部署会话 ${fence.operationId} 失败(build=${disposition.buildStatus}` +
        `${fence.buildId ? ` ${fence.buildId}` : ""});由管理员 ${decision.decidedBy} 核查基础设施后恢复(${decision.decisionId})`,
      lastFailure: failureRecord,
    };
    post = { spec, observed: postObserved };
    proj = materializedProjection(spec, postObserved);

    Object.assign(names, {
      "#o": "observed",
      "#ph": "phase",
      "#op": "operation",
      "#opKind": "kind",
      "#opId": "operationId",
      "#opEpoch": "lockEpoch",
      "#opHash": "openSnapshotHash",
      "#opStartedAt": "startedAt",
      "#opBuildId": "buildId",
      "#sp": "spec",
      "#desired": "desiredComponents",
      "#obsComponents": "components",
      "#st": "status",
      "#r": "ready",
      "#c": "components",
    });
    Object.assign(values, {
      ":obs": postObserved,
      ":status": proj.status,
      ":ready": proj.ready,
      ":components": proj.components,
      ":fenceDeployKind": "deploy",
      ":fenceHash": fence.openSnapshotHash,
      ":fenceStartedAt": fence.startedAt,
      ":fenceFromPhase": fence.fromPhase,
      ":fenceDesired": fence.desiredComponents,
      ":fenceObservedComponents": fence.observedComponents,
      ":fenceToken": fence.operationId,
    });
    conds.push(
      "attribute_exists(#o)",
      "#o.#ph = :fenceFromPhase",
      "#o.#op.#opKind = :fenceDeployKind",
      "#o.#op.#opId = :fenceOperationId",
      "#o.#op.#opEpoch = :fenceEpoch",
      "#o.#op.#opHash = :fenceHash",
      "#o.#op.#opStartedAt = :fenceStartedAt",
      "#sp.#desired = :fenceDesired",
      "#o.#obsComponents = :fenceObservedComponents",
      "#token = :fenceToken"
    );
    // 🔴 buildId 按分支绑定:有则逐字等值,无则**要求属性缺失**(names/values 只在用到的分支注册,
    //    否则 DynamoDB 因 unused ExpressionAttributeValues 抛 ValidationException —— mock 测不出、真环境必炸,
    //    §20.3/§18 两次实证)。
    if (fence.buildId === undefined) {
      conds.push("attribute_not_exists(#o.#op.#opBuildId)");
    } else {
      values[":fenceBuildId"] = fence.buildId;
      conds.push("#o.#op.#opBuildId = :fenceBuildId");
    }
    setClause =
      "SET #o = :obs, #st = :status, #r = :ready, #c = :components, #v = :next, updatedAt = :t" +
      " REMOVE #token, #expiry, #owner";
  } else {
    // ── ③ legacy:只清顶层锁三件套,**绝不创建/触碰 spec/observed** ──
    if (current.spec !== undefined || current.observed !== undefined) {
      throw new FailureRecoveryError("legacy 恢复要求该 item 尚无 spec/observed(否则应走 modern 恢复)");
    }
    if (
      current.lockEpoch !== fence.lockEpoch ||
      current.deployLockToken !== fence.lockToken ||
      current.deployLockOperationId !== fence.operationId ||
      current.lastOperationId !== fence.operationId ||
      current.status !== fence.status ||
      JSON.stringify(current.components ?? []) !== JSON.stringify(fence.components) ||
      (fence.buildId !== undefined && current.lastBuildId !== fence.buildId)
    ) {
      throw new LifecycleConflictError("legacy 残留锁与 fence 不符(epoch/token/owner/lastOperationId/状态/组件)");
    }
    Object.assign(names, {
      "#o": "observed",
      "#sp": "spec",
      "#lastOp": "lastOperationId",
      "#st": "status",
      "#c": "components",
    });
    Object.assign(values, {
      ":fenceToken": fence.lockToken,
      ":fenceStatus": fence.status,
      ":fenceComponents": fence.components,
    });
    conds.push(
      "attribute_not_exists(#o)",
      "attribute_not_exists(#sp)",
      "#token = :fenceToken",
      "#lastOp = :fenceOperationId",
      "#st = :fenceStatus",
      "#c = :fenceComponents"
    );
    if (fence.buildId !== undefined) {
      names["#lastBuild"] = "lastBuildId";
      values[":fenceBuildId"] = fence.buildId;
      conds.push("#lastBuild = :fenceBuildId");
    }
    setClause = "SET #v = :next, updatedAt = :t REMOVE #token, #expiry, #owner";
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: setClause,
        ConditionExpression: conds.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return { cleared: true, mode: fence.mode };
  } catch (error: unknown) {
    // 🔴 与 transitionPhase 同款:SDK 内部重试可能先已提交、随后因 version fence 收到 CCF ⇒ 先查 exact post-image。
    const postcondition = await failureRecoveryPostcondition(targetId, fence, post, proj);
    if (postcondition === "match") return { cleared: true, mode: fence.mode }; // 幂等成功,不得再写
    if (postcondition === "read-error") {
      throw new LifecycleCommitUncertainError("失败恢复提交结果未知,且 strong-read postcondition 自身失败");
    }
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecycleConflictError(
        `失败恢复的 fence 已变化(会话 ${fence.operationId};mode=${fence.mode})—— 期间 item 被改,未清锁`
      );
    }
    throw new LifecycleCommitUncertainError("失败恢复提交结果未知且 exact post-image 已确认不匹配");
  }
}

/** `recordOperationFailure` 的 exact post-image 判定(语义同 `transitionPostcondition`)。 */
async function failureRecoveryPostcondition(
  targetId: string,
  fence: OperationFailureFence,
  post: { spec: TargetSpec; observed: TargetObserved } | undefined,
  proj: { status: TargetStatus; ready: boolean; components: string[] } | undefined
): Promise<TransitionPostcondition> {
  let current: ExecutionTarget | undefined;
  try {
    current = await getLifecycleRaw(targetId);
  } catch {
    return "read-error";
  }
  if (!current) return "mismatch";
  const lockCleared =
    current.deployLockToken === undefined &&
    current.deployLockExpiresAt === undefined &&
    current.deployLockOperationId === undefined;
  if (current.version !== fence.expectedVersion + 1 || !lockCleared) return "mismatch";
  if (fence.mode === "legacy") {
    return current.spec === undefined && current.observed === undefined ? "match" : "mismatch";
  }
  if (!post || !proj) return "mismatch";
  return canonicalJson(current.observed) === canonicalJson(post.observed) &&
    canonicalJson(current.spec) === canonicalJson(post.spec) &&
    current.status === proj.status &&
    current.ready === proj.ready &&
    canonicalJson(current.components) === canonicalJson(proj.components)
    ? "match"
    : "mismatch";
}

// ══════════════════════════════════════════════════════════════════════════════
// 下线销毁的两个写通道
//   ① `markDecommissionApproved`:审批通过 ⇒ `spec.intent = delete` + 删除计划(审批单 / 影响预览指纹 / 最终快照名 / 将保留清单)
//      —— 这是平台把 intent 置成 delete 的**唯一**入口;broker 的 destroy 只认它写下的计划。
//   ② `settleDestroy`:销毁会话收口 —— 真查 AWS 全清 ⇒ `gone`;否则留 `decommissioning` + lastError(点名卡住的资源 + 真因)。
//      broker 从不清锁;锁与 destroy operation 只在这里(带会话 fence)一次条件写清掉。
// ══════════════════════════════════════════════════════════════════════════════

/** 销毁后**保留**的数据类资源(页面逐个列出「已保留,需人工确认后单独清理」)。 */
export interface RetainedResource {
  /** 资源类别:s3 / s3tables / dynamodb / kms / redshift-snapshot */
  kind: string;
  name: string;
  /** 给人看的说明(数据湖桶 / 表桶 / 最终快照 …) */
  note: string;
}

/** 注册表顶层 `decommission`:审批通过时写定,之后**不再改**(重试销毁复用同一份,快照名因此不会变)。 */
export interface DecommissionPlan {
  approvalId: string;
  /** 审批时那份影响预览的指纹(sha256 hex);审计可回放「批的是哪一份」 */
  previewHash: string;
  /** `bgp-final-<slug>-<yyyymmdd>-<hhmm>`(与 broker validate.mjs FINAL_SNAPSHOT_RE 同一形态,parity 单测钉住) */
  finalSnapshotName: string;
  requestedBy: string;
  approvedBy: string;
  approvedAt: string;
  retained: RetainedResource[];
}

/** 与 `infra/lambda/exec-env-broker/validate.mjs` 的 FINAL_SNAPSHOT_RE 逐字相同(`decommission-assembly` 单测读 broker 源码钉住)。 */
export const FINAL_SNAPSHOT_RE = /^bgp-final-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 能进入销毁的阶段(与 broker DESTROYABLE_PHASES 同集;`registered` 走弃置、`gone` 是终态)。 */
export const DESTROYABLE_PHASES: readonly TargetPhase[] = ["ready", "draining", "provisioning", "verifying", "decommissioning"];

function assertDecommissionPlan(plan: DecommissionPlan): void {
  const bad = (m: string) => {
    throw new PhaseTransitionError(`删除计划非法:${m}`);
  };
  if (!plan || typeof plan !== "object") bad("不是对象");
  if (typeof plan.approvalId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(plan.approvalId)) bad("approvalId");
  if (typeof plan.previewHash !== "string" || !/^[a-f0-9]{64}$/.test(plan.previewHash)) bad("previewHash 须为 64 位小写 hex");
  if (typeof plan.finalSnapshotName !== "string" || !FINAL_SNAPSHOT_RE.test(plan.finalSnapshotName) || plan.finalSnapshotName.length > 255) {
    bad(`finalSnapshotName=${JSON.stringify(plan.finalSnapshotName)}`);
  }
  for (const k of ["requestedBy", "approvedBy"] as const) {
    if (typeof plan[k] !== "string" || plan[k].length === 0) bad(k);
  }
  if (!isStrictIsoInstant(plan.approvedAt)) bad("approvedAt 须 canonical ISO");
  if (!Array.isArray(plan.retained)) bad("retained 须为数组");
}

/**
 * 审批通过 ⇒ 写 `spec.intent = delete` + 删除计划(同一次条件写)。
 * 前置(全部钉进条件写,读与写之间被抢 ⇒ 冲突,不写半份):version / intent=drain / 无 operation / 无部署锁 / 没有旧的删除计划 /
 * phase 仍是读到的那个(∈ DESTROYABLE_PHASES 且不是 decommissioning —— 那是已在销毁)。
 * 幂等:库里已是**同一张审批单**的计划 ⇒ `{written:false}`(审批通过后 broker 没起来、再点「重试销毁」走这里)。
 */
export async function markDecommissionApproved(
  targetId: string,
  opts: { expectedVersion: number; plan: DecommissionPlan }
): Promise<{ written: boolean }> {
  assertTargetId(targetId);
  if (targetId === "tgt_home") throw new PhaseTransitionError("主控区执行环境永不可删");
  assertDecommissionPlan(opts.plan);
  const current = await getLifecycleRaw(targetId);
  if (!current) throw new PhaseTransitionError(`执行目标不存在:${targetId}`);
  const existing = (current as { decommission?: DecommissionPlan }).decommission;
  const cls = classifyDescriptor(current);
  if (cls.kind !== "modern") {
    throw new PhaseTransitionError(`删除要求 modern 描述符(实为 ${cls.kind})—— 先「检测初始化」让平台收养`);
  }
  const { spec, observed } = cls;
  if (spec.intent === "delete") {
    if (existing?.approvalId === opts.plan.approvalId) return { written: false };
    throw new PhaseTransitionError(`该环境已有另一份删除计划(审批单 ${existing?.approvalId ?? "?"})`);
  }
  if (current.version !== opts.expectedVersion) {
    throw new PhaseTransitionError(`版本已变(读到 ${String(current.version)} ≠ 期望 ${opts.expectedVersion})—— 有并发操作,请刷新重试`);
  }
  if (spec.intent !== "drain") throw new PhaseTransitionError("删除前必须先停止承接(drain)");
  if (observed.operation || current.deployLockOperationId !== undefined) {
    throw new PhaseTransitionError(`有在途部署会话(${observed.operation?.operationId ?? current.deployLockOperationId})—— 等它收口`);
  }
  if (!DESTROYABLE_PHASES.includes(observed.phase) || observed.phase === "decommissioning") {
    throw new PhaseTransitionError(`phase=${observed.phase} 不能进入删除(registered 走弃置;gone 已删)`);
  }
  if (existing !== undefined) throw new PhaseTransitionError("注册表里残留一份删除计划而意图不是 delete —— 数据形态异常,fail-closed");

  const postSpec: TargetSpec = { ...spec, intent: "delete" };
  const proj = materializedProjection(postSpec, observed);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: "SET #sp = :spec, #st = :status, #r = :ready, #c = :components, #dc = :plan, #v = :next, updatedAt = :t",
        ConditionExpression: [
          "attribute_exists(sk)",
          "#v = :expected",
          "#sp.#intent = :drain",
          "#o.#ph = :phase",
          "attribute_not_exists(#o.#op)",
          "attribute_not_exists(#lock)",
          "attribute_not_exists(#dc)",
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#sp": "spec", "#st": "status", "#r": "ready", "#c": "components", "#dc": "decommission", "#v": "version",
          "#intent": "intent", "#o": "observed", "#ph": "phase", "#op": "operation", "#lock": "deployLockOperationId",
        },
        ExpressionAttributeValues: {
          ":spec": postSpec, ":status": proj.status, ":ready": proj.ready, ":components": proj.components,
          ":plan": opts.plan, ":expected": opts.expectedVersion, ":next": opts.expectedVersion + 1,
          ":t": new Date().toISOString(), ":drain": "drain", ":phase": observed.phase,
        },
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecycleConflictError("写删除计划被条件拒绝:期间出现了并发操作(版本 / 意图 / 在途会话 / 已有计划)—— 请刷新后重试");
    }
    throw error;
  }
  return { written: true };
}

/** 销毁会话收口时落进 `observed.lastDestroy` 的记录(诊断 / 页面「卡在哪 / 保留了什么」的唯一来源)。 */
export interface LastDestroyRecord {
  at: string;
  outcome: "gone" | "stuck";
  operationId?: string;
  buildId?: string;
  buildStatus: string;
  /** AWS 真值核查时刻 */
  checkedAt: string;
  /** 真查出来还在的东西(栈 / VPC / 托管服务);gone 时必为空 */
  remaining: string[];
  /** 看不清的项(查询失败);非空时不许判 gone */
  unverifiable: string[];
  /** 卡住的那一个(步骤 / 资源 / 真因);来自构建报告或 CFN 事件 */
  stuck?: { step?: string; resource: string; reason: string };
  retained: RetainedResource[];
  finalSnapshot?: { name: string; state: string };
}

/**
 * 收口会话的 fence。
 * `session` 有 ⇒ 收口一个在途 destroy 会话:绑 operation tuple + 顶层锁,写时**清锁**;
 * `session` 无 ⇒ 对已收口的卡住态(decommissioning、无 operation)重探:要求无 operation 无锁。
 */
export interface DestroySettleFence {
  expectedVersion: number;
  session?: { operationId: string; lockEpoch: number; buildId?: string; buildStatus: string };
}

const SETTLEABLE_BUILD_STATUSES = ["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT", "not-found"];

export async function settleDestroy(
  targetId: string,
  input: { fence: DestroySettleFence; record: LastDestroyRecord; lastError?: string }
): Promise<{ phase: "gone" | "decommissioning" }> {
  assertTargetId(targetId);
  const { fence, record } = input;
  if (!Number.isInteger(fence.expectedVersion)) throw new PhaseTransitionError("fence.expectedVersion 须为整数");
  if (!isStrictIsoInstant(record.at) || !isStrictIsoInstant(record.checkedAt)) throw new PhaseTransitionError("lastDestroy 的时刻须 canonical ISO");
  if (record.outcome === "gone") {
    // 🔴 「不许假装删完」的最后一道:真查还有剩 / 有看不清的项 ⇒ 结构上写不进 gone
    if (record.remaining.length > 0 || record.unverifiable.length > 0) {
      throw new PhaseTransitionError(`还有残留 / 看不清的项,不能判已删除:${[...record.remaining, ...record.unverifiable].join("; ")}`);
    }
  } else if (typeof input.lastError !== "string" || input.lastError.trim().length === 0) {
    throw new PhaseTransitionError("卡住态必须带 lastError(点名卡住的资源 + 真因)");
  }
  const sess = fence.session;
  if (sess) {
    const terminal = SETTLEABLE_BUILD_STATUSES.includes(sess.buildStatus) || (sess.buildId === undefined && sess.buildStatus === NO_BUILD_STATUS);
    if (!terminal) throw new PhaseTransitionError(`销毁 build 还没结束(${sess.buildStatus})—— 不收口`);
  }

  const current = await getLifecycleRaw(targetId);
  if (!current) throw new PhaseTransitionError(`执行目标不存在:${targetId}`);
  if (current.version !== fence.expectedVersion) throw new LifecycleConflictError(`version 已变化(读到 ${String(current.version)},fence 期望 ${fence.expectedVersion})`);
  const cls = classifyDescriptor(current);
  if (cls.kind !== "modern") throw new PhaseTransitionError(`销毁收口要求 modern 描述符(实为 ${cls.kind})`);
  const { spec, observed } = cls;
  if (observed.phase !== "decommissioning" || spec.intent !== "delete") {
    throw new LifecycleConflictError(`不在销毁中(phase=${observed.phase} intent=${spec.intent})`);
  }
  const op = observed.operation;
  if (sess) {
    if (!op || op.kind !== "destroy" || op.operationId !== sess.operationId || op.lockEpoch !== sess.lockEpoch || op.buildId !== sess.buildId) {
      throw new LifecycleConflictError("在途销毁会话与 fence 不符 —— 期间会话已变,拒绝误收口");
    }
  } else if (op) {
    throw new LifecycleConflictError(`还有在途会话(${op.operationId})—— 先等它收口`);
  }

  const { operation: _op, lastError: _le, ...rest } = observed;
  void _op;
  void _le;
  const postObserved: TargetObserved & { lastDestroy: LastDestroyRecord } = {
    ...rest,
    phase: record.outcome === "gone" ? "gone" : "decommissioning",
    health: "unknown",
    lastDestroy: record,
    ...(record.outcome === "stuck" ? { lastError: String(input.lastError).slice(0, 1500) } : {}),
  };
  const proj = materializedProjection(spec, postObserved);
  const names: Record<string, string> = {
    "#o": "observed", "#st": "status", "#r": "ready", "#c": "components", "#v": "version",
    "#sp": "spec", "#intent": "intent", "#ph": "phase", "#op": "operation",
  };
  const values: Record<string, unknown> = {
    ":obs": postObserved, ":status": proj.status, ":ready": proj.ready, ":components": proj.components,
    ":expected": fence.expectedVersion, ":next": fence.expectedVersion + 1, ":t": new Date().toISOString(),
    ":delete": "delete", ":decom": "decommissioning",
  };
  const conds = ["attribute_exists(sk)", "#v = :expected", "#sp.#intent = :delete", "#o.#ph = :decom"];
  let remove = "";
  if (sess) {
    Object.assign(names, {
      "#kind": "kind", "#opId": "operationId", "#opEpoch": "lockEpoch", "#bid": "buildId",
      "#topEpoch": "lockEpoch", "#token": "deployLockToken", "#owner": "deployLockOperationId", "#expiry": "deployLockExpiresAt",
    });
    Object.assign(values, { ":destroy": "destroy", ":opId": sess.operationId, ":epoch": sess.lockEpoch });
    conds.push("#o.#op.#kind = :destroy", "#o.#op.#opId = :opId", "#o.#op.#opEpoch = :epoch", "#topEpoch = :epoch", "#token = :opId", "#owner = :opId");
    if (sess.buildId === undefined) conds.push("attribute_not_exists(#o.#op.#bid)");
    else {
      values[":bid"] = sess.buildId;
      conds.push("#o.#op.#bid = :bid");
    }
    remove = " REMOVE #token, #expiry, #owner";
  } else {
    names["#token"] = "deployLockToken";
    conds.push("attribute_not_exists(#o.#op)", "attribute_not_exists(#token)");
  }
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: "SET #o = :obs, #st = :status, #r = :ready, #c = :components, #v = :next, updatedAt = :t" + remove,
        ConditionExpression: conds.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecycleConflictError("销毁收口被条件拒绝:期间会话 / 版本已变 —— 下次观测再来");
    }
    throw error;
  }
  return { phase: postObserved.phase as "gone" | "decommissioning" };
}
