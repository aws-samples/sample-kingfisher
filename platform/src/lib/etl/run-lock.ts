// （根治·裂缝C）— 作业级运行锁(job-level run serialization)。
//
// 【为什么存在】同一作业的多个 run 会在后端【并发执行 DROP+CTAS 同一张目标表】→ Redshift 报
// `could not open relation with OID <n>`(见 cookbook redshift.ctas-oid-concurrency)、后续 CTAS ABORTED。
// 触发源(Explore 勘定坐实):①补数 backfill 逐日提交(etl-jobs/engines 路由 + 补数中心 tick 的 workflow SQL 节点)
// ——run 函数【提交即返回】(Redshift BatchExecuteStatement 异步/Glue/EMR StartJobRun 立即返回),即便路由
// for+await"串行发起",后端执行仍重叠并发;②手动 run/rerun 狂点;③schedule 与手动交叉。平台此前【无任何
// 运行期串行化】(仅补数实例行有 runToken 幂等,粒度=(日期,节点),不按作业/目标表)。
//
// 【根治=作业级串行(排队,非拒绝)】同一"运行实体"(作业/工作流节点)的 run 串行执行到终态,不同实体并行。
//  · 不选"目标表级":目标表无结构化字段、只能启发式解析渲染后脚本(可能失败/多目标),且 ${ds} 若拼进
//    表名则不同日期本就是不同物理表——表级锁反而误判。作业级"稳>巧"(离线作业通常一实体一目标表)。
//
// 【锁的存放·泛化】直接用【实体行本身的属性】(<attr>Token + <attr>ExpiresAt)做条件写,不新建表
//  → 零 CDK 改动、零 infra 重部署(纯 platform)。lease TTL 兜底防僵尸锁(进程重启/轮询丢失时自动过期可抢)。
//  · ETL 作业:table=bgp-etl-jobs, key={userId,jobId},   attr="runLock"
//  · EMR 引擎:table=bgp-engine-jobs, key={userId,jobId}, attr="runLock"
//  · 工作流 SQL 节点:table=bgp-workflows, key={userId,workflowId}, attr="runLock_<nodeId>"
//    (按 nodeId 命名锁属性 → 同一 workflow 不同节点可并行,同节点不同日期串行,精准)。

import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

// lease 时长:覆盖最长离线作业(Glue poll 160×15s≈40min,Redshift 120×2s=4min,EMR 240×15s=60min)。
// 取 90min 上限兜底——正常路径跑完即主动释放,lease 只在进程崩溃/轮询丢失时兜底,宁长勿误杀在跑的作业。
const LEASE_MS = 90 * 60 * 1000;

// 抢锁重试(backfill 排队等待前一个 run 终态)的轮询间隔。手动 run 用 waitMs=0 不进入重试。
const RETRY_INTERVAL_MS = 15 * 1000;

const nowMs = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * **抢不到运行锁**的类型化错误(= 上一次运行还在跑)。
 *
 * 🔴 为什么必须是一个**类型**而不是 `new Error(文案)`:运行路由按「用户可修 vs 平台故障」
 * 分流 409 / 500,而分流靠的是 `instanceof`。纯 Error 一律落到 500 ⇒ 界面说「运行失败」、
 * 把人引去查平台故障,而真相是「上一次还在跑,等一下再点」。
 * 这与该路由里已经写着的那条注释(落点冲突报 500 = W3a-9 真环境暴露)是**同一个病**,
 * 只是当时只修了绑定那一类。2026-09-09 硬门 w3f 段 W3f-3 又撞到一次(单区运行紧跟两区运行 ⇒ 500)。
 *
 * 🔴 锁的**唯一作者**在本文件,所以这个类也放这里 —— 四个抢锁点(etl glue / etl redshift /
 * emr / backfill 节点)都抛它,分流只需要认一个类型。
 */
export class RunLockBusy extends Error {
  readonly busy = true as const;
  constructor(message: string) {
    super(message);
    this.name = "RunLockBusy";
  }
}

