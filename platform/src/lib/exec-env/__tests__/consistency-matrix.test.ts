// 版本一致性矩阵**聚合层**的门禁(50 INTERACTION §3.1 + §3.1a)。
//
// 🔴 这张看板最要紧的不是"算出格子",是**别误报**:误报与假绿一样致命 ——
// 全屏黄之后三天就没人看它了,组件白做(§2bis.4 原文)。
// 施工时逮到的两个"假红"口子(§3.1a 定案)在这里逐条钉住:
//   ① 下发路径还没接台账的资源类型**不进矩阵**(否则每格都判「漏发」);
//   ② 从没发布过的定义(草稿)**不进矩阵**(用户还没要求下发过,谈不上"漏")。
// 以及一个"隐藏问题"的口子:列必须取 **活跃 ∪ 出现过**,只取活跃会把"发到过某个后来被摘掉的
// target"**整列藏掉** —— 那是本看板要抓的"漏"的反面。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  items: [] as Array<Record<string, any>>,
  /** 🔴 建模产物的行也走**真的** `listCodeTablesEnriched` / `listModelTablesEnriched` ——
   *  打桩只到 DDB 边界。把那两个函数整个 mock 掉的话,`physicalTable2` / `codeTableId`
   *  这类**字段名写错**就永远测不出来(mock 会照着我写错的名字回)。 */
  codeTables: [] as Array<Record<string, any>>,
  modelTables: [] as Array<Record<string, any>>,
  active: [] as Array<{ targetId: string; region: string }>,
  activeThrows: false,
  versions: {} as Record<string, number>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", CODE_TABLES: "bgp-code-tables", MODEL_TABLES: "bgp-model-tables" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const tn = cmd?.input?.TableName;
      if (tn === "bgp-code-tables") return { Items: h.codeTables };
      if (tn === "bgp-model-tables") return { Items: h.modelTables };
      return { Items: h.items };
    }),
  },
}));

vi.mock("@/lib/exec-env/registry", () => ({
  listActiveTargets: vi.fn(async () => {
    if (h.activeThrows) throw new Error("注册表读失败");
    return h.active;
  }),
}));

vi.mock("@/lib/versions/version-service", () => ({
  currentDefinitionVersion: vi.fn(async (_t: string, id: string) => h.versions[id] ?? 1),
}));

vi.mock("@/lib/projects/guard", () => ({
  projectFilter: vi.fn(() => ({ clause: "projectId = :p", values: { ":p": "proj-x" } })),
}));

import {
  buildConsistencyMatrix,
  isPublishedDefinition,
  isLandedDefinition,
  cellNeedsAttention,
  modelingCell,
  attentionTasks,
  LANDED_TO_CELL,
  MATRIX_COVERED,
  MATRIX_PENDING,
} from "@/lib/exec-env/consistency-matrix";
import { needsAttention, ATTENTION_STATES, type CellState } from "@/lib/exec-env/deployments-shared";
import { LANDED_ATTENTION, landedNeedsAttention, type LandedState } from "@/lib/modeling/landing-shared";
import { codeTableDefHash } from "@/lib/modeling/service";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const dep = (v: number, status: "ok" | "failed" = "ok") => ({ version: v, publishedAt: 1, status });
const sorted = (a: string[]) => a.slice().sort();

/** 真实 DDB 行形状的码表(字段名照抄 `bgp-code-tables` 的真行) */
const ctFixture = (over: Record<string, any> = {}) => ({
  pk: "codetable",
  codeTableId: "ct1",
  name: "订单状态",
  code: "order_status",
  values: [{ value: "0", label: "待付款", seq: 0 }],
  createdAt: "x",
  updatedAt: "x",
  ...over,
});
const mtFixture = (over: Record<string, any> = {}) => ({
  pk: "modeltable",
  modelTableId: "mt1",
  name: "客户维",
  schema: "public",
  physicalTable: "dim_customer",
  tableType: "dimension",
  columns: [{ name: "id", dataType: "BIGINT", isPrimaryKey: true }],
  ...over,
});
const landRec = (status: string, defHash: string, over: Record<string, any> = {}) => ({
  status,
  defHash,
  table: "public.dim_code_order_status",
  at: "2026-09-04T00:00:00.000Z",
  observedAt: "2026-09-04T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  h.items = [];
  h.codeTables = [];
  h.modelTables = [];
  h.activeThrows = false;
  h.versions = {};
  h.active = [
    { targetId: HOME, region: "us-east-1" },
    { targetId: USW2, region: "us-west-2" },
  ];
});

