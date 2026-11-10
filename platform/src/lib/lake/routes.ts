// 数据湖表桶路由—— **数据湖表桶路由表**的唯一作者(docs/design/58-lake-bucket-routing/DESIGN.en.md §6.3)。
//
// 【客户原形(2026-11-03)】客户按合规把明细 / 聚合 / 结果放在**不同的 S3 Tables 表桶**里(桶级 IAM 隔离),一个 Spark 作业要
//   读 detail 桶、写 agg 桶。平台把「本区的湖」等同于「本区那一只平台表桶」:注入的 Spark 目录只有一个、预检不量 s3tables、
//   读面只认一个桶 ⇒ 跨桶作业要手敲十行 `--conf`(账号 / 区 / ARN),权限按桶量不出来。
// 【根治形状】每个执行环境一张**路由表**:`bucket → alias / tier / namespaces[] / writable`。平台表桶 = 隐式缺省路由
//   (别名固定 `s3tablescatalog`,不落行;D5)。作业缺省用本区全部路由(D2),可按桶声明读 / 写子集(D3)。
//   注入 / 预检 / 命名空间解析 / 读面全部经本文件:
//     · 读:`resolveLakeRoutes`(15s 进程缓存)· `routeByAlias` · `routeByBucket` · `routeForNamespace`(§6.4,**绝不回落**平台桶)· `selectRoutes`
//     · 写:`registerLakeRoute` · `updateLakeRoute` · `revokeLakeRoute`(平台管理员 / 升级迁移)
//     · 注入:`sparkCatalogConf`(**唯一**拼 `spark.sql.catalog.*` 的地方;Glue ⇒ GlueCatalog 5 项,EMR ⇒ S3TablesCatalog 3 项;D8)
//       · `lakeCatalogsArgument` · `rejectUserCatalogConf` · `assertGlueConfBudget`
// 【数据】零新表:沿用 bgp-settings 行 `pk="system"`,`sk="lake-ext-bucket#<targetId>#<bucket>"`(外部表桶登记行),字段只增不改;
//   存量行(没有 alias / tier / writable)在**第一次读到时**派生并条件回写一次(`attribute_not_exists(alias)`,幂等;§8)。
// 【fail-closed】命名空间匹配不到 ⇒ LAKE_ROUTE_NOT_FOUND;匹配到两条且无归属 ⇒ LAKE_ROUTE_AMBIGUOUS;任何函数都不拿平台桶顶上。
// 🔴 缓存挂 globalThis(Symbol.for):Next 产物里同一源文件在不同路由 bundle 里是不同的模块实例(记忆 next-bundle-duplicate-module-instances)。
import { DeleteCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetTableBucketCommand, ListNamespacesCommand, S3TablesClient } from "@aws-sdk/client-s3tables";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { sdkClient } from "@/lib/aws/clients";
import { SETTINGS_PK } from "@/lib/settings/model-store";
// 「一行绑在哪些区」的归一口(targets[] 优先,再 targetId,再主控区);引用查询只许走它,不手写第二份
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import {
  LAKE_ALIAS_RE, LAKE_RESERVED_ALIASES, LAKE_TIER_DEFAULT, LAKE_NAMESPACE_RE, PLATFORM_ROUTE_ALIAS, TABLE_BUCKET_NAME_RE,
  aliasFromBucket, aliasProblem, isLakeTier, type LakeAccessMode, type LakeBucketDeclaration, type LakeTier,
} from "./routes-grammar";

export * from "./routes-grammar";
export { lakeRouteProbes, LAKE_ROUTE_SID_PREFIX } from "@/lib/role-advisor/lake-probes";

// ── 行键(外部表桶登记行,键不变)──────────────────────────────────────────────────────────
export const LAKE_EXT_BUCKET_SK_PREFIX = "lake-ext-bucket#";
export function lakeExtBucketSk(targetId: string, bucket: string): string {
  return `${LAKE_EXT_BUCKET_SK_PREFIX}${targetId}#${bucket}`;
}

// ── 审计动作名(唯一作者;路由层与升级迁移脚本都用这三个字面)────────────────────────────────────
export const LAKE_ROUTE_AUDIT = {
  register: "lake.route.register",
  update: "lake.route.update",
  revoke: "lake.route.revoke",
} as const;
export const LAKE_ROUTE_AUDIT_RESOURCE_TYPE = "s3-table-bucket";

