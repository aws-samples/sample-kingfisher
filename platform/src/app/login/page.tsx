"use client";

import React, { useState } from "react";
import { Form, Input, Button, Card, message, Typography } from "antd";
import { UserOutlined, LockOutlined } from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import { useBuildInfo, BuildLabel } from "@/components/common/BuildInfo"; // 页脚一行「哪一版」

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const t = useT();
  const buildInfo = useBuildInfo();

  const handleSubmit = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success(t("登录成功"));
      router.push("/");
    } catch (err: any) {
      message.error(err.message || t("登录失败"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "transparent" }}>
      <Card style={{ width: 400, background: "rgba(14,22,40,0.72)", border: "1px solid rgba(34,211,238,0.22)", boxShadow: "0 0 40px rgba(34,211,238,0.12)" }}>
        <Typography.Title level={3} style={{ textAlign: "center", color: "#22d3ee", letterSpacing: 1 }}>Kingfisher</Typography.Title>
        <Form onFinish={handleSubmit} layout="vertical">
          <Form.Item name="username" rules={[{ required: true, message: t("请输入用户名") }]}>
            <Input prefix={<UserOutlined />} placeholder={t("用户名")} size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: t("请输入密码") }]}>
            <Input.Password prefix={<LockOutlined />} placeholder={t("密码")} size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">{t("登录")}</Button>
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ display: "block", textAlign: "center" }}>
          {t("未配置 Cognito 时可直接访问各页面")}
        </Typography.Text>
        {/* 登录前就能只读核版(运维 / 升级对账第一眼):发版 tag,或未发版构建的产品提交 */}
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 12 }}>
          <BuildLabel info={buildInfo} />
        </div>
      </Card>
    </div>
  );
}
