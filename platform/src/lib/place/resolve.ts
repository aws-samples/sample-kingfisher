// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 —— 落点的**唯一作者**(L1):决策(TargetRef)→ 解析(Place)。
//
// 五条原则里本文件管前两条 + 第四条:
//   · 落点只有一个来源 = DDB 描述符,**主控区也一样**(读 `tgt_home` 描述符,不读 env 常量);
//   · 决策只有一处且显式:`placeOfRequest` / `placeOfBinding` 推不出就抛 PlaceUndecidable,**没有「没传 = 主控区」**;
//   · fail-closed:描述符缺 / 不就绪 / 缺资源 ⇒ PlaceUnavailable,绝不回落。
//
// 🔴 本序只**新增**这条路,不改现有调用点(那是序 3,按引擎逐批迁移 + 棘轮降档)。

import type { NextRequest } from "next/server";
import {
  requireReadyTarget,
  TargetNotReadyError,
  getTargetRaw,
  descriptorViolation,
  type ExecutionTarget,
} from "@/lib/exec-env/registry";
import { HOME_TARGET_ID, isValidTargetId } from "@/lib/exec-env/target-id";
import { SCOPE_PARAM, parseScope } from "@/lib/scope/scope";
import { notePlaceDecision } from "./context";
import { PlaceUnavailable, PlaceUndecidable, type Place, type TargetRef } from "./types";
// 序 31 第二刀 ②:投影函数搬到零依赖叶子 descriptor.ts(请求外循环要用它建显式上下文,而本文件碰 node:crypto 可达面);
//   这里 re-export 保住既有 import 路径。
import { placeOfDescriptor } from "./descriptor";
export { placeOfDescriptor } from "./descriptor";

/** 点名一个 target(格式非法当场抛 —— 不许让非法 id 流到解析层再变成「查不到 = 主控区」)。 */
export function targetRef(targetId: string): TargetRef {
  if (!isValidTargetId(targetId)) {
    throw new PlaceUndecidable(`非法 targetId:${JSON.stringify(targetId)}`);
  }
  return { kind: "target", targetId };
}

/**
 * 请求里**点名**的落点(查询串 / 请求体的 `targetId`)。缺 / 空 ⇒ PlaceUndecidable(路由回 400),**不默认主控区**。
 * WP-31 序 3:原来这类入口写 `targetId || undefined` 再交给「缺省 = 主控区」的解析器 ⇒ 前端漏传就静默落主控区
 * (数据源弹窗列网络就是这么列出主控区 VPC 的)。前端**显式**带上落点,后端只认点名。
 */
export function requestedTargetId(raw: unknown, where: string): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) throw new PlaceUndecidable(`${where} 缺 targetId —— 不知道在哪个执行环境执行(不会默认主控区)`);
  targetRef(v);
  return v;
}

/**
 * 新建对象时请求里**点名**的绑定区列表(`targets[]`,兼收单值 `targetId`)。空 ⇒ PlaceUndecidable(400)。
 * WP-31 序 3:原来「两个都没给 = 绑主控区」⇒ /etl-jobs 页新建作业不带落点,在 us-west-2 视角建出的作业
 * 静默绑到主控区(application 也建在主控区)、并从当前视角消失(段 wp31 W31-E1/E2 无头坐实)。
 * 只做「有没有点名 + 格式」;能不能绑(准入 / 组件 / 白名单)仍由各引擎的绑定校验判。
 */
export function requestedTargets(body: { targets?: unknown; targetId?: unknown } | null | undefined, where: string): string[] {
  const raw = Array.isArray(body?.targets) ? (body!.targets as unknown[]) : [];
  const list = raw.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0);
  if (list.length === 0 && typeof body?.targetId === "string" && body.targetId.trim()) list.push(body.targetId.trim());
  if (list.length === 0) throw new PlaceUndecidable(`${where} 没有点名执行环境(targets)—— 不会默认绑到主控区`);
  for (const id of list) targetRef(id);
  return Array.from(new Set(list));
}

/**
 * 对**已绑定对象**的动作(运行 / 发布调度 / 触发)请求里的 `targets` 子集 —— 唯一解析作者(原来七个路由各写一遍)。
 * 不是数组 ⇒ `undefined` = 该对象的**全部绑定**(不是主控区);数组 ⇒ 去空白。
 * 是否为绑定的子集、空列表算 400 还是「全部」,由调用方按各自语义判(本函数不改任何路由的行为)。
 */
export function requestedSubset(body: { targets?: unknown } | null | undefined): string[] | undefined {
  if (!Array.isArray(body?.targets)) return undefined;
  return (body!.targets as unknown[]).map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
}

