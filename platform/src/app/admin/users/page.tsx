"use client";

import React, { useEffect, useState } from "react";
import { Table, Button, Space, Tag, Modal, Form, Input, Select, message, Popconfirm, Badge } from "antd";
import { PlusOutlined, UserOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { passwordPolicyError } from "@/lib/auth/password-policy";

const roleColor: Record<string, string> = { Admin: "red", Developer: "blue", Viewer: "default" };

export default function UsersPage() {
  const t = useT();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  /** 正在被管理员重置密码的用户(null = 弹窗关着) */
  const [resetUser, setResetUser] = useState<string | null>(null);
  const [resetForm] = Form.useForm();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      const d = await res.json();
      setUsers(Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async () => {
    const values = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!values) return;
    const res = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
    const d = await res.json();
    d.success !== false ? (message.success(t("用户已创建")), setCreateOpen(false), form.resetFields(), fetchUsers()) : message.error(d.error?.message);
  };

  // 🔴 原来不看响应一律提示「操作成功」⇒ 失败也报成功。现在按服务端结果说话。
  const handleAction = async (username: string, action: string, extra?: { role?: string; password?: string }) => {
    const res = await fetch("/api/admin/users", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, action, ...extra }) });
    const d = await res.json().catch(() => ({}));
    const ok = res.ok && d?.success !== false;
    ok ? message.success(t("操作成功")) : message.error(d?.error?.message || t("操作失败"));
    fetchUsers();
    return ok;
  };

  const handleResetPassword = async () => {
    const v = await resetForm.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!v) return;
    if (!resetUser) return;
    if (await handleAction(resetUser, "resetPassword", { password: v.newPassword })) {
      setResetUser(null);
      resetForm.resetFields();
    }
  };

  const columns = [
    { title: t("用户名"), dataIndex: "username", render: (v: string) => <Space><UserOutlined /><b>{v}</b></Space> },
    { title: t("邮箱"), dataIndex: "email" },
    { title: t("角色"), dataIndex: "role", render: (v: string, r: any) => (
      <Select size="small" value={v} style={{ width: 110 }} onChange={(role) => handleAction(r.username, "changeRole", { role })}
        options={[{ label: "Admin", value: "Admin" }, { label: "Developer", value: "Developer" }, { label: "Viewer", value: "Viewer" }]} />
    )},
    { title: t("状态"), key: "status", render: (_: any, r: any) => (
      <Badge status={r.enabled ? "success" : "error"} text={r.enabled ? t("启用") : t("禁用")} />
    )},
    { title: t("创建时间"), dataIndex: "createdAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    { title: t("操作"), key: "action", render: (_: any, r: any) => (
      <Space>
        {r.enabled ? (
          <Popconfirm title={t("确认禁用？")} onConfirm={() => handleAction(r.username, "disable")}><a style={{ color: "red" }}>{t("禁用")}</a></Popconfirm>
        ) : (
          <a onClick={() => handleAction(r.username, "enable")}>{t("启用")}</a>
        )}
        <a data-testid={`user-reset-password-${r.username}`} onClick={() => { resetForm.resetFields(); setResetUser(r.username); }}>{t("重置密码")}</a>
      </Space>
    )},
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><UserOutlined /> {t("用户管理")}</h2>
        <Button type="primary" data-testid="user-create-btn" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("创建用户")}</Button>
      </div>
      <Table columns={columns} dataSource={users} rowKey="username" loading={loading} />

      <Modal title={t("创建用户")} open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="username" label={t("用户名")} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label={t("邮箱")}><Input /></Form.Item>
          <Form.Item name="password" label={t("密码")} rules={[{ required: true, min: 8 }]}><Input.Password /></Form.Item>
          <Form.Item name="role" label={t("角色")} initialValue="Developer">
            <Select options={[{ label: t("Admin - 管理员"), value: "Admin" }, { label: t("Developer - 开发者"), value: "Developer" }, { label: t("Viewer - 只读"), value: "Viewer" }]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t("重置 {name} 的密码", { name: resetUser || "" })}
        open={resetUser !== null}
        onOk={handleResetPassword}
        onCancel={() => setResetUser(null)}
        okText={t("确认重置")}
        okButtonProps={{ "data-testid": "reset-password-ok" } as never}
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical" data-testid="reset-password-form">
          <Form.Item
            name="newPassword"
            label={t("新密码")}
            extra={t("至少 12 位,需包含大写字母、小写字母、数字和符号。设置后立即生效,对方下次登录用新密码")}
            rules={[{ required: true, message: t("请输入新密码") }, { validator: async (_r, v) => { const e = v ? passwordPolicyError(v) : null; if (e) throw new Error(t(e)); } }]}
          >
            <Input.Password autoComplete="new-password" data-testid="reset-password-new" />{/* gitleaks:allow —— 浏览器自动填充提示与测试锚点,不是口令 */}
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t("确认新密码")}
            dependencies={["newPassword"]}
            rules={[{ required: true, message: t("请再次输入新密码") }, ({ getFieldValue }) => ({ validator: async (_r, v) => { if (v && v !== getFieldValue("newPassword")) throw new Error(t("两次输入的新密码不一致")); } })]}
          >
            <Input.Password autoComplete="new-password" data-testid="reset-password-confirm" />{/* gitleaks:allow —— 浏览器自动填充提示与测试锚点,不是口令 */}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
