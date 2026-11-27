// 同步任务再次编辑不丢东西(2026-11-26 客户反馈「变量表再次编辑,之前的变量表以及内容会消失」;页面复现三条走法):
//   A 带日期变量的表名「新增行」填了没点「添加」就点「下一步 / 完成」⇒ 原来无声丢失;
//   B 再次编辑不读任务里保存的列映射,按新读到的表清单整份重建,点「完成」把缺省写回去(表清单没读完时还会写成空);
//   C 只打开编辑、什么都不改就关掉也留下草稿;草稿不看任务后来有没有再保存过。
// 判据钉事实:① 收进来 / 拦下的结果与原因;② 收进来之后直接整形出来的请求体(两个真模块装配,不 mock);③ 列映射合并后的每一行;
//   ④ 没读完表清单时请求体里的列映射;⑤ 接线(调用点在、旧形态不在);⑥ 草稿只在改过之后写、作废判断不比时钟(另见 lib/sync/__tests__/wizard-draft.test.ts)。
// 变异提示(手工:cp -a 备份 → 改 → 跑本文件 → cp -a 复原):
//   · commitTemplateEntry 里去掉 `&& !opts.emptyIsError` ⇒ ① 第 2 条红;
//   · mergeSavedFieldMappings 里把 `include: false` 改成 `include: true` ⇒ ③ 第 1 条红;
//   · buildSyncTaskPayload 里把 `!mappingsReady &&` 去掉 ⇒ ④ 第 2 条红;
//   · 向导 handleSubmitInner 里把 `committed.templateTables` 改回 `templateTables` ⇒ ⑤ 第 2 条红;
//   · 向导 saveDraftNow 里去掉 `|| !dirtyRef.current` ⇒ ⑤ 第 5 条红。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_PENDING_TEMPLATE, commitTemplateEntry, isPendingTemplateEmpty, mergeSavedFieldMappings, type TemplateWizardState } from "../sync-edit-roundtrip";
import { buildSyncTaskPayload } from "../sync-task-payload";
import { validateSyncCapabilityFields } from "@/lib/sync/run-vars";
import { EN } from "@/lib/i18n/messages/en";

const HERE = __dirname;
const read = (f: string) => readFileSync(join(HERE, "..", f), "utf8");
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)).join("\n");

const TPL = "orders_" + "$" + "{bizmonth}";
const TPL2 = "items_" + "$" + "{bizmonth}";
const col = (source: string, extra: Record<string, unknown> = {}) => ({ source, sourceType: "int", target: source, targetType: "INTEGER", compatibility: "compatible", include: true, ...extra });
const FRESH_ORDERS = [col("id"), col("amount"), col("note")];
const EMPTY_STATE: TemplateWizardState = { templateTables: [], templateSamples: {}, fieldMappings: { orders_202609: FRESH_ORDERS }, targetTableNames: {} };
const base = { name: "n", datasourceId: "ds1", syncMode: "full", writeMode: "append", targetType: "redshift" };