export interface RunLock {
  table: string;
  key: Record<string, string>; // DynamoDB 主键(如 {userId,jobId} 或 {userId,workflowId})
  attr: string; // 锁属性前缀(如 "runLock" 或 "runLock_<nodeId>")
  token: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 **锁属性名的唯一作者**(50 SPEC §3.6「运行锁身份含 target」)。
//
// 不变量:**同 target + 同任务(+同节点)= 互斥;不同 target + 同任务 = 并行**。
//
// 为什么只能走"属性名带 target"这一条路:锁**存在业务实体行自身的属性上**(见文件头),
// 键就是业务行主键(`userId` + 资源 id)—— **没有地方能注入 targetId**。所以唯一可行轴是属性名。
//
// 🔴 **home 必须与存量逐字节同名**(`runLock` / `runLock_<nodeId>`):并存期里存量 DAG、
// 存量 run、补数、以及**已经在跑**的作业都在抢那个名字。改名 = 并存期内新旧两套各锁各的
// = 白加锁却看不出任何报错(本仓最阴的那类回归)。
//
// 🔴 分隔符用 `-` 而不是 `_`:`targetId` 的字符集是 `[a-z0-9_]`(§1.1a),里面**可以有 `_`**
// 但**不可能有 `-`** ⇒ 用 `-` 才可逆、才不会 `runLock_tgt_usw2_a_node1` 这样歧义
// (到底是 target=tgt_usw2_a·node=node1,还是 target=tgt_usw2·node=a_node1?)。
//
// 🔴 **4 家必须产出同一字符串**(SPEC §3.6 逐条点名,真码坐实):
//   ① 本文件(Node 泛化模块:ETL / EMR / workflow 节点共用)
//   ② `lib/etl/dag-generator.ts` 生成的 ETL DAG 内联锁(🔴 由本函数在 **TS 侧算好后注入字面量**,
//      不让 python 再算一遍 —— 少一处实现就少一处漂移)
//   ③ `lib/workflow/runtime-lib.ts` 的 python `_acquire_wf_lock`(节点在运行期才知道 ⇒ python 侧
//      必须自己算,故那里有一个**镜像实现** + parity 单测钉住两侧对同一输入产出同一串)
//   ④ `lib/backfill/execute.ts` 抢锁
// ══════════════════════════════════════════════════════════════════════════════

/** DynamoDB 属性名安全化(与 python 侧 `_sanitize_node_id` 同集合同替换)。 */
export function sanitizeLockPart(v: string): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * 锁属性名。`targetId` 缺省 / home ⇒ 与存量**逐字节同名**。
 *
 * @param nodeId workflow 节点用;🔴 必须传**原始 `node.id`**,不是 `task_id`(370cd0c 教训)。
 */
export function lockAttrFor(opts: { targetId?: string | null; nodeId?: string | null }): string {
  const node = opts.nodeId ? sanitizeLockPart(opts.nodeId) : "";
  const tid = opts.targetId ? sanitizeLockPart(opts.targetId) : "";
  // home 豁免:`tgt_home` 与"没传"走同一分支,产出存量名字。
  if (!tid || tid === HOME_TARGET_ID) {
    return node ? `runLock_${node}` : "runLock";
  }
  return node ? `runLock-${tid}-${node}` : `runLock-${tid}`;
}

// 锁属性名(安全化 nodeId,避免非法 DynamoDB 属性字符;实际用 ExpressionAttributeNames 占位,这里仅拼名字)。
function lockAttrs(attr: string): { tokenAttr: string; expAttr: string } {
  return { tokenAttr: `${attr}Token`, expAttr: `${attr}ExpiresAt` };
}

/**
 * 尝试抢一次运行锁(不重试)。条件:锁不存在 OR 已过期(lease 到期,兜底僵尸锁)。
 * 抢到返回 RunLock,抢不到(别的 run 持锁且未过期)返回 null。
 */
/**
 * 2026-11-04:**作业行已不存在** ⇒ 抢锁 / 续租都不可能成功,也不该排队。
 * 🔴 为什么是独立类型而不是 RunLockBusy:RunLockBusy 让补数 / 定时排队等 45–60 分钟再放弃 —— 行都没了,等多久都一样;
 *   运行路由按 instanceof 分流成 409「作业已被删除」(用户可修:别再对它点运行),而不是 500 或「正在运行中」这句假话。
 */
export class JobRowMissing extends Error {
  readonly missing = true as const;
  constructor() {
    super("作业已被删除,无法运行(作业行不存在)");
    this.name = "JobRowMissing";
  }
}

export type RowPresence = "present" | "absent" | "unknown";

/**
 * 锁所在的实体行在不在(只读主键投影;一次读失败立即重试一次;两次都读不出 ⇒ `unknown`,调用方按自己的语义处理,不凭读错下结论)。
 * 条件写被拒时 DDB 可能已经把旧行带回来(见 ccfReturnedItem);没带回来才需要这一步确认。
 */
export async function lockRowPresence(table: string, key: Record<string, string>): Promise<RowPresence> {
  const pk = Object.keys(key)[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { Item } = await docClient.send(new GetCommand({ TableName: table, Key: key, ProjectionExpression: "#pk", ExpressionAttributeNames: { "#pk": pk } }));
      return Item ? "present" : "absent";
    } catch (e) {
      if (attempt === 1) console.warn("[run-lock] 读不出锁所在的实体行(重试一次仍失败)", table, JSON.stringify(key), e);
    }
  }
  return "unknown";
}

