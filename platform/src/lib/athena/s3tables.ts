// 枚举 S3 Tables 表桶下的命名空间与表，供前端表树与查询拼接 3 段限定名。
// 用 s3tables 控制面 API（ListNamespaces / ListTables），不依赖 Glue 目录的可读性。

import { homeRegion } from "@/lib/place/home-region";
// 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { notePlaceDecision } from "@/lib/place/context";
import {
  S3TablesClient,
  ListNamespacesCommand,
  ListTablesCommand,
} from "@aws-sdk/client-s3tables";
// 数据湖表桶路由:一个执行环境的全部落点 = 路由表(平台路由 + 外部路由),唯一作者 lib/lake/routes.ts;本文件只是它在 Athena 侧的薄壳
import { forgetLakeRoutesMemo, resolveLakeRoutes, routeForNamespace, type LakeRoute, type LakeTier } from "@/lib/lake/routes";

const region = homeRegion();
const account = process.env.AWS_ACCOUNT_ID || "";
const client = sdkClient("data-plane", S3TablesClient, { region });

export const S3TABLES_BUCKET = process.env.S3TABLES_BUCKET || "bgp-table-bucket";
export const S3TABLES_CATALOG = process.env.S3TABLES_CATALOG || "s3tablescatalog";

// Athena 联邦目录引用：catalog = `<联邦目录>/<表桶>`，查询 3 段名为 "catalog"."ns"."table"。
export const ATHENA_CATALOG_REF = `${S3TABLES_CATALOG}/${S3TABLES_BUCKET}`;

/** 表桶 ARN —— 🔴 只接受**已解析的落点**(原来是零参函数,恒拼主控区的那一个)。 */
function tableBucketArnOf(place: S3TablesPlace): string {
  return `arn:aws:s3tables:${place.region}:${account}:bucket/${place.bucket}`;
}

export interface S3TableInfo {
  namespace: string;
  name: string;
  // 直接可放进查询 FROM 的完整限定名（已加双引号）。
  qualifiedName: string;
}

export interface S3NamespaceTree {
  namespace: string;
  tables: S3TableInfo[];
  // 这个命名空间来自哪个表桶(平台表桶 / 已登记的外部表桶);存量只有平台表桶的调用方不读这三个键
  bucket?: string;
  catalog?: string;
  external?: boolean;
}

/**
 * 三段限定名 `"<目录引用>"."ns"."table"`。
 * 🔴🔴 原签名 `qualifiedName(ns, table)` 恒用**主控区**的目录引用 ⇒ 别的区的调用方
 *   (实时计算「查询结果」)拼出来的 SELECT 指向主控区的表桶。⇒ 目录引用改成**必填**,由调用方从
 *   `resolveS3TablesPlace(targetId).catalogRef` 取 —— 不给就编译不过,不再有「漏传 = 主控区」这条静默路。
 */
export function qualifiedName(catalogRef: string, namespace: string, table: string): string {
  return `"${catalogRef}"."${namespace}"."${table}"`;
}

// 表树按区。
/** 某个 target 的 S3 Tables 落点(表桶实名 + region + 联邦目录引用)。 */
export interface S3TablesPlace {
  targetId: string;
  region: string;
  bucket: string;
  /** Athena 查询用的联邦目录引用 `<catalog>/<bucket>` */
  catalogRef: string;
  home: boolean;
}

/**
 * 解析某个执行范围的 S3 Tables 落点。
 * 🔴 非 home 的表桶名取描述符资源袋 `tableBucket`(部署期实名),不由这里拼。
 * home 逐字节等价:仍用上面那对 env 值。
 */
// 落点必填(原来缺省 = 主控区);空串 / 非法 ⇒ 抛,不变成主控区
export async function resolveS3TablesPlace(targetId: string): Promise<S3TablesPlace> {
  notePlaceDecision({ targetId, via: "resolveS3TablesPlace" });
  const { HOME_TARGET_ID, isHome, assertTargetId } = await import("@/lib/exec-env/target-id");
  const id = assertTargetId(targetId);
  if (isHome(id)) {
    return { targetId: HOME_TARGET_ID, region, bucket: S3TABLES_BUCKET, catalogRef: ATHENA_CATALOG_REF, home: true };
  }
  const { requireReadyTarget } = await import("@/lib/exec-env/registry");
  const t = await requireReadyTarget(id);
  const bag = (t.resources ?? {}) as Record<string, unknown>;
  const bucket = typeof bag.tableBucket === "string" ? bag.tableBucket : "";
  if (!bucket) {
    throw new Error(
      `执行环境 ${id} 的资源清单里没有 S3 Tables 表桶(tableBucket)—— 已拒绝列举,` +
        `不会拿主控区的表桶顶上(那样列出来的是主控区的表)`
    );
  }
  return { targetId: id, region: t.region, bucket, catalogRef: `${S3TABLES_CATALOG}/${bucket}`, home: false };
}

