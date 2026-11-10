"use client";

import { targetOfStamp } from "@/lib/exec-env/target-id";
import { fetchScoped, workflowTargetsOf } from "@/components/dag-editor/scoped-candidates";
import React, { useEffect, useState, useRef, useCallback } from "react";
import { Button, Space, message, Dropdown, Spin, Tabs, Card, Tag, Badge, Table, Tooltip, Modal, Select, Input, Popconfirm } from "antd";
import { SaveOutlined, PlusOutlined, ArrowLeftOutlined, PlayCircleOutlined, CloudUploadOutlined, DashboardOutlined, LinkOutlined, FileTextOutlined, ApartmentOutlined, HistoryOutlined, FieldTimeOutlined } from "@ant-design/icons";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
// `?run=<runId>` 深链自动打开那次运行的「节点详情」;节点行按 backLink 点回作业 / 同步任务自己的运行历史(地址唯一作者)
import { nodeBackLinkHref, type NodeBackLink } from "@/lib/workflow/back-links";
import dynamic from "next/dynamic";
import type { Node, Edge } from "reactflow";
import VersionHistoryDrawer from "@/components/common/VersionHistoryDrawer";
import PromoteButton from "@/components/common/PromoteButton";
// 环境标签 + 各环境发布状态;「发布」改叫「发布到调度」与「发布到环境」区分
import EnvTag from "@/components/common/EnvTag";
import EnvPromotionStatus from "@/components/common/EnvPromotionStatus";
import DiagnosisButton from "@/components/common/DiagnosisButton";
import { useT } from "@/lib/i18n/useT";
// 2026-11-04(B):错误信封文案的唯一读法(`xxx.error` 可能是 apiError / 非 JSON 信封拦截器的对象信封,直接递给 antd ⇒ React error #31 ⇒ 零提示)
import { errorMessageOf } from "@/lib/http/error-envelope";
import { NODE_REGISTRY, PALETTE_NODE_TYPES } from "@/lib/workflow/node-registry";
// Airflow 控制台入口收成平台 admin 专用(服务端已硬拦,这里只是不让人白点)
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";

const DagEditor = dynamic(() => import("@/components/dag-editor/DagEditor"), { ssr: false });

// 33-B: 拖拽面板从 registry(SSOT)生成,加节点无需改这里。label 即 registry 的 labelKey,
// 渲染时过 t()。data.label 用短名(去掉"节点"后缀)作画布默认标签。
// 平台合成的节点(platform-action)不进面板
const nodeTemplates = PALETTE_NODE_TYPES.map((type) => {
  const labelKey = NODE_REGISTRY[type].labelKey;
  return { key: type, label: labelKey, type, data: { label: labelKey.replace(/节点$/, "") } };
});

// 运行历史按开始时间倒序（最新在前）。
// 平台手动触发的运行以 ULID 作 runId；Airflow 定时/回调补写的运行用原生 run_id
// （scheduled__…/manual__…）。这两套命名空间的字典序与时间无关，而共享的
// /api/sync/[id]/runs 用 ScanIndexForward:false 按 runId 字典序返回（该 API 被
// sync/schedule/etl-jobs/EMR 多页共用，不能改）。因此在页面层统一按 startedAt 时间
// 重排，保证"最新在前、最久在后"且与 runId 命名空间无关。
function sortRunsByTime(runs: any[]): any[] {
  return [...(runs || [])].sort((a, b) => {
    const ta = Date.parse(a?.startedAt || "") || 0;
    const tb = Date.parse(b?.startedAt || "") || 0;
    return tb - ta;
  });
}

// L5：稳定地序列化 DAG（仅 id/type/position/data + 边端点），用于"未保存更改"检测——
// 忽略 ReactFlow 的瞬时字段（selected/dragging/尺寸）与亚像素抖动。
function normalizeDag(nodes: any[], edges: any[]): string {
  return JSON.stringify({
    n: (nodes || []).map((x) => ({ id: x.id, type: x.type, x: Math.round(x.position?.x || 0), y: Math.round(x.position?.y || 0), data: x.data || {} })),
    // 33-B: 纳入 sourceHandle(branch 多出口的"分支归属"),否则改分支路由不触发"未保存"。
    // 现有边无 sourceHandle → undefined → JSON.stringify 忽略 → 与旧快照字节一致,不误判 dirty。
    e: (edges || []).map((x) => ({ s: x.source, t: x.target, h: x.sourceHandle ?? undefined })),
  });
}

