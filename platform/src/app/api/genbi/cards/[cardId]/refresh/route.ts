export const dynamic = "force-dynamic";
// (问数 · CAP-GENBI)
// POST /api/genbi/cards/[cardId]/refresh  { turnIndex? }  —— 「立即刷新」:重跑卡片里那条 SQL,刷新**同一张**卡并留一份快照。
//
// 🔴 与定时刷新**同一个作者** `refreshCardOnce`(白名单 genbi.card-refresh 的 author 就是它)。
// 🔴 权限:卡片作者本人(别人的 cardId 在他名下不存在 ⇒ 404,不泄露存在)+ 卡片归属项目的 viewer
//    (被移出项目的人不能再拿自己存过的卡去取数)。
import { NextRequest, NextResponse } from "next/server";
import { requireIdentity } from "@/lib/auth/identity";
import { requireProject } from "@/lib/projects/guard";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { getCardPointer } from "@/lib/genbi/cards-store";
import { refreshCardOnce } from "@/lib/genbi/cards-refresh";
import { CardNotFound } from "@/lib/genbi/cards-service";
import { cardsError } from "@/lib/genbi/cards-http";

export async function POST(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  const pointer = await getCardPointer(who.sub, params.cardId);
  if (!pointer) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
  const pctx = await requireProject(req, "viewer", pointer.projectId);
  if (pctx instanceof NextResponse) return pctx;
  const body = (await req.json().catch(() => ({}))) as { turnIndex?: unknown };
  const turnIndex = Number.isInteger(body.turnIndex) ? (body.turnIndex as number) : undefined;
  try {
    const r = await refreshCardOnce(who.sub, params.cardId, {
      triggeredBy: "manual",
      actor: { kind: "user", identity: pctx.identity },
      ...(turnIndex !== undefined ? { turnIndex } : {}),
    });
    recordAudit(req, "genbi.card.refresh", {
      resourceType: "genbi-card",
      resourceId: params.cardId,
      targetId: r.targetId,
      detail: { snapshotId: r.snapshotId, rowCount: r.rowCount, turnIndex: r.turnIndex, via: "manual" },
    }).catch(() => {});
    return apiOk(r);
  } catch (e) {
    if (e instanceof CardNotFound) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
    return cardsError(e);
  }
}
