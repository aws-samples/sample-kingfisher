export const dynamic = "force-dynamic";
// (问数 · CAP-GENBI)
// GET  /api/genbi/cards/[cardId]/schedule   这张卡的定时刷新(没有 ⇒ null)
// POST /api/genbi/cards/[cardId]/schedule   { cronExpression, enabled, turnIndex? } 建 / 改 / 启停
//   (用 POST 不用 PUT:运营分析账号在网关层只放行 /api/genbi 的 GET/POST,它们也要能给自己的卡定时)
//
// 🔴 只有卡片作者能配;再要求卡片归属项目的 viewer。载体发到**卡片自己那个区**的 MWAA Serverless。
import { NextRequest, NextResponse } from "next/server";
import { requireIdentity } from "@/lib/auth/identity";
import { requireProject } from "@/lib/projects/guard";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { getCardPointer } from "@/lib/genbi/cards-store";
import { configureCardSchedule, getCardSchedule } from "@/lib/genbi/cards-schedule";
import { isCarrierArmed } from "@/lib/scheduler/action-schedules";
import { CardNotFound } from "@/lib/genbi/cards-service";
import { cardsError } from "@/lib/genbi/cards-http";

async function gate(req: NextRequest, cardId: string) {
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  const pointer = await getCardPointer(who.sub, cardId);
  if (!pointer) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
  const pctx = await requireProject(req, "viewer", pointer.projectId);
  if (pctx instanceof NextResponse) return pctx;
  return { identity: pctx.identity, pointer };
}

export async function GET(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const g = await gate(req, params.cardId);
  if (g instanceof Response) return g;
  try {
    const row = await getCardSchedule(params.cardId);
    return apiOk(row ? { ...row, armed: isCarrierArmed(row) } : null);
  } catch (e) {
    return cardsError(e);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const g = await gate(req, params.cardId);
  if (g instanceof Response) return g;
  const body = (await req.json().catch(() => ({}))) as { cronExpression?: unknown; enabled?: unknown; turnIndex?: unknown };
  const cron = typeof body.cronExpression === "string" && body.cronExpression.trim() ? body.cronExpression.trim() : null;
  if (body.enabled === true && !cron) return apiError("启用定时刷新必须给 cronExpression", 400, { code: "VALIDATION_FAILED" });
  try {
    const r = await configureCardSchedule(g.identity, params.cardId, {
      cronExpression: cron,
      enabled: body.enabled === true,
      ...(Number.isInteger(body.turnIndex) ? { turnIndex: body.turnIndex as number } : {}),
    });
    recordAudit(req, r.scheduleEnabled ? "genbi.card.schedule.enable" : "genbi.card.schedule.update", {
      resourceType: "genbi-card",
      resourceId: params.cardId,
      targetId: g.pointer.targetId,
      detail: { cronExpression: r.cronExpression, enabled: r.scheduleEnabled },
    }).catch(() => {});
    return apiOk({ ...r, armed: isCarrierArmed(r) });
  } catch (e) {
    if (e instanceof CardNotFound) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
    return cardsError(e);
  }
}
