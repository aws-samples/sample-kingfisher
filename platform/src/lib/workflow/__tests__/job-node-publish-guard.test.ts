// 发布 400 三例 + 「不许先发一半」的结构
//   ① sync 节点任务绑别的区 ⇒ buildCarrierArtifact 抛 JobNodeUnbound(nodeType sync);② job 节点作业不绑该区 ⇒ JobNodeUnbound;
//   ③ legacy 引擎 + job 节点 ⇒ 能力门 engine-capability;三者经单一作者 schedulerRejectResponse 都是 **400**;
//   ④ 正向:serverless + 绑了该区的 Glue 作业 ⇒ YAML 里 job task 带 jobSpec(glueJobName / lockAttr / stamp);
//   ⑤ 结构:resolveCarrierPlan(只读)先核落点 / 端点 / 能力门,buildCarrierArtifact 再注 jobSpec 生成;publishWorkflowDag 先把**全部**绑定区核完再发第一个区;
//      就位(写)只在 publishWorkflowDagToTarget,且排在 plan 之后、生成之前;
//   ⑥ 行为:**先拒后写** —— 那个区没装调度器(409)/ legacy 引擎(400)/ 作业不绑该区(400)⇒ 就位阶段的 AWS 客户端工厂一次都没被调(Glue 作业定义 / 脚本一个字节不写);
//      正向对照:判定全过 ⇒ 就位真跑到(工厂被调),且端点解析排在它之前。
// 只 mock 真外部(调度端点 / 落点解析 / DDB / 主控区 / EMR 环境常量 / AWS 客户端工厂)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, Record<string, unknown>>>,
  serverless: true,
  /** 模拟「那个区没装调度器」:schedulerEndpointFor 抛 MwaaNotInstalled */
  mwaaMissing: false,
  /** 调用顺序流水(端点解析 / AWS 客户端工厂) */
  trace: [] as string[],
}));
// ⑥ 的外部边界:AWS 客户端工厂 —— 就位(ensureGlueJob)要先拿 Glue / S3 客户端;工厂被调 = 写阶段开始了。
//   glueClientFor 抛哨兵:正向对照里它证明「就位真跑到了」;反向里它一旦被调就会把拒因换成哨兵 ⇒ 判据必红。
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    glueClientFor: vi.fn(async (region: string) => { h.trace.push(`glueClientFor:${region}`); throw new Error("GLUE_FACTORY_CALLED"); }),
    s3ClientFor: vi.fn(async (region: string) => { h.trace.push(`s3ClientFor:${region}`); return { send: vi.fn(async () => ({})) }; }),
  };
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { input: { TableName: string; Key: Record<string, unknown> } }) => ({ Item: h.rows[cmd.input.TableName]?.[Object.values(cmd.input.Key).map(String).join("|")] }),
    },
  };
});
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "us-east-1" }));
vi.mock("@/lib/engines/emr/provider", () => ({
  S3TABLES_JAR: "s3://x/emr-jars/s3-tables.jar", S3TABLES_WAREHOUSE_ARN: "arn:aws:s3tables:us-east-1:1:bucket/bgp-table-bucket",
  s3LogUri: (jobId: string, bucket?: string) => `s3://${bucket}/emr-logs/${jobId}/`, persistApplicationId: vi.fn(async () => undefined),
}));
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (a: { targetId: string }) => ({ targetId: a.targetId, region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: "arn:aws:secretsmanager:us-west-2:1:secret:x-AbC", degradedToLegacyAdmin: true, home: false })),
    resolveGlueBinding: vi.fn(async (a: { targetId: string }) => ({ targetId: a.targetId, region: "us-west-2", scriptsBucket: "bgp-scripts-tgt-usw2-a", roleArn: "arn:aws:iam::1:role/glue-tgt-usw2-a", datalakeBucket: "bgp-lake-tgt-usw2-a", tableBucket: "bgp-tb-tgt-usw2-a", home: false, jurisdiction: "home" })),
  };
});
vi.mock("@/lib/scheduler/mwaa-endpoint", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    schedulerEndpointFor: vi.fn(async (targetId: string) => {
      h.trace.push(`schedulerEndpointFor:${targetId}`);
      if (h.mwaaMissing) throw new (real.MwaaNotInstalled as new (m: unknown[]) => Error)([{ targetId, region: "us-west-2", reason: "未安装 airflow-serverless" }]);
      return h.serverless
        ? { kind: "serverless", targetId, region: "us-west-2", workflowBucket: "bgp-wf-tgt-usw2-a", home: false }
        : { kind: "mwaa", targetId, region: "us-west-2", envName: "bgp-mwaa-tgt-usw2-a", dagBucket: "bgp-mwaa-dags-tgt-usw2-a", home: false };
    }),
  };
});

