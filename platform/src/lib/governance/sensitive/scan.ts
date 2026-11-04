// 敏感数据识别扫描服务。
//
// 流程：introspectSchema 拉列元数据 → 对每张表一次抽样 SELECT（LIMIT N）→ 读回后在内存
// 逐列跑注册表里全部检测器 → 取置信度最高者为主建议 → 写 findings（只存元数据）。
//
// 安全红线：
//  1) 只读（SELECT + LIMIT），统一 admin 身份仅为稳定读权限。
//  2) 标识符（schema/table/column）严格白名单 + 双引号包裹，防 SQL 注入（照抄质量引擎）。
//  3) **抽样到的敏感值只在内存用于算命中率，绝不落库 / 不出日志 / 不进 API 返回**——findings
//     只存列名、类型、检测器 id、命中率、置信度等元数据。
//  4) 单表失败（表不存在/无权限）记 status:error，不影响其它表（错误隔离）。
//  5) 扫描器只产出建议，采纳（写分级）是独立的人工动作（adopt.ts / API）。

// 裸客户端 / 落点 / 轮询收编进 `lib/redshift/direct-query.ts`
import {
  directQueryRaw,
  resolveDirectQueryPlaceSafe,
  type DirectQueryPlace,
  type DirectQueryScope,
  type DirectQueryUnavailable,
} from "@/lib/redshift/direct-query";
import { PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { introspectSchema, type SchemaTable } from "@/lib/genbi/schema";
import {
  getClassificationsForTable,
  upsertClassification,
  isSensitivityLevel,
  isMaskStrategy,
  type SensitivityLevel,
  type MaskStrategy,
} from "@/lib/governance/classification";
import { DETECTORS } from "./registry";
import type { DetectorContext } from "./types";
// 数仓落点唯一出口(收编兜底字面量)。

const DATABASE = process.env.REDSHIFT_DATABASE || "dev";

const SAMPLE_N = 200; // 每表抽样行数（服务端常量，不接受用户输入）
const MIN_CONFIDENCE = 0.5; // 低于此不产出建议（降噪）
const HIGH_BAND = 0.8; // 高置信档
const MAX_TABLES_PER_SCAN = 60; // 单次扫描表数上限（成本护栏；超出记 skipped）

// Redshift OM FQN 约定：bgp-redshift.<db>.<schema>.<table>
const RS_SERVICE = "bgp-redshift";
function toFqn(schema: string, table: string): string {
  return `${RS_SERVICE}.${DATABASE}.${schema}.${table}`;
}

// ─── SQL 注入防护（照抄 lib/quality/templates.ts）────────────────────────────────
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function safeIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) throw new Error(`非法标识符: ${JSON.stringify(name)}`);
  return `"${name}"`;
}


// 结果单元格 → 字符串（抽样值统一字符串化后交给检测器；仅内存使用）。
function cellToStr(cell: any): string {
  if (!cell || cell.isNull) return "";
  if (cell.stringValue !== undefined) return String(cell.stringValue);
  if (cell.longValue !== undefined) return String(cell.longValue);
  if (cell.doubleValue !== undefined) return String(cell.doubleValue);
  if (cell.booleanValue !== undefined) return String(cell.booleanValue);
  return "";
}

// 对一张表执行抽样 SELECT，返回 { columnName: sampleValues[] }。抛错由调用方按 error 隔离。
async function sampleTable(
  schema: string,
  table: string,
  columns: string[],
  place: DirectQueryPlace
): Promise<Record<string, string[]>> {
  // 只 SELECT 明确列（列名经白名单校验），不使用 SELECT *（列顺序可控、可映射）。
  const safeCols = columns.map(safeIdent);
  const sql = `SELECT ${safeCols.join(", ")} FROM ${safeIdent(schema)}.${safeIdent(table)} LIMIT ${SAMPLE_N}`;
  // 静态归类:**governance-read**(平台级只读受控全局读者)。
  // 🔴 **刻意不传 project**,而且这是合同规定的:50 SPEC §3.9 case "governance-read" 原文
  //    「🔴 【绝不】走 lookupProjectSecretArn(它们本无 project ⇒ 会被误判 fail-closed)」。
  //    敏感扫描要跨全部 schema 抽样,per-project 身份看不到别人的表 = 扫描直接判死
  //    (那正是 52 P0-3 要防的失败模式)。
  // 🔴 轮询预算保持**该站点原值 40 × 600ms**(别处是 50 × 700ms)—— 统一了就是悄悄改「多久算超时」,
  //    而抽样 SQL 的快慢直接决定扫描结果多寡,那种变化极难归因(见 direct-query.ts 的 DirectQueryPoll)。
  const raw = await directQueryRaw(place, sql, {
    rounds: 40,
    intervalMs: 600,
    timeoutMessage: "抽样查询超时",
  });
  const out: Record<string, string[]> = {};
  raw.columns.forEach((n) => (out[n] = []));
  for (const rec of raw.records) {
    raw.columns.forEach((n, idx) => {
      const s = cellToStr((rec as unknown[])[idx]);
      if (s !== "") out[n].push(s);
    });
  }
  return out;
}

