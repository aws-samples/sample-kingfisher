"use client";

// 告警中心。三 Tab:规则 / 通道 / 事件。
// 全局 fetch 拦截器自动带 Authorization + x-bgp-project(见 AuthProvider),故直接 fetch。

import React, { useEffect, useState, useCallback } from "react";
import {
  Card, Tabs, Table, Button, Tag, Space, Modal, Form, Input, Select, Switch, Typography,
  message, Popconfirm, InputNumber, Tooltip, Alert,
} from "antd";
import {
  BellOutlined, ReloadOutlined, PlusOutlined, ThunderboltOutlined, ApiOutlined,
  ExperimentOutlined, DeleteOutlined, EditOutlined, FieldTimeOutlined,
} from "@ant-design/icons";
import SlaPanel from "@/components/alerting/SlaPanel";
import { useT } from "@/lib/i18n/useT";
// 后台评估周期的单一作者(文案按它换算,不另写一份数字)
import { ALERTING_PUMP_INTERVAL_MS } from "@/lib/alerting/types";
// 执行范围。🔴 这一页最要紧的不是过滤,
// 而是**聚合类条件默认按区分别评估**(见 lib/alerting/evaluate.ts):池化会让一个区全挂
// 被健康区平均掉 ⇒ 不告警。页面这里做两件事:按区看规则/事件 + 事件列表显示「哪个区」。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

const { Title, Paragraph, Text } = Typography;

// 与后端 types.ts 对齐的前端轻类型。
type Severity = "P1" | "P2" | "P3";
type ConditionType = "failure" | "timeout" | "success-rate" | "no-run";
type ChannelType = "dingtalk" | "wecom" | "email" | "generic";

const SEVERITY_COLOR: Record<Severity, string> = { P1: "red", P2: "orange", P3: "blue" };
const CHANNEL_LABEL: Record<ChannelType, string> = { dingtalk: "钉钉", wecom: "企业微信", email: "邮件", generic: "通用 Webhook" };

export default function AlertingPage() {
  const t = useT();
  // 旧 /sla URL 重定向带 ?tab=sla 直达该 Tab(2026-07-13 调度运维收敛)。
  // 首帧固定 rules(= 服务端),挂载后按 ?tab=sla 切换;初值函数里读 window.location 会让 React 19 报水合不一致
  const [tab, setTab] = useBrowserInitialState<string>("rules", () =>
    new URLSearchParams(window.location.search).get("tab") === "sla" ? "sla" : "rules"
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><BellOutlined /> {t("告警中心")}</Title>
      </div>
      <Paragraph type="secondary">
        {t("统一告警中心：定义告警规则(失败/超时/成功率/断流)，命中后推送到钉钉/企业微信/邮件/通用 Webhook 通道；失败告警可自动挂 AI 诊断。")}
      </Paragraph>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "rules", label: <span><ThunderboltOutlined /> {t("告警规则")}</span>, children: <RulesTab active={tab === "rules"} /> },
          { key: "sla", label: <span><FieldTimeOutlined /> {t("SLA 基线预警")}</span>, children: <SlaPanel active={tab === "sla"} /> },
          { key: "channels", label: <span><ApiOutlined /> {t("通知通道")}</span>, children: <ChannelsTab active={tab === "channels"} /> },
          { key: "events", label: <span><BellOutlined /> {t("告警事件")}</span>, children: <EventsTab active={tab === "events"} /> },
        ]}
      />
    </div>
  );
}

