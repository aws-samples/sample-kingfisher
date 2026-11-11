"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card, Tabs, Table, Tag, Drawer, Button, Space, Modal, Form, Select, Input,
  Timeline, message, Empty, Spin, Typography, Tooltip,
} from "antd";
import {
  SolutionOutlined, UserSwitchOutlined, RobotOutlined, BuildOutlined,
  ClockCircleOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/useT";
import { PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP } from "@/lib/auth/groups";
import { useScope } from "@/components/scope/ScopeProvider";
import { landingOfScope } from "@/lib/scope/scope";
// 慢模型下服务端 45s 转 202,aiFetchJson 自动轮询到终态;网关 504 的 HTML 也包成可读错误
import { aiFetchJson } from "@/lib/ai/client/ai-fetch";

const { Text, Paragraph } = Typography;

const STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "default" },
  submitted: { label: "待受理", color: "blue" },
  assigned: { label: "已指派", color: "cyan" },
  in_development: { label: "研发中", color: "geekblue" },
  in_review: { label: "待验收", color: "gold" },
  delivered: { label: "已交付", color: "green" },
  rejected: { label: "已驳回", color: "red" },
  cancelled: { label: "已取消", color: "default" },
};
const PRIORITY: Record<string, { color: string }> = {
  P0: { color: "red" }, P1: { color: "volcano" }, P2: { color: "blue" }, P3: { color: "default" },
};
const ACTION_LABEL: Record<string, string> = {
  submit: "提交", assign: "指派", reject: "驳回", reopen: "重新打开",
  start: "开始研发", submit_delivery: "提交交付", request_changes: "打回修改",
  approve: "验收通过", cancel: "取消", comment: "评论", generate: "生成实现", "create-job": "创建作业",
};
const NOTE_ACTIONS = new Set(["reject", "request_changes", "cancel", "reopen"]);