// ── 类型 ─────────────────────────────────────────────────────────────────────────────────────
/** 落库行(§6.2)。 */
export interface LakeRouteRow {
  targetId: string;
  bucket: string;
  region: string;
  label?: string;
  addedBy: string;
  addedAt: string;
  alias: string;
  tier: LakeTier;
  namespaces?: string[];
  writable: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

/** 一条路由(行 + 派生字段);平台路由没有登记人 / 时间。 */
export interface LakeRoute extends Omit<LakeRouteRow, "addedBy" | "addedAt"> {
  addedBy?: string;
  addedAt?: string;
  /** true 只对隐式平台路由成立 */
  platform: boolean;
  /** Athena 联邦目录引用 `s3tablescatalog/<bucket>` */
  catalogRef: string;
  /** `arn:aws:s3tables:<region>:<account>:bucket/<bucket>` */
  bucketArn: string;
}

export interface LakeRouteSet {
  targetId: string;
  region: string;
  home: boolean;
  platform: LakeRoute;
  /** 登记顺序 */
  external: LakeRoute[];
  /** [platform, ...external] */
  all: LakeRoute[];
  fetchedAt: string;
}

export type SelectedRoute = LakeRoute & { access: LakeAccessMode };

// ── 错误 ─────────────────────────────────────────────────────────────────────────────────────
/** 五个路由专用码(§6.3)。 */
export type LakeRouteErrorCode =
  | "LAKE_ROUTE_NOT_FOUND"
  | "LAKE_ROUTE_AMBIGUOUS"
  | "LAKE_ROUTE_ALIAS_CONFLICT"
  | "LAKE_ROUTE_NOT_WRITABLE"
  | "LAKE_ROUTE_NAMESPACE_CONFLICT";
/** 登记 / 修改 / 撤销还会用到的通用码(§6.10.2–6.10.4)。 */
export type LakeRouteRejectCode = LakeRouteErrorCode | "VALIDATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "DECISION_REQUIRED";

export class LakeRouteError extends Error {
  constructor(
    readonly code: LakeRouteRejectCode,
    readonly status: 400 | 404 | 409,
    message: string,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "LakeRouteError";
  }
}

// ── 文法(抛的版本)────────────────────────────────────────────────────────────────────────────
export function assertTableBucketName(bucket: unknown): string {
  const s = typeof bucket === "string" ? bucket.trim() : "";
  if (!TABLE_BUCKET_NAME_RE.test(s)) {
    throw new LakeRouteError("VALIDATION_FAILED", 400, `表桶名不合法:${JSON.stringify(bucket)}(3–63 位小写字母 / 数字 / 连字符,首尾为字母或数字)`);
  }
  return s;
}

export function assertAlias(alias: unknown): string {
  const problem = aliasProblem(alias);
  if (problem) throw new LakeRouteError("VALIDATION_FAILED", 400, problem);
  return String(alias).trim();
}

export function assertTier(tier: unknown): LakeTier {
  if (tier === undefined || tier === null || tier === "") return LAKE_TIER_DEFAULT;
  if (!isLakeTier(tier)) throw new LakeRouteError("VALIDATION_FAILED", 400, `分层 ${JSON.stringify(tier)} 不在清单里(可选:detail / agg / result / ods / dim / other)`);
  return tier;
}

export function assertNamespaces(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new LakeRouteError("VALIDATION_FAILED", 400, "namespaces 必须是字符串数组(命名空间归属清单)");
  const out: string[] = [];
  for (const x of v) {
    const s = typeof x === "string" ? x.trim() : "";
    if (!LAKE_NAMESPACE_RE.test(s)) throw new LakeRouteError("VALIDATION_FAILED", 400, `命名空间 ${JSON.stringify(x)} 不合法(小写字母 / 数字 / 下划线)`);
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : undefined;
}

function accountId(): string {
  return process.env.AWS_ACCOUNT_ID || "";
}

export function tableBucketArn(region: string, bucket: string): string {
  return `arn:aws:s3tables:${region}:${accountId()}:bucket/${bucket}`;
}

export function catalogRefOf(bucket: string): string {
  return `${PLATFORM_ROUTE_ALIAS}/${bucket}`;
}

/** 平台表桶的隐式路由(纯函数;start-run 对不写 S3 Tables 的任务也要注入这条,不必读 DDB)。 */
export function platformRouteOf(landing: { targetId: string; region: string; tableBucket: string }): LakeRoute {
  return {
    targetId: landing.targetId,
    bucket: landing.tableBucket,
    region: landing.region,
    alias: PLATFORM_ROUTE_ALIAS,
    tier: LAKE_TIER_DEFAULT,
    writable: true,
    platform: true,
    catalogRef: catalogRefOf(landing.tableBucket),
    bucketArn: tableBucketArn(landing.region, landing.tableBucket),
  };
}

function routeOfRow(row: LakeRouteRow): LakeRoute {
  return { ...row, platform: false, catalogRef: catalogRefOf(row.bucket), bucketArn: tableBucketArn(row.region, row.bucket) };
}

// ── 存量行迁移(§8)─────────────────────────────────────────────────────────────────────────
interface NormalizedRow { row: LakeRouteRow; derived: boolean }

/** 把一条 DDB item 整形成路由行;没有 alias / tier / writable 的存量行按 §8 派生(调用方负责回写)。 */
export function normalizeLakeRouteItem(it: Record<string, unknown>, takenAliases: ReadonlySet<string>): NormalizedRow {
  const bucket = String(it.bucket ?? "");
  let derived = false;
  let alias = typeof it.alias === "string" && LAKE_ALIAS_RE.test(it.alias) ? it.alias : "";
  if (!alias) { alias = aliasFromBucket(bucket, takenAliases); derived = true; }
  let tier: LakeTier;
  if (isLakeTier(it.tier)) tier = it.tier; else { tier = LAKE_TIER_DEFAULT; derived = true; }
  let writable: boolean;
  if (typeof it.writable === "boolean") writable = it.writable; else { writable = true; derived = true; }
  const namespaces = Array.isArray(it.namespaces) ? it.namespaces.filter((x): x is string => typeof x === "string" && LAKE_NAMESPACE_RE.test(x)) : undefined;
  const row: LakeRouteRow = {
    targetId: String(it.targetId ?? ""),
    bucket,
    region: String(it.region ?? ""),
    ...(typeof it.label === "string" && it.label ? { label: it.label } : {}),
    addedBy: String(it.addedBy ?? ""),
    addedAt: String(it.addedAt ?? ""),
    alias,
    tier,
    ...(namespaces && namespaces.length ? { namespaces } : {}),
    writable,
    ...(typeof it.updatedBy === "string" && it.updatedBy ? { updatedBy: it.updatedBy } : {}),
    ...(typeof it.updatedAt === "string" && it.updatedAt ? { updatedAt: it.updatedAt } : {}),
  };
  return { row, derived };
}

/** 落库 item 的形状(**唯一作者**;升级迁移脚本写同形的行,由 golden 判据比对键集)。 */
export function lakeRouteItemOf(row: LakeRouteRow): Record<string, unknown> {
  return { pk: SETTINGS_PK, sk: lakeExtBucketSk(row.targetId, row.bucket), ...row };
}

async function writeBackDerived(row: LakeRouteRow): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.SETTINGS,
      Key: { pk: SETTINGS_PK, sk: lakeExtBucketSk(row.targetId, row.bucket) },
      UpdateExpression: "SET alias = :alias, tier = :tier, writable = :writable",
      ConditionExpression: "attribute_exists(sk) AND attribute_not_exists(alias)",
      ExpressionAttributeValues: { ":alias": row.alias, ":tier": row.tier, ":writable": row.writable },
    }));
  } catch (e) {
    // 别的任务先写了 / 行刚被撤销 ⇒ 读侧照常(读派生的值与写回的值相同);别的错也不阻断读
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") {
      console.warn(`[lake-routes] 回写存量行 ${row.targetId}/${row.bucket} 的派生字段失败(读不受影响):${String((e as Error)?.message || e).slice(0, 160)}`);
    }
  }
}

