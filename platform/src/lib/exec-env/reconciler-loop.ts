// @kf-batch 50-P50.3b-2a-reconciler
// P50.3b-2a:周期 reconciler 的【进程内驱动】(SPEC §3.5a / DESIGN §20.24)。
//
// 运行体 = 现有常驻平台服务(ApplicationLoadBalancedFargateService,desiredCount 2~6),由 src/instrumentation.ts
//   的 register() 在 nodejs runtime 启动一次。每 tick:选主(leader-lease)→ 若当选,遍历 listTargetsRaw() →
//   对每个 target 调 reconcileOneTarget(**与人点「检测初始化」同一份 SSOT**),逐 target try/catch 隔离。
//
// 🔴 为什么"进程内 lease 单例"(而非独立定时 ECS 任务 / 外部定时→内部端点):探活今天就在这进程里跑(probe 路由)⇒
//   零新基础设施/IAM/镜像/HTTP 端点、同一条 ambient 凭证、零漂移(选型台账见 DESIGN §20.24)。
// 🔴 tick 周期 ≤ 15min stale 阈值 / 3(=5min),取 4min 留裕度;lease 8min ⇒ leader 猝死缺口 ≈12min < 15min。
// 🔴 递归 setTimeout(非 setInterval):tick 跑完才排下一次 ⇒ 天然不重叠(target 多时也不会堆积并发)。

import { listTargetsRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import { reconcileOneTarget } from "@/lib/exec-env/reconcile";
import { acquireOrRenewLeaderLease, RECONCILER_LEASE_MS, type LeaderLease } from "@/lib/exec-env/leader-lease";
// @kf-batch 50-WP9a-durable-jobs —— 数据面长作业的推进泵(独立计时器;泵侧零执行器 import,见 pump.ts 文件头)
import { startDataplaneJobPump } from "@/lib/dataplane-jobs/pump";
// @kf-batch 50-B51-backfill-pump —— 补数计划的后台推进泵(独立计时器;泵侧零执行器 import,见 backfill/pump.ts 文件头)
import { startBackfillPump } from "@/lib/backfill/pump";
// @kf-batch 50-WP31-place-first-class 序 31 第二刀 ②:请求外的循环**自己建显式落点上下文**(context.ts 文件头 ① 的原话)。
//   第四十三轮 observe 实测,未归因榜 13 类里 11 类是「(请求外)」—— 全是本文件两个 tick 按 target 发出的探活 / 镜像调用:
//   客户端建在 target 自己的区(没越区),只是没人告诉观测器「这一串调用是替谁做的」。
//   🔴 两个叶子都已在 instrumentation 可达面上(observer → context;descriptor 只 import 类型 + target-id),不碰 node 内置。
//   🔴 enforce 安全:控制面客户端(注册表 DynamoDB / CodeBuild / IAM / 目标区 CloudFormation)走 sdkClient("control-plane"),
//      不挂落点守卫;数据面客户端都按 target.region 建 = 上下文的 region ⇒ 序 6 切 enforce 时本包装不会把探活自己拦死。
import { runInPlace } from "@/lib/place/context";
import { placeOfDescriptorOrNull } from "@/lib/place/descriptor";

/**
 * 在 target 的显式落点上下文里跑一段请求外的工作;描述符投影不出 Place(不合格)⇒ 无上下文照常跑(只影响归因,不影响做什么)。
 * 单一作者:两个 tick 都经它,免得一个包了一个没包。
 */
export function runForTarget<T>(t: ExecutionTarget | null | undefined, fn: () => Promise<T>): Promise<T> {
  const place = placeOfDescriptorOrNull(t);
  return place ? runInPlace(place, fn) : fn();
}

/** 🔴 tick 周期:≤ 阈值/3(15min/3=5min),取 4min 留裕度。 */
export const TICK_INTERVAL_MS = 4 * 60 * 1000;
/** 首 tick 延迟:让服务启动稳定后再跑(部署重启进程后不必等满一个周期)。 */
const INITIAL_DELAY_MS = 30 * 1000;

export interface TickSummary {
  leader: boolean;
  total: number;
  reconciled: number;
  errors: number;
}

// 进程内状态:持有的 leader 租约(跨 tick 续租)+ 是否已启动(register 幂等)。
let currentLease: LeaderLease | null = null;
let started = false;
// @kf-batch 50-WP9a-durable-jobs —— 本副本「确定还持有」leader 租约到何时(泵只在这之前取作业)。
//   取「续租时刻 + 租约 − 1 分钟」:租约 8 分钟、续租周期 4 分钟 ⇒ 正常运转时始终为真;
//   续租失败 / 被别的副本抢走 ⇒ 下一次 tick 就置 0,泵最迟 1 分钟余量内停手。
let leaderHeldUntil = 0;
const LEADER_SAFETY_MS = 60 * 1000;

/** 本副本此刻是否持有未过期的 leader 租约(泵的选主口径)。 */
export function holdsLeaderLease(now: number = Date.now()): boolean {
  return now < leaderHeldUntil;
}

/**
 * 🔴 一个 tick(可无定时器直接测):选主 → 遍历列全表 → 逐 target reconcileOneTarget(隔离)。
 * 非 leader ⇒ 立即返回(不探活)。一个 target 失败不掀翻其它(per-target try/catch)。
 * `now` 显式入参 = 选主可确定性测试。
 */
export async function runReconcileTick(now: number = Date.now()): Promise<TickSummary> {
  currentLease = await acquireOrRenewLeaderLease(currentLease, now);
  leaderHeldUntil = currentLease ? now + RECONCILER_LEASE_MS - LEADER_SAFETY_MS : 0; // @kf-batch 50-WP9a-durable-jobs
  if (!currentLease) return { leader: false, total: 0, reconciled: 0, errors: 0 };

  let targets: ExecutionTarget[];
  try {
    targets = await listTargetsRaw();
  } catch (e) {
    console.error("[reconciler] listTargetsRaw 失败:", String((e as Error)?.message ?? e));
    return { leader: true, total: 0, reconciled: 0, errors: 1 };
  }

  let reconciled = 0;
  let errors = 0;
  for (const t of targets) {
    try {
      // @kf-batch 50-WP30-decommission —— 退役中的环境不探活:
      //   · `gone`(已删除 / 已弃置)⇒ 跳过(没有资源可探;以前每 tick 对墓碑跑一次探活、记一次错);
      //   · `decommissioning`(销毁中 / 卡住)⇒ 跳过:探活一个正在拆的环境只会写一堆红项、还会跟收口抢写。
      //     销毁的观测收口走 destroy-observe(详情页销毁中每 15s 轮询)。
      //   🔴 刻意**不在这里**调 observeDecommission:它的 import 图碰 node:crypto(影响预览的指纹 / 数据面落点),
      //     而本文件在 instrumentation 可达面上 —— `await import()` 也不构成编译边界(instrumentation-bundle-guard 钉住)。
      const phase = (t.observed as { phase?: string } | undefined)?.phase;
      if (phase === "gone" || phase === "decommissioning" || (t.status === "deleted" && !t.observed)) continue;
      // 序 31 第二刀 ②:整段探活 / 完成 / 回写都在该 target 的显式落点上下文里 ⇒ 观测器把它发出的每一次调用归到这个 target
      await runForTarget(t, () => reconcileOneTarget(t.targetId));
      reconciled++;
    } catch (e) {
      errors++;
      console.error("[reconciler] reconcileOneTarget(%s) 失败:", t.targetId, String((e as Error)?.message ?? e));
    }
  }
  return { leader: true, total: targets.length, reconciled, errors };
}

// @kf-batch 50-P50.3-mirror
// ── 跨地域元数据镜像的**定时刷新**(50 SPEC §3.13「定时 + 手动触发」的定时那一半)──────
//
// 🔴 **为什么挂在这个循环上、而不是新建一个定时器/Lambda**:选主已经在这里了(leader-lease),
// 镜像刷新必须**单实例**执行(两卡同时刷同一个 target = 双份 Glue 调用 + 互相覆盖分面)。
// 复用已有 leader ⇒ 零新基础设施、零新 IAM、零第二套调度语义(与 DESIGN §20.24 同一条选型理由)。
//
// 🔴 **必须有预算上限**,而且预算是按**租约算术**定的,不是拍脑袋:
//   `runOnce` 的顺序是 reconcileTick(顺手续租,到 now+8min)→ mirrorTick → 等 4min → 下一次续租。
//   ⇒ 两次续租之间 = reconcile 耗时 + mirror 耗时 + 4min,必须 **< 8min 租约**。
//   取 mirror ≤ 60s / 每 tick 最多 3 个 target ⇒ 最坏 ≈ 4min + reconcile,留足裕度。
//   镜像慢到把 leader 租约拖掉,代价是**探活也停了** —— 那是拿核心功能换一个看板,不划算。
/** 一个 mirror tick 的墙钟预算(见上面的租约算术)。 */
export const MIRROR_TICK_BUDGET_MS = 60 * 1000;
/** 一个 tick 最多刷几个 target(超出的下一个 tick 继续 —— 到期清单是按时间戳算的,天然轮转)。 */
export const MIRROR_MAX_PER_TICK = 3;

export interface MirrorTickSummary {
  /** 到期需要刷的 target 数(可能大于本轮真刷的数量) */
  due: number;
  mirrored: number;
  errors: number;
  /** 🔴 被预算挡下、本轮**没刷**的数量 —— 必须回报(静默少刷 = 分面莫名变陈旧) */
  deferred: number;
}

/**
 * 刷一批到期的镜像。**只在已当选 leader 时调**(由 `runOnce` 保证)。
 *
 * 🔴 一个 target 失败不掀翻其余(逐 target try/catch),失败也**不清掉**上一次成功的时间戳
 * (那由 `mirrorMetadata` 内部保证)。
 */
export async function runMirrorTick(now: number = Date.now()): Promise<MirrorTickSummary> {
  const { mirrorDueTargets, mirrorMetadata } = await import("@/lib/exec-env/metadata-mirror");
  let due: string[];
  try {
    due = await mirrorDueTargets(now);
  } catch (e) {
    console.error("[mirror] 算到期清单失败:", String((e as Error)?.message ?? e));
    return { due: 0, mirrored: 0, errors: 1, deferred: 0 };
  }
  // 序 31 第二刀 ②:到期清单只有 targetId,显式上下文要描述符 ⇒ 列一次全表按 id 取(列不到 ⇒ 该 target 无上下文照常刷)
  let descriptors = new Map<string, ExecutionTarget>();
  try {
    descriptors = new Map((await listTargetsRaw()).map((t) => [t.targetId, t] as const));
  } catch (e) {
    console.error("[mirror] 列描述符失败(本轮刷新无落点上下文,只影响观测归因):", String((e as Error)?.message ?? e));
  }
  const deadline = now + MIRROR_TICK_BUDGET_MS;
  let mirrored = 0;
  let errors = 0;
  let processed = 0;
  for (const targetId of due) {
    if (processed >= MIRROR_MAX_PER_TICK || Date.now() >= deadline) break;
    processed++;
    try {
      await runForTarget(descriptors.get(targetId), () => mirrorMetadata(targetId));
      mirrored++;
    } catch (e) {
      errors++;
      console.error("[mirror] mirrorMetadata(%s) 失败:", targetId, String((e as Error)?.message ?? e));
    }
  }
  return { due: due.length, mirrored, errors, deferred: Math.max(0, due.length - processed) };
}

/**
 * 启动周期循环(instrumentation register() 调;重复调用幂等)。
 * 🔴 仅 production 启动(ECS 镜像跑 `next start` 时 NODE_ENV=production);dev/test 不自动探活真 AWS。
 * 🔴 kill-switch:`BGP_RECONCILER_DISABLED=1` 关闭(紧急时不必回滚镜像)。
 * 递归 setTimeout + unref():tick 不重叠,且不阻止进程退出。
 */
export function startReconcilerLoop(): void {
  if (started) return;
  if (process.env.NODE_ENV !== "production") {
    console.log("[reconciler] 非 production,不启动周期循环");
    return;
  }
  if (process.env.BGP_RECONCILER_DISABLED === "1") {
    console.log("[reconciler] 被 BGP_RECONCILER_DISABLED 关闭,不启动");
    return;
  }
  started = true;

  const schedule = (delay: number) => {
    const timer = setTimeout(runOnce, delay);
    if (typeof timer.unref === "function") timer.unref(); // 不阻止进程退出
  };
  const runOnce = async () => {
    try {
      const s = await runReconcileTick();
      if (s.leader && (s.errors > 0 || s.total > 0)) console.log("[reconciler] tick:", JSON.stringify(s));
      // @kf-batch 50-P50.3-mirror
      // 🔴 **镜像刷新排在探活之后、且完全隔离**:探活是准入判定的输入(15min stale 阈值),
      //    镜像只是一个看板 ⇒ 镜像抛异常绝不能影响 reconcile 的结果与计数。
      //    非 leader 不刷(两卡同时刷会双份调用 + 互相覆盖分面)。
      if (s.leader) {
        try {
          const m = await runMirrorTick();
          if (m.due > 0) console.log("[mirror] tick:", JSON.stringify(m));
        } catch (e) {
          console.error("[mirror] tick 未捕获异常:", String((e as Error)?.message ?? e));
        }
      }
    } catch (e) {
      console.error("[reconciler] tick 未捕获异常:", String((e as Error)?.message ?? e));
    } finally {
      schedule(TICK_INTERVAL_MS); // 跑完才排下一次 ⇒ 不重叠
    }
  };

  console.log("[reconciler] 周期循环已启动(tick=%dms,lease=%dms)", TICK_INTERVAL_MS, RECONCILER_LEASE_MS);
  schedule(INITIAL_DELAY_MS);

  // @kf-batch 50-WP9a-durable-jobs —— 🔴 独立计时块(不进 runOnce):泵 15s 一轮,与 4 分钟的探活 tick 互不阻塞;
  //   泵出任何错都只在它自己的循环里(pump.ts 逐轮 try/catch),碰不到探活与镜像。
  //   选主口径复用本循环的 leader 租约(不另起锁行);停泵开关 BGP_DATAPLANE_JOBS_PAUSED=1 在泵内部判。
  startDataplaneJobPump({ isLeader: () => holdsLeaderLease() });
  // @kf-batch 50-B51-backfill-pump —— 补数计划不再只靠页面开着推进(B-51c);选主口径与数据面作业泵相同。
  startBackfillPump({ isLeader: () => holdsLeaderLease() });
}
