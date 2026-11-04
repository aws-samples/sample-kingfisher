// @kf-batch 50-WP15-airflow-serverless
// serverless 发布 / 下线的**唯一**入口(扇出分路调它;SPEC v3.27 §3.15)。产物落该 target 的 workflowBucket:
//   dags/<dagId>.yaml(定义)+ code/bgp_runtime-<ver>.zip(运行时 Code 包 = **zip,模块 bgp_runtime.py 在根**;版本哈希进 key ⇒ 改运行时 = 新对象)。
//   🔴 T-11:裸 .py 会让 CreateWorkflow 成功、cron 照触发,而每个 run 死于 ModuleNotFoundError(见 code-package.ts 文件头)。
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import type { ServerlessEndpoint } from "@/lib/scheduler/mwaa-endpoint";
import { BGP_RUNTIME_VERSION } from "./runtime-py";
// @kf-batch 50-WP15-airflow-serverless(T-11):Code 包 = zip(模块在根)—— 唯一作者 code-package.ts
import { BGP_RUNTIME_S3_KEY, BGP_RUNTIME_ZIP } from "./code-package";
import { buildWorkflowYaml, type ServerlessJobSpec } from "./yaml-generator";
import { deleteWorkflow, ensureWorkflow } from "./workflow-client";

export interface ServerlessPublishResult {
  workflowArn: string;
  workflowVersion: string;
  workflowName: string;
  definitionKey: string;
  codeKey: string;
  runtimeVersion: string;
  created: boolean;
}

export function definitionKeyOf(dagId: string): string {
  return `dags/${dagId}.yaml`;
}

export async function publishServerlessWorkflow(args: {
  ep: ServerlessEndpoint;
  dagId: string;
  /** 单作业路径:cron + spec ⇒ 这里现建 YAML(逐字节不变) */
  cron?: string;
  spec?: ServerlessJobSpec;
  /**
   * @kf-batch 50-WP17-serverless-workflow
   * 多节点编排路径:YAML **已经建好**(`buildWorkflowTasksYaml`)。
   * 🔴 与 `spec` 二选一:两个都给 = 调用方自己都不知道发的是哪一份 ⇒ 直接抛。
   */
  definitionYaml?: string;
  triggerMode?: "scheduled" | "manual_only" | "disabled";
  existingArn?: string;
  description?: string;
}): Promise<ServerlessPublishResult> {
  const { ep, dagId, cron, spec } = args;
  if (!!args.definitionYaml === !!spec) {
    throw new Error("publishServerlessWorkflow:cron+spec(单作业)与 definitionYaml(多节点编排)必须给且只给一个");
  }
  const yaml = args.definitionYaml ?? buildWorkflowYaml({ dagId, cron: cron as string, spec: spec as ServerlessJobSpec });
  const s3 = await s3ClientFor(ep.region);
  const definitionKey = definitionKeyOf(dagId);
  // 运行时先落(幂等:同版本同 key 覆盖同内容),再落定义
  await s3.send(new PutObjectCommand({ Bucket: ep.workflowBucket, Key: BGP_RUNTIME_S3_KEY, Body: BGP_RUNTIME_ZIP, ContentType: "application/zip" }));
  await s3.send(new PutObjectCommand({ Bucket: ep.workflowBucket, Key: definitionKey, Body: yaml, ContentType: "application/x-yaml" }));
  const r = await ensureWorkflow({
    region: ep.region,
    name: dagId,
    existingArn: args.existingArn,
    definition: { bucket: ep.workflowBucket, key: definitionKey },
    code: { bucket: ep.workflowBucket, key: BGP_RUNTIME_S3_KEY },
    roleArn: ep.roleArn,
    network: { subnetIds: ep.subnetIds, securityGroupIds: [ep.sgId] },
    triggerMode: args.triggerMode ?? "scheduled",
    description: args.description,
  });
  return { ...r, definitionKey, codeKey: BGP_RUNTIME_S3_KEY, runtimeVersion: BGP_RUNTIME_VERSION };
}

/** 下线 = Stop 在跑 run + DeleteWorkflow + 删定义对象(§3.12 语义:不再触发 + 无残留)。 */
export async function offlineServerlessWorkflow(args: { ep: ServerlessEndpoint; dagId: string; workflowArn?: string }): Promise<{ deleted: boolean; dagFileDeleted: boolean; stoppedRuns: number }> {
  let deleted = false;
  let stoppedRuns = 0;
  if (args.workflowArn) {
    const r = await deleteWorkflow(args.ep.region, args.workflowArn);
    deleted = r.deleted;
    stoppedRuns = r.stoppedRuns;
  }
  let dagFileDeleted = false;
  try {
    const s3 = await s3ClientFor(args.ep.region);
    await s3.send(new DeleteObjectCommand({ Bucket: args.ep.workflowBucket, Key: definitionKeyOf(args.dagId) }));
    dagFileDeleted = true;
  } catch {
    /* 不存在视为已删 */
  }
  return { deleted, dagFileDeleted, stoppedRuns };
}
