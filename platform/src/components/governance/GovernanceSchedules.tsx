"use client";

// @kf-batch 50-WP28-platform-action-node(WP-29 治理)
// 治理页「定时治理任务」:建 / 启停 / 删 —— 质量检查 · 敏感扫描 · 目录同步 按 cron 在**当前执行范围**里跑。
//
// 🔴 三条与产品既有纪律对齐的约束:
//   ① **在哪个区跑 = 建它时顶栏选的那个执行范围**,弹框上复述(护栏 2);「全部 / 对比」视角不给建(先选一个区);
//      每区自治调度(用户拍板),载体发到**该区**的 MWAA Serverless,绝不回落主控区。
//   ② 「自动调度」绿标只给**真有载体**的行(看 deployments 里的 workflowArn,不看 scheduleEnabled);
//      enabled 而没有产物 ⇒ 橙色「待发布载体」(WP-26 那个教训:页面不许替没有载体的东西报喜)。
//   ③ 目录同步勾上「数仓目录」⇒ 当场明示**会唤醒该区数仓并计费**(30 分钟的平台镜像定时器仍只刷 Glue)。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { ClockCircleOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import CronEditor from "@/components/common/CronEditor";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { DISPATCHABLE_ACTIONS, GOVERNANCE_ACTION_IDS, type GovernanceActionId } from "@/lib/scheduler/action-commands";

const { Text } = Typography;

const ACTION_LABEL: Record<string, string> = Object.fromEntries(DISPATCHABLE_ACTIONS.map((a) => [a.id, a.label]));

function isArmed(r: any): boolean {
  return Boolean(r.scheduleEnabled && r.cronExpression && Object.values(r.deployments || {}).some((d: any) => d?.workflowArn));
}

