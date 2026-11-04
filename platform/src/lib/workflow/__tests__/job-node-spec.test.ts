// 序 73 模块 57(57 DESIGN §4)—— 离线作业节点的**发布期解析**判据:
//   ① 三拒:作业不存在 / 项目不符 / 不绑该区 ⇒ JobNodeUnbound(code JOB_NODE_UNBOUND,点名节点与作业);
//   ② spec 与单作业载体**逐字段相等**:resolveJobNodeSpec 的产物 === 唯一作者 serverlessJobSpecFor / emrJobSpecFor 用同一组事实算出的那份
//      (dag-fanout / schedule-fanout 调的也是这两个作者 —— 源码字面钉住),字段集合闭合;
//   ③ 同步节点落点一致性(R5 / B-141 ①):任务绑在别的区 ⇒ 拒;任务不存在 ⇒ 拒;
//   ④ 零作业节点 ⇒ 零次 DDB 读、工作流对象原样返回(存量工作流产物不变)。
// 只 mock 真外部(DynamoDB 文档客户端 / 落点解析器 / 主控区 / EMR 环境常量);spec 作者、锁名、Glue 作业名、PlaceWire 全是真实现。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, Record<string, unknown>>>, // table -> key json -> row
  reads: [] as string[],
  inputs: [] as Array<Record<string, unknown>>,
  bindings: {} as Record<string, { region: string; workgroup: string; database: string; secretArn?: string }>,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: { TableName: string; Key: Record<string, unknown> } }) => {
        const t = cmd.input.TableName;
        h.reads.push(t);
        h.inputs.push(cmd.input as unknown as Record<string, unknown>);
        const k = Object.values(cmd.input.Key).map(String).join("|");
        return { Item: h.rows[t]?.[k] };
      },
    },
  };
});
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "us-east-1" }));
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId: string }) => {
      const b = h.bindings[args.targetId];
      if (!b) throw new Error(`no redshift binding for ${args.targetId}`);
      return { targetId: args.targetId, ...b, degradedToLegacyAdmin: true, home: args.targetId === "tgt_home" };
    }),
    resolveEmrBinding: vi.fn(async (args: { targetId: string }) => ({
      targetId: args.targetId,
      region: args.targetId === "tgt_home" ? "us-east-1" : "us-west-2",
      scriptsBucket: `bgp-scripts-${args.targetId}`,
      roleArn: `arn:aws:iam::1:role/glue-${args.targetId}`,
      datalakeBucket: `bgp-lake-${args.targetId}`,
      tableBucket: `bgp-tb-${args.targetId}`,
      home: args.targetId === "tgt_home",
      jurisdiction: "home",
      executionRoleArn: `arn:aws:iam::1:role/emr-${args.targetId}`,
    })),
  };
});
vi.mock("@/lib/engines/emr/provider", () => ({
  S3TABLES_JAR: "s3://bgp-glue-scripts-x/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar",
  S3TABLES_WAREHOUSE_ARN: "arn:aws:s3tables:us-east-1:1:bucket/bgp-table-bucket",
  s3LogUri: (jobId: string, bucket?: string) => `s3://${bucket}/emr-logs/${jobId}/`,
  persistApplicationId: vi.fn(async () => undefined),
}));

const { TABLES } = await import("@/lib/aws/dynamodb");
const { JobNodeUnbound, resolveJobNodeSpec, resolveWorkflowJobSpecs, withJobSpecs, assertWorkflowNodesRunOn, jobRefOf } = await import("@/lib/workflow/job-node-spec");
const { serverlessJobSpecFor } = await import("@/lib/etl/job-spec");
const { emrJobSpecFor, emrSparkSubmitParametersFor } = await import("@/lib/engines/emr/job-spec");
const { entryPointUri, s3TablesJarUriFor } = await import("@/lib/engines/emr/script");
const { glueJobNameFor } = await import("@/lib/etl/glue-job-name");
const { lockAttrFor } = await import("@/lib/etl/run-lock");
const { splitSql } = await import("@/lib/etl/dag-generator");

