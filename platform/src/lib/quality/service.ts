// 模块 19 — 数据质量服务 (v1.10.0)
//
// 规则 CRUD + 运行引擎：对 Redshift 执行模板生成的校验 SQL（统一 admin 身份，复用 v1.6.1），
// 判定每条规则、计算质量评分（加权通过率 + 维度分）与 SLA（新鲜度违约），写结果与历史。

// @kf-batch 50-WP2-directquery —— 裸客户端 + 自带轮询已收编进 `lib/redshift/direct-query.ts`
import {
  directQueryRaw,
  resolveDirectQueryPlaceSafe,
  type DirectQueryPlace,
  type DirectQueryScope,
  type DirectQueryUnavailable,
} from "@/lib/redshift/direct-query";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import {
  buildCheckSql,
  evaluateRule,
  validateRuleInput,
  getTemplateMeta,
  type RuleSpec,
  type ResultRow,
  type RuleStatus,
  type Severity,
  type QualityDimension,
} from "./templates";


export interface QualityRule {
  fqn: string;
  ruleId: string;
  type: string;
  column?: string;
  params: Record<string, unknown>;
  severity: Severity;
  weight: number;
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

const round = (n: number, d = 0): number => {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
};


// ─── 规则 CRUD ───────────────────────────────────────────────────────────────
export async function listRules(fqn: string): Promise<QualityRule[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.QUALITY_RULES,
      KeyConditionExpression: "fqn = :f",
      ExpressionAttributeValues: { ":f": fqn },
    })
  );
  return Items as QualityRule[];
}

export async function createRule(
  fqn: string,
  input: { type?: string; column?: string; params?: Record<string, unknown>; severity?: string; weight?: number },
  actor?: string
): Promise<QualityRule> {
  // Validate type/column/params (also surfaces identifier/param errors by building the SQL).
  const norm = validateRuleInput({ type: input.type, column: input.column, params: input.params, fqn });
  const severity: Severity = input.severity === "warn" ? "warn" : "error";
  const weight = Number.isFinite(Number(input.weight)) && Number(input.weight) > 0 ? Number(input.weight) : 1;
  const now = new Date().toISOString();
  const rule: QualityRule = {
    fqn,
    ruleId: ulid(),
    type: norm.type,
    ...(norm.column ? { column: norm.column } : {}),
    params: norm.params,
    severity,
    weight,
    enabled: true,
    ...(actor ? { createdBy: actor } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.QUALITY_RULES, Item: rule }));
  return rule;
}

export async function getRule(fqn: string, ruleId: string): Promise<QualityRule | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.QUALITY_RULES, Key: { fqn, ruleId } })
  );
  return (Item as QualityRule) || null;
}

export async function updateRule(
  fqn: string,
  ruleId: string,
  patch: { params?: Record<string, unknown>; severity?: string; weight?: number; enabled?: boolean }
): Promise<QualityRule | null> {
  const current = await getRule(fqn, ruleId);
  if (!current) return null;
  // Re-validate params against the existing type/column when params change.
  if (patch.params !== undefined) {
    validateRuleInput({ type: current.type, column: current.column, params: patch.params, fqn });
  }
  const sets: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  const names: Record<string, string> = {};
  if (patch.params !== undefined) { sets.push("params = :p"); values[":p"] = patch.params; }
  if (patch.severity !== undefined) { sets.push("severity = :s"); values[":s"] = patch.severity === "warn" ? "warn" : "error"; }
  if (patch.weight !== undefined && Number(patch.weight) > 0) { sets.push("weight = :w"); values[":w"] = Number(patch.weight); }
  if (patch.enabled !== undefined) { sets.push("#en = :e"); values[":e"] = !!patch.enabled; names["#en"] = "enabled"; }
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.QUALITY_RULES,
      Key: { fqn, ruleId },
      UpdateExpression: "SET " + sets.join(", "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return (Attributes as QualityRule) || null;
}

export async function deleteRule(fqn: string, ruleId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.QUALITY_RULES, Key: { fqn, ruleId } }));
}

