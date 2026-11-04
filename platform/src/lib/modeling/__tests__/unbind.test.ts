// 「解绑 / 解绑并清理 / 删定义受控」的门禁(50 SPEC v3.20 §3.8;ACCEPTANCE §8vicies)。
//
// 承重不变量都是"不报错、只是顺序/语义错了"这一类,只能靠可执行断言:
//   ① 只解绑 ⇒ 记录**保留**(残留可见);清理 ⇒ 先 DROP、观测为空、**再**去记录;
//   ② DROP 抛错 ⇒ `save` 一次都不会被调(先去记录再 DROP 失败 = 真孤儿);
//   ③ credential-gap 记录从未执行过语句 ⇒ 清理不连库;
//   ④ 删定义:有产物 ⇒ 抛 DeleteDecisionRequired;带 keepTables 还要确认串对。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  unlandCalls: [] as Array<{ targetId: string; schema: string; table: string }>,
  unlandImpl: (async () => ({ dropped: true, observedBefore: "x" })) as (...a: any[]) => Promise<{ dropped: boolean; observedBefore: string | null }>,
}));

vi.mock("@/lib/modeling/landing", () => ({
  unlandFromTarget: vi.fn(async (targetId: string, args: { schema: string; table: string }) => {
    h.unlandCalls.push({ targetId, schema: args.schema, table: args.table });
    return h.unlandImpl(targetId, args);
  }),
}));

import { planUnbind, landedArtifacts, assertDeletable, UnbindRejected, DeleteDecisionRequired } from "@/lib/modeling/unbind-shared";
import { performUnbind } from "@/lib/modeling/unbind";
import type { LandedRecord } from "@/lib/modeling/landing-shared";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const TABLE = "public.dim_code_x";
const rec = (over: Partial<LandedRecord> = {}): LandedRecord => ({
  status: "ok",
  defHash: "abc",
  table: TABLE,
  at: "2026-09-05T00:00:00.000Z",
  observedAt: "2026-09-05T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  h.unlandCalls.length = 0;
  h.unlandImpl = async () => ({ dropped: true, observedBefore: "x" });
});

describe("planUnbind:只解绑 vs 解绑并清理(纯函数)", () => {
  it("只解绑 ⇒ 绑定收缩、记录**原样保留**(残留可见)、不连库", () => {
    const p = planUnbind({ boundTargets: [HOME, USW2], landedByTarget: { [HOME]: rec() }, targetId: HOME, cleanup: false, table: TABLE });
    expect(p.targets).toEqual([USW2]);
    expect(p.landedByTarget[HOME], "只解绑不许动记录 —— 那是「残留」的全部证据").toBeTruthy();
    expect(p.needsDrop).toBe(false);
  });
  it("清理:confirm 不等于物理表名 ⇒ 拒(机制 A),且不会算出任何写入计划", () => {
    expect(() =>
      planUnbind({ boundTargets: [HOME], landedByTarget: { [HOME]: rec() }, targetId: HOME, cleanup: true, confirm: "dim_code_x", table: TABLE })
    ).toThrowError(UnbindRejected);
    try {
      planUnbind({ boundTargets: [HOME], landedByTarget: { [HOME]: rec() }, targetId: HOME, cleanup: true, confirm: "", table: TABLE });
    } catch (e) {
      expect((e as UnbindRejected).reason).toBe("confirm-mismatch");
    }
  });
  it("清理且有真实记录 ⇒ needsDrop、记录去项", () => {
    const p = planUnbind({ boundTargets: [HOME, USW2], landedByTarget: { [HOME]: rec(), [USW2]: rec({ status: "credential-gap" }) }, targetId: HOME, cleanup: true, confirm: TABLE, table: TABLE });
    expect(p.needsDrop).toBe(true);
    expect(p.landedByTarget[HOME]).toBeUndefined();
    expect(p.landedByTarget[USW2], "别的区的记录一个字不动").toEqual(rec({ status: "credential-gap" }));
    expect(p.targets).toEqual([USW2]);
  });
  it("🔴 credential-gap 记录从未执行过语句 ⇒ 清理只删记录、**不连库**", () => {
    const p = planUnbind({ boundTargets: [HOME, USW2], landedByTarget: { [USW2]: rec({ status: "credential-gap" }) }, targetId: USW2, cleanup: true, confirm: TABLE, table: TABLE });
    expect(p.needsDrop).toBe(false);
    expect(p.skipDropReason).toBe("credential-gap");
    expect(p.landedByTarget[USW2]).toBeUndefined();
  });
  it("既未绑定也无记录 ⇒ nothing-to-unbind", () => {
    expect(() => planUnbind({ boundTargets: [HOME], landedByTarget: {}, targetId: USW2, cleanup: false, table: TABLE })).toThrowError(/没有可解绑/);
  });
  it("解绑最后一个绑定 ⇒ targets=[] 且 lastTargetRemoved(界面据此写明「回到缺省 home」)", () => {
    const p = planUnbind({ boundTargets: [HOME], landedByTarget: { [HOME]: rec() }, targetId: HOME, cleanup: false, table: TABLE });
    expect(p.targets).toEqual([]);
    expect(p.lastTargetRemoved).toBe(true);
  });
});

