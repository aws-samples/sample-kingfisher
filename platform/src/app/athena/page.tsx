"use client";

import React, { useState, useRef, useEffect } from "react";
import { Button, Space, Table, Alert, Spin, message, Card, Tag, Tree, Tooltip } from "antd";
import { PlayCircleOutlined, ClearOutlined, CloudOutlined, ReloadOutlined, TableOutlined } from "@ant-design/icons";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-4):数据湖查询与表树都按区。
// 🔴 与 `/redshift` 同款:**执行目标默认跟随顶栏视角**(INTERACTION §9.4),一棵树只显示一个区。
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface S3TableInfo { namespace: string; name: string; qualifiedName: string; }
// 序 38 B-71:命名空间带「来自哪个表桶」(平台表桶 / 平台管理员登记的外部表桶)
interface S3NamespaceTree { namespace: string; tables: S3TableInfo[]; bucket?: string; catalog?: string; external?: boolean; }

function fmtBytes(n?: number): string {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function AthenaPage() {
  const t = useT();
  // @kf-batch 50-WP7-sync-pushdown —— 🔴 编辑器不再预填主控区表桶的示例 SQL(在别的区视角下,那条 SQL 指向的
  // 是**另一个区**的表桶,点执行就是跨区查询)。表树到达后取该区第一张表生成示例(见 fetchTables)。
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ columns: string[]; rows: (string | null)[][] } | null>(null);
  const [stats, setStats] = useState<{ dataScannedBytes?: number; executionTimeMs?: number } | null>(null);
  const [error, setError] = useState("");
  const [tree, setTree] = useState<S3NamespaceTree[]>([]);
  const [catalog, setCatalog] = useState("");
  const [loadingTables, setLoadingTables] = useState(false);
  const [currentId, setCurrentId] = useState("");
  // S0(50 SPEC §0/§3.7):启动接口下发的 queryHandle —— 取结果/取消都要带,服务端凭它判归属。
  const [currentHandleId, setCurrentHandleId] = useState("");
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // @kf-batch 50-WP4ter-coverage —— 当前视角 = 执行目标(单区视角锚定该区;「全部」= 主控区)
  const { scope, targets: scopeTargets } = useScope();
  const execTarget = scope.kind === "target" ? scope.targetId : undefined;
  const execRegion = execTarget ? scopeTargets?.find((x) => x.targetId === execTarget)?.region || execTarget : "";
  // @kf-batch 50-WP31-place-first-class —— 请求恒带落点(全部 / 对比 = 主控区,显式);execTarget 只管界面标签
  const tq = `targetId=${encodeURIComponent(landingOfScope(scope))}`;

  const fetchTables = async () => {
    setLoadingTables(true);
    try {
      const r = await fetch(`/api/athena/tables${tq ? `?${tq}` : ""}`);
      const d = await r.json();
      if (d.error) { message.error(t("加载表失败：{err}", { err: d.error })); return; }
      setTree(d.namespaces || []);
      setCatalog(d.catalog || "");
      // 示例 SQL 只在编辑器还是空的时候给,且取**当前执行目标**表树里的第一张表(不写死任何桶名)。
      const first = (d.namespaces || []).flatMap((ns: S3NamespaceTree) => ns.tables)[0];
      if (first?.qualifiedName) setSql((cur) => cur || `SELECT * FROM ${first.qualifiedName} LIMIT 100`);
    } catch (e: any) {
      message.error(e.message);
    } finally { setLoadingTables(false); }
  };

  // @kf-batch 50-WP4ter-coverage —— 切区不重载页面,重拉表树(护栏 4)
  useEffect(() => {
    fetchTables();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tq]);

  // 序 52 —— 数据源页「建外部表」成功后的「去数据湖直查」带 ?sql= 进来 ⇒ 预填编辑器(只在编辑器还空着时,与 fetchTables 给示例 SQL
  //   同一条「不盖用户已写内容」的规则);落点仍由 ?scope= 经顶栏视角决定,这里不碰。
  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get("sql");
    if (preset) setSql((cur) => cur || preset);
  }, []);

  const handleExecute = async () => {
    setRunning(true); setResult(null); setError(""); setStats(null);
    try {
      const res = await fetch("/api/athena/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // @kf-batch 50-WP4ter-coverage —— 执行落点走 body(不是 `?scope=`)
        body: JSON.stringify({ sql, targetId: landingOfScope(scope) }),
      });
      const data = await res.json();
      if (data.error || !data.queryExecutionId) { setError(data.error || t("启动查询失败")); setRunning(false); return; }
      const id = data.queryExecutionId;
      setCurrentId(id);
      // S0(50 SPEC §0/§3.7):启动接口同时下发 queryHandle;取结果必须带上,否则服务端 403
      // (原来只有 requireProject、不校验该 id 归属 = 跨项目越权)。
      const handleQs = data.handleId ? `?handleId=${encodeURIComponent(data.handleId)}${tq ? `&${tq}` : ""}` : tq ? `?${tq}` : "";
      setCurrentHandleId(data.handleId || "");

      const poll = async () => {
        // 🔴 状态必须打到发起它的那个区(QueryExecutionId 只在该 region 存在)
        const r = await fetch(`/api/athena/query/${id}${tq ? `?${tq}` : ""}`);
        const d = await r.json();
        if (d.state === "SUCCEEDED") {
          setStats({ dataScannedBytes: d.dataScannedBytes, executionTimeMs: d.executionTimeMs });
          const rr = await fetch(`/api/athena/query/${id}/results${handleQs}`);
          const rd = await rr.json();
          // 🔴 非 200(handle 校验失败 403/410)时响应体是 {success:false,error:{message}},
          // 与本页既有的 `rd.error` 是字符串的约定不同,须两种形态都认,否则错误无声吞掉。
          if (!rr.ok) setError(rd?.error?.message || rd?.error || t("查询失败"));
          else if (rd.error) setError(rd.error);
          else setResult({ columns: rd.columns || [], rows: rd.rows || [] });
          setRunning(false); setCurrentId(""); setCurrentHandleId("");
        } else if (d.state === "FAILED" || d.state === "CANCELLED") {
          setError(d.error || (d.state === "CANCELLED" ? t("查询已取消") : t("查询失败")));
          setRunning(false); setCurrentId(""); setCurrentHandleId("");
        } else {
          pollRef.current = setTimeout(poll, 1200);
        }
      };
      poll();
    } catch (e: any) { setError(e.message); setRunning(false); }
  };

  const handleCancel = async () => {
    if (!currentId) return;
    // S0:带上 handleId,服务端按句柄归属判是否允许停这条查询。
    const qs = currentHandleId ? `?handleId=${encodeURIComponent(currentHandleId)}${tq ? `&${tq}` : ""}` : tq ? `?${tq}` : "";
    await fetch(`/api/athena/query/${currentId}/stop${qs}`, { method: "POST" });
    if (pollRef.current) clearTimeout(pollRef.current);
    setRunning(false); setCurrentId(""); setCurrentHandleId(""); message.info(t("查询已取消"));
  };

  const treeData = tree.map((ns) => ({
    // 序 38 B-71:外部表桶的命名空间标明桶名(同名命名空间可能在两个桶里),key 也带桶
    title: ns.external
      ? <span data-testid="lake-ns-external"><Tag color="purple" style={{ marginRight: 4 }}>{ns.bucket}</Tag>📁 {ns.namespace}</span>
      : <span>📁 {ns.namespace}</span>,
    key: `ns:${ns.bucket || ""}:${ns.namespace}`, selectable: false,
    children: ns.tables.map((tb) => ({
      title: <Space size={4}><TableOutlined /><span>{tb.name}</span></Space>,
      key: tb.qualifiedName, isLeaf: true, selectable: true,
    })),
  }));

  return (
    <div>
      <h2>
        <CloudOutlined /> {t("Athena 查询（S3 Tables / Iceberg）")}
        {/* @kf-batch 50-WP4ter-coverage —— 护栏 2:执行目标必须一眼可见(查错区比查不出来更坏) */}
        {execRegion ? (
          <Tag color="blue" style={{ marginLeft: 8 }} data-testid="athena-exec-target">{execRegion}</Tag>
        ) : (
          <Tag style={{ marginLeft: 8 }} data-testid="athena-exec-target">{t("主控区")}</Tag>
        )}
      </h2>
      <Alert
        type="info" showIcon style={{ marginBottom: 12 }}
        message={<span>{t("通过 Amazon Athena 查询当前执行目标的 S3 Tables 表桶（Iceberg）。统一")}<strong>{t("只读")}</strong>{t("，结果不落库。")}{catalog && <> {t("联邦目录：")}<code>{catalog}</code></>}</span>}
      />

      <div style={{ display: "flex", gap: 16 }}>
        {/* 左：S3 Tables 表树 */}
        <div style={{ width: 280, flexShrink: 0 }}>
          <Card size="small" title={<Space><DatabaseTitle /></Space>}
            extra={<Tooltip title={t("刷新表")}><Button size="small" type="text" icon={<ReloadOutlined />} loading={loadingTables} onClick={fetchTables} /></Tooltip>}
            style={{ height: "calc(100vh - 320px)", overflow: "auto" }}>
            {tree.length ? (
              <Tree treeData={treeData} defaultExpandAll
                onSelect={(keys) => {
                  const k = keys[0] as string;
                  if (k && !k.startsWith("ns:")) setSql(`SELECT * FROM ${k} LIMIT 100`);
                }} />
            ) : loadingTables ? <Spin style={{ display: "block", margin: "20px auto" }} />
              : <div style={{ color: "#999", textAlign: "center", padding: 20 }}>{t("无表或加载失败")}</div>}
          </Card>
        </div>

        {/* 右：编辑器 + 结果 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <Space>
              <Button icon={<ClearOutlined />} onClick={() => { setSql(""); setResult(null); setError(""); setStats(null); }}>{t("清空")}</Button>
            </Space>
            <Space>
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleExecute} loading={running}>
                {running ? t("执行中...") : t("执行")}
              </Button>
              {running && currentId && <Button danger onClick={handleCancel}>{t("取消")}</Button>}
            </Space>
          </div>

          <div style={{ border: "1px solid #1d4254", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
            <MonacoEditor height="260px" language="sql" theme="vs-dark" value={sql} onChange={(v) => setSql(v || "")} options={{ minimap: { enabled: false }, fontSize: 14 }} />
          </div>

          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}
          {running && <Spin tip={t("执行中...")} style={{ display: "block", margin: "20px auto" }} />}

          {stats && !running && (
            <Space style={{ marginBottom: 8 }}>
              <Tag color="cyan">{t("扫描 {size}", { size: fmtBytes(stats.dataScannedBytes) })}</Tag>
              <Tag color="blue">{t("耗时 {time}", { time: stats.executionTimeMs != null ? `${(stats.executionTimeMs / 1000).toFixed(2)}s` : "-" })}</Tag>
              {result && <Tag>{t("返回 {n} 行", { n: result.rows.length })}</Tag>}
            </Space>
          )}

          {result && (
            <div style={{ overflowX: "auto" }}>
              <Table size="small"
                dataSource={result.rows.map((row, i) => {
                  const obj: any = { _key: i };
                  result.columns.forEach((col, j) => { obj[col] = row[j]; });
                  return obj;
                })}
                columns={result.columns.map((col) => ({ title: col, dataIndex: col, key: col, ellipsis: true }))}
                rowKey="_key" scroll={{ x: "max-content" }} pagination={{ pageSize: 50, showTotal: (total) => t("共 {n} 行", { n: total }) }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DatabaseTitle() {
  const t = useT();
  return <span><TableOutlined /> {t("S3 Tables 表")}</span>;
}
