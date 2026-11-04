// 区域审计表 / 区域结果表 / 同意留存表的**唯一写入方**(50 SPEC v3.23 §1.3a S4·S13 / §3.2 / §3.3;DESIGN §18 决策 6quinquies ③④)。
//
// 【三张表,三种落点,一个作者】
//   · 区域审计表  `bgp-region-audit-<slug>`(在 target 所在 region;名字来自描述符资源袋 `residencyAuditTable`):
//       pk="audit#<targetId>#<yyyymmdd>"  sk="<ts>#<auditId>"  —— 全量(operator / SQL 原文 / statementId / entry / triggeredBy / authKind)
//   · 区域结果表  `bgp-region-results-<slug>`(同 region;`residencyResultsTable`):
//       pk="<projectId>#<targetId>"  sk="sql-history#<ts>#<historyId>"  —— 跨法域 target 的 SQL 历史原文**只**在这里
//   · 同意留存表  `bgp-residency-acks`(中央 home;S13):
//       pk="<userSub>"  sk="<targetId>#<disclaimerVersion>"  + GSI byTarget(targetId, at)  —— 只追加
//
// 🔴 三条纪律:
//   ① 表名 / region 只从**描述符资源袋**取(finalize 回写、probe 真探过的实名),缺一即抛 —— 猜名字的后果不是报错,
//      是「看起来写成功了,其实写进了别的表」;
//   ② 只 Put / Get / Query,**永不** Update / Delete(平台 TaskRole 对三张表本来就 Deny 改删;这里连代码路径都不给);
//   ③ 本文件不做业务判断(要不要审、审什么)—— 那是 residency-audit.ts 的事;这里只负责「往哪写、怎么写」。
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { dynamoDocClientFor } from "@/lib/exec-env/target-clients";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
import type { AuthKind, ResidencyEntry } from "@/lib/exec-env/residency";

export type ResidencyResourceKey = "residencyAuditTable" | "residencyResultsTable" | "residencyBucket";

/** 描述符资源袋里的 residency 实名(finalize 回写);缺 / 非字符串 ⇒ 抛(fail-closed,不猜)。 */
export function requireResidencyResource(t: ExecutionTarget, key: ResidencyResourceKey): string {
  const v = (t.resources ?? {})[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(
      `target ${t.targetId} 的描述符资源袋里没有 ${key} —— 跨法域 target 必须先「补充部署」residency-api 并探活通过` +
        `(residencyPrerequisite 本该在准入处拒掉它;走到这里说明描述符被绕过或半写)`
    );
  }
  return v;
}

/** 描述符上的 region(位置属性);缺失不得回落 home。 */
export function requireTargetRegion(t: ExecutionTarget): string {
  const r = typeof t.region === "string" && t.region.trim() ? t.region : "";
  if (!r) throw new Error(`target ${t.targetId} 的描述符没有 region —— 拒绝(位置属性缺失不得回落 home)`);
  return r;
}

// ── 区域审计(全量)────────────────────────────────────────────────────────────
export interface RegionAuditRecord {
  auditId: string;
  targetId: string;
  jurisdiction: string;
  entry: ResidencyEntry;
  authKind: AuthKind;
  /** 操作者 Cognito sub(区域侧留全量;中央摘要**不带**) */
  operatorSub: string;
  /** 操作者可读名(email / username);同上只在区域侧 */
  operator: string;
  projectId?: string;
  sqlText?: string;
  statementId?: string;
  triggeredBy?: string;
  /** ISO 时间戳(与 sk 前缀同一份) */
  ts: string;
}

export function regionAuditKey(rec: Pick<RegionAuditRecord, "targetId" | "ts" | "auditId">): { pk: string; sk: string } {
  const day = rec.ts.slice(0, 10).replace(/-/g, "");
  return { pk: `audit#${rec.targetId}#${day}`, sk: `${rec.ts}#${rec.auditId}` };
}

/** 写一条区域审计。任何异常**原样上抛**(调用方据此判 AuditUnavailable ⇒ 操作不执行)。 */
export async function putRegionAudit(t: ExecutionTarget, rec: RegionAuditRecord): Promise<void> {
  const region = requireTargetRegion(t);
  const table = requireResidencyResource(t, "residencyAuditTable");
  const c = await dynamoDocClientFor(region);
  await c.send(
    new PutCommand({
      TableName: table,
      Item: { ...regionAuditKey(rec), ...rec },
      // auditId 是 ulid,撞键只可能是重放 ⇒ 拒而不是覆盖(审计只追加)
      ConditionExpression: "attribute_not_exists(pk)",
    })
  );
}

// ── 区域结果表:SQL 历史原文 ────────────────────────────────────────────────────
export const SQL_HISTORY_KIND = "sql-history";

export interface RegionSqlHistoryRecord {
  projectId: string;
  historyId: string;
  sqlText: string;
  operatorSub: string;
  ts: string;
}

/** 区域结果表的分区键:一个项目在一个 target 上的所有留区结果同分区(SPEC §1.3a S4)。 */
export function regionResultsPk(projectId: string, targetId: string): string {
  return `${projectId}#${targetId}`;
}

/** 写跨法域 target 的 SQL 历史原文到区域结果表;返回 `sqlRef`(= sk),中央历史行只存这个指针。 */
export async function putRegionSqlHistory(t: ExecutionTarget, rec: RegionSqlHistoryRecord): Promise<{ sqlRef: string }> {
  const region = requireTargetRegion(t);
  const table = requireResidencyResource(t, "residencyResultsTable");
  const c = await dynamoDocClientFor(region);
  const sk = `${SQL_HISTORY_KIND}#${rec.ts}#${rec.historyId}`;
  await c.send(
    new PutCommand({
      TableName: table,
      Item: { pk: regionResultsPk(rec.projectId, t.targetId), sk, kind: SQL_HISTORY_KIND, targetId: t.targetId, ...rec },
      ConditionExpression: "attribute_not_exists(pk)",
    })
  );
  return { sqlRef: sk };
}

