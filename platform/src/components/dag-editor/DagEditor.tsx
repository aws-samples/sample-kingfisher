"use client";

import React, { useCallback, useMemo, useState, useRef } from "react";
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";
import SyncNode from "./SyncNode";
import SqlNode from "./SqlNode";
import PythonNode from "./PythonNode";
import { BranchNode, EmptyNode, JoinNode, ForeachNode, SetvarNode, ExternalNode } from "./RichNodes";
// 离线作业节点
import { JobNode } from "./JobNode";
import NodeConfigPanel from "./NodeConfigPanel";

interface Props {
  nodes: Node[];
  edges: Edge[];
  onChange: (nodes: Node[], edges: Edge[]) => void;
  /**
   * 这个工作流的执行区(行上的章;无章的存量工作流 = 主控区)。
   * 节点面板按它过滤候选(`?scope=<落点>`):只列出绑定了这些区的同步任务 / 离线作业 —— 与发布期 fail-closed 判定同一口径。
   */
  wfTargets: string[];
}

// ReactFlow throws ("can't access property x, e.position is undefined") if any node
// lacks a numeric position. DAGs created via the API may omit it, so guard here too
// (defense in depth — the page also normalizes on load).
function ensurePositions(ns: Node[]): Node[] {
  return (ns || []).map((n, i) => ({
    ...n,
    position:
      n && n.position && typeof n.position.x === "number" && typeof n.position.y === "number"
        ? n.position
        : { x: 250, y: 80 + i * 130 },
    data: (n && n.data) || {},
  }));
}

export default function DagEditor({ nodes: initNodes, edges: initEdges, onChange, wfTargets }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState(ensurePositions(initNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Sync when parent adds nodes (length-keyed so our own onChange→parent→initNodes round-trip
  // doesn't clobber in-canvas edits like drag positions / config).
  React.useEffect(() => { setNodes(ensurePositions(initNodes)); }, [initNodes.length]);

  // L4 修复：以前用 setTimeout(onChange(nodes, edges)) 上报，闭包里的 nodes/edges 是变更前的
  // 旧值（拖拽位置等会滞后一拍、保存时丢失）。改为在本地 nodes/edges 真正变化后用 effect 上报，
  // 始终是最新值。首帧不上报（避免覆盖父级初值）。
  const firstRender = useRef(true);
  React.useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    onChange(nodes, edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // 33-B: 渲染组件映射(nodeType → 组件)。老三 + 六新 + 离线作业节点;加节点在此加一行。
  const nodeTypes = useMemo(() => ({
    sync: SyncNode, sql: SqlNode, python: PythonNode,
    branch: BranchNode, empty: EmptyNode, join: JoinNode,
    foreach: ForeachNode, setvar: SetvarNode, external: ExternalNode,
    job: JobNode,
  }), []);

  const onConnect = useCallback(
    (conn: Connection) => setEdges((eds) => addEdge({ ...conn, animated: true }, eds)),
    [setEdges]
  );

  const handleNodeClick = useCallback((_: any, node: Node) => setSelectedNode(node), []);

  const handleNodeDataChange = useCallback(
    (id: string, data: any) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data } : n)));
      setSelectedNode((sel) => (sel && sel.id === id ? { ...sel, data } : sel));
    },
    [setNodes]
  );

  // L2：删除节点（连带删除与之相连的边）。
  const handleNodeDelete = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelectedNode(null);
    },
    [setNodes, setEdges]
  );

  return (
    <>
      <div style={{ height: "60vh", border: "1px solid #1d4254", borderRadius: 8 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView
        >
          <Background color="#1d4254" />
          <Controls />
          <MiniMap
            nodeColor="#22d3ee"
            nodeStrokeColor="#2dd4bf"
            maskColor="rgba(7, 11, 20, 0.7)"
            style={{ backgroundColor: "#08131b" }}
          />
        </ReactFlow>
      </div>
      <NodeConfigPanel
        node={selectedNode}
        wfTargets={wfTargets}
        onClose={() => setSelectedNode(null)}
        onChange={handleNodeDataChange}
        onDelete={handleNodeDelete}
      />
    </>
  );
}
