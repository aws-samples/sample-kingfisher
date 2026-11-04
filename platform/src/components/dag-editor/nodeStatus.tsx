// DAG 节点状态配色（暗黑科技风, v1.12.2）
//
// 三个节点组件（Sync/Sql/Python）原各自内联一份完全相同的浅色 statusStyle，
// 在深空暗黑画布上是突兀的浅色块。这里集中为「半透明深色底 + 语义边框 + 浅色文字」，
// 既贴合暗黑主题又保证文字/图标可读，并消除重复定义。
import type { ReactNode } from "react";
import { SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined } from "@ant-design/icons";

// 节点文字色（深色底上用浅色，与主题 colorText 对齐）。
export const NODE_TEXT = "#cfe6f0";
export const NODE_SUBTEXT = "#90a4c0";

// 语义色与主题 token 对齐：青=主色/运行、青绿=成功、玫红=失败、琥珀=警告/跳过。
export interface NodeStatusStyle {
  border: string;
  bg: string;
  icon: ReactNode;
}

export const nodeStatusStyle: Record<string, NodeStatusStyle> = {
  waiting: { border: "#3a4a63", bg: "rgba(255,255,255,0.04)", icon: <ClockCircleOutlined style={{ color: "#8294b3" }} /> },
  running: { border: "#22d3ee", bg: "rgba(34,211,238,0.14)", icon: <SyncOutlined spin style={{ color: "#22d3ee" }} /> },
  succeeded: { border: "#2dd4bf", bg: "rgba(45,212,191,0.14)", icon: <CheckCircleOutlined style={{ color: "#2dd4bf" }} /> },
  failed: { border: "#f5577a", bg: "rgba(245,87,122,0.14)", icon: <CloseCircleOutlined style={{ color: "#f5577a" }} /> },
  skipped: { border: "#e0a23c", bg: "rgba(224,162,60,0.14)", icon: <ClockCircleOutlined style={{ color: "#e0a23c" }} /> },
};