const { TABLES } = await import("@/lib/aws/dynamodb");
const { buildCarrierArtifact, publishWorkflowDagToTarget } = await import("@/lib/workflow/publish-dag");
const { MwaaNotInstalled } = await import("@/lib/scheduler/mwaa-endpoint");
const { glueClientFor } = await import("@/lib/exec-env/target-clients");
const { JobNodeUnbound } = await import("@/lib/workflow/job-node-spec");
const { schedulerRejectResponse, fanoutRejection, isTypedRejection } = await import("@/lib/scheduler/fanout-reject");
const { nodesExceedingEngine } = await import("@/lib/workflow/node-registry");
const { glueJobNameFor } = await import("@/lib/etl/glue-job-name");

const USW2 = "tgt_usw2_a";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`export async function ${name}(`);
  expect(i, `找不到 ${name}`).toBeGreaterThan(-1);
  const rest = src.slice(i + 10);
  const nx = rest.search(/\nexport (async )?function |\nexport (const|interface|type) /);
  return rest.slice(0, nx > 0 ? nx : rest.length);
}
const glueJob = (targets: string[]) => ({ userId: "default-user", jobId: "01JOBGLUE000000000000000AB", name: "每日清洗", type: "glue", script: "print('x')", targets, projectId: PROJ, env: "dev", createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "", updatedAt: "" });
const syncTask = (targets: string[]) => ({ userId: "default-user", taskId: "01SYNC000000000000000000AE", name: "订单同步", projectId: PROJ, targets, glueJobName: "bgp-sync-x", sourceTables: ["orders"], targetType: "redshift", status: "ready" });
const wf = (nodes: unknown[]) => ({ userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2], dagDefinition: { nodes, edges: [] }, scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "" }) as never;
const put = (table: string, row: Record<string, unknown>) => {
  h.rows[table] ??= {};
  h.rows[table][`default-user|${String(row.taskId ?? row.jobId)}`] = row;
};

beforeEach(() => { h.rows = {}; h.serverless = true; h.mwaaMissing = false; h.trace = []; vi.mocked(glueClientFor).mockClear(); delete process.env.WORKFLOW_DAG_ENGINE; });

describe("发布 400 三例(事实层:真走 buildCarrierArtifact + 单一作者映射)", () => {
  it("① 同步节点的任务绑在别的区 ⇒ JobNodeUnbound(sync / not-bound)⇒ 400 点名", async () => {
    put(TABLES.SYNC_TASKS, syncTask(["tgt_home"]));
    const e = await buildCarrierArtifact(wf([{ id: "s1", type: "sync", data: { label: "同步订单", syncTaskId: syncTask([]).taskId } }]), USW2).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.nodeType).toBe("sync");
    const r = schedulerRejectResponse(e)!;
    expect(r.status).toBe(400);
    const body = (await r.json()) as { success: boolean; error: { code: string; message: string; nodeId: string; nodeType: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("JOB_NODE_UNBOUND");
    expect(body.error.nodeId).toBe("s1");
    expect(body.error.message).toContain("同步订单");
    expect(body.error.message).toContain("tgt_home");
    expect(body.error.message).toContain(USW2);
  });
  it("② 作业节点的作业不绑该区 ⇒ JobNodeUnbound(job / not-bound)⇒ 400 点名节点与作业", async () => {
    put(TABLES.ETL_JOBS, glueJob(["tgt_home"]));
    const e = await buildCarrierArtifact(wf([{ id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: glueJob([]).jobId } } }]), USW2).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.reason).toBe("not-bound");
    const r = schedulerRejectResponse(e)!;
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { message: string; reason: string; ref: { bound: string[] } } };
    expect(body.error.reason).toBe("not-bound");
    expect(body.error.ref.bound).toEqual(["tgt_home"]);
    expect(body.error.message).toContain("清洗");
    expect(body.error.message).toContain("每日清洗");
    // 扇出聚合不许抹掉类型(instanceof / code 要立得住)
    const agg = fanoutRejection([e], [{ targetId: USW2, ok: false }], "x");
    expect(agg).toBe(e);
    expect(isTypedRejection(e)).toBe(true);
    expect(schedulerRejectResponse(agg)!.status).toBe(400);
  });
  it("③ legacy 引擎 + 作业节点 ⇒ 能力门拒(engine-capability)⇒ 400 指路 runtime-lib", async () => {
    h.serverless = false;
    process.env.WORKFLOW_DAG_ENGINE = "legacy";
    put(TABLES.ETL_JOBS, glueJob([USW2]));
    expect(nodesExceedingEngine([{ type: "job" }], "legacy")).toEqual(["job"]);
    const e = await buildCarrierArtifact(wf([{ id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: glueJob([]).jobId } } }]), USW2).catch((x) => x);
    expect(e.code).toBe("engine-capability");
    expect(e.message).toContain("job");
    expect(e.message).toContain("runtime-lib");
    expect(schedulerRejectResponse(e)!.status).toBe(400);
  });
  it("④ 正向:serverless + 绑了该区的 Glue 作业 ⇒ job task 带 jobSpec(按区 Glue 作业名 / 锁 / 章),python_callable 是 run_node", async () => {
    put(TABLES.ETL_JOBS, glueJob(["tgt_home", USW2]));
    const art = await buildCarrierArtifact(wf([{ id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: glueJob([]).jobId } } }]), USW2);
    expect(art.scheduler).toBe("serverless");
    expect(art.content).toContain('"jobSpec":');
    expect(art.content).toContain(`"glueJobName": "${glueJobNameFor(glueJob([]).jobId, USW2)}"`);
    expect(art.content).toContain('"lockAttr": "runLock-tgt_usw2_a"');
    expect(art.content).toContain('"taskType": "etl-glue"');
    expect(art.content).toContain('"python_callable": "bgp_runtime.run_node"');
    expect(art.content).toMatch(/"stamp":\n\s+"projectId": "proj-01M1KP594D2E6DJQC8EZ8CRAES"\n\s+"targetId": "tgt_usw2_a"/);
    // 没有作业 / 同步节点的工作流:产物不含 jobSpec(零回归)
    const plain = await buildCarrierArtifact(wf([{ id: "q", type: "sql", data: { sql: "SELECT 1" } }]), USW2);
    expect(plain.content).not.toContain("jobSpec");
  });
});

