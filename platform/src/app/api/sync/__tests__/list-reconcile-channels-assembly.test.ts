// 装配判据:`GET /api/sync` 列表 → 读时对账(真 reconcile / dms-service / zeroetl-service / run-records / task-write)→ 落库 → 响应。
// 只 mock 真外部(DynamoDB 文档客户端、AWS 客户端工厂)与请求身份(requireProject)/ 执行环境注册表(与 scope-route 同一组边界);
// 🔴 **不** mock `@/lib/sync/reconcile` —— 那正是要焊的接缝(改动前列表把 DMS / Zero-ETL 行原样放过)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCOUNT_ID = "123456789012";
  const condFail = (row?: unknown) => {
    const e = new Error("The conditional request failed") as Error & { name: string; Item?: unknown };
    e.name = "ConditionalCheckFailedException";
    if (row) e.Item = row;
    return e;
  };
  return {
    condFail,
    rows: [] as Array<Record<string, any>>,
    runsByTask: new Map<string, Array<Record<string, unknown>>>(),
    ddb: [] as Array<{ n: string; input: Record<string, any> }>,
    replTasks: new Map<string, Record<string, unknown>>(),
    integrations: new Map<string, Record<string, unknown>>(),
    glueRuns: new Map<string, Array<Record<string, unknown>>>(),
    reset() { this.rows = []; this.runsByTask.clear(); this.ddb.length = 0; this.replTasks.clear(); this.integrations.clear(); this.glueRuns.clear(); },
  };
});

vi.mock("@/lib/aws/dynamodb", () => {
  const TABLES = new Proxy(
    { SYNC_TASKS: "bgp-sync-tasks", TASK_RUNS: "bgp-task-runs", DATASOURCES: "bgp-datasources" } as Record<string, string>,
    { get: (t, k) => (typeof k === "string" ? (t[k] ?? `bgp-${k.toLowerCase().replace(/_/g, "-")}`) : undefined) }
  );
  const docClient = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      const n = cmd.constructor.name;
      const input = cmd.input;
      h.ddb.push({ n, input });
      if (n === "ScanCommand" && input.TableName === TABLES.SYNC_TASKS) return { Items: h.rows.map((r) => ({ ...r })) };
      if (n === "QueryCommand" && input.TableName === TABLES.TASK_RUNS) return { Items: h.runsByTask.get(input.ExpressionAttributeValues[":t"]) ?? [] };
      if (n === "UpdateCommand" && input.TableName === TABLES.SYNC_TASKS) {
        const row = h.rows.find((r) => r.taskId === input.Key.taskId);
        if (!row) throw h.condFail();
        const cur = input.ExpressionAttributeValues?.[":cur"];
        if (cur !== undefined && row.status !== cur) throw h.condFail(row);
        row.status = input.ExpressionAttributeValues[":s"];
        return { Attributes: row };
      }
      if (n === "UpdateCommand" && input.TableName === TABLES.TASK_RUNS) return {};
      return {};
    },
  };
  return { docClient, TABLES };
});

vi.mock("@/lib/aws/clients", async (orig) => {
  const real = await orig<typeof import("@/lib/aws/clients")>();
  const dmsFake = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      if (cmd.constructor.name === "DescribeReplicationTasksCommand") {
        const t = h.replTasks.get(cmd.input.Filters?.[0]?.Values?.[0]);
        return { ReplicationTasks: t ? [t] : [] };
      }
      throw new Error(`unexpected DMS call ${cmd.constructor.name}`);
    },
  };
  const rdsFake = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      if (cmd.constructor.name === "DescribeIntegrationsCommand") {
        const i = h.integrations.get(cmd.input.IntegrationIdentifier);
        return { Integrations: i ? [i] : [] };
      }
      throw new Error(`unexpected RDS call ${cmd.constructor.name}`);
    },
  };
  const glueFake = {
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      if (cmd.constructor.name === "GetJobRunsCommand") return { JobRuns: h.glueRuns.get(cmd.input.JobName) ?? [] };
      throw new Error(`unexpected Glue call ${cmd.constructor.name}`);
    },
  };
  const unexpected = (what: string) => ({ async send(cmd: { constructor: { name: string } }) { throw new Error(`unexpected ${what}.${cmd.constructor.name}`); } });
  return {
    ...real,
    regionalClient: async (service: string) => (service === "dms" ? dmsFake : service === "glue" ? glueFake : unexpected(service)),
    sdkClient: (_use: string, Ctor: { name: string }) => (Ctor.name === "RDSClient" ? rdsFake : unexpected(Ctor.name)),
  };
});
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    ...actual,
    requireProject: vi.fn(async () => ({ identity: { username: "u", sub: "s" }, projectId: "proj-a", role: "editor" })),
  };
});
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true, region: id === "tgt_home" ? "us-east-1" : "us-west-2" } : null)),
  descriptorViolation: vi.fn(() => null),
}));

import { TABLES } from "@/lib/aws/dynamodb";
import { GET } from "../route";

const DMS_FAILED = "arn:aws:dms:us-east-1:123456789012:task:FAILEDFAILEDFAILEDFAILEDFA";
const DMS_RUNNING = "arn:aws:dms:us-east-1:123456789012:task:RUNNINGRUNNINGRUNNINGRUNNI";
const INTEG = "arn:aws:rds:us-east-1:123456789012:integration:0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff";

const req = (qs = "") => new NextRequest(`https://x.test/api/sync${qs}`);
const listRows = async (qs = "") => ((await (await GET(req(qs))).json()).data ?? []) as Array<Record<string, any>>;
const syncTaskUpdates = () => h.ddb.filter((x) => x.n === "UpdateCommand" && x.input.TableName === TABLES.SYNC_TASKS);
const runUpdates = () => h.ddb.filter((x) => x.n === "UpdateCommand" && x.input.TableName === TABLES.TASK_RUNS);