describe("🔴 §3.1a ②:未发布的定义不进矩阵(否则草稿全被判「漏发」= 假红)", () => {
  it("判据 = `scheduleEnabled` 为真 **或** 台账非空", () => {
    expect(isPublishedDefinition({})).toBe(false);
    expect(isPublishedDefinition({ scheduleEnabled: false })).toBe(false);
    expect(isPublishedDefinition({ deployments: {} })).toBe(false);
    expect(isPublishedDefinition({ scheduleEnabled: true })).toBe(true);
    expect(isPublishedDefinition({ deployments: { [USW2]: dep(1) } })).toBe(true);
    // 🔴 「已下线但台账还有历史条目」也要进(让人能看到并清干净)
    expect(isPublishedDefinition({ scheduleEnabled: false, deployments: { [HOME]: dep(1) } })).toBe(true);
  });

  it("草稿被排除,并**如实回报**排除了几个(不是悄悄少几行)", async () => {
    h.items = [
      { jobId: "j1", name: "已发布", projectId: "proj-x", scheduleEnabled: true, targets: [HOME], deployments: { [HOME]: dep(1) } },
      { jobId: "j2", name: "草稿", projectId: "proj-x", targets: [HOME, USW2] },
      { jobId: "j3", name: "草稿2", projectId: "proj-x" },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.rows.map((r) => r.id)).toEqual(["j1"]);
    expect(m.excluded.unpublished, "排除的条数没回报 ⇒ 用户以为看板列全了").toBe(2);
  });
});

describe("🔴 §3.1a ①:覆盖面如实登记(不许假装一屏看全)", () => {
  it("covered 只含**真写了逐 target 真值**的类型;pending 把没接的都列出来", async () => {
    h.items = [{ jobId: "j1", name: "n", projectId: "proj-x", scheduleEnabled: true, targets: [HOME] }];
    const m = await buildConsistencyMatrix("proj-x");
    // 任务行接的是下发台账;建模产物行接的是 `landedByTarget` 观测态(W3-d2 混排进来)
    expect(m.covered).toEqual(["etl-job", "code-table", "model-table"]);
    expect([...MATRIX_COVERED]).toEqual(["etl-job", "code-table", "model-table"]);
    expect(m.pending.length, "没接台账的类型一个都不列 ⇒ 用户会以为矩阵覆盖全平台").toBeGreaterThan(0);
    expect([...MATRIX_PENDING]).toContain("workflow");
    expect(m.rows.every((r) => MATRIX_COVERED.includes(r.type as any))).toBe(true);
  });

  it("🔴 口径如实登记:任务是**本项目**的、建模产物是**平台全局**的(建模没有项目维度)", async () => {
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.scope.project).toEqual(["etl-job"]);
    expect(
      sorted(m.scope.global),
      "建模是平台级全局却不登记 ⇒ 用户会以为这一屏都是自己项目里的东西"
    ).toEqual(["code-table", "model-table"]);
  });
});

