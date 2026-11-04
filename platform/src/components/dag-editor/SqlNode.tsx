import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { ConsoleSqlOutlined } from "@ant-design/icons";
import { nodeStatusStyle, NODE_TEXT, NODE_SUBTEXT } from "./nodeStatus";
import { useT } from "@/lib/i18n/useT";

function SqlNode({ data }: NodeProps) {
  const t = useT();
  const st = nodeStatusStyle[data.runStatus] || nodeStatusStyle.succeeded;
  return (
    <div style={{ padding: "8px 16px", border: `2px solid ${data.runStatus ? st.border : "#2dd4bf"}`, borderRadius: 8, background: data.runStatus ? st.bg : "rgba(45, 212, 191, 0.12)", minWidth: 120, color: NODE_TEXT }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {data.runStatus ? st.icon : <ConsoleSqlOutlined style={{ color: "#2dd4bf" }} />}
        <span>{data.label || t("SQL 节点")}</span>
      </div>
      {data.sql ? (
        <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {(data.engine === "glue" ? "Glue · " : "") + String(data.sql).replace(/\s+/g, " ").slice(0, 40)}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: "#e8a23d", marginTop: 2 }}>{t("未配置 SQL")}</div>
      )}
      {data.duration && <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{data.duration}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export default memo(SqlNode);
