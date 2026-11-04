"use client";

import React, { useEffect, useState } from "react";
import { Drawer, Form, Input, Select, Tag, Button, Popconfirm } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import type { Node } from "reactflow";
import { useT } from "@/lib/i18n/useT";
import { JOB_NODE_KINDS, type JobNodeRef } from "@/types/workflow";
import { jobEngineLabel } from "./JobNode";

interface Props {
  node: Node | null;
  /** 序 73 模块 57(R1 / R8):工作流的执行区;候选同步任务 / 离线作业按它过滤(`?scope=<落点>`),与发布期判定同一口径。 */
  wfTargets: string[];
  onClose: () => void;
  onChange: (id: string, data: any) => void;
  onDelete?: (id: string) => void;
}

/** 面板候选(同步任务 / 离线计算作业 / EMR 作业)—— 三条已有读接口,都认 `?scope=`。 */
export interface NodeCandidates {
  syncTasks: any[];
  etlJobs: any[];
  emrJobs: any[];
  /** 候选读取失败的原话(红字说明;不静默回空列表 —— B-109 教训) */
  error: string | null;
  loaded: boolean;
}

const EMPTY_CANDIDATES: NodeCandidates = { syncTasks: [], etlJobs: [], emrJobs: [], error: null, loaded: false };

/**
 * 按工作流的执行区取候选:每个区各取一次 `?scope=<tid>`,工作流绑多个区时只留**每个区都绑了**的
 * (发布期判定是「绑定含工作流的每个落点」,面板只列发得出去的)。
 */
async function fetchScoped(base: string, targets: string[], idOf: (x: any) => string): Promise<any[]> {
  const lists = await Promise.all(
    targets.map(async (tid) => {
      const res = await fetch(`${base}?scope=${encodeURIComponent(tid)}`);
      const d = await res.json().catch(() => null);
      if (!res.ok || d?.success === false) throw new Error(d?.error?.message || `HTTP ${res.status}`);
      return (Array.isArray(d) ? d : d?.data || []) as any[];
    })
  );
  const [first, ...rest] = lists;
  return (first || []).filter((x) => rest.every((l) => l.some((y) => idOf(y) === idOf(x))));
}

export default function NodeConfigPanel({ node, wfTargets, onClose, onChange, onDelete }: Props) {
  const t = useT();
  const [cands, setCands] = useState<NodeCandidates>(EMPTY_CANDIDATES);
  const targetsKey = (wfTargets || []).join(",");

  useEffect(() => {
    const targets = targetsKey ? targetsKey.split(",") : ["tgt_home"];
    let cancelled = false;
    (async () => {
      try {
        const [syncTasks, etlJobs, emrJobs] = await Promise.all([
          fetchScoped("/api/sync", targets, (x) => String(x.taskId)),
          fetchScoped("/api/etl-jobs", targets, (x) => String(x.jobId)),
          fetchScoped("/api/engines/emr-serverless", targets, (x) => String(x.jobId)),
        ]);
        if (!cancelled) setCands({ syncTasks, etlJobs, emrJobs, error: null, loaded: true });
      } catch (e) {
        if (!cancelled) setCands({ ...EMPTY_CANDIDATES, error: String((e as Error)?.message || e), loaded: true });
      }
    })();
    return () => { cancelled = true; };
  }, [targetsKey]);

  if (!node) return null;

  return (
    <Drawer
      title={t("节点配置")}
      open={!!node}
      onClose={onClose}
      width={400}
      extra={
        onDelete && (
          <Popconfirm
            title={t("确认删除该节点？")}
            description={t("将同时移除与之相连的连线")}
            okText={t("删除")}
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(node.id)}
          >
            <Button danger size="small" icon={<DeleteOutlined />}>{t("删除节点")}</Button>
          </Popconfirm>
        )
      }
    >
      {/* 🔴 B-122:表单必须按节点**重开一份**(key=node.id),见 NodeConfigForm 顶部注释 */}
      <NodeConfigForm key={node.id} node={node} cands={cands} wfTargets={wfTargets} onChange={onChange} />
    </Drawer>
  );
}

