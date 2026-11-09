"use client";
// 数据湖表桶路由(设计稿 §6.9)—— 系统设置「数据湖表桶与路由」卡(原「数据湖外部表桶」卡长成路由表)。
//   表格:表桶 / 别名 / 分层 / 命名空间归属 / 可写 / 备注 / 登记人;第一行是该区的隐式平台路由(别名固定 s3tablescatalog,不可改不可撤销)。
//   登记表单:表桶下拉(TableBucketPicker)/ 别名(按桶名预填,可改)/ 分层 / 可写 / 命名空间归属 / 备注;行操作「编辑」「撤销」。
//   服务端拒因(409 别名冲突 / 命名空间冲突 / 仍被引用,400 文法)原话展示,不改写。
//   🔴 首帧只用 props 与空态渲染;路由表在 useEffect 里拉(渲染期不读浏览器状态)。所有读请求 URL 带 targetId=(执行范围判据)。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useT } from "@/lib/i18n/useT";
import { deleteJson } from "@/lib/http/delete-json";
import TableBucketPicker from "@/components/lake/TableBucketPicker";
import { LAKE_TIERS, LAKE_TIER_LABELS_ZH, aliasFromBucket, aliasProblem, type LakeTier } from "@/lib/lake/routes-grammar";

/** 与 GET /api/lake-routes(只读路径;写仍走 /api/admin/lake-routes)的应答同形(bucketArn 不下发)。 */
export interface LakeRouteView {
  bucket: string;
  alias: string;
  tier: LakeTier;
  writable: boolean;
  platform: boolean;
  catalogRef: string;
  namespaces?: string[];
  label?: string;
  addedBy?: string;
  addedAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface LakeRoutesCardProps {
  /** 当前执行范围落到的执行环境(路由表按它取;空串 = 还不知道,不拉) */
  targetId: string;
  displayName?: string;
  region?: string;
  isPlatformAdmin: boolean;
  /** 卡片 id(系统设置页用它做锚点 `/settings#lake-ext-buckets`) */
  id?: string;
}

type LoadState = { status: "idle" | "loading" | "ok" | "error"; routes: LakeRouteView[]; error?: string };

function errorMessageOf(d: unknown, status: number): string {
  const o = d as { error?: { message?: string } | string } | null;
  const err = o?.error;
  if (typeof err === "string") return err;
  return err?.message || `HTTP ${status}`;
}

export default function LakeRoutesCard(props: LakeRoutesCardProps) {
  const t = useT();
  const { targetId, displayName, region, isPlatformAdmin } = props;
  const [state, setState] = useState<LoadState>({ status: "idle", routes: [] });
  const [busy, setBusy] = useState(false);
  // 登记表单
  const [bucket, setBucket] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasTouched, setAliasTouched] = useState(false);
  const [tier, setTier] = useState<LakeTier>("other");
  const [writable, setWritable] = useState(true);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  // 编辑弹窗
  const [editing, setEditing] = useState<LakeRouteView | null>(null);
  const [edit, setEdit] = useState<{ alias: string; tier: LakeTier; writable: boolean; namespaces: string[]; label: string }>({ alias: "", tier: "other", writable: true, namespaces: [], label: "" });