describe("① 新增行:「添加」按钮与「下一步 / 完成」同一个函数", () => {
  it("三个框都空:「下一步 / 完成」⇒ 什么都不做;空白字符也算空", () => {
    expect(isPendingTemplateEmpty(EMPTY_PENDING_TEMPLATE)).toBe(true);
    expect(isPendingTemplateEmpty({ tpl: "  ", target: " ", sample: undefined })).toBe(true);
    expect(commitTemplateEntry(EMPTY_PENDING_TEMPLATE, EMPTY_STATE, { emptyIsError: false })).toEqual({ kind: "empty" });
  });
  it("三个框都空点「添加」⇒ 拦下并说先填源表名(与改动前按钮的行为一致)", () => {
    expect(commitTemplateEntry(EMPTY_PENDING_TEMPLATE, EMPTY_STATE, { emptyIsError: true })).toEqual({ kind: "error", error: "请填写带日期变量的源表名" });
  });
  it("填了一部分(只填目标名 / 只选样例 / 只填源表名)⇒「下一步 / 完成」也拦下,不放过也不丢", () => {
    const onlyTarget = commitTemplateEntry({ tpl: "", target: "ods_orders" }, EMPTY_STATE, { emptyIsError: false });
    const onlySample = commitTemplateEntry({ tpl: "", target: "", sample: "orders_202609" }, EMPTY_STATE, { emptyIsError: false });
    const onlyName = commitTemplateEntry({ tpl: TPL, target: "" }, EMPTY_STATE, { emptyIsError: false });
    expect(onlyTarget).toEqual({ kind: "error", error: "请填写带日期变量的源表名" });
    expect(onlySample).toEqual({ kind: "error", error: "请填写带日期变量的源表名" });
    expect(onlyName).toEqual({ kind: "error", error: "必须为它指定一个固定的目标表名" });
  });
  it("填得不合法(没有变量 / 已经添加过 / 目标名带变量)⇒ 拦下,原因与「添加」按钮同一份", () => {
    expect(commitTemplateEntry({ tpl: "orders", target: "ods" }, EMPTY_STATE, { emptyIsError: false })).toMatchObject({ kind: "error", error: expect.stringContaining("没有日期变量") });
    const has = { ...EMPTY_STATE, templateTables: [TPL] };
    expect(commitTemplateEntry({ tpl: TPL, target: "ods" }, has, { emptyIsError: false })).toMatchObject({ kind: "error", error: "这个表名模板已经添加过了" });
    expect(commitTemplateEntry({ tpl: TPL, target: "ods_" + "$" + "{ds}" }, EMPTY_STATE, { emptyIsError: false })).toMatchObject({ kind: "error", error: "目标表名不能带变量" });
  });
  it("填好了 ⇒ 收进来:清单多一条、固定目标名进 targetTableNames、样例表的列映射复制给它(自己的一份)、原状态不被改动", () => {
    const state: TemplateWizardState = { templateTables: [TPL2], templateSamples: { [TPL2]: "items_202609" }, fieldMappings: { orders_202609: FRESH_ORDERS }, targetTableNames: { [TPL2]: "ods_items", plain: "ods_plain" } };
    const r = commitTemplateEntry({ tpl: "  " + TPL + " ", target: " ods_orders ", sample: "orders_202609" }, state, { emptyIsError: false });
    expect(r.kind).toBe("committed");
    if (r.kind !== "committed") return;
    expect(r.name).toBe(TPL);
    expect(r.state.templateTables).toEqual([TPL2, TPL]);
    expect(r.state.targetTableNames).toEqual({ [TPL2]: "ods_items", plain: "ods_plain", [TPL]: "ods_orders" });
    expect(r.state.templateSamples).toEqual({ [TPL2]: "items_202609", [TPL]: "orders_202609" });
    expect(r.state.fieldMappings[TPL]).toEqual(FRESH_ORDERS);
    expect(r.state.fieldMappings[TPL]).not.toBe(FRESH_ORDERS);
    r.state.fieldMappings[TPL][0].include = false;
    expect(FRESH_ORDERS[0].include).toBe(true);
    // 原状态不动(调用方拿返回值用;状态变量由调用方自己 set)
    expect(state.templateTables).toEqual([TPL2]);
    expect(state.targetTableNames).toEqual({ [TPL2]: "ods_items", plain: "ods_plain" });
    expect(TPL in state.fieldMappings).toBe(false);
  });
  it("没选样例 ⇒ 照样收进来,只是它暂时没有列映射", () => {
    const r = commitTemplateEntry({ tpl: TPL, target: "ods_orders" }, EMPTY_STATE, { emptyIsError: true });
    expect(r.kind).toBe("committed");
    if (r.kind !== "committed") return;
    expect(r.state.templateSamples).toEqual({});
    expect(TPL in r.state.fieldMappings).toBe(false);
  });
});