describe("🔴🔴 列的取法:活跃 ∪ 出现过(只取活跃会把已下线的区整列藏掉)", () => {
  it("台账里出现过但注册表已不活跃的 target 仍然成列,并标 `active:false`", async () => {
    h.active = [{ targetId: HOME, region: "us-east-1" }];
    h.items = [
      { jobId: "j1", name: "n", projectId: "proj-x", scheduleEnabled: true, targets: [HOME],
        deployments: { [HOME]: dep(1), tgt_gone_a: dep(1) } },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const ids = m.columns.map((c) => c.targetId);
    expect(ids, "已下线的区整列消失 ⇒ 「发到过那里」这件事被藏起来了").toContain("tgt_gone_a");
    expect(m.columns.find((c) => c.targetId === "tgt_gone_a")!.active).toBe(false);
    expect(m.columns[0].targetId, "home 必须是第一列(列顺序不许随注册表返回顺序抖动)").toBe(HOME);
  });

  it("🔴 注册表读失败 ⇒ **抛**,不回落成「只有 home」(缺列会把漏发隐藏掉)", async () => {
    h.activeThrows = true;
    h.items = [{ jobId: "j1", name: "n", projectId: "proj-x", scheduleEnabled: true, targets: [HOME] }];
    await expect(buildConsistencyMatrix("proj-x")).rejects.toThrow(/执行目标清单/);
  });
});

describe("🔴🔴 格子与计数:只有三类参与判定", () => {
  it("漏发 / 版本不齐 / 失败 各自计入;未绑定 / 已特化 都不计", async () => {
    h.versions = { j1: 5, j2: 5, j3: 5, j4: 5 };
    h.items = [
      // 绑两个区,usw2 从没发过 ⇒ 漏发(计 1)
      { jobId: "j1", name: "漏发", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5) } },
      // usw2 发的是旧版本 ⇒ 版本不齐(计 1)
      { jobId: "j2", name: "不齐", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5), [USW2]: dep(4) } },
      // 只绑一个区(区域专属)⇒ 另一列 unbound,**不计**
      { jobId: "j3", name: "专属", projectId: "proj-x", scheduleEnabled: true, targets: [USW2],
        deployments: { [USW2]: dep(5) } },
      // 已特化 ⇒ 即便版本老也**不计**
      { jobId: "j4", name: "特化", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5), [USW2]: dep(1) }, specializedFrom: { [USW2]: { sourceId: "j4", at: 1 } } },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const by = Object.fromEntries(m.rows.map((r) => [r.id, r]));
    expect(by.j1.cells[USW2].state).toBe("never-deployed");
    expect(by.j2.cells[USW2].state).toBe("stale");
    expect(by.j3.cells[HOME].state, "区域专属任务在别的区必须是 unbound,不能是漏发").toBe("unbound");
    expect(by.j4.cells[USW2].state).toBe("specialized");
    expect(by.j3.attention, "区域专属被算进「需要处理」⇒ 看板天天误报").toBe(0);
    expect(by.j4.attention, "已特化被算进「需要处理」⇒ 每个特化格常年报黄").toBe(0);
    expect(m.summary.attentionCells).toBe(2);
    expect(m.summary.attentionRows).toBe(2);
  });

  it("🔴 需要处理的行排最前(看板的价值就是「要管的先看见」)", async () => {
    h.versions = { a1: 5, z9: 5 };
    h.items = [
      { jobId: "a1", name: "aaa 一致", projectId: "proj-x", scheduleEnabled: true, targets: [HOME], deployments: { [HOME]: dep(5) } },
      { jobId: "z9", name: "zzz 漏发", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2], deployments: { [HOME]: dep(5) } },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.rows[0].id, "一致的行排在了需要处理的行前面 ⇒ 要管的那条要翻页才看得到").toBe("z9");
  });

  it("待重发清单与 `ATTENTION_STATES` **同一个真值源**(列两遍必有一天不一致)", async () => {
    // 🔴 场景必须**同时含三种待处理态**。第一版只造了 `failed` 一种,于是"清单只收 failed"
    //    这个变异(M94)改不动结果、门禁全绿 —— 单一状态的场景钉不住"同源"这件事。
    h.versions = { j1: 5, j2: 5, j3: 5 };
    h.items = [
      // failed
      { jobId: "j1", name: "n1", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5), [USW2]: dep(5, "failed") } },
      // never-deployed(漏发)
      { jobId: "j2", name: "n2", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5) } },
      // stale(版本不齐)
      { jobId: "j3", name: "n3", projectId: "proj-x", scheduleEnabled: true, targets: [HOME, USW2],
        deployments: { [HOME]: dep(5), [USW2]: dep(3) } },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const tasks = attentionTasks(m);
    expect(
      sorted(tasks.map((x) => x.state)),
      "清单漏了某一类待处理态 ⇒ 看板显红、批量重发却跳过它(两处判据不同源)"
    ).toEqual(["failed", "never-deployed", "stale"]);
    expect(tasks.length, "清单条数与看板计数不一致 ⇒ 同一件事有两个说法").toBe(m.summary.attentionCells);
    expect(tasks.every((x) => x.targetId === USW2)).toBe(true);
  });

  it("失败格把 error / artifact 带出来(「从没发过」与「发过但失败」处置完全不同)", async () => {
    h.versions = { j1: 2 };
    h.items = [
      { jobId: "j1", name: "n", projectId: "proj-x", scheduleEnabled: true, targets: [HOME],
        deployments: { [HOME]: { version: 2, publishedAt: 9, status: "failed", error: "AccessDenied", artifact: "bgp_etl_j1" } } },
    ];
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.rows[0].cells[HOME]).toMatchObject({ state: "failed", version: 2, error: "AccessDenied", artifact: "bgp_etl_j1" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §3.1b  W3-d2:「建模产物」行组混排 —— 四个必须一次做对的点
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴🔴 观测态 → 格子态:穷举映射 + **两侧 attention 口径必须逐态相等**", () => {
  it("`LANDED_TO_CELL` 覆盖全部 6 个观测态(漏一个态就会静默落进默认值,而默认值最可能是绿;:residency-blocked 已删)", () => {
    expect(sorted(Object.keys(LANDED_TO_CELL))).toEqual([
      "credential-gap", "drift", "failed", "never-landed", "ok", "stale",
    ]);
  });

  it("🔴🔴 逐态比对:落地面板判「要处理」的,看板也必须判「要处理」(反之亦然)", () => {
    // 这是本批最承重的一条断言:两处各写一份清单,总有一天不一致 ——
    // 表现就是「落地面板红着、看板绿着」,同一件事两个说法。
    for (const s of Object.keys(LANDED_TO_CELL) as LandedState[]) {
      expect(
        needsAttention(LANDED_TO_CELL[s]),
        `观测态 ${s} 在两侧的「要不要处理」口径不一致(映到 ${LANDED_TO_CELL[s]})`
      ).toBe(landedNeedsAttention(s));
    }
  });

  it("🔴 `drift` 必须计入判定,两个 ⊘ 必须**不**计入(按了也没用 ⇒ 计入就是天天误报)", () => {
    expect([...ATTENTION_STATES].sort()).toEqual(["drift", "failed", "never-deployed", "stale"]);
    expect(needsAttention("drift")).toBe(true);
    expect(needsAttention("residency-blocked")).toBe(false);
    expect(needsAttention("credential-gap")).toBe(false);
    expect([...LANDED_ATTENTION]).toContain("drift");
  });
});

describe("🔴 §3.1b 入选规则:没落过也没绑过区的建模定义**不进矩阵**", () => {
  it("判据 = 有落地记录 **或** 显式绑过 region;`bindingTargets` 的 home 回落**不算**", () => {
    expect(isLandedDefinition({})).toBe(false);
    expect(isLandedDefinition({ landedByTarget: {} })).toBe(false);
    expect(isLandedDefinition({ targets: [] })).toBe(false);
    // 🔴 存量码表根本没有 `targets` 属性;若用 `bindingTargets()` 判就会被当成「绑过 home」⇒ 草稿全进矩阵
    expect(isLandedDefinition({ targets: [HOME] })).toBe(true);
    expect(isLandedDefinition({ landedByTarget: { [HOME]: { status: "ok" } } })).toBe(true);
  });

  it("草稿码表被排除并**如实回报**条数(不是悄悄少几行)", async () => {
    h.codeTables = [
      ctFixture({ codeTableId: "c1", code: "a1", targets: [HOME], landedByTarget: { [HOME]: landRec("ok", "zzz") } }),
      ctFixture({ codeTableId: "c2", code: "a2" }),
      ctFixture({ codeTableId: "c3", code: "a3" }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.rows.map((r) => r.id)).toEqual(["c1"]);
    expect(m.excluded.unlanded, "排除的建模定义条数没回报 ⇒ 用户以为看板列全了").toBe(2);
  });
});

describe("🔴🔴 建模产物格子:⊘ 不计入、drift 计入但**不给一键**", () => {
  it("home 已落 ok + usw2 缺写入通道 ⇒ 那一行 0 个待处理,且 ⊘ 不进待处置清单", async () => {
    const hash = await codeTableDefHash({ code: "order_status", values: [{ value: "0", label: "待付款", seq: 0 }] } as any);
    h.codeTables = [
      ctFixture({
        targets: [HOME, USW2],
        landedByTarget: {
          [HOME]: landRec("ok", hash),
          [USW2]: landRec("credential-gap", hash, { error: "缺窄权 shared-writer 通道" }),
        },
      }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.id === "ct1")!;
    // 🔴 这里同时钉住了「读侧比的是**同一个** defHash」:若矩阵取错字段,ok 会退化成 stale
    expect(row.cells[HOME].state, "落地时的 defHash 与列表侧算出来的应当相等 ⇒ ok").toBe("ok");
    expect(row.cells[USW2].state).toBe("credential-gap");
    expect(row.attention, "⊘ 缺写入通道被算进「需要处理」⇒ 用户永远处理不掉 = 天天误报").toBe(0);
    expect(attentionTasks(m).length).toBe(0);
    expect(row.group).toBe("modeling");
    expect(row.type).toBe("code-table");
    // 物理落点走**真的** enricher(`physicalTable`),字段名写错这里会露
    expect(row.physical).toBe("public.dim_code_order_status");
    expect(row.cells[HOME].observedAt, "没有观测时间 ⇒ 界面只能把陈旧观测画成实时绿灯").toBeTruthy();
  });

  it("🔴🔴 drift 计入判定,但**不可一键处置**,且跳过原因说清是因为要 DROP", async () => {
    h.codeTables = [
      ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("drift", "whatever", { observedColumns: "foo:integer" }) } }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.id === "ct1")!;
    expect(row.cells[HOME].state).toBe("drift");
    expect(row.attention, "drift 是观测到的真不一致,不计入就等于看板不报真问题").toBe(1);
    const tasks = attentionTasks(m);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].actionable, "drift 给了一键 ⇒ 一次批量就会 DROP 掉别人的表(有损且不可逆)").toBe(false);
    expect(tasks[0].skipReason).toMatch(/DROP/);
    expect(m.summary.attentionCells).toBe(1);
    expect(m.summary.actionableCells, "按钮上的数用了总数 ⇒ 点下去「处理 1 个」实际动 0 个(过度承诺)").toBe(0);
  });

  it("绑了却没落过 ⇒ 未落地(计入);没绑又没记录 ⇒ 未绑定(不计入)", async () => {
    h.codeTables = [ctFixture({ targets: [HOME, USW2], landedByTarget: { [HOME]: landRec("ok", "h-old") } })];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.id === "ct1")!;
    expect(row.cells[USW2].state).toBe("never-deployed");
    expect(row.cells[HOME].state, "定义指纹变了 ⇒ 版本不齐").toBe("stale");
    expect(row.attention).toBe(2);
    h.codeTables = [ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("ok", "h-old") } })];
    const m2 = await buildConsistencyMatrix("proj-x");
    expect(m2.rows[0].cells[USW2].state, "只绑 home 的码表在别的区必须是未绑定,不能报「未落地」").toBe("unbound");
  });

  it("🔴 维度/事实表走**同一个作者**,落点取 `schema.physicalTable`", async () => {
    h.modelTables = [mtFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("failed", "h", { error: "AccessDenied" }) } })];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.type === "model-table")!;
    expect(row.physical, "`listModelTablesEnriched` 把 schema.table 放在 `physicalTable2`,取错字段这里会露").toBe("public.dim_customer");
    expect(row.cells[HOME].state).toBe("failed");
    expect(row.cells[HOME].error).toBe("AccessDenied");
    expect(attentionTasks(m)[0].type, "待处置清单不带类型 ⇒ 一键处置会拿 modelTableId 去打任务调度端点").toBe("model-table");
  });
});

