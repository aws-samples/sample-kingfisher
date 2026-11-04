// G1—— 执行目标(ExecutionTarget)注册表读侧。
//
// 设计合同:docs/design/50-multi-region-execution/SPEC.md §1.1(表结构 + stale 定义 + home seed 时机)、
//          §1.1a(targetId 格式)、§3.1(准入不缓存 + 强一致读)、§3.1a(运行时整包校验)、§2.2(绝不回落 home)。
//
// 🔴 **本文件属 G 共享地基批:仍然没有任何生产调用方**(grep `platform/src` 排除 `__tests__` 与本目录 = 空)。
// 上线对现网行为的影响是 **0**(纯新增),可以单独回滚 = 删表 item。
//
// ── 这里最容易写错、也最危险的三处 ────────────────────────────────────────────────
// ① **回落 home**(外部审核 v1 P0-4)。设计稿里曾有一行:
//        const t = registry.getTarget(targetId) ?? homeTarget
//    那是整份设计里最危险的一行:**unknown / 已删除 / stale 的 target 会被当成 home**,
//    于是"跨法域守卫"下一步的 `jurisdiction === "home"` 成立 → 直接放行,整个守卫被绕过;
//    跨法域场景下就是**把 A 区任务静默打到 home 数据面 = 数据出境**。
//    ⇒ 本文件**不提供任何带 home 兜底的查询**。缺失/未 ready/状态不可用 一律:
//       `getTarget()` 返回 null、`requireReadyTarget()` 抛错。只有**字面 `tgt_home`** 才有 home 语义。
//
// ② **把可变准入位放进缓存**(外部审核 v2 P0-1 —— v3.4 本次整改的主项)。
//    旧实现把整个描述符放进 60s 正缓存。`status`/`ready`/`lockEpoch`/`credentialEpoch` 是**可变准入位**:
//    管理面把 target 原子改成 `draining`/`deleted` 之后,已持缓存的 ECS task **60s 内仍按 active 放行新 run**
//    (零 DDB 调用、无日志异常);TTL 到期后默认**最终一致**的 GetItem 也给不了准入需要的保证。
//    这不是普通的缓存陈旧,是**合同要求的安全判定被绕过**(ACCEPTANCE C5 正要断"进入 draining 后新 run 全被拒")。
//    ⇒ **准入路径彻底不缓存,每次 `GetItem({ConsistentRead:true})`。**
//    🔴 也**刻意不引入第二层"位置/资源"缓存**:资源袋随同一次读取一起回来,第二层缓存唯一的服务对象
//    是"跳过准入的调用方",而那正是要禁的。少一个缓存 = 少一类"状态在缓存底下变了"的缺陷。
//    🔴 **为什么不做跨实例失活总线**:SPEC §3.9b 的缓存规则是"跨实例失活 **或** 强一致 cutover gate"二选一,
//    这里走后者 ⇒ 准入位没有跨实例陈旧窗口,总线是多余件(顺带让 §3.9b 的 `credentialEpoch` 恒新鲜,
//    privileged-cred 不必改一行)。
//
// ③ **读路径自愈写库**(外部审核 v2 P1-1)。旧 `getHomeTarget()` 发现 home 缺失就自己 `ensureHomeTarget()`,
//    从 env 猜资源袋。后果:**第一个到达的运行时请求**抢先落下 `accountId=""`、缺 core 资源、却 `ready=true`
//    的描述符,并被条件写**永久锁死**;其中 `REDSHIFT_SECRET_ID` 这个 env **CDK 从未注入**(platform-stack.ts
//    出现 0 次)⇒ 猜出来的袋子必然缺 `redshiftSecretArn`。
//    ⇒ 读路径**只读**;seed 归部署期(§1.1),入参是完整实名描述符、写前整包校验、
//      `ConditionalCheckFailed` **不再一律当成功**。

import { NETWORK_PROFILES, type NetworkProfile } from "@/lib/exec-env/network-profile";
import { SCHEDULER_PREFERENCES } from "@/lib/exec-env/scheduler-preference";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { HOME_TARGET_ID, assertTargetId, isHome, isValidTargetId } from "@/lib/exec-env/target-id";
// 执行角色键的单一作者(SPEC v3.21 §3.1a 规则 ②:补充部署窄通道的唯一例外)
import { execRoleRotationVerdict, isExecRoleResourceKey } from "@/lib/exec-env/exec-roles";
// 跨法域技术前置 / 项目白名单 / 法域格式的单一作者(SPEC v3.22;DESIGN 6quinquies)
import { JURISDICTION_RE, isCrossJurisdiction, parseTargetAccess, residencyPrerequisite } from "@/lib/exec-env/residency";
import { isCurrentDisclaimerAck } from "@/lib/residency/disclaimer";
import { readExecEnvStackOutputs, type ExecEnvStackOutputs } from "@/lib/exec-env/stack-outputs";
import { orderComponents, isComponentRetired, retiredComponentMessage, requiredComponentsFor, requiredComponentsForTarget } from "@/lib/exec-env/implemented-components";
// VPC 地址池(与 infra/lib/exec-env/vpc-cidr.ts 由 parity 门禁钉住)
import { EXEC_ENV_VPC_CIDR_POOL, EXEC_ENV_VPC_CIDR_RE, allocateExecEnvVpcCidr } from "@/lib/exec-env/vpc-cidr";
// 🔴 值依赖 registry → lifecycle **单向**(lifecycle 反向只 `import type`,编译期擦除,无运行时循环)。
//    状态写一律经 lifecycle 的单写通道 transitionPhase;spec/observed 权威类型也在那儿。
import {
  canonicalJson,
  specObservedOf,
  classifyDescriptor,
  serviceabilityReason,
  transitionPhase,
  adoptLegacyAfterFreshProbe,
  parseProbeResult,
  ProbeResultSchema, LifecycleConflictError } from "@/lib/exec-env/lifecycle";
import type {
  TargetSpec,
  TargetObserved,
  TargetPhase,
  TransitionGuard,
  DeployOperation,
  ProbeResult,
  ProbeInputSnapshot,
  DeploymentCompletionFence,
  LegacySessionFence,
  LegacyCompletionFence,
  EnableLifecycleFence,
} from "@/lib/exec-env/lifecycle";
import { isGreenProbeForComponents, probeSaysComponentGone } from "@/lib/exec-env/component-contract";

// 🔴 保持 registry 旧 type-import API:probe-runner.ts / deploy-control.ts 从 registry type-import ProbeResult。
//    canonical 定义在 lifecycle.ts(唯一权威),registry 只 re-export 已 import 的本地绑定,消费方零改动。
export type { ProbeResult };

/** 单分区常量 pk(SPEC §1.1):target 数量是"部署单元"级别,不会到需要分片的量级。 */
const PK = "env";

/** GSI:按 region 反查"某 region 有哪些 target"(SPEC §1.1)。 */
const GSI_BY_REGION = "byRegion";

/**
 * 🔴 **描述符新鲜度阈值**(SPEC §1.1 v3.4 的 `stale` 定义)。
 *
 * 时间源 = `probe.at`,缺则退到 `updatedAt`;**仅对非 home 生效**。
 * 硬约束:探活 / reconcile 周期必须 **≤ 本值/3**(即 ≤5min),否则探活一慢就把整个 region 判死。
 */
export const TARGET_FRESHNESS_MAX_AGE_MS = 15 * 60_000;

/**
 * 🔴 **允许的最大"未来"时钟偏差**(SPEC §1.1 v3.5;外部审核 v3 P1-2 的 N3 整改)。
 *
 * 【为什么必须有】旧实现只算 `now - ts > 阈值`,于是 **`probe.at = 2999-01-01` 会让 age 为负 ⇒ 永远新鲜**
 * (实测放行非 home target)。这条我在给审核员的软点清单里**自己写过**,却只披露没修 ——
 * **披露不等于修好**,这是本轮最该记住的一句。
 *
 * 取 2min:要覆盖正常 NTP 抖动(通常 <1s,容器冷启动可能到秒级),又要远小于 15min 的 stale 阈值,
 * 免得"未来容差"反过来变成一条 15min 的绕过窗口。**超出容差与"缺时间源"同样 fail-closed。**
 */
export const TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS = 2 * 60_000;

/**
 * 🔴 **`provisioning` 窗口的最大时长**(SPEC §3.9b v3.7;外部审核 v4 P1-4)。
 *
 * 【为什么必须有上限】上一版只检查 `provisioningDeadlineAt` **非空** ⇒
 * 传一个过去时间、一个 `"soon"` 这样的垃圾串、或 `2999-01-01`,都能进 provisioning,
 * 而读路径又完全不看它 ⇒ **无限期使用共享 admin**。"有 deadline" 与 "deadline 有意义" 是两件事。
 *
 * 取 30 天:per-project 凭证供给 + canary 是**有界工程任务**,给一个月足够;
 * 超过一个月说明供给卡住了,那应该是**告警 + 重新决策**,而不是让回落继续默默生效。
 */
export const PROVISIONING_MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** 状态全集(SPEC §1.1)。**先有数组再派生类型**,好让 zod 与 TS 用同一份事实、不两处漂移。 */
export const TARGET_STATUSES = [
  "registered",
  "initializing",
  "testing",
  "active",
  "degraded",
  "failed",
  "upgrading",
  "draining",
  "decommissioning",
  "deleted",
] as const;

export type TargetStatus = (typeof TARGET_STATUSES)[number];

// 🔴 **可承接新工作**的判定 v3.15 起改由 `lifecycle.serviceabilityReason(spec, observed)` 派生
//    (intent=serve ∧ phase=ready ∧ 无破坏性 operation;degraded 仍可服务 = phase 仍 ready、health=degraded)。
//    旧 `RUNTIME_USABLE_STATUS={active,degraded}` 常量已废除 —— 单一判定不再散落成"状态子集"表。

/** 组件枚举(SPEC §1.1)。`core` 必有。 */
export const TARGET_COMPONENTS = [
  "core",
  "redshift",
  "kafka",
  "mwaa",
  "dms",
  "flink",
  "agentcore",
  "residency-api",
  // (SPEC v3.27 §3.15)
  "airflow-serverless",
] as const;

/**
 * 🔴 core 资源必填清单(SPEC §1.1 的 core 袋)。
 * `flinkSubnetIds` 刻意**不在**必填里 —— §1.1 把它标为 `?`(flink 是可选组件)。
 */
export const REQUIRED_CORE_RESOURCES = [
  "datalakeBucket",
  "scriptsBucket",
  "tableBucket",
  "athenaWorkgroup",
  "glueRoleArn",
  "emrSecurityGroupId",
] as const;

/** 执行目标描述符(SPEC §1.1;字段语义见该节表格)。 */
export interface ExecutionTarget {
  /** 常量 "env" */
  pk: string;
  /** = targetId(不可变身份;取代早期"envId=region"方案) */
  sk: string;
  targetId: string;
  /** 位置与部署属性 —— 都是**属性**,不是身份 */
  partition: string;
  accountId: string;
  region: string;
  cellId?: string;
  stage?: string;
  /** 网络规模(顶层描述符字段;注册时写、`POST .../network-profile` 改;broker 据此派生 NAT 数) */
  networkProfile?: NetworkProfile;
  /**
   * 🔴 本执行环境 VPC 的 CIDR(**注册时由服务端从地址池分配,之后不可改**)。
   * 为什么必须落描述符:broker 只读描述符,要把它透传给 `cdk deploy -c exec-env-vpc-cidr=`;
   * 而分配必须看**全量已用值**(同账号里任意两个执行环境不许重叠,否则主控区路由表没法同时指向两条 peering)。
   * 🔴 存量描述符没有这个字段(此前注册的、以及 home)—— 非 home 缺它 ⇒ **部署路径 fail-closed**,
   *    不猜默认值:CDK 默认的 10.0.0.0/16 与主控区逐位相同,建出来的环境**回写不了台账**(SPEC §3.14ter)。
   */
  vpcCidr?: string;
  /** (SPEC v3.27 §3.15):两种调度组件都装时用哪个;缺省 serverless */
  schedulerPreference?: "serverless" | "mwaa";
  displayName?: string;
  isHome?: boolean;
  /** 法域标记;缺省 "home"。🔴 v3.22:只是标签 + 审计维度 + 技术前置的触发条件(`residencyPrerequisite`),不驱动任何拒绝 */
  jurisdiction?: string;
  /** 项目白名单(SPEC §1.1 `access?`,通用,缺省全部项目;只许 `setTargetAccess` 写) */
  access?: { mode: "all-projects" } | { mode: "allowlist"; projects: string[] };
  /** 注册跨法域 target 时 admin 对免责告知的同意(之后不可改;每用户的同意另存 S13) */
  residencyAck?: { by: string; at: string; version: string; textHash: string };
  status: TargetStatus;
  /** 实名资源袋(**非派生**:不许由 region 拼出来) */
  resources?: Record<string, unknown>;
  components?: string[];
  capabilities?: string[];
  desiredVersion?: string;
  observedVersion?: string;
  agentcore?: Record<string, unknown>;
  /** 🔴 v3.15:canonical 探活结果(唯一权威在 lifecycle.ProbeResult)。完成态 fence 对它做 exact 等值条件写。 */
  probe?: ProbeResult;
  /**
   * 🔴 **v3.15期望态/观测态**(SPEC §1.1):`status`/`ready`/`components` 自本版起是
   * **由 `(spec, observed)` 派生的兼容投影**(见 lifecycle.ts)。过渡期两种形态并存:
   * 存量 item 只有 legacy 字段、无 spec/observed,由控制器 `adoptLegacy` 收养;新写入两者都落。
   */
  spec?: TargetSpec;
  observed?: TargetObserved;
  /** 描述符**整包写完**才置位;运行时只认 true。🔴 v3.15 起为 `observed.phase` 的派生投影(过渡期仍读旧字段) */
  ready?: boolean;
  /** fencing epoch(§3.5):旧 operation 即使恢复也因 epoch 过期无法写状态/销毁资源 */
  lockEpoch?: number;
  /**
   * 🔴 顶层残留部署锁(broker 写,§3.5;字段名与 `exec-env-broker/index.mjs` 一致)。
   * `unusableReason` 在 legacy/modern 分流**前**先查它(v2 审核 §20.2):否则一个 legacy-stable 描述符
   * (无 `observed.operation`)会绕过 operation 校验被准入,而它其实正被一次在途部署持锁。
   */
  deployLockToken?: string;
  /** 🔴 lease 到期时刻(epoch ms;broker 写)。§21.1:类型对齐 broker 写入的数值,非字符串。 */
  deployLockExpiresAt?: number;
  deployLockOperationId?: string;
  /** 🔴 完成态 fence 绑定:broker attach 的 buildId / 本次 operationId(顶层镜像,供 legacy/postcondition 核对)。 */
  lastBuildId?: string;
  lastOperationId?: string;
  createdBy?: string;
  updatedAt?: string;
  version?: number;
  /**
   * §3.9b 凭证隔离四字段。
   * 🔴 这里的可选性**只是 TS 层的形状声明**,不是"可以缺"的许可 ——
   * 凭证路径缺状态**一律拒**(`privileged-cred.requireCredentialIsolationState`)。
   */
  credentialIsolationState?: "legacy-seeded" | "provisioning" | "isolated";
  credentialEpoch?: number;
  credentialStateUpdatedAt?: string;
  provisioningOperationId?: string;
  provisioningDeadlineAt?: string;
}

/** `requireReadyTarget` 的专用错误,便于调用方区分"不可用"与"其它故障"。 */
export class TargetNotReadyError extends Error {
  constructor(
    readonly targetId: string,
    readonly why: string
  ) {
    super(`执行目标不可用:${targetId} —— ${why}`);
    this.name = "TargetNotReadyError";
  }
}

// ——————————————————————————————————————————————————————————————
// §3.1a 运行时整包校验(取代裸 `as ExecutionTarget`)
// ——————————————————————————————————————————————————————————————

/**
 * 描述符 schema。
 *
 * 🔴 **未知多余属性放行**(zod 默认行为,这里显式说明):新版本平台写的新字段不该让旧实例把整个
 * target 判死 —— 那是"向前兼容"与"fail-closed"的正确分工:**已知字段类型错才拒**。
 */
