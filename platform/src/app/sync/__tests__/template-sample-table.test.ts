// 带日期变量的表名:样例表(只读列结构)+ 模板实例黄标 + 目标表名撞车守卫。
// 缺陷原形:模板 orders_${bizmonth} 在源库里不存在 ⇒ 向导第 1 步没有它的列 ⇒ 客户为了看列把 orders_202609 也勾成普通表,
//   两者目标名都是 ods_orders ⇒ 同一次运行向同一张目标表写两次(覆盖模式下互相覆盖)。
// 判据:① 整形:样例列复制给模板、templateSampleTables 只在非空时写(存量零影响)、原任务有的改回空要显式写回 {};
//      ② 实例匹配器:按变量渲染位数匹配,不吃别的表;③ 撞车守卫:普通表 vs 模板 / 两张普通表规范化同名 ⇒ 拒,各不相同 ⇒ null;
//      ④ 样例键校验;⑤ 接线:向导把 templateSamples 交给整形、第 1 步黄标 / 只读映射 / 建表预览含模板;⑥ 新文案有英文。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyncTaskPayload, SYNC_CAPABILITY_SHAPED_KEYS } from "../sync-task-payload";
import { templateInstanceMatcher, templateInstanceOf, cloneColumnMapping, checkTemplateTableEntry } from "../sync-capability-helpers";
import { validateSyncCapabilityFields, targetTableNameCollision, templateSampleTablesOf } from "@/lib/sync/run-vars";
import { EN } from "@/lib/i18n/messages/en";

const HERE = __dirname;
const read = (f: string) => readFileSync(join(HERE, "..", f), "utf8");
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l) && !/^\s*import\s/.test(l)).join("\n");

const TPL = "orders_" + "$" + "{bizmonth}";
const COLS = [
  { source: "id", sourceType: "int", target: "id", targetType: "INTEGER", compatibility: "compatible", include: true },
  { source: "amount", sourceType: "decimal", target: "amount", targetType: "DECIMAL", compatibility: "compatible", include: true },
  { source: "note", sourceType: "text", target: "note", targetType: "VARCHAR", compatibility: "compatible", include: false },
];
const base = { name: "n", datasourceId: "ds1", syncMode: "full", writeMode: "overwrite", targetType: "redshift", targetTableNames: { [TPL]: "ods_orders" } };

describe("① 整形:样例表的列复制给模板;templateSampleTables 只在非空时写", () => {
  it("模板有样例 ⇒ fieldMappings[模板] = 样例表 include 的列;请求体带 templateSampleTables", () => {
    const fm = { orders_202609: COLS, [TPL]: cloneColumnMapping(COLS) };
    const out = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: [], templateTables: [TPL], templateSamples: { [TPL]: "orders_202609" }, fieldMappings: fm });
    expect(out.sourceTables).toEqual([TPL]);
    expect((out.fieldMappings as Record<string, unknown[]>)[TPL]).toEqual(COLS.filter((c) => c.include));
    expect(out.templateSampleTables).toEqual({ [TPL]: "orders_202609" });
    expect(validateSyncCapabilityFields(out as never, "jdbc")).toBeNull();
  });
  it("没选样例 / 样例指向已删掉的模板 / 老调用方不传 ⇒ 不写 templateSampleTables(存量任务零影响)", () => {
    const none = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: ["orders"], templateTables: [TPL], templateSamples: {}, fieldMappings: {} });
    expect("templateSampleTables" in none).toBe(false);
    const stale = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: ["orders"], templateTables: [], templateSamples: { [TPL]: "orders_202609" }, fieldMappings: {} });
    expect("templateSampleTables" in stale).toBe(false);
    const legacy = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: ["orders"], fieldMappings: {} });
    expect("templateSampleTables" in legacy).toBe(false);
    expect(SYNC_CAPABILITY_SHAPED_KEYS).toContain("templateSampleTables");
  });
  it("原任务本来有样例、本次清掉 ⇒ 显式写回 {}(PUT 逐键合并)", () => {
    const original = { ...base, sourceTables: [TPL], templateSampleTables: { [TPL]: "orders_202609" } };
    const out = buildSyncTaskPayload({ formValues: { ...base }, selectedTables: [], templateTables: [TPL], templateSamples: {}, fieldMappings: {}, original });
    expect(out.templateSampleTables).toEqual({});
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("cloneColumnMapping 逐行拷贝(改模板那份不牵连样例)", () => {
    const copy = cloneColumnMapping(COLS);
    expect(copy).toEqual(COLS);
    copy[0].include = false;
    expect(COLS[0].include).toBe(true);
    expect(cloneColumnMapping(undefined)).toEqual([]);
  });
});

