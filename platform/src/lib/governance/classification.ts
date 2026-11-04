// 模块 18 — 数据分级分类 + 权限授权 (v1.9.0)
//
// Control-plane store (DynamoDB) for table/column sensitivity classification and per-user
// data-access grants. The masking layer (masking.ts) reads these to decide what to mask;
// the access-request flow (reusing bgp-approvals) writes grants on approval.

import { GetCommand, PutCommand, QueryCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

export type SensitivityLevel = "L1" | "L2" | "L3" | "L4";
export type MaskStrategy = "none" | "full" | "partial" | "email" | "hash";

export const SENSITIVITY_LEVELS: SensitivityLevel[] = ["L1", "L2", "L3", "L4"];
export const MASK_STRATEGIES: MaskStrategy[] = ["none", "full", "partial", "email", "hash"];
export const TABLE_LEVEL_SK = "__table__"; // sk value for a table-level classification row

export function isSensitivityLevel(v: unknown): v is SensitivityLevel {
  return typeof v === "string" && (SENSITIVITY_LEVELS as string[]).includes(v);
}
export function isMaskStrategy(v: unknown): v is MaskStrategy {
  return typeof v === "string" && (MASK_STRATEGIES as string[]).includes(v);
}

// Order levels so the catalog can surface a table's strongest sensitivity.
const LEVEL_RANK: Record<SensitivityLevel, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
export function strongerLevel(a?: string, b?: string): SensitivityLevel | undefined {
  const ra = isSensitivityLevel(a) ? LEVEL_RANK[a] : 0;
  const rb = isSensitivityLevel(b) ? LEVEL_RANK[b] : 0;
  const max = Math.max(ra, rb);
  return (SENSITIVITY_LEVELS.find((l) => LEVEL_RANK[l] === max)) || undefined;
}

export interface ColumnClassification {
  fqn: string; // table FQN
  column: string; // column name, or TABLE_LEVEL_SK for table-level
  level: SensitivityLevel;
  category?: string;
  maskStrategy: MaskStrategy;
  classifiedBy?: string;
  updatedAt: string;
}

export interface DataGrant {
  username: string;
  fqn: string;
  grantedBy?: string;
  grantedAt: string;
  approvalId?: string;
}

// ---- Classification --------------------------------------------------------

export async function getClassificationsForTable(fqn: string): Promise<ColumnClassification[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.DATA_CLASSIFICATION,
      KeyConditionExpression: "fqn = :f",
      ExpressionAttributeValues: { ":f": fqn },
    })
  );
  return Items as ColumnClassification[];
}

export async function listAllClassifications(): Promise<ColumnClassification[]> {
  const { Items = [] } = await docClient.send(new ScanCommand({ TableName: TABLES.DATA_CLASSIFICATION }));
  return Items as ColumnClassification[];
}

// Batch-load classifications for several tables → Map<fqn, Map<columnLower, classification>>.
// Excludes the table-level (__table__) row from the per-column map (column-level drives masking).
export async function getClassificationsForTables(
  fqns: Iterable<string>
): Promise<Map<string, Map<string, ColumnClassification>>> {
  const out = new Map<string, Map<string, ColumnClassification>>();
  const unique = Array.from(new Set(Array.from(fqns)));
  await Promise.all(
    unique.map(async (fqn) => {
      const rows = await getClassificationsForTable(fqn).catch(() => [] as ColumnClassification[]);
      const cols = new Map<string, ColumnClassification>();
      for (const r of rows) {
        if (r.column === TABLE_LEVEL_SK) continue;
        cols.set(r.column.toLowerCase(), r);
      }
      out.set(fqn, cols);
    })
  );
  return out;
}

export async function upsertClassification(input: {
  fqn: string;
  column?: string;
  level: SensitivityLevel;
  category?: string;
  maskStrategy?: MaskStrategy;
  classifiedBy?: string;
}): Promise<ColumnClassification> {
  const item: ColumnClassification = {
    fqn: input.fqn,
    column: input.column || TABLE_LEVEL_SK,
    level: input.level,
    ...(input.category ? { category: input.category } : {}),
    maskStrategy: input.maskStrategy || "none",
    ...(input.classifiedBy ? { classifiedBy: input.classifiedBy } : {}),
    updatedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_CLASSIFICATION, Item: item }));
  return item;
}

export async function removeClassification(fqn: string, column: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.DATA_CLASSIFICATION, Key: { fqn, column: column || TABLE_LEVEL_SK } })
  );
}

// ---- Grants ----------------------------------------------------------------

export async function hasGrant(username: string, fqn: string): Promise<boolean> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATA_GRANTS, Key: { username, fqn } })
  );
  return !!Item;
}

// Load a user's full grant set (table FQNs) for the masking decision.
export async function getUserGrantSet(username: string): Promise<Set<string>> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.DATA_GRANTS,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
    })
  );
  return new Set((Items as DataGrant[]).map((g) => g.fqn));
}

export async function listGrants(username: string): Promise<DataGrant[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.DATA_GRANTS,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
    })
  );
  return Items as DataGrant[];
}

export async function grantAccess(
  username: string,
  fqn: string,
  grantedBy?: string,
  approvalId?: string
): Promise<DataGrant> {
  const grant: DataGrant = {
    username,
    fqn,
    ...(grantedBy ? { grantedBy } : {}),
    grantedAt: new Date().toISOString(),
    ...(approvalId ? { approvalId } : {}),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.DATA_GRANTS, Item: grant }));
  return grant;
}

export async function revokeGrant(username: string, fqn: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.DATA_GRANTS, Key: { username, fqn } }));
}