/** 按中央历史行上的指针读回区域原文;不存在 ⇒ null(其余异常上抛)。 */
export async function getRegionSqlHistory(
  t: ExecutionTarget,
  projectId: string,
  sqlRef: string
): Promise<RegionSqlHistoryRecord | null> {
  if (!sqlRef.startsWith(`${SQL_HISTORY_KIND}#`)) throw new Error(`非法的 sqlRef:${JSON.stringify(sqlRef)}`);
  const region = requireTargetRegion(t);
  const table = requireResidencyResource(t, "residencyResultsTable");
  const c = await dynamoDocClientFor(region);
  const { Item } = await c.send(new GetCommand({ TableName: table, Key: { pk: regionResultsPk(projectId, t.targetId), sk: sqlRef } }));
  if (!Item) return null;
  return {
    projectId: String(Item.projectId ?? projectId),
    historyId: String(Item.historyId ?? ""),
    sqlText: String(Item.sqlText ?? ""),
    operatorSub: String(Item.operatorSub ?? ""),
    ts: String(Item.ts ?? ""),
  };
}

// ── 同意留存(中央 S13)──────────────────────────────────────────────────────────
export interface AckRecord {
  userSub: string;
  username: string;
  targetId: string;
  version: string;
  textHash: string;
  at: string;
  ip?: string;
  ua?: string;
  /** 同意发生在哪一步:`register` = 注册向导末步(注册该 target 的 admin)· `ack`(缺省)= 首次数据操作的弹窗 / POST /api/residency/ack */
  source?: "register" | "ack";
}

export function ackKey(userSub: string, targetId: string, version: string): { pk: string; sk: string } {
  return { pk: userSub, sk: `${targetId}#${version}` };
}

/**
 * 进程内**正向**缓存(带有界 TTL):同意一旦留存不撤销(表只追加、无 TTL),所以「有」可以缓存、「没有」绝不缓存
 * (否则用户刚同意、另一个实例还说没有 ⇒ 反复弹窗)。
 * 🔴 正向条目也有 TTL(2 分钟):权限类事实的进程内缓存必须**有界陈旧** —— 行被带外删除(数据主体删除请求 / 合规处置 /
 * 验收环境重置)时,多任务实例不能有的说「已同意」、有的说「没有」直到进程重启(真环境 W5a 抓到:两台 ECS 任务分歧);
 * 过期后回 DDB(ConsistentRead)一次即对齐。成本 = 每用户 × target 每 2 分钟一次 GetItem,可忽略。
 */
export const ACK_CACHE_TTL_MS = 120_000;
const ackCache = new Map<string, number>(); // key → expiresAt(epoch ms)

function ackCacheKey(userSub: string, targetId: string, version: string): string {
  return `${userSub}#${targetId}#${version}`;
}

function ackCacheHit(k: string, now: number): boolean {
  const exp = ackCache.get(k);
  if (exp === undefined) return false;
  if (exp > now) return true;
  ackCache.delete(k);
  return false;
}

export async function hasAck(userSub: string, targetId: string, version: string, now = Date.now()): Promise<boolean> {
  const k = ackCacheKey(userSub, targetId, version);
  if (ackCacheHit(k, now)) return true;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.RESIDENCY_ACKS, Key: ackKey(userSub, targetId, version), ConsistentRead: true })
  );
  if (Item) {
    ackCache.set(k, now + ACK_CACHE_TTL_MS);
    return true;
  }
  return false;
}

/** 写一条同意记录;已存在 ⇒ `created:false`(幂等,不改原记录 —— 表只追加)。 */
export async function putAck(rec: AckRecord): Promise<{ created: boolean }> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.RESIDENCY_ACKS,
        Item: { ...ackKey(rec.userSub, rec.targetId, rec.version), ...rec },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    ackCache.set(ackCacheKey(rec.userSub, rec.targetId, rec.version), Date.now() + ACK_CACHE_TTL_MS);
    return { created: true };
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      ackCache.set(ackCacheKey(rec.userSub, rec.targetId, rec.version), Date.now() + ACK_CACHE_TTL_MS);
      return { created: false };
    }
    throw e;
  }
}

/** 某 target 的全部同意记录(GSI byTarget,按时间倒序;翻到底,不单页)。 */
export async function listAcksByTarget(targetId: string): Promise<AckRecord[]> {
  const out: AckRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.RESIDENCY_ACKS,
        IndexName: "byTarget",
        KeyConditionExpression: "targetId = :t",
        ExpressionAttributeValues: { ":t": targetId },
        ScanIndexForward: false,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of (r.Items ?? []) as Array<Record<string, unknown>>) {
      out.push({
        userSub: String(it.userSub ?? it.pk ?? ""),
        username: String(it.username ?? ""),
        targetId: String(it.targetId ?? targetId),
        version: String(it.version ?? ""),
        textHash: String(it.textHash ?? ""),
        at: String(it.at ?? ""),
        ...(typeof it.ip === "string" ? { ip: it.ip } : {}),
        ...(typeof it.ua === "string" ? { ua: it.ua } : {}),
        source: it.source === "register" ? "register" : "ack",
      });
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  return out;
}

/** 单测用。 */
export function __resetAckCache(): void {
  ackCache.clear();
}
