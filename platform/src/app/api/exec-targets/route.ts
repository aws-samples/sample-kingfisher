export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3-dataplane
// GET /api/exec-targets —— **数据面**可下推的执行目标清单(给"选执行目标"这个交互用)。
//
// 🔴 **为什么不复用 `/api/admin/exec-envs`**:那条路由在 `middleware.ts` 里被强制 `bgp-admin`
// (纵深第二道还有 `requireExecEnvAdmin`)。而"选一个区域跑我的作业"是**普通开发者**的日常操作 ——
// 让它去要管理员权限,等于把多区域功能锁死在管理员手里。
// ⇒ 本端点只回**呈现所需的最小字段**(targetId / region / jurisdiction / isHome),
//   不回资源袋、不回凭证 ARN、不回 probe 明细(那些是管理面的东西)。
//
// 🔴 **呈现不是授权**:这里列出来 ≠ 绑得上。真正的拒在写入路径的 `assertBindableTarget()`
// 与执行路径的 `resolveRedshiftBinding()`(清单可能已陈旧 —— target 随时会被改成 draining)。
// 两侧用的是**同一条判据函数**,所以不会出现"下拉里有、选了却 409"的长期撕裂。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listComponentCapableTargets } from "@/lib/exec-env/data-plane-target";
import { EXEC_TARGET_COMPONENT_DIMS, isExecTargetComponentDim } from "@/lib/exec-env/exec-targets-dims";

export async function GET(req: NextRequest) {
  // 最低门槛:得是某个项目的成员(与 `/api/redshift/schemas` 同口径)。
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const component = req.nextUrl.searchParams.get("component") || "redshift";
  // @kf-batch 50-B109-exec-target-dims —— 维度**闭合清单单一作者**(`exec-targets-dims.ts`,客户端 `fetchExecTargets` 的
  //   参数类型就是它)。不在清单 ⇒ 400:回空列表会让界面以为「没有可用目标」,而真相是「这个维度没做」,两件事处置完全不同。
  //   🔴 B-109:编排页传 "airflow"、建表向导传 "core",这里只认 redshift / any ⇒ 400 被页面吞成空列表,多区扇出入口灰了一个月。
  if (!isExecTargetComponentDim(component)) {
    return apiError(
      `component=${component} 不在支持的维度清单内(${EXEC_TARGET_COMPONENT_DIMS.join(" / ")})`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }
  // @kf-batch 50-WP4-o1-scope —— `component=any` = 顶栏「执行范围」下拉要的清单(SPEC v3.36 §2.6.5a)。
  // 🔴 复用本端点而不是新开一条:它的存在理由就是「选区域是普通开发者的日常操作,不该要管理员权限」,
  // 那条理由对执行范围一字不差地成立。判定仍是同两道过滤(已装好 ∩ 项目授权),不新写。
  if (component === "any") {
    try {
      const { listScopeTargets } = await import("@/lib/exec-env/data-plane-target");
      const targets = await listScopeTargets({ scope: "per-project", projectId: ctx.projectId });
      return apiOk({ targets });
    } catch (e: unknown) {
      // 读注册表失败**不许**回空列表:空列表在顶栏上等于「只有主控区」,用户会以为第二区域没建好。
      return apiError(`读取执行范围清单失败:${(e as Error)?.message ?? String(e)}`, 502, { code: "UPSTREAM_ERROR" });
    }
  }
  try {
    // redshift / airflow / core 三个组件维度同一条路:准入(listActiveTargets)∩ 装了该维度要的组件 ∩ 项目白名单(呈现 = 授权)
    const targets = await listComponentCapableTargets(component, { scope: "per-project", projectId: ctx.projectId }); // @kf-batch 50-W5-seg1-WP10a 项目白名单(呈现 = 授权)
    return apiOk({ targets });
  } catch (e: unknown) {
    // 🔴 读注册表失败**不许**回空列表:空列表在界面上等于"只有 home 可选",
    // 用户会以为第二区域没建好。必须把失败暴露出来。
    return apiError(`读取执行目标清单失败:${(e as Error)?.message ?? String(e)}`, 502, {
      code: "UPSTREAM_ERROR",
    });
  }
}
