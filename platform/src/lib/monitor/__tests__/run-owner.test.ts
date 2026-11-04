// @kf-batch 52-P52.2-W2a-run-stamp
// run 读侧归属判定的门禁。配套 `run-owner.ts`;并钉住 Copilot `check_run_status` 这个越权面。
import { describe, it, expect, vi, beforeEach } from "vitest";

/** table#id → 行。缺 projectId 即"存量行"。 */
let rows: Record<string, Record<string, unknown>> = {};
/** 让某张表读失败,用来验证 fail-closed。 */
let failingTables = new Set<string>();

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: {
    SYNC_TASKS: "bgp-sync-tasks",
    WORKFLOWS: "bgp-workflows",
    ETL_JOBS: "bgp-etl-jobs",
    ENGINE_JOBS: "bgp-engine-jobs",
    TASK_RUNS: "bgp-task-runs",
  },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      const input = (cmd.input ?? {}) as Record<string, any>;
      const table = String(input.TableName);
      if (failingTables.has(table)) throw new Error("boom");
      // task-runs 是 Query(KeyConditionExpression),没有 `Key` —— 第一版桩直接点 `input.Key.taskId`
      // 就抛了,于是"同项目照常可用"那条正向断言假红。桩看不懂的命令必须显式处理,不能靠异常兜。
      if (input.KeyConditionExpression) {
        return { Items: [{ taskId: String(input.ExpressionAttributeValues[":t"]), runId: "r1", status: "succeeded" }] };
      }
      const id = String(input.Key.taskId ?? input.Key.workflowId ?? input.Key.jobId ?? "");
      return { Item: rows[`${table}#${id}`] };
    }),
  },
}));

const { lookupRunOwner, isRunVisibleTo, canReadRunsOf } = await import("@/lib/monitor/run-owner");

const PID_A = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const PID_B = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";

beforeEach(() => {
  rows = {};
  failingTables = new Set();
});

describe("lookupRunOwner:四张资源表都要找(它们复用同一张运行表)", () => {
  it.each([
    ["bgp-sync-tasks", "taskId"],
    ["bgp-workflows", "workflowId"],
    ["bgp-etl-jobs", "jobId"],
    ["bgp-engine-jobs", "jobId"],
  ])("%s 上的资源也能被认出归属", async (table) => {
    rows[`${table}#x1`] = { projectId: PID_A };
    expect(await lookupRunOwner("x1")).toEqual({ found: true, projectId: PID_A });
  });

  it("🔴 查不到资源 ⇒ found:false(调用方必须当不可见 = fail-closed)", async () => {
    expect(await lookupRunOwner("ghost")).toEqual({ found: false });
    expect(await lookupRunOwner("")).toEqual({ found: false });
  });

  it("🔴 全部表都读失败也是 found:false,绝不退化成放行", async () => {
    rows["bgp-sync-tasks#x1"] = { projectId: PID_A };
    failingTables = new Set(["bgp-sync-tasks", "bgp-workflows", "bgp-etl-jobs", "bgp-engine-jobs"]);
    expect(await lookupRunOwner("x1")).toEqual({ found: false });
  });

  it("单表读失败不影响在别的表里找到(不能因为一张表抖动就判无权)", async () => {
    rows["bgp-etl-jobs#x1"] = { projectId: PID_A };
    failingTables = new Set(["bgp-sync-tasks"]);
    expect(await lookupRunOwner("x1")).toEqual({ found: true, projectId: PID_A });
  });
});

describe("🔴 isRunVisibleTo:语义必须与 projectFilter 逐字对齐", () => {
  it("同项目可见,跨项目不可见", () => {
    expect(isRunVisibleTo({ found: true, projectId: PID_A }, PID_A)).toBe(true);
    expect(isRunVisibleTo({ found: true, projectId: PID_A }, PID_B)).toBe(false);
    expect(isRunVisibleTo({ found: true, projectId: PID_A }, "proj-default")).toBe(false);
  });

  it("存量资源(无 projectId)只有默认工作区看得见 —— 与 attribute_not_exists 兜底同款", () => {
    expect(isRunVisibleTo({ found: true }, "proj-default")).toBe(true);
    expect(isRunVisibleTo({ found: true }, PID_A)).toBe(false);
  });

  it("found:false 一律不可见(哪个项目问都一样)", () => {
    for (const pid of ["proj-default", PID_A, PID_B]) {
      expect(isRunVisibleTo({ found: false }, pid)).toBe(false);
    }
  });
});

describe("🔴 Copilot check_run_status:跨项目读运行流水必须被拒", () => {
  it("A 项目的调用方拿 B 项目的 taskId ⇒ 失败且不回任何运行数据", async () => {
    rows["bgp-sync-tasks#t-of-b"] = { projectId: PID_B, name: "B 的同步任务" };
    const { DISCOVERY_TOOLS } = await import("@/lib/copilot/plan/discovery-tools");
    const tool = DISCOVERY_TOOLS.find((t) => t.name === "check_run_status")!;
    const res = await tool.handler({ taskId: "t-of-b" }, { token: "", projectId: PID_A, env: "dev" });
    expect(res.success).toBe(false);
    expect(res.data).toBeUndefined();
    expect(String(res.error)).toMatch(/无权查看/);
  });

  it("同项目照常可用(别把闸做成谁都不能查)", async () => {
    rows["bgp-sync-tasks#t-of-a"] = { projectId: PID_A };
    const { DISCOVERY_TOOLS } = await import("@/lib/copilot/plan/discovery-tools");
    const tool = DISCOVERY_TOOLS.find((t) => t.name === "check_run_status")!;
    const res = await tool.handler({ taskId: "t-of-a" }, { token: "", projectId: PID_A, env: "dev" });
    expect(res.success).toBe(true);
    expect(res.data.taskId).toBe("t-of-a");
  });

  it("🔴 handler 必须**用**第二个参数(caller)—— 声明用了却不用是这个洞的原型", async () => {
    const { DISCOVERY_TOOLS } = await import("@/lib/copilot/plan/discovery-tools");
    const tool = DISCOVERY_TOOLS.find((t) => t.name === "check_run_status")!;
    expect(tool.handler.length, "handler 只声明了 1 个参数 ⇒ 拿不到 caller 身份").toBeGreaterThanOrEqual(2);
  });
});
