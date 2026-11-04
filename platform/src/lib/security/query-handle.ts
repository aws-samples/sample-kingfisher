// S0 — queryHandle:修「凭 statementId 即可读他人查询结果」的现网越权(IDOR)。
//
// 设计合同:docs/design/50-multi-region-execution/SPEC.md §0(S0 独立安全修复)+ §3.7(完整机制)。
// 独立成批、与多区域改造无关,可单独上线与回滚。
//
// 缺陷原状:`/api/redshift/result/[id]` 只凭 URL 里的 statementId 取结果,**全程无鉴权**
// (`resolveIdentity` 只喂列脱敏、且 `.catch(() => null)`)⇒ 任一登录用户知道 statementId
// 即可读他人查询结果,仅受列级脱敏遮蔽。`/api/redshift/cancel` 同理(可取消他人查询),
// `/api/athena/query/[id]/results` 有 requireProject 但**不校验该 id 属于本项目** = 同构跨项目越权。
//
// 修法:提交语句时服务端签发 handle(记 statementId + ownerSub + projectId),取结果/取消
// 必须携带 `?handleId=` 并核对归属;不匹配 403、过期 410。
//
// 🔴 设计要点(SPEC §0「一期最小闭环」):`handleId` 是表的 **PK**。若图省事按 statementId
// 建键、取回不加参数,IDOR 根本没修 —— handle 的全部价值在于它是**只发给提交者的不可猜凭据**。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { resolveIdentity, type Identity } from "@/lib/auth/identity";
import { resolveRole } from "@/lib/projects/project-service";
import { ulid } from "ulid";

/** 传输方式定稿(SPEC §3.7):走 query 参数,不用 header —— 便于前端既有 fetch 改造与日志排查。 */
export const HANDLE_PARAM = "handleId";

/** 句柄有效期。取结果是提交后的短窗动作;36h 足够跨一个工作日,又不让凭据长期有效。 */
const TTL_SECONDS = 36 * 60 * 60;

/** 回滚开关的落点(SPEC §3.7)。置 false 即恢复现状 = **恢复 IDOR**,仅限紧急回滚。 */
const FLAG_PK = "system";
const FLAG_SK = "security#query-handle";
/** 开关缓存 5s:取结果是热路径,不能每次都打库(照 51 SPEC §3.1 的短 TTL 惯例)。 */
const FLAG_TTL_MS = 5000;

export type QueryEngine = "redshift" | "athena";

export interface QueryHandle {
  handleId: string;
  statementId: string;
  ownerSub: string;
  projectId: string;
  engine: QueryEngine;
  createdAt: string;
  /** epoch 秒。与 ttl 同值 —— ttl 交给 DDB 自动清理,expiresAt 供应用层判 410。 */
  expiresAt: number;
  ttl: number;
  // @kf-batch 50-P50.3-mrquery
  // ✅ **S0 当时留的两个字段,P50.3 W3-c1 起开始写**(表结构一次建全、写入分期填,SPEC §0)。
  // 🔴 `targetId` 是**取结果侧解析 region 的权威**:Redshift Data API 的 statementId 是 region 内的,
  // 拿错 region 的客户端去 Describe 会永远查不到 ⇒ 前端卡在「执行中」。
  // 把它记在**句柄**里(而不是只靠客户端传 `?targetId=`)⇒ 取结果这条路径的 region **不可被客户端操纵**。
  targetId?: string;
  jurisdiction?: string;
}

// ——————————————————————————————————————————————————————————————
// 回滚开关
// ——————————————————————————————————————————————————————————————

let flagCache: { value: boolean; at: number } | null = null;

/**
 * 是否强制校验 handle。默认 **true**。
 *
 * 🔴 读失败一律返回 true(fail-closed 到"强制校验")。这里的 fail-closed 方向必须想清楚:
 * 返回 false 会让配置表一挂就恢复 IDOR —— 开关本身成了绕过手段。返回 true 只是回到
 * 设计的默认行为(前端本来就会带 handle),代价可接受。
 */
