// @kf-batch 37-sync-capability —— 序 37 B-60 升级兼容「既有目标收养」的装配层判据:
//   startGlueSyncRun(真)→ adoptExistingTargetsOnce(真)→ run 台账查询单一作者 listRunsByTask(真)→ 任务唯一写通道(真)
//   → generateGlueScript(真)→ 上传脚本。只 mock 真外部:DDB docClient、按区 SDK 客户端工厂、落点解析、OM、下游扇出。
//   lib/sync 的兄弟模块一个都不 mock —— 「收养写进任务记录」与「生成脚本的 OVERWRITE_CONFIRMED 真含那些名字」是同一条链上
//   两个可观察事实,接缝不许被抹平。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GOLDEN_SHAPES } from "./golden-shapes";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const calls: Call[] = [];
const S = vi.hoisted(() => ({
  task: null as Record<string, any> | null,
  runs: [] as Array<Record<string, unknown>>,
  updates: [] as Record<string, any>[],
}));

vi.mock("ulid", () => ({ ulid: () => "01RUNADOPT000000A1" }));
vi.mock("@/lib/aws/dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/aws/dynamodb")>();
  return {
    ...actual,
    docClient: {
      send: vi.fn(async (cmd: any) => {
        const input = { ...((cmd.input || {}) as Record<string, unknown>) };
        calls.push({ svc: "ddb", cmd: cmd.constructor.name, input });
        if (cmd.constructor.name === "QueryCommand" && input.TableName === actual.TABLES.TASK_RUNS) return { Items: structuredClone(S.runs) };
        if (cmd.constructor.name === "UpdateCommand" && input.TableName === actual.TABLES.SYNC_TASKS) { S.updates.push(input); return { Attributes: {} }; }
        return {};
      }),
    },
  };
});
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

import { startGlueSyncRun } from "@/lib/sync/start-run";
import type { DataSource } from "@/types/datasource";

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "StartJobRunCommand") return { JobRunId: "jr_adopt" };
      if (svc === "s3tables" && n === "ListTableBucketsCommand") return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:123456789012:bucket/bgp-table-bucket" }] };
      if (svc === "s3tables" && n === "ListNamespacesCommand") return { namespaces: [{ namespace: ["gamedb"] }] };
      return {};
    }),
  };
}
const ds = { ...(GOLDEN_SHAPES[0].ds as unknown as Record<string, unknown>), glueConnectionName: "bgp-conn-mysql" } as unknown as DataSource;
const TASK_ID = "01TASKADOPT00000000A1";
const oldTask = () => ({
  userId: "default-user", taskId: TASK_ID, name: "Showcase-home-GameSync", datasourceId: "ds_mysql",
  channel: "glue", syncMode: "full", writeMode: "overwrite", targetType: "both",
  sourceDatabase: "gamedb", sourceTables: ["players", "orders"],
  s3Config: { namespace: "showcase" }, redshiftConfig: { schema: "public" }, projectId: "default",
});
const ALL = ["public.orders", "public.players", "s3tablescatalog.showcase.orders", "s3tablescatalog.showcase.players"];

async function start(task: Record<string, any>) {
  S.task = task;
  return startGlueSyncRun({ task, taskId: TASK_ID, ds, tid: "tgt_home", dsOwner: "tgt_home", triggeredBy: "manual" });
}
const runQueries = () => calls.filter((c) => c.svc === "ddb" && c.cmd === "QueryCommand" && c.input.TableName === "bgp-task-runs");
const adoptionUpdates = () => S.updates.filter((u) => String(u.UpdateExpression).includes("foreignGuardAdoptedAt"));
const script = () => String(calls.find((c) => c.svc === "s3" && c.cmd === "PutObjectCommand" && String(c.input.Key).endsWith(".py"))?.input.Body ?? "");

