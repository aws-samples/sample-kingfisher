"use client";
// 同步向导里新能力的控件(过滤条件预览 / 表名模板 / 业务日期时区 /
// 派生列 / 覆盖范围 / 空结果开关)。合法形态的唯一作者是 lib/sync/run-vars.ts,这里只做呈现与录入。
//
// 🔴 存量任务零影响:这里的 Form.Item **一个 initialValue 都不给**(给了 ⇒ getFieldsValue(true) 里就多出缺省值,
//    原样保存一个老任务也会往请求体里塞新字段)。界面上的「缺省选中」一律用 getValueProps 只改显示、不写进表单。
//    提交整形另有一道剔除(sync-task-payload.ts),两道各管一半,任何一道单独失效判据都会红。
//
// 🔴 本文件的表单控件刻意放在既有控件**之后**、且第 0 步不加 textarea:无头验收按「对话框里第一个 textarea」
//    找过滤条件输入框、按下标找前三个下拉,新控件插到前面会让那些段静默点错。
import React from "react";
import type { FormInstance } from "antd";
import { Form, Input, Select, AutoComplete, Space, Button, Tag, Radio, Checkbox, Alert, Divider, Switch } from "antd";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { SYNC_RUN_VAR_NAMES, DERIVED_COLUMN_FORMATS, isValidBusinessTimezone } from "@/lib/sync/run-vars";
import { overwriteOptionsApply, allowEmptyApplies, mergeKeysApply, type FieldMappingRow } from "./sync-task-payload";
import { previewToday, previewTemplate, varToken, cloneColumnMapping } from "./sync-capability-helpers";
import { EMPTY_PENDING_TEMPLATE, type PendingTemplateEntry } from "./sync-edit-roundtrip";

// ───────────────────────── ① WHERE 区:可用变量 + 渲染预览 + 方言说明 ─────────────────────────
// onUserEdit:「快捷」是替用户往表单里填值(不经表单控件,表单的 onValuesChange 不会响)⇒ 填完告诉向导「用户改过了」
export function WhereClauseHelp({ form, onUserEdit }: { form: FormInstance; onUserEdit?: () => void }) {
  const t = useT();
  const quickFill = (where: string) => { form.setFieldValue("whereClause", where); onUserEdit?.(); };
  return (
    <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }} data-testid="sync-where-help">
      <div>
        {t("可用变量")}: {SYNC_RUN_VAR_NAMES.map((n) => <Tag key={n} data-testid="sync-where-var">{varToken(n)}</Tag>)}
      </div>
      <div style={{ marginTop: 4 }}>
        {t("快捷")}: <a onClick={() => quickFill("created_at >= '" + varToken("run_date") + "'")}>{t("当天")}</a>
        {" | "}<a onClick={() => quickFill("created_at >= CURRENT_DATE - INTERVAL 7 DAY")}>{t("最近7天")}</a>
        <span> {t("(「最近7天」是 MySQL 写法,仅适用于 MySQL 源)")}</span>
      </div>
      <div style={{ marginTop: 4 }}>{t("该条件会下推到源库执行,请使用源库自己的 SQL 方言;只写 WHERE 后面的部分,不要带分号。")}</div>
      <Form.Item noStyle shouldUpdate={(p, c) => p.whereClause !== c.whereClause || p.businessTimezone !== c.businessTimezone}>
        {() => {
          const where = String(form.getFieldValue("whereClause") ?? "").trim();
          if (!where) return null;
          // 「今天」按表单里的业务日期时区取(没填 = UTC),并写明用的是哪个时区
          const { ds, tz } = previewToday(form.getFieldValue("businessTimezone"));
          const r = previewTemplate(where, ds);
          return "ok" in r ? (
            <div style={{ marginTop: 4 }} data-testid="sync-where-preview" data-state="ok">
              {t("按今天({ds},{tz})渲染后的条件:", { ds, tz })} <code>{r.ok}</code>
            </div>
          ) : (
            <div style={{ marginTop: 4, color: "#ff4d4f" }} data-testid="sync-where-preview" data-state="error">
              {t("条件无法渲染:")}{r.error}
            </div>
          );
        }}
      </Form.Item>
    </div>
  );
}

