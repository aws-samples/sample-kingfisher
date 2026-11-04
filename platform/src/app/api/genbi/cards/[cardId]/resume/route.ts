export const dynamic = "force-dynamic";

// POST /api/genbi/cards/[cardId]/resume —— 打开续聊(54 DESIGN v1.3 §5.5)
//
// 做的事:用卡片正文**覆盖式重建**这段对话的短期记忆,并回「该切到哪个 target」。
// 🔴 本接口**不改执行范围** —— 切区是页面按 50 INTERACTION v2.30 §9.7(护栏 7)征得用户同意后自己做的。
//    用户选「只读查看」时**根本不会调本接口**(§9.7 第 6 条:拒绝切区零副作用)。
import { requireIdentity } from "@/lib/auth/identity";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { CardNotFound, resumeCard } from "@/lib/genbi/cards-service";
import { cardsError } from "@/lib/genbi/cards-http";

export async function POST(req: NextRequest, props: { params: Promise<{ cardId: string }> }) {
  const params = await props.params;
  const identity = await requireIdentity(req);
  if (identity instanceof Response) return identity;
  try {
    const r = await resumeCard(identity.sub, params.cardId, identity);
    return apiOk(r);
  } catch (e) {
    if (e instanceof CardNotFound) return apiError("卡片不存在", 404, { code: "NOT_FOUND" });
    return cardsError(e);
  }
}
