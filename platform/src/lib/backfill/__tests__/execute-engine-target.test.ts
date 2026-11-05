// 🔴 EMR(engine-job)补数实例必须**按自己的 targetId 提交**。原来不传 ⇒ provider 缺省主控区 ⇒
//   绑两区的作业两区实例都在主控区跑(主控区两遍、非主控区零补),页面显示成功。
// 只 mock 真外部(DDB / 引擎 provider / 数仓客户端);判据断「provider 收到的 targetId」。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ submits: [] as Array<Record<string, unknown>>, job: {} as Record<string, unknown> }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: async () => ({ Item: h.job }) } };
});
vi.mock("@/lib/exec-env/target-clients", () => ({ redshiftDataClientFor: () => ({ send: async () => ({}) }) }));
vi.mock("@/lib/engines/registry", () => ({
  isEngineType: () => true,
  getProvider: () => ({
    submit: async (_job: unknown, opts: Record<string, unknown>) => {
      h.submits.push(opts);
      return { runId: `r${h.submits.length}` };
    },
  }),
}));

const { executeInstance } = await import("@/lib/backfill/execute");

const plan = { target: { scope: "task", kind: "engine-job", id: "job-1", name: "j" } } as never;
const inst = (over: Record<string, unknown>) =>
  ({ planId: "p", sk: "x", date: "2026-10-01", nodeId: "job-1", nodeName: "j", status: "running", dependsOn: [], attempts: 1, ttl: 0, ...over }) as never;

beforeEach(() => {
  h.submits = [];
  h.job = { jobId: "job-1", engine: "emr-serverless", targets: ["tgt_home", "tgt_usw2_a"] };
});

describe("🔴 EMR 补数按实例的区提交", () => {
  it("两个区的实例各自提交到自己的区(不是都落主控区)", async () => {
    await executeInstance(plan, inst({ targetId: "tgt_home" }));
    await executeInstance(plan, inst({ targetId: "tgt_usw2_a" }));
    expect(h.submits.map((o) => o.targetId)).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(h.submits.every((o) => o.triggeredBy === "backfill" && o.runDate === "2026-10-01")).toBe(true);
  });
  it("存量实例没有 targetId ⇒ 回落作业绑定的第一个区(与改动前一致)", async () => {
    h.job = { jobId: "job-1", engine: "emr-serverless", targets: ["tgt_usw2_a"] };
    await executeInstance(plan, inst({}));
    expect(h.submits[0].targetId).toBe("tgt_usw2_a");
  });
});

// 该缺陷的补数那一半:实例日期逐条进 provider.submit 的 runDate(provider 再把它变成 --ds 等参数)
describe("🔴 EMR 补数实例按**自己的日期**提交", () => {
  it("三个日期的实例 ⇒ 三次 submit 各带各的 runDate(不是都用今天 / 都用第一个)", async () => {
    for (const d of ["2026-09-01", "2026-09-02", "2026-09-03"]) await executeInstance(plan, inst({ date: d, targetId: "tgt_home" }));
    expect(h.submits.map((o) => o.runDate)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(h.submits.every((o) => o.triggeredBy === "backfill")).toBe(true);
  });
  it("小时粒度实例取日(与 etl-job 同一规则)", async () => {
    await executeInstance(plan, inst({ date: "2026-09-05T03", targetId: "tgt_home" }));
    expect(h.submits[0].runDate).toBe("2026-09-05");
  });
});
