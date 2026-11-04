export const dynamic = "force-dynamic";
// @kf-batch 50-P50.2c-control-api
// GET /api/admin/exec-envs —— 执行环境列表(SPEC §2.1)。
//
// 🔴 管理面读走 **raw 口径**(SPEC:241):不过滤、不校验 —— 运维必须能看到坏 item /
// 失败 target 才修得了它。准入/扇出那侧另有 `listActiveTargets()`(带校验剔除),两者绝不混用。
// @kf-batch 50-init-region-enablement
import { isControlPlaneRegionEnabled } from "@/lib/exec-env/control-plane-regions";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { listTargetsRaw, describeServiceability } from "@/lib/exec-env/registry";

export async function GET(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  try {
    const targets = await listTargetsRaw();
    // 支持 SPEC §2.1 的 ?region=&stage=&status= 过滤(在已翻页的全集上过滤 —— target 是部署单元量级)。
    const url = new URL(req.url);
    const want = {
      region: url.searchParams.get("region"),
      stage: url.searchParams.get("stage"),
      status: url.searchParams.get("status"),
    };
    const filtered = targets.filter(
      (t) =>
        (!want.region || t.region === want.region) &&
        (!want.stage || t.stage === want.stage) &&
        (!want.status || t.status === want.status)
    );
    // 🔴 每张卡附**只读**可服务性(判定与数据面同一内核 `describeServiceability`)。
    //    列表页据此在"徽标运行中但其实不承接"时打一个警示 tag —— 徽标不含新鲜度/锁,单看它会被骗。
    //    `now` 只取一次:同一次响应里各 target 的新鲜度用同一时刻算,不然会出现"上下两张卡口径不同"。
    const now = Date.now();
    return apiOk(
      filtered.map((t) => ({
        ...t,
        serviceability: describeServiceability(t, String(t.sk ?? t.targetId ?? ""), now),
        // @kf-batch 50-init-region-enablement —— 卡片 / 抽屉据此明示「控制面尚未放行该 region」(init 段 I-4)
        controlPlaneRegionEnabled: isControlPlaneRegionEnabled(String(t.region ?? "")),
      }))
    );
  } catch (e: unknown) {
    return apiError(`读取执行环境列表失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
