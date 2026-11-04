export const dynamic = "force-dynamic";

// @kf-batch 50-WP5-rungroup
// GET —— 这个定义最近的几次**多区联动运行**(50 SPEC v3.44 §2.7)。
// 🔴 走 GSI `byDefinition`,**不 Scan**(Scan 在多组之后只回首页且不报错 = 静默漏数)。
// 🔴 **单区运行不成组** ⇒ 不会出现在这里(运行历史照旧一行,E-166)。
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { listRunGroupViewsByDefinition } from "@/lib/monitor/run-groups";

const USER_ID = "default-user";
const MAX_LIMIT = 100;

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("资源不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;

  const raw = Number(req.nextUrl.searchParams.get("limit") ?? 20);
  // 🔴 非法/超界一律**收敛到边界**而不是静默用默认值(默认值静默生效那一类缺陷本仓已犯过很多次)
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : 20;
  try {
    return apiOk({ items: await listRunGroupViewsByDefinition(params.id, limit), limit });
  } catch (e) {
    return apiError(`读取联动运行列表失败:${e instanceof Error ? e.message : String(e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