export async function isHandleEnforced(): Promise<boolean> {
  const now = Date.now();
  if (flagCache && now - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  let value = true;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: FLAG_PK, sk: FLAG_SK } })
    );
    // 只有显式写入 enforce:false 才放行;缺项 = 默认强制。
    if (Item && Item.enforce === false) value = false;
  } catch {
    value = true; // fail-closed:见上方说明
  }
  flagCache = { value, at: now };
  return value;
}

/** 单测/紧急排障用:清掉开关缓存。 */
export function __resetHandleFlagCache(): void {
  flagCache = null;
}

// ——————————————————————————————————————————————————————————————
// 提交侧
// ——————————————————————————————————————————————————————————————

/**
 * 签发句柄。所有产出"可取结果"的提交路径都要经这里(SPEC §3.7 A 类)。
 *
 * 🔴 **漏一处 A 类 = 合法查询取不到结果**(fail-closed 误拒),所以提交点必须先枚举全。
 * 本函数**不抛**:签发失败只记日志并返回 undefined,让提交本身仍然成功 —— 否则一次 DDB
 * 抖动就把"能不能跑查询"变成"配置表可用性"的函数。取回侧此时会因无 handle 而拒,用户重跑即可
 * (比"查询直接跑不了"损失小)。
 */
export async function issueHandle(args: {
  statementId: string;
  identity: Identity;
  projectId: string;
  engine: QueryEngine;
  // @kf-batch 50-P50.3-mrquery —— 多 region 直查:这条语句提交在哪个 target / 哪个法域。
  // 可选是因为**存量提交点**(athena 等)本期还没接 target 维,缺省 = home 语义。
  targetId?: string;
  jurisdiction?: string;
}): Promise<string | undefined> {
  const { statementId, identity, projectId, engine } = args;
  const handleId = ulid();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + TTL_SECONDS;
  const item: QueryHandle = {
    handleId,
    statementId,
    ownerSub: identity.sub,
    projectId,
    engine,
    createdAt: new Date().toISOString(),
    expiresAt,
    ttl: expiresAt,
    // 🔴 只在有值时写:DDB 不接受 undefined 属性值,而**存量提交点不传** ⇒ 无条件写会当场炸,
    // 把「能不能跑查询」变成「有没有接 target 维」的函数。
    ...(args.targetId ? { targetId: args.targetId } : {}),
    ...(args.jurisdiction ? { jurisdiction: args.jurisdiction } : {}),
  };
  try {
    await docClient.send(new PutCommand({ TableName: TABLES.QUERY_HANDLES, Item: item }));
    return handleId;
  } catch (err) {
    console.error("[query-handle] 签发失败(提交仍继续,取回侧会拒):", err);
    return undefined;
  }
}

// @kf-batch 50-P50.3-mrquery
/**
 * 只从句柄里取 `targetId`,**用于选 region,不做任何授权判定**。
 *
 * 🔴 为什么需要它而不直接用 `requireQueryHandle`:SPEC §3.7 分档规定
 * 「**状态轮询不要求 handle**(避免轮询被句柄问题打断),一旦返回结果行才必须校验」。
 * 而状态轮询(`DescribeStatement`)**也需要正确的 region** —— statementId 是 region 内的。
 * ⇒ 这里做的是"**尽力**从句柄拿 region 线索",拿不到就回落到显式参数,**从不拒绝**。
 *
 * 🔴 **安全边界**:本函数只回一个 `targetId`(区域标识,不是数据),而 `handleId` 是不可猜的 ULID;
 * 真正的授权仍然由 `requireQueryHandle` 在**返回结果行之前**执行,一步都没少。
 */
export async function peekHandleTargetId(handleId: string | null | undefined): Promise<string | undefined> {
  if (!handleId) return undefined;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.QUERY_HANDLES, Key: { handleId } })
    );
    const t = (Item as QueryHandle | undefined)?.targetId;
    return typeof t === "string" && t ? t : undefined;
  } catch {
    return undefined; // 读不到就让调用方回落显式参数;绝不因此拒绝轮询
  }
}

// ——————————————————————————————————————————————————————————————
// 取回侧
// ——————————————————————————————————————————————————————————————

export interface HandleCheckOk {
  ok: true;
  handle: QueryHandle | null; // 开关关闭时为 null
  identity: Identity | null;
}

