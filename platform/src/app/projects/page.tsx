"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, message,
  Popconfirm, Drawer, Divider, Empty, Typography, Card, notification,
} from "antd";
// 批准「发布到环境」后给出「切到 {toEnv} 查看」(用户 2026-10-19 批准 4 次都不知道去哪看)
import { gotoEnvResource } from "@/components/common/PromoteButton";
import type { ResourceType } from "@/lib/versions/version-service";
import { PlusOutlined, AppstoreOutlined, TeamOutlined, DeleteOutlined, BellOutlined, LoadingOutlined } from "@ant-design/icons";
import { setActiveProject } from "@/lib/projects/active";
import { projectDisplayName, projectDisplayDescription } from "@/lib/projects/constants";
// 🔴 D4:按钮显隐用**后端同一个判据函数**(见 config-permissions.ts 的说明:
//    三处各写一遍布尔表达式必然出现"按钮亮着却 403"或"按钮灰了其实有权")。
import { canCreateProject, canManageProjectConfig, CONFIG_ADMIN_HINT } from "@/lib/projects/config-permissions";
import { useAuth } from "@/lib/auth/AuthProvider";
import { groupsFromToken } from "@/lib/auth/roles";
import { Tooltip } from "antd";
import { useT } from "@/lib/i18n/useT";
// 执行范围:单区视角只列**在该区获授权**的项目。
// 🔴 这一格是数据驻留的核心:「本项目在这个区能不能用」原来页面上一个字都不说。
import { useScope } from "@/components/scope/ScopeProvider";
import { Alert } from "antd";
import { toScopeParam } from "@/lib/scope/scope";

const { Text } = Typography;
const roleColor: Record<string, string> = { owner: "red", editor: "blue", viewer: "default" };
const roleOptions = [
  { label: "owner — 项目负责人（配置管理另需 admin/manager 平台角色）", value: "owner" },
  { label: "editor — 增删改资源", value: "editor" },
  { label: "viewer — 只读", value: "viewer" },
];

interface Project { projectId: string; name: string; description?: string; role: string; system?: boolean; createdAt?: string; }
interface Member { username: string; role: string; email?: string; addedAt?: string; }
interface Approval { approvalId: string; projectId: string; type: string; status: string; requestedBy: string; payload?: any; requestedAt?: string; }