// ───────────────────────── ③ 业务日期时区 ─────────────────────────
const COMMON_TIMEZONES = ["UTC", "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo", "Asia/Hong_Kong", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

export function BusinessTimezoneField({ form }: { form: FormInstance }) {
  const t = useT();
  return (
    <>
      <Form.Item
        name="businessTimezone"
        label={t("业务日期时区")}
        tooltip={t("运行时没有指定业务日期时,按这个时区取「今天」来计算日期变量;不填 = UTC。")}
        style={{ marginBottom: 4 }}
      >
        <AutoComplete
          style={{ width: 260 }}
          allowClear
          placeholder={t("不填 = UTC")}
          options={COMMON_TIMEZONES.map((z) => ({ label: z, value: z }))}
          filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          data-testid="sync-business-timezone"
        />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(p, c) => p.businessTimezone !== c.businessTimezone}>
        {() => {
          const tz = form.getFieldValue("businessTimezone");
          if (typeof tz !== "string" || !tz.trim() || isValidBusinessTimezone(tz.trim())) return <div style={{ marginBottom: 12 }} />;
          return <div style={{ color: "#ff4d4f", fontSize: 12, marginBottom: 12 }} data-testid="sync-business-timezone-error">{t("不是合法的 IANA 时区名(例如 Asia/Singapore)")}</div>;
        }}
      </Form.Item>
    </>
  );
}

