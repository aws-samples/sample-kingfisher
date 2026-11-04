// 🔴🔴 **扇出把「有个区撤不下来」吃掉了** —— 两个路由的注释都写着「撤不下来就不许动记录,
// 否则只剩一个谁也管不着的孤儿调度」(与段 `scq` A2-3 的学费),而那条不变量当时**靠的是
// 异常会往上抛**。把单区改成逐区扇出、把逐区异常收进 `perTarget` 之后
//   · `/unpublish` 照样把工作流改成 `draft`(而那个区的 workflow 还在按 cron 跑);
//   · `DELETE` 照样删掉记录(落点章随记录消失 ⇒ 再也定位不到它在哪个区)。
// 与「扇出把类型化拒因抹平 ⇒ 4xx 退化成 500」是同一族接缝缺陷:**改了扇出,就要把每一个
// 依赖「异常会冒泡」的守卫重新问一遍**。
//
// 🔴 这里**不 mock** `publish-dag`(接缝正在被测):只 mock 真外部(DDB / 调度器端点 / 服务调用)。
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const sends: Array<Record<string, any>> = [];
const offlined: string[] = [];
let failOn: string | null = null;
let notInstalledOn: string | null = null;

const WF = {
  workflowId: "wf1", projectId: "p1", airflowDagId: "bgp_wf1",
  targets: ["tgt_home", "tgt_usw2_a"],
  deployments: { tgt_home: { workflowArn: "arn:home" }, tgt_usw2_a: { workflowArn: "arn:usw2" } },
};

// 下线 / 删除经 submitLongOp ⇒ 任务表 bgp-long-ops 的读写交给内存夹具(真求值条件写),工作流表的命令照旧记在 sends
vi.mock("@/lib/aws/dynamodb", async () => {
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    TABLES: { WORKFLOWS: "wf", LONG_OPS: "bgp-long-ops" },
    docClient: {
      send: vi.fn(async (cmd: { input?: Record<string, any> }) => {
        if (cmd.input?.TableName === "bgp-long-ops") return mem.docClient.send(cmd);
        sends.push({ op: (cmd as { constructor: { name: string } }).constructor.name, ...(cmd.input ?? {}) });
        return cmd.input?.Key && !cmd.input?.UpdateExpression ? { Item: WF } : {};
      }),
    },
  };
});
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/snapshot", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/scheduler/mwaa-endpoint", () => {
  class MwaaNotInstalled extends Error {
    missing: Array<{ reason: string }> = [{ reason: "该执行环境没有调度组件" }];
    constructor(public targetId: string) { super(`${targetId} 没装调度组件`); this.name = "MwaaNotInstalled"; }
  }
  return {
    MwaaNotInstalled,
    mwaaErrorResponse: vi.fn(() => undefined),
    isServerlessEndpoint: vi.fn(() => true),
    unpauseWhenLoaded: vi.fn(async () => {}),
    mwaaClientFor: vi.fn(),
    homeMwaaEndpoint: vi.fn(),
    schedulerEndpointFor: vi.fn(async (t: string) => {
      if (t === notInstalledOn) throw new MwaaNotInstalled(t);
      return { targetId: t, region: t === "tgt_home" ? "us-east-1" : "us-west-2", kind: "serverless", dagBucket: `b-${t}` };
    }),
  };
});
vi.mock("@/lib/scheduler/serverless/workflow-client", () => ({
  findWorkflowArnByName: vi.fn(async (region: string) => `arn:${region}`),
}));
vi.mock("@/lib/scheduler/serverless/publish", () => ({
  publishServerlessWorkflow: vi.fn(),
  offlineServerlessWorkflow: vi.fn(async ({ ep }: { ep: { targetId: string } }) => {
    if (ep.targetId === failOn) throw new Error("DeleteWorkflow 被服务拒:ThrottlingException");
    offlined.push(ep.targetId);
    return { deleted: true, dagFileDeleted: true, stoppedRuns: 0 };
  }),
}));
vi.mock("@/lib/scheduler/mwaa-offline", () => ({ offlineDag: vi.fn(async () => ({ paused: true, dagFileDeleted: true })) }));

const reqOf = () => new Request("http://x/api/workflow/wf1/unpublish", { method: "POST" }) as never;
const updates = () => sends.filter((x) => x.UpdateExpression);

// 路由经 submitLongOp 带进整张执行体注册表 ⇒ 首次 import 要变换几百个模块(实测 > 5s),先暖一次,免得第一条用例被 5s 缺省超时误判
beforeAll(async () => { await import("../[id]/unpublish/route"); }, 60_000);
beforeEach(() => { sends.length = 0; offlined.length = 0; failOn = null; notInstalledOn = null; vi.resetModules(); });

describe("工作流下线的扇出接缝", () => {
  it("两个区都撤成功 ⇒ 200,且**两个区**的 deployments 台账都清掉(原来只清 head 那一个 ⇒ 另一个区的台账继续说「已部署」)", async () => {
    const { POST } = await import("../[id]/unpublish/route");
    const res = await POST(reqOf(), { params: { id: "wf1" } });
    expect(res.status).toBe(200);
    expect(offlined.sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    const up = updates();
    expect(up).toHaveLength(1);
    const names = Object.values(up[0].ExpressionAttributeNames as Record<string, string>);
    expect(names).toContain("tgt_home");
    expect(names).toContain("tgt_usw2_a");
    // REMOVE 段里两个 deployments 路径都在
    expect((up[0].UpdateExpression as string).match(/deployments\.#t\d/g)).toHaveLength(2);
  });

  it("🔴 有一个区撤不下来 ⇒ 502 且**一条记录都不许改**(不变量:记录不许比现实更「已下线」)", async () => {
    failOn = "tgt_usw2_a";
    const { POST } = await import("../[id]/unpublish/route");
    const res = await POST(reqOf(), { params: { id: "wf1" } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("DAG_CLEANUP_FAILED");
    expect(body.failures.map((f: { targetId: string }) => f.targetId)).toEqual(["tgt_usw2_a"]);
    expect(updates()).toHaveLength(0);
  });

  it("「该区没装调度组件」**不算**撤不下来(否则组件被拆掉的区会让这个工作流永远下线不了)", async () => {
    notInstalledOn = "tgt_usw2_a";
    const { POST } = await import("../[id]/unpublish/route");
    const res = await POST(reqOf(), { params: { id: "wf1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.perTarget.find((x: { targetId: string }) => x.targetId === "tgt_usw2_a").skipped).toMatch(/没有调度组件/);
    expect(updates()).toHaveLength(1);
  });

  it("🔴 DELETE 路由同一条不变量:有区撤不下来 ⇒ 502 且**不许删记录**(记录一删,落点章就没了)", async () => {
    failOn = "tgt_usw2_a";
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(
      new Request("http://x/api/workflow/wf1", { method: "DELETE" }) as never,
      { params: { id: "wf1" } }
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("DAG_CLEANUP_FAILED");
    // 只发生了 Get(路由鉴权读一次 + 执行体自己读一次),没有 Update / Delete
    expect(sends.filter((x) => x.UpdateExpression)).toHaveLength(0);
    expect(sends.filter((x) => x.op === "DeleteCommand")).toHaveLength(0);
    expect(sends.map((x) => x.op)).toEqual(["GetCommand", "GetCommand"]);
  });
});
