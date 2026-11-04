"use client";

// 补数中心。发起补数计划(向导:目标→日期范围→级联→并发→dry-run 预览→确认)+
// 计划列表 + 进度矩阵(日期×节点状态色块)+ 控制(暂停/恢复/取消/续跑)。前端刷新驱动 tick 推进。

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  Card, Table, Tag, Button, Space, Modal, Form, Select, DatePicker, InputNumber,
  Input, Switch, message, Tooltip, Statistic, Row, Col, Alert, Segmented, Drawer, Descriptions,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined,
  StopOutlined, RedoOutlined, HistoryOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useT } from "@/lib/i18n/useT";
import FeatureGuide from "@/components/common/FeatureGuide";
// 执行范围接入(50 SPEC §2.6;交互 INTERACTION §9)
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { toScopeParam } from "@/lib/scope/scope";
// 实例抽屉(行数 / 错误原话 / 日志 / 去监控页),「运行日志」弹窗与监控页同一作者
import RunLogModal from "@/components/monitor/RunLogModal";
import { resourcePath } from "@/lib/env/resource-path";
import type { ResourceType } from "@/lib/versions/version-service";

type Granularity = "day" | "week" | "hour";
const STATUS_COLORS: Record<string, string> = {
  pending: "#8c8c8c", blocked: "#bfbfbf", running: "#1677ff",
  succeeded: "#52c41a", failed: "#ff4d4f", skipped: "#d9b3ff",
};
const PLAN_STATUS_COLOR: Record<string, string> = {
  planned: "default", running: "processing", paused: "warning",
  cancelled: "default", succeeded: "success", "partially-failed": "error",
};