/** 某执行环境已登记的外部路由行(登记时间稳定排序;存量行当场派生 + 条件回写一次)。**直读 DDB,不走缓存**。 */
export async function listLakeRouteRows(targetId: string): Promise<LakeRouteRow[]> {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLES.SETTINGS,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": SETTINGS_PK, ":prefix": `${LAKE_EXT_BUCKET_SK_PREFIX}${targetId}#` },
      ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const it of (r.Items ?? []) as Record<string, unknown>[]) items.push(it);
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  items.sort((a, b) => String(a.addedAt ?? "").localeCompare(String(b.addedAt ?? "")) || String(a.bucket ?? "").localeCompare(String(b.bucket ?? "")));
  // 已有别名先占位,再给存量行派生(派生顺序 = 登记顺序,确定性)
  const taken = new Set<string>();
  for (const it of items) if (typeof it.alias === "string" && LAKE_ALIAS_RE.test(it.alias)) taken.add(it.alias);
  const rows: LakeRouteRow[] = [];
  const writeBacks: Promise<void>[] = [];
  for (const it of items) {
    const { row, derived } = normalizeLakeRouteItem(it, taken);
    taken.add(row.alias);
    rows.push(row);
    if (derived) writeBacks.push(writeBackDerived(row));
  }
  await Promise.all(writeBacks);
  return rows;
}

// ── 缓存(§6.4.1)────────────────────────────────────────────────────────────────────────────
const ROUTES_TTL_MS = 15_000;
type RoutesMemo = Map<string, { at: number; set: LakeRouteSet }>;
type NamespacesMemo = Map<string, { at: number; names: Set<string> }>;
const ROUTES_MEMO_KEY = Symbol.for("bgp.lake.routes.memo");
const NAMESPACES_MEMO_KEY = Symbol.for("bgp.lake.namespaces.memo");
function routesMemo(): RoutesMemo {
  const g = globalThis as unknown as Record<symbol, RoutesMemo | undefined>;
  return (g[ROUTES_MEMO_KEY] ??= new Map());
}
function namespacesMemo(): NamespacesMemo {
  const g = globalThis as unknown as Record<symbol, NamespacesMemo | undefined>;
  return (g[NAMESPACES_MEMO_KEY] ??= new Map());
}
/** 登记 / 修改 / 撤销后调用:本进程内所有模块实例立刻看到新路由表(跨 ECS task 靠 15s TTL 收敛)。 */
export function forgetLakeRoutesMemo(): void {
  routesMemo().clear();
  namespacesMemo().clear();
}

// ── 读 ───────────────────────────────────────────────────────────────────────────────────────
function buildSet(place: { targetId: string; region: string; bucket: string; home: boolean }, rows: LakeRouteRow[]): LakeRouteSet {
  const platform = platformRouteOf({ targetId: place.targetId, region: place.region, tableBucket: place.bucket });
  const external = rows.map(routeOfRow);
  return { targetId: place.targetId, region: place.region, home: place.home, platform, external, all: [platform, ...external], fetchedAt: new Date().toISOString() };
}

/**
 * 某执行环境的路由集 = 隐式平台路由 + 已登记外部路由。
 * 🔴 执行环境没就位 / 描述符缺 tableBucket ⇒ 抛(与 resolveS3TablesPlace 同一行为),不猜。
 * 写侧判定(保存 / 启动 / 登记)传 `fresh: true` 绕过缓存 —— 「一秒前登记的」必须在每个 ECS task 上立刻生效。
 */
export async function resolveLakeRoutes(targetId: string, opts: { fresh?: boolean } = {}): Promise<LakeRouteSet> {
  const { resolveS3TablesPlace } = await import("@/lib/athena/s3tables");
  const place = await resolveS3TablesPlace(targetId);
  return lakeRoutesOfPlace({ targetId: place.targetId, region: place.region, bucket: place.bucket, home: place.home }, opts);
}

/**
 * 调用方手里已经有 Spark 落点(`resolveGlueBinding` / `resolveEmrBinding` 的 landing:targetId / region / tableBucket / home)时用这条,
 * 平台路由直接从落点派生,不再解析第二次(设计稿 §6.1:平台路由的桶 = TargetSparkLanding.tableBucket);外部路由仍读 DDB、同一份缓存。
 */
export async function lakeRoutesOfLanding(landing: { targetId: string; region: string; tableBucket: string; home: boolean }, opts: { fresh?: boolean } = {}): Promise<LakeRouteSet> {
  return lakeRoutesOfPlace({ targetId: landing.targetId, region: landing.region, bucket: landing.tableBucket, home: landing.home }, opts);
}

async function lakeRoutesOfPlace(place: { targetId: string; region: string; bucket: string; home: boolean }, opts: { fresh?: boolean }): Promise<LakeRouteSet> {
  const memo = routesMemo();
  if (!opts.fresh) {
    const m = memo.get(place.targetId);
    if (m && Date.now() - m.at < ROUTES_TTL_MS) return m.set;
  }
  const set = buildSet(place, await listLakeRouteRows(place.targetId));
  memo.set(place.targetId, { at: Date.now(), set });
  return set;
}

export async function routeByAlias(targetId: string, alias: string, opts: { fresh?: boolean } = {}): Promise<LakeRoute> {
  const set = await resolveLakeRoutes(targetId, opts);
  const hit = set.all.find((r) => r.alias === alias);
  if (!hit) {
    throw new LakeRouteError("LAKE_ROUTE_NOT_FOUND", 400,
      `执行环境 ${set.targetId} 没有别名为「${alias}」的数据湖路由(现有:${set.all.map((r) => r.alias).join(" / ")})`, { targetId: set.targetId, alias });
  }
  return hit;
}

export async function routeByBucket(targetId: string, bucket: string, opts: { fresh?: boolean } = {}): Promise<LakeRoute> {
  const set = await resolveLakeRoutes(targetId, opts);
  const hit = set.all.find((r) => r.bucket === bucket);
  if (!hit) throw routeNotFoundForBucket(set, bucket);
  return hit;
}

