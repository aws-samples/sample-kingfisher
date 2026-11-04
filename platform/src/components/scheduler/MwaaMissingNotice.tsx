"use client";
// 「以下执行环境未安装 MWAA 调度服务」警示卡(50 INTERACTION v2.18 §2.2a)。
// 用户拍板:每个区域的定时任务只能由本区域的 MWAA 执行 ⇒ 非 home target 没装 mwaa 就不能为它配调度;
// 提示必须**在动作的当场、列全、能一键到补装入口**(不是三秒即逝的 toast)。
// 文案与深链都来自服务端载荷(单一作者 mwaa-endpoint.ts);本组件只渲染 + 导航。
import React from "react";
import { Alert, Button, Space, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import type { MwaaMissingPayload } from "@/lib/scheduler/mwaa-missing";

const { Text } = Typography;

export default function MwaaMissingNotice({ payload, style }: { payload: MwaaMissingPayload | null; style?: React.CSSProperties }) {
  const t = useT();
  const router = useRouter();
  if (!payload || payload.missing.length === 0) return null;
  // (INTERACTION v2.19 §2.2a 订正):缺**任一**调度组件都到这张卡;每行列出可选组件;
  //   新 testid scheduler-missing-*(包一层),旧 testid mwaa-missing-* 保留一版(验收脚本 / wiring guard 两个都认)
  return (
    <div data-testid="scheduler-missing-notice">
    <Alert
      type="warning"
      showIcon
      data-testid="mwaa-missing-notice"
      style={{ marginTop: 12, ...style }}
      message={t("以下执行环境未安装调度组件,无法在该区域配置定时 / 编排")}
      description={
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {payload.missing.map((m) => (
            <div key={m.targetId} data-testid="mwaa-missing-row">
              <Text strong>{m.region}</Text> · <Text code>{m.targetId}</Text>
              {m.displayName ? <Text type="secondary">({m.displayName})</Text> : null}
              {m.reason ? <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{m.reason}</Text> : null}
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }} data-testid="scheduler-missing-options">
                {t("可选:airflow-serverless(推荐,分钟级开通、按任务秒计费)/ mwaa(常驻,约 30 分钟)")}
              </Text>
            </div>
          ))}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("每个区域的定时任务只能由本区域的调度器执行;请先到执行环境补装调度组件(推荐 airflow-serverless:预演 → 批准 → 部署约 5 分钟),装好后回来再发布。")}
          </Text>
          <div>
            <span data-testid="scheduler-missing-fix">
              <Button type="primary" size="small" data-testid="mwaa-missing-fix" onClick={() => router.push(payload.fix.href)}>
                {payload.fix.label || t("去执行环境补装调度")} →
              </Button>
            </span>
          </div>
        </Space>
      }
    />
    </div>
  );
}
