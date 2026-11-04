// D4 指标体系服务层(原子/派生指标 CRUD + 安全聚合计算)。
//
// (bgp-metrics)之上的治理建模层,独立表 bgp-model-metrics,不动
//  - 原子指标:绑定表(fqn)+ 聚合(agg)+ 度量列;归属数据域;业务口径。
//  - 派生指标:引用原子指标 + 修饰词(过滤)+ 时间周期 → 安全 WHERE 谓词。
// 计算复用 ./metric-sql(安全 SQL 构造)+ ./redshift execScalar(只读执行)。OM Glossary 推送 best-effort。

import { PutCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { buildMetricSql, isAgg, isTimeWindow, isOp, quoteTable } from "./metric-sql";
// 指标计算按区(只读标量,与 DDL 的 home-only 无关)
import { execScalarAt, safeIdent } from "./redshift";
import { pushMetricGlossary } from "@/lib/openmetadata/om-glossary";
import type { ModelMetric, MetricModifier, MetricAgg, TimeWindow, MetricFormat } from "./types";

const METRIC_PK = "modelmetric";
const FORMATS: MetricFormat[] = ["number", "currency", "percent"];

const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? "" : String(v)).trim();

// ─── 校验 ──────────────────────────────────────────────────────────────────────
function normalizeModifiers(raw: any): MetricModifier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m: any) => {
      const column = str(m?.column);
      if (!column) return null;
      safeIdent(column); // 列白名单
      if (!isOp(m?.op)) throw new Error(`非法修饰词运算符: ${JSON.stringify(m?.op)}`);
      const value = Array.isArray(m?.value) ? m.value.map((x: any) => str(x)).filter(Boolean) : str(m?.value);
      return { column, op: m.op, value } as MetricModifier;
    })
    .filter(Boolean) as MetricModifier[];
}

type ModelMetricCore = Omit<ModelMetric, "modelMetricId" | "createdAt" | "updatedAt" | "createdBy" | "lastValue" | "lastComputedAt">;

function validateModelMetric(input: any): ModelMetricCore {
  const name = str(input.name);
  if (!name) throw new Error("缺少指标名称");
  const metricType = input.metricType === "derived" ? "derived" : "atomic";
  const core: ModelMetricCore = {
    name,
    metricType,
    ...(str(input.domainId) ? { domainId: str(input.domainId) } : {}),
    ...(str(input.caliber) ? { caliber: str(input.caliber) } : {}),
    ...(str(input.unit) ? { unit: str(input.unit) } : {}),
    ...(FORMATS.includes(input.format) ? { format: input.format } : {}),
    ...(str(input.description) ? { description: str(input.description) } : {}),
  };

  if (metricType === "atomic") {
    const fqn = str(input.fqn);
    if (!fqn) throw new Error("原子指标缺少数据表");
    quoteTable(fqn); // 提前暴露非法表名
    if (!isAgg(input.agg)) throw new Error("原子指标缺少合法聚合类型");
    const agg = input.agg as MetricAgg;
    const measureColumn = str(input.measureColumn);
    if (agg !== "count" && !measureColumn) throw new Error("该聚合需要度量列");
    if (measureColumn) safeIdent(measureColumn);
    core.fqn = fqn;
    core.agg = agg;
    if (measureColumn) core.measureColumn = measureColumn;
    if (str(input.timeColumn)) { safeIdent(str(input.timeColumn)); core.timeColumn = str(input.timeColumn); }
  } else {
    const atomicId = str(input.atomicId);
    if (!atomicId) throw new Error("派生指标缺少引用的原子指标");
    core.atomicId = atomicId;
    if (input.timeWindow != null && input.timeWindow !== "") {
      if (!isTimeWindow(input.timeWindow)) throw new Error(`非法时间周期: ${JSON.stringify(input.timeWindow)}`);
      core.timeWindow = input.timeWindow as TimeWindow;
    }
    const modifiers = normalizeModifiers(input.modifiers);
    if (modifiers.length) core.modifiers = modifiers;
    // 派生指标若指定了自己的时间列(覆盖原子的),也校验
    if (str(input.timeColumn)) { safeIdent(str(input.timeColumn)); core.timeColumn = str(input.timeColumn); }
  }
  return core;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────
/**
 * 「这个指标**在这个区**的值」的唯一读法。
 *
 * 🔴 该区没算过 ⇒ 回 `null`,**绝不回落 `lastValue`**:`lastValue` 是「最近一次算的」,
 * 它可能属于另一个区 —— 拿它当这个区的值,就是把一个区的数字冒充成另一个区的
 * (与基线那条 `baselineFor` 同一条纪律,刻意保持一致的形状)。
 * 落章之前算出来的存量行(没有 `valueByTarget`)⇒ 回 `lastValue` 并标 `legacy`,如实说明。
 */
export function metricValueFor(
  m: Pick<ModelMetric, "valueByTarget" | "lastValue" | "lastComputedAt" | "lastTargetId">,
  targetId?: string
): { value: number; computedAt?: string; legacy: boolean } | null {
  const tid = targetId || HOME_TARGET_ID;
  const map = m.valueByTarget;
  if (map && Object.keys(map).length > 0) {
    const hit = map[tid];
    return hit ? { value: hit.value, computedAt: hit.computedAt, legacy: false } : null;
  }
  if (typeof m.lastValue !== "number") return null;
  return { value: m.lastValue, computedAt: m.lastComputedAt, legacy: true };
}

export async function listModelMetrics(): Promise<ModelMetric[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({ TableName: TABLES.MODEL_METRICS, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": METRIC_PK } })
  );
  return Items as ModelMetric[];
}

export async function getModelMetric(modelMetricId: string): Promise<ModelMetric | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.MODEL_METRICS, Key: { pk: METRIC_PK, modelMetricId } }));
  return (Item as ModelMetric) || null;
}

