// 模块 37 v4 — 分析看板 CRUD(bgp-bi-analyses)。QuickSight 式:一个画布内嵌 N 个视觉对象 + 绑字段·作用域筛选器。
// 键式隔离:pk=projectId, sk=analysisId(ULID);更新走 version 乐观锁(照抄 dashboards.ts,并发一成功一 409)。
// 纯新增:旧 reports/dashboards 的表/lib/API 完全不动。视觉对象的 source/viz 复用 reports 的归一(不重造)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { OptimisticLockError, normalizeSource, normalizeViz } from "./reports";
import type { BiAnalysis, BiWidget, AnalysisFilter, AnalysisLayoutItem, FilterScope } from "./types";

export { OptimisticLockError };

const FILTER_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/i;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FILTER_OPS = ["=", "!=", ">", "<", ">=", "<="] as const;
// 视觉对象数量软上限:整个分析看板内嵌在一条 DynamoDB item(硬限 400KB)。每个视觉对象约 0.5~2KB,
// 50 个留足余量且远低于 400KB;超过给明确报错,而非存到 400KB 边界处静默失败(全球用户健壮性)。
const MAX_WIDGETS = 50;
const MAX_FILTERS = 30;

// antd 24 栅格制:占列宽夹到 [1,24],缺省 8。
function clampSpan(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 8;
  return Math.min(24, Math.max(1, Math.round(w)));
}

// 视觉对象归一:widgetId + name + 复用的 source/viz 校验。source 非法则抛(message 直接回前端)。
function normalizeWidgets(input: any): BiWidget[] {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_WIDGETS) throw new Error(`视觉对象过多(${input.length}),单个分析看板最多 ${MAX_WIDGETS} 个`);
  const out: BiWidget[] = [];
  const seen = new Set<string>();
  for (const w of input) {
    const widgetId = String(w?.widgetId || "").trim() || ulid();
    if (seen.has(widgetId)) continue; // 去重(防同 id 覆盖)
    seen.add(widgetId);
    const name = String(w?.name || "").trim() || "视觉对象";
    const source = normalizeSource(w?.source); // 复用!含 SELECT/WITH 只读校验、builder spec 透传
    const viz = normalizeViz(w?.viz); // 复用!含 v3 多系列/分组/堆叠/横向白名单
    out.push({ widgetId, name, source, viz });
  }
  return out;
}

// 作用域归一:{mode:"all"} | {mode:"widgets", widgetIds:[...]}。默认 all(用户拍板:新建筛选器默认联动全部)。
// widgetIds 用 validWidgetIds 过滤悬空引用(视觉对象被删后作用域自愈)。
function normalizeScope(input: any, validWidgetIds: Set<string>): FilterScope {
  if (input && input.mode === "widgets" && Array.isArray(input.widgetIds)) {
    const ids = input.widgetIds.map((s: any) => String(s)).filter((id: string) => validWidgetIds.has(id));
    return { mode: "widgets", widgetIds: ids };
  }
  return { mode: "all" };
}

// 筛选器归一:绑字段(合法标识符)+ 类型 + 作用域。key/字段防注入,select 需选项。
function normalizeFilters(input: any, widgetIds: Set<string>): AnalysisFilter[] {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_FILTERS) throw new Error(`筛选器过多(${input.length}),单个分析看板最多 ${MAX_FILTERS} 个`);
  const out: AnalysisFilter[] = [];
  const seen = new Set<string>();
  for (const f of input) {
    const key = String(f?.key || "").trim();
    if (!FILTER_KEY_RE.test(key)) throw new Error(`筛选器 key 非法:${key || "(空)"}(仅字母/数字/下划线,字母开头)`);
    if (seen.has(key.toLowerCase())) throw new Error(`筛选器 key 重复:${key}`);
    seen.add(key.toLowerCase());
    const field = String(f?.field || "").trim();
    if (!IDENT_RE.test(field)) throw new Error(`筛选器「${f?.label || key}」绑定字段非法:${field || "(空)"}`);
    const type = f?.type === "date" ? "date" : "select";
    const op = FILTER_OPS.includes(f?.op) ? f.op : "=";
    const filter: AnalysisFilter = { key, label: String(f?.label || key), field, type, op, scope: normalizeScope(f?.scope, widgetIds) };
    if (type === "select") {
      const options = Array.isArray(f?.options) ? f.options.map((o: any) => String(o)).filter(Boolean) : [];
      if (!options.length) throw new Error(`下拉筛选器「${filter.label}」需要至少一个选项`);
      filter.options = options.slice(0, 500);
    }
    if (f?.default !== undefined && f.default !== null && f.default !== "") filter.default = String(f.default);
    out.push(filter);
  }
  return out;
}

