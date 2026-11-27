// 同步任务向导本地草稿(用户 2026-10-15:「任务配置失败了…退出后需要重新从头配置,最好增加一个临时保存」)。
// 钉:① 空壳不存、有内容才存;② 读回逐键一致;③ 坏形状 / 过期 ⇒ null 且清掉;④ 新建与某 taskId 的草稿互不覆盖;⑤ storage 拿不到 / 抛错不打断。
import { describe, it, expect } from "vitest";
import { SYNC_DRAFT_TTL_MS, clearSyncDraft, describeDraftAge, isDraftStale, isDraftWorthSaving, loadSyncDraft, loadUsableSyncDraft, saveSyncDraft, syncDraftKey, type DraftStorage } from "../wizard-draft";

function memStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}
const T0 = new Date("2026-10-15T06:00:00Z");
const at = (d: Date) => () => d;
const DRAFT = { step: 1, formValues: { name: "订单同步", datasourceId: "ds-1", syncMode: "full" }, selectedTables: ["orders", "customers"], templateTables: ["log_${ds}"], fieldMappings: { orders: [{ source: "id", include: true }] } };

describe("① 值得存才存", () => {
  it("空壳(没名字 / 没源 / 没表)不存", () => {
    const s = memStorage();
    expect(isDraftWorthSaving({ formValues: { name: "  " }, selectedTables: [], templateTables: [] })).toBe(false);
    expect(saveSyncDraft(null, { step: 0, formValues: {}, selectedTables: [], templateTables: [], fieldMappings: {} }, s, at(T0))).toBe(false);
    expect(s.map.size).toBe(0);
  });
  it("只填了名字 / 只选了源 / 只选了表 都算值得", () => {
    expect(isDraftWorthSaving({ formValues: { name: "x" }, selectedTables: [], templateTables: [] })).toBe(true);
    expect(isDraftWorthSaving({ formValues: { datasourceId: "d" }, selectedTables: [], templateTables: [] })).toBe(true);
    expect(isDraftWorthSaving({ formValues: {}, selectedTables: ["t"], templateTables: [] })).toBe(true);
    expect(isDraftWorthSaving({ formValues: {}, selectedTables: [], templateTables: ["t_${ds}"] })).toBe(true);
  });
});

describe("② 存 → 读 逐键一致;④ 键隔离", () => {
  it("新建键 = …:new;taskId 键各自独立;读回带 version / savedAt", () => {
    const s = memStorage();
    expect(saveSyncDraft(null, DRAFT, s, at(T0))).toBe(true);
    expect(saveSyncDraft("task-9", { ...DRAFT, step: 3 }, s, at(T0))).toBe(true);
    expect(syncDraftKey(undefined)).toBe("bgp-sync-wizard-draft:new");
    expect(syncDraftKey(" task-9 ")).toBe("bgp-sync-wizard-draft:task-9");
    const a = loadSyncDraft(null, s, at(T0))!;
    const b = loadSyncDraft("task-9", s, at(T0))!;
    expect(a).toEqual({ version: 1, savedAt: T0.toISOString(), ...DRAFT });
    expect(b.step).toBe(3);
    clearSyncDraft(null, s);
    expect(loadSyncDraft(null, s, at(T0))).toBeNull();
    expect(loadSyncDraft("task-9", s, at(T0))).not.toBeNull();
  });
});

describe("③ 坏形状 / 过期", () => {
  it("非 JSON / 缺字段 / 版本不对 ⇒ null 且清掉", () => {
    const s = memStorage();
    s.setItem(syncDraftKey(null), "{not json");
    expect(loadSyncDraft(null, s, at(T0))).toBeNull();
    expect(s.map.has(syncDraftKey(null))).toBe(false);
    s.setItem(syncDraftKey(null), JSON.stringify({ version: 2, savedAt: T0.toISOString(), step: 0, formValues: {}, selectedTables: [], templateTables: [], fieldMappings: {} }));
    expect(loadSyncDraft(null, s, at(T0))).toBeNull();
    s.setItem(syncDraftKey(null), JSON.stringify({ version: 1, savedAt: T0.toISOString(), step: 0, formValues: {}, selectedTables: "nope", templateTables: [], fieldMappings: {} }));
    expect(loadSyncDraft(null, s, at(T0))).toBeNull();
  });
  it("超过 7 天 ⇒ null 且清掉;7 天内可读", () => {
    const s = memStorage();
    saveSyncDraft(null, DRAFT, s, at(T0));
    expect(loadSyncDraft(null, s, at(new Date(T0.getTime() + SYNC_DRAFT_TTL_MS - 1)))).not.toBeNull();
    expect(loadSyncDraft(null, s, at(new Date(T0.getTime() + SYNC_DRAFT_TTL_MS + 1)))).toBeNull();
    expect(s.map.size).toBe(0);
  });
});

