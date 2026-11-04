export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { readFlinkResults, readMysqlResults, readS3TableResults, flinkJobTarget } from "@/lib/realtime/flink-service";

const USER_ID = "default-user";

// GET /api/flink/jobs/[id]/results — 按需读取 sink 结果(供详情页"查询结果"无头核验)。
// S3 Tables 经 Athena 联邦目录查询(单次,不进 10s 状态轮询,避免 Athena 频繁扫描)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  try {
    // 统一契约 { table, columns, rows } —— 前端按真实列动态渲染(模式无关,兼容窗口聚合/CDC/自定义 sink)。
    let out: { table: string; columns: string[]; rows: Record<string, any>[] };
    if (job.sinkType === "s3table") {
      out = await readS3TableResults(job.sql, 200, flinkJobTarget(job));
    } else if (job.sinkType === "mysql") {
      out = await readMysqlResults(job.sinkDatasourceId, job.sql, 200);
    } else {
      // S3 数据湖裸文件(JSON 行):从首行键推导列。
      const rows = await readFlinkResults(params.id, 200, flinkJobTarget(job));
      const columns = rows.length ? Object.keys(rows[0]) : [];
      out = { table: "", columns, rows };
    }
    // 兼容旧前端:results 仍返回行数组;新增 table/columns 供动态渲染与真实表名标签。
    return apiOk({ jobId: params.id, sinkType: job.sinkType || "s3", table: out.table, columns: out.columns, resultCount: out.rows.length, results: out.rows });
  } catch (e: any) {
    return apiError(String(e?.message || e), 500);
  }
}
