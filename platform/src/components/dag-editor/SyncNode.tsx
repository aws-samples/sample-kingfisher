import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { SyncOutlined } from "@ant-design/icons";
import { nodeStatusStyle, NODE_TEXT, NODE_SUBTEXT } from "./nodeStatus";
import { useT } from "@/lib/i18n/useT";

function SyncNode({ data }: NodeProps) {
  const t = useT();
  const st = nodeStatusStyle[data.runStatus] || nodeStatusStyle.waiting;
  return (
    <div style={{ padding: "8px 16px", border: `2px solid ${data.runStatus ? st.border : "#22d3ee"}`, borderRadius: 8, background: data.runStatus ? st.bg : "rgba(34, 211, 238, 0.12)", minWidth: 120, color: NODE_TEXT }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {data.runStatus ? st.icon : <SyncOutlined style={{ color: "#22d3ee" }} />}
        <span>{data.label || t("数据同步")}</span>
      </div>
      <div style={{ fontSize: 10, color: data.syncTaskId ? NODE_SUBTEXT : "#e8a23d", marginTop: 2 }}>
        {data.syncTaskId ? t("已关联同步任务") : t("未关联同步任务")}
      </div>
      {data.duration && <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{data.duration}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(SyncNode);