  const load = useCallback(async () => {
    if (!targetId) { setState({ status: "idle", routes: [] }); return; }
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const res = await fetch(`/api/lake-routes?targetId=${encodeURIComponent(targetId)}`);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { setState({ status: "error", routes: [], error: errorMessageOf(d, res.status) }); return; }
      setState({ status: "ok", routes: (d.data?.routes ?? []) as LakeRouteView[] });
    } catch (e) {
      setState({ status: "error", routes: [], error: String((e as Error)?.message || e) });
    }
  }, [targetId]);

  useEffect(() => { void load(); }, [load]);

  const taken = useMemo(() => new Set(state.routes.map((r) => r.alias)), [state.routes]);
  // 别名按桶名预填(用户没手改时跟着桶走;与服务端派生规则同一个纯函数)
  useEffect(() => {
    if (!aliasTouched) setAlias(bucket ? aliasFromBucket(bucket, taken) : "");
  }, [bucket, taken, aliasTouched]);

  const resetForm = () => { setBucket(""); setAlias(""); setAliasTouched(false); setTier("other"); setWritable(true); setNamespaces([]); setLabel(""); };

  const register = async () => {
    const b = bucket.trim();
    if (!b) { message.warning(t("请选择或输入表桶名")); return; }
    const problem = aliasProblem(alias);
    if (problem) { message.warning(problem); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/lake-routes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, bucket: b, alias: alias.trim(), tier, writable, namespaces: namespaces.length ? namespaces : undefined, label: label.trim() || undefined }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d?.success) { message.error(errorMessageOf(d, res.status)); return; }
      message.success(t("已登记路由 {b}(别名 {a}):作业可用 {a}.<命名空间>.<表> 访问它,直查 / 治理目录 / 问数都会看到它", { b, a: alias.trim() }));
      resetForm();
      await load();
    } finally { setBusy(false); }
  };

  const revoke = async (r: LakeRouteView) => {
    setBusy(true);
    try {
      // 页面「删除」读响应的唯一作者(409 仍被引用 / 400 平台路由的服务端原话要给用户看;成功才提示)
      await deleteJson(`/api/admin/lake-routes?targetId=${encodeURIComponent(targetId)}&bucket=${encodeURIComponent(r.bucket)}`);
      message.success(t("已撤销路由(表桶与里面的表一个不动)"));
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally { setBusy(false); }
  };

  const openEdit = (r: LakeRouteView) => {
    setEditing(r);
    setEdit({ alias: r.alias, tier: r.tier, writable: r.writable, namespaces: r.namespaces ?? [], label: r.label ?? "" });
  };

  const saveEdit = async (confirmAliasChange = false) => {
    if (!editing) return;
    const problem = aliasProblem(edit.alias);
    if (problem) { message.warning(problem); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/lake-routes", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, bucket: editing.bucket, alias: edit.alias.trim(), tier: edit.tier, writable: edit.writable, namespaces: edit.namespaces, label: edit.label.trim(), confirmAliasChange }),
      });
      const d = await res.json().catch(() => null);
      if (res.status === 409 && d?.error?.code === "DECISION_REQUIRED") {
        Modal.confirm({
          title: t("改别名会影响引用旧别名的脚本,确认修改?"),
          content: <div data-testid="lake-route-alias-change-confirm">{d.error.message}</div>,
          okText: t("确认修改"), cancelText: t("取消"),
          onOk: () => saveEdit(true),
        });
        return;
      }
      if (!res.ok || !d?.success) { message.error(errorMessageOf(d, res.status)); return; }
      message.success(t("已更新路由 {b}", { b: editing.bucket }));
      setEditing(null);
      await load();
    } finally { setBusy(false); }
  };

  const tierOptions = LAKE_TIERS.map((x) => ({ value: x, label: `${x}(${t(LAKE_TIER_LABELS_ZH[x])})` }));

  const columns: ColumnsType<LakeRouteView> = [
    { title: t("表桶"), dataIndex: "bucket", render: (v: string, r) => <span><code data-testid="lake-route-bucket-name">{v}</code>{r.platform && <Tag color="blue" style={{ marginLeft: 8 }}>{t("该区平台表桶")}</Tag>}</span> },
    { title: t("别名"), dataIndex: "alias", render: (v: string) => <code data-testid="lake-route-alias">{v}</code> },
    { title: t("分层"), dataIndex: "tier", render: (v: LakeTier) => <span data-testid="lake-route-tier">{v}</span> },
    { title: t("命名空间归属"), dataIndex: "namespaces", render: (v?: string[]) => (v && v.length ? v.map((n) => <Tag key={n}>{n}</Tag>) : <Typography.Text type="secondary">{t("按实际存在解析")}</Typography.Text>) },
    { title: t("可写"), dataIndex: "writable", render: (v: boolean) => <Tag data-testid="lake-route-writable" color={v ? "green" : "default"}>{v ? t("可写") : t("只读")}</Tag> },
    { title: t("备注"), dataIndex: "label", render: (v?: string) => v || "—" },
    { title: t("登记人 / 时间"), key: "who", render: (_: unknown, r) => (r.platform ? t("部署期建") : `${r.addedBy ?? ""} · ${String(r.addedAt ?? "").slice(0, 19).replace("T", " ")}`) },
    ...(isPlatformAdmin ? [{
      title: t("操作"), key: "op", width: 170,
      render: (_: unknown, r: LakeRouteView) => r.platform ? <Typography.Text type="secondary">{t("隐式缺省路由")}</Typography.Text> : (
        <Space>
          <Button size="small" onClick={() => openEdit(r)} data-testid="lake-route-edit">{t("编辑")}</Button>
          <Popconfirm title={t("撤销路由?表桶与里面的表不会被动,只是平台不再注入 / 列出它")} onConfirm={() => revoke(r)}>
            <Button size="small" danger loading={busy} data-testid="lake-route-revoke">{t("撤销")}</Button>
          </Popconfirm>
        </Space>
      ),
    }] : []),
  ];

  const platformBucket = state.routes.find((r) => r.platform)?.bucket || "—";

  return (
    <div id={props.id} data-testid="settings-lake-ext-buckets">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <Typography.Text strong>{`${t("数据湖表桶与路由")} · ${displayName || targetId}${region ? ` (${region})` : ""}`}</Typography.Text>
        <Space>
          <Tag color="purple">{t("登记 = 路由:作业按别名注入目录、同步可写入、直查 / 治理目录 / 问数可见")}</Tag>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={state.status === "loading"} data-testid="lake-route-reload">{t("刷新")}</Button>
        </Space>
      </div>
      <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>
        {t("该区的平台表桶 {b} 是隐式缺省路由(别名固定 s3tablescatalog);客户自己的表桶登记为路由后,作业脚本用 <别名>.<命名空间>.<表> 三段名读写它,无需手写 Spark 配置;同步任务只能把可写路由选为 Table Bucket;同一命名空间出现在两条路由里时要声明归属。", { b: platformBucket })}
      </div>
      {state.status === "error" && <Typography.Text type="danger" data-testid="lake-route-error">{t("路由表读取失败:{msg}", { msg: state.error || "" })}</Typography.Text>}
      <div data-testid="lake-ext-bucket-table">
        <Table<LakeRouteView> size="small" pagination={false} rowKey="bucket" dataSource={state.routes} data-testid="lake-route-table"
          loading={state.status === "loading"}
          locale={{ emptyText: targetId ? t("这个执行环境还没有路由") : t("先在顶栏选中一个执行环境") }}
          onRow={(r) => ({ "data-testid": "lake-route-row", "data-bucket": r.bucket, "data-alias": r.alias, "data-platform": r.platform ? "1" : "0" } as React.HTMLAttributes<HTMLElement>)}
          columns={columns} />
      </div>
      {isPlatformAdmin ? (
        <Space style={{ marginTop: 12 }} wrap align="start">
          <TableBucketPicker targetId={targetId} value={bucket} onChange={(v) => { setBucket(v || ""); }} excludePlatform excludeRegistered reloadToken={state.routes.length}
            placeholder={t("表桶名,如 demo-agg-bucket")} style={{ width: 260 }} data-testid="lake-route-bucket" />
          <Input value={alias} onChange={(e) => { setAlias(e.target.value); setAliasTouched(true); }} placeholder={t("别名(Spark 目录名,按桶名预填)")} style={{ width: 200 }} data-testid="lake-route-alias-input" />
          <Select<LakeTier> value={tier} onChange={setTier} options={tierOptions} style={{ width: 170 }} data-testid="lake-route-tier-select" />
          <span><Switch checked={writable} onChange={setWritable} data-testid="lake-route-writable-switch" /> <Typography.Text type="secondary">{t("可写")}</Typography.Text></span>
          <Select<string[]> mode="tags" value={namespaces} onChange={(v) => setNamespaces(v.map((x) => String(x).trim()).filter(Boolean))} placeholder={t("命名空间归属(可选,回车添加)")} style={{ width: 240 }} tokenSeparators={[",", " "]} open={false} data-testid="lake-route-namespaces-input" />
          <Input placeholder={t("备注(可选)")} value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 180 }} data-testid="lake-route-label" />
          <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={register} data-testid="lake-route-add">{t("登记到 {t}", { t: displayName || targetId })}</Button>
        </Space>
      ) : (
        <div style={{ color: "#999", fontSize: 12, marginTop: 8 }}>{t("登记 / 修改 / 撤销需要平台管理员(bgp-admin)")}</div>
      )}
      <Modal open={!!editing} title={editing ? t("编辑路由 {b}", { b: editing.bucket }) : ""} onCancel={() => setEditing(null)} onOk={() => saveEdit(false)} okText={t("保存")} cancelText={t("取消")} confirmLoading={busy} destroyOnHidden>
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <div><Typography.Text type="secondary">{t("别名(改了要同步改脚本里的三段名)")}</Typography.Text><Input value={edit.alias} onChange={(e) => setEdit({ ...edit, alias: e.target.value })} data-testid="lake-route-edit-alias" /></div>
          <div><Typography.Text type="secondary">{t("分层")}</Typography.Text><Select<LakeTier> value={edit.tier} onChange={(v) => setEdit({ ...edit, tier: v })} options={tierOptions} style={{ width: "100%" }} data-testid="lake-route-edit-tier" /></div>
          <div><Switch checked={edit.writable} onChange={(v) => setEdit({ ...edit, writable: v })} data-testid="lake-route-edit-writable" /> <Typography.Text type="secondary">{t("可写(关掉后同步 / 建表 / 作业写声明都不能用它)")}</Typography.Text></div>
          <div><Typography.Text type="secondary">{t("命名空间归属(可选,回车添加)")}</Typography.Text><Select<string[]> mode="tags" value={edit.namespaces} onChange={(v) => setEdit({ ...edit, namespaces: v.map((x) => String(x).trim()).filter(Boolean) })} style={{ width: "100%" }} tokenSeparators={[",", " "]} open={false} data-testid="lake-route-edit-namespaces" /></div>
          <div><Typography.Text type="secondary">{t("备注(可选)")}</Typography.Text><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} data-testid="lake-route-edit-label" /></div>
        </Space>
      </Modal>
    </div>
  );
}
