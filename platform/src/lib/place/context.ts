// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 —— 请求内的落点上下文(L7)+ 观测用的「落点决策」记账。
//
// 两样东西,刻意分开:
//
// ① **显式上下文**(`runInPlace` / `forEachPlace`,AsyncLocalStorage):拦截模式(序 6)的依据。
//    只由显式包装建立 —— 路由用 `withPlace`(route.ts),请求外的循环自己 `runInPlace`。
//    🔴 D2 演练:ALS 跨 await / Promise.all / setTimeout 都在,但**请求外启动的循环没有** ⇒ 必须显式建立。
//    🔴 D11 演练(2026-10-01):`enterWith` 只有在**调用方同步段**里执行才会被调用方看见,
//       放在 async 函数的第一个 await 之后就丢了 ⇒ 不用 `enterWith` 做上下文,一律 `run`。
//
// ② **决策记账**(`notePlaceDecision`):观测模式(序 2)的依据。今天 277 个路由一个都没包 `withPlace`,
//    要拿到「真实越区调用清单」就不能等包完 —— 于是在各引擎**现有的**落点解析函数入口记一笔
//    「这次请求决定了在哪儿执行 / 有没有走『没传 = 主控区』」,观测器拿它和每次 SDK 调用的区比对。
//    账记在 **Next 的请求级存储对象**上(WeakMap,请求结束即回收,不会串到别的请求)。
//    🔴 它只是**观测输入**,不是决策来源:任何业务代码都不许读它来决定在哪儿执行。

import { AsyncLocalStorage } from "node:async_hooks";
// 🔴 Next 的内部模块(`.external` = Next 保证全进程同一实例)。只用 `getStore()`:不抛、不触发动态渲染判定
//    (`next/headers` 的 `headers()` 在请求外会抛,包 try/catch 又会吞掉 Next 的静态渲染退出信号)。
//    Next 14.2 叫 `client/components/request-async-storage.external#requestAsyncStorage`;
//    Next 15(序 68,2026-11-02)改为 `server/app-render/work-unit-async-storage.external#workUnitAsyncStorage`,
//    请求内 getStore() 返回 RequestStore(仍带 `headers`),请求外 undefined。升级 Next 时它若再变,`place-ratchets.test.ts` 那条就红。
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import type { Place } from "./types";

interface PlaceFrame {
  readonly place: Place;
}

// 🔴🔴 **进程级单例,不是模块级**(2026-10-01 本机 standalone 冒烟实测):Next 把 instrumentation 与各路由编进
//    不同的 webpack layer ⇒ 同一个源文件在产物里是**多个模块实例**(本文件在 5 个路由产物里各有一份)。
//    模块级的 ALS / 账本 ⇒ 路由里记的决策,instrumentation 装的观测器**看不见**(冒烟时 decisions 恒为空)。
//    ⇒ 挂在 globalThis 的注册 symbol 上,全进程只有一份。
const G = globalThis as unknown as Record<symbol, unknown>;
const ALS_KEY = Symbol.for("bgp.place.als");
const BAGS_KEY = Symbol.for("bgp.place.decisionBags");
const als = (G[ALS_KEY] ??= new AsyncLocalStorage<PlaceFrame>()) as AsyncLocalStorage<PlaceFrame>;

/** 在某个落点里跑 fn —— 请求外的循环(reconciler / 调度 / 后台任务)也用它。 */
export function runInPlace<T>(place: Place, fn: () => T): T {
  return als.run({ place }, fn);
}

/** 当前显式落点;没有就是 undefined(🔴 调用方不许把 undefined 当主控区)。 */
export function currentPlace(): Place | undefined {
  return als.getStore()?.place;
}

/**
 * L10:一个请求碰多个区时的**唯一**写法 —— 每个分支各自一个嵌套上下文(D10:并发不串、退出恢复父上下文)。
 * 结果顺序与入参一致;任一分支抛错 ⇒ 整体抛(需要逐个容错的调用方自己在 fn 里接住)。
 */
export function forEachPlace<T>(places: readonly Place[], fn: (place: Place) => Promise<T>): Promise<T[]> {
  return Promise.all(places.map((p) => als.run({ place: p }, () => fn(p))));
}

// ── ② 决策记账(观测用)───────────────────────────────────────────────────────────

/** 一次落点决策。`targetId: null` = 调用方**没传**、解析层按老规矩落到了主控区(B-26 那一类的原形)。 */
export interface PlaceDecision {
  readonly targetId: string | null;
  /** 哪个解析函数做的决定(观测清单按它归类) */
  readonly via: string;
  /** 显式要主控区时的理由(`redshiftClientForHomeOnly(reason)` 那种) */
  readonly homeReason?: string;
}

/** 一个请求最多记多少笔 —— 防止扇出循环把账本撑大(超出的不记,`overflow` 计数)。 */
export const MAX_DECISIONS_PER_REQUEST = 32;

interface DecisionBag {
  decisions: PlaceDecision[];
  overflow: number;
}

const bags = (G[BAGS_KEY] ??= new WeakMap<object, DecisionBag>()) as WeakMap<object, DecisionBag>;

type StoreProvider = () => object | undefined;
let storeProvider: StoreProvider = () => workUnitAsyncStorage.getStore() as object | undefined;

/** 当前请求的 Next 请求级存储对象(请求外 = undefined)。观测器用它取请求头。 */
export function currentRequestStore(): object | undefined {
  try {
    return storeProvider();
  } catch {
    return undefined;
  }
}

/**
 * 记一笔落点决策。🔴 **必须在调用方的同步段里调**(解析函数的第一行,第一个 await 之前)——
 * 它不改上下文,只往本请求的账本里追加;请求外(没有请求存储)直接忽略。永不抛。
 */
export function notePlaceDecision(d: PlaceDecision): void {
  const store = currentRequestStore();
  if (!store) return;
  let bag = bags.get(store);
  if (!bag) {
    bag = { decisions: [], overflow: 0 };
    bags.set(store, bag);
  }
  if (bag.decisions.length >= MAX_DECISIONS_PER_REQUEST) {
    bag.overflow++;
    return;
  }
  bag.decisions.push(d);
}

/** 本请求到此刻为止的决策(拷贝)。 */
export function decisionsOfCurrentRequest(): { decisions: PlaceDecision[]; overflow: number } {
  const store = currentRequestStore();
  const bag = store ? bags.get(store) : undefined;
  return { decisions: bag ? [...bag.decisions] : [], overflow: bag?.overflow ?? 0 };
}

/** 单测用:换掉请求存储的来源(Next 之外没有请求存储)。 */
export function __setRequestStoreProvider(p: StoreProvider | null): void {
  storeProvider = p ?? (() => workUnitAsyncStorage.getStore() as object | undefined);
}