export function routeNotFoundForBucket(set: LakeRouteSet, bucket: string): LakeRouteError {
  return new LakeRouteError("LAKE_ROUTE_NOT_FOUND", 400,
    `表桶「${bucket}」不是执行环境 ${set.targetId} 的数据湖路由(平台表桶「${set.platform.bucket}」或已在「${LAKE_ROUTES_PAGE_PATH}」登记的表桶)。` +
      `请先去登记(登记一次 = 作业 / 同步可用、直查 / 治理目录 / 问数可见)` +
      (set.external.length ? `;该执行环境已登记:${set.external.map((r) => `${r.bucket}(${r.alias})`).join("、")}` : ""),
    { targetId: set.targetId, bucket });
}

/** 页面上登记路由的位置(拒绝文案 / 下拉提示都指它;与 app/settings 的卡片标题同词)。 */
export const LAKE_ROUTES_PAGE_PATH = "系统设置 → 数据湖表桶与路由";

const s3tClients = new Map<string, S3TablesClient>();
function s3tClientFor(region: string): S3TablesClient {
  let c = s3tClients.get(region);
  if (!c) { c = sdkClient("data-plane", S3TablesClient, { region }); s3tClients.set(region, c); }
  return c;
}

/** 某条路由(桶)里**实际存在**的命名空间(ListNamespaces 翻页;15s 按 (targetId, bucket) 缓存)。 */
export async function liveNamespacesOf(route: Pick<LakeRoute, "targetId" | "bucket" | "region" | "bucketArn">, opts: { fresh?: boolean; client?: { send(cmd: unknown): Promise<unknown> } } = {}): Promise<Set<string>> {
  const key = `${route.targetId}#${route.bucket}`;
  const memo = namespacesMemo();
  if (!opts.fresh) {
    const m = memo.get(key);
    if (m && Date.now() - m.at < ROUTES_TTL_MS) return m.names;
  }
  const c = opts.client ?? s3tClientFor(route.region);
  const names = new Set<string>();
  let tok: string | undefined;
  do {
    const r = (await c.send(new ListNamespacesCommand({ tableBucketARN: route.bucketArn, ...(tok ? { continuationToken: tok } : {}) }))) as {
      namespaces?: Array<{ namespace?: string[] }>; continuationToken?: string;
    };
    for (const n of r.namespaces || []) { const first = Array.isArray(n.namespace) ? n.namespace[0] : undefined; if (first) names.add(first); }
    tok = r.continuationToken;
  } while (tok);
  memo.set(key, { at: Date.now(), names });
  return names;
}

/**
 * 按命名空间找路由(§6.4;问数 / BI / 向导只让用户选了「库」):
 *   ① 只有一条路由 ⇒ 它(不探);② 恰一条路由声明归属该命名空间 ⇒ 它;两条以上声明 ⇒ NAMESPACE_CONFLICT(登记守卫应已挡住,防御性);
 *   ③ 否则对**没声明归属**的路由逐桶 ListNamespaces:0 命中 ⇒ NOT_FOUND;1 ⇒ 它;≥2 ⇒ AMBIGUOUS(detail.buckets)。
 * 🔴 没有任何分支把平台路由当「找不到时的缺省」—— 那正是 外部表桶登记之后残留的静默默认(s3tables.ts:164)。
 */
export async function routeForNamespace(targetId: string, namespace: string, opts: { fresh?: boolean } = {}): Promise<LakeRoute> {
  const set = await resolveLakeRoutes(targetId, opts);
  if (set.all.length === 1) return set.all[0];
  const owners = set.all.filter((r) => r.namespaces?.includes(namespace));
  if (owners.length === 1) return owners[0];
  if (owners.length >= 2) {
    throw new LakeRouteError("LAKE_ROUTE_NAMESPACE_CONFLICT", 409,
      `命名空间 ${namespace} 被 ${owners.map((r) => `${r.bucket}(别名 ${r.alias})`).join(" 与 ")} 同时声明归属 —— 在「${LAKE_ROUTES_PAGE_PATH}」只保留一条路由的归属`,
      { conflicts: [{ namespace, buckets: owners.map((r) => r.bucket) }] });
  }
  const hits: LakeRoute[] = [];
  for (const r of set.all) {
    if (r.namespaces) continue; // 声明了归属清单的路由只按清单解析
    if ((await liveNamespacesOf(r, { fresh: opts.fresh })).has(namespace)) hits.push(r);
  }
  if (hits.length === 0) {
    throw new LakeRouteError("LAKE_ROUTE_NOT_FOUND", 400,
      `命名空间 ${namespace} 不在执行环境 ${set.targetId} 的 ${set.all.length} 条数据湖路由里:${set.all.map((r) => `${r.alias} → ${r.bucket}`).join(",")}` +
        ` —— 请核对命名空间名,或在「${LAKE_ROUTES_PAGE_PATH}」登记它所在的表桶`,
      { targetId: set.targetId, namespace, routes: set.all.map((r) => ({ alias: r.alias, bucket: r.bucket })) });
  }
  if (hits.length >= 2) {
    throw new LakeRouteError("LAKE_ROUTE_AMBIGUOUS", 400,
      `命名空间 ${namespace} 同时存在于 ${hits.map((r) => `${r.bucket}(别名 ${r.alias})`).join(" 与 ")} —— 请在「${LAKE_ROUTES_PAGE_PATH}」给其中一条路由声明归属(namespaces 填 ${namespace})`,
      { targetId: set.targetId, namespace, buckets: hits.map((r) => r.bucket), fix: `declare ownership of ${namespace} on one route` });
  }
  return hits[0];
}

/**
 * 作业的路由选择(D2 / D3):没声明 ⇒ 本区全部路由,访问方式随 writable;声明了 ⇒ 每个桶必须是本区路由,`write` 必须可写。
 * 结果按路由表顺序(平台路由在前,外部按登记顺序)。
 */