/** 条件写被拒时 DDB 回了旧行(请求带 ReturnValuesOnConditionCheckFailure=ALL_OLD;行不存在 ⇒ 不会有 Item)。 */
function ccfReturnedItem(e: unknown): boolean {
  return (e as { Item?: unknown } | null | undefined)?.Item !== undefined;
}

export interface AcquireRunLockOptions {
  /**
   * 2026-11-04:🔴 **锁只许落在仍然存在的实体行上**。锁是用 UpdateItem 写在业务行的属性上,而 UpdateItem 是 upsert ——
   *   作业行刚被删掉、一次排队中的运行(补数 / 定时 / 手动)这时才抢到锁 ⇒ 凭空造出一条只有锁属性、没有名字的幽灵作业行,
   *   随后 ensureGlueJob 还会把刚删掉的 Glue 作业定义重建出来(与删源后在途探测写回已删行留幽灵行同类)。开了它,条件里多一句 `attribute_exists(<分区键>)`:
   *   行不在 ⇒ 条件不满足 ⇒ 当作「抢不到」(返回 null),什么都不写。
   *   作业行锁(`acquireJobRunLock`)恒开;工作流节点锁与 MWAA 侧的 Python 镜像不动(节点锁所在的工作流行在发布期不会被删)。
   */
  requireRowExists?: boolean;
}

export async function tryAcquireRunLock(
  table: string,
  key: Record<string, string>,
  attr = "runLock",
  opts: AcquireRunLockOptions = {}
): Promise<RunLock | null> {
  const token = ulid();
  const expiresAt = nowMs() + LEASE_MS;
  const { tokenAttr, expAttr } = lockAttrs(attr);
  // 分区键名从 Key 自己取(作业行 / 工作流行都是 `userId` 打头),不在这里硬编码表结构
  const pkName = Object.keys(key)[0];
  const freeOrExpired = "attribute_not_exists(#t) OR #e < :now";
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        // 抢锁:当前无锁(属性不存在)或 lease 已过期 → 写入本次 token + 新 lease。用占位名兼容动态属性名。
        UpdateExpression: "SET #t = :tok, #e = :exp",
        ConditionExpression: opts.requireRowExists ? `attribute_exists(#pk) AND (${freeOrExpired})` : freeOrExpired,
        ExpressionAttributeNames: { "#t": tokenAttr, "#e": expAttr, ...(opts.requireRowExists ? { "#pk": pkName } : {}) },
        ExpressionAttributeValues: { ":tok": token, ":exp": expiresAt, ":now": nowMs() },
        // 行在、别人持锁 ⇒ DDB 把旧行带回来;行不在 ⇒ 没有旧行 —— 据此分辨「忙」与「作业已删」(S4),不再把两者都当成忙去排队
        ...(opts.requireRowExists ? { ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } : {}),
      })
    );
    return { table, key, attr, token };
  } catch (e: any) {
    if (e?.name !== "ConditionalCheckFailedException") throw e; // 其它错误(权限/网络)照抛,不吞
    if (!opts.requireRowExists || ccfReturnedItem(e)) return null; // 别的 run 持锁未过期
    // 没带回旧行:要么行不在,要么端点没回旧行 —— 再读一次确认,不凭缺省下结论
    if ((await lockRowPresence(table, key)) === "absent") throw new JobRowMissing();
    return null; // 行在(或读不出)⇒ 当作抢不到,排队的下一次重试会再分辨
  }
}

