// 「描述符 → Place」的投影,独立成**零依赖叶子**。
//
// 为什么从 resolve.ts 搬出来:请求外的周期循环(reconciler 探活 / 镜像 tick)也要给每个 target 建**显式落点上下文**
//   (`runInPlace`),否则它们发出的每一次数据面调用在观测清单里都只能记成「未归因 (请求外)」
//   (ec2 80 · s3 HEAD 60 · cloudformation 60 · s3tables / glue / redshift-serverless / dms / athena 各 20)。
//   而 `resolve.ts` 经 `data-plane-target` → `privileged-cred` → `project-schema` 碰 node:crypto,
//   reconciler 所在的 instrumentation 可达面 import 它会让 edge 编译直接炸(instrumentation-bundle-guard)。
//   ⇒ 投影函数放这里(只 import 类型 + target-id),resolve.ts 从这里 re-export,既有调用方一个字不改。
//
// 🔴 本文件只做投影,不读注册表、不做准入:能不能承接由 resolve.ts 的 `resolvePlace` 判。

import { isHome } from "@/lib/exec-env/target-id";
import type { ExecutionTarget } from "@/lib/exec-env/registry";
import { PlaceUnavailable, type Place } from "./types";

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** 把描述符投影成 Place。缺位置属性 ⇒ 拒(位置属性缺失不得回落主控区)。 */
export function placeOfDescriptor(t: ExecutionTarget): Place {
  const region = typeof t.region === "string" ? t.region.trim() : "";
  if (!REGION_RE.test(region)) {
    throw new PlaceUnavailable(t.targetId, `执行环境 ${t.targetId} 的描述符没有合法 region(${JSON.stringify(t.region)})—— 拒绝`);
  }
  const accountId = typeof t.accountId === "string" ? t.accountId.trim() : "";
  if (!/^\d{12}$/.test(accountId)) {
    throw new PlaceUnavailable(t.targetId, `执行环境 ${t.targetId} 的描述符没有合法 accountId —— 拒绝`);
  }
  const partition = typeof t.partition === "string" ? t.partition.trim() : "";
  if (!partition) {
    throw new PlaceUnavailable(t.targetId, `执行环境 ${t.targetId} 的描述符没有 partition —— 拒绝`);
  }
  return Object.freeze({
    targetId: t.targetId,
    region,
    accountId,
    partition,
    home: isHome(t.targetId),
    resources: Object.freeze({ ...(t.resources ?? {}) }),
    version: typeof t.version === "number" ? t.version : null,
    source: "descriptor" as const,
  });
}

/**
 * 请求外循环给**观测上下文**用的宽松版:描述符不合格 ⇒ `null`(调用方按「无上下文」照常跑)。
 * 🔴 只许用在建观测上下文这一个用途上 —— 任何**决定在哪儿执行**的代码都必须用上面的严格版(fail-closed)。
 *    探活 / 镜像自己的区取自描述符的 `region`,与上下文无关;上下文建不起来只影响「归因」,不影响「做什么」,
 *    所以这里不能因为一个描述符不合格就让整条周期循环对该 target 停摆。
 */
export function placeOfDescriptorOrNull(t: ExecutionTarget | null | undefined): Place | null {
  if (!t) return null;
  try {
    return placeOfDescriptor(t);
  } catch {
    return null;
  }
}