// ───────────────────────── ② 带日期变量的源表名 ─────────────────────────
// 模板在源库里不存在,此前它没有列 ⇒ 客户为了看列把某个月表也勾成普通表 ⇒ 两者目标名相同,
//   同一次运行向同一张目标表写两次。现在模板可以指定一张「样例表」(源库里同结构的真表)只用来读列结构:
//   添加 / 改样例时把样例表的列映射复制给模板(fieldMappings[模板]),第 1 步字段映射 / 建表预览 / 派生列候选随之可见;样例表不会被同步。
//
// 2026-11-26 客户反馈后两处改动:
//   ① 新增行的三个框改成受控(状态在向导里):原来它们只是这个控件的内部状态,填好没点「添加」就点「完成」⇒ 不进保存请求、也不提示。
//      现在「添加」按钮与向导的「下一步 / 完成」走同一条收进来的路(onAdd / 向导的 commitPendingTemplate,校验只有一份)。
//   ② 这一块用开关收起:不按日期分表的任务只看到一行开关与一句说明;打开后才出现三个框(各带标签)与只跟它有关的提示。
//      已经添加了带日期变量的表名时恒打开(开关置灰)—— 不让「关上开关」把已有的内容藏起来。
export function TemplateTablesEditor({ form, templateTables, setTemplateTables, sourceTableNames, templateSamples, setTemplateSamples, fieldMappings, setFieldMappings,
  pending, setPending, pendingError, setPendingError, onAdd, open, setOpen, onUserEdit }: {
  form: FormInstance;
  templateTables: string[];
  setTemplateTables: (v: string[]) => void;
  /** 源库表清单里的表名 = 样例表候选 */
  sourceTableNames: string[];
  /** 模板 → 样例表 */
  templateSamples: Record<string, string>;
  setTemplateSamples: (v: Record<string, string>) => void;
  /** 每张表的列映射(模板那份由样例表复制而来) */
  fieldMappings: Record<string, FieldMappingRow[]>;
  setFieldMappings: (v: Record<string, FieldMappingRow[]>) => void;
  /** 新增行的三个输入(受控:向导的「下一步 / 完成」也要读到它) */
  pending: PendingTemplateEntry;
  setPending: (v: PendingTemplateEntry) => void;
  /** 新增行下面那句红字(校验不过的原因;中文键,这里过译文) */
  pendingError: string | null;
  setPendingError: (v: string | null) => void;
  /** 「添加」按钮:与「下一步 / 完成」同一条收进来的路(在向导里) */
  onAdd: () => void;
  /** 用户有没有打开这一块的开关(已有带日期变量的表名时恒展开,不看它) */
  open: boolean;
  setOpen: (v: boolean) => void;
  /** 用户在这一块做了不经表单控件的改动(移除 / 换样例)⇒ 告诉向导「用户改过了」 */
  onUserEdit?: () => void;
}) {
  const t = useT();
  const sampleOptions = sourceTableNames.map((n) => ({ label: n, value: n }));
  const editPending = (patch: Partial<PendingTemplateEntry>) => { setPending({ ...pending, ...patch }); setPendingError(null); };
  /** 改 / 清某个模板的样例表:样例列映射复制给模板;清掉 ⇒ 模板不再有列(运行时仍读全列,只是向导里看不到) */
  const setSampleFor = (name: string, next: string | undefined) => {
    const nextSamples = { ...templateSamples };
    const nextMaps = { ...fieldMappings };
    if (next) { nextSamples[name] = next; nextMaps[name] = cloneColumnMapping(fieldMappings[next]); } else { delete nextSamples[name]; delete nextMaps[name]; }
    setTemplateSamples(nextSamples);
    setFieldMappings(nextMaps);
    onUserEdit?.();
  };
  const remove = (name: string) => {
    setTemplateTables(templateTables.filter((x) => x !== name));
    // 目标表名一并移除(整个 targetTableNames 是一个字段,删键而不是写空串);样例与列映射也一并删
    const names = { ...(form.getFieldValue("targetTableNames") || {}) } as Record<string, unknown>;
    delete names[name];
    form.setFieldValue("targetTableNames", names);
    setSampleFor(name, undefined);
  };
  // 「今天」按表单里的业务日期时区取(没填 = UTC);useWatch 让改时区时预览跟着变
  const watchTz = Form.useWatch("businessTimezone", { form, preserve: true });
  const today = previewToday(watchTz);
  const preview = pending.tpl.trim() ? previewTemplate(pending.tpl.trim(), today.ds) : null;
  const exampleTpl = "orders_" + varToken("bizmonth");
  const hasTemplates = templateTables.length > 0;
  const expanded = hasTemplates || open;
  const cell = (width: number): React.CSSProperties => ({ display: "inline-block", width, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" });
  return (
    <div data-testid="sync-template-tables" data-open={expanded ? "true" : "false"} style={{ marginTop: 16 }}>
      <Divider>{t("带日期变量的表名")}</Divider>
      <Space align="center" style={{ marginBottom: 8 }}>
        {/* 关上开关 = 这个任务不按日期分表:新增行里还没添加的内容一并清掉(用户自己关的,不算无声丢失) */}
        <Switch size="small" checked={expanded} disabled={hasTemplates} data-testid="sync-template-toggle"
          onChange={(v) => { setOpen(v); if (!v) { setPending(EMPTY_PENDING_TEMPLATE); setPendingError(null); } }} />
        <span>{t("源库按日期分表(每月 / 每天一张表)")}</span>
        {hasTemplates ? <span style={{ fontSize: 12, color: "#888" }}>{t("(已添加带日期变量的表名;要关掉这一块,请先把它们移除)")}</span> : null}
      </Space>
      {!expanded ? (
        <div style={{ fontSize: 12, color: "#888" }} data-testid="sync-template-collapsed-hint">
          {t("源库里同一类数据按日期分成多张表(例如 {a}、{b})时打开:用带日期变量的表名,每次运行只读业务日期对应的那一张。只同步上面勾选的表,就不用打开。", { a: "orders_202609", b: "orders_202610" })}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }} data-testid="sync-template-help">
            <div>{t("源库里按日期分表(例如每月一张:{a}、{b})时,把表名里的日期写成变量({tpl}),每次运行只读业务日期对应的那一张,并写到一个固定的目标表(例如 {target})。", { a: "orders_202609", b: "orders_202610", tpl: exampleTpl, target: "ods_orders" })}</div>
            <div>{t("要看列结构、做字段映射、预览建表,请为它选一张同结构的真表作「样例表」:样例表只用来读列,不会被同步。不要再在上面的清单里勾选这些月表 —— 勾了就会多同步一份,并与模板写同一张目标表。")}</div>
          </div>
          {/* 三个框各自的标签(原来只有占位提示,填上就看不出哪个框是什么) */}
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }} data-testid="sync-template-labels">
            <span style={cell(240)}>{t("源表名(带日期变量)")}</span>
            <span style={cell(30)} />
            <span style={cell(208)}>{t("固定的目标表名")}</span>
            <span style={cell(228)}>{t("样例表(只读列结构,不会被同步)")}</span>
          </div>
          {templateTables.map((name) => (
            <Space key={name} style={{ display: "flex", marginBottom: 6 }} data-testid="sync-template-table-row" data-template={name} data-sample={templateSamples[name] || ""}>
              <span style={cell(240)} title={name}><code>{name}</code></span> →
              <Form.Item name={["targetTableNames", name]} noStyle>
                <Input size="small" style={{ width: 200 }} placeholder={t("固定的目标表名")} />
              </Form.Item>
              <Select size="small" style={{ width: 220 }} allowClear showSearch disabled={sampleOptions.length === 0} value={templateSamples[name]}
                placeholder={sampleOptions.length ? t("样例表(只读列结构)") : t("先选数据源才有样例表可选")} options={sampleOptions}
                onChange={(v) => setSampleFor(name, v ? String(v) : undefined)} data-testid="sync-template-sample" />
              <MinusCircleOutlined onClick={() => remove(name)} data-testid="sync-template-table-remove" />
            </Space>
          ))}
          <Space wrap style={{ marginTop: 4 }} data-testid="sync-template-new-row">
            <Input size="small" style={{ width: 240 }} value={pending.tpl} onChange={(e) => editPending({ tpl: e.target.value })}
              placeholder={t("源表名,例如 {example}", { example: exampleTpl })} data-testid="sync-template-table-name" />
            →
            <Input size="small" style={{ width: 200 }} value={pending.target} onChange={(e) => editPending({ target: e.target.value })}
              placeholder={t("固定的目标表名")} data-testid="sync-template-table-target" />
            <Select size="small" style={{ width: 220 }} allowClear showSearch disabled={sampleOptions.length === 0} value={pending.sample}
              placeholder={sampleOptions.length ? t("样例表(只读列结构)") : t("先选数据源才有样例表可选")} options={sampleOptions}
              onChange={(v) => editPending({ sample: v ? String(v) : undefined })} data-testid="sync-template-sample-new" />
            <Button size="small" icon={<PlusOutlined />} onClick={onAdd} data-testid="sync-template-table-add">{t("添加带日期变量的表名")}</Button>
          </Space>
          {preview && "ok" in preview ? (
            <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{t("按今天({ds},{tz})读的表:", { ds: today.ds, tz: today.tz })} <code>{preview.ok}</code></div>
          ) : null}
          {pendingError ? <div style={{ fontSize: 12, color: "#ff4d4f", marginTop: 4 }} data-testid="sync-template-table-error">{t(pendingError)}</div> : null}
        </>
      )}
    </div>
  );
}

