"use client";

import React, { useEffect, useRef, useState } from "react";
import { Modal, Form, Input, Select, Steps, InputNumber, Space, Button, Table, Switch, Checkbox, Tag, Divider, Radio, Alert, message } from "antd";
import TableBucketPicker from "@/components/lake/TableBucketPicker"; // S3 Tables 表桶下拉(唯一作者)
import { MinusCircleOutlined, PlusOutlined, SwapOutlined, CheckCircleOutlined, WarningOutlined, ThunderboltOutlined, InfoCircleOutlined } from "@ant-design/icons";
import type { SyncTask } from "@/types/sync-task";
import type { DataSource } from "@/types/datasource";
import { DS_TYPE_OPTIONS } from "@/types/datasource";
import { resolveTargetTableName } from "@/lib/sync/target-naming";
// 新字段合法形态的唯一作者 = lib/sync/run-vars.ts;提交整形的唯一作者 = ./sync-task-payload.ts
import { validateSyncCapabilityFields } from "@/lib/sync/run-vars";
// Glue 版本清单与「写 S3 Tables 的最低版本」的唯一作者(后端新建 / 保存 / 启动三处同一份)
import { GLUE_VERSIONS, GLUE_VERSION_DEFAULT, GLUE_VERSION_FOR_UNVERSIONED_RECORDS, S3_TABLES_MIN_GLUE_VERSION, glueVersionSupportsS3Tables, glueVersionLabel } from "@/lib/sync/glue-version";
import { buildSyncTaskPayload, paradigmForCapabilityCheck } from "./sync-task-payload";
// 取表清单的唯一作者(直连 / 经 Glue 连接发现 + 轮询)
import { fetchSourceTables } from "@/lib/datasource/tables-client";
// 向导本地草稿(单一作者 lib/sync/wizard-draft.ts):每步改动落 localStorage,保存成功才清;再打开问「恢复 / 丢弃」
import { clearSyncDraft, describeDraftAge, loadSyncDraft, saveSyncDraft, type SyncWizardDraft } from "@/lib/sync/wizard-draft";
// UX ②:第一步三个选择题的缺省值(唯一作者)
import { SYNC_WIZARD_DEFAULTS } from "@/lib/sync/wizard-defaults";
import { WhereClauseHelp, BusinessTimezoneField, TemplateTablesEditor, WriteOptionsSection } from "./SyncCapabilityControls";
// 模板实例识别(守卫 1 黄标)与样例列映射复制(纯函数,单测在 __tests__/template-sample-table.test.ts)
import { templateInstanceOf, cloneColumnMapping } from "./sync-capability-helpers";

// 数据源类型→图标(由 DS_TYPE_OPTIONS 单一事实源派生,不再散落硬编码 mysql?🐬:🐘)。
const DS_TYPE_ICON: Record<string, string> = Object.fromEntries(DS_TYPE_OPTIONS.map((o) => [o.value, o.icon]));
import { GLUE_WORKER_TYPES, GLUE_MAX_WORKERS } from "@/lib/etl/worker-types";
import NetworkAdvisorPanel from "@/components/network-advisor/NetworkAdvisorPanel";
import ParamAdvisorPanel from "@/components/param-advisor/ParamAdvisorPanel";
import RoleAdvisorPanel from "@/components/role-advisor/RoleAdvisorPanel";
// Glue 通道的执行角色改为选择器(三组下拉 + 刷新 + 手填兜底 + 检查权限;角色顾问面板在其内)
import ExecutionRolePicker from "@/components/exec-roles/ExecutionRolePicker";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";
import type { ComputeKind, Target } from "@/lib/network-advisor";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";
// 存量源(无 ownerTargetId)= 主控区,前端显式给(后端缺 targetId ⇒ 400)
import { targetOfStamp } from "@/lib/exec-env/target-id";
// `HOME_WORKGROUP` import 在此**已退役**:
// 落点(workgroup/database/表桶)的唯一作者在服务端(按任务所在章的描述符解析),向导一律留空。
// 🔴 别再把它加回来:客户端引用 home 的 workgroup 常量,等于在前端造第二个落点真值源
// (段 o4 的就是这条路上的红)。要列 workgroup 就用 `/api/redshift/connections?targetId=`。

interface Props { open: boolean; editing?: SyncTask; onClose: () => void; onSuccess: () => void; }

/**
 * 编辑**存量**任务时,记录里没有 Glue 版本的,表单里显示并保存它被写下时的缺省(5.1)—— 否则 antd 的 initialValue(新缺省 6.0)会顶上去,
 *   用户只是改个别字段点「完成」,任务就被静默换到 6.0(与运行侧 glueVersionOfRecord 同一口径)。新建任务不经这里,缺省仍是最高版本。
 */
function withRecordGlueVersion(task: SyncTask): SyncTask {
  const g = (task.glueConfig || {}) as { glueVersion?: string };
  if (g.glueVersion) return task;
  return { ...task, glueConfig: { ...(task.glueConfig || {}), glueVersion: GLUE_VERSION_FOR_UNVERSIONED_RECORDS } };
}

