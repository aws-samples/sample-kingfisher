// 模块 16/33（根治·裂缝C）— 作业级运行锁(job-level run serialization)。
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

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
// @kf-batch 50-P50.3-multibind
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

// lease 时长:覆盖最长离线作业(Glue poll 160×15s≈40min,Redshift 120×2s=4min,EMR 240×15s=60min)。
// 取 90min 上限兜底——正常路径跑完即主动释放,lease 只在进程崩溃/轮询丢失时兜底,宁长勿误杀在跑的作业。
const LEASE_MS = 90 * 60 * 1000;

// 抢锁重试(backfill 排队等待前一个 run 终态)的轮询间隔。手动 run 用 waitMs=0 不进入重试。
const RETRY_INTERVAL_MS = 15 * 1000;

const nowMs = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * @kf-batch 50-WP4bis-p1-scope
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

// @kf-batch 50-P50.3-multibind
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
export async function tryAcquireRunLock(
  table: string,
  key: Record<string, string>,
  attr = "runLock"
): Promise<RunLock | null> {
  const token = ulid();
  const expiresAt = nowMs() + LEASE_MS;
  const { tokenAttr, expAttr } = lockAttrs(attr);
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        // 抢锁:当前无锁(属性不存在)或 lease 已过期 → 写入本次 token + 新 lease。用占位名兼容动态属性名。
        UpdateExpression: "SET #t = :tok, #e = :exp",
        ConditionExpression: "attribute_not_exists(#t) OR #e < :now",
        ExpressionAttributeNames: { "#t": tokenAttr, "#e": expAttr },
        ExpressionAttributeValues: { ":tok": token, ":exp": expiresAt, ":now": nowMs() },
      })
    );
    return { table, key, attr, token };
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return null; // 别的 run 持锁未过期
    throw e; // 其它错误(权限/网络)照抛,不吞
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
  attr = "runLock"
): Promise<RunLock | null> {
  const deadline = nowMs() + waitMs;
  for (;;) {
    const lock = await tryAcquireRunLock(table, key, attr);
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
  if (!lock) return true;
  const last = _lastRenew.get(lock.token) ?? 0;
  if (nowMs() - last < RENEW_INTERVAL_MS) return true;
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
      })
    );
    _lastRenew.set(lock.token, nowMs());
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") {
      console.warn("[run-lock] 续租失败:锁已不属于本 run(lease 曾过期被抢)", lock.table, lock.key, lock.attr);
      return false;
    }
    return true; // 网络/限流抖动:不当作丢锁(lease 还在),下轮再续
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
  // @kf-batch 50-P50.3-multibind —— 缺省/home 时属性名与存量逐字节相同。
  targetId?: string | null
): Promise<RunLock | null> {
  return acquireRunLock(table, { userId: USER_ID, jobId }, waitMs, lockAttrFor({ targetId }));
}
export async function releaseJobRunLock(lock: RunLock | null | undefined): Promise<void> {
  return releaseRunLock(lock);
}
