// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 —— 路由包装器 `withPlace`(L7):决策 → 解析 → 在显式上下文里跑 handler。
//
//     export const GET = withPlace(async (req, place) => apiOk(await listTables(place)));
//
// 推不出落点 ⇒ 400 PLACE_UNDECIDABLE;描述符不可用 ⇒ 409 PLACE_UNAVAILABLE —— **都不回落主控区**。
// 需要按对象绑定的路由传 `objectOf`(先读对象、再定落点;对象读不到由 objectOf 自己回 404)。

import type { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { runInPlace } from "./context";
import { placeOfRequest, resolvePlace } from "./resolve";
import { PlaceUnavailable, PlaceUndecidable, type Place } from "./types";

type Handler<C> = (req: NextRequest, place: Place, ctx: C) => Promise<Response>;
type ObjectOf<C> = (req: NextRequest, ctx: C) => Promise<{ targets?: unknown; targetId?: unknown } | Response>;

/** 落点两类错误 → 统一信封(其余错误原样抛给路由自己的处理)。 */
export function placeErrorResponse(e: unknown): Response | null {
  if (e instanceof PlaceUndecidable) return apiError(e.message, 400, { code: "PLACE_UNDECIDABLE" });
  if (e instanceof PlaceUnavailable) {
    return apiError(e.message, 409, { code: "PLACE_UNAVAILABLE", detail: { targetId: e.targetId } });
  }
  return null;
}

export function withPlace<C = unknown>(handler: Handler<C>, opts: { objectOf?: ObjectOf<C> } = {}) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    let place: Place;
    try {
      let obj: { targets?: unknown; targetId?: unknown } | undefined;
      if (opts.objectOf) {
        const o = await opts.objectOf(req, ctx);
        if (o instanceof Response) return o;
        obj = o;
      }
      place = await resolvePlace(placeOfRequest(req, obj));
    } catch (e) {
      const r = placeErrorResponse(e);
      if (r) return r;
      throw e;
    }
    return runInPlace(place, () => handler(req, place, ctx));
  };
}
