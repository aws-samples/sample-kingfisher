// 序 38 B-68 —— 建 / 更新 Glue 同步作业的装配层判据(唯一作者 ensureGlueSyncJob,真客户端序列)。
//
// 【缺陷原形(2026-10-13 客户生产环境)】作业已存在而定义有变(改 Glue 版本 / 改目标表桶 ⇒ --conf 变)时,
//   原实现「先 CreateJob,报 already exists 才 UpdateJob」撞上 Glue 的 IdempotentParameterMismatchException
//   「Job already submitted with different configuration」⇒ 不含 already exists ⇒ 落进「最小参数重建」再撞同一错 ⇒ 保存 502 / 启动 500;
//   定义没变时 UpdateJob 失败又被 `catch {}` 吞掉 ⇒ 页面说保存成功、作业还是旧的。
// 【规则】GetJob 判存在 ⇒ 存在就 UpdateJob(失败如实上抛);不存在才 CreateJob;CreateJob 撞「已存在 / 幂等不匹配」⇒ 走 UpdateJob;
//   GetJob 的权限 / 限流错不许当「不存在」;不再有「最小参数重建」。
// 【只 mock 真外部】按区 SDK 客户端工厂、落点解析。lib/sync 兄弟模块(脚本生成 / 标识符 / 版本)不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GOLDEN_SHAPES } from "./golden-shapes";
import { GLUE_VERSION_FOR_UNVERSIONED_RECORDS, GLUE_SYNC_SPARK4_COMPAT_CONF } from "@/lib/sync/glue-version";
import "@aws-sdk/client-glue";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const calls: Call[] = [];
const S = vi.hoisted(() => ({
  jobExists: true,
  getJobError: "" as string,          // 非空 ⇒ GetJob 抛这个 name 的错(EntityNotFoundException 以外的)
  createError: "" as string,          // 非空 ⇒ CreateJob 抛这个 name 的错
  createMessage: "" as string,
  updateError: "" as string,          // 非空 ⇒ UpdateJob 抛这个 name 的错
}));

