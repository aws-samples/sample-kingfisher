// @kf-batch 37-sync-capability —— 同步向导「提交整形」判据。
//
// ① 钉现状:LEGACY = 改动前 SyncTaskModal.handleSubmit 里那四行**逐字**搬来的参考实现;
//    对存量形态的任务,新整形函数的输出必须与它逐键相同。
// ② 存量任务零影响:老任务的表单值(含编辑回填的 sourceTables / fieldMappings)过整形函数,输出与输入逐键相同;
//    即便表单里残留了新字段的缺省值(控件曾挂载 / 用户点过又撤回),也一个都不许进请求体。
// ③ PUT 是逐键 SET 合并 ⇒ 原任务本来有的新字段改回缺省时必须显式写回(否则「改回去」不生效)。
// ④ 接线:向导的提交路径真的调用了整形函数与前端校验(剥掉 import / 注释后,在 handleSubmit 函数体里查)。
// ⑤ 新控件不给 initialValue(给了 ⇒ getFieldsValue(true) 里就有缺省值)。
// ⑥ 新文案都有英文译文。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyncTaskPayload, SYNC_CAPABILITY_SHAPED_KEYS, paradigmForCapabilityCheck } from "../sync-task-payload";
import { checkTemplateTableEntry, previewTemplate, todayUtcDs, previewToday } from "../sync-capability-helpers";
import { SYNC_RUN_VAR_NAMES, validateSyncCapabilityFields } from "@/lib/sync/run-vars";
import { EN } from "@/lib/i18n/messages/en";

const HERE = __dirname;
const read = (f: string) => readFileSync(join(HERE, "..", f), "utf8");
const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l) && !/^\s*import\s/.test(l))
    .join("\n");

/** 改动前 handleSubmit 的整形(逐字搬运,勿改)。 */
function LEGACY(formValues: Record<string, any>, selectedTables: string[], fieldMappings: Record<string, any[]>) {
  const values = { ...formValues };
  values.sourceTables = selectedTables;
  values.fieldMappings = {};
  selectedTables.forEach((tbl) => { values.fieldMappings[tbl] = fieldMappings[tbl]?.filter((f) => f.include) || []; });
  return values;
}

const MAP_ORDERS = [
  { source: "id", sourceType: "int", target: "id", targetType: "INTEGER", compatibility: "compatible", include: true },
  { source: "note", sourceType: "text", target: "note", targetType: "VARCHAR", compatibility: "compatible", include: false },
];
const MAP_ORDERS_INCLUDED = [MAP_ORDERS[0]];

/** 存量任务(编辑回填后的表单值 = 原任务 + 挂载时 initialValue 补上的那几个) —— 都不带序 37 新字段。 */
const OLD_TASKS: Array<{ what: string; task: Record<string, any> }> = [
  {
    what: "全量 + 覆盖 + S3 Tables",
    task: {
      taskId: "t1", name: "orders-s3", datasourceId: "ds1", syncMode: "full", writeMode: "overwrite", targetType: "s3-tables", channel: "glue",
      sourceTables: ["orders"], fieldMappings: { orders: MAP_ORDERS_INCLUDED },
      s3Config: { namespace: "shop", format: "iceberg", partitionFields: [{ field: "dt", type: "date" }], icebergConfig: { snapshotRetentionDays: 7, maxSnapshots: 100, compactionMinutes: 60 } },
      glueConfig: { workerType: "G.1X", numberOfWorkers: 2, glueVersion: "5.1", timeoutMinutes: 60, maxRetries: 0 },
      scheduleEnabled: false, triggers: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
    },
  },
  {
    what: "全量 + 追加 + Redshift + 过滤条件",
    task: {
      taskId: "t2", name: "users-rs", datasourceId: "ds1", syncMode: "full", writeMode: "append", targetType: "redshift", channel: "glue",
      whereClause: "created_at >= '${run_date}'",
      sourceTables: ["orders"], fieldMappings: { orders: MAP_ORDERS_INCLUDED },
      redshiftConfig: { schema: "public", distStyle: "auto" }, targetTableNames: { orders: "ods_orders" },
    },
  },
  {
    what: "增量 + 覆盖 + both",
    task: {
      taskId: "t3", name: "inc", datasourceId: "ds1", syncMode: "incremental", writeMode: "overwrite", targetType: "both",
      incrementalConfig: { strategy: "timestamp", field: "updated_at" }, incrementalValue: "2026-10-01",
      sourceTables: ["orders"], fieldMappings: { orders: MAP_ORDERS_INCLUDED },
    },
  },
  {
    what: "实时 + 合并",
    task: { taskId: "t4", name: "rt", datasourceId: "ds1", syncMode: "realtime", writeMode: "merge", targetType: "redshift", channel: "dms",
      sourceTables: ["orders"], fieldMappings: { orders: MAP_ORDERS_INCLUDED }, dmsSettings: { lobMode: "limited", lobMaxSizeKB: 32 } },
  },
];

