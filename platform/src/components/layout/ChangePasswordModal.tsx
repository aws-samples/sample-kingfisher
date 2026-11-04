"use client";
// 登录用户在页面上修改自己的密码(用户 2026-10-09:「MFA 暂时不需要,只要能允许管理员能在页面自己修改密码即可」)。
// 走 Cognito ChangePassword(先校验当前密码);前端预校验与用户池策略同口径(infra/lib/auth-stack.ts:
// ≥12 位 + 大小写 + 数字 + 符号),最终以 Cognito 服务端为准(它拒绝时把原因如实显示)。
import React, { useState } from "react";
import { Modal, Form, Input, message } from "antd";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";
import { passwordPolicyError } from "@/lib/auth/password-policy";

function cognitoReason(e: unknown): string {
  const name = String((e as { name?: string; code?: string })?.code || (e as { name?: string })?.name || "");
  if (name === "NotAuthorizedException") return "当前密码不正确";
  if (name === "InvalidPasswordException") return "新密码不符合密码策略";
  if (name === "LimitExceededException") return "尝试次数过多,请稍后再试";
  return String((e as Error)?.message || e);
}

export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { changePassword } = useAuth();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await changePassword(v.oldPassword, v.newPassword);
      message.success(t("密码已修改,下次登录请使用新密码"));
      form.resetFields();
      onClose();
    } catch (e) {
      message.error(t("修改密码失败:{reason}", { reason: t(cognitoReason(e)) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("修改密码")}
      okText={t("确认修改")}
      cancelText={t("取消")}
      confirmLoading={saving}
      onOk={submit}
      onCancel={() => { form.resetFields(); onClose(); }}
      destroyOnClose
      okButtonProps={{ "data-testid": "change-password-ok" } as never}
    >
      <Form form={form} layout="vertical" data-testid="change-password-form">
        <Form.Item name="oldPassword" label={t("当前密码")} rules={[{ required: true, message: t("请输入当前密码") }]}>
          <Input.Password autoComplete="current-password" data-testid="change-password-old" />{/* gitleaks:allow —— 浏览器自动填充提示与测试锚点,不是口令 */}
        </Form.Item>
        <Form.Item
          name="newPassword"
          label={t("新密码")}
          extra={t("至少 12 位,需包含大写字母、小写字母、数字和符号")}
          rules={[
            { required: true, message: t("请输入新密码") },
            { validator: async (_r, value) => { const e = value ? passwordPolicyError(String(value)) : null; if (e) throw new Error(t(e)); } },
          ]}
        >
          <Input.Password autoComplete="new-password" data-testid="change-password-new" />{/* gitleaks:allow —— 浏览器自动填充提示与测试锚点,不是口令 */}
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label={t("确认新密码")}
          dependencies={["newPassword"]}
          rules={[
            { required: true, message: t("请再次输入新密码") },
            ({ getFieldValue }) => ({ validator: async (_r, value) => { if (value && value !== getFieldValue("newPassword")) throw new Error(t("两次输入的新密码不一致")); } }),
          ]}
        >
          <Input.Password autoComplete="new-password" data-testid="change-password-confirm" />{/* gitleaks:allow —— 浏览器自动填充提示与测试锚点,不是口令 */}
        </Form.Item>
      </Form>
    </Modal>
  );
}
