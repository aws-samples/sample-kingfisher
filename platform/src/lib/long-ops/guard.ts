// 长操作统一框架 —— 对象租约的路由侧守卫(55 DESIGN §2.8)。
//
// 改 / 删某对象的路由(当前:建模码表 / 维表的 PUT / DELETE)在动手前调 `resourceBusyResponse([...])`:
//   该对象正被某个长操作占着 ⇒ 409 `{ code: "LONG_OP_IN_PROGRESS", message: 「<标签>」正在进行中(已 n 秒),请等它结束后再操作 }`;
//   没人占 / 死租约(holder 已终态 / 超天花板)⇒ null(死租约顺手清掉),路由照常。
// 资源键必须用 kinds.ts 的 resourceKey 生成,与 LONG_OP_RESOURCES 里长操作一侧的声明是同一文法(判据 leases-wiring 钉两侧字面同族)。
// 不引 driver.ts(那边 import 全部执行体注册表);错误 ⇒ 响应用 http-error.ts 的同一个作者。

import type { NextResponse } from "next/server";
import { assertResourcesFree } from "./store";
import { longOpErrorResponse } from "./http-error";

export { assertResourcesFree };

/** 任一资源仍被长操作占着 ⇒ 409 响应;否则 null。只吞 LongOpHttpError,库错误照抛(路由自己的兜底处理)。 */
export async function resourceBusyResponse(resources: readonly string[]): Promise<NextResponse | null> {
  try {
    await assertResourcesFree(resources);
    return null;
  } catch (e) {
    const res = longOpErrorResponse(e);
    if (res) return res;
    throw e;
  }
}
