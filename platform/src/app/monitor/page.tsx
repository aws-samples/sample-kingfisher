"use client";

import React, { useEffect, useState, useRef } from "react";
// 执行范围接入(50 SPEC §2.6;交互 INTERACTION §9)。
// 🔴 护栏 1 的数字来自**列表响应自己的** `countsByTarget`(同一时间窗、同一筛选),
// 不走 `/api/scope/counts` —— 那是不带窗口的全表计数,与本页口径必然对不上(SPEC v3.35 §2.6.6)。
import { useScope } from "@/components/scope/ScopeProvider";
import { ScopeCountsHint } from "@/components/scope/OtherScopesHint";
import { toScopeParam } from "@/lib/scope/scope";
import { Alert, Card, Col, Row, Statistic, Table, Tag, Tabs, Button, Space, Select, Badge, Input, DatePicker, message } from "antd";
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined, FileTextOutlined, ReloadOutlined, RedoOutlined, FieldTimeOutlined, SearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import DiagnosisButton from "@/components/common/DiagnosisButton";
import SchedulePanel from "@/components/monitor/SchedulePanel";
// 「运行日志」弹窗抽成唯一作者(补数中心实例抽屉同用)
import RunLogModal from "@/components/monitor/RunLogModal";
// 「触发」列与「触发方式」筛选的文案同一作者:补数 / 试运行 / 重跑不再冒称「手动」
import { triggeredByMeta, TRIGGERED_BY_FILTER_OPTIONS } from "@/lib/monitor/triggered-by";
import { useT } from "@/lib/i18n/useT";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