// 布局归一:i=widgetId,只保留引用了真实视觉对象的项。
function normalizeLayout(input: any, widgetIds: Set<string>): AnalysisLayoutItem[] {
  if (!Array.isArray(input)) return [];
  const out: AnalysisLayoutItem[] = [];
  for (const it of input) {
    const i = String(it?.i || "").trim();
    if (!i || !widgetIds.has(i)) continue;
    out.push({
      i,
      x: Number.isFinite(Number(it?.x)) ? Number(it.x) : 0,
      y: Number.isFinite(Number(it?.y)) ? Number(it.y) : 0,
      w: clampSpan(Number(it?.w)),
      h: Number.isFinite(Number(it?.h)) && Number(it.h) > 0 ? Number(it.h) : 6,
    });
  }
  return out;
}

export async function listAnalyses(projectId: string): Promise<BiAnalysis[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.BI_ANALYSES,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
      ScanIndexForward: false, // 新看板在前(analysisId=ULID 时间序)
    })
  );
  return Items as BiAnalysis[];
}

export async function getAnalysis(projectId: string, analysisId: string): Promise<BiAnalysis | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.BI_ANALYSES, Key: { projectId, analysisId } })
  );
  return (Item as BiAnalysis) || null;
}

export async function createAnalysis(
  input: { name?: string; description?: string; widgets?: any; filters?: any; layout?: any },
  ctx: { projectId: string; createdBy: string }
): Promise<BiAnalysis> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("缺少分析看板名称");
  const widgets = normalizeWidgets(input.widgets);
  const ids = new Set(widgets.map((w) => w.widgetId));
  const filters = normalizeFilters(input.filters, ids);
  const layout = normalizeLayout(input.layout, ids);
  const now = new Date().toISOString();
  const analysis: BiAnalysis = {
    projectId: ctx.projectId,
    analysisId: ulid(),
    name,
    description: input.description ? String(input.description) : undefined,
    widgets,
    filters,
    layout,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.BI_ANALYSES, Item: analysis }));
  return analysis;
}

export async function updateAnalysis(
  projectId: string,
  analysisId: string,
  patch: { name?: string; description?: string; widgets?: any; filters?: any; layout?: any },
  expectedVersion: number
): Promise<BiAnalysis> {
  // widgets/filters/layout 相互依赖(filter.scope、layout.i 引用 widgetId)。若本次改了 widgets 用新集合,
  // 否则用库里当前的 widgetIds 校验 filters/layout 引用完整性。
  let widgetIds: Set<string>;
  let normalizedWidgets: BiWidget[] | undefined;
  if (patch.widgets !== undefined) {
    normalizedWidgets = normalizeWidgets(patch.widgets);
    widgetIds = new Set(normalizedWidgets.map((w) => w.widgetId));
  } else {
    const cur = await getAnalysis(projectId, analysisId);
    widgetIds = new Set((cur?.widgets || []).map((w) => w.widgetId));
  }

  const sets: string[] = ["updatedAt = :now", "version = :nextV"];
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":curV": expectedVersion,
    ":nextV": expectedVersion + 1,
  };
  const names: Record<string, string> = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("分析看板名称不能为空");
    sets.push("#nm = :nm");
    values[":nm"] = n;
    names["#nm"] = "name";
  }
  if (patch.description !== undefined) {
    sets.push("description = :ds");
    values[":ds"] = patch.description ? String(patch.description) : "";
  }
  if (normalizedWidgets !== undefined) {
    sets.push("widgets = :wg");
    values[":wg"] = normalizedWidgets;
  }
  if (patch.filters !== undefined) {
    sets.push("filters = :ft");
    values[":ft"] = normalizeFilters(patch.filters, widgetIds);
  }
  if (patch.layout !== undefined) {
    sets.push("#ly = :ly");
    values[":ly"] = normalizeLayout(patch.layout, widgetIds);
    names["#ly"] = "layout";
  }

  try {
    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BI_ANALYSES,
        Key: { projectId, analysisId },
        UpdateExpression: "SET " + sets.join(", "),
        ConditionExpression: "version = :curV",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    return Attributes as BiAnalysis;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") throw new OptimisticLockError();
    throw e;
  }
}

export async function deleteAnalysis(projectId: string, analysisId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.BI_ANALYSES, Key: { projectId, analysisId } }));
}
