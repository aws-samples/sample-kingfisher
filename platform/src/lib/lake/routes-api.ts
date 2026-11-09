// 数据湖表桶路由—— 数据湖路由 HTTP 接口的**共用处理器**(设计稿 §6.10):
//   规范路径 /api/admin/lake-routes(GET 列 / POST 登记 / PATCH|PUT 修改 / DELETE 撤销);
//   兼容别名 /api/admin/lake-buckets 保留一个版本(D9:GET 回外部路由数组、POST 派生别名登记、DELETE 撤销),与规范路径同一份处理器。
// 规则:落点由**路由文件**经点名作者 requestedTargetId 解析后传进来(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE,不默认主控区;
//   落点棘轮 L5 与「服务端真读范围」判据都钉在 app/api 的路由文件上,所以解析必须写在那里,这里只收解析好的值);
//   任何登录用户可读;写要平台管理员(403 RBAC_DENIED);每次写都审计 lake.route.register / update / revoke(动作名唯一作者 LAKE_ROUTE_AUDIT);
//   拒因状态码 / code / detail 由 LakeRouteError 承载,这里只整形成平台信封。
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { placeErrorResponse } from "@/lib/place/route";
import { recordAudit } from "@/lib/audit";
import { lakeRouteErrorResponse } from "./job-declaration";
import {
  LAKE_ROUTE_AUDIT, LAKE_ROUTE_AUDIT_RESOURCE_TYPE, registerLakeRoute, resolveLakeRoutes, revokeLakeRoute, updateLakeRoute, type LakeRoute,
} from "./routes";

type Identity = NonNullable<Awaited<ReturnType<typeof resolveIdentity>>>;

async function requireSignedIn(req: NextRequest): Promise<Identity | Response> {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  return identity;
}

async function requireLakeAdmin(req: NextRequest): Promise<Identity | Response> {
  const identity = await requireSignedIn(req);
  if (identity instanceof Response) return identity;
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员(bgp-admin)可登记 / 修改 / 撤销数据湖表桶路由", 403, { code: "RBAC_DENIED" });
  return identity;
}

/** 路由文件用:点名作者抛的落点错 ⇒ 400 响应(PLACE_UNDECIDABLE 等 code 原样);别的错也 400。 */
export function placeReject(e: unknown): Response {
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  return apiError(String((e as Error)?.message || e), 400, { code: "VALIDATION_FAILED" });
}

function reject(e: unknown): Response {
  const lr = lakeRouteErrorResponse(e);
  if (lr) return lr;
  const pr = placeErrorResponse(e);
  if (pr) return pr;
  return apiError(String((e as Error)?.message || e), 500, { code: "UPSTREAM_ERROR" });
}

/** 接口里的一条路由(不带 bucketArn:页面不需要 ARN,也不该让人去抄 ARN)。 */
export function routeView(r: LakeRoute) {
  const { bucketArn: _arn, ...rest } = r;
  return rest;
}

/** 路由文件用:请求体 ⇒ 对象(非 JSON / 非对象 ⇒ 空对象)。 */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

function auditDetail(route: LakeRoute) {
  return { targetId: route.targetId, region: route.region, alias: route.alias, tier: route.tier, writable: route.writable, ...(route.namespaces ? { namespaces: route.namespaces } : {}) };
}

// ── GET ────────────────────────────────────────────────────────────────────────────────────
/** 规范:{ targetId, region, home, fetchedAt, routes[] }(含隐式平台路由)。 */
export async function handleListRoutes(req: NextRequest, tid: string): Promise<Response> {
  const identity = await requireSignedIn(req);
  if (identity instanceof Response) return identity;
  try {
    const set = await resolveLakeRoutes(tid, { fresh: true });
    return apiOk({ targetId: set.targetId, region: set.region, home: set.home, fetchedAt: set.fetchedAt, routes: set.all.map(routeView) });
  } catch (e) {
    return reject(e);
  }
}

/** 兼容:外部路由数组(新字段一起带;不含隐式平台路由 —— 与改动前同形)。 */
export async function handleListExternalBuckets(req: NextRequest, tid: string): Promise<Response> {
  const identity = await requireSignedIn(req);
  if (identity instanceof Response) return identity;
  try {
    const set = await resolveLakeRoutes(tid, { fresh: true });
    return apiOk(set.external.map(routeView));
  } catch (e) {
    return reject(e);
  }
}

// ── POST ───────────────────────────────────────────────────────────────────────────────────
export async function handleRegisterRoute(req: NextRequest, args: { tid: string; body: Record<string, unknown>; compat?: boolean }): Promise<Response> {
  const admin = await requireLakeAdmin(req);
  if (admin instanceof Response) return admin;
  const { tid, body } = args;
  try {
    const route = await registerLakeRoute({
      targetId: tid, bucket: body.bucket, label: body.label, addedBy: admin.username,
      // 兼容别名只收桶 / 备注(别名派生、分层 other、可写);规范路径收全套
      ...(args.compat ? {} : { alias: body.alias, tier: body.tier, writable: body.writable, namespaces: body.namespaces }),
    });
    recordAudit(req, LAKE_ROUTE_AUDIT.register, { resourceType: LAKE_ROUTE_AUDIT_RESOURCE_TYPE, resourceId: route.bucket, targetId: route.targetId, detail: auditDetail(route) }).catch(() => {});
    return apiOk(routeView(route), 201);
  } catch (e) {
    return reject(e);
  }
}

// ── PATCH / PUT ────────────────────────────────────────────────────────────────────────────
export async function handleUpdateRoute(req: NextRequest, args: { tid: string; body: Record<string, unknown> }): Promise<Response> {
  const admin = await requireLakeAdmin(req);
  if (admin instanceof Response) return admin;
  const { tid, body } = args;
  try {
    const before = (await resolveLakeRoutes(tid, { fresh: true })).external.find((r) => r.bucket === body.bucket);
    const route = await updateLakeRoute({
      targetId: tid, bucket: body.bucket, alias: body.alias, tier: body.tier, writable: body.writable, namespaces: body.namespaces, label: body.label,
      confirmAliasChange: body.confirmAliasChange === true, updatedBy: admin.username,
    });
    recordAudit(req, LAKE_ROUTE_AUDIT.update, {
      resourceType: LAKE_ROUTE_AUDIT_RESOURCE_TYPE, resourceId: route.bucket, targetId: route.targetId,
      detail: { ...auditDetail(route), before: before ? auditDetail(before) : null, after: auditDetail(route) },
    }).catch(() => {});
    return apiOk(routeView(route));
  } catch (e) {
    return reject(e);
  }
}

// ── DELETE ─────────────────────────────────────────────────────────────────────────────────
export async function handleRevokeRoute(req: NextRequest, args: { tid: string; bucket: string | null }): Promise<Response> {
  const admin = await requireLakeAdmin(req);
  if (admin instanceof Response) return admin;
  const { tid, bucket } = args;
  try {
    const removed = await revokeLakeRoute(tid, bucket);
    if (!removed) return apiError("这个表桶没有在该执行环境登记为路由", 404, { code: "NOT_FOUND" });
    recordAudit(req, LAKE_ROUTE_AUDIT.revoke, { resourceType: LAKE_ROUTE_AUDIT_RESOURCE_TYPE, resourceId: String(bucket), targetId: tid, detail: { targetId: tid } }).catch(() => {});
    return apiOk({ removed: true });
  } catch (e) {
    return reject(e);
  }
}