const DescriptorSchema = z.object({
  pk: z.literal(PK),
  sk: z.string(),
  targetId: z.string(),
  partition: z.enum(["aws", "aws-cn", "aws-us-gov"]),
  accountId: z.string().regex(/^\d{12}$/, "accountId 须为 12 位数字"),
  region: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "region 形如 us-east-1 / cn-north-1 / us-gov-west-1"),
  cellId: z.string().optional(),
  stage: z.string().optional(),
  networkProfile: z.enum(NETWORK_PROFILES).optional(),
  // 形如 10.128.0.0/16 … 10.255.0.0/16(池子与主控区 10.0.0.0/16 构造上不相交)
  vpcCidr: z.string().regex(EXEC_ENV_VPC_CIDR_RE, `vpcCidr 须是地址池 ${EXEC_ENV_VPC_CIDR_POOL} 里的一个 /16`).optional(),
  // 两者都装时走哪个调度器(SPEC §3.15;缺省 serverless)
  schedulerPreference: z.enum(SCHEDULER_PREFERENCES).optional(),
  displayName: z.string().optional(),
  isHome: z.boolean().optional(),
  // 法域格式(SPEC §1.1 v3.22)—— `Home` / `HOME` / `EU` 变体不进库
  jurisdiction: z.string().regex(JURISDICTION_RE, "jurisdiction 形如 home / eu-sim(小写字母开头,[a-z0-9-],2–32 位)").optional(),
  // 项目白名单(通用)与注册时的免责告知同意(跨法域必填,之后不可改)
  access: z
    .union([
      z.object({ mode: z.literal("all-projects") }),
      z.object({ mode: z.literal("allowlist"), projects: z.array(z.string().min(1)) }),
    ])
    .optional(),
  residencyAck: z
    .object({ by: z.string().min(1), at: z.string().min(1), version: z.string().min(1), textHash: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
  status: z.enum(TARGET_STATUSES),
  resources: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  desiredVersion: z.string().optional(),
  observedVersion: z.string().optional(),
  agentcore: z.record(z.string(), z.unknown()).optional(),
  // 🔴 v3.15(§21.1):probe 不再 z.record —— 用 canonical ProbeResultSchema 做结构校验
  //    (canonical `at` + ok===every(ok) 由 parseProbeResult 在写侧把关,不在描述符层重复)。
  probe: ProbeResultSchema.optional(),
  // 🔴 v3.15:期望态/观测态。此处**松校验**(z.record,与 agentcore/probe 同款)——
  //    精确形状由 lifecycle.ts 的类型 + 写通道(transitionPhase/writeSpec)保证;§3.1a 的跨字段不变量
  //    仍由 descriptorViolation 把关。未知多余属性放行(向前兼容),已知字段类型错才拒。
  spec: z.record(z.string(), z.unknown()).optional(),
  observed: z.record(z.string(), z.unknown()).optional(),
  ready: z.boolean().optional(),
  lockEpoch: z.number().int().nonnegative().optional(),
  // 🔴 §21.1:broker 顶层部署锁 + 完成态镜像字段必须在 schema 里声明,否则 zod 默认 strip 会让
  //    完成方(reconcileAfterProbe)/postcondition 拿不到锁与 lastBuildId/lastOperationId(读不到 = 无法核对同一次会话)。
  deployLockToken: z.string().optional(),
  deployLockExpiresAt: z.number().optional(),
  deployLockOperationId: z.string().optional(),
  lastBuildId: z.string().optional(),
  lastOperationId: z.string().optional(),
  createdBy: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.number().int().optional(),
  // §3.9b 的凭证隔离四字段:这里只做**类型**校验。
  // 🔴 "缺失即拒"发生在**凭证层**(`privileged-cred.requireCredentialIsolationState`),不在这里 ——
  //    描述符层若也强制它们,会把"还没走凭证路径的 target"一并判死(§3.9b 明确它是凭证判定,不是准入位)。
  credentialIsolationState: z.enum(["legacy-seeded", "provisioning", "isolated"]).optional(),
  credentialEpoch: z.number().int().nonnegative().optional(),
  credentialStateUpdatedAt: z.string().optional(),
  provisioningOperationId: z.string().optional(),
  provisioningDeadlineAt: z.string().optional(),
});

/** region 前缀 → partition 的权威映射(SPEC §3.1a 的交叉校验)。导出:register 路由的分区护栏与 aws-context 复用同一映射。 */
export function partitionForRegion(region: string): string {
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

/** ARN 形态:`arn:<partition>:<service>:<region>:<account>:...`。非 ARN 值返回 null。 */
function parseArn(v: unknown): { partition: string; service: string; region: string; accountId: string } | null {
  if (typeof v !== "string" || !v.startsWith("arn:")) return null;
  const seg = v.split(":");
  if (seg.length < 6) return null;
  return { partition: seg[1], service: seg[2], region: seg[3], accountId: seg[4] };
}

// ——————————————————————————————————————————————————————————————
// 🔴 G8(外部审核 v3 P1-2 整改):资源袋的**逐项形态**与**组件↔资源配套**校验
//
// v3 实测到的三个绕过,根子是同一个:我只校验了"非空字符串"。
//   ① `glueRoleArn: "not-an-arn"` —— 非空字符串 ⇒ 过;而 `parseArn` 返回 null 之后
//      归属校验被 `continue` **跳过** ⇒ **越是畸形的 ARN 越不被检查**(方向正好反了);
//   ② `emrSubnetIds: [null]` —— 只判了"数组非空",没判元素;
//   ③ `components:["core","redshift"]` 却没有 redshiftWorkgroup/database/secret ⇒ 声明了组件却无资源,
//      下推到该 target 时才在很远的地方炸。
// ⇒ 定案:**必须是 ARN 的键就强制 ARN 形态**(畸形即拒,不再跳过)、数组逐元素校验、
//    每个可选组件声明对应的必备资源(SPEC §3.1a v3.5)。
// ——————————————————————————————————————————————————————————————

/** 必须是 ARN 的资源键(畸形 ⇒ 直接拒,**不再因为"解析不出来"而跳过归属校验**)。 */
export const ARN_RESOURCE_KEYS = [
  "glueRoleArn",
  "redshiftSecretArn",
  "flinkRoleArn",
  // (SPEC v3.21 §3.1a):三个新执行角色键,**有则必须是合法 ARN**(不追溯存量必填,见 COMPONENT_OPTIONAL_RESOURCES)
  "emrExecutionRoleArn",
  "redshiftCopyRoleArn",
  "dmsKinesisRoleArn",
] as const;

/** 形态校验器:S3 桶名 / 子网 id / SG id / 标识符类名字。 */
const SHAPE = {
  bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  subnetId: /^subnet-[0-9a-f]{8,17}$/,
  sgId: /^sg-[0-9a-f]{8,17}$/,
  /** workgroup / database / namespace / 环境名之类:小写字母数字加 `-`/`_`,长度 1–128。 */
  name: /^[a-z0-9][a-z0-9_-]{0,127}$/i,
} as const;

/** 资源键 → 期望形态。未登记的键不做形态校验(向前兼容:新组件先能写进去,再补规则)。 */
const RESOURCE_SHAPES: Record<string, keyof typeof SHAPE> = {
  datalakeBucket: "bucket",
  scriptsBucket: "bucket",
  tableBucket: "bucket",
  dagBucket: "bucket",
  athenaWorkgroup: "name",
  redshiftWorkgroup: "name",
  redshiftDatabase: "name",
  mwaaEnvName: "name",
  dmsSubnetGroup: "name",
  emrSecurityGroupId: "sgId",
  residencyAuditTable: "name",
  residencyResultsTable: "name",
  residencyBucket: "bucket",
};

/** 组件 → 该组件必备的资源键(SPEC §1.1 的"可选组件字段随组件存在")。 */
const COMPONENT_REQUIRED_RESOURCES: Record<string, readonly string[]> = {
  redshift: ["redshiftWorkgroup", "redshiftDatabase", "redshiftSecretArn"],
  mwaa: ["dagBucket", "mwaaEnvName"],
  dms: ["dmsSubnetGroup"],
  flink: ["flinkRoleArn"],
  // (SPEC v3.22 §1.3a S4 / §1.3 D):residency-api 片 1 的三样实名资源(区域审计表 / 结果表 / 结果桶)。
  "residency-api": ["residencyAuditTable", "residencyResultsTable", "residencyBucket"],
  // (SPEC v3.27 §1.1 / §3.15):定义桶 / 执行角色 / 工作 SG 三样实名资源
  "airflow-serverless": ["workflowBucket", "airflowServerlessRoleArn", "airflowServerlessSgId"],
  // kafka 在 §1.1 里没有实名资源字段 ⇒ 刻意不设不变量(不发明合同)。
};

/**
 * 组件 → 该组件**可选**的资源键(SPEC v3.21 §1.1:`redshiftCopyRoleArn?` / `dmsKinesisRoleArn?`)。
 * 与 `COMPONENT_REQUIRED_RESOURCES` 的差别只有一条:**存量描述符缺它不判死**(否则 tgt_usw2_a 在重新部署前当场不可用)。
 * finalize 从组件栈 Output **读到才写**;「非 home 必须有」这道前置由准入 `hasPerTargetExecRoles`判。
 * 🔴 v1.3 施工包写的「Output 原样进袋、零改动」只对 core 成立 —— 组件栈的 Output 只取合同声明的键(袋子是路由输入,面要窄),
 *    所以新键必须在这里**登记**才流得进来。
 */
export const COMPONENT_OPTIONAL_RESOURCES: Record<string, readonly string[]> = {
  redshift: ["redshiftCopyRoleArn"],
  dms: ["dmsKinesisRoleArn"],
};

/** 数组类资源键 → 元素形态。 */
const ARRAY_RESOURCE_SHAPES: Record<string, keyof typeof SHAPE> = {
  emrSubnetIds: "subnetId",
  flinkSubnetIds: "subnetId",
};

/**
 * 整包校验 + 跨字段不变量(SPEC §3.1a)。
 * 返回 `null` = 通过;否则返回**指名道姓**的原因(要能直接照着修,不能只说"校验失败")。
 */
export function descriptorViolation(item: unknown, expectedTargetId: string): string | null {
  const parsed = DescriptorSchema.safeParse(item);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return `描述符 schema 不合法:${first?.path?.join(".") || "(根)"} —— ${first?.message}`;
  }
  const t = parsed.data;

  // 身份三等:防"查 A 拿到 B"与"键值/属性漂移"。
  if (t.sk !== t.targetId) return `sk(${t.sk})与 targetId(${t.targetId})不一致`;
  if (t.targetId !== expectedTargetId) return `描述符 targetId(${t.targetId})不是请求的 ${expectedTargetId}`;
  if (!isValidTargetId(t.targetId)) return `targetId 格式非法:${t.targetId}`;

  // home 不变量:互斥两侧都要挡 —— 既挡"伪装 home",也挡"home 被标成外法域"。
  const literalHome = isHome(t.targetId);
  if (literalHome !== (t.isHome === true)) {
    return `home 不变量违反:targetId=${t.targetId} 但 isHome=${String(t.isHome)}(两者必须同真同假)`;
  }
  if (literalHome && (t.jurisdiction ?? "home") !== "home") {
    return `home 的 jurisdiction 必须是 home,实为 ${t.jurisdiction}`;
  }

  // 分区 ↔ region 交叉一致(错分区会让 ARN 拼错、跨境判断错)。
  const expectPartition = partitionForRegion(t.region);
  if (t.partition !== expectPartition) {
    return `partition(${t.partition})与 region(${t.region})不一致,应为 ${expectPartition}`;
  }

  // core 完整性:准入时 components 必填必含 core、core 资源必须齐。
  const components = t.components;
  if (!components || components.length === 0) return "components 缺失或为空(准入要求必填且必含 core)";
  const unknownComp = components.filter((c) => !(TARGET_COMPONENTS as readonly string[]).includes(c));
  if (unknownComp.length) return `components 含未知组件:${unknownComp.join(",")}`;
  if (!components.includes("core")) return `components 不含 core:${components.join(",")}`;

  const res = t.resources ?? {};
  const missing = REQUIRED_CORE_RESOURCES.filter((k) => {
    const v = res[k];
    return typeof v !== "string" || v.length === 0;
  });
  if (missing.length) return `core 资源缺失:${missing.join(", ")}(SPEC §1.1 core 袋)`;

  // 🔴 组件 ↔ 资源配套(v3 P1-2 ③):声明了组件就必须有它的实名资源。
  for (const comp of components) {
    for (const key of COMPONENT_REQUIRED_RESOURCES[comp] ?? []) {
      const v = res[key];
      if (typeof v !== "string" || !v) {
        return `components 含 ${comp} 但 resources.${key} 缺失(SPEC §1.1:可选组件字段随组件存在)`;
      }
    }
  }
  if (components.includes("agentcore")) {
    const ac = t.agentcore ?? {};
    for (const key of ["genbiRuntimeArn", "genbiMemoryId", "gatewayUrl"]) {
      if (typeof ac[key] !== "string" || !ac[key]) {
        return `components 含 agentcore 但 agentcore.${key} 缺失(SPEC §1.1)`;
      }
    }
  }

  // 🔴 数组类资源逐元素校验(v3 P1-2 ②:`emrSubnetIds:[null]` 曾因"数组非空"而放行)。
  for (const [key, shape] of Object.entries(ARRAY_RESOURCE_SHAPES)) {
    const v = res[key];
    if (v === undefined) {
      if (key === "emrSubnetIds") return "core 资源缺失:emrSubnetIds(至少 1 个子网)";
      continue; // flinkSubnetIds 在 §1.1 里是可选
    }
    if (!Array.isArray(v) || v.length === 0) return `resources.${key} 必须是非空数组`;
    const bad = v.filter((x) => typeof x !== "string" || !SHAPE[shape].test(x));
    if (bad.length) {
      return `resources.${key} 含形态非法的元素:${JSON.stringify(bad[0])}(要求 ${SHAPE[shape].source})`;
    }
  }

  // 🔴 标量资源的形态校验(v3 P1-2:此前只判"非空字符串")。
  for (const [key, shape] of Object.entries(RESOURCE_SHAPES)) {
    const v = res[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !SHAPE[shape].test(v)) {
      return `resources.${key} 形态非法:${JSON.stringify(v)}(要求 ${SHAPE[shape].source})`;
    }
  }

  // 🔴 必须是 ARN 的键:**畸形即拒**。
  // 旧实现在这里跳过(`parseArn` 返回 null 就 `continue`)⇒ 越畸形越不被检查,方向正好反了。
  for (const key of ARN_RESOURCE_KEYS) {
    const v = res[key];
    if (v === undefined) continue;
    if (!parseArn(v)) {
      return `resources.${key} 必须是合法 ARN(arn:<partition>:<service>:<region>:<account>:...),实为 ${JSON.stringify(v)}`;
    }
  }

  // 资源归属:凡 ARN 形态的值,partition/region/account 段必须与本描述符一致。
  for (const [k, v] of Object.entries(res)) {
    const arn = parseArn(v);
    if (!arn) continue;
    if (arn.partition !== t.partition) {
      return `resources.${k} 的 partition(${arn.partition})不属于本 target(${t.partition})`;
    }
    // 全局服务(IAM/S3 等)的 ARN region 段为空 ⇒ 豁免 region 比对,但账号仍要对。
    if (arn.region && arn.region !== t.region) {
      return `resources.${k} 的 region(${arn.region})不属于本 target(${t.region})`;
    }
    if (arn.accountId && arn.accountId !== t.accountId) {
      return `resources.${k} 的账号段不属于本 target`;
    }
  }
  return null;
}

/**
 * 🔴 **seed / 修补完成后的"完整"定义**(SPEC §1.1 v3.5,外部审核 v3 P1-1 整改)。
 *
 * 【为什么必须单独有它】v3 实测:`seedHomeTarget({...,ready:false})` 返回 `created` **并真写库**。
 * 根因不是某个函数写错了,而是**两个函数各自都对、拼起来漏一格**:
 *   · `descriptorViolation` 是为**准入前置**写的 —— 它管"描述符本身合不合法";
 *   · `ready` / `status` 由 `unusableReason` 管 —— 它管"这个 target 现在能不能承接工作"。
 * 我把"完整"实现成了只调前者。**"整包写完"必须同时满足两者**,否则 seed 会永久落下一个
 * `ready:false` 的 item,而条件写保证它再也补不上(P1-1 的原始危害)。
 */
export function descriptorSeedViolation(item: unknown, expectedTargetId: string, now = Date.now()): string | null {
  const violation = descriptorViolation(item, expectedTargetId);
  if (violation) return violation;
  const unusable = unusableReason(item as ExecutionTarget, now);
  if (unusable) return `描述符不是"整包写完可承接工作"的状态:${unusable}`;
  return null;
}

// ——————————————————————————————————————————————————————————————
// 新鲜度(stale)
// ——————————————————————————————————————————————————————————————

function parseIsoMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 描述符年龄(ms)。`null` = **没有可用时间源**。
 * 时间源优先 `probe.at`(真探活),退到 `updatedAt`(至少证明有人在维护它)。
 */
export function descriptorAgeMs(t: ExecutionTarget, now = Date.now()): number | null {
  const probeAt = parseIsoMs(t.probe?.at);
  const ms = probeAt ?? parseIsoMs(t.updatedAt);
  return ms === null ? null : now - ms;
}

/**
 * 🔴 顶层残留部署锁检查(v2 审核 §20.2):必须**早于** classifyDescriptor/收养 ——
 * 一个 legacy-stable item(`observed.operation` 缺失)否则会绕过 operation 校验被准入,
 * 而它其实正被一次在途部署持锁。锁三字段任一存在即视为"有在途会话",fail-closed。
 * (锁的 lease 过期清理 / 恢复-2/4 的 reconciler + 失败恢复;在那之前残留锁 = 不承接,No-Go。)
 */
function activeDeployLockReason(t: ExecutionTarget): string | null {
  return t.deployLockToken !== undefined || t.deployLockExpiresAt !== undefined || t.deployLockOperationId !== undefined
    ? `target 有在途部署锁(deployLockOperationId=${t.deployLockOperationId ?? "?"})—— 不承接新工作直到部署完成/恢复`
    : null;
}

/**
 * 描述符是否可承接新工作;不可用时返回原因字符串(便于把"为什么被拒"讲清楚)。
 *
 * 🔴 **v3.15 改【单一派生判定】**:可服务性由 `(spec, observed)` 派生 —— 存量 legacy item
 * 经 `specObservedOf`→`adoptLegacy` 收养成双轴,再过 `serviceabilityReason`(intent=serve ∧ phase=ready ∧
 * 无破坏性 operation)。**新鲜度仍在本函数**(它持时间源解析 `descriptorAgeMs` + home 豁免,那是准入的另一维)。
 * 顺序:先"有没有" → 再"可服务性(派生)" → 最后"新鲜度";报错取第一条(最根本的原因)。
 * 🔴 拒因末尾附 `(status=<原始 status>)`:既保留旧诊断口径(运维/告警按 status 检索),又不改派生判定本身。
 */
function unusableReason(t: ExecutionTarget | null, now = Date.now()): string | null {
  if (!t) return "注册表里没有该描述符(未注册 / 已删除)";
  // 🔴 v2 审核(§20.2):顶层残留部署锁在 legacy/modern 分流**前**先查(否则 legacy-stable 绕过 operation 校验)。
  const lockReason = activeDeployLockReason(t);
  if (lockReason) return lockReason;
  // 🔴 v2 审核(矛盾 D):三分类 —— invalid(半写/字段坏)在准入侧当"不可用"返回原因(fail-closed),不抛。
  const c = classifyDescriptor(t);
  if (c.kind === "invalid") return `描述符形态非法(fail-closed):${c.reason}`;
  const svc = serviceabilityReason(c.spec, c.observed);
  if (svc) {
    // ready!==true 的存量在 adoptLegacy 里落非 ready 相 ⇒ 这里补一句 ready 诊断(旧口径连续性)。
    const readyHint = t.ready !== true ? `,ready=${String(t.ready)}` : "";
    return `${svc}(status=${t.status}${readyHint})`;
  }

  // 🔴 跨法域 target 的**唯一**技术前置(SPEC §2.1 v3.22 / §3.2;DESIGN §18 决策 6quinquies):
  //    装了 residency-api(区域审计 / 结果存储)+ 本 target 自己的执行角色齐(SPEC §6.1 段二)。
  //    放在准入内核里 ⇒ 管理页「不承接:<原因>」与数据面拒因**逐字同源**;放在这一步(可服务性之后、新鲜度之前)
  //    是因为它比 stale 更根本(缺组件的 target 再新鲜也承接不了)。**没有法务判定**:平台不设法务门。
  const residency = residencyPrerequisite(t);
  if (residency) return residency;

  // 🔴 stale 仅对非 home 生效(SPEC §1.1 v3.4)。理由见该节:home 没有"探活失联"这一失败模式,
  // 且探活写入方才来 —— 若 home 也判 stale,G0 接线当天全平台 fail-closed。
  if (!isHome(t.targetId)) {
    const age = descriptorAgeMs(t, now);
    if (age === null) {
      // 🔴 **绝不"缺时间源=新鲜"**:那是 §3.9b 已禁的"缺状态=legacy"同型错误(负向推断决定放行)。
      return "描述符没有可用的新鲜度时间源(probe.at / updatedAt 都缺失或无法解析)⇒ 判 stale";
    }
    if (age > TARGET_FRESHNESS_MAX_AGE_MS) {
      return `描述符已 stale(距上次探活/更新 ${Math.round(age / 1000)}s > ${TARGET_FRESHNESS_MAX_AGE_MS / 1000}s)`;
    }
    // 🔴 **未来时钟容差**(v3.5):age 为负 = 时间源在未来。旧实现只判 `age > 阈值`,
    // 于是 `probe.at=2999` 让 age 恒为大负数 ⇒ **永远新鲜**,stale gate 被长期关闭(实测坐实)。
    // 方向必须与"缺时间源"一致:**判 stale、fail-closed**。
    if (age < -TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS) {
      return (
        `描述符的时间源在未来(超前 ${Math.round(-age / 1000)}s > 容差 ${TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS / 1000}s)` +
        ` ⇒ 判 stale(探活写入方时钟错误或被写入了未来值;绝不因此放行)`
      );
    }
  }
  return null;
}

// ——————————————————————————————————————————————————————————————
// 读侧
// ——————————————————————————————————————————————————————————————

/**
 * 单点读描述符。
 *
 * 🔴 **`ConsistentRead: true`,而且没有任何缓存**(SPEC §3.1 v3.4)。
 * DDB 默认的最终一致读给不了准入需要的保证:管理面刚把 target 改成 draining,一次最终一致读
 * 仍可能读回旧的 `active`。这一行是 P0-1 的核心修复,**别为了省一次读把它改回默认或加缓存**。
 */
async function readDescriptor(targetId: string): Promise<ExecutionTarget | null> {
  const { Item } = await docClient.send(
    new GetCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      ConsistentRead: true,
    })
  );
  return (Item as ExecutionTarget | undefined) ?? null;
}

/**
 * 读原始描述符,**不做可用性过滤、不做整包校验**。管理面(列表页/部署进度/探活)用这个。
 *
 * 🔴 **刻意不校验**(SPEC §3.1a 的例外条款):运维必须能看到坏 item 才能修它。
 * 运行路径**不要**用它 —— 用 `getTarget()` 或 `requireReadyTarget()`。
 */
export async function getTargetRaw(targetId: string): Promise<ExecutionTarget | null> {
  if (!isValidTargetId(targetId)) return null;
  return readDescriptor(targetId);
}

/** 缺描述符的拒因(内核与 `admit` 的类型兜底共用一份字面量,免得两处措辞悄悄分叉)。 */
const NO_DESCRIPTOR_REASON = "注册表里没有该描述符(未注册 / 已删除)";

/**
 * 🔴 **准入判定的唯一内核**(整包校验 + 可服务性 + 新鲜度,顺序即"最根本的原因优先")。
 *
 * 三个调用方共用它:`admit()`(单点运行路径)、`listActiveTargets()`(扇出下推)、
 * `describeServiceability()`(管理页**只读呈现**)。
 * 🔴 **为什么必须是同一份**:页面写着「可承接新工作」,数据面就一定收;页面写着
 * 「不承接:<原因>」,那句话必须**逐字**是数据面拒绝时给出的同一句。
 * 各写一份 = 两侧悄悄分叉(§20.26c 已经栽过一次:parity 门禁只证"两侧一致"、不证"判得对",
 * 而这里连一致都不会有)。
 * @returns `null` = 可承接;字符串 = 不可承接的原因(第一条、最根本的那条)。
 */
function serviceabilityVerdict(
  raw: ExecutionTarget | null,
  targetId: string,
  now = Date.now(),
  logPrefix = "描述符校验不通过,fail-closed 拒绝"
): string | null {
  if (!raw) return NO_DESCRIPTOR_REASON;
  const violation = descriptorViolation(raw, targetId);
  if (violation) {
    // 告警:这类 item 是"看起来像描述符但不是"的坏数据,静默拒绝会让人查不到原因。
    console.error("[exec-env/registry] %s:%s —— %s", logPrefix, targetId, violation);
    return `描述符校验不通过:${violation}`;
  }
  return unusableReason(raw, now);
}

/** 准入判定:校验 + 可用性,返回 `{target}` 或 `{why}`。两个公开入口共用这一份判定。 */
async function admit(targetId: string): Promise<{ target: ExecutionTarget } | { why: string }> {
  const raw = await readDescriptor(targetId);
  const why = serviceabilityVerdict(raw, targetId);
  // `why === null` 时内核已保证 raw 非空(raw 为 null 它必返回 NO_DESCRIPTOR_REASON);
  // 这里仍显式判一次 raw,是为了不用非空断言把这条不变量藏进类型里。
  if (why !== null || raw === null) return { why: why ?? NO_DESCRIPTOR_REASON };
  return { target: raw };
}