const stateOf = (task: Record<string, any>) => ({ selectedTables: [...task.sourceTables], fieldMappings: { orders: MAP_ORDERS } });

describe("① 钉现状:存量形态的输出与改动前逐键相同", () => {
  for (const { what, task } of OLD_TASKS) {
    it(what, () => {
      const st = stateOf(task);
      const legacy = LEGACY(structuredClone(task), st.selectedTables, st.fieldMappings);
      const now = buildSyncTaskPayload({ formValues: structuredClone(task), ...st, templateTables: [], original: task });
      expect(Object.keys(now).sort()).toEqual(Object.keys(legacy).sort());
      expect(now).toEqual(legacy);
    });
  }
  it("新建(无原任务)同样与改动前相同", () => {
    const form = { name: "n", datasourceId: "ds1", syncMode: "full", writeMode: "append", targetType: "redshift", redshiftConfig: { schema: "public" } };
    const st = { selectedTables: ["orders"], fieldMappings: { orders: MAP_ORDERS } };
    expect(buildSyncTaskPayload({ formValues: { ...form }, ...st })).toEqual(LEGACY({ ...form }, st.selectedTables, st.fieldMappings));
  });
});

describe("② 存量任务零影响:老任务原样保存,输出与输入逐键相同", () => {
  for (const { what, task } of OLD_TASKS) {
    it(what, () => {
      const out = buildSyncTaskPayload({ formValues: structuredClone(task), ...stateOf(task), original: task });
      expect(Object.keys(out)).toEqual(Object.keys(task));
      for (const k of Object.keys(task)) expect(out[k], `键 ${k}`).toEqual(task[k]);
      for (const k of SYNC_CAPABILITY_SHAPED_KEYS) expect(k in out, `老任务的请求体里多出了 ${k}`).toBe(false);
    });
  }
  it("表单里残留新字段的缺省值(控件挂载过 / 点过又撤回)也一个都不进请求体", () => {
    const task = OLD_TASKS[0].task;
    const residue = { ...structuredClone(task), overwriteScope: "table", allowEmptyOverwrite: false, derivedColumns: [], partitionKeys: [], businessTimezone: "" };
    const out = buildSyncTaskPayload({ formValues: residue, ...stateOf(task), original: task });
    expect(out).toEqual(task);
  });
  it("派生列只剩空行(点了「添加」没填)视同没有", () => {
    const task = OLD_TASKS[0].task;
    const out = buildSyncTaskPayload({ formValues: { ...structuredClone(task), derivedColumns: [{}, undefined] }, ...stateOf(task), original: task });
    expect("derivedColumns" in out).toBe(false);
  });
  it("老任务原样保存的请求体过前端校验恒为 null", () => {
    for (const { task } of OLD_TASKS) {
      const out = buildSyncTaskPayload({ formValues: structuredClone(task), ...stateOf(task), original: task });
      expect(validateSyncCapabilityFields(out as never)).toBeNull();
    }
  });
});

