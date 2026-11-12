"use client";

import React, { useEffect, useState } from "react";
import { Table, Button, Space, Tag, Popconfirm, message, Select, Input, Card, Switch, Tooltip } from "antd";
import { PlusOutlined, ReloadOutlined, PlayCircleOutlined, PauseCircleOutlined, SearchOutlined, LoadingOutlined } from "@ant-design/icons";
import type { SyncTask } from "@/types/sync-task";
import { useRouter } from "next/navigation";
import SyncTaskModal from "./SyncTaskModal";
// 指定业务日期运行(不用它 = 直接「启动」= 改动前的行为)
import RunWithDateModal from "@/components/sync/RunWithDateModal";
import { useT } from "@/lib/i18n/useT";
// 执行范围接入(50 SPEC §2.6 / INTERACTION §9)。
// 🔴 列表请求带 `?scope=`;`global` 时 `toScopeParam` 回 null ⇒ URL 与改动前逐字节相同(回滚点)。
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { toScopeParam } from "@/lib/scope/scope";
import { isHome } from "@/lib/exec-env/target-id";
// 自动刷新的事实在纯模块(page 文件不许多出 export,否则 next build 失败)
import { SYNC_AUTO_REFRESH_MS, anySyncInFlight } from "@/lib/sync/auto-refresh";
// 页面删除读响应的唯一作者:失败呈现服务端原话,成功才提示「已删除」
import { deleteJson } from "@/lib/http/delete-json";
import { syncTaskCanStop, syncToggleAction, SYNC_STATUS_META } from "@/lib/sync/row-action";
import { Empty, Alert } from "antd";

// 状态文案与「启动 / 停止」判别搬到唯一作者 `lib/sync/row-action.ts`(列表与详情共用;provisioning「启动中」可停)

const channelLabel: Record<string, string> = { "zero-etl": "Zero-ETL", glue: "Glue ETL", dms: "DMS" };

