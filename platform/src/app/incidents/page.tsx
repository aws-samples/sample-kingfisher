"use client";

// 模块 43-A — 运维知识库(Incident Memory)。诊断沉淀的结构化故障,按 signature 归并成"故障类别":
// 顶部健康度卡(类别数/已验证修复覆盖率/累计发生/复发Top),主表按复发排序 + 筛选,展开抽屉看
// 发生时间线 + 维护"已验证修复手册"(乐观锁)。读时后端 reconcile 把 done 诊断补记(零侵入模块25)。

import React, { useEffect, useState } from "react";
import {
  Card, Table, Tag, Button, Space, Drawer, Input, Select, message, Row, Col,
  Timeline, Typography, Switch, Popconfirm, Empty, Tooltip,
} from "antd";
import { BulbOutlined, ReloadOutlined, CheckCircleOutlined, StopOutlined, ExportOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import FeatureGuide from "@/components/common/FeatureGuide";
import { MetricCard } from "@/components/dashboard/charts";
// @kf-batch 50-WP4quater-reads(工单 SC-20)—— 运维知识库按执行范围过滤。
// 🔴 故障是**跑在某个区**的作业出的:同一个签名在 us-west-2 反复出、在主控区一次没有,这件事
// 原来完全看不出来(顶部覆盖率与复发 Top 都是全平台合计)。列表 + 健康度**用同一个 scope**,
// 否则会出现「覆盖率 60%」配一张两行的表这种自相矛盾。
import { useScope } from "@/components/scope/ScopeProvider";
import { toScopeParam } from "@/lib/scope/scope";
import { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";

const { TextArea } = Input;
const { Paragraph, Text } = Typography;

const STATUS_META: Record<string, { color: string; label: string }> = {
  unresolved: { color: "warning", label: "未解决" },
  "resolved-verified": { color: "success", label: "已验证修复" },
  silenced: { color: "default", label: "已抑制" },
};

export default function IncidentsPage() {
  const t = useT();
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const viewRegion = scope.kind === "target" ? scopeTargets?.find((x) => x.targetId === scope.targetId)?.region || scope.targetId : "";
  const [rows, setRows] = useState<any[]>([]);
  const [health, setHealth] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [engine, setEngine] = useState<string | undefined>();
  const [q, setQ] = useState("");
  const [reconcileInfo, setReconcileInfo] = useState<any | null>(null);

  // 详情抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fixMd, setFixMd] = useState("");
  const [fixVerified, setFixVerified] = useState(false);
  const [saving, setSaving] = useState(false);

  // 43-A 二期加固:初始加载纯读(reconcile=0,实测 22ms vs 516ms;重读路径是偶发 502 诱因);
  // reconcile 只在点「刷新」时跑一次兜底——A.2 即时 hook 已保证新诊断实时沉淀,纯读不漏数据。
  const load = (reconcile = false) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (engine) params.set("engine", engine);
    if (q.trim()) params.set("q", q.trim());
    if (!reconcile) params.set("reconcile", "0");
    // 🔴 `global` 时 `toScopeParam` 回 null ⇒ 不带该参数,URL 与改动前逐字节相同(回滚点)
    if (scopeParam) params.set("scope", scopeParam);
    const healthQs = scopeParam ? `&scope=${encodeURIComponent(scopeParam)}` : "";
    Promise.all([
      fetch(`/api/incidents?${params.toString()}`).then((r) => r.json()),
      fetch(`/api/incidents/health?reconcile=0${healthQs}`).then((r) => r.json()),
    ])
      .then(([list, h]) => {
        setRows(list?.data?.items || []);
        setReconcileInfo(list?.data?.reconcile || null);
        setHealth(h?.data || null);
      })
      .catch(() => message.error(t("加载失败")))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  // 🔴 `scopeParam` 进 deps:切范围**不重载页面**,靠这里重拉(护栏 4)
  useEffect(() => { load(); }, [status, engine, scopeParam]);

  const openDetail = async (row: any) => {
    setDrawerOpen(true);
    setDetail(null);
    setDetailLoading(true);
    setFixMd(row.resolution?.markdown || "");
    setFixVerified(!!row.resolution?.verified);
    try {
      const d = await fetch(`/api/incidents/${encodeURIComponent(row.signature)}`).then((r) => r.json());
      setDetail(d?.data || null);
      setFixMd(d?.data?.master?.resolution?.markdown || "");
      setFixVerified(!!d?.data?.master?.resolution?.verified);
    } catch {
      message.error(t("加载详情失败"));
    } finally {
      setDetailLoading(false);
    }
  };

  const saveResolution = async () => {
    if (!detail?.master) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/incidents/${encodeURIComponent(detail.master.signature)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: fixMd, verified: fixVerified, version: detail.master.version }),
      });
      const d = await res.json();
      if (res.status === 409) { message.error(t("版本冲突,请刷新后重试")); return; }
      if (!res.ok) { message.error(d?.error?.message || t("保存失败")); return; }
      message.success(t("修复手册已保存"));
      setDetail({ ...detail, master: d?.data });
      load();
    } finally {
      setSaving(false);
    }
  };

  const silence = async (row: any) => {
    const res = await fetch(`/api/incidents/${encodeURIComponent(row.signature)}/silence`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    if (res.ok) { message.success(t("已抑制该类故障")); load(); } else { message.error(t("操作失败")); }
  };

  const mttrText = health?.avgMttrSec != null ? `${Math.round(health.avgMttrSec / 60)} ${t("分钟")}` : "—";
  const coverageText = health ? `${Math.round((health.verifiedFixCoverage || 0) * 100)}%` : "—";
  const top1 = health?.topRecurring?.[0];

  const columns = [
    {
      title: t("故障签名"), dataIndex: "signature", key: "signature",
      render: (v: string, r: any) => (
        <Space direction="vertical" size={0}>
          <a onClick={() => openDetail(r)}><Text code>{v}</Text></a>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.title}</Text>
        </Space>
      ),
    },
    { title: t("引擎"), dataIndex: "engine", key: "engine", width: 100, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: t("复发次数"), dataIndex: "occurrenceCount", key: "occ", width: 100, sorter: (a: any, b: any) => (a.occurrenceCount || 0) - (b.occurrenceCount || 0),
      render: (v: number) => <Tag color={v >= 3 ? "error" : v === 2 ? "warning" : "default"}>{v || 1}</Tag>,
    },
    { title: t("影响任务"), dataIndex: "affectedTasks", key: "tasks", width: 100, render: (v: string[]) => (v || []).length },
    {
      // @kf-batch 50-WP4quater-reads —— 这类故障在哪些区出现过(护栏 2:落点必须一眼可见)。
      // 🔴 无章的存量主档如实显示「主控区」而不是留空:留空会让人以为「不属于任何区」,
      // 而读侧的回落规则明确把它算进主控区 —— 显示与过滤必须是同一句话。
      title: t("出现区域"), dataIndex: "targets", key: "targets", width: 170,
      render: (v: string[], r: any) => {
        const list: string[] = Array.isArray(v) && v.length ? v : r.targetId ? [r.targetId] : ["tgt_home"];
        return (
          <Space size={2} wrap>
            {list.map((tid) => (
              <Tag key={tid} color={tid === "tgt_home" ? "default" : "blue"}>
                {scopeTargets?.find((x) => x.targetId === tid)?.region || tid}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: t("首次 / 最近"), key: "seen", width: 180,
      render: (_: any, r: any) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <Text type="secondary">{t("首次")} {(r.firstSeenAt || "").slice(0, 10)}</Text>
          <Text type="secondary">{t("最近")} {(r.lastSeenAt || "").slice(0, 10)}</Text>
        </Space>
      ),
    },
    {
      title: t("状态"), dataIndex: "status", key: "status", width: 130,
      render: (v: string, r: any) => (
        <Space>
          <Tag color={STATUS_META[v]?.color || "default"}>{t(STATUS_META[v]?.label || v)}</Tag>
          {r.hasVerifiedFix && <Tooltip title={t("已有已验证修复手册")}><SafetyCertificateOutlined style={{ color: "#52c41a" }} /></Tooltip>}
        </Space>
      ),
    },
    {
      title: t("操作"), key: "op", width: 180,
      render: (_: any, r: any) => (
        <Space>
          <Button size="small" onClick={() => openDetail(r)}>{t("详情/修复")}</Button>
          {r.status !== "silenced" && (
            <Popconfirm title={t("抑制该类故障 30 天?")} onConfirm={() => silence(r)}>
              <Button size="small" icon={<StopOutlined />}>{t("抑制")}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const engineOptions = Array.from(new Set(rows.map((r) => r.engine).filter(Boolean))).map((e) => ({ value: e, label: e }));

  return (
    <div style={{ padding: 24 }}>
      <Card
        title={<Space><BulbOutlined />{t("运维知识库")}</Space>}
        extra={
          <Space>
            <Button icon={<ExportOutlined />} onClick={() => window.open("/api/incidents/export?format=jsonl", "_blank")}>{t("脱敏导出")}</Button>
            <Button icon={<ReloadOutlined />} onClick={() => load(true)}>{t("刷新")}</Button>
          </Space>
        }
      >
        <FeatureGuide
          title={t("运维知识库")}
          what="平台每次对失败任务做的 AI 诊断,都会被自动归一成一条结构化「故障类别」并按指纹(signature)归并——同类故障复发只累加计数、不重复建条。你在这里维护每类故障的「已验证修复手册」,让诊断越用越懂这套管道:下次同类故障再发,诊断会直接引用你上次验证有效的修复。这是随使用复利、竞品拿空框架追不上的运维数据资产。"
          steps={[
            "任务失败后到「任务监控」对失败运行发起 AI 诊断;诊断完成即被沉淀到本库(打开本页时自动补记,无需手工录入)。",
            "在列表里按复发次数/引擎/状态筛选,点「详情/修复」展开某类故障。",
            "抽屉里看该类故障的发生时间线(每次的运行/时间),并撰写「已验证修复手册」(Markdown)。",
            "确认修复真实有效后,打开「标记为已验证」并保存——只有已验证的手册才会被诊断 Agent 引用。",
            "已知无害或待排期的故障可「抑制」,不占用未解决计数。",
          ]}
          tips={[
            "签名算法已做归一化脱敏:去掉表名/路径/账号/UUID/日期等可变量,同因归并、异因区分,且入库不落敏感数据。",
            "「脱敏导出」输出 JSONL,只含脱敏后的签名/症状模板/引擎/修复类型,可作对外评测场景集(DataOps-Bench)原料。",
            "修复手册需 editor 及以上角色维护;导出需项目 owner。",
          ]}
        />

        {/* 健康度卡 */}
        <Row gutter={12} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}><Card size="small" styles={{ body: { padding: 0 } }}><MetricCard value={health?.categoryCount ?? 0} label={t("故障类别数")} sub={t("累计发生 {n} 次", { n: health?.totalOccurrences ?? 0 })} /></Card></Col>
          <Col xs={12} sm={6}><Card size="small" styles={{ body: { padding: 0 } }}><MetricCard value={coverageText} label={t("已验证修复覆盖率")} sub={t("{n} 类有已验证修复", { n: health?.verifiedFixCount ?? 0 })} /></Card></Col>
          <Col xs={12} sm={6}><Card size="small" styles={{ body: { padding: 0 } }}><MetricCard value={mttrText} label={t("平均 MTTR")} sub={t("未解决 {n} 类", { n: health?.unresolvedCount ?? 0 })} /></Card></Col>
          <Col xs={12} sm={6}><Card size="small" styles={{ body: { padding: 0 } }}><MetricCard value={top1?.occurrenceCount ?? 0} label={t("复发 Top1")} sub={top1?.engine ? `${top1.engine}` : "—"} /></Card></Col>
        </Row>

        {/* 筛选 */}
        <Space style={{ marginBottom: 12 }} wrap>
          <Select allowClear placeholder={t("状态")} style={{ width: 140 }} value={status} onChange={setStatus}
            options={[
              { value: "unresolved", label: t("未解决") },
              { value: "resolved-verified", label: t("已验证修复") },
              { value: "silenced", label: t("已抑制") },
            ]} />
          <Select allowClear placeholder={t("引擎")} style={{ width: 140 }} value={engine} onChange={setEngine} options={engineOptions} />
          <Input.Search placeholder={t("搜索签名关键词")} allowClear style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} onSearch={() => load()} />
          {reconcileInfo?.recorded > 0 && <Text type="secondary">{t("本次新沉淀 {n} 条", { n: reconcileInfo.recorded })}</Text>}
        </Space>

        <Table
          rowKey="signature"
          size="small"
          loading={loading}
          columns={columns as any}
          dataSource={rows}
          pagination={{ pageSize: 10 }}
          locale={{
            // @kf-batch 50-WP4quater-reads(工单 SC-20)—— 护栏 1「永远不让用户丢东西」:
            // 单区视角下知识库常常本来就是空的(那个区还没出过故障),而「空」与「这一页没按范围过滤」
            // 在界面上长得一模一样 ⇒ 空态必须说出「别的范围里还有多少条」并给切过去的入口。
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <ScopeEmptyHint
                    resources={["incident"]}
                    noun={t("故障沉淀")}
                    note={t("对失败任务发起 AI 诊断后会自动归并到此;故障归到**作业实际执行的那个区**")}
                  />
                }
              />
            ),
          }}
        />
      </Card>

      {/* 详情抽屉:时间线 + 修复手册 */}
      <Drawer
        title={detail?.master ? <Space><Text code>{detail.master.signature}</Text></Space> : t("故障详情")}
        width={640}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        loading={detailLoading}
      >
        {detail?.master && (
          <>
            <Paragraph>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Text strong>{detail.master.title}</Text>
                <Space wrap>
                  <Tag>{detail.master.engine}</Tag>
                  <Tag color={STATUS_META[detail.master.status]?.color}>{t(STATUS_META[detail.master.status]?.label || detail.master.status)}</Tag>
                  <Tag color={detail.master.occurrenceCount >= 3 ? "error" : "default"}>{t("复发 {n} 次", { n: detail.master.occurrenceCount || 1 })}</Tag>
                </Space>
                {detail.master.rootCauseSummary && (
                  <Text type="secondary">{t("最近诊断根因归纳")}: {detail.master.rootCauseSummary}</Text>
                )}
              </Space>
            </Paragraph>

            <Card size="small" title={t("已验证修复手册")} style={{ marginBottom: 16 }}
              extra={<Space><Text type="secondary" style={{ fontSize: 12 }}>{t("标记为已验证")}</Text><Switch checked={fixVerified} onChange={setFixVerified} /></Space>}>
              <TextArea rows={6} value={fixMd} onChange={(e) => setFixMd(e.target.value)}
                placeholder={t("用 Markdown 记录:根因 + 逐步修复动作 + 验证方法。只有标记「已验证」后,才会被诊断 Agent 引用。")} />
              <div style={{ marginTop: 8 }}>
                <Button type="primary" icon={<CheckCircleOutlined />} loading={saving} onClick={saveResolution}>{t("保存修复手册")}</Button>
                {detail.master.resolution?.verifiedBy && (
                  <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                    {t("上次验证")}: {detail.master.resolution.verifiedBy} @ {(detail.master.resolution.verifiedAt || "").slice(0, 16).replace("T", " ")}
                  </Text>
                )}
              </div>
            </Card>

            <Card size="small" title={t("发生时间线")}>
              {(detail.occurrences || []).length ? (
                <Timeline
                  items={(detail.occurrences || []).map((o: any) => ({
                    children: (
                      <Space direction="vertical" size={0}>
                        <Text>{(o.occurredAt || "").slice(0, 16).replace("T", " ")} · <Text strong>{o.taskName || o.taskId}</Text> <Tag>{o.taskType}</Tag></Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{o.symptomDigest}</Text>
                        {o.runId && <Text type="secondary" style={{ fontSize: 12 }}>runId: {o.runId}</Text>}
                      </Space>
                    ),
                  }))}
                />
              ) : <Empty description={t("暂无发生记录")} />}
            </Card>
          </>
        )}
      </Drawer>
    </div>
  );
}
