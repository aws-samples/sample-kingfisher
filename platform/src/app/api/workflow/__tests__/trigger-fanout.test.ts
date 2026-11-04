// 编排(工作流)的**手动触发必须按全部绑定 target 扇出** —— 与离线作业同一条通道。
//
// 【用户 2026-09-15 逐字】「美西2的任务从来没有执行过 ETL 编排…我不是让你在美东1 发布执行多个区域吗?」
// 【改动前的事实】`/api/workflow/[id]/trigger` 里是 `bindingTargets(...)[0]` ——
// 绑了两个区,点一次「触发」**只有第一个区真跑**,另一个区什么都没发生**且不报错**;
// 界面上两个区都亮着 ⇒ 正是客户痛点「怕漏 region 对不上」。
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const started: Array<{ region: string; arn: string }> = [];
const groupOpens: Array<Record<string, unknown>> = [];
const noted: Array<Record<string, unknown>> = [];
const putRuns: Array<Record<string, unknown>> = [];

const WF = {
  workflowId: "wf1", projectId: "p1", airflowDagId: "bgp_wf1",
  targets: ["tgt_home", "tgt_usw2_a"],
  deployments: {
    tgt_home: { workflowArn: "arn:home" },
    tgt_usw2_a: { workflowArn: "arn:usw2" },
  },
};

// 触发经 submitLongOp ⇒ 任务表 bgp-long-ops 交给内存夹具(真求值条件写 / 租约释放),工作流表照旧回 WF
vi.mock("@/lib/aws/dynamodb", async () => {
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    TABLES: { WORKFLOWS: "wf", TASK_RUNS: "runs", LONG_OPS: "bgp-long-ops" },
    docClient: {
      send: vi.fn(async (cmd: { input?: Record<string, any> }) => {
        if (cmd.input?.TableName === "bgp-long-ops") return mem.docClient.send(cmd);
        return cmd.input?.Key ? { Item: WF } : {};
      }),
    },
  };
});
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/residency-audit", () => ({
  requireResidencyAckForTargets: vi.fn(async () => {}),
  residencyErrorResponse: vi.fn(() => null),
}));
vi.mock("@/lib/scheduler/mwaa-endpoint", () => ({
  // 两个区都是 serverless(现网形态);端点解析按 target 回不同 region
  schedulerEndpointFor: vi.fn(async (t: string) => ({ targetId: t, region: t === "tgt_home" ? "us-east-1" : "us-west-2", kind: "serverless" })),
  isServerlessEndpoint: vi.fn(() => true),
  mwaaClientFor: vi.fn(),
  MwaaNotInstalled: class extends Error {},
  mwaaErrorResponse: vi.fn(),
}));
vi.mock("@/lib/scheduler/serverless/workflow-client", () => ({
  findWorkflowArnByName: vi.fn(async () => undefined),
  startWorkflowRun: vi.fn(async (region: string, arn: string) => {
    started.push({ region, arn });
    return { RunId: `svc-${region}` };
  }),
}));
// trigger 路由经 submitLongOp 带进整张执行体注册表 ⇒ 产物生成链(runtime-py)也会 import 本模块的 python 源函数,只覆盖两个被测函数
vi.mock("@/lib/monitor/run-groups", async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  openRunGroupIfFanout: vi.fn(async (a: Record<string, unknown>) => { groupOpens.push(a); }),
  noteFanoutResult: vi.fn(async (rg: unknown, t: unknown, r: unknown) => { noted.push({ rg, t, r }); }),
}));
vi.mock("@/lib/monitor/run-records", () => ({
  putRunRecord: vi.fn(async (a: Record<string, unknown>) => { putRuns.push(a); }),
  resolveRunStamp: vi.fn((owner: { projectId?: string }, tid?: string) => ({ projectId: owner?.projectId ?? "p1", targetId: tid ?? "tgt_home" })),
}));