const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/target-clients")>();
  const get = (svc: string) => async () => clients[svc];
  return { ...actual, glueClientFor: get("glue"), s3ClientFor: get("s3"), s3tablesClientFor: get("s3tables"), logsClientFor: get("logs") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec-env/data-plane-target")>();
  return {
    ...actual,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
    resolveRedshiftBinding: vi.fn(async () => ({ targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:rs-AbC" })),
  };
});
vi.mock("@/lib/openmetadata/om-push", () => ({ pushSyncToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-sync-backfill", () => ({ backfillSyncOmAfterSuccess: vi.fn(async () => {}) }));
vi.mock("@/lib/scheduler/dependency", () => ({ fireDownstreamOnce: vi.fn(async () => {}) }));

import { ensureGlueSyncJob } from "@/lib/sync/start-run";
import { isGlueJobAlreadyThere } from "@/lib/aws/glue-job-upsert";
import type { DataSource } from "@/types/datasource";

function err(name: string, message: string) { const e = new Error(message); e.name = name; return e; }

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "GetJobCommand") {
        if (S.getJobError) throw err(S.getJobError, "denied");
        if (!S.jobExists) throw err("EntityNotFoundException", `Job with name: ${input.JobName} not found`);
        return { Job: { Name: input.JobName, GlueVersion: "5.0" } };
      }
      if (svc === "glue" && n === "CreateJobCommand") {
        if (S.createError) throw err(S.createError, S.createMessage || "create failed");
        return { Name: input.Name };
      }
      if (svc === "glue" && n === "UpdateJobCommand") {
        if (S.updateError) throw err(S.updateError, "Role arn:aws:iam::123456789012:role/bgp-glue-role is not passable");
        return { JobName: input.JobName };
      }
      if (svc === "s3tables" && n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
      if (svc === "s3tables" && n === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
      return {};
    }),
  };
}

const ds = { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), glueConnectionName: "bgp-conn-mysql" } as unknown as DataSource;
const TASK_ID = "01TASKUPSERT0000000A1";
const task = (over: Record<string, unknown> = {}) => ({
  userId: "default-user", taskId: TASK_ID, name: "players-s3", datasourceId: "ds_mysql",
  channel: "glue", syncMode: "full", writeMode: "append", targetType: "s3-tables",
  sourceDatabase: "gamedb", sourceTables: ["players"], s3Config: { namespace: "gamedb" }, projectId: "default",
  glueConfig: { glueVersion: "5.1", numberOfWorkers: 4, workerType: "G.2X" },
  ...over,
});
const glue = (cmd: string) => calls.filter((c) => c.svc === "glue" && c.cmd === cmd);
const jobCmds = () => calls.filter((c) => c.svc === "glue" && c.cmd.endsWith("JobCommand")).map((c) => c.cmd);

beforeEach(() => {
  calls.length = 0;
  S.jobExists = true; S.getJobError = ""; S.createError = ""; S.createMessage = ""; S.updateError = "";
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
});

describe("🔴 B-68 ensureGlueSyncJob:建 / 更新作业", () => {
  it("作业已存在 ⇒ GetJob → UpdateJob,**不调 CreateJob**;JobUpdate 带任务当前的 GlueVersion / Worker / --conf 里的表桶", async () => {
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(jobCmds()).toEqual(["GetJobCommand", "UpdateJobCommand"]);
    const upd = glue("UpdateJobCommand")[0].input.JobUpdate as Record<string, any>;
    expect(upd).toMatchObject({ GlueVersion: "5.1", NumberOfWorkers: 4, WorkerType: "G.2X", Connections: { Connections: ["bgp-conn-mysql"] } });
    expect(String(upd.DefaultArguments["--conf"])).toContain("s3tablescatalog/bgp-table-bucket");
    expect(String(upd.DefaultArguments["--conf"])).toContain("arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket");
  });
  it("作业不存在 ⇒ GetJob(EntityNotFound)→ CreateJob,不调 UpdateJob;CreateJob 带完整 --conf(没有「最小参数」那一版)", async () => {
    S.jobExists = false;
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(jobCmds()).toEqual(["GetJobCommand", "CreateJobCommand"]);
    const created = glue("CreateJobCommand")[0].input as Record<string, any>;
    expect(created.Name).toBe(`bgp-sync-${TASK_ID.slice(-12)}`);
    expect(String(created.DefaultArguments["--conf"])).toContain("spark.sql.catalog.s3tablescatalog.warehouse=");
  });
  it("GetJob 说不存在、CreateJob 却回 IdempotentParameterMismatchException(定义不同的同名作业刚被建出)⇒ 按已存在走 UpdateJob,成功", async () => {
    S.jobExists = false; S.createError = "IdempotentParameterMismatchException"; S.createMessage = "Job already submitted with different configuration";
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(jobCmds()).toEqual(["GetJobCommand", "CreateJobCommand", "UpdateJobCommand"]);
  });
  it("CreateJob 回 AlreadyExistsException ⇒ 同样走 UpdateJob", async () => {
    S.jobExists = false; S.createError = "AlreadyExistsException"; S.createMessage = "Job already exists";
    const r = await ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok).toBe(true);
    expect(jobCmds()).toEqual(["GetJobCommand", "CreateJobCommand", "UpdateJobCommand"]);
  });
  it("UpdateJob 失败 ⇒ **如实上抛**(name / message 原样),不再被吞成「成功」", async () => {
    S.updateError = "InvalidInputException";
    await expect(ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" }))
      .rejects.toMatchObject({ name: "InvalidInputException", message: expect.stringContaining("not passable") });
    expect(jobCmds()).toEqual(["GetJobCommand", "UpdateJobCommand"]);
  });
  it("CreateJob 因别的原因失败(AccessDeniedException)⇒ 原样抛,不做「最小参数重建」第二次 CreateJob", async () => {
    S.jobExists = false; S.createError = "AccessDeniedException"; S.createMessage = "not authorized";
    await expect(ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" })).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(glue("CreateJobCommand")).toHaveLength(1);
    expect(glue("UpdateJobCommand")).toHaveLength(0);
  });
  it("GetJob 因权限 / 限流失败 ⇒ 原样抛,不许把「没查到」当「不存在」去 CreateJob", async () => {
    S.getJobError = "AccessDeniedException";
    await expect(ensureGlueSyncJob({ task: task(), taskId: TASK_ID, ds, tid: "tgt_home" })).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(jobCmds()).toEqual(["GetJobCommand"]);
  });
  it("「作业已经在了」判别清单:AlreadyExists / IdempotentParameterMismatch / 两种 Glue 原话 ⇒ 真;AccessDenied / 空 ⇒ 假", () => {
    expect(isGlueJobAlreadyThere(err("AlreadyExistsException", "x"))).toBe(true);
    expect(isGlueJobAlreadyThere(err("IdempotentParameterMismatchException", "x"))).toBe(true);
    expect(isGlueJobAlreadyThere(new Error("Job already exists"))).toBe(true);
    expect(isGlueJobAlreadyThere(new Error("Job already submitted with different configuration"))).toBe(true);
    expect(isGlueJobAlreadyThere(err("AccessDeniedException", "not authorized"))).toBe(false);
    expect(isGlueJobAlreadyThere(undefined)).toBe(false);
  });
});

describe("🔴 B-69 ensureGlueSyncJob 处的 fail-closed:写 S3 Tables 的任务 Glue 版本 < 5.1 ⇒ 400,零 Glue 作业调用", () => {
  it("glueVersion 5.0 + s3-tables ⇒ ok=false / 400 / 说明含 5.1;不写脚本、不建 / 更新作业", async () => {
    const r = await ensureGlueSyncJob({ task: task({ glueConfig: { glueVersion: "5.0" } }), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.message).toContain("5.1"); }
    expect(jobCmds()).toEqual([]);
    expect(calls.filter((c) => c.svc === "s3" && c.cmd === "PutObjectCommand")).toHaveLength(0);
  });
  it("glueVersion 5.0 + 只写 Redshift ⇒ 放行(不限版本)", async () => {
    const r = await ensureGlueSyncJob({ task: task({ glueConfig: { glueVersion: "5.0" }, targetType: "redshift", redshiftConfig: { schema: "public" } }), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((glue("UpdateJobCommand")[0].input.JobUpdate as Record<string, unknown>).GlueVersion).toBe("5.0");
  });
  it("🔴 序 53:记录里不带 glueVersion 的存量任务 ⇒ 按它被写下时的缺省 5.1 跑(不跟新缺省 6.0 走,升级不改存量任务);作业定义不带 Spark 4 兼容开关", async () => {
    const r = await ensureGlueSyncJob({ task: task({ glueConfig: {} }), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok).toBe(true);
    const upd = glue("UpdateJobCommand")[0].input.JobUpdate as Record<string, any>;
    expect(upd.GlueVersion).toBe(GLUE_VERSION_FOR_UNVERSIONED_RECORDS);
    expect(GLUE_VERSION_FOR_UNVERSIONED_RECORDS).toBe("5.1");
    expect(String(upd.DefaultArguments["--conf"])).not.toContain("spark.sql.ansi.enabled");
    expect(String(upd.DefaultArguments["--conf"])).not.toContain("spark.sql.legacy.");
  });
  it("🔴 序 53:glueVersion 6.0 ⇒ 作业定义 GlueVersion 6.0,且 --conf 链尾带全部 Spark 4 兼容开关(ANSI 关 + JDBC legacy 映射),S3 Tables 目录 conf 原样在前", async () => {
    const r = await ensureGlueSyncJob({ task: task({ glueConfig: { glueVersion: "6.0" } }), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const upd = glue("UpdateJobCommand")[0].input.JobUpdate as Record<string, any>;
    expect(upd.GlueVersion).toBe("6.0");
    const conf = String(upd.DefaultArguments["--conf"]).split(" --conf ");
    expect(conf[0]).toBe("spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog");
    expect(conf.slice(-GLUE_SYNC_SPARK4_COMPAT_CONF.length)).toEqual([...GLUE_SYNC_SPARK4_COMPAT_CONF]);
    expect(GLUE_SYNC_SPARK4_COMPAT_CONF).toContain("spark.sql.ansi.enabled=false");
    expect(GLUE_SYNC_SPARK4_COMPAT_CONF).toContain("spark.sql.legacy.mysql.bitArrayMapping.enabled=true");
  });
  it("序 53:glueVersion 存了清单外的值 ⇒ 400 如实拒(不替用户猜),零 Glue 作业调用", async () => {
    const r = await ensureGlueSyncJob({ task: task({ glueConfig: { glueVersion: "3.0" }, targetType: "redshift", redshiftConfig: { schema: "public" } }), taskId: TASK_ID, ds, tid: "tgt_home" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.message).toContain("不合法"); }
    expect(glue("CreateJobCommand")).toHaveLength(0);
    expect(glue("UpdateJobCommand")).toHaveLength(0);
  });
});