/**
 * 校验请求携带的 handle 是否有权访问 `statementId` 的结果。
 *
 * 返回 `NextResponse` 表示**拒绝**,路由直接 return 它;返回 `HandleCheckOk` 表示放行:
 *
 *     const chk = await requireQueryHandle(req, params.id, "redshift");
 *     if (chk instanceof NextResponse) return chk;
 *
 * 判定顺序(SPEC §3.7):无/错 handle → 403;过期 → 410;归属不符(既非本人、又非该项目成员)
 * → 403。平台管理员经 `resolveRole` 天然为 owner,故自动放行(与全平台惯例一致)。
 */
export async function requireQueryHandle(
  req: NextRequest,
  statementId: string,
  engine: QueryEngine
): Promise<HandleCheckOk | NextResponse> {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401, { code: "UNAUTHENTICATED" });

  if (!(await isHandleEnforced())) {
    // 紧急回滚态:放行但**留痕**,免得悄悄跑在无保护状态下。
    console.warn("[query-handle] 校验已被开关关闭(= 恢复 IDOR),statementId=%s", statementId);
    return { ok: true, handle: null, identity };
  }

  const handleId = req.nextUrl.searchParams.get(HANDLE_PARAM);
  if (!handleId) {
    // 存量语句(S0 上线前提交的)没有 handle,会走到这里。给可执行的提示而不是裸 403,
    // 否则用户只看到"无权限"会以为是权限配错了。
    return apiError("查询凭据缺失或已失效，请重新执行该查询", 403, { code: "RBAC_DENIED" });
  }

  let handle: QueryHandle | undefined;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.QUERY_HANDLES, Key: { handleId } })
    );
    handle = Item as QueryHandle | undefined;
  } catch (err) {
    console.error("[query-handle] 读取失败:", err);
    return apiError("查询凭据校验失败，请稍后重试", 503, { code: "UPSTREAM_ERROR" });
  }

  // 🔴 必须核对 handle 与 URL 里的 statementId 一致 —— 否则拿自己的 handle 配别人的
  // statementId 就绕过了全部校验(这是本修复最容易写漏的一步)。
  if (!handle || handle.statementId !== statementId || handle.engine !== engine) {
    return apiError("查询凭据与该查询不匹配", 403, { code: "RBAC_DENIED" });
  }
  if (handle.expiresAt <= Math.floor(Date.now() / 1000)) {
    return apiError("查询结果已过期，请重新执行该查询", 410, { code: "NOT_FOUND" });
  }
  if (handle.ownerSub !== identity.sub) {
    // 🔴 resolveRole 会打 DDB,可能抛。必须自己接住并**拒绝** —— 否则异常会冒到路由的
    // catch,而 redshift/result 的 catch 把任何异常都包成 `{status:"FAILED"}` **HTTP 200**,
    // 一次成员表抖动就会把"越权判定失败"显示成"查询失败",既误导又掩盖真实拒绝原因。
    let role: unknown = null;
    try {
      role = await resolveRole(identity, handle.projectId);
    } catch (err) {
      console.error("[query-handle] 项目成员判定失败(按 fail-closed 拒绝):", err);
      return apiError("权限校验失败，请稍后重试", 503, { code: "UPSTREAM_ERROR" });
    }
    if (!role) return apiError("无权访问该查询结果", 403, { code: "RBAC_DENIED" });
  }
  return { ok: true, handle, identity };
}

// 🔴 已删除 `resolveSubmitContext()`(2026-08-29 外部审核 P0-2)。
//
// 它只做"认证 + 读 `x-bgp-project` header",**不做授权** —— 提交点用它就等于:任一登录用户
// 自称任意 project 都能以共享 admin 身份执行 SQL/DDL,随后作为 handle owner 合法取回结果。
// 那样 queryHandle 只保护了"怎么取结果",没保护"谁能让 SQL 跑起来"。
// ⇒ 提交点一律直接用 `requireProject(req, "editor")`(52 SPEC:67-68 合同),不要再造这层薄封装:
// 它的存在本身就是个陷阱,看着像上下文解析、实际把"header 自称"当成了授权依据。
