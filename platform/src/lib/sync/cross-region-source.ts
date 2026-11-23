// 「禁止跨区取数」的判法(唯一作者):同步 = 读源写仓,数据源所在的执行区必须就是任务绑定的执行区。
//
// 批同步启动、DMS 启动、修改任务换源三处共用这一个判法(错误码与文案留在各自的路由里:它们说的话不一样,判的是同一件事)。
// 存量数据源没有落点章 = 主控区;存量任务没有绑定 = 主控区 —— 两个缺省各自只有一个读法,这里只是把它们对一下。
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";

export interface CrossRegionSource {
  /** 数据源所在的执行区 */
  datasourceOwner: string;
  /** 任务绑定的执行区 */
  bound: string[];
}

/** 数据源不在任务绑定的执行区 ⇒ 回两边的事实(调用方据此 409);在 ⇒ `null`。 */
export function crossRegionSource(
  task: { targets?: unknown; targetId?: unknown } | null | undefined,
  datasource: Record<string, unknown> | null | undefined
): CrossRegionSource | null {
  const bound = bindingTargets(task);
  const datasourceOwner = datasourceOwnerTarget(datasource);
  return bound.includes(datasourceOwner) ? null : { datasourceOwner, bound };
}
