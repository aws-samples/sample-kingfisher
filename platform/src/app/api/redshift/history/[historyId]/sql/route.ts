export const dynamic = "force-dynamic";
// GET /api/redshift/history/[historyId]/sql —— 按需读回**留在区域**的 SQL 原文。
//
// 中央 `bgp-sql-history` 对跨法域 target 的行只存指针 `{residency:"region", sqlRef}`;原文在该 target 所在 region 的区域结果表。
// 读原文本身也是一次跨法域数据操作 ⇒ 先同意前置(409 带文案)再写区域审计(entry=history),写不成即拒(503)。
// home / 同法域行:直接回中央行上的 sql(与历史页表格里显示的同一份),不碰任何区域客户端。
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { LEGACY_PARTITION } from "@/lib/auth/identity";
import { guardResourceAccess } from "@/lib/projects/guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { jurisdictionOf } from "@/lib/exec-env/residency";
import { getRegionSqlHistory } from "@/lib/exec-env/residency-store";
import { residencyAudit, residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";

const TABLE = "bgp-sql-history";

export async function GET(req: NextRequest, props: { params: Promise<{ historyId: string }> }) {
  const params = await props.params;
  const historyId = String(params.historyId || "");
  if (!/^[0-9A-Z]{26}$/.test(historyId)) return apiError(`非法 historyId:${JSON.stringify(params.historyId)}`, 400, { code: "VALIDATION_FAILED" });
  const { Item: row } = await docClient.send(new GetCommand({ TableName: TABLE, Key: { userId: LEGACY_PARTITION, historyId } }));
  if (!row) return apiError("历史记录不存在", 404, { code: "NOT_FOUND" });
  // 归属:与历史列表同一口径(项目内共享;默认工作区兼容无 projectId 的存量行)
  const ctx = await guardResourceAccess(req, row as { projectId?: string }, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  if (row.residency !== "region") {
    return apiOk({ historyId, targetId: row.targetId ?? "tgt_home", residency: "central", sql: row.sql ?? "" });
  }
  const targetId = String(row.targetId ?? "");
  const sqlRef = String(row.sqlRef ?? "");
  if (!targetId || !sqlRef) return apiError("该历史行的留区指针不完整(缺 targetId / sqlRef),无法读回原文", 500, { code: "INTERNAL" });
  const t = await getTargetRaw(targetId);
  if (!t) return apiError(`执行目标不存在:${targetId}(原文仍留在其区域表,目标注册表里已无该描述符)`, 404, { code: "NOT_FOUND" });

  let auditId: string | undefined;
  try {
    const a = await residencyAudit({ actor: userActor(ctx.identity), targetId, entry: "history", projectId: ctx.projectId });
    auditId = a?.auditId;
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }
  let rec;
  try {
    rec = await getRegionSqlHistory(t, String(row.projectId ?? ctx.projectId), sqlRef);
  } catch (e) {
    return apiError(`读取区域结果表失败:${String((e as Error)?.message ?? e)}`, 503, { code: "UPSTREAM_ERROR" });
  }
  if (!rec) return apiError("区域结果表里没有这条原文(可能已按该区的保留策略清理)", 404, { code: "NOT_FOUND" });
  return apiOk({
    historyId,
    targetId,
    jurisdiction: jurisdictionOf(t),
    region: t.region,
    residency: "region",
    sql: rec.sqlText,
    ...(auditId ? { auditId } : {}),
  });
}
