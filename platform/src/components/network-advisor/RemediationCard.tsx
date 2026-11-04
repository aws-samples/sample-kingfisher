"use client";
import { useState } from "react";
import { Tag, Tooltip, Collapse, Button, Popconfirm, message } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import type { Remediation, ConnectivityRequest } from "@/lib/network-advisor";
import { useT } from "@/lib/i18n/useT";

const RISK_COLOR: Record<Remediation["risk"], string> = { low: "green", medium: "gold", high: "red" };

// Phase 1：只读展示"要做什么 + 为什么 + API 预览"。
// Phase 2(2026-07-14 用户授权):autoApplicable 的补救挂「授权执行」按钮,经 /api/network-advisor/apply
// 实际创建补网络资源(仅低风险可逆动作;只创建不删改;参数服务端重解析;仅管理员;走审计+二次确认)。
export default function RemediationCard({ rem, req, onApplied }: { rem: Remediation; req?: ConnectivityRequest; onApplied?: () => void }) {
  const t = useT();
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const doApply = async () => {
    if (!req) { message.warning(t("缺少环境上下文,无法执行")); return; }
    setApplying(true);
    try {
      const r = await fetch("/api/network-advisor/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ req, type: rem.type, targetIndex: rem.forTargetIndex }),
      }).then((x) => x.json());
      if (r?.success) {
        const d = r.data;
        setDone(d?.detail || t("已执行"));
        message.success(d?.applied ? t("已执行") : t("已就绪(资源已存在)"));
        onApplied?.();
      } else {
        message.error(r?.error?.message || t("执行失败"));
      }
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const items = [
    {
      key: rem.id,
      label: (
        <span>
          <Tag color={RISK_COLOR[rem.risk]}>{rem.risk}</Tag>
          {rem.title}
          {rem.apiPreview ? (
            <Tooltip title={rem.apiPreview.reversible ? t("可逆操作") : t("不可逆，谨慎")}>
              <Tag style={{ marginLeft: 8 }} color={rem.apiPreview.reversible ? "blue" : "volcano"}>
                {rem.apiPreview.action}
              </Tag>
            </Tooltip>
          ) : null}
          {rem.autoApplicable ? <Tag style={{ marginLeft: 4 }} color="cyan">{t("可一键修复")}</Tag> : null}
        </span>
      ),
      children: (
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ color: "#9fb3c8", marginBottom: 6 }}>{rem.why}</div>
          {rem.apiPreview ? (
            <pre style={{ background: "#0e1f2b", border: "1px solid #1d4254", borderRadius: 6, padding: 8, overflow: "auto", margin: 0 }}>
              {JSON.stringify(rem.apiPreview.params, null, 2)}
            </pre>
          ) : null}
          {rem.autoApplicable ? (
            <div style={{ marginTop: 8 }}>
              {done ? (
                <Tag color="green">{done}</Tag>
              ) : (
                <Popconfirm
                  title={t("授权执行该修复?")}
                  description={t("将实际在你的 AWS 环境创建补网络资源;仅创建不删改、可逆、走审计。")}
                  okText={t("授权执行")} cancelText={t("取消")}
                  onConfirm={doApply}
                >
                  <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />} loading={applying}>
                    {t("授权执行(一键修复)")}
                  </Button>
                </Popconfirm>
              )}
              <span style={{ color: "#5a7184", marginLeft: 8 }}>{t("仅平台管理员;实际创建资源,请确认")}</span>
            </div>
          ) : null}
        </div>
      ),
    },
  ];
  return <Collapse size="small" ghost items={items} style={{ marginBottom: 4 }} />;
}