const USW2 = "tgt_usw2_a";
const HOME = "tgt_home";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/** 真落库形态(照 api/etl-jobs POST 的 item 抄键集;不多不少)。 */
const glueJob = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", jobId: "01JOBGLUE000000000000000AB", name: "每日清洗", type: "glue", script: "print('x')",
  glueConfig: { workerType: "G.1X", numberOfWorkers: 2 }, targets: [HOME, USW2], projectId: PROJ, env: "dev",
  createdBy: "u", createdBySub: "sub", status: "ready", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over,
});
const rsJob = (over: Record<string, unknown> = {}) => ({
  ...glueJob({ jobId: "01JOBRS00000000000000000AC", name: "汇总", type: "redshift", script: "DROP TABLE IF EXISTS t;\nCREATE TABLE t AS SELECT 1;", glueConfig: undefined, redshiftConfig: { database: "dev" } }), ...over,
});
const emrJob = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", jobId: "01JOBEMR0000000000000000AD", engine: "emr-serverless", name: "spark-roi", projectId: PROJ, env: "dev",
  script: "spark.table('x')", status: "ready", createdBy: "u", createdBySub: "sub", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  spec: { releaseLabel: "emr-spark-8.0.0", architecture: "ARM64", driver: { cpu: "2 vCPU", memory: "4 GB" }, executor: { cpu: "2 vCPU", memory: "4 GB", count: 2 }, maxExecutors: 10 },
  network: { subnetIds: [], securityGroupIds: [] }, entryPointArguments: ["--a", "1"], sparkConf: { "spark.sql.shuffle.partitions": "8" },
  targets: [USW2], applicationIdByTarget: { [USW2]: "00fabcd1234567890" }, ...over,
});
const syncTask = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: "01SYNC000000000000000000AE", name: "订单同步", projectId: PROJ, targets: [USW2], glueJobName: "bgp-sync-x",
  sourceTables: ["orders"], targetType: "redshift", status: "ready", createdAt: "", updatedAt: "", ...over,
});
const node = (id: string, data: Record<string, unknown>, type = "job") => ({ id, type, data: { label: `节点 ${id}`, ...data } });
const wf = (nodes: unknown[], over: Record<string, unknown> = {}) =>
  ({ userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2], dagDefinition: { nodes, edges: [] }, scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "", ...over }) as never;
const put = (table: string, row: Record<string, unknown>) => {
  h.rows[table] ??= {};
  const key = table === TABLES.SYNC_TASKS ? `default-user|${row.taskId}` : table === TABLES.WORKFLOWS ? `default-user|${row.workflowId}` : `default-user|${row.jobId}`;
  h.rows[table][key] = row;
};
const CTX = { dagId: "bgp_wf1", execRegion: "us-west-2" };

beforeEach(() => {
  h.rows = {};
  h.reads = [];
  h.inputs = [];
  h.bindings = {
    [HOME]: { region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:1:secret:home-AbC" },
    [USW2]: { region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: "arn:aws:secretsmanager:us-west-2:1:secret:usw2-AbC" },
  };
});

describe("① 三拒(发布期 fail-closed,点名节点与作业)", () => {
  it("作业不存在 ⇒ not-found", async () => {
    const e = await resolveJobNodeSpec(node("n1", { jobRef: { kind: "etl", jobId: "01NOPE00000000000000000AA" } }), USW2, PROJ, CTX).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.code).toBe("JOB_NODE_UNBOUND");
    expect(e.reason).toBe("not-found");
    expect(e.nodeId).toBe("n1");
    expect(e.message).toContain("节点 n1");
    expect(e.message).toContain("01NOPE00000000000000000AA");
  });
  it("项目不符 ⇒ project-mismatch(作业属于别的项目)", async () => {
    put(TABLES.ETL_JOBS, glueJob({ projectId: "proj-OTHER0000000000000000AF" }));
    const e = await resolveJobNodeSpec(node("n1", { jobRef: { kind: "etl", jobId: glueJob().jobId } }), USW2, PROJ, CTX).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.reason).toBe("project-mismatch");
    expect(e.message).toContain("每日清洗");
    expect(e.message).toContain(PROJ);
  });
  it("不绑该区 ⇒ not-bound(原话点名作业名、它绑的区、工作流要发的区)", async () => {
    put(TABLES.ETL_JOBS, glueJob({ targets: [HOME] }));
    const e = await resolveJobNodeSpec(node("n1", { jobRef: { kind: "etl", jobId: glueJob().jobId } }), USW2, PROJ, CTX).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.reason).toBe("not-bound");
    expect(e.ref).toEqual({ kind: "etl", jobId: glueJob().jobId, bound: [HOME] });
    expect(e.message).toContain("每日清洗");
    expect(e.message).toContain("tgt_home");
    expect(e.message).toContain(USW2);
    expect(e.message).toContain("已拒绝发布");
  });
  it("未关联 / kind 不在闭合清单 ⇒ missing-ref;EMR 引用指到非 emr-serverless 行 ⇒ kind-mismatch", async () => {
    expect((await resolveJobNodeSpec(node("n1", {}), USW2, PROJ, CTX).catch((x) => x)).reason).toBe("missing-ref");
    expect((await resolveJobNodeSpec(node("n1", { jobRef: { kind: "flink", jobId: "x" } }), USW2, PROJ, CTX).catch((x) => x)).reason).toBe("missing-ref");
    expect(jobRefOf({ data: { jobRef: { kind: "emr", jobId: " " } } })).toBeNull();
    put(TABLES.ENGINE_JOBS, emrJob({ engine: "flink" }));
    expect((await resolveJobNodeSpec(node("n1", { jobRef: { kind: "emr", jobId: emrJob().jobId } }), USW2, PROJ, CTX).catch((x) => x)).reason).toBe("kind-mismatch");
  });
  it("EMR 作业在该区还没 application ⇒ not-prepared(只读路径不替它建)", async () => {
    put(TABLES.ENGINE_JOBS, emrJob({ applicationIdByTarget: {} }));
    const e = await resolveJobNodeSpec(node("n1", { jobRef: { kind: "emr", jobId: emrJob().jobId } }), USW2, PROJ, CTX).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.reason).toBe("not-prepared");
  });
});

