// 模块 36 (E2) — 治理健康分 / 工作台聚合服务。
//
// 把散落的治理信号聚合成一个"治理健康总分"(0–100,加权)+ 分维度分 + 资产榜 + 待办工作台。
// **纯聚合读,零新表**:数据源全是现有表(分级/质量结果/血缘 + 最近一次敏感扫描)。表全集取自
// Redshift 物理内省(introspectSchema,真相来源,不依赖 OM 是否部署)。
//
// 维度与权重(见 design/36 §4):
//   安全/分级覆盖 0.30 · 质量健康 0.30 · SLA 达标 0.20 · 血缘完整度 0.20

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { introspectSchema } from "@/lib/genbi/schema";
import { listAllClassifications } from "@/lib/governance/classification";
// @kf-batch 50-WP4quater-reads(工单 SC-8)
import { parseScopedFqn, displayFqn } from "@/lib/governance/scoped-fqn";
import { resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { getLatestScan } from "@/lib/governance/sensitive/scan";
// @kf-batch 50-P50.1-workgroup-ssot — 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";

const WORKGROUP = homeWorkgroup();
const DATABASE = process.env.REDSHIFT_DATABASE || "dev";
const RS_SERVICE = "bgp-redshift";
const LINEAGE_TABLE = "bgp-lineage";
const QUALITY_PASS = 80; // 质量分不达标阈值

const round = (n: number): number => Math.round(n);
function fqnOf(schema: string, table: string): string {
  return `${RS_SERVICE}.${DATABASE}.${schema}.${table}`;
}

// 🔴 血缘完整度口径归一(根治"血缘完整度恒 0"):
// 表全集用 OM 约定 FQN(bgp-redshift.dev.public.players,见 fqnOf),
// 而 bgp-lineage 表存的是平台约定 FQN(redshift.dev.public.players,非前缀,见 lineage-service 注释,故意不同)。
// 两套约定的 service 段(bgp-redshift. vs redshift.)永远不相等 → lineageSet.has(t.fqn) 恒 false → 血缘维度恒 0。
// 归一:剥掉最前面的 service 段,只留 <db>.<schema>.<table> 作为比较键(bare key),对任一前缀约定免疫。
// 仅影响治理健康分的血缘维度统计,不碰任何血缘写路径 / OM / impact / lineage route。
function bareKey(fqn: string): string {
  const parts = fqn.split(".");
  // 形如 [service, db, schema, table] → 去掉首段 service;不足 4 段则原样返回(稳健)。
  return parts.length >= 4 ? parts.slice(1).join(".") : fqn;
}

// i18n:后端只出 key + params(不拼中文成品串),前端按语种 t(key, params) 渲染。
// 与模块 34 告警消息 msgKey/msgParams 同一约定 —— 面向全球用户,避免英文模式残留中文。
export interface I18nText {
  key: string;
  params?: Record<string, string | number>;
}

export interface HealthDimension {
  key: "security" | "quality" | "sla" | "lineage";
  labelKey: string; // 固定 i18n key(维度名)
  score: number; // 0–100
  weight: number;
  detail: I18nText;
}

export interface TodoItem {
  kind: "unclassified_sensitive" | "quality_below" | "sla_breach" | "ungoverned";
  fqn: string;
  detail: I18nText;
  link: string; // 跳转目标
}

export interface AssetRisk {
  fqn: string;
  table: string;
  issues: I18nText[]; // 该表的问题标签(key+params)
  qualityScore: number | null;
  classified: boolean;
}

export interface GovernanceHealth {
  score: number; // 加权总分 0–100
  dimensions: HealthDimension[];
  totals: { tables: number; columns: number; classifiedTables: number; tablesWithQuality: number; tablesWithLineage: number };
  todos: TodoItem[];
  worstAssets: AssetRisk[];
  latestScanId?: string;
  ts: string;
}

// 进程内缓存 ~60s(避免每次刷屏都全量聚合)。
// @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 缓存必须按 target 分键:
// 一个全局缓存会让「切到 us-west-2」在 60 秒内看到主控区的健康分 —— 而那个数字看起来完全正常。
const _cache = new Map<string, { at: number; data: GovernanceHealth }>();
const CACHE_MS = 60_000;

// 最近一次质量 summary(每表)。Scan summary 行,按 runId 取每表最新。
async function latestQualityByTable(wantTarget: string): Promise<Map<string, { score: number | null; slaBreached: boolean }>> {
  const out = new Map<string, { score: number | null; slaBreached: boolean; runId: string }>();
  const { Items = [] } = await docClient
    .send(new ScanCommand({ TableName: TABLES.QUALITY_RESULTS, FilterExpression: "kind = :k", ExpressionAttributeValues: { ":k": "summary" } }))
    .catch(() => ({ Items: [] as any[] }));
  for (const it of Items as any[]) {
    // 🔴 按键上的区筛:落 SC-8 之后 fqn 是 `<targetId>::<fqn>`(home 裸 fqn)。
    // 不筛的话两个区的质量结果混算成一个平均分 —— 用户的词是「串味」。
    const { fqn, targetId } = parseScopedFqn(String(it.fqn || ""));
    if (targetId !== wantTarget) continue;
    const prev = out.get(fqn);
    if (!prev || it.runId > prev.runId) out.set(fqn, { score: it.score ?? null, slaBreached: !!it.slaBreached, runId: it.runId });
  }
  const res = new Map<string, { score: number | null; slaBreached: boolean }>();
  Array.from(out.entries()).forEach(([fqn, v]) => res.set(fqn, { score: v.score, slaBreached: v.slaBreached }));
  return res;
}

// 有血缘的表集合(bgp-lineage 的 target 或 source 任一端)。
// 存 bareKey(去 service 前缀)以便与表全集(OM 约定 FQN)口径一致比较,见 bareKey 注释。
async function tablesWithLineage(wantTarget: string): Promise<Set<string>> {
  const set = new Set<string>();
  const { Items = [] } = await docClient
    .send(new ScanCommand({ TableName: LINEAGE_TABLE }))
    .catch(() => ({ Items: [] as any[] }));
  for (const it of Items as any[]) {
    // 🔴 血缘边的两端都是 scoped 键;只算**这个区**的边(否则别区的血缘会把这个区的完整度抬高)
    for (const raw of [it.targetFqn, it.sourceFqn]) {
      if (!raw) continue;
      const { fqn, targetId } = parseScopedFqn(String(raw));
      if (targetId !== wantTarget) continue;
      set.add(bareKey(fqn));
    }
  }
  return set;
}

// @kf-batch 50-WP31-place-first-class —— 落点与项目都必填:原来 `targetId?` + `|| HOME_TARGET_ID`,且非主控区不带项目
//   ⇒ `resolveRedshiftBinding` 必抛、被 `.catch(() => null)` 吞成「表全集为空」⇒ 健康分在空分母上照常算出一个看着正常的数。
export async function computeHealth(refresh: boolean, targetId: string, projectId: string | null): Promise<GovernanceHealth> {
  // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 健康分按区算。用户 2026-09-10 点名:
  // 「治理健康分依赖质量 / 血缘 / 分类三路信号,而它们的键里没有区维(按 fqn 聚合)——
  //  同名表跨区会互相顶,按区出分会串味;必须先给这三路加区维」。三路已加(scopedFqn),这里按区聚合。
  const wantTarget = targetId;
  const hit = _cache.get(wantTarget);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const ts = new Date().toISOString();

  // 1) 表全集(物理真相)——**那个区的数仓**。introspect 失败时降级为空(维度按未覆盖计)。
  // 🔴 用主控区的 workgroup 去探别的区,拿到的是主控区的表 ⇒ 分母就是错的,而分数看起来正常。
  const place = await resolveRedshiftBinding({ targetId: wantTarget, projectId: projectId ?? undefined }).catch(() => null);
  const schemaTables = place
    ? await introspectSchema(place.workgroup, place.database, {
        // 🔴 治理健康是 governance-read:主控区分支丢掉项目;非主控区按 §3.9b 必须带(原来不带 ⇒ 被吞成空表全集)
        targetId: place.targetId,
        project: projectId,
      }).catch(() => [])
    : [];
  const tables = schemaTables.map((t) => ({ fqn: fqnOf(t.schema, t.table), table: t.table, columns: t.columns.length }));
  const totalTables = tables.length;
  const totalColumns = tables.reduce((s, t) => s + t.columns, 0);
  const tableSet = new Set(tables.map((t) => t.fqn));

  // 2) 并发拉三路信号。
  const [classificationsAll, qualityMap, lineageSet, latestScan] = await Promise.all([
    listAllClassifications().catch(() => []),
    latestQualityByTable(wantTarget),
    tablesWithLineage(wantTarget),
    // @kf-batch 50-WP28-platform-action-node —— 🔴 敏感扫描也按区取(原来全表取最新 ⇒ 别的区的扫描进了本区的分)
    getLatestScan({ targetId: wantTarget }).catch(() => null),
  ]);
  // 🔴 分级也按键上的区筛,并把区前缀剥掉再比(表全集用的是不带前缀的 OM 约定 fqn)
  const classifications = classificationsAll
    .filter((c) => parseScopedFqn(String(c.fqn || "")).targetId === wantTarget)
    .map((c) => ({ ...c, fqn: displayFqn(String(c.fqn || "")) }));

  // 分级:哪些表已有(列级)分级。
  const classifiedTables = new Set<string>();
  for (const c of classifications) if (c.column !== "__table__") classifiedTables.add(c.fqn);

  // 敏感扫描:未分级的高置信 finding(治理缺口的核心信号)。
  const scanHighUnclassified = (latestScan?.findings || []).filter((f: any) => f.band === "high" && !f.alreadyClassified && !f.adopted);
  const highFindings = (latestScan?.findings || []).filter((f: any) => f.band === "high");
  const adoptedHigh = highFindings.filter((f: any) => f.adopted).length;

  // ── 维度分 ──────────────────────────────────────────────────────────────
  // 安全/分级:表级分级覆盖率 0.7 + 高置信敏感建议采纳率 0.3(有扫描时)。
  const classCoverage = totalTables > 0 ? (classifiedTables.size / totalTables) * 100 : 0;
  const adoptionRate = highFindings.length > 0 ? (adoptedHigh / highFindings.length) * 100 : 100;
  const securityScore = highFindings.length > 0 ? round(classCoverage * 0.7 + adoptionRate * 0.3) : round(classCoverage);

  // 质量:有质量结果的表的平均分。
  const qualityVals = Array.from(qualityMap.values());
  const scored = qualityVals.map((v) => v.score).filter((s): s is number => s != null);
  const qualityScore = scored.length ? round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;
  const tablesWithQuality = qualityMap.size;

  // SLA:有结果的表中未违约比例。
  const breached = qualityVals.filter((v) => v.slaBreached).length;
  const slaScore = tablesWithQuality > 0 ? round(100 - (breached / tablesWithQuality) * 100) : 100;

  // 血缘:表全集里有血缘的比例。用 bareKey 归一比较(根治 FQN 前缀约定不一致致恒 0)。
  const withLineage = tables.filter((t) => lineageSet.has(bareKey(t.fqn))).length;
  const lineageScore = totalTables > 0 ? round((withLineage / totalTables) * 100) : 0;

  const dimensions: HealthDimension[] = [
    {
      key: "security", labelKey: "安全 / 分级覆盖", score: securityScore, weight: 0.3,
      detail: highFindings.length
        ? { key: "{a}/{b} 表已分级，高危建议采纳 {c}/{d}", params: { a: classifiedTables.size, b: totalTables, c: adoptedHigh, d: highFindings.length } }
        : { key: "{a}/{b} 表已分级", params: { a: classifiedTables.size, b: totalTables } },
    },
    {
      key: "quality", labelKey: "质量健康", score: qualityScore, weight: 0.3,
      detail: scored.length ? { key: "{n} 表平均质量分", params: { n: scored.length } } : { key: "暂无质量检查结果" },
    },
    {
      key: "sla", labelKey: "SLA 达标", score: slaScore, weight: 0.2,
      detail: tablesWithQuality ? { key: "{n} 表 SLA 违约", params: { n: breached } } : { key: "暂无 SLA 规则" },
    },
    {
      key: "lineage", labelKey: "血缘完整度", score: lineageScore, weight: 0.2,
      detail: { key: "{a}/{b} 表有血缘", params: { a: withLineage, b: totalTables } },
    },
  ];
  const score = round(dimensions.reduce((s, d) => s + d.score * d.weight, 0));

  // ── 待办工作台 ───────────────────────────────────────────────────────────
  const todos: TodoItem[] = [];
  // 🔴 未分级的疑似敏感表(按表聚合高置信 finding)。
  const sensByTable = new Map<string, number>();
  for (const f of scanHighUnclassified) sensByTable.set(f.fqn, (sensByTable.get(f.fqn) || 0) + 1);
  Array.from(sensByTable.entries()).forEach(([fqn, n]) => {
    todos.push({ kind: "unclassified_sensitive", fqn, detail: { key: "{n} 个高置信敏感字段待采纳", params: { n } }, link: "/governance?tab=sensitive" });
  });
  // 🟠 质量不达标表 / 🔴 SLA 违约表。
  Array.from(qualityMap.entries()).forEach(([fqn, v]) => {
    if (v.score != null && v.score < QUALITY_PASS) todos.push({ kind: "quality_below", fqn, detail: { key: "质量分 {s} 低于 {p}", params: { s: v.score, p: QUALITY_PASS } }, link: "/governance?tab=quality" });
    if (v.slaBreached) todos.push({ kind: "sla_breach", fqn, detail: { key: "新鲜度超阈值" }, link: "/governance?tab=quality" });
  });
  // ⚪ 未治理表(既无分级也无质量规则)。
  for (const t of tables) {
    if (!classifiedTables.has(t.fqn) && !qualityMap.has(t.fqn)) {
      todos.push({ kind: "ungoverned", fqn: t.fqn, detail: { key: "无分级、无质量规则" }, link: "/governance?tab=quality" });
    }
  }

  // ── 资产榜(最需治理的表)────────────────────────────────────────────────
  const riskMap = new Map<string, AssetRisk>();
  const ensure = (fqn: string, table: string): AssetRisk => {
    let r = riskMap.get(fqn);
    if (!r) { r = { fqn, table, issues: [], qualityScore: qualityMap.get(fqn)?.score ?? null, classified: classifiedTables.has(fqn) }; riskMap.set(fqn, r); }
    return r;
  };
  const tableName = (fqn: string) => fqn.split(".").pop() || fqn;
  Array.from(sensByTable.entries()).forEach(([fqn, n]) => ensure(fqn, tableName(fqn)).issues.push({ key: "{n} 敏感字段未分级", params: { n } }));
  Array.from(qualityMap.entries()).forEach(([fqn, v]) => {
    if (v.slaBreached) ensure(fqn, tableName(fqn)).issues.push({ key: "SLA 违约" });
    if (v.score != null && v.score < QUALITY_PASS) ensure(fqn, tableName(fqn)).issues.push({ key: "质量分 {s}", params: { s: v.score } });
  });
  // 风险排序:敏感缺口 > SLA > 低质量;取前 10(按 issue key 判权重)。
  const riskWeight = (r: AssetRisk) =>
    r.issues.reduce((s, i) => s + (i.key.includes("敏感") ? 100 : i.key.includes("SLA") ? 50 : 10), 0);
  const worstAssets = Array.from(riskMap.values()).sort((a, b) => riskWeight(b) - riskWeight(a)).slice(0, 10);

  const data: GovernanceHealth = {
    score,
    dimensions,
    totals: { tables: totalTables, columns: totalColumns, classifiedTables: classifiedTables.size, tablesWithQuality, tablesWithLineage: withLineage },
    todos,
    worstAssets,
    ...(latestScan?.summary?.scanId ? { latestScanId: latestScan.summary.scanId } : {}),
    ts,
  };
  _cache.set(wantTarget, { at: Date.now(), data });
  return data;
}