export default function SyncTaskModal({ open, editing, onClose, onSuccess }: Props) {
  // targetId → 可读 region(拿不到就退回 targetId,绝不显示空)
  const { scope, targets: scopeTargets } = useScope();
  const regionLabelOf = (tid?: string) => {
    const id = tid || "tgt_home";
    return scopeTargets?.find((x: { targetId: string; region?: string }) => x.targetId === id)?.region || id;
  };
  const t = useT();
  const [form] = Form.useForm();
  // 网络顾问:响应式读取数据源/通道/目标,决定是否展示 + 传什么 computeKind/targets。
  // preserve:channel 的 Form.Item 只在 channelRec 非空时挂载;编辑弹窗重开 channelRec=null,
  // 默认 useWatch 不监听未注册字段 → watchChannel 恒 undefined,step4 通道区块(Glue 资源/DMS 设置)不渲染。
  const watchDsId = Form.useWatch("datasourceId", form);
  const watchChannel = Form.useWatch("channel", { form, preserve: true });
  const watchTargetType = Form.useWatch("targetType", form);
  // 网络预检要跟着用户选的 workgroup 走(getFieldValue 不触发重算)。
  const watchRsWorkgroup = Form.useWatch(["redshiftConfig", "workgroupName"], form) as string | undefined;
  const { getToken } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { (async () => { try { setIsAdmin(groupsFromToken(await getToken()).includes("bgp-admin")); } catch { /* 忽略 */ } })(); }, [getToken]);
  const [step, setStep] = useState(0);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  // 带日期变量的源表名单独存:它们不在源库表清单里,而 antd 的
  // Checkbox.Group 在 onChange 时会把「没有对应复选框」的值滤掉(混在 selectedTables 里一勾选就丢了)。
  const [templateTables, setTemplateTables] = useState<string[]>([]);
  // 模板 → 样例表(源库里一张同结构的真表,只用来读列结构,不会被同步)。ref 镜像给异步的 onDatasourceChange 读最新值
  //   拉表回来后按样例表新拉到的列重建模板的列映射(编辑打开 / 恢复草稿 / 换源都走那条路)。
  const [templateSamples, setTemplateSamples] = useState<Record<string, string>>({});
  const templateSamplesRef = useRef(templateSamples);
  templateSamplesRef.current = templateSamples;
  // 拉表请求序号:只有**最后一次**选源的结果能落进 tables / fieldMappings。
  //   编辑打开时自动按旧源拉表(经 Glue 发现要 1–3 分钟),此时用户换源 ⇒ 两次拉表并发,先发后到的旧源结果会盖掉新源表清单(stale-response 竞态)。
  const dsReqSeq = useRef(0);
  // 提交前前端校验(validateSyncCapabilityFields)的错误;显示在表单顶上并阻止提交
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [fieldMappings, setFieldMappings] = useState<Record<string, any[]>>({});
  const [saving, setSaving] = useState(false);
  // 打开时发现的未保存草稿(用户决定恢复 / 丢弃前先不动表单);tableFilter / onlySelected 是选表步的筛选器
  const [pendingDraft, setPendingDraft] = useState<SyncWizardDraft | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [targetType, setTargetType] = useState("");
  const [channelRec, setChannelRec] = useState<any>(null);
  // 🔴 生产上线批次 A:exists 三态(true / false / null = 探测不到);platformCreated 区分「平台建的」与「客户已有的」。
  const [ddlPreview, setDdlPreview] = useState<Record<string, { ddl: string; table?: string; exists: boolean | null; platformCreated?: boolean | null }>>({});
  // IAM 侧(2026-10-21):原来这里还有一个 `s3Buckets` 状态 + 打开向导就 fetch("/api/s3/buckets"),但**没有任何 JSX 消费它**
  //   (表桶下拉早已是 TableBucketPicker 按落点读 S3 Tables 候选)⇒ 每开一次向导白打一次账号级 ListBuckets。死请求删掉,不是搬轴。
  const [rsWorkgroups, setRsWorkgroups] = useState<any[]>([]);
  const [rsDatabases, setRsDatabases] = useState<string[]>([]); // 空 = 还不知道是哪个区的数仓(别拿 home 的 dev 打底)
  // 任务跟随源的执行环境(章 = ds.ownerTargetId,
  // 服务端 bindingForNewSyncTask 同一条判据)。`dsNonHome` 只用来决定**查哪个区**的清单/带不带
  // targetId;落点值本身**不分 home 与否,一律不预填**(留空 = 服务端按该章解析,前端不造第二个
  // 落点真值源;「只在非 home 清空」那种分叉靠挂载时序,已被判死)。
  const watchDsOwnerTarget = ((dataSources.find((d) => d.datasourceId === watchDsId) as any)?.ownerTargetId as string) || "tgt_home";
  const dsNonHome = watchDsOwnerTarget !== "tgt_home";
  // SCH-03: options (other sync tasks + workflows) for the downstream-dependency selector.
  const [depOptions, setDepOptions] = useState<{ label: string; value: string }[]>([]);
  // SYNC-FIX(namespace): S3 Tables namespace 支持两种方式——
  //   auto(默认)= 跟随所选数据源库名,输入框只读、切库实时更新;
  //   manual     = 用户自定义,自由输入。
  const [nsMode, setNsMode] = useState<"auto" | "manual">("auto");
  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    // 🔴 **刻意不按当前范围过滤数据源**。
    // 用户 2026-09-10:「所有的任务都要创建在当前区域…**除非在主控区创建任务,可以选择在主控区
    // 下发到其他指定区域执行**。」同步任务的落点由它引用的数据源派生 ⇒ 只有让用户看得到别区的源,
    // 「站在主控区往别的区下发」才成立。所以这里给全清单,并在下拉里**标出每个源在哪个区**(护栏 2:
    // 选的时候就知道这个任务会在哪儿跑),而不是过滤掉再让用户纳闷「我的源哪去了」。
    fetch("/api/datasources").then((r) => r.json()).then((d) => setDataSources(d.success ? d.data : d));
    // 还没选源时先列主控区的(与改动前一致,显式写明);选了源由下面按源的章重拉
    fetch("/api/redshift/connections?targetId=tgt_home").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setRsWorkgroups(d); });
    // 🔴 这里原来硬编码 `workgroup=bgp-workgroup` 预拉库清单
    // 选了非 home 的源,下拉里列的却是**主控区**的库名,选中就在真跑时被 409 拒。库清单只能在
    // 「知道是哪个 workgroup」之后拉(见 Workgroup 选择器的 onChange),选源时先清空防跨区串味。
    // SCH-03: build the list of downstream targets (other sync tasks + workflows).
    Promise.all([
      fetch("/api/sync").then((r) => r.json()).catch(() => []),
      fetch("/api/workflow").then((r) => r.json()).catch(() => []),
    ]).then(([syncRes, wfRes]) => {
      const syncs = (syncRes?.data || syncRes || []).filter((s: any) => s.taskId !== editing?.taskId);
      const wfs = Array.isArray(wfRes) ? wfRes : wfRes?.data || [];
      setDepOptions([
        ...syncs.map((s: any) => ({ label: t("同步: {name}", { name: s.name || s.taskId }), value: s.taskId })),
        ...wfs.map((w: any) => ({ label: t("工作流: {name}", { name: w.name || w.workflowId }), value: w.workflowId })),
      ]);
    });
  }, [open]);

  // BUGFIX(编辑第2步空表):datasourceId 是 setFieldsValue 静默回填,不触发 Select.onChange,
  // 故 tables/fieldMappings 始终空 → 第2步恒显示"请先在上一步选择数据源"(所有编辑场景通病;
  // Copilot 建的草稿必须编辑补表,首当其冲)。等 dataSources 加载完 + 有已选源 + 表尚未拉时,
  // 主动拉一次表清单+字段映射(与手动选源等价)。依赖 dataSources 避免其未就绪时 find 落空的竞态。
  useEffect(() => {
    if (!open || !editing?.datasourceId || dataSources.length === 0 || tables.length > 0) return;
    onDatasourceChange(editing.datasourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, dataSources]);

  // userSwitched = 用户在下拉里换了源(编辑打开时的自动回填 / 草稿恢复不算):
  //   换源后原已选的表若不在新源的表清单里一律移除并告知 —— 否则保存下去的任务引用新源不存在的表,一跑必失败(…7698 探针 2026-10-15 坐实:
  //   换到 sys 库后计数「已选 2 / 共 101」,其中 products 是旧源的,PUT 的 sourceTables 带着它、fieldMappings.products 为空)。
  const onDatasourceChange = async (dsId: string, opts?: { userSwitched?: boolean }) => {
    const ds = dataSources.find((d) => d.datasourceId === dsId);
    if (!ds) return;
    const seq = ++dsReqSeq.current;
    // 源在哪个区,任务就在那个区跑。workgroup 下拉改拉**该区**清单。
    // 🔴 落点字段(表桶/workgroup/库)在前端**一律不预填**:留空 = 服务端按该章的描述符解析
    // (start 路由 tableBucketName / resolveRedshiftBinding 是唯一作者)。此处刻意不按 home 与否
    // 分两条路——「非 home 才清空」曾靠挂载时序,而 S3 / Redshift 区块是选完 targetType 才挂载,
    // 挂载时 initialValue 又把 home 桶名填回去(段 o4 的就是这么红的)。
    const ownerTid = ((ds as any).ownerTargetId as string) || "tgt_home";
    const nonHome = ownerTid !== "tgt_home";
    fetch(`/api/redshift/connections?targetId=${encodeURIComponent(ownerTid)}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d) && seq === dsReqSeq.current) setRsWorkgroups(d); });
    setRsDatabases([]); // 换源可能换区 ⇒ 上一个区的库清单立即作废(选中不存在的库 = 真跑时 409)
    // SYNC-FIX(namespace): 自动模式下 namespace 恒跟随所选数据源库名(切库实时更新,修此前
    // 「只在为空时填」导致换库残留旧库名的陈旧 bug);手动模式尊重用户输入不动。
    // 后端 fallback 同为 ds.database,避免非 ecommerce 用户数据落进硬编码的 ecommerce namespace。
    // namespace 跟随源标识——JDBC 用库名;DDB 无库,用表名;S3 用桶名(非 JDBC 源 ds.database 为 undefined)。
    if (nsMode === "auto") {
      const c = (ds as any).connection || {};
      const nsFallback = ds.database || c.tableName || c.bucket || "default";
      form.setFieldValue(["s3Config", "namespace"], nsFallback);
    }
    // 直连读不到且有 Glue 连接时后端起发现作业(202),唯一作者 fetchSourceTables 负责轮询;源在自有网络的客户向导才建得了任务
    let tableList: any[] = [];
    try {
      const r = await fetchSourceTables(dsId, ds.database, {
        onWaiting: (info) => message.info(info.note || t("正在经数据源的 Glue 连接发现表(约 1–3 分钟),请稍候…"), 8),
      });
      tableList = r.tables;
      if (r.via === "glue-discovery") message.success(t("表结构经数据源的 Glue 连接发现({n} 张表)", { n: r.tables.length }));
    } catch (e: any) {
      if (seq === dsReqSeq.current) message.error(e?.message || t("获取表列表失败"));
    }
    // 🔴 先发后到的旧源结果不许盖掉新源的表清单 / 映射(用户已经换了源,这次结果作废)
    if (seq !== dsReqSeq.current) return;
    setTables(tableList);
    if (opts?.userSwitched) {
      // 旧源的建表预览 / 通道推荐 / 能力校验错误都是按旧源算的,一律作废
      setDdlPreview({}); setChannelRec(null); setCapabilityError(null);
      const names = new Set(tableList.map((x: any) => String(x.name)));
      const dropped = selectedTables.filter((x) => !names.has(x));
      if (dropped.length) {
        setSelectedTables(selectedTables.filter((x) => names.has(x)));
        message.info(t("已切换数据源:原已选的 {n} 张表不在新源里,已移除({list})", { n: String(dropped.length), list: dropped.slice(0, 5).join(", ") }), 8);
      }
      // 样例表不在新源里的模板 ⇒ 样例作废(模板本身保留,用户可重新选样例)
      const samplesNow = templateSamplesRef.current;
      const keptSamples = Object.fromEntries(Object.entries(samplesNow).filter(([, sampleName]) => names.has(sampleName)));
      if (Object.keys(keptSamples).length !== Object.keys(samplesNow).length) { templateSamplesRef.current = keptSamples; setTemplateSamples(keptSamples); }
    }
    const mappings: Record<string, any[]> = {};
    for (const tbl of tableList) {
      if (tbl.columns?.length) {
        const mapRes = await fetch("/api/sync/type-mapping", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceDb: ds.type, columns: tbl.columns }) });
        const mapData = await mapRes.json();
        mappings[tbl.name] = (mapData.success ? mapData.data : mapData).map((m: any) => ({ ...m, include: true }));
      }
    }
    // 模板的列映射 = 它的样例表的列(按新拉到的样例列重建;样例不在清单里 ⇒ 模板暂时没有列)
    for (const [tpl, sampleName] of Object.entries(templateSamplesRef.current)) {
      if (mappings[sampleName]) mappings[tpl] = cloneColumnMapping(mappings[sampleName]);
    }
    if (seq !== dsReqSeq.current) return;
    setFieldMappings(mappings);
  };

  const fetchChannelRec = async () => {
    const ds = dataSources.find((d) => d.datasourceId === form.getFieldValue("datasourceId"));
    const res = await fetch("/api/sync/recommend-channel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceType: ds?.type, targetType: form.getFieldValue("targetType"), syncMode: form.getFieldValue("syncMode") }) });
    const data = await res.json();
    setChannelRec(data.success ? data.data : data);
    if (data.data?.recommended) form.setFieldValue("channel", data.data.recommended);
  };

  const fetchDDL = async (tableName: string) => {
    const ds = dataSources.find((d) => d.datasourceId === form.getFieldValue("datasourceId"));
    const cols = fieldMappings[tableName]?.filter((f) => f.include);
    if (!cols?.length) return;
    // SYNC-07: generate the DDL for the resolved target table name (default = source name).
    const targetName = resolveTargetTableName(tableName, form.getFieldsValue(true));
    // DDL 的落点 = 源的执行环境(服务端 resolveRedshiftBinding 按它取四样)
    const res = await fetch("/api/sync/generate-ddl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceDb: ds?.type, tableName: targetName, columns: cols.map((c: any) => ({ name: c.source, type: c.sourceType })), redshiftConfig: form.getFieldValue("redshiftConfig"), targetId: targetOfStamp((ds as any)?.ownerTargetId) }) });
    const data = await res.json();
    if (data.success) setDdlPreview((prev) => ({ ...prev, [tableName]: { ddl: data.data.ddl, table: data.data.table, exists: data.data.tableExists ?? null, platformCreated: data.data.platformCreated ?? null } }));
  };

  const executeDDL = async (tableName: string) => {
    if (!ddlPreview[tableName]?.ddl) return;
    // 预建表建到源所在的区(targetId 派生自 ds.ownerTargetId)
    // 🔴 生产上线批次 A:不再把 SQL 文本发给服务端执行 —— 发的是与「生成 DDL」同一份建表参数,
    //   服务端现生成那条 CREATE TABLE 并打平台标记(见 lib/sync/target-ddl.ts)。
    const ds = dataSources.find((d) => d.datasourceId === form.getFieldValue("datasourceId"));
    const cols = fieldMappings[tableName]?.filter((f) => f.include) || [];
    const targetName = resolveTargetTableName(tableName, form.getFieldsValue(true));
    const res = await fetch("/api/sync/execute-ddl", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceDb: ds?.type, tableName: targetName, columns: cols.map((c: any) => ({ name: c.source, type: c.sourceType })), redshiftConfig: form.getFieldValue("redshiftConfig"), targetId: targetOfStamp((ds as any)?.ownerTargetId) }) });
    const data = await res.json();
    if (data.success) { message.success(t("{name} 建表成功", { name: tableName })); fetchDDL(tableName); }
    else message.error(data.error?.message || t("建表失败"));
  };

  // 草稿:每一步 / 每次改值都存(便宜,不防抖);保存成功才清。恢复 = 回填表单 + 选表 + 映射 + 步骤,再按源重拉表清单(映射以草稿为准)。
  const draftKey = editing?.taskId;
  const saveDraftNow = () => {
    if (!open) return;
    saveSyncDraft(draftKey, { step, formValues: form.getFieldsValue(true) as Record<string, unknown>, selectedTables, templateTables, templateSamples, fieldMappings });
  };
  useEffect(() => { saveDraftNow(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, step, selectedTables, templateTables, fieldMappings]);
  const applyDraft = async (d: SyncWizardDraft) => {
    setPendingDraft(null);
    form.setFieldsValue(d.formValues);
    setTargetType(String((d.formValues as any)?.targetType || ""));
    setSelectedTables(d.selectedTables);
    setTemplateTables(d.templateTables);
    setTemplateSamples(d.templateSamples || {});
    templateSamplesRef.current = d.templateSamples || {};
    setFieldMappings(d.fieldMappings as Record<string, any[]>);
    const dsId = String((d.formValues as any)?.datasourceId || "");
    if (dsId && tables.length === 0) {
      await onDatasourceChange(dsId);
      setFieldMappings((prev) => ({ ...prev, ...(d.fieldMappings as Record<string, any[]>) })); // 映射以草稿为准(用户勾掉的字段不许回来)
    }
    setStep(Math.min(Math.max(0, d.step), STEPS.length - 1));
    message.success(t("已恢复上次未保存的配置"));
  };
  const discardDraft = () => { clearSyncDraft(draftKey); setPendingDraft(null); };

  const handleSubmit = async () => {
    // 🔴 整个提交路径都在 try 里:原来整形 / 校验在 try 之外,一旦抛错 Modal 的 onOk 静默吞掉 ⇒ 用户看到的就是「点『完成』没反应」;
    //   现在任何异常都落成一条 message.error,且草稿一直在,关掉重开能恢复。
    //   「完成」从第 2 步起任何一步都能点(UX ②:第 1 步只留「下一步」,三个选择题有缺省)⇒ 先按用户的话复述前两步的必填项(任务名称 / 数据源 / 模式 / 至少一张表),
    //   而不是让后端那句带字段名的拒绝(「`sourceTables` 为空 …」)当第一道提示(2026-10-15 页面驱动 p42b W3 看到的就是它)。
    if (!validateUpTo(1)) return;
    try {
      await handleSubmitInner();
    } catch (e: any) {
      message.error(t("保存失败:{m}", { m: String(e?.message || e).slice(0, 200) }));
    }
  };

  const handleSubmitInner = async () => {
    // 整形抽成纯函数(判据钉住改动前的输出 + 存量任务逐键不变)
    const values: Record<string, any> = buildSyncTaskPayload({
      formValues: form.getFieldsValue(true),
      selectedTables,
      templateTables,
      templateSamples,
      fieldMappings,
      original: editing as Record<string, unknown> | undefined,
    });
    // 前端先校验一遍(后端同一函数再校验)。数据源范式只在「过滤条件 / 表名模板是本次新填或改过的」时参与:
    // 存量任务里那条从前不生效的过滤条件原样保存时,不因为源不是 JDBC 就被拦住保存。
    const ds = dataSources.find((d) => d.datasourceId === values.datasourceId);
    const paradigm = DS_TYPE_OPTIONS.find((o) => o.value === ds?.type)?.paradigm;
    const capErr = validateSyncCapabilityFields(values, paradigmForCapabilityCheck(values, editing as Record<string, unknown> | undefined, paradigm));
    if (capErr) { setCapabilityError(capErr); message.error(capErr); return; }
    setCapabilityError(null);
    setSaving(true);
    try {
      const url = isEdit ? `/api/sync/${editing.taskId}` : "/api/sync";
      const send = (v: Record<string, unknown>) => fetch(url, { method: isEdit ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
      const res = await send(values);
      const data = await res.json();
      // 🔴 生产上线批次 A:服务端发现「会被整表清空的、不是平台建的已有表」⇒ 逐表列给用户确认,确认后带清单重提。
      const err = data?.error;
      if (res.status === 409 && err?.code === "DECISION_REQUIRED" && err?.detail?.kind === "overwrite-foreign-tables") {
        const tables: string[] = err.detail.tables || [];
        Modal.confirm({
          title: t("确认覆盖已有的表?"),
          okText: t("确认覆盖"),
          okButtonProps: { danger: true, "data-testid": "sync-overwrite-confirm-ok" } as any,
          cancelText: t("取消"),
          content: (
            <div data-testid="sync-overwrite-confirm">
              <p>{t("以下目标表已存在且不是平台建的。本任务每次运行都会把它们整表清空:")}</p>
              <ul>{tables.map((x) => <li key={x}><code>{x}</code></li>)}</ul>
              <p>{t("如不想清空,请取消后把写入模式改成「追加」,或换一个目标表名。")}</p>
            </div>
          ),
          onOk: async () => {
            const prev: string[] = Array.isArray(values.overwriteConfirmedTables) ? values.overwriteConfirmedTables : [];
            const r2 = await send({ ...values, overwriteConfirmedTables: Array.from(new Set([...prev, ...tables])) });
            const d2 = await r2.json();
            if (d2.success !== false) { clearSyncDraft(draftKey); onSuccess(); } else message.error(d2.error?.message || t("失败"));
          },
        });
        return;
      }
      if (data.success !== false) { clearSyncDraft(draftKey); onSuccess(); } else message.error(data.error?.message || t("失败"));
    } finally { setSaving(false); }
  };

  /** 校验到第 upTo 步(含)为止的必填项;「下一步」只校验当前步,「完成」校验前两步(后面几步都有默认值)。 */
  const validateUpTo = (upTo: number, only?: number) => {
    const v = form.getFieldsValue(true);
    const covers = (i: number) => (only === undefined ? i <= upTo : i === only);
    if (covers(0)) {
      if (!v.name) { message.warning(t("请输入任务名称")); return false; }
      if (!v.datasourceId) { message.warning(t("请选择数据源")); return false; }
      if (!v.syncMode) { message.warning(t("请选择同步模式")); return false; }
      if (!v.writeMode) { message.warning(t("请选择写入模式")); return false; }
      if (!v.targetType) { message.warning(t("请选择目标类型")); return false; }
    }
    if (covers(1) && selectedTables.length === 0 && templateTables.length === 0) { message.warning(t("请至少选择一张表")); return false; }
    return true;
  };
  const validateStep = () => validateUpTo(step, step);

  const STEPS = [{ title: t("源端配置") }, { title: t("选表 & 映射") }, { title: t("目标配置") }, { title: t("建表预览") }, { title: t("调度设置") }];
  // 有样例表(⇒ 有列)的模板,在字段映射(只读)/ 建表预览 / 派生列与合并键候选里与普通表一起列出;
  //   模板的目标名 = 固定目标名(resolveTargetTableName 读 targetTableNames[模板])
  const templatesWithColumns = templateTables.filter((x) => (fieldMappings[x] || []).length > 0);
  const previewTables = [...selectedTables, ...templatesWithColumns];
  const compatIcon = (c: string) => c === "compatible" ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> : <WarningOutlined style={{ color: c === "truncation" ? "#ff4d4f" : "#faad14" }} />;

  return (
    <Modal title={isEdit ? t("编辑同步任务") : t("新建同步任务")} open={open} width={900} onCancel={onClose} onOk={handleSubmit} confirmLoading={saving} okText={t("完成")}
      // UX ②:第一步只留「下一步」(用户 10-20 拍板);第 2 步起「完成」才出现(后面几步都有缺省,可直接完成)
      okButtonProps={{ "data-testid": "sync-wizard-finish", style: step === 0 ? { display: "none" } : undefined } as any}
      afterOpenChange={(o) => { if (o) { form.setFieldsValue(editing ? withRecordGlueVersion(editing) : SYNC_WIZARD_DEFAULTS); setStep(0); setTargetType(editing?.targetType || SYNC_WIZARD_DEFAULTS.targetType); setChannelRec(null); setDdlPreview({}); setCapabilityError(null); setPendingDraft(loadSyncDraft(editing?.taskId)); setTableFilter(""); setOnlySelected(false);
        // 带日期变量的表名与普通表分开回填(见 templateTables 的注释)
        const editTables = editing?.sourceTables || [];
        setSelectedTables(editTables.filter((x) => !x.includes("$" + "{"))); setTemplateTables(editTables.filter((x) => x.includes("$" + "{")));
        // 样例表随任务回填(拉表回来后 onDatasourceChange 按样例列重建模板的列映射)
        setTemplateSamples(editing?.templateSampleTables || {}); templateSamplesRef.current = editing?.templateSampleTables || {};
        // 编辑已有任务:若保存的 namespace 与源库名不同,说明用户曾自定义 → 手动模式;否则自动。新建默认自动。
        const editNs = (editing as any)?.s3Config?.namespace;
        const editDsDb = dataSources.find((d) => d.datasourceId === editing?.datasourceId)?.database;
        setNsMode(editing && editNs && editNs !== editDsDb ? "manual" : "auto");
      } else { form.resetFields(); setTables([]); setFieldMappings({}); setSelectedTables([]); setTemplateTables([]); setTemplateSamples({}); setCapabilityError(null); setNsMode("auto"); } }}>
      <Steps current={step} size="small" style={{ marginBottom: 24 }} items={STEPS} />
      {pendingDraft ? (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} data-testid="sync-draft-banner"
          message={t("发现上次未保存的配置({age}):{name}", { age: describeDraftAge(pendingDraft), name: String((pendingDraft.formValues as any)?.name || t("(未命名)")) })}
          action={<Space><Button size="small" type="primary" data-testid="sync-draft-restore" onClick={() => { void applyDraft(pendingDraft); }}>{t("恢复")}</Button><Button size="small" data-testid="sync-draft-discard" onClick={discardDraft}>{t("丢弃")}</Button></Space>} />
      ) : null}
      {capabilityError ? <Alert type="error" showIcon closable style={{ marginBottom: 16 }} message={capabilityError} data-testid="sync-capability-error" onClose={() => setCapabilityError(null)} /> : null}
      <Form form={form} layout="vertical" style={{ minHeight: 380 }} preserve onValuesChange={() => saveDraftNow()}>

        {/* ===== Step 0: 源端配置 ===== */}
        <div style={{ display: step === 0 ? undefined : "none" }}>
          <Form.Item name="name" label={t("任务名称")} rules={[{ required: true }]}><Input placeholder={t("例如：订单表同步到S3")} /></Form.Item>
          <Form.Item name="datasourceId" label={t("选择数据源")} rules={[{ required: true }]}>
            {/* 数据源下拉按范式渲染标识(JDBC=host/库;DDB=表名;S3=桶/前缀)。仅列可批同步(glue 通道)的源
                JDBC 四兄弟 + DynamoDB + S3;stream(kinesis/msk)走实时计算页 flink-cdc,不在批同步向导。 */}
            <Select onChange={(v) => { void onDatasourceChange(String(v), { userSwitched: true }); }} options={dataSources
              .filter((ds) => ds.type !== "kinesis" && ds.type !== "msk")
              .map((ds) => {
                const c = (ds as any).connection || {};
                const badge = ds.type === "dynamodb" ? `${c.tableName || "-"}`
                  : ds.type === "s3" ? `${c.bucket || "-"}/${c.prefix || ""}`
                  : `${ds.host?.split(".")[0] || "-"}/${ds.database || "-"}`;
                return {
                  // 🔴 标出这个源在哪个区:同步任务的执行落点
                  // 就是它,选的时候必须看得见(护栏 2)。无章的存量源如实显示主控区,不留空。
                  label: (
                    <Space>
                      {DS_TYPE_ICON[ds.type] || "🗄️"} {ds.name} <Tag>{badge}</Tag>
                      <Tag color={((ds as any).ownerTargetId || "tgt_home") === "tgt_home" ? "default" : "blue"} data-testid="sync-ds-region">
                        {regionLabelOf((ds as any).ownerTargetId)}
                      </Tag>
                      {ds.status === "active" && <Tag color="green">{t("已连接")}</Tag>}
                    </Space>
                  ),
                  value: ds.datasourceId,
                };
              })} />
          </Form.Item>
          <Space size={24}>
            <Form.Item name="syncMode" label={t("同步模式")} rules={[{ required: true }]}>
              <Select style={{ width: 200 }} onChange={() => fetchChannelRec()} options={[{ label: t("全量同步"), value: "full" }, { label: t("增量同步 (CDC)"), value: "incremental" }, { label: t("实时同步 (DMS CDC)"), value: "realtime" }]} />
            </Form.Item>
            <Form.Item name="writeMode" label={t("写入模式")} rules={[{ required: true }]}>
              <Select style={{ width: 200 }} options={[{ label: t("覆盖 (Overwrite)"), value: "overwrite" }, { label: t("追加 (Append)"), value: "append" }, { label: t("合并 (Merge)"), value: "merge" }]} />
            </Form.Item>
          </Space>
          <Form.Item name="targetType" label={t("目标类型")} rules={[{ required: true }]}>
            <Radio.Group onChange={(e) => { setTargetType(e.target.value); setTimeout(fetchChannelRec, 100); }}>
              <Radio.Button value="s3-tables">{t("S3 数据湖")}</Radio.Button>
              <Radio.Button value="redshift">Redshift</Radio.Button>
              <Radio.Button value="both">S3 + Redshift</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {channelRec && (
            <div style={{ background: "rgba(45, 212, 191, 0.1)", border: "1px solid rgba(45, 212, 191, 0.35)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontWeight: 500, marginBottom: 8 }}><ThunderboltOutlined /> {t("通道推荐")}</div>
              <Form.Item name="channel" noStyle><Radio.Group>
                {channelRec.options?.map((o: any) => (
                  <Radio key={o.channel} value={o.channel} disabled={!o.supported} style={{ display: "block", marginBottom: 4 }}>
                    <Space>{o.channel === "glue" ? "Glue ETL" : o.channel === "zero-etl" ? "Zero-ETL" : "DMS CDC"} {o.recommended && <Tag color="green">{t("推荐")}</Tag>} {!o.supported && <Tag color="red">{t("不支持")}</Tag>} <span style={{ fontSize: 12, color: "#888" }}>{o.reason}</span></Space>
                  </Radio>
                ))}
              </Radio.Group></Form.Item>
            </div>
          )}
          {/* 网络连通性智能顾问:同步任务(DMS/Glue)的计算需连源库 + 写目标(Redshift/S3),
              门槛在网络。选定数据源 + 通道后,顾问探测环境并裁决可达性 + 给修复建议(预检,不阻断)。 */}
          {watchDsId && watchChannel ? (() => {
            const ck: ComputeKind = watchChannel === "glue" ? "glue" : watchChannel === "zero-etl" ? "zeroetl" : "dms";
            const targets: Target[] = [{ kind: "datasource", datasourceId: watchDsId }];
            if (watchTargetType === "redshift" || watchTargetType === "both") {
              // 🔴 预检的数仓**绝不回落 home 的 workgroup**:那会在
              // 非 home 源上拿主控区的数仓去量网络,给出与真跑无关的结论。用户已选的优先;未选就取
              // **该源所在区**清单的第一个(同区的 workgroup 共享该 target 的 VPC/子网,量可达性等价);
              // 清单还没到就干脆不列这个目标(宁可少量一项,不量错一项)。
              const wg = watchRsWorkgroup || rsWorkgroups[0]?.workgroupName;
              if (wg) targets.push({ kind: "redshift", flavor: "serverless", identifier: wg });
            }
            if (watchTargetType === "s3-tables" || watchTargetType === "both") {
              targets.push({ kind: "aws-service", service: "s3" });
            }
            return (
              <NetworkAdvisorPanel
                targetIds={[landingOfScope(scope)]}
                request={{ computeKind: ck, targets, constraints: { preferPrivate: true, avoidNatCost: true } }}
                title={t("网络连通性预检（{engine}）", { engine: ck.toUpperCase() })}
              />
            );
          })() : null}
          <Form.Item name="whereClause" label={t("数据过滤条件 (WHERE)")}>
            <Input.TextArea rows={2} placeholder={"created_at >= '${run_date}' AND status = 'completed'"} />
          </Form.Item>
          {/* 可用变量取自 SYNC_RUN_VAR_NAMES + 按今天渲染预览 + 方言说明 */}
          <WhereClauseHelp form={form} />
          <BusinessTimezoneField form={form} />
          <Form.Item noStyle shouldUpdate>
            {() => form.getFieldValue("syncMode") === "incremental" ? (
              <div>
                <Divider>{t("增量配置")}</Divider>
                <Form.Item name={["incrementalConfig", "strategy"]} label={t("增量策略")} initialValue="timestamp">
                  <Radio.Group><Radio.Button value="timestamp">{t("时间戳")}</Radio.Button><Radio.Button value="id">{t("自增ID")}</Radio.Button><Radio.Button value="cdc">CDC</Radio.Button></Radio.Group>
                </Form.Item>
                <Space size={16}>
                  <Form.Item name={["incrementalConfig", "field"]} label={t("增量字段")}><Input placeholder="updated_at" style={{ width: 200 }} /></Form.Item>
                  <Form.Item name={["incrementalConfig", "startValue"]} label={t("起始值")}><Input placeholder="2026-01-01 00:00:00" style={{ width: 220 }} /></Form.Item>
                </Space>
                {isEdit && (
                  <Form.Item label={t("当前水位 (incrementalValue)")} tooltip={t("增量同步每次只读「增量字段 > 当前水位」的行;成功后自动前进到本次最大值。落库为幂等先删后写,重跑不会重复。需要重新全量回填可清空或填 0。")}>
                    <Space>
                      <Form.Item name="incrementalValue" noStyle><Input placeholder={t("(尚未运行)")} style={{ width: 220 }} /></Form.Item>
                      <Button size="small" onClick={() => form.setFieldValue("incrementalValue", "0")}>{t("重置为 0(重新回填)")}</Button>
                    </Space>
                  </Form.Item>
                )}
              </div>
            ) : null}
          </Form.Item>
        </div>

        {/* ===== Step 1: 选表 & 映射 ===== */}
        <div style={{ display: step === 1 ? undefined : "none" }}>
          <Divider>{t("选择同步表")}</Divider>
          {tables.length > 0 ? (() => {
            // (用户 2026-10-15:「选表最好是筛选确认,而不是全量展示,否则要不断向下拉,影响 column 的映射关系确认」)
            //   搜索框按表名子串(不分大小写)筛;「只看已选」只列勾过的;计数行一直显示「已选 n / 共 m」。
            //   🔴 不用 Checkbox.Group:它在 onChange 时会把**没渲染出来**的已选值滤掉(筛掉一半表再勾一个 = 其余已选全丢),所以逐个 Checkbox 自己维护。
            const kw = tableFilter.trim().toLowerCase();
            const shown = tables.filter((tbl) => (!kw || String(tbl.name).toLowerCase().includes(kw)) && (!onlySelected || selectedTables.includes(tbl.name)));
            const toggle = (name: string, on: boolean) => setSelectedTables((prev) => (on ? (prev.includes(name) ? prev : [...prev, name]) : prev.filter((x) => x !== name)));
            return (
              <div data-testid="sync-table-picker">
                <Space wrap style={{ marginBottom: 8 }}>
                  <Input allowClear placeholder={t("搜索表名")} value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} style={{ width: 240 }} data-testid="sync-table-filter" />
                  <Checkbox checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} data-testid="sync-table-only-selected">{t("只看已选")}</Checkbox>
                  <Button size="small" disabled={shown.length === 0} onClick={() => setSelectedTables((prev) => Array.from(new Set([...prev, ...shown.map((x) => String(x.name))])))} data-testid="sync-table-select-shown">{t("全选筛出的 {n} 张", { n: String(shown.length) })}</Button>
                  <Button size="small" disabled={selectedTables.length === 0} onClick={() => setSelectedTables([])} data-testid="sync-table-clear">{t("清空已选")}</Button>
                  <Tag color={selectedTables.length ? "cyan" : "default"} data-testid="sync-table-count">{t("已选 {n} / 共 {m}", { n: String(selectedTables.length), m: String(tables.length) })}</Tag>
                </Space>
                <div style={{ maxHeight: 320, overflowY: "auto" }}>
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {shown.map((tbl) => {
                      // 守卫 1:勾选了某个模板按日期渲染出来的实例表(orders_202609 之于 orders_${bizmonth})⇒ 黄标 + 提示
                      //   勾了就会把它当普通表多同步一份,并与模板写同一张目标表(客户 2026-10-27 撞到的正是这个)
                      const instanceOfTpl = selectedTables.includes(tbl.name) ? templateInstanceOf(String(tbl.name), templateTables) : null;
                      return (
                      <div key={tbl.name} data-testid="sync-table-row" data-table={tbl.name} style={{ padding: "8px 12px", border: "1px solid #1d4254", borderRadius: 6, background: selectedTables.includes(tbl.name) ? "rgba(34, 211, 238, 0.14)" : "transparent" }}>
                        <Checkbox checked={selectedTables.includes(tbl.name)} onChange={(e) => toggle(String(tbl.name), e.target.checked)}><Space><b>{tbl.name}</b><Tag>{tbl.columns?.length || 0} {t("字段")}</Tag>{instanceOfTpl ? <Tag color="warning" data-testid="sync-table-template-instance" data-template={instanceOfTpl}>{t("模板实例")}</Tag> : null}</Space></Checkbox>
                        {instanceOfTpl ? (
                          <div style={{ fontSize: 12, color: "#faad14", marginTop: 4 }} data-testid="sync-table-template-instance-hint">
                            {t("这张表是「{tpl}」按日期渲染出来的一张实例表:勾选它 = 把它当普通表再同步一份,并与模板写同一张目标表(覆盖模式下互相覆盖)。只想借它的列结构,请在下方把它设为该模板的样例表,再取消这里的勾选。", { tpl: instanceOfTpl })}
                          </div>
                        ) : null}
                      </div>
                      );
                    })}
                    {shown.length === 0 ? <Alert type="info" showIcon message={onlySelected ? t("还没有勾选任何表") : t("没有匹配「{kw}」的表", { kw: tableFilter })} /> : null}
                  </Space>
                </div>
              </div>
            );
          })() : <Alert type="info" message={t("请先在上一步选择数据源")} />}
          {/* 带日期变量的源表名(加进 sourceTables + 固定目标表名进 targetTableNames) */}
          {/* 样例表候选 = 源库表清单;添加 / 改样例把样例列映射复制给模板 */}
          <TemplateTablesEditor form={form} templateTables={templateTables} setTemplateTables={setTemplateTables}
            sourceTableNames={tables.map((x) => String(x.name))} templateSamples={templateSamples} setTemplateSamples={setTemplateSamples}
            fieldMappings={fieldMappings} setFieldMappings={setFieldMappings} />
          {(selectedTables.length > 0 || templatesWithColumns.length > 0) && (() => {
            // 同一组列定义两种用法:普通表可改(同步开关 / 目标字段名);模板只读(列结构来自样例表,运行时按业务日期读对应那张表)
            const mappingColumns = (tableName: string, readOnly: boolean) => [
              { title: t("同步"), dataIndex: "include", width: 50, render: (_: any, r: any, i: number) => <Switch size="small" disabled={readOnly} checked={r.include} onChange={(v) => { const m = { ...fieldMappings }; m[tableName] = [...m[tableName]]; m[tableName][i] = { ...m[tableName][i], include: v }; setFieldMappings(m); }} /> },
              { title: t("源字段"), dataIndex: "source", render: (v: string) => <code>{v}</code> },
              { title: t("源类型"), dataIndex: "sourceType", render: (v: string) => <Tag>{v}</Tag> },
              { title: "", width: 30, render: () => "→" },
              { title: t("目标类型"), dataIndex: "targetType", render: (v: string, r: any) => <Space>{compatIcon(r.compatibility)}<Tag color={r.compatibility === "compatible" ? "green" : "orange"}>{v}</Tag></Space> },
              { title: t("目标字段"), dataIndex: "target", render: (_: any, r: any, i: number) => <Input size="small" disabled={readOnly} value={r.target} onChange={(e) => { const m = { ...fieldMappings }; m[tableName] = [...m[tableName]]; m[tableName][i] = { ...m[tableName][i], target: e.target.value }; setFieldMappings(m); }} /> },
            ];
            return (
            <div>
              <Divider><SwapOutlined /> {t("字段映射")}</Divider>
              {selectedTables.map((tableName) => (
                <div key={tableName} style={{ marginBottom: 16 }}>
                  <h4>📋 {tableName}</h4>
                  <Table size="small" pagination={false} dataSource={fieldMappings[tableName]?.map((f, i) => ({ ...f, key: i }))} columns={mappingColumns(tableName, false)} />
                </div>
              ))}
              {templatesWithColumns.map((tpl) => (
                <div key={tpl} style={{ marginBottom: 16 }} data-testid="sync-template-mapping" data-template={tpl} data-sample={templateSamples[tpl] || ""}>
                  <h4>📋 {tpl} <Tag color="blue">{t("样例表:{s}", { s: templateSamples[tpl] || "" })}</Tag> <span style={{ fontSize: 12, color: "#888", fontWeight: 400 }}>{t("列结构来自样例表,只读;运行时按业务日期读对应那张表")}</span></h4>
                  <Table size="small" pagination={false} dataSource={fieldMappings[tpl]?.map((f, i) => ({ ...f, key: i }))} columns={mappingColumns(tpl, true)} />
                </div>
              ))}
            </div>
            );
          })()}
        </div>

        {/* ===== Step 2: 目标配置 ===== */}
        <div style={{ display: step === 2 ? undefined : "none" }}>
          {/* SYNC-07: target table naming */}
          <Divider>{t("目标表命名 (SYNC-07)")}</Divider>
          <Space size={16}>
            <Form.Item name="targetTablePrefix" label={t("表名前缀")} tooltip={t("应用到所有目标表，默认与源表同名")}>
              <Input placeholder={t("如 ods_")} style={{ width: 180 }} allowClear />
            </Form.Item>
            <Form.Item name="targetTableSuffix" label={t("表名后缀")}>
              <Input placeholder={t("如 _v2")} style={{ width: 180 }} allowClear />
            </Form.Item>
          </Space>
          {selectedTables.length > 0 && (
            <Form.Item noStyle shouldUpdate>
              {() => {
                const prefix = form.getFieldValue("targetTablePrefix") || "";
                const suffix = form.getFieldValue("targetTableSuffix") || "";
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>{t("每张表的目标名（留空则使用 前缀+源表名+后缀）：")}</div>
                    {selectedTables.map((src) => (
                      <Space key={src} style={{ marginBottom: 6 }}>
                        <code>{src}</code> →
                        <Form.Item name={["targetTableNames", src]} noStyle>
                          <Input size="small" style={{ width: 240 }} placeholder={`${prefix}${src}${suffix}`} allowClear />
                        </Form.Item>
                      </Space>
                    ))}
                  </div>
                );
              }}
            </Form.Item>
          )}
          {(targetType === "s3-tables" || targetType === "both") && (
            <div>
              <Divider>{t("S3 Tables 数据湖配置")}</Divider>
              <Space size={16}>
                {/* 🔴 **不设 initialValue**:落点的唯一作者在服务端
                    (按任务所在章的描述符解析)。留空 = 自动解析;填了与该章不一致的值会被 409 拒,
                    不静默取一个。曾用「initialValue 填 home 桶 + 选非 home 源时清空」,但本区块是选完
                    targetType 才挂载 ⇒ 挂载时 initialValue 后手把 home 桶名填回去(红)。*/}
                <Form.Item
                  name={["s3Config", "tableBucket"]}
                  label="Table Bucket"
                  extra={t("留空 = 按该数据源所在执行环境的表桶自动解析(推荐);选客户自有表桶时,非主控区的执行环境须先在「系统设置 → 数据湖外部表桶」登记该桶")}
                >
                  {/* (客户待改进项):原来只能手填表桶名 ⇒ 改为下拉(可仍手填),清单 = 该源所在执行环境那个区账号内的
                      S3 Tables 表桶,平台表桶 / 已登记外部表桶带标;仍不设 initialValue,留空照旧由服务端解析。
                      writeIntent ⇒ 未登记的桶带「未登记」标,选中后出提示 + 去登记链接(保存会被 400 指路,不等到启动才 409)*/}
                  <TableBucketPicker targetId={watchDsOwnerTarget} style={{ width: 250 }} placeholder={t("留空自动解析")} writeIntent data-testid="sync-s3t-bucket-picker" />
                </Form.Item>
                <Form.Item label="Namespace" tooltip={t("自动=跟随所选数据源库名；手动=自定义")} style={{ marginBottom: 0 }}>
                  <Space direction="vertical" size={4}>
                    <Radio.Group size="small" value={nsMode} onChange={(e) => {
                      const mode = e.target.value as "auto" | "manual";
                      setNsMode(mode);
                      // 切回自动:立即用当前数据源库名覆盖,保证与「自动」语义一致。
                      if (mode === "auto") {
                        const ds = dataSources.find((d) => d.datasourceId === form.getFieldValue("datasourceId"));
                        form.setFieldValue(["s3Config", "namespace"], ds?.database || "");
                      }
                    }}>
                      <Radio.Button value="auto">{t("自动跟随库名")}</Radio.Button>
                      <Radio.Button value="manual">{t("手动指定")}</Radio.Button>
                    </Radio.Group>
                    <Form.Item name={["s3Config", "namespace"]} noStyle>
                      <Input placeholder={t("默认=数据源库名")} style={{ width: 200 }} disabled={nsMode === "auto"} />
                    </Form.Item>
                  </Space>
                </Form.Item>
              </Space>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
                💡 {t("S3 Tables 是 AWS 托管的 Iceberg 表服务，自动管理快照、压缩、合并。数据通过 Glue Catalog 的 s3tablescatalog 访问。")}
              </div>
              <Form.Item name={["s3Config", "format"]} label={t("文件格式")} initialValue="parquet">
                <Select style={{ width: 200 }} options={[{ label: t("Parquet (推荐)"), value: "parquet" }, { label: "ORC", value: "orc" }, { label: "CSV", value: "csv" }]} />
              </Form.Item>
              <Form.List name={["s3Config", "partitionFields"]}>
                {(fields, { add, remove }) => (
                  <div>
                    <label style={{ fontWeight: 500 }}><InfoCircleOutlined /> {t("分区配置")}</label>
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: "flex", marginBottom: 8 }}>
                        <Form.Item name={[name, "field"]} noStyle><Input placeholder={t("字段名")} style={{ width: 180 }} /></Form.Item>
                        <Form.Item name={[name, "type"]} noStyle><Select style={{ width: 160 }} placeholder={t("分区类型")} options={[{ label: t("📅 日期"), value: "date" }, { label: t("🔤 字符串"), value: "string" }]} /></Form.Item>
                        <MinusCircleOutlined onClick={() => remove(name)} />
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>{t("添加分区字段")}</Button>
                  </div>
                )}
              </Form.List>
              <Divider>{t("Iceberg 表参数")}</Divider>
              <Form.Item name={["s3Config", "format"]} label={t("存储格式")} initialValue="iceberg">
                <Select style={{ width: 200 }} disabled options={[{ label: t("Iceberg (S3 Tables 托管)"), value: "iceberg" }]} />
              </Form.Item>
              <Space size={16}>
                <Form.Item name={["s3Config", "icebergConfig", "snapshotRetentionDays"]} label={t("快照保留天数")} initialValue={7}>
                  <InputNumber min={1} max={365} style={{ width: 120 }} />
                </Form.Item>
                <Form.Item name={["s3Config", "icebergConfig", "maxSnapshots"]} label={t("最大快照数")} initialValue={100}>
                  <InputNumber min={1} max={1000} style={{ width: 120 }} />
                </Form.Item>
                <Form.Item name={["s3Config", "icebergConfig", "compactionMinutes"]} label={t("自动合并间隔(分钟)")} initialValue={60}>
                  <InputNumber min={5} max={1440} style={{ width: 140 }} />
                </Form.Item>
              </Space>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>
                💡 {t("Iceberg 表支持 ACID 事务、Schema 演进、时间旅行查询。数据自动注册到 Glue Data Catalog，可通过 Athena/Redshift Spectrum 直接查询。")}
              </div>
            </div>
          )}
          {(targetType === "redshift" || targetType === "both") && (
            <div>
              <Divider>{t("Redshift 配置")}</Divider>
              <Space size={16}>
                {/* 下拉列**该源所在区**的 workgroup(onDatasourceChange
                    已按 ownerTargetId 重拉);空态**不回落 home 的名字**,也不设 initialValue
                    (留空 = 服务端按该章解析,同 Table Bucket);databases 带 targetId 查该区。 */}
                <Form.Item name={["redshiftConfig", "workgroupName"]} label="Workgroup" extra={t("留空 = 按执行环境自动解析")}>
                  <Select style={{ width: 200 }} allowClear placeholder={t("留空自动解析")} onChange={(v) => { if (!v) { setRsDatabases([]); return; } fetch(`/api/redshift/databases?workgroup=${encodeURIComponent(v)}&targetId=${encodeURIComponent(watchDsOwnerTarget)}`).then((r) => r.json()).then((d) => setRsDatabases(Array.isArray(d) ? d.map((x: any) => x.name || x) : [])); }} options={rsWorkgroups.map((w) => ({ label: w.workgroupName, value: w.workgroupName }))} />
                </Form.Item>
                {/* 同上:database 也不预填(home 的 `dev` 在别区可能压根不存在,填错即 409)。 */}
                <Form.Item name={["redshiftConfig", "database"]} label="Database" extra={t("留空 = 按执行环境自动解析")}><Select style={{ width: 150 }} allowClear placeholder={t("留空自动解析")} options={rsDatabases.map((d) => ({ label: d, value: d }))} /></Form.Item>
                <Form.Item name={["redshiftConfig", "schema"]} label="Schema" initialValue="public"><Input style={{ width: 120 }} /></Form.Item>
              </Space>
              <Space size={16}>
                <Form.Item name={["redshiftConfig", "distStyle"]} label={t("分布策略")} initialValue="auto"><Select style={{ width: 150 }} options={[{ label: "AUTO", value: "auto" }, { label: "KEY", value: "key" }, { label: "EVEN", value: "even" }]} /></Form.Item>
                <Form.Item name={["redshiftConfig", "distKey"]} label="DISTKEY"><Input placeholder={t("主键")} style={{ width: 150 }} /></Form.Item>
                <Form.Item name={["redshiftConfig", "sortKeys"]} label="SORTKEY"><Input placeholder="col1,col2" style={{ width: 200 }} /></Form.Item>
              </Space>
            </div>
          )}
          {/* 派生列 / 覆盖范围 / 空结果开关 */}
          <WriteOptionsSection form={form} targetType={targetType} sourceColumns={Array.from(new Set(previewTables.flatMap((tb) => (fieldMappings[tb] || []).map((f: any) => String(f.source)))))} />
        </div>

        {/* ===== Step 3: 建表预览 ===== */}
        <div style={{ display: step === 3 ? undefined : "none" }}>
          {(targetType === "redshift" || targetType === "both") ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ color: "#666" }}>{t("预览建表 DDL")}</span>
                <Button size="small" onClick={() => previewTables.forEach(fetchDDL)}>{t("生成 DDL")}</Button>
              </div>
              {previewTables.map((tableName) => (
                <div key={tableName} style={{ marginBottom: 16, border: "1px solid #1d4254", borderRadius: 8, padding: 12 }}>
                  <Space style={{ marginBottom: 8 }}><b>{tableName}</b>{(() => {
                    const p = ddlPreview[tableName];
                    if (!p) return null;
                    if (p.exists === null) return <Tag color="default" data-testid="ddl-table-state" data-state="unknown">{t("无法确认表是否已存在")}</Tag>;
                    if (!p.exists) return <Tag color="blue" data-testid="ddl-table-state" data-state="new">{t("新建")}</Tag>;
                    return p.platformCreated
                      ? <Tag color="orange" data-testid="ddl-table-state" data-state="platform">{t("表已存在(平台建)")}</Tag>
                      : <Tag color="red" data-testid="ddl-table-state" data-state="foreign">{t("表已存在(不是平台建的,覆盖写入需确认)")}</Tag>;
                  })()}</Space>
                  <pre style={{ background: "#1e1e1e", color: "#d4d4d4", padding: 12, borderRadius: 6, fontSize: 12, maxHeight: 200, overflow: "auto" }}>{ddlPreview[tableName]?.ddl || t("点击\"生成 DDL\"按钮")}</pre>
                  <Space style={{ marginTop: 8 }}>
                    <Button size="small" type="primary" onClick={() => executeDDL(tableName)}>{t("执行建表")}</Button>
                    <Button size="small" onClick={() => fetchDDL(tableName)}>{t("刷新")}</Button>
                  </Space>
                </div>
              ))}
            </div>
          ) : <Alert type="info" message={t("S3 目标无需建表，Parquet 文件自动创建")} />}
        </div>

        {/* ===== Step 4: 调度设置 ===== */}
        <div style={{ display: step === 4 ? undefined : "none" }}>
          {/* 参数智能顾问:按通道(glue→glue-sync / dms)与表数/模式推荐 重试/超时/Iceberg/Redshift 表设计,
              一键预填回同一个 Form(跨 step 字段 display:none 不卸载,setFieldsValue 全量生效)。 */}
          {watchChannel === "glue" || watchChannel === "dms" ? (
            <ParamAdvisorPanel
              request={{
                channel: watchChannel === "glue" ? "glue-sync" : "dms",
                workload: {
                  tableCount: (selectedTables.length + templateTables.length) || undefined,
                  syncMode: form.getFieldValue("syncMode"),
                  targetType: watchTargetType,
                },
                current: {
                  retryCount: form.getFieldValue("retryCount"),
                  timeout: form.getFieldValue("timeout"),
                  s3Config: form.getFieldValue("s3Config"),
                  redshiftConfig: form.getFieldValue("redshiftConfig"),
                  glueConfig: form.getFieldValue("glueConfig"),
                  dmsSettings: form.getFieldValue("dmsSettings"),
                },
              }}
              onPrefill={(p) => {
                if (p.channel === "glue-sync") {
                  form.setFieldsValue({
                    retryCount: p.retryCount,
                    timeout: p.timeout,
                    ...(p.glueConfig ? { glueConfig: { ...(form.getFieldValue("glueConfig") || {}), ...p.glueConfig } } : {}),
                    ...(p.icebergConfig ? { s3Config: { ...(form.getFieldValue("s3Config") || {}), icebergConfig: p.icebergConfig } } : {}),
                    ...(p.redshiftConfig ? { redshiftConfig: { ...(form.getFieldValue("redshiftConfig") || {}), ...p.redshiftConfig } } : {}),
                  });
                } else if (p.channel === "dms") {
                  form.setFieldsValue({
                    retryCount: p.retryCount,
                    timeout: p.timeout,
                    ...(p.dmsSettings ? { dmsSettings: { ...(form.getFieldValue("dmsSettings") || {}), ...p.dmsSettings } } : {}),
                    ...(p.redshiftConfig ? { redshiftConfig: { ...(form.getFieldValue("redshiftConfig") || {}), ...p.redshiftConfig } } : {}),
                  });
                }
              }}
              title={t("同步参数智能顾问（{engine}）", { engine: watchChannel === "glue" ? "Glue" : "DMS" })}
            />
          ) : null}
          {/* DMS 通道任务设置(对齐 DMS console 创建任务页 Task settings,参数齐全暴露;不填用 AWS 默认)。 */}
          {watchChannel === "dms" ? (
            <div>
              <Divider>{t("DMS 任务设置")}</Divider>
              <Space size={16} wrap>
                <Form.Item name={["dmsSettings", "targetTablePrepMode"]} label={t("目标表准备模式")} initialValue="DO_NOTHING"
                  tooltip={t("DROP_AND_CREATE=每次重建表;TRUNCATE=清空保结构;DO_NOTHING=保留已有数据(平台已预建 schema,推荐默认)")}>
                  <Select style={{ width: 210 }} options={[
                    { label: t("DO_NOTHING(保留数据)"), value: "DO_NOTHING" },
                    { label: t("DROP_AND_CREATE(重建)"), value: "DROP_AND_CREATE" },
                    { label: t("TRUNCATE(清空保结构)"), value: "TRUNCATE_BEFORE_LOAD" },
                  ]} />
                </Form.Item>
                <Form.Item name={["dmsSettings", "lobMode"]} label={t("LOB 列模式")} initialValue="limited"
                  tooltip={t("源表含 TEXT/BLOB 大字段时:limited=按上限截断(快,推荐);full=完整迁移(慢);none=跳过 LOB 列")}>
                  <Select style={{ width: 170 }} options={[
                    { label: t("limited(截断,推荐)"), value: "limited" },
                    { label: t("full(完整,较慢)"), value: "full" },
                    { label: t("none(跳过 LOB)"), value: "none" },
                  ]} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate>
                  {() => form.getFieldValue(["dmsSettings", "lobMode"]) !== "none" && form.getFieldValue(["dmsSettings", "lobMode"]) !== "full" ? (
                    <Form.Item name={["dmsSettings", "lobMaxSizeKB"]} label={t("LOB 上限(KB)")} initialValue={32}
                      tooltip={t("Redshift 目标引擎上限 63KB(AWS 校验)")}>
                      <InputNumber min={1} max={63} style={{ width: 110 }} />
                    </Form.Item>
                  ) : null}
                </Form.Item>
              </Space>
              <Space size={16} wrap>
                <Form.Item name={["dmsSettings", "batchApplyEnabled"]} label={t("CDC 批量应用")} valuePropName="checked" initialValue={false}
                  tooltip={t("合并小事务批量写目标,高吞吐 CDC 提速明显;事务顺序敏感场景保持关闭")}>
                  <Switch />
                </Form.Item>
                <Form.Item name={["dmsSettings", "validationEnabled"]} label={t("数据校验")} valuePropName="checked" initialValue={false}
                  tooltip={t("迁移后逐行比对源/目标数据一致性;增加源库与复制实例负载,生产核对时开启")}>
                  <Switch />
                </Form.Item>
                <Form.Item name={["dmsSettings", "fullLoadMaxSubTasks"]} label={t("全量并行子任务")} initialValue={8} tooltip={t("全量装载并行度(1~49);表多可调大,源库压力大调小")}>
                  <InputNumber min={1} max={49} style={{ width: 90 }} />
                </Form.Item>
                <Form.Item name={["dmsSettings", "commitRate"]} label={t("每批提交行数")} initialValue={10000}>
                  <InputNumber min={1} max={50000} style={{ width: 110 }} />
                </Form.Item>
              </Space>
            </div>
          ) : null}
          {/* Glue 通道作业资源(对齐 Glue console 创建页,参数齐全暴露;此前写死 G.1X/2/5.1)。 */}
          {watchChannel === "glue" ? (
            <div>
              <Divider>{t("Glue 作业资源")}</Divider>
              <Space size={16} wrap>
                <Form.Item name={["glueConfig", "workerType"]} label={t("Worker 类型")} initialValue="G.1X">
                  <Select style={{ width: 200 }} options={GLUE_WORKER_TYPES} />
                </Form.Item>
                <Form.Item name={["glueConfig", "numberOfWorkers"]} label={t("Worker 数量")} initialValue={2}>
                  <InputNumber min={2} max={GLUE_MAX_WORKERS} style={{ width: 100 }} />
                </Form.Item>
                {/* 写 S3 Tables 时 5.1 以下**禁选**(选了后端也会 400;原来三个版本随便选,5.0 跑到写表才报 Invalid S3 URI)。
                    缺省 = 清单最高版本,用户可自己选更低的;文案带 Spark / Python 版本让人知道选的是什么(单一作者 lib/sync/glue-version.ts)*/}
                <Form.Item name={["glueConfig", "glueVersion"]} label={t("Glue 版本")} initialValue={GLUE_VERSION_DEFAULT}
                  extra={(targetType === "s3-tables" || targetType === "both") ? t("写 S3 Tables 需要 Glue {v} 及以上", { v: S3_TABLES_MIN_GLUE_VERSION }) : undefined}>
                  <Select style={{ width: 250 }} data-testid="sync-glue-version"
                    options={GLUE_VERSIONS.map((x) => ({
                      label: glueVersionLabel(x), value: x,
                      disabled: (targetType === "s3-tables" || targetType === "both") && !glueVersionSupportsS3Tables(x),
                    }))} />
                </Form.Item>
                <Form.Item name={["glueConfig", "timeoutMinutes"]} label={t("作业超时(分钟)")} initialValue={60}>
                  <InputNumber min={5} max={2880} style={{ width: 110 }} />
                </Form.Item>
                <Form.Item name={["glueConfig", "maxRetries"]} label={t("失败重试")} initialValue={0} tooltip={t("Glue 作业级自动重试(区别于下方调度级重试:这里是单次运行失败 Glue 原地重跑)")}>
                  <InputNumber min={0} max={10} style={{ width: 90 }} />
                </Form.Item>
              </Space>
            </div>
          ) : null}
          {/* 执行角色(Glue/DMS 通道):同步作业的执行角色,常规做法在任务级暴露。留空=平台默认角色。
              注:Glue 作业接入 VPC 是经「Glue 连接」(数据源级配置,AWS 硬约束),不在任务级配 subnet/SG;
              网络连通性由上方顾问诊断,不通时按建议到「数据源」的 Glue 连接处调整。 */}
          {watchChannel === "glue" || watchChannel === "dms" ? (
            <div>
              <Divider>{t("执行角色")}</Divider>
              {watchChannel === "glue" ? (
                /* Glue 通道 = 账号内任何 glue.amazonaws.com 可承担的角色都能选(落点 = 源所在章);值仍是 glueConfig.executionRoleArn,空 = 平台默认 */
                <Form.Item name={["glueConfig", "executionRoleArn"]} label={t("执行角色")}
                  tooltip={t("执行角色决定同步作业能访问哪些 AWS 资源。留空=用平台默认角色;自建角色须信任 glue.amazonaws.com。")}>
                  <ExecutionRolePicker
                    engine="glue"
                    targetId={watchDsOwnerTarget}
                    isAdmin={isAdmin}
                    advisorRequest={{ engine: "glue", resources: { needsS3Tables: watchTargetType === "s3-tables" || watchTargetType === "both", needsRedshift: watchTargetType === "redshift" || watchTargetType === "both", needsGlueCatalog: true, needsCloudWatchLogs: true } }}
                  />
                </Form.Item>
              ) : (
              <Form.Item name={["glueConfig", "executionRoleArn"]} label={t("执行角色 ARN")}
                tooltip={t("执行角色决定同步作业能访问哪些 AWS 资源。留空=用平台默认角色;生产建议按最小权限自建角色并填其 ARN。")}>
                <Input allowClear placeholder={t("留空=平台默认;或 arn:aws:iam::<账号>:role/<角色名>")} />
              </Form.Item>
              )}
              {/* 角色顾问(DMS 通道;Glue 通道的顾问已在选择器内):推荐最小权限策略 / 一键创建 / 复制自建。 */}
              {watchChannel === "dms" ? <RoleAdvisorPanel
                request={{ engine: watchChannel === "dms" ? "dms" : "glue", resources: { needsS3Tables: watchTargetType === "s3-tables" || watchTargetType === "both", needsRedshift: watchTargetType === "redshift" || watchTargetType === "both", needsGlueCatalog: true, needsCloudWatchLogs: true } }}
                isAdmin={isAdmin}
                onFilled={(arn) => form.setFieldValue(["glueConfig", "executionRoleArn"], arn)}
              /> : null}
              <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
                {t("网络接入(VPC/子网/安全组)由「数据源」的 Glue 连接决定;请到「数据源管理 → 网络配置」调整。")}
              </div>
            </div>
          ) : null}
          <Form.Item name="scheduleEnabled" label={t("启用调度")} valuePropName="checked"><Switch /></Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => form.getFieldValue("scheduleEnabled") ? (
              <div>
                <Form.Item name="cronExpression" label={t("Cron 表达式")}>
                  <Input placeholder="0 2 * * *" addonAfter={<Select style={{ width: 130 }} placeholder={t("快捷")} onChange={(v) => form.setFieldValue("cronExpression", v)} options={[{ label: t("每小时"), value: "0 * * * *" }, { label: t("每天2点"), value: "0 2 * * *" }, { label: t("每6小时"), value: "0 */6 * * *" }]} />} />
                </Form.Item>
                <Space size={24}>
                  <Form.Item name="retryCount" label={t("失败重试")} initialValue={2}><InputNumber min={0} max={5} /></Form.Item>
                  <Form.Item name="timeout" label={t("超时(秒)")} initialValue={3600}><InputNumber min={60} max={86400} /></Form.Item>
                </Space>
              </div>
            ) : null}
          </Form.Item>
          <Divider>{t("依赖调度 (SCH-03)")}</Divider>
          <Form.Item name="triggers" label={t("下游依赖")} tooltip={t("本任务运行成功后，自动触发选中的下游同步任务 / 工作流")}>
            <Select
              mode="multiple"
              allowClear
              placeholder={t("选择运行成功后要触发的下游任务 / 工作流")}
              options={depOptions}
              optionFilterProp="label"
            />
          </Form.Item>
        </div>
      </Form>

      <div style={{ textAlign: "right", marginTop: 12, borderTop: "1px solid #1d4254", paddingTop: 12 }}>
        {step > 0 && <Button onClick={() => setStep(step - 1)} style={{ marginRight: 8 }}>{t("上一步")}</Button>}
        {step < STEPS.length - 1 && <Button type="primary" onClick={() => { if (validateStep()) setStep(step + 1); }}>{t("下一步")}</Button>}
      </div>
    </Modal>
  );
}
