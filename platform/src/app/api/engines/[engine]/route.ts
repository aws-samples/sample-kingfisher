export const dynamic = "force-dynamic";

// 模块 33-A — 离线多引擎统一路由（动态段 [engine] → 一套路由多引擎，SPI 分派）。
// 执行层完全独立于 api/etl-jobs·api/sync；老代码零改动。

import { NextRequest, NextResponse } from "next/server";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
import { isEngineType, getProvider } from "@/lib/engines/registry";
import { EMR_SPEC_DEFAULT } from "@/lib/engines/emr/spec";
import { EMR_NETWORK_EMPTY } from "@/lib/engines/emr/network";
import { ulid } from "ulid";
// @kf-batch 50-P50.3-engines
import { assertBindableTargetsForEngine, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
// @kf-batch 50-WP4-o1-scope
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
// @kf-batch 50-WP31-place-first-class
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

const USER_ID = "default-user";

// GET /api/engines/[engine] —— 列表（项目 + 环境 + 引擎过滤 + 读时对账）。
export async function GET(req: NextRequest, props: { params: Promise<{ engine: string }> }) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  try {
    const ctx = await requireProject(req, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    // @kf-batch 50-WP4-o1-scope —— 执行范围(50 SPEC §2.6);与 `/api/etl-jobs` 同一条路(同一页混排)。
    const scope = await requireScope(req, ctx.projectId);
    if (scope instanceof NextResponse) return scope;
    const pf = projectFilter(ctx.projectId);
    const ef = envFilter(getActiveEnv(req));
    const { Items = [] } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.ENGINE_JOBS,
        FilterExpression: `userId = :uid AND engine = :eng AND ${pf.clause} AND ${ef.clause}`,
        ExpressionAttributeNames: { "#env": "env" },
        ExpressionAttributeValues: { ":uid": USER_ID, ":eng": params.engine, ...pf.values, ...ef.values },
      })
    );
    // 读时对账：对卡在 running 的作业查真实 EMR 状态并回写，杜绝列表假 running。
    const provider = getProvider(params.engine);
    const reconciled = await Promise.all(Items.map((it: any) => provider.reconcile(it).catch(() => it)));
    // @kf-batch 50-WP4-o1-scope —— 在对账**之后**过滤(理由同 `/api/etl-jobs`:不改副作用)。
    return apiOk(filterRowsByScope(reconciled as Array<Record<string, unknown>>, scope));
  } catch (e: any) {
    return apiError(e.message, 500, { code: "INTERNAL" });
  }
}

// POST /api/engines/[engine] —— 创建作业 + per-作业 application（拍板④⑤：不共享，动态建）。
export async function POST(req: NextRequest, props: { params: Promise<{ engine: string }> }) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return apiError("缺少 name", 400, { code: "VALIDATION_FAILED" });

  // @kf-batch 50-P50.3-engines
  // 🔴 `targets` **必须连校验一起进**:它决定"这个 Spark 作业在哪个区跑"。
  // 客户端塞任何 targetId 都会被 `{...body}` 原样落库(与 etl-jobs 同一个坑),
  // 而落库那一刻不报错、下次运行才发作(还可能在一个没准备好的区建 application)。
  // @kf-batch 50-WP31-place-first-class —— 🔴 绑定区必须点名(缺 ⇒ 400)。原来两个字段都没给就**跳过校验**、
  //   作业行不带 targets(读侧 = 主控区)⇒ /etl-jobs 页在 us-west-2 视角新建的 EMR 作业在主控区建 application
  //   并从当前视角消失(段 wp31 W31-E1/E2 无头坐实)。
  try {
    body.targets = await assertBindableTargetsForEngine(
      params.engine,
      requestedTargets(body, "新建引擎作业"),
      "core",
      { scope: "per-project", projectId: ctx.projectId } // @kf-batch 50-W5-seg1-WP10a 项目白名单(WP-11b:scope 必填)
    );
    delete body.targetId; // 只保留一个真值源
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
  }

  const now = new Date().toISOString();
  const jobId = ulid();
  const item: any = {
    // EMR 默认字段（前端可覆盖）。
    script: "",
    spec: EMR_SPEC_DEFAULT,
    network: EMR_NETWORK_EMPTY,
    ...body,
    engine: params.engine,
    userId: USER_ID,
    jobId,
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  try {
    // per-作业 application：创建时就建好（连接信息已在 body.network 前置填清）。best-effort：
    // application 建失败不阻断作业创建（作业先存 draft，run 时 ensureResource 会重试）。
    try {
      const provider = getProvider(params.engine);
      // @kf-batch 50-WP31-place-first-class —— B-30:每个绑定区各建一个;主控区仍写老字段 applicationId(存量零迁移),
      //   其余进 applicationIdByTarget(与 provider.persistApplicationId 同一形状)
      const { applicationFields } = await import("@/lib/engines/emr/application");
      Object.assign(item, applicationFields(await provider.ensureResource(item)));
      item.status = "ready";
    } catch (e: any) {
      item.applicationCreateError = String(e?.message || e).slice(0, 300);
    }
    await docClient.send(new PutCommand({ TableName: TABLES.ENGINE_JOBS, Item: item }));
    recordAudit(req, `engine.${params.engine}.create`, {
      resourceType: "engine-job",
      resourceId: jobId,
      detail: { name: item.name, engine: params.engine, applicationId: item.applicationId || null },
    }).catch(() => {});
    return apiOk(item, 201);
  } catch (e: any) {
    return apiError(e.message, 500, { code: "INTERNAL" });
  }
}
