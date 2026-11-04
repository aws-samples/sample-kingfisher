// @kf-batch 50-WP15-airflow-serverless
// 🔴 `/api/exec-targets` 的**唯一**客户端读法(W3e-12 页面驱动真撞:路由回 `{targets:[…]}`,EMR 面板仍按数组读
//    ⇒「执行目标清单读取失败:(e.data || []).map is not a function」⇒「全选当前活跃区(0)」灰掉 ⇒ 作业只能绑 home,多区域在界面上消失)。
//    一个路由、四个消费者、只改了三个 —— 爆炸半径漏消费者的标准形态。修法不是再改一处,而是把读法收成一处:
//    页面不许再自己 fetch 这条路由(wiring 守卫 grep 钉),形状变化只可能在这里被发现一次。
"use client";

import type { ExecTargetComponentDim } from "@/lib/exec-env/exec-targets-dims";

export interface ExecTargetOption {
  targetId: string;
  region: string;
  isHome: boolean;
  jurisdiction?: string;
  // @kf-batch 50-WP4-o1-scope —— 顶栏「执行范围」下拉要显示的两样(`component=any` 才回)。
  // 🔴 可选而不是必填:老消费者(EMR 面板 / 直查 / 建模)拿的是 `component=redshift`,那条不回这两个字段。
  displayName?: string;
  components?: string[];
  /** @kf-batch 50-WP4-o1-scope 此刻能否承接新工作(徽标用;**不是**过滤条件 —— 见 listScopeTargets 的注释) */
  serviceable?: boolean;
  unusableReason?: string | null;
}

/** 把服务端 `data` 归一成数组:现行 `{targets:[…]}`;兼容早期裸数组;其他形状**显式抛**(静默回空 = 界面只剩 home,用户会以为第二区域没建好)。 */
export function normalizeExecTargets(data: unknown): ExecTargetOption[] {
  const arr = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { targets?: unknown }).targets) ? (data as { targets: unknown[] }).targets : null;
  if (!arr) throw new Error(`执行目标清单形状异常:期望 {targets:[…]},收到 ${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}`);
  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { targetId?: unknown }).targetId === "string")
    .map((x) => ({
      targetId: String(x.targetId),
      region: typeof x.region === "string" ? x.region : "",
      isHome: !!x.isHome,
      ...(typeof x.jurisdiction === "string" ? { jurisdiction: x.jurisdiction } : {}),
      ...(typeof x.displayName === "string" ? { displayName: x.displayName } : {}),
      ...(Array.isArray(x.components) ? { components: x.components.map(String) } : {}),
      ...(typeof x.serviceable === "boolean" ? { serviceable: x.serviceable } : {}),
      ...(typeof x.unusableReason === "string" ? { unusableReason: x.unusableReason } : {}),
    }));
}

/** 读可下推执行目标清单(服务端已过准入 + 组件 + 法域)。失败**抛错**,由调用方显式呈现(不许静默留空)。
 *  @kf-batch 50-B109-exec-target-dims —— 🔴 维度参数**只认闭合清单**(`exec-targets-dims.ts`,路由同一份):
 *  编排页曾传路由不认的 "airflow"、建表向导传 "core",400 被页面吞成空列表坏了一个月(B-109);类型化后传错在 tsc 就红。 */
export async function fetchExecTargets(component: ExecTargetComponentDim = "redshift"): Promise<ExecTargetOption[]> {
  const res = await fetch(`/api/exec-targets?component=${encodeURIComponent(component)}`, { cache: "no-store" });
  let body: { success?: boolean; data?: unknown; error?: { message?: string } } | null = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`读取执行目标失败:HTTP ${res.status}(非 JSON 响应)`);
  }
  if (!res.ok || !body?.success) throw new Error(body?.error?.message || `读取执行目标失败:HTTP ${res.status}`);
  return normalizeExecTargets(body.data);
}

/**
 * @kf-batch 50-WP4-o1-scope
 * 顶栏「执行范围」下拉的清单(合同 SPEC v3.36 §2.6.5a)= `component=any`。
 *
 * 🔴 走同一个客户端而不是自己 fetch:本文件头那条教训(一个路由四个消费者、只改了三个)对
 * 新增的第五个消费者一字不差地成立 —— 形状变化只该在**一处**被发现。
 */
export async function fetchScopeTargets(): Promise<ExecTargetOption[]> {
  return fetchExecTargets("any");
}
