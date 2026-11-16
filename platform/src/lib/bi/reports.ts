// 报表 widget CRUD(bgp-bi-reports)。键式隔离:pk=projectId, sk=reportId(ULID)。
// Query(pk=projectId) 天然 per-project 列表;更新走 version 乐观锁(照抄告警规则,并发一成功一 409)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import {
  BiReport,
  WidgetSource,
  WidgetViz,
  BiChartType,
  BI_CHART_TYPES,
  BI_ENGINES,
  BiEngine,
} from "./types";

// 并发冲突(乐观锁)专用错误,route 层据此返回 409。
export class OptimisticLockError extends Error {
  constructor() {
    super("报表已被他人修改，请刷新后重试");
    this.name = "OptimisticLockError";
  }
}

/**
 * 读出视觉对象的落点章(在哪个区取数)并校验:没给 ⇒ 空串(由调用方决定是不写字段还是拒绝);
 * 给了就必须是合法的执行环境 id,**原样返回**供存下来。
 * 2026-11-12 真环境坐实:归一化只挑 kind / engine / sql 几个字段回写,把页面写进来的落点丢了
 * ⇒ 在某个执行区视角建的视觉对象,保存后重新打开就回到主控区取数,列表「涉及区域」也恒为主控区。
 */
function landingStampOf(input: any): string {
  const raw = input?.targetId;
  if (raw === undefined || raw === null || raw === "") return "";
  if (!isValidTargetId(raw)) throw new Error(`取数落点非法:${JSON.stringify(raw)}(应为执行环境 id)`);
  return raw;
}

/** 指标 id 的形状(只做形状校验;指标是否存在在取数时如实报)。 */
const MODEL_METRIC_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

// 校验 + 规范化取数来源。抛出的 message 直接回前端。
// 导出:v4 分析看板的视觉对象内嵌同构的 source,复用同一校验(不重造、不改行为)。
export function normalizeSource(input: any): WidgetSource {
  const kind = input?.kind;
  if (kind === "metric") {
    const modelMetricId = String(input?.modelMetricId || "").trim();
    if (!modelMetricId) throw new Error("指标来源需要选择一个指标");
    if (!MODEL_METRIC_ID_RE.test(modelMetricId)) throw new Error("指标来源的指标 id 非法");
    // 指标来源的落点必填:存下来的视觉对象必须说清在哪个执行环境的数仓上算,缺了就拒,不默认主控区。
    const stamp = landingStampOf(input);
    if (!stamp) throw new Error("指标来源需要取数落点(在哪个执行环境的数仓上计算)");
    return { kind: "metric", modelMetricId, targetId: stamp };
  }
  if (kind === "dataapi") {
    const apiId = String(input?.apiId || "").trim();
    if (!apiId) throw new Error("数据服务来源需要 apiId");
    const params = input?.params && typeof input.params === "object" ? input.params : undefined;
    return { kind: "dataapi", apiId, ...(params ? { params } : {}) };
  }
  if (kind === "sql" || kind === "genbi") {
    const engine: BiEngine = BI_ENGINES.includes(input?.engine) ? input.engine : "redshift";
    const sql = String(input?.sql || "").trim();
    if (!sql) throw new Error("SQL 来源需要 sql");
    if (!/^(select|with)\b/i.test(sql)) throw new Error("SQL 必须是 SELECT / WITH 只读查询");
    if (sql.includes(";")) throw new Error("SQL 不允许包含分号(单语句)");
    // 这两种来源有存量行:没给落点就不写字段(= 主控区,见 WidgetSource 的说明);给了原样存。
    const stamp = landingStampOf(input);
    if (kind === "genbi") {
      const question = input?.question ? String(input.question).slice(0, 500) : undefined;
      return { kind: "genbi", engine, sql, ...(question ? { question } : {}), ...(stamp ? { targetId: stamp } : {}) };
    }
    // v2:字段配置器所建的 sql source 可带 builder spec(纯 UI 元数据,用于再编辑还原字段面板)。
    const builder = input?.builder && typeof input.builder === "object" ? input.builder : undefined;
    return { kind: "sql", engine, sql, ...(builder ? { builder } : {}), ...(stamp ? { targetId: stamp } : {}) };
  }
  throw new Error("source.kind 必须是 sql / dataapi / genbi / metric");
}