export default function SyncPage() {
  const t = useT();
  const [data, setData] = useState<SyncTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SyncTask | undefined>();
  const router = useRouter();
  const [filters, setFilters] = useState({ name: "", channel: "", syncMode: "", targetType: "", status: "" });
  // PLT-02: guard expensive row actions (start/stop/delete) against double-submit.
  const [busyId, setBusyId] = useState<string>("");
  const [runDateTask, setRunDateTask] = useState<SyncTask | null>(null);
  // (用户 2026-10-15:「数据同步页面增加定时刷新,否则要手动刷新才能看见任务运行的最终状态」)
  //   有任务在跑(running / starting / stopping)时每 SYNC_AUTO_REFRESH_MS 自动重拉一次列表;全部到终态就停,不白打接口。
  //   开关默认开,用户可关(关了就回到手动刷新);状态只存本页内存,不进 URL。
  const [autoRefresh, setAutoRefresh] = useState(true);
  // 当前执行范围(顶栏选的那个;URL 是权威)
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `scope=${encodeURIComponent(scopeParam)}` : "";
  // 单区视角且不是主控区 ⇒ 新建入口要先说清落点(护栏 2:写操作复述目标,不做静默)
  const nonHomeView = scope.kind === "target" && !isHome(scope.targetId);
  const viewRegion = scope.kind === "target" ? scopeTargets?.find((x) => x.targetId === scope.targetId)?.region || "" : "";

  const fetchData = async (f?: typeof filters) => {
    setLoading(true);
    try {
      const cur = f || filters;
      const params = new URLSearchParams();
      if (cur.name) params.set("name", cur.name);
      if (cur.channel) params.set("channel", cur.channel);
      if (cur.syncMode) params.set("syncMode", cur.syncMode);
      if (cur.targetType) params.set("targetType", cur.targetType);
      if (cur.status) params.set("status", cur.status);
      // 执行范围与既有筛选并列进同一个 query
      if (scopeQs) params.set("scope", scopeParam!);
      const qs = params.toString();
      const res = await fetch(`/api/sync${qs ? `?${qs}` : ""}`);
      const d = await res.json();
      setData(Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []);
    } finally { setLoading(false); }
  };

  // 🔴 `scopeQs` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)
  useEffect(() => { fetchData(); }, [scopeQs]);

  // 自动刷新:只在开关开 + 有任务处于非终态时轮询;终态齐了自然停
  const anyInFlight = anySyncInFlight(data);
  useEffect(() => {
    if (!autoRefresh || !anyInFlight) return;
    const timer = setInterval(() => { fetchData(); }, SYNC_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, anyInFlight, scopeQs, filters]);

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await deleteJson(`/api/sync/${id}`);
      message.success(t("已删除"));
      fetchData();
    } catch (e) {
      // 服务端拒绝(409 通道还在撤 / 502 撤不下来)⇒ 原话呈现、行不动;此前这里无条件提示「已删除」
      message.error((e as Error).message || t("删除失败"));
    } finally { setBusyId(""); }
  };

  const handleToggle = async (id: string, status: string, syncMode?: string, channel?: string) => {
    if (busyId) return; // prevent double-submit
    setBusyId(id);
    // DMS 通道(全量/增量/实时)统一走 DMS 启动入口 start-realtime;Glue / Zero-ETL 走 /start。
    // 唯一作者判「停 / 启」(provisioning 也可停,不再把「启动中」再发一次 start-realtime)
    const path = syncToggleAction(status, channel);
    const isDmsStart = path === "start-realtime";
    try {
      const res = await fetch(`/api/sync/${id}/${path}`, { method: "POST" });
      const data = await res.json();
      if (data.success === false || data.error) {
        message.error(data.error?.message || data.error || t("操作失败"));
        return;
      }
      message.success(isDmsStart ? (data.data?.message || t("DMS 同步已启动")) : path === "start" ? t("已启动") : t("已停止"));
      fetchData();
    } finally { setBusyId(""); }
  };

  const columns = [
    { title: t("任务名称"), dataIndex: "name", key: "name",
      render: (v: string, r: any) => <a onClick={() => router.push(`/sync/${r.taskId}`)} style={{ cursor: "pointer" }}><b>{v}</b></a> },
    { title: t("同步通道"), dataIndex: "channel", key: "channel", render: (v: string) => channelLabel[v] || v },
    { title: t("同步模式"), dataIndex: "syncMode", key: "syncMode", render: (v: string) => v === "full" ? t("全量") : v === "realtime" ? t("实时(CDC)") : t("增量") },
    { title: t("目标"), dataIndex: "targetType", key: "targetType", render: (v: string) => v?.toUpperCase() },
    {
      title: t("状态"), dataIndex: "status", key: "status",
      render: (v: string) => <Tag color={SYNC_STATUS_META[v]?.color}>{SYNC_STATUS_META[v] ? t(SYNC_STATUS_META[v].text) : v}</Tag>,
    },
    { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    {
      title: t("操作"), key: "action",
      render: (_: any, record: SyncTask) => (
        <Space>
          <a onClick={() => handleToggle(record.taskId, record.status, record.syncMode, record.channel)} style={busyId === record.taskId ? { pointerEvents: "none", opacity: 0.5 } : {}}>
            {busyId === record.taskId ? <LoadingOutlined /> : syncTaskCanStop(record.status) ? <><PauseCircleOutlined /> {t("停止")}</> : <><PlayCircleOutlined /> {t("启动")}</>}
          </a>
          {(record.channel || "glue") === "glue" && record.status !== "running" && (
            <a data-testid="sync-run-date-link" onClick={() => setRunDateTask(record)}>{t("指定日期运行")}</a>
          )}
          <a onClick={() => router.push(`/sync/${record.taskId}`)}>{t("详情")}</a>
          <a onClick={() => { setEditing(record); setModalOpen(true); }}>{t("编辑")}</a>
          <Popconfirm title={t("确认删除？")} onConfirm={() => handleDelete(record.taskId)} okButtonProps={{ loading: busyId === record.taskId }}
            description={record.channel === "dms" ? <span data-testid="sync-delete-dms-note" style={{ maxWidth: 360, display: "inline-block" }}>{t("若删后该区再无 DMS 任务,复制实例将在空闲宽限后由后台自动回收(下次启动需重新创建,约 10–15 分钟);停止态任务保留检查点、实例不回收。")}</span> : undefined}>
            <a style={{ color: "red" }}>{t("删除")}</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{t("数据同步")}</h2>
        <Space>
          <Tooltip title={t("有任务在运行 / 启动 / 停止时每 {s} 秒自动重拉列表;全部到终态即停", { s: String(SYNC_AUTO_REFRESH_MS / 1000) })}>
            <span data-testid="sync-auto-refresh" data-on={autoRefresh ? "true" : "false"} data-polling={autoRefresh && anyInFlight ? "true" : "false"}>
              <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} /> <span style={{ fontSize: 12 }}>{t("自动刷新")}</span>
            </span>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>{t("刷新")}</Button>
          <Button type="primary" data-testid="sync-create-btn" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); setModalOpen(true); }}>
            {t("新建同步任务")}
          </Button>
        </Space>
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input placeholder={t("任务名称")} prefix={<SearchOutlined />} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} onPressEnter={() => fetchData()} allowClear style={{ width: 180 }} />
          <Select placeholder={t("同步通道")} value={filters.channel || undefined} onChange={(v) => { const f = { ...filters, channel: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 130 }}
            options={[{ label: "Glue ETL", value: "glue" }, { label: "Zero-ETL", value: "zero-etl" }, { label: "DMS CDC", value: "dms" }]} />
          <Select placeholder={t("同步模式")} value={filters.syncMode || undefined} onChange={(v) => { const f = { ...filters, syncMode: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            options={[{ label: t("全量"), value: "full" }, { label: t("增量"), value: "incremental" }]} />
          <Select placeholder={t("目标")} value={filters.targetType || undefined} onChange={(v) => { const f = { ...filters, targetType: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 140 }}
            options={[{ label: t("S3 数据湖"), value: "s3-tables" }, { label: "Redshift", value: "redshift" }, { label: "S3 + Redshift", value: "both" }]} />
          <Select placeholder={t("状态")} value={filters.status || undefined} onChange={(v) => { const f = { ...filters, status: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 110 }}
            options={[{ label: t("草稿"), value: "draft" }, { label: t("运行中"), value: "running" }, { label: t("成功"), value: "succeeded" }, { label: t("已停止"), value: "stopped" }, { label: t("异常"), value: "error" }]} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchData()}>{t("搜索")}</Button>
          <Button onClick={() => { const f = { name: "", channel: "", syncMode: "", targetType: "", status: "" }; setFilters(f); fetchData(f); }}>{t("重置")}</Button>
        </Space>
      </Card>
      {/* 护栏 2:非主控区视角下,先把「新建会落在哪」说清楚,
          不静默、也不把入口藏起来(功能守恒:不许用删入口冒充 fail-closed)。 */}
      {nonHomeView && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="sync-nonhome-notice"
          message={
            <span>
              {t("当前只看")} <b>{viewRegion || scope.kind === "target" && scope.targetId}</b>
              {t(":同步任务的执行落点**跟随它引用的数据源**。在这个视角下新建数据源就会建在这个区(密钥 / 安全组 / Glue 连接都建在那儿),由它派生的同步任务也在这个区跑;站在「全部」视角时,新建向导的数据源下拉会标出每个源在哪个区 —— 选哪个源就等于选在哪个区跑。")}
            </span>
          }
        />
      )}
      <Table
        columns={columns}
        dataSource={data}
        rowKey="taskId"
        loading={loading}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <ScopeEmptyHint
                  resources={["sync"]}
                  noun={t("同步任务")}
                  // 执行已逐区下推,这里是可建可跑的正常空态
                  // 任务跟随数据源的执行环境(源在哪个区,就在那个区跑);跨区取数是设计禁止(409),不是没做完。
                  note={t("同步任务跟随数据源的执行环境:在当前区新建数据源后即可建任务、就地执行(源与任务必须同区,跨区取数为设计禁止)")}
                />
              }
            />
          ),
        }}
      />
      {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」 */}
      <OtherScopesHint resources={["sync"]} />
      <SyncTaskModal open={modalOpen} editing={editing} onClose={() => setModalOpen(false)} onSuccess={() => { setModalOpen(false); fetchData(); }} />
      <RunWithDateModal task={runDateTask} open={!!runDateTask} onClose={() => setRunDateTask(null)} onStarted={() => fetchData()} />
    </div>
  );
}