export async function createModelMetric(input: any, actor?: string): Promise<ModelMetric> {
  const v = validateModelMetric(input);
  const ts = now();
  const m: ModelMetric & { pk: string } = { pk: METRIC_PK, modelMetricId: ulid(), ...v, ...(actor ? { createdBy: actor } : {}), createdAt: ts, updatedAt: ts };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_METRICS, Item: m }));
  pushMetricGlossary(m).catch(() => {}); // best-effort 推 OM Glossary
  return m;
}

export async function updateModelMetric(modelMetricId: string, patch: any): Promise<ModelMetric | null> {
  const current = await getModelMetric(modelMetricId);
  if (!current) return null;
  const v = validateModelMetric({ ...current, ...patch });
  const updated: ModelMetric & { pk: string } = {
    pk: METRIC_PK, modelMetricId, ...v,
    ...(current.lastValue != null ? { lastValue: current.lastValue } : {}),
    ...(current.lastComputedAt ? { lastComputedAt: current.lastComputedAt } : {}),
    createdBy: current.createdBy, createdAt: current.createdAt, updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.MODEL_METRICS, Item: updated }));
  pushMetricGlossary(updated).catch(() => {});
  return updated;
}

export async function deleteModelMetric(modelMetricId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.MODEL_METRICS, Key: { pk: METRIC_PK, modelMetricId } }));
}

// ─── 计算 ──────────────────────────────────────────────────────────────────────
// 解析指标(原子直接用自身;派生先取引用的原子拿 fqn/agg/measureColumn,再叠加派生的修饰词/时间窗)。
async function resolveQuerySpec(m: ModelMetric) {
  if (m.metricType === "atomic") {
    if (!m.fqn || !m.agg) throw new Error("原子指标定义不完整");
    return { fqn: m.fqn, agg: m.agg, measureColumn: m.measureColumn, timeColumn: m.timeColumn, timeWindow: undefined as TimeWindow | undefined, modifiers: [] as MetricModifier[] };
  }
  if (!m.atomicId) throw new Error("派生指标缺少原子引用");
  const atomic = await getModelMetric(m.atomicId);
  if (!atomic) throw new Error("派生指标引用的原子指标不存在");
  if (atomic.metricType !== "atomic" || !atomic.fqn || !atomic.agg) throw new Error("引用的指标不是合法原子指标");
  return {
    fqn: atomic.fqn,
    agg: atomic.agg,
    measureColumn: atomic.measureColumn,
    // 派生可覆盖时间列;否则用原子的
    timeColumn: m.timeColumn || atomic.timeColumn,
    timeWindow: m.timeWindow,
    modifiers: m.modifiers || [],
  };
}

export interface ComputeResult {
  /** 这个值是在哪个区算出来的 */
  targetId?: string;
  modelMetricId: string;
  value: number;
  computedAt: string;
  sql: string;
}

export async function computeModelMetric(modelMetricId: string, targetId: string, projectId: string): Promise<ComputeResult> {
  const m = await getModelMetric(modelMetricId);
  if (!m) throw new Error("指标不存在");
  const spec = await resolveQuerySpec(m);
  const sql = buildMetricSql(spec);
  // 🔴 在**指定的那个区**算,并把结果按区存。
  // 落点必填。`resolveRedshiftBinding` 会核准入 / 组件 / 落点 / 凭证,
  // 解析不出来就抛 —— 绝不静默改到主控区算一个数再标成那个区的(那才是最坏的错数字)。
  const tid = targetId;
  const value = await execScalarAt(sql, tid, projectId);
  const ts = now();
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.MODEL_METRICS,
      Key: { pk: METRIC_PK, modelMetricId },
      // `valueByTarget.<tid>` 用 map 单键更新(不整体覆盖 ⇒ 别的区的值不会被这次计算抹掉);
      // `lastValue` / `lastComputedAt` 保留旧语义(最近一次),另存 `lastTargetId` 说清它属于哪个区。
      UpdateExpression:
        "SET lastValue = :v, lastComputedAt = :t, lastTargetId = :tid, valueByTarget = if_not_exists(valueByTarget, :empty)",
      ExpressionAttributeValues: { ":v": value, ":t": ts, ":tid": tid, ":empty": {} },
    })
  ).catch(() => {});
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.MODEL_METRICS,
      Key: { pk: METRIC_PK, modelMetricId },
      UpdateExpression: "SET valueByTarget.#t = :entry",
      ExpressionAttributeNames: { "#t": tid },
      ExpressionAttributeValues: { ":entry": { value, computedAt: ts } },
    })
  ).catch(() => {});
  return { modelMetricId, value, computedAt: ts, sql, targetId: tid };
}
