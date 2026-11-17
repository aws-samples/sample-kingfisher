// 2a:周期 reconciler 的【单例选主】(进程内 lease 单例;SPEC §3.5a / DESIGN §20.24)。
//
// 【为什么必须选主】平台服务是 ApplicationLoadBalancedFargateService,desiredCount 2~6(可扩)⇒ 若每副本
//   都跑 reconciler,会对每个 target 重复探活 N 次。用一条 DDB 条件写租约选出唯一 leader,只它真跑。
// 🔴 **correctness 不依赖选主**:reconcileAfterProbe 幂等 + fence、reconcileTelemetry 条件写,偶发双跑只是
//   重复探活(浪费,不写坏)⇒ 选主是**效率**优化,不是正确性前提。故租约可短、可容忍抖动。
// 🔴 **租约时长的硬约束**:leader 猝死(来不及释放)后的「无人探活缺口」= 它最后一次探活距今(≤ 一个探活节拍)
//   + 租约剩余(≤ TTL,过期才可被抢)+ 备用副本的一个选主拍(接手后立刻探活),**必须 < 15 分钟探活过期阈值**
//   (否则非 home target 会在 leader 猝死后被判过期)。取 TTL = 3 分钟、选主拍 30 秒、探活节拍 4 分钟 ⇒ 缺口 ≤ 7.5 分钟。
//   续租在选主拍上做(每 30 秒),不再搭在 4 分钟的探活节拍上 ⇒ 探活 / 镜像一轮跑多久都拖不掉租约。
// 🔴 **正常退出要释放**(2026-11-16 真环境:滚动升级后旧 leader 被停、租约没释放,后台泵停了约 5 分钟,最长可到 12 分钟):
//   进程收到停止信号时由 reconciler-loop 调 `releaseLeaderLease`,备用副本在下一个选主拍(≤ 30 秒)接手;
//   只有猝死才靠 TTL 过期兜底(≤ 3.5 分钟)。
//
// 【为何不复用 run-lock.ts】run-lock.ts 是 ETL/EMR/workflow 作业级串行锁(防 DROP+CTAS 撞 OID 的数据正确性锁),
//   LEASE_MS 写死 90min、锁挂在业务实体行上。选主要的是**短租约 + 专用锁行**;为不动那条数据正确性关键锁,
//   本文件独立实现同款 DDB 条件写语义(acquire/renew/steal-on-expiry/release),短租约,锁行 pk="lock"/sk="reconciler"。
//   锁行的 pk="lock" 与执行环境 item 的 pk="env" 不同分区 ⇒ 对 listTargetsRaw/getTargetRaw(均查 pk="env")完全不可见。

import { UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";

/** 🔴 专用锁行(与执行环境 item 的 pk="env" 不同分区,互不可见)。 */
const LOCK_PK = "lock";
const LOCK_SK = "reconciler";

/** 🔴 租约时长:见文件头硬约束。取 3 分钟(主副本每个选主拍续一次,见 reconciler-loop.ts 的 ELECTION_BEAT_MS)。 */
export const RECONCILER_LEASE_MS = 3 * 60 * 1000;

export interface LeaderLease {
  /** 本副本持锁凭证;续租/释放都按它条件写,绝不误动别的副本的锁。 */
  token: string;
}

/**
 * 抢或续 leader 租约。`prev` 为上次持有的租约(续租)或 null(首次抢)。
 *  - 无锁 / 锁已过期 / 就是我自己(token 相同,续租)⇒ 写入我的 token + 新到期时间,返回租约;
 *  - 别的副本持锁且未过期 ⇒ ConditionalCheckFailed ⇒ 返回 null(本副本本 tick 不当 leader,跳过)。
 * 🔴 `now`/`leaseMs` 显式入参 = 确定性可测(loop 传 Date.now());DDB 条件写天然序列化 ⇒ 并发抢过期锁只有一个赢。
 */
export async function acquireOrRenewLeaderLease(
  prev: LeaderLease | null,
  now: number,
  leaseMs = RECONCILER_LEASE_MS
): Promise<LeaderLease | null> {
  const token = prev?.token ?? ulid();
  const expiresAt = now + leaseMs;
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
        UpdateExpression: "SET #tok = :tok, #exp = :exp",
        // 无锁 OR 已过期 OR 就是我(续租):三者任一才写。别的副本持锁未过期 ⇒ 三者皆假 ⇒ 拒。
        ConditionExpression: "attribute_not_exists(#tok) OR #exp < :now OR #tok = :tok",
        ExpressionAttributeNames: { "#tok": "leaseToken", "#exp": "leaseExpiresAt" },
        ExpressionAttributeValues: { ":tok": token, ":exp": expiresAt, ":now": now },
      })
    );
    return { token };
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return null; // 别的副本持锁未过期
    throw e; // 权限/网络错误照抛,不吞(否则会静默变成"永不当 leader")
  }
}

/**
 * 释放 leader 租约(条件 token 匹配,防误释放别人续上的锁)。不抛:失败也无害(租约 TTL 兜底过期)。
 * 返回值是事实:`true` = 锁行确实是本副本的、已删掉;`false` = 没有可释放的(没持锁 / 已被别的副本接手)或这次删除没成功。
 * 调用点:进程收到停止信号时(reconciler-loop 的 `releaseLeadershipOnShutdown`)。
 */
export async function releaseLeaderLease(lease: LeaderLease | null): Promise<boolean> {
  if (!lease) return false;
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLES.EXECUTION_ENVS,
        Key: { pk: LOCK_PK, sk: LOCK_SK },
        ConditionExpression: "#tok = :tok",
        ExpressionAttributeNames: { "#tok": "leaseToken" },
        ExpressionAttributeValues: { ":tok": lease.token },
      })
    );
    return true;
  } catch {
    /* token 不匹配(过期后已被别的副本抢走)/ 已释放 / 网络或权限错误 ⇒ 都不抛:租约到期兜底 */
    return false;
  }
}
