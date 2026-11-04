"use client";

import React, { useEffect, useState } from "react";
import { Card, Table, Tag, Button, Space, Modal, Form, Input, Select, message, Popconfirm, Typography, Alert, Statistic, Row, Col, Checkbox } from "antd";
import { ApiOutlined, PlusOutlined, ThunderboltOutlined, RobotOutlined, GlobalOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";
// 执行范围:技能**定义**是全平台一份
// (用户 2026-09-10 拍板「都走同一个 AgentCore」⇒ 技能全区共用),但**用量与报错按区**
// —— 「这个区的问数把哪个技能调爆了」是运维要看的东西。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";

const { Title, Paragraph, Text } = Typography;

// 内置 MCP 技能的中文说明。
const BUILTIN_DESC: Record<string, string> = {
  run_redshift_sql: "在 Amazon Redshift 执行只读 SQL",
  run_athena_sql: "在 Amazon Athena 查数据湖 S3 Tables(只读)",
  introspect_redshift_schema: "探查 Redshift 表结构",
  introspect_s3tables_schema: "探查 S3 Tables 结构",
  lookup_business_context: "查询业务口径/术语/规则",
  list_registered_skills: "列出已注册的业务技能",
  run_registered_skill: "按名执行已注册的业务技能",
};

export default function SkillsPage() {
  const t = useT();
  const { getToken, user, loading: authLoading } = useAuth();
  const [obs, setObs] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const kind = Form.useWatch("kind", form);

  // 未登录/401 的跳转由全局 middleware(/api/* 鉴权) + layoutClient(顶层未登录守卫,按 loading 结束
  // 的正确时序重定向)统一处理。页面里**不再自己 router.push("/login")**——那会重置路由树、把
  // MultiTabs keep-alive 的其他已开页签清零(切到本页的 auth 竞态窗口曾触发此清零 bug)。
  const authedFetch = async (url: string, init?: RequestInit) => {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
    if (res.status === 401) return null;
    return res;
  };

  const load = async () => {
    setLoading(true);
    try {
      // 用量按区(技能清单本身全平台一份,不带 scope)
      const [o, s] = await Promise.all([authedFetch(`/api/observability/genbi${scopeQs}`), authedFetch("/api/genbi/skills")]);
      if (o) { const d = await o.json(); setObs(d?.success ? d.data : null); }
      if (s) { const d = await s.json(); setSkills(d?.success ? d.data : []); }
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layoutClient 守卫重定向;此处不硬跳(避免重置路由树清空其他页签)
    (async () => { const tok = await getToken(); if (tok) { try { const p = JSON.parse(atob(tok.split(".")[1] || "")); setIsAdmin((p["cognito:groups"] || []).includes("bgp-admin")); } catch {} } })();
    load();
    // eslint-disable-next-line
    // 切区不重载页面,重拉用量(护栏 4)
  }, [authLoading, user, scopeQs]);

  const parseParams = (paramsText: string) => {
    if (!paramsText || !paramsText.trim()) return [];
    // 每行一个参数:  name:type:描述  (type: string|number|identifier)
    return paramsText.split(/\n+/).map((ln: string) => ln.trim()).filter(Boolean).map((ln: string) => {
      const [name, type, ...rest] = ln.split(":");
      return { name: (name || "").trim(), type: ["number", "identifier"].includes((type || "").trim()) ? (type || "").trim() : "string", description: rest.join(":").trim(), required: true };
    }).filter((p: any) => p.name);
  };

  const submit = async () => {
    let v: any;
    try { v = await form.validateFields(); } catch { return; }
    const params = parseParams(v.paramsText);
    const isHttp = v.kind === "http";
    let http: any = undefined;
    if (isHttp) {
      let headers: Record<string, string> | undefined;
      if (v.headersText && v.headersText.trim()) {
        try { headers = JSON.parse(v.headersText); } catch { message.error(t("请求头必须是合法 JSON 对象")); return; }
      }
      http = { method: v.method || "GET", urlTemplate: (v.urlTemplate || "").trim(), headers, bodyTemplate: v.bodyTemplate || undefined, resultPath: v.resultPath || undefined };
    }
    setSubmitting(true);
    try {
      const res = await authedFetch("/api/genbi/skills", {
        method: "POST",
        body: JSON.stringify({
          name: v.name, description: v.description, kind: v.kind || "sql",
          engine: v.engine, sqlTemplate: isHttp ? undefined : v.sqlTemplate, http,
          params, global: !!v.global,
        }),
      });
      if (!res) return;
      const d = await res.json();
      if (d?.success) { message.success(t("已注册技能(后续问数会话自动可用)")); setOpen(false); form.resetFields(); load(); }
      else message.error(d?.error?.message || t("注册失败"));
    } finally { setSubmitting(false); }
  };

  const del = async (r: any) => {
    const res = await authedFetch(`/api/genbi/skills/${r.skillId}?projectId=${encodeURIComponent(r.projectId)}`, { method: "DELETE" });
    if (!res) return;
    const d = await res.json();
    d?.success ? (message.success(t("已删除")), load()) : message.error(d?.error?.message || t("删除失败"));
  };

  const ac = obs?.agentcore;
  const builtinTools: string[] = ac?.tools || [];
  const total = builtinTools.length + skills.length;
  // 24h 调用计数（EMF）。
  const perTool: Record<string, { calls: number; errors: number }> = {};
  for (const tc of (obs?.toolCalls?.perTool || [])) perTool[tc.tool] = { calls: tc.calls, errors: tc.errors };
  const perSkill: Record<string, { calls: number; errors: number }> = {};
  for (const s of (obs?.toolCalls?.perSkill || [])) perSkill[s.skill] = { calls: s.calls, errors: s.errors };
  const callTag = (c?: { calls: number; errors: number }) => {
    if (!c) return <Tag>{t("{n} 次", { n: 0 })}</Tag>;
    return (
      <Space size={4}>
        <Tag color={c.calls > 0 ? "blue" : "default"}>{t("{n} 次", { n: c.calls })}</Tag>
        {c.errors > 0 ? <Tag color="red">{t("{n} 错", { n: c.errors })}</Tag> : null}
      </Space>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Title level={3} style={{ marginBottom: 0 }}><ApiOutlined /> {t("技能 Skills")}</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>{t("注册技能")}</Button>
      </div>
      <Paragraph type="secondary">
        {t("智能问数 Agent(Amazon Bedrock AgentCore)可用的技能。")}<strong>{t("内置 MCP 技能")}</strong>{t("由平台提供；")}<strong>{t("注册技能")}</strong>{t("是数据驱动的参数化只读查询(SQL 模板或 HTTP 外部 API)，注册后")}<strong>{t("后续会话自动加载、零部署")}</strong>{t("，Agent 通过 ")}<code>run_registered_skill</code>{t(" 按名调用。调用次数来自 CloudWatch(EMF，近 24h)。")}
      </Paragraph>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title={t("技能总数")} value={total} valueStyle={{ color: "#22d3ee" }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t("内置 MCP 技能")} value={builtinTools.length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t("注册技能")} value={skills.length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t("技能调用 (24h)")} value={obs?.toolCalls?.totalCalls ?? 0} suffix={t("次")} valueStyle={{ color: "#a371f7" }} /></Card></Col>
      </Row>

      <Card size="small" title={<span><RobotOutlined /> {t("内置 MCP 技能（{n}）", { n: builtinTools.length })}</span>} style={{ marginBottom: 16 }}>
        <Table size="small" rowKey="name" pagination={false} dataSource={builtinTools.map((tool) => ({ name: tool, desc: t(BUILTIN_DESC[tool] || "") }))}
          columns={[
            { title: t("技能(工具)"), dataIndex: "name", render: (v: string) => <Tag color="purple"><ApiOutlined /> {v}</Tag> },
            { title: t("说明"), dataIndex: "desc" },
            { title: t("调用(24h)"), key: "calls", width: 140, render: (_: any, r: any) => callTag(perTool[r.name]) },
            { title: t("来源"), key: "src", width: 100, render: () => <Tag>{t("平台内置")}</Tag> },
          ]} />
      </Card>

      <Card size="small" title={<span><ThunderboltOutlined /> {t("注册技能 — 数据驱动/热加载（{n}）", { n: skills.length })}</span>}>
        <Table size="small" rowKey="skillId" loading={loading} pagination={{ pageSize: 10 }} dataSource={skills}
          locale={{ emptyText: t("暂无注册技能，点「注册技能」添加(参数化只读查询 / HTTP 外部 API，注册即生效)") }}
          columns={[
            { title: t("技能名"), dataIndex: "name", width: 180, render: (v: string) => <b>{v}</b> },
            { title: t("说明"), dataIndex: "description" },
            { title: t("类型"), dataIndex: "kind", width: 130, render: (v: string) => v === "http" ? <Tag color="volcano"><GlobalOutlined /> HTTP API</Tag> : <Tag color="cyan">{t("SQL 模板")}</Tag> },
            { title: t("引擎/目标"), key: "engine", width: 110, render: (_: any, r: any) => r.kind === "http" ? <Text type="secondary" style={{ fontSize: 12 }}>{(r.http?.method || "GET")} {t("外部")}</Text> : <Tag color={r.engine === "athena" ? "gold" : "cyan"}>{r.engine === "athena" ? t("数据湖") : t("数据仓库")}</Tag> },
            { title: t("参数"), dataIndex: "params", width: 150, render: (ps: any[]) => (ps || []).map((p) => <Tag key={p.name}>{p.name}:{p.type}</Tag>) },
            { title: t("调用(24h)"), key: "calls", width: 130, render: (_: any, r: any) => callTag(perSkill[r.name]) },
            { title: t("范围"), dataIndex: "projectId", width: 80, render: (v: string) => v === "global" ? <Tag color="red">{t("全局")}</Tag> : <Tag>{t("本项目")}</Tag> },
            { title: t("操作"), key: "act", width: 70, render: (_: any, r: any) => <Popconfirm title={t("删除该技能?")} onConfirm={() => del(r)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm> },
          ]} />
      </Card>

      <Modal title={t("注册一个业务技能")} open={open} onOk={submit} confirmLoading={submitting} onCancel={() => setOpen(false)} okText={t("注册")} width={720}>
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t("技能=经审核的参数化调用(用 {{参数名}} 占位)。注册后 Agent 经 run_registered_skill 按名调用,后续会话自动可用、无需部署。SQL 模板经只读守卫；HTTP 外部 API 经 SSRF 守卫(仅 https、域名白名单、拒绝内网地址)且仅平台管理员可注册。")} />
        <Form form={form} layout="vertical" initialValues={{ kind: "sql", engine: "redshift", method: "GET" }}>
          <Form.Item name="kind" label={t("技能类型")} rules={[{ required: true }]}>
            <Select options={[
              { value: "sql", label: t("SQL 模板（只读 SELECT / WITH）") },
              { value: "http", label: t("HTTP 外部 API（仅平台管理员）"), disabled: !isAdmin },
            ]} />
          </Form.Item>
          <Form.Item name="name" label={t("技能名(英文/下划线)")} rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,48}$/i, message: t("字母开头的英文/下划线,2-49字符") }]}><Input placeholder={t("如：top_customers_by_region / fx_rate")} /></Form.Item>
          <Form.Item name="description" label={t("用途说明(给模型看)")} rules={[{ required: true }]}><Input placeholder={t("如：按地区返回客户数 TOP N / 查询某币种实时汇率")} /></Form.Item>

          {kind === "http" ? (
            <>
              <Form.Item name="method" label={t("HTTP 方法")} rules={[{ required: true }]}>
                <Select options={["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => ({ value: m, label: m }))} />
              </Form.Item>
              <Form.Item name="urlTemplate" label={t("URL 模板(https://，路径/查询可用 {{参数}}；主机名不可含占位符)")} rules={[{ required: true, pattern: /^https:\/\//i, message: t("必须以 https:// 开头") }]}>
                <Input placeholder={t("如：https://api.example.com/fx?base=CNY&symbol={{symbol}}")} />
              </Form.Item>
              <Form.Item name="headersText" label={t("请求头(可选, JSON 对象)")}>
                <Input.TextArea rows={2} placeholder={'{"Authorization": "Bearer xxx"}'} />
              </Form.Item>
              <Form.Item name="bodyTemplate" label={t('请求体模板(可选, 仅 POST/PUT/PATCH; JSON 中字符串参数写成 "{{参数}}")')}>
                <Input.TextArea rows={2} placeholder={'{"query": "{{q}}", "limit": {{n}}}'} />
              </Form.Item>
              <Form.Item name="resultPath" label={t("结果路径(可选, JSON 点路径定位数组/对象)")}>
                <Input placeholder={t("如：data.items")} />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="engine" label={t("引擎")} rules={[{ required: true }]}>
                <Select options={[{ value: "redshift", label: t("数据仓库 (Redshift)") }, { value: "athena", label: t("数据湖 (Athena / S3 Tables)") }]} />
              </Form.Item>
              <Form.Item name="sqlTemplate" label={t("只读 SQL 模板(用 {{参数}} 占位)")} rules={[{ required: true }]}>
                <Input.TextArea rows={4} placeholder={t("如：SELECT region, COUNT(*) AS n FROM public.customers GROUP BY region ORDER BY n DESC LIMIT {{topn}}")} />
              </Form.Item>
            </>
          )}

          <Form.Item name="paramsText" label={t("参数声明(每行一个: 名称:类型:说明; 类型=string|number|identifier)")}>
            <Input.TextArea rows={2} placeholder={t("topn:number:返回前 N 个地区")} />
          </Form.Item>
          {isAdmin && <Form.Item name="global" valuePropName="checked"><Checkbox>{t("设为全局通用技能(所有项目可用,仅平台管理员)")}</Checkbox></Form.Item>}
        </Form>
      </Modal>
    </div>
  );
}
