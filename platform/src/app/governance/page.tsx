"use client";

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Tabs, Input, Table, Card, Tag, Space, Button, Empty, Spin, Select, Alert, message, Modal, InputNumber, Popconfirm, Statistic } from "antd";
import { SearchOutlined, DatabaseOutlined, ApartmentOutlined, ThunderboltOutlined, SafetyCertificateOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { QUALITY_TEMPLATES_META, DIMENSION_LABELS } from "@/lib/quality/templates";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useT } from "@/lib/i18n/useT";
// 治理三件(目录 / 质量 / 敏感扫描)按顶栏「执行范围」查那个区的数仓。
// 🔴 读用 `?scope=`,执行(质量运行 / 敏感扫描)用 **body.targetId**(写路由不读 scope,SPEC §2.6.3)。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
// 目录筛选的事实(拆库·schema / 过滤 / 候选 / URL 往返)全在纯模块里,页面只渲染。
import {
  applyCatalogFilter, catalogFilterOptions, catalogFilterFromSearch, catalogFilterToSearch,
  EMPTY_CATALOG_FILTER, isEmptyCatalogFilter, splitDatabase, SENSITIVITY_NONE, type CatalogFilter,
} from "@/lib/governance/catalog-filters";
import dynamic from "next/dynamic";
import CrossTargetMirrorOverview from "@/components/governance/CrossTargetMirrorOverview";
// (治理)—— 定时治理任务(质量检查 / 敏感扫描 / 目录同步按 cron 在该区跑)
import GovernanceSchedules from "@/components/governance/GovernanceSchedules";
// 数据目录「新建表」向导 / 行操作「修改表结构」
import CreateTableWizard from "@/components/governance/CreateTableWizard";
import AlterTableDrawer, { type AlterTarget } from "@/components/governance/AlterTableDrawer";
import "reactflow/dist/style.css";

const ReactFlow = dynamic(() => import("reactflow").then((m) => m.default), { ssr: false });

const typeColor: Record<string, string> = {
  mysql: "#1677ff", postgresql: "#336791", s3: "#e47911", redshift: "#8c4fff", glue: "#00a1c9",
  // 物理端点(bgp-physical 容器 / bgp-streams 流):RDS 实例 / S3 桶 / Redshift 集群 / Kinesis 流
  rds: "#2e73b8", s3bucket: "#e47911", rscluster: "#8c4fff", kinesis: "#ff9900", storage: "#5a6b7b",
};
const typeIcon: Record<string, string> = {
  mysql: "🐬", postgresql: "🐘", s3: "📁", redshift: "🏢", glue: "📊",
  rds: "🛢️", s3bucket: "🪣", rscluster: "🖥️", kinesis: "🌊", storage: "💾",
};

// sensitivity levels + mask strategies (display).
const LEVELS = ["L1", "L2", "L3", "L4"] as const;
const LEVEL_META: Record<string, { label: string; color: string }> = {
  L1: { label: "L1 公开", color: "green" },
  L2: { label: "L2 内部", color: "blue" },
  L3: { label: "L3 机密", color: "orange" },
  L4: { label: "L4 核心机密", color: "red" },
};
const MASK_OPTS = [
  { value: "none", label: "不脱敏" },
  { value: "full", label: "完全掩码 (***)" },
  { value: "partial", label: "部分 (首尾保留)" },
  { value: "email", label: "邮箱 (j***@x.com)" },
  { value: "hash", label: "哈希 (sha256)" },
];

// Build ReactFlow nodes/edges from a {nodes, edges, centerNode} lineage payload with a
// simple BFS layered layout (upstream left, downstream right). Shared by the 数据血缘 and
// 影响分析 views. `downstream` edges (impact view) are drawn in orange.
function buildFlowGraph(data: any): { rfNodes: any[]; rfEdges: any[] } {
  const rfNodeData: any[] = data?.nodes || [];
  const rfEdgesRaw: any[] = data?.edges || [];
  const layerMap: Record<string, number> = {};
  const center = data?.centerNode || rfNodeData[0]?.fqn;
  if (center) {
    layerMap[center] = 0;
    const sourceOf: Record<string, string[]> = {};
    const targetOf: Record<string, string[]> = {};
    for (const e of rfEdgesRaw) {
      (sourceOf[e.source] ||= []).push(e.target);
      (targetOf[e.target] ||= []).push(e.source);
    }
    const queue = [center];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const src of targetOf[cur] || []) if (!(src in layerMap)) { layerMap[src] = layerMap[cur] - 1; queue.push(src); }
      for (const tgt of sourceOf[cur] || []) if (!(tgt in layerMap)) { layerMap[tgt] = layerMap[cur] + 1; queue.push(tgt); }
    }
  }
  const minLayer = Math.min(0, ...Object.values(layerMap));
  const layerNodes: Record<number, string[]> = {};
  for (const [fqn, layer] of Object.entries(layerMap)) {
    const l = layer - minLayer;
    (layerNodes[l] ||= []).push(fqn);
  }
  const rfNodes = rfNodeData.map((n: any) => {
    const layer = (layerMap[n.fqn] || 0) - minLayer;
    const siblings = layerNodes[layer] || [n.fqn];
    const idx = siblings.indexOf(n.fqn);
    const parts = n.fqn.split(".");
    const label = parts.slice(-1)[0];
    const dbInfo = parts.slice(0, -1).join(".");
    return {
      id: n.fqn,
      position: { x: layer * 300, y: idx * 140 },
      data: {
        label: (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16 }}>{typeIcon[n.type] || "📋"}</div>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{label}</div>
            <div style={{ fontSize: 10, color: "#888" }}>{dbInfo}</div>
          </div>
        ),
      },
      style: {
        border: `2px solid ${typeColor[n.type] || "#3a4a63"}`,
        borderRadius: 8, padding: 8, minWidth: 140,
        background: n.fqn === center ? "rgba(34, 211, 238, 0.16)" : "#0c1c28",
        color: "#cfe6f0",
      },
    };
  });
  const rfEdges = rfEdgesRaw.map((e: any, i: number) => ({
    id: `e-${i}`, source: e.source, target: e.target, animated: true,
    label: e.lineageType, labelStyle: { fontSize: 10 },
    style: { stroke: e.lineageType === "sync" ? "#1677ff" : e.lineageType === "downstream" ? "#fa541c" : "#52c41a" },
  }));
  return { rfNodes, rfEdges };
}