describe("⑤ 结构:先核再生成、先核全部区再发第一个区、就位只在写阶段", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));
  it("resolveCarrierPlan(只读):端点 → 落点 → assertWorkflowNodesRunOn → 服务侧可表达 / 能力门,且不出现就位(写);buildCarrierArtifact 只注 jobSpec 再生成", () => {
    const plan = fnBody(pub, "resolveCarrierPlan");
    const iEp = plan.indexOf("await schedulerEndpointFor(wfTarget)");
    const iAssert = plan.indexOf("await assertWorkflowNodesRunOn(wfBase, wfTarget)");
    const iExpr = plan.indexOf("assertServerlessExpressible(");
    const iCap = plan.indexOf("checkEngineCapability(wfBase, engine)");
    expect(iEp).toBeGreaterThan(-1);
    expect(iAssert).toBeGreaterThan(iEp);
    expect(iExpr).toBeGreaterThan(iAssert);
    expect(iCap).toBeGreaterThan(iAssert);
    expect(plan, "只读的 plan 里不许出现就位(写)").not.toContain("prepareJobNodesForTarget(");
    expect(plan, "只读的 plan 里不许出现注入 jobSpec(那要等写阶段把 application 建好)").not.toContain("withJobSpecs(");
    const body = fnBody(pub, "buildCarrierArtifact");
    const iSpecs = body.indexOf("withJobSpecs(wfBase, await resolveWorkflowJobSpecs(wfBase, wfTarget,");
    expect(iSpecs).toBeGreaterThan(-1);
    for (const gen of ["buildWorkflowTasksYaml({", "generateAirflowDagV2(wfWithDag", "generateAirflowDag(wfWithDag"]) {
      expect(body.indexOf(gen), `${gen} 排在 jobSpec 注入之前`).toBeGreaterThan(iSpecs);
    }
    expect(body, "只读的生成函数里不许出现就位(写)").not.toContain("prepareJobNodesForTarget(");
    expect(body, "plan 缺省才自己核一遍(比对路径),发布路径传 plan 不重复解析").toContain("plan ?? (await resolveCarrierPlan(workflow, wfTarget, opts))");
  });
  it("publishWorkflowDag:全部绑定区先核完(assertWorkflowNodesRunOn 循环)再进逐区发布循环", () => {
    const body = fnBody(pub, "publishWorkflowDag");
    const iPre = body.indexOf("for (const t of list) await assertWorkflowNodesRunOn(workflow, t);");
    const iLoop = body.indexOf("await publishWorkflowDagToTarget(workflow, t, opts)");
    expect(iPre).toBeGreaterThan(-1);
    expect(iLoop).toBeGreaterThan(iPre);
  });
  it("publishWorkflowDagToTarget:resolveCarrierPlan(全部拒因)→ prepareJobNodesForTarget(写)→ buildCarrierArtifact(plan)(生成)", () => {
    const body = fnBody(pub, "publishWorkflowDagToTarget");
    const iPlan = body.indexOf("const plan = await resolveCarrierPlan(workflow, wfTarget, opts);");
    const iPrep = body.indexOf("await prepareJobNodesForTarget(workflow, wfTarget)");
    const iArt = body.indexOf("await buildCarrierArtifact(workflow, wfTarget, opts, plan)");
    expect(iPlan).toBeGreaterThan(-1);
    expect(iPrep).toBeGreaterThan(iPlan);
    expect(iArt).toBeGreaterThan(iPrep);
  });
  it("fanout-reject 只按 code 判 JobNodeUnbound(type-only import,不拖运行期依赖)", () => {
    const fr = read("lib/scheduler/fanout-reject.ts");
    expect(fr).toContain('import type { JobNodeUnbound } from "@/lib/workflow/job-node-spec";');
    expect(fr).toContain('const JOB_NODE_UNBOUND = "JOB_NODE_UNBOUND";');
    expect(new JobNodeUnbound({ nodeId: "n", nodeType: "job", reason: "not-found", ref: {}, targetId: "tgt_home", message: "m" }).code).toBe("JOB_NODE_UNBOUND");
  });
});

