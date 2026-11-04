// GET /api/exec-targets 的维度闭合清单:编排页传 "airflow"、建表向导传 "core" 曾被这条路由 400,
// 页面吞成空列表 ⇒ 「执行区域(可多选)」永远空、「全选当前活跃区(0)」灰了一个月。
// 本判据钉**事实**:每个维度回哪些目标(与写路径同口径)、不在清单的维度 400 并列出清单(不回空列表)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ targets: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, requireProject: vi.fn(async () => ({ identity: { username: "u", sub: "u" }, projectId: "proj-a", role: "viewer" })) };
});
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, listActiveTargets: vi.fn(async () => h.targets), listTargetsRaw: vi.fn(async () => h.targets) };
});

const { GET } = await import("../route");
const call = (qs: string) => GET(new NextRequest(`https://x.test/api/exec-targets${qs}`));
const ids = async (r: Response) => ((await r.json()).data.targets as Array<{ targetId: string }>).map((x) => x.targetId).sort();

const HOME = { targetId: "tgt_home", region: "us-east-1", jurisdiction: "home", components: ["core", "redshift", "airflow-serverless"] };
const USW2 = { targetId: "tgt_usw2_a", region: "us-west-2", jurisdiction: "home", components: ["core", "redshift", "airflow-serverless", "dms"] };
/** 装了数仓、没装任何调度组件 */
const USW1_NO_SCHED = { targetId: "tgt_usw1_a", region: "us-west-1", jurisdiction: "home", components: ["core", "redshift"] };
/** 只有湖 + 经典 mwaa、没装数仓 */
const EUC1_LAKE_MWAA = { targetId: "tgt_euc1_a", region: "eu-central-1", jurisdiction: "eu", components: ["core", "mwaa"] };

beforeEach(() => {
  h.targets = [HOME, USW2, USW1_NO_SCHED, EUC1_LAKE_MWAA];
});

describe("GET /api/exec-targets —— 维度闭合清单", () => {
  it("缺省 = redshift:只列装了数仓的(EMR 面板 / 直查 / 建模 / 离线作业的既有口径不变)", async () => {
    const r = await call("");
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual(["tgt_home", "tgt_usw1_a", "tgt_usw2_a"]);
  });

  it("component=airflow(编排页「执行区域(可多选)」):装了 airflow-serverless 或 mwaa 的列;只有数仓的不列;主控区恒在", async () => {
    const r = await call("?component=airflow");
    expect(r.status).toBe(200);
    expect(await ids(r)).toEqual(["tgt_euc1_a", "tgt_home", "tgt_usw2_a"]);
  });

  it("airflow 维度对主控区不看组件(写路径 requireMwaaForTargets 只核非 home,列表不许比写路径更严)", async () => {
    h.targets = [{ ...HOME, components: ["core", "redshift"] }, USW1_NO_SCHED];
    expect(await ids(await call("?component=airflow"))).toEqual(["tgt_home"]);
  });

  it("component=core(治理「新建表」S3 Tables 分支):所有已就位目标", async () => {
    expect(await ids(await call("?component=core"))).toEqual(["tgt_euc1_a", "tgt_home", "tgt_usw1_a", "tgt_usw2_a"]);
  });

  it("呈现 = 授权:项目白名单不含本项目的目标在任何维度都不列", async () => {
    h.targets = [HOME, { ...USW2, access: { mode: "allowlist", projects: ["proj-b"] } }];
    expect(await ids(await call("?component=airflow"))).toEqual(["tgt_home"]);
    expect(await ids(await call("?component=core"))).toEqual(["tgt_home"]);
    expect(await ids(await call(""))).toEqual(["tgt_home"]);
  });

  it("🔴 不在清单的维度 ⇒ 400 VALIDATION_FAILED 并列出清单(不回空列表 —— 空列表会让界面以为「没有可用目标」)", async () => {
    const r = await call("?component=glue");
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toContain("redshift / airflow / core / any");
  });

  it("component=any 仍是顶栏执行范围清单那条路(不筛组件;200)", async () => {
    const r = await call("?component=any");
    expect(r.status).toBe(200);
    expect((await r.json()).success).toBe(true);
  });
});
