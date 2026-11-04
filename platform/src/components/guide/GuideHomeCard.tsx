"use client";
// 首页「新手引导」卡:三个入口(打开操作指引 / 去项目空间 / 去执行环境)。用户 2026-09-06:「现在的系统没几个人会用」。
import React from "react";
import { Button, Card, Space, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import { useGuide } from "./GuideProvider";

const { Text } = Typography;

export default function GuideHomeCard() {
  const t = useT();
  const router = useRouter();
  const { openGuide, startTour } = useGuide();
  return (
    <Card size="small" style={{ marginBottom: 16 }} data-testid="guide-home-card">
      <Space wrap align="center" size={12}>
        <QuestionCircleOutlined style={{ color: "var(--bgp-primary, #22d3ee)", fontSize: 18 }} />
        <Text strong>{t("新手引导")}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t("点「带我走一遍」会一步步高亮该点哪里(可随时上一步 / 跳过,换页也接着走);每页右上角 ❓ 有「本页怎么用」。")}</Text>
        {/* 主入口 = 导览;说明书降为次要入口 */}
        <Button type="primary" size="small" data-testid="guide-home-tour" onClick={() => startTour("dev")}>{t("带我走一遍")}</Button>
        <Button size="small" data-testid="guide-home-open" onClick={() => openGuide("start")}>{t("打开操作指引")}</Button>
        <Button size="small" data-testid="guide-home-projects" onClick={() => router.push("/projects")}>{t("去项目空间")}</Button>
        <Button size="small" data-testid="guide-home-exec-envs" onClick={() => router.push("/exec-envs")}>{t("去执行环境")}</Button>
      </Space>
    </Card>
  );
}