// ───────────────────────── ④⑤⑥ 写入选项:派生列 / 覆盖范围 / 空结果开关 ─────────────────────────
export function WriteOptionsSection({ form, sourceColumns, targetType }: {
  form: FormInstance;
  /** 已选源表的源列名(派生列「来源列」的候选) */
  sourceColumns: string[];
  targetType: string;
}) {
  const t = useT();
  return (
    <div data-testid="sync-write-options">
      <Divider>{t("派生列")}</Divider>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
        {t("写入前按来源列的日期计算出新列(例如 create_date → month,格式 yyyyMM),可作为分区列。")}
      </div>
      <Form.List name="derivedColumns">
        {(fields, { add, remove }) => (
          <div>
            {fields.map(({ key, name }) => (
              <Space key={key} align="baseline" style={{ display: "flex", marginBottom: 8 }} data-testid="sync-derived-row">
                <Form.Item name={[name, "name"]} noStyle><Input placeholder={t("新列名")} style={{ width: 160 }} /></Form.Item>
                <Form.Item name={[name, "sourceColumn"]} noStyle>
                  <AutoComplete style={{ width: 200 }} placeholder={t("来源列")} options={sourceColumns.map((c) => ({ label: c, value: c }))}
                    filterOption={(input, opt) => String(opt?.value ?? "").toLowerCase().includes(input.toLowerCase())} />
                </Form.Item>
                <Form.Item name={[name, "format"]} noStyle>
                  <Select style={{ width: 150 }} placeholder={t("格式")} options={DERIVED_COLUMN_FORMATS.map((f) => ({ label: f, value: f }))} />
                </Form.Item>
                <MinusCircleOutlined onClick={() => remove(name)} />
              </Space>
            ))}
            <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />} data-testid="sync-derived-add">{t("添加派生列")}</Button>
          </div>
        )}
      </Form.List>

      <Form.Item noStyle shouldUpdate>
        {() => {
          const v = form.getFieldsValue(true) as Record<string, unknown>;
          const showScope = overwriteOptionsApply(v);
          const showEmpty = allowEmptyApplies(v);
          if (!showScope && !showEmpty) return null;
          const partitionFields = ((v.s3Config as { partitionFields?: Array<{ field?: unknown; type?: unknown }> } | undefined)?.partitionFields || []);
          const identityFields = partitionFields
            .filter((p) => p && p.field && p.type !== "date" && p.type !== "year-month")
            .map((p) => String(p.field));
          const derivedNames = (Array.isArray(v.derivedColumns) ? v.derivedColumns : [])
            .map((d) => (d && typeof d === "object" ? String((d as { name?: unknown }).name ?? "") : ""))
            .filter(Boolean);
          const candidates = Array.from(new Set([...identityFields, ...derivedNames]));
          const writesS3 = targetType === "s3-tables" || targetType === "both";
          return (
            <div>
              <Divider>{t("覆盖写入选项")}</Divider>
              {showScope ? (
                <>
                  <Form.Item
                    name="overwriteScope"
                    label={t("覆盖范围")}
                    // 未设置时显示为「整表」,但不写进表单(存量任务零影响)
                    getValueProps={(val) => ({ value: val ?? "table" })}
                  >
                    <Radio.Group data-testid="sync-overwrite-scope">
                      <Radio.Button value="table">{t("整表")}</Radio.Button>
                      <Radio.Button value="partitions">{t("按分区")}</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  {v.overwriteScope === "partitions" ? (
                    <>
                      <Form.Item name="partitionKeys" label={t("分区列")} tooltip={t("只覆盖本批数据涉及的这些分区,其余分区保持不变。候选 = 按原值的分区字段 + 派生列。")}>
                        <Select mode="tags" style={{ width: 360 }} placeholder={t("选择分区列")} options={candidates.map((c) => ({ label: c, value: c }))} data-testid="sync-partition-keys" />
                      </Form.Item>
                      {writesS3 ? (
                        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="sync-partition-s3-hint"
                          message={t("写 S3 Tables 时,上面「分区配置」里的分区字段必须恰好是这些分区列,并且按原值分区(类型选「字符串」,不能用「日期」)。")} />
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
              {showEmpty ? (
                <>
                  <Form.Item name="allowEmptyOverwrite" valuePropName="checked" style={{ marginBottom: 4 }}>
                    <Checkbox data-testid="sync-allow-empty-overwrite">{t("读到 0 行也允许清空目标表")}</Checkbox>
                  </Form.Item>
                  <div style={{ fontSize: 12, color: "#faad14", marginBottom: 12 }}>
                    {t("默认情况下,覆盖写入读到 0 行会判为失败、目标表保持不动(防止源端故障时把数据清空)。勾选后,源端确实没有数据时会把目标表(或对应分区)清空。")}
                  </div>
                </>
              ) : null}
            </div>
          );
        }}
      </Form.Item>

      {/* 合并键 —— 只在写入模式 = 合并时出现(放在本节最后,不改变既有控件的位置与下标)。 */}
      {/* 🔴 不给初值、不给缺省:没有键的合并任务由前端校验(validateSyncCapabilityFields)与服务端 400 一起挡住。 */}
      <Form.Item noStyle shouldUpdate={(p, c) => p.writeMode !== c.writeMode || p.mergeKeys !== c.mergeKeys}>
        {() => {
          const v = form.getFieldsValue(true) as Record<string, unknown>;
          if (!mergeKeysApply(v)) return null;
          const keys = Array.isArray(v.mergeKeys) ? (v.mergeKeys as unknown[]).filter((k) => typeof k === "string" && k.trim()) : [];
          return (
            <div data-testid="sync-merge-options">
              <Divider>{t("合并写入选项")}</Divider>
              <Form.Item
                name="mergeKeys"
                label={t("合并键")}
                required
                tooltip={t("按这些列判定「同一行」:键命中的行整行更新,其余插入。至少一列;候选 = 已选源表的列,也可手输。")}
                style={{ marginBottom: 4 }}
              >
                <Select mode="tags" style={{ width: 360 }} placeholder={t("选择或输入合并键列")} options={sourceColumns.map((c) => ({ label: c, value: c }))} data-testid="sync-merge-keys" />
              </Form.Item>
              {keys.length === 0 ? (
                <div style={{ fontSize: 12, color: "#ff4d4f", marginBottom: 12 }} data-testid="sync-merge-keys-error">{t("合并写入必须指定至少一个合并键")}</div>
              ) : (
                <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>
                  {t("合并不会清空目标表;源数据里合并键重复或为空时本次运行会失败、目标表一行不动。")}
                </div>
              )}
            </div>
          );
        }}
      </Form.Item>
    </div>
  );
}