// ─── 规则 Tab ──────────────────────────────────────────────────────────────
function RulesTab({ active }: { active: boolean }) {
  const t = useT();
  const [rules, setRules] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form] = Form.useForm();

  // 规则按区看(盯全部区的规则在任何视角下都出现)
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([
        fetch(`/api/alerting/rules${scopeQs}`).then((x) => x.json()),
        // 通道是账号级配置(钉钉/企微/邮件 webhook),与区无关 ⇒ 不带 scope
        fetch("/api/alerting/channels").then((x) => x.json()),
      ]);
      setRules(r?.success ? r.data : []);
      setChannels(c?.success ? c.data : []);
    } finally {
      setLoading(false);
    }
  }, [scopeQs]);

  useEffect(() => { if (active) load(); }, [active, load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ scope: { taskType: "all" }, condition: { type: "failure" }, severity: "P2", enrichWithDiagnosis: true, channelIds: [] });
    setModalOpen(true);
  };
  const openEdit = (rule: any) => {
    setEditing(rule);
    form.setFieldsValue({
      name: rule.name,
      scope: { taskType: rule.scope?.taskType || "all", taskId: rule.scope?.taskId },
      condition: rule.condition,
      severity: rule.severity,
      channelIds: rule.channelIds || [],
      enrichWithDiagnosis: rule.enrichWithDiagnosis,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!v) return;
    const payload = { ...v };
    const url = editing ? `/api/alerting/rules/${editing.ruleId}` : "/api/alerting/rules";
    const method = editing ? "PUT" : "POST";
    if (editing) (payload as any).version = editing.version;
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json());
    if (res?.success) {
      message.success(editing ? t("规则已更新") : t("规则已创建"));
      setModalOpen(false);
      load();
    } else {
      message.error(res?.error?.message || t("操作失败"));
    }
  };

  const toggle = async (rule: any, field: "enabled" | "silenced", value: boolean) => {
    const res = await fetch(`/api/alerting/rules/${rule.ruleId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value, version: rule.version }),
    }).then((x) => x.json());
    if (res?.success) load();
    else message.error(res?.error?.message || t("操作失败"));
  };

  const del = async (rule: any) => {
    const res = await fetch(`/api/alerting/rules/${rule.ruleId}`, { method: "DELETE" }).then((x) => x.json());
    if (res?.success) { message.success(t("已删除")); load(); }
  };

  const runEvaluate = async () => {
    setEvaluating(true);
    try {
      const res = await fetch("/api/alerting/evaluate", { method: "POST" }).then((x) => x.json());
      if (res?.success) {
        const n = res.data.newEvents;
        message.success(n > 0 ? t("评估完成：新增 {n} 条告警", { n }) : t("评估完成：无新告警"));
        load();
      } else {
        message.error(res?.error?.message || t("评估失败"));
      }
    } finally {
      setEvaluating(false);
    }
  };

  // 后台泵每轮都会推进每条规则的水位 ⇒ 「上次评估」= 规则水位的最大值(页面不另问服务端)
  const lastEvaluatedAt = rules.map((r) => String(r.lastEvaluatedAt || "")).filter(Boolean).sort().pop();
  const autoEvalEveryMin = Math.max(1, Math.round(ALERTING_PUMP_INTERVAL_MS / 60_000));

  const condText = (c: any) => {
    if (c?.type === "failure") return t("任务失败");
    if (c?.type === "timeout") return t("超时 > {m} 分钟", { m: c.thresholdMinutes });
    if (c?.type === "success-rate") return t("成功率 < {p}%（近 {w} 分钟）", { p: c.thresholdPercent, w: c.windowMinutes });
    if (c?.type === "no-run") return t("断流：近 {w} 分钟无成功", { w: c.windowMinutes });
    return "-";
  };

  return (
    <Card
      size="small"
      title={
        <Text type="secondary" style={{ fontWeight: "normal", fontSize: 13 }} data-testid="alerting-auto-eval-hint">
          {t("后台每 {n} 分钟自动评估一次", { n: autoEvalEveryMin })}
          {lastEvaluatedAt ? ` · ${t("上次 {time}", { time: lastEvaluatedAt.slice(11, 19) + " UTC" })}` : ""}
        </Text>
      }
      extra={
        <Space>
          <Tooltip title={t("后台每 {n} 分钟自动评估一次", { n: autoEvalEveryMin }) + t(";点这里只是提前一轮")}>
            <Button icon={<ExperimentOutlined />} loading={evaluating} onClick={runEvaluate}>{t("立即评估")}</Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>{t("刷新")}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t("新建规则")}</Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="ruleId"
        loading={loading}
        dataSource={rules}
        locale={{ emptyText: t("暂无告警规则") }}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: t("规则名称"), dataIndex: "name", render: (v: string, r: any) => <Space><Tag color={SEVERITY_COLOR[r.severity as Severity]}>{r.severity}</Tag>{v}</Space> },
          { title: t("作用域"), key: "scope", render: (_: any, r: any) => <Tag>{r.scope?.taskType === "all" ? t("全部类型") : r.scope?.taskType}{r.scope?.taskId ? ` · ${r.scope.taskId.slice(-8)}` : ""}</Tag> },
          { title: t("触发条件"), key: "cond", render: (_: any, r: any) => condText(r.condition) },
          { title: t("通道"), key: "ch", render: (_: any, r: any) => (r.channelIds?.length ? <Tag color="cyan">{r.channelIds.length} {t("个")}</Tag> : <Text type="secondary">{t("无")}</Text>) },
          { title: "AI", key: "ai", width: 60, render: (_: any, r: any) => (r.enrichWithDiagnosis ? <Tooltip title={t("失败自动挂 AI 诊断")}><Tag color="purple">AI</Tag></Tooltip> : null) },
          { title: t("启用"), key: "enabled", width: 70, render: (_: any, r: any) => <Switch size="small" checked={r.enabled} onChange={(v) => toggle(r, "enabled", v)} /> },
          { title: t("静默"), key: "silenced", width: 70, render: (_: any, r: any) => <Switch size="small" checked={r.silenced} onChange={(v) => toggle(r, "silenced", v)} /> },
          {
            title: t("操作"), key: "act", width: 120,
            render: (_: any, r: any) => (
              <Space>
                <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)} />
                <Popconfirm title={t("确认删除该规则？")} onConfirm={() => del(r)} okText={t("删除")} cancelText={t("取消")}>
                  <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? t("编辑告警规则") : t("新建告警规则")}
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        okText={t("保存")}
        cancelText={t("取消")}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("规则名称")} rules={[{ required: true, message: t("请输入规则名称") }]}>
            <Input placeholder={t("如：生产同步任务失败告警")} />
          </Form.Item>
          <Space size="middle" style={{ display: "flex" }}>
            <Form.Item name={["scope", "taskType"]} label={t("作用域(任务类型)")} style={{ flex: 1 }}>
              <Select
                options={[
                  { value: "all", label: t("全部类型") },
                  { value: "sync", label: t("数据同步") },
                  { value: "etl", label: t("离线计算(ETL)") },
                  { value: "emr-serverless", label: "EMR Serverless" },
                  { value: "workflow", label: t("ETL 编排") },
                  { value: "flink", label: t("实时计算(Flink)") },
                ]}
              />
            </Form.Item>
            <Form.Item name="severity" label={t("级别")} style={{ width: 120 }}>
              <Select options={[{ value: "P1", label: "P1" }, { value: "P2", label: "P2" }, { value: "P3", label: "P3" }]} />
            </Form.Item>
          </Space>
          <Form.Item name={["scope", "taskId"]} label={t("限定具体任务 ID(可选，留空=该类型全部)")}>
            <Input placeholder={t("留空则监视该类型下所有任务")} allowClear />
          </Form.Item>
          <Form.Item name={["condition", "type"]} label={t("触发条件")}>
            <Select
              options={[
                { value: "failure", label: t("任务失败即告警") },
                { value: "timeout", label: t("运行超时(时长超阈值)") },
                { value: "success-rate", label: t("成功率低于阈值") },
                { value: "no-run", label: t("断流(窗口内无成功运行)") },
              ]}
            />
          </Form.Item>
          {/* 条件参数:按类型动态显示 */}
          <Form.Item noStyle shouldUpdate={(p, c) => p.condition?.type !== c.condition?.type}>
            {() => {
              const type: ConditionType = form.getFieldValue(["condition", "type"]);
              if (type === "timeout")
                return <Form.Item name={["condition", "thresholdMinutes"]} label={t("超时阈值(分钟)")} rules={[{ required: true, message: t("请输入分钟数") }]}><InputNumber min={1} style={{ width: "100%" }} placeholder="30" /></Form.Item>;
              if (type === "success-rate")
                return (
                  <Space style={{ display: "flex" }}>
                    <Form.Item name={["condition", "thresholdPercent"]} label={t("成功率阈值(%)")} rules={[{ required: true, message: t("请输入") }]} style={{ flex: 1 }}><InputNumber min={0} max={100} style={{ width: "100%" }} placeholder="90" /></Form.Item>
                    <Form.Item name={["condition", "windowMinutes"]} label={t("统计窗口(分钟)")} style={{ flex: 1 }}><InputNumber min={1} style={{ width: "100%" }} placeholder="1440" /></Form.Item>
                  </Space>
                );
              if (type === "no-run")
                return <Form.Item name={["condition", "windowMinutes"]} label={t("断流窗口(分钟)")} rules={[{ required: true, message: t("请输入分钟数") }]}><InputNumber min={1} style={{ width: "100%" }} placeholder="1440" /></Form.Item>;
              return null;
            }}
          </Form.Item>
          <Form.Item name="channelIds" label={t("通知通道")}>
            <Select mode="multiple" allowClear placeholder={t("选择通知通道(可多选)")}
              options={channels.map((c) => ({ value: c.channelId, label: `${c.name}（${CHANNEL_LABEL[c.type as ChannelType] || c.type}）` }))}
            />
          </Form.Item>
          <Form.Item name="enrichWithDiagnosis" label={t("失败时自动挂 AI 诊断")} valuePropName="checked" tooltip={t("仅对「任务失败」类条件生效")}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ─── 通道 Tab ──────────────────────────────────────────────────────────────
function ChannelsTab({ active }: { active: boolean }) {
  const t = useT();
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [form] = Form.useForm();
  const chType: ChannelType = Form.useWatch("type", form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/alerting/channels").then((x) => x.json());
      setChannels(res?.success ? res.data : []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { if (active) load(); }, [active, load]);

  const openCreate = () => { setEditing(null); form.resetFields(); form.setFieldsValue({ type: "generic" }); setModalOpen(true); };
  const openEdit = (c: any) => {
    setEditing(c);
    form.setFieldsValue({ name: c.name, type: c.type, webhookUrl: undefined, secret: undefined, emailFrom: c.emailFrom, emailTo: (c.emailTo || []).join(", ") });
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!v) return;
    const payload: any = { name: v.name, type: v.type };
    if (v.webhookUrl) payload.webhookUrl = v.webhookUrl;
    if (v.secret) payload.secret = v.secret;
    if (v.emailFrom) payload.emailFrom = v.emailFrom;
    if (v.emailTo) payload.emailTo = String(v.emailTo).split(/[,，\s]+/).filter(Boolean);
    const url = editing ? `/api/alerting/channels/${editing.channelId}` : "/api/alerting/channels";
    const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((x) => x.json());
    if (res?.success) { message.success(editing ? t("通道已更新") : t("通道已创建")); setModalOpen(false); load(); }
    else message.error(res?.error?.message || t("操作失败"));
  };

  const del = async (c: any) => {
    const res = await fetch(`/api/alerting/channels/${c.channelId}`, { method: "DELETE" }).then((x) => x.json());
    if (res?.success) { message.success(t("已删除")); load(); }
  };

  const test = async (c: any) => {
    setTesting(c.channelId);
    try {
      const res = await fetch(`/api/alerting/channels/${c.channelId}/test`, { method: "POST" }).then((x) => x.json());
      if (res?.success && res.data.result?.ok) {
        message.success(t("测试投递成功(HTTP {s})", { s: res.data.result.httpStatus || 200 }));
      } else {
        message.error(t("测试失败：{e}", { e: res?.data?.result?.error || res?.error?.message || t("未知错误") }));
      }
    } finally {
      setTesting(null);
    }
  };

  return (
    <Card
      size="small"
      extra={<Space><Button icon={<ReloadOutlined />} onClick={load} loading={loading}>{t("刷新")}</Button><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t("新建通道")}</Button></Space>}
    >
      <Alert
        type="info" showIcon style={{ marginBottom: 12 }}
        message={t("无需真实 IM 账号也可验证：新建「通用 Webhook」通道，URL 填 <平台域名>/api/public/alerting-sink，即可端到端验证投递。")}
      />
      <Table
        size="small" rowKey="channelId" loading={loading} dataSource={channels}
        locale={{ emptyText: t("暂无通知通道") }} pagination={{ pageSize: 10 }}
        columns={[
          { title: t("通道名称"), dataIndex: "name" },
          { title: t("类型"), dataIndex: "type", render: (v: ChannelType) => <Tag color="cyan">{t(CHANNEL_LABEL[v] || v)}</Tag> },
          { title: t("配置"), key: "cfg", render: (_: any, c: any) => c.type === "email" ? <Text type="secondary">{c.emailFrom} → {(c.emailTo || []).length} {t("人")}</Text> : <Text type="secondary" code>{c.webhookHint || "-"}</Text> },
          { title: t("启用"), dataIndex: "enabled", width: 70, render: (v: boolean) => <Tag color={v ? "green" : "default"}>{v ? t("是") : t("否")}</Tag> },
          {
            title: t("操作"), key: "act", width: 180,
            render: (_: any, c: any) => (
              <Space>
                <Button size="small" loading={testing === c.channelId} onClick={() => test(c)}>{t("发送测试")}</Button>
                <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(c)} />
                <Popconfirm title={t("确认删除该通道？")} onConfirm={() => del(c)} okText={t("删除")} cancelText={t("取消")}>
                  <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal title={editing ? t("编辑通道") : t("新建通道")} open={modalOpen} onOk={submit} onCancel={() => setModalOpen(false)} okText={t("保存")} cancelText={t("取消")} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("通道名称")} rules={[{ required: true, message: t("请输入通道名称") }]}><Input placeholder={t("如：运维值班群")} /></Form.Item>
          <Form.Item name="type" label={t("通道类型")}>
            <Select disabled={!!editing} options={[
              { value: "generic", label: t("通用 Webhook") },
              { value: "dingtalk", label: t("钉钉群机器人") },
              { value: "wecom", label: t("企业微信群机器人") },
              { value: "email", label: t("邮件(SES)") },
            ]} />
          </Form.Item>
          {chType === "email" ? (
            <>
              <Form.Item name="emailFrom" label={t("发件人(须已在 SES 验证)")} rules={[{ required: !editing, message: t("请输入发件人") }]}><Input placeholder="alerts@example.com" /></Form.Item>
              <Form.Item name="emailTo" label={t("收件人(逗号分隔)")} rules={[{ required: !editing, message: t("请输入收件人") }]}><Input placeholder="ops@example.com, oncall@example.com" /></Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="webhookUrl" label={t("Webhook URL")} rules={[{ required: !editing, message: t("请输入 webhook URL") }]}>
                <Input placeholder="https://..." />
              </Form.Item>
              {chType === "dingtalk" && (
                <Form.Item name="secret" label={t("加签密钥 secret(钉钉安全设置选「加签」时必填)")}>
                  <Input.Password placeholder={editing ? t("留空=不修改") : t("可选")} />
                </Form.Item>
              )}
            </>
          )}
          {editing && <Alert type="warning" showIcon message={t("出于安全，webhook URL / secret 不回显；留空表示保持原值，填写则覆盖。")} />}
        </Form>
      </Modal>
    </Card>
  );
}

// ─── 事件 Tab ──────────────────────────────────────────────────────────────
function EventsTab({ active }: { active: boolean }) {
  const t = useT();
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const { scope: evScope, targets: evTargets } = useScope();
  const evScopeParam = toScopeParam(evScope);
  const evScopeQs = evScopeParam ? `?scope=${encodeURIComponent(evScopeParam)}` : "";
  const regionOf = (tid?: string) => (tid ? evTargets?.find((x) => x.targetId === tid)?.region || tid : "");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/alerting/events${evScopeQs}`).then((x) => x.json());
      setEvents(res?.success ? res.data : []);
    } finally {
      setLoading(false);
    }
  }, [evScopeQs]);
  useEffect(() => { if (active) load(); }, [active, load]);

  const statusTag = (s: string) => {
    const map: Record<string, [string, string]> = {
      notified: ["green", t("已通知")], partial: ["orange", t("部分成功")], failed: ["red", t("投递失败")], firing: ["blue", t("触发中")],
    };
    const [color, label] = map[s] || ["default", s];
    return <Tag color={color}>{label}</Tag>;
  };

  return (
    <Card size="small" extra={<Button icon={<ReloadOutlined />} onClick={load} loading={loading}>{t("刷新")}</Button>}>
      <Table
        size="small" rowKey="eventId" loading={loading} dataSource={events}
        locale={{ emptyText: t("暂无告警事件") }} pagination={{ pageSize: 15 }}
        expandable={{
          expandedRowRender: (r: any) => (
            <div style={{ paddingLeft: 8 }}>
              <div style={{ marginBottom: 6 }}><Text strong>{t("投递结果")}</Text></div>
              {(r.channelResults || []).length === 0 ? <Text type="secondary">{t("(该规则未绑定通道)")}</Text> : (
                <Space direction="vertical">
                  {r.channelResults.map((cr: any, i: number) => (
                    <Space key={i}>
                      <Tag color="cyan">{t(CHANNEL_LABEL[cr.channelType as ChannelType] || cr.channelType)}</Tag>
                      <Tag color={cr.ok ? "green" : "red"}>{cr.ok ? t("成功") : t("失败")}</Tag>
                      {cr.httpStatus && <Text type="secondary">HTTP {cr.httpStatus}</Text>}
                      {cr.error && <Text type="danger" style={{ fontSize: 12 }}>{cr.error}</Text>}
                    </Space>
                  ))}
                </Space>
              )}
              {r.diagnosisId && <div style={{ marginTop: 8 }}><Tag color="purple">AI</Tag><Text type="secondary">{t("已挂 AI 诊断")}: {r.diagnosisId}</Text></div>}
            </div>
          ),
        }}
        columns={[
          { title: t("级别"), dataIndex: "severity", width: 70, render: (v: Severity) => <Tag color={SEVERITY_COLOR[v]}>{v}</Tag> },
          { title: t("规则"), dataIndex: "ruleName", width: 160 },
          // 值班第一个问题是「哪个区挂了」⇒ 单独一列
          {
            title: t("执行环境"), dataIndex: "targetId", width: 130,
            render: (v?: string) => (v ? <Tag color="blue">{regionOf(v)}</Tag> : <Tag>{t("全平台合计")}</Tag>),
          },
          { title: t("告警内容"), dataIndex: "message", ellipsis: true, render: (v: string, r: any) => (r.msgKey ? t(r.msgKey, r.msgParams || {}) : v) },
          { title: t("状态"), dataIndex: "status", width: 100, render: statusTag },
          { title: t("时间"), dataIndex: "createdAt", width: 170, render: (v: string) => (v ? v.slice(0, 19).replace("T", " ") : "-") },
        ]}
      />
    </Card>
  );
}