// ─── 单列识别：跑注册表全部检测器，取置信度最高者为主建议 ──────────────────────────
export interface ColumnFinding {
  fqn: string;
  column: string;
  columnType: string;
  detectorId: string;
  detectorLabel: string;
  detectorRegion: string;
  category: string;
  suggestedLevel: string;
  suggestedMask: string;
  confidence: number;
  band: "high" | "med";
  hitRate?: number;
  evidence: {
    nameMatched?: boolean;
    valueHitRate?: number;
    method: string;
    alternatives?: Array<{ detectorId: string; confidence: number }>;
  };
  alreadyClassified: boolean;
  currentLevel?: string;
  currentMask?: string;
}

function detectColumn(
  fqn: string,
  columnName: string,
  columnType: string,
  sampleValues: string[]
): Omit<ColumnFinding, "alreadyClassified" | "currentLevel" | "currentMask"> | null {
  const ctx: DetectorContext = { columnName, columnType, sampleValues };
  const hits = DETECTORS.map((d) => ({ d, m: d.detect(ctx) }))
    .filter((x): x is { d: (typeof DETECTORS)[number]; m: NonNullable<ReturnType<(typeof DETECTORS)[number]["detect"]>> } => x.m !== null)
    .sort((a, b) => b.m.confidence - a.m.confidence);
  if (!hits.length) return null;
  const top = hits[0];
  if (top.m.confidence < MIN_CONFIDENCE) return null;
  const alternatives = hits.slice(1, 4).map((h) => ({ detectorId: h.d.id, confidence: round(h.m.confidence, 2) }));
  return {
    fqn,
    column: columnName,
    columnType,
    detectorId: top.d.id,
    detectorLabel: top.d.label,
    detectorRegion: top.d.region,
    category: top.d.category,
    suggestedLevel: top.d.suggestedLevel,
    suggestedMask: top.d.suggestedMask,
    confidence: round(top.m.confidence, 2),
    band: top.m.confidence >= HIGH_BAND ? "high" : "med",
    ...(top.m.hitRate !== undefined ? { hitRate: round(top.m.hitRate, 2) } : {}),
    evidence: {
      ...top.m.evidence,
      ...(alternatives.length ? { alternatives } : {}),
    },
  };
}

function round(n: number, d = 0): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ─── 扫描运行 ────────────────────────────────────────────────────────────────
export interface ScanSummary {
  scanId: string;
  /**
   * 这次扫描**在哪个区**扫的(落点章)。
   * 🔴 原来 summary 不带它,而「最近一次扫描」是全表取最新 ⇒ 两个区各扫一次之后,
   *    在 A 区视角会读到 B 区的结果(串区)。存量没有它的行 = 落点改必填之前的扫描,当时只有主控区能扫 ⇒ 视为 tgt_home。
   */
  targetId: string;
  database: string;
  schema?: string;
  tablesScanned: number;
  tablesSkipped: number;
  tablesErrored: number;
  columnsScanned: number;
  findingsHigh: number;
  findingsMed: number;
  scannedBy?: string;
  ts: string;
}

export interface ScanResult {
  summary: ScanSummary;
  findings: ColumnFinding[];
  errors: Array<{ fqn: string; error: string }>;
}

