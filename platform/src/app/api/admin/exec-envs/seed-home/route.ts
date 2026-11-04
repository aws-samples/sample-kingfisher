export const dynamic = "force-dynamic";
// @kf-batch 50-P50.2e2-seed-home
// POST /api/admin/exec-envs/seed-home —— home 描述符的部署期 seed(SPEC §1.1 的「seed 入口」)。
//
// 【这不是"读路径自愈"】G 批 P1-1 禁的是"读请求顺手写库";本端点是 **bgp-admin 的显式管理动作**
// (部署收尾/管理页按钮),语义 = SPEC §1.1 的"seed 由部署期收尾执行"。
// 流程:实时查询组装(fetchHomeFacts)→ 纯函数出候选 → **先真探**(runProbe;红了就不写,
// 「校验不过不写」)→ 既有 seedHomeTarget 落库(整包校验 + 幂等位置比对)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { seedHomeTarget, HOME_TARGET_ID, type ExecutionTarget, getTargetRaw, adoptHomeComponents } from "@/lib/exec-env/registry";
import { fetchHomeFacts, buildHomeDescriptor } from "@/lib/exec-env/seed-home";
import { runProbe } from "@/lib/exec-env/probe-runner";

export async function POST(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  try {
    const facts = await fetchHomeFacts(); // core 真值缺任一 ⇒ 抛(fail-closed,不写半份)
    const candidate = buildHomeDescriptor(facts, identity.username, new Date().toISOString());

    // 先真探再写:名字是 SSOT 给的、id 是查来的,但"资源真的在"要探过才算(校验不过不写)。
    const probe = await runProbe({ ...candidate, targetId: HOME_TARGET_ID, sk: HOME_TARGET_ID, pk: "env" } as ExecutionTarget);
    if (!probe.ok) {
      recordAudit(req, "exec-env.seed-home.rejected", {
        resourceType: "exec-env",
        resourceId: HOME_TARGET_ID,
        detail: { failed: probe.items.filter((i) => !i.ok).map((i) => i.name) },
      }).catch(() => {});
      return apiError("home 资源探活未全绿,拒绝落库(校验不过不写)", 409, {
        code: "CONFLICT",
        detail: { probe },
      });
    }

    // ProbeResult 是 interface(无索引签名),描述符的 probe 字段是 Record<string,unknown> —— 结构兼容,展开即可。
    const outcome = await seedHomeTarget({ ...candidate, probe: { ...probe } });
    // @kf-batch 50-WP15-airflow-serverless —— seedHomeTarget 对已存在只做位置比对与 contentDrift 报告,不改内容;
    //   控制面新建的组件(deploy-all 6.6 / redeploy §2c 的 BgpAirflowServerlessStack)由下面的 adoptHomeComponents **只增采纳**。
    let merged: { components?: string[]; resources?: string[] } | undefined;
    if (outcome.outcome === "already-complete") {
      // @kf-batch 50-WP15-airflow-serverless
      // 🔴 home 已在服务:控制面新建的组件(如 BgpAirflowServerlessStack)只能经**只增采纳**通道进描述符。
      //    reconcileTarget 是维修态门(active 必拒,真环境 HTTP 500),mergeComponentResources 要 finalize fence(home 没有部署会话)
      //    ⇒ adoptHomeComponents:只增不改 / 三处同步 / 本次真探全绿才写 / version + 无在途会话条件写。没有增量就是幂等无写。
      const existing = await getTargetRaw(HOME_TARGET_ID);
      if (existing) {
        const r = await adoptHomeComponents({
          components: candidate.components ?? [],
          resources: (candidate.resources ?? {}) as Record<string, unknown>,
          expectedVersion: Number(existing.version ?? 0),
          probe,
        });
        if (r.changed) merged = { components: r.added, resources: r.addedResources };
      }
    }
    recordAudit(req, "exec-env.seed-home", {
      resourceType: "exec-env",
      resourceId: HOME_TARGET_ID,
      detail: { outcome: outcome.outcome, components: candidate.components, ...(merged ? { merged } : {}) },
    }).catch(() => {});
    return apiOk({ targetId: HOME_TARGET_ID, outcome, probe, ...(merged ? { merged } : {}) });
  } catch (e: unknown) {
    return apiError(`home seed 失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