const post = async (body?: unknown) => {
  const { POST } = await import("@/app/api/workflow/[id]/trigger/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://x/api/workflow/wf1/trigger", {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const res = await POST(req, { params: { id: "wf1" } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

// 首次 import 路由会带进整张执行体注册表(几百个模块的变换,实测 > 5s)⇒ 先暖一次,免得第一条用例被 5s 缺省超时误判、其路由体在下一条用例里才跑完
beforeAll(async () => { await import("@/app/api/workflow/[id]/trigger/route"); }, 60_000);
beforeEach(async () => {
  started.length = 0; groupOpens.length = 0; noted.length = 0; putRuns.length = 0; vi.clearAllMocks();
  (await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops")).resetMemLongOps();
});

describe("🔴🔴 编排手动触发:缺省在**全部绑定区**各跑一次", () => {
  it("不传 targets ⇒ 两个区都真触发(改动前只有第一个区)", async () => {
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.body.runs?.map((x: any) => x.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    // 🔴 真的打到了两个**不同的** region 的服务(不是打两次同一个)
    expect(started.map((x) => x.region).sort()).toEqual(["us-east-1", "us-west-2"]);
    expect(started.map((x) => x.arn).sort()).toEqual(["arn:home", "arn:usw2"]);
  });

  it("🔴 多区共享**一个** runGroupId,且组行在扇出之前就建出来(否则这批 run 永远归不了组)", async () => {
    const r = await post({});
    expect(r.body.runGroupId).toMatch(/^rg_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(groupOpens).toHaveLength(1);
    expect(groupOpens[0]).toMatchObject({ definitionKind: "workflow", definitionId: "wf1", requestedTargets: ["tgt_home", "tgt_usw2_a"], triggeredBy: "manual" });
    // 逐区记账:两条都记上
    expect(noted.map((x) => x.t).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
  });

  it("显式给子集 ⇒ 只跑那一个区(单区**不成组**:行上不落 runGroupId)", async () => {
    const r = await post({ targets: ["tgt_usw2_a"] });
    expect(r.body.runs.map((x: any) => x.targetId)).toEqual(["tgt_usw2_a"]);
    expect(r.body.runGroupId).toBeUndefined();
    expect(started.map((x) => x.region)).toEqual(["us-west-2"]);
  });

  it("🔴 反例:给一个**不在绑定里**的 target ⇒ 409 拒,且**一个区都不许触发**(静默忽略 = 「我按你说的跑了」)", async () => {
    const r = await post({ targets: ["tgt_euw1_zz"] });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("不在该工作流的绑定里");
    expect(started).toHaveLength(0);
  });

  it("🔴 反例:targets 传空数组 ⇒ 400(不许当成「全部」)", async () => {
    const r = await post({ targets: [] });
    expect(r.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it("🔴 一个区失败不许拖垮另一个区:第二个区找不到产物 ⇒ 另一个区照样跑,失败逐区如实回报(带 code)", async () => {
    const wc = await import("@/lib/scheduler/serverless/workflow-client");
    (wc.startWorkflowRun as any).mockImplementation(async (region: string, arn: string) => {
      if (region === "us-west-2") throw new Error("boom");
      started.push({ region, arn });
      return { RunId: "svc-home" };
    });
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.body.runs).toHaveLength(1);
    expect(r.body.failures?.[0]).toMatchObject({ targetId: "tgt_usw2_a" });
    expect(started.map((x) => x.region)).toEqual(["us-east-1"]);
  });
});

// 发布侧同样要「一次发布 → 每个绑定区各一份产物」
describe("🔴🔴 编排发布:一次发布 = 全部绑定区各一份产物", () => {
  it("`publishWorkflowDag` 逐 target 发布(不再只发 bindings[0]),并逐区回报", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../../lib/workflow/publish-dag.ts", import.meta.url), "utf8"));
    // 扇出版必须存在且**遍历全部绑定**
    expect(src).toMatch(/export async function publishWorkflowDag\(/);
    expect(src).toMatch(/const targets = bindingTargets\(/);
    expect(src).toMatch(/for \(const t of list\)/);
    expect(src).toContain("publishWorkflowDagToTarget(workflow, t, opts)");
    // 🔴 反例:per-target 版里不许再出现「取第一个绑定」那句(那正是这次要根治的东西)
    // 🔴 负向文本断言**必先剥注释**(仓里的老坑):扇出版的文档注释里就写着「改动前这里是
    //    `bindingTargets(...)[0]`」,不剥掉的话这条负向永远假红。
    const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const perTarget = stripComments(
      src.slice(src.indexOf("export async function publishWorkflowDagToTarget"), src.indexOf("export async function publishWorkflowDag("))
    );
    expect(perTarget, "per-target 版还在自己挑第一个绑定 ⇒ 扇出等于没做").not.toMatch(/bindingTargets\([^)]*\)\[0\]/);
    // 逐 target 各自 try(一个区失败不许把已发好的当成没发)
    expect(src).toMatch(/perTarget\.push\(\{ targetId: t, ok: false/);
  });
});

// 入口:创建/改绑必须能给多个区,且逐个校验
describe("🔴🔴 编排的绑定入口:创建就能绑多区(否则扇出通道永远没有输入)", () => {
  const readRaw = (rel: string) =>
    require("node:fs").readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8") as string;
  // 🔴 负向文本断言**先剥注释**(仓里的老坑,今天第二次踩):注释里写着「改动前这里恒写
  //    `targets: [wantTarget]`」,不剥掉这条负向永远假红。
  const read = (rel: string) =>
    readRaw(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

  it("POST /api/workflow:`targets` 多值落库、逐个校验、非 home 逐个核调度组件", () => {
    const src = read("app/api/workflow/route.ts");
    expect(src).toContain("targets: wantTargets");
    // 解析(多值 / 单值 / 去重 / 非法即拒 / 空即拒)收成唯一作者 requestedTargets,
    //   行为判据在 lib/place/__tests__/requested-target.test.ts;这里钉「本路由走的是它」
    expect(src).toMatch(/requestedTargets\(body, "新建工作流"\)/);
    expect(src).toContain("requireMwaaForTargets(nonHome)");
    // 🔴 反例:回到单值就红
    expect(src).not.toContain("targets: [wantTarget]");
  });

  it("发布执行体必须把**逐区结果**透出去(一个区成一个区没成,不许只回一个 dagId 藏起来)", () => {
    // 发布主体在执行体 workflow-publish(rawBody 原样交回摊平形状);路由只 submitLongOp 自己的 kind
    expect(read("app/api/workflow/[id]/publish/route.ts")).toContain('kind: "workflow-publish"');
    const src = read("lib/workflow/long-ops.ts");
    expect(src).toMatch(/\(\{ dagId, scheduler, perTarget \} = await publishWorkflowDag/);
    expect(src).toContain("perTarget,");
    expect(src).toContain("partial: true");
  });

  it("PUT /api/workflow/[id]:改绑定也要过同一道校验(原来是 ...body 裸抄进 DDB)", () => {
    const src = read("app/api/workflow/[id]/route.ts");
    // 改绑定的判断 / 解析收成唯一作者(行为判据见 requested-target.test.ts)
    expect(src).toMatch(/if \(hasTargetsPatch\(body\)\)/);
    expect(src).toMatch(/requestedTargets\(body, "修改编排绑定"\)/);
    expect(src).toContain("requireMwaaForTargets(nonHome)");
    expect(src, "空绑定必须拒(编排至少绑一个区)").toContain("targets 不能为空");
  });

  it("页面:新建弹窗给的是**多选** + 全选按钮 + 计数标签(只勾一个时多选长得像单选,必须有可见标签)", () => {
    const src = read("app/workflow/page.tsx");
    expect(src).toContain('mode="multiple"');
    expect(src).toContain('data-testid="wf-create-targets"');
    expect(src).toContain('data-testid="wf-create-targets-all"');
    expect(src).toContain("执行区域(可多选)");
    // 触发也要走同一个弹窗(绑多区才弹)
    expect(src).toContain("RunTargetsModal");
    expect(src).toMatch(/bound\.length > 1/);
  });
});

/**
 * 🔴🔴 **闭合式接线门**:凡是走扇出发布的路由,拒因分派必须过**同一个作者**。
 * 缘由(2026-09-16 段 slsw):扇出把 `MwaaNotInstalled` / `ServerlessNodeUnsupported` 包成裸 Error,
 * 路由里各写一遍的 `instanceof` 全部落空 ⇒ 「图里有 external 节点」「那个区没装调度器」
 * 双双被回成 500「平台故障」。收成一个作者之后,**新增路由漏接**这一处就会被这道门抓住。
 * 门的形状 = 「谁 import 了扇出实现,就必须 import 那个分派器」(集合关系,不是关键字计数)。
 */
describe("🔴 扇出拒因分派的单一作者(闭合式接线门)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const API_ROOT = new URL("../../../../app/api", import.meta.url).pathname;

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("每个调用扇出发布的路由都接上了 `schedulerRejectResponse`,且不再自己判 instanceof", () => {
    // 🔴 **先剥注释**再判「接上了没」:本仓老坑,而且这一条被变异实测抓到过 ——
    //    路由里那段解释性注释**本身就写着** `schedulerRejectResponse`,不剥的话
    //    「把调用删掉、只留注释」这种最典型的退化会被判成绿。
    const strip = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    // 发布路由的主体搬进执行体 lib/workflow/long-ops.ts ⇒ 调用扇出发布的载体 = 执行体 + schedule/enable 路由
    const EXEC = path.resolve(API_ROOT, "../../lib/workflow/long-ops.ts");
    const users = [...walk(API_ROOT), EXEC]
      .map((f) => ({ f, src: strip(fs.readFileSync(f, "utf8")) }))
      .filter(({ src }) => /await publishWorkflowDag\(/.test(src));
    // 载体本身必须存在(0 个 = 门空转,这是最危险的假绿)
    expect(users.length, "没有任何路由调用扇出发布 ⇒ 这道门在空转").toBeGreaterThanOrEqual(2);
    const missing = users.filter(({ src }) => !/schedulerRejectResponse\(/.test(src));
    expect(missing.map((x) => path.relative(API_ROOT, x.f)), "这些路由没接分派器 ⇒ 它们的 4xx 会退化成 500").toEqual([]);
    // 🔴 反例:不许再在路由里自己判(两处判定 = 迟早只改一处)
    const selfJudging = users.filter(({ src }) => /instanceof (MwaaNotInstalled|ServerlessNodeUnsupported)/.test(src));
    expect(selfJudging.map((x) => path.relative(API_ROOT, x.f)), "路由自己又判了一遍 ⇒ 与单一作者迟早漂移").toEqual([]);
  });

  it("触发路由的响应/拒因都过单一作者(顶层兼容字段 + 409 补装出路)", () => {
    // 扇出主体在执行体 workflow-trigger;路由只留子集校验 / 法域同意 / 运行组开立 + submitLongOp
    const route = fs.readFileSync(new URL("../[id]/trigger/route.ts", import.meta.url), "utf8");
    expect(route).toContain('kind: "workflow-trigger"');
    const src = fs.readFileSync(new URL("../../../../lib/workflow/long-ops.ts", import.meta.url), "utf8");
    expect(src).toContain("fanoutRunBody(");
    expect(src).toContain("schedulerRejectResponse(fanoutRejection(");
    expect(src).toContain("tagFanoutFailure(");
    // 🔴 反例:再出现「把拒因包成裸 Error」就红
    const stripComments = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const body = stripComments(src);
    expect(body, "包成裸 Error 会把 code / 类型一起丢掉").not.toMatch(/throw new Error\(`触发失败/);
    expect(body).not.toMatch(/throw new Error\(`该区没装调度器/);
  });
});
