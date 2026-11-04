export const dynamic = "force-dynamic";
// @kf-batch 50-P50.2c-control-api
// GET /api/admin/exec-envs/[targetId]/build-status —— 部署进度回读(SPEC §2.1:156 / DESIGN §12.4)。
//
// 数据源分工(§12.4 定案):
//   phase   ← BatchGetBuilds(home region;只作"整体在跑/成功/失败"的粗粒度)
//   stacks  ← **目标 region** 的 CloudFormation DescribeStacks(逐栈进度的唯一可靠来源)
//   logsTail← 构建日志尾部(辅助信息,失败降级为 "")
//   observedVersion ← 恒 null(真源=切片 e 的描述符回写,不装完成)
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { readBuildStatus } from "@/lib/exec-env/deploy-control";

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    // buildId 缺省取 target.lastBuildId(broker 置 initializing 时写入);都没有时仍查 CFN ——
    // "没有 build 在跑"不等于"没有栈"(部署完成后进度页仍应能看到栈的现状),phase 会如实是 "none"。
    const buildId = new URL(req.url).searchParams.get("buildId") ?? undefined;
    const status = await readBuildStatus(target, buildId);
    return apiOk(status);
  } catch (e: unknown) {
    return apiError(`读取部署进度失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
