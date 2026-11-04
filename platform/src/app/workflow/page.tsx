"use client";
// 序 41 B-117 —— 页面删除读响应的唯一作者:失败呈现服务端原话,成功才提示「已删除」
import { deleteJson } from "@/lib/http/delete-json";

import React, { useEffect, useState } from "react";
// @kf-batch 50-WP18-workflow-fanout —— 与离线作业**同一个**弹窗组件(一份交互两处用,别再抄一套)
import { RunTargetsModal } from "@/components/monitor/RunTargetsModal";
import { fetchExecTargets } from "@/lib/exec-env/exec-targets-client";
import { Table, Button, Space, Tag, Popconfirm, message, Modal, Input, Form, Select, Card } from "antd";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import type { Workflow } from "@/types/workflow";
import { useT } from "@/lib/i18n/useT";
// @kf-batch 50-WP4quater-reads —— 🔴 口径纠正:编排**不是**「中心一个 Airflow」。
// 每区一套 MWAA Serverless、调度只在本区执行、只有元数据上报主控区(用户第三次提醒)。
// 别把 [[one-agentcore-one-om-mandate]]「中心一份」那条纪律套到编排上 —— 那条只管 AgentCore / OM。
// @kf-batch 50-WP4ter-coverage —— 执行范围接入(工单 SC-3)。编排的执行体目前只有主控区
// (publish 走 `homeMwaaEndpoint()`),所以存量行经三级回落归主控区是真话;逐区扇出 = WP-14。
import { useScope } from "@/components/scope/ScopeProvider";
import OtherScopesHint, { ScopeEmptyHint } from "@/components/scope/OtherScopesHint";
import { landingOfScope, toScopeParam } from "@/lib/scope/scope";
import { isHome } from "@/lib/exec-env/target-id";
import { Empty, Alert } from "antd";

const statusMap: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  active: { color: "processing", text: "已发布" },
  paused: { color: "warning", text: "已暂停" },
  error: { color: "error", text: "异常" },
};

const runStatusMap: Record<string, { color: string; text: string }> = {
  running: { color: "processing", text: "运行中" },
  succeeded: { color: "success", text: "成功" },
  failed: { color: "error", text: "失败" },
};

