// 🔴🔴 **落地一个子集不许把别的区静默解绑**(W3-d2 施工时逮到的第三个真 bug)。
//
// 起因:W3-d2 在版本一致性矩阵的每个格子上加了〔落地到此 region〕,它只带**那一个** target。
// 而 `landCodeTableById` / `applyModelTableById` 原来把入参 `targets` **直接写回绑定** ⇒
// 点一下那个按钮就把这张码表的**其它区全解绑**了。任务侧早已明令禁止这种事
// (W3-b:子集重发点名未绑区**直接拒**、绝不动绑定;`verify_w3c2_matrix.py` W3c2-9 就是那条判据)。
//
// 定案:**本次落地的目标** 与 **定义的绑定** 是两件事 ——
//   · 落地只作用于本次目标;
//   · 绑定**只增不减**(落地即绑定);
//   · 解绑必须是**显式动作** —— 本期没有那个动作,已如实登记(见 INTERACTION §3.1b 的「残留」段)。
//
// 打桩只到 `landToTargets`(AWS 边界)与 DDB;绑定归一/合并/写回全部真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  item: null as Record<string, any> | null,
  puts: [] as Array<{ table: string; item: Record<string, any> }>,
  landedWith: [] as string[][],
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { CODE_TABLES: "bgp-code-tables", MODEL_TABLES: "bgp-model-tables", MODEL_ASSETS: "bgp-model-assets" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const n = cmd.constructor.name;
      if (n.startsWith("Get")) return { Item: h.item };
      if (n.startsWith("Put")) {
        h.puts.push({ table: cmd.input.TableName, item: cmd.input.Item });
        return {};
      }
      return { Items: [] };
    }),
  },
}));

vi.mock("@/lib/modeling/landing", () => ({
  landToTargets: vi.fn(async (args: any) => {
    h.landedWith.push([...args.targets]);
    return Object.fromEntries(
      (args.targets as string[]).map((t) => [
        t,
        { status: "ok", defHash: args.defHash, table: `${args.schema}.${args.table}`, at: "x", observedAt: "x" },
      ])
    );
  }),
  defHashOf: () => "hash-1",
  CODE_TABLE_COLUMNS: "value:varchar(64),label:varchar(256),seq:integer",
  landedStateOf: (rec: any, hash: string) => (rec?.defHash === hash ? "ok" : "stale"),
  columnSignature: (cols: Array<{ name: string; type: string }>) => cols.map((c) => `${c.name}:${c.type}`).join(","),
  normalizeTypeName: (t: string) => String(t).toLowerCase(),
}));

vi.mock("@/lib/openmetadata/om-glossary", () => ({ pushStandardGlossary: vi.fn(async () => {}) }));

// 落地前的区域审计(residencyAudit)在本文件不是被测对象 —— 它要读注册表判法域,
// 这里的 target 都是同法域 ⇒ 打桩成 null(与真实同法域行为一致);审计本身由 residency-audit.test.ts 覆盖。
vi.mock("@/lib/exec-env/residency-audit", () => ({
  residencyAudit: vi.fn(async () => null),
  auditActorOrService: vi.fn(() => ({ actor: { identity: { sub: "svc" }, authKind: "service" }, skipAck: true })),
}));

import { landCodeTableById } from "@/lib/modeling/service";
import { applyModelTableById } from "@/lib/modeling/dimensions";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const EUW1 = "tgt_euw1_a";

const ct = (over: Record<string, any> = {}) => ({
  pk: "codetable",
  codeTableId: "ct1",
  name: "订单状态",
  code: "order_status",
  values: [{ value: "0", label: "待付款", seq: 0 }],
  targets: [HOME, USW2],
  landedByTarget: {
    [HOME]: { status: "ok", defHash: "hash-1", table: "public.dim_code_order_status", at: "t1" },
    [USW2]: { status: "credential-gap", defHash: "hash-1", table: "public.dim_code_order_status", at: "t1" },
  },
  createdAt: "t0",
  updatedAt: "t1",
  ...over,
});

const mt = (over: Record<string, any> = {}) => ({
  pk: "modeltable",
  modelTableId: "mt1",
  name: "客户维",
  tableType: "dimension",
  schema: "public",
  physicalTable: "dim_customer",
  columns: [{ name: "id", dataType: "BIGINT", nullable: false }],
  targets: [HOME, USW2],
  landedByTarget: { [USW2]: { status: "credential-gap", defHash: "hash-0", table: "public.dim_customer", at: "t1" } },
  createdAt: "t0",
  updatedAt: "t1",
  ...over,
});

const put = (table: string) => h.puts.filter((p) => p.table === table).pop()!.item;

beforeEach(() => {
  h.item = null;
  h.puts.length = 0;
  h.landedWith.length = 0;
});

describe("🔴🔴 码表:落地一个子集不许改动别的区的绑定", () => {
  it("绑了 [home, usw2],只落 home ⇒ 绑定**仍是两个区**,usw2 的记录一个字没变", async () => {
    h.item = ct();
    await landCodeTableById("ct1", { targets: [HOME] });
    const saved = put("bgp-code-tables");
    expect(
      saved.targets,
      "把本次落地目标直接写回绑定 ⇒ 点一下看板格子上的〔落地到此 region〕就把别的区静默解绑了"
    ).toEqual([HOME, USW2]);
    expect(h.landedWith, "落地不该顺手把没点的区也跑一遍").toEqual([[HOME]]);
    expect(saved.landedByTarget[USW2]).toEqual(ct().landedByTarget[USW2]);
  });

  it("落到一个**没绑过**的区 ⇒ 绑定增长(落地即绑定),原有区照旧", async () => {
    h.item = ct();
    await landCodeTableById("ct1", { targets: [EUW1] });
    const saved = put("bgp-code-tables");
    expect([...saved.targets].sort()).toEqual([HOME, EUW1, USW2].sort());
    expect(h.landedWith).toEqual([[EUW1]]);
  });

  it("🔴 `probeOnly`(只观测)更不许动绑定", async () => {
    h.item = ct();
    await landCodeTableById("ct1", { targets: [HOME], probeOnly: true });
    expect(put("bgp-code-tables").targets).toEqual([HOME, USW2]);
  });

  it("不传 targets ⇒ 落到当前绑定的全部区(缺省行为不变)", async () => {
    h.item = ct();
    await landCodeTableById("ct1", {});
    expect(h.landedWith).toEqual([[HOME, USW2]]);
    expect(put("bgp-code-tables").targets).toEqual([HOME, USW2]);
  });
});

describe("🔴🔴 维度/事实表:同一条(两处口径必须一致)", () => {
  it("只应用 home ⇒ 绑定仍是两个区、usw2 记录不动", async () => {
    h.item = mt();
    await applyModelTableById("mt1", "admin", { targets: [HOME] });
    const saved = put("bgp-model-tables");
    expect(saved.targets).toEqual([HOME, USW2]);
    expect(h.landedWith).toEqual([[HOME]]);
    expect(saved.landedByTarget[USW2]).toEqual(mt().landedByTarget[USW2]);
  });

  it("应用到没绑过的区 ⇒ 绑定增长", async () => {
    h.item = mt();
    await applyModelTableById("mt1", "admin", { targets: [EUW1] });
    expect([...put("bgp-model-tables").targets].sort()).toEqual([HOME, EUW1, USW2].sort());
  });
});
