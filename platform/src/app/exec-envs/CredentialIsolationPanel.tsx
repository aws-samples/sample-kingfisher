"use client";
// 执行环境详情页的「凭证隔离」一栏 + 〔延期供给截止〕入口(50 SPEC §3.9b 延期专用操作)。
//
// 🔴 为什么单独一个组件:TargetDetail.tsx 是并行包的高频改动面;本栏只在那里插一行,改动面最小。
// 🔴 只读三件事(状态 / 世代 / 截止)+ 一个写入口(延期)。延期必须写理由、天数 1–30,服务端再校验一遍
//    (前态 = provisioning、epoch 一致、新截止晚于旧截止、≤ 30 天、审计 fail-closed)—— 这里的限制只是少让人撞墙。
import React, { useState } from "react";
import { Alert, Button, InputNumber, Input, Modal, Space, Tag, Typography, message } from "antd";
import { useT } from "@/lib/i18n/useT";
import { extendProvisioningDeadline, type ExecEnvTarget } from "./api";

const { Text } = Typography;

export default function CredentialIsolationPanel({ target, onChanged }: { target: ExecEnvTarget; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(7);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const state = target.credentialIsolationState;
  const epoch = target.credentialEpoch;
  const deadline = target.provisioningDeadlineAt;
  const deadlineMs = deadline ? Date.parse(deadline) : NaN;
  const expired = state === "provisioning" && (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now());

  const submit = async () => {
    setBusy(true);
    try {
      const r = await extendProvisioningDeadline(target.targetId, { extendDays: days, reason: reason.trim(), expectedEpoch: epoch });
      message.success(t("已延期:新截止 {d}(凭证世代 {e})", { d: r.provisioningDeadlineAt.slice(0, 19).replace("T", " "), e: String(r.epoch) }));
      setOpen(false);
      setReason("");
      onChanged();
    } catch (e) {
      message.error(t("延期失败:{e}", { e: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }} data-testid="credential-isolation">
      <Space size={6} wrap>
        <Tag data-testid="credential-state" color={state === "isolated" ? "green" : state === "provisioning" ? (expired ? "error" : "gold") : "default"}>
          {state ?? t("未知")}
        </Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t("凭证世代 {e}", { e: epoch === undefined ? "—" : String(epoch) })}
        </Text>
        {state === "provisioning" ? (
          <Text type={expired ? "danger" : "secondary"} style={{ fontSize: 12 }} data-testid="provisioning-deadline">
            {t("供给截止 {d}", { d: deadline ? deadline.slice(0, 19).replace("T", " ") : "—" })}
            {expired ? t("(已过期:未供给凭证的项目在该区已被拒绝)") : ""}
          </Text>
        ) : null}
        {state === "provisioning" ? (
          <Button size="small" data-testid="extend-deadline-btn" onClick={() => setOpen(true)}>
            {t("延期供给截止")}
          </Button>
        ) : null}
      </Space>
      <Modal
        open={open}
        title={t("延期供给截止")}
        okText={t("确认延期")}
        cancelText={t("取消")}
        confirmLoading={busy}
        okButtonProps={{ disabled: reason.trim().length < 4, "data-testid": "extend-deadline-ok" } as never}
        onOk={submit}
        onCancel={() => setOpen(false)}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="warning"
            showIcon
            message={t("延期 = 允许尚未供给凭证的项目在该区继续使用共享管理员凭证 N 天")}
            description={t("新截止从现在起算、最多 30 天;每次延期都会让凭证世代加一(已有的 canary 结果随之失效,需要重跑),并写入审计。")}
          />
          <Space>
            <Text>{t("延期天数")}</Text>
            <InputNumber min={1} max={30} precision={0} value={days} onChange={(v) => setDays(Number(v) || 1)} data-testid="extend-days" />
          </Space>
          <Input.TextArea
            rows={3}
            maxLength={500}
            placeholder={t("延期理由(必填,至少 4 个字)")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-testid="extend-reason"
          />
        </Space>
      </Modal>
    </Space>
  );
}
