export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { reconcileFlinkStatus, readFlinkResults, readMysqlResults, flinkJobTarget } from "@/lib/realtime/flink-service";

const USER_ID = "default-user";

// GET /api/flink/jobs/[id]/status — MSAF 应用状态 + S3 输出聚合结果(供详情页轮询/无头核验)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  // 读时对账(与列表同一套逻辑):查 MSAF 真实态→映射→回写。AWS 侧已删→deleted。
  const { dbStatus: mapped, appStatus } = await reconcileFlinkStatus(job);

  let results: any[] = [];
  let columns: string[] = [];
  try {
    if (job.sinkType === "mysql") {
      const r = await readMysqlResults(job.sinkDatasourceId, job.sql, 200);
      results = r.rows; columns = r.columns;
    } else if (job.sinkType === "s3table") {
      results = []; // S3 Tables 结果经 /results 端点按需用 Athena 查询,不进 10s 状态轮询
    } else {
      results = await readFlinkResults(params.id, 200, flinkJobTarget(job));
      columns = results.length ? Object.keys(results[0]) : [];
    }
  } catch { /* 输出未就绪 */ }

  return apiOk({
    jobId: params.id,
    appStatus,
    dbStatus: mapped,
    appName: job.appName || null,
    outputPath: job.outputPath || null,
    resultCount: results.length,
    columns,
    results,
  });
}
