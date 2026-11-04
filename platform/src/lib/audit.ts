import { NextRequest } from "next/server";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
// @kf-batch 50-WP4ter-coverage —— targetId 形态判定复用唯一权威(不在这里写正则)
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { scalarTargetOf, type TargetScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";

// AUTH-04 — operation audit log.
//
// All audit records live in a single logical partition. Write volume on this platform is
// low (a workshop/demo deployment), so one partition with a time-ordered sort key gives
// cheap, correct reverse-chronological reads. If write throughput ever outgrows a single
// partition, shard the pk (e.g. by day) and fan-out the read query.
export const AUDIT_PK = "audit";

// @kf-batch 52-P52.5a-supply
/**
 * 审计的**行为主体**。原先它是本文件私有的 `AuditActor`,只能由 `NextRequest` 解出来。
 *
 * 🔴 为什么必须导出并让它可以脱离 `NextRequest`:50 SPEC §3.9a 的闭合执行器
 * `executeAdminDdl(actor, request)` 会被**无请求上下文**的路径调用(后台供给、DAG),
 * 而它的第 6 步是 **fail-closed-on-audit**(写不进审计就拒绝执行)。
 * 现有 `recordAudit(req, …)` 两条都不满足:① 强依赖 `NextRequest`;② **吞掉所有异常**。
 * ⇒ 抽出一个**会抛**的内核 `writeAuditRecord()`,`recordAudit` 退化成它的"吞异常"包装。
 * **刻意不写第二套审计**(同一张表、同一 item 形状、同一作者)。
 */
export interface AuditActorRef {
  actor: string; // best human-readable id: email > cognito:username > sub
  actorSub?: string;
  email?: string;
}

type AuditActor = AuditActorRef;

// Decode (NOT verify) the Cognito ID token to attribute the action to a user. The
// platform's middleware already verifies every /api/* request's token signature, issuer
// and audience, so here we only need to read the claims — base64-decoding the JWT body.
// 🔴 生产上线批次 A:这个前提由中间件「鉴权未配置即拒」保证(不再有「没配 Cognito = 全站放开」);
//    用户维度的数据分区一律用 lib/auth/identity 的 requireIdentity(已校验的 sub),这里只用于署名。
function actorFromRequest(req: NextRequest): AuditActor {
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    try {
      const payload = JSON.parse(Buffer.from(auth.split(".")[1], "base64").toString());
      const email = typeof payload.email === "string" ? payload.email : undefined;
      const username = typeof payload["cognito:username"] === "string" ? payload["cognito:username"] : undefined;
      const sub = typeof payload.sub === "string" ? payload.sub : undefined;
      return { actor: email || username || sub || "unknown", actorSub: sub, email };
    } catch {
      /* fall through */
    }
  }
  return { actor: "anonymous" };
}

export interface AuditOptions {
  resourceType?: string; // e.g. "datasource" | "sync" | "workflow"
  resourceId?: string;
  /**
   * @kf-batch 50-WP4ter-coverage(工单 SC-12)
   * 这次动作**作用在哪个执行环境**上。审计表原来一个区维都没有(50 SPEC §3.3 的设计里写了
   * target 分片,实际没写)⇒ 审计日志页无法回答「谁在哪个区做了什么」,跨法域下还牵涉留区。
   *
   * 🔴 **只由调用方显式给,或由下面那条派生规则得出,不猜**:猜错的审计比没有审计更糟
   * (事后复盘会把动作算到错的区头上)。
   */
  targetId?: string;
  // Free-form, NON-SENSITIVE context. Never pass secrets/passwords here — callers are
  // responsible for whitelisting safe fields (e.g. { name, type, host }).
  detail?: Record<string, unknown> | string;
}

// Record an operation. Best-effort: never throws and never blocks the caller's response.
// Invoke fire-and-forget, e.g.:
//
//     recordAudit(req, "datasource.create", { resourceType: "datasource", resourceId: id });
//
export async function recordAudit(
  req: NextRequest,
  action: string,
  opts: AuditOptions = {}
): Promise<void> {
  try {
    await writeAuditRecord(actorFromRequest(req), action, opts, {
      method: req.method,
      path: req.nextUrl?.pathname || "",
    });
  } catch {
    // Swallow — auditing must never break the primary operation.
  }
}