export default function GovernancePage() {
  const t = useT();
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  // 🔴 每一条治理请求都要带范围:治理记录的分区键
  // 现在是 `<targetId>::<fqn>`(home 裸 fqn)。不带范围 = 去主控区的分区上读写本区那张表的
  // 标签 / 规则 / 结果 ⇒ 两个区互相顶(用户的词:「串味」)。
  const scopeQs = scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : "";
  const runTargetId = scope.kind === "target" ? scope.targetId : undefined;
  // 🔴 治理**写入 / 执行**的落点唯一作者(单区视角 = 该区;「全部 / 对比」= 显式主控区,
  //   与读侧 `governanceTargetFrom` 同一口径)。原来「添加规则」「保存分级」两样都不带 ⇒ 服务端回落主控区 ⇒
  //   us-west-2 视角加的规则 / 设的级别写进主控区那张表,而列表按本区读 ⇒「加了看不见」。服务端现在缺即 400。
  const govTargetId = landingOfScope(scope);
  const runRegion = runTargetId ? scopeTargets?.find((x) => x.targetId === runTargetId)?.region || runTargetId : "";
  // 该区未部署数仓时服务端回的说明(空串 = 正常)
  const [noWarehouse, setNoWarehouse] = useState("");
  // 目录的新鲜度(target 视角才有):目录来自**元数据同步**,
  // 不是实时直查 ⇒ 必须把「同步于何时 / 什么状态」显示出来,否则用户不知道自己在看什么时候的目录。
  const [catalogFresh, setCatalogFresh] = useState<any>(null);
  // 🔴🔴 `catalogData` 只有**一个**语义:**数据目录页签当前那次搜索的结果**。
  //   它**不是**「可选资产全集」—— 别的页签的资产选择器**绝不许**拿它当 `options`。
  //   (原来血缘 / 影响分析 / 数据分级 / 数据质量**四处**都写着 `options={catalogData.map(...)}`,
  //    于是用户在目录里搜过一次之后,那四个选择器就只剩搜到的那几张表 ——
  //    想给别的表跑质量检查,得先回目录把搜索框清空,而界面上没有任何线索。
  //    本仓已为「同一个集合被当成两件事用」立过记忆 one-set-two-meanings-deadlock。)
  const [catalogData, setCatalogData] = useState<any[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  // 🔴 资产全集(选择器候选)的**唯一**持有者:只由 `loadAllAssets()` 写,与搜索完全无关。
  const [allAssets, setAllAssets] = useState<any[]>([]);
  const [keyword, setKeyword] = useState("");
  // (客户 2026-10-19:「数据目录缺少数据库类型、schema、bucket 等筛选条件」)
  // 🔴 筛选是**本地**过滤(目录数据已整份在手,pageSize 20 只是分页),不另打接口;初值来自地址栏、改动写回地址栏
  //   (只动自己的 5 个键,执行范围 `scope` 等原样保留),刷新 / 分享不丢。
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>(EMPTY_CATALOG_FILTER);
  useEffect(() => {
    if (typeof window !== "undefined") setCatalogFilter(catalogFilterFromSearch(window.location.search));
  }, []);
  const updateCatalogFilter = (patch: Partial<CatalogFilter>) => {
    setCatalogFilter((prev) => {
      const next: CatalogFilter = { ...prev, ...patch };
      if (patch.db !== undefined && patch.db !== prev.db) next.schema = ""; // 换了库 ⇒ schema 候选变了,旧值作废
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", `${window.location.pathname}${catalogFilterToSearch(next, window.location.search)}`);
      }
      return next;
    });
  };
  const filteredCatalog = useMemo(() => applyCatalogFilter(catalogData, catalogFilter), [catalogData, catalogFilter]);
  const catalogOptions = useMemo(() => catalogFilterOptions(catalogData, catalogFilter.db), [catalogData, catalogFilter.db]);
  const catalogFiltered = !isEmptyCatalogFilter(catalogFilter);
  const [lineageFqn, setLineageFqn] = useState("");
  const [lineageData, setLineageData] = useState<any>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("catalog");
  // 「当前 target」/「全部 target」两个视图(INTERACTION §4quater)。
  // 🔴 缺省仍是 `current`:多区域是**增量能力**,不改任何既有用户的默认落地画面。
  const [scopeView, setScopeView] = useState<"current" | "all">("current");
  const [qualityData, setQualityData] = useState<any>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  const [impactFqn, setImpactFqn] = useState("");
  const [impactData, setImpactData] = useState<any>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // 新建表向导 / 改表抽屉
  const [createOpen, setCreateOpen] = useState(false);
  const [alterTarget, setAlterTarget] = useState<AlterTarget | null>(null);
  const [classFqn, setClassFqn] = useState("");
  const [classCols, setClassCols] = useState<any[]>([]);
  const [classLoading, setClassLoading] = useState(false);
  const [myGrants, setMyGrants] = useState<any[]>([]);
  const [newCol, setNewCol] = useState("");
  // 数据质量
  const [qFqn, setQFqn] = useState("");
  const [qRules, setQRules] = useState<any[]>([]);
  const [qResults, setQResults] = useState<any>(null);
  const [qLoading, setQLoading] = useState(false);
  const [qRunning, setQRunning] = useState(false);
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [arType, setArType] = useState<string>("not_null");
  const [arColumn, setArColumn] = useState("");
  const [arParams, setArParams] = useState<Record<string, any>>({});
  const [arSeverity, setArSeverity] = useState<"error" | "warn">("error");
  const [arWeight, setArWeight] = useState<number>(1);
  // (E5) 敏感数据识别扫描
  const [scanDb, setScanDb] = useState("dev");
  const [scanSchema, setScanSchema] = useState("");
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanAdopting, setScanAdopting] = useState(false);
  const [scanSelected, setScanSelected] = useState<string[]>([]);
  const [scanOverrides, setScanOverrides] = useState<Record<string, { level?: string; maskStrategy?: string }>>({});

  const { getToken, user, loading: authLoading } = useAuth();

  // The governance read APIs now require a valid Cognito token. Attach the ID token to each call.
  const authedFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    const token = await getToken();
    if (!token) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    const res = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) return null; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    return res;
  };

  // 🔴🔴 **并发请求的陈旧响应竞态:晚到的那份会赢**(本仓已经栽过一次 —— 那次的形态是
  //   「某区视角显示别的区的数仓」,真根同样是这个)。改动前本函数是
  //     `const d = await fetch(...); setCatalogData(...)`
  //   ——**没有序号、没有 AbortController、没有「只认最后一次」**⇒ 快速连搜两次(或切区与搜索同时发生)
  //   时,两个请求并发,**谁晚回来谁写进 state**:用户搜了新词,列表显示的却是上一次的结果。
  // ⇒ 三件套:记序号 → 回来时比序号 → 不是最后一次就**丢弃**(连 loading 也不许关,免得把
  //   正在飞的那次的 loading 提前关掉)。
  const catalogSeqRef = useRef(0);
  const assetsSeqRef = useRef(0);
  // 🔴🔴 **这一页每一个「取数后写 state」的函数都要有序号闸**。
  //   为什么不是「挑几个重要的修」:那个缺陷(晚到的陈旧响应赢)不挑对象
  //   任何一个「发请求 → 等回来 → 写共享 state」的函数,只要能被触发两次就有它。
  //   登记时我写的是「至少 5 个是真竞态」,细看**动作型也一样是真竞态**:
  //   `runQuality` 点两次、`addRule` 快速加两条,晚到的旧响应照样会盖掉新的。
  //   ⇒ 不分等级,12 个全修;棘轮 `UNGUARDED_LIMIT` 从 12 降到 0。
  // 🔴 闸放在**「用取回的数据写 state」之前**,不放在函数开头 ——
  //   开头那些 `setXxxFqn(fqn)` / `setXxxLoading(true)` 是**用户动作直接决定**的,
  //   拦住它们会变成「点了没反应」(那是另一个 bug)。
  // 🔴 `finally` 里关 loading 也要过闸:否则**旧响应的 finally** 会把新请求的 loading 关掉
  //   (与 `bootstrapCatalog` 同一处理)。
  const seqRefs = {
    lineage: useRef(0), impact: useRef(0), grants: useRef(0), classification: useRef(0),
    qRules: useRef(0), qResults: useRef(0), quality: useRef(0), qRun: useRef(0),
    addRule: useRef(0), sensScan: useRef(0), adopt: useRef(0), schemaSync: useRef(0),
  };

  /** 取数的**唯一作者**:只取,不写任何 state(所以它没有语义 —— 谁写 state 谁自己管序号闸)。 */
  const fetchCatalogPayload = async (kw: string) => {
    const res = await authedFetch(`/api/governance/catalog?keyword=${kw}${scopeQs}`);
    if (!res) return null;
    return await res.json();
  };

  /** 写「目录页签那次搜索的结果」的**唯一**一处(含该区没装数仓的说明与新鲜度)。 */
  const applyCatalogPayload = (d: any) => {
    setCatalogFresh(d?._meta?.catalogFreshness || null);
    // 该区没装数仓 ⇒ 说清原因,别显示一张空目录
    const payload = d.success ? d.data : [];
    // 🔴 **两条路都要认**:目录现在主要走 OpenMetadata(用户 2026-09-10 拍板「都走同一个 OM」),
    //   那条路上没有 `capability` 字段 ⇒ 服务端把「该区没装数仓」放在 `_meta.warehouse`。
    //   只认下面那个 `payload.capability` 的旧写法 ⇒ core-only 目标看到的是一张**不给原因的空目录**,
    //   用户会以为同步坏了 / 表被删了(就是这么被判据挖出来的)。
    const metaNoWh = d?._meta?.warehouse?.reason ? String(d._meta.warehouse.reason) : "";
    if (payload && !Array.isArray(payload) && payload.capability === "unavailable") {
      setNoWarehouse(String(payload.reason || ""));
      setCatalogData([]);
    } else {
      setNoWarehouse(metaNoWh);
      setCatalogData(Array.isArray(payload) ? payload : []);
    }
  };

  /** 写「可选资产全集」的**唯一**一处。 */
  const applyAssetsPayload = (d: any) => {
    const payload = d.success ? d.data : [];
    setAllAssets(Array.isArray(payload) ? payload : []);
  };

  const searchCatalog = async (kw?: string) => {
    const seq = ++catalogSeqRef.current;
    setCatalogLoading(true);
    try {
      const d = await fetchCatalogPayload(kw || keyword);
      if (!d) return;
      // 🔴 陈旧响应:丢掉,绝不写 state(它会盖掉更晚发出、但更早/更晚回来的那一份)
      if (seq !== catalogSeqRef.current) return;
      applyCatalogPayload(d);
    } finally {
      // 🔴 连 loading 也只认最后一次:陈旧响应回来时若也关 loading,
      //   正在飞的那次就变成「没有加载中」⇒ 用户以为已经搜完了。
      if (seq === catalogSeqRef.current) setCatalogLoading(false);
    }
  };

  // 🔴🔴 **资产全集(选择器候选)的唯一作者。** 与 `searchCatalog` 彻底分开:
  //   它**永远不带 keyword**,所以用户在目录页签里搜什么都影响不到别的页签的候选清单。
  //   这就是该缺陷的根治点:缺陷不是「某个选择器坏了」,是**一份 state 被当成两件事用**,
  //      所以修法必须是「把两个语义拆成两份 state」,而不是给那四处各打一个补丁。
  // 🔴 序号保护照抄 `searchCatalog`(切执行范围**不重载页面**,两次 scope 的响应会并发 ——
  //   同一个根,这里是第二处;**口径不许另写一遍**)。
  const loadAllAssets = async () => {
    const seq = ++assetsSeqRef.current;
    const d = await fetchCatalogPayload("");
    if (!d) return;
    if (seq !== assetsSeqRef.current) return; // 陈旧响应:丢掉
    applyAssetsPayload(d);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // (**第二刀:修法订正**)
  //
  // 🔴🔴 进页面 / 切范围时**只取一次数**,分别写两份 state。
  //
  // 【为什么不是各调一次 —— 我上一版就是各调一次,而且在注释里写了「值得」,那是没有依据的】
  // 带时间戳实测(`/tmp/probe_b18_timing.py`):两个**参数逐字节相同**的请求同时发出
  //     1.6s REQ keyword=&scope=tgt_home   ← 两条一模一样
  //     1.6s REQ keyword=&scope=tgt_home
  //     6.2s RESP 200                       ← 第一个
  //    10.4s RESP 200                       ← 第二个被拖慢 4.2s(服务端串行处理这个重活:
  //                                            OM 全量 2000 行 + 逐行分级注解)
  //   ⇒ 候选清单就绪从 **+6.2s 推迟到 +11.1s**,用户打开页面立刻点「数据质量」会看到空下拉。
  //   **多发一次完全相同的请求,换不来任何语义清晰度。**
  //
  // 🔴 这**不是**把两个语义焊回去:两份 state 的正确初值**恰好就是同一次取数的结果**
  //   (都是「关键词为空」),如实表达这个事实 = 取一次、赋两次;
  //   而**之后**任何一次搜索只写 `catalogData`、任何一次资产刷新只写 `allAssets`,两者再不相干。
  //   两个序号闸也各判各的 —— 谁陈旧谁丢弃,互不代劳。
  // ══════════════════════════════════════════════════════════════════════════
  const bootstrapCatalog = async () => {
    const cSeq = ++catalogSeqRef.current;
    const aSeq = ++assetsSeqRef.current;
    setCatalogLoading(true);
    try {
      const d = await fetchCatalogPayload("");
      if (!d) return;
      if (cSeq === catalogSeqRef.current) applyCatalogPayload(d);
      if (aSeq === assetsSeqRef.current) applyAssetsPayload(d);
    } finally {
      if (cSeq === catalogSeqRef.current) setCatalogLoading(false);
    }
  };

  // 四个页签的资产选择器共用这一份 `options`(label 口径也收成**单一作者** ——
  // 原来那段 `typeIcon[...] || typeIcon[fqn.split(".")[0]]` 在四处各写了一遍)。
  const assetOptions = useMemo(
    () => allAssets.map((c) => ({
      label: `${typeIcon[c.type] || typeIcon[c.fqn?.split(".")[0]] || ""} ${c.fqn}`,
      value: c.fqn,
    })),
    [allAssets],
  );

  // B2 修复: 把 Redshift 真实列回填 OM（修字段数恒为 1）。仅管理员可见/可用。
  const [syncingSchema, setSyncingSchema] = useState(false);
  const syncRedshiftSchema = async () => {
    setSyncingSchema(true);
    const seq = ++seqRefs.schemaSync.current;
    try {
      const res = await authedFetch(`/api/governance/sync-redshift-schema`, { method: "POST" });
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.schemaSync.current) return; // 陈旧响应:丢掉
      // 同步列信息是长操作 —— 超过 45 秒服务端回 202(协议 long-op/1),全局 fetch 拦截器轮询到终态再交回
      //   同形 200 / 500,页面右下「正在后台执行:同步列信息到数据目录(已 n 秒)」;那套治理专用 202 + GET 轮询在这里退役。
      // 🔴 列信息回填会改变资产内容 ⇒ **两份 state 都要刷**(只刷一份就是新的漂移源)
      if (d.success) { message.success(d.data?.message || t("已同步 Redshift 列信息")); await searchCatalog(); await loadAllAssets(); }
      else message.error(d.error?.message || t("同步失败"));
    } finally { if (seq === seqRefs.schemaSync.current) setSyncingSchema(false); }
  };

  const loadLineage = async (fqn: string) => {
    setLineageFqn(fqn);
    setLineageLoading(true);
    const seq = ++seqRefs.lineage.current;
    try {
      const res = await authedFetch(`/api/governance/lineage?fqn=${encodeURIComponent(fqn)}&depth=3${scopeQs}`);
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.lineage.current) return; // 陈旧响应:丢掉
      setLineageData(d.success ? d.data : null);
    } finally { if (seq === seqRefs.lineage.current) setLineageLoading(false); }
  };

  const loadImpact = async (fqn: string) => {
    setImpactFqn(fqn);
    setImpactLoading(true);
    const seq = ++seqRefs.impact.current;
    try {
      const res = await authedFetch(`/api/governance/impact?fqn=${encodeURIComponent(fqn)}&depth=3${scopeQs}`);
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.impact.current) return; // 陈旧响应:丢掉
      setImpactData(d.success ? d.data : null);
    } finally { if (seq === seqRefs.impact.current) setImpactLoading(false); }
  };

  // detect platform-admin from the ID token's cognito:groups (server still enforces).
  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const payload = JSON.parse(atob(token.split(".")[1] || ""));
        const groups: string[] = payload["cognito:groups"] || [];
        setIsAdmin(groups.includes("bgp-admin"));
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const loadMyGrants = async () => {
    const seq = ++seqRefs.grants.current;
    const res = await authedFetch(`/api/governance/access-grants${scopeQs ? `?${scopeQs.slice(1)}` : ""}`);
    if (!res) return;
    const d = await res.json();
    if (seq !== seqRefs.grants.current) return; // 陈旧响应:丢掉
    setMyGrants(d.success ? d.data : []);
  };

  // Load a table's columns: UNION of OM columns + already-classified columns, so columns
  // that exist in the DB but aren't in OM (e.g. when the ingestion stack isn't deployed and
  // the OM entity is a stub) still appear and stay editable. The OM "_row" placeholder is skipped.
  const loadClassification = async (fqn: string) => {
    setClassFqn(fqn);
    if (!fqn) { setClassCols([]); return; }
    setClassLoading(true);
    const seq = ++seqRefs.classification.current;
    try {
      const [colsRes, clsRes] = await Promise.all([
        authedFetch(`/api/governance/columns?fqn=${encodeURIComponent(fqn)}`),
        authedFetch(`/api/governance/classification?fqn=${encodeURIComponent(fqn)}${scopeQs}`),
      ]);
      if (!colsRes || !clsRes) return;
      const cols = (await colsRes.json())?.data || [];
      const cls = (await clsRes.json())?.data || [];
      const byKey: Record<string, any> = {};
      const order: string[] = [];
      const addCol = (name: string, dataType?: string) => {
        if (!name || name === "_row") return; // skip OM placeholder stub
        const k = name.toLowerCase();
        if (!(k in byKey)) { byKey[k] = { name, dataType: dataType || "", level: "", maskStrategy: "none", category: "" }; order.push(k); }
        else if (dataType && !byKey[k].dataType) byKey[k].dataType = dataType;
      };
      for (const c of cols) addCol(c.name, c.dataType);
      for (const c of cls) {
        if (!c.column || c.column === "__table__") continue;
        addCol(c.column, t("(已分级)"));
        const k = c.column.toLowerCase();
        byKey[k].level = c.level || ""; byKey[k].maskStrategy = c.maskStrategy || "none"; byKey[k].category = c.category || "";
      }
      if (seq !== seqRefs.classification.current) return; // 陈旧响应:丢掉
      setClassCols(order.map((k) => byKey[k]));
    } finally { if (seq === seqRefs.classification.current) setClassLoading(false); }
  };

  // Manually add a column name to the editor (for tables whose columns OM hasn't ingested).
  const addManualColumn = () => {
    const name = newCol.trim();
    if (!name) return;
    if (classCols.some((c) => c.name.toLowerCase() === name.toLowerCase())) { message.info(t("该字段已在列表中")); setNewCol(""); return; }
    setClassCols((prev) => [...prev, { name, dataType: t("(手动)"), level: "", maskStrategy: "none", category: "" }]);
    setNewCol("");
  };

  // 数据质量
  const loadQRules = async (fqn: string) => {
    const seq = ++seqRefs.qRules.current;
    const res = await authedFetch(`/api/governance/quality-rules?fqn=${encodeURIComponent(fqn)}${scopeQs}`);
    if (!res) return;
    const d = await res.json();
    if (seq !== seqRefs.qRules.current) return; // 陈旧响应:丢掉
    setQRules(d.success ? d.data : []);
  };
  const loadQResults = async (fqn: string) => {
    const seq = ++seqRefs.qResults.current;
    const res = await authedFetch(`/api/governance/quality-results?fqn=${encodeURIComponent(fqn)}&history=1${scopeQs}`);
    if (!res) return;
    const d = await res.json();
    if (seq !== seqRefs.qResults.current) return; // 陈旧响应:丢掉
    setQResults(d.success ? d.data : null);
  };
  const selectQualityTable = async (fqn: string) => {
    setQFqn(fqn);
    if (!fqn) { setQRules([]); setQResults(null); return; }
    setQLoading(true);
    try { await Promise.all([loadQRules(fqn), loadQResults(fqn)]); } finally { setQLoading(false); }
  };
  const runQuality = async () => {
    if (!qFqn) return;
    setQRunning(true);
    const seq = ++seqRefs.qRun.current;
    try {
      const res = await fetch("/api/governance/quality-run", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fqn: qFqn, targetId: govTargetId }),
      });
      const d = await res.json();
      if (seq !== seqRefs.qRun.current) return; // 陈旧响应:丢掉(点两次时旧结果不许赢)
      if (d?.success && d.data?.capability === "unavailable") { setNoWarehouse(String(d.data.reason || "")); message.warning(String(d.data.reason || "")); }
      else if (d?.success) { message.success(t("检查完成，质量分 {score}", { score: d.data.summary.score ?? "—" })); await Promise.all([loadQRules(qFqn), loadQResults(qFqn)]); }
      else message.error(d?.error?.message || t("运行失败"));
    } finally { if (seq === seqRefs.qRun.current) setQRunning(false); }
  };
  const addRule = async () => {
    if (!qFqn) return;
    const seq = ++seqRefs.addRule.current;
    const res = await fetch("/api/governance/quality-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqn: qFqn, type: arType, column: arColumn, params: arParams, severity: arSeverity, weight: arWeight, targetId: govTargetId }),
    });
    const d = await res.json();
    if (seq !== seqRefs.addRule.current) return; // 陈旧响应:丢掉(快速加两条时旧的不许盖掉新的)
    if (d?.success) { message.success(t("规则已添加")); setAddRuleOpen(false); setArColumn(""); setArParams({}); loadQRules(qFqn); }
    else message.error(d?.error?.message || t("添加失败"));
  };
  const delRule = async (ruleId: string) => {
    const res = await fetch(`/api/governance/quality-rules/${ruleId}?fqn=${encodeURIComponent(qFqn)}${scopeQs}`, { method: "DELETE" });
    const d = await res.json();
    if (d?.success) { message.success(t("已删除")); loadQRules(qFqn); } else message.error(d?.error?.message || t("删除失败"));
  };
  const qMetaOf = (type: string) => QUALITY_TEMPLATES_META.find((tpl) => tpl.type === type);
  const qResultFor = (ruleId: string) => (qResults?.results || []).find((r: any) => r.ruleId === ruleId);
  const qParamSummary = (p: Record<string, any>) => Object.entries(p || {}).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
  const scoreColor = (s: number | null) => (s == null ? "#999" : s >= 90 ? "#52c41a" : s >= 70 ? "#faad14" : "#f5222d");

  // (E5) 敏感数据识别扫描
  const findingKey = (f: any) => `${f.fqn}#${f.column}`;
  const runSensitiveScan = async () => {
    setScanLoading(true);
    setScanSelected([]);
    setScanOverrides({});
    const seq = ++seqRefs.sensScan.current;
    try {
      const res = await authedFetch("/api/governance/sensitive-scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: scanDb.trim() || "dev", schema: scanSchema.trim() || undefined, targetId: govTargetId }),
      });
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.sensScan.current) return; // 陈旧响应:丢掉
      if (d?.success && d.data?.capability === "unavailable") {
        setNoWarehouse(String(d.data.reason || ""));
        message.warning(String(d.data.reason || ""));
      } else if (d?.success) {
        setScanResult(d.data);
        const n = d.data?.findings?.length || 0;
        message.success(t("扫描完成，发现 {n} 条敏感字段建议", { n }));
      } else message.error(d?.error?.message || t("扫描失败"));
    } finally { if (seq === seqRefs.sensScan.current) setScanLoading(false); }
  };
  const adoptSensitive = async () => {
    if (!scanResult?.summary?.scanId || scanSelected.length === 0) return;
    const byKey: Record<string, any> = {};
    for (const f of scanResult.findings || []) byKey[findingKey(f)] = f;
    const items = scanSelected.map((k) => {
      const f = byKey[k];
      const ov = scanOverrides[k] || {};
      return { fqn: f.fqn, column: f.column, level: ov.level || f.suggestedLevel, category: f.category, maskStrategy: ov.maskStrategy || f.suggestedMask };
    });
    setScanAdopting(true);
    const seq = ++seqRefs.adopt.current;
    try {
      const res = await authedFetch("/api/governance/sensitive-scan/adopt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanId: scanResult.summary.scanId, items }),
      });
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.adopt.current) return; // 陈旧响应:丢掉
      if (d?.success) {
        message.success(t("已采纳 {n} 条，写入数据分级", { n: d.data.adopted }));
        setScanSelected([]);
        // 刷新扫描结果（adopted 标记）；采纳的表若正在分级 tab 打开则同步刷新。
        const gr = await authedFetch(`/api/governance/sensitive-scan?scanId=${encodeURIComponent(scanResult.summary.scanId)}`);
        if (gr) { const gd = await gr.json(); if (gd?.success) setScanResult(gd.data); }
      } else message.error(d?.error?.message || t("采纳失败"));
    } finally { if (seq === seqRefs.adopt.current) setScanAdopting(false); }
  };
  const confBandTag = (f: any) => f.band === "high"
    ? <Tag color="green">{t("高")} {Math.round((f.confidence || 0) * 100)}%</Tag>
    : <Tag color="orange">{t("中")} {Math.round((f.confidence || 0) * 100)}%</Tag>;

  const updateColField = (name: string, field: string, value: any) => {
    setClassCols((prev) => prev.map((c) => (c.name === name ? { ...c, [field]: value } : c)));
  };

  // Apply a column's classification (admin): PUT when a level is set, DELETE when cleared.
  const applyColClassification = async (col: any) => {
    if (!classFqn) return;
    if (!col.level) {
      const res = await fetch(`/api/governance/classification?fqn=${encodeURIComponent(classFqn)}&column=${encodeURIComponent(col.name)}${scopeQs}`, { method: "DELETE" });
      const d = await res.json();
      if (d?.success) message.success(t("已清除 {name} 的分级", { name: col.name }));
      else message.error(d?.error?.message || t("操作失败（需平台管理员）"));
      return;
    }
    const res = await fetch(`/api/governance/classification`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fqn: classFqn, column: col.name, level: col.level, maskStrategy: col.maskStrategy, category: col.category, targetId: govTargetId }),
    });
    const d = await res.json();
    if (d?.success) message.success(t("已保存 {name}：{level} / {mask}", { name: col.name, level: col.level, mask: col.maskStrategy }));
    else message.error(d?.error?.message || t("保存失败（需平台管理员）"));
  };

  const requestAccess = async (fqn: string) => {
    const projectId = (typeof window !== "undefined" && window.localStorage.getItem("bgp-active-project")) || "proj-default";
    const res = await fetch("/api/approvals", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "data-access", projectId, fqn, note: "申请访问敏感数据" }),
    });
    const d = await res.json();
    if (d?.success) message.success(t("访问申请已提交，等待审批"));
    else message.error(d?.error?.message || t("申请失败"));
  };

  // Wait for auth to resolve, then load catalog once authenticated.
  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    // (第二刀)—— 🔴 **只取一次数,分别写两份 state**。
    //   上一版在这里各调一次(`searchCatalog("")` + `loadAllAssets()`),实测两个**参数逐字节相同**
    //   的请求互相拖慢 4.2s、候选清单就绪从 +6.2s 推到 +11.1s。见 `bootstrapCatalog` 的文件头。
    bootstrapCatalog();
    // 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重查(护栏 4)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user, scopeQs]);

  const loadQuality = async () => {
    setQualityLoading(true);
    const seq = ++seqRefs.quality.current;
    try {
      const res = await authedFetch(`/api/governance/quality`);
      if (!res) return;
      const d = await res.json();
      if (seq !== seqRefs.quality.current) return; // 陈旧响应:丢掉
      setQualityData(d.success ? d.data : { testCases: [], profiles: [] });
    } finally { if (seq === seqRefs.quality.current) setQualityLoading(false); }
  };

  // 深链:治理工作台待办跳转带 ?tab=sensitive|quality|classification,进页切到对应 Tab。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const wanted = new URLSearchParams(window.location.search).get("tab");
    if (wanted && ["catalog", "lineage", "impact", "classification", "sensitive", "quality"].includes(wanted)) {
      setActiveTab(wanted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-load data-quality / profiler results when the tab is opened.
  useEffect(() => {
    if (activeTab === "quality" && user && !qualityData && !qualityLoading) loadQuality();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user]);

  useEffect(() => {
    if (activeTab === "classification" && user) loadMyGrants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user]);

  // Convert lineage data to ReactFlow nodes/edges with layered layout (shared helper).
  const { rfNodes, rfEdges } = buildFlowGraph(lineageData);
  const impactFlow = buildFlowGraph(impactData);

  const catalogColumns = [
    { title: t("数据资产"), key: "name", render: (_: any, r: any) => (
      <Space>
        <span>{typeIcon[r.type] || typeIcon[r.fqn?.split(".")[0]] || "📋"}</span>
        <div>
          <div style={{ fontWeight: 500 }}>{r.name}</div>
          <div style={{ fontSize: 11, color: "#888" }}>{r.fqn}</div>
        </div>
      </Space>
    )},
    { title: t("来源"), dataIndex: "source", render: (v: string) => <Tag color={v === "Redshift" ? "purple" : "blue"}>{v}</Tag> },
    // 原来「数据库」一列是 `<db>.<schema>` 一个串;拆成两列 —— Redshift = 库 / schema,S3 Tables = 表桶 / 命名空间(FQN 约定 bgp-s3tables.<bucket>.<namespace>.<table>)。
    { title: t("库 / 表桶"), key: "db", render: (_: any, r: any) => { const { db } = splitDatabase(r); return db ? <span data-testid="catalog-cell-db">{db}</span> : "-"; } },
    { title: t("Schema / 命名空间"), key: "schema", render: (_: any, r: any) => { const { schema } = splitDatabase(r); return schema ? <span data-testid="catalog-cell-schema">{schema}</span> : "-"; } },
    { title: t("格式"), dataIndex: "format", render: (v: string) => v ? <Tag>{v}</Tag> : "-" },
    { title: t("字段数"), dataIndex: "columns", render: (v: number) => v || "-" },
    { title: t("敏感级别"), dataIndex: "sensitivity", width: 120, render: (v: string) => v && LEVEL_META[v] ? <Tag color={LEVEL_META[v].color}>{t(LEVEL_META[v].label)}</Tag> : <span style={{ color: "#bbb" }}>{t("未分级")}</span> },
    { title: t("操作"), key: "action", render: (_: any, r: any) => (
      <Space>
        <Button size="small" icon={<ApartmentOutlined />} onClick={() => { loadLineage(r.fqn); setActiveTab("lineage"); }}>{t("血缘")}</Button>
        <Button size="small" icon={<ThunderboltOutlined />} onClick={() => { loadImpact(r.fqn); setActiveTab("impact"); }}>{t("影响分析")}</Button>
        <Button size="small" icon={<SafetyCertificateOutlined />} onClick={() => { loadClassification(r.fqn); setActiveTab("classification"); }}>{t("分级")}</Button>
        {/* 图形化改表 —— 只有 Redshift 表有载体(ALTER / COMMENT);S3 Tables 的 Iceberg 模式演进要 Spark 引擎、Athena 对 s3tablescatalog 不支持 DDL ⇒ 不给假入口,按钮置灰并说明 */}
        {isAdmin && (r.type === "redshift"
          ? <Button size="small" data-testid="catalog-alter-btn" onClick={() => { const { schema } = splitDatabase(r); setAlterTarget({ targetId: r.targetId || govTargetId, schema: schema || "public", table: r.name, fqn: r.fqn }); }}>{t("修改表结构")}</Button>
          : <Button size="small" data-testid="catalog-alter-btn" disabled title={t("S3 Tables 表的结构变更需经 Spark 作业做 Iceberg 模式演进,本版不提供图形化;可用离线作业跑 ALTER TABLE … ADD COLUMNS")}>{t("修改表结构")}</Button>)}
      </Space>
    )},
  ];

  return (
    <div>
      {/* 50 INTERACTION §4quater:数据地图/血缘/资产盘点顶部加「全部 target」视图。
          🔴 两个视图**互斥**(不是并排):当前 target 视图下面那些 tab 全是**单地域**的读写面
          (点表看数据、跑质量检查、改分级),把它们和跨地域只读全景摆一起会让人以为
          "在全部 target 视图里也能点进去改分级" —— 而那要等治理页按 target 化(后续刀)。 */}
      <Space align="center" wrap style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}><DatabaseOutlined /> {t("数据治理")}</h2>
        <Select
          size="small"
          style={{ width: 210 }}
          value={scopeView}
          onChange={(v) => setScopeView(v)}
          options={[
            { value: "current", label: t("视图:当前 target") },
            { value: "all", label: t("视图:全部 target(只读元数据)") },
          ]}
        />
      </Space>
      {/* 该区未部署数据仓库 ⇒ 整块说清(目录/质量/敏感三件都靠它取数)。
          🔴 不能只是"目录空着":空目录在界面上等于「这个区没有表」,而真相是「这个区没有数仓」。 */}
      {noWarehouse && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="governance-no-warehouse" message={noWarehouse} />
      )}
      {/* target 视角:把三件事一次说清(别让人靠猜)
          ① 目录来自**同一个 OpenMetadata**(按执行环境分 service),内容是**元数据同步时刻**的样子;
          ② 同步时间与状态(W3-e 的五态),以及去哪儿手动刷;
          ③ 质量检查 / 敏感扫描是**实时**在该区数仓上执行的(与目录不同)—— 两者混为一谈会让人
             以为「目录里没有的表就扫不到」。 */}
      {runTargetId && !noWarehouse && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} data-testid="governance-scope-note"
          message={
            <Space direction="vertical" size={2}>
              <span>
                {t("当前只看 {region}:数据目录来自同一个 OpenMetadata(按执行环境分服务),内容是**元数据同步**时刻的样子;质量检查与敏感扫描则是实时在该区域数据仓库上执行。", { region: runRegion })}
              </span>
              <span style={{ color: "#90a4c0", fontSize: 12 }} data-testid="governance-catalog-freshness">
                {/* 🔴 **不显示 facet 的 tables**:那个数只统计定时来源(Glue),数仓目录另有自己的时间戳与态
                    ⇒ 真环境实测它是 0,而上面目录里明明列了 21 张 —— 「0 张表」在界面上等于「这个区没东西」。
                    表数由目录页签自己的 (N) 显示(它就是这次真列出来的行数)。 */}
                {catalogFresh
                  ? t("该区目录同步状态 {state}{at};数仓目录 {wh} —— 需手动同步,去「数据治理中心 · 跨地域总览」刷新。", {
                      state: String(catalogFresh.state || "未知"),
                      at: catalogFresh.mirroredAt ? t(",最近同步 {at}", { at: new Date(catalogFresh.mirroredAt).toLocaleString() }) : t("(定时来源从未同步)"),
                      wh: catalogFresh.warehouse
                        ? `${String(catalogFresh.warehouse.state)}${catalogFresh.warehouse.at ? ` @ ${new Date(catalogFresh.warehouse.at).toLocaleString()}` : ""}`
                        : t("从未同步"),
                    })
                  : t("该区目录的同步状态读不到 —— 请到「数据治理中心 · 跨地域总览」查看/刷新(此处不猜)。")}
              </span>
            </Space>
          } />
      )}
      {scopeView === "all" ? (
        <CrossTargetMirrorOverview />
      ) : (
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "catalog", label: catalogFiltered
            ? t("数据目录 ({n} / {total})", { n: filteredCatalog.length, total: catalogData.length })
            : t("数据目录 ({n})", { n: catalogData.length }), children: (
          <div>
            {/* 筛选栏:候选来自当前目录数据本身;每个维度多选 / 单选,维度间取交集;「重置」清空并回到全量 */}
            <div data-testid="catalog-filters" style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
              <Select data-testid="catalog-filter-source" mode="multiple" allowClear placeholder={t("来源")} style={{ minWidth: 180 }}
                value={catalogFilter.sources} onChange={(v: string[]) => updateCatalogFilter({ sources: v })}
                options={catalogOptions.sources.map((s) => ({ value: s, label: s }))} maxTagCount="responsive" />
              <Select data-testid="catalog-filter-db" allowClear showSearch placeholder={t("库 / 表桶")} style={{ minWidth: 200 }}
                value={catalogFilter.db || undefined} onChange={(v: string | undefined) => updateCatalogFilter({ db: v || "" })}
                options={catalogOptions.dbs.map((s) => ({ value: s, label: s }))} />
              <Select data-testid="catalog-filter-schema" allowClear showSearch placeholder={t("Schema / 命名空间")} style={{ minWidth: 200 }}
                value={catalogFilter.schema || undefined} onChange={(v: string | undefined) => updateCatalogFilter({ schema: v || "" })}
                options={catalogOptions.schemas.map((s) => ({ value: s, label: s }))} />
              <Select data-testid="catalog-filter-format" mode="multiple" allowClear placeholder={t("格式")} style={{ minWidth: 160 }}
                value={catalogFilter.formats} onChange={(v: string[]) => updateCatalogFilter({ formats: v })}
                options={catalogOptions.formats.map((s) => ({ value: s, label: s }))} maxTagCount="responsive" />
              <Select data-testid="catalog-filter-sens" mode="multiple" allowClear placeholder={t("敏感级别")} style={{ minWidth: 170 }}
                value={catalogFilter.sensitivities} onChange={(v: string[]) => updateCatalogFilter({ sensitivities: v })}
                options={catalogOptions.sensitivities.map((s) => ({ value: s, label: s === SENSITIVITY_NONE ? t("未分级") : (LEVEL_META[s] ? t(LEVEL_META[s].label) : s) }))}
                maxTagCount="responsive" />
              <Button data-testid="catalog-filter-reset" disabled={!catalogFiltered} onClick={() => updateCatalogFilter(EMPTY_CATALOG_FILTER)}>{t("重置")}</Button>
              {catalogFiltered && (
                <span data-testid="catalog-filter-count" style={{ color: "#5a6b7b", fontSize: 12 }}>
                  {t("筛出 {n} / {total}", { n: filteredCatalog.length, total: catalogData.length })}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {/* 🔴 **刻意不给 `loading={catalogLoading}`**:antd 的 Input.Search 在 loading 态会把按钮换成
                  转圈并**吞掉搜索触发** ⇒ 一旦 loading 因为任何原因卡住(实测:取 token 的 promise 不 settle),
                  搜索就**彻底不可用且不报错**。加载中的反馈放在下面的 Table 上就够了;搜索必须始终可点。 */}
              <Input.Search placeholder={t("搜索数据资产（表名/库名）...")} value={keyword} onChange={(e) => setKeyword(e.target.value)}
                onSearch={searchCatalog} enterButton={<><SearchOutlined /> {t("搜索")}</>} size="large" style={{ flex: 1 }} />
              {isAdmin && (
                <Button size="large" icon={<ApartmentOutlined />} loading={syncingSchema} onClick={syncRedshiftSchema}
                  title={t("将 Redshift 真实列信息回填到数据目录（修正字段数）")}>{t("同步 Redshift 列")}</Button>
              )}
              {/* 图形化建表(Redshift 走建模落地通道;S3 Tables 走 s3tables CreateTable;prod 环境转审批) */}
              {isAdmin && (
                <Button size="large" type="primary" icon={<PlusOutlined />} data-testid="catalog-new-table-btn" onClick={() => setCreateOpen(true)}>{t("新建表")}</Button>
              )}
            </div>
            <Table columns={catalogColumns} dataSource={filteredCatalog} rowKey="fqn" loading={catalogLoading} pagination={{ pageSize: 20 }} />
            <CreateTableWizard open={createOpen} onClose={() => setCreateOpen(false)} defaultTargetId={govTargetId}
              onDone={(info) => { if (info.created) { setKeyword(info.table); searchCatalog(info.table); loadAllAssets(); } }} />
            <AlterTableDrawer open={!!alterTarget} target={alterTarget} onClose={() => setAlterTarget(null)}
              onChanged={() => { searchCatalog(); loadAllAssets(); }} />
          </div>
        )},
        { key: "lineage", label: t("数据血缘"), children: (
          <div>
            <Space style={{ marginBottom: 16 }}>
              <Select showSearch style={{ width: 400 }} placeholder={t("输入或选择数据资产 FQN")} value={lineageFqn || undefined}
                onChange={loadLineage} options={assetOptions} />
              <Button onClick={() => lineageFqn && loadLineage(lineageFqn)} loading={lineageLoading}>{t("查询血缘")}</Button>
            </Space>

            {lineageLoading ? <Spin size="large" style={{ display: "block", margin: "60px auto" }} /> :
              lineageData && rfNodes.length > 0 ? (
                <div style={{ height: "60vh", border: "1px solid #1d4254", borderRadius: 8 }}>
                  <ReactFlow nodes={rfNodes} edges={rfEdges} fitView>
                  </ReactFlow>
                </div>
              ) : lineageFqn ? (
                <Card><Empty description={t("未找到血缘关系。创建同步任务后将自动生成血缘。")} /></Card>
              ) : (
                <Card><Empty description={t("选择数据资产查看血缘关系")} /></Card>
              )
            }

            {lineageData?.edges?.some((e: any) => e.columnMappings?.length) && (() => {
              const colRows = lineageData.edges.flatMap((e: any) => (e.columnMappings || []).map((c: any, i: number) => ({
                key: `${e.source}-${i}`, sourceTable: e.source.split(".").pop(), targetTable: e.target.split(".").pop(), ...c,
              })));
              // Build column-level ReactFlow graph
              const colGroups: Record<string, { table: string; side: "source" | "target"; cols: string[] }> = {};
              for (const r of colRows) {
                const sk = `src:${r.sourceTable}`;
                const tk = `tgt:${r.targetTable}`;
                if (!colGroups[sk]) colGroups[sk] = { table: r.sourceTable, side: "source", cols: [] };
                if (!colGroups[tk]) colGroups[tk] = { table: r.targetTable, side: "target", cols: [] };
                if (!colGroups[sk].cols.includes(r.source)) colGroups[sk].cols.push(r.source);
                if (!colGroups[tk].cols.includes(r.target)) colGroups[tk].cols.push(r.target);
              }
              const colNodes: any[] = [];
              const colEdges: any[] = [];
              const groups = Object.values(colGroups);
              const srcGroups = groups.filter((g) => g.side === "source");
              const tgtGroups = groups.filter((g) => g.side === "target");
              let yOff = 0;
              for (const g of srcGroups) {
                colNodes.push({
                  id: `src:${g.table}`, position: { x: 0, y: yOff }, type: "default",
                  data: { label: (<div style={{ textAlign: "left", minWidth: 160 }}><div style={{ fontWeight: 700, borderBottom: "1px solid #1d4254", paddingBottom: 4, marginBottom: 4 }}>🐬 {g.table}</div>{g.cols.map((c) => <div key={c} style={{ fontSize: 11, padding: "1px 0" }}>{c}</div>)}</div>) },
                  style: { border: "2px solid #1677ff", borderRadius: 8, padding: 8, background: "rgba(22, 119, 255, 0.14)", color: "#cfe6f0" },
                });
                yOff += 60 + g.cols.length * 20;
              }
              yOff = 0;
              for (const g of tgtGroups) {
                colNodes.push({
                  id: `tgt:${g.table}`, position: { x: 450, y: yOff }, type: "default",
                  data: { label: (<div style={{ textAlign: "left", minWidth: 160 }}><div style={{ fontWeight: 700, borderBottom: "1px solid #1d4254", paddingBottom: 4, marginBottom: 4 }}>🏢 {g.table}</div>{g.cols.map((c) => <div key={c} style={{ fontSize: 11, padding: "1px 0" }}>{c}</div>)}</div>) },
                  style: { border: "2px solid #8c4fff", borderRadius: 8, padding: 8, background: "rgba(140, 79, 255, 0.16)", color: "#cfe6f0" },
                });
                yOff += 60 + g.cols.length * 20;
              }
              for (const r of colRows) {
                colEdges.push({
                  id: `col-${r.key}`, source: `src:${r.sourceTable}`, target: `tgt:${r.targetTable}`,
                  animated: true, label: `${r.source} → ${r.target}`, labelStyle: { fontSize: 9, fill: "#888" },
                  style: { stroke: "#1677ff" },
                });
              }
              return (
                <Card title={t("列级血缘")} size="small" style={{ marginTop: 16 }}>
                  <Tabs size="small" items={[
                    { key: "graph", label: t("图形视图"), children: (
                      <div style={{ height: Math.max(300, yOff + 60), border: "1px solid #1d4254", borderRadius: 8 }}>
                        <ReactFlow nodes={colNodes} edges={colEdges} fitView />
                      </div>
                    )},
                    { key: "table", label: t("表格视图"), children: (
                      <Table size="small" pagination={false} dataSource={colRows}
                        columns={[
                          { title: t("源表"), dataIndex: "sourceTable" },
                          { title: t("源字段"), dataIndex: "source", render: (v: string) => <code>{v}</code> },
                          { title: "→", width: 30, render: () => "→" },
                          { title: t("目标表"), dataIndex: "targetTable" },
                          { title: t("目标字段"), dataIndex: "target", render: (v: string) => <code>{v}</code> },
                        ]}
                      />
                    )},
                  ]} />
                </Card>
              );
            })()}
          </div>
        )},
        { key: "impact", label: t("影响分析"), children: (
          <div>
            <Space style={{ marginBottom: 16 }}>
              <Select showSearch style={{ width: 400 }} placeholder={t("选择要分析影响的数据资产 FQN")} value={impactFqn || undefined}
                onChange={loadImpact} options={assetOptions} />
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => impactFqn && loadImpact(impactFqn)} loading={impactLoading}>{t("分析下游影响")}</Button>
            </Space>
            {impactLoading ? <Spin size="large" style={{ display: "block", margin: "60px auto" }} /> :
              impactData ? (
                <>
                  {!impactData.omAvailable && (
                    <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                      message={t("OpenMetadata 暂不可达：下游血缘图为空，仅按作业 SQL 解析显示直接消费者。")} />
                  )}
                  <Space size="large" style={{ marginBottom: 12 }}>
                    <span>{t("受影响数据资产：")}<b>{impactData.impacted?.length || 0}</b></span>
                    <span>{t("受影响作业 / 任务：")}<b>{impactData.jobs?.length || 0}</b></span>
                  </Space>
                  {impactFlow.rfNodes.length > 1 ? (
                    <div style={{ height: "50vh", border: "1px solid #1d4254", borderRadius: 8, marginBottom: 16 }}>
                      <ReactFlow nodes={impactFlow.rfNodes} edges={impactFlow.rfEdges} fitView />
                    </div>
                  ) : <Card style={{ marginBottom: 16 }}><Empty description={t("该资产暂无下游血缘（无下游表依赖）")} /></Card>}
                  <Card title={t("受影响的数据资产 ({n})", { n: impactData.impacted?.length || 0 })} size="small" style={{ marginBottom: 16 }}>
                    <Table size="small" rowKey="fqn" pagination={false} dataSource={impactData.impacted || []}
                      locale={{ emptyText: t("无下游受影响资产") }}
                      columns={[
                        { title: t("数据资产"), dataIndex: "fqn", render: (v: string, r: any) => (
                          <Space><span>{typeIcon[r.type] || "📋"}</span>
                            <div><div style={{ fontWeight: 500 }}>{v.split(".").pop()}</div>
                              <div style={{ fontSize: 11, color: "#888" }}>{v}</div></div></Space>
                        ) },
                        { title: t("下游层级"), dataIndex: "depth", width: 110, render: (v: number) => <Tag color="orange">{t("第 {n} 层", { n: v })}</Tag> },
                      ]} />
                  </Card>
                  <Card title={t("受影响的作业 / 任务 ({n})", { n: impactData.jobs?.length || 0 })} size="small">
                    <Table size="small" rowKey="id" pagination={false} dataSource={impactData.jobs || []}
                      locale={{ emptyText: t("无受影响作业 / 任务") }}
                      columns={[
                        { title: t("名称"), dataIndex: "name" },
                        { title: t("类型"), dataIndex: "resourceType", width: 140, render: (v: string) => <Tag color={v === "etl-job" ? "geekblue" : "purple"}>{v === "etl-job" ? t("ETL 作业") : t("Redshift 任务")}</Tag> },
                        { title: t("影响方式"), dataIndex: "role", width: 150, render: (v: string) => <Tag color={v.includes("reads") ? "red" : "gold"}>{v === "reads" ? t("读取被改表") : v === "writes" ? t("产出下游表") : t("读取+产出")}</Tag> },
                      ]} />
                  </Card>
                </>
              ) : impactFqn ? (
                <Card><Empty description={t("未获取到影响分析结果")} /></Card>
              ) : (
                <Card><Empty description={t("选择数据资产，分析「改 / 删它会影响哪些下游资产与作业」")} /></Card>
              )
            }
          </div>
        )},
        { key: "classification", label: t("数据分级"), children: (
          <div>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={isAdmin
                ? t("平台管理员：设置表/字段的敏感级别与脱敏策略；脱敏在查询结果中对非授权用户生效（仅脱敏返回值，不改动库内数据）。")
                : t("查看数据分级；对敏感表可「申请访问」，审批通过后查询不再脱敏。设置分级需平台管理员。")} />
            <Space style={{ marginBottom: 12 }} wrap>
              <Select showSearch style={{ width: 420 }} placeholder={t("选择数据表设置 / 查看分级")} value={classFqn || undefined}
                onChange={loadClassification}
                options={assetOptions} />
              {classFqn && <Button icon={<SafetyCertificateOutlined />} onClick={() => requestAccess(classFqn)}>{t("申请访问该表")}</Button>}
            </Space>
            {classFqn && isAdmin && (
              <Space style={{ marginBottom: 12 }} wrap>
                <Input placeholder={t("手动输入字段名（OM 未收录该列时使用）")} value={newCol} onChange={(e) => setNewCol(e.target.value)} onPressEnter={addManualColumn} style={{ width: 320 }} />
                <Button onClick={addManualColumn}>{t("添加字段到列表")}</Button>
                <span style={{ color: "#888", fontSize: 12 }}>{t("添加后在下表为它设级别 / 脱敏策略并「应用」")}</span>
              </Space>
            )}
            {classLoading ? <Spin style={{ display: "block", margin: "40px auto" }} /> : classFqn ? (
              <Table size="small" rowKey="name" dataSource={classCols} pagination={false}
                locale={{ emptyText: t("该表无字段信息（OM 未收录列）") }}
                columns={[
                  { title: t("字段"), dataIndex: "name", render: (v: string, r: any) => (
                    <div><div style={{ fontWeight: 500 }}>{v}</div><div style={{ fontSize: 11, color: "#888" }}>{r.dataType}</div></div>
                  ) },
                  { title: t("敏感级别"), dataIndex: "level", width: 160, render: (v: string, r: any) => isAdmin ? (
                    <Select size="small" style={{ width: 140 }} value={v || ""} onChange={(val) => updateColField(r.name, "level", val)}
                      options={[{ value: "", label: t("未分级") }, ...LEVELS.map((l) => ({ value: l, label: t(LEVEL_META[l].label) }))]} />
                  ) : (v && LEVEL_META[v] ? <Tag color={LEVEL_META[v].color}>{t(LEVEL_META[v].label)}</Tag> : <Tag>{t("未分级")}</Tag>) },
                  { title: t("脱敏策略"), dataIndex: "maskStrategy", width: 200, render: (v: string, r: any) => isAdmin ? (
                    <Select size="small" style={{ width: 180 }} value={v || "none"} onChange={(val) => updateColField(r.name, "maskStrategy", val)} options={MASK_OPTS.map((o) => ({ value: o.value, label: t(o.label) }))} />
                  ) : <Tag>{t(MASK_OPTS.find((o) => o.value === (v || "none"))?.label || "")}</Tag> },
                  { title: t("分类标签"), dataIndex: "category", width: 160, render: (v: string, r: any) => isAdmin ? (
                    <Input size="small" value={v} placeholder={t("PII / 财务…")} onChange={(e) => updateColField(r.name, "category", e.target.value)} />
                  ) : (v || "-") },
                  ...(isAdmin ? [{ title: t("操作"), width: 80, render: (_: any, r: any) => <Button size="small" type="link" onClick={() => applyColClassification(r)}>{t("应用")}</Button> }] : []),
                ]} />
            ) : <Card><Empty description={t("选择一张表查看 / 设置字段分级与脱敏")} /></Card>}
            <Card title={t("我的数据访问授权 ({n})", { n: myGrants.length })} size="small" style={{ marginTop: 16 }}>
              <Table size="small" rowKey="fqn" pagination={false} dataSource={myGrants}
                locale={{ emptyText: t("暂无授权（对敏感表「申请访问」并经审批后在此显示）") }}
                columns={[
                  { title: t("已授权数据表"), dataIndex: "fqn" },
                  { title: t("授权人"), dataIndex: "grantedBy", render: (v: string) => v || "-" },
                  { title: t("授权时间"), dataIndex: "grantedAt", render: (v: string) => v ? new Date(v).toLocaleString() : "-" },
                ]} />
            </Card>
          </div>
        )},
        { key: "sensitive", label: t("敏感扫描"), children: (
          <div>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={isAdmin
                ? t("平台管理员：自动扫描数据表列，识别可能的敏感字段（邮箱/信用卡/电话/凭证等，检测器全球通用+可插拔）。扫描只读且抽样值不落库；识别结果为「建议」，勾选后「采纳」才写入数据分级。")
                : t("敏感数据自动识别扫描需平台管理员运行。识别结果为建议，采纳后写入数据分级。")} />
            <Space style={{ marginBottom: 12 }} wrap>
              <Input addonBefore={t("数据库")} style={{ width: 220 }} value={scanDb} onChange={(e) => setScanDb(e.target.value)} placeholder="dev" />
              <Input addonBefore={t("Schema（可选）")} style={{ width: 260 }} value={scanSchema} onChange={(e) => setScanSchema(e.target.value)} placeholder={t("留空扫全部")} />
              <Button type="primary" icon={<ThunderboltOutlined />} loading={scanLoading} disabled={!isAdmin} onClick={runSensitiveScan}>{t("开始扫描")}</Button>
              {scanResult?.findings?.length > 0 && isAdmin && (
                <Button icon={<SafetyCertificateOutlined />} loading={scanAdopting} disabled={scanSelected.length === 0} onClick={adoptSensitive}>
                  {t("采纳所选 ({n}) 写入分级", { n: scanSelected.length })}
                </Button>
              )}
            </Space>

            {scanLoading ? <Spin style={{ display: "block", margin: "40px auto" }} tip={t("扫描中：拉取列元数据 → 抽样 → 识别…")} /> : scanResult?.summary ? (
              <>
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Space size="large" wrap>
                    <Statistic title={t("扫描表数")} value={scanResult.summary.tablesScanned} />
                    <Statistic title={t("扫描字段数")} value={scanResult.summary.columnsScanned} />
                    <Statistic title={t("高置信建议")} value={scanResult.summary.findingsHigh} valueStyle={{ color: "#52c41a" }} />
                    <Statistic title={t("中置信建议")} value={scanResult.summary.findingsMed} valueStyle={{ color: "#faad14" }} />
                    {scanResult.summary.tablesErrored > 0 && <Statistic title={t("跳过/失败表")} value={scanResult.summary.tablesErrored} valueStyle={{ color: "#f5222d" }} />}
                  </Space>
                </Card>
                <Table size="small" rowKey={findingKey} dataSource={scanResult.findings || []} pagination={false}
                  locale={{ emptyText: t("未发现敏感字段建议") }}
                  rowSelection={isAdmin ? {
                    selectedRowKeys: scanSelected,
                    onChange: (keys) => setScanSelected(keys as string[]),
                    getCheckboxProps: (r: any) => ({ disabled: !!r.adopted }),
                  } : undefined}
                  columns={[
                    { title: t("数据表 / 字段"), key: "col", render: (_: any, r: any) => (
                      <div><div style={{ fontWeight: 500 }}>{r.column}</div><div style={{ fontSize: 11, color: "#888" }}>{r.fqn}</div></div>
                    ) },
                    { title: t("识别类型"), key: "detector", render: (_: any, r: any) => (
                      <Space size={4}><Tag color="purple">{t(r.detectorLabel)}</Tag>{r.detectorRegion && r.detectorRegion !== "global" && <Tag>{r.detectorRegion}</Tag>}</Space>
                    ) },
                    { title: t("置信度"), key: "conf", width: 120, render: (_: any, r: any) => (
                      <div>{confBandTag(r)}<div style={{ fontSize: 11, color: "#888" }}>{r.evidence?.nameMatched ? t("列名命中") : ""}{r.hitRate != null ? t(" 值{p}%", { p: Math.round(r.hitRate * 100) }) : ""}</div></div>
                    ) },
                    { title: t("当前分级"), key: "cur", width: 110, render: (_: any, r: any) => r.alreadyClassified
                      ? <Tag color={LEVEL_META[r.currentLevel]?.color}>{r.currentLevel}</Tag>
                      : <Tag>{t("未分级")}</Tag> },
                    { title: t("建议级别"), key: "sl", width: 150, render: (_: any, r: any) => isAdmin ? (
                      <Select size="small" style={{ width: 130 }} value={scanOverrides[findingKey(r)]?.level || r.suggestedLevel}
                        onChange={(v) => setScanOverrides((p) => ({ ...p, [findingKey(r)]: { ...p[findingKey(r)], level: v } }))}
                        options={LEVELS.map((l) => ({ value: l, label: t(LEVEL_META[l].label) }))} />
                    ) : <Tag color={LEVEL_META[r.suggestedLevel]?.color}>{t(LEVEL_META[r.suggestedLevel]?.label || r.suggestedLevel)}</Tag> },
                    { title: t("建议脱敏"), key: "sm", width: 190, render: (_: any, r: any) => isAdmin ? (
                      <Select size="small" style={{ width: 170 }} value={scanOverrides[findingKey(r)]?.maskStrategy || r.suggestedMask}
                        onChange={(v) => setScanOverrides((p) => ({ ...p, [findingKey(r)]: { ...p[findingKey(r)], maskStrategy: v } }))}
                        options={MASK_OPTS.map((o) => ({ value: o.value, label: t(o.label) }))} />
                    ) : <Tag>{t(MASK_OPTS.find((o) => o.value === r.suggestedMask)?.label || r.suggestedMask)}</Tag> },
                    { title: t("状态"), key: "adopted", width: 90, render: (_: any, r: any) => r.adopted ? <Tag color="green">{t("已采纳")}</Tag> : <Tag>{t("待采纳")}</Tag> },
                  ]} />
              </>
            ) : <Card><Empty description={t("点「开始扫描」自动识别敏感字段并给出分级建议")} /></Card>}
          </div>
        )},
        { key: "quality", label: t("数据质量"), children: (
          <div>
            <Space style={{ marginBottom: 12 }} wrap>
              <Select showSearch style={{ width: 420 }} placeholder={t("选择数据表（质量规则 / 评分 / SLA）")} value={qFqn || undefined}
                onChange={selectQualityTable}
                options={assetOptions} />
              <Button type="primary" icon={<PlayCircleOutlined />} disabled={!qFqn} loading={qRunning} onClick={runQuality}>{t("运行检查")}</Button>
              {qFqn && isAdmin && <Button icon={<PlusOutlined />} onClick={() => setAddRuleOpen(true)}>{t("添加规则")}</Button>}
            </Space>

            {qFqn ? (
              <>
                {qResults?.summary ? (
                  <Card size="small" style={{ marginBottom: 12 }}>
                    <Space size="large" wrap>
                      <Statistic title={t("质量评分")} value={qResults.summary.score ?? "—"} suffix="/ 100" valueStyle={{ color: scoreColor(qResults.summary.score) }} />
                      {Object.entries(qResults.summary.dimensions || {}).map(([d, s]: any) => (
                        <Statistic key={d} title={t(DIMENSION_LABELS[d as keyof typeof DIMENSION_LABELS] || d)} value={s} suffix="%" />
                      ))}
                      <div><div style={{ color: "#888", fontSize: 12 }}>SLA</div>{qResults.summary.slaBreached ? <Tag color="red">{t("违约")}</Tag> : <Tag color="green">{t("达标")}</Tag>}</div>
                      <div><div style={{ color: "#888", fontSize: 12 }}>{t("通过/失败/错误")}</div><span>{qResults.summary.passed} / {qResults.summary.failed} / {qResults.summary.errors}</span></div>
                      <div><div style={{ color: "#888", fontSize: 12 }}>{t("上次运行")}</div><span>{qResults.summary.ts ? new Date(qResults.summary.ts).toLocaleString() : "—"}</span></div>
                    </Space>
                    {qResults.trend?.length > 1 && <div style={{ marginTop: 8, color: "#888", fontSize: 12 }}>{t("历史评分：")}{qResults.trend.map((pt: any) => pt.score ?? "—").join(" → ")}</div>}
                  </Card>
                ) : <Alert style={{ marginBottom: 12 }} type="info" showIcon message={t("尚未运行质量检查。配置规则后点「运行检查」。")} />}

                <Card size="small" title={t("质量规则 ({n})", { n: qRules.length })}>
                  <Table size="small" rowKey="ruleId" pagination={false} dataSource={qRules} loading={qLoading}
                    locale={{ emptyText: isAdmin ? t("暂无规则，点「添加规则」") : t("暂无规则") }}
                    columns={[
                      { title: t("维度"), dataIndex: "type", width: 80, render: (tp: string) => <Tag>{t(DIMENSION_LABELS[qMetaOf(tp)?.dimension as keyof typeof DIMENSION_LABELS] || "-")}</Tag> },
                      { title: t("规则"), dataIndex: "type", render: (tp: string, r: any) => (<div><div>{qMetaOf(tp)?.label || tp}</div>{r.column && <div style={{ fontSize: 11, color: "#888" }}>{t("字段 {col}", { col: r.column })}</div>}</div>) },
                      { title: t("参数"), dataIndex: "params", render: (p: any) => <span style={{ fontSize: 12 }}>{qParamSummary(p)}</span> },
                      { title: t("严重度"), dataIndex: "severity", width: 80, render: (v: string) => <Tag color={v === "error" ? "red" : "gold"}>{v}</Tag> },
                      { title: t("最近结果"), key: "res", render: (_: any, r: any) => { const res = qResultFor(r.ruleId); if (!res) return <Tag>{t("未运行")}</Tag>; const c = res.status === "passed" ? "green" : res.status === "error" ? "default" : "red"; return <Space size={4}><Tag color={c}>{res.status}</Tag><span style={{ fontSize: 11, color: "#888" }}>{res.detail}</span></Space>; } },
                      ...(isAdmin ? [{ title: t("操作"), width: 70, render: (_: any, r: any) => <Popconfirm title={t("删除该规则？")} onConfirm={() => delRule(r.ruleId)}><a style={{ color: "red" }}>{t("删除")}</a></Popconfirm> }] : []),
                    ]} />
                </Card>
              </>
            ) : <Card><Empty description={t("选择一张表查看 / 配置数据质量规则、评分与 SLA")} /></Card>}

            <Card size="small" title={t("OpenMetadata Profiler / TestSuite（补充）")} style={{ marginTop: 16 }}
              extra={<Button size="small" onClick={loadQuality} loading={qualityLoading}>{t("刷新")}</Button>}>
              {qualityData && ((qualityData.testCases?.length || 0) > 0 || (qualityData.profiles?.length || 0) > 0) ? (
                <Table size="small" rowKey={(r: any) => `${r.table}.${r.column || ""}.${r.name}`} dataSource={qualityData.testCases || []} pagination={false}
                  locale={{ emptyText: t("暂无 OM 测试用例") }}
                  columns={[
                    { title: t("测试"), dataIndex: "name" },
                    { title: t("表"), dataIndex: "table", render: (v: string) => v ? v.split(".").pop() : "-" },
                    { title: t("字段"), dataIndex: "column", render: (v: string) => v || "-" },
                    { title: t("状态"), dataIndex: "status", render: (v: string) => <Tag color={v === "Success" ? "green" : v === "Failed" ? "red" : "default"}>{v}</Tag> },
                  ]} />
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("无 OM 质量数据（需部署摄取 / Profiler 栈）")} />}
            </Card>

            <Modal title={t("添加质量规则")} open={addRuleOpen} onOk={addRule} onCancel={() => setAddRuleOpen(false)} okText={t("保存")}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <div>{t("规则类型")}
                  <Select style={{ width: "100%" }} value={arType} onChange={(v) => { setArType(v); setArParams({}); }}
                    options={QUALITY_TEMPLATES_META.map((tpl) => ({ value: tpl.type, label: `${t(tpl.label)} · ${t(DIMENSION_LABELS[tpl.dimension])}` }))} />
                </div>
                <div style={{ color: "#888", fontSize: 12 }}>{t(qMetaOf(arType)?.description || "")}</div>
                {qMetaOf(arType)?.needsColumn && (
                  <Input addonBefore={t("字段名")} value={arColumn} onChange={(e) => setArColumn(e.target.value)} placeholder={t("如 customer_id")} />
                )}
                {(qMetaOf(arType)?.params || []).map((p) => (
                  <div key={p.key}>
                    {p.type === "number" ? (
                      <InputNumber style={{ width: "100%" }} addonBefore={t(p.label)} value={arParams[p.key]} placeholder={p.placeholder ? t(p.placeholder) : undefined}
                        onChange={(v) => setArParams((prev) => ({ ...prev, [p.key]: v }))} />
                    ) : (
                      <Input addonBefore={t(p.label)} value={arParams[p.key] || ""} placeholder={p.placeholder ? t(p.placeholder) : undefined}
                        onChange={(e) => setArParams((prev) => ({ ...prev, [p.key]: e.target.value }))} />
                    )}
                  </div>
                ))}
                <Space>
                  <span>{t("严重度")}</span>
                  <Select value={arSeverity} style={{ width: 120 }} onChange={(v) => setArSeverity(v)} options={[{ value: "error", label: "error" }, { value: "warn", label: "warn" }]} />
                  <span>{t("权重")}</span>
                  <InputNumber min={1} value={arWeight} onChange={(v) => setArWeight(v || 1)} />
                </Space>
              </Space>
            </Modal>
          </div>
        )},
        { key: "schedules", label: <span data-testid="gov-tab-schedules">{t("定时治理任务")}</span>, children: (
          <GovernanceSchedules isAdmin={isAdmin} />
        )},
      ]} />
      )}
    </div>
  );
}
