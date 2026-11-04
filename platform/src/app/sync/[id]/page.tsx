"use client";
// 序 41 B-118 —— 「启动 / 停止」判别的唯一作者(与列表页共用)
import { syncTaskCanStop, syncToggleAction } from "@/lib/sync/row-action";

import React, { useEffect, useState } from "react";
import { Button, Card, Descriptions, Space, Table, Tabs, Tag, Spin, message, Badge, Alert, Modal } from "antd";
import { ArrowLeftOutlined, PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { useParams, useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 37-sync-backfill —— 序 37 ⑥:指定业务日期运行(不用它 = 直接「启动」= 改动前的行为)
import RunWithDateModal from "@/components/sync/RunWithDateModal";
// @kf-batch 50-SEQ47a-promote-ux —— 同步任务也是可发布到环境的配置资源(后端 ResourceType 早含 "sync"),页面此前没有入口
import PromoteButton from "@/components/common/PromoteButton";
import EnvTag from "@/components/common/EnvTag";
import EnvPromotionStatus from "@/components/common/EnvPromotionStatus";
// 序 73 模块 57(R8 ③):工作流里的同步节点写进本任务运行历史的行 ⇒ 「由工作流「X」触发」可点回那次工作流运行(唯一作者)
import RunTriggerCell from "@/components/monitor/RunTriggerCell";

const channelLabel: Record<string, string> = { "zero-etl": "Zero-ETL", glue: "Glue ETL", dms: "DMS" };
const statusBadge: Record<string, any> = { draft: "default", running: "processing", succeeded: "success", stopped: "warning", error: "error", active: "success" };

export default function SyncDetailPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<any>(null);
  const [runs, setRuns] = useState<any>({ runs: [], stats: {} });
  const [loading, setLoading] = useState(true);
  const [glueRun, setGlueRun] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [s3Files, setS3Files] = useState<any[]>([]);
  const [rt, setRt] = useState<any>(null); // 模块 31 (R6): 实时(CDC)运行态监控
  const [ze, setZe] = useState<any>(null); // Zero-ETL 增量(CDC)运行态:集成状态 + 已复制行数
  const [runLogModal, setRunLogModal] = useState<{ open: boolean; runId: string; logs: string[]; loading: boolean }>({ open: false, runId: "", logs: [], loading: false });
  const [runDateOpen, setRunDateOpen] = useState(false);

  const fetchTask = async () => {
    const res = await fetch(`/api/sync/${id}`);
    const d = await res.json();
    setTask(d.success ? d.data : d);
  };

  const fetchRuns = async () => {
    const res = await fetch(`/api/sync/${id}/runs`);
    const d = await res.json();
    setRuns(d.success ? d.data : d);
  };

  const fetchGlueStatus = async (jobName: string) => {
    try {
      const res = await fetch(`/api/sync/${id}/glue-status`);
      const d = await res.json();
      if (d.success) {
        setGlueRun(d.data);
        // If Glue finished, refresh task and runs to get updated status
        if (d.data?.state === "SUCCEEDED" || d.data?.state === "FAILED") {
          fetchTask();
          fetchRuns();
        }
      }
    } catch {}
  };

  const fetchLogs = async () => {
    setLogsLoading(true);
    try {
      // 实时/全量(DMS)/ Zero-ETL 任务无 Glue 日志,改取最近一次运行记录的内联编排日志。
      if (task?.channel === "dms" || task?.channel === "zero-etl") {
        const rid = task?.lastRunId || runs?.runs?.[0]?.runId;
        if (rid) {
          const res = await fetch(`/api/sync/${id}/runs/${encodeURIComponent(rid)}/logs`);
          const d = await res.json();
          setLogs((d.success ? d.data?.logs : d.logs) || []);
        }
        return;
      }
      const res = await fetch(`/api/sync/${id}/logs`);
      const d = await res.json();
      setLogs(d.success ? d.data : d.logs || []);
    } catch {} finally { setLogsLoading(false); }
  };

  const fetchS3Output = async () => {
    try {
      const res = await fetch(`/api/sync/${id}/output`);
      const d = await res.json();
      if (d.success) setS3Files(d.data);
    } catch {}
  };

  // 模块 31 (R6): 拉取实时(CDC)运行态(全量进度/状态/各表已复制行数)。
  const fetchRealtime = async () => {
    try {
      const res = await fetch(`/api/sync/${id}/realtime-status`);
      const d = await res.json();
      if (d.success) setRt(d.data);
    } catch {}
  };

  // Zero-ETL 增量(真·CDC)运行态:集成状态 + 已复制行数(供详情页展示与无头验证)。
  const fetchZeroEtl = async () => {
    try {
      const res = await fetch(`/api/sync/${id}/zeroetl-status`);
      const d = await res.json();
      if (d.success) setZe(d.data);
    } catch {}
  };

  useEffect(() => {
    Promise.all([fetchTask(), fetchRuns()]).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (task?.glueJobName) { fetchGlueStatus(task.glueJobName); fetchLogs(); fetchS3Output(); }
  }, [task?.glueJobName]);

  // 模块 31 + DMS:DMS 通道任务(全量/增量/实时)首次加载即拉一次运行态 + 编排日志。
  useEffect(() => {
    if (task?.channel === "dms") { fetchRealtime(); fetchLogs(); }
  }, [task?.channel, task?.lastRunId]);

  // Zero-ETL 增量任务:首次加载拉集成态 + 编排日志。
  useEffect(() => {
    if (task?.channel === "zero-etl") { fetchZeroEtl(); fetchLogs(); }
  }, [task?.channel, task?.lastRunId]);

  // Auto-refresh when running(批同步走 Glue;实时任务额外轮询 realtime-status)
  useEffect(() => {
    const isDms = task?.channel === "dms";
    const isZeroEtl = task?.channel === "zero-etl";
    const isResident = isDms || isZeroEtl; // 常驻/托管复制通道:provisioning/running 均需轮询
    const active = isResident ? task?.status === "running" || task?.status === "provisioning" : task?.status === "running";
    if (!active) return;
    const timer = setInterval(() => {
      fetchTask();
      if (isDms) { fetchRealtime(); fetchRuns(); fetchLogs(); }
      else if (isZeroEtl) { fetchZeroEtl(); fetchRuns(); fetchLogs(); }
      else { fetchGlueStatus(task.glueJobName); fetchLogs(); }
    }, 10000);
    return () => clearInterval(timer);
  }, [task?.status, task?.syncMode, task?.channel]);

  const handleToggle = async () => {
    // 模块 31 + DMS:DMS 通道任务(全量/增量/实时)走 DMS 启动入口 start-realtime,与 Glue 批同步解耦。
    // 序 41 B-118:唯一作者判「停 / 启」(provisioning 也可停)
    const action = syncToggleAction(task.status, task.channel);
    if (action === "start-realtime") {
      const res = await fetch(`/api/sync/${id}/start-realtime`, { method: "POST" });
      const data = await res.json();
      if (data.success === false) { message.error(data.error?.message || t("启动 DMS 同步失败")); return; }
      message.success(data.data?.message || t("DMS 同步已启动"));
      fetchTask();
      return;
    }
    const res = await fetch(`/api/sync/${id}/${action}`, { method: "POST" });
    const data = await res.json();
    if (data.success === false) { message.error(data.error?.message || t("操作失败")); return; }
    message.success(data.data?.message || (action === "start" ? t("已启动") : t("已停止")));
    fetchTask();
    if (action === "start") setTimeout(() => {
      if (task.channel === "zero-etl") { fetchZeroEtl(); fetchRuns(); }
      else { fetchGlueStatus(task.glueJobName); }
      fetchLogs();
    }, 5000);
  };

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;
  if (!task) return <div>{t("任务不存在")}</div>;

  // @kf-batch 50-WP7-sync-pushdown —— 🔴「是不是 S3 Tables 落点」的真值是 `targetType`,不是
  // 「表桶字段填了没有」。向导已改为**留空 = 按执行环境解析**(不再预填 home 桶名),旧写法
  // `!!s3Config.tableBucket` 会让新建任务在首次运行前整块落点信息消失。留 `||` 那半兼容
  // 早期没有 targetType 的存量任务;桶名未定则如实写「按执行环境解析」,不猜一个名字。
  const isS3Tables = task.targetType === "s3-tables" || task.targetType === "both" || !!task.s3Config?.tableBucket;
  const outputDisplay = isS3Tables
    ? `S3 Tables: ${task.s3Config?.tableBucket || t("(按执行环境解析)")}/${task.s3Config?.namespace || "ecommerce"}`
    : task.s3Config?.bucket ? `s3://${task.s3Config.bucket}/${task.s3Config.prefix || ""}` : null;


  const viewRunLog = async (runId: string) => {
    setRunLogModal({ open: true, runId, logs: [], loading: true });
    try {
      // 🔴 runId 要编码:定时同步 run 的 id 由 ETL DAG 写成 `<run_id>#<targetId>`(T-12),`#` 会截断 URL
      const res = await fetch(`/api/sync/${id}/runs/${encodeURIComponent(runId)}/logs`);
      const d = await res.json();
      const logs = d.success ? (d.data?.logs || []) : [t("加载失败")];
      setRunLogModal({ open: true, runId, logs, loading: false });
    } catch {
      setRunLogModal({ open: true, runId, logs: [t("加载失败")], loading: false });
    }
  };

  const runColumns = [
    { title: "#", key: "idx", render: (_: any, __: any, i: number) => runs.runs.length - i },
    { title: t("开始时间"), dataIndex: "startedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    { title: t("耗时"), dataIndex: "duration", render: (v: number) => v ? `${Math.floor(v / 60)}m${v % 60}s` : "-" },
    { title: t("读取"), key: "read", render: (_: any, r: any) => r.metrics?.rowsRead?.toLocaleString() || "-" },
    { title: t("写入"), key: "write", render: (_: any, r: any) => r.metrics?.rowsWritten?.toLocaleString() || "-" },
    { title: t("状态"), dataIndex: "status", render: (v: string) => <Badge status={statusBadge[v] || "default"} text={v === "succeeded" ? t("成功") : v === "failed" ? t("失败") : v} /> },
    { title: t("触发"), dataIndex: "triggeredBy", width: 200, render: (_: any, r: any) => <RunTriggerCell run={r} /> },
    { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v: string) => v ? <Tag color="red">{v.slice(0, 60)}</Tag> : "-" },
    { title: t("日志"), key: "log", width: 80, render: (_: any, r: any) => (
      <Button size="small" type="link" onClick={() => viewRunLog(r.runId)}>
        {r.logS3Key ? t("📋 查看") : r.status === "running" ? "⏳" : t("📋 查看")}
      </Button>
    )},
  ];

  const mappingData = task.fieldMappings ? Object.entries(task.fieldMappings).flatMap(([table, fields]: [string, any]) =>
    (fields || []).map((f: any, i: number) => ({ key: `${table}-${i}`, table, ...f }))
  ) : [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/sync")}>{t("返回")}</Button>
          <h2 style={{ margin: 0 }}>{task.name || t("同步任务")}</h2>
          <Badge status={statusBadge[task.status] || "default"} text={task.status} />
          <EnvTag env={task.env || "dev"} current />
          <EnvPromotionStatus type="sync" id={task.taskId} />
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { fetchTask(); fetchRuns(); fetchLogs(); fetchS3Output(); }}>{t("刷新")}</Button>
          <PromoteButton type="sync" id={task.taskId} onPromoted={fetchTask} />
          {(task.channel || "glue") === "glue" && task.status !== "running" && (
            <Button data-testid="sync-run-date-btn" onClick={() => setRunDateOpen(true)}>{t("指定日期运行")}</Button>
          )}
          <Button icon={syncTaskCanStop(task.status) ? <PauseCircleOutlined /> : <PlayCircleOutlined />} type="primary" onClick={handleToggle}>
            {syncTaskCanStop(task.status) ? t("停止") : t("启动")}
          </Button>
        </Space>
      </div>

      {/* Config Summary */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Descriptions column={4} size="small">
          <Descriptions.Item label={t("通道")}>{channelLabel[task.channel] || task.channel}</Descriptions.Item>
          <Descriptions.Item label={t("模式")}>{task.syncMode === "full" ? t("全量") : task.syncMode === "realtime" ? t("实时(CDC)") : t("增量")} / {task.writeMode}</Descriptions.Item>
          <Descriptions.Item label={t("目标")}>{task.targetType?.toUpperCase()}</Descriptions.Item>
          <Descriptions.Item label={t("调度")}>{task.cronExpression || t("未配置")}</Descriptions.Item>
          <Descriptions.Item label={t("源表")}>{task.sourceTables?.join(", ")}</Descriptions.Item>
          <Descriptions.Item label="Glue Job"><Tag color="blue">{task.glueJobName || t("未创建")}</Tag></Descriptions.Item>
          {outputDisplay && <Descriptions.Item label={t("数据输出")} span={2}><Tag color="green">{outputDisplay}</Tag></Descriptions.Item>}
        </Descriptions>
      </Card>

      {/* Glue Run Status */}
      {glueRun && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Descriptions column={4} size="small" title={t("最近运行")}>
            <Descriptions.Item label={t("状态")}><Badge status={glueRun.state === "SUCCEEDED" ? "success" : glueRun.state === "FAILED" ? "error" : glueRun.state === "RUNNING" ? "processing" : "default"} text={glueRun.state} /></Descriptions.Item>
            <Descriptions.Item label={t("开始")}>{glueRun.startedOn?.slice(0, 19).replace("T", " ")}</Descriptions.Item>
            <Descriptions.Item label={t("耗时")}>{glueRun.executionTime ? `${glueRun.executionTime}s` : "-"}</Descriptions.Item>
            <Descriptions.Item label="DPU">{glueRun.dpuSeconds || "-"}</Descriptions.Item>
            {glueRun.errorMessage && <Descriptions.Item label={t("错误")} span={4}><Alert type="error" message={glueRun.errorMessage} /></Descriptions.Item>}
          </Descriptions>
        </Card>
      )}

      {/* 模块 31 + DMS:DMS 通道(全量/增量/实时)运行态监控 */}
      {task.channel === "dms" && (
        <Card size="small" style={{ marginBottom: 16 }} title={t("DMS 同步监控")}>
          <Descriptions column={4} size="small" style={{ marginBottom: rt?.tables?.length ? 12 : 0 }}>
            <Descriptions.Item label={t("复制状态")}>
              <Badge status={statusBadge[task.status] || (rt?.status === "running" ? "processing" : "default")} text={rt?.status || task.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t("全量进度")}>{rt?.fullLoadProgress != null ? `${rt.fullLoadProgress}%` : "-"}</Descriptions.Item>
            <Descriptions.Item label={t("CDC 延迟")}>{rt?.cdcLatencySec != null ? `${rt.cdcLatencySec}s` : "—"}</Descriptions.Item>
            <Descriptions.Item label={t("目标")}>REDSHIFT</Descriptions.Item>
            {(rt?.lastFailure || task.realtimeConfig?.error) && (
              <Descriptions.Item label={t("错误")} span={4}><Alert type="error" message={rt?.lastFailure || task.realtimeConfig?.error} /></Descriptions.Item>
            )}
          </Descriptions>
          {rt?.tables?.length > 0 && (
            <Table size="small" pagination={false} rowKey={(r: any) => `${r.schema}.${r.table}`} dataSource={rt.tables}
              columns={[
                { title: t("表"), key: "t", render: (_: any, r: any) => <b>{r.schema}.{r.table}</b> },
                { title: t("状态"), dataIndex: "state" },
                { title: t("全量行数"), dataIndex: "fullRows", render: (v: number) => v?.toLocaleString() ?? 0 },
                { title: t("插入"), dataIndex: "inserts", render: (v: number) => <Tag color="green">{v ?? 0}</Tag> },
                { title: t("更新"), dataIndex: "updates", render: (v: number) => <Tag color="blue">{v ?? 0}</Tag> },
                { title: t("删除"), dataIndex: "deletes", render: (v: number) => <Tag color="red">{v ?? 0}</Tag> },
              ]} />
          )}
        </Card>
      )}

      {/* Zero-ETL 增量(真·CDC)集成监控 */}
      {task.channel === "zero-etl" && (
        <Card size="small" style={{ marginBottom: 16 }} title={t("Zero-ETL 增量同步 (托管 CDC)")}>
          <Descriptions column={4} size="small" style={{ marginBottom: ze?.counts?.length ? 12 : 0 }}>
            <Descriptions.Item label={t("集成状态")}>
              <Badge status={ze?.integrationStatus === "active" ? "success" : ze?.integrationStatus === "failed" ? "error" : (task.status === "provisioning" || ze?.integrationStatus === "creating") ? "processing" : "default"} text={ze?.integrationStatus || task.status} />
            </Descriptions.Item>
            <Descriptions.Item label={t("目标 Workgroup")}>{ze?.workgroup || "—"}</Descriptions.Item>
            <Descriptions.Item label={t("目标库")}>{ze?.destDb || "—"}</Descriptions.Item>
            <Descriptions.Item label={t("源 Schema")}>{ze?.schema || task.sourceDatabase || "—"}</Descriptions.Item>
            {(ze?.error || task.zeroEtlError) && (
              <Descriptions.Item label={t("错误")} span={4}><Alert type="error" message={ze?.error || task.zeroEtlError} /></Descriptions.Item>
            )}
          </Descriptions>
          {ze?.integrationStatus === "active" && (
            <Alert type="success" showIcon style={{ marginBottom: ze?.counts?.length ? 12 : 0 }}
              message={t("增量同步运行中:源 {schema} 的变更将近实时复制到 Redshift。无头验证:Redshift 查询页选 Workgroup「{workgroup}」/ 库「{destDb}」,执行 SELECT COUNT(*) FROM {schema2}.<表>。", { schema: ze?.schema || "", workgroup: ze?.workgroup, destDb: ze?.destDb, schema2: ze?.schema })} />
          )}
          {ze?.counts?.length > 0 && (
            <Table size="small" pagination={false} rowKey="table" dataSource={ze.counts}
              columns={[
                { title: t("表"), dataIndex: "table", render: (v: string) => <b>{ze.schema}.{v}</b> },
                { title: t("已复制行数"), dataIndex: "rows", render: (v: number | null) => v != null ? v.toLocaleString() : <Tag color="orange">{t("同步中")}</Tag> },
              ]} />
          )}
        </Card>
      )}

      {/* Stats */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space size={48}>
          <div><div style={{ fontSize: 24, fontWeight: "bold" }}>{runs.stats?.total || 0}</div><div style={{ color: "#888" }}>{t("运行次数")}</div></div>
          <div><div style={{ fontSize: 24, fontWeight: "bold", color: "#52c41a" }}>{runs.stats?.successRate ? (runs.stats.successRate * 100).toFixed(0) + "%" : "N/A"}</div><div style={{ color: "#888" }}>{t("成功率")}</div></div>
          <div><div style={{ fontSize: 24, fontWeight: "bold" }}>{runs.stats?.avgDuration ? Math.round(runs.stats.avgDuration) + "s" : "N/A"}</div><div style={{ color: "#888" }}>{t("平均耗时")}</div></div>
          <div><div style={{ fontSize: 24, fontWeight: "bold" }}>{runs.stats?.totalRows?.toLocaleString() || 0}</div><div style={{ color: "#888" }}>{t("累计行数")}</div></div>
        </Space>
      </Card>

      <Tabs items={[
        { key: "logs", label: t("运行日志"), children: (
          <div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <Button size="small" onClick={fetchLogs} loading={logsLoading}>{t("刷新日志")}</Button>
            </div>
            <div style={{ maxHeight: 500, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
              {logs.length > 0 ? logs.map((line, i) => (
                <div key={i} style={{ color: line.includes("ERROR") || line.includes("error") ? "#ff6b6b" : line.includes("WARN") ? "#ffd43b" : line.includes("SYNC RESULTS") || line.includes("completed") ? "#69db7c" : "#d4d4d4" }}>
                  {line}
                </div>
              )) : <span style={{ color: "#808080" }}>{task.syncMode === "realtime" ? t("实时任务未启动或编排日志加载中…(点击右上角启动按钮)") : task.glueJobName ? t("日志加载中... 任务启动后约 30 秒开始输出日志") : t("任务未启动，无日志")}</span>}
            </div>
          </div>
        )},
        { key: "output", label: t("输出结果"), children: (
          <div>
            {outputDisplay && (
              <Alert type="info" message={t("数据输出位置: {loc}", { loc: outputDisplay })} style={{ marginBottom: 16 }} />
            )}
            {s3Files.length > 0 ? (
              <Table size="small" dataSource={s3Files} rowKey="key" columns={[
                { title: t("文件路径"), dataIndex: "key", render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
                { title: t("大小"), dataIndex: "size", render: (v: number) => v > 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : `${(v / 1024).toFixed(1)} KB` },
                { title: t("修改时间"), dataIndex: "lastModified", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
              ]} />
            ) : <div style={{ color: "#999", textAlign: "center", padding: 40 }}>{t("任务运行完成后将显示输出文件列表")}</div>}
          </div>
        )},
        { key: "runs", label: t("运行历史 ({n})", { n: runs.runs?.length || 0 }), children: <Table columns={runColumns} dataSource={runs.runs} rowKey="runId" size="small" /> },
        { key: "mapping", label: t("字段映射"), children: (
          <Table size="small" dataSource={mappingData} pagination={false} columns={[
            { title: t("表"), dataIndex: "table", render: (v: string) => <b>{v}</b> },
            { title: t("源字段"), dataIndex: "source", render: (v: string) => <code>{v}</code> },
            { title: t("源类型"), dataIndex: "sourceType", render: (v: string) => <Tag>{v}</Tag> },
            { title: "→", width: 30, render: () => "→" },
            { title: t("目标字段"), dataIndex: "target", render: (v: string) => <code>{v}</code> },
            { title: t("目标类型"), dataIndex: "targetType", render: (v: string) => <Tag color="blue">{v}</Tag> },
          ]} />
        )},
        { key: "config", label: t("完整配置"), children: (
          <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 16, borderRadius: 8, fontSize: 12, maxHeight: 400, overflow: "auto" }}>
            {JSON.stringify(task, null, 2)}
          </pre>
        )},
      ]} />

      <Modal title={t("运行日志 - {rid}", { rid: runLogModal.runId?.slice(-8) })} open={runLogModal.open}
        onCancel={() => setRunLogModal({ open: false, runId: "", logs: [], loading: false })} footer={null} width={900}>
        {runLogModal.loading ? <Spin style={{ display: "block", margin: "40px auto" }} /> : (
          <div style={{ maxHeight: 500, overflow: "auto", background: "#1e1e1e", color: "#d4d4d4", padding: 16, borderRadius: 8, fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
            {runLogModal.logs.length > 0 ? runLogModal.logs.map((line, i) => (
              <div key={i} style={{ color: line.includes("ERROR") || line.includes("Exception") ? "#ff6b6b" : line.includes("WARN") ? "#ffd43b" : line.includes("SYNC RESULTS") || line.includes("completed") || line.includes("Written") ? "#69db7c" : "#d4d4d4" }}>
                {line}
              </div>
            )) : <span style={{ color: "#808080" }}>{t("暂无日志")}</span>}
          </div>
        )}
      </Modal>
      <RunWithDateModal task={task} open={runDateOpen} onClose={() => setRunDateOpen(false)}
        onStarted={() => { fetchTask(); setTimeout(() => { fetchGlueStatus(task.glueJobName); fetchLogs(); }, 5000); }} />
    </div>
  );
}