/**
 * 管理页用的**只读**可服务性呈现(4 收尾;根治 ROADMAP 记的"把原因链呈现出来")。
 *
 * 【它买到什么 —— 用真实撞过的场景说】新注册的 region 因为平台 IAM 的 region 条件是**部署时快照**,
 * 探活被 `AccessDenied` ⇒ 完成栅栏收不了口 ⇒ 页面把补充部署整体禁用。用户当时的原话是
 * 「最坏的不是不能用,是**看不出为什么不能用**」。同族还有:15min 没探活被判 stale、残留部署锁、
 * 被排空(intent≠serve)—— 这些**全都不体现在 `status` 徽标上**(徽标是 生命周期×健康 的投影,
 * 不含新鲜度与锁),于是页面会理直气壮地显示「运行中」而数据面其实一律拒收。
 *
 * 🔴 **只读、零写入**:它不改任何字段、不触发探活,只是把内核的判定连同诊断量摆出来。
 *   `status` 投影**照旧**(不为了呈现去改投影语义 —— 那会动到 252 格 parity 的承重面)。
 * 🔴 **不接受调用方传 now**(除测试):否则页面可以传一个假时间把 stale 说成新鲜。
 */
export interface ServiceabilityView {
  /** 数据面此刻会不会收它。 */
  usable: boolean;
  /** 不可承接的原因(逐字 = 数据面拒因);`null` = 可承接。 */
  reason: string | null;
  /** 距上次探活/更新的秒数;`null` = 无可用时间源(那本身就判 stale)。 */
  ageSeconds: number | null;
  /** stale 阈值(秒)—— 页面据此说"NNNs > 900s",不在前端写死数字。 */
  freshnessMaxAgeSeconds: number;
  /** 本 target 是否豁免 stale(仅 home)。页面据此解释"为什么它陈旧也仍可承接"。 */
  staleExempt: boolean;
}

export function describeServiceability(
  raw: ExecutionTarget | null,
  targetId: string,
  now = Date.now()
): ServiceabilityView {
  const reason = serviceabilityVerdict(raw, targetId, now, "管理页只读呈现:描述符校验不通过");
  const ageMs = raw ? descriptorAgeMs(raw, now) : null;
  return {
    usable: reason === null,
    reason,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    freshnessMaxAgeSeconds: TARGET_FRESHNESS_MAX_AGE_MS / 1000,
    staleExempt: isHome(targetId),
  };
}

/**
 * 运行路径专用:可用则返回描述符,**不可用返回 null**(不抛)。
 *
 * 🔴 注意它**不会**回落到 home。调用方拿到 null 只有两条合法出路:
 * 报错给用户,或者(仅当业务语义确实是"没指定就用 home"时)显式改调 `getHomeTarget()`。
 * 绝不要写 `(await getTarget(id)) ?? (await getHomeTarget())` —— 那正是 P0-4 那行的等价物。
 */
export async function getTarget(targetId: string): Promise<ExecutionTarget | null> {
  if (!isValidTargetId(targetId)) return null; // 非法格式在打库前挡掉
  const r = await admit(targetId);
  return "target" in r ? r.target : null;
}

/**
 * fail-closed 版本(SPEC §3.2 的 `requireReadyTarget`):不可用即**抛** `TargetNotReadyError`。
 * 驻留守卫、下推、client 工厂等"拿不到就绝不能继续"的地方用这个。
 */
export async function requireReadyTarget(targetId: string): Promise<ExecutionTarget> {
  assertTargetId(targetId); // 格式非法直接抛,错误信息里带要求
  const r = await admit(targetId);
  if ("target" in r) return r.target;
  throw new TargetNotReadyError(targetId, r.why);
}

/**
 * 翻完所有页。
 *
 * 🔴 单页 `Items` 就返回 = **静默漏 target**(DDB 单次 Query 上限 1MiB),而函数名叫 "list…" ⇒
 * 调用方以为拿到了全部。与 §1.2 把 Scan 改 Query 是同一个理由(外部审核 v2 P2-1)。
 */
async function queryAllPages(
  build: (startKey?: Record<string, unknown>) => QueryCommand
): Promise<ExecutionTarget[]> {
  const out: ExecutionTarget[] = [];
  let startKey: Record<string, unknown> | undefined;
  // 页数上限:纯防御(单分区 target 数量是"部署单元"级别);打到上限说明数据形态出乎预料,宁可报错。
  for (let page = 0; page < 100; page++) {
    const r = (await docClient.send(build(startKey))) as {
      Items?: unknown[];
      LastEvaluatedKey?: Record<string, unknown>;
    };
    out.push(...((r.Items as ExecutionTarget[] | undefined) ?? []));
    if (!r.LastEvaluatedKey) return out;
    startKey = r.LastEvaluatedKey;
  }
  throw new Error("exec-env 列表分页超过 100 页 —— 数据形态异常,拒绝返回可能不完整的结果");
}

/**
 * 全部可承接新工作的 target。控制面列表 / 扇出下推用。
 *
 * 🔴 `ConsistentRead: true`:它会被用于扇出下推(= 准入决定),不能用最终一致读。
 * 校验不通过的 item 一并剔除并告警(与单点准入同一口径,避免"单点拒、列表放"的裂缝)。
 */
export async function listActiveTargets(): Promise<ExecutionTarget[]> {
  const items = await queryAllPages(
    (startKey) =>
      new QueryCommand({
        TableName: TABLES.EXECUTION_ENVS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": PK },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
  );
  const now = Date.now();
  // 🔴 与单点准入**共用内核** `serviceabilityVerdict`(原来这里自己又组合了一遍
  //    `descriptorViolation` + `unusableReason` —— 两份组合就有两份腐烂机会,
  //    "单点拒、列表放"的裂缝正是这么长出来的)。
  return items.filter(
    (t) => !serviceabilityVerdict(t, String((t as { sk?: string }).sk ?? ""), now, "列表里剔除校验不通过的描述符")
  );
}

/**
 * 某 region 有哪些 target(SPEC §1.1:走 GSI `byRegion`,不做全表 Scan)。
 *
 * 🔴🔴 **禁用于准入判定**(SPEC §3.1 v3.4):DDB **GSI 不支持强一致读**,而且本函数**刻意不过滤**
 * 可用性(运维要看到该 region 里失败/正在下线的 target)。扇出下推必须对每个候选**再过一次**
 * `requireReadyTarget()` —— 直接拿这里的结果去下发,等于用最终一致的索引做安全判定。
 */
export async function listTargetsByRegion(region: string): Promise<ExecutionTarget[]> {
  return queryAllPages(
    (startKey) =>
      new QueryCommand({
        TableName: TABLES.EXECUTION_ENVS,
        IndexName: GSI_BY_REGION,
        KeyConditionExpression: "#r = :r",
        ExpressionAttributeNames: { "#r": "region" },
        ExpressionAttributeValues: { ":r": region },
        // 🔴 不设 ConsistentRead:GSI 不支持,设了 AWS 直接报错。这正是"禁用于准入"的物理原因。
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
  );
}

// ——————————————————————————————————————————————————————————————
// home seed(部署期,**不是**读路径自愈)
// ——————————————————————————————————————————————————————————————

/**
 * `seedHomeTarget` 的结果 —— 刻意区分四种,**不把"已存在"一律当成功**。
 *
 * 🔴 v3.5 新增 `conflict-mismatch`(外部审核 v3 P1-1):旧实现只判"已存在的 item 自己合不合法",
 * **从不与本次 seed 的期望值比对** ⇒ 一个**属于别的账号/别的 region** 的 home item 会被判成
 * `already-complete`(实测坐实)。部署脚本因此会以为 seed 成功,而平台连的是另一个账号的资源。
 */
export type SeedOutcome =
  /** 本次写入成功 */
  | { outcome: "created" }
  /**
   * 已存在、通过整包校验、且**位置身份与期望一致**:真正的幂等成功路径。
   * `contentDrift` = 内容类字段(resources/components/capabilities…)与期望的差异清单 ——
   * 🔴 **它不阻断**:运维手工改过 resources 是合法的(这也是"绝不覆盖已有 item"的初衷),
   * 但差异必须**报出来**,不能静默吞掉。
   */
  | { outcome: "already-complete"; contentDrift?: string[] }
  /** 已存在但**校验不过**:必须显式 reconcile,不静默覆盖、也不当成功 */
  | { outcome: "conflict-incomplete"; violation: string; version?: number }
  /** 🔴 已存在且自身合法,但**位置身份**与期望不一致(别的账号/region/partition/法域)⇒ 绝不当成功 */
  | { outcome: "conflict-mismatch"; differences: string[]; version?: number };

/**
 * 🔴 **位置身份字段**:seed 幂等比对时**必须逐字段相等**,不一致即 `conflict-mismatch`。
 *
 * 为什么只有这几个是"硬比对":它们决定**这个描述符指向哪个账号、哪个区域、哪个法域** ——
 * 不一致意味着"库里那个 home 根本不是我这次要 seed 的 home",继续跑下去平台会连到别处。
 * 而 `resources`/`components` 之类是**内容**:运维可能合法地手工改过,差异只报不拦。
 */
const SEED_IDENTITY_FIELDS = ["partition", "accountId", "region", "jurisdiction", "cellId", "stage"] as const;

/** 内容类字段:差异只报告(`contentDrift`),不阻断。 */
const SEED_CONTENT_FIELDS = ["resources", "components", "capabilities", "displayName", "agentcore"] as const;

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/**
 * home 描述符的**部署期** seed(SPEC §1.1 v3.4)。
 *
 * 🔴 与旧 `ensureHomeTarget()` 的三处关键区别:
 *   ① **入参是完整实名描述符**,不再从 env 猜(旧实现读 `REDSHIFT_SECRET_ID` 这个 CDK 从未注入的 env);
 *   ② **写前过整包校验**,校验不过**不写**(旧实现直接写 `accountId=""` + 缺 core 资源 + `ready=true`);
 *   ③ **`ConditionalCheckFailed` 不再一律当成功** —— 回读比对:已存在且合格才算幂等成功,
 *      已存在但不合格返回 `conflict-incomplete`(旧实现会把"库里有个坏 item"静默当成"seed 成功",
 *      而条件写又保证它**永远补不上** = 永久锁死)。
 *
 * 🔴 **谁调它**:部署期收尾(从 CFN Outputs / 实时查询组装描述符)。该调用方另有归属
 * (`emrSecurityGroupId` 须运行时查询、`components` 取决于真实部署清单)。**在它落地前 home 不会被 seed,
 * `getHomeTarget()` 恒 fail-closed —— 这是刻意的**(G 批零生产调用方 ⇒ 零行为变化)。
 */
export async function seedHomeTarget(
  descriptor: Omit<ExecutionTarget, "pk" | "sk" | "targetId" | "isHome"> & { isHome?: true }
): Promise<SeedOutcome> {
  const item: ExecutionTarget = {
    ...descriptor,
    pk: PK,
    sk: HOME_TARGET_ID,
    targetId: HOME_TARGET_ID,
    isHome: true,
    jurisdiction: descriptor.jurisdiction ?? "home",
    updatedAt: descriptor.updatedAt ?? new Date().toISOString(),
    version: descriptor.version ?? 1,
  };
  // 🔴 v3.5:用 `descriptorSeedViolation`(= 整包校验 **+** "整包写完可承接工作")。
  // 只用 `descriptorViolation` 是 v3 P1-1 的根因:它不管 `ready`/`status`,于是 `ready:false` 照样写进去。
  const violation = descriptorSeedViolation(item, HOME_TARGET_ID);
  if (violation) {
    throw new Error(
      `拒绝 seed home 描述符:${violation}。` +
        `seed 必须传【完整实名且 ready=true、status 可承接工作】的描述符(SPEC §1.1 v3.5);` +
        `不完整就写 = 落下一个补不上的坏 item,并被条件写永久锁死(外部审核 v2 P1-1 / v3 P1-1)`
    );
  }
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Item: item,
        // **绝不覆盖**已有 item:运维可能手工改过 resources,一次无害的"自愈"把它冲掉才是真事故。
        ConditionExpression: "attribute_not_exists(sk)",
      })
    );
    return { outcome: "created" };
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
  }
  // 已存在 ⇒ 强一致回读,并**与本次期望值比对**(v3 P1-1:旧实现只判它自己合不合法)。
  const existing = await readDescriptor(HOME_TARGET_ID);
  if (!existing) {
    return { outcome: "conflict-incomplete", violation: "条件写说已存在,但强一致回读为空(并发删除?)" };
  }
  const existingViolation = descriptorSeedViolation(existing, HOME_TARGET_ID);
  if (existingViolation) {
    return { outcome: "conflict-incomplete", violation: existingViolation, version: existing.version };
  }
  // 🔴 v3.7(外部审核 v4 P2-1):比较前**规范化可默认字段**。
  // `jurisdiction` 缺省即 `home`(§1.1),而 `descriptorViolation` 也是这么解释的;
  // 若按 raw 值比,一个**语义合法、只是省略了该字段**的历史 home item 会被误判 `conflict-mismatch`
  // ⇒ 部署/恢复 seed 变成不幂等(白挡一次部署)。规范化只作用于"有明确缺省语义"的字段。
  const normalize = (o: Record<string, unknown>): Record<string, unknown> => ({
    ...o,
    jurisdiction: o.jurisdiction ?? "home",
  });
  const ex = normalize(existing as unknown as Record<string, unknown>);
  const want = normalize(item as unknown as Record<string, unknown>);
  const differences = SEED_IDENTITY_FIELDS.filter((k) => stableJson(ex[k]) !== stableJson(want[k])).map(
    (k) => `${k}: 库里=${stableJson(ex[k])} 期望=${stableJson(want[k])}`
  );
  if (differences.length) {
    // 🔴 位置身份不一致 = "库里那个 home 根本不是我要 seed 的这个"。绝不当幂等成功。
    return { outcome: "conflict-mismatch", differences, version: existing.version };
  }
  const contentDrift = SEED_CONTENT_FIELDS.filter((k) => stableJson(ex[k]) !== stableJson(want[k])).map(
    (k) => `${k} 与期望不同(运维手工改过?)`
  );
  return contentDrift.length ? { outcome: "already-complete", contentDrift } : { outcome: "already-complete" };
}

/**
 * 🔴🔴 **`reconcileTarget` 的允许列表**(SPEC §1.1 v3.5;外部审核 v3 P1-1 的 N1 整改)。
 *
 * 【为什么从黑名单改成允许列表 —— 这是本轮最重的一条教训】
 * 上一版只禁了 `pk/sk/targetId/ready`,于是这个"修补存量描述符"的通用函数**顺带**能改:
 *   · `credentialIsolationState` ⇒ 能把 §3.9b 刚立的**单调不可逆**状态机 `isolated → legacy-seeded`
 *     **改回去**(实测 UpdateCommand 正常发出)—— 等于给刚焊上的安全门配了一把后门,
 *     **比它修掉的问题更严重**;
 *   · `accountId` / `region` / `partition` ⇒ 静默把一个 target 指向**另一个账号/区域**;
 *   · `jurisdiction` ⇒ 静默改变**跨法域**判定(§3.2 驻留守卫的授权输入);
 *   · `version` ⇒ 与内部乐观锁的 `SET` 冲突,同一属性在表达式里出现两次。
 * 根因是**方向**:安全承重面上"列出禁止项"永远漏,必须"列出允许项"。
 *
 * 允许集**由合同反推**(不是我想到哪些算哪些):`reconcileTarget` 的唯一用途是
 * §1.1 的"存量不完整 item 用带条件的 reconcile 更新**修补**" ⇒ 只允许**内容类**字段。
 * 位置身份(partition/accountId/region/cellId/stage)、法域、生命周期(status)、
 * fencing(lockEpoch)、整包标志(ready)、乐观锁(version)、凭证状态机(§3.9b 五字段)**全部不在内**;
 * 它们各有专门通道:注册(§2.1 register)、生命周期(§3.5 broker/drain)、
 * 凭证迁移(`advanceCredentialIsolationState`,见下)。
 */
export const RECONCILE_ALLOWED_FIELDS = [
  "resources",
  "components",
  "capabilities",
  "displayName",
  "desiredVersion",
  "observedVersion",
  "agentcore",
  "probe",
] as const;

/**
 * 🔴 **允许被 reconcile 修补的 `status`(= "维修态")**,SPEC §1.1 v3.7。
 *
 * 反面清单更能说明问题:**`active` / `draining` / `decommissioning` / `deleted` 一律不许**。
 * 理由(外部审核 v4 P1-2):`resources` 是**路由输入**、`probe` 是**新鲜度输入** ——
 * 对一个**正在承接流量**的 target 改这两样等于**在线改路由**,还绕过了整条生命周期闸;
 * 对 `draining` 的改更糟(它正要被销毁,任何"修补"只会让销毁前的三段校验看到不一致的东西)。
 */
export const RECONCILE_ALLOWED_STATUS: readonly TargetStatus[] = [
  "registered",
  "initializing",
  "testing",
  "upgrading",
  "degraded",
  "failed",
];

/**
 * 修补存量不完整描述符(SPEC §1.1 v3.7:**`version` + `ready=false` + `status ∈ 维修态`** 条件)。
 *
 * 🔴 **v3.7 三处收紧(外部审核 v4 P1-2)**:
 *   ① 条件表达式**不再只有 `version`** —— 同时绑 `ready = false` 与 `status ∈ 维修态`。
 *      上一版只有 `version` ⇒ 读一下当前 version 就能对 `active/ready=true` 的 target **在线改路由**,
 *      下一次强一致读立刻采用新 `resources` / 伪造的新鲜 `probe`,而**不需要它进入任何维修态**。
 *   ② **合并后的 candidate 整包过 §3.1a 校验**再写。只校验 patch 片段挡不住"片段各自合法、
 *      合起来违反跨字段不变量"(把 `glueRoleArn` 换到别的账号、或删掉某组件的配套资源)。
 *      为此需要**先强一致读当前 item**(多一次读换一次不可回退的错误写,值得)。
 *   ③ 🔴 **合同曾被我改去迁就实现**:v3.6 把 SPEC 的"`version`/`status` 条件"删成只要 `version`。
 *      那是**反向操作**(合同是唯一权威,对不上该改实现)。已改回合同并在此补足实现。
 *
 * 🔴 仍然**不在这里置 `ready`** —— `ready` 是"整包写完"的标志,由补齐的那一方补完后单独置位。
 */