// 导出:v4 分析看板的视觉对象复用同一 viz 归一(含 v3 多系列/分组/堆叠/横向白名单)。
export function normalizeViz(input: any): WidgetViz {
  const chart: BiChartType = BI_CHART_TYPES.includes(input?.chart) ? input.chart : "table";
  const viz: WidgetViz = { chart };
  if (input?.xField) viz.xField = String(input.xField);
  if (input?.yField) viz.yField = String(input.yField);
  // v3:图表增强字段(全部可选)。不在此显式放行会被存储层静默丢弃 → 多系列/堆叠/横向失效。
  if (Array.isArray(input?.yFields)) {
    const yf = input.yFields.map((s: unknown) => String(s)).filter(Boolean).slice(0, 20);
    if (yf.length) viz.yFields = yf;
  }
  if (input?.seriesField) viz.seriesField = String(input.seriesField);
  if (input?.stack === true) viz.stack = true;
  if (input?.orient === "h") viz.orient = "h"; // 仅存非默认值(v 为默认,省略)
  if (input?.auto) viz.auto = true;
  return viz;
}

export async function listReports(projectId: string): Promise<BiReport[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.BI_REPORTS,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
      ScanIndexForward: false, // 新报表在前(reportId=ULID 时间序)
    })
  );
  return Items as BiReport[];
}

export async function getReport(projectId: string, reportId: string): Promise<BiReport | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.BI_REPORTS, Key: { projectId, reportId } })
  );
  return (Item as BiReport) || null;
}

export async function createReport(
  input: { name?: string; description?: string; source?: any; viz?: any },
  ctx: { projectId: string; createdBy: string }
): Promise<BiReport> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("缺少报表名称");
  const source = normalizeSource(input.source);
  const viz = normalizeViz(input.viz);
  const now = new Date().toISOString();
  const report: BiReport = {
    projectId: ctx.projectId,
    reportId: ulid(),
    name,
    description: input.description ? String(input.description) : undefined,
    source,
    viz,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.BI_REPORTS, Item: report }));
  return report;
}

// 部分更新 + 乐观锁。expectedVersion 由前端回传(从 GET 拿的)。
export async function updateReport(
  projectId: string,
  reportId: string,
  patch: { name?: string; description?: string; source?: any; viz?: any },
  expectedVersion: number
): Promise<BiReport> {
  const sets: string[] = ["updatedAt = :now", "version = :nextV"];
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":curV": expectedVersion,
    ":nextV": expectedVersion + 1,
  };
  const names: Record<string, string> = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("报表名称不能为空");
    sets.push("#nm = :nm");
    values[":nm"] = n;
    names["#nm"] = "name";
  }
  if (patch.description !== undefined) {
    sets.push("description = :ds");
    values[":ds"] = patch.description ? String(patch.description) : "";
  }
  if (patch.source !== undefined) {
    sets.push("#src = :src");
    values[":src"] = normalizeSource(patch.source);
    names["#src"] = "source";
  }
  if (patch.viz !== undefined) {
    sets.push("viz = :vz");
    values[":vz"] = normalizeViz(patch.viz);
  }

  try {
    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BI_REPORTS,
        Key: { projectId, reportId },
        UpdateExpression: "SET " + sets.join(", "),
        ConditionExpression: "version = :curV",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    return Attributes as BiReport;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") throw new OptimisticLockError();
    throw e;
  }
}

export async function deleteReport(projectId: string, reportId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.BI_REPORTS, Key: { projectId, reportId } }));
}