// 🔴 `scope` 缺省 = 主控区(与收编前逐字节等价);传了非 home 就扫**那个区的数仓**。
// 🔴 静态归类仍是 **governance-read**:home 分支不传 projectId(敏感扫描要跨全部 schema 抽样,
//    per-project 身份看不到别人的表 = 扫描直接判死,合同原话见 direct-query.ts 规矩 ②)。
export async function runSensitiveScan(input: {
  database?: string;
  schema?: string;
  tables?: string[]; // 可选：仅扫这些表（"schema.table" 或裸表名）
  scannedBy?: string;
  /** 必填(原来可省 = 主控区) */
  scope: DirectQueryScope;
}): Promise<ScanResult | DirectQueryUnavailable> {
  const pre = await resolveDirectQueryPlaceSafe(input.scope);
  if (pre.capability === "unavailable") return pre;
  const place = pre.place;
  const database = input.database || place.database;
  const scanId = ulid();
  const ts = new Date().toISOString();

  // 1) 拉列元数据。
  let allTables: SchemaTable[] = await introspectSchema(place.workgroup, database, { targetId: place.targetId, project: input.scope.projectId });

  // 2) 过滤（schema / tables）。
  if (input.schema) allTables = allTables.filter((t) => t.schema === input.schema);
  if (input.tables?.length) {
    const want = new Set(input.tables.map((t) => t.toLowerCase()));
    allTables = allTables.filter(
      (t) => want.has(`${t.schema}.${t.table}`.toLowerCase()) || want.has(t.table.toLowerCase())
    );
  }
  allTables = allTables.filter((t) => t.columns.length > 0);

  const tablesSkipped = Math.max(0, allTables.length - MAX_TABLES_PER_SCAN);
  const scanTables = allTables.slice(0, MAX_TABLES_PER_SCAN);

  // 3) 逐表抽样 + 识别（并发，错误隔离）。
  const findings: ColumnFinding[] = [];
  const errors: Array<{ fqn: string; error: string }> = [];
  let columnsScanned = 0;
  let tablesErrored = 0;

  await Promise.all(
    scanTables.map(async (t) => {
      const fqn = toFqn(t.schema, t.table);
      try {
        const colNames = t.columns.map((c) => c.name);
        const samples = await sampleTable(t.schema, t.table, colNames, { ...place, database });
        const existing = await getClassificationsForTable(fqn).catch(() => []);
        const existingByCol = new Map(existing.filter((e) => e.column !== "__table__").map((e) => [e.column.toLowerCase(), e]));
        for (const col of t.columns) {
          columnsScanned++;
          const f = detectColumn(fqn, col.name, col.type, samples[col.name] || []);
          if (!f) continue;
          const cur = existingByCol.get(col.name.toLowerCase());
          findings.push({
            ...f,
            alreadyClassified: !!cur,
            ...(cur ? { currentLevel: cur.level, currentMask: cur.maskStrategy } : {}),
          });
        }
      } catch (e: any) {
        tablesErrored++;
        errors.push({ fqn, error: e?.message || String(e) });
      }
    })
  );

  const findingsHigh = findings.filter((f) => f.band === "high").length;
  const findingsMed = findings.filter((f) => f.band === "med").length;
  const summary: ScanSummary = {
    scanId,
    targetId: place.targetId,
    database,
    ...(input.schema ? { schema: input.schema } : {}),
    tablesScanned: scanTables.length,
    tablesSkipped,
    tablesErrored,
    columnsScanned,
    findingsHigh,
    findingsMed,
    ...(input.scannedBy ? { scannedBy: input.scannedBy } : {}),
    ts,
  };

  // 4) 持久化：每条 finding 一行 + 一条 summary。**只写元数据，不写抽样值。**
  const ttl = Math.floor(new Date(ts).getTime() / 1000) + 90 * 24 * 3600; // 90 天
  await Promise.all([
    ...findings.map((f) =>
      docClient.send(
        new PutCommand({
          TableName: TABLES.SENSITIVE_FINDINGS,
          Item: { scanId, sk: `finding#${f.fqn}#${f.column}`, kind: "finding", adopted: false, ts, ttl, ...f },
        })
      )
    ),
    docClient.send(
      new PutCommand({
        TableName: TABLES.SENSITIVE_FINDINGS,
        Item: { sk: "__summary__", kind: "summary", ttl, ...summary },
      })
    ),
  ]);

  return { summary, findings, errors };
}

// ─── 读取：某次扫描 / 最近一次扫描 ─────────────────────────────────────────────
export async function getScan(scanId: string): Promise<ScanResult | null> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.SENSITIVE_FINDINGS,
      KeyConditionExpression: "scanId = :s",
      ExpressionAttributeValues: { ":s": scanId },
    })
  );
  const summary = (Items as any[]).find((i) => i.kind === "summary");
  if (!summary) return null;
  const findings = (Items as any[]).filter((i) => i.kind === "finding") as ColumnFinding[];
  return { summary: summary as ScanSummary, findings, errors: [] };
}

