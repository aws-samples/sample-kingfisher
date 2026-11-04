"use client";

// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录「新建表」向导(客户 2026-10-19 反馈 c:全平台无图形化建表)。
// 三步:① 落点与名称(Redshift schema / S3 Tables 命名空间 + 执行区 + 表名)② 列定义 ③ DDL 预览 → 执行。
// 服务端:POST /api/governance/tables/preview(纯预览)/ POST /api/governance/tables(执行;prod 环境回 202 审批单)。
// 跨法域执行区首次操作 ⇒ 服务端 409 ⇒ 免责告知 ⇒ 自动重试(与建模页落地同一个 `fetchWithResidencyAck`)。
import React, { useEffect, useMemo, useState } from "react";
import { Alert, AutoComplete, Button, Checkbox, Input, InputNumber, Modal, Radio, Select, Space, Steps, Tag, Typography, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useT } from "@/lib/i18n/useT";
import { fetchExecTargets, type ExecTargetOption } from "@/lib/exec-env/exec-targets-client";
import { DDL_TYPE_CHOICES, ICEBERG_UNSUPPORTED_TYPES, needsLength, needsPrecision } from "@/lib/modeling/ddl-type-choices";
import { getActiveEnv } from "@/lib/projects/active";
import { isProtectedEnv } from "@/lib/projects/constants";
import { useResidencyAck } from "@/components/residency/useResidencyAck";
import { fetchWithResidencyAck } from "@/lib/residency/client";
import { useBrowserInitialState } from "@/lib/hydration/use-browser-initial-state";

export interface WizardColumn {
  name: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

export interface CreateTableWizardProps {
  open: boolean;
  onClose: () => void;
  /** 建成(或审批单已提交)后回调;created=false 表示进了审批 */
  onDone: (info: { created: boolean; kind: "redshift" | "s3tables"; schema: string; table: string; approvalId?: string }) => void;
  defaultTargetId?: string;
}

const newColumn = (): WizardColumn => ({ name: "", dataType: "VARCHAR", length: 256, nullable: true, isPrimaryKey: false });

export default function CreateTableWizard({ open, onClose, onDone, defaultTargetId }: CreateTableWizardProps) {
  const t = useT();
  const { residencyModal, resolveAckRequired } = useResidencyAck();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<"redshift" | "s3tables">("redshift");
  const [targets, setTargets] = useState<ExecTargetOption[]>([]);
  const [targetsErr, setTargetsErr] = useState("");
  const [targetId, setTargetId] = useState(defaultTargetId || "");
  const [schema, setSchema] = useState("");
  // 序 49 ⑦ UX ③:该执行区已有的 schema(Redshift)/ 命名空间(S3 Tables)清单 —— 下拉可选,也可输新名(用户 10-20 拍板)
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [table, setTable] = useState("");
  const [comment, setComment] = useState("");
  const [columns, setColumns] = useState<WizardColumn[]>([newColumn()]);
  const [preview, setPreview] = useState<{ statements?: string[]; icebergSchema?: { fields: Array<{ name: string; type: string; required?: boolean }> } } | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; pending?: boolean; approvalId?: string; text: string } | null>(null);
  // B-138:环境标识来自 localStorage,首帧按 dev(= 服务端)渲染,挂载后再读,避免 React 19 水合不一致
  const [env] = useBrowserInitialState<string>("dev", () => getActiveEnv());
  const protectedEnv = isProtectedEnv(env);

