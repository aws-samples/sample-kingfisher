"use client";

// O2 前端:①「在哪些区跑」运行对话框(默认跟随执行范围视角) ②「多区联动运行」组行列表。
// 合同 50 SPEC v3.44 §2.7 / INTERACTION §9.4;判据 ACCEPTANCE 段 `o2`。
//
// 🔴 护栏(与 INTERACTION §9 六条同源):
//   · **绝不静默切顶栏的执行范围** —— 这里只决定「这次在哪些区跑」,不动视角;
//   · **按钮复述**要跑几个区、跑哪几个(用户点下去之前必须知道会发生什么);
//   · 组行**不许把「一个区失败」折成整组失败** —— 状态一律用服务端派生的 `derivedStatus`
//     (列表接口也带派生值:未展开时显示表里的物化 `status` 就是让**第二真值源**泄漏到界面上);
//   · 取消 / 重试的结果**逐区如实回报**,一个区停不下来不许说「已全部取消」。
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Checkbox, Modal, Popconfirm, Space, Table, Tag, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";

const { Text } = Typography;

export type RunGroupDefinitionKindUi = "etl-job" | "engine-job" | "workflow";

/** 组状态 → 颜色 / 人话。派生值由服务端给,这里只负责显示。 */
const GROUP_STATUS: Record<string, { color: string; label: string }> = {
  submitting: { color: "default", label: "提交中" },
  running: { color: "processing", label: "运行中" },
  succeeded: { color: "success", label: "全部成功" },
  "partial-failed": { color: "warning", label: "部分成功" },
  failed: { color: "error", label: "全部失败" },
  cancelled: { color: "default", label: "已取消" },
};

// ① 运行对话框已搬到 `RunTargetsModal.tsx`(理由见那个文件头):同一份交互,两处用。
export { RunTargetsModal } from "./RunTargetsModal";

// ─────────────────────── ② 组行列表 ───────────────────────

interface GroupRow {
  runGroupId: string;
  definitionKind: string;
  definitionId: string;
  requestedTargets: string[];
  accepted?: Record<string, { runId?: string; definitionVersion?: number }>;
  skipped?: Record<string, { reason: string }>;
  status: string;
  /** 🔴 服务端派生值 —— UI 只许看它(表里的 `status` 是缓存)。 */
  derivedStatus: string;
  childCount: number;
  triggeredBy: string;
  createdAt: string;
  finishedAt?: string;
  retryOfRunGroupId?: string;
}

interface ChildRow {
  targetId: string;
  region: string | null;
  runId: string;
  status: string;
  taskType: string;
  startedAt?: string;
  finishedAt?: string;
  definitionVersion?: number;
  error?: string;
}

const LIST_PATH: Record<RunGroupDefinitionKindUi, (id: string, engine?: string) => string> = {
  "etl-job": (id) => `/api/etl-jobs/${encodeURIComponent(id)}/run-groups`,
  "engine-job": (id, engine) => `/api/engines/${encodeURIComponent(engine || "emr-serverless")}/${encodeURIComponent(id)}/run-groups`,
  workflow: (id) => `/api/workflow/${encodeURIComponent(id)}/run-groups`,
};