// 2026-07-13 调度运维收敛:原 /schedule 页并入本页「调度配置」Tab(看运行↔改调度一页完成),
// 旧 /schedule URL 重定向到 /monitor?tab=schedule。
export default function MonitorPage() {
  // 当前执行范围(URL 权威)
  const { scope } = useScope();
  const scopeParam = toScopeParam(scope);
  const [countsByTarget, setCountsByTarget] = useState<Record<string, number>>({});
  const t = useT();
  // 首帧固定 runs(= 服务端),挂载后按 ?tab=schedule 切换
  const [topTab, setTopTab] = useBrowserInitialState<string>("runs", () =>
    new URLSearchParams(window.location.search).get("tab") === "schedule" ? "schedule" : "runs"
  );
  const [runs, setRuns] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [loading, setLoading] = useState(false);
  // 弹窗本体抽到 components/monitor/RunLogModal(补数中心同用);这里只记「看哪条 run」
  const [logFor, setLogFor] = useState<{ taskId: string; runId: string } | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(10);
  const timerRef = useRef<NodeJS.Timeout>(undefined);
  // 🆕 region 筛选(50 INTERACTION §3.3):照本页既有惯例加一个 Select allowClear,与 status/taskType 并列。
  // 初始筛选可由地址栏带入(`?name=&triggeredBy=`):补数实例抽屉「去监控页定位」
  //   就是带着任务名 + backfill 跳过来的;没带参数时初值与改动前逐字节相同。
  //   首帧按空筛选渲染(= 服务端),挂载后再从地址栏取 name / triggeredBy
  const [filters, setFilters] = useBrowserInitialState(
    { name: "", status: "", taskType: "", triggeredBy: "", startDate: "", endDate: "", region: "" },
    () => {
      const qs = new URLSearchParams(window.location.search);
      return { name: qs.get("name") || "", status: "", taskType: "", triggeredBy: qs.get("triggeredBy") || "", startDate: "", endDate: "", region: "" };
    },
  );
  // 可选 region/target 由接口回(= 活跃执行目标 ∪ 结果里真实出现过的 target)。
  const [targets, setTargets] = useState<Array<{ targetId: string; region: string }>>([]);
  const [loadError, setLoadError] = useState("");

  const buildQuery = (f: typeof filters) => {
    const params = new URLSearchParams();
    if (f.name) params.set("name", f.name);
    if (f.status) params.set("status", f.status);
    if (f.taskType) params.set("taskType", f.taskType);
    if (f.triggeredBy) params.set("triggeredBy", f.triggeredBy);
    if (f.startDate) params.set("startDate", f.startDate);
    if (f.endDate) params.set("endDate", f.endDate);
    if (f.region) params.set("region", f.region);
    // 🔴 `global` 时 `toScopeParam` 回 null ⇒ **不带该参数**,请求 URL 与改动前逐字节相同(回滚点)
    if (scopeParam) params.set("scope", scopeParam);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  };

  const fetchData = (f?: typeof filters) => {
    setLoading(true);
    fetch(`/api/monitor/runs${buildQuery(f || filters)}`).then((r) => r.json()).then((d) => {
      // 🔴 本批给该接口补了鉴权(此前零守卫)。403/401 会回 { success:false, error:{message} },
      //    若仍按 `d.runs || []` 处理就会**静默显示空列表**,看起来像"没有运行"而不是"没有权限"。
      const err = d?.error?.message || (d?.success === false ? t("无权访问") : "") || d?.error;
      setLoadError(typeof err === "string" ? err : "");
      setRuns(d.runs || []);
      setStats(d.stats || {});
      if (Array.isArray(d.targets)) setTargets(d.targets);
      setCountsByTarget(d.countsByTarget && typeof d.countsByTarget === "object" ? d.countsByTarget : {});
    }).finally(() => setLoading(false));
  };

  // 🔴 `scopeParam` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchData(); }, [scopeParam]);
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (refreshInterval > 0) timerRef.current = setInterval(() => fetchData(), refreshInterval * 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refreshInterval, filters]);

  const onSearch = () => fetchData(filters);
  const onReset = () => { const f = { name: "", status: "", taskType: "", triggeredBy: "", startDate: "", endDate: "", region: "" }; setFilters(f); fetchData(f); };

  const viewLog = (taskId: string, runId: string) => setLogFor({ taskId, runId });

  const retryTask = async (taskId: string, taskType: string) => {
    const url = taskType === "workflow" ? `/api/workflow/${taskId}/trigger` : `/api/sync/${taskId}/start`;
    const res = await fetch(url, { method: "POST" });
    const d = await res.json();
    d.success !== false ? message.success(t("已重新触发")) : message.error(d.error?.message || t("触发失败"));
    fetchData();
  };

  const statusBadge = (v: string) => {
    const m: Record<string, { s: any; t: string }> = {
      succeeded: { s: "success", t: t("成功") }, failed: { s: "error", t: t("失败") }, running: { s: "processing", t: t("运行中") },
    };
    const st = m[v] || { s: "default", t: v };
    return <Badge status={st.s} text={st.t} />;
  };

  const columns = [
    { title: t("时间"), dataIndex: "startedAt", key: "time", width: 170,
      render: (v: string, r: any) => (v || r.finishedAt || "").slice(0, 19).replace("T", " ") || "-" },
    { title: t("任务名"), dataIndex: "taskName", key: "name",
      render: (v: string, r: any) => {
        // 跳转:workflow→编排页;EMR/ETL 作业(emr-serverless / etl-*)→「离线计算」(etl-jobs)页;其余(sync)→同步详情。
        const tt = r.taskType || "";
        // 治理定时任务 → 治理页;问数卡片 → 智能问数(卡片在「我的卡片」里)
        const href = tt === "workflow" ? `/workflow/${r.taskId}`
          : (tt === "emr-serverless" || tt.startsWith("etl")) ? `/etl-jobs`
          : tt === "governance" ? `/governance`
          : tt === "genbi-card" ? `/genbi`
          // 造数(手动 / 定时)→ 数据源页的「示范数据造数」卡片
          : tt === "seed" ? `/datasources`
          : `/sync/${r.taskId}`;
        return <a href={href}><b>{v}</b></a>;
      } },
    { title: t("类型"), dataIndex: "taskType", key: "type", width: 90,
      render: (v: string) => {
        const isSync = v === "sync";
        const isEmr = v === "emr-serverless";
        const isEtl = !isEmr && (v || "").startsWith("etl");
        // 两类平台动作的 run 行(治理定时 / 卡片定时刷新)
        if (v === "governance") return <Tag color="cyan" data-testid="run-type-governance">{t("治理任务")}</Tag>;
        if (v === "genbi-card") return <Tag color="magenta" data-testid="run-type-genbi-card">{t("问数卡片")}</Tag>;
        if (v === "seed") return <Tag color="gold" data-testid="run-type-seed">{t("造数")}</Tag>;
        const color = isSync ? "blue" : isEmr ? "volcano" : isEtl ? "green" : "purple";
        const label = isSync ? t("同步") : isEmr ? "EMR" : isEtl ? t("ETL作业") : t("工作流");
        return <Tag color={color}>{label}</Tag>;
      } },
    // 🆕 region 列:客户痛点"怕漏 region 对不上"的一眼可辨面。
    { title: t("区域"), dataIndex: "region", key: "region", width: 130,
      render: (v: string, r: any) => v
        ? <Tag color="geekblue" title={r.targetId || ""}>{v}</Tag>
        : <span style={{ color: "#bfbfbf" }} title={t("存量运行记录没有执行目标维度(视为主区域)")}>-</span> },
    // 跨法域 run 的区域审计 ID(全量留在该区,中央只留摘要;home 为空)
    { title: t("审计"), dataIndex: "residencyAuditId", key: "residencyAuditId", width: 110,
      render: (v: string) => v && !String(v).startsWith("pending#")
        ? <code data-testid="run-audit-id" style={{ fontSize: 11 }} title={v}>#{String(v).slice(-8)}</code>
        : <span style={{ color: "#bfbfbf" }}>-</span> },
    { title: t("触发"), dataIndex: "triggeredBy", key: "trigger", width: 80,
      render: (v: string) => { const m = triggeredByMeta(v); return <Tag color={m.color} data-testid="run-trigger" data-trigger={v || ""}>{t(m.label)}</Tag>; } },
    { title: t("状态"), dataIndex: "status", key: "status", width: 100, render: statusBadge },
    { title: t("耗时"), dataIndex: "duration", key: "duration", width: 80,
      render: (v: number) => v ? (v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`) : "-" },
    { title: t("错误"), dataIndex: "error", key: "error", ellipsis: true,
      render: (v: string) => v ? <span style={{ color: "#ff4d4f" }}>{v}</span> : "-" },
    { title: t("操作"), key: "action", width: 240,
      render: (_: any, r: any) => (
        <Space>
          <Button size="small" type="link" icon={<FileTextOutlined />} onClick={() => viewLog(r.taskId, r.runId)}>{t("日志")}</Button>
          {["succeeded", "failed"].includes(r.status) && <DiagnosisButton taskId={r.taskId} runId={r.runId} label={r.status === "failed" ? t("AI 诊断") : t("AI 分析")} />}
          {/* 平台动作没有「从监控页重试」的入口(重试 = 下一次 cron,或去它自己的页面手动跑)⇒ 不给一个点了会打错接口的按钮 */}
          {r.status === "failed" && r.taskType !== "governance" && r.taskType !== "genbi-card" && r.taskType !== "seed" && <Button size="small" type="link" danger icon={<RedoOutlined />} onClick={() => retryTask(r.taskId, r.taskType)}>{t("重试")}</Button>}
        </Space>
      ),
    },
  ];

  const runningRuns = runs.filter((r) => r.status === "running");
  const failedRuns = runs.filter((r) => r.status === "failed");
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayRuns = runs.filter((r) => (r.startedAt || r.finishedAt || "") >= todayStart);

  const runsView = (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <Space>
          <Select value={refreshInterval} onChange={setRefreshInterval} style={{ width: 130 }} options={[
            { label: t("手动刷新"), value: 0 }, { label: t("5秒自动"), value: 5 }, { label: t("10秒自动"), value: 10 }, { label: t("30秒自动"), value: 30 },
          ]} />
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>{t("刷新")}</Button>
        </Space>
      </div>

      {loadError ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }}
          message={t("运行记录读取失败")} description={loadError} />
      ) : null}

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={4}><Card size="small"><Statistic title={t("运行中")} value={stats.running || 0} prefix={<SyncOutlined spin={(stats.running || 0) > 0} />} valueStyle={{ color: "#1677ff" }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title={t("今日成功")} value={stats.todaySuccess || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: "#52c41a" }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title={t("今日失败")} value={stats.todayFailed || 0} prefix={<CloseCircleOutlined />} valueStyle={{ color: "#ff4d4f" }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title={t("今日运行")} value={stats.todayTotal || 0} prefix={<ClockCircleOutlined />} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title={t("成功率")} value={stats.successRate || 0} suffix="%" valueStyle={{ color: (stats.successRate || 0) >= 90 ? "#52c41a" : "#faad14" }} /></Card></Col>
        <Col span={4}><Card size="small"><Statistic title={t("平均耗时")} value={stats.avgDuration || 0} suffix="s" prefix={<FieldTimeOutlined />} /></Card></Col>
      </Row>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input placeholder={t("任务名称")} prefix={<SearchOutlined />} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} onPressEnter={onSearch} style={{ width: 180 }} allowClear />
          <Select placeholder={t("状态")} value={filters.status || undefined} onChange={(v) => { const f = { ...filters, status: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 110 }}
            options={[{ label: t("成功"), value: "succeeded" }, { label: t("失败"), value: "failed" }, { label: t("运行中"), value: "running" }]} />
          <Select placeholder={t("任务类型")} value={filters.taskType || undefined} onChange={(v) => { const f = { ...filters, taskType: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 130 }}
            options={[{ label: t("同步"), value: "sync" }, { label: t("工作流"), value: "workflow" }, { label: t("ETL作业(Glue)"), value: "etl-glue" }, { label: t("ETL作业(Redshift)"), value: "etl-redshift" }, { label: t("EMR离线"), value: "emr-serverless" }, { label: t("治理任务"), value: "governance" }, { label: t("问数卡片"), value: "genbi-card" }, { label: t("造数"), value: "seed" }]} data-testid="monitor-tasktype-filter" />
          <Select placeholder={t("区域")} value={filters.region || undefined} onChange={(v) => { const f = { ...filters, region: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 150 }}
            options={Array.from(new Set(targets.map((x) => x.region).filter(Boolean))).map((r) => ({ label: r, value: r }))} />
          <Select placeholder={t("触发方式")} value={filters.triggeredBy || undefined} onChange={(v) => { const f = { ...filters, triggeredBy: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            data-testid="monitor-trigger-filter"
            options={TRIGGERED_BY_FILTER_OPTIONS.map((o) => ({ label: t(o.label), value: o.value }))} />
          <DatePicker.RangePicker size="middle" allowClear
            onChange={(dates) => {
              const f = { ...filters, startDate: dates?.[0]?.format("YYYY-MM-DD") || "", endDate: dates?.[1]?.format("YYYY-MM-DD") || "" };
              setFilters(f); fetchData(f);
            }} />
          <Button type="primary" data-testid="monitor-search-btn" icon={<SearchOutlined />} onClick={onSearch}>{t("搜索")}</Button>
          <Button onClick={onReset}>{t("重置")}</Button>
        </Space>
      </Card>

      <Tabs items={[
        { key: "all", label: t("全部运行 ({n})", { n: runs.length }),
          children: (
            /* 无头验收要能只数「全部运行」这张表的行 */
            <div data-testid="run-table">
              <Table columns={columns} dataSource={runs} rowKey={(r) => `${r.taskId}-${r.runId}`} loading={loading} pagination={{ pageSize: 20 }} size="small" />
            </div>
          ) },
        { key: "running", label: <span style={{ color: runningRuns.length > 0 ? "#1677ff" : undefined }}>{t("运行中 ({n})", { n: runningRuns.length })}</span>,
          children: <Table columns={columns} dataSource={runningRuns} rowKey={(r) => `${r.taskId}-${r.runId}`} loading={loading} size="small" /> },
        { key: "failed", label: <span style={{ color: failedRuns.length > 0 ? "#ff4d4f" : undefined }}>{t("失败 ({n})", { n: failedRuns.length })}</span>,
          children: <Table columns={columns} dataSource={failedRuns} rowKey={(r) => `${r.taskId}-${r.runId}`} loading={loading} size="small" /> },
        { key: "today", label: t("今日 ({n})", { n: todayRuns.length }),
          children: <Table columns={columns} dataSource={todayRuns} rowKey={(r) => `${r.taskId}-${r.runId}`} loading={loading} pagination={{ pageSize: 20 }} size="small" /> },
      ]} />

      <RunLogModal open={!!logFor} taskId={logFor?.taskId ?? ""} runId={logFor?.runId ?? ""} onClose={() => setLogFor(null)} />
    </div>
  );

  return (
    <div>
      <h2 style={{ margin: "0 0 12px" }}>{t("任务监控")}</h2>
      {/* 护栏 1:target 视角常驻「其他执行范围还有 N 条」。
          数字来自列表响应自己的 countsByTarget(同一时间窗),不去问全表计数端点。 */}
      <ScopeCountsHint counts={countsByTarget} noun={t("运行")} />
      <Tabs
        activeKey={topTab}
        onChange={setTopTab}
        items={[
          { key: "runs", label: <span><FieldTimeOutlined /> {t("运行实例")}</span>, children: runsView },
          { key: "schedule", label: <span><ClockCircleOutlined /> {t("调度配置")}</span>, children: <SchedulePanel active={topTab === "schedule"} /> },
        ]}
      />
    </div>
  );
}
