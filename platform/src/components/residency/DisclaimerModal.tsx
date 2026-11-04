"use client";
// 免责告知弹窗(50 INTERACTION v2.17 §4bis.4;DESIGN §18 决策 6quinquies ④)。
//
// 用户 2026-09-05 原话:「可以弹窗告知担责说明。这个是有必要的。而且这种弹窗等用户同意之后,可以保留用户的选择,避免扯皮。」
// 🔴 文案**逐字显示服务端下发的 disclaimer.text**(单作者 lib/residency/disclaimer.ts;本组件不拼一个字、不加任何法律定性);
//    版本号一并显示;〔取消〕= 不执行任何操作;〔同意并继续〕= 服务端留存 (用户, target, 版本) 后重试原请求。
//    每用户每 target 只弹一次(服务端 409 驱动;同意留存后不再 409)。
import React from "react";
import { Alert, Button, Modal, Space, Typography } from "antd";
import { useT } from "@/lib/i18n/useT";
import type { AckRequiredDetail } from "@/lib/residency/client";

const { Paragraph, Text } = Typography;

export interface DisclaimerModalProps {
  detail: AckRequiredDetail | null;
  busy?: boolean;
  error?: string | null;
  onAgree: () => void;
  onCancel: () => void;
}

export default function DisclaimerModal({ detail, busy, error, onAgree, onCancel }: DisclaimerModalProps) {
  const t = useT();
  return (
    <Modal
      open={Boolean(detail)}
      title={t("⚠️ 免责告知({v})", { v: detail?.disclaimer.version ?? "" })}
      onCancel={onCancel}
      maskClosable={false}
      destroyOnHidden
      data-testid="residency-disclaimer-modal"
      footer={
        <Space>
          <Button onClick={onCancel} data-testid="residency-disclaimer-cancel">
            {t("取消")}
          </Button>
          <Button type="primary" loading={busy} onClick={onAgree} data-testid="residency-disclaimer-agree">
            {t("同意并继续")}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t("执行目标 {id} 属于另一个法域;首次对它做数据操作前,请阅读并同意以下告知(您的选择会被留存:用户 / 目标 / 版本 / 时间)。", {
            id: detail?.targetId ?? "",
          })}
        </Text>
        <Paragraph data-testid="residency-disclaimer-text" style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
          {detail?.disclaimer.text}
        </Paragraph>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Space>
    </Modal>
  );
}