export async function reconcileTarget(
  targetId: string,
  patch: Partial<Omit<ExecutionTarget, "pk" | "sk" | "targetId">>,
  opts: { expectedVersion: number; finalizeFence?: FinalizeLifecycleFence }
): Promise<void> {
  assertTargetId(targetId);
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error("reconcileTarget 的 patch 为空");
  const notAllowed = keys.filter((k) => !(RECONCILE_ALLOWED_FIELDS as readonly string[]).includes(k));
  if (notAllowed.length) {
    throw new Error(
      `reconcileTarget 只允许修补内容类字段 ${RECONCILE_ALLOWED_FIELDS.join("/")};被拒:${notAllowed.join(",")}。` +
        `身份/位置/法域走 §2.1 register;status/lockEpoch 走 §3.5 生命周期;` +
        `ready 须补齐后单独置位;凭证状态走 advanceCredentialIsolationState(§3.9b,单调不可逆)`
    );
  }

  // ── ② post-image 校验:先强一致读当前 item,合并 patch 后整包校验
  const current = await readDescriptor(targetId);
  if (!current) throw new Error(`reconcileTarget:target ${targetId} 不存在`);
  if (current.ready === true || !RECONCILE_ALLOWED_STATUS.includes(current.status)) {
    throw new Error(
      `reconcileTarget 拒绝:只能修补**维修态**的描述符(要求 ready=false 且 status ∈ ` +
        `${RECONCILE_ALLOWED_STATUS.join("/")}),实为 ready=${String(current.ready)} status=${current.status}。` +
        `对正在承接流量的 target 改 resources/probe = 在线改路由且绕过生命周期闸(SPEC §1.1 v3.7)`
    );
  }

  // 🔴 §21.2:modern axes 同步 —— 通用内容修补(无 fence)可不动 observed;但只要 patch 含部署产出的
  //    components/resources,就必须携 route 初读时已验证成功的 exact deploy fence,并把 observed.components 同步过去。
  const hasSpec = current.spec !== undefined;
  const hasObserved = current.observed !== undefined;
  if (hasSpec !== hasObserved) {
    throw new LifecyclePreconditionError("spec/observed 只存在一侧,拒绝 reconcile");
  }
  const axes = hasSpec ? specObservedOf(current) : undefined;
  if (opts.finalizeFence) assertFinalizeFence(current, opts.finalizeFence);
  const nextObserved =
    axes && Array.isArray(patch.components)
      ? { ...axes.observed, components: orderComponents(patch.components) }
      : undefined;
  const touchesDeploymentResult =
    Object.prototype.hasOwnProperty.call(patch, "components") ||
    Object.prototype.hasOwnProperty.call(patch, "resources");
  if (axes && touchesDeploymentResult && opts.finalizeFence?.kind !== "deploy") {
    throw new LifecyclePreconditionError(
      "modern deployment resources/components 只能在 exact deploy finalize fence 下同步"
    );
  }

  const candidate = {
    ...current,
    ...patch,
    ...(nextObserved ? { observed: nextObserved } : {}),
  } as ExecutionTarget;
  const violation = descriptorViolation(candidate, targetId);
  if (violation) {
    throw new Error(
      `reconcileTarget 拒绝:合并 patch 后的描述符不合法 —— ${violation}。` +
        `(只校验 patch 片段挡不住"片段各自合法、合起来违反跨字段不变量")`
    );
  }

  const names: Record<string, string> = { "#v": "version", "#r": "ready", "#st": "status" };
  const values: Record<string, unknown> = {
    ":expected": opts.expectedVersion,
    ":next": opts.expectedVersion + 1,
    ":false": false,
  };
  RECONCILE_ALLOWED_STATUS.forEach((st, i) => {
    values[`:st${i}`] = st;
  });
  const statusIn = RECONCILE_ALLOWED_STATUS.map((_s, i) => `:st${i}`).join(", ");
  const sets: string[] = ["#v = :next"];
  keys.forEach((k, i) => {
    names[`#k${i}`] = k;
    values[`:k${i}`] = (patch as Record<string, unknown>)[k];
    sets.push(`#k${i} = :k${i}`);
  });
  // 🔴 §21.2:modern initial finalize 经此通道时同步 observed.components(map-path,不重写整 observed,保留 operation)。
  if (nextObserved) {
    names["#observed"] = "observed";
    names["#observedComponents"] = "components";
    values[":observedComponents"] = nextObserved.components;
    sets.push("#observed.#observedComponents = :observedComponents");
  }

  // 🔴 ① 条件同时绑 version + ready 不为 true + status ∈ 维修态(read-then-check 只给好报错;真正防 TOCTOU 是这行)。
  //    集成缝:`#r = :false` 用 `(attribute_not_exists(#r) OR #r = :false)`(register 刻意不写 ready,缺失=false 同义)。
  //    §21.2:再附加 route 传入的 finalize fence(不从 axes.observed.operation 重新生成)。
  const conditions = [
    "attribute_exists(sk)",
    "#v = :expected",
    "(attribute_not_exists(#r) OR #r = :false)",
    `#st IN (${statusIn})`,
  ];
  if (opts.finalizeFence) {
    appendFinalizeFence(names, values, conditions, opts.finalizeFence);
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

// ——————————————————————————————————————————————————————————————
// 🔴 home 组件**只增采纳**通道(SPEC v3.28 §1.1 / §2.1 seed-home)
// ——————————————————————————————————————————————————————————————

/**
 * home 已存在且在服务(active / ready)时,把**控制面新建的组件**(如 deploy-all 6.6 的 BgpAirflowServerlessStack)采纳进描述符。
 *
 * 【为什么需要】home 的组件由控制面栈建、不经 broker ⇒ 没有部署会话 / finalize fence 可带,借不了 `mergeComponentResources`;
 * `reconcileTarget` 是维修态门(ready=false 且 status ∈ 维修态),对 active 的 home 必拒 —— 真环境(首刀):
 * `POST seed-home` 走 reconcileTarget ⇒ HTTP 500「只能修补维修态」,home 永远声称不了 airflow-serverless。
 * 那道门的理由是「对正在承接流量的 target **改** resources = 在线改路由」,对**加**不成立(与 mergeComponentResources 同一论证)。
 *
 * 【五条硬约束(缺一条就是 reconcile 的后门)】
 *   ① 只 home;
 *   ② 只增不改:组件集只增(摘组件即拒)、资源键只许 §3.1a 组件私有键且既有键值不等即拒(core / base 键碰不到);
 *   ③ `spec.desiredComponents` / `observed.components` / `components` **三处同步**(broker 校 observed ⊆ desired 与顶层投影一致);
 *   ④ 本次**真探全绿且覆盖全部组件**才写(`isGreenProbeForComponents`;probe 一并落库),post-image 过 §3.1a 整包校验;
 *   ⑤ 条件写:version 乐观锁 ∧ ready 仍 true ∧ 无在途 operation ∧ 无部署锁。
 */
export async function adoptHomeComponents(input: {
  components: string[];
  resources: Record<string, unknown>;
  expectedVersion: number;
  probe: ProbeResult;
}): Promise<{ changed: boolean; added: string[]; addedResources: string[] }> {
  if (!Number.isInteger(input?.expectedVersion)) {
    throw new LifecyclePreconditionError(`expectedVersion 须为整数(收到 ${String(input?.expectedVersion)})`);
  }
  const current = await getTargetRaw(HOME_TARGET_ID);
  if (!current) throw new LifecyclePreconditionError("home 描述符不存在 —— 采纳通道只服务已 seed 的 home");
  if (current.ready !== true || current.status !== "active") {
    throw new LifecyclePreconditionError(
      `adoptHomeComponents 只服务在服务中的 home(ready=true ∧ status=active);实为 ready=${String(current.ready)} status=${current.status} —— 维修态走 reconcileTarget`
    );
  }
  if (current.version !== input.expectedVersion) {
    throw new LifecyclePreconditionError(`版本已变(读到 ${String(current.version)} ≠ 期望 ${input.expectedVersion})—— 有并发操作,请重试`);
  }
  const hasSpec = current.spec !== undefined;
  const hasObserved = current.observed !== undefined;
  if (hasSpec !== hasObserved) throw new LifecyclePreconditionError("spec/observed 只存在一侧,拒绝采纳");
  const axes = hasSpec ? specObservedOf(current) : undefined;
  if (axes?.observed.operation || current.deployLockOperationId !== undefined) {
    throw new LifecyclePreconditionError("home 有在途部署会话 / 部署锁,采纳组件会与之互咬;等它收口后再试");
  }
  const existing = (current.resources ?? {}) as Record<string, unknown>;
  const existingComponents = Array.isArray(current.components) ? current.components.filter((c) => typeof c === "string") : [];

  // ② 只增不改
  const additions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.resources ?? {})) {
    const before = existing[k];
    if (before !== undefined) {
      if (JSON.stringify(before) !== JSON.stringify(v)) {
        throw new LifecyclePreconditionError(
          `拒绝改写 home 已有资源 resources.${k}(${JSON.stringify(before)} → ${JSON.stringify(v)})—— 采纳通道**只增不改**;改既有资源须走维修态`
        );
      }
      continue;
    }
    if (!COMPONENT_OWNED_RESOURCE_KEYS.has(k)) {
      throw new LifecyclePreconditionError(`拒绝经采纳通道新增非组件资源键 resources.${k} —— 只许 §3.1a 组件配套映射里的键(core/base 资源要变必须走维修态)`);
    }
    additions[k] = v;
  }
  const dropped = existingComponents.filter((c) => !input.components.includes(c));
  if (dropped.length) {
    throw new LifecyclePreconditionError(`拒绝经采纳通道摘掉 home 组件:${dropped.join(", ")} —— 摘组件不是「采纳」`);
  }
  const mergedRaw = [...existingComponents, ...input.components].filter((c, idx, arr) => arr.indexOf(c) === idx);
  const merged = orderComponents(mergedRaw);
  const added = merged.filter((c) => !existingComponents.includes(c));
  const componentsChanged = added.length > 0 || JSON.stringify(merged) !== JSON.stringify(orderComponents(existingComponents));
  if (Object.keys(additions).length === 0 && !componentsChanged) return { changed: false, added: [], addedResources: [] };

  // ④ 真探必须全绿且覆盖合并后的全部组件(声称一个没探过的组件 = 撒谎)
  const probe = parseProbeResult(input.probe);
  if (probe.ok !== true || !isGreenProbeForComponents(merged, probe.items)) {
    throw new LifecyclePreconditionError(
      `采纳前真探未全绿或未覆盖全部组件(${merged.join(", ")})—— seed-home 必须先对候选整包真探再采纳`
    );
  }
  const nextObserved = axes ? { ...axes.observed, components: merged } : undefined;
  const nextSpec = axes ? { ...axes.spec, desiredComponents: merged } : undefined;
  const candidate = {
    ...current,
    resources: { ...existing, ...additions },
    components: merged,
    probe,
    ...(nextObserved ? { observed: nextObserved } : {}),
    ...(nextSpec ? { spec: nextSpec } : {}),
  } as ExecutionTarget;
  const violation = descriptorViolation(candidate, HOME_TARGET_ID);
  if (violation) throw new LifecyclePreconditionError(`拒绝采纳:合并后 home 描述符整包校验不过 —— ${violation}`);

  const names: Record<string, string> = {
    "#r": "ready",
    "#v": "version",
    "#comp": "components",
    "#probe": "probe",
    "#observed": "observed",
    "#op": "operation",
    "#lock": "deployLockOperationId",
  };
  const values: Record<string, unknown> = {
    ":true": true,
    ":expected": input.expectedVersion,
    ":next": input.expectedVersion + 1,
    ":comp": merged,
    ":probe": probe,
    ":t": new Date().toISOString(),
  };
  const sets = ["#comp = :comp", "#probe = :probe", "#v = :next", "updatedAt = :t"];
  if (nextObserved && nextSpec) {
    names["#observedComponents"] = "components";
    names["#spec"] = "spec";
    names["#desired"] = "desiredComponents";
    values[":observedComponents"] = nextObserved.components;
    values[":desired"] = nextSpec.desiredComponents;
    sets.push("#observed.#observedComponents = :observedComponents", "#spec.#desired = :desired");
  }
  let resourceIndex = 0;
  for (const [key, value] of Object.entries(additions)) {
    if (resourceIndex === 0) names["#res"] = "resources";
    names[`#resourceKey${resourceIndex}`] = key;
    values[`:resourceValue${resourceIndex}`] = value;
    sets.push(`#res.#resourceKey${resourceIndex} = :resourceValue${resourceIndex}`); // map-path 只增该键,不碰兄弟键
    resourceIndex++;
  }
  // ⑤ 读后条件写
  const conditions = ["attribute_exists(sk)", "#v = :expected", "#r = :true", "attribute_not_exists(#observed.#op)", "attribute_not_exists(#lock)"];
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: HOME_TARGET_ID },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecyclePreconditionError("采纳写入被条件拒绝:期间出现并发操作(版本变化 / 在途部署会话 / ready 变化)—— 请重试");
    }
    throw error;
  }
  return { changed: true, added, addedResources: Object.keys(additions) };
}

// ——————————————————————————————————————————————————————————————
// 🔴🔴 **摘除组件**(component retirement)—— 组件在现网被真的删掉之后,描述符停止声称它
// ——————————————————————————————————————————————————————————————
//
// 【为什么必须有这个动作(2026-09-14 真环境撞出来的缺口)】
//   用户拍板把经典 MWAA 从部署里去掉、我把 `BgpMwaaStack` 删干净之后,home 的描述符里还写着
//   `mwaa` ⇒ 周期 reconciler 探活发现它不在 ⇒ home 永久 `status=degraded`;而**两条既有修复路径都拒**:
//     · `adoptHomeComponents` 要求 `status=active`(现在是 degraded)且明写「摘组件不是采纳」;
//     · `reconcileTarget` 是维修态门,要求 `ready=false`(现在 ready=true)。
//   ⇒ 描述符卡在「声称一个不存在的组件」这个态里,**唯一出路只剩手改 DDB —— 而那是红线**。
//   平台支持「补充部署」(加组件)却没有反向动作,这是设计缺口而不是使用错误。
//
// 【安全条件(缺一条就是给自己开后门)】
//   ① 不许摘 `core`(它恒装,摘了描述符必非法);
//   ② 🔴 **必须有一次真探证明它真的不在了** —— 该组件在 probe 里必须是**红的**。
//      反过来(探活是绿的却摘掉)= 把一个活着的组件从平台视野里藏起来,比不摘危险得多;
//   ③ 摘掉后**只丢该组件私有的资源键**(remaining 组件仍需要的键一个都不动);
//   ④ 三处同步:`components` / `spec.desiredComponents` / `observed.components`(与采纳通道同一纪律);
//   ⑤ post-image 必须过 §3.1a 整包校验;
//   ⑥ 条件写:version 乐观锁 ∧ 无在途 operation ∧ 无部署锁。
export class ComponentRetirementRefused extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ComponentRetirementRefused";
  }
}

/** 摘掉这些组件后,哪些资源键会随之丢掉(= 它们要求的键里,**没有任何留下来的组件**还要的)。 */
export function resourceKeysFreedByRetiring(
  allComponents: readonly string[],
  retiring: readonly string[]
): string[] {
  const remaining = allComponents.filter((c) => !retiring.includes(c));
  const stillNeeded = new Set<string>();
  for (const c of remaining) for (const k of COMPONENT_REQUIRED_RESOURCES[c] ?? []) stillNeeded.add(k);
  const freed = new Set<string>();
  for (const c of retiring) for (const k of COMPONENT_REQUIRED_RESOURCES[c] ?? []) if (!stillNeeded.has(k)) freed.add(k);
  return Array.from(freed).sort();
}