describe("③ 新字段:照写 / 隐藏控件残留按缺省 / 原任务有的改回缺省要显式写回", () => {
  const base = { name: "n", datasourceId: "ds1", syncMode: "full", writeMode: "overwrite", targetType: "redshift" };
  const st = { selectedTables: ["orders"], fieldMappings: { orders: MAP_ORDERS } };
  it("非缺省值照写", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, businessTimezone: " Asia/Singapore ", overwriteScope: "partitions", partitionKeys: ["month"], allowEmptyOverwrite: true,
      derivedColumns: [{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }] }, ...st });
    expect(out.businessTimezone).toBe("Asia/Singapore");
    expect(out.overwriteScope).toBe("partitions");
    expect(out.partitionKeys).toEqual(["month"]);
    expect(out.allowEmptyOverwrite).toBe(true);
    expect(out.derivedColumns).toEqual([{ name: "month", sourceColumn: "create_date", format: "yyyyMM" }]);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("写入模式改成追加后,隐藏控件里残留的「按分区 / 允许清空」不进请求体(否则用户看不见的控件让保存失败)", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, writeMode: "append", overwriteScope: "partitions", partitionKeys: ["month"], allowEmptyOverwrite: true }, ...st });
    for (const k of ["overwriteScope", "partitionKeys", "allowEmptyOverwrite"]) expect(k in out, k).toBe(false);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("增量 + 覆盖:覆盖范围不适用(残留不进请求体),空结果开关仍适用", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, syncMode: "incremental", overwriteScope: "partitions", partitionKeys: ["m"], allowEmptyOverwrite: true }, ...st });
    expect("overwriteScope" in out).toBe(false);
    expect("partitionKeys" in out).toBe(false);
    expect(out.allowEmptyOverwrite).toBe(true);
  });
  it("覆盖范围选回「整表」⇒ 分区列不进请求体", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, overwriteScope: "table", partitionKeys: ["month"] }, ...st });
    expect("partitionKeys" in out).toBe(false);
    expect("overwriteScope" in out).toBe(false);
  });
  it("原任务本来有的新字段,改回缺省时显式写回缺省值(PUT 是逐键合并)", () => {
    const original = { ...base, businessTimezone: "Asia/Tokyo", overwriteScope: "partitions", partitionKeys: ["month"], allowEmptyOverwrite: true, derivedColumns: [{ name: "month", sourceColumn: "d", format: "yyyyMM" }] };
    const out = buildSyncTaskPayload({ formValues: { ...base, businessTimezone: undefined, overwriteScope: "table", partitionKeys: ["month"], allowEmptyOverwrite: false, derivedColumns: [] }, ...st, original });
    expect(out.businessTimezone).toBe("");
    expect(out.overwriteScope).toBe("table");
    expect(out.partitionKeys).toEqual([]);
    expect(out.allowEmptyOverwrite).toBe(false);
    expect(out.derivedColumns).toEqual([]);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("带日期变量的表名合进 sourceTables(列映射为空 = 全列),固定目标表名透传", () => {
    const tpl = "cf_point_" + "$" + "{bizmonth}";
    const out = buildSyncTaskPayload({ formValues: { ...base, targetTableNames: { [tpl]: "cf_point" } }, ...st, templateTables: [tpl] });
    expect(out.sourceTables).toEqual(["orders", tpl]);
    expect((out.fieldMappings as any)[tpl]).toEqual([]);
    expect(validateSyncCapabilityFields(out as never, "jdbc")).toBeNull();
    const missing = buildSyncTaskPayload({ formValues: { ...base }, ...st, templateTables: [tpl] });
    expect(validateSyncCapabilityFields(missing as never, "jdbc")).toMatch(/固定的目标表名/);
  });
});

