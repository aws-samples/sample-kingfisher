"use client";
// 序 41 B-117 —— 页面删除读响应的唯一作者:失败呈现服务端原话,成功才提示「已删除」
import { deleteJson } from "@/lib/http/delete-json";

import { fetchExecTargets } from "@/lib/exec-env/exec-targets-client";
// @kf-batch 50-WP2-directquery —— 顶栏「执行范围」= 本页执行目标的**默认值**(INTERACTION §9.4「默认范围跟随视角」)。
// 🔴 为什么必须跟随:页面在能力矩阵里声明了 `scopeWired: true`(= 已按执行范围过滤),
//    若顶栏切了区而编辑器仍打在原来的区,那句声明就是假的 —— 门禁 `scope-wired-guard` 正是为此存在。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import React, { useState, useRef, useEffect } from "react";
import { Button, Space, Table, Alert, Spin, Select, Tabs, message, Input, Popconfirm, Card, Descriptions, Tag, Tree, Divider, Modal } from "antd";
import { PlayCircleOutlined, ClearOutlined, SaveOutlined, DeleteOutlined, DatabaseOutlined, ReloadOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-P50.1-workgroup-ssot
// 前端默认值也收编到命名 SSOT(与改动前**同值**,零行为变化)。
// 🔴 P50.3 待办:这里应改成"取当前执行目标的 workgroup"(env 覆盖与 per-target 实名都在服务端,
//    客户端拿不到)—— 届时改这一个 import 的用法即可,不必再回来找字面量。
// @kf-batch 50-P50.3-mrquery —— 多 region 结果:一个 region 一个 sheet(INTERACTION §4septies)。
import MultiRegionResults, { type Submission } from "@/components/redshift/MultiRegionResults";
// @kf-batch 50-W5-seg2-WP10a —— 免责告知弹窗(409 驱动,同意后重试)+ 留区 SQL 原文按需读回
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";

/** home target 常量(与服务端 `HOME_TARGET_ID` 同值;前端不 import 服务端模块)。 */
const HOME_TARGET = "tgt_home";
/** 一次点击最多打几个区(与服务端 `MAX_QUERY_FANOUT` 同值;服务端仍会再判一次)。 */
const MAX_FANOUT = 8;

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// 序 43 nit:原第一项是占位选项「选择模板...」(value 空,选了无动作)—— Select 自带 placeholder,去掉
const SQL_TEMPLATES = [
  { label: "CREATE TABLE AS", value: "CREATE TABLE new_table AS\nSELECT * FROM source_table\nWHERE 1=1;" },
  { label: "MERGE (Upsert)", value: "MERGE INTO target USING source ON target.id = source.id\nWHEN MATCHED THEN UPDATE SET target.col = source.col\nWHEN NOT MATCHED THEN INSERT VALUES (source.id, source.col);" },
  { label: "UNLOAD to S3", value: "UNLOAD ('SELECT * FROM my_table')\nTO 's3://my-bucket/prefix/'\nIAM_ROLE default\nPARQUET;" },
  { label: "查看表结构", value: "SELECT column_name, data_type, is_nullable\nFROM information_schema.columns\nWHERE table_schema = 'public' AND table_name = 'your_table'\nORDER BY ordinal_position;" },
];

export default function RedshiftPage() {
  const t = useT();
  const { scope } = useScope();
  // @kf-batch 50-W5-seg2-WP10a —— 免责告知弹窗(409 驱动,同意后重试)+ 留区 SQL 原文查看
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const [regionSql, setRegionSql] = useState<{ historyId: string; jurisdiction?: string; sql: string; auditId?: string } | null>(null);
  const [sql, setSql] = useState("SELECT 1;");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [savedTasks, setSavedTasks] = useState<any[]>([]);
  const [taskName, setTaskName] = useState("");
  const pollRef = useRef<NodeJS.Timeout>(undefined);
  // 工作组清单请求的序号:只认最新那次的响应(见 fetchWorkgroups 里的理由)
  const wgReqSeq = useRef(0);

  // Connection state
  const [workgroups, setWorkgroups] = useState<any[]>([]);
  // @kf-batch 50-WP7-sync-pushdown —— 🔴 不再以 home 的 workgroup 常量打底(在别的区视角下那是主控区的名字,
  // 清单到达前会当选中项显示;与向导 E-218 同族)。空 = 清单到达后选第一个;空着提交由服务端按执行目标解析。
  const [selectedWg, setSelectedWg] = useState("");
  const [selectedDb, setSelectedDb] = useState("dev");
  const [schemas, setSchemas] = useState<any>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);

  const [databases, setDatabases] = useState<string[]>(["dev"]);

  // @kf-batch 50-P50.3-mrquery —— 执行区域多选 + 逐区提交结果。
  const [execTargets, setExecTargets] = useState<Array<{ targetId: string; region: string; isHome: boolean }>>([]);
  const [targets, setTargets] = useState<string[]>([HOME_TARGET]);
  const [targetsErr, setTargetsErr] = useState("");
  // @kf-batch 50-WP2-directquery —— 该区未部署数仓时的说明(空串 = 正常)
  const [schemaUnavailable, setSchemaUnavailable] = useState("");
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  /** 只要绑了任何非 home 的区,落点就不能再手填(只能来自各目标的描述符)。 */
  const multiRegion = targets.length > 1 || targets.some((x) => x !== HOME_TARGET);

  const [currentStatementId, setCurrentStatementId] = useState<string>("");
  // S0(50 SPEC §0/§3.7):执行接口下发的 queryHandle —— 取消/取结果都要带,服务端凭它判归属。
  const [currentHandleId, setCurrentHandleId] = useState<string>("");
  const [sqlHistory, setSqlHistory] = useState<any[]>([]);

  // @kf-batch 50-WP4quater-reads(工单 SC-35)—— 保存的查询与执行历史都按执行范围过滤。
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const fetchTasks = () => fetch(`/api/redshift/tasks${scopeQs}`).then((r) => r.json()).then(setSavedTasks);
  // @kf-batch 50-WP4ter-coverage —— 工作组下拉跟随编辑器自己的执行目标(与左侧库表树同一个 `treeTarget`)
  const fetchWorkgroups = () => {
    // 🔴🔴 **先清空再取**(2026-09-18 真环境截图坐实的缺陷):切到 us-west-2 之后,这条请求要跨区
    // ListWorkgroups,平台忙时能飞好几十秒;在那段时间里页面**继续显示上一个区的值** ——
    // 顶栏写着 tgt_usw2_a,工作组却是主控区的 `bgp-workgroup`、Endpoint 还是 `…us-east-1…`。
    // 这正是 `/settings` 那次「硬撒谎」同一类:界面上一份看着很正常、其实属于另一个区的清单。
    // ⇒ 换区那一刻先把清单与选中项清空(界面显示「加载中/空」),宁可少显示,绝不显示别的区的。
    setWorkgroups([]);
    setSelectedWg("");
    // 🔴🔴 **丢弃陈旧响应**(2026-09-18 带时序实测):挂载时 `targets` 初值是 `[tgt_home]`,视角 effect
    // 随后才把它改成 usw2 ⇒ 同一次进站会**并发**发出两个清单请求(实测 t=1.56s 打 home、t=1.79s 打 usw2)。
    // 谁先返回不确定;**home 那份晚到就会赢**,于是 us-west-2 视角显示主控区的工作组与 us-east-1 的 Endpoint
    // (真环境截图坐实)。只「先清空」治不了这个:清空发生在**请求发出时**,管不住晚到的响应。
    // ⇒ 每次请求记一个序号,回来时不是最新那次就整份丢掉(经典的 stale-response 竞态)。
    const seq = ++wgReqSeq.current;
    return fetch(`/api/redshift/connections?targetId=${encodeURIComponent(treeTarget)}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq !== wgReqSeq.current) return; // 更晚的请求已发出 ⇒ 这份是别的区的答案,丢掉
        if (!Array.isArray(d)) return;
        setWorkgroups(d);
        // 选中项只能是**这份清单里**的名字:换执行目标后上一个区的选中项作废,取该区第一个;清单为空就留空。
        const names: string[] = d.map((w: any) => w.workgroupName).filter(Boolean);
        setSelectedWg((cur) => (cur && names.includes(cur) ? cur : names[0] || ""));
      });
  };
  // @kf-batch 50-WP2-directquery —— 库清单/库表树跟**执行目标**走(多选时取第一个:左侧树只能显示一个区的结构;
  // 多区并行的差异由 §4septies 的多 sheet 结果对比呈现,不该硬塞进一棵树里)。
  // 🔴 用 `?targetId=` 而不是 `?scope=`:这里回答的是「我在编辑器里选了哪个数仓」,不是页面视角。
  const treeTarget = targets[0] || HOME_TARGET;
  // 🔴 非主控区**不带** workgroup:本页那个选择器列的是主控区的工作组,带过去会撞「落点冲突」
  //    (绑定解析对「显式给的 workgroup ≠ 该 target 描述符」是直接拒 —— 那条检查本身是对的)。
  const treeWgQs = (wg: string) => (treeTarget === HOME_TARGET ? `workgroup=${encodeURIComponent(wg)}&` : "");
  const fetchDatabases = (wg: string) => fetch(`/api/redshift/databases?${treeWgQs(wg)}targetId=${encodeURIComponent(treeTarget)}`).then((r) => r.json()).then((d: any[]) => { if (Array.isArray(d) && d.length) setDatabases(d.map((x) => x.name)); });
  // @kf-batch 50-WP4quater-reads(工单 SC-35)—— 执行历史按范围过滤(行上已有 targetId 章)
  const fetchHistory = () => fetch(`/api/redshift/history${scopeQs}`).then((r) => r.json()).then((d) => setSqlHistory(d.success ? d.data : d));

  const fetchSchemas = async () => {
    setLoadingSchema(true);
    try {
      const res = await fetch(`/api/redshift/schemas?${treeWgQs(selectedWg)}database=${encodeURIComponent(selectedDb)}&targetId=${encodeURIComponent(treeTarget)}`);
      const j = await res.json();
      // 该区没装数仓 ⇒ 服务端回能力态:树置空 + 说清原因(而不是给一棵空树让人以为库里真没东西)
      setSchemaUnavailable(j && j.capability === "unavailable" ? String(j.reason || "") : "");
      setSchemas(j);
    } finally { setLoadingSchema(false); }
  };

  // @kf-batch 50-WP4ter-coverage —— 同上:执行目标换了,工作组下拉跟着换
  // @kf-batch 50-WP4quater-reads —— 🔴 deps 必须同时含 `scopeQs`:`treeTarget` 是**编辑器选的执行目标**,
  // 它与顶栏视角是两回事(多区分组视角下 treeTarget 不变)⇒ 只写 treeTarget,切分组时保存的查询与
  // 历史列表都停在上一个分组(护栏 4 的漏洞)。
  useEffect(() => { fetchTasks(); fetchWorkgroups(); fetchDatabases(selectedWg); fetchHistory(); /* eslint-disable-next-line */ }, [treeTarget, scopeQs]);

  // @kf-batch 50-WP2-directquery
  // 顶栏切区 ⇒ 执行目标默认跟着换(用户刚刚明确表达了"我关心这个区");之后仍可手动多选做扇出。
  // 🔴 「全部」视角回到 `[HOME_TARGET]` = 改动前的缺省,逐字节等价。
  useEffect(() => {
    setTargets(scope.kind === "target" ? [scope.targetId] : [HOME_TARGET]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind === "target" ? scope.targetId : "global"]);

  // @kf-batch 50-P50.3-mrquery
  // 🔴 清单**必须来自服务端**(`/api/exec-targets`):"哪些目标可下推"是准入 + 组件 + 法域
  // 三条判据的合成,前端拼等于第二个判据源。读失败要**显式说出来** —— 静默留空 = 界面上只剩
  // home 可选,用户会以为第二区域没建好。
  useEffect(() => {
    fetchExecTargets("redshift").then(setExecTargets).catch((e) => setTargetsErr(String(e?.message || e)));
  }, []);

  // @kf-batch 50-W5-seg2-WP10a —— 留区 SQL 原文:中央历史行只有指针,点「查看 / 加载」按需读区域表(先同意前置再区域审计)
  const fetchRegionSql = async (r: any): Promise<{ sql: string; auditId?: string } | null> => {
    const { res, body, cancelled } = await fetchWithResidencyAck(`/api/redshift/history/${r.historyId}/sql`, undefined, resolveAckRequired);
    if (cancelled) return null;
    if (!res.ok || !body?.success) { message.error(body?.error?.message || t("读取区域 SQL 原文失败")); return null; }
    return { sql: String(body.data?.sql ?? ""), auditId: body.data?.auditId };
  };
  const viewRegionSql = async (r: any) => { const d = await fetchRegionSql(r); if (d) setRegionSql({ historyId: r.historyId, jurisdiction: r.jurisdiction, ...d }); };
  const loadHistorySql = async (r: any) => {
    if (r.residency !== "region") { setSql(r.sql); return; }
    const d = await fetchRegionSql(r);
    if (d) setSql(d.sql);
  };

  const handleExecute = async () => {
    setRunning(true); setError(""); setSubmissions(null);
    try {
      // @kf-batch 50-W5-seg2-WP10a —— 跨法域 target 首次直查 ⇒ 服务端 409 ⇒ 弹免责告知 ⇒ 同意留存 ⇒ 自动重试同一请求
      const { body: data, cancelled } = await fetchWithResidencyAck("/api/redshift/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql,
          // @kf-batch 50-P50.3-mrquery —— 多区:落点由各目标描述符决定,**多区时不传** workgroup/database
          // (传了非 home 会被 `assertNoWarehouseConflict` 当场拒,用户会看到一堆"落点冲突"而不知为何)。
          ...(multiRegion ? {} : { workgroupName: selectedWg, database: selectedDb }),
          targets,
        }),
      }, resolveAckRequired);
      if (cancelled) { setRunning(false); return; }
      // 🔴 全部区在**提交阶段**就失败时,顶层才有 error(单区语义与改动前一致);apiError 信封则在 error.message。
      if (!data || !Array.isArray(data.submissions) || data.submissions.length === 0) {
        setError((typeof data?.error === "string" ? data.error : data?.error?.message) || t("执行失败")); setRunning(false); return;
      }
      // 🔴 提交完就交给多 sheet 组件:**每个 sheet 各自轮询、谁先回来谁先能看**
      //    (用户 2026-09-04 明确要求"不许等所有区都回来再展示")。
      setSubmissions(data.submissions as Submission[]);
      setCurrentStatementId(data.statementId || "");
      setCurrentHandleId(data.handleId || "");
      setRunning(false);
      const bad = (data.submissions as Submission[]).filter((x) => x.submitError);
      if (bad.length) {
        message.warning(t("{n} 个区域提交即失败,错误已显示在各自的 sheet 里", { n: bad.length }));
      }
    } catch (e: any) { setError(e.message); setRunning(false); }
  };

  const handleSave = async () => {
    if (!taskName) { message.warning(t("请输入任务名称")); return; }
    await fetch("/api/redshift/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, // 🔴 保存时盖上**编辑器当前的执行目标**(不是页面视角):这条查询将来就该跑在那个区。
      body: JSON.stringify({ name: taskName, sql, workgroupName: selectedWg, database: selectedDb, targetId: treeTarget }) });
    message.success(t("已保存")); setTaskName(""); fetchTasks();
  };

  const handleDeleteTask = async (id: string) => {
    try {
      await deleteJson(`/api/redshift/tasks/${id}`); message.success(t("已删除")); fetchTasks();
    } catch (e) {
      // 序 41 B-117:服务端拒绝 ⇒ 原话呈现(此前无条件提示「已删除」)
      message.error((e as Error).message || t("删除失败"));
    }
  };

  const schemaTreeData = schemas?.schemas?.map((s: any) => ({
    title: <span>📁 {s.name}</span>, key: s.name, selectable: false,
    children: schemas.tables?.filter((tb: any) => tb.schema === s.name).map((tb: any) => ({
      title: <Space><span>📋 {tb.table}</span><Tag style={{ fontSize: 10 }}>{t("{n} 列", { n: tb.columns?.length || 0 })}</Tag></Space>,
      key: `${s.name}.${tb.table}`, selectable: true,
      children: tb.columns?.map((c: any) => ({
        title: <span style={{ fontSize: 12 }}><code>{c.name}</code> <Tag style={{ fontSize: 10 }}>{c.type}</Tag></span>,
        key: `${s.name}.${tb.table}.${c.name}`, isLeaf: true, selectable: false,
      })) || [],
    })) || [],
  })) || [];

  return (
    <div>
      {residencyModal}
      {/* @kf-batch 50-W5-seg2-WP10a —— 留区 SQL 原文(按需读回,来自该区的区域结果表;中央仍无) */}
      <Modal
        open={Boolean(regionSql)}
        onCancel={() => setRegionSql(null)}
        footer={null}
        width={760}
        title={t("SQL 原文(留在 {j} 区域)", { j: regionSql?.jurisdiction || "" })}
        data-testid="history-region-sql-modal"
      >
        <pre data-testid="history-region-sql" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{regionSql?.sql}</pre>
        {regionSql?.auditId ? <span style={{ fontSize: 12, color: "#888" }}>{t("审计 #{id}", { id: regionSql.auditId })}</span> : null}
      </Modal>
      <h2><DatabaseOutlined /> {t("Redshift 查询")}</h2>

      {/* Connection Config */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <span style={{ fontWeight: 500 }}>{t("连接配置:")}</span>
          {/* @kf-batch 50-P50.3-mrquery —— 🔴 **执行区域多选**:一条 SQL 可同时打多个 region,
              结果按区分 sheet(INTERACTION §4septies)。标签必须可见 —— 多选 Select 只勾一个值时
              长得跟单选一模一样,用户第一反应会是"只能选一个区域"(离线计算页刚被这条咬过)。 */}
          <span style={{ color: "#8fa6b2", fontSize: 12 }}>{t("执行区域(可多选)")}</span>
          <Select
            mode="multiple"
            allowClear={false}
            value={targets}
            style={{ minWidth: 300 }}
            placeholder={t("执行区域(可多选)")}
            data-testid="rs-exec-targets"
            onChange={(v: string[]) => setTargets(v.length ? v.slice(0, MAX_FANOUT) : [HOME_TARGET])}
            options={(execTargets.length ? execTargets : [{ targetId: HOME_TARGET, region: "", isHome: true }]).map((x) => ({
              label: `${x.targetId}${x.region ? `(${x.region})` : ""}${x.isHome ? ` · ${t("本地")}` : ""}`,
              value: x.targetId,
            }))}
          />
          <Button size="small" disabled={execTargets.length === 0}
            onClick={() => setTargets(execTargets.slice(0, MAX_FANOUT).map((x) => x.targetId))}>
            {t("全选当前活跃区({n})", { n: Math.min(execTargets.length, MAX_FANOUT) })}
          </Button>
          {targets.length > 1 ? <Tag color="geekblue">{t("🌐 {n} 个区各执行一次,结果分 sheet", { n: targets.length })}</Tag> : null}
          {targetsErr ? <Tag color="red">{t("执行目标清单读取失败")}: {targetsErr}</Tag> : null}
          {/* 🔴 多区时落点只能来自各目标的描述符 ⇒ 这两个选择器置灰(给了就会出现"我选的是 A、真跑在 B")。 */}
          <Select value={selectedWg} disabled={multiRegion} onChange={(v) => { setSelectedWg(v); fetchDatabases(v); setSchemas(null); }} style={{ width: 200 }} placeholder="Workgroup"
            options={workgroups.map((w) => ({ label: `${w.workgroupName} (${w.status})`, value: w.workgroupName }))} />
          <Select value={selectedDb} disabled={multiRegion} onChange={setSelectedDb} style={{ width: 140 }}
            options={databases.map((d) => ({ label: d, value: d }))} />
          {multiRegion ? <Tag color="blue">{t("落点由各执行目标的描述符决定")}</Tag> : null}
          {/* 🔴 无头判据(E-140c)靠**结构属性**定位,不靠文案:这两处都走 `t()`,有英文词条 ⇒
              界面被判成 en 时中文 locator 必崩(本仓 locale 坑已犯 4 次)。 */}
          <Button icon={<ReloadOutlined />} onClick={fetchSchemas} loading={loadingSchema}
                  data-testid="rs-load-schema">{t("加载 Schema")}</Button>
          {workgroups.find((w) => w.workgroupName === selectedWg)?.endpoint && (
            <Tag color="green">Endpoint: {workgroups.find((w) => w.workgroupName === selectedWg)?.endpoint}</Tag>
          )}
        </Space>
      </Card>

      <div style={{ display: "flex", gap: 16 }}>
        {/* Left: Schema Browser */}
        <div style={{ width: 260, flexShrink: 0 }}>
          <Card size="small" title={t("数据库对象")} style={{ height: "calc(100vh - 280px)", overflow: "auto" }}>
            {/* @kf-batch 50-WP2-directquery —— 该区未部署数仓 ⇒ 说清原因,别给一棵空树 */}
            {schemaUnavailable ? (
              <Alert type="warning" showIcon data-testid="schema-no-warehouse" message={schemaUnavailable} />
            ) : schemas ? (
              <Tree treeData={schemaTreeData} defaultExpandAll
                onSelect={(keys) => {
                  const k = keys[0] as string;
                  if (k?.includes(".")) setSql(`SELECT * FROM ${k} LIMIT 100;`);
                }} />
            ) : <div style={{ color: "#999", textAlign: "center", padding: 20 }}>{t("点击\"加载 Schema\"")}<br/>{t("浏览数据库对象")}</div>}
          </Card>
        </div>

        {/* Right: Editor + Results */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tabs items={[
            { key: "editor", label: t("SQL 编辑器"), children: (<>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <Space>
                  <Select style={{ width: 180 }} options={SQL_TEMPLATES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => { if (v) setSql(v); }} placeholder={t("SQL 模板")} />
                  <Button icon={<ClearOutlined />} onClick={() => { setSql(""); setError(""); setSubmissions(null); }}>{t("清空")}</Button>
                </Space>
                <Space>
                  <Input placeholder={t("任务名称")} value={taskName} onChange={(e) => setTaskName(e.target.value)} style={{ width: 140 }} />
                  <Button icon={<SaveOutlined />} onClick={handleSave}>{t("保存")}</Button>
                  {/* 🔴 按钮写清会打几个区:N 个区 = N 份扫描与计费,不能让一次点击悄悄放大。 */}
                  <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleExecute} loading={running}>
                    {running ? t("提交中...") : targets.length > 1 ? t("执行({n} 个区)", { n: targets.length }) : t("执行")}
                  </Button>
                  {running && currentStatementId && (
                    <Button danger onClick={async () => {
                      // S0:带上 handleId(query 参数),服务端按句柄归属判是否允许取消。
                      const qs = currentHandleId ? `?handleId=${encodeURIComponent(currentHandleId)}` : "";
                      await fetch(`/api/redshift/cancel${qs}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ statementId: currentStatementId }) });
                      setRunning(false); setCurrentStatementId(""); setCurrentHandleId(""); message.info(t("查询已取消"));
                    }}>{t("取消")}</Button>
                  )}
                </Space>
              </div>
              <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                <MonacoEditor height="280px" language="sql" theme="vs-dark" value={sql} onChange={(v) => setSql(v || "")} options={{ minimap: { enabled: false }, fontSize: 14 }} />
              </div>
              {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}
              {running && <Spin tip={t("提交中...")} style={{ display: "block", margin: "20px auto" }} />}
              {/* @kf-batch 50-P50.3-mrquery
                  🔴 结果区整体交给多 sheet 组件:**每个 sheet 独立生命周期**(各自轮询、谁先回来
                  谁先能看、错误就地展示在它自己的 sheet 里)。单区时组件不出「对比」tab,
                  视觉与改动前一致 ⇒ 存量用法零感知。 */}
              {submissions && submissions.length > 0 && (
                <MultiRegionResults submissions={submissions} sql={sql} onHistoryWritten={fetchHistory} />
              )}
            </>)},
            { key: "tasks", label: t("已保存任务 ({count})", { count: savedTasks.length }), children: (
              <Table columns={[
                { title: t("名称"), dataIndex: "name", key: "name" },
                // 空 = 运行时按该行 targetId 的描述符解析;这里不能拿 home 的名字充数(非 home 行会被显示成主控区)
                { title: "Workgroup", dataIndex: "workgroupName", key: "wg", render: (v: string) => v || t("(按执行区域自动解析)") },
                { title: "Database", dataIndex: "database", key: "db", render: (v: string) => v || "dev" },
                { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
                { title: t("操作"), key: "action", render: (_: any, r: any) => (
                  <Space>
                    <a onClick={() => { setSql(r.sql); if (r.workgroupName) setSelectedWg(r.workgroupName); if (r.database) setSelectedDb(r.database); }}>{t("加载")}</a>
                    <Popconfirm title={t("确认删除？")} onConfirm={() => handleDeleteTask(r.taskId)}><a style={{ color: "red" }}><DeleteOutlined /></a></Popconfirm>
                  </Space>
                )},
              ]} dataSource={savedTasks} rowKey="taskId" />
            )},
            { key: "history", label: t("执行历史 ({count})", { count: sqlHistory.length }), children: (
              <Table size="small" columns={[
                // @kf-batch 50-W5-seg2-WP10a —— 跨法域 target 的 SQL 原文**留在区域**(E-189):中央行无 sql,这里只显示指针 + 「查看」按需读回
                { title: "SQL", dataIndex: "sql", ellipsis: true, render: (v: string, r: any) => r.residency === "region"
                  ? <Space size={4} data-testid="history-region-row">
                      <span style={{ fontSize: 11 }}>{t("留在 {j} 区域", { j: r.jurisdiction || r.targetId })}</span>
                      <a onClick={() => viewRegionSql(r)} data-testid="history-view-sql">{t("查看")}</a>
                    </Space>
                  : <code style={{ fontSize: 11 }}>{v?.slice(0, 80)}</code> },
                { title: t("状态"), dataIndex: "status", width: 80, render: (v: string) => <Tag color={v === "success" ? "green" : "red"}>{v}</Tag> },
                // @kf-batch 50-P50.3-mrquery —— 一条 SQL 打了多个区就会有多条历史,不标区域看不出哪个区没成。
                { title: t("执行区域"), dataIndex: "targetId", width: 140,
                  render: (v: string, r: any) => (!v || v === HOME_TARGET
                    ? <Tag>{t("本地")}</Tag>
                    : <Tag color={r.residency === "region" ? "geekblue" : "cyan"}>{r.residency === "region" ? `🌍 ${v}` : v}</Tag>) },
                { title: t("耗时"), dataIndex: "duration", width: 70, render: (v: number) => v ? `${v}s` : "-" },
                { title: t("行数"), dataIndex: "rowCount", width: 70 },
                { title: t("时间"), dataIndex: "createdAt", width: 160, render: (v: string) => v?.slice(0, 19).replace("T", " ") },
                { title: "", width: 60, render: (_: any, r: any) => <a onClick={() => loadHistorySql(r)}>{t("加载")}</a> },
              ]} dataSource={sqlHistory} rowKey="historyId" pagination={{ pageSize: 20 }} />
            )},
          ]} />
        </div>
      </div>
    </div>
  );
}