/** `jobRef`(对象)⇄ Select 的标量值 `<kind>:<jobId>`(kind 闭合;形态不对 ⇒ 不选中)。 */
export function encodeJobRef(ref: unknown): string | undefined {
  const r = ref as { kind?: unknown; jobId?: unknown } | null | undefined;
  const kind = String(r?.kind ?? "");
  const jobId = String(r?.jobId ?? "");
  return (JOB_NODE_KINDS as readonly string[]).includes(kind) && jobId ? `${kind}:${jobId}` : undefined;
}
export function decodeJobRef(v: unknown): JobNodeRef | undefined {
  const s = String(v ?? "");
  const i = s.indexOf(":");
  if (i <= 0) return undefined;
  const kind = s.slice(0, i);
  const jobId = s.slice(i + 1);
  return (JOB_NODE_KINDS as readonly string[]).includes(kind) && jobId ? { kind: kind as JobNodeRef["kind"], jobId } : undefined;
}

/** 候选行的标签:名称 · 引擎 · 绑定区(与列表页同一套事实:行上的 `targets[]`,无章 = 主控区)。 */
function candidateLabel(name: unknown, engine: unknown, targets: unknown): string {
  const tg = Array.isArray(targets) && targets.length ? targets.map(String).join("/") : "tgt_home";
  return `${String(name ?? "")} · ${jobEngineLabel(engine)} · ${tg}`;
}

// @kf-batch 41-B122-node-form-per-node
/**
 * 一个节点一份表单(连同它的 Form 实例 / 值仓)。
 *
 * 【缺陷原形(2026-10-24 页面驱动段 slsw SW-12,真 DOM 探针坐实)】原来 `Form.useForm()` 建在外层 NodeConfigPanel 里,
 *   而 NodeConfigPanel 在编辑器里**常驻**(没选中节点时只是 return null):关掉抽屉再点另一个节点,<Form> 虽然重挂,
 *   但 useForm 的值仓还是上一个节点那份;rc-field-form 在挂载时把 initialValues **合并**进值仓(值仓里已有的赢)
 *   ⇒ 第二个节点的抽屉里显示的是**第一个节点**的名称 / 脚本 / SQL。用户看着「已经填好」不再动它 ⇒ 这个节点其实什么都没存
 *   (发布时「Python 节点「Python 2」未填写脚本」);改一个字 ⇒ 上一个节点的全部字段(含名称)被整份写进这个节点。
 *   不关抽屉直接点下一个节点同样中招(同一个 Form 实例,initialValues 变了也不重新应用)。
 * 【修法】Form.useForm() 挪进本组件,由父级用 key=node.id 渲染 ⇒ 换节点 = 换组件实例 = 全新值仓,initialValues 原样生效。
 */
