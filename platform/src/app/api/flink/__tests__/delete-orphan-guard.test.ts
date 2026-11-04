// @kf-batch 50-WP18d-unpublish-seam
// 🔴🔴 删实时作业:**销毁 MSAF 应用失败就不许删记录**。
// 改动前是 `deleteFlinkApp(...).catch(() => {})`(注释写着 best-effort)⇒ 销毁失败也照删行,
// 而流式作业是「一区一个」:那个区的应用**继续在跑** —— 继续消费 CDC/Kafka、继续往数仓写数、
// **继续计费**,平台再也看不到它(孤儿长在非 home 区更没人会去看)。
// 与离线侧「撤不下来就不许动记录」(T-14)是同一条不变量,只有这条路一直是 best-effort。
// 🔴 `deleteFlinkApp` 自己已把「应用本来就不存在」当成成功 ⇒ 它抛出来的就是真失败。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ sent: [] as string[], destroyFail: false, settling: false, destroyed: [] as string[] }));

const JOB = { userId: "default-user", jobId: "f1", name: "f1", projectId: "p1", targetId: "tgt_usw2_a", status: "running" };

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { FLINK_JOBS: "flink" },
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string } }) => {
      h.sent.push(cmd.constructor.name);
      return cmd.constructor.name === "GetCommand" ? { Item: JOB } : {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/cookbook", () => ({ guardCode: vi.fn(async () => ({ ok: true, findings: [] })) }));
vi.mock("@/lib/realtime/flink-service", () => ({
  // @kf-batch 50-B28b-flink-delete-async —— 路由只认唯一入口 requestFlinkDeletion 的三种结局;
  //   「停稳后真删行 / 后台做完 / 超时如实报」在 lib/realtime/__tests__/flink-delete-settling.test.ts 装配层里验。
  normalizeFlinkSql: vi.fn((x: string) => x),
  flinkJobTarget: vi.fn((j: { targetId?: string }) => j.targetId),
  requestFlinkDeletion: vi.fn(async (jobId: string, targetId: string) => {
    if (h.destroyFail) throw new Error("ResourceInUseException: 应用正在转换状态,DeleteApplication 被拒");
    h.destroyed.push(`${jobId}@${targetId}`);
    return h.settling ? "accepted" : "deleted";
  }),
}));

// 序 72:路由模块改为顶层导入 —— 原来在第一条用例体内懒加载,路由新接入执行角色预检后导入链变重,并行跑批下首条用例吃掉 5s 超时(量具侧,非产品)
import { DELETE } from "@/app/api/flink/jobs/[id]/route";

const del = async () => {
  const res = await DELETE(new Request("http://x/api/flink/jobs/f1", { method: "DELETE" }) as never, { params: { id: "f1" } });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { h.sent.length = 0; h.destroyed.length = 0; h.destroyFail = false; h.settling = false; vi.resetModules(); });

describe("删实时作业:孤儿应用守卫", () => {
  it("🔴 销毁失败 ⇒ 502 且**不许删行**(否则那个区的应用继续消费、继续写数、继续计费)", async () => {
    h.destroyFail = true;
    const r = await del();
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toMatch(/未删除|孤儿/);
    expect(h.sent.filter((x) => x === "DeleteCommand")).toHaveLength(0);
  });

  it("🔴 B-28b:应用还在停止中 ⇒ **202 已受理**(不是 409「稍后再点」—— 用户点一次就该删掉),回显 deleting", async () => {
    h.settling = true;
    const r = await del();
    expect(r.status).toBe(202);
    expect(r.body.data).toMatchObject({ deleted: false, deleting: true });
    expect(JSON.stringify(r.body)).toMatch(/无需再点/);
  });

  it("销毁成功(且打的是**这个作业自己那个区**)⇒ 照常删行", async () => {
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ deleted: true });
    expect(h.destroyed).toEqual(["f1@tgt_usw2_a"]);
  });
});