export default function BackfillPage() {
  const t = useT();
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [targets, setTargets] = useState<any[]>([]);
  const [form] = Form.useForm();
  const [preview, setPreview] = useState<{ count: number; input: any } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [detail, setDetail] = useState<any | null>(null); // {plan,instances,matrix}
  const [detailPlanId, setDetailPlanId] = useState<string>("");
  const tickTimer = useRef<NodeJS.Timeout>(undefined);
  // 当前执行范围(顶栏选的那个;URL 是权威)。
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  // `global` 时回 null ⇒ URL 与改动前逐字节相同(回滚点),不会凭空多出 `?scope=global`。
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";

  // 🔴 返回**这次拿到的计划列表**(不只是 setState):创建后要判断「新建的计划在当前范围里看得见吗」,
  //    看不见就得当场说出来 —— 靠 state 判会读到上一轮的旧值。
  const fetchPlans = useCallback(async (): Promise<any[]> => {
    setLoading(true);
    try {
      const d = await fetch(`/api/backfill${scopeQs}`).then((r) => r.json());
      const list = d?.data?.plans || d?.plans || [];
      setPlans(list);
      return list;
    } catch {
      return [];
    } finally {
      setLoading(false);
    }
  }, [scopeQs]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  // 打开向导时拉目标。
  const openWizard = () => {
    setPreview(null);
    form.resetFields();
    setWizardOpen(true);
    // 目标下拉按执行范围过滤:否则在 us-west-2 视角
    // 也能选到只在主控区能跑的作业,补数计划建出来必然失败。
    // 显式要同步任务(`include=sync-task`;不带时接口与改动前逐字节相同,SLA 面板也读它)。
    const tq = new URLSearchParams();
    if (scopeParam) tq.set("scope", scopeParam);
    tq.set("include", "sync-task");
    fetch(`/api/backfill/targets?${tq.toString()}`).then((r) => r.json()).then((d) => setTargets(d?.data?.targets || d?.targets || []));
  };

  const selectedTarget = () => targets.find((x) => x.id === form.getFieldValue("targetId"));

  // dry-run 预览。
  const doPreview = async () => {
    const v = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!v) return;
    const tgt = targets.find((x) => x.id === v.targetId);
    if (!tgt) return;
    setPreviewing(true);
    try {
      const body = {
        name: v.name,
        target: { id: tgt.id, scope: tgt.scope, kind: tgt.kind },
        dateRange: { start: v.range[0].format("YYYY-MM-DD"), end: v.range[1].format("YYYY-MM-DD"), granularity: v.granularity },
        cascade: tgt.scope === "workflow" ? !!v.cascade : false,
        concurrency: v.concurrency, maxInstances: v.maxInstances,
        dryRun: true,
      };
      const res = await fetch("/api/backfill/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) { message.error(d?.error || t("预览失败")); setPreview(null); return; }
      setPreview({ count: d.data.count, input: d.data.input });
    } finally { setPreviewing(false); }
  };

  // 确认落库。
  const doConfirm = async () => {
    const v = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!v) return;
    const tgt = targets.find((x) => x.id === v.targetId);
    if (!tgt) return;
    const body = {
      name: v.name,
      target: { id: tgt.id, scope: tgt.scope, kind: tgt.kind },
      dateRange: { start: v.range[0].format("YYYY-MM-DD"), end: v.range[1].format("YYYY-MM-DD"), granularity: v.granularity },
      cascade: tgt.scope === "workflow" ? !!v.cascade : false,
      concurrency: v.concurrency, maxInstances: v.maxInstances,
      dryRun: false,
    };
    const res = await fetch("/api/backfill/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { message.error(d?.error || t("创建失败")); return; }
    message.success(t("补数计划已创建"));
    setWizardOpen(false);
    // 护栏 1:计划的执行区来自**所选作业自己的绑定**(服务端 `execTargets`),
    // 与顶栏视角无关(写路径不读 scope)。若建出来的计划不落在当前视角,列表会「毫无变化」——
    // 那正是「东西不见了而界面一个字不说」。⇒ 用**实际拉回来的列表**判一次,看不见就当场说清。
    const after = await fetchPlans();
    if (scope.kind !== "global" && !after.some((x: any) => x.planId === d.data.planId)) {
      message.warning(t("计划已创建,但它的执行区不在当前执行范围内 —— 请切到「全部」查看"));
    }
    openDetail(d.data.planId); // 直接进详情并开始推进
  };

  // ── 详情 + 自动 tick 推进 ──
  const loadDetail = useCallback((planId: string) => {
    fetch(`/api/backfill/${planId}`).then((r) => r.json()).then((d) => { if (d?.data) setDetail(d.data); });
  }, []);

  const tickOnce = useCallback((planId: string) => {
    fetch(`/api/backfill/${planId}/tick`, { method: "POST" }).then((r) => r.json()).then(() => loadDetail(planId)).catch(() => {});
  }, [loadDetail]);

  const openDetail = (planId: string) => {
    setDetailPlanId(planId);
    loadDetail(planId);
    tickOnce(planId);
  };

  // 详情打开时每 6s tick 一次(推进 + 刷新);计划终态则停。
  useEffect(() => {
    if (tickTimer.current) clearInterval(tickTimer.current);
    if (!detailPlanId) return;
    tickTimer.current = setInterval(() => {
      const st = detail?.plan?.status;
      // 终态(成功/取消/部分失败)不再推进,只刷新展示;partially-failed 等用户点『续跑失败』再动。
      if (st === "succeeded" || st === "cancelled" || st === "partially-failed") { loadDetail(detailPlanId); return; }
      tickOnce(detailPlanId);
    }, 6000);
    return () => { if (tickTimer.current) clearInterval(tickTimer.current); };
  }, [detailPlanId, detail?.plan?.status, tickOnce, loadDetail]);

  const control = async (action: string) => {
    if (!detailPlanId) return;
    const res = await fetch(`/api/backfill/${detailPlanId}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const d = await res.json();
    if (!res.ok) { message.error(d?.error || t("操作失败")); return; }
    message.success(t("操作成功"));
    loadDetail(detailPlanId);
    fetchPlans();
    if (action === "resume" || action === "retry-failed") tickOnce(detailPlanId);
  };

  const planColumns = [
    { title: t("计划名称"), dataIndex: "name", key: "name", render: (v: string, r: any) => <a onClick={() => openDetail(r.planId)}>{v}</a> },
    { title: t("目标"), dataIndex: ["target", "name"], key: "target", render: (v: string, r: any) => <Space><Tag>{r.target?.scope === "workflow" ? t("工作流") : t("任务")}</Tag>{v}</Space> },
    { title: t("日期范围"), key: "range", render: (_: any, r: any) => `${r.dateRange?.start} ~ ${r.dateRange?.end}` },
    { title: t("级联"), dataIndex: "cascade", key: "cascade", render: (v: boolean) => (v ? <Tag color="blue">{t("级联下游")}</Tag> : <Tag>{t("否")}</Tag>) },
    { title: t("并发"), dataIndex: "concurrency", key: "concurrency" },
    {
      title: t("进度"), key: "progress", render: (_: any, r: any) => {
        const p = r.progress || {};
        return <Space size={4}><Tag color="success">{p.succeeded || 0}✓</Tag>{(p.failed || 0) > 0 && <Tag color="error">{p.failed}✗</Tag>}<span style={{ color: "#8c8c8c" }}>/ {p.total || 0}</span></Space>;
      },
    },
    { title: t("状态"), dataIndex: "status", key: "status", render: (v: string) => <Tag color={PLAN_STATUS_COLOR[v] || "default"}>{t(planStatusLabel(v))}</Tag> },
    { title: t("操作"), key: "op", render: (_: any, r: any) => <Button size="small" onClick={() => openDetail(r.planId)}>{t("查看进度")}</Button> },
  ];

  const tgtSel = selectedTarget();
  // 含数据同步节点的工作流:服务端会把并发强制成 1(lib/backfill/types.ts forcedBackfillConcurrency),
  //   这里提前说明并锁住并发框(与同步任务目标同一套 UX);`nodeTypes` 来自 /api/backfill/targets。
  const wfHasSyncNode = tgtSel?.scope === "workflow" && Array.isArray(tgtSel?.nodeTypes) && tgtSel.nodeTypes.includes("sync");
  const concurrencyForced = tgtSel?.kind === "sync-task" || wfHasSyncNode;

  return (
    <div style={{ padding: 24 }}>
      <Card
        title={<Space><HistoryOutlined />{t("补数中心")}</Space>}
        extra={<Space>
          <Button icon={<ReloadOutlined />} onClick={fetchPlans}>{t("刷新")}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openWizard}>{t("发起补数")}</Button>
        </Space>}
      >
        <FeatureGuide
          title={t("补数中心")}
          what="对历史某段日期重新跑数据加工任务(补数/回刷)。批量展开成「日期×节点」实例,自动限并发、按依赖链顺序推进、失败可只续跑失败项;补数运行与在线调度严格隔离,不污染成功率与 SLA 统计。"
          steps={[
            "点右上「发起补数」,选择要补的任务或工作流。",
            "选日期范围与粒度(按天/周/小时);工作流可勾选「级联下游」按依赖顺序补。",
            "设并发上限与实例天花板,点「预览实例」查看将生成多少个补数实例。",
            "点「确认创建」,系统按并发限流逐个以 backfill 触发,进度矩阵实时展示每个(日期×节点)的状态。",
            "失败时点「续跑失败」只重跑失败项及其下游;也可暂停/恢复/取消整个计划。",
            "点进度矩阵里的色块看该实例的写入行数 / 错误原话 / 运行日志,或一键跳到任务监控页;「成功但写入 0 行」会标黄并给排查方向。",
          ]}
          tips={[
            "补数运行一律标记 backfill,不计入在线成功率与 SLA 基线,放心大批量重算。",
            "并发上限与实例天花板是防跑飞的双闸:超过天花板会拒绝创建。",
            "级联补数下,上游节点失败会自动跳过其下游,续跑后自动重新参与。",
          ]}
        />
        <Alert style={{ marginBottom: 16 }} type="info" showIcon
          message={t("补数产生的运行以 backfill 标记,不计入在线成功率/SLA 基线,不污染在线统计。")} />
        {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」 */}
        <OtherScopesHint resources={["backfill-plan"]} />
        {/* 同 /datasources:包一层 testid 容器,无头验收只数计划表 */}
        <div data-testid="backfill-table">
          <Table rowKey="planId" size="small" loading={loading} columns={planColumns as any} dataSource={plans} pagination={{ pageSize: 10 }}
            style={{ marginTop: 12 }}
            locale={{ emptyText: <ScopeEmptyHint resources={["backfill-plan"]} noun={t("补数计划")} /> }} />
        </div>
      </Card>

      {/* 发起向导 */}
      <Modal title={t("发起补数")} open={wizardOpen} onCancel={() => setWizardOpen(false)} width={720}
        footer={<Space>
          <Button onClick={() => setWizardOpen(false)}>{t("取消")}</Button>
          <Button loading={previewing} onClick={doPreview}>{t("预览实例")}</Button>
          <Button type="primary" disabled={!preview} onClick={doConfirm}>{t("确认创建")}</Button>
        </Space>}>
        <Form form={form} layout="vertical" initialValues={{ granularity: "day", concurrency: 2, maxInstances: 100, cascade: true }} onValuesChange={() => setPreview(null)}>
          <Form.Item name="targetId" label={t("补数目标")} rules={[{ required: true, message: t("请选择目标") }]}>
            <Select showSearch optionFilterProp="label" placeholder={t("选择任务或工作流")}
              options={targets.map((x) => ({
                value: x.id,
                // 同步任务:补不了的(没用日期变量 / 增量)置灰并把原因写在选项上,不让人选了再报错
                label: x.kind === "sync-task"
                  ? `${x.name}（${t("同步任务")}）${x.unavailableReason ? ` — ${t("不可补数")}:${x.unavailableReason}` : ""}`
                  : `${x.name}（${x.scope === "workflow" ? t("工作流") : x.taskType}）`,
                disabled: !!x.unavailableReason,
              }))} />
          </Form.Item>
          <Form.Item name="name" label={t("计划名称")}>
            <Input placeholder={t("留空自动命名")} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={14}>
              <Form.Item name="range" label={t("日期范围")} rules={[{ required: true, message: t("请选择日期范围") }]}>
                <DatePicker.RangePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="granularity" label={t("粒度")}>
                <Segmented options={[{ label: t("按天"), value: "day" }, { label: t("按周"), value: "week" }, { label: t("按小时"), value: "hour" }]} />
              </Form.Item>
            </Col>
          </Row>
          {tgtSel?.kind === "sync-task" && (
            <Alert style={{ marginBottom: 16 }} type="info" showIcon
              message={t("同步任务按业务日期逐天补数:每个日期跑一次该任务(Glue 作业带上这个日期),并发固定为 1(同一个 Glue 作业不能同时跑两个日期);只支持按天 / 按周。")} />
          )}
          {wfHasSyncNode && (
            <Alert style={{ marginBottom: 16 }} type="info" showIcon
              message={t("该工作流含数据同步节点:每个业务日期会把节点关联的同步任务跑一次(Glue 作业带上这个日期),并发固定为 1(同一个 Glue 作业不能同时跑两个日期)。关联的同步任务须是 Glue 通道、全量且用到日期变量,否则该节点的实例会如实失败(级联时其下游跳过)。")} />
          )}
          {tgtSel?.scope === "workflow" && (
            <Form.Item name="cascade" label={t("级联下游依赖")} valuePropName="checked"
              tooltip={t("按 DAG 依赖顺序补数:同日期上游成功后下游才跑")}>
              <Switch checkedChildren={t("级联")} unCheckedChildren={t("独立")} />
            </Form.Item>
          )}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="concurrency" label={t("并发上限")} tooltip={t("同时运行的实例数上限,防打爆引擎")}>
                <InputNumber min={1} max={10} style={{ width: "100%" }} disabled={concurrencyForced} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="maxInstances" label={t("实例天花板")} tooltip={t("防跑飞:展开超过此数则拒绝创建")}>
                <InputNumber min={1} max={500} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          {preview && (
            <Alert type={preview.count > 0 ? "success" : "warning"} showIcon
              message={t("将生成 {n} 个补数实例", { n: preview.count })}
              description={t("确认后按并发上限逐个以 backfill 触发,可在进度矩阵查看。")} />
          )}
        </Form>
      </Modal>

      {/* 进度详情 + 矩阵 */}
      <Modal title={<Space><HistoryOutlined />{detail?.plan?.name || t("补数进度")}</Space>} open={!!detailPlanId} width={900}
        onCancel={() => { setDetailPlanId(""); setDetail(null); }} footer={null}>
        {detail && <PlanDetail detail={detail} t={t} onControl={control} onRefresh={() => { loadDetail(detailPlanId); tickOnce(detailPlanId); }} />}
      </Modal>
    </div>
  );
}

function planStatusLabel(v: string): string {
  return ({ planned: "已规划", running: "运行中", paused: "已暂停", cancelled: "已取消", succeeded: "已完成", "partially-failed": "部分失败" } as Record<string, string>)[v] || v;
}

// 成功但写入 0 行 —— 只认 succeeded ∧ 行数已知 ∧ 为 0(行数未上报 ≠ 0 行;判定与服务端 run-facts.ts 同口径)
function isZeroRowSuccess(inst: any): boolean {
  return inst?.status === "succeeded" && !!inst?.run && inst.run.rowsWritten === 0;
}

// 补数目标 ⇒ 它的详情页在哪(唯一作者 lib/env/resource-path.ts;同步任务按实例自己的 runTaskId —— 工作流里的同步节点跑的是别的任务)
function targetPagePath(plan: any, inst: any): string | null {
  const kind = plan?.target?.kind as string | undefined;
  const map: Record<string, ResourceType> = { "etl-job": "etl-job", "engine-job": "engine-job", workflow: "workflow", "sync-task": "sync" };
  if (inst?.run?.taskType === "sync" && inst?.runTaskId) return resourcePath("sync", String(inst.runTaskId));
  const type = kind ? map[kind] : undefined;
  return type ? resourcePath(type, String(plan.target.id)) : null;
}

function PlanDetail({ detail, t, onControl, onRefresh }: { detail: any; t: (s: string, p?: any) => string; onControl: (a: string) => void; onRefresh: () => void }) {
  const { plan, instances, matrix } = detail;
  const rowsSum = detail.rows || null;
  const p = plan.progress || {};
  const byKey: Record<string, any> = {};
  for (const i of instances) byKey[`${i.date}#${i.nodeId}`] = i;
  const isWorkflow = plan.target?.scope === "workflow";
  // 选中的实例(抽屉);抽屉内容随 6s 刷新取最新那一份(按 日期#节点 重取,不拿陈旧快照)
  const [selKey, setSelKey] = useState<string>("");
  const [logOpen, setLogOpen] = useState(false);
  const sel = selKey ? byKey[selKey] || null : null;

  // 矩阵列:第一列日期,其后每个节点一列。
  const columns: any[] = [{ title: t("日期"), dataIndex: "date", key: "date", fixed: "left", width: 130 }];
  for (const node of matrix.nodes) {
    columns.push({
      title: node.nodeName, key: node.nodeId, width: 110,
      render: (_: any, row: any) => {
        const key = `${row.date}#${node.nodeId}`;
        const inst = byKey[key];
        if (!inst) return <span style={{ color: "#d9d9d9" }}>—</span>;
        const zero = isZeroRowSuccess(inst);
        const hasRows = !!inst.run && inst.run.rowsWritten !== null && inst.run.rowsWritten !== undefined;
        const rowsTxt = hasRows ? t("写入 {n} 行", { n: inst.run.rowsWritten }) : inst.status === "succeeded" ? t("行数未上报") : "";
        const tip = [zero ? t("成功(0 行)") : inst.status, rowsTxt, inst.lastError || inst.run?.error || "", inst.attempts ? t("尝试") + inst.attempts : "", t("点击查看详情")]
          .filter(Boolean).join(" · ");
        return <Tooltip title={tip}>
          <span role="button" data-testid="backfill-cell" data-status={inst.status} data-zero={zero ? "1" : "0"} data-rows={hasRows ? String(inst.run.rowsWritten) : ""}
            onClick={() => setSelKey(key)}
            style={{ display: "inline-block", minWidth: 68, textAlign: "center", padding: "2px 8px", borderRadius: 4, color: "#fff", fontSize: 12, cursor: "pointer",
              background: zero ? "#faad14" : STATUS_COLORS[inst.status] || "#8c8c8c" }}>
            {zero ? t("成功(0 行)") : t(instStatusLabel(inst.status))}
          </span>
        </Tooltip>;
      },
    });
  }
  const rows = matrix.dates.map((d: string) => ({ key: d, date: d }));
  const taskPath = sel ? targetPagePath(plan, sel) : null;
  const monitorHref = `/monitor?name=${encodeURIComponent(plan.target?.name || "")}&triggeredBy=backfill`;

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col span={4}><Statistic title={t("总实例")} value={p.total || 0} /></Col>
        <Col span={4}><Statistic title={t("成功")} value={p.succeeded || 0} valueStyle={{ color: "#52c41a" }} /></Col>
        <Col span={4}><Statistic title={t("失败")} value={p.failed || 0} valueStyle={{ color: "#ff4d4f" }} /></Col>
        <Col span={4}><Statistic title={t("运行中")} value={p.running || 0} valueStyle={{ color: "#1677ff" }} /></Col>
        <Col span={4}><Statistic title={t("待跑")} value={(p.pending || 0) + (p.blocked || 0)} /></Col>
        <Col span={4}><Statistic title={t("跳过")} value={p.skipped || 0} /></Col>
      </Row>
      {/* 计划级写入行数 —— 只汇总行数已知的成功实例;未上报的单独计数,不混进总和当 0 */}
      {rowsSum && (
        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col span={8}>
            <div data-testid="plan-rows-total">
              <Statistic title={t("写入总行数")} value={rowsSum.rowsWrittenTotal || 0}
                suffix={<span style={{ fontSize: 12, color: "#8c8c8c" }}>{t("已知 {k} / {n} 个成功实例", { k: rowsSum.instancesWithRows || 0, n: p.succeeded || 0 })}</span>} />
            </div>
          </Col>
          <Col span={8}>
            <div data-testid="plan-zero-rows">
              <Statistic title={t("成功但 0 行")} value={rowsSum.instancesZeroRows || 0} valueStyle={{ color: (rowsSum.instancesZeroRows || 0) > 0 ? "#faad14" : undefined }} />
            </div>
          </Col>
          <Col span={8}>
            <div data-testid="plan-rows-unknown">
              <Statistic title={t("行数未上报")} value={rowsSum.instancesUnknown || 0} />
            </div>
          </Col>
        </Row>
      )}
      {rowsSum && (rowsSum.instancesZeroRows || 0) > 0 && (
        <Alert data-testid="plan-zero-alert" type="warning" showIcon style={{ marginBottom: 12 }}
          message={t("有 {n} 个实例成功但写入 0 行 —— 点对应色块看原因与排查方向", { n: rowsSum.instancesZeroRows })} />
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <Tag color={PLAN_STATUS_COLOR[plan.status] || "default"}>{t(planStatusLabel(plan.status))}</Tag>
        <Tag>{t("并发")} {plan.concurrency}</Tag>
        {isWorkflow && plan.cascade && <Tag color="blue">{t("级联下游")}</Tag>}
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>{t("刷新")}</Button>
        {(plan.status === "running" || plan.status === "planned") && <Button size="small" icon={<PauseCircleOutlined />} onClick={() => onControl("pause")}>{t("暂停")}</Button>}
        {plan.status === "paused" && <Button size="small" icon={<PlayCircleOutlined />} onClick={() => onControl("resume")}>{t("恢复")}</Button>}
        {plan.status !== "cancelled" && plan.status !== "succeeded" && <Button size="small" danger icon={<StopOutlined />} onClick={() => onControl("cancel")}>{t("取消")}</Button>}
        {(p.failed || 0) > 0 && <Button size="small" icon={<RedoOutlined />} onClick={() => onControl("retry-failed")}>{t("续跑失败")}</Button>}
        <Button size="small" href={monitorHref} data-testid="plan-goto-monitor">{t("去监控页看全部运行")}</Button>
      </Space>
      <div data-testid="backfill-matrix-hint" style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 6 }}>{t("点色块查看该实例的写入行数 / 错误原话 / 运行日志")}</div>
      <Table size="small" columns={columns} dataSource={rows} pagination={false} scroll={{ x: "max-content", y: 380 }} bordered />

      {/* 实例抽屉 */}
      <Drawer open={!!sel} onClose={() => setSelKey("")} width={560} data-testid="backfill-instance-drawer"
        title={sel ? `${t("补数实例")} · ${sel.date} · ${sel.nodeName}` : t("补数实例")}>
        {sel && <InstanceDetail inst={sel} t={t} taskPath={taskPath} monitorHref={monitorHref} onViewLog={() => setLogOpen(true)} />}
      </Drawer>
      <RunLogModal open={logOpen && !!sel?.runTaskId && !!sel?.runId} taskId={sel?.runTaskId ?? ""} runId={sel?.runId ?? ""} onClose={() => setLogOpen(false)}
        title={sel ? `${t("运行日志")} · ${sel.date} · ${sel.nodeName}` : undefined}
        extra={sel?.run?.glueJobName ? <span data-testid="run-log-glue">{t("本区 Glue 作业运行")}:<code>{sel.run.glueJobName}</code> / <code>{sel.run.glueJobRunId || "-"}</code></span> : undefined} />
    </div>
  );
}

function InstanceDetail({ inst, t, taskPath, monitorHref, onViewLog }: { inst: any; t: (s: string, p?: any) => string; taskPath: string | null; monitorHref: string; onViewLog: () => void }) {
  const run = inst.run || null;
  const zero = isZeroRowSuccess(inst);
  const hints: string[] = Array.isArray(inst.zeroRowHints) ? inst.zeroRowHints : [];
  const fmt = (v?: string | null) => (v ? String(v).slice(0, 19).replace("T", " ") : "-");
  const dur = run && run.duration !== null && run.duration !== undefined ? (run.duration >= 60 ? `${Math.floor(run.duration / 60)}m${run.duration % 60}s` : `${run.duration}s`) : "-";
  let rowsNode: React.ReactNode;
  if (run && run.rowsWritten !== null && run.rowsWritten !== undefined) {
    rowsNode = <span data-testid="inst-rows" data-rows={String(run.rowsWritten)} style={{ color: zero ? "#faad14" : undefined, fontWeight: 600 }}>
      {t("写入 {n} 行", { n: run.rowsWritten })}
      <span style={{ color: "#8c8c8c", fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{run.rowsSource === "sync-metrics" ? t("来自同步作业写入侧指标") : run.rowsSource === "redshift-affected" ? t("Redshift 受影响行数") : ""}</span>
    </span>;
  } else if (inst.status === "succeeded") {
    rowsNode = <span data-testid="inst-rows" data-rows="">{t("未上报(该类运行不产出行数指标)")}</span>;
  } else {
    rowsNode = <span data-testid="inst-rows" data-rows="">-</span>;
  }
  const err = run?.error || inst.lastError || "";
  return (
    <div>
      {zero && (
        <Alert data-testid="inst-zero-hint" type="warning" showIcon style={{ marginBottom: 12 }}
          message={t("成功但写入 0 行:平台只知道这次写了 0 行,不知道源里为什么没有 —— 下面是可核对的方向")}
          description={<ul style={{ margin: "4px 0 0 16px", padding: 0 }}>{hints.map((h, i) => <li key={i}>{h}</li>)}</ul>} />
      )}
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label={t("日期")}>{inst.date}</Descriptions.Item>
        <Descriptions.Item label={t("节点")}>{inst.nodeName}{inst.nodeType ? <Tag style={{ marginLeft: 6 }}>{inst.nodeType}</Tag> : null}</Descriptions.Item>
        <Descriptions.Item label={t("执行区")}><span data-testid="inst-target">{run?.stampedTargetId || inst.targetId || "-"}</span></Descriptions.Item>
        <Descriptions.Item label={t("状态")}>
          <Tag data-testid="inst-status" data-status={inst.status} color={zero ? "warning" : inst.status === "succeeded" ? "success" : inst.status === "failed" ? "error" : inst.status === "running" ? "processing" : "default"}>
            {zero ? t("成功(0 行)") : t(instStatusLabel(inst.status))}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t("尝试次数")}>{inst.attempts ?? 0}</Descriptions.Item>
        <Descriptions.Item label={t("耗时")}>{dur}</Descriptions.Item>
        <Descriptions.Item label={t("开始")}>{fmt(run?.startedAt || inst.startedAt)}</Descriptions.Item>
        <Descriptions.Item label={t("结束")}>{fmt(run?.finishedAt || inst.finishedAt)}</Descriptions.Item>
        <Descriptions.Item label={t("写入行数")} span={2}>{rowsNode}</Descriptions.Item>
        <Descriptions.Item label={t("错误原话")} span={2}>
          <div data-testid="inst-error" style={{ whiteSpace: "pre-wrap", color: err ? "#ff4d4f" : undefined, maxHeight: 160, overflow: "auto" }}>{err || "-"}</div>
        </Descriptions.Item>
        <Descriptions.Item label={t("底层运行")} span={2}>
          {inst.runTaskId && inst.runId
            ? <span data-testid="inst-run-ref"><code>{inst.runTaskId}</code> / <code>{inst.runId}</code>{run?.taskType ? <Tag style={{ marginLeft: 6 }}>{run.taskType}</Tag> : null}</span>
            : <span data-testid="inst-run-ref" style={{ color: "#8c8c8c" }}>{t("该实例尚未产生运行(未领取或提交失败)")}</span>}
        </Descriptions.Item>
        {run?.glueJobName && (
          <Descriptions.Item label={t("Glue 作业")} span={2}><span data-testid="inst-glue"><code>{run.glueJobName}</code>{run.glueJobRunId ? <> / <code>{run.glueJobRunId}</code></> : null}</span></Descriptions.Item>
        )}
      </Descriptions>
      <Space style={{ marginTop: 12 }} wrap>
        <Button type="primary" data-testid="inst-view-log" disabled={!(inst.runTaskId && inst.runId)} onClick={onViewLog}>{t("查看运行日志")}</Button>
        <Button data-testid="inst-goto-monitor" href={monitorHref}>{t("去监控页定位")}</Button>
        {taskPath && <Button data-testid="inst-goto-task" href={taskPath}>{t("去任务页")}</Button>}
      </Space>
    </div>
  );
}

function instStatusLabel(v: string): string {
  return ({ pending: "待跑", blocked: "阻塞", running: "运行", succeeded: "成功", failed: "失败", skipped: "跳过" } as Record<string, string>)[v] || v;
}
