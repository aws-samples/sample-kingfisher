export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
// @kf-batch 50-P50.3-dataplane
import { assertBindableTargetsForEngine, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { recordAudit } from "@/lib/audit";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
// @kf-batch 50-WP4-o1-scope
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
import { snapshotVersion } from "@/lib/versions/version-service";
import { pushSqlLineageToOpenMetadata } from "@/lib/openmetadata/om-push";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
import { reconcileEtlJob } from "@/lib/etl/job-service";
// @kf-batch 50-WP31-place-first-class
import { requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// 序 72 B-139(模块 56):自定义执行角色保存期预检
import { preflightCustomRoleForTargets } from "@/lib/execution-role/preflight";
import { s3UrisFromGlueConfig } from "@/lib/execution-role/s3-uris";
import { ulid } from "ulid";

const USER_ID = "default-user";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireProject(req, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    // @kf-batch 50-WP4-o1-scope —— 执行范围(50 SPEC §2.6)。🔴 只认 URL 的 `?scope=`;
    // 非法/不存在/无权/不可承接一律 4xx,**绝不回落 home 或 global**。
    const scope = await requireScope(req, ctx.projectId);
    if (scope instanceof NextResponse) return scope;
    const pf = projectFilter(ctx.projectId);
    const ef = envFilter(getActiveEnv(req));
    const { Items = [] } = await docClient.send(
      new ScanCommand({
        TableName: TABLES.ETL_JOBS,
        FilterExpression: `userId = :uid AND ${pf.clause} AND ${ef.clause}`,
        ExpressionAttributeNames: { "#env": "env" },
        ExpressionAttributeValues: { ":uid": USER_ID, ...pf.values, ...ef.values },
      })
    );
    // 读时对账:对卡在 running 的作业查真实 Glue/Redshift 状态并回写,杜绝列表假 running。
    const reconciled = await Promise.all(Items.map((it: any) => reconcileEtlJob(it).catch(() => it)));
    // @kf-batch 50-WP4-o1-scope —— 🔴 **在对账之后**过滤,不在之前:
    // 对账会回写卡住的 running 状态,提前过滤会让「别的区那几条」在本次请求里不被对账 ——
    // 那是把一个纯展示改动变成了副作用改动(A3:缺省 global 下必须与改前逐字节等价)。
    // B 类资源(绑定列表)只许内存过滤,经 `bindingTargets` 的三级回落 —— 见 SPEC §2.6.4。
    return apiOk(filterRowsByScope(reconciled as Array<Record<string, unknown>>, scope));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json();
  if (!body?.name || !body?.type) return apiError("缺少 name 或 type");
  if (!["glue", "redshift"].includes(body.type)) return apiError("type 必须是 glue 或 redshift");
  // @kf-batch 50-P50.3-dataplane
  // 🔴 **必须显式校验 `targetId`**:下面是 `{ ...body }` 展开 ⇒ 不校验就等于客户端可随意指定
  // "这个作业的 SQL 打到哪个区域的数仓" —— 绕过准入(ready/新鲜度)与跨法域门,
  // 而且**落库那一刻不报错、下次运行才发作**。归一后写回 item(不用 body 里那个)。
  // @kf-batch 50-P50.3-multibind —— 合同是 `targets?: string[]`(SPEC §1.3a-S1)。
  // 仍收 `targetId` 作为**单值入口**(W3-a 的形态、也方便脚本/API 直接用),但**归一后只写 `targets`**:
  // 两个字段同时可写就会有两个说法。
  let boundTargets: string[];
  try {
    // @kf-batch 50-P50.3-fanout —— 判据按**引擎**分:Glue 本期只许 home(理由见该函数注释:
    // 放它绑非 home 会让「定时与手动两条路径算出不同的锁属性名」⇒ 互斥失效、偶发撞 OID)。
    // @kf-batch 50-WP31-place-first-class —— 🔴 绑定区必须点名(缺 ⇒ 400),不再「没给 = 主控区」
    boundTargets = await assertBindableTargetsForEngine(
      String(body.type),
      requestedTargets(body, "新建 ETL 作业"),
      "redshift",
      { scope: "per-project", projectId: ctx.projectId } // @kf-batch 50-W5-seg1-WP10a 项目白名单(WP-11b:scope 必填)
    );
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
  }
  // 序 72 B-139:自定义执行角色在保存那一刻就按每个绑定区预检(信任 glue.amazonaws.com + 引擎基线 + --extra-jars /
  //   --extra-py-files / 脚本 s3:// 引用的每个对象),缺 ⇒ 400 逐条指路、**不落库**(客户现网 2026-11-03:保存成功、Glue 启动期才 403)
  if (body.type === "glue") {
    const pfRes = await preflightCustomRoleForTargets({
      engine: "glue",
      customRoleArn: body.glueConfig?.executionRoleArn,
      targets: [...boundTargets],
      extraS3Uris: s3UrisFromGlueConfig(body.glueConfig),
      scriptCode: typeof body.script === "string" ? body.script : undefined,
    });
    if (pfRes) return pfRes;
  }
  const now = new Date().toISOString();
  const item = {
    script: "",
    ...body,
    // 🔴 在展开**之后**,覆盖客户端给的值(展开之前会被 body 里的原值盖回去,校验就白做了)
    targets: boundTargets,
    targetId: undefined, // 只保留一个真值源:写入侧不再写单值字段
    userId: USER_ID,
    jobId: ulid(),
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  try {
    await docClient.send(new PutCommand({ TableName: TABLES.ETL_JOBS, Item: item }));
    await snapshotVersion("etl-job", item.jobId, item, ctx.identity.username, "创建").catch(() => {});
    // 模块 17: auto-parse SQL → table-level lineage in OpenMetadata (best-effort).
    // + 计算血缘:并排写平台血缘表 bgp-lineage(OM 未配置时治理页仍可见此计算产出的血缘)。
    if (item.type === "redshift" && item.script) {
      pushSqlLineageToOpenMetadata({
        sql: item.script,
        database: item.redshiftConfig?.database,
        pipeline: { resourceType: "etl-job", id: item.jobId, name: item.name },
      }).catch(() => {});
      recordComputeLineage({
        sql: item.script,
        database: item.redshiftConfig?.database,
        taskId: item.jobId,
        engine: "etl-redshift",
      }).catch(() => {});
    }
    recordAudit(req, "etl-job.create", {
      resourceType: "etl-job",
      resourceId: item.jobId,
      detail: { name: item.name, type: item.type },
    }).catch(() => {});
    return apiOk(item, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