function decodeToken(t?: string | null): { sub?: string; username?: string; groups: string[] } {
  if (!t) return { groups: [] };
  try {
    const p = JSON.parse(atob(t.split(".")[1] || ""));
    return { sub: p.sub, username: p["cognito:username"] || p.username, groups: p["cognito:groups"] || [] };
  } catch {
    return { groups: [] };
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return "-";
  return iso.slice(0, 19).replace("T", " ");
}

export default function RequirementsPage() {
  const { getToken, user, loading: authLoading } = useAuth();
  const router = useRouter();
  const t = useT();
  // 生成实现 / 创建作业的落点唯一作者(单区视角 = 该区;「全部 / 对比」= 显式主控区)。
  //   原来两样都不带 ⇒ 生成按主控区目录、作业建在主控区,与用户正在看的区无关。
  const { scope } = useScope();
  const reqLanding = landingOfScope(scope);
  const [me, setMe] = useState<{ sub?: string; username?: string; groups: string[] }>({ groups: [] });
  const isManager = me.groups.includes(PLATFORM_ADMIN_GROUP) || me.groups.includes(MANAGER_GROUP);
  const isDeveloper = me.groups.includes(PLATFORM_ADMIN_GROUP) || me.groups.includes(DEVELOPER_GROUP);

  const [box, setBox] = useState<string>("mine");
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [genTarget, setGenTarget] = useState<"redshift" | "glue">("redshift");

  // 指派 modal
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignees, setAssignees] = useState<any[]>([]);
  const [assignForm] = Form.useForm();

  // 动作（带备注）modal
  const [actionModal, setActionModal] = useState<{ action: string } | null>(null);
  const [actionNote, setActionNote] = useState("");

  const load = useCallback(async (b: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/requirements?box=${b}`);
      const d = await res.json();
      setList(d?.success && Array.isArray(d.data) ? d.data : []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) return; // 未登录由全局 layout 守卫处理,此处不硬跳避免清空 MultiTabs 页签
    (async () => {
      const tok = await getToken();
      const decoded = decodeToken(tok);
      setMe(decoded);
      const initial = (decoded.groups.includes(PLATFORM_ADMIN_GROUP) || decoded.groups.includes(MANAGER_GROUP))
        ? "inbox"
        : (decoded.groups.includes(DEVELOPER_GROUP) ? "assigned" : "mine");
      setBox(initial);
      load(initial);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetail({ requirementId: id });
    try {
      const res = await fetch(`/api/requirements/${id}`);
      const d = await res.json();
      if (d?.success) setDetail(d.data);
      else { message.error(d?.error?.message || t("加载失败")); setDetail(null); }
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshAll = () => { load(box); if (detail?.requirementId) openDetail(detail.requirementId); };

  const tabs = useMemo(() => {
    const tabItems = [{ key: "mine", label: t("我提出的") }];
    if (isDeveloper) tabItems.unshift({ key: "assigned", label: t("指派给我") });
    if (isManager) { tabItems.push({ key: "inbox", label: t("待受理 / 待验收") }); tabItems.push({ key: "all", label: t("全部") }); }
    return tabItems;
  }, [isManager, isDeveloper, t]);

  // ── 动作 ──
  const doTransition = async (action: string, note?: string) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/requirements/${detail.requirementId}/transition`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      const d = await res.json();
      if (!d?.success) message.error(d?.error?.message || t("操作失败"));
      else { message.success(t("{name} 成功", { name: t(ACTION_LABEL[action] || action) })); refreshAll(); }
    } finally { setBusy(false); }
  };

  const openAssign = async () => {
    setAssignOpen(true);
    assignForm.resetFields();
    try {
      const res = await fetch("/api/requirements/assignees");
      const d = await res.json();
      setAssignees(d?.success ? d.data : []);
    } catch { setAssignees([]); }
  };

  const submitAssign = async () => {
    let v: any;
    try { v = await assignForm.validateFields(); } catch { return; }
    const picked = assignees.find((a) => a.username === v.assigneeName);
    setBusy(true);
    try {
      const res = await fetch(`/api/requirements/${detail.requirementId}/assign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeName: v.assigneeName, assigneeSub: picked?.sub, priority: v.priority, dueDate: v.dueDate }),
      });
      const d = await res.json();
      if (!d?.success) message.error(d?.error?.message || t("指派失败"));
      else { message.success(t("指派成功")); setAssignOpen(false); refreshAll(); }
    } finally { setBusy(false); }
  };

  const doGenerate = async () => {
    if (!detail) return;
    setBusy(true);
    message.loading({ content: t("大模型生成实现中…"), key: "gen", duration: 0 });
    try {
      const d = await aiFetchJson(`/api/requirements/${detail.requirementId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType: genTarget, targetId: reqLanding }),
      });
      message.destroy("gen");
      if (!d?.success) message.error(d?.error?.message || t("生成失败"));
      else { message.success(t("已生成实现，请审阅后再创建作业")); refreshAll(); }
    } catch (e: any) { message.destroy("gen"); message.error(e?.message || t("网络异常")); }
    finally { setBusy(false); }
  };

  const doCreateJob = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/requirements/${detail.requirementId}/create-job`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targets: [reqLanding] }),
      });
      const d = await res.json();
      if (!d?.success) message.error(d?.error?.message || t("创建作业失败"));
      else { message.success(t("已创建 ETL 作业（草稿），可在作业开发中运行/调度")); refreshAll(); }
    } finally { setBusy(false); }
  };

  const submitComment = async () => {
    const text = comment.trim();
    if (!text || !detail) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/requirements/${detail.requirementId}/comment`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      const d = await res.json();
      if (!d?.success) message.error(d?.error?.message || t("评论失败"));
      else { setComment(""); refreshAll(); }
    } finally { setBusy(false); }
  };

  const columns = [
    { title: t("标题"), dataIndex: "title", key: "title", render: (v: string, r: any) => <a onClick={() => openDetail(r.requirementId)}>{v}</a> },
    { title: t("优先级"), dataIndex: "priority", key: "priority", width: 90, render: (p: string) => <Tag color={PRIORITY[p]?.color}>{p}</Tag> },
    { title: t("状态"), dataIndex: "status", key: "status", width: 110, render: (s: string) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.label ? t(STATUS[s].label) : s}</Tag> },
    { title: t("提出人"), dataIndex: "requesterName", key: "requesterName", width: 120 },
    { title: t("指派给"), dataIndex: "assigneeName", key: "assigneeName", width: 120, render: (a: string) => a || <Text type="secondary">—</Text> },
    { title: t("更新时间"), dataIndex: "updatedAt", key: "updatedAt", width: 170, render: (v: string) => <Text type="secondary">{fmtTime(v)}</Text> },
  ];

  const actions: string[] = detail?._actions || [];
  // 与后端 isAssignee 一致：优先按 sub 匹配，sub 缺失时按用户名兜底（assigneeName 来自项目成员名单，可信）。
  const amAssignee =
    !!detail &&
    (((!!me.sub && detail.assigneeSub === me.sub)) ||
      (!!me.username && detail.assigneeName === me.username));
  const canDev = amAssignee && (detail?.status === "assigned" || detail?.status === "in_development");
  const impl = detail?.implementation;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}><SolutionOutlined /> {t("需求工作台")}</h2>
        <Button icon={<ReloadOutlined />} onClick={() => load(box)}>{t("刷新")}</Button>
      </div>
      <div style={{ color: "#8fb0c2", marginBottom: 16, fontSize: 13 }}>
        {t("从智能问数沉淀的业务需求，经理受理指派、研发借助大模型落地实现并创建作业。技术实现与资源创建收口研发部门。")}
      </div>

      <Card>
        <div data-testid="req-tabs"><Tabs activeKey={box} onChange={(k) => { setBox(k); load(k); }} items={tabs} /></div>
        <Table
          rowKey="requirementId"
          loading={loading}
          dataSource={list}
          columns={columns as any}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("暂无需求")} /> }}
        />
      </Card>

      <Drawer
        title={detail?.title || t("需求详情")}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={680}
        extra={detail?.status && <Tag color={STATUS[detail.status]?.color}>{STATUS[detail.status]?.label && t(STATUS[detail.status].label)}</Tag>}
      >
        {detailLoading ? (
          <div style={{ textAlign: "center", padding: 60 }}><Spin /></div>
        ) : detail && detail.title ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            {/* 操作区 */}
            <Card size="small" title={t("操作")}>
              <Space wrap>
                {actions.filter((a) => a !== "assign" && a !== "comment").map((a) => (
                  <Button
                    key={a}
                    danger={a === "reject" || a === "cancel"}
                    type={a === "approve" || a === "start" ? "primary" : "default"}
                    loading={busy}
                    onClick={() => (NOTE_ACTIONS.has(a) ? (setActionModal({ action: a }), setActionNote("")) : doTransition(a))}
                  >
                    {t(ACTION_LABEL[a] || a)}
                  </Button>
                ))}
                {actions.includes("assign") && (
                  <Button icon={<UserSwitchOutlined />} type="primary" onClick={openAssign}>{t("指派研发")}</Button>
                )}
                {canDev && (
                  <Tooltip title={t("用大模型生成生产级实现（不自动执行，审阅后再建作业）")}>
                    <Space.Compact>
                      <Select value={genTarget} onChange={(v) => setGenTarget(v)} style={{ width: 130 }}
                        options={[{ value: "redshift", label: "Redshift SQL" }, { value: "glue", label: "Glue PySpark" }]} />
                      <Button icon={<RobotOutlined />} loading={busy} onClick={doGenerate}>{t("大模型生成实现")}</Button>
                    </Space.Compact>
                  </Tooltip>
                )}
                {canDev && impl?.generatedCode && !impl?.etlJobId && (
                  <Button icon={<BuildOutlined />} loading={busy} onClick={doCreateJob}>{t("创建 ETL 作业")}</Button>
                )}
              </Space>
              {actions.length === 0 && !canDev && <Text type="secondary">{t("当前无可执行操作")}</Text>}
            </Card>

            {/* 基本信息 */}
            <Card size="small" title={t("基本信息")}>
              <p><Tag color={PRIORITY[detail.priority]?.color}>{detail.priority}</Tag> {t("提出人：")}{detail.requesterName}　{t("指派给：")}{detail.assigneeName || "—"}</p>
              {detail.description && <Paragraph style={{ whiteSpace: "pre-wrap" }}>{detail.description}</Paragraph>}
              {detail.businessValue && <p><Text type="secondary">{t("业务价值：")}</Text>{detail.businessValue}</p>}
              {detail.acceptanceCriteria && <p><Text type="secondary">{t("验收标准：")}</Text>{detail.acceptanceCriteria}</p>}
            </Card>

            {/* 来源洞察 */}
            {detail.source && (
              <Card size="small" title={t("来源洞察（智能问数）")}>
                <p><Text type="secondary">{t("问题：")}</Text>{detail.source.question}</p>
                {detail.source.sql && (
                  <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 160 }}>
                    <code style={{ fontSize: 12 }}>{detail.source.sql}</code>
                  </pre>
                )}
              </Card>
            )}

            {/* 研发实现 */}
            {impl?.generatedCode && (
              <Card size="small" title={t("研发实现（{engine}）", { engine: impl.targetType === "glue" ? "Glue PySpark" : "Redshift SQL" })}
                extra={impl.etlJobId && <a onClick={() => router.push("/etl-jobs")}>{t("已建作业 →")}</a>}>
                {impl.explanation && <Paragraph type="secondary" style={{ whiteSpace: "pre-wrap" }}>{impl.explanation}</Paragraph>}
                <pre style={{ background: "#08131b", color: "#c9d6e5", border: "1px solid #1d4254", padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 280 }}>
                  <code style={{ fontSize: 12 }}>{impl.generatedCode}</code>
                </pre>
              </Card>
            )}

            {/* 活动时间线 */}
            <Card size="small" title={t("活动时间线")}>
              <Timeline
                items={(detail.activity || []).slice().reverse().map((a: any) => ({
                  color: a.action === "comment" ? "blue" : a.toStatus === "delivered" ? "green" : a.toStatus === "rejected" ? "red" : "cyan",
                  children: (
                    <div>
                      <Text strong>{a.actor}</Text> <Text type="secondary">{t(ACTION_LABEL[a.action] || a.action)}</Text>
                      {a.fromStatus && a.toStatus && <Text type="secondary"> · {STATUS[a.fromStatus]?.label && t(STATUS[a.fromStatus].label)} → {STATUS[a.toStatus]?.label && t(STATUS[a.toStatus].label)}</Text>}
                      <div style={{ fontSize: 12, color: "#8fb0c2" }}><ClockCircleOutlined /> {fmtTime(a.ts)}</div>
                      {a.note && <div style={{ marginTop: 2 }}>{a.note}</div>}
                    </div>
                  ),
                }))}
              />
              <Space.Compact style={{ width: "100%", marginTop: 8 }}>
                <Input placeholder={t("添加评论…")} value={comment} onChange={(e) => setComment(e.target.value)} onPressEnter={submitComment} />
                <Button onClick={submitComment} loading={busy}>{t("评论")}</Button>
              </Space.Compact>
            </Card>
          </Space>
        ) : (
          <Empty description={t("加载失败")} />
        )}
      </Drawer>

      {/* 指派 modal */}
      <Modal title={t("指派研发")} open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={submitAssign} confirmLoading={busy} okText={t("确认指派")}>
        <Form form={assignForm} layout="vertical">
          <Form.Item name="assigneeName" label={t("指派给（项目研发成员）")} rules={[{ required: true, message: t("请选择研发") }]}>
            <Select
              placeholder={t("选择研发负责人")}
              options={assignees.map((a) => ({ value: a.username, label: `${a.username}（${a.role}）` }))}
              notFoundContent={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("该项目暂无可指派成员")} />}
            />
          </Form.Item>
          <Form.Item name="priority" label={t("优先级")} initialValue={detail?.priority || "P2"}>
            <Select options={["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }))} />
          </Form.Item>
          <Form.Item name="dueDate" label={t("期望交付日期（可选）")}>
            <Input type="date" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 带备注的动作 modal */}
      <Modal
        title={actionModal ? t(ACTION_LABEL[actionModal.action]) : ""}
        open={!!actionModal}
        onCancel={() => setActionModal(null)}
        onOk={() => { const a = actionModal!.action; setActionModal(null); doTransition(a, actionNote); }}
        confirmLoading={busy}
        okText={t("确认")}
      >
        <Input.TextArea rows={3} placeholder={t("备注 / 原因（可选）")} value={actionNote} onChange={(e) => setActionNote(e.target.value)} />
      </Modal>
    </div>
  );
}