// ─── Redshift 执行 ───────────────────────────────────────────────────────────
function coerceCell(cell: any): number | null {
  if (!cell || cell.isNull) return null;
  if (cell.longValue !== undefined) return Number(cell.longValue);
  if (cell.doubleValue !== undefined) return Number(cell.doubleValue);
  if (cell.stringValue !== undefined) {
    const n = Number(cell.stringValue);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Execute a single-row check SQL and return its row as { alias: number|null }. Throws on error.
// @kf-batch 50-WP2-directquery
// 🔴 收编:落点 / 客户端 / 轮询三件全部交给 `directQuery`(单一作者)。本函数只留**行形状** ——
//    质量的归一口径是「非数字字符串 ⇒ null」,与指标那边(原样返回字符串)**不同**,
//    所以归一必须留在各自领域里,不能上提(见 direct-query.ts 规矩 ①)。
// 🔴 `scope` 缺省 = 主控区 ⇒ 与收编前**逐字节等价**(home 分支不传 projectId,静态归类仍是 governance-read)。
// 🔴 落点在 `runChecks` 里**解析一次**、传进来:一次请求 N 条规则,解析 N 次等于 N 次注册表强一致读,
//    而且「该区没装数仓」这件事会在 N 条规则上各报一次(页面看起来像"规则全炸了")。
async function execCheck(sql: string, place: DirectQueryPlace): Promise<ResultRow> {
  const r = await directQueryRaw(place, sql);
  const rec = r.records[0] || [];
  const row: ResultRow = {};
  r.columns.forEach((n, idx) => { row[n] = coerceCell(rec[idx]); });
  return row;
}

// ─── 运行引擎 + 评分 ──────────────────────────────────────────────────────────
export interface RuleResult {
  ruleId: string;
  type: string;
  column?: string;
  dimension: QualityDimension;
  severity: Severity;
  weight: number;
  status: RuleStatus;
  metric: number | null;
  total?: number;
  failed?: number;
  detail: string;
  hours?: number;
  slaHours?: number;
}

export interface RunSummary {
  runId: string;
  score: number | null;
  dimensions: Partial<Record<QualityDimension, number>>;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  slaBreached: boolean;
  ts: string;
}

// @kf-batch 50-WP2-directquery
// 🔴 @kf-batch 50-WP31-place-first-class:`scope.targetId` 必填(原来缺省 = 主控区)。在**那个区的数仓**上跑这批规则。
// 🔴 「该区没装数仓」**不是规则执行失败** —— 把它塞进 `status:"error"` 会让页面显示
//    「17 条规则全部执行失败」,用户会去查 SQL;正确呈现是整页降级(路由把 `unavailable` 透传出去)。
export async function runChecks(
  fqn: string,
  scope: DirectQueryScope
): Promise<{ summary: RunSummary; results: RuleResult[] } | DirectQueryUnavailable> {
  const rules = (await listRules(fqn)).filter((r) => r.enabled);
  if (!rules.length) throw new Error("该表暂无启用的质量规则");
  // @kf-batch 50-WP2-directquery —— 落点解析一次;「该区没装数仓」⇒ 整体降级(见函数头注释)
  const pre = await resolveDirectQueryPlaceSafe(scope);
  if (pre.capability === "unavailable") return pre;
  const place = pre.place;
  const runId = ulid();
  const ts = new Date().toISOString();

  const results: RuleResult[] = await Promise.all(
    rules.map(async (rule): Promise<RuleResult> => {
      const meta = getTemplateMeta(rule.type);
      const dimension = (meta?.dimension || "validity") as QualityDimension;
      const base = { ruleId: rule.ruleId, type: rule.type, column: rule.column, dimension, severity: rule.severity, weight: rule.weight };
      try {
        const spec: RuleSpec = { type: rule.type, column: rule.column, params: rule.params };
        const row = await execCheck(buildCheckSql(fqn, spec), place);
        const ev = evaluateRule(spec, row);
        return { ...base, status: ev.status, metric: ev.metric, total: ev.total, failed: ev.failed, detail: ev.detail, hours: ev.hours, slaHours: ev.slaHours };
      } catch (e: any) {
        return { ...base, status: "error", metric: null, detail: `执行失败: ${e.message}` };
      }
    })
  );

  // Weighted pass-rate over executed (non-error) rules; per-dimension breakdown.
  let num = 0, den = 0, passed = 0, failed = 0, errors = 0;
  const dimAgg: Partial<Record<QualityDimension, { num: number; den: number }>> = {};
  let slaBreached = false;
  for (const r of results) {
    if (r.status === "error") { errors++; continue; }
    den += r.weight;
    if (r.status === "passed") { num += r.weight; passed++; } else { failed++; }
    const da = (dimAgg[r.dimension] ||= { num: 0, den: 0 });
    da.den += r.weight;
    if (r.status === "passed") da.num += r.weight;
    if (r.type === "freshness" && r.status === "failed") slaBreached = true;
  }
  const dimensions: Partial<Record<QualityDimension, number>> = {};
  for (const [dim, agg] of Object.entries(dimAgg)) {
    if (agg && agg.den > 0) dimensions[dim as QualityDimension] = round((agg.num / agg.den) * 100);
  }
  const summary: RunSummary = {
    runId,
    score: den > 0 ? round((num / den) * 100) : null,
    dimensions,
    passed,
    failed,
    errors,
    total: results.length,
    slaBreached,
    ts,
  };

  // Persist: one row per rule result + one summary row.
  await Promise.all([
    ...results.map((r) =>
      docClient.send(
        new PutCommand({ TableName: TABLES.QUALITY_RESULTS, Item: { fqn, sk: `${runId}#${r.ruleId}`, runId, kind: "result", ts, ...r } })
      )
    ),
    docClient.send(
      new PutCommand({ TableName: TABLES.QUALITY_RESULTS, Item: { fqn, sk: `${runId}#__summary__`, kind: "summary", ...summary } })
    ),
  ]);

  return { summary, results };
}

// ─── 结果 / 趋势读取 ──────────────────────────────────────────────────────────
export async function getResults(
  fqn: string,
  withHistory = false
): Promise<{ summary: RunSummary | null; results: RuleResult[]; trend: Array<{ runId: string; score: number | null; ts: string; slaBreached: boolean }> }> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.QUALITY_RESULTS,
      KeyConditionExpression: "fqn = :f",
      ExpressionAttributeValues: { ":f": fqn },
      ScanIndexForward: false, // newest runId first
      Limit: 400,
    })
  );
  const summaries = (Items as any[]).filter((i) => i.kind === "summary").sort((a, b) => (a.runId < b.runId ? 1 : -1));
  const latest = summaries[0] || null;
  const results = latest
    ? (Items as any[]).filter((i) => i.kind === "result" && i.runId === latest.runId)
    : [];
  const trend = withHistory
    ? summaries.slice(0, 10).map((s) => ({ runId: s.runId, score: s.score ?? null, ts: s.ts, slaBreached: !!s.slaBreached }))
    : [];
  return { summary: latest, results: results as RuleResult[], trend };
}
