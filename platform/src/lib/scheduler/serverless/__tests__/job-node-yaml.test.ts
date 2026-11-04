// 序 73 模块 57(57 DESIGN §4)—— workflow-tasks-yaml:job 节点 ⇒ 恰好一个 task,op_kwargs.node.data.jobSpec 齐(字段集合闭合),
// python_callable = bgp_runtime.run_node(语义由 _exec_job 承担);没有 jobSpec 的 job 节点照样生成(运行期如实拒并指路重新发布),jobRef 保留。
import { describe, it, expect } from "vitest";
import { buildWorkflowTasksYaml, START_TASK_ID, FINISH_TASK_ID } from "@/lib/scheduler/serverless/workflow-yaml";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { withJobSpecs } from "@/lib/workflow/job-node-spec";
import { serverlessJobSpecFor } from "@/lib/etl/job-spec";
import { glueJobNameFor } from "@/lib/etl/glue-job-name";
import type { Workflow } from "@/types/workflow";

const USW2 = "tgt_usw2_a";
const PLACE = { targetId: USW2, execRegion: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:redshift!x-AbC" };
const JOB = { userId: "default-user", jobId: "01JOBGLUE000000000000000AB", name: "每日清洗", type: "glue", script: "print('x')", targets: ["tgt_home", USW2], projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES", env: "dev", createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "", updatedAt: "" } as never;
const wf = (nodes: unknown[], edges: unknown[] = []) =>
  ({ workflowId: "wf1", userId: "default-user", name: "t", airflowDagId: "bgp_wf1", projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES", targets: [USW2], dagDefinition: { nodes, edges } }) as unknown as Workflow;
const taskNames = (y: string) => y.split("\n").filter((l) => /^ {4}"[^"]+":$/.test(l)).map((l) => l.trim().replace(/^"|":$/g, ""));

describe("job 节点 → serverless tasks YAML", () => {
  const spec = serverlessJobSpecFor(JOB, USW2, { dagId: "bgp_wf1", endpointRegion: "us-west-2", binding: undefined });
  const nodes = [
    { id: "s1", type: "sync", data: { label: "同步", syncTaskId: "01SYNC000000000000000000AE" } },
    { id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: (JOB as { jobId: string }).jobId } } },
  ];
  const edges = [{ source: "s1", target: "j1" }];
  const dagSpec = buildDagSpec(withJobSpecs(wf(nodes, edges), { j1: spec }), PLACE);
  const y = buildWorkflowTasksYaml({ spec: dagSpec, cron: "0 3 * * *", now: new Date("2026-11-03T00:00:00Z") });

  it("恰好一个 task,依赖上游同步节点,python_callable = run_node", () => {
    expect(taskNames(y)).toEqual([START_TASK_ID, "s1", "j1", FINISH_TASK_ID]);
    const j1 = y.slice(y.indexOf('    "j1":'), y.indexOf(`    "${FINISH_TASK_ID}":`));
    expect(j1).toContain('"python_callable": "bgp_runtime.run_node"');
    expect(j1).toMatch(/"dependencies":\n\s+- "s1"/);
    expect(j1).toContain('"type": "job"');
  });
  it("op_kwargs.node.data.jobSpec 字段齐(与单作业载体 spec 同一字段集合),jobRef 一并保留", () => {
    const node = dagSpec.nodes.find((n) => n.id === "j1")!;
    const js = node.data.jobSpec as Record<string, unknown>;
    expect(Object.keys(js)).toEqual(["engine", "jobId", "dagId", "taskType", "jobsTable", "ctrlRegion", "place", "lockAttr", "stamp", "glueJobName"]);
    expect(js).toEqual(spec);
    expect(node.data.jobRef).toEqual({ kind: "etl", jobId: (JOB as { jobId: string }).jobId });
    for (const frag of ['"jobSpec":', '"engine": "glue"', `"glueJobName": "${glueJobNameFor((JOB as { jobId: string }).jobId, USW2)}"`, '"lockAttr": "runLock-tgt_usw2_a"', '"jobsTable": "bgp-etl-jobs"', '"taskType": "etl-glue"']) {
      expect(y, frag).toContain(frag);
    }
  });
  it("没解析 jobSpec 的 job 节点照样一个 task(运行期 _exec_job 如实拒并指路重新发布);存量三节点图不受影响", () => {
    const y2 = buildWorkflowTasksYaml({ spec: buildDagSpec(wf([nodes[1]]), PLACE), cron: null });
    expect(taskNames(y2)).toEqual([START_TASK_ID, "j1", FINISH_TASK_ID]);
    expect(y2).not.toContain("jobSpec");
    const y3 = buildWorkflowTasksYaml({ spec: buildDagSpec(wf([{ id: "q", type: "sql", data: { sql: "SELECT 1" } }]), PLACE), cron: null });
    expect(y3).not.toContain("jobSpec");
  });
});
