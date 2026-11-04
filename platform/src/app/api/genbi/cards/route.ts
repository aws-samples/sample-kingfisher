export const dynamic = "force-dynamic";

// @kf-batch 54-genbi-session-cards
// POST /api/genbi/cards        保存 / 更新一段对话为卡片(54 DESIGN v1.3 §5.1)
// GET  /api/genbi/cards?scope= 我的卡片列表(§5.2)
//
// 🔴 列表**必须按 `?scope=` 过滤**(读路由口径,50 SPEC §2.6.3),并回 `hiddenByScope`:
//    「当前范围外还有几张」必须说出来 —— 静默少列就是护栏一(不丢东西)的反面。
import { requireIdentity } from "@/lib/auth/identity";
import { requireProject } from "@/lib/projects/guard";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { readScope, filterRowsByScalar } from "@/lib/exec-env/scope";
import { attachTitles, listCards, saveCard } from "@/lib/genbi/cards-service";
import { cardsError } from "@/lib/genbi/cards-http";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

export async function GET(req: NextRequest) {
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  const userSub = who.sub;
  const { items, used, limit } = await listCards(userSub);
  const scope = readScope(req);
  const shown = scope
    ? (filterRowsByScalar(items as unknown as Array<Record<string, unknown>>, scope, "genbiCard") as unknown as typeof items)
    : items;
  // 🔴 标题在**各自的区域**里(用户 2026-09-12 拍板「标题也留区」)⇒ 只对**当前范围内要显示的**那些去取:
  //    执行范围过滤天然把跨区读降到最小;读不到的行 `title:null + titleUnavailable:true`,**仍然列出**。
  const rows = await attachTitles(userSub, shown);
  return apiOk({
    items: rows,
    used,
    limit,
    hiddenByScope: items.length - shown.length,
    titleUnavailableCount: rows.filter((r) => r.titleUnavailable).length,
  });
}

export async function POST(req: NextRequest) {
  let body: {
    conversationId?: string; title?: string; targetId?: string; engine?: string;
    database?: string; turns?: unknown[];
  };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体无效");
  }
  // 🔴 生产上线批次 A:存卡片 = 把该项目的查询结果落进卡片 ⇒ 必须是该项目成员(≥ viewer)。
  const pctx = await requireProject(req, "viewer");
  if (pctx instanceof NextResponse) return pctx;
  const identity = pctx.identity;
  try {
    const r = await saveCard({
      userSub: identity.sub,
      userName: identity?.email || identity?.username,
      identity,
      projectId: pctx.projectId,
      // 🔴 落点从 body 显式来(写/执行路由不读 `?scope=`,SPEC §2.6.3);**不缺省 home** ——
      //    这段对话的数据来自哪个区,正文就只能存在那个区。
      // @kf-batch 50-WP31-place-first-class —— 经点名作者(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
      targetId: requestedTargetId(body.targetId, "保存问数卡片"),
      engine: body.engine === "athena" ? "athena" : "redshift",
      // 🔴 库名要随正文存下来 —— 打开卡片时的**重脱敏**靠它拼 FQN(缺了会让重脱敏变 no-op)。
      database: (body.database || "").trim(),
      conversationId: (body.conversationId || "").trim(),
      title: body.title || "",
      turns: (body.turns || []) as never,
    });
    return apiOk(r);
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return cardsError(e);
  }
}
