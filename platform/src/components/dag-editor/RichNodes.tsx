// 六个新节点的渲染组件(仅 runtime-lib 引擎)。
// 照 SqlNode.tsx 范式:memo + Handle(target/source)+ nodeStatusStyle[data.runStatus]。
// branch 是唯一特殊者:多个 source Handle(每个分支一个出口 + 默认出口),
// 出边靠 reactflow 原生 sourceHandle 承载"分支归属"(见 types/workflow.ts WorkflowEdge)。
import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  BranchesOutlined, BorderOutlined, MergeCellsOutlined,
  RetweetOutlined, TagOutlined, ClockCircleOutlined,
} from "@ant-design/icons";
import { nodeStatusStyle, NODE_TEXT, NODE_SUBTEXT } from "./nodeStatus";
import { useT } from "@/lib/i18n/useT";

// 通用外壳:统一配色/状态/边框,子节点只传 icon + 标题 + 副文本 + 额外 Handle。
// 导出给 JobNode.tsx 复用(同一个外壳,不再抄一份);`testId` 落在根节点上给页面驱动判据定位。
export function Shell({
  data, icon, title, sub, extraSource, testId,
}: {
  data: any; icon: React.ReactNode; title: string; sub?: React.ReactNode; extraSource?: React.ReactNode; testId?: string;
}) {
  const st = nodeStatusStyle[data.runStatus] || nodeStatusStyle.succeeded;
  return (
    <div data-testid={testId} style={{ padding: "8px 16px", border: `2px solid ${data.runStatus ? st.border : "#2dd4bf"}`, borderRadius: 8, background: data.runStatus ? st.bg : "rgba(45, 212, 191, 0.12)", minWidth: 120, color: NODE_TEXT }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {data.runStatus ? st.icon : icon}
        <span>{data.label || title}</span>
      </div>
      {sub}
      {data.duration && <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{data.duration}</div>}
      {extraSource ?? <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}

export const BranchNode = memo(function BranchNode({ data }: NodeProps) {
  const t = useT();
  const branches: any[] = Array.isArray(data.branches) ? data.branches : [];
  // 多出口:每个分支一个 source Handle(id=b{idx}) + 默认出口(id=default)。
  // 横向均匀分布在底边,连线时 edge.sourceHandle 即记录走哪个分支。
  const handles = [...branches.map((_, i) => ({ id: `b${i}`, label: `${i + 1}` })), { id: "default", label: t("默认") }];
  return (
    <Shell
      data={data} icon={<BranchesOutlined style={{ color: "#2dd4bf" }} />} title={t("分支节点")}
      sub={
        branches.length ? (
          <div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{t("{n} 个分支", { n: branches.length })}</div>
        ) : (
          <div style={{ fontSize: 10, color: "#e8a23d", marginTop: 2 }}>{t("未配置分支")}</div>
        )
      }
      extraSource={
        <>
          {handles.map((h, i) => (
            <Handle key={h.id} id={h.id} type="source" position={Position.Bottom}
              style={{ left: `${((i + 1) / (handles.length + 1)) * 100}%` }} />
          ))}
        </>
      }
    />
  );
});

export const EmptyNode = memo(function EmptyNode({ data }: NodeProps) {
  const t = useT();
  return <Shell data={data} icon={<BorderOutlined style={{ color: "#2dd4bf" }} />} title={t("空节点")} />;
});

export const JoinNode = memo(function JoinNode({ data }: NodeProps) {
  const t = useT();
  return (
    <Shell data={data} icon={<MergeCellsOutlined style={{ color: "#2dd4bf" }} />} title={t("归并节点")}
      sub={<div style={{ fontSize: 10, color: NODE_SUBTEXT, marginTop: 2 }}>{data.rule || "all_success"}</div>} />
  );
});

export const ForeachNode = memo(function ForeachNode({ data }: NodeProps) {
  const t = useT();
  const items = data.items;
  const desc = Array.isArray(items) ? t("{n} 项", { n: items.length }) : items ? `XCom: ${items}` : t("未指定集合");
  return (
    <Shell data={data} icon={<RetweetOutlined style={{ color: "#2dd4bf" }} />} title={t("遍历节点")}
      sub={<div style={{ fontSize: 10, color: items ? NODE_SUBTEXT : "#e8a23d", marginTop: 2 }}>{desc}</div>} />
  );
});

export const SetvarNode = memo(function SetvarNode({ data }: NodeProps) {
  const t = useT();
  const n = data.vars && typeof data.vars === "object" ? Object.keys(data.vars).length : 0;
  return (
    <Shell data={data} icon={<TagOutlined style={{ color: "#2dd4bf" }} />} title={t("赋值节点")}
      sub={<div style={{ fontSize: 10, color: n ? NODE_SUBTEXT : "#e8a23d", marginTop: 2 }}>{t("{n} 个变量", { n })}</div>} />
  );
});

export const ExternalNode = memo(function ExternalNode({ data }: NodeProps) {
  const t = useT();
  return (
    <Shell data={data} icon={<ClockCircleOutlined style={{ color: "#2dd4bf" }} />} title={t("跨周期依赖节点")}
      sub={
        <div style={{ fontSize: 10, color: data.externalDagId ? NODE_SUBTEXT : "#e8a23d", marginTop: 2, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {data.externalDagId ? `→ ${data.externalDagId}` : t("未指定外部 DAG")}
        </div>
      } />
  );
});
