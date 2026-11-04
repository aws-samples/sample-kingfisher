// @kf-batch 50-WP9a-durable-jobs
// 进 `isolated` 的**服务端前置判据**(WORK-PACKAGES WP-9 ④-3 末句;50 SPEC §3.9b「进 isolated 的前置」)。
//
//   ① 在用项目都有 per-project secret(P52.5a 已有:present / missing / unverifiable 三分)
//   ② 在用项目最新 canary 全 pass ∧ epoch 一致 ∧ ≤ 24h(本包 permission-canary)
//   ③ 产物凭证扫描 = 0(Glue 脚本 / DAG 里烤进去的 admin secret ARN;WP-9 ② 第 10 行)
//   ④ 近 7 天 `CredentialFallback` = 0(回落指标;cred-observability 写的那条)
//
// 🔴 **全部 fail-closed**:任何一项「拿不准」都算不满足 —— 尤其 ③:它的实现归 **WP-9b**(序 4 写入收口 /
//    序 8 产物重发布),在那之前它回 `unavailable`,于是 isolated **一定被拒**。这是有意的:
//    `isolated` 单调不可逆,在「烤进产物里的 admin ARN 还没清零」时推过去,稳态就是虚设(WP-9 ⑩-2)。
// 🔴 不在这里推进状态:本模块只**判**,推进仍只经 `advanceCredentialIsolationState`(唯一写通道)。
import { listProjectsWithBindings, verifyProjectCredentials } from "@/lib/exec-env/project-cred-supply";
import { canaryPrerequisite, latestCanaryByProject } from "@/lib/exec-env/permission-canary";
import { CRED_METRIC_NAMESPACE } from "@/lib/exec-env/cred-observability";

export type PrereqKey = "secrets" | "canary" | "artifact-scan" | "fallback-7d";

export interface PrereqFailure {
  key: PrereqKey;
  message: string;
  projects?: Array<{ projectId: string; why: string }>;
}

export interface IsolationPrereqVerdict {
  ok: boolean;
  projects: string[];
  failures: PrereqFailure[];
}

/** ③ 产物凭证扫描的结果。`unavailable` = 扫描器还不存在 / 扫不全 ⇒ 按不满足处理。 */
export type ArtifactScanResult =
  | { status: "ok"; adminArnHits: number }
  | { status: "unavailable"; reason: string };

/** ④ 回落指标的结果。 */
export type FallbackCountResult = { status: "ok"; count: number } | { status: "unavailable"; reason: string };

export interface PrereqDeps {
  scanArtifacts?: (targetId: string) => Promise<ArtifactScanResult>;
  countFallback7d?: (targetId: string, now: number) => Promise<FallbackCountResult>;
}

/**
 * ③ 的默认实现:**如实回 unavailable**(扫描器归 WP-9b)。
 * 🔴 不许写成 `{status:"ok", adminArnHits:0}` 先放行 —— 那正是「没有载体的能力宣称」。
 */
export async function scanArtifactCredentialsUnavailable(_targetId: string): Promise<ArtifactScanResult> {
  return {
    status: "unavailable",
    reason:
      "产物凭证扫描尚未实现(归 WP-9b:写入收口 + 产物重发布之后才能扫清)。在扫描器落地前,进 isolated 一律被拒 —— " +
      "Glue 脚本 / DAG 里烤进去的 admin secret ARN 不清零,isolated 只是名义上的稳态",
  };
}

/**
 * ④ 的默认实现:CloudWatch `BGP/ExecEnv · CredentialFallback`,按该 target 的全部维度组合求近 7 天总和。
 * 🔴 指标写在控制面区(cred-observability 用进程 region 写)⇒ 读也在控制面区。
 * 🔴 读失败 ⇒ unavailable(不是 0):「读不到」当「没有回落」就是放行。
 */
