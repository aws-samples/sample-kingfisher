import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { CodeOutlined } from "@ant-design/icons";
import { nodeStatusStyle, NODE_TEXT, NODE_SUBTEXT } from "./nodeStatus";
import { useT } from "@/lib/i18n/useT";

function PythonNode({ data }: NodeProps) {
  const t = useT();
  const st = nodeStatusStyle[data.runStatus] || nodeStatusStyle.skipped;
  return (
    <div style={{ padding: "8px 16px", border: `2px solid ${data.runStatus ? st.border : "#e0a23c"}`, borderRadius: 8, background: data.runStatus ? st.bg : "rgba(224, 162, 60, 0.12)", minWidth: 120, color: NODE_TEXT }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {data.runStatus ? st.icon : <CodeOutlined style={{ color: "#e0a23c" }} />}
        <span>{data.label || t("Python 脚本")}</span>
      </div>
      {data.duration && <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{data.duration}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(PythonNode);