describe("② 装配:收进来之后直接整形出来的请求体里有它(「完成」那一下不等界面状态刷新)", () => {
  it("原任务有一张普通表 + 一张带变量的;新增行填了第二张没点「添加」⇒ 请求体 sourceTables / 固定目标名 / 样例 / 列映射都带着它,且过前端校验", () => {
    const original = { ...base, sourceTables: ["plain", TPL2], targetTableNames: { [TPL2]: "ods_items" }, templateSampleTables: { [TPL2]: "items_202609" } };
    const before: TemplateWizardState = {
      templateTables: [TPL2], templateSamples: { [TPL2]: "items_202609" },
      fieldMappings: { plain: [col("a")], orders_202609: FRESH_ORDERS, items_202609: [col("sku")], [TPL2]: [col("sku")] },
      targetTableNames: { [TPL2]: "ods_items" },
    };
    const r = commitTemplateEntry({ tpl: TPL, target: "ods_orders", sample: "orders_202609" }, before, { emptyIsError: false });
    if (r.kind !== "committed") throw new Error("应当收进来");
    const out = buildSyncTaskPayload({
      formValues: { ...base, targetTableNames: r.state.targetTableNames },
      selectedTables: ["plain"], templateTables: r.state.templateTables, templateSamples: r.state.templateSamples, fieldMappings: r.state.fieldMappings, original,
    });
    expect(out.sourceTables).toEqual(["plain", TPL2, TPL]);
    expect(out.targetTableNames).toEqual({ [TPL2]: "ods_items", [TPL]: "ods_orders" });
    expect(out.templateSampleTables).toEqual({ [TPL2]: "items_202609", [TPL]: "orders_202609" });
    expect((out.fieldMappings as Record<string, unknown[]>)[TPL]).toEqual(FRESH_ORDERS);
    expect(validateSyncCapabilityFields(out as never, "jdbc")).toBeNull();
    // 对照:拿收进来之前的状态去整形(= 改动前的行为)⇒ 请求体里没有它
    const lost = buildSyncTaskPayload({ formValues: { ...base, targetTableNames: before.targetTableNames }, selectedTables: ["plain"], templateTables: before.templateTables, templateSamples: before.templateSamples, fieldMappings: before.fieldMappings, original });
    expect(lost.sourceTables).toEqual(["plain", TPL2]);
  });
});

describe("③ 列映射读回:以任务里保存的为准合到新读到的列清单上", () => {
  const fresh = { orders: [col("id"), col("amount"), col("note"), col("added_later")], customers: [col("cid"), col("cname")] };
  it("保存过的列 = 开着 + 保存的目标字段名;没保存的列(用户关掉的 / 源库后来新增的)= 关着;类型以新读到的为准", () => {
    const saved = { orders: [{ source: "id", target: "order_id", sourceType: "bigint", targetType: "OLD", include: true }, { source: "amount", target: "amount", include: true }] };
    const merged = mergeSavedFieldMappings(fresh, saved);
    expect(merged.orders).toEqual([
      col("id", { target: "order_id" }),
      col("amount"),
      col("note", { include: false }),
      col("added_later", { include: false }),
    ]);
  });
  it("这张表在任务里没有列映射(没有键 / 空数组 / 一列都对不上)⇒ 新读到的那份原样(全部开着)", () => {
    const merged = mergeSavedFieldMappings(fresh, { orders: [], customers: [{ source: "renamed_away", target: "x", include: true }] });
    expect(merged.orders).toBe(fresh.orders);
    expect(merged.customers).toBe(fresh.customers);
    expect(mergeSavedFieldMappings(fresh, {}).orders).toBe(fresh.orders);
  });
  it("源库里已经没有的列不带回来;保存的那一行自己标了不同步 ⇒ 关着;保存的目标字段名是空的 ⇒ 用新读到的", () => {
    const saved = { customers: [{ source: "cid", target: "  ", include: true }, { source: "cname", target: "customer_name", include: false }, { source: "dropped", target: "dropped", include: true }] };
    const merged = mergeSavedFieldMappings(fresh, saved);
    expect(merged.customers).toEqual([col("cid"), col("cname", { target: "customer_name", include: false })]);
  });
  it("任务里的列映射不是对象(没有 / 数组 / 字符串)⇒ 新读到的整份原样", () => {
    for (const bad of [undefined, null, [], "x", 3]) expect(mergeSavedFieldMappings(fresh, bad)).toBe(fresh);
  });
  it("往返:合并后的列映射不改就整形 ⇒ 请求体里这张表的列映射与任务里保存的是同一组列、同样的目标字段名(原来会回到全列)", () => {
    const saved = { orders: [{ ...col("id"), target: "order_id" }, col("amount")] };
    const merged = mergeSavedFieldMappings(fresh, saved);
    const out = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: ["orders"], fieldMappings: merged, original: { ...base, sourceTables: ["orders"], fieldMappings: saved } });
    const rows = (out.fieldMappings as Record<string, Array<{ source: string; target: string }>>).orders;
    expect(rows.map((r) => [r.source, r.target])).toEqual([["id", "order_id"], ["amount", "amount"]]);
    // 对照:不合并(= 改动前)⇒ 四列全回来
    const before = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: ["orders"], fieldMappings: fresh });
    expect((before.fieldMappings as Record<string, unknown[]>).orders).toHaveLength(4);
  });
});