describe("⑥ 行为:先拒后写 —— 会被拒的发布在该区一个字节都不写", () => {
  const JOB_NODE = { id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: glueJob([]).jobId } } };
  it("那个区没装调度器 ⇒ MwaaNotInstalled(409)原样抛出,就位阶段的 Glue / S3 客户端工厂一次都没被调", async () => {
    h.mwaaMissing = true;
    put(TABLES.ETL_JOBS, glueJob([USW2]));
    const e = await publishWorkflowDagToTarget(wf([JOB_NODE]), USW2).catch((x) => x);
    expect(e).toBeInstanceOf(MwaaNotInstalled);
    expect(e.message).not.toContain("GLUE_FACTORY_CALLED");
    expect(vi.mocked(glueClientFor)).not.toHaveBeenCalled();
    expect(h.trace.filter((x) => x.startsWith("s3ClientFor"))).toEqual([]);
  });
  it("legacy 引擎 + 作业节点 ⇒ engine-capability(400),就位没跑(工厂没被调)", async () => {
    h.serverless = false;
    process.env.WORKFLOW_DAG_ENGINE = "legacy";
    put(TABLES.ETL_JOBS, glueJob([USW2]));
    const e = await publishWorkflowDagToTarget(wf([JOB_NODE]), USW2).catch((x) => x);
    expect(e.code).toBe("engine-capability");
    expect(vi.mocked(glueClientFor)).not.toHaveBeenCalled();
    expect(h.trace.filter((x) => x.startsWith("s3ClientFor"))).toEqual([]);
  });
  it("作业不绑该区 ⇒ JobNodeUnbound(400),就位没跑", async () => {
    put(TABLES.ETL_JOBS, glueJob(["tgt_home"]));
    const e = await publishWorkflowDagToTarget(wf([JOB_NODE]), USW2).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(vi.mocked(glueClientFor)).not.toHaveBeenCalled();
  });
  it("正向对照:判定全过 ⇒ 就位真跑到(Glue 客户端工厂被调 ⇒ 哨兵抛出),且端点解析排在它之前(证明上面三条的「没被调」不是因为工厂没接上)", async () => {
    put(TABLES.ETL_JOBS, glueJob(["tgt_home", USW2]));
    const e = await publishWorkflowDagToTarget(wf([JOB_NODE]), USW2).catch((x) => x);
    expect(e.message).toBe("GLUE_FACTORY_CALLED");
    expect(vi.mocked(glueClientFor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(glueClientFor).mock.calls[0][0]).toBe("us-west-2");
    const iEp = h.trace.findIndex((x) => x.startsWith("schedulerEndpointFor:"));
    const iGlue = h.trace.findIndex((x) => x.startsWith("glueClientFor:"));
    expect(iEp).toBeGreaterThan(-1);
    expect(iGlue).toBeGreaterThan(iEp);
  });
});