export default function ProjectsPage() {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [discoverable, setDiscoverable] = useState<any[]>([]);
  const [reqRole, setReqRole] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  // members drawer state
  const [drawerProject, setDrawerProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [inbox, setInbox] = useState<Approval[]>([]); // 全局待我审批（我作为 owner 的所有项目）
  const [inboxHidden, setInboxHidden] = useState(0);
  const [myRole, setMyRole] = useState<string>("");
  const [memberForm] = Form.useForm();
  // D4:平台组(admin/manager)从 token 取;判据与后端守卫同源。
  const { getToken } = useAuth();
  const [groups, setGroups] = useState<string[]>([]);
  useEffect(() => { (async () => setGroups(groupsFromToken(await getToken())))(); }, [getToken]);
  const canCreate = canCreateProject(groups);
  const { scope, targets: scopeTargets } = useScope();
  const scopeParam = toScopeParam(scope);
  const scopeQs = scopeParam ? `?scope=${encodeURIComponent(scopeParam)}` : "";
  const viewRegion = scope.kind === "target" ? scopeTargets?.find((x) => x.targetId === scope.targetId)?.region || scope.targetId : "";

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects${scopeQs}`);
      const d = await res.json();
      setProjects(d?.success ? d.data : []);
    } finally { setLoading(false); }
  };

  // 全局审批收件箱：无过滤的 /api/approvals 返回"我能决策的项目"下所有 pending 审批
  // （含晋升 deploy / 入组 membership / 数据访问 data-access）。
  // 🔴 D4 起"能决策" = 平台 admin ∨（manager ∧ 该项目 owner）——后端 approvals/route.ts 用
  //    与本页同一个 canManageProjectConfig 判据过滤，所以纯 developer-owner 不会再看到本项目的待审。
  // 审批收件箱按执行范围筛。
  // 🔴 只筛**带区的**审批(deploy 类从被晋升作业派生);入组 / 数据访问两类不藏。
  // 🔴 被筛掉几条必须显示出来:收件箱漏一条 = 一件该批的事没人批,而界面上毫无痕迹(护栏 1)。
  const fetchInbox = async () => {
    try {
      const res = await fetch(`/api/approvals${scopeQs}`);
      const d = await res.json();
      setInbox(d?.success && Array.isArray(d.data) ? d.data : []);
      setInboxHidden(Number(d?._meta?.hiddenByScope) || 0);
    } catch { setInbox([]); setInboxHidden(0); }
  };

  const fetchDiscover = async () => {
    // 发现页(申请加入)刻意不带 scope:它的用途是「看全平台有哪些项目可申请」
    const res = await fetch("/api/projects?discover=1");
    const d = await res.json();
    // Only projects the caller is NOT a member of are "requestable".
    setDiscoverable(d?.success ? d.data.filter((p: any) => p.myRole === null) : []);
  };

  // 切区不重载页面,重拉项目(护栏 4)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchProjects(); fetchDiscover(); fetchInbox(); }, [scopeQs]);

  const handleRequest = async (projectId: string) => {
    const role = reqRole[projectId] || "editor";
    const res = await fetch("/api/approvals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, role }),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("已提交申请，等待项目 owner 审批")); fetchDiscover(); }
    else message.error(d?.error?.message || t("申请失败"));
  };

  const handleCreate = async () => {
    const values = await form.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!values) return;
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    const d = await res.json();
    if (d?.success) {
      message.success(t("项目空间已创建"));
      setCreateOpen(false); form.resetFields(); fetchProjects();
    } else {
      message.error(d?.error?.message || t("创建失败"));
    }
  };

  // 删项目空间是长操作:数仓冷恢复时服务端超 45 秒回 202(协议 long-op/1),全局 fetch 拦截器轮询到终态再交回
  //   同形响应,页面右下「正在后台执行:删除项目空间(已 n 秒)」;这里拿到的就是终态(200 / 400 列明细 / 503)。
  //   那套「202 warming + 页面按 retryAfterMs 自动重发」在这里退役。同一项目在途时忽略重复点击。
  const [deleting, setDeleting] = useState<Record<string, true>>({});
  const deletingRef = useRef<Set<string>>(new Set());
  const handleDelete = async (projectId: string) => {
    if (deletingRef.current.has(projectId)) return;
    deletingRef.current.add(projectId);
    setDeleting((prev) => ({ ...prev, [projectId]: true }));
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (body?.success) { message.success(t("已删除")); fetchProjects(); }
      else message.error(body?.error?.message || t("删除失败"));
    } finally {
      deletingRef.current.delete(projectId);
      setDeleting((prev) => { const next = { ...prev }; delete next[projectId]; return next; });
    }
  };

  const openDrawer = async (p: Project) => {
    setDrawerProject(p);
    setMembers([]); setApprovals([]); setMyRole("");
    const [detRes, apprRes] = await Promise.all([
      fetch(`/api/projects/${p.projectId}`),
      fetch(`/api/approvals?projectId=${p.projectId}&status=pending`),
    ]);
    const det = await detRes.json();
    if (det?.success) { setMembers(det.data.members || []); setMyRole(det.data.myRole || ""); }
    const appr = await apprRes.json();
    if (appr?.success) setApprovals(appr.data || []);
  };

  const refreshDrawer = () => { if (drawerProject) openDrawer(drawerProject); };

  const handleAddMember = async () => {
    if (!drawerProject) return;
    const values = await memberForm.validateFields().catch(() => null); // 校验不过时 antd 已在表单上标红,别让 rejection 冒成控制台 Uncaught Object
    if (!values) return;
    const res = await fetch(`/api/projects/${drawerProject.projectId}/members`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    const d = await res.json();
    if (d?.success) { message.success(t("成员已更新")); memberForm.resetFields(); refreshDrawer(); }
    else message.error(d?.error?.message || t("操作失败"));
  };

  const handleRemoveMember = async (username: string) => {
    if (!drawerProject) return;
    const res = await fetch(`/api/projects/${drawerProject.projectId}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
    const d = await res.json();
    d?.success ? (message.success(t("已移除")), refreshDrawer()) : message.error(d?.error?.message || t("移除失败"));
  };

  // 批准 deploy 审批后,接口已回 promote(targetId / toEnv / created / sourceVersion,见 approvals/[id] 路由),
  //   原来页面只 toast「已批准」,人不知道 prod 里已经多了一份、也不知道去哪看 ⇒ 这里给可点的「切到 {toEnv} 环境查看」。
  //   (形参 / 局部名刻意不叫 d / p:读取级门禁 page-read-coverage 按名字传播「携带范围」标记,撞名会把抽屉那次 /api/approvals 读误判成已带范围)
  const notifyPromoted = (resp: any) => {
    const promo = resp?.data?.promote;
    const pl = resp?.data?.payload || {};
    if (!promo?.toEnv || !promo?.targetId || !pl.resourceType) return false;
    const rtype = pl.resourceType as ResourceType;
    const nkey = `approve-${resp.data.approvalId || promo.targetId}`;
    notification.success({
      key: nkey,
      message: t("已批准并发布到 {toEnv}", { toEnv: promo.toEnv }),
      description: t("{name} 已{action}到 {toEnv} 环境(v{ver})。你现在看的是别的环境,切过去才能看到它。", {
        name: pl.name || pl.resourceId || "", action: promo.created ? t("新建") : t("更新"), toEnv: promo.toEnv, ver: promo.sourceVersion ?? "?",
      }),
      duration: 15,
      btn: (
        <Button data-testid="approval-goto-env" size="small" type="primary"
          onClick={() => { notification.destroy(nkey); gotoEnvResource(promo.toEnv, rtype, promo.targetId); }}>
          {t("切到 {env} 环境查看", { env: promo.toEnv })}
        </Button>
      ),
    });
    return true;
  };

  const handleDecide = async (approvalId: string, decision: "approve" | "reject") => {
    const res = await fetch(`/api/approvals/${approvalId}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
    });
    const d = await res.json();
    if (!d?.success) { message.error(d?.error?.message || t("操作失败")); return; }
    if (!(decision === "approve" && notifyPromoted(d))) message.success(decision === "approve" ? t("已批准") : t("已驳回"));
    refreshDrawer(); fetchInbox();
  };

  // 审批项的可读标签（与抽屉内一致），供全局收件箱复用。
  const approvalLabel = (a: Approval) =>
    // 删除执行环境的审批单(只有平台管理员看得到;服务端按类型过滤)
    a.type === "exec-env-delete"
      ? t("删除执行环境 {tid}({region})", { tid: String(a.payload?.targetId ?? ""), region: String(a.payload?.region ?? "") })
      : a.type === "deploy"
      ? t("晋升 {name} → {toEnv}", { name: a.payload?.name || a.payload?.resourceType || "", toEnv: a.payload?.toEnv })
      : a.type === "data-access"
      ? t("申请访问数据表 {table}", { table: String(a.payload?.fqn || "").split(".").pop() || a.payload?.fqn })
      // prod 环境的数据目录建表 / 改表审批(payload 由 lib/governance/catalog-ddl.ts 定形)
      : a.type === "ddl"
      ? ddlApprovalText(a)
      : t("申请加入项目（角色 {role}）", { role: a.payload?.role });
  const ddlApprovalText = (a: Approval) => {
    const pl = a.payload || {};
    const spec = pl.action === "create" ? pl.spec || {} : pl;
    const fq = `${spec.schema || ""}.${spec.table || ""}`;
    return pl.action === "create"
      ? t("建表 {fq}({kind},{env} 环境)", { fq, kind: spec.kind === "s3tables" ? "S3 Tables" : "Redshift", env: pl.env || "prod" })
      : t("改表 {fq}({n} 条语句,{env} 环境)", { fq, n: Array.isArray(pl.statements) ? pl.statements.length : "?", env: pl.env || "prod" });
  };

  const columns = [
    { title: t("项目空间"), dataIndex: "name", render: (v: string, r: Project) => (
      <Space><AppstoreOutlined /><b>{projectDisplayName(v, r.projectId, t)}</b>{r.system && <Tag>{t("默认")}</Tag>}</Space>
    )},
    { title: t("我的角色"), dataIndex: "role", render: (v: string) => <Tag color={roleColor[v] || "default"}>{v}</Tag> },
    { title: t("描述"), dataIndex: "description", ellipsis: true, render: (v: string, r: any) => <Text type="secondary">{projectDisplayDescription(v, r.projectId, t) || "—"}</Text> },
    { title: t("创建时间"), dataIndex: "createdAt", render: (v: string) => v?.slice(0, 19).replace("T", " ") || "—" },
    { title: t("操作"), key: "action", render: (_: any, r: Project) => (
      <Space>
        <a onClick={() => { setActiveProject(r.projectId); message.success(t("已切换到「{name}」", { name: projectDisplayName(r.name, r.projectId, t) })); setTimeout(() => window.location.reload(), 400); }}>{t("切换到此")}</a>
        <a onClick={() => openDrawer(r)}><TeamOutlined /> {t("成员/审批")}</a>
        {!r.system && r.role === "owner" && (
          canManageProjectConfig(groups, r.role) ? deleting[r.projectId] ? (
            // 在途时把「删除」换成进度文字,点不到第二次(等待进度由全局提示「正在后台执行:删除项目空间」承担)
            <Text type="secondary" data-testid="project-delete-progress">
              <LoadingOutlined /> {t("删除中…")}
            </Text>
          ) : (
            // 🔴 文案订正:删除有前置校验(资源/成员/数据面表全为 0 才可删),不再是"资源不删除"。
            <Popconfirm
              title={t("删除该项目空间？需先清空其资源与成员——平台不做级联删除，若仍有内容会返回明细并拒绝。")}
              onConfirm={() => handleDelete(r.projectId)}
            >
              <a style={{ color: "red" }}><DeleteOutlined /> {t("删除")}</a>
            </Popconfirm>
          ) : (
            <Tooltip title={t(CONFIG_ADMIN_HINT)}>
              <span style={{ color: "#5b6b7a", cursor: "not-allowed" }}><DeleteOutlined /> {t("删除")}</span>
            </Tooltip>
          )
        )}
      </Space>
    )},
  ];

  // D4:成员增删改 / 审批决策 = 平台 admin ∨(manager ∧ 本项目 owner)。
  const canManage = canManageProjectConfig(groups, myRole as any);
  // 我是本项目 owner 却没有平台组 ⇒ 交互 §1.2 要求把"权没了"讲成"分工",而不是让入口凭空消失。
  const ownerWithoutConfigRight = myRole === "owner" && !canManage;

  return (
    <div>
      {/* 单区视角下必须说清「这里只列在该区获授权的项目」,
          否则用户会以为项目丢了(护栏 1:不让用户丢东西,先把话说明白) */}
      {scope.kind === "target" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="projects-scope-notice"
          message={`${"当前只列在 "}${viewRegion}${" 获授权的项目(执行环境的项目白名单)。想看全部项目请把执行范围切到「全部」。"}`}
        />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}><AppstoreOutlined /> {t("项目空间")}</h2>
        {canCreate ? (
          <Button type="primary" data-testid="proj-create-btn" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t("新建项目空间")}</Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t("项目空间由管理员 / 研发经理创建，如需新空间请联系他们")}
          </Text>
        )}
      </div>
      <Text type="secondary">
        {t("每个项目空间是独立的工作区：数据源 / 同步任务 / 编排 / Redshift 任务 / 作业等资源按空间隔离，按项目角色（owner > editor > viewer）授权。顶部可切换当前空间。")}
      </Text>

      {/* 🔴 被执行范围筛掉的待办必须显示出来。
          收件箱少一条 = 一件该批的事没人批,而界面上毫无痕迹 —— 那正是护栏 1 要挡的「丢东西」。 */}
      {inboxHidden > 0 && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }} data-testid="approval-hidden-by-scope"
          message={t("当前执行范围隐藏了 {n} 条待审(它们作用在别的区);切到「全部」可看到全部待办", { n: inboxHidden })}
        />
      )}
      {inbox.length > 0 && (
        <Card
          style={{ marginTop: 16, borderColor: "#e0a23c" }}
          title={<span><BellOutlined style={{ color: "#e0a23c" }} /> {t("待我审批（{n}）", { n: inbox.length })}</span>}
          styles={{ header: { minHeight: 40 } }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>{t("你可决策的项目下的待处理审批：晋升发布 / 加入项目 / 数据访问 / 删除执行环境(仅平台管理员)。")}</Text>
          <div style={{ marginTop: 8 }}>
            {inbox.map((a) => {
              const proj = projects.find((p) => p.projectId === a.projectId);
              // 🔴 审批接收端**回放影响预览快照**(INTERACTION §1.4 机制 C;52 §5bis):
              //   销毁哪个区 / 三个数 / 将保留哪些数据资源 / 谁发起 —— 看不到这些的审批就是橡皮图章。
              const snap = a.type === "exec-env-delete" ? (a.payload?.snapshot as { counts?: Record<string, number | null>; retained?: Array<{ kind: string; name: string; note: string }>; computedAt?: string } | undefined) : undefined;
              return (
                <div key={a.approvalId} style={{ padding: "10px 4px", borderBottom: "1px solid #163243" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Tag color={a.type === "exec-env-delete" ? "red" : a.type === "deploy" ? "purple" : a.type === "data-access" ? "volcano" : a.type === "ddl" ? "cyan" : "blue"}>{a.type === "exec-env-delete" ? t("删除执行环境") : a.type === "deploy" ? t("晋升") : a.type === "data-access" ? t("数据访问") : a.type === "ddl" ? t("建表 / 改表") : t("入组")}</Tag>
                  <span style={{ flex: 1 }}>{approvalLabel(a)}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>{a.requestedBy} · {proj ? projectDisplayName(proj.name, proj.projectId, t) : a.projectId}</Text>
                  <Space>
                    <a data-testid={`approval-approve-${a.approvalId}`} onClick={async () => { await fetch(`/api/approvals/${a.approvalId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) }).then((r) => r.json()).then((d) => !d?.success ? message.error(d?.error?.message || t("失败")) : d?.data?.destroy && d.data.destroy.started === false ? message.warning(t("审批已通过,但销毁没能启动:{e}", { e: String(d.data.destroy.error ?? "") })) : notifyPromoted(d) ? undefined : message.success(t("已批准并执行"))); fetchInbox(); }}>{t("批准")}</a>
                    <a style={{ color: "red" }} onClick={async () => { await fetch(`/api/approvals/${a.approvalId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject" }) }).then((r) => r.json()); fetchInbox(); }}>{t("驳回")}</a>
                  </Space>
                </div>
                {snap && (
                  <div data-testid="approval-exec-env-delete-snapshot" style={{ marginTop: 6, paddingLeft: 8, fontSize: 12 }}>
                    <Text style={{ fontSize: 12 }}>
                      {t("影响预览快照({at}):绑定资源 {b} · 启用调度 {s} · 运行中 run {r}", {
                        at: String(snap.computedAt ?? "").slice(0, 19).replace("T", " "),
                        b: String(snap.counts?.bindings ?? "?"),
                        s: String(snap.counts?.schedules ?? "?"),
                        r: String(snap.counts?.runningRuns ?? "?"),
                      })}
                    </Text>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t("将保留(不删):")}</Text>
                      {(snap.retained ?? []).map((x) => (
                        <Tag key={`${x.kind}:${x.name}`} style={{ fontSize: 11 }}>{`${x.kind}:${x.name}`}</Tag>
                      ))}
                    </div>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t("批准后服务端会重算一次影响预览:与申请时那一份不同就拒绝批准(需驳回后重新申请)。")}</Text>
                  </div>
                )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Table style={{ marginTop: 16 }} columns={columns} dataSource={projects} rowKey="projectId" loading={loading} />

      {discoverable.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3>{t("可申请加入的其他空间")}</h3>
          <Text type="secondary">{t("你不是这些空间的成员；提交申请后由平台管理员或该空间的研发经理 owner 审批，批准后即获得对应角色。")}</Text>
          <Table
            style={{ marginTop: 12 }}
            size="small"
            pagination={false}
            rowKey="projectId"
            dataSource={discoverable}
            columns={[
              { title: t("项目空间"), dataIndex: "name", render: (v: string, r: any) => <Space><AppstoreOutlined /><b>{projectDisplayName(v, r.projectId, t)}</b>{r.system && <Tag>{t("默认")}</Tag>}</Space> },
              { title: t("描述"), dataIndex: "description", ellipsis: true, render: (v: string, r: any) => <Text type="secondary">{projectDisplayDescription(v, r.projectId, t) || "—"}</Text> },
              { title: t("申请"), key: "req", width: 260, render: (_: any, r: any) => (
                r.pending ? <Tag color="orange">{t("审批中")}</Tag> : (
                  <Space>
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={reqRole[r.projectId] || "editor"}
                      onChange={(v) => setReqRole((m) => ({ ...m, [r.projectId]: v }))}
                      options={[{ label: "editor", value: "editor" }, { label: "viewer", value: "viewer" }]}
                    />
                    <Popconfirm title={t("提交加入申请？")} onConfirm={() => handleRequest(r.projectId)}>
                      <Button size="small" type="primary">{t("申请加入")}</Button>
                    </Popconfirm>
                  </Space>
                )
              )},
            ]}
          />
        </div>
      )}

      <Modal title={t("新建项目空间")} open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)} okText={t("创建")}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t("名称")} rules={[{ required: true, message: t("请输入项目名称") }]}><Input placeholder={t("如：风控数据域")} /></Form.Item>
          <Form.Item name="description" label={t("描述")}><Input.TextArea rows={3} /></Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={drawerProject ? t("成员与审批 · {name}", { name: drawerProject.name }) : ""}
        width={560}
        open={!!drawerProject}
        onClose={() => setDrawerProject(null)}
      >
        {ownerWithoutConfigRight && (
          <div style={{ marginBottom: 12, padding: "8px 12px", border: "1px solid #e0a23c", borderRadius: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t("你是本项目 owner（开发权限）。成员管理 / 改名 / 删除需平台管理员或研发经理 —— 你仍可正常开发本项目的同步 / 作业 / 工作流等资源。")}
            </Text>
          </div>
        )}
        <Divider>{t("成员")}</Divider>
        <Table
          size="small"
          pagination={false}
          dataSource={members}
          rowKey="username"
          columns={[
            { title: t("用户名"), dataIndex: "username" },
            { title: t("角色"), dataIndex: "role", render: (v: string) => <Tag color={roleColor[v] || "default"}>{v}</Tag> },
            ...(canManage ? [{
              title: t("操作"), key: "act", render: (_: any, m: Member) => (
                <Popconfirm title={t("移除该成员？")} onConfirm={() => handleRemoveMember(m.username)}>
                  <a style={{ color: "red" }}>{t("移除")}</a>
                </Popconfirm>
              ),
            }] : []),
          ]}
        />
        {canManage && (
          <Form form={memberForm} layout="inline" style={{ marginTop: 12 }} onFinish={handleAddMember}>
            <Form.Item name="username" rules={[{ required: true, message: t("用户名") }]}>
              <Input placeholder={t("Cognito 用户名")} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="role" initialValue="editor" rules={[{ required: true }]}>
              <Select style={{ width: 130 }} options={roleOptions.map((o) => ({ label: o.value, value: o.value }))} />
            </Form.Item>
            <Form.Item><Button type="primary" htmlType="submit">{t("添加/更新")}</Button></Form.Item>
          </Form>
        )}

        <Divider style={{ marginTop: 24 }}>{t("待审批（访问/角色申请）")}</Divider>
        {approvals.length === 0 ? (
          <Empty description={t("暂无待审批")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small"
            pagination={false}
            dataSource={approvals}
            rowKey="approvalId"
            columns={[
              { title: t("申请人"), dataIndex: "requestedBy" },
              { title: t("申请"), key: "p", render: (_: any, a: Approval) => (
                a.type === "deploy"
                  ? <Tag color="purple">{t("晋升 {name} → {toEnv}", { name: a.payload?.name || a.payload?.resourceType || "", toEnv: a.payload?.toEnv })}</Tag>
                  : a.type === "data-access"
                  ? <Tag color="volcano">{t("申请访问数据表 {table}", { table: String(a.payload?.fqn || "").split(".").pop() || a.payload?.fqn })}</Tag>
                  : a.type === "ddl"
                  ? <Tag color="cyan">{ddlApprovalText(a)}</Tag>
                  : <Tag>{`${a.type}:${a.payload?.role}`}</Tag>
              )},
              ...(canManage ? [{
                title: t("操作"), key: "act", render: (_: any, a: Approval) => (
                  <Space>
                    <a onClick={() => handleDecide(a.approvalId, "approve")}>{t("批准")}</a>
                    <a style={{ color: "red" }} onClick={() => handleDecide(a.approvalId, "reject")}>{t("驳回")}</a>
                  </Space>
                ),
              }] : []),
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}
