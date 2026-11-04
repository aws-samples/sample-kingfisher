// 离线作业节点在某个执行区的**就位**(发布的写阶段;与作业「立即运行」做的准备逐项相同)。
//
// 【为什么单独一个文件】`buildCarrierArtifact` 是只读的(判据钉死:里面不许出现任何写),而作业节点要能跑,
//   该区必须先有:Glue 作业定义(`ensureGlueJob`,与「立即运行」同一个作者)/ EMR 的脚本对象 · S3 Tables jar · application
//   (`uploadScript` / `ensureS3TablesJar` / `ensureApplication` / `persistApplicationId`,与 provider.submit 同一组作者)。
//   这些写放在 `publishWorkflowDagToTarget` 里、排在只读生成之前;只读解析(job-node-spec.ts)随后用确定性读法拿到同一个值。
// 🔴 先核再写:三道判定(存在 / 项目 / 绑定)不过就一个字节都不动(`loadJobNodeRow` 抛 JobNodeUnbound ⇒ 400)。
import { ensureGlueJob } from "@/lib/etl/job-service";
import { resolveEmrBinding } from "@/lib/exec-env/data-plane-target";
import { resolveExecutionRoleArn } from "@/lib/execution-role/resolve";
import { preflightExecutionRole, assertPreflightPassed } from "@/lib/execution-role/preflight";
import { ensureApplication, targetEmrNetwork } from "@/lib/engines/emr/application";
import { persistApplicationId, S3TABLES_JAR } from "@/lib/engines/emr/provider";
import { ensureS3TablesJar, uploadScript } from "@/lib/engines/emr/script";
import type { Workflow } from "@/types/workflow";
import { loadJobNodeRow, type WorkflowNodeLike } from "./job-node-spec";

/** 工作流里每个作业节点在 `wfTarget` 上就位;回每个节点做了什么(审计 / 排障用)。没有作业节点 ⇒ 空数组、零写。 */
export async function prepareJobNodesForTarget(
  workflow: Workflow,
  wfTarget: string
): Promise<Array<{ nodeId: string; kind: "etl" | "emr"; jobId: string; prepared: string[] }>> {
  const out: Array<{ nodeId: string; kind: "etl" | "emr"; jobId: string; prepared: string[] }> = [];
  for (const n of (workflow.dagDefinition?.nodes ?? []) as WorkflowNodeLike[]) {
    if (n?.type !== "job") continue;
    const nodeId = String(n.id ?? "");
    const loaded = await loadJobNodeRow(n, workflow, wfTarget);
    if (loaded.kind === "etl") {
      const prepared: string[] = [];
      if (loaded.job.type === "glue") {
        // Glue 作业定义按区建 / 更新(含自定义执行角色预检),与「立即运行」同一个作者 ⇒ 节点跑的 JobRun 名 = 作业自己的按区名
        prepared.push(`glue:${await ensureGlueJob(loaded.job, wfTarget)}`);
      }
      out.push({ nodeId, kind: "etl", jobId: loaded.job.jobId, prepared });
      continue;
    }
    const job = loaded.job;
    const landing = await resolveEmrBinding({ targetId: wfTarget });
    const resolvedRole = resolveExecutionRoleArn({
      custom: job.spec?.executionRoleArn,
      fallback: landing.executionRoleArn,
      missingMessage: `目标 ${wfTarget} 没有 EMR 执行角色(描述符缺 emrExecutionRoleArn)`,
    });
    if (resolvedRole.isCustom) {
      // 自定义角色按该区预检(与 provider.submit / 发布调度同一口径),缺 ⇒ 发布如实失败
      const pf = await preflightExecutionRole({ engine: "emr", roleArn: resolvedRole.roleArn, targetId: wfTarget, scriptCode: job.script });
      assertPreflightPassed(pf, { engine: "emr", roleArn: resolvedRole.roleArn, targetId: wfTarget, what: `workflow-job-node ${job.jobId}` });
    }
    const targetNetwork = await targetEmrNetwork(wfTarget);
    const entryPoint = await uploadScript(job.jobId, job.script, landing);
    await ensureS3TablesJar(landing, S3TABLES_JAR);
    const applicationId = await ensureApplication(job, landing, targetNetwork);
    await persistApplicationId(job, wfTarget, applicationId);
    out.push({ nodeId, kind: "emr", jobId: job.jobId, prepared: [`entryPoint:${entryPoint}`, `application:${applicationId}`] });
  }
  return out;
}