// 最近一次扫描：低频低量，Scan + 内存取最大 scanId（ulid 时间有序）。
// 🔴 **按区取**(落点必填):原来是全表取最新 ⇒ 两个区各扫一次
//   (尤其定时扫描上线之后,这是常态)就会在 A 区视角读到 B 区的扫描结果。
//   存量 summary 没有 `targetId` = 落点改必填之前的扫描(当时只有主控区能扫)⇒ 归 `tgt_home`。
//   Scan 要翻页扫完:Filter 在读之后生效,只读第一页会静默漏掉更新的那次扫描。
export async function getLatestScan(scope: { targetId: string }): Promise<ScanResult | null> {
  const want = scope.targetId;
  const items: any[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await docClient.send(
      new ScanCommand({
        TableName: TABLES.SENSITIVE_FINDINGS,
        FilterExpression: "kind = :k",
        ExpressionAttributeValues: { ":k": "summary" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    items.push(...((r.Items ?? []) as any[]));
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  const mine = items.filter((i) => (typeof i.targetId === "string" && i.targetId ? i.targetId : "tgt_home") === want);
  if (!mine.length) return null;
  const latest = mine.sort((a, b) => (a.scanId < b.scanId ? 1 : -1))[0];
  return getScan(latest.scanId);
}

// ─── 采纳（写入分级）─────────────────────────────────────────────────────────
// 扫描器只产出建议；采纳是独立的人工动作：把选中的建议写入 bgp-data-classification，
// 并把对应 finding 标记 adopted=true（供 UI 显示"已采纳"，避免重复）。建议的 level/mask
// 可被用户在 UI 覆盖（这里以传入值为准，回退到建议默认值）。
export interface AdoptItem {
  fqn: string;
  column: string;
  level?: string; // 覆盖建议 level；缺省用 finding 的 suggestedLevel
  category?: string;
  maskStrategy?: string; // 覆盖建议 mask
}

export interface AdoptResult {
  adopted: number;
  skipped: Array<{ fqn: string; column: string; reason: string }>;
}

export async function adoptFindings(
  scanId: string,
  items: AdoptItem[],
  actor?: string
): Promise<AdoptResult> {
  const scan = await getScan(scanId);
  if (!scan) throw new Error("扫描记录不存在或已过期");
  const byKey = new Map(scan.findings.map((f) => [`${f.fqn}#${f.column}`, f]));

  const skipped: AdoptResult["skipped"] = [];
  let adopted = 0;

  for (const it of items) {
    const key = `${it.fqn}#${it.column}`;
    const finding = byKey.get(key);
    if (!finding) {
      skipped.push({ fqn: it.fqn, column: it.column, reason: "该建议不在此次扫描结果中" });
      continue;
    }
    // 采纳值：优先用户覆盖，回退建议默认；非法值拒绝该条（不阻断其它条）。
    const level = (it.level ?? finding.suggestedLevel) as string;
    const mask = (it.maskStrategy ?? finding.suggestedMask) as string;
    if (!isSensitivityLevel(level)) {
      skipped.push({ fqn: it.fqn, column: it.column, reason: `非法级别 ${level}` });
      continue;
    }
    if (!isMaskStrategy(mask)) {
      skipped.push({ fqn: it.fqn, column: it.column, reason: `非法脱敏策略 ${mask}` });
      continue;
    }
    try {
      await upsertClassification({
        fqn: it.fqn,
        column: it.column,
        level: level as SensitivityLevel,
        category: it.category ?? finding.category,
        maskStrategy: mask as MaskStrategy,
        classifiedBy: actor,
      });
      // 标记 finding 已采纳（best-effort，失败不影响分级已写入）。
      await docClient
        .send(
          new UpdateCommand({
            TableName: TABLES.SENSITIVE_FINDINGS,
            Key: { scanId, sk: `finding#${it.fqn}#${it.column}` },
            UpdateExpression: "SET adopted = :t",
            ExpressionAttributeValues: { ":t": true },
          })
        )
        .catch(() => {});
      adopted++;
    } catch (e: any) {
      skipped.push({ fqn: it.fqn, column: it.column, reason: e?.message || "写入失败" });
    }
  }
  return { adopted, skipped };
}
