export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listMasters } from "@/lib/incidents/store";
import { toExportRow } from "@/lib/incidents/health";

// GET /api/incidents/export?format=jsonl — 脱敏导出(DataOps-Bench 原料,§8 契约)。RBAC: admin(owner)。
// 每行只含脱敏元数据:{signature, symptomTemplate(已归一化), taskType, engine, rootCauseCategory,
// resolutionKind, mttrSec}。绝不含客户标识/真实表名/日志原文。
export async function GET(req: NextRequest, ) {
  // 导出为高敏动作 → 要求项目 owner(平台最高项目角色,对齐设计"admin")。
  const ctx = await requireProject(req, "owner");
  if (ctx instanceof NextResponse) return ctx;
  const format = (req.nextUrl.searchParams.get("format") || "jsonl").toLowerCase();
  try {
    const masters = await listMasters(ctx.projectId);
    const rows = masters.map(toExportRow);
    recordAudit(req, "incident.export", { resourceType: "incident", detail: { count: rows.length, format } }).catch(() => {});

    if (format === "json") {
      return new NextResponse(JSON.stringify(rows, null, 2), {
        status: 200,
        headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="incidents-export.json"' },
      });
    }
    // 默认 JSONL(每行一个 JSON,DataOps-Bench 场景集友好)。
    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
    return new NextResponse(jsonl, {
      status: 200,
      headers: { "content-type": "application/x-ndjson", "content-disposition": 'attachment; filename="incidents-export.jsonl"' },
    });
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}