export async function retireComponents(input: {
  targetId: string;
  components: string[];
  expectedVersion: number;
  probe: ProbeResult;
}): Promise<{ retired: string[]; freedResources: string[]; statusAfter: string }> {
  const retiring = Array.from(new Set((input.components ?? []).filter((c) => typeof c === "string" && c)));
  if (retiring.length === 0) throw new ComponentRetirementRefused("没给要摘的组件");
  if (retiring.includes("core")) throw new ComponentRetirementRefused("`core` 恒装,摘掉它描述符必非法 —— 拒绝");
  if (!Number.isInteger(input?.expectedVersion)) {
    throw new ComponentRetirementRefused(`expectedVersion 须为整数(收到 ${String(input?.expectedVersion)})`);
  }
  const current = await getTargetRaw(input.targetId);
  if (!current) throw new ComponentRetirementRefused(`注册表里没有 ${input.targetId}`);
  if (current.version !== input.expectedVersion) {
    throw new ComponentRetirementRefused(`版本已变(读到 ${String(current.version)} ≠ 期望 ${input.expectedVersion})—— 有并发操作,请重读后重试`);
  }
  const axes = current.spec !== undefined && current.observed !== undefined ? specObservedOf(current) : undefined;
  if (axes?.observed.operation || current.deployLockOperationId !== undefined) {
    throw new ComponentRetirementRefused("该执行环境有在途部署会话 / 部署锁 —— 等它收口后再摘组件");
  }
  const existing = Array.isArray(current.components) ? current.components.filter((c): c is string => typeof c === "string") : [];
  const notThere = retiring.filter((c) => !existing.includes(c));
  if (notThere.length) throw new ComponentRetirementRefused(`这些组件本来就不在描述符里:${notThere.join("、")}`);
  // ② —— 🔴🔴 不提供精简形态:完整组件集里的组件**一个都不许摘**
  //   (摘掉 = 把环境变成精简形态)。组件真坏了的出路是〔补齐缺失组件〕/ 重新部署,不是从描述符里藏起来。
  //   能摘的只剩要求集以外的存量组件(如已停供的 mwaa)。
  const requiredHere = requiredComponentsForTarget(current);
  const protectedOnes = retiring.filter((c) => requiredHere.includes(c));
  if (protectedOnes.length) {
    throw new ComponentRetirementRefused(
      `${protectedOnes.join("、")} 属于该执行环境的完整组件集,不许摘(每个执行环境都必须装齐,不提供精简形态)` +
        `—— 组件坏了请对该环境〔重新部署〕或〔补齐缺失组件〕`
    );
  }

  // ② 🔴 真探必须 **positively 证明它不在了**。
  //    2026-09-14 真环境教训:这里第一版写的是 `isGreenProbeForComponents([c], probe.items)` ——
  //    那个函数问的是**另一个问题**(整份探活全绿且恰好只覆盖该集合),于是守卫**等于没有**,
  //    我的负向控制当场把一个**还活着的 redshift 摘掉了**。判据必须钉性质,用专用谓词。
  const probe = parseProbeResult(input.probe);
  const notProven = retiring.filter((c) => !probeSaysComponentGone(c, probe.items));
  if (notProven.length) {
    throw new ComponentRetirementRefused(
      `这次真探**没有证明**这些组件已经不在了:${notProven.join("、")}。` +
        `只有当该组件自己的探活项存在且至少一项是红的,才算证明;` +
        `探活全绿 = 它还活着(摘掉活组件 = 把它从平台视野里藏起来),一个探活项都没有 = 不知道(不许拿「没消息」当「没了」)。` +
        `请先真的删掉那些资源、让探活变红,再来摘。`
    );
  }

  const nextComponents = orderComponents(existing.filter((c) => !retiring.includes(c)));
  const freed = resourceKeysFreedByRetiring(existing, retiring);
  const nextResources: Record<string, unknown> = { ...((current.resources ?? {}) as Record<string, unknown>) };
  for (const k of freed) delete nextResources[k];

  const candidate = {
    ...current,
    components: nextComponents,
    resources: nextResources,
    probe,
    ...(axes ? { observed: { ...axes.observed, components: nextComponents }, spec: { ...axes.spec, desiredComponents: nextComponents } } : {}),
  } as ExecutionTarget;
  const violation = descriptorViolation(candidate, input.targetId);
  if (violation) throw new ComponentRetirementRefused(`摘除后描述符整包校验不过 —— ${violation}`);

  // 摘完之后剩下的组件若全绿 ⇒ 回到 active(这正是本动作要修的那个 degraded)
  const statusAfter = probe.ok === true && isGreenProbeForComponents(nextComponents, probe.items) ? "active" : String(current.status);

  const names: Record<string, string> = {
    "#v": "version", "#comp": "components", "#probe": "probe", "#res": "resources",
    "#observed": "observed", "#op": "operation", "#lock": "deployLockOperationId", "#st": "status",
  };
  const values: Record<string, unknown> = {
    ":expected": input.expectedVersion, ":next": input.expectedVersion + 1,
    ":comp": nextComponents, ":probe": probe, ":t": new Date().toISOString(), ":st": statusAfter,
  };
  const sets = ["#comp = :comp", "#probe = :probe", "#v = :next", "updatedAt = :t", "#st = :st"];
  const removes: string[] = [];
  freed.forEach((key, i) => {
    names[`#freed${i}`] = key;
    removes.push(`#res.#freed${i}`);
  });
  if (axes) {
    names["#observedComponents"] = "components";
    names["#spec"] = "spec";
    names["#desired"] = "desiredComponents";
    values[":comp2"] = nextComponents;
    sets.push("#observed.#observedComponents = :comp2", "#spec.#desired = :comp2");
  }
  const expr = `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : "");
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: input.targetId },
        UpdateExpression: expr,
        ConditionExpression: ["attribute_exists(sk)", "#v = :expected", "attribute_not_exists(#observed.#op)", "attribute_not_exists(#lock)"].join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new ComponentRetirementRefused("摘除写入被条件拒绝:期间出现并发操作(版本变化 / 在途部署会话)—— 请重读后重试");
    }
    throw error;
  }
  return { retired: retiring, freedResources: freed, statusAfter };
}

// ——————————————————————————————————————————————————————————————
// 🔴 凭证隔离状态迁移(§3.9b 的**唯一**写通道)
// ——————————————————————————————————————————————————————————————

/** §3.9b:**只有**这两条前进边合法。刻意用"前态 → 后态"的显式表,而不是数组下标比较。 */
const CREDENTIAL_STATE_FORWARD: Record<string, string> = {
  "legacy-seeded": "provisioning",
  provisioning: "isolated",
};

export class CredentialTransitionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialTransitionRejected";
  }
}

/**
 * `provisioningDeadlineAt` 的**唯一校验口**(§3.9b「deadline 必须可执行」)。
 *
 * 🔴 为什么抽出来:有**两个**写入点会写这个字段 —— ① `registerTarget` 的**初始写**
 * (新 target 从 `provisioning` 起,见该函数的订正说明);② `advanceCredentialIsolationState`
 * 的状态迁移。两处各写一份校验 = 下一处漂移源(其中一处漏判"必须在未来"就等于开了一个
 * 一进去就过期、或永不过期的窗口)。⇒ 单一作者。
 *
 * 判据逐条来自 §3.9b:严格解析 + **必须在未来** + **不得超过 `PROVISIONING_MAX_WINDOW_MS`**。
 */
export function assertProvisioningDeadline(raw: string | undefined, now: number): string {
  if (!raw) {
    throw new CredentialTransitionRejected(
      "进入 provisioning 必须带 provisioningDeadlineAt(§3.9b:回落不得无期限,超时须告警)"
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new CredentialTransitionRejected(
      `provisioningDeadlineAt 无法解析:${JSON.stringify(raw)}(要求 RFC3339/ISO-8601,如 2026-09-30T00:00:00.000Z)`
    );
  }
  if (ms <= now) {
    throw new CredentialTransitionRejected(
      `provisioningDeadlineAt 必须在**未来**:${raw} 已过期 ⇒ 拒绝。` +
        `否则等于开一个「一进去就已过期」的窗口,而读路径会立刻 fail-closed(等于把业务打挂而不是过渡)`
    );
  }
  if (ms - now > PROVISIONING_MAX_WINDOW_MS) {
    throw new CredentialTransitionRejected(
      `provisioningDeadlineAt 超过最大窗口 ${PROVISIONING_MAX_WINDOW_MS / 86_400_000} 天:${raw} ⇒ 拒绝。` +
        `一个很远的 deadline 与「无期限」没有实质区别(§3.9b);供给卡住应告警重新决策,不是把窗口拉长`
    );
  }
  return raw;
}

/**
 * 新注册 target 的 `provisioning` 窗口长度。
 *
 * 取合同允许的**上限**(§3.9b:≤30 天)。理由:刚注册的 target **还没有任何项目负载**
 * ⇒ 窗口内的"回落共享 admin"实际上没有流量;而窗口太短会在运维还没做完供给时就把
 * 刚建好的环境判死。到期即 fail-closed 是**故意**的收敛压力(§3.9b「不可逆收敛计划」),
 * 配套的超时告警在本批的可观测部分接。
 */
export const REGISTER_PROVISIONING_WINDOW_MS = PROVISIONING_MAX_WINDOW_MS;

/**
 * 推进凭证隔离状态(§3.9b 的"允许的迁移"格,**单调不可逆**)。
 *
 * 🔴 为什么必须是**专用 API**、不能借通用 reconcile:
 *   · §3.9b 明写"每次迁移用 DDB `ConditionExpression` 校验**前态 + 当前 epoch**;成功即 `credentialEpoch++`;
 *     **不实现逆向 API**"。通用 patch 做不到这三件里的任何一件 —— 它既不知道前态,
 *     也不会 `++` epoch,更挡不住往回改(这正是 v3 抓到的 N1)。
 *   · epoch `++` 是**缓存正确性的支点**:凭证缓存键含 epoch(§3.9b 缓存规则),epoch 不 ++
 *     就等于状态切了而旧槽仍命中 —— 那是 v2 P0-3 的原始缺陷。
 *
 * 🔴 **没有逆向函数,也不要加**。回滚应用代码**不得**回滚持久化状态(§3.9b 原文)。
 *
 * 🔴 **调用方**(供给层:创建 per-project role/secret → canary → 推进状态)。
 * 本函数只提供**被合同约束住的那一条通道**,免得施工时又去把 reconcile 的口子开大。
 * ⚠️ 如实登记:§3.9b 要求的**审计事件 / 指标 / provisioning 超时告警**不在本函数内 ——
 * 它们需要请求上下文与告警通道,一起接;**在那之前不得声称 §3.9b 的可观测闭环已完成**。
 */
export async function advanceCredentialIsolationState(
  targetId: string,
  opts: {
    /** 期望的当前状态(前态)——写条件的一部分,不是提示 */
    fromState: "legacy-seeded" | "provisioning";
    /** 期望迁移到的状态;必须等于 `CREDENTIAL_STATE_FORWARD[fromState]` */
    toState: "provisioning" | "isolated";
    /** 期望的当前 epoch;不符即拒(fencing:并发的另一次迁移不会被覆盖) */
    expectedEpoch: number;
    /** 进入 `provisioning` 时登记操作号与截止时间(§3.9b:回落不得无期限) */
    operationId?: string;
    provisioningDeadlineAt?: string;
    /** 迁移时间戳;由调用方传入以便审计与本地测试可控 */
    at?: string;
    /** 当前时间(仅测试注入;生产不传)。deadline 的未来性/窗口判定以它为基准。 */
    now?: number;
  }
): Promise<void> {
  assertTargetId(targetId);
  const expectTo = CREDENTIAL_STATE_FORWARD[opts.fromState];
  if (!expectTo || expectTo !== opts.toState) {
    throw new CredentialTransitionRejected(
      `非法凭证状态迁移 ${opts.fromState} → ${opts.toState}:§3.9b 只允许 ` +
        `legacy-seeded → provisioning → isolated,**单调不可逆、无逆向 API**`
    );
  }
  if (!Number.isInteger(opts.expectedEpoch) || opts.expectedEpoch < 0) {
    throw new CredentialTransitionRejected(`expectedEpoch 非法:${String(opts.expectedEpoch)}`);
  }
  if (opts.toState === "provisioning") {
    assertProvisioningDeadline(opts.provisioningDeadlineAt, opts.now ?? Date.now());
  }
  const names: Record<string, string> = {
    "#s": "credentialIsolationState",
    "#e": "credentialEpoch",
    "#u": "credentialStateUpdatedAt",
    "#v": "version",
  };
  const values: Record<string, unknown> = {
    ":from": opts.fromState,
    ":to": opts.toState,
    ":expectedEpoch": opts.expectedEpoch,
    ":nextEpoch": opts.expectedEpoch + 1,
    ":at": opts.at ?? new Date().toISOString(),
    ":one": 1,
  };
  const sets = ["#s = :to", "#e = :nextEpoch", "#u = :at", "#v = if_not_exists(#v, :zero) + :one"];
  values[":zero"] = 0;
  if (opts.operationId) {
    names["#o"] = "provisioningOperationId";
    values[":o"] = opts.operationId;
    sets.push("#o = :o");
  }
  if (opts.provisioningDeadlineAt) {
    names["#d"] = "provisioningDeadlineAt";
    values[":d"] = opts.provisioningDeadlineAt;
    sets.push("#d = :d");
  }
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      // 🔴 前态 + epoch 双条件:任一不符即 ConditionalCheckFailed(既挡逆向,也挡并发重复推进)。
      ConditionExpression: "attribute_exists(sk) AND #s = :from AND #e = :expectedEpoch",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/**
 * **延期** `provisioning` 窗口(§3.9b「延期只能走受审计、带 epoch 的专用操作」;合同差分 ③-2)。
 *
 * 🔴 为什么是又一个专用函数、而不是复用 `advanceCredentialIsolationState`:那个函数「只认两条前进边」,
 *    `provisioning → provisioning` 不是前进边;为了延期去放宽它,等于在单调不可逆的状态机上开一条自环口子,
 *    而自环最容易被顺手扩成「任意 → 任意」。延期单独一个出口,能写的字段只有 deadline / epoch / 时间戳 / 操作号。
 * 🔴 与前进边**同一套**约束:
 *    · 条件写校验**前态(必须仍是 provisioning)+ 当前 epoch**(并发的另一次延期 / 推进不会被覆盖);
 *    · 成功即 `credentialEpoch++`(缓存正确性的支点:旧 epoch 的凭证槽与 canary 结果随之失效);
 *    · 新 deadline 过 `assertProvisioningDeadline`(严格解析 + 必须在未来 + **≤ 30 天**)——
 *      「≤30 天」以**现在**为基准,所以反复延期也拉不出一个一年后的 deadline;每次延期都要人再决定一次。
 * 🔴 审计 fail-closed 在调用方(路由):先写意图审计,写不进去就不调本函数。
 */
export async function extendProvisioningDeadline(
  targetId: string,
  opts: {
    expectedEpoch: number;
    provisioningDeadlineAt: string;
    operationId?: string;
    at?: string;
    /** 仅测试注入 */
    now?: number;
  }
): Promise<{ newEpoch: number }> {
  assertTargetId(targetId);
  if (!Number.isInteger(opts.expectedEpoch) || opts.expectedEpoch < 0) {
    throw new CredentialTransitionRejected(`expectedEpoch 非法:${String(opts.expectedEpoch)}`);
  }
  const deadline = assertProvisioningDeadline(opts.provisioningDeadlineAt, opts.now ?? Date.now());
  const names: Record<string, string> = {
    "#s": "credentialIsolationState",
    "#e": "credentialEpoch",
    "#u": "credentialStateUpdatedAt",
    "#d": "provisioningDeadlineAt",
    "#v": "version",
  };
  const values: Record<string, unknown> = {
    ":prov": "provisioning",
    ":expectedEpoch": opts.expectedEpoch,
    ":nextEpoch": opts.expectedEpoch + 1,
    ":d": deadline,
    ":at": opts.at ?? new Date().toISOString(),
    ":one": 1,
    ":zero": 0,
  };
  const sets = ["#d = :d", "#e = :nextEpoch", "#u = :at", "#v = if_not_exists(#v, :zero) + :one"];
  if (opts.operationId) {
    names["#o"] = "provisioningOperationId";
    values[":o"] = opts.operationId;
    sets.push("#o = :o");
  }
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        // 🔴 前态 + epoch 双条件:不是 provisioning(已 isolated / legacy-seeded)或 epoch 已被别人推过 ⇒ 拒
        ConditionExpression: "attribute_exists(sk) AND #s = :prov AND #e = :expectedEpoch",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new CredentialTransitionRejected(
        `延期被拒:${targetId} 已不在 provisioning,或凭证世代已不是 ${opts.expectedEpoch}(并发的另一次延期 / 推进)⇒ 刷新后重试`
      );
    }
    throw e;
  }
  return { newEpoch: opts.expectedEpoch + 1 };
}

// ——————————————————————————————————————————————————————————————
// §2.1 register(切片 c)—— 身份/位置的**唯一**写通道
//
// 与 seed / reconcile 的分工(SPEC §1.1 v3.7 的通道表):
//   · register  = 新建 target 的**身份与位置**(本函数;`status=registered`、不置 ready、不写 resources)
//   · seed      = 部署期落 **home** 的完整描述符(`seedHomeTarget`)
//   · reconcile = 维修态下修**内容类**字段(`RECONCILE_ALLOWED_FIELDS`,身份一律拒)
//   · 凭证状态  = `advanceCredentialIsolationState()`(§3.9b)
// ——————————————————————————————————————————————————————————————

/** register 入参(SPEC §2.1:`{region, partition, accountId, cellId?, stage?, jurisdiction, components[]}`)。 */
export interface RegisterTargetInput {
  region: string;
  partition: string;
  accountId: string;
  cellId?: string;
  stage?: string;
  /** 网络规模 standard(2 NAT)/ economy(1 NAT);缺省 standard */
  networkProfile?: NetworkProfile;
  /** 缺省 "home"(SPEC §1.1:jurisdiction 是可默认字段)。 */
  jurisdiction?: string;
  components: string[];
  /** `jurisdiction≠home` 时**必填**:客户端回传的免责告知同意(须逐字等于当前版本,SPEC §2.1 v3.22) */
  residencyAck?: { version: string; textHash: string };
}

/** register 专用错误:入参不合法(调用方应映射 400,而不是 500)。 */
/**
 * 同一个 region 能容纳的执行环境个数 = `tgt_<abbr>_a` … `tgt_<abbr>_z`。
 * 🔴 导出的理由是**它必须被可执行断言钉住**:这个数原来是 `3`(见下方生成循环的注释),
 *    而那是个没人打算立的上限,且失败时的拒因把人引向「稍后重试」这条死路。
 */
export const TARGET_CELL_SPACE = 26;

/**
 * 该 region 的 targetId 命名空间(`a..z`)已用满 —— **确定性**耗尽,不是瞬态争抢。
 * 分成独立类型的唯一理由:路由要把它映射成 **409 + 可操作的话**,而不是 500「内部错误 + 请稍后重试」。
 */
export class RegisterNamespaceExhausted extends Error {
  readonly cellSpace = TARGET_CELL_SPACE;
  constructor(
    readonly region: string,
    readonly abbrev: string
  ) {
    super(
      `${region} 的执行环境命名空间已用满:tgt_${abbrev}_a … tgt_${abbrev}_z 共 ${TARGET_CELL_SPACE} 个全部已被占用。` +
        `这不是瞬态失败,重试不会改变结果 —— 请先删除该 region 里不再使用的执行环境,再注册新的。`
    );
    this.name = "RegisterNamespaceExhausted";
  }
}

/**
 * 🔴🔴 **一个 region 只允许一套执行环境**(用户反复拍板;2026-09-15 第 N 次:
 * 「我不是跟你说过 N 次了吗?一个 region 只能有一个执行环境」)。
 *
 * 【为什么必须是**产品**的守卫,而不是纪律】它今天真的被违反了:验收段的一条判据(I-6)为了证明
 * targetId 字母空间不是写死的 3 个,在 us-west-2 注册了 `_b/_c/_d` 三个描述符 ——
 * **平台一个都没拦**,于是页面上出现 4 个执行环境。凡靠「大家记得别这么做」维持的约束,
 * 迟早被某条自动化路径踩穿(这一条已经踩穿两次:上一次是我为造夹具在 us-east-1 建第二套)。
 * ⇒ 把它变成**注册通道的硬拒**:同一 region 只要还有一个非 deleted 的执行环境,就不许注册第二个。
 *
 * 🔴 为什么连 `registered` / `failed` 这种「没建成」的也拦:它们同样出现在页面与清单里
 * (用户看到的就是「这个区有 4 个」),而且留着它们正是本次事故的形态。要腾位置就**显式删掉**它。
 * 🔴 蓝绿/主备(同区两套)如果将来真要做,那是一次**显式的设计变更**(要同时改这条守卫与它的判据),
 * 不是让守卫留个后门。
 */
export class RegionAlreadyHasEnvironmentError extends Error {
  constructor(
    readonly region: string,
    readonly existing: Array<{ targetId: string; status: string }>
  ) {
    super(
      `${region} 已经有执行环境(${existing.map((x) => `${x.targetId}[${x.status}]`).join(", ")})—— ` +
        `**一个 region 只允许一套执行环境**。这不是瞬态失败,重试不会改变结果:` +
        `要在这个区换一套,先把上面那个删掉(未部署的描述符也算占位)。`
    );
    this.name = "RegionAlreadyHasEnvironmentError";
  }
}

export class RegisterValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RegisterValidationError";
  }
}

/**
 * region → targetId 用的确定性缩写。
 * 规则:首段全取 + 中间各段取首字母 + 尾部数字段全取(`us-west-2`→`usw2`、`ap-southeast-4`→`aps4`、
 * `us-gov-west-1`→`usgw1`)。产物只含 `[a-z0-9]` ⇒ 拼进 targetId 正文天然合法;
 * 最长 region(如 `ap-southeast-4`)的缩写 ≤5 字符,`<abbr>_<字母>` 正文 ≤7 ≤ 16 上限。
 */
export function regionAbbrev(region: string): string {
  const seg = region.split("-");
  return seg[0] + seg.slice(1, -1).map((s) => s[0]).join("") + seg[seg.length - 1];
}

/**
 * 注册新执行目标(SPEC §2.1 POST register)。
 *
 * 🔴 三条承重:
 * ① **服务端生成 targetId**(SPEC §1.1a:客户端不得指定)——形如 `tgt_<region缩写>_<字母序>`;
 *    **绝不生成 `tgt_home`**(home 只能由部署期 seed 落,register 走到 home 语义 = P0-4 那类 fail-open 的温床);
 * ② **不置 `ready`、不写 `resources`** —— 实名资源袋由部署回写(切片 e)整包落,半份描述符比没有更糟(§20.11-N2);
 * ③ 条件写 `attribute_not_exists(sk)`:撞 id(并发注册同 region)换下一个字母重试,**不覆盖任何已有 item**。
 */
export async function registerTarget(
  input: RegisterTargetInput,
  actor: string
): Promise<{ targetId: string; status: "registered" }> {
  const bad = (msg: string) => {
    throw new RegisterValidationError(msg);
  };

  if (!input || typeof input !== "object") bad("入参必须是对象");
  const { region, partition, accountId, components } = input;

  // 逐项校验 —— 复用 DescriptorSchema 同款正则/映射,不另立第二套口径。
  if (typeof region !== "string" || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    bad(`region 非法:${JSON.stringify(region)}(形如 us-east-1 / cn-north-1 / us-gov-west-1)`);
  }
  const expectedPartition = partitionForRegion(region);
  if (partition !== expectedPartition) {
    bad(`partition=${JSON.stringify(partition)} 与 region=${region} 不一致(应为 ${expectedPartition})—— 交叉校验同 §3.1a`);
  }
  if (typeof accountId !== "string" || !/^\d{12}$/.test(accountId)) {
    bad(`accountId 须为 12 位数字:${JSON.stringify(accountId)}`);
  }
  if (!Array.isArray(components) || components.length === 0) bad("components 必须是非空数组");
  const unknownComp = components.filter((c) => !(TARGET_COMPONENTS as readonly string[]).includes(c));
  if (unknownComp.length > 0) {
    bad(`components 含未知组件:${unknownComp.join(", ")}(合法:${TARGET_COMPONENTS.join(", ")})`);
  }
  if (!components.includes("core")) bad("components 必须含 core(SPEC §1.1:core 必有)");
  // 🔴 **注册 = 新装**,停供组件一律拒(用户 2026-09-11 拍板)。
  //   与 `planComponentAddition` 的差别:那里是「全集」语义、要放行**存量已装**的;这里是全新目标,
  //   压根没有「已装」⇒ 带了就是要新装 ⇒ 直接拒,并把出路(airflow-serverless)写在拒因里。
  const retired = components.filter((c) => isComponentRetired(c));
  if (retired.length) bad(retiredComponentMessage(retired));
  const jurisdiction = input.jurisdiction === undefined ? "home" : input.jurisdiction;
  if (typeof jurisdiction !== "string" || jurisdiction.length === 0) {
    bad(`jurisdiction 须为非空字符串:${JSON.stringify(input.jurisdiction)}`);
  }
  // 法域格式(SPEC §1.1 v3.22)+ 跨法域注册必带当前版本的免责告知同意(§2.1 register)
  if (typeof jurisdiction === "string" && !JURISDICTION_RE.test(jurisdiction)) {
    bad(`jurisdiction 格式非法:${JSON.stringify(jurisdiction)}(须匹配 ${JURISDICTION_RE.source},如 home / eu-sim;不收 Home / EU 这类变体)`);
  }
  const crossJurisdictionRegister = typeof jurisdiction === "string" && jurisdiction !== "home";
  if (crossJurisdictionRegister && !isCurrentDisclaimerAck(input.residencyAck)) {
    bad(
      "注册非 home 法域的执行目标必须带当前版本的免责告知同意 residencyAck:{version, textHash}" +
        "(向导最后一步勾选「我已阅读并同意」;版本或文本哈希与当前不一致 = 用户看到的不是这一版,拒)"
    );
  }
  if (!crossJurisdictionRegister && input.residencyAck !== undefined) {
    bad("home 法域的执行目标不接受 residencyAck(告知只对跨法域 target 有意义;带了说明调用方拼错了法域)");
  }
  // ② —— 🔴🔴 不许精简(用户 2026-10-10):注册带的组件集必须**逐项等于**要求集。
  //   注册的一律是非主控区(主控区由 seed-home 探测写入,不走这里)。少一个 = 精简形态 ⇒ 拒;
  //   多一个(kafka 未实现 / 非主控区带 agentcore)= 装不出来或违反「一个 AgentCore」⇒ 同样拒。
  if (typeof jurisdiction === "string" && Array.isArray(components)) {
    const required = requiredComponentsFor({ isHome: false, jurisdiction });
    const got = new Set(components as string[]);
    const lacking = required.filter((c) => !got.has(c));
    const extra = Array.from(got).filter((c) => !required.includes(c));
    if (lacking.length > 0 || extra.length > 0) {
      bad(
        `components 必须等于该执行环境的完整组件集 [${required.join(", ")}](每个执行环境都必须装齐,不提供精简形态)` +
          (lacking.length ? `;缺 ${lacking.join(", ")}` : "") +
          (extra.length ? `;多出 ${extra.join(", ")}` : "")
      );
    }
  }
  for (const k of ["cellId", "stage"] as const) {
    const v = input[k];
    if (v !== undefined && (typeof v !== "string" || v.length === 0)) {
      bad(`${k} 有值则须为非空字符串:${JSON.stringify(v)}`);
    }
  }
  if (typeof actor !== "string" || actor.length === 0) bad("actor 缺失(审计要求 createdBy)");

  // 组件归一:去重 + 按枚举顺序(同一勾选集产出同一 item,写入可复现)。
  const normalized = TARGET_COMPONENTS.filter((c) => components.includes(c));

  // 服务端生成 targetId:`tgt_<abbr>_<a..z>`,条件写撞了就进位重试(并发注册同 region 的场景)。
  //
  // 🔴🔴 **2026-09-13 修的一个真缺陷**:这里原来写 `MAX_TRIES = 3` ⇒ 只试 `a`/`b`/`c` 三个字母
  //    ⇒ **一个 region 最多只能有 3 个执行环境**,第 4 个注册必失败。而注释写着「a, b, c…」,
  //    读起来像会一直进位 —— 上限是个**没人打算立的**限制。
  //    更坏的是拒因:它说「同 region target 过多或**并发注册风暴;请稍后重试**」,而这是
  //    **确定性耗尽**,重试一万次也不会成 ⇒ 运维会一直重试而不是去删一个不用的环境
  //    (「最坏的不是不能用,是看不出为什么不能用」的又一例)。
  //    ⇒ 字母空间给满 26 个;**耗尽**与**争抢**分成两种错(见 RegisterNamespaceExhausted)。
  // 分配本环境的 VPC 地址段
  // 🔴 为什么在注册这一刻分配(而不是部署时):跨区 peering 要求两侧 CIDR 不重叠,而「不重叠」是
  //    **账号内全局**的性质(主控区路由表要同时指向 N 条 peering,目的地段不能撞)⇒ 只有注册表这一侧
  //    看得见全量已用值。落进描述符后 broker 直接透传,部署期不再有第二处判断。
  // ⚠️ 已知的窄窗口:两笔**并发**注册可能算到同一个段(条件写只保护 sk 唯一,管不了别的属性)。
  //    这一条**刻意不用「再加一张 cidr 索引表」来消除** —— 那会多出一份要跟着删干净的生命周期
  //    (本项目已经吃过「删不干净」与「两个名单夹缝」两次苦头)。它的兜底是**物理层响亮失败**:
  //    两个环境撞同一段时,主控区那条回程路由 `CreateRoute` 会 `RouteAlreadyExists` ⇒ 自定义资源失败
  //    ⇒ 整栈回滚,并在错误里点名冲突的那一段(SPEC §3.14ter)。**不是静默错**,所以不值得为它再开一张表。
  const allTargets = await listTargetsRaw();
  // 🔴🔴 同区已有执行环境 ⇒ 硬拒(见 RegionAlreadyHasEnvironmentError)
  //   复用这一次全量读,不额外扫表。
  // ⚠️ 残留窄窗口(**刻意保留,理由与上面 CIDR 那条同族**):这是「读了再写」,两笔**并发**注册可能都通过。
  //   条件写 `attribute_not_exists(sk)` 只保护 targetId 唯一,管不了「这个 region 已经有一个」。
  //   消除它的做法是给 region 单开一条 claim 项(`pk=env-region` + 事务写),但那会多出一份**必须跟着删干净**
  //   的生命周期 —— 而「删执行环境」在本项目里**还没有产品路径**(未实现,今天清 `tgt_usw2_e` 是手工删栈 + 手工删行)。
  //   claim 一旦成为孤儿,症状是「这个 region 从此再也注册不进去」,比现在这个窄窗口更难诊断、更伤人。
  //   ⇒ 现阶段的兜底有两层:① 真实注册全部来自页面/脚本的**串行**调用;② 验收侧 `vlib.assert_one_env_per_region()`
  //   在**每一段**开跑前扫注册表,一区多套当场硬红。等(环境回收)落地、有了单一的删除作者,再把 claim 并进它的事务里。
  const sameRegion = allTargets
    .filter((x) => x.region === region && x.status !== "deleted")
    .map((x) => ({ targetId: x.targetId, status: String(x.status) }));
  if (sameRegion.length > 0) throw new RegionAlreadyHasEnvironmentError(region, sameRegion);
  const usedCidrs = allTargets.map((t) => t.vpcCidr);
  const vpcCidr = allocateExecEnvVpcCidr(usedCidrs);

  const abbrev = regionAbbrev(region);
  for (let i = 0; i < TARGET_CELL_SPACE; i++) {
    const suffix = String.fromCharCode(97 + i); // a, b, c … z
    const targetId = `tgt_${abbrev}_${suffix}`;
    // 双保险:生成器出的 id 必须合法且绝不是 home(生成规则天然不含 "home",这里仍显式断)。
    if (!isValidTargetId(targetId) || isHome(targetId)) {
      throw new Error(`register 生成了非法/保留的 targetId:${targetId} —— 生成器缺陷,拒绝写入`);
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const item: Record<string, unknown> = {
      pk: PK,
      sk: targetId,
      targetId,
      partition,
      accountId,
      region,
      jurisdiction,
      // 跨法域注册时 admin 的同意入描述符(服务端补 by / at;之后不可改)
      ...(crossJurisdictionRegister && input.residencyAck
        ? { residencyAck: { by: actor, at: now, version: input.residencyAck.version, textHash: input.residencyAck.textHash } }
        : {}),
      status: "registered",
      components: normalized,
      // VPC 地址段(不可改;部署期由 broker 透传给栈组)
      vpcCidr,
      // 🔴🔴 **订正一处现网 fail-open**(50 ROADMAP §2quinquies 事实 ③;实测 `tgt_usw2_a` 就是这个形态)。
      // 原来这里硬编码 `legacy-seeded`,而 §3.9b 的权威合同写的是:
      //   「**仅部署迁移脚本显式登记**的存量 home target 可进入 `legacy-seeded`;
      //     **新 target 从 `provisioning` 开始**,未完成项目凭证供给与验证不得进入 `isolated`。」
      // 差别不是措辞:`legacy-seeded` **不要求 deadline** ⇒ 新建的非 home target 可以**无限期**
      // 回落共享 admin secret,而 `provisioning` 有 ≤30 天硬窗口、过期即 fail-closed。
      // ⇒ 这是"隔离永远不收敛"的结构性口子,不是将来才发作的隐患。
      credentialIsolationState: "provisioning",
      credentialEpoch: 0,
      credentialStateUpdatedAt: now,
      // 🔴 `now` 只取一次:两次 `Date.now()` 之间跨过毫秒边界会让"必须在未来"这条自己判自己不过。
      provisioningDeadlineAt: assertProvisioningDeadline(
        new Date(nowMs + REGISTER_PROVISIONING_WINDOW_MS).toISOString(),
        nowMs
      ),
      version: 1,
      createdBy: actor,
      updatedAt: now,
      // 🔴 刻意不写:ready(部署回写整包校验通过后才单独置位)、resources(切片 e)、isHome(非 home 不写)。
    };
    if (input.cellId !== undefined) item.cellId = input.cellId;
    if (input.stage !== undefined) item.stage = input.stage;
    // 显式写缺省,让「没写 = standard」不靠读方猜
    // 新注册的 target **不再写** networkProfile(零出网无 NAT 档)。
    //   只有客户端显式给了(= 存量迁移场景)才落库,保持向后兼容。
    if (input.networkProfile) item.networkProfile = input.networkProfile;
    try {
      await docClient.send(
        new PutCommand({
          TableName: TABLES.EXECUTION_ENVS,
          Item: item,
          ConditionExpression: "attribute_not_exists(sk)",
        })
      );
      return { targetId, status: "registered" };
    } catch (e) {
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
        continue; // 该 id 已被占(同 region 已注册过 / 并发),换下一个字母
      }
      throw e;
    }
  }
  // 🔴 走到这里 = `a..z` **全部**被占。这不是「稍后重试」能解决的事,拒因必须说出**唯一的出路**。
  throw new RegisterNamespaceExhausted(region, abbrev);
}

/**
 * 管理面列表(SPEC §2.1 GET list;口径同 §3.1 的 `getTargetRaw`)。
 *
 * 🔴 **不过滤、不校验**:运维必须能看到坏 item / 失败 target 才修得了它(SPEC:241)。
 * 🔴 **禁用于准入/扇出**:那是 `listActiveTargets()` 的职责(它剔坏 item + 判可用性)。
 */
export async function listTargetsRaw(): Promise<ExecutionTarget[]> {
  return queryAllPages(
    (startKey) =>
      new QueryCommand({
        TableName: TABLES.EXECUTION_ENVS,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": PK },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
  );
}

// ——————————————————————————————————————————————————————————————
// 切片 e —— 部署回写 / 就绪置位 / 探活写入 / 启用(G 批欠账的收口
// seed/回写与 probe 第一次有**真实调用方与真实写入方**,stale 判定第一次有真值)
//
// 通道分工(SPEC §1.1 v3.7 的通道表,一条不混):
//   finalizeTargetResources —— 资源袋回写:CFN Outputs → 经 reconcileTarget(维修态+整包校验)
//   markTargetTested        —— `ready` 置位 + status→testing(SPEC:59「ready → 补齐后单独置位」)
//   writeProbeResult        —— **只写 probe 字段**(active 后周期探活也走它,故不能走 reconcile 的维修态门)
//   enableTarget            —— status testing→active(前置 ready ∧ probe.ok,条件写三绑)
// ——————————————————————————————————————————————————————————————

/** 生命周期前置不满足(调用时机不对/前置未达成)。route 应映射 409,而不是 500。 */
export class LifecyclePreconditionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LifecyclePreconditionError";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 finalize / probe-reconcile 的 fence 机制(§21)—— bug#11 真正闭合的核心
//    completion 以 version+phase+opId+epoch+**本次 probe 身份** 一次条件写,operation + deploy 锁同写清。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * finalize 入口的独立 fence(§21.1.1):防 route 核 build 成功后、finalize 首读前 operation 被 A→B 替换 ——
 * 若 finalize 从"当前 B"重取 operation,A 的 CFN 结果会先污染 B。故 finalize 强制收本 fence,任何 CFN read
 * 与下游写之前先核。deploy(modern)与 legacy(bug#11 存量升级前遗留)两型。
 */
type FinalizeIdentityFence = { region: string; accountId: string; partition: string };
export type FinalizeLifecycleFence = FinalizeIdentityFence &
  (
    | {
        kind: "deploy";
        expectedVersion: number;
        fromPhase: TargetPhase;
        operationId: string;
        lockEpoch: number;
        openSnapshotHash: string;
        buildId: string;
        startedAt: string;
        desiredComponents: string[];
      }
    | {
        kind: "legacy";
        expectedVersion: number;
        status: TargetStatus;
        ready: boolean | undefined;
        components: string[];
        probe: ProbeResult | undefined;
        lockEpoch: number;
        lockToken: string;
        operationId: string;
        buildId: string;
      }
  );

function probeSnapshot(probe: ProbeResult | undefined): string {
  if (!probe) return "absent";
  return JSON.stringify([probe.at, probe.ok, probe.items.map((item) => [item.name, item.ok, item.error ?? null])]);
}

/** 读侧断言(仅为好错误;真正防 TOCTOU 的仍是每个资源写的 ConditionExpression = appendFinalizeFence)。 */
function assertFinalizeFence(current: ExecutionTarget, fence: FinalizeLifecycleFence): void {
  if (current.version !== fence.expectedVersion) {
    throw new LifecyclePreconditionError("finalize fence version 已变化");
  }
  if (current.region !== fence.region || current.accountId !== fence.accountId || current.partition !== fence.partition) {
    throw new LifecyclePreconditionError("finalize 外部读取身份(region/account/partition)已变化");
  }
  const hasSpec = current.spec !== undefined;
  const hasObserved = current.observed !== undefined;
  if (hasSpec !== hasObserved) {
    throw new LifecyclePreconditionError("spec/observed 只存在一侧");
  }

  if (fence.kind === "deploy") {
    if (!hasSpec || !hasObserved) {
      throw new LifecyclePreconditionError("deploy finalize fence 对应的 modern axes 已消失");
    }
    const { spec, observed } = specObservedOf(current);
    const operation = observed.operation;
    if (
      operation?.kind !== "deploy" ||
      operation.operationId !== fence.operationId ||
      operation.lockEpoch !== fence.lockEpoch ||
      operation.openSnapshotHash !== fence.openSnapshotHash ||
      operation.buildId !== fence.buildId ||
      operation.startedAt !== fence.startedAt ||
      operation.disruptive !== true ||
      observed.phase !== fence.fromPhase ||
      spec.intent !== "serve" ||
      current.lockEpoch !== fence.lockEpoch ||
      current.deployLockToken !== fence.operationId ||
      current.deployLockOperationId !== fence.operationId ||
      current.lastOperationId !== fence.operationId ||
      current.lastBuildId !== fence.buildId ||
      JSON.stringify(spec.desiredComponents) !== JSON.stringify(fence.desiredComponents)
    ) {
      throw new LifecyclePreconditionError("finalize deploy tuple 已变化");
    }
    return;
  }

  if (
    hasSpec ||
    hasObserved ||
    current.status !== fence.status ||
    current.ready !== fence.ready ||
    JSON.stringify(current.components ?? []) !== JSON.stringify(fence.components) ||
    probeSnapshot(current.probe) !== probeSnapshot(fence.probe) ||
    current.lockEpoch !== fence.lockEpoch ||
    current.deployLockToken !== fence.lockToken ||
    current.deployLockOperationId !== fence.operationId ||
    current.lastOperationId !== fence.operationId ||
    current.lastBuildId !== fence.buildId
  ) {
    throw new LifecyclePreconditionError("legacy finalize snapshot 已变化");
  }
}

/**
 * 把 finalize fence 变成资源写的 ConditionExpression 片段(initial `reconcileTarget` 与 ready `mergeComponentResources`
 * 共用,确保不漂移)。🔴 names/values **按 kind 分支构造**,只放该分支真正用到的,避免 unused-names → 真环境 ValidationException。
 */
function appendFinalizeFence(
  names: Record<string, string>,
  values: Record<string, unknown>,
  conditions: string[],
  fence: FinalizeLifecycleFence
): void {
  Object.assign(names, { "#ffRegion": "region", "#ffAccountId": "accountId", "#ffPartition": "partition" });
  Object.assign(values, { ":ffRegion": fence.region, ":ffAccountId": fence.accountId, ":ffPartition": fence.partition });
  conditions.push("#ffRegion = :ffRegion");
  conditions.push("#ffAccountId = :ffAccountId");
  conditions.push("#ffPartition = :ffPartition");

  if (fence.kind === "legacy") {
    Object.assign(names, {
      "#ffSpec": "spec",
      "#ffObserved": "observed",
      "#ffStatus": "status",
      "#ffReady": "ready",
      "#ffComponents": "components",
      "#ffLegacyEpoch": "lockEpoch",
      "#ffLegacyToken": "deployLockToken",
      "#ffLegacyOwner": "deployLockOperationId",
      "#ffLastOperation": "lastOperationId",
      "#ffLastBuild": "lastBuildId",
    });
    values[":ffStatus"] = fence.status;
    values[":ffComponents"] = fence.components;
    values[":ffLegacyEpoch"] = fence.lockEpoch;
    values[":ffLegacyToken"] = fence.lockToken;
    values[":ffLegacyOperation"] = fence.operationId;
    values[":ffLegacyBuild"] = fence.buildId;
    conditions.push("attribute_not_exists(#ffSpec)");
    conditions.push("attribute_not_exists(#ffObserved)");
    conditions.push("#ffStatus = :ffStatus");
    conditions.push("#ffComponents = :ffComponents");
    conditions.push("#ffLegacyEpoch = :ffLegacyEpoch");
    conditions.push("#ffLegacyToken = :ffLegacyToken");
    conditions.push("#ffLegacyOwner = :ffLegacyOperation");
    conditions.push("#ffLastOperation = :ffLegacyOperation");
    conditions.push("#ffLastBuild = :ffLegacyBuild");
    if (fence.ready === undefined) {
      conditions.push("attribute_not_exists(#ffReady)");
    } else {
      values[":ffReady"] = fence.ready;
      conditions.push("#ffReady = :ffReady");
    }
    names["#ffProbe"] = "probe";
    if (fence.probe === undefined) {
      conditions.push("attribute_not_exists(#ffProbe)");
    } else {
      values[":ffProbe"] = fence.probe;
      conditions.push("#ffProbe = :ffProbe");
    }
    return;
  }

  Object.assign(names, {
    "#ffSpec": "spec",
    "#ffObserved": "observed",
    "#ffPhase": "phase",
    "#ffIntent": "intent",
    "#ffDesired": "desiredComponents",
    "#ffOperation": "operation",
    "#ffKind": "kind",
    "#ffOperationId": "operationId",
    "#ffOperationEpoch": "lockEpoch",
    "#ffOpenSnapshotHash": "openSnapshotHash",
    "#ffBuildId": "buildId",
    "#ffStartedAt": "startedAt",
    "#ffDisruptive": "disruptive",
    "#ffTopEpoch": "lockEpoch",
    "#ffLockToken": "deployLockToken",
    "#ffLockOwner": "deployLockOperationId",
    "#ffTopLastOperation": "lastOperationId",
    "#ffTopLastBuild": "lastBuildId",
  });
  Object.assign(values, {
    ":ffPhase": fence.fromPhase,
    ":ffServe": "serve",
    ":ffDesired": fence.desiredComponents,
    ":ffDeploy": "deploy",
    ":ffOperationId": fence.operationId,
    ":ffEpoch": fence.lockEpoch,
    ":ffOpenSnapshotHash": fence.openSnapshotHash,
    ":ffBuildId": fence.buildId,
    ":ffStartedAt": fence.startedAt,
    ":ffDisruptive": true,
  });
  conditions.push("#ffObserved.#ffPhase = :ffPhase");
  conditions.push("#ffSpec.#ffIntent = :ffServe");
  conditions.push("#ffSpec.#ffDesired = :ffDesired");
  conditions.push("#ffObserved.#ffOperation.#ffKind = :ffDeploy");
  conditions.push("#ffObserved.#ffOperation.#ffOperationId = :ffOperationId");
  conditions.push("#ffObserved.#ffOperation.#ffOperationEpoch = :ffEpoch");
  conditions.push("#ffObserved.#ffOperation.#ffOpenSnapshotHash = :ffOpenSnapshotHash");
  conditions.push("#ffObserved.#ffOperation.#ffBuildId = :ffBuildId");
  conditions.push("#ffObserved.#ffOperation.#ffStartedAt = :ffStartedAt");
  conditions.push("#ffObserved.#ffOperation.#ffDisruptive = :ffDisruptive");
  conditions.push("#ffTopEpoch = :ffEpoch");
  conditions.push("#ffLockToken = :ffOperationId");
  conditions.push("#ffLockOwner = :ffOperationId");
  conditions.push("#ffTopLastOperation = :ffOperationId");
  conditions.push("#ffTopLastBuild = :ffBuildId");
}

// ── probe reconcile(§21.4:核心完成命令 + 输入快照)────────────────────────────

function jsonClone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function reconcileCanonicalJson(value: unknown): string {
  // 🔴 委托给 lifecycle 的 `canonicalJson`(唯一实现)—— 原来这里有第二份逐字相同的代码,
  //    而"同一口径两份实现"正是本仓反复出事的形状(判据分叉)。名字保留,免动既有调用点。
  return canonicalJson(value);
}

/** 探活真实读取的输入快照(region/account/partition/组件/资源/agentcore)—— route finalize 后、runProbe 前捕获。 */
export function probeInputOf(target: ExecutionTarget): ProbeInputSnapshot {
  return {
    region: target.region,
    accountId: target.accountId,
    partition: target.partition,
    components: [...(target.components ?? [])],
    resources: jsonClone(target.resources),
    agentcore: jsonClone(target.agentcore),
  };
}

/** 纯 helper(enable/probe route 也复用):当前 item 的探活输入是否与快照一致。 */
export function sameProbeInput(current: ExecutionTarget, expected: ProbeInputSnapshot): boolean {
  return reconcileCanonicalJson(probeInputOf(current)) === reconcileCanonicalJson(expected);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** probe route 在 finalize 后、runProbe 前捕获的 exact 完成证据(§21.4)。 */
export type ProbeLifecycleEvidence =
  | {
      kind: "deploy";
      expectedVersion: number;
      fromPhase: TargetPhase;
      operationId: string;
      lockEpoch: number;
      openSnapshotHash: string;
      buildId: string;
      startedAt: string;
      desiredComponents: string[];
      observedComponents: string[];
      probeInput: ProbeInputSnapshot;
    }
  | ({
      kind: "legacy";
      expectedVersion: number;
      status: TargetStatus;
      ready: boolean | undefined;
      components: string[];
      probeInput: ProbeInputSnapshot;
    } & ({ mode: "stable"; legacySession?: never } | { mode: "e99" | "initial"; legacySession: LegacySessionFence }))
  | { kind: "none"; expectedVersion: number };

export interface ProbeReconcileInput {
  probe: ProbeResult;
  finalized: boolean;
  evidence: ProbeLifecycleEvidence;
}

export interface ProbeReconcileResult {
  advanced: boolean;
  reason?: string;
}

/**
 * 🔴 **核心完成命令**(§21.4):按 route 在 finalize 后捕获的 exact evidence 完成 deploy / 收养 legacy。
 * 绝不从"当前 item"重取 operation(probe 期间可能 A→B,旧 probe 反会合法清掉 B)。任何证据在途变化 → 早退不晋级。
 */
export async function reconcileAfterProbe(targetId: string, input: ProbeReconcileInput): Promise<ProbeReconcileResult> {
  assertTargetId(targetId);
  parseProbeResult(input.probe); // 含 canonical at、非空 items、ok===items.every(ok)
  const current = await getTargetRaw(targetId);
  if (!current) throw new LifecyclePreconditionError(`执行目标不存在:${targetId}`);
  if (!Number.isInteger(current.version)) {
    throw new LifecyclePreconditionError(`target ${targetId} 缺整数 version`);
  }

  // probe raw write 不涨 version。只要 probe 期间开了/换了 operation,version 必已变化。
  if (current.version !== input.evidence.expectedVersion) {
    return { advanced: false, reason: "evidence-version-changed" };
  }

  const hasSpec = current.spec !== undefined;
  const hasObserved = current.observed !== undefined;
  if (hasSpec !== hasObserved) {
    throw new LifecyclePreconditionError("spec/observed 只存在一侧");
  }

  if (input.evidence.kind === "none") {
    if (hasObserved && specObservedOf(current).observed.operation) {
      return { advanced: false, reason: "operation-appeared-during-probe" };
    }
    return { advanced: false, reason: "telemetry-only" };
  }

  if (!sameProbeInput(current, input.evidence.probeInput)) {
    return { advanced: false, reason: "probe-input-changed-during-probe" };
  }

  let spec: TargetSpec;
  let observed: TargetObserved;
  let to: TargetPhase;
  let completionFence: DeploymentCompletionFence | undefined;
  let legacyCompletionFence: LegacyCompletionFence | undefined;
  let actualComponents: string[];
  let ifAbsent = false;

  if (input.evidence.kind === "deploy") {
    if (!hasSpec || !hasObserved) {
      return { advanced: false, reason: "modern-operation-disappeared" };
    }
    ({ spec, observed } = specObservedOf(current));
    const operation = observed.operation;
    const evidence = input.evidence;

    if (
      operation?.kind !== "deploy" ||
      spec.intent !== "serve" ||
      operation.operationId !== evidence.operationId ||
      operation.lockEpoch !== evidence.lockEpoch ||
      operation.openSnapshotHash !== evidence.openSnapshotHash ||
      operation.buildId !== evidence.buildId ||
      operation.startedAt !== evidence.startedAt ||
      operation.disruptive !== true ||
      observed.phase !== evidence.fromPhase ||
      current.lockEpoch !== evidence.lockEpoch ||
      current.deployLockToken !== evidence.operationId ||
      current.deployLockOperationId !== evidence.operationId
    ) {
      return { advanced: false, reason: "operation-evidence-changed" };
    }
    if (!sameStrings(spec.desiredComponents, evidence.desiredComponents)) {
      return { advanced: false, reason: "desired-changed-during-probe" };
    }
    if (!sameStrings(observed.components, evidence.observedComponents)) {
      return { advanced: false, reason: "observed-components-changed-during-probe" };
    }
    if (!input.probe.ok) return { advanced: false, reason: "probe-red" };
    if (!input.finalized) return { advanced: false, reason: "finalize-not-complete" };
    if (!isGreenProbeForComponents(evidence.observedComponents, input.probe.items)) {
      return { advanced: false, reason: "probe-coverage-mismatch" };
    }

    const missingDesired = evidence.desiredComponents.filter((c) => !evidence.observedComponents.includes(c));
    if (missingDesired.length) {
      return { advanced: false, reason: `desired-not-observed:${missingDesired.join(",")}` };
    }
    const unexpectedObserved = evidence.observedComponents.filter((c) => !evidence.desiredComponents.includes(c));
    if (unexpectedObserved.length) {
      return { advanced: false, reason: `observed-not-desired:${unexpectedObserved.join(",")}` };
    }

    if (evidence.fromPhase === "ready") to = "ready";
    else if (evidence.fromPhase === "provisioning" || evidence.fromPhase === "verifying") to = "verifying";
    else return { advanced: false, reason: `phase=${evidence.fromPhase}` };

    actualComponents = [...evidence.observedComponents];
    completionFence = {
      operationId: evidence.operationId,
      lockEpoch: evidence.lockEpoch,
      openSnapshotHash: evidence.openSnapshotHash,
      buildId: evidence.buildId,
      startedAt: evidence.startedAt,
      probeAt: input.probe.at,
      probe: input.probe,
      desiredComponents: evidence.desiredComponents,
      observedComponents: evidence.observedComponents,
      probeInput: evidence.probeInput,
    };
  } else {
    // legacy 初装:probe 前捕获的是"无双轴"快照;probe 后若出现双轴/operation,立即拒。
    const evidence = input.evidence;
    if (hasSpec || hasObserved) {
      return { advanced: false, reason: "legacy-replaced-during-probe" };
    }
    if (
      current.status !== evidence.status ||
      current.ready !== evidence.ready ||
      !sameStrings(current.components ?? [], evidence.components)
    ) {
      return { advanced: false, reason: "legacy-snapshot-changed" };
    }
    if (evidence.mode === "stable") {
      if (
        evidence.legacySession !== undefined ||
        current.deployLockToken !== undefined ||
        current.deployLockExpiresAt !== undefined ||
        current.deployLockOperationId !== undefined
      ) {
        return { advanced: false, reason: "stable-legacy-has-residual-lock" };
      }
    } else {
      const session = evidence.legacySession;
      if (
        !session ||
        current.lockEpoch !== session.lockEpoch ||
        current.deployLockToken !== session.lockToken ||
        current.deployLockOperationId !== session.operationId ||
        current.lastOperationId !== session.operationId ||
        current.lastBuildId !== session.buildId
      ) {
        return { advanced: false, reason: "legacy-session-evidence-changed" };
      }
    }
    if (!input.probe.ok) return { advanced: false, reason: "probe-red" };
    if (!input.finalized) return { advanced: false, reason: "finalize-not-complete" };
    if (!isGreenProbeForComponents(evidence.probeInput.components, input.probe.items)) {
      return { advanced: false, reason: "probe-coverage-mismatch" };
    }

    ({ spec, observed } = adoptLegacyAfterFreshProbe(current, input.probe, evidence.mode));
    if (observed.phase === "ready") to = "ready";
    else if (observed.phase === "provisioning" || observed.phase === "verifying") to = "verifying";
    else return { advanced: false, reason: `legacy-phase=${observed.phase}` };
    actualComponents = orderComponents(current.components ?? observed.components);
    const exactGreen = {
      probeAt: input.probe.at,
      probe: input.probe,
      desiredComponents: [...spec.desiredComponents],
      observedComponents: [...actualComponents],
      probeInput: evidence.probeInput,
    };
    legacyCompletionFence =
      evidence.mode === "stable"
        ? { mode: "stable", ...exactGreen }
        : { mode: evidence.mode, session: evidence.legacySession, ...exactGreen };
    ifAbsent = true;
  }

  const postObserved: TargetObserved = {
    ...observed,
    phase: to,
    health: "healthy",
    components: actualComponents,
    probe: input.probe,
    lastReconcileAt: new Date().toISOString(),
    // 🔴 P0-E ④(SPEC §3.5c):**成功栅栏**把本次会话用的源包身份提升为基线("现实里装的是哪一份源")。
    //    · 只在这一次条件写里前移 ⇒ 与 `observed.components` 同一原子写,不会出现"组件更新了但基线没跟上";
    //    · **失败一律不动**(recordOperationFailure 不碰它)—— 与"失败不动 phase"同一条原则:
    //      没成功就不许改写"现实是哪一版";
    //    · legacy 收养路径没有 operation ⇒ 保持既有值(通常也没有)⇒ 基线判定按"缺基线"fail-closed,
    //      **不**要求审批(否则存量 target 补组件会被自己挡死)。
    ...(observed.operation?.sourceRef ? { baselineRef: observed.operation.sourceRef } : {}),
  };
  delete postObserved.operation;
  delete postObserved.lastError;

  const guards: TransitionGuard[] = [
    { path: "probe", equals: input.probe },
    { path: "probe.ok", equals: true },
    { path: "probe.at", equals: input.probe.at },
  ];
  if (input.evidence.kind === "legacy") {
    guards.push({ path: "status", equals: input.evidence.status });
    guards.push({ path: "components", equals: input.evidence.components });
    guards.push({ path: "region", equals: input.evidence.probeInput.region });
    guards.push({ path: "accountId", equals: input.evidence.probeInput.accountId });
    guards.push({ path: "partition", equals: input.evidence.probeInput.partition });
    guards.push(
      input.evidence.probeInput.resources === undefined
        ? { path: "resources", absent: true }
        : { path: "resources", equals: input.evidence.probeInput.resources }
    );
    guards.push(
      input.evidence.probeInput.agentcore === undefined
        ? { path: "agentcore", absent: true }
        : { path: "agentcore", equals: input.evidence.probeInput.agentcore }
    );
    guards.push(
      input.evidence.ready === undefined
        ? { path: "ready", absent: true }
        : { path: "ready", equals: input.evidence.ready }
    );
    if (input.evidence.mode === "stable") {
      guards.push({ path: "deployLockToken", absent: true });
      guards.push({ path: "deployLockExpiresAt", absent: true });
      guards.push({ path: "deployLockOperationId", absent: true });
    }
  }

  await transitionPhase(targetId, {
    from: observed.phase,
    ifAbsent,
    post: { spec, observed: postObserved },
    expectedVersion: input.evidence.expectedVersion,
    guards,
    ...(completionFence ? { completionFence } : {}),
    ...(legacyCompletionFence ? { legacyCompletionFence } : {}),
    reason:
      input.evidence.kind === "deploy"
        ? `complete deploy ${input.evidence.operationId}`
        : "adopt legacy after fresh green probe",
  });

  return { advanced: true };
}

/**
 * 🔴 纯判定:该 target 是否需要 finalize(§21.5)—— 避免 route 再抄一份 status/phase 组合。
 */
export function deploymentNeedsFinalize(target: ExecutionTarget): boolean {
  const hasSpec = target.spec !== undefined;
  const hasObserved = target.observed !== undefined;
  if (hasSpec !== hasObserved) {
    throw new LifecyclePreconditionError("spec/observed 只存在一侧");
  }
  if (!hasObserved) {
    specObservedOf(target); // strict legacy schema;不得只读 status/ready 绕过 probe/components 校验。
    return target.ready === true
      ? target.status === "initializing" || target.status === "upgrading"
      : target.status === "initializing" || target.status === "testing";
  }

  const { observed } = specObservedOf(target);
  if (observed.operation?.kind === "deploy") return true;
  if (observed.phase === "provisioning" && !observed.operation) {
    if (observed.lastError) return false; // 已收敛 failed 投影;由显式 retry/recovery 开新会话。
    throw new LifecyclePreconditionError(
      "provisioning 缺 lifecycle operation/lastError,必须走损坏恢复,不能由普通 probe 猜 finalize"
    );
  }
  // verifying/no-op = 初装完成后等待独立 enable 的正常态;ready/no-op = 稳定服务态。两者都只写 probe telemetry。
  return false;
}

/** base/core 两栈各自必须给出的 OutputKey(栈组的合同:OutputKey = 描述符字段名,中间零映射表)。 */
const BASE_STACK_OUTPUT_KEYS = ["vpcId", "dataKeyArn", "privateSubnetIds", "targetId"] as const;
/**
 * 🔴🔴 base 栈的**网络观测** Output —— **读到才写,缺不算合同破坏**(老版本的 base 栈没有它们)。
 *
 * 【为什么补这一条:一个「写了没接上」的真缺陷】让 base 栈输出了 `endpointIds` /
 * `crossRegionDdbEndpointId` / `homeLinkHostedZoneId`,探活(`probe-runner`)也照它们写了
 * `network:egress-none` / `network:home-link` 两项 —— 但**没有人把这些 Output 装进资源袋**:
 * 下面的组装是一张**写死的键清单**,只含 vpcId / dataKeyArn / privateSubnetIds。
 * 于是 `res.endpointIds` 恒为 undefined ⇒ 探活的灰度门 `switchedToZeroEgress` **恒为 false**
 * ⇒ 那两项探活**从来没跑过**(而单测与门禁全绿,因为两边各自都对)。
 * 这正是记忆里 [[unwired-code-is-unverified]] 的形状:**缺陷在接缝上**。
 * ⇒ 键清单从此含它们;新增 base 侧观测字段只要进这个数组就自动落库。
 */
const BASE_STACK_OPTIONAL_OUTPUT_KEYS = [
  "vpcCidr",
  "endpointIds",
  "homeLinkPeeringId",
  "homeLinkHostedZoneId",
] as const;
const CORE_STACK_OUTPUT_KEYS = [
  "datalakeBucket",
  "scriptsBucket",
  "tableBucket",
  "athenaWorkgroup",
  "glueRoleArn",
  "emrSecurityGroupId",
  "emrSubnetIds",
  // core 栈从此必吐 EMR 执行角色(SPEC v3.21 §6.1 段二);栈是后的版本才有它
  // 旧版栈缺它 ⇒ finalize 整轮拒(一个字节都不写),这正是「先重新部署再回写」的顺序保证。
  "emrExecutionRoleArn",
] as const;

/**
 * 🔴 **部署回写(§1.1 部署期真调用方;DESIGN:591 定案)**:从目标 region 的 CFN Outputs 组装
 * 实名资源袋,经 `reconcileTarget`(自带允许列表 + 维修态条件 + 合并后整包校验)落库。
 *
 * 为什么从 DescribeStacks 而不是 buildspec 回写:§12.7 —— buildspec 末尾的 update-item 仅 build
 * 成功才跑,部分成功后失败会让注册表陈旧;CFN Outputs 是**真实资源的权威 SSOT**,平台侧随时可重放。
 * 🔴 缺任何一个 Output ⇒ **一个字节都不写**(§20.11-N2:半份描述符比没有更糟)。
 *
 * 🔴 **同时回写 `components`(observed 语义)**:值 = `core` + 真读到栈且 Output 齐的可选组件。
 *    这意味着它**可能变短** —— 注册时勾了 redshift 但那个栈没部署成功,回写后 components 里就没有它。
 *    这是刻意的:注册表宁可如实反映"现在真装了什么",也不保留一个没有资源支撑的声称
 *    (desired 与 observed 的分离字段归后续批次,见 SPEC §3.5 desired/observed)。
 */
export async function finalizeTargetResources(
  targetId: string,
  opts: { fence: FinalizeLifecycleFence }
): Promise<Record<string, unknown>> {
  assertTargetId(targetId);
  const current = await getTargetRaw(targetId);
  if (!current) throw new LifecyclePreconditionError(`执行目标不存在:${targetId}(先 register)`);
  if (typeof current.version !== "number") {
    throw new LifecyclePreconditionError(`target ${targetId} 缺 version(乐观锁)—— item 不是 register 通道落的,拒绝回写`);
  }
  // 🔴 §21.1.1:在**任何 CFN read 与下游写之前**先核 route 初读时构造的 exact fence ——
  //    probe route 核验 operation A 的 build 成功后,A 可能在本函数首读前已被 B 替换;若从"当前 B"重取
  //    operation,A 的 CFN 结果会先污染 B。下游 reconcile/merge 也必须继续传同一个 opts.fence,不能从二次读重建。
  assertFinalizeFence(current, opts.fence);
  // 取数在独立模块(顶层 import 的 CFN client;🔴 动态 import 的 vi.mock 实测拦不住,
  // 曾让单测拿本机凭证真打 AWS —— 见 stack-outputs.ts 文件头)。"栈不存在"转本层的 409 语义。
  let outs: ExecEnvStackOutputs;
  try {
    outs = await readExecEnvStackOutputs(current.region, targetId);
  } catch (e) {
    throw new LifecyclePreconditionError(String((e as Error)?.message ?? e));
  }
  const { base, core } = outs;

  // 交叉:base 栈自报的 targetId 必须就是本 target(防"查错栈 / 同 region 另一个 target 的栈")。
  if (base.targetId !== targetId) {
    throw new LifecyclePreconditionError(
      `base 栈自报 targetId=${JSON.stringify(base.targetId)} ≠ ${targetId} —— 拒绝把别人的资源写进本描述符`
    );
  }

  const missing: string[] = [];
  for (const k of BASE_STACK_OUTPUT_KEYS) if (!base[k]) missing.push(`base.${k}`);
  for (const k of CORE_STACK_OUTPUT_KEYS) if (!core[k]) missing.push(`core.${k}`);
  if (missing.length) {
    throw new LifecyclePreconditionError(
      `CFN Outputs 缺:${missing.join(", ")} —— 栈组合同(§4.1a:OutputKey=描述符字段名)被破坏或部署不完整;` +
        `🔴 缺一个就一个字节都不写(§20.11-N2:半份描述符比没有更糟)`
    );
  }

  // 组装资源袋:逗号串 Output(子网列表)split 成数组;targetId 是交叉校验字段,不进袋。
  const resources: Record<string, unknown> = {
    vpcId: base.vpcId,
    dataKeyArn: base.dataKeyArn,
    privateSubnetIds: base.privateSubnetIds.split(",").filter(Boolean),
    datalakeBucket: core.datalakeBucket,
    scriptsBucket: core.scriptsBucket,
    tableBucket: core.tableBucket,
    athenaWorkgroup: core.athenaWorkgroup,
    glueRoleArn: core.glueRoleArn,
    emrExecutionRoleArn: core.emrExecutionRoleArn,
    emrSecurityGroupId: core.emrSecurityGroupId,
    emrSubnetIds: core.emrSubnetIds.split(",").filter(Boolean),
  };
  // base 的网络观测键(读到才写;见上面那段「写了没接上」的说明)
  for (const k of BASE_STACK_OPTIONAL_OUTPUT_KEYS) if (base[k]) resources[k] = base[k];

  // ── 可选组件栈:**observed 语义 —— 只声称"真读到栈"的组件** ─────────────
  // 🔴 为什么组件集由这里回写、而不是由 add-components 端点写:G 批 P1-1 的教训 ——
  //    资源真实存在**之前**绝不声称装了某组件(声称了没装,下推任务时才在很远的地方炸)。
  //    add-components 只触发部署;"装上了"这件事由本函数在读到栈的 Outputs 之后才写。
  // 🔴 每个组件"必须给哪些 Output" **直接复用 `COMPONENT_REQUIRED_RESOURCES`**(§3.1a 的配套映射),
  //    不另列一份清单:栈组合同就是 "OutputKey = 描述符字段名",所以两者本来是同一份知识
  //    (change-safety A1:宁可推导,不要第二处定义)。
  const observedComponents: string[] = ["core"];
  for (const comp of Object.keys(outs.components ?? {})) {
    const compOuts = outs.components[comp] ?? {};
    const need = COMPONENT_REQUIRED_RESOURCES[comp] ?? [];
    const missingComp = need.filter((k) => !compOuts[k]);
    if (missingComp.length) {
      // 栈**存在**却缺合同要求的 Output ⇒ 栈组合同被破坏,与 core 缺 Output 同级处理:
      // 一个字节都不写(不是"那就不声称这个组件"——那会把合同破坏静默藏起来)。
      throw new LifecyclePreconditionError(
        `组件栈 ${comp} 的 CFN Outputs 缺:${missingComp.map((k) => `${comp}.${k}`).join(", ")} —— ` +
          `栈组合同(OutputKey=描述符字段名)被破坏;🔴 缺一个就一个字节都不写(§20.11-N2)`
      );
    }
    // 只取合同声明的键:防一个组件栈往资源袋里塞未登记字段(袋子是路由输入,面要窄)。
    for (const k of need) resources[k] = compOuts[k];
    // 合同声明的**可选**键(读到才写;缺不算合同破坏 —— 旧版组件栈没有它们)
    for (const k of COMPONENT_OPTIONAL_RESOURCES[comp] ?? []) if (compOuts[k]) resources[k] = compOuts[k];
    observedComponents.push(comp);
  }

  // ── 落库:按 target 是否**已在承接流量**分两条通道(真跑撞出的合同缺口)──────────
  // 🔴 首装(ready 未置)走 **reconcileTarget**:它的维修态条件 + 合并后 §3.1a 整包校验就是这次
  //    写入的门,不绕开不复刻。`components` 与 `resources` **同一次**写(分两次会出现"声称了组件
  //    但资源还没落"的中间态)。
  // 🔴 **补充部署**(target 已 ready=true)走窄通道 `mergeComponentResources`:reconcile 的维修态门
  //    要求 `ready=false`,而"给一个已启用的环境加组件"是 §2.1/§4.6 明文认可的生命周期操作
  //    ⇒ 门本身没有给它通道,这是**合同缺口**(实测:dms 栈真建成了,回写被拒、组件永远进不了注册表)。
  //    修法**不是**放宽那道门(四轮审核盯着它),而是照本模块既有先例(`writeProbeResult` 就是为
  //    "active 后周期探活"开的窄通道)另开一条**只增不改**的通道:见该函数的四条硬约束。
  const orderedComponents = orderComponents(observedComponents);
  if (current.ready === true) {
    await mergeComponentResources(targetId, {
      components: orderedComponents,
      resources,
      expectedVersion: current.version,
      finalizeFence: opts.fence,
    });
  } else {
    await reconcileTarget(
      targetId,
      { resources, components: orderedComponents },
      { expectedVersion: current.version, finalizeFence: opts.fence }
    );
  }
  return resources;
}

/**
 * base 栈的网络观测键(补充部署通道允许**只增**)。与 `BASE_STACK_OPTIONAL_OUTPUT_KEYS` 同源,
 * 不另抄一份 —— 抄一份就会出现「finalize 写了、窄通道拒了」这种两处不一致。
 */
const BASE_OBSERVED_ADDABLE_KEYS: ReadonlySet<string> = new Set<string>(BASE_STACK_OPTIONAL_OUTPUT_KEYS);

/**
 * 🔴🔴 **集合型**观测键(逗号分隔的 id 集合)。这类键的「只增不改」判定必须按**集合**来,
 * 不能按字符串逐字节比 —— 否则一次合法的重新部署(多建了一个接口端点)会把整个 target **永久堵死**。
 *
 * 【真环境实测(2026-09-16,段 `w3h` 之后)】重新部署给 us-west-2 多建了一个接口端点
 * (12 → 13 个),finalize 于是报「拒绝改写已有资源 resources.endpointIds」⇒ 不 finalize
 * ⇒ target 停在 `upgrading` 且**部署锁一直held**⇒ 之后任何运维动作(补充部署…)都被拒:
 * 「必须走 finalize/probe」,而 probe 恰恰又 finalize 不了 —— **死锁**
 * (与「一个集合被当成两件事用 ⇒ 夹缝里的对象被永久堵死」同族)。
 *
 * 口径:① 集合**相等**(顺序无关)⇒ 视为无变化,不写(顺便消掉「CFN Output 顺序不保证」这颗雷:
 * 逐字节比会把重排当成改写);② 旧成员**一个都不少**且有新增 ⇒ 允许(这就是「只增」);
 * ③ 少了 / 换了旧成员 ⇒ **照旧拒**(那是在线改路由,必须走维修态)。
 * 🔴 只放这一个键:它是**纯观测**(探活的零出网灰度门读它),不是任何执行落点的路由输入。
 */
const SET_VALUED_OBSERVED_RESOURCE_KEYS: ReadonlySet<string> = new Set<string>(["endpointIds"]);

function idSetOf(x: unknown): Set<string> | undefined {
  if (typeof x !== "string") return undefined;
  const parts = x.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  return parts.length ? new Set(parts) : undefined;
}

/** 集合型键的三态判定:`same`(集合相等)/ `grew`(旧成员全在 + 有新增)/ `changed`(其它,拒)。 */
export function setValuedResourceVerdict(before: unknown, after: unknown): "same" | "grew" | "changed" {
  const a = idSetOf(before);
  const b = idSetOf(after);
  if (!a || !b) return "changed";
  let missing = false;
  a.forEach((m) => { if (!b.has(m)) missing = true; });
  if (missing) return "changed";                          // 旧成员少了 / 被换掉
  if (b.size === a.size) return "same";                  // 集合相等(顺序无关)
  return "grew";
}

/** 组件私有的资源键集合(= §3.1a 配套映射的值域)。core/base 的键**不在**里面,故窄通道碰不到它们。 */
const COMPONENT_OWNED_RESOURCE_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(COMPONENT_REQUIRED_RESOURCES).flatMap((v) => [...v]),
  // 组件可选键同属组件私有(它们的写入另受执行角色键规则 ② 的 SSOT 名判定,见下)
  ...Object.values(COMPONENT_OPTIONAL_RESOURCES).flatMap((v) => [...v]),
]);

/**
 * 🔴 **补充部署的窄写通道**:给**已启用**(ready=true)的 target 追加组件的实名资源。
 *
 * 【为什么不走 reconcileTarget】它要求 `ready=false`(维修态),理由是"对正在承接流量的 target 改
 * resources = 在线改路由"。那个理由对**改**成立,对**加**不成立:加一个 `dmsSubnetGroup` 不会动
 * `datalakeBucket` 一个字节。而 §2.1 `add-components` / §4.6 明文认可"对 active 环境补充部署"
 * ⇒ 缺的是通道,不是应该放宽那道门。先例:`writeProbeResult` 同样为"active 后周期探活"另开窄通道。
 *
 * 【四条硬约束(缺一条这个通道就变成 reconcile 的后门)】
 *   ① **只许碰组件私有键**:任何不在 `COMPONENT_OWNED_RESOURCE_KEYS` 里的键一律拒
 *      —— core/base 的资源(桶、VPC、CMK、Glue 角色)绝不经本通道改写;
 *   ② **只增不改**:已存在的键若与来值**不等**一律拒(改值 = 在线改路由,正是那道门要防的);
 *   ③ **组件集只增不减**:不许经本通道摘掉组件(摘组件是删除流程的地盘);
 *   ④ **post-image 过 §3.1a 整包校验**,且 `version` 乐观锁 + `ready` 必须仍为 true(读后条件写防 TOCTOU)。
 * 身份/位置/状态/凭证状态机字段**一个都不在** UpdateExpression 里。
 */
export async function mergeComponentResources(
  targetId: string,
  input: { components: string[]; resources: Record<string, unknown>; expectedVersion: number; finalizeFence: FinalizeLifecycleFence }
): Promise<void> {
  assertTargetId(targetId);
  if (!Number.isInteger(input?.expectedVersion)) {
    throw new LifecyclePreconditionError(`expectedVersion 须为整数(收到 ${String(input?.expectedVersion)})`);
  }
  const current = await getTargetRaw(targetId);
  if (!current) throw new LifecyclePreconditionError(`执行目标不存在:${targetId}`);
  if (current.ready !== true) {
    throw new LifecyclePreconditionError(
      `mergeComponentResources 只服务**已启用**的 target(ready=true);未启用的走 reconcileTarget 的维修态通道`
    );
  }
  // 🔴 §21.3:本函数是 finalize 专用窄写,**不提供无 fence 入口**。绑定 route 初读时已验证成功的 exact build:
  //    modern(ready 升级中)必须 fence.kind=deploy ∧ intent=serve ∧ phase=ready ∧ 有 deploy operation;
  //    legacy(升级前部署遗留的 bug#11 item:initializing/upgrading ∧ ready=true)才允许 legacy fence 在线 merge。
  const hasSpec = current.spec !== undefined;
  const hasObserved = current.observed !== undefined;
  if (hasSpec !== hasObserved) {
    throw new LifecyclePreconditionError("spec/observed 只存在一侧,拒绝 merge");
  }
  if (input.expectedVersion !== input.finalizeFence.expectedVersion) {
    throw new LifecyclePreconditionError("merge expectedVersion 与 finalize fence 不一致");
  }
  assertFinalizeFence(current, input.finalizeFence);
  const axes = hasObserved ? specObservedOf(current) : undefined;
  let operation: DeployOperation | undefined;
  if (axes) {
    operation = axes.observed.operation;
    if (
      input.finalizeFence.kind !== "deploy" ||
      axes.spec.intent !== "serve" ||
      axes.observed.phase !== "ready" ||
      operation?.kind !== "deploy"
    ) {
      throw new LifecyclePreconditionError(
        `补组件 merge 前置不满足(intent=${axes.spec.intent},phase=${axes.observed.phase},operation=${operation?.kind ?? "无"})`
      );
    }
  } else if (input.finalizeFence.kind !== "legacy" || !["initializing", "upgrading"].includes(current.status)) {
    // 只为升级前部署遗留的 bug#11 item 保留 legacy 兼容;普通 active legacy 不能直接在线 merge。
    throw new LifecyclePreconditionError(`legacy merge 前置不满足(status=${current.status})`);
  }
  const existing = (current.resources ?? {}) as Record<string, unknown>;
  const existingComponents = Array.isArray(current.components) ? current.components.filter((c) => typeof c === "string") : [];

  // ① 只许碰组件私有键 + ② 只增不改
  const additions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.resources)) {
    const before = existing[k];
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(v)) continue; // 值相同 ⇒ 无需写
    // ──:执行角色键的**唯一例外**(SPEC v3.21 §3.1a 规则 ②)────────────────
    // 已启用 target 从「共享 home 角色」切到「本 target 角色」只能经本通道回写,而 ①② 会把它拒掉
    // (glueRoleArn 是 core 键且值变了;emrExecutionRoleArn 是 core 新键)。例外只放两种、且由命名 SSOT 判定:
    //   「新增」= 前值不存在 ∧ 新值角色名 = 本 target 名;「切换」= 前值角色名 = 该 kind 的 home 名 ∧ 新值 = 本 target 名。
    // 其它任何形态(切成别的 target / 切回 home / 非 ARN)照旧拒 —— 桶 / workgroup / 凭证一个字节都碰不到。
    if (isExecRoleResourceKey(k)) {
      const verdict = execRoleRotationVerdict(targetId, k, before, v);
      if (!verdict) {
        throw new LifecyclePreconditionError(
          `拒绝写 resources.${k}=${JSON.stringify(v)}:执行角色键只许「新增本 target 的角色」或「home 角色 → 本 target 角色」单向切换` +
            `(SPEC §3.1a 执行角色键 ②;前值 ${JSON.stringify(before ?? null)})`
        );
      }
      additions[k] = v;
      continue;
    }
    if (before !== undefined) {
      // 集合型观测键按**集合**判(见 SET_VALUED_OBSERVED_RESOURCE_KEYS 注释)
      if (SET_VALUED_OBSERVED_RESOURCE_KEYS.has(k)) {
        const verdict = setValuedResourceVerdict(before, v);
        if (verdict === "same") continue;   // 只是顺序不同 ⇒ 无变化,不写
        if (verdict === "grew") {
          additions[k] = v;                 // 旧成员一个不少 + 有新增 = 「只增」
          continue;
        }
      }
      if (JSON.stringify(before) !== JSON.stringify(v)) {
        throw new LifecyclePreconditionError(
          `拒绝改写已有资源 resources.${k}(${JSON.stringify(before)} → ${JSON.stringify(v)})—— ` +
            `本通道**只增不改**;改既有资源 = 在线改路由,须走维修态(先 drain / 置 ready=false)`
        );
      }
      continue; // 值相同 ⇒ 无需写
    }
    // base 的**网络观测**键允许「只增」——
    //   它们不是路由输入(只被探活读),而「一个已启用的环境第一次装上跨区通路」正是升级路径:
    //   若一律拒,重新部署会在回写这一步整轮失败(而资源其实已经建好了 ⇒ 最难查的那种不一致)。
    //   🔴 **改**它们仍然拒 —— 上面那段「只增不改」的检查在此之前就跑了。
    if (!COMPONENT_OWNED_RESOURCE_KEYS.has(k) && !BASE_OBSERVED_ADDABLE_KEYS.has(k)) {
      throw new LifecyclePreconditionError(
        `拒绝经补充部署通道新增非组件资源键 resources.${k} —— 本通道只许写 §3.1a 组件配套映射里的键` +
          `(core/base 资源要变必须走维修态)`
      );
    }
    additions[k] = v;
  }
  // ③ 组件集只增不减
  const dropped = existingComponents.filter((c) => !input.components.includes(c));
  if (dropped.length) {
    throw new LifecyclePreconditionError(
      `拒绝经补充部署通道摘掉组件:${dropped.join(", ")} —— 摘组件是删除流程(§4.6)的地盘`
    );
  }
  // 去重不用 [...new Set()](本仓 tsconfig target 不允许 Set 展开;filter 同效且零依赖)
  const mergedRaw = [...existingComponents, ...input.components].filter((c, idx, arr) => arr.indexOf(c) === idx);
  const merged = orderComponents(mergedRaw);
  const componentsChanged = JSON.stringify(merged) !== JSON.stringify(existingComponents);
  if (Object.keys(additions).length === 0 && !componentsChanged) return; // 幂等:没有增量就不写

  // ④ post-image 整包校验(校验不过一个字节都不写);modern 同步 observed.components(map-path,保留 operation)。
  const nextObserved = axes ? { ...axes.observed, components: merged } : undefined;
  const candidate = {
    ...current,
    resources: { ...existing, ...additions },
    components: merged,
    ...(nextObserved ? { observed: nextObserved } : {}),
  } as ExecutionTarget;
  const violation = descriptorViolation(candidate, targetId);
  if (violation) {
    throw new LifecyclePreconditionError(
      `拒绝补充部署回写:合并后描述符整包校验不过 —— ${violation}`
    );
  }

  // 🔴 §21.3:基础 names **不预放 `#res`** —— 当 componentsChanged 但 additions={} 时,预放未使用会让真实
  //    DynamoDB 抛 ValidationException(普通 Command mock 测不出)。只有真有 addition 才注册 #res。
  const names: Record<string, string> = { "#r": "ready", "#v": "version", "#comp": "components" };
  const values: Record<string, unknown> = {
    ":true": true,
    ":expected": input.expectedVersion,
    ":next": input.expectedVersion + 1,
    ":comp": merged,
    ":t": new Date().toISOString(),
  };
  const sets = ["#comp = :comp", "#v = :next", "updatedAt = :t"];
  if (nextObserved) {
    names["#observed"] = "observed";
    names["#observedComponents"] = "components";
    values[":observedComponents"] = nextObserved.components;
    sets.push("#observed.#observedComponents = :observedComponents");
  }
  let resourceIndex = 0;
  for (const [key, value] of Object.entries(additions)) {
    if (resourceIndex === 0) names["#res"] = "resources";
    const nameKey = `#resourceKey${resourceIndex}`;
    const valueKey = `:resourceValue${resourceIndex}`;
    names[nameKey] = key;
    values[valueKey] = value;
    // `#res.#kN` map 路径写只增该键、不碰兄弟键(只增不改的承重线,不许改成整袋 resources = :resources)。
    sets.push(`#res.${nameKey} = ${valueKey}`);
    resourceIndex++;
  }

  // 读后条件写:version 乐观锁 + ready 仍为 true + route 传入的 exact finalize fence(不从 merge 的 current 重新生成)。
  const conditions = ["attribute_exists(sk)", "#v = :expected", "#r = :true"];
  appendFinalizeFence(names, values, conditions, input.finalizeFence);

  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/**
 * 🔴 **项目白名单的唯一写通道**(SPEC §1.1 `access?` / §2.1 `POST .../[targetId]/access`)。
 * 通用:任何 target(含 home)都可设;缺省 all-projects。
 * 为什么单独一条通道而不是塞进 reconcile / 窄通道:`access` 是**授权输入**,不属 resources(路由输入)也不属
 * spec/observed(生命周期);reconcile 只服务维修态、窄通道只碰组件私有资源键 —— 两条都不该为授权开口。
 * 条件写:`version` 乐观锁;身份 / 位置 / 状态 / 资源一个字段都不在 UpdateExpression 里。
 */
export async function setTargetAccess(
  targetId: string,
  rawAccess: unknown,
  opts: { expectedVersion: number }
): Promise<{ before: unknown; after: { mode: "all-projects" } | { mode: "allowlist"; projects: string[] } }> {
  assertTargetId(targetId);
  if (!Number.isInteger(opts?.expectedVersion)) {
    throw new LifecyclePreconditionError(`expectedVersion 须为整数(收到 ${String(opts?.expectedVersion)})`);
  }
  const after = parseTargetAccess(rawAccess); // 形态非法即抛(调用方映射 400)
  const current = await getTargetRaw(targetId);
  if (!current) throw new LifecyclePreconditionError(`执行目标不存在:${targetId}`);
  const before = current.access;
  const sets = ["#v = :next", "updatedAt = :t"];
  const names: Record<string, string> = { "#v": "version", "#access": "access" };
  const values: Record<string, unknown> = { ":expected": opts.expectedVersion, ":next": opts.expectedVersion + 1, ":t": new Date().toISOString() };
  let expr: string;
  if (after.mode === "all-projects") {
    // 缺省态不落字段(读侧 `parseTargetAccess(undefined)` = all-projects);REMOVE 让存量与新建形态一致
    expr = `SET ${sets.join(", ")} REMOVE #access`;
  } else {
    values[":access"] = after;
    expr = `SET ${sets.join(", ")}, #access = :access`;
  }
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: PK, sk: targetId },
        UpdateExpression: expr,
        ConditionExpression: "attribute_exists(sk) AND #v = :expected",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LifecycleConflictError(`设置授权项目被并发写入拒绝(version 已变),请刷新后重试:${targetId}`);
    }
    throw e;
  }
  return { before, after };
}