export function RunGroupsPanel({
  kind, definitionId, engine, onRetry, refreshKey,
}: {
  kind: RunGroupDefinitionKindUi;
  definitionId: string;
  engine?: string;
  /** 「只重试失败区」由页面用**原来那条运行路由**发起(服务端只给计划,不自己扇出)。 */
  onRetry: (plan: { targets: string[]; retryOfRunGroupId: string }) => Promise<void>;
  refreshKey?: number;
}) {
  const t = useT();
  const [rows, setRows] = useState<GroupRow[] | null>(null);
  const [err, setErr] = useState("");
  const [children, setChildren] = useState<Record<string, ChildRow[]>>({});
  const [derived, setDerived] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(LIST_PATH[kind](definitionId, engine));
      const d = await r.json();
      if (!d?.success) { setErr(d?.error?.message || `HTTP ${r.status}`); setRows(null); return; }
      setErr("");
      setRows(d.data.items as GroupRow[]);
    } catch (e) {
      // 🔴 拉不到**不当成"没有联动运行"** —— 那是撒谎(读不到 ≠ 没有)
      setErr((e as Error)?.message || t("网络异常"));
      setRows(null);
    }
  }, [kind, definitionId, engine, t]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const openGroup = async (id: string) => {
    const r = await fetch(`/api/run-groups/${encodeURIComponent(id)}`);
    const d = await r.json();
    if (!d?.success) { message.error(d?.error?.message || t("读取联动运行失败")); return; }
    setChildren((m) => ({ ...m, [id]: d.data.children as ChildRow[] }));
    // 🔴 状态**只信服务端派生值**(表里的 status 是缓存)
    setDerived((m) => ({ ...m, [id]: d.data.derivedStatus as string }));
    if (d.data.unknownChildStatuses?.length) {
      message.warning(t("有 {n} 条运行的状态平台不认识:{list} —— 已如实显示,请检查", {
        n: d.data.unknownChildStatuses.length, list: d.data.unknownChildStatuses.join("、"),
      }));
    }
  };

  const doCancel = async (id: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/run-groups/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const d = await r.json();
      if (!d?.success) { message.error(d?.error?.message || t("取消失败")); return; }
      const res: Array<{ targetId: string; cancelled: boolean; reason?: string }> = d.data.results || [];
      const ok = res.filter((x) => x.cancelled).map((x) => x.targetId);
      const bad = res.filter((x) => !x.cancelled);
      if (ok.length) message.success(t("已取消 {n} 个区:{where}", { n: ok.length, where: ok.join("、") }));
      // 🔴 停不下来的逐个点名 —— 不许把「2 个区停了 1 个」说成全部取消
      if (bad.length) message.warning(t("{n} 个区没停下来:{list}", { n: bad.length, list: bad.map((x) => `${x.targetId}(${x.reason || "未知原因"})`).join(";") }));
      await openGroup(id); await load();
    } finally { setBusy(""); }
  };

  const doRetry = async (id: string) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/run-groups/${encodeURIComponent(id)}/retry-failed`, { method: "POST" });
      const d = await r.json();
      if (!d?.success) { message.error(d?.error?.message || t("重试失败")); return; }
      await onRetry({ targets: d.data.targets as string[], retryOfRunGroupId: d.data.retryOfRunGroupId as string });
      await load();
    } finally { setBusy(""); }
  };

  if (err) {
    return <Alert type="error" showIcon data-testid="run-groups-error" message={t("读取联动运行失败:{e}", { e: err })} />;
  }
  return (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>{t("刷新")}</Button>
        <Text type="secondary" style={{ fontSize: 12 }} data-testid="run-groups-hint">
          {t("只有一次点击跑了**多个**执行范围时才会出现联动运行;单区运行照旧在「运行历史」里一行。")}
        </Text>
      </Space>
      <Table size="small" rowKey="runGroupId" dataSource={rows || []} loading={rows === null && !err}
             data-testid="run-groups-table" pagination={{ pageSize: 10 }}
             expandable={{
               onExpand: (expanded, r) => { if (expanded) void openGroup(r.runGroupId); },
               expandedRowRender: (r) => (
                 <Table size="small" rowKey="runId" pagination={false} dataSource={children[r.runGroupId] || []}
                        data-testid={`run-group-children-${r.runGroupId}`}
                        columns={[
                          { title: t("执行区域"), dataIndex: "targetId", render: (v: string, c: ChildRow) => (
                            <Space size={4}>
                              <Tag color="cyan" data-testid={`rg-child-target-${v}`}>{v}</Tag>
                              {/* 🔴 环境被删了 region 读不到 ⇒ 标出来,但**这一行照样列** */}
                              {c.region ? <Text type="secondary" style={{ fontSize: 11 }}>{c.region}</Text>
                                        : <Text type="secondary" style={{ fontSize: 11 }} data-testid="rg-child-region-na">{t("(该执行环境已不在注册表)")}</Text>}
                            </Space>
                          ) },
                          { title: t("状态"), dataIndex: "status", width: 100, render: (v: string) => <Tag data-testid={`rg-child-status-${v}`}>{v}</Tag> },
                          // 🔴 跨区定义版本差要**看得见**(它刻意不进分组键)
                          { title: t("定义版本"), dataIndex: "definitionVersion", width: 90,
                            render: (v?: number) => (typeof v === "number" ? <Tag data-testid="rg-child-defver">v{v}</Tag> : "-") },
                          { title: t("开始"), dataIndex: "startedAt", width: 170, render: (v?: string) => v?.slice(0, 19).replace("T", " ") || "-" },
                          { title: t("错误"), dataIndex: "error", ellipsis: true, render: (v?: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : "-" },
                        ]} />
               ),
             }}
             columns={[
               { title: t("联动运行"), dataIndex: "runGroupId", width: 210, render: (v: string, r: GroupRow) => (
                 <Space direction="vertical" size={0}>
                   <code style={{ fontSize: 11 }} data-testid={`run-group-id-${v}`}>{v}</code>
                   {r.triggeredBy === "schedule" && <Tag color="gold" style={{ fontSize: 11 }} data-testid="rg-scheduled">{t("定时")}</Tag>}
                   {r.retryOfRunGroupId && (
                     <Text type="secondary" style={{ fontSize: 11 }} data-testid={`rg-retry-of-${v}`}>
                       {t("重试自 {id}", { id: r.retryOfRunGroupId })}
                     </Text>
                   )}
                 </Space>
               ) },
               { title: t("区数"), key: "n", width: 96, render: (_: unknown, r: GroupRow) => (
                 // 🔴 「请求了几个区 / 真起了几条 run」是两个数,**都要给** ——
                 //    只给前者会把「有一个区压根没提交」说成正常(那正是护栏 1 要防的事)
                 <span data-testid={`rg-count-${r.runGroupId}`}>{r.childCount}/{(r.requestedTargets || []).length}</span>
               ) },
               { title: t("状态"), key: "st", width: 110, render: (_: unknown, r: GroupRow) => {
                 // 🔴 展开过就用**服务端派生值**;没展开时表里的物化值只是缓存 ⇒ 标出来
                 const st = derived[r.runGroupId] ?? r.derivedStatus;
                 const meta = GROUP_STATUS[st] || { color: "default", label: st };
                 return <Tag color={meta.color} data-testid={`rg-status-${r.runGroupId}`}>{t(meta.label)}</Tag>;
               } },
               { title: t("开始"), dataIndex: "createdAt", width: 170, render: (v: string) => v?.slice(0, 19).replace("T", " ") },
               { title: t("操作"), key: "act", width: 260, render: (_: unknown, r: GroupRow) => {
                 const st = derived[r.runGroupId] ?? r.derivedStatus;
                 const canCancel = st === "running" || st === "submitting";
                 const canRetry = st === "partial-failed" || st === "failed";
                 return (
                   <Space>
                     <Popconfirm title={t("取消这一组里还没跑完的区?")} okText={t("取消未完成")} cancelText={t("先不")}
                                 description={t("已经跑完的区**不会**被动(不连坐);正在跑的会被停下来。")}
                                 onConfirm={() => void doCancel(r.runGroupId)}>
                       <Button size="small" danger disabled={!canCancel} loading={busy === r.runGroupId}
                               data-testid={`rg-cancel-${r.runGroupId}`}>{t("取消未完成")}</Button>
                     </Popconfirm>
                     <Button size="small" disabled={!canRetry} loading={busy === r.runGroupId}
                             onClick={() => void doRetry(r.runGroupId)}
                             data-testid={`rg-retry-${r.runGroupId}`}>{t("只重试失败区")}</Button>
                   </Space>
                 );
               } },
             ]} />
    </>
  );
}