export function selectRoutes(set: LakeRouteSet, declared?: readonly LakeBucketDeclaration[]): SelectedRoute[] {
  if (!declared) return set.all.map((r) => ({ ...r, access: r.writable ? "write" : "read" }));
  const byBucket = new Map<string, LakeAccessMode>();
  for (const d of declared) {
    if (byBucket.has(d.bucket)) throw new LakeRouteError("VALIDATION_FAILED", 400, `数据湖表桶声明里 ${d.bucket} 出现了两次`);
    const route = set.all.find((r) => r.bucket === d.bucket);
    if (!route) throw routeNotFoundForBucket(set, d.bucket);
    if (d.access === "write" && !route.writable) {
      throw new LakeRouteError("LAKE_ROUTE_NOT_WRITABLE", 400,
        `数据湖路由「${route.alias}」(${route.bucket})登记为只读,作业不能把它声明为「写」—— 把访问改成「读」,或在「${LAKE_ROUTES_PAGE_PATH}」把它改为可写`,
        { targetId: set.targetId, bucket: route.bucket, alias: route.alias });
    }
    byBucket.set(d.bucket, d.access);
  }
  return set.all.filter((r) => byBucket.has(r.bucket)).map((r) => ({ ...r, access: byBucket.get(r.bucket)! }));
}

/** 缺省目录别名必须是本作业目录之一(§6.2)。 */
export function assertDefaultCatalogAlias(selected: readonly SelectedRoute[], alias: unknown): string | undefined {
  if (alias === undefined || alias === null || alias === "") return undefined;
  const a = assertAlias(alias);
  if (!selected.some((r) => r.alias === a)) {
    throw new LakeRouteError("VALIDATION_FAILED", 400,
      `缺省目录「${a}」不是本作业可用的目录(可用:${selected.map((r) => r.alias).join(" / ")})`, { defaultCatalogAlias: a });
  }
  return a;
}

// ── 注入(§6.5;**唯一**拼写 Spark 目录属性的地方)─────────────────────────────────────────────
export type SparkEngine = "glue" | "emr";

/**
 * 每条路由一组 Spark 目录属性(不带 `--conf` 前缀,调用方拼接):
 *   glue ⇒ Iceberg GlueCatalog 5 项(与改动前 job-service / start-run 的字面逐字相同);
 *   emr  ⇒ S3TablesCatalog 3 项(与改动前 emr/spec.ts 的字面逐字相同;jar / extensions 由调用方加一次)。
 * 给了 defaultAlias ⇒ 末尾追加 `spark.sql.defaultCatalog=<alias>`。
 */
export function sparkCatalogConf(routes: readonly LakeRoute[], opts: { engine: SparkEngine; account: string; defaultAlias?: string }): string[] {
  const out: string[] = [];
  for (const r of routes) {
    if (opts.engine === "glue") {
      out.push(
        `spark.sql.catalog.${r.alias}=org.apache.iceberg.spark.SparkCatalog`,
        `spark.sql.catalog.${r.alias}.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog`,
        `spark.sql.catalog.${r.alias}.glue.id=${opts.account}:${PLATFORM_ROUTE_ALIAS}/${r.bucket}`,
        `spark.sql.catalog.${r.alias}.io-impl=org.apache.iceberg.aws.s3.S3FileIO`,
        `spark.sql.catalog.${r.alias}.warehouse=arn:aws:s3tables:${r.region}:${opts.account}:bucket/${r.bucket}`,
      );
    } else {
      out.push(
        `spark.sql.catalog.${r.alias}=org.apache.iceberg.spark.SparkCatalog`,
        `spark.sql.catalog.${r.alias}.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog`,
        `spark.sql.catalog.${r.alias}.warehouse=arn:aws:s3tables:${r.region}:${opts.account}:bucket/${r.bucket}`,
      );
    }
  }
  if (opts.defaultAlias) out.push(`spark.sql.defaultCatalog=${opts.defaultAlias}`);
  return out;
}

/** `alias=bucket,alias=bucket`(Glue `--bgp_lake_catalogs` / EMR `spark.bgp.lakeCatalogs` 的值;平台路由在前;键名在 routes-grammar)。 */
export function lakeCatalogsArgument(routes: readonly LakeRoute[]): string {
  return routes.map((r) => `${r.alias}=${r.bucket}`).join(",");
}

const CATALOG_KEY_RE = /^spark\.sql\.catalog\.([A-Za-z_][A-Za-z0-9_]*)(?:\.(.+))?$/;

/** Glue `--conf` 参数值 ⇒ 条目列表(`k=v --conf k=v` 形态,用户在页面里就是这样填的)。
 *  线性扫描:按空白切词,遇到独立的 `--conf` 词就切一刀。不用 `/\s+--conf\s+/` —— 用户可控文本上那种式子会多项式回溯(2026-11-09 代码扫描抓到)。 */
