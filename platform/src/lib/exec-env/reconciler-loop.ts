// 2a:周期 reconciler 的【进程内驱动】(SPEC §3.5a / DESIGN §20.24)。
//
// 运行体 = 现有常驻平台服务(ApplicationLoadBalancedFargateService,desiredCount 2~6),由 src/instrumentation.ts
//   的 register() 在 nodejs runtime 启动一次。每 tick:选主(leader-lease)→ 若当选,遍历 listTargetsRaw() →
//   对每个 target 调 reconcileOneTarget(**与人点「检测初始化」同一份 SSOT**),逐 target try/catch 隔离。
//
// 🔴 为什么"进程内 lease 单例"(而非独立定时 ECS 任务 / 外部定时→内部端点):探活今天就在这进程里跑(probe 路由)⇒
//   零新基础设施/IAM/镜像/HTTP 端点、同一条 ambient 凭证、零漂移(选型台账见 DESIGN §20.24)。
// 🔴 两个计时器,分开计:
//   · **探活节拍** 4 分钟(≤ 15 分钟探活过期阈值 / 3,留裕度):只有主副本真探活;
//   · **选主拍** 30 秒:主副本续租、备用副本看租约有没有空出来(被释放 / 已过期)并接手,接手后立刻探活一轮。
//   选主从探活节拍里拆出来的原因(2026-11-16 真环境):滚动升级后旧主副本被停,租约没释放(8 分钟)、新副本又只在自己的
//   4 分钟节拍上抢 ⇒ 挂在选主上的后台泵(告警 / SLA 评估、数据面作业、补数)和探活停了约 5 分钟,最长可到 12 分钟。
//   现在:正常退出先释放租约(见 installShutdownRelease)⇒ 约 30 秒内接手;猝死靠租约过期(3 分钟)⇒ 最长约 3.5 分钟。
// 🔴 **接手即干活**:本副本一成为主副本,探活与三台泵都把等着的那一轮提到现在(不各自再等完一个周期)。
//   2026-11-17 真环境:接手只用了 8 秒,而告警评估泵要等自己的下一个 60 秒周期 ⇒ 页面上的评估心跳断了 87 秒;
//   滚动部署里两个旧副本先后被停、连着交接两次时,这段等待还会叠加。
// 🔴 计时器代码只有一份(periodic-loop.ts):一轮跑完才排下一轮 ⇒ 天然不重叠(target 多时也不会堆积并发)。

