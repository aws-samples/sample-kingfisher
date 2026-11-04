"use client";

// Copilot 工程配方库(管理页)。系统内嵌配方【只读】展示;管理员可【新增/删除】企业特有配方。
// 权限:所有登录用户可看(规划大脑用同一套);仅平台管理员见"新增/删除"(canManage 由后端 GET 回传,
// 写操作后端 isPlatformAdmin 二次鉴权,前端隐藏只是体验,真正拦截在 API)。

import React, { useEffect, useState, useCallback } from "react";
import { Card, Table, Tag, Button, Space, Modal, Form, Input, Select, message, Typography, Tooltip, Alert } from "antd";
import { PlusOutlined, DeleteOutlined, ReloadOutlined, LockOutlined, BookOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";

const { Text, Paragraph } = Typography;

interface RecipeItem {
  id: string; engine: string; capability: string; title: string; whenToUse: string;
  template: string; dialectNotes?: string[]; tags?: string[];
  source: "system" | "admin"; readonly: boolean; recipeId?: string; createdBy?: string;
}

export default function RecipeLibrary() {
  const t = useT();
  const [engines, setEngines] = useState<string[]>([]);
  const [rows, setRows] = useState<RecipeItem[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();

  const fetchRecipes = useCallback(() => {
    setLoading(true);
    fetch("/api/copilot/recipes")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success) {
          setEngines(d.data.engines || []);
          setRows([...(d.data.system || []), ...(d.data.admin || [])]);
          setCanManage(!!d.data.canManage);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchRecipes(); }, [fetchRecipes]);

  const addRecipe = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const res = await fetch("/api/copilot/recipes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...v, tags: v.tags ? String(v.tags).split(",").map((x: string) => x.trim()).filter(Boolean) : [] }),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("已新增配方")); setAddOpen(false); form.resetFields(); fetchRecipes(); }
    else message.error(d?.error?.message || d?.error || t("新增失败"));
  };

  const delRecipe = (row: RecipeItem) => {
    Modal.confirm({
      title: t("删除配方?"), content: `${row.engine} / ${row.title}`,
      okText: t("删除"), okButtonProps: { danger: true },
      onOk: async () => {
        const res = await fetch(`/api/copilot/recipes/${row.recipeId}?engine=${row.engine}`, { method: "DELETE" });
        const d = await res.json();
        if (d?.success) { message.success(t("已删除")); fetchRecipes(); }
        else message.error(d?.error?.message || d?.error || t("删除失败"));
      },
    });
  };

  const columns = [
    { title: t("引擎"), dataIndex: "engine", width: 100, render: (e: string) => <Tag color="cyan">{e}</Tag> },
    { title: t("能力"), dataIndex: "capability", width: 130 },
    { title: t("标题"), dataIndex: "title" },
    {
      title: t("来源"), dataIndex: "source", width: 100,
      render: (s: string) => s === "system"
        ? <Tag icon={<LockOutlined />} color="default">{t("系统内置")}</Tag>
        : <Tag color="blue">{t("管理员")}</Tag>,
    },
    {
      title: t("操作"), width: 90,
      render: (_: any, row: RecipeItem) =>
        row.source === "admin" && canManage
          ? <Button size="small" danger icon={<DeleteOutlined />} onClick={() => delRecipe(row)} data-testid="recipe-del" />
          : <Tooltip title={t("系统内置配方随平台分发,不可修改")}><LockOutlined style={{ color: "#8fb0c2" }} /></Tooltip>,
    },
  ];

  return (
    <Card
      size="small"
      title={<Space><BookOutlined />{t("工程配方库")}</Space>}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchRecipes} loading={loading} />
          {canManage && <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)} data-testid="recipe-add">{t("新增配方")}</Button>}
        </Space>
      }
    >
      <Alert
        type="info" showIcon style={{ marginBottom: 12 }}
        message={t("配方库 = 平台验证过的引擎工程范式(方言规则 + 代码模板)。Copilot 规划大脑生成 SQL/代码前会查阅,从源头写对。系统内置配方随平台分发、只读;管理员可新增企业特有范式。")}
      />
      <Table
        size="small" rowKey="id" loading={loading} columns={columns as any} dataSource={rows}
        pagination={{ pageSize: 10 }}
        expandable={{
          expandedRowRender: (row: RecipeItem) => (
            <div style={{ padding: "4px 8px" }}>
              {row.whenToUse && <Paragraph style={{ marginBottom: 6 }}><Text type="secondary">{t("何时用")}:</Text> {row.whenToUse}</Paragraph>}
              {(row.dialectNotes || []).length > 0 && (
                <Paragraph style={{ marginBottom: 6 }}>
                  <Text type="secondary">{t("方言注意")}:</Text>
                  <ul style={{ margin: "4px 0 0 0", paddingLeft: 18 }}>{row.dialectNotes!.map((n, i) => <li key={i} style={{ fontSize: 12 }}>{n}</li>)}</ul>
                </Paragraph>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>{t("代码模板")}:</Text>
              <pre style={{ background: "rgba(0,0,0,0.25)", padding: 10, borderRadius: 6, fontSize: 12, overflowX: "auto", marginTop: 4 }}>{row.template}</pre>
            </div>
          ),
        }}
      />

      <Modal title={t("新增配方(管理员)")} open={addOpen} onCancel={() => setAddOpen(false)} onOk={addRecipe} okText={t("保存")} width={640}>
        <Form form={form} layout="vertical">
          <Form.Item name="engine" label={t("引擎")} rules={[{ required: true }]}>
            <Select options={engines.map((e) => ({ label: e, value: e }))} placeholder={t("选择引擎")} />
          </Form.Item>
          <Form.Item name="capability" label={t("能力标签")} rules={[{ required: true }]}>
            <Input placeholder={t("如 aggregate / upsert / s3table-write")} />
          </Form.Item>
          <Form.Item name="title" label={t("标题")} rules={[{ required: true }]}>
            <Input placeholder={t("如:Redshift 聚合建表(CTAS)")} />
          </Form.Item>
          <Form.Item name="whenToUse" label={t("何时用")}>
            <Input placeholder={t("给 AI 判断何时命中此配方")} />
          </Form.Item>
          <Form.Item name="template" label={t("代码模板")} rules={[{ required: true }]}>
            <Input.TextArea rows={8} placeholder={t("验证过的 SQL/代码范式(可含占位符)")} />
          </Form.Item>
          <Form.Item name="tags" label={t("检索标签(逗号分隔)")}>
            <Input placeholder="roi, conversion, aggregate" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
