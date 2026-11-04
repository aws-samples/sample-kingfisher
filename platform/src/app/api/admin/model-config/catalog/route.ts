// @kf-batch 50-W5-seg2-WP8
// 模块 51 — GET /api/admin/model-config/catalog(51 SPEC §2;M11:只读探测缓存、绝不 probe-all、<1s)。
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
// @kf-batch 50-WP31-place-first-class —— 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiOk } from "@/lib/api-response";
import { requirePlatformAdmin, modelConfigError } from "@/lib/settings/admin-guard";
import { fetchCatalog } from "@/lib/settings/model-catalog";
// @kf-batch 51-v2-multi-vendor —— 响应带 `families[]`(系列键 / 分组标题 / 是否要 tool-use 二探 / 是否恒带推理块),
//   前端分组与说明只读这里,不再硬编码「两系列」(51 SPEC §7.5)。
import { familySummaries } from "@/lib/ai/core/vendors";
// @kf-batch 50-WP4quater-reads(工单 SC-25 读侧)—— 🔴 `fetchCatalog` **本来就收 targetId**,
// 只是这条路由写死了 HOME_TARGET_ID ⇒ 在别的区看到的是**主控区能用的模型清单**。
// 而模型可用性是真按区的:`us.` 前缀的跨区推理配置在非美国区根本调不通(51 SPEC §6.2③ / 50 R10 P0)。
// 用户照着主控区的清单选一个,保存后在那个区一调就炸,而报错指向模型而不是区。
// 🔴 per-region 的**默认模型覆盖**(settingScope=<targetId>#global)是 51 WP-8 / P51.3 的设计,
//    不在这一刀里替它拍板;这里只把**目录读**做对。

export async function GET(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;
  try {
    // @kf-batch 50-WP31-place-first-class —— 🔴 原来「没给 / 非法 ⇒ 主控区」(非法值也静默改区 = fail-open);现在只认点名
    // @kf-batch 50-WP31-place-first-class —— B-35 后一半:🔴 只验格式不够 —— 不存在的 targetId 原来照样 200 且回主控区目录。
    //   现在点名必须是**已注册且装好**的执行环境(否则 409),目录取**该环境所在区**的 Bedrock(region 来自描述符)。
    const place = await requestedRegisteredPlace(req.nextUrl.searchParams.get("targetId"), "取模型目录");
    const models = await fetchCatalog({ place });
    return apiOk({ models, families: familySummaries(), targetId: place.targetId, region: place.region });
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return modelConfigError("CatalogUnavailable", 503, { message: `模型目录拉取失败(Bedrock ListFoundationModels/ListInferenceProfiles): ${e instanceof Error ? e.message : String(e)}` });
  }
}