// ── 一个执行环境的**全部**S3 Tables 落点 = 路由表(平台路由 + 已登记的外部路由)──────────
//   缺陷原形:直查表树 / 治理目录 / 问数只认 resolveS3TablesPlace ⇒ 客户写进自己表桶的数据在平台里一张表都看不到。
export interface S3TablesPlaceEx extends S3TablesPlace {
  /** false = 该区平台表桶(部署期建);true = 平台管理员登记的外部表桶 */
  external: boolean;
  label?: string;
  /** 数据湖表桶路由:路由元数据(Spark 目录别名 / 分层 / 可写) */
  alias: string;
  tier: LakeTier;
  writable: boolean;
}

/** 登记 / 撤销路由后调用(兼容名;真缓存在 lib/lake/routes.ts)。 */
export function forgetExternalBucketsMemo(): void { forgetLakeRoutesMemo(); }

function placeOfRoute(route: LakeRoute, home: boolean): S3TablesPlaceEx {
  return {
    targetId: route.targetId, region: route.region, bucket: route.bucket, catalogRef: route.catalogRef, home,
    external: !route.platform, ...(route.label ? { label: route.label } : {}),
    alias: route.alias, tier: route.tier, writable: route.writable,
  };
}

/** 平台表桶在前,外部桶按登记顺序(15s 读缓存在路由作者里;写侧判定请直接用 lib/lake/routes 的 fresh 读)。 */
export async function resolveS3TablesPlaces(targetId: string): Promise<S3TablesPlaceEx[]> {
  const set = await resolveLakeRoutes(targetId);
  return set.all.map((r) => placeOfRoute(r, set.home));
}

/** 全部落点的命名空间树(每个命名空间带 bucket / catalog / external;平台表桶在前,外部桶按登记顺序)。 */
export async function listNamespaceTreeAll(places: S3TablesPlaceEx[]): Promise<S3NamespaceTree[]> {
  const out: S3NamespaceTree[] = [];
  for (const p of places) {
    const tree = await listNamespaceTree(p);
    for (const ns of tree) out.push({ ...ns, bucket: p.bucket, catalog: p.catalogRef, external: p.external });
  }
  return out;
}

/**
 * 按命名空间找到它所在的落点(问数 / 探查用:用户只选了「库」,目录由平台解析)。
 * 🔴 数据湖表桶路由:改走路由作者的 `routeForNamespace`,**fail-closed** —— 哪条路由都没有这个命名空间 ⇒ 抛 LAKE_ROUTE_NOT_FOUND;
 *   两条都有且没人声明归属 ⇒ 抛 LAKE_ROUTE_AMBIGUOUS。原来「哪个桶都没有 ⇒ 回平台表桶」那条静默默认(外部表桶登记遗留)已删。
 */
export async function resolveS3TablesPlaceForNamespace(targetId: string, namespace: string): Promise<S3TablesPlace> {
  const route = await routeForNamespace(targetId, namespace);
  const set = await resolveLakeRoutes(targetId);
  return placeOfRoute(route, set.home);
}

const s3tClients = new Map<string, S3TablesClient>();
function clientForRegion(r: string): S3TablesClient {
  if (r === region) return client;
  let c = s3tClients.get(r);
  if (!c) {
    c = sdkClient("data-plane", S3TablesClient, { region: r });
    s3tClients.set(r, c);
  }
  return c;
}

// 列出表桶下所有命名空间及其表，组织成树。
// 🔴 落点**必填**(原来 `place?` 缺省 = 主控区;主控区调用方现在显式解析 home 的落点)。
export async function listNamespaceTree(place: S3TablesPlace): Promise<S3NamespaceTree[]> {
  const arn = tableBucketArnOf(place);
  const c = clientForRegion(place.region);
  const nsResp = await c.send(new ListNamespacesCommand({ tableBucketARN: arn }));
  const namespaces = (nsResp.namespaces || [])
    .map((n) => (Array.isArray(n.namespace) ? n.namespace[0] : undefined))
    .filter((n): n is string => Boolean(n));

  const tree: S3NamespaceTree[] = [];
  for (const ns of namespaces) {
    const tResp = await c.send(new ListTablesCommand({ tableBucketARN: arn, namespace: ns }));
    const tables: S3TableInfo[] = (tResp.tables || [])
      .filter((t) => t.name)
      .map((t) => ({
        namespace: ns,
        name: t.name as string,
        // 🔴 三段名里的目录引用必须用**该区**的表桶,否则点表生成的 SELECT 打回主控区
        qualifiedName: qualifiedName(place.catalogRef, ns, t.name as string),
      }));
    tree.push({ namespace: ns, tables });
  }
  return tree;
}
