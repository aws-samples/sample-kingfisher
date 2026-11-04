// @kf-batch 50-WP30-decommission
// 删除执行环境的**影响预览** —— 计数的唯一作者(WP-30 路 B 施工序 2;INTERACTION §1.4 机制 B)。
//
// 【它回答什么】「这个环境现在能不能删」= 三个数都必须是 0:
//   ① **绑定资源定义数**:哪些定义(同步 / 离线作业 / 多引擎作业 / 流作业 / 工作流 / 直查任务 / 建模产物 / 补数计划 /
//      平台动作调度 / 数据源)此刻还绑在它身上 —— 判据 = `bindingTargets()`,**与绑定门 / 下发 / 看板读的是同一个函数**;
//   ② **启用调度数**:上面那些里 `scheduleEnabled === true` 的(`POST /api/schedule/enable` 写的就是这个字段);
//   ③ **运行中 run 数**:`bgp-task-runs` 里 `status = running` 且章(`targetId`)是它的 —— 与监控页「运行中」同一个源。
// 任何一个 > 0 ⇒ 不许删,并把明细列出来(给「去解绑」直达)。
//
// 🔴 「读不到」≠「没有」(与项目删除前置 project-resources.ts 同一条纪律):任一来源读失败 ⇒ 该项进 `unresolved`、
//    count 记 null、**阻断删除**。把读失败合成 0 = 删掉一个其实还有绑定的环境。
// 🔴 `previewHash` 绑的是**这一份清单**:申请删除时带上它,服务端重算一遍,不一致 ⇒ 409 要求重新预览
//    (用户看的是 0,提交那一刻多出一个绑定 —— 正是要拦的那一种)。审批通过时再重算一次(审批可能隔了几天)。
import { createHash } from "node:crypto";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { DATASOURCE_OWNER_TARGET_ATTR } from "@/lib/datasource/placement-shared";
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";
import { resourceName } from "@/lib/aws/naming";
import { canonicalJson, type RetainedResource } from "@/lib/exec-env/lifecycle";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

/** 一类「可能绑在执行环境上的资源定义」。 */
export interface ImpactSource {
  kind: string;
  /** 页面上的中文名(前端经 t() 翻译) */
  label: string;
  table: string;
  /** 行主键里那个 id 属性 */
  idAttr: string;
  /**
   * 绑定怎么读:
   * · `binding` = `bindingTargets()`(targets[] → 单值 targetId → 缺省 home 三级回落;**绑定门同一个函数**);
   *   `attr` 是绑定列表的字段名(缺省 targets;补数计划叫 execTargets,取自该模块自己导出的常量)
   * · `scalar` = 单值归属属性(数据源的 ownerTargetId:它的 Glue 连接就建在那个区)
   */
  binding: { mode: "binding"; attr?: string } | { mode: "scalar"; attr: string };
  /** 这类行有没有调度(`scheduleEnabled`) */
  schedulable: boolean;
}

/**
 * 🔴 清单本身是判据:漏一类 = 那一类的绑定永远不会挡住删除(删掉之后它们指向一个不存在的区)。
 *   单测 `delete-impact-sources` 钉住:与 `scope/resource-index` 的 KIND_INDEX 交叉核对(那张表登记了「哪些资源按执行范围归属」),
 *   并要求 KIND_INDEX 之外多出来的每一类都写明理由。
 */
export const IMPACT_SOURCES: readonly ImpactSource[] = [
  { kind: "datasource", label: "数据源", table: TABLES.DATASOURCES, idAttr: "datasourceId", binding: { mode: "scalar", attr: DATASOURCE_OWNER_TARGET_ATTR }, schedulable: false },
  { kind: "sync", label: "同步任务", table: TABLES.SYNC_TASKS, idAttr: "taskId", binding: { mode: "binding" }, schedulable: true },
  { kind: "etl-job", label: "离线作业", table: TABLES.ETL_JOBS, idAttr: "jobId", binding: { mode: "binding" }, schedulable: true },
  { kind: "engine-job", label: "多引擎作业", table: TABLES.ENGINE_JOBS, idAttr: "jobId", binding: { mode: "binding" }, schedulable: true },
  // KIND_INDEX 之外:流作业(一区一个应用,作业行盖本区的章)
  { kind: "flink-job", label: "实时作业", table: TABLES.FLINK_JOBS, idAttr: "jobId", binding: { mode: "binding" }, schedulable: false },
  { kind: "workflow", label: "工作流", table: TABLES.WORKFLOWS, idAttr: "workflowId", binding: { mode: "binding" }, schedulable: true },
  // KIND_INDEX 之外:直查任务(行上是单值 targetId,bindingTargets 的第二级回落)
  { kind: "redshift-task", label: "直查任务", table: TABLES.REDSHIFT_TASKS, idAttr: "taskId", binding: { mode: "binding" }, schedulable: true },
  { kind: "model-table", label: "维度 / 事实表", table: TABLES.MODEL_TABLES, idAttr: "modelTableId", binding: { mode: "binding" }, schedulable: false },
  { kind: "code-table", label: "码表", table: TABLES.CODE_TABLES, idAttr: "codeTableId", binding: { mode: "binding" }, schedulable: false },
  { kind: "backfill-plan", label: "补数计划", table: TABLES.BACKFILL_PLANS, idAttr: "planId", binding: { mode: "binding", attr: BACKFILL_PLAN_BINDING_ATTR }, schedulable: false },
  // KIND_INDEX 之外:平台动作调度(治理定时任务 / 问数卡片定时刷新;每区各建一个,targets=[该区])
  { kind: "action-schedule", label: "平台定时任务", table: TABLES.ACTION_SCHEDULES, idAttr: "taskId", binding: { mode: "binding" }, schedulable: true },
];