describe("🔴🔴 残留:解绑不会删掉那个区已经建出来的表 —— 不计入判定,但**绝不隐藏**", () => {
  it("有落地记录却当前没绑 ⇒ 标 residual、状态照实、不计入需处理", async () => {
    const hash = await codeTableDefHash({ code: "order_status", values: [{ value: "0", label: "待付款", seq: 0 }] } as any);
    h.codeTables = [
      ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("ok", hash), [USW2]: landRec("ok", hash) } }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.id === "ct1")!;
    expect(row.cells[USW2].residual, "画成「—未绑定」⇒ 那份留在别的法域里的表被藏起来了").toBe(true);
    expect(row.cells[USW2].state, "残留格的状态要照实(它确实还在那儿)").toBe("ok");
    expect(row.attention).toBe(0);
  });

  it("🔴🔴 整张矩阵里:残留格带着**需处理态**时,行内计数与待处置清单**都**要扣掉它", async () => {
    // 🔴 这条是补 M116 的:原来两条残留用例一条用 `ok`(两种判据结果相同)、一条只直接调纯函数,
    //    于是"清单改用 needsAttention"这个变异根本不变红 —— 典型的弱用例。
    //    只有当**残留格恰好是需处理态**、并且走完整条 `buildConsistencyMatrix` 才钉得住"同一个判据"。
    h.codeTables = [
      ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("ok", "h-old"), [USW2]: landRec("drift", "h-old") } }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    const row = m.rows.find((r) => r.id === "ct1")!;
    expect(row.cells[USW2].state, "残留格的状态要照实(那个区确实有一张结构不同的表)").toBe("drift");
    expect(row.cells[USW2].residual).toBe(true);
    // home 那格是 stale(定义指纹变了)⇒ 恰好 1 个待处理,残留那格不算
    expect(row.attention, "残留的 drift 被算进行内计数 ⇒ 用户点不掉、天天红").toBe(1);
    const tasks = attentionTasks(m);
    expect(tasks.map((x) => x.targetId), "清单收了残留格 ⇒ 一键处置会去动一个没绑的区(且它本来就没有清理动作)").toEqual([HOME]);
    expect(tasks.length).toBe(m.summary.attentionCells);
  });

  it("🔴 残留 + 需处理态(如 drift)也**不计入**(没有清理通道,算进去就是永远处理不掉的红点)", () => {
    const cell = modelingCell({
      targetId: USW2,
      targets: [HOME],
      defHash: "h",
      landedByTarget: { [USW2]: landRec("drift", "h") as any },
    });
    expect(cell.state).toBe("drift");
    expect(cell.residual).toBe(true);
    expect(cellNeedsAttention(cell), "残留格算进判定 ⇒ 用户点不掉、天天红").toBe(false);
    // 而同一个格子**绑着**的时候必须计入
    expect(cellNeedsAttention(modelingCell({ targetId: USW2, targets: [USW2], defHash: "h", landedByTarget: { [USW2]: landRec("drift", "h") as any } }))).toBe(true);
  });

  it("🔴 判定顺序:有记录时**先按观测态判**,不许先判「没绑」(否则残留被藏)", () => {
    // 没记录 + 没绑 ⇒ unbound;没记录 + 绑了 ⇒ 未落地
    expect(modelingCell({ targetId: USW2, targets: [HOME], defHash: "h", landedByTarget: {} }).state).toBe("unbound");
    expect(modelingCell({ targetId: USW2, targets: [USW2], defHash: "h", landedByTarget: {} }).state).toBe("never-deployed");
  });
});