describe("② 模板实例匹配器:按变量渲染后的位数匹配", () => {
  it("orders_${bizmonth} 匹配 orders_202609 / orders_202610,不匹配 orders / orders_2026 / orders_202609_bak", () => {
    const re = templateInstanceMatcher(TPL);
    expect(re).not.toBeNull();
    for (const ok of ["orders_202609", "orders_202610", "orders_199912"]) expect(re!.test(ok), ok).toBe(true);
    for (const no of ["orders", "orders_2026", "orders_202609_bak", "xorders_202609", "orders_20260901"]) expect(re!.test(no), no).toBe(false);
  });
  it("带连字符的 ds / 两个变量 / 正则特殊字符都按字面处理", () => {
    expect(templateInstanceMatcher("t_" + "$" + "{ds}")!.test("t_2026-09-01")).toBe(true);
    expect(templateInstanceMatcher("t_" + "$" + "{ds}")!.test("t_20260901")).toBe(false);
    const two = templateInstanceMatcher("a." + "$" + "{ds_nodash}_" + "$" + "{bizmonth}")!;
    expect(two.test("a.20260901_202608")).toBe(true);
    expect(two.test("aX20260901_202608")).toBe(false);
  });
  it("没有变量 / 未知变量 / 写法不完整 ⇒ null;templateInstanceOf 返回命中的模板", () => {
    expect(templateInstanceMatcher("orders")).toBeNull();
    expect(templateInstanceMatcher("o_" + "$" + "{nope}")).toBeNull();
    expect(templateInstanceMatcher("o_" + "$" + "{ds")).toBeNull();
    expect(templateInstanceOf("orders_202609", [TPL, "log_" + "$" + "{ds}"])).toBe(TPL);
    expect(templateInstanceOf("customers", [TPL])).toBeNull();
    expect(templateInstanceOf("orders_202609", [])).toBeNull();
  });
});

describe("③ 目标表名撞车守卫(前后端同一函数 validateSyncCapabilityFields)", () => {
  const task = { ...base, sourceTables: ["orders_202609", TPL] };
  it("普通表(月表实例)的目标名被改成模板的固定目标名 ⇒ 拒,文案点名样例表与取消勾选", () => {
    const withClash = { ...task, targetTableNames: { [TPL]: "ods_orders", orders_202609: "ods_orders" } };
    const msg = validateSyncCapabilityFields(withClash as never, "jdbc");
    expect(msg).toMatch(/orders_202609/);
    expect(msg).toMatch(/样例表/);
    expect(msg).toMatch(/取消勾选/);
    expect(targetTableNameCollision(withClash)).toBe(msg);
  });
  it("前缀路径撞上模板固定目标名也拒(Ods_orders 规范化后 = ods_orders,与生成器 _san 同口径)", () => {
    const msg = validateSyncCapabilityFields({ ...base, sourceTables: ["orders", TPL], targetTablePrefix: "Ods_", targetTableNames: { [TPL]: "ods_orders" } } as never, "jdbc");
    expect(msg).toMatch(/普通表「orders」/);
    expect(msg).toMatch(/「ods_orders」/);
  });
  it("两张普通表规范化后同名(x-1 与 x_1 / A 与 a)⇒ 拒;各不相同 ⇒ null", () => {
    expect(validateSyncCapabilityFields({ ...base, sourceTables: ["x-1", "x_1"] } as never)).toMatch(/都是「x_1」/);
    expect(validateSyncCapabilityFields({ ...base, sourceTables: ["A", "a"] } as never)).toMatch(/写两次/);
    expect(validateSyncCapabilityFields({ ...base, sourceTables: ["orders_202609", TPL] } as never, "jdbc")).toBeNull();
    expect(validateSyncCapabilityFields({ ...base, sourceTables: ["orders", "customers"] } as never)).toBeNull();
  });
  it("同一张表在清单里重复出现不算撞车(去重后比较);targetTableNames 里的非字符串值当没填", () => {
    expect(targetTableNameCollision({ sourceTables: ["orders", "orders"] })).toBeNull();
    expect(targetTableNameCollision({ sourceTables: ["orders", "customers"], targetTableNames: { orders: 3 } })).toBeNull();
  });
});

describe("④ 样例键校验", () => {
  it("键不是带变量的源表名 / 值不是真表名 / 不是对象 ⇒ 拒;合法 ⇒ null;templateSampleTablesOf 只做规整", () => {
    const task = { ...base, sourceTables: [TPL] };
    expect(validateSyncCapabilityFields({ ...task, templateSampleTables: { [TPL]: "orders_202609" } } as never, "jdbc")).toBeNull();
    expect(validateSyncCapabilityFields({ ...task, templateSampleTables: { orders: "orders_202609" } } as never, "jdbc")).toMatch(/不是本任务带日期变量的源表名/);
    expect(validateSyncCapabilityFields({ ...task, templateSampleTables: { [TPL]: "" } } as never, "jdbc")).toMatch(/样例表名不合法/);
    expect(validateSyncCapabilityFields({ ...task, templateSampleTables: { [TPL]: "o_" + "$" + "{ds}" } } as never, "jdbc")).toMatch(/样例表名不合法/);
    expect(validateSyncCapabilityFields({ ...task, templateSampleTables: ["x"] } as never, "jdbc")).toMatch(/必须是「带日期变量的源表名 → 样例表名」的对象/);
    expect(templateSampleTablesOf({ templateSampleTables: { [TPL]: " orders_202609 ", bad: 3 } })).toEqual({ [TPL]: "orders_202609" });
    expect(templateSampleTablesOf({ templateSampleTables: null })).toEqual({});
  });
  it("添加模板的前端检查不要求样例(没样例 = 老行为:模板无列)", () => {
    expect(checkTemplateTableEntry(TPL, "ods_orders", [])).toBeNull();
  });
});