export function splitGlueConfValue(value: string | undefined): string[] {
  const text = String(value ?? "");
  const out: string[] = [];
  let start = 0;
  for (const m of Array.from(text.matchAll(/\S+/g))) {
    if (m[0] !== "--conf" || m.index === undefined) continue;
    out.push(text.slice(start, m.index));
    start = m.index + m[0].length;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface UserCatalogConfVerdict {
  /** 原样保留的条目(别名不在路由表里的手写目录、与路由无关的 conf) */
  kept: string[];
  /** 被平台接管而丢弃的条目 */
  dropped: string[];
  /** 给用户看的说明(每条丢弃一句) */
  notices: string[];
}

/**
 * 用户自己写的 Spark conf 条目过一遍路由表(§6.5.1 / D10):
 *   · `spark.sql.catalog.<alias>*` 的别名 = 平台生成的别名,且 glue.id / warehouse 指向**同一个桶**(或与桶无关的属性)⇒ 丢弃 + 一句说明;
 *   · 同一别名、不同桶 ⇒ LAKE_ROUTE_ALIAS_CONFLICT(400,detail { alias, userBucket, routeBucket });
 *   · 别名不在路由表里 ⇒ 原样保留(手写非路由桶的目录仍允许,IAM 决定能不能用);
 *   · `spark.sql.defaultCatalog` 且作业声明了缺省目录 ⇒ 丢弃 + 说明。
 */
export function rejectUserCatalogConf(entries: readonly string[], routes: readonly LakeRoute[], opts: { defaultDeclared?: boolean } = {}): UserCatalogConfVerdict {
  const kept: string[] = [];
  const dropped: string[] = [];
  const notices: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const key = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    const value = eq >= 0 ? entry.slice(eq + 1).trim() : "";
    if (key === "spark.sql.defaultCatalog" && opts.defaultDeclared) {
      dropped.push(entry);
      notices.push(`已忽略手写的 spark.sql.defaultCatalog=${value}:作业已在「数据湖表桶」里指定了缺省目录,由平台注入`);
      continue;
    }
    const m = CATALOG_KEY_RE.exec(key);
    if (!m) { kept.push(entry); continue; }
    const alias = m[1];
    const prop = m[2] ?? "";
    const route = routes.find((r) => r.alias === alias);
    if (!route) { kept.push(entry); continue; }
    const userBucket = prop === "glue.id" ? value.split(`${PLATFORM_ROUTE_ALIAS}/`).pop() ?? ""
      : prop === "warehouse" ? value.split(":bucket/").pop() ?? ""
      : "";
    if ((prop === "glue.id" || prop === "warehouse") && userBucket && userBucket !== route.bucket) {
      throw new LakeRouteError("LAKE_ROUTE_ALIAS_CONFLICT", 400,
        `手写的 Spark 目录「${alias}」指向表桶 ${userBucket},而平台路由「${alias}」是 ${route.bucket} —— 同一别名不能指向两个桶。` +
          `请把手写的 --conf 里这些 spark.sql.catalog.${alias}* 删掉(平台会注入),或给手写目录换一个别名`,
        { alias, userBucket, routeBucket: route.bucket });
    }
    dropped.push(entry);
    notices.push(`已由平台接管 Spark 目录「${alias}」(${route.bucket}):手写的 ${key} 不再需要,已忽略`);
  }
  return { kept, dropped, notices };
}

/**
 * Glue `DefaultArguments` 单个值的上限(字节)。🔴 Q7:精确上限待对照 Glue API 参考确认;设计稿按 10 KB 口径估算
 *   (每条路由 ≈ 430–610 字节 ⇒ 16–23 条路由)。在这里写成常量 + 判据,改一处即生效。
 */
export const GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES = 10_240;

export function glueConfBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** `--conf` 值超过上限 ⇒ 400 VALIDATION_FAILED(说清字节数与上限;出路 = 只声明用到的路由)。 */
export function assertGlueConfBudget(value: string): void {
  const bytes = glueConfBytes(value);
  if (bytes > GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES) {
    throw new LakeRouteError("VALIDATION_FAILED", 400,
      `注入的 Spark 目录配置(--conf)有 ${bytes} 字节,超过 Glue 作业参数单值上限 ${GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES} 字节 —— ` +
        `请在作业的「数据湖表桶」里只声明用到的路由(每条路由约 430–610 字节)`,
      { bytes, limit: GLUE_DEFAULT_ARGUMENT_VALUE_MAX_BYTES });
  }
}

// ── 写(平台管理员 / 升级迁移)──────────────────────────────────────────────────────────────
export interface RegisterLakeRouteInput {
  targetId: string;
  bucket: unknown;
  alias?: unknown;
  tier?: unknown;
  writable?: unknown;
  namespaces?: unknown;
  label?: unknown;
  addedBy: string;
  /** 判据注入用;缺省按区建 s3tables 客户端 */
  s3tablesClient?: { send(cmd: unknown): Promise<unknown> };
  now?: Date;
}

function labelOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined;
}

async function assertBucketExists(region: string, bucket: string, client?: { send(cmd: unknown): Promise<unknown> }): Promise<void> {
  const arn = tableBucketArn(region, bucket);
  const c = client ?? s3tClientFor(region);
  try {
    await c.send(new GetTableBucketCommand({ tableBucketARN: arn }));
  } catch (e: unknown) {
    const err = (e ?? {}) as { name?: string; message?: string };
    if (err.name === "NotFoundException" || /not found|does not exist/i.test(String(err.message ?? ""))) {
      throw new LakeRouteError("NOT_FOUND", 404, `在 ${region} 没有名为 ${bucket} 的 S3 Tables 表桶(${arn})—— 登记前请先在该区建好,或核对名字`);
    }
    throw e;
  }
}

/**
 * 登记守卫(R7):新桶实际存在的命名空间 ∩ 现有路由(平台路由 + 外部路由)实际 / 声明的命名空间 ⇒
 *   对每个重叠的命名空间:声明归属的路由数 ≥ 2 ⇒ 冲突;恰 1 条声明 ⇒ 归属已定,放行;0 条声明 ⇒ 冲突(要有人声明)。
 * 声明了归属清单的现有路由只按清单参与(与 routeForNamespace 同一规则)。
 */
async function assertNoNamespaceConflict(
  set: LakeRouteSet,
  candidate: { bucket: string; region: string; targetId: string; bucketArn: string; namespaces?: string[] },
  exclude: string | undefined,
  client?: { send(cmd: unknown): Promise<unknown> }
): Promise<void> {
  const others = set.all.filter((r) => r.bucket !== exclude && r.bucket !== candidate.bucket);
  const live = await liveNamespacesOf(candidate, { fresh: true, client });
  const conflicts: Array<{ namespace: string; buckets: string[] }> = [];
  const candidateNs = new Set<string>([...Array.from(live), ...(candidate.namespaces ?? [])]);
  for (const ns of Array.from(candidateNs)) {
    const overlapping: string[] = [];
    let declaredOwners = candidate.namespaces?.includes(ns) ? 1 : 0;
    for (const o of others) {
      if (o.namespaces) {
        if (o.namespaces.includes(ns)) { overlapping.push(o.bucket); declaredOwners += 1; }
        continue;
      }
      if ((await liveNamespacesOf(o, { fresh: true, client })).has(ns)) overlapping.push(o.bucket);
    }
    if (!overlapping.length) continue;
    if (declaredOwners === 1) continue; // 归属已定(新路由或恰一条现有路由声明了它)
    conflicts.push({ namespace: ns, buckets: [...overlapping, candidate.bucket] });
  }
  if (conflicts.length) {
    const msg = conflicts.map((c) => `命名空间 ${c.namespace} 同时存在于 ${c.buckets.map((b) => { const r = set.all.find((x) => x.bucket === b); return r ? `${b}(别名 ${r.alias})` : b; }).join(" 与 ")}`).join(";");
    throw new LakeRouteError("LAKE_ROUTE_NAMESPACE_CONFLICT", 409,
      `${msg}。请在 namespaces 里声明哪条路由拥有 ${conflicts.map((c) => c.namespace).join(" / ")}(只能一条)后重试;三段名 <别名>.<命名空间>.<表> 不受影响`,
      { conflicts });
  }
}

