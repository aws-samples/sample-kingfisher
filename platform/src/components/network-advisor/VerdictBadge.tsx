"use client";
import { Tag } from "antd";
import {
  CheckCircleOutlined,
  ToolOutlined,
  CloseCircleOutlined,
  QuestionCircleOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { Verdict } from "@/lib/network-advisor";
import { useT } from "@/lib/i18n/useT";

const MAP: Record<Verdict, { color: string; icon: React.ReactNode; label: string }> = {
  reachable: { color: "success", icon: <CheckCircleOutlined />, label: "可连通" },
  "reachable-after-fixes": { color: "warning", icon: <ToolOutlined />, label: "修复后可连通" },
  unreachable: { color: "error", icon: <CloseCircleOutlined />, label: "无法连通" },
  "needs-input": { color: "processing", icon: <QuestionCircleOutlined />, label: "需补充信息" },
  unknown: { color: "default", icon: <WarningOutlined />, label: "判定不确定" },
};

export default function VerdictBadge({ verdict, confidence }: { verdict: Verdict; confidence?: number }) {
  const t = useT();
  const m = MAP[verdict] || MAP.unknown;
  return (
    <Tag color={m.color} icon={m.icon} style={{ fontSize: 13, padding: "2px 10px" }}>
      {t(m.label)}
      {typeof confidence === "number" ? t(" · 置信 {pct}%", { pct: Math.round(confidence * 100) }) : ""}
    </Tag>
  );
}