/**
 * 编辑请求里**有没有**改绑定(`targets` / `targetId` 任一出现)—— 三个编辑路由共用的唯一判断。
 * 不带 = 不改绑定(不是主控区);带了 ⇒ 调用方必须走 `requestedTargets`(空 / 非法 ⇒ 400)。
 */
export function hasTargetsPatch(body: { targets?: unknown; targetId?: unknown } | null | undefined): boolean {
  return body?.targets !== undefined || body?.targetId !== undefined;
}

/**
 * 「这个执行环境**装好了、能看**」的唯一判据(呈现面口径)。`listScopeTargets`(顶栏下拉)与
 * `requestedRegisteredPlace`(读接口点名)共用 —— 下拉里有的,点进去一定解析得开;下拉里没有的,点名也拒。
 * 🔴 刻意**不是**「能不能承接」(准入 / 新鲜度 / 部署锁):「能不能看」不能用「能不能承接」当判据
 *    (那样装好但暂不可承接的区会从页面上消失,记忆 scope-view-vs-serviceable-lesson)。
 * @returns `null` = 能看;字符串 = 不能看的原因。
 */
export function viewabilityVerdict(t: ExecutionTarget, violation: string | null): string | null {
  if (violation !== null) return `描述符不合格(${violation})`;
  if (String(t.status) === "deleted") return "已删除";
  if (!(t.ready === true || t.observed?.phase === "ready")) return "尚未装好(初始化没跑完)";
  return null;
}

/**
 * @kf-batch 50-WP31-place-first-class —— B-35 后一半(2026-10-11 真环境无头坐实):
 * **读接口**点名一个**已注册**执行环境 ⇒ 它的落点(位置事实全部来自描述符)。
 *
 * `requestedTargetId` 只验格式 ⇒ 一个格式合法但**不存在**的 targetId(`tgt_nope_zz`)一路流到下游,
 * 下游解析失败又被 catch 吞掉、再拿主控区的值顶上 ⇒ 200 + 主控区数据(`/api/flink/meta` 回主控区 region、
 * 模型目录回主控区的 Bedrock 清单)。这里把「点名 + 存在 + 装好」收成一个作者:
 *   · 缺 / 空 / 非法 ⇒ PlaceUndecidable(400);
 *   · 不存在 / 已删除 / 没装好 / 描述符不合格 ⇒ PlaceUnavailable(409),**绝不回落主控区**。
 * 与 `resolvePlace` 的区别:只看「能不能看」,不看「能不能承接」(见 `viewabilityVerdict`)。
 * 决策记账在第一个 await 之前(D11)。
 */
export async function requestedRegisteredPlace(raw: unknown, where: string): Promise<Place> {
  return registeredPlace(requestedTargetId(raw, where), where);
}

/**
 * 同上,入参是**代码里已经确定**的 targetId(如一期只作用于主控区的全局模型设置 / 探测)。
 * 主控区也读描述符(region 不读 env),不存在 / 没装好同样 409。
 */
export async function registeredPlace(targetId: string, where: string): Promise<Place> {
  notePlaceDecision({ targetId, via: "registeredPlace" });
  if (!isValidTargetId(targetId)) throw new PlaceUndecidable(`${where}:非法 targetId:${JSON.stringify(targetId)}`);
  const t = await getTargetRaw(targetId);
  if (!t) {
    throw new PlaceUnavailable(targetId, `${where}:执行环境 ${targetId} 不存在(注册表里没有)—— 已拒绝,不会改用主控区`);
  }
  const why = viewabilityVerdict(t, descriptorViolation(t, targetId));
  if (why) throw new PlaceUnavailable(targetId, `${where}:执行环境 ${targetId} ${why} —— 已拒绝,不会改用主控区`);
  return placeOfDescriptor(t);
}

/**
 * `resolvePlace` 的两个可选项(都不是落点本身 —— 落点只来自 `ref`)。
 *   · `via`:决策记账里写哪个引擎作者做的决定(观测清单按它归类;缺省 `resolvePlace`)。
 *     引擎作者(如 `resolveFlinkPlace`)委托到这里时传自己的名字 ⇒ 一次决策只记**一笔**,不是两层各记一笔。
 *   · `component`:该落点必须装了的组件(描述符 `components[]`)。缺 ⇒ PlaceUnavailable(409),**不回落主控区**。
 *     @kf-batch 50-WP31-place-first-class 序 3 收尾:Flink 主控区分支改走描述符时加 —— 主控区也要核组件,
 *     原来主控区走 env 常量、从来不核「主控区装没装 flink」。
 */