describe("🔴 混排后的列、排序与字段口径", () => {
  it("只在建模产物里出现过的 target 也要成列(否则那份数据彻底看不见)", async () => {
    h.active = [{ targetId: HOME, region: "us-east-1" }];
    h.codeTables = [ctFixture({ targets: [HOME], landedByTarget: { tgt_euw1_a: landRec("ok", "h") } })];
    const m = await buildConsistencyMatrix("proj-x");
    const ids = m.columns.map((c) => c.targetId);
    expect(ids).toContain("tgt_euw1_a");
    expect(m.columns.find((c) => c.targetId === "tgt_euw1_a")!.active).toBe(false);
  });

  it("🔴 任务行不带定义指纹、建模行不带版本号(免得界面印出一个假的「v0」)", async () => {
    h.versions = { j1: 3 };
    h.items = [{ jobId: "j1", name: "任务", projectId: "proj-x", scheduleEnabled: true, targets: [HOME], deployments: { [HOME]: dep(3) } }];
    h.codeTables = [ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("ok", "h") } })];
    const m = await buildConsistencyMatrix("proj-x");
    const task = m.rows.find((r) => r.group === "task")!;
    const model = m.rows.find((r) => r.group === "modeling")!;
    expect(task.currentVersion).toBe(3);
    expect(task.currentDefHash).toBeUndefined();
    expect(model.currentVersion, "建模没有版本快照,给了数字界面就会印「v0」").toBeUndefined();
    expect(model.currentDefHash).toBeTruthy();
  });

  it("需处理的行排最前;同等时任务组在前(两组混排也要有稳定顺序)", async () => {
    h.versions = { j1: 1 };
    h.items = [{ jobId: "j1", name: "b任务", projectId: "proj-x", scheduleEnabled: true, targets: [HOME], deployments: { [HOME]: dep(1) } }];
    // 🔴 c1 必须**真的一致**(记录里的 defHash = 列表侧算出来的那个),否则它自己就是 stale、
    //    这条排序断言就变成了"两个待处理行按名字排",钉不住"待处理排最前"。
    const h1 = await codeTableDefHash({ code: "a1", values: [{ value: "0", label: "待付款", seq: 0 }] } as any);
    h.codeTables = [
      ctFixture({ codeTableId: "c1", code: "a1", name: "a码表", targets: [HOME], landedByTarget: { [HOME]: landRec("ok", h1) } }),
      ctFixture({ codeTableId: "c2", code: "a2", name: "z码表漂移", targets: [HOME], landedByTarget: { [HOME]: landRec("drift", "h2") } }),
    ];
    const m = await buildConsistencyMatrix("proj-x");
    expect(m.rows[0].id, "有待处理的行没排最前 ⇒ 要管的那条要翻页才看得到").toBe("c2");
    expect(m.rows[1].group, "同分时任务组在前(顺序抖动会让人以为看板变了)").toBe("task");
  });

  it("待处置清单条数与看板计数**同源**(混排后依然)", async () => {
    h.versions = { j1: 5 };
    h.items = [{ jobId: "j1", name: "任务", projectId: "proj-x", scheduleEnabled: true, cronExpression: "0 1 * * *",
                 targets: [HOME, USW2], deployments: { [HOME]: dep(5) } }];
    h.codeTables = [ctFixture({ targets: [HOME], landedByTarget: { [HOME]: landRec("drift", "h") } })];
    const m = await buildConsistencyMatrix("proj-x");
    const tasks = attentionTasks(m);
    expect(tasks.length).toBe(m.summary.attentionCells);
    expect(sorted(tasks.map((x) => `${x.type}:${x.state}:${x.actionable}`))).toEqual([
      "code-table:drift:false",
      "etl-job:never-deployed:true",
    ]);
  });
});