/** 运行中的 run(`bgp-task-runs.status`)。与监控页「运行中」计数同一个词。 */
export const RUNNING_RUN_STATUS = "running";

/** 明细最多回多少条(计数永远是全量;明细只是给人看 + 去解绑)。 */
export const IMPACT_DETAIL_CAP = 200;

export interface ImpactItem {
  kind: string;
  label: string;
  id: string;
  name: string;
  projectId?: string;
}
export interface RunningRunItem {
  taskId: string;
  runId: string;
  taskType?: string;
}

export interface DeleteImpact {
  targetId: string;
  region: string;
  /** null = 读不到(看 unresolved);不是 0 */
  counts: { bindings: number | null; schedules: number | null; runningRuns: number | null };
  bindings: ImpactItem[];
  schedules: ImpactItem[];
  runningRuns: RunningRunItem[];
  /** 没能核实的来源(非空即阻断删除) */
  unresolved: Array<{ source: string; error: string }>;
  /** 销毁后**保留**(不删)的数据类资源;最终快照名在审批通过那一刻才定,这里给出模板 */
  retained: RetainedResource[];
  /** 明细是否被截断(计数不受影响) */
  truncated: boolean;
  computedAt: string;
  /** 这一份清单的指纹(申请 / 审批时重算比对) */
  previewHash: string;
  /** 三个数都是 0 且无 unresolved */
  clear: boolean;
}

async function scanAll(table: string, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  // 🔴 必须翻到底:Scan 单次 1MiB 且过滤在分页之后 ⇒ 不翻页 = 静默少报(少报的方向恰好是「放行删除」)
  for (let page = 0; page < 500; page++) {
    const r = (await docClient.send(
      new ScanCommand({ TableName: table, ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) })
    )) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    out.push(...(r.Items ?? []));
    startKey = r.LastEvaluatedKey;
    if (!startKey) return out;
  }
  throw new Error(`${table} 分页超过 500 页 —— 数据形态异常,拒绝给出可能不完整的计数`);
}

/** 这一行是否绑在 targetId 上(唯一判据;单测与看板同一个 bindingTargets)。 */
export function rowBindsTarget(source: ImpactSource, row: Record<string, unknown>, targetId: string): boolean {
  if (source.binding.mode === "scalar") return String(row[source.binding.attr] ?? "") === targetId;
  const attr = source.binding.attr ?? "targets";
  return bindingTargets({ targets: row[attr], targetId: row.targetId }).includes(targetId);
}

function itemOf(source: ImpactSource, row: Record<string, unknown>): ImpactItem {
  const id = String(row[source.idAttr] ?? "");
  const name = String(row.name ?? row.displayName ?? row.title ?? id);
  return { kind: source.kind, label: source.label, id, name, ...(row.projectId ? { projectId: String(row.projectId) } : {}) };
}

/** 销毁后保留的数据类资源(名字:描述符资源袋优先,缺了按命名 SSOT 现算 —— 与 buildspec 销毁脚本同一份 naming.json)。 */
export function retainedResourcesOf(t: Pick<ExecutionTarget, "targetId" | "accountId" | "components"> & { resources?: Record<string, unknown> }, finalSnapshotName?: string): RetainedResource[] {
  const comps = new Set(Array.isArray(t.components) ? t.components.map(String) : ["core"]);
  comps.add("core");
  const res = t.resources ?? {};
  const nameOf = (kind: string, bagKey?: string) => {
    const v = bagKey ? res[bagKey] : undefined;
    if (typeof v === "string" && v.trim()) return v;
    return resourceName(kind, { targetId: t.targetId, account: t.accountId });
  };
  const out: RetainedResource[] = [
    { kind: "s3", name: nameOf("datalakeBucket", "datalakeBucket"), note: "数据湖桶" },
    { kind: "s3", name: nameOf("scriptsBucket", "scriptsBucket"), note: "脚本桶" },
    { kind: "s3tables", name: nameOf("tableBucket", "tableBucket"), note: "表桶" },
  ];
  if (comps.has("airflow-serverless")) out.push({ kind: "s3", name: nameOf("workflowBucket", "workflowBucket"), note: "工作流定义桶" });
  if (comps.has("mwaa")) out.push({ kind: "s3", name: nameOf("dagBucket", "dagBucket"), note: "DAG 桶" });
  if (comps.has("residency-api")) {
    out.push({ kind: "s3", name: nameOf("residencyBucket", "residencyBucket"), note: "驻留结果桶" });
    out.push({ kind: "dynamodb", name: nameOf("residencyAuditTable", "residencyAuditTable"), note: "驻留审计表" });
    out.push({ kind: "dynamodb", name: nameOf("residencyResultsTable", "residencyResultsTable"), note: "驻留结果表" });
  }
  out.push({ kind: "kms", name: nameOf("dataKeyAlias"), note: "数据域 CMK" });
  if (comps.has("redshift")) {
    out.push({
      kind: "redshift-snapshot",
      name: finalSnapshotName ?? `bgp-final-${t.targetId.replace(/_/g, "-")}-<审批时刻>`,
      note: "数仓最终快照(删命名空间时拍)",
    });
  }
  return out;
}

