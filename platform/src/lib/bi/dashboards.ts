// 仪表盘 CRUD(bgp-bi-dashboards)。键式隔离:pk=projectId, sk=dashboardId(ULID)。
// 布局(引用 widget)+ 筛选器内嵌;更新走 version 乐观锁。widget 为弱引用(不做外键约束)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { BiDashboard, DashboardFilter, DashboardLayoutItem } from "./types";
import { OptimisticLockError } from "./reports";

export { OptimisticLockError };

const FILTER_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/i;

function normalizeLayout(input: any): DashboardLayoutItem[] {
  if (!Array.isArray(input)) return [];
  const out: DashboardLayoutItem[] = [];
  for (const it of input) {
    const i = String(it?.i || "").trim();
    if (!i) continue; // 无 reportId 引用则跳过
    out.push({
      i,
      x: Number.isFinite(Number(it?.x)) ? Number(it.x) : 0,
      y: Number.isFinite(Number(it?.y)) ? Number(it.y) : 0,
      w: clampSpan(Number(it?.w)),
      h: Number.isFinite(Number(it?.h)) && Number(it.h) > 0 ? Number(it.h) : 1,
    });
  }
  return out;
}

// antd 24 栅格制:占列宽夹到 [1,24],缺省 8。
function clampSpan(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return 8;
  return Math.min(24, Math.max(1, Math.round(w)));
}

function normalizeFilters(input: any): DashboardFilter[] {
  if (!Array.isArray(input)) return [];
  const out: DashboardFilter[] = [];
  const seen = new Set<string>();
  for (const f of input) {
    const key = String(f?.key || "").trim();
    if (!FILTER_KEY_RE.test(key)) throw new Error(`筛选器 key 非法:${key || "(空)"}(仅字母/数字/下划线,字母开头)`);
    if (seen.has(key.toLowerCase())) throw new Error(`筛选器 key 重复:${key}`);
    seen.add(key.toLowerCase());
    const type = f?.type === "select" ? "select" : "date";
    const filter: DashboardFilter = { key, label: String(f?.label || key), type };
    if (type === "select") {
      const options = Array.isArray(f?.options) ? f.options.map((o: any) => String(o)).filter(Boolean) : [];
      if (!options.length) throw new Error(`下拉筛选器「${filter.label}」需要至少一个选项`);
      filter.options = options.slice(0, 200);
    }
    if (f?.default !== undefined && f.default !== null && f.default !== "") filter.default = String(f.default);
    out.push(filter);
  }
  return out;
}

export async function listDashboards(projectId: string): Promise<BiDashboard[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.BI_DASHBOARDS,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
      ScanIndexForward: false,
    })
  );
  return Items as BiDashboard[];
}

export async function getDashboard(projectId: string, dashboardId: string): Promise<BiDashboard | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.BI_DASHBOARDS, Key: { projectId, dashboardId } })
  );
  return (Item as BiDashboard) || null;
}

export async function createDashboard(
  input: { name?: string; description?: string; layout?: any; filters?: any },
  ctx: { projectId: string; createdBy: string }
): Promise<BiDashboard> {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("缺少仪表盘名称");
  const layout = normalizeLayout(input.layout);
  const filters = normalizeFilters(input.filters);
  const now = new Date().toISOString();
  const dashboard: BiDashboard = {
    projectId: ctx.projectId,
    dashboardId: ulid(),
    name,
    description: input.description ? String(input.description) : undefined,
    layout,
    filters,
    createdBy: ctx.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.BI_DASHBOARDS, Item: dashboard }));
  return dashboard;
}

export async function updateDashboard(
  projectId: string,
  dashboardId: string,
  patch: { name?: string; description?: string; layout?: any; filters?: any },
  expectedVersion: number
): Promise<BiDashboard> {
  const sets: string[] = ["updatedAt = :now", "version = :nextV"];
  const values: Record<string, unknown> = {
    ":now": new Date().toISOString(),
    ":curV": expectedVersion,
    ":nextV": expectedVersion + 1,
  };
  const names: Record<string, string> = {};
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new Error("仪表盘名称不能为空");
    sets.push("#nm = :nm");
    values[":nm"] = n;
    names["#nm"] = "name";
  }
  if (patch.description !== undefined) {
    sets.push("description = :ds");
    values[":ds"] = patch.description ? String(patch.description) : "";
  }
  if (patch.layout !== undefined) {
    sets.push("layout = :ly");
    values[":ly"] = normalizeLayout(patch.layout);
  }
  if (patch.filters !== undefined) {
    sets.push("filters = :ft");
    values[":ft"] = normalizeFilters(patch.filters);
  }

  try {
    const { Attributes } = await docClient.send(
      new UpdateCommand({
        TableName: TABLES.BI_DASHBOARDS,
        Key: { projectId, dashboardId },
        UpdateExpression: "SET " + sets.join(", "),
        ConditionExpression: "version = :curV",
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
    return Attributes as BiDashboard;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") throw new OptimisticLockError();
    throw e;
  }
}

export async function deleteDashboard(projectId: string, dashboardId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.BI_DASHBOARDS, Key: { projectId, dashboardId } }));
}
