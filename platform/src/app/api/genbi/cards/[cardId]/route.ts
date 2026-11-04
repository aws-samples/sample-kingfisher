export const dynamic = "force-dynamic";

// GET    /api/genbi/cards/[cardId]  取正文(打开;54 DESIGN v1.3 §5.3)
// DELETE /api/genbi/cards/[cardId]  删卡(两段式,§5.4 / §7.3)
//
// 🔴 越权一律 **404**,不是 403 —— 403 会泄露「这个 cardId 存在」。
import { requireIdentity } from "@/lib/auth/identity";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { CardNotFound, deleteCard, openCard } from "@/lib/genbi/cards-service";
import { cardsError } from "@/lib/genbi/cards-http";
// 删卡前先撤这张卡的定时刷新(撤不下来 ⇒ 卡片不删)
import { removeCardSchedule } from "@/lib/genbi/cards-schedule";
import { getCardPointer } from "@/lib/genbi/cards-store";

export async function GET(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const identity = await requireIdentity(req);
  if (identity instanceof Response) return identity;
  try {
    const r = await openCard(identity.sub, params.cardId, identity);
    return apiOk({
      pointer: r.pointer,
      body: r.body,
      // 这次打开**按当前分级**新隐去的列 ⇒ 页面要说明「这几列现在按数据分级隐去了」,
      // 而不是让用户以为卡片存坏了(卡片不是绕过分级的后门)。
      maskedNow: r.maskedNow,
      bodyMissing: r.bodyMissing,
    });
  } catch (e) {
    if (e instanceof CardNotFound) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
    return cardsError(e);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  try {
    // 🔴 先撤定时载体:顺序反了 = 卡片没了,而那个区的 workflow 还在按 cron 刷一张不存在的卡(每次都失败、每次都计费)。
    //    只有卡片作者本人的卡才撤(别人的 cardId 不存在于他名下 ⇒ 下面 deleteCard 照旧 404)。
    if (await getCardPointer(who.sub, params.cardId)) await removeCardSchedule(params.cardId);
    const r = await deleteCard(who.sub, params.cardId);
    if (r.bodyOrphaned) {
      // 🔴 终态孤儿必须**留痕给能处置的人**(运维);只打日志会随日志过期而消失。
      recordAudit(req, "genbi.card.body-orphaned", {
        resourceType: "genbi-card",
        resourceId: params.cardId,
        targetId: r.bodyOrphaned.targetId,
        detail: { bucket: r.bodyOrphaned.bucket, key: r.bodyOrphaned.key, why: "执行环境已不在注册表,该区正文无法再清理" },
      }).catch(() => {});
    }
    return apiOk(r);
  } catch (e) {
    if (e instanceof CardNotFound) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
    return cardsError(e);
  }
}