/**
 * 抢运行锁,带重试等待(排队语义)。
 *  · waitMs>0(backfill/schedule):抢不到则按 RETRY_INTERVAL_MS 轮询等待,直到抢到或超 waitMs。
 *  · waitMs=0(手动 run):只抢一次,抢不到立即返回 null(由调用方给"作业运行中"提示)。
 */
export async function acquireRunLock(
  table: string,
  key: Record<string, string>,
  waitMs = 0,
  attr = "runLock",
  opts: AcquireRunLockOptions = {}
): Promise<RunLock | null> {
  const deadline = nowMs() + waitMs;
  for (;;) {
    const lock = await tryAcquireRunLock(table, key, attr, opts);
    if (lock) return lock;
    if (nowMs() + RETRY_INTERVAL_MS > deadline) return null; // 再等一轮也会超时 → 放弃
    await sleep(RETRY_INTERVAL_MS);
  }
}

// ── 续租 + "耗尽不释放"(2026-08-29 外部审核 P0-6:严格互斥此前不成立)──────────────
//
// 【原缺陷】4 个轮询循环都在 `finally` 里**无条件** releaseRunLock —— 无论是"到达终态 return"
// 还是"轮询轮次跑完掉出循环"。而轮询窗口远短于作业可能的实际时长:
//   Redshift 120×2s≈4min · Glue 160×15s≈40min · EMR 240×15s≈60min · backfill 150 轮
// ⇒ 一个跑 1 小时的 Glue 作业,平台在第 40 分钟就把锁放了,**后端还在跑**,第二个 run 立刻进来
//   DROP+CTAS 同一张表 → 正是裂缝C 要根治的 OID 事故复现。代码注释("终态/轮询耗尽都释放")
//   写明了这是**故意**的,动机是"避免后续 run 等 90min lease 过期"——但那把可用性买在了正确性上。
//
// 【定案】① 轮询期间**主动续租**(lease 永不在我们还在看着的时候过期);
//        ② 轮询耗尽 ⇒ **绝不释放**:此刻后端状态**未知**,唯一安全动作是继续持锁,
//           由 lease 兜底(进程真死了才过期可抢)。这样"等 lease"只发生在**确实失联**时,
//           而不是"作业比我们的轮询窗口长"这种正常情况。
// ⚠️ 仍欠(须单独立批,不在本批):fencing generation(50 SPEC §2.1 `lockEpoch`)与
//    durable reconciler —— 有了它们才能把"未知"收敛成"确认终态"并安全提前释放。

/** 续租间隔:比任何轮询 sleep 都长、又远小于 LEASE_MS,避免每轮都打库。 */
const RENEW_INTERVAL_MS = 60 * 1000;
/** token → 上次续租时刻(仅进程内;释放时清理,避免无界增长)。 */
const _lastRenew = new Map<string, number>();

/**
 * 到点则续租(条件 token 匹配)。轮询循环每轮调一次即可,内部按时间节流。
 * 返回 false = **锁已不再属于我们**(lease 曾过期并被他人抢走)⇒ 调用方应停止写终态。
 */
export async function renewRunLockIfDue(lock: RunLock | null | undefined): Promise<boolean> {
  return (await renewRunLockIfDueDetailed(lock)) === "ok";
}

