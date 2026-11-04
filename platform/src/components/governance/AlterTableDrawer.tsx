"use client";

// 数据目录行操作「修改表结构」(Redshift 表)。
// 真实列来自 GET /api/governance/tables/columns?targetId=&schema=&table=(svv_columns);「预览变更」= POST /api/governance/tables/alter dryRun
// (计划 / 语句 / 拒绝项都是服务端算的,界面不自己猜);「执行」= 同路由不带 dryRun(prod 环境 ⇒ 202 审批单)。
// 删列不可逆 ⇒ 重档确认:输入物理表名才放行(PRINCIPLES §D-裁决)。
import React, { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Drawer, Input, InputNumber, Modal, Select, Space, Tag, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined, UndoOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { DDL_TYPE_CHOICES, needsLength, needsPrecision } from "@/lib/modeling/ddl-type-choices";
import { getActiveEnv } from "@/lib/projects/active";
import { isProtectedEnv } from "@/lib/projects/constants";
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

export interface AlterTarget {
  targetId: string;
  schema: string;
  table: string;
  fqn: string;
}

interface EditCol {
  key: string;
  name: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment: string;
  defaultValue: string;
  /** 现有列(名字 / 可空 / 主键不可改;类型只允许加宽 VARCHAR) */
  existing: boolean;
  /** 现有列被标记删除 */
  drop: boolean;
}

interface Planning {
  adoptable: boolean;
  reason?: string;
  plan: { addColumns: Array<{ name: string }>; dropColumns: string[]; commentChanges: Array<{ column: string }>; widenVarchar: Array<{ column: string; from: number; to: number }> };
  rejected: Array<{ column: string; reason: string }>;
  statements: string[];
}

export interface AlterTableDrawerProps {
  open: boolean;
  target: AlterTarget | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function AlterTableDrawer({ open, target, onClose, onChanged }: AlterTableDrawerProps) {
  const t = useT();
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [meta, setMeta] = useState<{ exists: boolean; adoptable: boolean; reason?: string; modelTableId: string | null; origin: string | null; database: string } | null>(null);
  const [cols, setCols] = useState<EditCol[]>([]);
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [planErr, setPlanErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [result, setResult] = useState<{ ok: boolean; pending?: boolean; approvalId?: string; text: string } | null>(null);
  // 环境标识来自 localStorage,首帧按 dev(= 服务端)渲染,挂载后再读,避免 React 19 水合不一致
  const [env] = useBrowserInitialState<string>("dev", () => getActiveEnv());
  const protectedEnv = isProtectedEnv(env);

  useEffect(() => {
    if (!open || !target) return;
    let alive = true;
    setLoading(true); setLoadErr(""); setMeta(null); setCols([]); setPlanning(null); setPlanErr(""); setResult(null); setConfirmName("");
    fetch(`/api/governance/tables/columns?targetId=${encodeURIComponent(target.targetId)}&schema=${encodeURIComponent(target.schema)}&table=${encodeURIComponent(target.table)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok || !d?.success) { setLoadErr(d?.error?.message || `HTTP ${r.status}`); return; }
        const m = d.data;
        setMeta({ exists: !!m.exists, adoptable: !!m.adoptable, reason: m.reason, modelTableId: m.modelTableId ?? null, origin: m.origin ?? null, database: m.database || "" });
        setCols((m.columns || []).map((c: any, i: number): EditCol => ({
          key: `e${i}`, name: String(c.name), dataType: String(c.dataType || "").toUpperCase(), length: c.length ?? undefined, precision: c.precision ?? undefined, scale: c.scale ?? undefined,
          nullable: c.nullable !== false, isPrimaryKey: !!c.isPrimaryKey, comment: String(c.comment || ""), defaultValue: "", existing: true, drop: false,
        })));
      })
      .catch((e) => { if (alive) setLoadErr(String(e?.message || e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, target]);

  const setCol = (key: string, patch: Partial<EditCol>) => { setCols((xs) => xs.map((c) => (c.key === key ? { ...c, ...patch } : c))); setPlanning(null); setResult(null); };
  const addCol = () => { setCols((xs) => [...xs, { key: `n${Date.now()}`, name: "", dataType: "VARCHAR", length: 256, nullable: true, isPrimaryKey: false, comment: "", defaultValue: "", existing: false, drop: false }]); setPlanning(null); };
  const removeNew = (key: string) => { setCols((xs) => xs.filter((c) => c.key !== key)); setPlanning(null); };

  const desired = () => cols.filter((c) => !c.drop).map((c) => ({
    name: c.name.trim(), dataType: c.dataType, nullable: c.nullable, isPrimaryKey: c.isPrimaryKey,
    ...(needsLength(c.dataType) && c.length ? { length: c.length } : {}),
    ...(needsPrecision(c.dataType) ? { precision: c.precision ?? 18, scale: c.scale ?? 2 } : {}),
    ...(c.comment.trim() ? { comment: c.comment.trim() } : {}),
    ...(!c.existing && c.defaultValue.trim() ? { defaultValue: c.defaultValue.trim() } : {}),
  }));

  const post = async (extra: Record<string, unknown>) => {
    if (!target) throw new Error("no target");
    return fetchWithResidencyAck(
      "/api/governance/tables/alter",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId: target.targetId, schema: target.schema, table: target.table, desired: desired(), ...extra }) },
      resolveAckRequired
    );
  };

  const doPreview = async () => {
    setBusy(true); setPlanErr(""); setPlanning(null); setResult(null);
    try {
      const { res: r, body: d, cancelled } = await post({ dryRun: true });
      if (cancelled) return;
      if (!r.ok || !d?.success) { setPlanErr(d?.error?.message || `HTTP ${r.status}`); return; }
      setPlanning(d.data as Planning);
    } catch (e: any) {
      setPlanErr(String(e?.message || e));
    } finally { setBusy(false); }
  };

  const execute = async (name?: string) => {
    setBusy(true); setResult(null);
    try {
      const { res: r, body: d, cancelled } = await post(name ? { confirmName: name } : {});
      if (cancelled) return;
      if (!r.ok || !d?.success) { setResult({ ok: false, text: d?.error?.message || `HTTP ${r.status}` }); return; }
      if (r.status === 202 && d.data?.pending) {
        setResult({ ok: true, pending: true, approvalId: d.data.approvalId, text: t("已提交改表审批({env} 环境需审批):项目空间 owner 批准后才会执行", { env: d.data.env || env }) });
        return;
      }
      setResult({ ok: true, text: t("已执行 {n} 条语句;该执行区观测态:{state}", { n: (d.data?.statements || []).length, state: d.data?.landed?.status || "-" }) });
      message.success(t("表结构已修改"));
      onChanged();
    } catch (e: any) {
      setResult({ ok: false, text: String(e?.message || e) });
    } finally { setBusy(false); setConfirmOpen(false); }
  };

  const onExec = () => {
    if (planning?.plan.dropColumns.length) { setConfirmName(""); setConfirmOpen(true); return; }
    void execute();
  };

  const canExec = !!planning && planning.adoptable && planning.rejected.length === 0 && planning.statements.length > 0 && !result?.ok;

  return (
    <Drawer open={open} onClose={onClose} width={760} data-testid="alter-table-drawer" destroyOnClose
      title={<Space>{t("修改表结构")}<code>{target ? `${target.schema}.${target.table}` : ""}</code><Tag color={protectedEnv ? "red" : env === "staging" ? "gold" : "green"} data-testid="at-env">{env}</Tag></Space>}
      extra={<Space>
        <Button data-testid="at-preview" loading={busy} disabled={!meta?.adoptable || cols.some((c) => !c.drop && !c.name.trim())} onClick={doPreview}>{t("预览变更")}</Button>
        <Button data-testid="at-exec" type="primary" danger={protectedEnv || !!planning?.plan.dropColumns.length} loading={busy} disabled={!canExec} onClick={onExec}>{protectedEnv ? t("提交审批") : t("执行")}</Button>
      </Space>}>
      {residencyModal}
      {loading && <Alert type="info" showIcon message={t("正在读取该执行区上的真实列…")} />}
      {loadErr && <Alert type="error" showIcon data-testid="at-load-error" message={loadErr} />}
      {meta && !meta.exists && <Alert type="error" showIcon data-testid="at-not-exists" message={t("该执行区上不存在这张表")} />}
      {meta && meta.exists && !meta.adoptable && (
        <Alert type="warning" showIcon data-testid="at-not-adoptable" style={{ marginBottom: 12 }}
          message={t("这张表不能图形化改表")} description={meta.reason} />
      )}
      {meta && meta.exists && (
        <div style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 8 }} data-testid="at-meta">
          {t("执行区")}: <code>{target?.targetId}</code> · {t("库")}: <code>{meta.database}</code> · {meta.modelTableId
            ? t("建模台账已有定义({origin})", { origin: meta.origin || "modeling" })
            : t("建模台账里没有这张表:执行时会按真实列认领(origin = catalog-adopted),之后可在建模页看到它")}
        </div>
      )}
      {protectedEnv && <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="at-prod-hint"
        message={t("当前是 {env} 环境:改表不会立刻执行,会生成审批单", { env })} />}

      {cols.map((c) => (
        <Space key={c.key} data-testid="at-col-row" data-existing={c.existing ? "1" : "0"} data-drop={c.drop ? "1" : "0"} style={{ display: "flex", marginBottom: 8, opacity: c.drop ? 0.5 : 1 }} wrap>
          <Input data-testid="at-col-name" placeholder={t("列名")} style={{ width: 150, textDecoration: c.drop ? "line-through" : undefined }} value={c.name} disabled={c.existing} onChange={(e) => setCol(c.key, { name: e.target.value })} />
          <Select data-testid="at-col-type" style={{ width: 170 }} value={c.dataType} disabled={c.drop || (c.existing && !needsLength(c.dataType))} onChange={(v) => setCol(c.key, { dataType: v })} options={DDL_TYPE_CHOICES.map((x) => ({ label: x, value: x }))} />
          {needsLength(c.dataType) && <InputNumber data-testid="at-col-length" placeholder={t("长度")} style={{ width: 90 }} min={1} value={c.length} disabled={c.drop} onChange={(v) => setCol(c.key, { length: v ?? undefined })} />}
          {needsPrecision(c.dataType) && <>
            <InputNumber data-testid="at-col-precision" style={{ width: 80 }} min={1} max={38} value={c.precision ?? 18} disabled={c.drop || c.existing} onChange={(v) => setCol(c.key, { precision: v ?? undefined })} />
            <InputNumber data-testid="at-col-scale" style={{ width: 80 }} min={0} value={c.scale ?? 2} disabled={c.drop || c.existing} onChange={(v) => setCol(c.key, { scale: v ?? undefined })} />
          </>}
          <Checkbox data-testid="at-col-nullable" checked={c.nullable} disabled={c.existing || c.drop} onChange={(e) => setCol(c.key, { nullable: e.target.checked })}>{t("可空")}</Checkbox>
          {!c.existing && !c.nullable && <Input data-testid="at-col-default" placeholder={t("默认值(NOT NULL 必填)")} style={{ width: 160 }} value={c.defaultValue} onChange={(e) => setCol(c.key, { defaultValue: e.target.value })} />}
          <Input data-testid="at-col-comment" placeholder={t("注释")} style={{ width: 180 }} value={c.comment} disabled={c.drop} onChange={(e) => setCol(c.key, { comment: e.target.value })} />
          {c.existing
            ? <Button data-testid="at-col-drop" size="small" danger={!c.drop} icon={c.drop ? <UndoOutlined /> : <DeleteOutlined />} onClick={() => setCol(c.key, { drop: !c.drop })}>{c.drop ? t("撤销删除") : t("删列")}</Button>
            : <Button data-testid="at-col-remove" size="small" icon={<DeleteOutlined />} onClick={() => removeNew(c.key)} />}
        </Space>
      ))}
      {meta?.exists && meta.adoptable && <Button data-testid="at-col-add" size="small" icon={<PlusOutlined />} onClick={addCol}>{t("添加列")}</Button>}

      {planErr && <Alert type="error" showIcon style={{ marginTop: 12 }} data-testid="at-plan-error" message={planErr} />}
      {planning && (
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>{t("变更计划")}</Typography.Text>
          <div data-testid="at-plan" data-add={planning.plan.addColumns.length} data-drop={planning.plan.dropColumns.length} data-comment={planning.plan.commentChanges.length} data-widen={planning.plan.widenVarchar.length} style={{ fontSize: 12, marginTop: 4 }}>
            <Tag color="green">{t("加列")} {planning.plan.addColumns.length}</Tag>
            <Tag color="red">{t("删列")} {planning.plan.dropColumns.length}</Tag>
            <Tag>{t("注释")} {planning.plan.commentChanges.length}</Tag>
            <Tag color="blue">{t("加宽")} {planning.plan.widenVarchar.length}</Tag>
          </div>
          {planning.rejected.length > 0 && (
            <Alert type="error" showIcon style={{ marginTop: 8 }} data-testid="at-rejected" message={t("有 {n} 项变更 Redshift 做不到(整单不执行)", { n: planning.rejected.length })}
              description={<ul style={{ margin: "4px 0 0 16px", padding: 0 }}>{planning.rejected.map((r, i) => <li key={i}><code>{r.column}</code>:{r.reason}</li>)}</ul>} />
          )}
          {planning.plan.dropColumns.length > 0 && planning.rejected.length === 0 && (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} data-testid="at-drop-warning" message={t("将删除列 {cols}:不可逆,执行前要输入表名确认", { cols: planning.plan.dropColumns.join(", ") })} />
          )}
          <pre data-testid="at-ddl" style={{ background: "#1e1e1e", color: "#d4d4d4", padding: 12, borderRadius: 6, marginTop: 8, maxHeight: 260, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {planning.statements.length ? planning.statements.join(";\n") + ";" : t("(没有任何变更)")}
          </pre>
        </div>
      )}
      {result && (
        <Alert style={{ marginTop: 12 }} type={result.ok ? (result.pending ? "warning" : "success") : "error"} showIcon data-testid={result.pending ? "at-pending" : "at-result"} message={result.text}
          action={result.pending ? <Button size="small" href="/projects" data-testid="at-goto-approvals">{t("去项目空间审批")}</Button> : undefined} />
      )}

      <Modal open={confirmOpen} onCancel={() => setConfirmOpen(false)} title={t("删除列不可逆")} data-testid="at-confirm"
        okText={t("确认执行")} okButtonProps={{ danger: true, disabled: confirmName.trim() !== (target?.table || ""), "data-testid": "at-confirm-ok" } as any}
        onOk={() => execute(confirmName.trim())} confirmLoading={busy}>
        <p>{t("将删除列 {cols} 及其数据,无法恢复。请输入物理表名「{table}」确认:", { cols: planning?.plan.dropColumns.join(", ") || "", table: target?.table || "" })}</p>
        <Input data-testid="at-confirm-input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={target?.table || ""} />
      </Modal>
    </Drawer>
  );
}