describe("② spec 与单作业载体逐字段相等(同一个 spec 作者)", () => {
  it("Glue 作业:=== serverlessJobSpecFor 同事实产物;按区 Glue 作业名 / 锁属性 / 章 / 台账表都对;字段集合闭合", async () => {
    const job = glueJob();
    put(TABLES.ETL_JOBS, job);
    const got = await resolveJobNodeSpec(node("n1", { jobRef: { kind: "etl", jobId: job.jobId } }), USW2, PROJ, CTX);
    const expected = serverlessJobSpecFor(job as never, USW2, { dagId: "bgp_wf1", endpointRegion: "us-west-2", binding: undefined });
    expect(got).toEqual(expected);
    expect(got.glueJobName).toBe(glueJobNameFor(job.jobId, USW2));
    expect(got.lockAttr).toBe(lockAttrFor({ targetId: USW2 }));
    expect(got.stamp).toEqual({ projectId: PROJ, targetId: USW2 });
    expect(got.taskType).toBe("etl-glue");
    expect(got.jobsTable).toBe(TABLES.ETL_JOBS);
    expect(got.ctrlRegion).toBe("us-east-1");
    expect(got.place).toEqual({ v: 1, targetId: USW2, region: "us-west-2" });
    expect(Object.keys(got)).toEqual(["engine", "jobId", "dagId", "taskType", "jobsTable", "ctrlRegion", "place", "lockAttr", "stamp", "glueJobName"]);
  });
  it("Redshift 作业:语句经唯一切分作者;数仓腿来自该区绑定(不是主控区)", async () => {
    const job = rsJob();
    put(TABLES.ETL_JOBS, job);
    const got = await resolveJobNodeSpec(node("n2", { jobRef: { kind: "etl", jobId: job.jobId } }), USW2, PROJ, CTX);
    const expected = serverlessJobSpecFor(job as never, USW2, { dagId: "bgp_wf1", endpointRegion: "us-west-2", binding: { ...h.bindings[USW2] } });
    expect(got).toEqual(expected);
    expect(got.statements).toEqual(splitSql(job.script));
    expect(got.statements?.length).toBe(2);
    expect(got.place).toEqual({ v: 1, targetId: USW2, region: "us-west-2", redshift: { workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev", secretArn: h.bindings[USW2].secretArn } });
    expect(got.taskType).toBe("etl-redshift");
    expect(Object.keys(got)).toEqual(["engine", "jobId", "dagId", "taskType", "jobsTable", "ctrlRegion", "place", "lockAttr", "stamp", "statements"]);
  });
  it("EMR 作业:=== emrJobSpecFor 同事实产物;application 取该区的、entryPoint / jar / spark 参数走确定性读法", async () => {
    const job = emrJob();
    put(TABLES.ENGINE_JOBS, job);
    const got = await resolveJobNodeSpec(node("n3", { jobRef: { kind: "emr", jobId: job.jobId } }), USW2, PROJ, CTX);
    const landing = { targetId: USW2, region: "us-west-2", scriptsBucket: `bgp-scripts-${USW2}`, roleArn: "r", datalakeBucket: `bgp-lake-${USW2}`, tableBucket: `bgp-tb-${USW2}`, home: false };
    const expected = emrJobSpecFor(job as never, USW2, {
      dagId: "bgp_wf1", region: "us-west-2", applicationId: "00fabcd1234567890", executionRoleArn: `arn:aws:iam::1:role/emr-${USW2}`,
      entryPoint: entryPointUri(job.jobId, landing),
      sparkSubmitParameters: emrSparkSubmitParametersFor(job as never, landing, s3TablesJarUriFor(landing, "s3://bgp-glue-scripts-x/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar"), { redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a", redshiftDatabase: "dev", redshiftSecretArn: h.bindings[USW2].secretArn }),
      logUri: `s3://bgp-lake-${USW2}/emr-logs/${job.jobId}/`, runName: "spark-roi-wf",
    });
    expect(got).toEqual(expected);
    expect(got.engine).toBe("emr");
    expect(got.taskType).toBe("emr-serverless");
    expect(got.jobsTable).toBe(TABLES.ENGINE_JOBS);
    expect(got.entryPoint).toBe(`s3://bgp-scripts-${USW2}/emr-scripts/${job.jobId}.py`);
    expect(got.sparkSubmitParameters).toContain(`s3://bgp-scripts-${USW2}/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar`);
    expect(got.sparkSubmitParameters).toContain(`arn:aws:s3tables:us-west-2:${process.env.AWS_ACCOUNT_ID}:bucket/bgp-tb-${USW2}`);
    expect(got.entryPointArguments).toEqual(["--a", "1"]);
    expect(Object.keys(got)).toEqual(["engine", "jobId", "dagId", "taskType", "jobsTable", "ctrlRegion", "place", "lockAttr", "stamp", "applicationId", "executionRoleArn", "entryPoint", "entryPointArguments", "sparkSubmitParameters", "logUri", "runName"]);
  });
  it("🔴 单作业载体(dag-fanout / schedule-fanout)调的就是这两个作者,spec 字面量不许再出现第二份", () => {
    const fan = strip(read("lib/etl/dag-fanout.ts"));
    expect(fan).toContain("serverlessJobSpecFor(job, targetId, {");
    expect(fan, "dag-fanout 里又出现了 spec 字面量(taskType: `etl-…`)").not.toMatch(/taskType:\s*`etl-\$\{job\.type\}`/);
    const emr = strip(read("lib/engines/emr/schedule-fanout.ts"));
    expect(emr).toContain("emrJobSpecFor(job, targetId, {");
    expect(emr, "schedule-fanout 里又出现了 spec 字面量(taskType: \"emr-serverless\")").not.toMatch(/taskType:\s*"emr-serverless"/);
    const author = strip(read("lib/workflow/job-node-spec.ts"));
    expect(author).toContain("serverlessJobSpecFor(job, wfTarget, {");
    expect(author).toContain("emrJobSpecFor(job, wfTarget, {");
  });
});

describe("③ 同步 / 作业节点的发布期落点一致性(assertWorkflowNodesRunOn)", () => {
  it("同步任务绑在别的区 ⇒ JobNodeUnbound(nodeType sync · not-bound · 原话点名任务与两边的区)", async () => {
    put(TABLES.SYNC_TASKS, syncTask({ targets: [HOME] }));
    const e = await assertWorkflowNodesRunOn(wf([node("s1", { syncTaskId: syncTask().taskId }, "sync")]), USW2).catch((x) => x);
    expect(e).toBeInstanceOf(JobNodeUnbound);
    expect(e.nodeType).toBe("sync");
    expect(e.reason).toBe("not-bound");
    expect(e.ref).toEqual({ syncTaskId: syncTask().taskId, bound: [HOME] });
    expect(e.message).toContain("订单同步");
    expect(e.message).toContain(USW2);
  });
  it("同步任务不存在 ⇒ not-found;绑了该区 ⇒ 放行;作业节点同一入口核三道", async () => {
    expect((await assertWorkflowNodesRunOn(wf([node("s1", { syncTaskId: "01GONE00000000000000000AG" }, "sync")]), USW2).catch((x) => x)).reason).toBe("not-found");
    put(TABLES.SYNC_TASKS, syncTask());
    put(TABLES.ETL_JOBS, glueJob());
    await expect(assertWorkflowNodesRunOn(wf([node("s1", { syncTaskId: syncTask().taskId }, "sync"), node("j1", { jobRef: { kind: "etl", jobId: glueJob().jobId } })]), USW2)).resolves.toBeUndefined();
    await expect(assertWorkflowNodesRunOn(wf([node("j1", { jobRef: { kind: "etl", jobId: glueJob().jobId } })]), "tgt_euw1_a")).rejects.toMatchObject({ reason: "not-bound" });
  });
});

describe("④ 注入与零回归", () => {
  it("没有作业节点 ⇒ 零次 DDB 读、工作流对象原样返回(存量产物逐字节不变)", async () => {
    const w = wf([node("q", { sql: "SELECT 1" }, "sql")]);
    const specs = await resolveWorkflowJobSpecs(w, USW2, CTX);
    expect(specs).toEqual({});
    expect(h.reads).toEqual([]);
    expect(withJobSpecs(w, specs)).toBe(w);
  });
  it("withJobSpecs 只给作业节点挂 jobSpec,其余节点与边不动", async () => {
    put(TABLES.ETL_JOBS, glueJob());
    const w = wf([node("q", { sql: "SELECT 1" }, "sql"), node("j1", { jobRef: { kind: "etl", jobId: glueJob().jobId } })], { dagDefinition: { nodes: [node("q", { sql: "SELECT 1" }, "sql"), node("j1", { jobRef: { kind: "etl", jobId: glueJob().jobId } })], edges: [{ source: "q", target: "j1" }] } });
    const specs = await resolveWorkflowJobSpecs(w, USW2, CTX);
    const out = withJobSpecs(w, specs) as unknown as { dagDefinition: { nodes: Array<{ id: string; data: Record<string, unknown> }>; edges: unknown[] } };
    expect(out.dagDefinition.nodes[0].data).toEqual({ label: "节点 q", sql: "SELECT 1" });
    expect((out.dagDefinition.nodes[1].data.jobSpec as { glueJobName: string }).glueJobName).toBe(glueJobNameFor(glueJob().jobId, USW2));
    expect(out.dagDefinition.nodes[1].data.jobRef).toEqual({ kind: "etl", jobId: glueJob().jobId });
    expect(out.dagDefinition.edges).toEqual([{ source: "q", target: "j1" }]);
  });
});

describe("⑤ 读作业 / 同步任务行必须强一致(ConsistentRead)", () => {
  it("ETL 作业行 / EMR 作业行 / 同步任务行三条 GetCommand 都带 ConsistentRead: true(首次发布时 persistApplicationId 刚 UpdateItem 过这一行,紧接着的读要读到自己的写)", async () => {
    put(TABLES.ETL_JOBS, glueJob());
    put(TABLES.ENGINE_JOBS, emrJob());
    put(TABLES.SYNC_TASKS, syncTask());
    await assertWorkflowNodesRunOn(
      wf([
        node("j1", { jobRef: { kind: "etl", jobId: glueJob().jobId } }),
        node("j2", { jobRef: { kind: "emr", jobId: emrJob().jobId } }),
        node("s1", { syncTaskId: syncTask().taskId }, "sync"),
      ]),
      USW2
    );
    const byTable = Object.fromEntries(h.inputs.map((i) => [String(i.TableName), i]));
    for (const t of [TABLES.ETL_JOBS, TABLES.ENGINE_JOBS, TABLES.SYNC_TASKS]) {
      expect(byTable[t], `没读 ${t}`).toBeTruthy();
      expect(byTable[t].ConsistentRead, `${t} 的 GetCommand 不是强一致读`).toBe(true);
    }
    expect(h.inputs.every((i) => i.ConsistentRead === true)).toBe(true);
    expect(h.inputs.length).toBe(3);
  });
});