beforeEach(() => {
  h.reset();
  h.rows = [
    { taskId: "d-failed", channel: "dms", status: "running", targets: ["tgt_home"], projectId: "proj-a", realtimeConfig: { replicationTaskArn: DMS_FAILED } },
    { taskId: "d-running", channel: "dms", status: "running", targets: ["tgt_home"], projectId: "proj-a", realtimeConfig: { replicationTaskArn: DMS_RUNNING } },
    { taskId: "z-failed", channel: "zero-etl", status: "running", targets: ["tgt_home"], projectId: "proj-a", integrationArn: INTEG },
    { taskId: "g-done", channel: "glue", status: "running", targets: ["tgt_home"], projectId: "proj-a", glueJobName: "bgp-sync-g" },
    { taskId: "draft", channel: "dms", status: "draft", targets: ["tgt_home"], projectId: "proj-a" },
  ];
  h.runsByTask.set("d-failed", [{ taskId: "d-failed", runId: "r1", status: "running" }]);
  h.runsByTask.set("z-failed", [{ taskId: "z-failed", runId: "r1", status: "running" }]);
  h.replTasks.set(DMS_FAILED, { Status: "failed", LastFailureMessage: "Last Error Binary Logging must be enabled", ReplicationTaskStats: { FullLoadProgressPercent: 0 } });
  h.replTasks.set(DMS_RUNNING, { Status: "running", LastFailureMessage: "old failure (resumed)", ReplicationTaskStats: { FullLoadProgressPercent: 100 } });
  h.integrations.set(INTEG, { Status: "failed", Errors: [{ ErrorCode: "IAM", ErrorMessage: "not authorized" }] });
  h.glueRuns.set("bgp-sync-g", [{ JobRunState: "SUCCEEDED", ExecutionTime: 3 }]);
});

describe("GET /api/sync 列表读时对账", () => {
  it("🔴 DMS 侧 failed 的行列表直接显示 failed(不用先打开详情页);running 带残留 lastFailure 的行不动;zero-etl failed ⇒ error;glue 照旧", async () => {
    const byId = Object.fromEntries((await listRows()).map((r) => [r.taskId, r]));
    expect(byId["d-failed"].status).toBe("failed");
    expect(byId["d-running"].status).toBe("running");
    expect(byId["z-failed"].status).toBe("error");
    expect(byId["g-done"].status).toBe("succeeded");
    expect(byId["draft"].status).toBe("draft");
  });

  it("落库事实:三条终态各一笔条件写(d-running 零写);DMS / Zero-ETL 的运行记录收口", async () => {
    await listRows();
    const up = syncTaskUpdates();
    expect(up.map((x) => [x.input.Key.taskId, x.input.ExpressionAttributeValues[":s"]]).sort()).toEqual([
      ["d-failed", "failed"], ["g-done", "succeeded"], ["z-failed", "error"],
    ]);
    for (const x of up) expect(x.input.ConditionExpression).toContain("attribute_exists(taskId)");
    const dmsUp = up.find((x) => x.input.Key.taskId === "d-failed")!.input;
    expect(dmsUp.ConditionExpression).toBe("attribute_exists(taskId) AND (#s = :cur)");
    expect(dmsUp.ExpressionAttributeValues[":err"]).toBe("Last Error Binary Logging must be enabled");
    const zeUp = up.find((x) => x.input.Key.taskId === "z-failed")!.input;
    expect(zeUp.UpdateExpression).toContain("zeroEtlError = :err");
    expect(runUpdates().map((x) => x.input.Key.taskId).sort()).toEqual(["d-failed", "z-failed"]);
    // 「数据库」里的行真的变了(下一次列表不再问 DMS)
    expect(h.rows.find((r) => r.taskId === "d-failed")?.status).toBe("failed");
  });

  it("对账发生在 scope 过滤之前:主控区视角与全局视角看到同一份终态", async () => {
    const scoped = Object.fromEntries((await listRows("?scope=tgt_home")).map((r) => [r.taskId, r.status]));
    expect(scoped["d-failed"]).toBe("failed");
    expect(scoped["z-failed"]).toBe("error");
  });

  it("第二次列表:行已是终态 ⇒ 不再问 DMS / RDS,也不再写", async () => {
    await listRows();
    h.ddb.length = 0;
    await listRows();
    expect(syncTaskUpdates()).toHaveLength(0);
    expect(runUpdates()).toHaveLength(0);
  });

  it("用户在列表刷新的同一瞬间点了「停止」(行已 stopped)⇒ 对账让路:响应仍是旧状态、运行记录不碰", async () => {
    h.rows = [{ taskId: "d-raced", channel: "dms", status: "running", targets: ["tgt_home"], projectId: "proj-a", realtimeConfig: { replicationTaskArn: DMS_FAILED } }];
    h.runsByTask.set("d-raced", [{ taskId: "d-raced", runId: "r1", status: "running" }]);
    // Scan 返回的是快照;Update 之前「别人」把库里的行改成了 stopped
    const realSend = (await import("@/lib/aws/dynamodb")).docClient.send as (c: never) => Promise<unknown>;
    (await import("@/lib/aws/dynamodb")).docClient.send = (async (cmd: { constructor: { name: string } }) => {
      const out = await realSend(cmd as never);
      if (cmd.constructor.name === "ScanCommand") h.rows[0].status = "stopped";
      return out;
    }) as never;
    const rows = await listRows();
    expect(rows[0].status).toBe("running");
    expect(runUpdates()).toHaveLength(0);
    expect(h.rows[0].status).toBe("stopped");
    (await import("@/lib/aws/dynamodb")).docClient.send = realSend as never;
  });
});
