// @kf-batch 50-B39-plan-target
// 计划中心「面向哪个区」的装配层判据(B-39 第三处,真环境段 cov COV-B39-PLAN 坐实):
//   路由决定落点 → createPlanTask **落库** → 执行体读回 → planner 的只读发现工具 → 计划记录的 targets。
// 🔴 缺陷原形:类型里有 targetId、注释写着「必须落库」,而 Put 的 Item 里没写它 ⇒ 执行体读回的行恒无落点
//   ⇒ us-west-2 视角的计划查的是主控区目录、计划也被盖成主控区。各模块单测都绿 —— 断在接缝上。
// ⇒ 本文件只 mock **真外部**:DynamoDB · Strands 智能体 SDK(模型侧)· 模型调用入口 · 数仓 / 数据湖目录读取;
//   plan-task-service / plan-task-runner / planner / strands-tools / discovery-tools / plan-service 全部跑真代码。

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const db = vi.hoisted(() => new Map<string, Record<string, any>>());
const keyOf = (table: string, k: Record<string, any>) => `${table}|${k.taskId ?? ""}|${k.pk ?? ""}|${k.planId ?? k.sk ?? ""}`;

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: new Proxy({}, { get: (_t, name) => `bgp-${String(name).toLowerCase()}` }),
  docClient: {
    send: async (cmd: any) => {
      const i = cmd.input;
      if (i.Item) { db.set(keyOf(i.TableName, i.Item), { ...i.Item }); return {}; }
      if (i.UpdateExpression) {
        const k = keyOf(i.TableName, i.Key);
        const row = db.get(k) ?? { ...i.Key };
        // 只需要支持本链路用到的 SET a = :v 形态(claim / heartbeat / finalize)
        const names = i.ExpressionAttributeNames || {};
        for (const part of String(i.UpdateExpression).replace(/^SET\s+/i, "").split(",")) {
          const [lhs, rhs] = part.split("=").map((x: string) => x.trim());
          if (lhs && rhs) row[names[lhs] ?? lhs] = i.ExpressionAttributeValues[rhs];
        }
        db.set(k, row);
        return {};
      }
      if (i.Key) return { Item: db.get(keyOf(i.TableName, i.Key)) };
      return { Items: [] };
    },
  },
}));

// 模型侧:Agent 收到的工具就是平台真实构建的只读工具;invoke 时调一次 discover_catalog,把它的返回写进 findings
vi.mock("@strands-agents/sdk", () => {
  class BedrockModel { constructor(public o: unknown) {} }
  class StructuredOutputError extends Error {}
  class Agent {
    tools: any[];
    constructor(o: { tools: any[] }) { this.tools = o.tools; }
    async invoke() {
      const t = this.tools.find((x) => x.name === "discover_catalog");
      const out = await t.callback({ target: "warehouse" });
      return { structuredOutput: { summary: "s", findings: JSON.stringify(out), steps: [] } };
    }
  }
  return { Agent, BedrockModel, StructuredOutputError, tool: (cfg: any) => cfg };
});
vi.mock("@/lib/ai/invoke", () => ({
  invokeAgent: async (_cap: string, _t: unknown, run: (m: string) => Promise<unknown>) =>
    ({ response: await run("model-x"), usedModelId: "model-x", usedSource: "default" }),
}));
// 目录读取(真外部 = 该区数仓):按传进来的落点回**该区独有**的表名 ⇒ 回错区一眼可见
const introspected = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock("@/lib/genbi/schema", () => ({
  introspectSchema: async (_wg: string, _db: string, opts: { targetId?: string }) => {
    introspected.push(opts?.targetId);
    return [{ schema: "public", table: `only_in_${opts?.targetId}`, columns: [] }];
  },
}));

// 首次 import 这条链很重(planner / 发现工具 / 配方库)⇒ 先导入一遍;每条给足超时。
//   否则全量并行时第一条超时被判红,而它触发的执行体还在后台跑,晚到的目录读取会串进下一条(假红)。
beforeAll(async () => { await import("../plan-task-runner"); await import("../plan-task-service"); }, 60_000);
beforeEach(() => { db.clear(); introspected.length = 0; });

async function planFor(targetId: string) {
  const { createPlanTask, getPlanTask } = await import("../plan-task-service");
  const { runPlanTask } = await import("../plan-task-runner");
  const taskId = await createPlanTask({ prompt: "列出表", projectId: "proj-a", env: "dev", token: "tk", createdBy: "u", targetId });
  const row = await getPlanTask(taskId);
  await runPlanTask(row!, "tk");
  const plan = [...db.values()].find((r) => r.planId && r.findings !== undefined);
  return { row, plan };
}

describe("🔴 B-39 计划落点:建任务 → 落库 → 执行体 → 发现工具 → 计划记录,全程同一个区", { timeout: 30_000 }, () => {
  it("🔴 us-west-2 视角:任务行落了 targetId;发现工具查 tgt_usw2_a;计划 targets == [tgt_usw2_a]", async () => {
    const { row, plan } = await planFor("tgt_usw2_a");
    expect(row?.targetId).toBe("tgt_usw2_a");
    expect(introspected).toEqual(["tgt_usw2_a"]);
    expect(plan?.findings).toContain("only_in_tgt_usw2_a");
    expect(plan?.findings).not.toContain("only_in_tgt_home");
    expect(plan?.targets).toEqual(["tgt_usw2_a"]);
  });
  it("对照:主控区视角 ⇒ 全程 tgt_home", async () => {
    const { plan } = await planFor("tgt_home");
    expect(introspected).toEqual(["tgt_home"]);
    expect(plan?.targets).toEqual(["tgt_home"]);
  });
  it("B-39 之前的存量任务行(无 targetId)⇒ 经唯一作者解析为主控区(不在别处补缺省)", async () => {
    const { runPlanTask } = await import("../plan-task-runner");
    db.set(keyOf("bgp-copilot_plan_tasks", { taskId: "legacy" }), { taskId: "legacy", status: "pending", prompt: "p", projectId: "proj-a", env: "dev", createdBy: "u" });
    await runPlanTask({ taskId: "legacy", status: "pending", prompt: "p", projectId: "proj-a", env: "dev", createdBy: "u", createdAt: "" } as any, "tk");
    expect(introspected).toEqual(["tgt_home"]);
  });
});