/** 登记一条外部路由(§6.10.2 的状态矩阵由抛出的 LakeRouteError 承载)。 */
export async function registerLakeRoute(input: RegisterLakeRouteInput): Promise<LakeRoute> {
  const bucket = assertTableBucketName(input.bucket);
  const set = await resolveLakeRoutes(input.targetId, { fresh: true });
  if (bucket === set.platform.bucket) {
    throw new LakeRouteError("CONFLICT", 409, `${bucket} 就是执行环境 ${set.targetId} 的平台表桶(别名 ${PLATFORM_ROUTE_ALIAS}),本来就是缺省路由,不需要登记`);
  }
  const existing = set.external.find((r) => r.bucket === bucket);
  if (existing) throw new LakeRouteError("CONFLICT", 409, `${bucket} 已在执行环境 ${set.targetId} 登记过(${existing.addedAt} by ${existing.addedBy},别名 ${existing.alias})`);
  const taken = new Set(set.all.map((r) => r.alias));
  const alias = input.alias === undefined || input.alias === null || input.alias === "" ? aliasFromBucket(bucket, taken) : assertAlias(input.alias);
  const clash = set.all.find((r) => r.alias === alias);
  if (clash) {
    throw new LakeRouteError("LAKE_ROUTE_ALIAS_CONFLICT", 409, `别名「${alias}」已被执行环境 ${set.targetId} 的路由 ${clash.bucket} 使用,请换一个别名`, { alias, bucket: clash.bucket });
  }
  const tier = assertTier(input.tier);
  if (input.writable !== undefined && typeof input.writable !== "boolean") throw new LakeRouteError("VALIDATION_FAILED", 400, "writable 必须是布尔值");
  const writable = input.writable === undefined ? true : input.writable;
  const namespaces = assertNamespaces(input.namespaces);
  const label = labelOf(input.label);
  await assertBucketExists(set.region, bucket, input.s3tablesClient);
  const candidate = { bucket, region: set.region, targetId: set.targetId, bucketArn: tableBucketArn(set.region, bucket), ...(namespaces ? { namespaces } : {}) };
  await assertNoNamespaceConflict(set, candidate, undefined, input.s3tablesClient);
  const row: LakeRouteRow = {
    targetId: set.targetId, bucket, region: set.region, ...(label ? { label } : {}),
    addedBy: input.addedBy, addedAt: (input.now ?? new Date()).toISOString(),
    alias, tier, ...(namespaces ? { namespaces } : {}), writable,
  };
  try {
    await docClient.send(new PutCommand({ TableName: TABLES.SETTINGS, Item: lakeRouteItemOf(row), ConditionExpression: "attribute_not_exists(sk)" }));
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
      throw new LakeRouteError("CONFLICT", 409, `${bucket} 刚被别人登记到执行环境 ${set.targetId},请刷新`);
    }
    throw e;
  }
  forgetLakeRoutesMemo();
  return routeOfRow(row);
}

export interface UpdateLakeRouteInput {
  targetId: string;
  bucket: unknown;
  alias?: unknown;
  tier?: unknown;
  writable?: unknown;
  namespaces?: unknown;
  label?: unknown;
  /** 改别名需显式确认(D11:脚本里引用着别名) */
  confirmAliasChange?: boolean;
  updatedBy: string;
  s3tablesClient?: { send(cmd: unknown): Promise<unknown> };
  now?: Date;
}

/** 修改一条外部路由(§6.10.3);桶与执行环境是身份,不可改;平台路由不可改(400)。 */
export async function updateLakeRoute(input: UpdateLakeRouteInput): Promise<LakeRoute> {
  const bucket = assertTableBucketName(input.bucket);
  const set = await resolveLakeRoutes(input.targetId, { fresh: true });
  if (bucket === set.platform.bucket) throw new LakeRouteError("VALIDATION_FAILED", 400, `平台表桶 ${bucket} 的路由是隐式缺省路由(别名固定 ${PLATFORM_ROUTE_ALIAS}),不接受修改`);
  const current = set.external.find((r) => r.bucket === bucket);
  if (!current) throw new LakeRouteError("NOT_FOUND", 404, `表桶 ${bucket} 没有在执行环境 ${set.targetId} 登记为路由`);
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  const next: LakeRouteRow = { ...current, addedBy: current.addedBy ?? "", addedAt: current.addedAt ?? "" };
  if (input.alias !== undefined && input.alias !== null && input.alias !== "" && input.alias !== current.alias) {
    const alias = assertAlias(input.alias);
    const clash = set.all.find((r) => r.alias === alias && r.bucket !== bucket);
    if (clash) throw new LakeRouteError("LAKE_ROUTE_ALIAS_CONFLICT", 409, `别名「${alias}」已被执行环境 ${set.targetId} 的路由 ${clash.bucket} 使用,请换一个别名`, { alias, bucket: clash.bucket });
    if (!input.confirmAliasChange) {
      const refs = await referencesOfRoute(set.targetId, bucket);
      throw new LakeRouteError("DECISION_REQUIRED", 409,
        `把路由 ${bucket} 的别名从「${current.alias}」改成「${alias}」会让脚本里写着 ${current.alias}.<命名空间>.<表> 的作业找不到目录` +
          (refs.jobs.length ? `(声明了这条路由的作业:${refs.jobs.map((j) => j.name).join("、")})` : "(目前没有作业显式声明这条路由,但脚本里可能仍引用旧别名)") +
          `。确认要改请带 confirmAliasChange=true 重试`,
        { alias: { from: current.alias, to: alias }, jobs: refs.jobs, syncTasks: refs.syncTasks });
    }
    sets.push("alias = :alias"); values[":alias"] = alias; next.alias = alias;
  }
  if (input.tier !== undefined) { const tier = assertTier(input.tier); sets.push("tier = :tier"); values[":tier"] = tier; next.tier = tier; }
  if (input.writable !== undefined) {
    if (typeof input.writable !== "boolean") throw new LakeRouteError("VALIDATION_FAILED", 400, "writable 必须是布尔值");
    sets.push("writable = :writable"); values[":writable"] = input.writable; next.writable = input.writable;
  }
  if (input.namespaces !== undefined) {
    const ns = assertNamespaces(input.namespaces);
    if (ns) { sets.push("#ns = :ns"); names["#ns"] = "namespaces"; values[":ns"] = ns; next.namespaces = ns; }
    else { sets.push("#ns = :nsEmpty"); names["#ns"] = "namespaces"; values[":nsEmpty"] = null; delete next.namespaces; }
  }
  if (input.label !== undefined) {
    const label = labelOf(input.label);
    sets.push("label = :label"); values[":label"] = label ?? null;
    if (label) next.label = label; else delete next.label;
  }
  if (!sets.length) return current;
  if (input.namespaces !== undefined) {
    await assertNoNamespaceConflict(set, { bucket, region: set.region, targetId: set.targetId, bucketArn: current.bucketArn, ...(next.namespaces ? { namespaces: next.namespaces } : {}) }, bucket, input.s3tablesClient);
  }
  const now = (input.now ?? new Date()).toISOString();
  sets.push("updatedBy = :updatedBy", "updatedAt = :updatedAt");
  values[":updatedBy"] = input.updatedBy; values[":updatedAt"] = now;
  next.updatedBy = input.updatedBy; next.updatedAt = now;
  await docClient.send(new UpdateCommand({
    TableName: TABLES.SETTINGS,
    Key: { pk: SETTINGS_PK, sk: lakeExtBucketSk(set.targetId, bucket) },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(sk)",
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
  }));
  forgetLakeRoutesMemo();
  return routeOfRow(next);
}