describe("④ 表清单没读完就保存:不把任务里原有的列映射写成空", () => {
  const savedFm = { orders: [col("id")], [TPL]: [col("id"), col("amount")] };
  const original = { ...base, sourceTables: ["orders", TPL], fieldMappings: savedFm, targetTableNames: { [TPL]: "ods_orders" } };
  const form = { ...base, targetTableNames: { [TPL]: "ods_orders" } };
  it("缺省(= 已读完):这次没有列映射的表写空(改动前行为,逐键不变)", () => {
    const out = buildSyncTaskPayload({ formValues: form, selectedTables: ["orders"], templateTables: [TPL], fieldMappings: {}, original });
    expect(out.fieldMappings).toEqual({ orders: [], [TPL]: [] });
  });
  it("没读完 + 数据源没换 ⇒ 这次没有列映射的表保持任务里原来那份", () => {
    const out = buildSyncTaskPayload({ formValues: form, selectedTables: ["orders"], templateTables: [TPL], fieldMappings: {}, original, mappingsReady: false });
    expect(out.fieldMappings).toEqual(savedFm);
  });
  it("没读完,但这张表这次有列映射(恢复草稿带来的 / 用户动过的)⇒ 用这次的,哪怕是空数组", () => {
    const out = buildSyncTaskPayload({ formValues: form, selectedTables: ["orders"], templateTables: [TPL], fieldMappings: { orders: [col("id"), col("amount", { include: false })], [TPL]: [] }, original, mappingsReady: false });
    expect(out.fieldMappings).toEqual({ orders: [col("id")], [TPL]: [] });
  });
  it("没读完,但换了数据源 / 是新建 / 原任务没有这张表的列映射 ⇒ 写空(旧源的列映射不作数)", () => {
    const switched = buildSyncTaskPayload({ formValues: { ...form, datasourceId: "ds2" }, selectedTables: ["orders"], templateTables: [TPL], fieldMappings: {}, original, mappingsReady: false });
    expect(switched.fieldMappings).toEqual({ orders: [], [TPL]: [] });
    const created = buildSyncTaskPayload({ formValues: form, selectedTables: ["orders"], fieldMappings: {}, mappingsReady: false });
    expect(created.fieldMappings).toEqual({ orders: [] });
    const newTable = buildSyncTaskPayload({ formValues: form, selectedTables: ["orders", "brand_new"], fieldMappings: {}, original, mappingsReady: false });
    expect((newTable.fieldMappings as Record<string, unknown>).brand_new).toEqual([]);
  });
});