export default function WorkflowPage() {
  const t = useT();
  const [data, setData] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();
  const router = useRouter();
  const [filters, setFilters] = useState({ name: "", status: "", cron: "" });
  // PLT-02: prevent double-submit on create and on row actions.
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string>("");
  // @kf-batch 50-WP18-workflow-fanout —— 多绑工作流触发前的「这次在哪些执行范围跑?」
  const [runPick, setRunPick] = useState<{ id: string; bindings: string[] } | null>(null);
  // @kf-batch 50-WP18-workflow-fanout —— 新建时可**多选**执行区(清单来自服务端 `/api/exec-targets`,前端不拼)
  const [execTargets, setExecTargets] = useState<Array<{ targetId: string; region: string; isHome: boolean }>>([]);
  // @kf-batch 50-B109-exec-target-dims —— 清单读取失败要**说出来**(原来 `.catch(() => [])` 静默回空,
  //   路由 400 了一个月只表现为「全选当前活跃区(0)」灰,没人知道是读失败;与离线作业页同一呈现:红 Tag + 原话)
  const [execTargetsErr, setExecTargetsErr] = useState<string>("");
  const [createTargets, setCreateTargets] = useState<string[]>([]);
  // @kf-batch 50-WP4ter-coverage
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `scope=${encodeURIComponent(scopeParam)}` : "";
  // @kf-batch 50-WP4quater-reads(工单 SC-3)—— 新建落点 = 当前视角(单区)/ 主控区(分组·全部)
  const createTargetId = scope.kind === "target" ? scope.targetId : undefined;
  const createRegion = createTargetId ? scopeTargets?.find((x) => x.targetId === createTargetId)?.region || createTargetId : "";
  const nonHomeView = scope.kind === "target" && !isHome(scope.targetId);
  const viewRegion = scope.kind === "target" ? scopeTargets?.find((x) => x.targetId === scope.targetId)?.region || "" : "";

  const fetchData = async (f?: typeof filters) => {
    setLoading(true);
    try {
      const cur = f || filters;
      const params = new URLSearchParams();
      if (cur.name) params.set("name", cur.name);
      if (cur.status) params.set("status", cur.status);
      if (cur.cron) params.set("cron", cur.cron);
      // @kf-batch 50-WP4ter-coverage
      if (scopeParam) params.set("scope", scopeParam);
      const qs = params.toString();
      const res = await fetch(`/api/workflow${qs ? `?${qs}` : ""}`);
      const wf = await res.json();
      setData(Array.isArray(wf) ? wf : Array.isArray(wf?.data) ? wf.data : []);
    } finally {
      setLoading(false);
    }
  };

  // @kf-batch 50-WP4ter-coverage —— 切范围不重载页面,靠 deps 重拉(护栏 4)
  useEffect(() => { fetchData(); }, [scopeQs]);
  // @kf-batch 50-WP18-workflow-fanout —— 可绑的执行区清单**来自服务端**(准入 + 组件 + 法域都由它判)
  //   维度 "airflow" = 装了任一调度组件的区(B-109 前路由不认这个维度 ⇒ 每次 400 ⇒ 多选永远空)
  useEffect(() => {
    fetchExecTargets("airflow")
      .then((list) => { setExecTargets(list); setExecTargetsErr(""); })
      .catch((e) => { setExecTargets([]); setExecTargetsErr(String(e?.message || e)); });
  }, []);

  const handleCreate = async () => {
    const values = await form.validateFields().catch(() => null); // 序 43 nit:校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!values) return;
    setCreating(true);
    try {
      // @kf-batch 50-WP4quater-reads(工单 SC-3)—— 🔴 新建工作流落**当前视角那个区**;
      // 服务端在建之前就核那个区有没有调度组件(没有 ⇒ 409 + 直达补装,不先建出来再发现发不了)。
      const res = await fetch("/api/workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 🔴 多选优先(用户 2026-09-15:要能「在主控区发布、多区执行」);没选就沿用当前视角那个区
        body: JSON.stringify({
          ...values,
          // @kf-batch 50-WP31-place-first-class —— 没多选 ⇒ 视角落点(全部 = 主控区,显式;后端缺 ⇒ 400)
          ...(createTargets.length ? { targets: createTargets } : { targetId: landingOfScope(scope) }),
        }),
      });
      const created = await res.json().catch(() => ({}));
      if (!res.ok || created?.success === false) {
        message.error(created?.error?.message || t("创建失败"));
        return;
      }
      message.success(createRegion ? t("已在 {r} 创建(调度只在这个区执行)", { r: createRegion }) : t("已创建"));
      setCreateOpen(false);
      form.resetFields();
      fetchData();
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await deleteJson(`/api/workflow/${id}`);
      message.success(t("已删除"));
      fetchData();
    } catch (e) {
      // 序 41 B-117:服务端拒绝(发布中的编排 409 等)⇒ 原话呈现、行不动
      message.error((e as Error).message || t("删除失败"));
    } finally { setBusyId(""); }
  };

  const handlePublish = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/workflow/${id}/publish`, { method: "POST" });
      const data = await res.json();
      // 🔴 那个区没装调度组件 / 只装了 serverless ⇒ 409 带机器可读码 + 直达补装链接;
      //    刻意不回落主控区发布(那就是跨区域调度)。把服务端那句话原样显示,别压成「发布失败」。
      const errMsg = data?.error?.message || data?.error;
      errMsg ? message.error(typeof errMsg === "string" ? errMsg : t("发布失败")) : message.success(t("已发布到 Airflow"));
      fetchData();
    } finally { setBusyId(""); }
  };

  // 下线:pause + 删 MWAA DAG 文件 + 状态回 draft(发布的逆操作,不再需要手动登 MWAA 删 DAG)。
  const handleUnpublish = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/workflow/${id}/unpublish`, { method: "POST" });
      const data = await res.json();
      data.error ? message.error(data.error) : message.success(t("已从 MWAA 下线(DAG 已移除)"));
      fetchData();
    } finally { setBusyId(""); }
  };

  // @kf-batch 50-WP18-workflow-fanout
  // 🔴 用户 2026-09-15:「我不是让你在美东1 发布执行多个区域吗?」—— 触发要能一次在**全部绑定区**各跑一次。
  //    与离线作业同一条交互(INTERACTION §9):绑了多区 ⇒ 先弹「这次在哪些执行范围跑?」并**由按钮复述区数**;
  //    单绑保持原样(不给多余一步)。
  const doTrigger = async (id: string, targets?: string[]) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/workflow/${id}/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targets && targets.length ? { targets } : {}),
      });
      const data = await res.json();
      if (data.error) { message.error(data.error); return; }
      const n = Array.isArray(data.runs) ? data.runs.length : 1;
      message.success(n > 1 ? t("已在 {n} 个执行范围各触发一次", { n }) : t("已触发运行"));
      fetchData();
    } finally { setBusyId(""); setRunPick(null); }
  };

  /** 与后端 `bindingTargets()` **同口径**:`targets[]` 优先,退回 `targetId`,再退回主控区。 */
  const wfBindings = (wf: any): string[] => {
    const raw = Array.isArray(wf?.targets) ? wf.targets : [];
    const list = raw.map((x: unknown) => String(x ?? "").trim()).filter((x: string) => x.length > 0);
    if (list.length === 0 && typeof wf?.targetId === "string" && wf.targetId.trim()) list.push(wf.targetId.trim());
    return list.filter((x: string, i: number) => list.indexOf(x) === i);
  };

  const handleTrigger = async (id: string) => {
    if (busyId) return;
    const wf = data.find((x: any) => x.workflowId === id);
    const bound = wfBindings(wf);
    if (bound.length > 1) { setRunPick({ id, bindings: bound }); return; }
    await doTrigger(id);
  };

  const columns = [
    { title: t("工作流名称"), dataIndex: "name", key: "name",
      render: (v: string, r: any) => <a onClick={() => router.push(`/workflow/${r.workflowId}`)} style={{ cursor: "pointer" }}><b>{v}</b></a> },
    { title: t("描述"), dataIndex: "description", key: "description", ellipsis: true },
    {
      title: t("节点"), key: "nodes",
      render: (_: any, r: Workflow) => {
        const n = r.dagDefinition?.nodes?.length || 0;
        const e = r.dagDefinition?.edges?.length || 0;
        return <Tag>{t("{n} 节点 / {e} 连线", { n, e })}</Tag>;
      },
    },
    {
      title: t("状态"), dataIndex: "status", key: "status",
      render: (v: string) => <Tag color={statusMap[v]?.color}>{statusMap[v] ? t(statusMap[v].text) : v}</Tag>,
    },
    {
      title: t("最近运行"), dataIndex: "lastRunStatus", key: "lastRunStatus",
      render: (v: string) => v ? <Tag color={runStatusMap[v]?.color}>{runStatusMap[v] ? t(runStatusMap[v].text) : v}</Tag> : <Tag>{t("未运行")}</Tag>,
    },
    { title: t("调度"), dataIndex: "cronExpression", key: "cron", render: (v: string) => v || t("未配置") },
    { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") },
    {
      title: t("操作"), key: "action",
      render: (_: any, record: Workflow) => (
        <Space>
          <a onClick={() => router.push(`/workflow/${record.workflowId}`)}>{t("编辑 DAG")}</a>
          <a onClick={() => handlePublish(record.workflowId)} style={busyId === record.workflowId ? { pointerEvents: "none", opacity: 0.5 } : {}}>{t("发布")}</a>
          <a onClick={() => handleTrigger(record.workflowId)} style={busyId === record.workflowId ? { pointerEvents: "none", opacity: 0.5 } : {}}>{t("触发")}</a>
          {record.status === "active" && (
            <Popconfirm title={t("从 MWAA 下线(pause + 删 DAG)?")} onConfirm={() => handleUnpublish(record.workflowId)}>
              <a style={{ color: "#d46b08", ...(busyId === record.workflowId ? { pointerEvents: "none", opacity: 0.5 } : {}) }}>{t("下线")}</a>
            </Popconfirm>
          )}
          <Popconfirm title={t("确认删除？")} onConfirm={() => handleDelete(record.workflowId)} okButtonProps={{ loading: busyId === record.workflowId }}>
            <a style={{ color: "red" }}>{t("删除")}</a>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>{t("ETL 编排")}</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>{t("刷新")}</Button>
          <Button type="primary" data-testid="wf-create-btn" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("新建工作流")}</Button>
        </Space>
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input placeholder={t("工作流名称")} prefix={<SearchOutlined />} value={filters.name} onChange={(e) => setFilters({ ...filters, name: e.target.value })} onPressEnter={() => fetchData()} allowClear style={{ width: 200 }} />
          <Select placeholder={t("状态")} value={filters.status || undefined} onChange={(v) => { const f = { ...filters, status: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 120 }}
            options={[{ label: t("草稿"), value: "draft" }, { label: t("已发布"), value: "active" }, { label: t("已暂停"), value: "paused" }, { label: t("异常"), value: "error" }]} />
          <Select placeholder={t("调度")} value={filters.cron || undefined} onChange={(v) => { const f = { ...filters, cron: v || "" }; setFilters(f); fetchData(f); }} allowClear style={{ width: 130 }}
            options={[{ label: t("已配置"), value: "configured" }, { label: t("未配置"), value: "none" }]} />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => fetchData()}>{t("搜索")}</Button>
          <Button onClick={() => { const f = { name: "", status: "", cron: "" }; setFilters(f); fetchData(f); }}>{t("重置")}</Button>
        </Space>
      </Card>
      {/* @kf-batch 50-WP4ter-coverage —— 护栏 2:先说清「新建 / 发布会落在哪个区」 */}
      {nonHomeView && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="workflow-nonhome-notice"
          message={
            <span>
              {t("当前只看")} <b>{viewRegion || scope.targetId}</b>
              {t(":这个区的编排由**这个区自己的调度器**执行 —— 新建的工作流盖在这个区,DAG 发到这个区的 Airflow,手动触发 / 节点状态 / 任务日志也都查这个区;跨区域调度是被禁止的。若这个区还没装调度组件,新建与发布会直接告诉你并给出补装入口(不会悄悄发到主控区)。")}
            </span>
          }
        />
      )}
      <Table
        columns={columns}
        dataSource={data}
        rowKey="workflowId"
        loading={loading}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <ScopeEmptyHint
                  resources={["workflow"]}
                  noun={t("工作流")}
                  note={t("这个区还没有工作流。新建的工作流会盖在这个区、由这个区自己的 Airflow 调度;若该区尚未安装调度组件,新建时会直接提示并给出补装入口")}
                />
              }
            />
          ),
        }}
      />
      <OtherScopesHint resources={["workflow"]} />
      <Modal title={t("新建工作流")} open={createOpen} onOk={handleCreate} confirmLoading={creating} onCancel={() => setCreateOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("名称")} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label={t("描述")}><Input.TextArea rows={2} /></Form.Item>
          {/* @kf-batch 50-WP18-workflow-fanout —— 🔴 多选执行区:一个编排可以绑多个区,
              发布时每个区各一份产物、触发时每个区各跑一次(与离线作业同一套语义)。
              🔴 必须有可见标签 + 计数标签:多选 Select 只勾一个时长得和单选一模一样(2026-09-04 用户实测反馈)。 */}
          <Form.Item label={t("执行区域(可多选)")}>
            <Space wrap>
              <Select
                mode="multiple"
                allowClear={false}
                style={{ minWidth: 320 }}
                data-testid="wf-create-targets"
                value={createTargets}
                onChange={(v: string[]) => setCreateTargets(v)}
                placeholder={t("默认 = 当前顶栏视角那个区")}
                options={execTargets.map((x) => ({
                  label: `${x.targetId}${x.region ? `(${x.region})` : ""}${x.isHome ? ` · ${t("本地")}` : ""}`,
                  value: x.targetId,
                }))}
              />
              <Button
                size="small"
                disabled={execTargets.length === 0}
                data-testid="wf-create-targets-all"
                onClick={() => setCreateTargets(execTargets.map((x) => x.targetId))}
              >
                {t("全选当前活跃区({count})", { count: execTargets.length })}
              </Button>
              {createTargets.length > 1 ? (
                <Tag color="geekblue">{t("🌐 一次发布 · {n} 个区各一份产物", { n: createTargets.length })}</Tag>
              ) : (
                <Tag>{t("📍 单区")}</Tag>
              )}
              {/* @kf-batch 50-B109-exec-target-dims —— 读失败不许静默回空(与离线作业页同一句) */}
              {execTargetsErr ? <Tag color="red" data-testid="wf-create-targets-err">{t("执行目标清单读取失败")}: {execTargetsErr}</Tag> : null}
            </Space>
          </Form.Item>
        </Form>
      </Modal>
      {/* @kf-batch 50-WP18-workflow-fanout —— 多绑工作流:触发前先问「这次在哪些执行范围跑?」 */}
      <RunTargetsModal
        open={!!runPick}
        bindings={runPick?.bindings ?? []}
        busy={!!busyId}
        verb={t("触发运行")}
        onCancel={() => setRunPick(null)}
        onRun={(picked: string[]) => { if (runPick) void doTrigger(runPick.id, picked); }}
      />
    </div>
  );
}