// 🔴 v3.15(§22):`markTargetTested` **已删除** —— 初装进入 verifying 由 `reconcileAfterProbe()`(携本次
//    fresh probe 的 completionFence)完成。旧 mark 的 legacy 首写路现结构性需要 fence(无法自造),modern 路也被
//    reconcileAfterProbe 取代 ⇒ 保留它=保留一条会误导的死路。它非用户功能(不在功能守恒清单),删除是收敛不是删功能。

/**
 * 🔴 **探活结果的专用写通道**(§3.5 探活写入方 —— stale 判定的时间源 `probe.at` 从此有真实来源)。
 *
 * 为什么不走 `reconcileTarget`(它的允许列表明明含 probe):reconcile 只接**维修态**,而周期探活
 * 恰恰要对 `active` 的 target 持续写 `probe.at` —— 不写,15min 后 stale gate 把整个健康 region 判死。
 * 本通道**只能 SET probe(+updatedAt)**,别的字段一个都碰不到,窄到不构成新的改路由面。
 * 刻意**不动 version**:probe 是运行时观测,不是合同内容变更;抢 version 会与管理操作的乐观锁打架。
 */
export async function writeProbeResult(targetId: string, probe: ProbeResult): Promise<void> {
  assertTargetId(targetId);
  // 🔴 §21.4:构造任何 UpdateCommand 前先 `parseProbeResult` —— 结构 + **canonical `at`** + ok===items.every(ok);
  //    坏 probe **零 DDB 写**。canonical at 是完成态 fence 做 exact 等值条件写的前提(非 canonical 会让完成写永远
  //    ConditionalCheckFailed);空 items 的 every() 恒 true 造假绿 ⇒ schema 已 .min(1) 挡。
  const parsed = parseProbeResult(probe);
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.EXECUTION_ENVS,
      Key: { pk: PK, sk: targetId },
      UpdateExpression: "SET probe = :p, updatedAt = :t",
      ConditionExpression: "attribute_exists(sk)",
      ExpressionAttributeValues: { ":p": parsed, ":t": new Date().toISOString() },
    })
  );
}