beforeEach(() => {
  calls.length = 0; S.updates.length = 0; S.runs = [];
  for (const s of ["glue", "s3", "s3tables", "logs"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  // 只换 setTimeout:后台轮询(15s 一拍)在本判据里永不触发;Date 真走(收养时间戳要是真 ISO)
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("🔴🔴 B-60 升级兼容:守卫上线前已成功运行过的任务,首次运行时收养当时的目标表(一次性)", () => {
  it("老任务(overwrite · both · 无 stamp)有 succeeded run ⇒ 记录被 stamp 且确认清单 = Redshift 全名 ∪ S3 三段名;生成脚本的 OVERWRITE_CONFIRMED 含全部", async () => {
    S.runs = [{ runId: "r1", status: "error" }, { runId: "r2", status: "succeeded" }, { runId: "r3", status: "running" }];
    const task = oldTask();
    const res = await start(task);
    expect(res.started, JSON.stringify(res)).toBe(true);
    expect(runQueries()).toHaveLength(1);
    const up = adoptionUpdates();
    expect(up).toHaveLength(1);
    expect(up[0].UpdateExpression).toBe("SET overwriteConfirmedTables = :c, foreignGuardAdoptedAt = :t");
    expect(up[0].ExpressionAttributeValues[":c"]).toEqual(ALL);
    expect(up[0].ExpressionAttributeValues[":t"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(up[0].ConditionExpression).toBe("attribute_exists(taskId)"); // 走的是任务唯一写通道
    // 内存里的任务也更新了 ⇒ 紧接着生成的脚本读到的是收养后的清单(Redshift 块 + S3 守卫段各一处)
    expect(task.overwriteConfirmedTables).toEqual(ALL);
    expect(task.foreignGuardAdoptedAt).toBe(up[0].ExpressionAttributeValues[":t"]);
    const py = script();
    expect(py).toContain(`OVERWRITE_CONFIRMED = set(${JSON.stringify(ALL)})`);
    expect(py).toContain(`s3t_table not in set(${JSON.stringify(ALL)})`);
  });
  it("老任务原有的确认清单被保留(并集),不是覆盖", async () => {
    S.runs = [{ runId: "r1", status: "succeeded" }];
    const task = { ...oldTask(), overwriteConfirmedTables: ["ods.legacy_tbl"] };
    await start(task);
    expect(adoptionUpdates()[0].ExpressionAttributeValues[":c"]).toEqual(["ods.legacy_tbl", ...ALL]);
  });
  it("老任务**没有** succeeded run(只有失败)⇒ 只写时间戳、不收养任何表;脚本 OVERWRITE_CONFIRMED 为空", async () => {
    S.runs = [{ runId: "r1", status: "error" }, { runId: "r2", status: "running" }];
    const task = oldTask();
    await start(task);
    const up = adoptionUpdates();
    expect(up).toHaveLength(1);
    expect(up[0].UpdateExpression).toBe("SET foreignGuardAdoptedAt = :t");
    expect(up[0].ExpressionAttributeValues[":c"]).toBeUndefined();
    expect(task.overwriteConfirmedTables).toBeUndefined();
    expect(script()).toContain("OVERWRITE_CONFIRMED = set([])");
  });
  it("新任务(从没跑过,run 台账为空)⇒ 不收养,守卫全量生效(只 stamp)", async () => {
    S.runs = [];
    const task = oldTask();
    await start(task);
    expect(adoptionUpdates()[0].UpdateExpression).toBe("SET foreignGuardAdoptedAt = :t");
    expect(script()).toContain("OVERWRITE_CONFIRMED = set([])");
  });
  it("已 stamp 的任务不再查 run 台账、不再写(即使有 succeeded run 也不会第二次收养)", async () => {
    S.runs = [{ runId: "r1", status: "succeeded" }];
    const task = { ...oldTask(), foreignGuardAdoptedAt: "2026-10-12T00:00:00.000Z", sourceTables: ["players", "orders", "new_table"] };
    await start(task);
    expect(runQueries()).toHaveLength(0);
    expect(adoptionUpdates()).toHaveLength(0);
    expect(script()).toContain("OVERWRITE_CONFIRMED = set([])"); // 改了目标表就得重新确认 —— 这是对的
  });
  it("不会触发守卫的任务(append / merge)⇒ 不查、不 stamp", async () => {
    S.runs = [{ runId: "r1", status: "succeeded" }];
    await start({ ...oldTask(), writeMode: "append" });
    expect(runQueries()).toHaveLength(0);
    expect(adoptionUpdates()).toHaveLength(0);
    calls.length = 0; S.updates.length = 0;
    await start({ ...oldTask(), writeMode: "merge", mergeKeys: ["id"] });
    expect(runQueries()).toHaveLength(0);
    expect(adoptionUpdates()).toHaveLength(0);
  });
  it("只写 S3 的老任务:收养的是三段名;只写 Redshift 的老任务:收养的是 schema.table", async () => {
    S.runs = [{ runId: "r1", status: "succeeded" }];
    await start({ ...oldTask(), targetType: "s3-tables" });
    expect(adoptionUpdates()[0].ExpressionAttributeValues[":c"]).toEqual(["s3tablescatalog.showcase.orders", "s3tablescatalog.showcase.players"]);
    calls.length = 0; S.updates.length = 0;
    await start({ ...oldTask(), targetType: "redshift" });
    expect(adoptionUpdates()[0].ExpressionAttributeValues[":c"]).toEqual(["public.orders", "public.players"]);
  });
  it("增量 + 空水位(整表预删那条路)的老任务同样收养", async () => {
    S.runs = [{ runId: "r1", status: "succeeded" }];
    await start({ ...oldTask(), writeMode: "append", syncMode: "incremental", incrementalColumn: "id" });
    expect(adoptionUpdates()[0].ExpressionAttributeValues[":c"]).toEqual(ALL);
  });
});