describe("⑤ 接线:向导与控件真的走了这几条路(调用点在,旧形态不在)", () => {
  const modal = strip(read("SyncTaskModal.tsx"));
  const controls = strip(read("SyncCapabilityControls.tsx"));
  it("「完成」:先把新增行收进来(被拦下就回到选表那一步并提示),再校验前两步,再提交;校验与提交都用收进来之后的值", () => {
    expect(modal).toMatch(/const handleSubmit = async \(\) => \{\s*const committed = commitPendingTemplate\(false\);\s*if \(!committed\) \{ setStep\(1\); message\.warning\(t\("带日期变量的表名那一行还没填对[^"]*"\)\); return; \}\s*if \(!validateUpTo\(1, undefined, committed\.templateTables\)\) return;\s*try \{\s*await handleSubmitInner\(committed\);/);
  });
  it("提交整形用的是收进来之后的清单 / 样例 / 列映射,并带上「列映射是否已准备好」;状态变量不直接进整形", () => {
    const inner = modal.slice(modal.indexOf("const handleSubmitInner = async"), modal.indexOf("const validateUpTo ="));
    expect(inner).toMatch(/buildSyncTaskPayload\(\{\s*formValues: form\.getFieldsValue\(true\),\s*selectedTables,\s*templateTables: committed\.templateTables,\s*templateSamples: committed\.templateSamples,\s*fieldMappings: committed\.fieldMappings,\s*original: editing as Record<string, unknown> \| undefined,\s*mappingsReady: mappingsReadyRef\.current,\s*\}\);/);
    expect(inner).not.toMatch(/^\s*templateTables,\s*$/m);
    expect(inner).not.toMatch(/^\s*fieldMappings,\s*$/m);
  });
  it("收进来的唯一入口 commitPendingTemplate:调纯函数;被拦下把原因放到那一行下面;收进来后四样一起更新并清空新增行;不是点「添加」收进来的要说一声", () => {
    const fn = modal.slice(modal.indexOf("const commitPendingTemplate ="), modal.indexOf("const handleSubmit = async"));
    expect(fn).toMatch(/const r = commitTemplateEntry\(pendingTpl, state, \{ emptyIsError \}\);/);
    expect(fn).toMatch(/if \(r\.kind === "error"\) \{ setPendingTplError\(r\.error\); return null; \}/);
    expect(fn).toMatch(/setTemplateTables\(r\.state\.templateTables\);\s*setTemplateSamples\(r\.state\.templateSamples\); templateSamplesRef\.current = r\.state\.templateSamples;\s*setFieldMappings\(r\.state\.fieldMappings\);\s*form\.setFieldValue\("targetTableNames", r\.state\.targetTableNames\);\s*setPendingTpl\(EMPTY_PENDING_TEMPLATE\); setPendingTplError\(null\);/);
    expect(fn).toMatch(/if \(!emptyIsError\) message\.info\(t\("已把填好但还没点「添加」的带日期变量的表名「\{name\}」加进任务"/);
    expect((modal.match(/commitTemplateEntry\(/g) || []).length).toBe(1);
    // 三个调用点:「完成」「下一步」(false)与「添加」按钮(true)
    expect((modal.match(/commitPendingTemplate\(false\)/g) || []).length).toBe(2);
    expect(modal).toMatch(/onAdd=\{\(\) => \{ commitPendingTemplate\(true\); \}\}/);
  });
  it("「下一步」:离开选表那一步之前先收进来,被拦下就不往下走;按钮接的是 goNext", () => {
    expect(modal).toMatch(/const goNext = \(\) => \{\s*let tplTables: string\[\] \| undefined;\s*if \(step === 1\) \{\s*const committed = commitPendingTemplate\(false\);\s*if \(!committed\) return;\s*tplTables = committed\.templateTables;\s*\}\s*if \(validateStep\(tplTables\)\) setStep\(step \+ 1\);\s*\};/);
    expect(modal).toMatch(/\{step < STEPS\.length - 1 && <Button type="primary" onClick=\{goNext\}>\{t\("下一步"\)\}<\/Button>\}/);
    expect(modal).toMatch(/selectedTables\.length === 0 && tplTables\.length === 0\) \{ message\.warning\(t\("请至少选择一张表"\)\)/);
  });
  it("草稿只在用户改过之后写:saveDraftNow 开头看 dirtyRef;置真只有 markEdited 与收进来两处;打开 / 关闭归假;草稿带上写它时任务的保存标记", () => {
    expect(modal).toMatch(/const saveDraftNow = \(\) => \{\s*if \(!open \|\| !dirtyRef\.current\) return;\s*saveSyncDraft\(draftKey, \{[^}]*baseConfigSavedAt: editing\?\.configSavedAt \}\);/);
    expect(modal).toMatch(/const markEdited = \(\) => \{ dirtyRef\.current = true; saveDraftNow\(\); \};/);
    expect((modal.match(/dirtyRef\.current = true/g) || []).length).toBe(2);
    expect((modal.match(/dirtyRef\.current = false/g) || []).length).toBe(2);
    expect(modal).toMatch(/onValuesChange=\{\(\) => markEdited\(\)\}/);
    expect(modal).not.toMatch(/onValuesChange=\{\(\) => saveDraftNow\(\)\}/);
    // 不经表单控件的用户改动都报到 markEdited:勾表 / 全选 / 清空、列映射的开关与目标字段、带日期变量的表名、过滤条件快捷
    expect(modal).toMatch(/const toggle = \(name: string, on: boolean\) => \{ markEdited\(\); setSelectedTables\(/);
    expect((modal.match(/onChange=\{\([ve]\) => \{ markEdited\(\); const m = \{ \.\.\.fieldMappings \};/g) || []).length).toBe(2);
    expect(modal).toMatch(/onUserEdit=\{markEdited\} \/>/);
    expect(modal).toMatch(/<WhereClauseHelp form=\{form\} onUserEdit=\{markEdited\} \/>/);
    // 恢复草稿不算「改过」
    const apply = modal.slice(modal.indexOf("const applyDraft = async"), modal.indexOf("const discardDraft ="));
    expect(apply).not.toMatch(/markEdited|dirtyRef/);
  });
  it("打开向导读草稿走 loadUsableSyncDraft(任务在草稿之后又保存过 ⇒ 当作没有);裸的 loadSyncDraft 不再出现在向导里", () => {
    expect(modal).toMatch(/setPendingDraft\(loadUsableSyncDraft\(editing\?\.taskId, editing\?\.configSavedAt\)\)/);
    expect(modal).not.toMatch(/loadSyncDraft\(/);
  });
  it("列映射读回:表清单读完后、写进页面之前与任务里保存的那份合(只在数据源没换时);读完才算准备好,读失败不算", () => {
    const fn = modal.slice(modal.indexOf("const onDatasourceChange = async"), modal.indexOf("const fetchChannelRec = async"));
    expect(fn).toMatch(/const savedMappings = editing && dsId === editing\.datasourceId \? editing\.fieldMappings : undefined;\s*setFieldMappings\(mergeSavedFieldMappings\(mappings, savedMappings\)\);\s*mappingsReadyRef\.current = tablesRead;/);
    expect(fn).not.toMatch(/setFieldMappings\(mappings\);/);
    expect(fn).toMatch(/\} catch \(e: any\) \{\s*tablesRead = false;/);
    // 置「没准备好」在第一个等待之前
    expect(fn.indexOf("mappingsReadyRef.current = false;")).toBeGreaterThan(0);
    expect(fn.indexOf("mappingsReadyRef.current = false;")).toBeLessThan(fn.indexOf("await "));
    expect((modal.match(/mappingsReadyRef\.current = false/g) || []).length).toBe(2); // 打开向导 + 每次读表开始
  });
  it("控件:新增行三个框是受控的(状态在向导里,控件自己不存);「添加」按钮接 onAdd;开关 / 标签 / 收起时的说明都在", () => {
    expect(controls).not.toMatch(/useState/);
    expect(controls).toMatch(/value=\{pending\.tpl\} onChange=\{\(e\) => editPending\(\{ tpl: e\.target\.value \}\)\}/);
    expect(controls).toMatch(/value=\{pending\.target\} onChange=\{\(e\) => editPending\(\{ target: e\.target\.value \}\)\}/);
    expect(controls).toMatch(/value=\{pending\.sample\}/);
    expect(controls).toMatch(/onClick=\{onAdd\} data-testid="sync-template-table-add"/);
    expect(controls).toMatch(/\{pendingError \? <div[^>]*data-testid="sync-template-table-error">\{t\(pendingError\)\}<\/div> : null\}/);
    for (const id of ["sync-template-toggle", "sync-template-collapsed-hint", "sync-template-labels", "sync-template-new-row", "sync-template-help"]) expect(controls, id).toContain(`data-testid="${id}"`);
    // 已有带日期变量的表名 ⇒ 恒展开、开关置灰;用户关上开关 ⇒ 新增行清空
    expect(controls).toMatch(/const expanded = hasTemplates \|\| open;/);
    expect(controls).toMatch(/<Switch size="small" checked=\{expanded\} disabled=\{hasTemplates\} data-testid="sync-template-toggle"\s*onChange=\{\(v\) => \{ setOpen\(v\); if \(!v\) \{ setPending\(EMPTY_PENDING_TEMPLATE\); setPendingError\(null\); \} \}\} \/>/);
    // 移除 / 换样例是不经表单控件的改动 ⇒ 报给向导
    expect(controls).toMatch(/setFieldMappings\(nextMaps\);\s*onUserEdit\?\.\(\);/);
  });
  it("目标表命名:任务里只有带日期变量的表名时,表名前缀 / 后缀两个框不出现,改为一句说明", () => {
    expect(modal).toMatch(/\{selectedTables\.length === 0 && templateTables\.length > 0 \? \(\s*<div[^>]*data-testid="sync-target-naming-template-only">/);
    expect(modal).toContain('data-testid="sync-target-naming-template-note"');
  });
  it("新文案都有英文译文(向导与控件的 t(...) 字面键全在 EN 字典里)", () => {
    const literals = (src: string) => Array.from(strip(src).matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g), (m) => m[1].replace(/\\"/g, '"'));
    const keys = [...literals(read("SyncTaskModal.tsx")), ...literals(read("SyncCapabilityControls.tsx"))];
    expect(keys).toContain("源库按日期分表(每月 / 每天一张表)");
    expect(keys).toContain("已把填好但还没点「添加」的带日期变量的表名「{name}」加进任务");
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
  });
});

describe("⑥ 服务端:任务行的「配置最近一次保存」标记只由新建 / 保存两条路由写", () => {
  const put = strip(readFileSync(join(HERE, "..", "..", "api", "sync", "[id]", "route.ts"), "utf8"));
  const post = strip(readFileSync(join(HERE, "..", "..", "api", "sync", "route.ts"), "utf8"));
  it("保存:客户端带回来的那个值先剔除(否则与路由自己那句 SET 路径重叠);与 updatedAt 同一个时刻一起写", () => {
    expect(put).toMatch(/delete body\.configSavedAt;/);
    expect(put).toMatch(/UpdateExpression: `SET \$\{expr\}, #upd = :now, #cfg = :now`,\s*ExpressionAttributeNames: \{ \.\.\.names, "#upd": "updatedAt", "#cfg": "configSavedAt" \},/);
  });
  it("新建:落库即带", () => {
    expect(post).toMatch(/updatedAt: now,\s*configSavedAt: now,/);
  });
});
