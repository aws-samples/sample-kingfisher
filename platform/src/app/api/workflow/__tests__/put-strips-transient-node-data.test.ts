// 序 73 模块 57 —— `PUT /api/workflow/[id]`:持久化的 dagDefinition 里**没有** jobMissing(编辑期派生字段不落库)。
//
// 【缺陷原形】节点配置面板按候选清单算出 jobMissing 写进 node.data 给画布显示警示,保存时整个 node.data 原样 PUT ⇒ 一个随候选变化的派生判断
//   被钉进定义:作业重新绑回该区后,存量定义里仍写着 jobMissing=true。判据钉**真落库的 UpdateCommand 值**:节点 data 里没有 jobMissing,
//   权威字段(jobRef / label / jobName / jobEngine)与别的节点 / 边逐字节保留。只 mock 真外部(DynamoDB 文档客户端 / 身份)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const sent: Array<{ name: string; input: Record<string, any> }> = [];
const CURRENT = {
  userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES", targets: ["tgt_usw2_a"],
  dagDefinition: { nodes: [], edges: [] }, scheduleEnabled: false, status: "draft", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
};
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const TABLES = real.TABLES as Record<string, string>;
  return {
    ...real,
    docClient: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
        // 对象租约(bgp-long-ops)没有 ⇒ 空;版本快照等别的写一律吞掉
        if (cmd.input?.TableName === TABLES.LONG_OPS) return {};
        if (cmd.input?.TableName !== TABLES.WORKFLOWS) return {};
        sent.push({ name: cmd.constructor.name, input: (cmd.input ?? {}) as Record<string, any> });
        if (cmd.constructor.name === "GetCommand") return { Item: { ...CURRENT } };
        if (cmd.constructor.name === "UpdateCommand") {
          const vals = (cmd.input as any).ExpressionAttributeValues as Record<string, unknown>;
          const names = (cmd.input as any).ExpressionAttributeNames as Record<string, string>;
          const out: Record<string, unknown> = { ...CURRENT };
          for (const [ph, field] of Object.entries(names)) {
            const vph = ph === "#upd" ? ":now" : ph.replace(/^#f/, ":v");
            if (vph in vals) out[field] = vals[vph];
          }
          return { Attributes: out };
        }
        return {};
      }),
    },
  };
});
// 身份 / 项目权限来自 Cognito(真外部);与仓内 PUT 路由判据同款 partial mock
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, guardResourceAccess: vi.fn(async () => ({ identity: { username: "u" }, projectId: "proj-01M4Z0AHBYF5Y28STSE1TKS7EG", role: "editor" })) };
});

const { PUT } = await import("@/app/api/workflow/[id]/route");

const JOB_NODE = {
  id: "j1", type: "job", position: { x: 250, y: 80 },
  data: { label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" }, jobName: "每日清洗", jobEngine: "glue", jobTargets: ["tgt_usw2_a"], jobMissing: true },
};
const SQL_NODE = { id: "q", type: "sql", position: { x: 250, y: 210 }, data: { label: "汇总", sql: "SELECT 1" } };
const EDGES = [{ id: "e-j1-q-0", source: "j1", target: "q" }];

function put(body: unknown) {
  return PUT(new NextRequest("http://x/api/workflow/wf1", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "wf1" }) });
}

beforeEach(() => { sent.length = 0; });

describe("PUT /api/workflow/[id] 落库的 dagDefinition", () => {
  it("节点 data 里的 jobMissing 不落库;jobRef / label / jobName / jobEngine / jobTargets / position 与别的节点 / 边逐字节保留;响应回的是落库后的定义", async () => {
    const res = await put({ dagDefinition: { nodes: [JOB_NODE, SQL_NODE], edges: EDGES } });
    expect(res.status).toBe(200);
    const upd = sent.find((s) => s.name === "UpdateCommand")!;
    expect(upd, "没有 UpdateCommand").toBeTruthy();
    const names = upd.input.ExpressionAttributeNames as Record<string, string>;
    const ph = Object.entries(names).find(([, f]) => f === "dagDefinition")![0].replace(/^#f/, ":v");
    const persisted = upd.input.ExpressionAttributeValues[ph] as { nodes: Array<{ id: string; data: Record<string, unknown> }>; edges: unknown[] };
    expect(persisted.nodes.map((n) => n.id)).toEqual(["j1", "q"]);
    const j1 = persisted.nodes[0];
    expect("jobMissing" in j1.data).toBe(false);
    expect(j1).toEqual({
      id: "j1", type: "job", position: { x: 250, y: 80 },
      data: { label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" }, jobName: "每日清洗", jobEngine: "glue", jobTargets: ["tgt_usw2_a"] },
    });
    expect(persisted.nodes[1]).toEqual(SQL_NODE);
    expect(persisted.edges).toEqual(EDGES);
    // 整份定义里任何一层都没有这个键(闭合:不只看第一个节点)
    expect(JSON.stringify(persisted)).not.toContain("jobMissing");
    const body = (await res.json()) as { dagDefinition: { nodes: Array<{ data: Record<string, unknown> }> } };
    expect(JSON.stringify(body.dagDefinition)).not.toContain("jobMissing");
  });
  it("没有 jobMissing 的定义逐字节原样落库(剥离不动别的东西)", async () => {
    const def = { nodes: [{ ...JOB_NODE, data: { label: "清洗", jobRef: JOB_NODE.data.jobRef } }, SQL_NODE], edges: EDGES };
    await put({ dagDefinition: def });
    const upd = sent.find((s) => s.name === "UpdateCommand")!;
    const names = upd.input.ExpressionAttributeNames as Record<string, string>;
    const ph = Object.entries(names).find(([, f]) => f === "dagDefinition")![0].replace(/^#f/, ":v");
    expect(upd.input.ExpressionAttributeValues[ph]).toEqual(def);
  });
});