/**
 * 🔴 **启用:verifying→ready**(SPEC:37 状态机;INTERACTION §1.3「全绿 → 启用」)。
 *
 * 🔴 v3.15(§21.4.1):**只能消费本次 manual-enable 请求的 fresh probe**(`EnableLifecycleFence`),
 *    绝不读任意历史 `probe.ok` —— 否则绕过 exact coverage / desired===observed 协议。route 在同一次 POST 内
 *    真探 → 写 raw probe(不涨 version)→ 构造 fence → 调本函数;真正裁决由 transitionPhase 的 enableFence 条件写完成。
 *    本函数的 early check 只为好错误,**不替代** DDB 条件(read-then-write 之间的变化由条件写拒)。
 */
export async function enableTarget(targetId: string, opts: { fence: EnableLifecycleFence }): Promise<void> {
  assertTargetId(targetId);
  const current = await getTargetRaw(targetId);
  if (!current || current.version !== opts.fence.expectedVersion) {
    throw new LifecyclePreconditionError("enable evidence version 已变化(读回 version 与 fence.expectedVersion 不符)");
  }
  const { spec, observed } = specObservedOf(current);
  // 🔴 逐项报名,不再是一条巨型 `||`。
  //
  // 【为什么改】原来是 9 个条件挤在一个 `||` 里、报错只说"fence 已变化"。2026-09-03 真环境:
  //   页面点「启用」**每次必 409**,而拒因文案对定位毫无帮助 —— 只能翻 DDB + 逐条排除,白花两轮。
  //   这类"N 个条件错哪个都不说"的判据本身就是缺陷(与本轮 legacyCompletionFence 同一教训)。
  //
  // 🔴 【那次 409 的真根因,记在这儿别再犯】最后一项原本是
  //      `JSON.stringify(current.probe) !== JSON.stringify(opts.fence.probe)`
  //   而两边**来源不同**:`fence.probe` 是 `runProbe()` 的**内存对象**,`current.probe` 是
  //   **DynamoDB 往返**回来的 —— DDB 的 Map 属性**不保证键序**,于是逐字节比**必不相等**
  //   ⇒ 启用永久 409(fail-closed 自锁)。旁边的 `sameProbeInput` 早就用了 canonical(键排序)序列化,
  //   偏偏这一项用裸 stringify —— 同一个函数里两种口径。
  //   ⇒ **规则**:凡"内存对象 vs DDB 往返对象"的比较,一律走 `reconcileCanonicalJson`;
  //     裸 `JSON.stringify` 只可用于**同源**(都来自 DDB / 都来自内存)的比较。
  const failures: string[] = [];
  if (observed.phase !== "verifying") failures.push(`phase=${observed.phase}(须 verifying)`);
  if (observed.operation !== undefined) failures.push(`存在在途 operation(${observed.operation.operationId})`);
  if (current.deployLockToken !== undefined) failures.push("残留 deployLockToken");
  if (current.deployLockExpiresAt !== undefined) failures.push("残留 deployLockExpiresAt");
  if (current.deployLockOperationId !== undefined) failures.push("残留 deployLockOperationId");
  if (!sameProbeInput(current, opts.fence.probeInput)) failures.push("probeInput 已变化(partition/components/resources/agentcore)");
  if (!sameStrings(spec.desiredComponents, opts.fence.desiredComponents)) failures.push("spec.desiredComponents 已变化");
  if (!sameStrings(observed.components, opts.fence.observedComponents)) failures.push("observed.components 已变化");
  if (reconcileCanonicalJson(current.probe) !== reconcileCanonicalJson(opts.fence.probe)) {
    failures.push("本次探活结果与 fence 不是同一份(probe 内容变化)");
  }
  if (failures.length > 0) {
    throw new LifecyclePreconditionError(
      `enable fresh probe/axes/input fence 已变化(须无 operation/无残留锁 ∧ 本次探活 == fence):${failures.join(";")}`
    );
  }
  const postObserved: TargetObserved = {
    ...observed,
    phase: "ready",
    health: "healthy",
    probe: opts.fence.probe,
    lastReconcileAt: new Date().toISOString(),
  };
  await transitionPhase(targetId, {
    from: "verifying",
    expectedVersion: opts.fence.expectedVersion,
    post: { spec, observed: postObserved },
    enableFence: opts.fence,
    reason: "manual enable after fresh exact-green probe",
  });
}

/**
 * 取 home target。
 *
 * 🔴 **v3.4:只读,不再自愈**(外部审核 v2 P1-1)。缺失/不完整 ⇒ 抛 `TargetNotReadyError`,
 * 错误信息指向 seed 入口。旧实现在**读路径写库**:第一个到达的运行时请求会抢先落下一个
 * `accountId=""`、缺 core 资源、却 `ready=true` 的描述符,而条件写保证后续正确 seed **永远补不上**。
 */
export async function getHomeTarget(): Promise<ExecutionTarget> {
  const r = await admit(HOME_TARGET_ID);
  if ("target" in r) return r.target;
  throw new TargetNotReadyError(
    HOME_TARGET_ID,
    `${r.why};home 描述符须由**部署期** seed(seedHomeTarget,SPEC §1.1 v3.4),` +
      `平台读路径不再自愈写库 —— 部署期真调用方另有归属`
  );
}

/** 便捷判定:该 targetId 是否 home(re-export,免调用方再 import 两个模块)。 */
export { isHome, HOME_TARGET_ID };