/**
 * 2026-11-04:续租失败的**两种原因动作相反**,所以要分开说。
 *   · `lost-taken-over`:行在,锁 token 不是我的(lease 曾过期被别的 run 抢走)⇒ 停止回写(另一条 run 正在跑同一作业,写会把状态写花);
 *   · `lost-row-gone`:实体行已被删(锁随行消失)⇒ **没有任何人会再收口这条 run**,轮询器必须继续跟踪到真正的终态,只是不再续租;
 *   · `lost-unknown`:条件不满足且两次都读不出行 ⇒ 按「行可能已删」处理(继续跟踪;停下来才是缺陷原形);
 *   · `ok`:续上了 / 没到点 / 瞬时错误(lease 还在,下轮再续)。
 * 分辨靠 DDB 原子带回的旧行(ReturnValuesOnConditionCheckFailure=ALL_OLD):有旧行 = 行在;没带回来再读一次确认。
 */
export type RenewOutcome = "ok" | "lost-taken-over" | "lost-row-gone" | "lost-unknown";

export async function renewRunLockIfDueDetailed(lock: RunLock | null | undefined): Promise<RenewOutcome> {
  if (!lock) return "ok";
  const last = _lastRenew.get(lock.token) ?? 0;
  if (nowMs() - last < RENEW_INTERVAL_MS) return "ok";
  const { tokenAttr, expAttr } = lockAttrs(lock.attr);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: lock.table,
        Key: lock.key,
        UpdateExpression: "SET #e = :exp",
        ConditionExpression: "#t = :tok", // 🔴 只续自己的锁
        ExpressionAttributeNames: { "#t": tokenAttr, "#e": expAttr },
        ExpressionAttributeValues: { ":tok": lock.token, ":exp": nowMs() + LEASE_MS },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
    _lastRenew.set(lock.token, nowMs());
    return "ok";
  } catch (e: any) {
    if (e?.name !== "ConditionalCheckFailedException") return "ok"; // 网络/限流抖动:不当作丢锁(lease 还在),下轮再续
    const where = `${lock.table} ${JSON.stringify(lock.key)} ${lock.attr}`;
    if (ccfReturnedItem(e)) {
      console.warn("[run-lock] 续租失败:锁已被别的 run 持有(lease 曾过期被抢),本 run 停止回写", where);
      return "lost-taken-over";
    }
    const presence = await lockRowPresence(lock.table, lock.key);
    if (presence === "present") {
      console.warn("[run-lock] 续租失败:锁已被别的 run 持有(lease 曾过期被抢),本 run 停止回写", where);
      return "lost-taken-over";
    }
    if (presence === "absent") {
      console.warn("[run-lock] 续租失败:实体行已不存在(作业已删,锁随行消失);本 run 继续跟踪到终态、不再续租", where);
      return "lost-row-gone";
    }
    console.warn("[run-lock] 续租失败且两次都读不出实体行 ⇒ 按「行可能已删」处理:继续跟踪到终态、不再续租", where);
    return "lost-unknown";
  }
}

/**
 * 轮询耗尽时调用:**保持持锁**,只把 lease 顶满一次并留下明确告警。
 *
 * 🔴 故意不释放。此刻我们只知道"我们不再看着它了",**不知道后端是否已结束**;
 * 释放 = 允许第二个 run 与仍在执行的作业并发写同一张目标表。宁可让后续 run 等 lease,
 * 也不能重新打开并发窗口。
 */
export async function keepRunLockForReconcile(
  lock: RunLock | null | undefined,
  ctx: { jobId?: string; runId?: string; engine?: string }
): Promise<void> {
  if (!lock) return;
  await renewRunLockIfDue({ ...lock, token: lock.token }).catch(() => {});
  console.warn(
    "[run-lock] 轮询耗尽但后端状态未知 ⇒ **保持持锁**(不释放),等 lease 兜底或 reconciler 收口。",
    JSON.stringify({ ...ctx, table: lock.table, attr: lock.attr, leaseMs: LEASE_MS })
  );
}

/**
 * 释放运行锁(条件:token 匹配,防误释放别人续上的锁)。best-effort,失败静默
 * (lease TTL 会兜底过期;绝不能因释放失败阻断作业终态回写)。
 * 🔴 **只在确认后端到达终态时调用**;轮询耗尽请改调 `keepRunLockForReconcile()`。
 */