/**
 * 计算影响预览。**只读**(Scan 若干张定义表 + 运行台账),不改任何东西。
 */
export async function computeDeleteImpact(t: ExecutionTarget, now: Date = new Date()): Promise<DeleteImpact> {
  const targetId = t.targetId;
  const bindings: ImpactItem[] = [];
  const schedules: ImpactItem[] = [];
  const unresolved: DeleteImpact["unresolved"] = [];

  await Promise.all(
    IMPACT_SOURCES.map(async (src) => {
      try {
        const rows = await scanAll(src.table, {});
        for (const row of rows) {
          if (!rowBindsTarget(src, row, targetId)) continue;
          const it = itemOf(src, row);
          bindings.push(it);
          if (src.schedulable && row.scheduleEnabled === true) schedules.push(it);
        }
      } catch (e) {
        unresolved.push({ source: src.kind, error: sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 300) });
      }
    })
  );

  let runningRuns: RunningRunItem[] = [];
  let runsOk = true;
  try {
    const rows = await scanAll(TABLES.TASK_RUNS, {
      FilterExpression: "#st = :running AND #tid = :t",
      ExpressionAttributeNames: { "#st": "status", "#tid": "targetId" },
      ExpressionAttributeValues: { ":running": RUNNING_RUN_STATUS, ":t": targetId },
    });
    runningRuns = rows
      // 过滤表达式之外再在内存里核一遍(替身 / 旧 SDK 不尊重 FilterExpression 时也不多算)
      .filter((r) => r.status === RUNNING_RUN_STATUS && r.targetId === targetId)
      .map((r) => ({ taskId: String(r.taskId ?? ""), runId: String(r.runId ?? ""), ...(r.taskType ? { taskType: String(r.taskType) } : {}) }));
  } catch (e) {
    runsOk = false;
    unresolved.push({ source: "task-runs", error: sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 300) });
  }

  const byKey = (a: { kind?: string; id?: string; taskId?: string; runId?: string }, b: typeof a) =>
    `${a.kind ?? ""}/${a.id ?? a.taskId ?? ""}/${a.runId ?? ""}`.localeCompare(`${b.kind ?? ""}/${b.id ?? b.taskId ?? ""}/${b.runId ?? ""}`);
  bindings.sort(byKey);
  schedules.sort(byKey);
  runningRuns.sort(byKey);
  unresolved.sort((a, b) => a.source.localeCompare(b.source));

  const bindingSourcesFailed = unresolved.some((u) => u.source !== "task-runs");
  const counts = {
    bindings: bindingSourcesFailed ? null : bindings.length,
    schedules: bindingSourcesFailed ? null : schedules.length,
    runningRuns: runsOk ? runningRuns.length : null,
  };
  const retained = retainedResourcesOf(t as ExecutionTarget & { resources?: Record<string, unknown> });
  // 🔴 指纹覆盖**全量** id(在截断之前算):明细截断了也不影响「清单变没变」的判定
  const previewHash = createHash("sha256")
    .update(
      canonicalJson({
        targetId,
        region: t.region,
        bindings: bindings.map((b) => `${b.kind}/${b.id}`),
        schedules: schedules.map((b) => `${b.kind}/${b.id}`),
        runningRuns: runningRuns.map((r) => `${r.taskId}/${r.runId}`),
        unresolved: unresolved.map((u) => u.source),
        retained: retained.map((r) => `${r.kind}:${r.name}`),
      })
    )
    .digest("hex");
  const truncated = bindings.length > IMPACT_DETAIL_CAP || schedules.length > IMPACT_DETAIL_CAP || runningRuns.length > IMPACT_DETAIL_CAP;
  return {
    targetId,
    region: t.region,
    counts,
    bindings: bindings.slice(0, IMPACT_DETAIL_CAP),
    schedules: schedules.slice(0, IMPACT_DETAIL_CAP),
    runningRuns: runningRuns.slice(0, IMPACT_DETAIL_CAP),
    unresolved,
    retained,
    truncated,
    computedAt: now.toISOString(),
    previewHash,
    clear: counts.bindings === 0 && counts.schedules === 0 && counts.runningRuns === 0 && unresolved.length === 0,
  };
}
