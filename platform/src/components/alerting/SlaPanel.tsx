"use client";

// SLA 基线预警面板(原 /sla 页,2026-07-13 调度运维收敛并入告警中心作 Tab;
// 功能零删减:SLA CRUD/基线学习与展示/破线预测标签/FeatureGuide)。

// SLA 基线预警。两块:①SLA 定义(选任务/工作流 → 承诺完成时刻 → 预警提前量 → 通道)
// CRUD;②基线只读展示 + 重新学习。破线预测在运行途中由 /api/sla/predict 滚动计算并通道推送。

import React, { useEffect, useState } from "react";
import {
  Card, Table, Tag, Button, Space, Modal, Form, Select, InputNumber, Input,
  Switch, message, Tabs, Tooltip, Segmented, Popconfirm,
} from "antd";
import { PlusOutlined, ReloadOutlined, AlertOutlined, ExperimentOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
// 后台预测周期的单一作者(文案按它换算,不另写一份数字)
import { ALERTING_PUMP_INTERVAL_MS } from "@/lib/alerting/types";
// 2026-11-04(B):错误信封文案的唯一读法(原 `d?.error || …` 把信封对象递给 antd ⇒ React error #31 ⇒ 零提示)
import { errorMessageOf } from "@/lib/http/error-envelope";
import FeatureGuide from "@/components/common/FeatureGuide";
// 「给哪个任务定 SLA」的候选必须按执行范围过滤。
// 🔴 注意本文件里 `targetId` 是**表单字段名**(SLA 绑的任务/工作流 id),与执行目标不是一回事;
// 执行范围一律用下面的 `execScopeQs`,别把两个概念混进同一个名字。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

export default function SlaPanel({ active }: { active: boolean }) {
  const t = useT();
  const { scope } = useScope();
  const execScopeParam = toScopeParam(scope);
  const execScopeQs = execScopeParam ? `?scope=${encodeURIComponent(execScopeParam)}` : "";
  const [slas, setSlas] = useState<any[]>([]);
  const [baselines, setBaselines] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [form] = Form.useForm();
  const [learning, setLearning] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      // 两条都按执行范围
      // SLA 行的区维派生自绑定对象;基线由服务端**摊平成「任务 × 区」**返回(一行一区)。
      fetch(`/api/sla${execScopeQs}`).then((r) => r.json()),
      fetch(`/api/baseline${execScopeQs}`).then((r) => r.json()),
    ]).then(([s, b]) => {
      setSlas(s?.data?.slas || []);
      setBaselines(b?.data?.baselines || []);
    }).finally(() => setLoading(false));
  };

  const loadedRef = React.useRef(false);
  useEffect(() => { if (active && !loadedRef.current) { loadedRef.current = true; load(); } }, [active]);
  // 🔴 切范围要重拉(护栏 4);只在本 Tab 已激活后拉,避免每次切区多打两个没人看的请求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (active && loadedRef.current) load(); }, [execScopeParam]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ targetType: "relative", offsetMinFromTrigger: 90, warnLeadMin: 30, enabled: true, channelIds: [] });
    setModalOpen(true);
    fetch(`/api/backfill/targets${execScopeQs}`).then((r) => r.json()).then((d) => setTargets((d?.data?.targets || []).filter((x: any) => x.scope === "workflow" || x.scope === "task")));
    fetch("/api/alerting/channels").then((r) => r.json()).then((d) => setChannels(d?.data || d?.channels || []));
  };

  const openEdit = (sla: any) => {
    setEditing(sla);
    form.resetFields();
    form.setFieldsValue({
      targetId: sla.target.workflowId || sla.target.taskId,
      name: sla.name, enabled: sla.enabled,
      targetType: sla.target.type,
      offsetMinFromTrigger: sla.target.offsetMinFromTrigger || 90,
      clockTime: sla.target.clockTime || "02:00",
      warnLeadMin: sla.warnLeadMin, channelIds: sla.channelIds || [],
    });
    setModalOpen(true);
    fetch(`/api/backfill/targets${execScopeQs}`).then((r) => r.json()).then((d) => setTargets((d?.data?.targets || [])));
    fetch("/api/alerting/channels").then((r) => r.json()).then((d) => setChannels(d?.data || d?.channels || []));
  };

  const submit = async () => {
    const v = await form.validateFields();
    const tgt = targets.find((x) => x.id === v.targetId);
    const target: any = { type: v.targetType };
    if (v.targetType === "relative") target.offsetMinFromTrigger = v.offsetMinFromTrigger;
    else target.clockTime = v.clockTime;
    if (tgt?.scope === "workflow") target.workflowId = v.targetId; else target.taskId = v.targetId;

    const body: any = { name: v.name, target, warnLeadMin: v.warnLeadMin, channelIds: v.channelIds, enabled: v.enabled };
    let res;
    if (editing) {
      body.version = editing.version;
      res = await fetch(`/api/sla/${editing.slaId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } else {
      res = await fetch("/api/sla", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    const d = await res.json();
    if (!res.ok) { message.error(errorMessageOf(d, t("保存失败"))); return; }
    message.success(editing ? t("已更新") : t("已创建"));
    setModalOpen(false);
    load();
  };

  const del = async (slaId: string) => {
    const res = await fetch(`/api/sla/${slaId}`, { method: "DELETE" });
    if (res.ok) { message.success(t("已删除")); load(); } else { message.error(t("删除失败")); }
  };

  const relearn = async () => {
    setLearning(true);
    try {
      const res = await fetch("/api/baseline/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const d = await res.json();
      if (!res.ok) { message.error(errorMessageOf(d, t("学习失败"))); return; }
      message.success(t("已学习 {n} 个任务基线", { n: d?.data?.learned ?? 0 }));
      load();
    } finally { setLearning(false); }
  };

  const slaColumns = [
    { title: t("名称"), dataIndex: "name", key: "name" },
    { title: t("对象"), key: "scope", render: (_: any, r: any) => <Tag>{r.target?.scope === "workflow" ? t("工作流") : t("任务")}</Tag> },
    {
      title: t("承诺完成时刻"), key: "target", render: (_: any, r: any) =>
        r.target?.type === "relative" ? t("触发后 {m} 分钟", { m: r.target.offsetMinFromTrigger }) : `${t("每日")} ${r.target?.clockTime}`,
    },
    { title: t("预警提前量"), dataIndex: "warnLeadMin", key: "warn", render: (v: number) => t("{m} 分钟", { m: v }) },
    { title: t("通道"), dataIndex: "channelIds", key: "ch", render: (v: string[]) => <span>{(v || []).length}</span> },
    { title: t("启用"), dataIndex: "enabled", key: "enabled", render: (v: boolean) => (v ? <Tag color="success">{t("启用")}</Tag> : <Tag>{t("停用")}</Tag>) },
    {
      title: t("最近预测"), key: "pred", render: (_: any, r: any) => {
        const p = r.lastPrediction;
        if (!p) return <Tag>{t("未运行")}</Tag>;
        return <Tag color={p.riskLevel === "red" ? "error" : p.riskLevel === "yellow" ? "warning" : "success"}>
          {p.willBreach ? t("预测破线") : t("正常")}{p.marginMin != null ? ` (${p.marginMin}m)` : ""}
        </Tag>;
      },
    },
    {
      title: t("操作"), key: "op", render: (_: any, r: any) => <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>{t("编辑")}</Button>
        <Popconfirm title={t("确认删除?")} onConfirm={() => del(r.slaId)}><Button size="small" danger icon={<DeleteOutlined />}>{t("删除")}</Button></Popconfirm>
      </Space>,
    },
  ];

  const baselineColumns = [
    { title: t("任务"), dataIndex: "taskName", key: "taskName", render: (v: string, r: any) => v || r.taskId?.slice(-12) },
    { title: t("类型"), dataIndex: "taskType", key: "taskType", render: (v: string) => v ? <Tag>{v}</Tag> : "—" },
    {
      // 一行一区。`legacy` = 落章之前学出来的基线,
      // 它没有区维,如实标出来而不是冒充成某个区自己的数字。
      title: t("执行区"), key: "targetId", width: 150,
      render: (_: any, r: any) => (
        <Space size={2}>
          <Tag color={r.targetId === "tgt_home" ? "default" : "blue"}>{r.targetId || "tgt_home"}</Tag>
          {r.legacy && <Tag color="warning" data-testid="baseline-legacy">{t("落章前·无区维")}</Tag>}
        </Space>
      ),
    },
    { title: "p50(s)", key: "p50", render: (_: any, r: any) => r.durationSec?.p50 ?? "—" },
    { title: "p90(s)", key: "p90", render: (_: any, r: any) => r.durationSec?.p90 ?? "—" },
    { title: "EWMA(s)", key: "ewma", render: (_: any, r: any) => r.durationSec?.ewma ?? "—" },
    { title: t("样本"), key: "samples", render: (_: any, r: any) => r.durationSec?.samples ?? 0 },
    { title: t("准点率"), key: "punc", render: (_: any, r: any) => `${r.punctuality?.onTimeRate ?? 100}%` },
    { title: t("成功率"), key: "succ", render: (_: any, r: any) => `${r.successRate?.value ?? 100}%` },
    { title: t("置信度"), key: "conf", render: (_: any, r: any) => r.lowConfidence ? <Tag color="warning">{t("冷启动")}</Tag> : <Tag color="success">{t("可用")}</Tag> },
  ];

  const targetType = Form.useWatch("targetType", form);

  return (
    <div>
      <Space style={{ marginBottom: 12, display: "flex", justifyContent: "flex-end" }}>
        <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
      </Space>
        <FeatureGuide
          title={t("SLA 基线预警")}
          what="从历史运行自动学习每个任务的「正常耗时基线」(p50/p90/EWMA),并对配了 SLA 的工作流 / 任务在运行途中由后台自动滚动预测完成时刻(ETA);预计会晚于承诺时刻时,在破线之前就告警,给你处置窗口——而不是破线之后才发现。"
          steps={[
            "先到「动态基线」页点「重新学习基线」,系统从历史运行学出每任务的时长基线(自动排除补数运行)。",
            "在「SLA 定义」页点「新建 SLA」,选一个工作流/任务。",
            "设承诺完成时刻:相对触发(如触发后 90 分钟)或绝对时刻(如每日 02:00)。",
            "设预警提前量(如提前 30 分钟预测到破线就告警)并选通知通道(复用告警中心的通道)。",
            "运行途中后台自动滚动预测(周期见列表上方):预计破线时经通道推送,并在运维大屏「SLA 风险看板」标红。",
          ]}
          tips={[
            "基线学习已排除补数(backfill)运行,并用 MAD 去异常,补数大跑不会拉高基线。",
            "样本不足 7 次的任务标「冷启动」,不触发时长早警,避免新任务误报。",
            "预测破线做多窗口确认(短窗急、长窗稳),单点抖动不误报;同一次运行只推一次(去重)。",
          ]}
        />
        <Tabs
          items={[
            {
              key: "sla", label: t("SLA 定义"),
              children: <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t("新建 SLA")}</Button>
                  <span style={{ color: "var(--bgp-text-dim, #8fb0c2)", fontSize: 13 }} data-testid="sla-auto-predict-hint">
                    {t("后台每 {n} 分钟对在途运行自动预测一次;「最近预测」列随之刷新", { n: Math.max(1, Math.round(ALERTING_PUMP_INTERVAL_MS / 60_000)) })}
                  </span>
                </Space>
                <Table rowKey="slaId" size="small" loading={loading} columns={slaColumns as any} dataSource={slas} pagination={{ pageSize: 10 }} />
              </>,
            },
            {
              key: "baseline", label: t("动态基线"),
              children: <>
                <Space style={{ marginBottom: 12 }}>
                  <Button icon={<ExperimentOutlined />} loading={learning} onClick={relearn}>{t("重新学习基线")}</Button>
                  <Tooltip title={t("从历史运行学习每任务时长基线,已排除补数(backfill)运行,MAD 去异常。")}><a>{t("说明")}</a></Tooltip>
                </Space>
                <Table rowKey="taskId" size="small" loading={loading} columns={baselineColumns as any} dataSource={baselines} pagination={{ pageSize: 10 }} />
              </>,
            },
          ]}
        />

      <Modal title={editing ? t("编辑 SLA") : t("新建 SLA")} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={submit} width={560}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("名称")} rules={[{ required: true, message: t("请输入名称") }]}>
            <Input placeholder={t("如:凌晨批 SLA")} />
          </Form.Item>
          <Form.Item name="targetId" label={t("监控对象")} rules={[{ required: true, message: t("请选择对象") }]}>
            <Select showSearch optionFilterProp="label" disabled={!!editing}
              placeholder={t("选择任务或工作流")}
              options={targets.map((x) => ({ value: x.id, label: `${x.name}（${x.scope === "workflow" ? t("工作流") : x.taskType}）` }))} />
          </Form.Item>
          <Form.Item name="targetType" label={t("承诺时刻类型")}>
            <Segmented options={[{ label: t("相对触发"), value: "relative" }, { label: t("绝对时刻"), value: "absolute" }]} />
          </Form.Item>
          {targetType === "absolute" ? (
            <Form.Item name="clockTime" label={t("完成时刻(UTC,HH:mm)")} rules={[{ pattern: /^\d{1,2}:\d{2}$/, message: "HH:mm" }]}>
              <Input placeholder="02:00" />
            </Form.Item>
          ) : (
            <Form.Item name="offsetMinFromTrigger" label={t("触发后多少分钟内完成")}>
              <InputNumber min={1} max={1440} style={{ width: "100%" }} addonAfter={t("分钟")} />
            </Form.Item>
          )}
          <Form.Item name="warnLeadMin" label={t("预警提前量")} tooltip={t("预计完成时刻距 SLA 少于此值即预警")}>
            <InputNumber min={1} max={720} style={{ width: "100%" }} addonAfter={t("分钟")} />
          </Form.Item>
          <Form.Item name="channelIds" label={t("通知通道")} tooltip={t("复用告警中心的通道")}>
            <Select mode="multiple" placeholder={t("选择通道(可多选)")}
              options={channels.map((c: any) => ({ value: c.channelId, label: `${c.name}（${c.type}）` }))} />
          </Form.Item>
          <Form.Item name="enabled" label={t("启用")} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
