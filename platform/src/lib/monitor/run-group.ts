// @kf-batch 50-W3f-T0-T3
// 模块 50 —— 多区运行的**关联标识** `runGroupId`(50 ROADMAP §2octies.17 ⑤ / 门票 T2)。
//
// 用户原话:「在主控区创建任务下发到多个区域,这些任务会产生关联性,后续主控区执行可以选择联动」。
// 承载关联性的是将来的持久 RunGroup 父对象(O2:整组看 / 一键取消 / 只重试失败区);
// **本刀只透传**:一次点「运行」扇出到 N 个区 ⇒ N 条 run 行带同一个 runGroupId;
// 单区运行**不带**(没有关联性可言;带了反而让读侧「有 runGroupId = 多区运行」这条判据失真)。
//
// 🔴 为什么现在就落字段:run 行是**只追加**的历史事实。今天不盖、明天做 O2 时这批 run 就永远归不了组
//    (与 W2-a 盖 {projectId,targetId} 同一道理:掉头成本的门在数据不在代码)。
// 🔴 定时触发的分组键(`definitionId + scheduledTime + definitionVersion` 的确定性键)**刻意不在本刀**:
//    它要改 Python DAG 侧(runtime-lib 升版),归 O2;这里只有手动 / API 扇出这一条 TS 路径。
import { ulid } from "ulid";
// @kf-batch 50-WP5-rungroup —— 只取类型(编译期擦除,不给运行期/边缘面加任何依赖)。
import type { ResourceType } from "@/lib/versions/version-service";

/** run 行上的属性名 —— 写通道 / 门禁 / 验收脚本共用同一份真值,不各写字符串。 */
export const RUN_GROUP_ATTR = "runGroupId" as const;

/** 组 id 的两种形态前缀:手动 / API 扇出 vs 定时确定性键(§3.17.2)。单一真值,门禁与验收脚本共用。 */
export const MANUAL_RUN_GROUP_PREFIX = "rg_" as const;
export const SCHEDULED_RUN_GROUP_PREFIX = "rgs_" as const;

/** 形态:`rg_` + ULID(26 位 Crockford base32,大写)。写通道按它校验,别的字符串(比如 targetId)进不来。 */
export const RUN_GROUP_ID_PATTERN = /^rg_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isRunGroupId(v: unknown): v is string {
  // @kf-batch 50-WP5-rungroup —— 两种形态都是合法的组 id(手动扇出 `rg_<ULID>` / 定时确定性 `rgs_<24hex>`)。
  // 🔴 写通道用它做守卫 ⇒ 漏掉 `rgs_` 那一支的故障形态是「定时运行整批写不进台账」(而不是「没分组」)。
  return isManualRunGroupId(v) || isScheduledRunGroupId(v);
}

/**
 * 一次运行请求要不要分组:**多于一个 target 才分组**。
 * 调用方(运行路由)在扇出循环**之前**调一次,把同一个值传给每一条 run。
 * 单区返回 `undefined` ⇒ 写通道不落该属性(不是 null、不是空串)。
 *
 * 🔴 **`forceGroup` 的唯一正当用途 = 重试链**(WP-5 步 4 落地时暴露的合同冲突):
 * 「只重试失败区」若只剩**一个**区失败,按上面那条规则就不成组 ⇒ 新的一次运行**回指不到原组**,
 * 而 E-162 明确要求这条链可点回。重试**本来就是上一次联动的延续**,所以它成组是对的;
 * 普通单区运行照旧不成组(E-166)。
 */
export function runGroupIdFor(
  targets: readonly string[],
  opts: { forceGroup?: boolean } = {}
): string | undefined {
  return targets.length > 1 || opts.forceGroup ? `${MANUAL_RUN_GROUP_PREFIX}${ulid()}` : undefined;
}

// ─────────────────────── O2(WP-5):持久父对象的形态契约 ───────────────────────
// @kf-batch 50-WP5-rungroup —— 50 SPEC v3.44 §1.3a S7 / §2.7 / §3.17。
//
// 🔴 本文件**只放形态与词汇**(它被 DAG 生成器与运行路由一路引到,依赖越轻越好 ——
//    `instrumentation` 可达面碰上 node 内置会直接构建失败,记忆 instrumentation-edge-bundle-boundary)。
//    确定性键的 sha256 计算落在独立模块(施工序第 5 步),不进这里。

/**
 * 组所属定义的种类。
 * 🔴 **刻意复用模块 14 既有的单一作者 `ResourceType`**(`workflow|etl-job|sync|redshift-task|engine-job`),
 * 不另造一套「资源词汇」—— 同一概念两套表示必然各自漂移(SSOT/A1;本仓 `targetType` 的
 * warehouse 事故就是「planner 一套词、路由另一套词」造出来的)。
 */
export type RunGroupDefinitionKind = ResourceType;

/**
 * 定时触发的**确定性**组键形态:`rgs_` + sha256 前 24 hex(小写)。
 * 为什么要确定性:同一个 cron 在 N 个区各自的调度器上触发,两个区之间**不通信**(区域自治),
 * 只能各自算出同一个 id 才归得成一组(§3.17.2)。
 */
export const SCHEDULED_RUN_GROUP_ID_PATTERN = /^rgs_[0-9a-f]{24}$/;

/** GSI 名(§1.3a S7):「这个定义最近的几次联动运行」。写死字符串会与 infra 漂移,一律引这里。 */
export const RUN_GROUPS_GSI_BY_DEFINITION = "byDefinition" as const;

/**
 * 组状态词表(§3.17.1)。**穷举**且刻意不合并两对:
 * · `partial-failed` ≠ `failed` —— 折成 failed 会让用户不去看已经成功那个区的产物;
 * · `cancelled` ≠ `failed` —— 取消是用户的动作、失败是系统的结果,合并了「一键取消」就没法验成功。
 */
export const RUN_GROUP_STATUSES = [
  "submitting",
  "running",
  "succeeded",
  "partial-failed",
  "failed",
  "cancelled",
] as const;
export type RunGroupStatus = (typeof RUN_GROUP_STATUSES)[number];

export function isScheduledRunGroupId(v: unknown): v is string {
  return typeof v === "string" && SCHEDULED_RUN_GROUP_ID_PATTERN.test(v);
}

export function isManualRunGroupId(v: unknown): v is string {
  return typeof v === "string" && RUN_GROUP_ID_PATTERN.test(v);
}