export function NodeConfigForm({ node, cands, wfTargets, onChange }: { node: Node; cands: NodeCandidates; wfTargets: string[]; onChange: Props["onChange"] }) {
  const t = useT();
  const [form] = Form.useForm();
  const { syncTasks, etlJobs, emrJobs } = cands;

  /** 选中的作业在候选里的那一行(名称 / 引擎 / 绑定区的展示副本随 jobRef 一起写进 data;权威引用只有 jobRef)。 */
  const jobMetaOf = (ref: JobNodeRef | undefined) => {
    if (!ref) return undefined;
    if (ref.kind === "etl") {
      const j = etlJobs.find((x) => String(x.jobId) === ref.jobId);
      return j ? { jobName: String(j.name ?? ""), jobEngine: String(j.type ?? ""), jobTargets: j.targets } : undefined;
    }
    const j = emrJobs.find((x) => String(x.jobId) === ref.jobId);
    return j ? { jobName: String(j.name ?? ""), jobEngine: "emr", jobTargets: j.targets } : undefined;
  };

  const handleChange = () => {
    const values = form.getFieldsValue();
    if (node.type === "job") {
      const ref = values.jobRef as JobNodeRef | undefined;
      const meta = jobMetaOf(ref);
      onChange(node.id, { ...node.data, ...values, ...(meta ?? {}), jobMissing: Boolean(ref && cands.loaded && !cands.error && !meta) });
      return;
    }
    onChange(node.id, { ...node.data, ...values });
  };

  const currentJobRef = decodeJobRef(encodeJobRef((node.data as { jobRef?: unknown })?.jobRef));
  const jobMissing = Boolean(node.type === "job" && currentJobRef && cands.loaded && !cands.error && !jobMetaOf(currentJobRef));
  const scopeNote = (
    <div style={{ marginBottom: 8, color: "#90a4c0", fontSize: 12 }} data-testid="node-candidates-scope">
      {t("候选按本工作流的执行区过滤:{targets}", { targets: (wfTargets || []).join(" / ") || "tgt_home" })}
    </div>
  );
  const candError = cands.error ? (
    <div style={{ marginBottom: 8, color: "#ff7875", fontSize: 12 }} data-testid="node-candidates-error">
      {t("候选读取失败:{msg}", { msg: cands.error })}
    </div>
  ) : null;

  return (
    <Form form={form} layout="vertical" initialValues={node.data} onValuesChange={handleChange}>
        <Form.Item name="label" label={t("节点名称")}>
          <Input />
        </Form.Item>

        {node.type === "sync" && (
          <>
            {scopeNote}
            {candError}
            <Form.Item name="syncTaskId" label={t("关联同步任务")}>
              <Select placeholder={t("选择同步任务")} showSearch optionFilterProp="label" data-testid="sync-node-picker"
                options={syncTasks.map(task => ({
                  label: `${task.name} (${task.sourceTables?.join(",") || ""} → ${task.targetType}) · ${Array.isArray(task.targets) && task.targets.length ? task.targets.join("/") : "tgt_home"}`,
                  value: task.taskId,
                }))}
              />
            </Form.Item>
          </>
        )}

        {node.type === "job" && (
          <>
            {scopeNote}
            {candError}
            {/* 序 73 模块 57(R1):`jobRef` 是对象 {kind, jobId},Select 用标量 `<kind>:<jobId>` 承载;kind 闭合(JOB_NODE_KINDS) */}
            <Form.Item
              name="jobRef"
              label={t("关联离线作业")}
              getValueProps={(v) => ({ value: encodeJobRef(v) })}
              normalize={(v) => decodeJobRef(v)}
              extra={jobMissing ? <span style={{ color: "#e8a23d" }} data-testid="job-node-missing">{t("作业不存在或不再绑定本工作流的执行区")}</span> : undefined}
            >
              <Select
                placeholder={t("选择离线作业(只列出绑定了本工作流执行区的作业)")}
                showSearch
                optionFilterProp="label"
                data-testid="job-node-picker"
                options={[
                  {
                    label: t("离线计算(Glue / Redshift)"),
                    options: etlJobs.map((j) => ({ value: `etl:${j.jobId}`, label: candidateLabel(j.name, j.type, j.targets) })),
                  },
                  {
                    label: "EMR Serverless",
                    options: emrJobs.map((j) => ({ value: `emr:${j.jobId}`, label: candidateLabel(j.name, "emr", j.targets) })),
                  },
                ]}
              />
            </Form.Item>
          </>
        )}

        {node.type === "sql" && (
          <>
            <Form.Item name="engine" label={t("执行引擎")} initialValue="redshift">
              <Select options={[
                { label: t("Redshift (数据仓库查询)"), value: "redshift" },
                { label: t("Glue Spark SQL (ETL 处理)"), value: "glue" },
              ]} />
            </Form.Item>
            <Form.Item name="database" label={t("数据库")}>
              <Input placeholder="dev" />
            </Form.Item>
            <Form.Item name="sql" label={t("SQL 语句")}>
              <Input.TextArea rows={6} placeholder="SELECT ..." />
            </Form.Item>
          </>
        )}

        {node.type === "python" && (
          <Form.Item name="script" label={t("Python 脚本")}>
            <Input.TextArea rows={6} placeholder={t("# 受限执行:仅纯计算(禁 import/open/exec 等),可用 params/xcom/result")} />
          </Form.Item>
        )}

        {/* ── 33-B 六新节点(仅 runtime-lib 引擎)── */}

        {node.type === "branch" && (
          <>
            <div style={{ marginBottom: 8, color: "#90a4c0", fontSize: 12 }}>
              {t("按顺序求值条件(受限表达式,如 xcom['rows'] > 0),命中即路由到对应目标节点;都不命中走默认。")}
            </div>
            <Form.List name="branches">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <div key={field.key} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                      <Form.Item name={[field.name, "cond"]} noStyle>
                        <Input placeholder={t("条件表达式")} style={{ flex: 1 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, "target"]} noStyle>
                        <Input placeholder={t("目标节点ID")} style={{ width: 120 }} />
                      </Form.Item>
                      <Button size="small" danger onClick={() => remove(field.name)}>{t("删")}</Button>
                    </div>
                  ))}
                  <Button size="small" onClick={() => add({ cond: "", target: "" })}>+ {t("加分支")}</Button>
                </>
              )}
            </Form.List>
            <Form.Item name="default" label={t("默认目标节点ID")} style={{ marginTop: 8 }}>
              <Input placeholder={t("都不命中时走此节点")} />
            </Form.Item>
          </>
        )}

        {node.type === "join" && (
          <Form.Item name="rule" label={t("汇聚规则")} initialValue="all_success">
            <Select options={[
              { label: t("全部成功 (all_success)"), value: "all_success" },
              { label: t("无失败 (none_failed)"), value: "none_failed" },
              { label: t("无失败且至少一个成功 (none_failed_min_one_success)"), value: "none_failed_min_one_success" },
            ]} />
          </Form.Item>
        )}

        {node.type === "foreach" && (
          <>
            <Form.Item name="items" label={t("遍历集合")}
              tooltip={t("静态列表用逗号分隔,或填上游 XCom key(二期支持动态)")}>
              <Input placeholder={t("a,b,c 或 xcom_key")} />
            </Form.Item>
            <Form.Item name={["sub", "type"]} label={t("子任务类型")} initialValue="sql">
              <Select options={[
                { label: "SQL", value: "sql" },
                { label: "Python", value: "python" },
                { label: t("空(占位)"), value: "empty" },
              ]} />
            </Form.Item>
            <Form.Item name={["sub", "data", "sql"]} label={t("子任务 SQL(用 {{item}} 引用当前项)")}>
              <Input.TextArea rows={3} placeholder="SELECT * FROM t WHERE k = '{{item}}'" />
            </Form.Item>
          </>
        )}

        {node.type === "setvar" && (
          <Form.List name="varList">
            {(fields, { add, remove }) => (
              <>
                <div style={{ marginBottom: 8, color: "#90a4c0", fontSize: 12 }}>
                  {t("定义变量(push 到 XCom,下游可用 {{ ti.xcom_pull(key=...) }} 引用)")}
                </div>
                {fields.map((field) => (
                  <div key={field.key} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                    <Form.Item name={[field.name, "k"]} noStyle>
                      <Input placeholder={t("变量名")} style={{ width: 120 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, "v"]} noStyle>
                      <Input placeholder={t("值")} style={{ flex: 1 }} />
                    </Form.Item>
                    <Button size="small" danger onClick={() => remove(field.name)}>{t("删")}</Button>
                  </div>
                ))}
                <Button size="small" onClick={() => add({ k: "", v: "" })}>+ {t("加变量")}</Button>
              </>
            )}
          </Form.List>
        )}

        {node.type === "external" && (
          <>
            <Form.Item name="externalDagId" label={t("外部 DAG ID")}>
              <Input placeholder="bgp_xxx" />
            </Form.Item>
            <Form.Item name="externalTaskId" label={t("外部任务 ID(留空=等整个 DAG)")}>
              <Input placeholder={t("可选")} />
            </Form.Item>
            <Form.Item name="executionDelta" label={t("时间偏移(秒,上游早于本 DAG 的时长)")}>
              <Input type="number" placeholder="0" />
            </Form.Item>
          </>
        )}

        <Form.Item name="retryCount" label={t("重试次数")} initialValue={0}>
          <Select options={[0, 1, 2, 3].map(n => ({ label: t("{n} 次", { n }), value: n }))} />
        </Form.Item>

        <Form.Item name="timeout" label={t("超时时间（秒）")}>
          <Input type="number" placeholder="3600" />
        </Form.Item>
    </Form>
  );
}