  useEffect(() => {
    if (!open) return;
    setStep(0); setPreview(null); setPreviewErr(""); setResult(null);
    setSchema(""); setTable(""); setComment(""); setColumns([newColumn()]);
    setTargetId(defaultTargetId || "");
  }, [open, defaultTargetId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTargetsErr("");
    // Redshift 建表要装了数仓的区;S3 Tables 表桶属 core(每个区都有)
    fetchExecTargets(kind === "redshift" ? "redshift" : "core")
      .then((list) => { if (!alive) return; setTargets(list); if (!targetId && list.length === 1) setTargetId(list[0].targetId); })
      .catch((e) => { if (alive) setTargetsErr(String(e?.message || e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  // 序 49 ⑦ UX ③:选定执行区后读它已有的 schema / 命名空间(带 targetId 的读取;读失败只影响候选清单,照样可以手输)。
  //   Redshift 走 /api/redshift/schemas?mode=schemas(只列 schema 名,含空 schema);S3 Tables 走 /api/athena/tables 的 namespaces。
  //   项目私有 schema(proj_*,lib/exec-env/project-schema.ts 的合同形态)不是建表落点,从候选里剔掉(服务端校验仍是权威)。
  useEffect(() => {
    if (!open || !targetId) { setSchemaOptions([]); return; }
    let alive = true;
    setSchemaLoading(true);
    const url = kind === "redshift"
      ? `/api/redshift/schemas?targetId=${encodeURIComponent(targetId)}&mode=schemas`
      : `/api/athena/tables?targetId=${encodeURIComponent(targetId)}`;
    fetch(url)
      .then((r) => r.json())
      .then((body) => {
        if (!alive) return;
        const names: string[] = kind === "redshift"
          ? (Array.isArray(body?.schemas) ? body.schemas.map((x: { name?: string }) => String(x?.name || "")) : [])
          : (Array.isArray(body?.namespaces) ? body.namespaces.map((x: { namespace?: string }) => String(x?.namespace || "")) : []);
        setSchemaOptions(Array.from(new Set(names.filter((n) => n && !n.startsWith("proj_")))).sort());
      })
      .catch(() => { if (alive) setSchemaOptions([]); })
      .finally(() => { if (alive) setSchemaLoading(false); });
    return () => { alive = false; };
  }, [open, kind, targetId]);

  const typeChoices = useMemo(() => DDL_TYPE_CHOICES.filter((x) => kind === "redshift" || !ICEBERG_UNSUPPORTED_TYPES.includes(x)), [kind]);

  const setCol = (i: number, patch: Partial<WizardColumn>) => setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const spec = () => ({
    kind, targetId, schema: schema.trim(), table: table.trim(), comment: comment.trim() || undefined,
    columns: columns.map((c) => ({
      name: c.name.trim(), dataType: c.dataType, nullable: c.nullable, isPrimaryKey: kind === "redshift" ? c.isPrimaryKey : false,
      ...(needsLength(c.dataType) && c.length ? { length: c.length } : {}),
      ...(needsPrecision(c.dataType) ? { precision: c.precision ?? 18, scale: c.scale ?? 2 } : {}),
      ...(c.comment?.trim() ? { comment: c.comment.trim() } : {}),
    })),
  });

  const step1Ok = !!targetId && !!schema.trim() && !!table.trim();
  const step2Ok = columns.length > 0 && columns.every((c) => c.name.trim());

  const doPreview = async () => {
    setBusy(true); setPreviewErr(""); setPreview(null);
    try {
      const r = await fetch("/api/governance/tables/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec()) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.success) { setPreviewErr(d?.error?.message || `HTTP ${r.status}`); return; }
      setPreview({ statements: d.data?.statements, icebergSchema: d.data?.icebergSchema });
      setStep(2);
    } catch (e: any) {
      setPreviewErr(String(e?.message || e));
    } finally { setBusy(false); }
  };

  const doCreate = async () => {
    setBusy(true); setResult(null);
    try {
      const { res: r, body: d, cancelled } = await fetchWithResidencyAck(
        "/api/governance/tables",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec()) },
        resolveAckRequired
      );
      if (cancelled) return;
      if (!r.ok || !d?.success) { setResult({ ok: false, text: d?.error?.message || `HTTP ${r.status}` }); return; }
      if (r.status === 202 && d.data?.pending) {
        setResult({ ok: true, pending: true, approvalId: d.data.approvalId, text: t("已提交建表审批({env} 环境需审批):项目空间 owner 在「待我审批」批准后才会真的建表", { env: d.data.env || env }) });
        onDone({ created: false, kind, schema: schema.trim(), table: table.trim(), approvalId: d.data.approvalId });
        return;
      }
      const fqnText = kind === "redshift" ? `${d.data?.database || ""}.${schema.trim()}.${table.trim()}` : `${d.data?.bucket || ""}.${schema.trim()}.${table.trim()}`;
      setResult({ ok: true, text: t("已建表:{fqn}(执行区 {target});目录已刷新", { fqn: fqnText, target: targetId }) });
      message.success(t("建表成功"));
      onDone({ created: true, kind, schema: schema.trim(), table: table.trim() });
    } catch (e: any) {
      setResult({ ok: false, text: String(e?.message || e) });
    } finally { setBusy(false); }
  };

  const footer = (
    <Space>
      <Button onClick={onClose} data-testid="ct-cancel">{result?.ok ? t("关闭") : t("取消")}</Button>
      {step > 0 && !result?.ok && <Button data-testid="ct-prev" onClick={() => setStep(step - 1)}>{t("上一步")}</Button>}
      {step === 0 && <Button type="primary" data-testid="ct-next" disabled={!step1Ok} onClick={() => setStep(1)}>{t("下一步")}</Button>}
      {step === 1 && <Button type="primary" data-testid="ct-preview" disabled={!step2Ok} loading={busy} onClick={doPreview}>{t("预览 DDL")}</Button>}
      {step === 2 && !result?.ok && <Button type="primary" danger={protectedEnv} data-testid="ct-exec" loading={busy} onClick={doCreate}>{protectedEnv ? t("提交审批") : t("执行建表")}</Button>}
    </Space>
  );

  return (
    <Modal open={open} onCancel={onClose} width={860} footer={footer} destroyOnClose data-testid="create-table-wizard"
      title={<Space>{t("新建表")}<Tag color={protectedEnv ? "red" : env === "staging" ? "gold" : "green"} data-testid="ct-env">{env}</Tag></Space>}>
      {residencyModal}
      <Steps size="small" current={step} style={{ marginBottom: 16 }}
        items={[{ title: t("落点与名称") }, { title: t("列定义") }, { title: t("预览与执行") }]} />
      {protectedEnv && <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="ct-prod-hint"
        message={t("当前是 {env} 环境:建表不会立刻执行,会生成审批单,项目空间 owner 批准后才执行", { env })} />}

      {step === 0 && (
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div>
            <Typography.Text strong>{t("表类型")}</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <Radio.Group data-testid="ct-kind" value={kind} onChange={(e) => { setKind(e.target.value); setTargetId(""); }}
                options={[{ label: t("Redshift 数仓表"), value: "redshift" }, { label: t("S3 Tables 数据湖表(Iceberg)"), value: "s3tables" }]} optionType="button" />
            </div>
          </div>
          <div>
            <Typography.Text strong>{t("执行区")}</Typography.Text>
            <Select data-testid="ct-target" style={{ width: "100%", marginTop: 6 }} value={targetId || undefined} onChange={setTargetId} placeholder={t("选择执行区")}
              options={targets.map((x) => ({ value: x.targetId, label: `${x.displayName || x.targetId}（${x.region}${x.isHome ? " · " + t("主控区") : ""}）`, disabled: x.serviceable === false }))} />
            {targetsErr && <Alert type="error" showIcon style={{ marginTop: 6 }} message={targetsErr} />}
          </div>
          <Space style={{ width: "100%" }} align="start">
            <div style={{ width: 300 }}>
              <Typography.Text strong>{kind === "redshift" ? t("目标 schema") : t("命名空间")}</Typography.Text>
              {/* 序 49 ⑦ UX ③:下拉列出该区已有的 schema / 命名空间,也可直接输入新名(AutoComplete;testid 仍在内层 input 上) */}
              <AutoComplete style={{ width: "100%", marginTop: 6 }} value={schema} onChange={(v) => setSchema(String(v ?? ""))}
                options={schemaOptions.filter((n) => !schema || n.toLowerCase().includes(schema.toLowerCase())).map((n) => ({ value: n, label: n }))}
                popupMatchSelectWidth>
                <Input data-testid="ct-schema" disabled={!targetId}
                  placeholder={!targetId ? t("先选择执行区") : kind === "redshift" ? t("选已有 schema 或输入新名,如 dwd;不能是项目私有 schema(proj_*)") : t("选已有命名空间或输入新名(小写字母 / 数字 / 下划线)")} />
              </AutoComplete>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="ct-schema-hint" data-count={schemaOptions.length}>
                {!targetId ? "" : kind === "redshift"
                  ? (schemaLoading ? t("正在读取该区已有的 schema…") : schemaOptions.length ? t("该区已有 {n} 个 schema 可直接选,也可输入新名称", { n: schemaOptions.length }) : t("该区还没有可选的 schema,输入新名称即可"))
                  : (schemaLoading ? t("正在读取该区已有的命名空间…") : schemaOptions.length ? t("该区已有 {n} 个命名空间可直接选,也可输入新名称", { n: schemaOptions.length }) : t("该区还没有可选的命名空间,输入新名称即可"))}
              </Typography.Text>
            </div>
            <div style={{ width: 300 }}>
              <Typography.Text strong>{t("表名")}</Typography.Text>
              <Input data-testid="ct-table" style={{ marginTop: 6 }} value={table} onChange={(e) => setTable(e.target.value)} placeholder={t("标识符:字母 / 数字 / 下划线")} />
            </div>
          </Space>
          <div>
            <Typography.Text strong>{t("表注释(可选)")}</Typography.Text>
            <Input data-testid="ct-comment" style={{ marginTop: 6 }} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </Space>
      )}

      {step === 1 && (
        <div>
          <div style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 8 }}>
            {kind === "redshift" ? t("类型来自平台 DDL 白名单;主键为声明性(Redshift 不强制)") : t("类型按 Iceberg 映射(VARCHAR/CHAR → string,INTEGER → int,BIGINT → long,DECIMAL(p,s) → decimal …);SUPER 不可用")}
          </div>
          {columns.map((c, i) => (
            <Space key={i} data-testid="ct-col-row" style={{ display: "flex", marginBottom: 8 }} wrap>
              <Input data-testid="ct-col-name" placeholder={t("列名")} style={{ width: 160 }} value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} />
              <Select data-testid="ct-col-type" style={{ width: 170 }} value={c.dataType} onChange={(v) => setCol(i, { dataType: v })} options={typeChoices.map((x) => ({ label: x, value: x }))} />
              {needsLength(c.dataType) && <InputNumber data-testid="ct-col-length" placeholder={t("长度")} style={{ width: 90 }} min={1} value={c.length} onChange={(v) => setCol(i, { length: v ?? undefined })} />}
              {needsPrecision(c.dataType) && <>
                <InputNumber data-testid="ct-col-precision" placeholder={t("精度")} style={{ width: 80 }} min={1} max={38} value={c.precision ?? 18} onChange={(v) => setCol(i, { precision: v ?? undefined })} />
                <InputNumber data-testid="ct-col-scale" placeholder={t("标度")} style={{ width: 80 }} min={0} value={c.scale ?? 2} onChange={(v) => setCol(i, { scale: v ?? undefined })} />
              </>}
              <Checkbox data-testid="ct-col-nullable" checked={c.nullable} onChange={(e) => setCol(i, { nullable: e.target.checked })}>{t("可空")}</Checkbox>
              {kind === "redshift" && <Checkbox data-testid="ct-col-pk" checked={c.isPrimaryKey} onChange={(e) => setCol(i, { isPrimaryKey: e.target.checked })}>{t("主键")}</Checkbox>}
              <Input data-testid="ct-col-comment" placeholder={t("注释")} style={{ width: 180 }} value={c.comment || ""} onChange={(e) => setCol(i, { comment: e.target.value })} />
              <Button data-testid="ct-col-del" size="small" danger icon={<DeleteOutlined />} disabled={columns.length <= 1} onClick={() => setColumns(columns.filter((_, j) => j !== i))} />
            </Space>
          ))}
          <Button data-testid="ct-col-add" size="small" icon={<PlusOutlined />} onClick={() => setColumns([...columns, newColumn()])}>{t("添加列")}</Button>
          {previewErr && <Alert type="error" showIcon style={{ marginTop: 12 }} data-testid="ct-preview-error" message={previewErr} />}
        </div>
      )}

      {step === 2 && (
        <div>
          <Typography.Text strong>{kind === "redshift" ? t("将执行的语句") : t("将创建的 Iceberg 表结构")}</Typography.Text>
          <pre data-testid="ct-ddl" style={{ background: "#1e1e1e", color: "#d4d4d4", padding: 12, borderRadius: 6, marginTop: 6, maxHeight: 320, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {preview?.statements ? preview.statements.join(";\n") + ";" : JSON.stringify(preview?.icebergSchema ?? {}, null, 2)}
          </pre>
          <div style={{ color: "#8c8c8c", fontSize: 12 }}>
            {t("执行区")}: <code>{targetId}</code> · {kind === "redshift" ? t("走建模落地通道(登记建模台账 + 区域审计 + 落地后再观测)") : t("s3tables CreateTable(全程写审计)")}
          </div>
          {result && (
            <Alert style={{ marginTop: 12 }} type={result.ok ? (result.pending ? "warning" : "success") : "error"} showIcon data-testid={result.pending ? "ct-pending" : "ct-result"}
              message={result.text}
              action={result.pending ? <Button size="small" href="/projects" data-testid="ct-goto-approvals">{t("去项目空间审批")}</Button> : undefined} />
          )}
        </div>
      )}
    </Modal>
  );
}
