// @kf-batch 50-P50.3-matrix2
// 🔴🔴 **编辑定义不许抹掉逐 target 真值**(W3-d2 施工时逮到的真 bug,W3-d1 起就在)。
//
// 码表/维度表的编辑走的是**全量 Put**,而那一行有**两个作者**:
//   · 定义编辑(name / code / values / columns)—— 走 `validateXxx()`,只回**定义核**;
//   · 落地记录(`targets` / `landedByTarget`)—— 由 W3-d1 的落地路径写。
// 于是 `Put({ ...定义核 })` 会把落地记录**整片抹掉**。后果不是"少个字段":
//   · 矩阵/落地面板每一格从 ⚠版本不齐 退化成 **⚠未落地**,而库里那些表**还在**(误报);
//   · `targets` 一起丢掉之后,那些区连「残留」都看不见了(**跨法域残留被藏**,§3.1b 定案要防的)。
// 🔴 而且**改个中文名**就会触发 —— 与 code/values 有没有变**无关**。
//
// 打桩只到 DDB 边界:`validateCodeTable` / `validateModelTable` / 保留逻辑全部真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  item: null as Record<string, any> | null,
  puts: [] as Array<{ table: string; item: Record<string, any> }>,
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

// OM 推送是 best-effort 的旁路,与本组无关
vi.mock("@/lib/openmetadata/om-glossary", () => ({ pushStandardGlossary: vi.fn(async () => {}) }));

import { updateCodeTable } from "@/lib/modeling/service";
import { updateModelTable } from "@/lib/modeling/dimensions";
import { PER_TARGET_TRUTH_KEYS, perTargetTruth } from "@/lib/modeling/landing-shared";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
/** 逐 target 真值的样例:home 已落、usw2 有一条**残留**记录 */
const TRUTH = {
  targets: [HOME],
  landedByTarget: {
    [HOME]: { status: "ok", defHash: "h-old", table: "public.dim_code_x", at: "t1", observedAt: "t1" },
    [USW2]: { status: "credential-gap", defHash: "h-old", table: "public.dim_code_x", at: "t1" },
  },
};

const ct = () => ({
  pk: "codetable",
  codeTableId: "ct1",
  name: "订单状态",
  code: "order_status",
  values: [{ value: "0", label: "待付款", seq: 0 }],
  landed: true,
  landedTable: "public.dim_code_order_status",
  landedAt: "t1",
  createdBy: "admin",
  createdAt: "t0",
  updatedAt: "t1",
  ...TRUTH,
});

const mt = () => ({
  pk: "modeltable",
  modelTableId: "mt1",
  name: "客户维",
  tableType: "dimension",
  schema: "public",
  physicalTable: "dim_customer",
  columns: [{ name: "id", dataType: "BIGINT", nullable: false, isPrimaryKey: true }],
  applied: true,
  createdBy: "admin",
  createdAt: "t0",
  updatedAt: "t1",
  ...TRUTH,
});

const lastPut = () => h.puts[h.puts.length - 1].item;

beforeEach(() => {
  h.item = null;
  h.puts.length = 0;
});

describe("🔴🔴 码表编辑:逐 target 真值必须原样留下", () => {
  it("**只改中文名**(code/values 没变)⇒ `targets` 与 `landedByTarget` 逐字节不变", async () => {
    h.item = ct();
    await updateCodeTable("ct1", { name: "订单状态(新)" });
    const put = lastPut();
    expect(put.name).toBe("订单状态(新)");
    expect(put.targets, "改个中文名就把绑定丢了 ⇒ 那些区变「未绑定」,残留彻底看不见").toEqual(TRUTH.targets);
    expect(
      put.landedByTarget,
      "改个中文名就把逐区观测态清空 ⇒ 看板每一格从 ⚠版本不齐 退化成 ⚠未落地,而库里那些表还在(误报)"
    ).toEqual(TRUTH.landedByTarget);
  });

  it("🔴 **改枚举值**(定义指纹会变)也必须留下观测记录 —— 那是「库里现在是什么」,不随定义变", async () => {
    h.item = ct();
    await updateCodeTable("ct1", { values: [{ value: "0", label: "待付款" }, { value: "9", label: "已退款" }] });
    const put = lastPut();
    expect(put.landedByTarget).toEqual(TRUTH.landedByTarget);
    expect(put.targets).toEqual(TRUTH.targets);
    // 读侧靠「记录里的指纹 ≠ 当前指纹」判 ⚠版本不齐 —— 记录被抹掉就退化成 ⚠未落地(判据都没了)
    expect(put.landedByTarget[HOME].defHash).toBe("h-old");
    // home 投影按既有语义失效(它只是读兼容用的 bool,不是真值源)
    expect(put.landed).toBe(false);
  });

  it("没有落地记录的行(纯草稿)不会因此长出空属性", async () => {
    h.item = { ...ct(), targets: undefined, landedByTarget: undefined };
    await updateCodeTable("ct1", { name: "x" });
    const put = lastPut();
    expect("targets" in put).toBe(false);
    expect("landedByTarget" in put).toBe(false);
  });
});

describe("🔴🔴 维度/事实表编辑:同一条(不许两处口径不同)", () => {
  it("改表名(结构没变)⇒ 逐 target 真值不变", async () => {
    h.item = mt();
    await updateModelTable("mt1", { name: "客户维(新)" });
    const put = h.puts.filter((p) => p.table === "bgp-model-tables").pop()!.item;
    expect(put.name).toBe("客户维(新)");
    expect(put.targets).toEqual(TRUTH.targets);
    expect(put.landedByTarget).toEqual(TRUTH.landedByTarget);
  });

  it("🔴 改列结构 ⇒ `applied` 投影失效,但观测记录仍在(否则残留被藏)", async () => {
    h.item = mt();
    await updateModelTable("mt1", { columns: [{ name: "id", dataType: "BIGINT" }, { name: "nm", dataType: "VARCHAR", length: 32 }] });
    const put = h.puts.filter((p) => p.table === "bgp-model-tables").pop()!.item;
    expect(put.applied).toBe(false);
    expect(put.landedByTarget).toEqual(TRUTH.landedByTarget);
  });
});

describe("🔴 保留清单是**单一真值源** —— 将来加第三个逐 target 属性只需加进它", () => {
  it("清单恰好是那两个键,且两处编辑都经由同一个 `perTargetTruth()`", async () => {
    expect([...PER_TARGET_TRUTH_KEYS]).toEqual(["targets", "landedByTarget"]);
    // 🔴 可执行地钉住「两处都读同一份清单」:给行上塞一个清单里的键的值,两处 Put 都要带出来。
    //    (若哪天有人在某一处改成手写 `...(current.targets ? ...)`,新增键就会在**那一处**丢。)
    for (const [item, fn, table] of [
      [ct(), updateCodeTable, "bgp-code-tables"],
      [mt(), updateModelTable, "bgp-model-tables"],
    ] as Array<[Record<string, any>, (id: string, patch: any) => Promise<unknown>, string]>) {
      h.puts.length = 0;
      h.item = item;
      await fn(item.codeTableId || item.modelTableId, { name: "改个名" });
      const put = h.puts.filter((p) => p.table === table).pop()!.item;
      for (const k of PER_TARGET_TRUTH_KEYS) {
        expect(put[k], `${table} 的编辑把 ${k} 丢了`).toEqual((item as Record<string, unknown>)[k]);
      }
      expect(perTargetTruth(item)).toEqual(perTargetTruth(put));
    }
  });
});
