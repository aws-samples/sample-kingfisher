// 2a:周期 reconciler 的【单例选主】(进程内 lease 单例;SPEC §3.5a / DESIGN §20.24)。
//
// 【为什么必须选主】平台服务是 ApplicationLoadBalancedFargateService,desiredCount 2~6(可扩)⇒ 若每副本
//   都跑 reconciler,会对每个 target 重复探活 N 次。用一条 DDB 条件写租约选出唯一 leader,只它真跑。
// 🔴 **correctness 不依赖选主**:reconcileAfterProbe 幂等 + fence、reconcileTelemetry 条件写,偶发双跑只是
//   重复探活(浪费,不写坏)⇒ 选主是**效率**优化,不是正确性前提。故租约可短、可容忍抖动。
// 🔴 **租约 TTL + tick 周期的硬约束**:leader 猝死后"无人探活缺口" = 租约 TTL(过期才可被抢)+ 一个 tick,
//   **必须 < 15min stale 阈值**(否则非 home target 会在 leader 猝死后被判 stale 死)。取 TTL=8min、tick≈4min
//   ⇒ 缺口 ≈12min < 15min。续租间隔 < TTL(每 tick 续,tick 远 < TTL)。
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

/** 🔴 租约时长:见文件头硬约束(TTL + tick < 15min stale)。取 8min。 */
export const RECONCILER_LEASE_MS = 8 * 60 * 1000;

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
 * 释放 leader 租约(条件 token 匹配,防误释放别人续上的锁)。best-effort,失败静默
 * (租约 TTL 会兜底过期;进程退出时尽量释放让接管更快,失败也无害)。
 */
export async function releaseLeaderLease(lease: LeaderLease | null): Promise<void> {
  if (!lease) return;
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
  } catch {
    /* token 不匹配(已被过期后他人抢走)或已释放 ⇒ 无害,静默 */
  }
}