describe("⑤ 接线:向导 / 控件真的用上了样例与守卫", () => {
  const modal = strip(read("SyncTaskModal.tsx"));
  const controls = strip(read("SyncCapabilityControls.tsx"));
  it("提交整形带 templateSamples;编辑打开 / 恢复草稿 / 关闭都回填或清空样例;草稿带样例", () => {
    expect(modal).toMatch(/buildSyncTaskPayload\(\{[\s\S]*?templateTables,\s*templateSamples,[\s\S]*?original: editing/);
    expect(modal).toContain("setTemplateSamples(editing?.templateSampleTables || {})");
    expect(modal).toContain("setTemplateSamples(d.templateSamples || {})");
    expect(modal).toMatch(/setTemplateTables\(\[\]\); setTemplateSamples\(\{\}\)/);
    expect(modal).toMatch(/saveSyncDraft\(draftKey, \{[^}]*templateSamples,/);
  });
  it("拉表回来后按样例列重建模板的列映射(编辑打开 / 换源都走这里)", () => {
    expect(modal).toMatch(/for \(const \[tpl, sampleName\] of Object\.entries\(templateSamplesRef\.current\)\) \{\s*if \(mappings\[sampleName\]\) mappings\[tpl\] = cloneColumnMapping\(mappings\[sampleName\]\);/);
  });
  it("第 1 步:勾选的模板实例表打黄标 + 提示;模板的列映射只读列出;建表预览与派生列候选含模板;Checkbox 开标签不变", () => {
    expect(modal).toMatch(/const instanceOfTpl = selectedTables\.includes\(tbl\.name\) \? templateInstanceOf\(String\(tbl\.name\), templateTables\) : null;/);
    expect(modal).toContain('data-testid="sync-table-template-instance"');
    expect(modal).toContain('data-testid="sync-table-template-instance-hint"');
    expect(modal).toContain('data-testid="sync-template-mapping"');
    expect(modal).toMatch(/columns=\{mappingColumns\(tpl, true\)\}/);
    expect(modal).toMatch(/const templatesWithColumns = templateTables\.filter\(\(x\) => \(fieldMappings\[x\] \|\| \[\]\)\.length > 0\);\s*const previewTables = \[\.\.\.selectedTables, \.\.\.templatesWithColumns\];/);
    expect(modal).toContain("previewTables.forEach(fetchDDL)");
    expect(modal).toMatch(/sourceColumns=\{Array\.from\(new Set\(previewTables\.flatMap/);
    expect(modal).toMatch(/<TemplateTablesEditor form=\{form\}[\s\S]*?sourceTableNames=\{tables\.map\(\(x\) => String\(x\.name\)\)\} templateSamples=\{templateSamples\} setTemplateSamples=\{setTemplateSamples\}\s*fieldMappings=\{fieldMappings\} setFieldMappings=\{setFieldMappings\}/);
    expect(modal).toMatch(/<Checkbox checked=\{selectedTables\.includes\(tbl\.name\)\} onChange=\{\(e\) => toggle\(String\(tbl\.name\), e\.target\.checked\)\}/);
  });
  it("控件:样例下拉(新增行 + 每个模板行)、添加时复制样例列、删除时连样例与列映射一起删、占位示例是中性的 orders_", () => {
    expect(controls).toContain('data-testid="sync-template-sample-new"');
    expect(controls).toContain('data-testid="sync-template-sample"');
    expect(controls).toMatch(/if \(sample\) setSampleFor\(name, sample\);/);
    expect(controls).toMatch(/nextMaps\[name\] = cloneColumnMapping\(fieldMappings\[next\]\)/);
    expect(controls).toMatch(/form\.setFieldValue\("targetTableNames", names\);\s*setSampleFor\(name, undefined\);/);
    expect(controls).toContain('const exampleTpl = "orders_" + varToken("bizmonth")');
    expect(controls).not.toContain("cf_point_");
  });
});

describe("⑥ 新文案都有英文译文", () => {
  // 与 en-coverage-guard 同一种提取法(含转义引号的存量键如 点击\"生成 DDL\"按钮)
  const literals = (src: string) => Array.from(strip(src).matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g), (m) => m[1].replace(/\\"/g, '"'));
  it("SyncTaskModal.tsx 与 SyncCapabilityControls.tsx 的 t(...) 字面键全在 EN 字典里", () => {
    const keys = [...literals(read("SyncTaskModal.tsx")), ...literals(read("SyncCapabilityControls.tsx"))];
    expect(keys).toContain("模板实例");
    expect(keys).toContain("样例表:{s}");
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
  });
});