describe("🔴🔴 performUnbind:先 DROP、再去记录 —— DROP 抛错 ⇒ save 一次都不调", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    boundTargets: [HOME, USW2],
    landedByTarget: { [HOME]: rec(), [USW2]: rec({ status: "credential-gap" }) },
    targetId: HOME,
    cleanup: true,
    confirm: TABLE,
    schema: "public",
    table: "dim_code_x",
    ...over,
  });
  it("DROP 抛错 ⇒ 抛出、save 未被调用(记录与绑定一字不动)", async () => {
    h.unlandImpl = async () => {
      throw new Error("DROP 已执行,但仍观测到该表");
    };
    const save = vi.fn(async () => ({}));
    await expect(performUnbind({ ...base(), save })).rejects.toThrow(/仍观测到/);
    expect(save, "先去记录再 DROP 失败 = 真孤儿").not.toHaveBeenCalled();
    expect(h.unlandCalls).toEqual([{ targetId: HOME, schema: "public", table: "dim_code_x" }]);
  });
  it("DROP 成功 ⇒ save 恰好一次,带去项后的记录与收缩后的绑定,dropped=true", async () => {
    const save = vi.fn(async (patch: any) => patch);
    const out = await performUnbind({ ...base(), save });
    expect(save).toHaveBeenCalledTimes(1);
    const patch = save.mock.calls[0][0] as any;
    expect(patch.targets).toEqual([USW2]);
    expect(patch.landedByTarget[HOME]).toBeUndefined();
    expect(patch.landedByTarget[USW2]).toBeTruthy();
    expect(out.dropped).toBe(true);
    expect(out.table).toBe(TABLE);
  });
  it("只解绑 ⇒ 不连库(unland 零调用),save 带**原样**记录", async () => {
    const save = vi.fn(async (patch: any) => patch);
    const out = await performUnbind({ ...base({ cleanup: false, confirm: undefined }), save });
    expect(h.unlandCalls).toEqual([]);
    expect((save.mock.calls[0][0] as any).landedByTarget[HOME]).toEqual(rec());
    expect(out.dropped).toBe(false);
  });
  it("credential-gap 记录清理 ⇒ 不连库,记录去项", async () => {
    const save = vi.fn(async (patch: any) => patch);
    const out = await performUnbind({ ...base({ targetId: USW2 }), save });
    expect(h.unlandCalls).toEqual([]);
    expect((save.mock.calls[0][0] as any).landedByTarget[USW2]).toBeUndefined();
    expect(out.dropped).toBe(false);
  });
  it("表本来就不存在(unland 返回 dropped=false)⇒ 记录仍去项、dropped=false(记录必须对应库里的事实)", async () => {
    h.unlandImpl = async () => ({ dropped: false, observedBefore: null });
    const save = vi.fn(async (patch: any) => patch);
    const out = await performUnbind({ ...base(), save });
    expect((save.mock.calls[0][0] as any).landedByTarget[HOME]).toBeUndefined();
    expect(out.dropped).toBe(false);
  });
});

describe("删定义受控:landedArtifacts / assertDeletable", () => {
  it("credential-gap 不算产物;其余状态都算(failed 也可能是「建了表、灌数失败」)", () => {
    const arts = landedArtifacts({ landedByTarget: { [USW2]: rec({ status: "credential-gap" }), [HOME]: rec({ status: "failed" }) } });
    expect(arts.map((a) => a.targetId)).toEqual([HOME]);
  });
  it("有产物且未带 keepTables ⇒ DeleteDecisionRequired(带清单)", () => {
    try {
      assertDeletable({ landedByTarget: { [HOME]: rec() } }, { expectedConfirm: "x" });
      throw new Error("应当抛出");
    } catch (e) {
      expect(e).toBeInstanceOf(DeleteDecisionRequired);
      expect((e as DeleteDecisionRequired).artifacts).toEqual([{ targetId: HOME, table: TABLE, status: "ok", at: rec().at }]);
    }
  });
  it("带 keepTables 但确认串不对 ⇒ 拒;对 ⇒ 回保留清单", () => {
    expect(() => assertDeletable({ landedByTarget: { [HOME]: rec() } }, { keepTables: true, confirm: "y", expectedConfirm: "x" })).toThrowError(UnbindRejected);
    expect(assertDeletable({ landedByTarget: { [HOME]: rec() } }, { keepTables: true, confirm: "x", expectedConfirm: "x" }).length).toBe(1);
  });
  it("没有产物 ⇒ 直接可删(空清单),不要求确认串", () => {
    expect(assertDeletable({ landedByTarget: { [USW2]: rec({ status: "credential-gap" }) } }, { expectedConfirm: "x" })).toEqual([]);
  });
});

describe("🔴 接线门禁:两处 delete 都先过 assertDeletable 再 DeleteCommand;两处 unbind 都经 performUnbind", () => {
  const root = path.resolve(__dirname, "..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const f of ["service.ts", "dimensions.ts"]) {
    it(`${f}:delete 函数体内 assertDeletable 出现在 DeleteCommand 之前;unbind 走 performUnbind`, () => {
      const src = strip(readFileSync(path.join(root, f), "utf8"));
      const fnStart = src.indexOf(f === "service.ts" ? "export async function deleteCodeTable(" : "export async function deleteModelTable(");
      expect(fnStart, "delete 函数没了?").toBeGreaterThan(0);
      const body = src.slice(fnStart, src.indexOf("\n}", fnStart));
      const a = body.indexOf("assertDeletable(");
      const d = body.indexOf("new DeleteCommand(");
      expect(a, "delete 函数里没有 assertDeletable ⇒ 有落地产物照删 = 静默造孤儿").toBeGreaterThan(0);
      expect(d).toBeGreaterThan(a);
      expect(src.includes("performUnbind<"), "unbind 没走编排 ⇒ 顺序保证失效").toBe(true);
    });
  }
});