describe("⑤ storage 不可用不打断", () => {
  it("storage 为 null ⇒ save false / load null / clear 不抛;setItem 抛(配额满)⇒ save false", () => {
    expect(saveSyncDraft(null, DRAFT, null, at(T0))).toBe(false);
    expect(loadSyncDraft(null, null, at(T0))).toBeNull();
    expect(() => clearSyncDraft(null, null)).not.toThrow();
    const bad: DraftStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
    expect(saveSyncDraft(null, DRAFT, bad, at(T0))).toBe(false);
  });
});

// 2026-11-26:任务在草稿写下之后又被保存过 ⇒ 草稿作废(原来仍弹「发现上次未保存的配置」,点「恢复」就用旧状态整体盖掉新保存的内容)。
//   不比时钟:比「写草稿时看到的保存标记」与「任务现在的保存标记」是不是同一个值。
describe("⑥ 作废判断:任务在草稿之后又保存过 ⇒ 打开时当作没有草稿并清掉", () => {
  const SAVED_1 = "2026-11-26T03:00:00.000Z";
  const SAVED_2 = "2026-11-26T04:00:00.000Z";
  it("标记相同 ⇒ 不作废;不同 ⇒ 作废(哪怕任务现在的标记比草稿里的「早」—— 不比先后,只比是不是同一个)", () => {
    expect(isDraftStale({ baseConfigSavedAt: SAVED_1 }, SAVED_1)).toBe(false);
    expect(isDraftStale({ baseConfigSavedAt: SAVED_1 }, SAVED_2)).toBe(true);
    expect(isDraftStale({ baseConfigSavedAt: SAVED_2 }, SAVED_1)).toBe(true);
  });
  it("两边都没有(新建任务 / 旧草稿配还没有标记的存量任务)⇒ 不作废;只有一边有 ⇒ 作废", () => {
    expect(isDraftStale({}, undefined)).toBe(false);
    expect(isDraftStale({}, null)).toBe(false);
    expect(isDraftStale({ baseConfigSavedAt: undefined }, "")).toBe(false);
    expect(isDraftStale({}, SAVED_1)).toBe(true);       // 旧草稿(或写草稿时任务还没有标记),之后任务被保存过
    expect(isDraftStale({ baseConfigSavedAt: SAVED_1 }, undefined)).toBe(true);
  });
  it("草稿带着写它时的标记存取;loadUsableSyncDraft:没作废 ⇒ 原样返回;作废 ⇒ null 且从存储里清掉;别的键不受影响", () => {
    const s = memStorage();
    saveSyncDraft("task-9", { ...DRAFT, baseConfigSavedAt: SAVED_1 }, s, at(T0));
    saveSyncDraft(null, DRAFT, s, at(T0));
    expect(loadSyncDraft("task-9", s, at(T0))!.baseConfigSavedAt).toBe(SAVED_1);
    expect(loadUsableSyncDraft("task-9", SAVED_1, s, at(T0))).toEqual({ version: 1, savedAt: T0.toISOString(), ...DRAFT, baseConfigSavedAt: SAVED_1 });
    expect(s.map.has(syncDraftKey("task-9"))).toBe(true);
    expect(loadUsableSyncDraft("task-9", SAVED_2, s, at(T0))).toBeNull();
    expect(s.map.has(syncDraftKey("task-9"))).toBe(false);
    // 新建任务的草稿(两边都没有标记)照常可用
    expect(loadUsableSyncDraft(null, undefined, s, at(T0))).not.toBeNull();
    expect(s.map.has(syncDraftKey(null))).toBe(true);
  });
  it("没有草稿 / 存储拿不到 ⇒ null,不抛", () => {
    expect(loadUsableSyncDraft("nope", SAVED_1, memStorage(), at(T0))).toBeNull();
    expect(loadUsableSyncDraft("nope", SAVED_1, null, at(T0))).toBeNull();
  });
});

describe("describeDraftAge", () => {
  it("刚刚 / N 分钟前 / N 小时前 / N 天前", () => {
    const d = { version: 1 as const, savedAt: T0.toISOString(), ...DRAFT };
    expect(describeDraftAge(d, at(new Date(T0.getTime() + 20_000)))).toBe("刚刚");
    expect(describeDraftAge(d, at(new Date(T0.getTime() + 5 * 60_000)))).toBe("5 分钟前");
    expect(describeDraftAge(d, at(new Date(T0.getTime() + 3 * 3600_000)))).toBe("3 小时前");
    expect(describeDraftAge(d, at(new Date(T0.getTime() + 2 * 86400_000)))).toBe("2 天前");
  });
});
