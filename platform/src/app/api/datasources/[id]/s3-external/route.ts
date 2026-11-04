export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { isDataSourceType } from "@/lib/datasource-spi/registry";
import { getCorrelationId } from "@/lib/observability/logger";
// 模块 55 / 序 50 第二批:建外部表主体(introspect → 选数据集 / 列 → 三条 Athena DDL 经 awaitTerminal 等终态 → 审计)在 lib/datasource/long-ops.ts
//   (datasource-s3-external)。大桶 introspect + 三条 DDL 合计常超 60s 墙 ⇒ 超 45 秒由统一框架转 202,页面右下「正在后台执行:为 S3 数据源建 Athena 外部表」。
//   对象租约 `datasource:<id>`:建表进行中再编辑 / 删除这条源 ⇒ 409。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import type { SourceColumn } from "@/lib/datasource-spi/types";

const USER_ID = "default-user";

// 模块42 P42.4:为 S3 数据源建 Athena 外部表(分析通道)。
//  POST /api/datasources/[id]/s3-external { dataset?, columns? }
//  · 读该 S3 源 → introspect 拿"逻辑数据集"+推断列(CSV 采样;或用 body.columns 覆盖)
//  · CREATE DATABASE bgp_s3_ext + CREATE EXTERNAL TABLE ... LOCATION s3://bucket/prefix
//  · 返回可查表名(bgp_s3_ext.<table>),前端随后走数据湖直查接口查数据。
// RBAC:建外部表是写元数据操作(非只读),要 editor。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const { Item: ds } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
  );
  if (!ds) return apiError("数据源不存在", 404);
  if (ds.type !== "s3") return apiError("仅 S3 数据源支持建 Athena 外部表", 400);
  if (!isDataSourceType(ds.type)) return apiError(`不支持的数据源类型: ${ds.type}`, 400);

  const body = await req.json().catch(() => ({}));
  const conn = ds.connection || {};
  if (!conn.bucket) return apiError("S3 数据源缺少 bucket", 400);

  try {
    const result = await submitLongOp(
      {
        kind: "datasource-s3-external",
        params: {
          datasourceId: params.id,
          projectId: ctx.projectId,
          ...(typeof body?.dataset === "string" && body.dataset ? { dataset: body.dataset } : {}),
          ...(Array.isArray(body?.columns) && body.columns.length > 0 ? { columns: body.columns as SourceColumn[] } : {}),
        },
        correlationId: getCorrelationId(req),
      },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(`建外部表失败: ${String(e?.message || e).slice(0, 300)}`, 500);
  }
}