export async function countCredentialFallback7d(targetId: string, now: number): Promise<FallbackCountResult> {
  try {
    const { GetMetricDataCommand } = await import("@aws-sdk/client-cloudwatch");
    const { regionalClient } = await import("@/lib/aws/clients");
    const { ctrlRegionOf } = await import("@/lib/workflow/dag-place");
    const cw = await regionalClient("cloudwatch", ctrlRegionOf());
    if (!/^tgt_[a-z0-9_]+$/.test(targetId)) return { status: "unavailable", reason: `targetId 形态非法:${targetId}` };
    let total = 0;
    let nextToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await cw.send(
        new GetMetricDataCommand({
          StartTime: new Date(now - 7 * 86_400_000),
          EndTime: new Date(now),
          MetricDataQueries: [
            {
              Id: "fb",
              Expression:
                `SEARCH('{${CRED_METRIC_NAMESPACE},IsolationState,ProjectId,TargetId} ` +
                `MetricName="CredentialFallback" TargetId="${targetId}"', 'Sum', 86400)`,
              ReturnData: true,
            },
          ],
          ...(nextToken ? { NextToken: nextToken } : {}),
        })
      );
      for (const res of r.MetricDataResults ?? []) {
        if (res.StatusCode && res.StatusCode !== "Complete" && res.StatusCode !== "PartialData") {
          return { status: "unavailable", reason: `CloudWatch 回 ${res.StatusCode}` };
        }
        for (const v of res.Values ?? []) total += v;
      }
      nextToken = r.NextToken;
      if (!nextToken) return { status: "ok", count: total };
    }
    return { status: "unavailable", reason: "CloudWatch 翻页超过上限 ⇒ 数不全" };
  } catch (e) {
    return { status: "unavailable", reason: `读 CredentialFallback 指标失败:${String((e as Error)?.message ?? e)}` };
  }
}

/**
 * 四项一起判,**全部**失败项一次说清(运维不必一项一项撞墙)。
 */
export async function evaluateIsolationPrereqs(
  targetId: string,
  currentEpoch: number,
  now: number,
  deps: PrereqDeps = {}
): Promise<IsolationPrereqVerdict> {
  const failures: PrereqFailure[] = [];
  const projects = await listProjectsWithBindings(targetId);

  // ①
  const v = await verifyProjectCredentials(targetId, projects);
  if (v.missing.length > 0 || v.unverifiable.length > 0) {
    failures.push({
      key: "secrets",
      message: `还有 ${v.missing.length} 个在用项目没有 per-project 凭证、${v.unverifiable.length} 个无法核实`,
      projects: [
        ...v.missing.map((projectId) => ({ projectId, why: "没有 per-project secret" })),
        ...v.unverifiable.map((u) => ({ projectId: u.projectId, why: `无法核实:${u.why}` })),
      ],
    });
  }

  // ②
  const latest = await latestCanaryByProject(targetId);
  const c = canaryPrerequisite(projects, latest, currentEpoch, now);
  if (!c.ok) {
    failures.push({ key: "canary", message: `${c.failing.length} 个在用项目的 canary 不满足(须全 pass、epoch 一致、24 小时内)`, projects: c.failing });
  }

  // ③
  const scan = await (deps.scanArtifacts ?? scanArtifactCredentialsUnavailable)(targetId);
  if (scan.status !== "ok") failures.push({ key: "artifact-scan", message: scan.reason });
  else if (scan.adminArnHits !== 0) {
    failures.push({ key: "artifact-scan", message: `产物里还有 ${scan.adminArnHits} 处该区的 admin secret ARN ⇒ 先重发布清零` });
  }

  // ④
  const fb = await (deps.countFallback7d ?? countCredentialFallback7d)(targetId, now);
  if (fb.status !== "ok") failures.push({ key: "fallback-7d", message: fb.reason });
  else if (fb.count !== 0) failures.push({ key: "fallback-7d", message: `近 7 天仍有 ${fb.count} 次 admin 回落 ⇒ 还有调用面没切到项目身份` });

  return { ok: failures.length === 0 && projects.length > 0, projects, failures: projects.length === 0 ? [...failures, { key: "secrets", message: "没有识别到在用项目 ⇒ 无从证明「全部项目都满足」" }] : failures };
}