export interface ResolvePlaceOpts {
  readonly via?: string;
  readonly component?: string;
}

/**
 * 解析落点。🔴 主控区与其他区**同一条路**:都读描述符、都过准入(可承接才给)。
 * 决策记账在第一个 await 之前(D11:放到 await 之后调用方就看不见了)。
 */
export async function resolvePlace(ref: TargetRef, opts: ResolvePlaceOpts = {}): Promise<Place> {
  const targetId = ref.kind === "home" ? HOME_TARGET_ID : ref.targetId;
  const via = opts.via ?? "resolvePlace";
  notePlaceDecision(ref.kind === "home" ? { targetId, via, homeReason: ref.reason } : { targetId, via });
  if (!isValidTargetId(targetId)) throw new PlaceUndecidable(`非法 targetId:${JSON.stringify(targetId)}`);
  let t: ExecutionTarget;
  try {
    t = await requireReadyTarget(targetId);
  } catch (e) {
    if (e instanceof TargetNotReadyError) {
      throw new PlaceUnavailable(targetId, `执行环境 ${targetId} 当前不可承接:${e.message}(不会改在主控区执行)`);
    }
    throw e;
  }
  if (opts.component) {
    const comps: string[] = Array.isArray(t.components) ? t.components : [];
    if (!comps.includes(opts.component)) {
      throw new PlaceUnavailable(
        targetId,
        `执行环境 ${targetId} 没有装 ${opts.component} 组件(已装:${comps.join(", ") || "无"})—— 已拒绝,不会改在别的区执行`
      );
    }
  }
  return placeOfDescriptor(t);
}

/**
 * 取落点里的一个实名资源(L2)。缺 / 不是非空字符串 ⇒ 拒,并说清缺哪一个。
 * 🔴 没有缺省值参数 —— 缺省值就是把某个区写死。
 */
export function placeResource(place: Place, key: string): string {
  const v = place.resources[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new PlaceUnavailable(
      place.targetId,
      `执行环境 ${place.targetId} 的资源清单里没有 ${key} —— 已拒绝,不会拿别的区的同名资源顶上`
    );
  }
  return v;
}

/**
 * 对象自己的绑定 ⇒ 落点(写路由 / 按对象执行的唯一来源)。
 * 🔴 与 `bindingTargets` 的区别:它对「两个字段都没有」回主控区(存量行的历史约定),
 *    这里**不回**:序 3 迁移某类对象前,先把它的存量行补上章,再切到本函数。
 */
export function placeOfBinding(row: { targets?: unknown; targetId?: unknown } | null | undefined): TargetRef {
  const raw = Array.isArray(row?.targets) ? (row!.targets as unknown[]) : [];
  const list = raw.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
  const single = typeof row?.targetId === "string" ? row.targetId.trim() : "";
  const ids = Array.from(new Set(list.length ? list : single ? [single] : []));
  if (ids.length === 0) throw new PlaceUndecidable("对象没有执行环境绑定 —— 不知道在哪儿执行(不会默认主控区)");
  if (ids.length > 1) {
    throw new PlaceUndecidable(`对象绑定了 ${ids.length} 个执行环境(${ids.join(", ")})—— 多区执行只许经 forEachPlace`);
  }
  return targetRef(ids[0]);
}

/**
 * 一次请求的落点:**对象绑定 > URL 视角**;推不出 ⇒ 抛 PlaceUndecidable(路由回 400)。
 * 🔴 写路由不读视角(SPEC §2.6.3:地址栏里的东西不该决定在哪个区真跑)⇒ 非 GET/HEAD 必须给对象。
 */
export function placeOfRequest(req: NextRequest, obj?: { targets?: unknown; targetId?: unknown } | null): TargetRef {
  if (obj) return placeOfBinding(obj);
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new PlaceUndecidable(`写请求(${method})的落点只能来自对象绑定或请求体,不读视角 ?${SCOPE_PARAM}=`);
  }
  const raw = req.nextUrl.searchParams.get(SCOPE_PARAM);
  const scope = parseScope(raw);
  if (!scope) throw new PlaceUndecidable(`视角 ?${SCOPE_PARAM}= 取值非法(${JSON.stringify(raw)})`);
  if (scope.kind !== "target") {
    throw new PlaceUndecidable(
      scope.kind === "global"
        ? "当前视角是「全部」—— 数据面操作要先选一个执行环境(不会默认主控区)"
        : "当前视角是对比 —— 多区操作只许经 forEachPlace"
    );
  }
  return targetRef(scope.targetId);
}
