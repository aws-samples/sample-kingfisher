// 收尾 —— **按 targetId 扇出**的唯一写法(L10 的入口形态)。
//
// `forEachPlace(places, fn)`(context.ts)要的是**已解析**的 Place;而平台的扇出点手里拿的是一串 targetId
// (作业绑定 / 请求点名 / 列表里各行的章),每个分支在各自的执行体里还有一套自己的准入与报错(typed rejection:
// 绑定被拒 409 / 运行锁忙 / 区域审计写不进 …)。本文件把两者接起来,且**一点不改那套报错**:
//
//   forEachTargetPlace(targetIds, async (targetId, place) => { …原循环体… }, { sequential: true })
//
//   · 先逐个 `resolvePlace`(主控区也一样);解析得开的分支在 `forEachPlace` 建的**嵌套上下文**里跑
//     (拦截模式下该分支里的数据面调用按**它自己的区**核验,D10:并发不串、退出恢复父上下文);
//   · 解析不开的分支 **照样跑 fn**(place = null、不建上下文)—— 与改动前逐字节相同:原循环体自己的解析器会
//     以它原来的 typed error 拒掉它。🔴 刻意不在这里替它报错:那会把「绑定被拒(409,可修)」改写成别的错误类型,
//     而扇出的路由靠 `instanceof` 分 409 / 500(记忆 fanout-wrapper-erases-typed-rejection:改了异常通道,
//     靠 instanceof 的守卫全部静默失效)。
//   · fn 的返回 / 抛错**原样**透出(不包、不吞):`sequential` 时按顺序逐个 await(保留原循环「第 1 个区已提交、
//     第 2 个区失败」的语义与 stop-on-first-failure 类写法),否则并发(结果顺序与入参一致)。
//
// 🔴 本文件不新建任何 ALS 上下文 —— 上下文只由 `forEachPlace` / `runInPlace` 建(context.ts 是唯一作者)。
import { forEachPlace } from "./context";
import { resolvePlace } from "./resolve";
import type { Place } from "./types";

export interface ForEachTargetOpts {
  /** 逐个顺序执行(原来是 `for … of` + await 的扇出循环用它,保留顺序与「前一个已提交」语义) */
  readonly sequential?: boolean;
  /** 决策记账里写的作者名(观测清单按它归类) */
  readonly via?: string;
}

/** 解析一个 targetId 的落点;解析不开 ⇒ null(原因交给分支自己的解析器去报,见文件头)。 */
async function placeOrNull(targetId: string, via: string): Promise<Place | null> {
  try {
    return await resolvePlace({ kind: "target", targetId }, { via });
  } catch {
    return null;
  }
}

export async function forEachTargetPlace<T>(
  targetIds: readonly string[],
  fn: (targetId: string, place: Place | null) => Promise<T>,
  opts: ForEachTargetOpts = {}
): Promise<T[]> {
  const via = opts.via ?? "forEachTargetPlace";
  if (opts.sequential) {
    const out: T[] = [];
    for (const targetId of targetIds) {
      const place = await placeOrNull(targetId, via);
      // 单个分支也走 forEachPlace(唯一建嵌套上下文的写法);解析不开 ⇒ 不建上下文,照原样跑
      out.push(place ? (await forEachPlace([place], (p) => fn(targetId, p)))[0] : await fn(targetId, null));
    }
    return out;
  }
  const places = await Promise.all(targetIds.map((t) => placeOrNull(t, via)));
  const resolved = places.filter((p): p is Place => p !== null);
  // 解析得开的那一批:一个 forEachPlace(每个分支各自一个嵌套上下文);解析不开的照原样并发跑
  const [inPlace, outOfPlace] = await Promise.all([
    forEachPlace(resolved, (p) => fn(p.targetId, p)),
    Promise.all(targetIds.map((t, i) => (places[i] ? undefined : fn(t, null)))),
  ]);
  let k = 0;
  return targetIds.map((_t, i) => (places[i] ? inPlace[k++] : (outOfPlace[i] as T)));
}
