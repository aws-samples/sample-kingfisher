"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Table, Tag, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Typography, Alert, Checkbox } from "antd";
import { ReadOutlined, PlusOutlined, BulbOutlined, ThunderboltOutlined, MessageOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";

const { Title, Paragraph, Text } = Typography;

const KIND_META: Record<string, { label: string; color: string }> = {
  caliber: { label: "口径/指标定义", color: "purple" },
  term: { label: "术语/别名", color: "cyan" },
  rule: { label: "规则/注意事项", color: "gold" },
};

export default function KnowledgePage() {
  const t = useT();
  const router = useRouter();
  const { getToken, user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null); // 非 null = 编辑模式,存被编辑条目
  const [submitting, setSubmitting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [form] = Form.useForm();

  const authedFetch = async (url: string, init?: RequestInit) => {
    const token = await getToken();
    if (!token) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    const res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
    if (res.status === 401) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    return res;
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/genbi/context");
      if (!res) return;
      const d = await res.json();
      setRows(d?.success ? d.data : []);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    (async () => { const tok = await getToken(); if (tok) { try { const p = JSON.parse(atob(tok.split(".")[1] || "")); setIsAdmin((p["cognito:groups"] || []).includes("bgp-admin")); } catch {} } })();
    load();
    // eslint-disable-next-line
  }, [authLoading, user]);

  // 打开新建 / 编辑弹窗:编辑时回填表单(tags 数组转回逗号串以复用同一输入框)。
  const openCreate = () => { setEditing(null); form.resetFields(); setOpen(true); };
  const openEdit = (r: any) => {
    setEditing(r);
    form.setFieldsValue({ kind: r.kind, title: r.title, body: r.body, scope: r.scope || "", tags: (r.tags || []).join(", ") });
    setOpen(true);
  };

  const submit = async () => {
    let v: any;
    try { v = await form.validateFields(); } catch { return; }
    setSubmitting(true);
    try {
      const tags = v.tags ? String(v.tags).split(/[，,\s]+/).filter(Boolean) : [];
      // 编辑走 PUT /api/genbi/context/[id](权限:global 仅管理员、项目 editor);新建走 POST。
      const res = editing
        ? await authedFetch(`/api/genbi/context/${editing.entryId}`, {
            method: "PUT",
            body: JSON.stringify({ projectId: editing.projectId, kind: v.kind, title: v.title, body: v.body, scope: v.scope, tags }),
          })
        : await authedFetch("/api/genbi/context", {
            method: "POST",
            body: JSON.stringify({ kind: v.kind, title: v.title, body: v.body, scope: v.scope, tags, global: !!v.global }),
          });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { message.success(editing ? t("已保存") : t("已添加")); setOpen(false); setEditing(null); form.resetFields(); load(); }
      else message.error(d?.error?.message || (editing ? t("保存失败") : t("添加失败")));
    } finally { setSubmitting(false); }
  };

  // 管理员一键预置 global 通用业务口径/术语/规则(GMV/活跃用户/留存/金额单位/测试数据排除…),
  // 让新环境「业务口径与规则」开箱即用。幂等 upsert,重复点只更新不重复建。
  const seed = async () => {
    setSeeding(true);
    try {
      const res = await authedFetch("/api/genbi/context/seed", { method: "POST" });
      if (!res) return;
      const d = await res.json();
      if (d?.success) {
        const c = d.data?.createdCount ?? 0, u = d.data?.updatedCount ?? 0;
        message.success(t("已预置通用口径（新建 {c}，更新 {u}）", { c, u }));
        load();
      } else message.error(d?.error?.message || t("预置失败"));
    } finally { setSeeding(false); }
  };

  const del = async (r: any) => {
    const res = await authedFetch(`/api/genbi/context/${r.entryId}?projectId=${encodeURIComponent(r.projectId)}`, { method: "DELETE" });
    if (!res) return;
    const d = await res.json();
    d?.success ? (message.success(t("已删除")), load()) : message.error(d?.error?.message || t("删除失败"));
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><ReadOutlined /> {t("业务口径与规则")}</Title>
        <Space>
          <Button icon={<MessageOutlined />} onClick={() => router.push("/genbi")}>{t("去智能问数试试")}</Button>
          {isAdmin && <Button icon={<ThunderboltOutlined />} loading={seeding} onClick={seed}>{t("预置通用口径")}</Button>}
          <Button type="primary" data-testid="kb-create-btn" icon={<PlusOutlined />} onClick={openCreate}>{t("新建条目")}</Button>
        </Space>
      </div>
      <Paragraph type="secondary">
        {t("维护业务")}<strong>{t("口径/指标定义")}</strong>{t("、")}<strong>{t("术语别名")}</strong>{t("、")}<strong>{t("规则/注意事项")}</strong>{t("。这些知识会作为技能 ")}<code>lookup_business_context</code>{t(" 提供给智能问数（GenBI）与 Copilot，并注入代码生成/故障诊断提示——让生成的 SQL/代码遵循正确的业务口径与规则（如金额单位、特定叫法、需排除的状态、测试数据标记等）。")}<strong>{t("验证方法：")}</strong>{t("在智能问数里用你定义的术语提问（如「统计大R玩家」），回答区会显示「本次参考了 N 条业务口径」。")}
      </Paragraph>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message={<span><BulbOutlined /> {t("例：「GMV = 已支付订单金额合计，排除 status='cancelled'」「金额字段单位为分，展示需 /100」「活跃用户口径=近30天有下单的客户」「QAREG 开头为测试数据，分析时排除」")}</span>} />

      <Card>
        <Table rowKey="entryId" loading={loading} dataSource={rows} pagination={{ pageSize: 12 }}
          columns={[
            { title: t("类型"), dataIndex: "kind", width: 130, render: (k: string) => <Tag color={KIND_META[k]?.color}>{KIND_META[k] ? t(KIND_META[k].label) : k}</Tag> },
            { title: t("名称"), dataIndex: "title", width: 200, render: (v: string) => <b>{v}</b> },
            { title: t("定义 / 内容"), dataIndex: "body", render: (v: string) => <span style={{ whiteSpace: "pre-wrap" }}>{v}</span> },
            { title: t("适用范围"), dataIndex: "scope", width: 140, render: (v: string) => v || <Text type="secondary">—</Text> },
            { title: t("范围"), dataIndex: "projectId", width: 90, render: (v: string) => v === "global" ? <Tag color="red">{t("全局")}</Tag> : <Tag>{t("本项目")}</Tag> },
            { title: t("标签"), dataIndex: "tags", width: 140, render: (tb: string[]) => (tb || []).map((x) => <Tag key={x}>{x}</Tag>) },
            { title: t("操作"), key: "act", width: 130, render: (_: any, r: any) => {
              // global 条目仅平台管理员可改/删(与后端一致);项目条目项目成员可改/删。
              const canModify = r.projectId !== "global" || isAdmin;
              return (
                <Space size="small">
                  <a onClick={() => canModify && openEdit(r)} style={{ color: canModify ? undefined : "#666", cursor: canModify ? "pointer" : "not-allowed" }}>{t("编辑")}</a>
                  {canModify
                    ? <Popconfirm title={t("删除该条目?")} onConfirm={() => del(r)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm>
                    : <span style={{ color: "#666" }}>{t("删除")}</span>}
                </Space>
              );
            } },
          ]} />
      </Card>

      <Modal title={editing ? t("编辑业务口径 / 术语 / 规则") : t("新建业务口径 / 术语 / 规则")} open={open} onOk={submit} confirmLoading={submitting} onCancel={() => { setOpen(false); setEditing(null); }} okText={t("保存")} width={600}>
        <Form form={form} layout="vertical">
          <Form.Item name="kind" label={t("类型")} initialValue="caliber" rules={[{ required: true }]}>
            <Select options={[{ value: "caliber", label: t("口径/指标定义") }, { value: "term", label: t("术语/别名") }, { value: "rule", label: t("规则/注意事项") }]} />
          </Form.Item>
          <Form.Item name="title" label={t("名称")} rules={[{ required: true, message: t("请填写名称") }]}>
            <Input placeholder={t("如：GMV / 活跃用户 / 金额单位 / 测试数据排除")} maxLength={80} />
          </Form.Item>
          <Form.Item name="body" label={t("定义 / 内容")} rules={[{ required: true, message: t("请填写定义或规则内容") }]}>
            <Input.TextArea rows={4} placeholder={t("如：GMV = 已支付订单(status='paid')的 amount 合计；amount 单位为分，展示需 /100。")} />
          </Form.Item>
          <Form.Item name="scope" label={t("适用范围(可选)")}><Input placeholder={t("如：orders 表 / Redshift / 销售分析")} /></Form.Item>
          <Form.Item name="tags" label={t("标签(可选,逗号分隔)")}><Input placeholder={t("如：销售,口径,金额")} /></Form.Item>
          {/* global 勾选仅新建时有意义(编辑不改归属:projectId 是主键不可变)。 */}
          {isAdmin && !editing && <Form.Item name="global" valuePropName="checked"><Checkbox>{t("设为全局通用条目(所有项目可见,仅平台管理员)")}</Checkbox></Form.Item>}
        </Form>
      </Modal>
    </div>
  );
}