export default function WorkflowEditorPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [workflow, setWorkflow] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // L5：未保存更改指示。savedRef 保存最近一次"已持久化"的 DAG 归一化快照。
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef<string>("");
  // version history drawer + a reload key to re-fetch the workflow after a rollback.
  const [versionOpen, setVersionOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // SCH-03: options (other workflows + sync tasks) for the downstream-dependency selector.
  const [depOptions, setDepOptions] = useState<{ label: string; value: string }[]>([]);
  // 下游依赖候选读取失败的原话(红字说明;不静默回空列表)
  const [depOptionsError, setDepOptionsError] = useState<string | null>(null);
  const [savingDeps, setSavingDeps] = useState(false);
  // PLT-02: per-action loading so save/publish/trigger can't be double-submitted.
  const [actionLoading, setActionLoading] = useState<{ save?: boolean; publish?: boolean; trigger?: boolean }>({});
  /**
   * 🔴 Airflow 控制台入口只对**平台管理员**开放。
   * 真授权在服务端(`api/workflow/airflow` 已硬拦 403);这里只是**不让人白点一下再吃 403**,
   * 并且**不隐藏、而是禁用 + Tooltip 说清原因** —— 与执行环境那批同一口径:
   * 「最坏的不是不能用,是看不出为什么不能用」。
   * 判定沿用仓内既有先例(etl-jobs / EmrJobPanel / SyncTaskModal 同一写法),不另造身份来源。
   */
  const { getToken } = useAuth();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        setIsPlatformAdmin(groupsFromToken(await getToken()).includes("bgp-admin"));
      } catch {
        /* 非登录态忽略;默认 false = 保守(不误开入口) */
      }
    })();
  }, [getToken]);
  const [logModal, setLogModal] = useState<{ open: boolean; runId: string; logs: string[] }>({ open: false, runId: "", logs: [] });
  const [runs, setRuns] = useState<any[]>([]);
  // 运行列表至少到过一次(成功或失败)才按 `?run=` 开节点详情;只开一次
  const [runsLoaded, setRunsLoaded] = useState(false);
  const searchParams = useSearchParams();
  const openedRunFromQueryRef = useRef<string>("");
  // WF-04: per-run node (task instance) inspection — list of nodes + the selected node's logs.
  const [nodeModal, setNodeModal] = useState<{ open: boolean; runId: string; nodes: any[]; loading: boolean; selected: string; logs: string[]; logsLoading: boolean }>(
    { open: false, runId: "", nodes: [], loading: false, selected: "", logs: [], logsLoading: false }
  );

  const viewNodes = async (runId: string) => {
    setNodeModal({ open: true, runId, nodes: [], loading: true, selected: "", logs: [], logsLoading: false });
    try {
      // 🔴 runId 必须 encodeURIComponent:调度器写的 run 行 id 形如 `<raw>#<targetId>`(复合键),
      //    `#` 在 URL 里是 fragment 起点 ⇒ 服务端只收到前半段 ⇒ 404 ⇒ 界面看起来像「这次运行没有节点」。
      const res = await fetch(`/api/workflow/${id}/runs/${encodeURIComponent(runId)}/nodes`);
      const data = await res.json();
      const nodes = (data.success ? data.data?.nodes : data.nodes) || [];
      setNodeModal((p) => ({ ...p, nodes, loading: false }));
    } catch {
      setNodeModal((p) => ({ ...p, nodes: [], loading: false }));
    }
  };

  const viewNodeLog = async (task: string, tryNumber: number) => {
    setNodeModal((p) => ({ ...p, selected: task, logs: [], logsLoading: true }));
    try {
      const res = await fetch(`/api/workflow/${id}/runs/${encodeURIComponent(nodeModal.runId)}/nodes/${encodeURIComponent(task)}/logs?try=${tryNumber || 1}`);
      const data = await res.json();
      const logs = (data.success ? data.data?.logs : data.logs) || [t("暂无日志")];
      setNodeModal((p) => ({ ...p, logs, logsLoading: false }));
    } catch {
      setNodeModal((p) => ({ ...p, logs: [t("日志加载失败")], logsLoading: false }));
    }
  };


  const viewRunLog = async (runId: string) => {
    setLogModal({ open: true, runId, logs: [] });
    try {
      const res = await fetch(`/api/monitor/tasks/${id}/logs?runId=${encodeURIComponent(runId)}`);
      const data = await res.json();
      const logs = (data.logs || []).map((l: any) => typeof l === "string" ? l : (l.timestamp ? `[${new Date(l.timestamp).toISOString().slice(0,19)}] ` : "") + (l.message || ""));
      setLogModal({ open: true, runId, logs: logs.length > 0 ? logs : [t("暂无日志")] });
    } catch { setLogModal(prev => ({ ...prev, logs: [t("日志加载失败")] })); }
  };

  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/sync/${id}/runs`);
      const json = await res.json();
      const d = json.data || json;
      const list: any[] = d.runs || d.Items || [];
      setRuns(sortRunsByTime(list));
      // WF-07: workflow runs are recorded as "running" at trigger time but only Airflow
      // knows when they finish. Backfill any still-running rows from Airflow, then refresh.
      const running = list.filter((r) => r.status === "running");
      if (running.length > 0) {
        // 🔴 同上:不编码 ⇒ 定时 run 的状态**永远回填不了**(它的 id 一定带 `#`),行会永远停在「运行中」
        await Promise.all(running.map((r) => fetch(`/api/workflow/${id}/runs/${encodeURIComponent(r.runId)}/status`).catch(() => {})));
        const res2 = await fetch(`/api/sync/${id}/runs`);
        const json2 = await res2.json();
        const d2 = json2.data || json2;
        setRuns(sortRunsByTime(d2.runs || d2.Items || []));
      }
    } catch {
      /* ignore — keep last known runs */
    } finally {
      setRunsLoaded(true);
    }
  }, [id]);
  const [activeTab, setActiveTab] = useState("editor");

  // 作业 / 同步任务运行历史里「由工作流「X」触发」点过来 ⇒ 切到运行历史并打开**这次**运行的节点详情。
  // 🔴 query 只在挂载后的 effect 里读(首帧与服务端一致);同一个 runId 只开一次(用户关掉后不再弹回)。
  useEffect(() => {
    const want = searchParams?.get("run") || "";
    if (!want || !runsLoaded || openedRunFromQueryRef.current === want) return;
    openedRunFromQueryRef.current = want;
    setActiveTab("runs");
    viewNodes(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsLoaded, searchParams]);

  // Fetch runs once on load so the 运行历史 tab count is accurate before the tab is ever
  // opened (previously it showed (0) until first click), and so any orphaned "running"
  // rows get reconciled promptly rather than only when the user opens the tab.
  useEffect(() => { refreshRuns(); }, [refreshRuns]);

  useEffect(() => {
    if (activeTab !== "runs") return;
    // Light polling while the 运行历史 tab is open so running runs settle to their
    // terminal status without a manual refresh.
    const timer = setInterval(refreshRuns, 10000);
    return () => clearInterval(timer);
  }, [activeTab, refreshRuns]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  useEffect(() => {
    fetch(`/api/workflow/${id}`)
      .then((r) => r.json())
      .then((res) => {
        const data = res.success ? res.data : res;
        setWorkflow(data);
        // ReactFlow requires every node to carry a numeric position and every edge
        // an id. DAGs created via the API (or programmatically) may omit these,
        // which throws on render and surfaces as a client-side "Application error".
        // Normalize defensively so the canvas always renders.
        const rawNodes = Array.isArray(data?.dagDefinition?.nodes) ? data.dagDefinition.nodes : [];
        const rawEdges = Array.isArray(data?.dagDefinition?.edges) ? data.dagDefinition.edges : [];
        const loadedNodes = rawNodes.map((n: any, i: number) => ({
          ...n,
          position:
            n?.position && typeof n.position.x === "number" && typeof n.position.y === "number"
              ? n.position
              : { x: 250, y: 80 + i * 130 },
          data: n?.data || {},
        }));
        const loadedEdges = rawEdges.map((e: any, i: number) => ({
          ...e,
          id: e?.id || `e-${e?.source}-${e?.target}-${i}`,
        }));
        setNodes(loadedNodes);
        setEdges(loadedEdges);
        // L5：记录加载时的快照为"已保存"基线，clear 脏标记。
        savedRef.current = normalizeDag(loadedNodes, loadedEdges);
        setDirty(false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id, reloadKey]);

  // SCH-03: load selectable downstream targets (other workflows + sync tasks).
  //   候选按**这条工作流的执行区**取(`?scope=<落点>`,与节点面板 / 发布期落点判定同一口径;单一作者 scoped-candidates.ts):
  //   两条读接口只认 URL ?scope=,原来裸 fetch 不带它 = 「全部」视角 ⇒ 列出所有区的候选(2026-11-03 勘查)。读失败红字说明,不静默回空。
  const depTargetsKey = workflow ? workflowTargetsOf(workflow as { targets?: unknown; targetId?: unknown }, targetOfStamp).join(",") : "";
  useEffect(() => {
    if (!depTargetsKey) return;
    const targets = depTargetsKey.split(",");
    let cancelled = false;
    (async () => {
      try {
        const [wfs, syncs] = await Promise.all([
          fetchScoped("/api/workflow", targets, (w) => String(w.workflowId)),
          fetchScoped("/api/sync", targets, (s) => String(s.taskId)),
        ]);
        if (cancelled) return;
        setDepOptions([
          ...wfs.filter((w: any) => w.workflowId !== id).map((w: any) => ({ label: t("工作流: {name}", { name: w.name || w.workflowId }), value: w.workflowId })),
          ...syncs.map((s: any) => ({ label: t("同步: {name}", { name: s.name || s.taskId }), value: s.taskId })),
        ]);
        setDepOptionsError(null);
      } catch (e) {
        if (!cancelled) { setDepOptions([]); setDepOptionsError(String((e as Error)?.message || e)); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, depTargetsKey]);

  // 周期调度设置:后端/DAG 生成器一直支持 cronExpression(发布时写进 Airflow schedule_interval),
  // 但页面此前没有设置入口(只能手动调 API)——这里补齐:填 cron → 应用(落库+重新发布 DAG 生效)。
  const [cronInput, setCronInput] = useState("");
  useEffect(() => { setCronInput(workflow?.cronExpression || ""); }, [workflow?.cronExpression]);
  const applySchedule = async () => {
    const cron = cronInput.trim();
    if (!cron) { message.warning(t("请输入 cron 表达式,如 */30 * * * *(每 30 分钟)")); return; }
    setActionLoading((p) => ({ ...p, publish: true }));
    try {
      await fetch(`/api/workflow/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression: cron, scheduleEnabled: true }),
      });
      // cron 写进 DAG 的 schedule_interval,必须重新发布才生效。
      const res = await fetch(`/api/workflow/${id}/publish`, { method: "POST" });
      const data = await res.json();
      if (data.success !== false && !data.error) {
        message.success(t("调度已应用并发布({cron}),MWAA 加载约 1 分钟后按周期运行", { cron }));
        setWorkflow((w: any) => ({ ...w, cronExpression: cron, scheduleEnabled: true, status: "active" }));
      } else message.error(data.error?.message || data.error || t("发布失败"));
    } finally { setActionLoading((p) => ({ ...p, publish: false })); }
  };
  const offlineSchedule = async () => {
    setActionLoading((p) => ({ ...p, publish: true }));
    try {
      const res = await fetch(`/api/workflow/${id}/unpublish`, { method: "POST" });
      const data = await res.json();
      if (data.error) message.error(errorMessageOf(data, t("操作失败")));
      else {
        message.success(t("已从 MWAA 下线(DAG 已移除,调度停止)"));
        setWorkflow((w: any) => ({ ...w, cronExpression: "", scheduleEnabled: false, status: "draft", airflowDagId: undefined }));
        setCronInput("");
      }
    } finally { setActionLoading((p) => ({ ...p, publish: false })); }
  };

  const saveTriggers = async (triggers: string[]) => {
    setWorkflow((w: any) => ({ ...w, triggers }));
    setSavingDeps(true);
    try {
      await fetch(`/api/workflow/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggers }),
      });
      message.success(t("已保存下游依赖"));
    } catch {
      message.error(t("保存失败"));
    } finally {
      setSavingDeps(false);
    }
  };

  const handleSave = async () => {
    setActionLoading((p) => ({ ...p, save: true }));
    try {
      await fetch(`/api/workflow/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dagDefinition: { nodes: nodesRef.current, edges: edgesRef.current } }),
      });
      savedRef.current = normalizeDag(nodesRef.current, edgesRef.current);
      setDirty(false);
      message.success(t("已保存"));
    } finally {
      setActionLoading((p) => ({ ...p, save: false }));
    }
  };

  // L3：发布前校验 DAG 是否可用。返回 { errors, warnings }。
  const validateDag = () => {
    const ns = nodesRef.current || [];
    const es = edgesRef.current || [];
    const errors: string[] = [];
    const warnings: string[] = [];
    if (ns.length === 0) { errors.push(t("画布为空，请先添加并配置节点")); return { errors, warnings }; }
    for (const n of ns) {
      const d = n.data || {};
      const nm = d.label || n.id;
      // 33-B: 校验从 registry(SSOT)取,替代此前散落的三处硬编码 if。
      const def = n.type ? NODE_REGISTRY[n.type as keyof typeof NODE_REGISTRY] : undefined;
      if (!def) { errors.push(t("未知节点类型「{nm}」", { nm })); continue; }
      const err = def.validate(d);
      if (err) errors.push(t(err.key, { nm }));
    }
    if (ns.length > 1) {
      const connected = new Set<string>();
      for (const e of es) { connected.add(e.source); connected.add(e.target); }
      const isolated = ns.filter((n) => !connected.has(n.id)).map((n) => n.data?.label || n.id);
      if (isolated.length) warnings.push(t("存在未连线的孤立节点：{list}（将各自独立运行）", { list: isolated.join("、") }));
    }
    return { errors, warnings };
  };

  const doPublish = async () => {
    setActionLoading((p) => ({ ...p, publish: true }));
    try {
      // 发布前若有未保存改动，先静默保存，确保发布的是当前画布。
      if (dirty) {
        await fetch(`/api/workflow/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dagDefinition: { nodes: nodesRef.current, edges: edgesRef.current } }),
        });
        savedRef.current = normalizeDag(nodesRef.current, edgesRef.current);
        setDirty(false);
      }
      const res = await fetch(`/api/workflow/${id}/publish`, { method: "POST" });
      const data = await res.json();
      if (data.success !== false && !data.error) {
        message.success(t("已发布到 Airflow"));
        // 🔴 发布成功后页头必须立刻反映真相:原来只弹 toast,状态 Badge 仍是 draft、
        //   「DAG: …」标不出现,直到用户离开再进来(…7698 页面驱动 p43b W5 坐实)。服务端已把 status=active / airflowDagId 落库,
        //   这里按**服务端返回的 dagId** 同步本地状态(与 applySchedule 同一写法)。
        setWorkflow((w: any) => ({ ...(w || {}), status: "active", airflowDagId: data.dagId || w?.airflowDagId }));
      } else message.error(data.error?.message || data.error || t("发布失败"));
    } finally {
      setActionLoading((p) => ({ ...p, publish: false }));
    }
  };

  const handlePublish = async () => {
    const { errors, warnings } = validateDag();
    if (errors.length) {
      Modal.error({ title: t("无法发布：DAG 校验未通过"), content: (<ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>) });
      return;
    }
    if (warnings.length) {
      Modal.confirm({
        title: t("发布前确认"),
        content: (<><div>{t("以下提示不影响发布，确认继续？")}</div><ul style={{ marginTop: 8, paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></>),
        okText: t("继续发布"), cancelText: t("返回检查"),
        onOk: doPublish,
      });
      return;
    }
    await doPublish();
  };

  const handleTrigger = async () => {
    setActionLoading((p) => ({ ...p, trigger: true }));
    try {
      const res = await fetch(`/api/workflow/${id}/trigger`, { method: "POST" });
      const data = await res.json();
      data.success !== false ? message.success(t("已触发运行")) : message.error(data.error?.message || t("触发失败"));
      // Refresh runs
      if (activeTab === "runs") {
        refreshRuns();
      }
    } finally {
      setActionLoading((p) => ({ ...p, trigger: false }));
    }
  };

  const openAirflowConsole = async () => {
    const dagId = workflow?.airflowDagId || "";
    // 控制台在**这条编排绑定的区**(记录上的章;无章 = 存量 = 主控区)
    const wfTarget = targetOfStamp((Array.isArray(workflow?.targets) && workflow.targets[0]) || (workflow as { targetId?: unknown } | null)?.targetId);
    const res = await fetch(`/api/workflow/airflow?dagId=${dagId}&targetId=${encodeURIComponent(wfTarget)}`);
    const data = await res.json();
    if (data.success && data.data?.loginUrl) {
      window.open(data.data.loginUrl, "_blank");
    } else {
      message.error(data.error?.message || t("无法打开 Airflow 控制台"));
    }
  };

  const addNode = (template: (typeof nodeTemplates)[number]) => {
    setNodes((prev) => {
      // L1：同类节点自动编号，画布上可区分（SQL 执行 1 / 2 …）。
      const seq = prev.filter((n) => n.type === template.type).length + 1;
      const newNode: Node = {
        id: `${template.type}-${Date.now()}`,
        type: template.type,
        position: { x: 250 + Math.random() * 100, y: 100 + prev.length * 120 },
        data: { ...template.data, label: `${template.data.label} ${seq}` },
      };
      return [...prev, newNode];
    });
    setDirty(true);
  };

  // 这个工作流的执行区(行上的章 `targets[]`;无章的存量工作流 = 主控区,与 openAirflowConsole 同口径)。
  //   节点面板与下游依赖下拉都按它过滤候选(?scope=),与发布期落点一致性判定同一口径。权威判定在服务端(job-node-spec.ts)。
  const wfTargets: string[] = workflowTargetsOf(workflow as { targets?: unknown; targetId?: unknown } | null, targetOfStamp);

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/workflow")}>{t("返回")}</Button>
          <h2 style={{ margin: 0 }}>{workflow?.name || t("工作流")}</h2>
          <Badge status={workflow?.status === "active" ? "success" : "default"} text={workflow?.status} />
          <EnvTag env={(workflow as { env?: string } | null)?.env || "dev"} current />
          {workflow?.airflowDagId && <Tag color="blue">DAG: {workflow.airflowDagId}</Tag>}
          {dirty && <Tag color="warning">● {t("未保存更改")}</Tag>}
        </Space>
        <Space>
          <Dropdown menu={{ items: nodeTemplates.map(({ key, label, ...rest }) => ({ key, label: t(label), onClick: () => addNode({ key, label, ...rest }) })) }}>
            <Button icon={<PlusOutlined />}>{t("添加节点")}</Button>
          </Dropdown>
          <Button type={dirty ? "primary" : "default"} icon={<SaveOutlined />} onClick={handleSave} loading={actionLoading.save}>{t("保存")}{dirty ? " *" : ""}</Button>
          <Button icon={<HistoryOutlined />} onClick={() => setVersionOpen(true)}>{t("版本历史")}</Button>
          <PromoteButton type="workflow" id={id} />
          <EnvPromotionStatus type="workflow" id={id} />
          <Button icon={<CloudUploadOutlined />} onClick={handlePublish} loading={actionLoading.publish}>{t("发布到调度")}</Button>
          {workflow?.airflowDagId && (
            <Tooltip
              title={
                isPlatformAdmin
                  ? t("在 Airflow 中查看 DAG 详情、任务日志、甘特图")
                  : t("仅平台管理员可打开:平台只有一个 MWAA 环境、Airflow 无 DAG 级授权,登录凭证等于所有项目 DAG 的控制权")
              }
            >
              <Button icon={<DashboardOutlined />} onClick={openAirflowConsole} disabled={!isPlatformAdmin}>
                {t("Airflow 控制台")}
              </Button>
            </Tooltip>
          )}
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleTrigger} loading={actionLoading.trigger}>{t("触发运行")}</Button>
        </Space>
      </div>

      {/* Workflow info */}
      {workflow?.description && (
        <Card size="small" style={{ marginBottom: 12 }}>
          {workflow.description}
          {workflow.cronExpression && <Tag style={{ marginLeft: 8 }}>{t("调度")}: {workflow.cronExpression}</Tag>}
          <Tag style={{ marginLeft: 8 }}>{nodes.length} {t("节点")} / {edges.length} {t("连线")}</Tag>
        </Card>
      )}

      {/* 周期调度:cron → 应用(落库+发布 DAG);已配置时可一键下线 MWAA。 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space align="center" wrap>
          <FieldTimeOutlined />
          <span>{t("周期调度")}:</span>
          <Input value={cronInput} onChange={(e) => setCronInput(e.target.value)}
            placeholder="cron: */30 * * * *" style={{ width: 200 }} />
          <Button size="small" type="primary" loading={actionLoading.publish} onClick={applySchedule}>{t("应用并发布")}</Button>
          {workflow?.cronExpression && <Tag color="blue">{t("当前")}: {workflow.cronExpression}</Tag>}
          {(workflow?.scheduleEnabled || workflow?.status === "active") && (
            <Popconfirm title={t("从 MWAA 下线(pause + 删 DAG,调度停止)?")} onConfirm={offlineSchedule}>
              <Button size="small" danger loading={actionLoading.publish}>{t("下线调度")}</Button>
            </Popconfirm>
          )}
          <span style={{ color: "#999", fontSize: 12 }}>{t("五段 cron(UTC);触发运行不受影响,随时可手动触发")}</span>
        </Space>
      </Card>

      {/* SCH-03: downstream dependency scheduling */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space align="center">
          <ApartmentOutlined />
          <span>{t("下游依赖（本工作流运行成功后自动触发）：")}</span>
          <Select
            mode="multiple"
            allowClear
            loading={savingDeps}
            style={{ minWidth: 360 }}
            placeholder={t("选择运行成功后要触发的下游同步任务 / 工作流")}
            value={workflow?.triggers || []}
            onChange={saveTriggers}
            options={depOptions}
            optionFilterProp="label"
            data-testid="wf-dep-select"
          />
          {depOptionsError && <span data-testid="wf-dep-error" style={{ color: "#cf1322", fontSize: 12 }}>{t("候选读取失败:{msg}", { msg: depOptionsError })}</span>}
        </Space>
      </Card>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "editor", label: t("DAG 编辑器"), children: (
          <DagEditor nodes={nodes} edges={edges} wfTargets={wfTargets} onChange={(n, e) => { setNodes(n); setEdges(e); setDirty(normalizeDag(n, e) !== savedRef.current); }} />
        )},
        { key: "runs", label: t("运行历史 ({n})", { n: runs.length }), children: (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Button size="small" onClick={refreshRuns}>{t("刷新")}</Button>
              {workflow?.airflowDagId && (
                <Tooltip title={isPlatformAdmin ? "" : t("仅平台管理员可打开(Airflow 无 DAG 级授权)")}>
                  <Button size="small" icon={<LinkOutlined />} onClick={openAirflowConsole} disabled={!isPlatformAdmin}>
                    {t("在 Airflow 中查看")}
                  </Button>
                </Tooltip>
              )}
            </Space>
            <Table size="small" dataSource={runs} rowKey="runId" locale={{ emptyText: t("暂无运行记录。点击\"触发运行\"开始。") }}
              columns={[
                { title: t("运行ID"), dataIndex: "runId", width: 180, render: (v: string) => <code style={{fontSize:11}}>{v?.slice(0,20)}</code> },
                { title: t("状态"), dataIndex: "status", width: 100, render: (v: string) => <Badge status={v === "succeeded" ? "success" : v === "failed" ? "error" : v === "running" ? "processing" : "default"} text={v} /> },
                // 🔴 MWAA Serverless 的运行行由运行时 __start 写台账,triggeredBy 写死 "schedule"
                //   (worker 侧分不出手动 / 定时,与离线计算页同一事实);原来这里照抄出来 ⇒ 用户点「触发运行」看到的却是「schedule」
                //   (…7698 页面驱动 p43b W6 坐实)。与离线计算页同口径:serverless 运行只标调度器,不宣称触发来源。
                { title: t("触发方式"), dataIndex: "triggeredBy", width: 100, render: (v: string, r: any) => r.scheduler === "serverless"
                  ? <Tag color="gold" data-testid="run-scheduler-tag">Serverless</Tag>
                  : <Tag>{v || "manual"}</Tag> },
                { title: t("开始时间"), dataIndex: "startedAt", width: 180, render: (v: string) => v?.slice(0,19).replace("T"," ") },
                { title: t("结束时间"), dataIndex: "finishedAt", width: 180, render: (v: string) => v ? v.slice(0,19).replace("T"," ") : "-" },
                { title: t("耗时"), dataIndex: "duration", width: 80, render: (v: number) => v ? `${v}s` : "-" },
                { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <span style={{color:"#ff4d4f"}}>{v}</span> : "-" },
                { title: t("操作"), width: 250, render: (_: any, r: any) => (
                  <Space>
                    <Button size="small" icon={<FileTextOutlined />} onClick={() => viewRunLog(r.runId)}>{t("日志")}</Button>
                    <Button size="small" icon={<ApartmentOutlined />} onClick={() => viewNodes(r.runId)}>{t("节点")}</Button>
                    {["succeeded", "failed"].includes(r.status) && <DiagnosisButton taskId={id} runId={r.runId} label={r.status === "failed" ? t("AI 诊断") : t("AI 分析")} />}
                  </Space>
                )},
              ]}
            />
          </div>
        )},
        { key: "config", label: t("配置"), children: (
          <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 16, borderRadius: 8, fontSize: 12, maxHeight: 400, overflow: "auto" }}>
            {JSON.stringify(workflow, null, 2)}
          </pre>
        )},
      ]} />

      <Modal title={t("运行日志 - {rid}", { rid: logModal.runId?.slice(0,16) })} open={logModal.open} onCancel={() => setLogModal({ open: false, runId: "", logs: [] })} footer={null} width={900}>
        <div style={{ maxHeight: 500, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {logModal.logs.length > 0 ? logModal.logs.map((line, i) => <div key={i}>{line}</div>) : <span style={{ color: "#808080" }}>{t("加载中...")}</span>}
        </div>
      </Modal>

      <Modal title={t("节点详情 - {rid}", { rid: nodeModal.runId?.slice(0, 16) })} open={nodeModal.open} onCancel={() => setNodeModal({ open: false, runId: "", nodes: [], loading: false, selected: "", logs: [], logsLoading: false })} footer={null} width={1000}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ width: 320, maxHeight: 480, overflow: "auto", borderRight: "1px solid #1d4254", paddingRight: 8 }}>
            {nodeModal.loading ? <Spin /> : (
              <Table size="small" pagination={false} dataSource={nodeModal.nodes} rowKey="taskId"
                locale={{ emptyText: t("暂无节点状态（运行可能尚未开始）") }}
                rowClassName={(r: any) => (r.taskId === nodeModal.selected ? "ant-table-row-selected" : "")}
                columns={[
                  { title: t("节点"), dataIndex: "taskId", ellipsis: true },
                  { title: t("状态"), dataIndex: "state", width: 100, render: (v: string) => <Badge status={v === "success" ? "success" : v === "failed" ? "error" : v === "running" ? "processing" : "default"} text={v} /> },
                  // 作业 / 同步节点 ⇒ 点回它自己的运行历史(backLink 由节点状态接口按发布定义挂上;地址唯一作者 nodeBackLinkHref)
                  { title: "", width: 90, render: (_: any, r: { backLink?: NodeBackLink | null }) => {
                    const href = nodeBackLinkHref(r.backLink);
                    return href ? <Link href={href} data-testid="node-job-run-link" style={{ fontSize: 12 }}>{r.backLink?.nodeType === "sync" ? t("同步运行历史") : t("作业运行历史")}</Link> : null;
                  } },
                  { title: "", width: 50, render: (_: any, r: any) => <Button size="small" type="link" icon={<FileTextOutlined />} onClick={() => viewNodeLog(r.taskId, r.tryNumber)} /> },
                ]}
              />
            )}
          </div>
          <div style={{ flex: 1, maxHeight: 480, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {!nodeModal.selected ? <span style={{ color: "#808080" }}>{t("点击左侧节点的日志按钮查看其日志")}</span>
              : nodeModal.logsLoading ? <span style={{ color: "#808080" }}>{t("加载中...")}</span>
              : nodeModal.logs.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      </Modal>
      <VersionHistoryDrawer
        type="workflow"
        id={id}
        open={versionOpen}
        onClose={() => setVersionOpen(false)}
        onRolledBack={() => { setVersionOpen(false); setReloadKey((k) => k + 1); message.success(t("已刷新为回滚后的内容")); }}
      />
    </div>
  );
}
