// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 —— 「落点」的一等类型(WORK-PACKAGES v1.86 WP-31 ① L1)。
//
// ── 为什么要有这个文件 ──────────────────────────────────────────────────────────
// 落点 bug 越修越多的根因(WP-31 ⓪):「在哪个区执行」从来不是一等值,而是散在各处的
// `targetId?: string | null` —— **漏传 = 主控区**,而主控区返回的是**真数据**,于是错误静默。
// B-26 的修法(`LakeTarget = { targetId: string | undefined }`)把键改成了必填,但 `undefined`
// 仍然是合法值、仍然 = 主控区 —— 静默默认只是换了个写法留在类型里(WP-31 §⑥ D3 的对照组)。
//
// ⇒ 本文件的三条承重:
//   ① `TargetRef` 是**判别联合,没有可选、没有 undefined**:要么点名一个 target,要么**写明理由**地要主控区;
//   ② 主控区也是一个 target(`tgt_home`),走同一条解析(resolve.ts 读它的描述符),不是常量;
//   ③ 本文件零依赖(只有类型 + 两个错误类),edge / node / 测试都能 import。

import type { HomeOnlyReason } from "@/lib/exec-env/target-clients";

/**
 * 「为什么这里只能是主控区」的封闭理由集。
 * 🔴 **不新起第二份清单**:直接用 `target-clients.ts` 的 `HomeOnlyReason`(那张表只减不增,每删一个理由
 *    = 一条路径完成下推)。在这里另写一份,两份迟早各自漂移(change-safety A1)。
 */
export type HomeReason = HomeOnlyReason;

/**
 * 落点的引用 —— 「要在哪儿执行」的**决策结果**,还没解析成资源。
 *
 * 🔴 刻意没有 `{ kind: "default" }` / `undefined`:推不出落点的地方必须报错(PlaceUndecidable),
 *    而不是让解析层替它挑一个「合理的」区。
 */
export type TargetRef =
  | { readonly kind: "target"; readonly targetId: string }
  | { readonly kind: "home"; readonly reason: HomeReason };

/**
 * 解析后的落点(L1):**一切数据面资源名与区域只许从这里取**。
 *
 * 由 DDB 描述符派生(`source` 恒为 `"descriptor"`,主控区也一样 —— PL-3 判据看的就是这个字段)。
 * `version` = 描述符的乐观锁版本,请求内只读一次、同一份用到底(WP-31「DDB 唯一真值 + 读取时复核」)。
 */
export interface Place {
  readonly targetId: string;
  readonly region: string;
  readonly accountId: string;
  readonly partition: string;
  readonly home: boolean;
  /** 描述符实名资源袋的**只读快照**(不许由 region 拼名字 —— 见 `placeResource`)。 */
  readonly resources: Readonly<Record<string, unknown>>;
  readonly version: number | null;
  readonly source: "descriptor";
}

/** 推不出落点(没有对象绑定、视角是全局 / 对比、或写路由想读视角)。路由据此回 400,**不回落主控区**。 */
export class PlaceUndecidable extends Error {
  readonly status = 400 as const;
  readonly code = "PLACE_UNDECIDABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "PlaceUndecidable";
  }
}

/** 描述符缺失 / 不完整 / 缺某个资源。🔴 只许报错,**绝不**拿主控区的值顶上(fail-closed)。 */
export class PlaceUnavailable extends Error {
  readonly status = 409 as const;
  readonly code = "PLACE_UNAVAILABLE" as const;
  constructor(readonly targetId: string, message: string) {
    super(message);
    this.name = "PlaceUnavailable";
  }
}

/** 一次跨区数据面调用(L3 拦截模式抛它;观测模式只记录)。 */
export class CrossRegionDataPlaneCall extends Error {
  readonly code = "CROSS_REGION_DATA_PLANE_CALL" as const;
  constructor(
    readonly detail: { service: string; operation: string; clientRegion: string; placeRegion: string; targetId: string }
  ) {
    super(
      `跨区数据面调用已拦截:${detail.service}.${detail.operation} 的客户端在 ${detail.clientRegion},` +
        `而本次请求的落点是 ${detail.targetId}(${detail.placeRegion})—— 这正是「在别的区视角拿到主控区数据」那一类,拒绝发出`
    );
    this.name = "CrossRegionDataPlaneCall";
  }
}