export default function GovernanceSchedules({ isAdmin }: { isAdmin: boolean }) {
  const t = useT();
  const { scope, targets } = useScope();
  const scopeParam = toScopeParam(scope);
  const targetId = scope.kind === "target" ? scope.targetId : "";
  const region = targetId ? targets?.find((x) => x.targetId === targetId)?.region || targetId : "";
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  // 表单
  const [name, setName] = useState("");
  const [action, setAction] = useState<GovernanceActionId>("governance.quality-check");
  const [cron, setCron] = useState("0 3 * * *");
  const [fqns, setFqns] = useState("");
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState("");
  const [sources, setSources] = useState<string[]>(["glue"]);
  const [enableNow, setEnableNow] = useState(true);
  const [formErr, setFormErr] = useState("");

  // 🔴 只认最后一次请求(切区时晚到的旧响应不许盖掉新范围的结果)
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const qs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
      const r = await fetch(`/api/governance/schedules${qs}`);
      const d = await r.json();
      if (my !== seq.current) return;
      if (!d?.success) { setErr(d?.error?.message || `HTTP ${r.status}`); setRows([]); }
      else { setErr(""); setRows(Array.isArray(d.data) ? d.data : []); }
    } catch (e) {
      if (my === seq.current) { setErr((e as Error)?.message || t("网络异常")); setRows([]); }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [scopeParam, t]);
  useEffect(() => { void load(); }, [load]);

  const paramsOf = (): Record<string, unknown> => {
    const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    if (action === "governance.quality-check") return { fqns: lines(fqns) };
    if (action === "governance.sensitive-scan") return { ...(schema.trim() ? { schema: schema.trim() } : {}), ...(lines(tables).length ? { tables: lines(tables) } : {}) };
    return { sources };
  };

  const create = async () => {
    setFormErr("");
    const res = await fetch("/api/governance/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), action, params: paramsOf(), targetId, cronExpression: cron }),
    });
    const d = await res.json().catch(() => ({}));
    if (!d?.success) { setFormErr(d?.error?.message || t("创建失败")); return; }
    if (enableNow) {
      const er = await fetch("/api/schedule/enable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: d.data.taskId, taskType: "governance", cronExpression: cron, enabled: true }),
      });
      const ed = await er.json().catch(() => ({}));
      if (!ed?.success) message.error(t("任务已建,但启用定时失败:{e}", { e: ed?.error?.message || `HTTP ${er.status}` }), 8);
      else message.success(t("定时治理任务已建并启用"));
    } else {
      message.success(t("定时治理任务已建(未启用)"));
    }
    setOpen(false);
    setName(""); setFqns(""); setSchema(""); setTables("");
    void load();
  };

  const toggle = async (r: any, enabled: boolean) => {
    setBusy(r.taskId);
    try {
      const res = await fetch("/api/schedule/enable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: r.taskId, taskType: "governance", cronExpression: r.cronExpression || cron, enabled }),
      });
      const d = await res.json().catch(() => ({}));
      if (!d?.success) message.error(d?.error?.message || t("调度配置失败"), 8);
      else message.success(enabled ? t("调度已启用") : t("调度已停用"));
    } finally {
      setBusy("");
      void load();
    }
  };

  const del = async (r: any) => {
    setBusy(r.taskId);
    try {
      const res = await fetch(`/api/governance/schedules/${r.taskId}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!d?.success) message.error(d?.error?.message || t("删除失败"), 8);
      else message.success(t("已删除"));
    } finally {
      setBusy("");
      void load();
    }
  };

  const columns = [
    { title: t("名称"), dataIndex: "name", key: "name", render: (v: string, r: any) => <b data-testid={`gov-schedule-name-${r.taskId}`}>{v}</b> },
    { title: t("动作"), dataIndex: "action", key: "action", render: (v: string) => <Tag color="cyan">{t(ACTION_LABEL[v] || v)}</Tag> },
    { title: t("执行范围"), key: "target", render: (_: any, r: any) => {
      const tid = (r.targets || [])[0] || "";
      const rg = targets?.find((x) => x.targetId === tid)?.region || tid;
      return <Tag color="geekblue" title={tid} data-testid={`gov-schedule-target-${r.taskId}`}>🌍 {rg}</Tag>;
    } },
    { title: t("Cron 表达式"), dataIndex: "cronExpression", key: "cron", render: (v: string) => <Tag><ClockCircleOutlined /> {v || t("未配置")}</Tag> },
    { title: t("调度类型"), key: "armed", render: (_: any, r: any) => {
      if (isArmed(r)) {
        return <Tooltip title={t("已发布到该执行范围的 MWAA Serverless,到点由它触发;运行记录与日志在任务监控里查")}>
          <Tag color="green" data-testid={`gov-schedule-armed-${r.taskId}`}>{t("自动调度")}</Tag>
        </Tooltip>;
      }
      if (r.scheduleEnabled) return <Tag color="orange" data-testid={`gov-schedule-not-armed-${r.taskId}`}>{t("待发布载体")}</Tag>;
      return <Tag data-testid={`gov-schedule-disabled-${r.taskId}`}>{t("未启用")}</Tag>;
    } },
    { title: t("启用"), key: "enabled", render: (_: any, r: any) => (
      <Switch size="small" checked={Boolean(r.scheduleEnabled)} disabled={!isAdmin} loading={busy === r.taskId}
        data-testid={`gov-schedule-toggle-${r.taskId}`} onChange={(v) => void toggle(r, v)} />
    ) },
    { title: t("操作"), key: "op", render: (_: any, r: any) => (
      <Space>
        <a href="/monitor" data-testid={`gov-schedule-runs-${r.taskId}`}>{t("运行记录")}</a>
        {isAdmin && (
          <Popconfirm title={t("删除这个定时治理任务?")} description={t("会先把该区的调度产物撤下来;撤不下来不会删记录。")}
            okText={t("删除")} cancelText={t("取消")} onConfirm={() => void del(r)}>
            <a style={{ color: "#ff7875" }} data-testid={`gov-schedule-del-${r.taskId}`}>{t("删除")}</a>
          </Popconfirm>
        )}
      </Space>
    ) },
  ];

  return (
    <Card size="small" data-testid="gov-schedules-card"
      title={<span><ClockCircleOutlined /> {t("定时治理任务")}</span>}
      extra={<Space>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>{t("刷新")}</Button>
        {isAdmin && (
          <Tooltip title={targetId ? "" : t("先在顶栏选一个执行环境:定时治理任务在哪个区跑,就是建它时选的那个区")}>
            <Button size="small" type="primary" icon={<PlusOutlined />} disabled={!targetId}
              data-testid="gov-schedule-create-btn" onClick={() => setOpen(true)}>{t("新建定时任务")}</Button>
          </Tooltip>
        )}
      </Space>}>
      <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
        {t("质量检查 / 敏感扫描 / 目录同步按 cron 在所选执行范围里自动跑;每个区自治调度,只有结果元数据回到主控区。")}
      </Text>
      {!targetId && (
        <Alert type="info" showIcon style={{ marginBottom: 8 }} data-testid="gov-schedule-pick-target"
          message={t("当前是「全部 / 对比」视角:列表显示全部范围的定时治理任务;要新建,请先在顶栏选一个执行环境")} />
      )}
      {err && <Alert type="error" showIcon style={{ marginBottom: 8 }} data-testid="gov-schedule-error" message={err} />}
      <Table size="small" rowKey="taskId" loading={loading} dataSource={rows} columns={columns} pagination={false}
        data-testid="gov-schedule-table"
        onRow={(r: any) => ({ "data-testid": `gov-schedule-row-${r.taskId}` }) as React.HTMLAttributes<HTMLElement>}
        locale={{ emptyText: t("还没有定时治理任务") }} />

      <Modal open={open} title={t("新建定时治理任务")} onCancel={() => setOpen(false)} onOk={() => void create()}
        okText={t("创建")} okButtonProps={{ "data-testid": "gov-schedule-submit" } as never} data-testid="gov-schedule-modal" width={620}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type="info" showIcon data-testid="gov-schedule-target-restate"
            message={t("将在 {region}({tid})按 cron 执行;调度发布到该区的 MWAA Serverless,不会回落主控区", { region, tid: targetId })} />
          <Input placeholder={t("任务名称")} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} data-testid="gov-schedule-name" />
          <Select style={{ width: "100%" }} value={action} onChange={(v) => setAction(v)} data-testid="gov-schedule-action"
            options={GOVERNANCE_ACTION_IDS.map((id) => ({ value: id, label: t(ACTION_LABEL[id] || id) }))} />
          {action === "governance.quality-check" && (
            <Input.TextArea rows={3} value={fqns} onChange={(e) => setFqns(e.target.value)} data-testid="gov-schedule-fqns"
              placeholder={t("要检查的表(每行一个 FQN,如 bgp-redshift.dev.public.orders);每张表跑它已启用的全部规则")} />
          )}
          {action === "governance.sensitive-scan" && (
            <>
              <Input placeholder={t("schema(留空 = 全部)")} value={schema} onChange={(e) => setSchema(e.target.value)} data-testid="gov-schedule-scan-schema" />
              <Input.TextArea rows={2} value={tables} onChange={(e) => setTables(e.target.value)} data-testid="gov-schedule-scan-tables"
                placeholder={t("只扫这些表(可选,每行一个 schema.table)")} />
            </>
          )}
          {action === "governance.catalog-sync" && (
            <>
              <Checkbox.Group value={sources} onChange={(v) => setSources(v as string[])} data-testid="gov-schedule-sources"
                options={[{ label: t("Glue 目录(免费的目录 API)"), value: "glue" }, { label: t("数仓目录(Redshift)"), value: "redshift" }]} />
              {sources.includes("redshift") && (
                <Alert type="warning" showIcon data-testid="gov-schedule-warehouse-billing"
                  message={t("定时采数仓目录会唤醒该区的 Redshift Serverless 数仓并产生计费(按 RPU-秒);只在确实需要时勾选。平台自己的 30 分钟镜像定时器仍只刷 Glue。")} />
              )}
            </>
          )}
          <div data-testid="gov-schedule-cron"><CronEditor value={cron} onChange={setCron} /></div>
          <Checkbox checked={enableNow} onChange={(e) => setEnableNow(e.target.checked)} data-testid="gov-schedule-enable-now">
            {t("创建后立即启用定时")}
          </Checkbox>
          {formErr && <Alert type="error" showIcon data-testid="gov-schedule-form-error" message={formErr} />}
        </Space>
      </Modal>
    </Card>
  );
}
