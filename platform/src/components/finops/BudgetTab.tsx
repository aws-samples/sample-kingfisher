"use client";

// FinOps 预算护栏 + 优化建议:预算 CRUD(乐观锁)+ 烧钱进度 + 确定性建议列表。

import React, { useCallback, useEffect, useState } from "react";
import {
  Button, Card, Form, Input, InputNumber, List, Modal, Popconfirm, Progress,
  Select, Space, Switch, Table, Tag, message,
} from "antd";
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined, BulbOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

interface BudgetRow {
  budgetId: string;
  name: string;
  scope: { kind: string; service?: string };
  monthlyLimitUsd: number;
  channelIds: string[];
  enabled: boolean;
  lastEval?: { month: string; spentUsd: number; pct: number; at: string };
  version: number;
}

interface AdviceRow {
  ruleId: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
  estMonthlySavingUsd?: number;
  resource?: string;
}

const SEV_COLOR: Record<string, string> = { info: "blue", warn: "orange", high: "red" };

export default function BudgetTab() {
  // @kf-batch 50-WP4quater-reads(工单 SC-24)—— 预算与建议都按执行范围。
  // 🔴 只有 `region` 作用域的预算会被范围筛掉;账号 / 服务 / 项目作用域横切所有区,
  // 在单区视角下也必须一直看得见(那条账号总预算恰恰最该看得见)。
  const { scope, targets: scopeTargetList } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const t = useT();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [advice, setAdvice] = useState<AdviceRow[]>([]);
  const [channels, setChannels] = useState<{ channelId: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetRow | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/finops/budgets${scopeQs}`)
      .then((r) => r.json())
      .then((d) => setBudgets(d?.data?.items || []))
      .finally(() => setLoading(false));
  // 🔴 `scopeQs` 进 deps:切范围不重载页面,靠这里重拉(护栏 4)
  }, [scopeQs]);

  const loadAdvice = useCallback(() => {
    setAdviceLoading(true);
    fetch(`/api/finops/advice${scopeQs}`)
      .then((r) => r.json())
      .then((d) => setAdvice(d?.data?.items || []))
      .finally(() => setAdviceLoading(false));
  // 🔴 `scopeQs` 进 deps:切范围不重载页面,靠这里重拉(护栏 4)
  }, [scopeQs]);

  useEffect(() => { load(); loadAdvice(); }, [load, loadAdvice]);

  const openModal = (b: BudgetRow | null) => {
    setEditing(b);
    form.resetFields();
    if (b) {
      form.setFieldsValue({
        name: b.name, scopeKind: b.scope.kind, service: b.scope.service, region: (b.scope as { region?: string }).region,
        monthlyLimitUsd: b.monthlyLimitUsd, channelIds: b.channelIds, enabled: b.enabled,
      });
    } else {
      form.setFieldsValue({ scopeKind: "account", enabled: true, channelIds: [] });
    }
    fetch("/api/alerting/channels").then((r) => r.json()).then((d) => setChannels(d?.data || []));
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const scope =
      v.scopeKind === "service" ? { kind: "service", service: v.service }
      : v.scopeKind === "region" ? { kind: "region", region: v.region }
      : { kind: "account" };
    const body: Record<string, unknown> = {
      name: v.name, scope, monthlyLimitUsd: v.monthlyLimitUsd, channelIds: v.channelIds, enabled: v.enabled,
    };
    let res: Response;
    if (editing) {
      body.version = editing.version;
      res = await fetch(`/api/finops/budgets/${editing.budgetId}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      res = await fetch("/api/finops/budgets", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    }
    const d = await res.json();
    if (res.ok) {
      message.success(editing ? t("预算已更新") : t("预算已创建"));
      setModalOpen(false);
      load();
    } else {
      message.error(d?.error || t("保存失败"));
    }
  };

  const remove = async (b: BudgetRow) => {
    const res = await fetch(`/api/finops/budgets/${b.budgetId}`, { method: "DELETE" });
    if (res.ok) { message.success(t("已删除")); load(); }
  };

  return (
    <div>
      <Card
        size="small"
        title={t("月度预算")}
        extra={
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>{t("新建预算")}</Button>
            <Button icon={<ReloadOutlined />} onClick={load}>{t("刷新")}</Button>
          </Space>
        }
      >
        <Table<BudgetRow>
          rowKey="budgetId"
          size="small"
          loading={loading}
          dataSource={budgets}
          pagination={false}
          columns={[
            { title: t("名称"), dataIndex: "name" },
            { title: t("作用域"), key: "scope", width: 160, render: (_: unknown, b: BudgetRow) => (b.scope.kind === "service" ? <Tag color="blue">{b.scope.service}</Tag> : <Tag>{t("整个账号")}</Tag>) },
            { title: t("月限额"), dataIndex: "monthlyLimitUsd", width: 110, render: (v: number) => `$${v.toFixed(2)}` },
            {
              title: t("本月进度"), key: "pct", width: 220,
              render: (_: unknown, b: BudgetRow) =>
                b.lastEval ? (
                  <Progress
                    percent={Math.min(Math.round(b.lastEval.pct), 100)}
                    size="small"
                    status={b.lastEval.pct >= 100 ? "exception" : b.lastEval.pct >= 80 ? "active" : "normal"}
                    format={() => `$${b.lastEval!.spentUsd.toFixed(2)} (${b.lastEval!.pct.toFixed(0)}%)`}
                  />
                ) : (
                  <Tag>{t("未评估(在成本异常页点「检测并推送」)")}</Tag>
                ),
            },
            { title: t("启用"), dataIndex: "enabled", width: 70, render: (v: boolean) => (v ? <Tag color="green">{t("是")}</Tag> : <Tag>{t("否")}</Tag>) },
            {
              title: t("操作"), key: "ops", width: 140,
              render: (_: unknown, b: BudgetRow) => (
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openModal(b)} />
                  <Popconfirm title={t("确认删除该预算?")} onConfirm={() => remove(b)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        size="small"
        title={<span><BulbOutlined /> {t("优化建议(确定性规则)")}</span>}
        extra={<Button icon={<ReloadOutlined />} onClick={loadAdvice} loading={adviceLoading}>{t("刷新")}</Button>}
        style={{ marginTop: 12 }}
      >
        <List<AdviceRow>
          size="small"
          loading={adviceLoading}
          dataSource={advice}
          locale={{ emptyText: t("暂无建议——当前没有发现可优化项") }}
          renderItem={(a) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Tag color={SEV_COLOR[a.severity]}>{a.severity}</Tag>
                    <span>{a.title}</span>
                    {a.estMonthlySavingUsd ? <Tag color="green">{t("预估月省")} ~${a.estMonthlySavingUsd}</Tag> : null}
                  </Space>
                }
                description={a.detail}
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal
        title={editing ? t("编辑预算") : t("新建预算")}
        open={modalOpen}
        onOk={submit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("名称")} rules={[{ required: true }]}>
            <Input placeholder={t("如:月度总预算")} />
          </Form.Item>
          <Form.Item name="scopeKind" label={t("作用域")} rules={[{ required: true }]}>
            <Select
              options={[
                { value: "account", label: t("整个账号") },
                { value: "service", label: t("单个 AWS 服务") },
                // @kf-batch 50-WP4quater-reads(工单 SC-24)—— 🔴 给**单个执行区**设预算。
                // 用户 2026-09-10 点名「预算护栏仍是全平台合计」;没有这一项就只能设账号总额。
                { value: "region", label: t("单个执行区(如 us-west-2)") },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.scopeKind !== c.scopeKind}>
            {({ getFieldValue }) =>
              getFieldValue("scopeKind") === "service" ? (
                <Form.Item name="service" label={t("服务名(CE 口径)")} rules={[{ required: true }]}>
                  <Input placeholder="AWS Glue" />
                </Form.Item>
              ) : getFieldValue("scopeKind") === "region" ? (
                <Form.Item name="region" label={t("执行区(取自已装的执行环境)")} rules={[{ required: true }]}>
                  <Select
                    options={(scopeTargetList || []).map((x: { targetId: string; region?: string }) => ({
                      value: x.region || x.targetId,
                      label: `${x.region || x.targetId}${x.targetId === "tgt_home" ? ` · ${t("主控区")}` : ""}`,
                    }))}
                    placeholder={t("选择区域")}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="monthlyLimitUsd" label={t("月限额(USD)")} rules={[{ required: true }]}>
            <InputNumber min={0.01} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="channelIds" label={t("告警通道(空=全部启用通道)")}>
            <Select mode="multiple" allowClear options={channels.map((c) => ({ value: c.channelId, label: c.name }))} />
          </Form.Item>
          <Form.Item name="enabled" label={t("启用")} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