export async function releaseRunLock(lock: RunLock | null | undefined): Promise<void> {
  if (!lock) return;
  const { tokenAttr, expAttr } = lockAttrs(lock.attr);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: lock.table,
        Key: lock.key,
        UpdateExpression: "REMOVE #t, #e",
        ConditionExpression: "#t = :tok",
        ExpressionAttributeNames: { "#t": tokenAttr, "#e": expAttr },
        ExpressionAttributeValues: { ":tok": lock.token },
      })
    );
  } catch {
    /* token 不匹配(已被 lease 过期后他人抢走)或已释放 → 无害,静默 */
  } finally {
    _lastRenew.delete(lock.token); // 防续租表无界增长
  }
}

// ── 便捷包装:作业级锁(ETL/EMR 作业行,key={userId,jobId},attr=runLock)。保留旧签名,三引擎 run 路径调用。──
const USER_ID = "default-user";

export async function acquireJobRunLock(
  table: string,
  jobId: string,
  waitMs = 0,
  // 缺省/home 时属性名与存量逐字节相同。
  targetId?: string | null
): Promise<RunLock | null> {
  // 2026-11-04:作业行锁只许落在仍存在的作业行上(见 AcquireRunLockOptions.requireRowExists)
  return acquireRunLock(table, { userId: USER_ID, jobId }, waitMs, lockAttrFor({ targetId }), { requireRowExists: true });
}

// ── 2026-11-04:从作业行**读出**谁还持着运行锁(删作业前的在途判据之一;锁属性文法的唯一作者在本文件,所以反解也放这里)──

/**
 * 「刚续租过」的时间窗 —— 它只覆盖**平台进程里的持有者**(TS 的 runGlueScriptJob / runRedshiftSqlJob / EMR submit 抢锁时把 ExpiresAt 写成
 * `now + LEASE_MS`,轮询每 RENEW_INTERVAL_MS 顶一次),所以 `ExpiresAt - LEASE_MS` = 上一次续租时刻,两个间隔内续过 ⇒ 提交段 / 轮询仍活着。
 * 🔴 实话:**MWAA / Serverless 的 Python 执行体抢锁后从不续租**(一次 ExpiresAt = now + 90 min,`_acquire_run_lock`),两分钟后就落到窗外 ——
 *   定时 / 工作流节点的在途**不靠这把锁判**,靠它们开跑即落的 running run 行(2026-11-04 起 `_record_start`;更早发布的 DAG 要重发才有)。
 *   这把锁对删除只多挡一件事:TS 提交段抢到锁、run 行还没写出来的那几秒。
 * 超过窗还没续 ⇒ 轮询已耗尽(`keepRunLockForReconcile` 之后)或进程已死,只剩 lease 在兜底 —— 此时 run 行才是权威(对账会把它收口),
 *   删作业的判据不该再被这把「没人看着」的锁挡 90 分钟。
 */
export const RUN_LOCK_LIVE_WINDOW_MS = 2 * RENEW_INTERVAL_MS;
/** lease 时长(只读导出给判据算 ExpiresAt;写侧仍只有本文件一个作者)。 */
export const RUN_LOCK_LEASE_MS = LEASE_MS;

/** 「刚续租过」的 ExpiresAt 下界:ExpiresAt 大于它 ⇔ 最近一个 live 窗内续过(内存判据与 DeleteItem 条件共用这一个数)。 */
export function runLockLiveCutoff(now = nowMs()): number {
  return now + LEASE_MS - RUN_LOCK_LIVE_WINDOW_MS;
}

/** lease 未过期 **且** 最近一个 live 窗内续过租(= ExpiresAt > runLockLiveCutoff(now);LEASE_MS ≫ 窗,所以也必然 > now)。 */
export function runLockRecentlyRenewed(expiresAt: unknown, now = nowMs()): boolean {
  const exp = typeof expiresAt === "number" ? expiresAt : Number(expiresAt);
  return Number.isFinite(exp) && exp > runLockLiveCutoff(now);
}