// @kf-batch 52-P52.5a-supply
/**
 * 写一条审计记录并返回它的 **auditId**。
 *
 * 🔴 **本函数会抛**(与 `recordAudit` 的唯一区别)。50 SPEC §3.9a 第 6 步要求
 * 「写**执行意图**审计;审计失败**立即拒绝**(fail-closed-on-audit)」——
 * 一次没有审计记录的权限边界变更,事后无法复盘"当时凭什么放行"。
 * 想要"尽力而为"的语义就用 `recordAudit`(它包着本函数吞异常),两者共用同一份 item 形状。
 *
 * 🔴 `opts.detail` 的**非敏感**要求在这里同样成立(见 `AuditOptions` 注释):
 * 口令、secret 明文、完整敏感 SQL 一律不得进来。执行器只写 `sqlSkeleton(sql)`。
 *
 * @returns auditId —— 即 item 的排序键 `${ISO}#${ulid()}`,全表唯一,可回查。
 */
export async function writeAuditRecord(
  actorRef: AuditActorRef,
  action: string,
  opts: AuditOptions = {},
  ctx: { method?: string; path?: string } = {}
): Promise<string> {
  const { item, auditId } = buildAuditItem(actorRef, action, opts, ctx);
  await docClient.send(new PutCommand({ TableName: TABLES.AUDIT, Item: item }));
  return auditId;
}

// @kf-batch 50-WP9a-durable-jobs
/**
 * **恰好一次**的审计写(会抛)。
 *
 * 🔴 为什么需要:数据面长作业的「结果审计」写在**读到终态**的那一步,而那一步可能因为进程猝死 /
 * 租约被接手而**重做**(作业可续跑的代价)。用 `writeAuditRecord` 重做一次就多一条审计,
 * 判据 JB-4「审计每步恰一条」就红。
 * ⇒ 排序键由调用方给的**确定性** `onceKey` 决定(通常 = `<意图审计 id>#settled`),
 *   `attribute_not_exists(ts)` 条件写:第二次写被拒 ⇒ 视为「已经写过了」,返回同一个 id。
 * 🔴 `onceKey` 必须以 ISO 时间开头(意图审计 id 正是如此)⇒ 按 ts 倒序读审计时它仍排在该排的位置。
 */
export async function writeAuditRecordOnce(
  actorRef: AuditActorRef,
  action: string,
  opts: AuditOptions,
  onceKey: string
): Promise<{ auditId: string; written: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(onceKey)) {
    throw new Error(`writeAuditRecordOnce:onceKey 必须以 ISO 时间开头(收到 ${JSON.stringify(onceKey)})`);
  }
  const { item } = buildAuditItem(actorRef, action, opts);
  item.ts = onceKey;
  try {
    await docClient.send(
      new PutCommand({ TableName: TABLES.AUDIT, Item: item, ConditionExpression: "attribute_not_exists(ts)" })
    );
    return { auditId: onceKey, written: true };
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return { auditId: onceKey, written: false };
    throw e;
  }
}

// @kf-batch 50-W5-seg2-WP8
/**
 * 构造一条审计 item(**纯函数,不写库**)。
 *
 * 🔴 为什么抽出来:51 SPEC §6.1③ 要求「配置写 + `__version` ADD + 审计 Put」放进**同一个**
 * `TransactWriteCommand`(审计写不进去配置就不生效)。事务里的审计 item 必须与 `writeAuditRecord`
 * **同一形状、同一作者**,否则就是第二套审计。`writeAuditRecord` 现在只是「本函数 + 一次 Put」,
 * 行为逐字节不变;想进事务的调用方拿 `item` 自己放进 `TransactItems`。
 *
 * @returns item = 落表对象;auditId = 排序键 `${ISO}#${ulid()}`(与 `writeAuditRecord` 返回值同义)
 */