export interface LakeRouteReferences {
  syncTasks: Array<{ taskId: string; name: string }>;
  jobs: Array<{ kind: "etl" | "emr"; jobId: string; name: string }>;
}

/** 一行(同步任务 / 作业)绑在哪些区:走归一口 bindingTargets(targets[] 优先,再 targetId,再主控区;不在这里手写第二份)。 */
function rowTargets(row: Record<string, unknown>): string[] {
  return bindingTargets(row as { targets?: unknown; targetId?: unknown });
}

async function scanAll(table: string, projection: string, names?: Record<string, string>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await docClient.send(new ScanCommand({
      TableName: table, ProjectionExpression: projection, ...(names ? { ExpressionAttributeNames: names } : {}), ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const it of (r.Items ?? []) as Record<string, unknown>[]) out.push(it);
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

/** 谁在用这条路由:写它的同步任务 + 显式声明它的离线 / EMR 作业(撤销 409 / 改别名 DECISION_REQUIRED 用)。 */
export async function referencesOfRoute(targetId: string, bucket: string): Promise<LakeRouteReferences> {
  const [tasks, etl, emr] = await Promise.all([
    scanAll(TABLES.SYNC_TASKS, "taskId, #n, targets, targetId, s3Config", { "#n": "name" }),
    scanAll(TABLES.ETL_JOBS, "jobId, #n, targets, targetId, glueConfig", { "#n": "name" }),
    scanAll(TABLES.ENGINE_JOBS, "jobId, #n, targets, targetId, lakeBuckets", { "#n": "name" }),
  ]);
  const declares = (v: unknown) => Array.isArray(v) && v.some((d) => d && typeof d === "object" && (d as { bucket?: unknown }).bucket === bucket);
  return {
    syncTasks: tasks
      .filter((t) => rowTargets(t).includes(targetId) && String((t.s3Config as { tableBucket?: unknown } | undefined)?.tableBucket ?? "").trim() === bucket)
      .map((t) => ({ taskId: String(t.taskId ?? ""), name: String(t.name ?? "") })),
    jobs: [
      ...etl.filter((j) => rowTargets(j).includes(targetId) && declares((j.glueConfig as { lakeBuckets?: unknown } | undefined)?.lakeBuckets))
        .map((j) => ({ kind: "etl" as const, jobId: String(j.jobId ?? ""), name: String(j.name ?? "") })),
      ...emr.filter((j) => rowTargets(j).includes(targetId) && declares(j.lakeBuckets))
        .map((j) => ({ kind: "emr" as const, jobId: String(j.jobId ?? ""), name: String(j.name ?? "") })),
    ],
  };
}

/**
 * 撤销一条外部路由(§6.10.4):只删登记行,表桶与里面的表一个不碰。
 * 回 false = 本来就没登记(路由回 404);仍被同步任务 / 作业引用 ⇒ CONFLICT 409 detail { syncTasks, jobs };平台表桶 ⇒ 400。
 */
export async function revokeLakeRoute(targetId: string, bucket: unknown): Promise<boolean> {
  const b = assertTableBucketName(bucket);
  const set = await resolveLakeRoutes(targetId, { fresh: true });
  if (b === set.platform.bucket) throw new LakeRouteError("VALIDATION_FAILED", 400, `平台表桶 ${b} 的路由是隐式缺省路由,不能撤销`);
  if (!set.external.some((r) => r.bucket === b)) return false;
  const refs = await referencesOfRoute(set.targetId, b);
  if (refs.syncTasks.length || refs.jobs.length) {
    throw new LakeRouteError("CONFLICT", 409,
      `表桶 ${b} 仍被引用,先去掉引用再撤销:` +
        [refs.syncTasks.length ? `同步任务 ${refs.syncTasks.map((t) => t.name || t.taskId).join("、")}` : "", refs.jobs.length ? `作业 ${refs.jobs.map((j) => j.name || j.jobId).join("、")}` : ""].filter(Boolean).join(";"),
      refs);
  }
  const r = await docClient.send(new DeleteCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: lakeExtBucketSk(set.targetId, b) }, ReturnValues: "ALL_OLD" }));
  if (r.Attributes) forgetLakeRoutesMemo();
  return !!r.Attributes;
}
