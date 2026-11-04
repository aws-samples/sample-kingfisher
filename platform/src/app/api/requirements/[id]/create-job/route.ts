export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, getActiveEnv } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { snapshotVersion } from "@/lib/versions/version-service";
import { pushSqlLineageToOpenMetadata } from "@/lib/openmetadata/om-push";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
import { parseSqlLineage } from "@/lib/lineage/sql-lineage";
import { availableActions, getRequirement, isAssignee, linkEtlJob } from "@/lib/requirements/service";
// @kf-batch 50-WP31-place-first-class(B-36)
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { assertBindableTargetsForEngine, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { targetOfStamp } from "@/lib/exec-env/target-id";

const USER_ID = "default-user"; // 与 ETL 作业模块一致的物理分区键（租户在 projectId）。

// POST /api/requirements/[id]/create-job — 研发由生成的实现一键创建 ETL 作业（资源收口研发侧）。
// 仅被指派的研发，且须为项目 editor（与 ETL 作业模块创建权限一致）。作业创建后纳入既有
// 运行/调度/版本/血缘管控，绝不在此自动执行。
// Body: { name?: string }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  // 创建 ETL 作业需要 editor（与 /api/etl-jobs 一致）——确保资源创建权限受控。
  const ctx = await requireProject(req, "editor", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  if (!isAssignee(r, ctx.identity)) return apiError("仅被指派的研发可创建作业", 403);
  const code = r.implementation?.generatedCode;
  const targetType = r.implementation?.targetType || "redshift";
  if (!code) return apiError("请先生成实现代码再创建作业", 409);

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || `需求-${r.title}`).slice(0, 120);
  // @kf-batch 50-WP31-place-first-class(B-36)—— 🔴 绑定区必须点名,且走与 `/api/etl-jobs` **同一套**绑定校验
  //   (准入 / 组件 / 项目白名单 / Glue 只许主控区)。原来直写 DDB、不带区、工作组写死主控区 ⇒ 需求建出的作业永远是主控区的。
  //   并且绑定区必须含「这份代码是按哪个区生成的」:否则 = 按 A 区的表生成、却建成 B 区作业(表在 B 区根本不存在)。
  let boundTargets: string[];
  try {
    boundTargets = await assertBindableTargetsForEngine(targetType, requestedTargets(body, "需求创建作业"), "redshift", {
      scope: "per-project", // @kf-batch 50-WP11b-shared-writer —— scope 必填(无默认值)
      projectId: r.projectId,
    });
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
  }
  // 存量实现没有章 = 当年按主控区生成的(历史事实,唯一作者 targetOfStamp)
  const grounded = targetOfStamp(r.implementation?.groundedTargetId);
  if (!boundTargets.includes(grounded)) {
    return apiError(
      `这份实现是按执行环境 ${grounded} 的目录生成的,要建到 ${boundTargets.join(", ")} 请先切到该区视角重新生成(表结构按区不同)`,
      409,
      { code: "CONFLICT", detail: { groundedTargetId: grounded, targets: boundTargets } }
    );
  }
  // 从生成 SQL 解析结果表名（仅 redshift），供 GenBI 固化复用。
  let targetTable: string | undefined;
  if (targetType === "redshift") {
    try {
      const parsed = parseSqlLineage(code, { database: process.env.REDSHIFT_DATABASE || "dev" });
      const t = parsed.targets?.[parsed.targets.length - 1];
      if (t?.table) targetTable = t.table;
    } catch {
      /* best-effort */
    }
  }
  const now = new Date().toISOString();
  const jobId = ulid();
  const lineageId = ulid();
  const item: Record<string, any> = {
    userId: USER_ID,
    jobId,
    name,
    type: targetType,
    script: code,
    projectId: r.projectId,
    env: getActiveEnv(req),
    lineageId,
    requirementId: r.requirementId, // 作业↔需求双向关联
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    targets: boundTargets,
    // 🔴 不再预填 `redshiftConfig`(原来写死主控区工作组):与 /etl-jobs 页新建的作业同形,运行时按各绑定区的描述符解析
    //   (把主控区工作组写给别区的作业 ⇒ 绑定解析「落点冲突」当场拒,而且那个名字在别区根本不存在)。
  };

  try {
    await docClient.send(new PutCommand({ TableName: TABLES.ETL_JOBS, Item: item }));
    await snapshotVersion("etl-job", jobId, item, ctx.identity.username, "由需求生成创建").catch(() => {});
    if (targetType === "redshift" && code) {
      pushSqlLineageToOpenMetadata({
        sql: code,
        database: item.redshiftConfig?.database,
        pipeline: { resourceType: "etl-job", id: jobId, name },
      }).catch(() => {});
      recordComputeLineage({ sql: code, database: item.redshiftConfig?.database, taskId: jobId, engine: "etl-redshift" }).catch(() => {});
    }
    const updated = await linkEtlJob(r, ctx.identity, jobId, name, targetTable);
    recordAudit(req, "requirement.create-job", {
      resourceType: "etl-job",
      resourceId: jobId,
      detail: { requirementId: r.requirementId, type: targetType, name },
    }).catch(() => {});
    return apiOk({
      etlJobId: jobId,
      name,
      requirement: { ...updated, _actions: availableActions(updated, ctx.identity) },
    }, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