export function buildAuditItem(
  actorRef: AuditActorRef,
  action: string,
  opts: AuditOptions = {},
  ctx: { method?: string; path?: string } = {}
): { item: Record<string, unknown>; auditId: string } {
  const { actor, actorSub, email } = actorRef;
  const ts = new Date().toISOString();
  const auditId = `${ts}#${ulid()}`; // enables reverse-chronological reads (ScanIndexForward=false)
  // @kf-batch 50-WP4ter-coverage —— **派生规则(单一处)**:`resourceType === "exec-env"` 时
  // `resourceId` **就是** targetId(全部 12 条 `/api/admin/exec-envs/[targetId]/**` 路由都这么传)。
  // 🔴 写成派生而不是去改 138 个调用点:改 138 处必漏,而漏掉的那处会静默落到「无章」⇒ 归主控区。
  // 数据面的动作(同步启动 / 问数 / 质量运行)另由调用方显式传 `targetId`(它们知道真落点)。
  const derivedTarget =
    opts.targetId || (opts.resourceType === "exec-env" && isValidTargetId(opts.resourceId || "") ? opts.resourceId : undefined);
  const item: Record<string, unknown> = {
    pk: AUDIT_PK,
    ts: auditId,
    ...(derivedTarget ? { targetId: derivedTarget } : {}),
    timestamp: ts,
    actor,
    ...(actorSub ? { actorSub } : {}),
    ...(email ? { email } : {}),
    action,
    resourceType: opts.resourceType || "",
    ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    method: ctx.method ?? "",
    path: ctx.path ?? "",
  };
  return { item, auditId };
}

/**
 * 从 `NextRequest` 解出审计主体(供路由层把身份交给会进事务的 store 函数)。
 * 与 `recordAudit` 内部用的是同一个解析器(`actorFromRequest`),只是导出一个名字。
 */
export function auditActorFromRequest(req: NextRequest): AuditActorRef {
  return actorFromRequest(req);
}

/**
 * Read the most recent audit entries (reverse-chronological).
 *
 * @kf-batch 50-WP4ter-coverage(工单 SC-12)
 * @param opts.scope 传了就只回**归属该执行范围**的条目。
 *
 * 🔴 **必须翻页**:DDB 的 `Limit` 是**过滤之前**的量。按区过滤后直接返回会让「最近 200 条」
 * 变成「最近 200 条里恰好属于这个区的那几条」——用户看到的是一个**静默截断**的审计日志,
 * 而审计日志少一条的后果就是复盘时那条动作根本不存在。⇒ 一页一页往前翻,直到凑够 limit 条
 * 匹配的、或翻到表尾为止(与 `resource-index.listRowsForCount` 同一条纪律)。
 *
 * 🔴 **无章的存量条目归主控区**(`scalarTargetOf` 的统一回落):审计表落章之前,平台的动作
 * 全部发生在主控区(控制面就在那儿)⇒ 归主控区是历史事实。但**跨区动作的存量条目**因此
 * 也会落在主控区视角 —— 这一点如实登记在 WORK-PACKAGES WP-4ter,不靠猜去补。
 */
export async function queryAuditLog(
  limit = 200,
  opts: { scope?: TargetScope } = {}
): Promise<Record<string, any>[]> {
  const want = Math.min(Math.max(limit, 1), 1000);
  const wantTargets = opts.scope ? scopeTargets(opts.scope) : [];
  const out: Record<string, any>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLES.AUDIT,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": AUDIT_PK },
        ScanIndexForward: false,
        // 过滤时一次多取一些(减少往返);不过滤时保持与改动前**逐字节相同**的单页行为。
        Limit: wantTargets.length === 0 ? want : Math.min(want * 5, 1000),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    const items = (res.Items ?? []) as Record<string, any>[];
    for (const it of items) {
      if (wantTargets.length > 0 && !wantTargets.includes(scalarTargetOf(it, "audit"))) continue;
      out.push(it);
      if (out.length >= want) return out;
    }
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && wantTargets.length > 0);
  return out;
}