describe("③b 数据源范式只在过滤条件 / 表名模板是新填或改过时参与校验", () => {
  const oldDdb = { datasourceId: "ddb", whereClause: "region = 'x'", sourceTables: ["t"] };
  it("老任务那条从前不生效的过滤条件原样保存 ⇒ 不带范式(不拦与它无关的编辑)", () => {
    const payload = { ...oldDdb, name: "改了名字" };
    expect(paradigmForCapabilityCheck(payload, oldDdb, "nosql")).toBeUndefined();
    expect(validateSyncCapabilityFields(payload as never, paradigmForCapabilityCheck(payload, oldDdb, "nosql"))).toBeNull();
  });
  it("过滤条件改过 / 新建 / 有表名模板 ⇒ 带范式(非 JDBC 被拒)", () => {
    const changed = { ...oldDdb, whereClause: "region = 'y'" };
    expect(paradigmForCapabilityCheck(changed, oldDdb, "nosql")).toBe("nosql");
    expect(validateSyncCapabilityFields(changed as never, "nosql")).toMatch(/只支持 JDBC/);
    expect(paradigmForCapabilityCheck(oldDdb, undefined, "nosql")).toBe("nosql");
    const tpl = { ...oldDdb, sourceTables: ["t_" + "$" + "{ds_nodash}"] };
    expect(paradigmForCapabilityCheck(tpl, oldDdb, "nosql")).toBe("nosql");
  });
  it("向导用它决定范式", () => {
    const modal = stripComments(read("SyncTaskModal.tsx"));
    expect(modal).toMatch(/validateSyncCapabilityFields\(values, paradigmForCapabilityCheck\(values, editing/);
  });
});

describe("④ 接线:向导提交路径调用整形函数与前端校验", () => {
  const modal = stripComments(read("SyncTaskModal.tsx"));
  const body = modal.slice(modal.indexOf("const handleSubmit = async"), modal.indexOf("const validateStep ="));
  it("handleSubmit 函数体存在", () => { expect(body.length).toBeGreaterThan(200); });
  it("请求体来自 buildSyncTaskPayload(带 templateTables 与 original)", () => {
    expect(body).toMatch(/const values[^=]*=\s*buildSyncTaskPayload\(\{[\s\S]*?templateTables[\s\S]*?original: editing/);
    expect(body, "旧的就地整形又回来了").not.toMatch(/values\.sourceTables\s*=/);
  });
  it("发送前调用 validateSyncCapabilityFields,有错就 return(不发请求)", () => {
    const iVal = body.search(/const capErr = validateSyncCapabilityFields\(values,/);
    const iRet = body.search(/if \(capErr\) \{[^}]*return; \}/);
    const iSend = body.indexOf("await send(values)");
    expect(iVal).toBeGreaterThan(0);
    expect(iRet).toBeGreaterThan(iVal);
    expect(iSend).toBeGreaterThan(iRet);
  });
  it("编辑回填把带变量的表名分进 templateTables;新建清空", () => {
    expect(modal).toMatch(/setTemplateTables\(editTables\.filter\(\(x\) => x\.includes\(/);
    expect(modal, "普通表清单里混进了带变量的表名(Checkbox.Group 一勾选就会把它滤掉)").toMatch(/setSelectedTables\(editTables\.filter\(\(x\) => !x\.includes\(/);
    expect(modal).toMatch(/setSelectedTables\(\[\]\); setTemplateTables\(\[\]\)/);
  });
  it("向导挂上了四个新控件", () => {
    for (const c of ["<WhereClauseHelp", "<BusinessTimezoneField", "<TemplateTablesEditor", "<WriteOptionsSection"]) expect(modal, c).toContain(c);
  });
  it("旧的写死变量清单不在了(改由 SYNC_RUN_VAR_NAMES 生成)", () => {
    expect(modal).not.toContain('<Tag>{"${run_date}"}</Tag>');
    const controls = stripComments(read("SyncCapabilityControls.tsx"));
    expect(controls).toMatch(/SYNC_RUN_VAR_NAMES\.map\(/);
    expect(SYNC_RUN_VAR_NAMES).toContain("run_date");
    expect(SYNC_RUN_VAR_NAMES).toContain("yesterday");
  });
});

describe("⑤ 新控件一个 initialValue 都不给", () => {
  const controls = stripComments(read("SyncCapabilityControls.tsx"));
  it("SyncCapabilityControls.tsx 里没有 initialValue", () => {
    expect(controls).toContain('name="overwriteScope"');
    expect(controls).not.toMatch(/initialValue/);
  });
  it("向导里也没有给新字段 initialValue", () => {
    const modal = stripComments(read("SyncTaskModal.tsx"));
    for (const k of SYNC_CAPABILITY_SHAPED_KEYS) expect(modal).not.toMatch(new RegExp(`name="${k}"[^>]*initialValue`));
  });
});

describe("预览 / 模板表名检查", () => {
  it("按今天 UTC 渲染,未知变量给出原因", () => {
    expect(todayUtcDs(new Date("2026-03-05T23:30:00Z"))).toBe("2026-03-05");
    expect(previewTemplate("d >= '" + "$" + "{run_date}'", "2026-03-05")).toEqual({ ok: "d >= '2026-03-05'" });
    expect(previewTemplate("cf_" + "$" + "{bizmonth}", "2026-03-05")).toEqual({ ok: "cf_202602" });
    const bad = previewTemplate("x = '" + "$" + "{nope}'", "2026-03-05");
    expect("error" in bad && bad.error).toMatch(/不支持的变量/);
  });
  it("模板表名:没变量 / 变量不合法 / 重复 / 缺目标 / 目标带变量 都拒", () => {
    const tpl = "cf_point_" + "$" + "{bizmonth}";
    expect(checkTemplateTableEntry(tpl, "cf_point", [])).toBeNull();
    expect(checkTemplateTableEntry("cf_point", "cf_point", [])).toMatch(/没有日期变量/);
    expect(checkTemplateTableEntry("cf_" + "$" + "{bad}", "t", [])).toMatch(/不支持的变量/);
    expect(checkTemplateTableEntry("cf_" + "$" + "{bizmonth", "t", [])).toMatch(/不完整/);
    expect(checkTemplateTableEntry(tpl, "t", [tpl])).toMatch(/已经添加过/);
    expect(checkTemplateTableEntry(tpl, " ", [])).toMatch(/固定的目标表名/);
    expect(checkTemplateTableEntry(tpl, "t_" + "$" + "{ds}", [])).toMatch(/不能带变量/);
  });
});

describe("⑦ 预览的「今天」按业务日期时区取(没填 = UTC),并写明时区", () => {
  // 2026-03-05T23:30Z:UTC 还是 3/5,新加坡(UTC+8)已是 3/6,洛杉矶(UTC-8)是 3/5 15:30
  const now = new Date("2026-03-05T23:30:00Z");
  it("填了时区 ⇒ 按该时区的当天", () => {
    expect(previewToday("Asia/Singapore", now)).toEqual({ ds: "2026-03-06", tz: "Asia/Singapore" });
    expect(previewToday(" America/Los_Angeles ", now)).toEqual({ ds: "2026-03-05", tz: "America/Los_Angeles" });
    expect(previewToday("Asia/Tokyo", new Date("2026-12-31T15:00:00Z"))).toEqual({ ds: "2027-01-01", tz: "Asia/Tokyo" });
  });
  it("没填 / 空串 / 不合法 ⇒ UTC", () => {
    for (const tz of [undefined, null, "", "  ", "Mars/Olympus"]) expect(previewToday(tz, now)).toEqual({ ds: "2026-03-05", tz: "UTC" });
  });
  it("渲染结果随时区变(bizdate = 当天前一天)", () => {
    const tpl = "cf_" + "$" + "{bizdate}";
    expect(previewTemplate(tpl, previewToday("Asia/Singapore", now).ds)).toEqual({ ok: "cf_20260305" });
    expect(previewTemplate(tpl, previewToday(undefined, now).ds)).toEqual({ ok: "cf_20260304" });
  });
  it("接线:两处预览都用表单里的业务日期时区,文案写明时区", () => {
    const controls = stripComments(read("SyncCapabilityControls.tsx"));
    expect(controls).not.toMatch(/todayUtcDs\(/);
    expect(controls).toMatch(/const \{ ds, tz \} = previewToday\(form\.getFieldValue\("businessTimezone"\)\)/);
    expect(controls, "WHERE 预览改时区不刷新").toMatch(/p\.whereClause !== c\.whereClause \|\| p\.businessTimezone !== c\.businessTimezone/);
    expect(controls).toMatch(/const watchTz = Form\.useWatch\("businessTimezone"/);
    expect(controls).toMatch(/const today = previewToday\(watchTz\)/);
    expect(controls).toContain('t("按今天({ds},{tz})渲染后的条件:", { ds, tz })');
    expect(controls).toContain('t("按今天({ds},{tz})读的表:", { ds: today.ds, tz: today.tz })');
  });
});

describe("⑥ 新文案都有英文译文", () => {
  const literals = (src: string) => Array.from(stripComments(src).matchAll(/\bt\("([^"]+)"/g), (m) => m[1]);
  it("SyncCapabilityControls.tsx 的 t(...) 文案全在 EN 字典里", () => {
    const keys = literals(read("SyncCapabilityControls.tsx"));
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((k) => !(k in EN))).toEqual([]);
  });
  it("模板表名检查的固定错误文案(界面上过 t())全在 EN 字典里", () => {
    const msgs = Array.from(read("sync-capability-helpers.ts").matchAll(/return "([^"]+)";/g), (m) => m[1]);
    expect(msgs.length).toBeGreaterThanOrEqual(5);
    expect(msgs.filter((k) => !(k in EN))).toEqual([]);
  });
});

describe("⑦ 序 37 B-61:合并键只在 merge 时进请求体;原任务有的改回缺省要显式写回", () => {
  const base = { name: "n", datasourceId: "ds1", syncMode: "full", targetType: "s3-tables" };
  const st = { selectedTables: ["orders"], fieldMappings: { orders: MAP_ORDERS } };
  it("merge + 有键 ⇒ 照写(去空白);过前端校验", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, writeMode: "merge", mergeKeys: [" id ", "tenant_id"] }, ...st });
    expect(out.mergeKeys).toEqual(["id", "tenant_id"]);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("merge + 没键 ⇒ 请求体不带 mergeKeys,前端校验拒(中文点名合并键)—— 不替用户猜主键", () => {
    const out = buildSyncTaskPayload({ formValues: { ...base, writeMode: "merge" }, ...st });
    expect("mergeKeys" in out).toBe(false);
    expect(validateSyncCapabilityFields(out as never)).toMatch(/合并键/);
    const blank = buildSyncTaskPayload({ formValues: { ...base, writeMode: "merge", mergeKeys: ["", "  "] }, ...st });
    expect("mergeKeys" in blank).toBe(false);
  });
  it("写入模式改成追加 / 覆盖后,隐藏控件里残留的合并键不进请求体", () => {
    for (const writeMode of ["append", "overwrite"]) {
      const out = buildSyncTaskPayload({ formValues: { ...base, writeMode, mergeKeys: ["id"] }, ...st });
      expect("mergeKeys" in out, writeMode).toBe(false);
    }
  });
  it("原任务本来有 mergeKeys、改成追加 ⇒ 显式写回 [](PUT 逐键合并)", () => {
    const original = { ...base, writeMode: "merge", mergeKeys: ["id"] };
    const out = buildSyncTaskPayload({ formValues: { ...base, writeMode: "append", mergeKeys: ["id"] }, ...st, original });
    expect(out.mergeKeys).toEqual([]);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("实时(DMS)+ 合并的存量任务原样保存:不带 mergeKeys 也不被拒(DMS 的 merge 是 CDC 自己的语义)", () => {
    const rt = OLD_TASKS.find((x) => x.what === "实时 + 合并")!.task;
    const out = buildSyncTaskPayload({ formValues: structuredClone(rt), ...stateOf(rt), original: rt });
    expect("mergeKeys" in out).toBe(false);
    expect(validateSyncCapabilityFields(out as never)).toBeNull();
  });
  it("向导控件:合并键用 name=mergeKeys 的 Select、不给 initialValue、只在 merge 时渲染(mergeKeysApply)", () => {
    const src = stripComments(read("SyncCapabilityControls.tsx"));
    expect(src).toMatch(/name="mergeKeys"/);
    expect(src).not.toMatch(/name="mergeKeys"[^>]*initialValue/);
    expect(src).toContain("if (!mergeKeysApply(v)) return null;");
    expect(src).toContain('data-testid="sync-merge-keys"');
  });
});

// @kf-batch 44-sync-switch-datasource —— 编辑时换源:表单预填的旧库名不带回去(服务端按新源重算);没换源逐键不变(① 组已钉)
describe("④ 换数据源时丢掉表单预填的 sourceDatabase", () => {
  const task = { name: "t", datasourceId: "ds1", sourceDatabase: "ecommerce", sourceTables: ["orders"], syncMode: "full", writeMode: "append", targetType: "redshift" };
  it("datasourceId 与原任务不同 ⇒ 请求体没有 sourceDatabase;其余键照旧", () => {
    const out = buildSyncTaskPayload({ formValues: { ...task, datasourceId: "ds2" }, selectedTables: ["sys_config"], fieldMappings: {}, original: task });
    expect(out).not.toHaveProperty("sourceDatabase");
    expect(out.datasourceId).toBe("ds2");
    expect(out.sourceTables).toEqual(["sys_config"]);
  });
  it("datasourceId 相同 ⇒ sourceDatabase 原样;新建(无原任务)⇒ 不动", () => {
    expect(buildSyncTaskPayload({ formValues: { ...task }, selectedTables: ["orders"], fieldMappings: {}, original: task }).sourceDatabase).toBe("ecommerce");
    expect(buildSyncTaskPayload({ formValues: { ...task, datasourceId: "ds2" }, selectedTables: ["orders"], fieldMappings: {} }).sourceDatabase).toBe("ecommerce");
  });
});