export interface HeldJobRunLock {
  /** 锁属性前缀(`runLock` / `runLock-<targetId>`) */
  attr: string;
  /** 由属性名反解的执行目标(home 的锁属性没有 target 段 ⇒ `tgt_home`) */
  targetId: string;
  expiresAt: number;
  /** 距上次续租的毫秒数(由 ExpiresAt 反推) */
  renewedAgoMs: number;
  /** 见 runLockRecentlyRenewed */
  recentlyRenewed: boolean;
}

/** 作业行上 token 属性名的文法(只认作业级锁:`runLock` / `runLock-<target>`;工作流节点锁 `runLock_<node>` 不在此列)。 */
const JOB_LOCK_TOKEN_ATTR_RE = /^(runLock(?:-([A-Za-z0-9_]+))?)Token$/;

/**
 * 从**作业行**读出所有 lease 未过期的作业级运行锁(不读库,只看传进来的行)。
 * `targetId` 的字符集是 `[a-z0-9_]`(§1.1a)⇒ `sanitizeLockPart` 对它是恒等 ⇒ 由属性名反解无歧义。
 */
export function heldJobRunLocks(row: Record<string, unknown> | null | undefined, now = nowMs()): HeldJobRunLock[] {
  if (!row) return [];
  const out: HeldJobRunLock[] = [];
  for (const [k, v] of Object.entries(row)) {
    const m = JOB_LOCK_TOKEN_ATTR_RE.exec(k);
    if (!m || v === undefined || v === null) continue;
    const attr = m[1];
    const rawExp = row[`${attr}ExpiresAt`];
    const expiresAt = typeof rawExp === "number" ? rawExp : Number(rawExp);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue; // lease 已过期 = 僵尸锁,下一个 run 可直接抢,不算在途
    out.push({
      attr,
      targetId: m[2] ?? HOME_TARGET_ID,
      expiresAt,
      renewedAgoMs: Math.max(0, now - (expiresAt - LEASE_MS)),
      recentlyRenewed: runLockRecentlyRenewed(expiresAt, now),
    });
  }
  return out;
}
export async function releaseJobRunLock(lock: RunLock | null | undefined): Promise<void> {
  return releaseRunLock(lock);
}

/**
 * 2026-11-04:作业行上可能承载作业级锁的全部属性前缀 —— home + 各绑定区(由 lockAttrFor 算)+ 行上已有的任何作业级锁属性
 * (含已解绑区的残留)。给 DeleteItem 的条件用,所以**宁多勿少**。
 */
export function jobLockAttrsOf(row: Record<string, unknown> | null | undefined, targets: readonly string[]): string[] {
  const set = new Set<string>([lockAttrFor({}), ...targets.map((t) => lockAttrFor({ targetId: t }))]);
  for (const k of Object.keys(row ?? {})) {
    const m = JOB_LOCK_TOKEN_ATTR_RE.exec(k);
    if (m) set.add(m[1]);
  }
  return Array.from(set).sort();
}

/**
 * 删作业行的 DeleteItem 条件:每把作业级锁都「不存在,或最近一个 live 窗内没人续租」—— 与 `heldJobRunLocks().recentlyRenewed`
 * 是**同一条判据**(同一个 runLockLiveCutoff),只是交给 DDB 原子地判:堵住「删前核完、删行之前刚好有一次运行抢到锁」的窄窗。
 * 条件不满足 ⇒ ConditionalCheckFailedException,什么都没删。
 */
export function noLiveJobLockCondition(
  row: Record<string, unknown> | null | undefined,
  targets: readonly string[],
  now = nowMs()
): { ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const parts: string[] = [];
  jobLockAttrsOf(row, targets).forEach((attr, i) => {
    const { tokenAttr, expAttr } = lockAttrs(attr);
    names[`#lk${i}`] = tokenAttr;
    names[`#le${i}`] = expAttr;
    parts.push(`(attribute_not_exists(#lk${i}) OR #le${i} < :liveCutoff)`);
  });
  return { ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: { ":liveCutoff": runLockLiveCutoff(now) } };
}