import { startPeriodicLoop } from "@/lib/exec-env/periodic-loop";
import { listTargetsRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import { reconcileOneTarget } from "@/lib/exec-env/reconcile";
import { acquireOrRenewLeaderLease, releaseLeaderLease, RECONCILER_LEASE_MS, type LeaderLease } from "@/lib/exec-env/leader-lease";
// 数据面长作业的推进泵(独立计时器;泵侧零执行器 import,见 pump.ts 文件头)
import { startDataplaneJobPump } from "@/lib/dataplane-jobs/pump";
// 补数计划的后台推进泵(独立计时器;泵侧零执行器 import,见 backfill/pump.ts 文件头)
import { startBackfillPump } from "@/lib/backfill/pump";
// 告警 / SLA 评估泵(独立计时器;泵侧零执行器 import,见 alerting/pump.ts 文件头)
import { startAlertingPump } from "@/lib/alerting/pump";
// 请求外的循环**自己建显式落点上下文**(context.ts 文件头 ① 的原话)。
//   第四十三轮 observe 实测,未归因榜 13 类里 11 类是「(请求外)」—— 全是本文件两个 tick 按 target 发出的探活 / 镜像调用
//   客户端建在 target 自己的区(没越区),只是没人告诉观测器「这一串调用是替谁做的」。
//   🔴 两个叶子都已在 instrumentation 可达面上(observer → context;descriptor 只 import 类型 + target-id),不碰 node 内置。
//   🔴 enforce 安全:控制面客户端(注册表 DynamoDB / CodeBuild / IAM / 目标区 CloudFormation)走 sdkClient("control-plane"),
//      不挂落点守卫;数据面客户端都按 target.region 建 = 上下文的 region ⇒ 切 enforce 时本包装不会把探活自己拦死。
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
/** 🔴 选主拍:每个副本每 30 秒一拍(主副本续租 / 备用副本尝试接手)。远小于租约 ⇒ 连丢几拍也不掉主。 */
export const ELECTION_BEAT_MS = 30 * 1000;
/** 收到停止信号后,进程最多等这么久让「释放租约」写完;到点照常退出(租约到期兜底)。 */
export const SHUTDOWN_RELEASE_BUDGET_MS = 3 * 1000;

export interface TickSummary {
  leader: boolean;
  total: number;
  reconciled: number;
  errors: number;
}

// 进程内状态:持有的 leader 租约(跨 tick 续租)+ 是否已启动(register 幂等)。
let currentLease: LeaderLease | null = null;
let started = false;
// 本副本「确定还持有」leader 租约到何时(泵只在这之前取作业)。
//   取「续租时刻 + 租约 − 1 分钟」:租约 3 分钟、每 30 秒续一次 ⇒ 正常运转时始终为真,连续丢 3 拍才为假;
//   被别的副本抢走 ⇒ 下一拍就置 0;泵最迟在租约到期前 1 分钟停手。
let leaderHeldUntil = 0;
const LEADER_SAFETY_MS = 60 * 1000;
// 在途的那一次选主写(进程内单飞):探活节拍与选主拍可能同时到,两次并发的「抢 / 续」若各带各的凭证,
//   后落地的失败结果会把先落地的成功盖成「不是主副本」,锁行却写着本副本 ⇒ 没人续、白白空一个租约期。
let electionInFlight: Promise<boolean> | null = null;
// 进程正在退出:此后不再抢 / 续租(否则刚释放的租约会被自己续回去),泵的选主口径立刻为假。
let shuttingDown = false;
// 「本副本刚成为主副本」时要叫起来的人(startLeaderLoops 挂上:探活 + 三台泵各把等着的那一轮提到现在)。
let onBecameLeader: (() => void) | null = null;

/** 本副本此刻是否持有未过期的 leader 租约(泵的选主口径)。 */
export function holdsLeaderLease(now: number = Date.now()): boolean {
  return !shuttingDown && now < leaderHeldUntil;
}

/**
 * 🔴 选主的唯一作者:抢或续一次租约,并更新本副本的选主状态。探活节拍与选主拍都只经它。
 * 返回本副本此刻是不是主副本。非条件失败的错误(权限 / 网络)照抛,状态不动(已有的持有期自然走完)。
 */
export function runElectionBeat(now: number = Date.now()): Promise<boolean> {
  if (shuttingDown) return Promise.resolve(false);
  if (electionInFlight) return electionInFlight;
  const attempt = (async () => {
    try {
      const hadLease = currentLease !== null;
      const lease = await acquireOrRenewLeaderLease(currentLease, now);
      currentLease = lease; // 退出途中落地的结果也要记下:释放时按它删
      leaderHeldUntil = lease && !shuttingDown ? now + RECONCILER_LEASE_MS - LEADER_SAFETY_MS : 0;
      // 身份变化各记一行(排障时从日志就能看出主副本是哪一刻换的)
      if (lease && !hadLease) {
        console.log("[reconciler] 本副本成为主副本");
        // 接手即干活。在选主的唯一作者这里通知 ⇒ 不论这次接手发生在选主拍还是探活节拍里都叫得到;通知出错不许影响选主。
        if (!shuttingDown) {
          try {
            onBecameLeader?.();
          } catch (e) {
            console.error("[reconciler] 接手后的通知出错:", String((e as Error)?.message ?? e));
          }
        }
      }
      if (!lease && hadLease) console.log("[reconciler] 本副本不再是主副本(租约已被别的副本接手)");
      return !!lease && !shuttingDown;
    } finally {
      electionInFlight = null;
    }
  })();
  electionInFlight = attempt;
  return attempt;
}

export type ShutdownReleaseOutcome = "released" | "not-leader" | "not-released" | "timeout";
const SHUTDOWN_OUTCOME_TEXT: Record<ShutdownReleaseOutcome, string> = {
  released: "本副本是主副本,选主租约已释放(备用副本在下一个选主拍接手)",
  "not-leader": "本副本不是主副本,没有租约要释放",
  "not-released": "释放选主租约没有成功(租约到期后由备用副本接手)",
  timeout: "释放选主租约超时没写完,不再等(租约到期后由备用副本接手)",
};

/**
 * 进程退出前交出主副本身份:置退出标记(泵立刻停手、之后不再抢 / 续)→ 等在途的选主写落地 → 条件删除锁行。
 * 整体限时 SHUTDOWN_RELEASE_BUDGET_MS;不抛。返回的是事实(释放了 / 本来就不是 / 没成功 / 超时)。
 */
export async function releaseLeadershipOnShutdown(): Promise<ShutdownReleaseOutcome> {
  shuttingDown = true;
  leaderHeldUntil = 0;
  const work = (async (): Promise<ShutdownReleaseOutcome> => {
    // 在途的选主写先落地:否则释放之后它又把锁行写回来,而本进程马上就没了
    if (electionInFlight) await electionInFlight.catch(() => false);
    const lease = currentLease;
    currentLease = null;
    if (!lease) return "not-leader";
    return (await releaseLeaderLease(lease)) ? "released" : "not-released";
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ShutdownReleaseOutcome>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SHUTDOWN_RELEASE_BUDGET_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 停止信号的宿主(node 的 process;判据里换成同形的假对象)。 */
export interface ShutdownHost {
  prependListener(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit: (code?: number) => unknown;
}

/** node 进程对象。本文件也在 edge 编译的可达面上,那里没有信号 / 退出接口 ⇒ 经 globalThis 取,取不到就不挂。 */
function nodeProcessHost(): ShutdownHost | null {
  const p = (globalThis as { process?: Partial<ShutdownHost> }).process;
  return p && typeof p.prependListener === "function" && typeof p.exit === "function" ? (p as ShutdownHost) : null;
}

/**
 * 进程收到停止信号(SIGTERM / SIGINT)时释放选主租约,并让进程**等释放写完再退出**(限时)。
 * 🔴 为什么要「等」:框架自己的停止处理是「关服务 → 立刻退出进程」,而释放是一次异步的条件删除 —— 不等,多半写不出去,
 *    租约就只能靠过期。做法:信号一到,先把宿主的 `exit` 换成「等释放结束(最多 SHUTDOWN_RELEASE_BUDGET_MS)再真退出」;
 *    框架原有的关服务流程照走。用 prependListener 排在框架的处理器之前,框架哪怕同步退出也先经过这一步。
 * 返回是否挂上(没有进程宿主 ⇒ false)。
 */
export function installShutdownRelease(host: ShutdownHost | null = nodeProcessHost()): boolean {
  if (!host) return false;
  let handling = false;
  const onSignal = (signal: "SIGTERM" | "SIGINT") => {
    if (handling) return;
    handling = true;
    const realExit = host.exit.bind(host);
    const settled = releaseLeadershipOnShutdown().then(
      (outcome) => console.log("[reconciler] 收到 %s:%s", signal, SHUTDOWN_OUTCOME_TEXT[outcome]),
      (e) => console.error("[reconciler] 收到 %s:释放选主租约出错:", signal, String((e as Error)?.message ?? e))
    );
    host.exit = (code?: number) => {
      void settled.finally(() => realExit(code));
    };
  };
  host.prependListener("SIGTERM", () => onSignal("SIGTERM"));
  host.prependListener("SIGINT", () => onSignal("SIGINT"));
  return true;
}

/**
 * 🔴 一个 tick(可无定时器直接测):选主 → 遍历列全表 → 逐 target reconcileOneTarget(隔离)。
 * 非 leader ⇒ 立即返回(不探活)。一个 target 失败不掀翻其它(per-target try/catch)。
 * `now` 显式入参 = 选主可确定性测试。
 */
export async function runReconcileTick(now: number = Date.now()): Promise<TickSummary> {
  if (!(await runElectionBeat(now))) return { leader: false, total: 0, reconciled: 0, errors: 0 };

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
      // 退役中的环境不探活
      //   · `gone`(已删除 / 已弃置)⇒ 跳过(没有资源可探;以前每 tick 对墓碑跑一次探活、记一次错);
      //   · `decommissioning`(销毁中 / 卡住)⇒ 跳过:探活一个正在拆的环境只会写一堆红项、还会跟收口抢写。
      //     销毁的观测收口走 destroy-observe(详情页销毁中每 15s 轮询)。
      //   🔴 刻意**不在这里**调 observeDecommission:它的 import 图碰 node:crypto(影响预览的指纹 / 数据面落点),
      //     而本文件在 instrumentation 可达面上 —— `await import()` 也不构成编译边界(instrumentation-bundle-guard 钉住)。
      const phase = (t.observed as { phase?: string } | undefined)?.phase;
      if (phase === "gone" || phase === "decommissioning" || (t.status === "deleted" && !t.observed)) continue;
      // 整段探活 / 完成 / 回写都在该 target 的显式落点上下文里 ⇒ 观测器把它发出的每一次调用归到这个 target
      await runForTarget(t, () => reconcileOneTarget(t.targetId));
      reconciled++;
    } catch (e) {
      errors++;
      console.error("[reconciler] reconcileOneTarget(%s) 失败:", t.targetId, String((e as Error)?.message ?? e));
    }
  }
  return { leader: true, total: targets.length, reconciled, errors };
}

// ── 跨地域元数据镜像的**定时刷新**(50 SPEC §3.13「定时 + 手动触发」的定时那一半)──────
//
// 🔴 **为什么挂在这个循环上、而不是新建一个定时器/Lambda**:选主已经在这里了(leader-lease),
// 镜像刷新必须**单实例**执行(两卡同时刷同一个 target = 双份 Glue 调用 + 互相覆盖分面)。
// 复用已有 leader ⇒ 零新基础设施、零新 IAM、零第二套调度语义(与 DESIGN §20.24 同一条选型理由)。
//
// 🔴 **必须有预算上限**:`runOnce` 的顺序是 reconcileTick → mirrorTick → 等 4min → 下一次探活,
//   镜像跑多久,下一次探活就被往后挤多久,而探活是准入判定的输入(15 分钟过期阈值)。
//   取 mirror ≤ 60s / 每 tick 最多 3 个 target ⇒ 两次探活之间最坏 ≈ 5min + reconcile,留足裕度。
//   (续租在独立的选主拍上做,镜像再慢也拖不掉租约;预算守的是探活的周期,不是租约。)
//   拿核心功能的及时性去换一个看板,不划算。
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
  // 到期清单只有 targetId,显式上下文要描述符 ⇒ 列一次全表按 id 取(列不到 ⇒ 该 target 无上下文照常刷)
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
 * 起两个计时器:探活节拍(4 分钟)与选主拍(30 秒),并挂上「退出前释放租约」。`startReconcilerLoop` 过了启动门之后调它;
 * 判据直接调它(同一份计时器代码)。`onTakeover`:本副本刚成为主副本时调一次 —— 三台泵从这里把等着的那一轮提到现在。
 */
export function startLeaderLoops(host?: ShutdownHost | null, onTakeover?: () => void): void {
  const runOnce = async () => {
    try {
      const s = await runReconcileTick();
      if (s.leader && (s.errors > 0 || s.total > 0)) console.log("[reconciler] tick:", JSON.stringify(s));
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
    }
  };

  // 选主拍:主副本续租;备用副本发现租约空出来(被释放 / 已过期)就接手。
  const beat = async () => {
    try {
      await runElectionBeat();
    } catch (e) {
      console.error("[reconciler] 选主拍失败:", String((e as Error)?.message ?? e));
    }
  };

  console.log(
    "[reconciler] 周期循环已启动(tick=%dms,lease=%dms,election=%dms)",
    TICK_INTERVAL_MS,
    RECONCILER_LEASE_MS,
    ELECTION_BEAT_MS
  );
  // 先起探活节拍、再起选主拍:两者同一刻到时探活先走(它第一步就是选主;选主拍随后复用同一次在途的写,不另发)。
  const probe = startPeriodicLoop({ intervalMs: TICK_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS, runOnce });
  startPeriodicLoop({ intervalMs: ELECTION_BEAT_MS, runOnce: beat });
  // 刚接手:探活把等着的那一轮提到现在(不等自己的下一个 4 分钟节拍;正有一轮在跑 = 已按新身份在探,不插队),
  //   三台泵由调用方经 onTakeover 接上。
  onBecameLeader = () => {
    probe.kick();
    onTakeover?.();
  };
  const hooked = host === undefined ? installShutdownRelease() : installShutdownRelease(host);
  if (!hooked) console.log("[reconciler] 没有进程宿主可挂停止信号:退出时不释放选主租约,靠租约到期交接");
}

/**
 * 启动周期循环(instrumentation register() 调;重复调用幂等)。
 * 🔴 仅 production 启动(ECS 镜像跑 `next start` 时 NODE_ENV=production);dev/test 不自动探活真 AWS。
 * 🔴 kill-switch:`BGP_RECONCILER_DISABLED=1` 关闭(紧急时不必回滚镜像)。
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

  // 🔴 独立计时块(不进 runOnce):泵 15s 一轮,与 4 分钟的探活 tick 互不阻塞;
  //   泵出任何错都只在它自己的循环里(pump.ts 逐轮 try/catch),碰不到探活与镜像。
  //   选主口径复用本循环的 leader 租约(不另起锁行);停泵开关 BGP_DATAPLANE_JOBS_PAUSED=1 在泵内部判。
  const dataplaneJobs = startDataplaneJobPump({ isLeader: () => holdsLeaderLease() });
  // 补数计划不再只靠页面开着推进;选主口径与数据面作业泵相同。
  const backfill = startBackfillPump({ isLeader: () => holdsLeaderLease() });
  // 告警规则不再只靠「立即评估」按钮、SLA 破线预测不再没人调用:每分钟逐项目评估 + 对在途运行滚动预测;选主口径相同。
  const alerting = startAlertingPump({ isLeader: () => holdsLeaderLease() });

  // 探活节拍 + 选主拍 + 退出前释放租约;本副本一接手主副本,三台泵各把等着的那一轮提到现在。
  startLeaderLoops(undefined, () => {
    for (const pump of [dataplaneJobs, backfill, alerting]) pump.kick();
  });
}
