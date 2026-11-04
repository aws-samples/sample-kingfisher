// 模块 24 — 枚举 S3 Tables 表桶下的命名空间与表，供前端表树与查询拼接 3 段限定名。
// 用 s3tables 控制面 API（ListNamespaces / ListTables），不依赖 Glue 目录的可读性。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { notePlaceDecision } from "@/lib/place/context";
import {
  S3TablesClient,
  ListNamespacesCommand,
  ListTablesCommand,
} from "@aws-sdk/client-s3tables";

const region = homeRegion();
const account = process.env.AWS_ACCOUNT_ID || "";
const client = sdkClient("data-plane", S3TablesClient, { region });

export const S3TABLES_BUCKET = process.env.S3TABLES_BUCKET || "bgp-table-bucket";
export const S3TABLES_CATALOG = process.env.S3TABLES_CATALOG || "s3tablescatalog";

// Athena 联邦目录引用：catalog = `<联邦目录>/<表桶>`，查询 3 段名为 "catalog"."ns"."table"。
export const ATHENA_CATALOG_REF = `${S3TABLES_CATALOG}/${S3TABLES_BUCKET}`;

/** 表桶 ARN —— 🔴 只接受**已解析的落点**(B-26:原来是零参函数,恒拼主控区的那一个)。 */
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
  // 序 38 B-71:这个命名空间来自哪个表桶(平台表桶 / 已登记的外部表桶);存量只有平台表桶的调用方不读这三个键
  bucket?: string;
  catalog?: string;
  external?: boolean;
}

/**
 * 三段限定名 `"<目录引用>"."ns"."table"`。
 * 🔴🔴 B-26(2026-10-01):原签名 `qualifiedName(ns, table)` 恒用**主控区**的目录引用 ⇒ 别的区的调用方
 *   (实时计算「查询结果」)拼出来的 SELECT 指向主控区的表桶。⇒ 目录引用改成**必填**,由调用方从
 *   `resolveS3TablesPlace(targetId).catalogRef` 取 —— 不给就编译不过,不再有「漏传 = 主控区」这条静默路。
 */
export function qualifiedName(catalogRef: string, namespace: string, table: string): string {
  return `"${catalogRef}"."${namespace}"."${table}"`;
}

// @kf-batch 50-WP4ter-coverage —— 工单 SC-4:表树按区。
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
// @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 = 主控区);空串 / 非法 ⇒ 抛,不变成主控区
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

// ── 序 38 B-71:一个执行环境的**全部**S3 Tables 落点 = 平台表桶 + 已登记的外部表桶 ─────────────────
//   缺陷原形:直查表树 / 治理目录 / 问数只认 resolveS3TablesPlace ⇒ 客户写进自己表桶的数据在平台里一张表都看不到。
export interface S3TablesPlaceEx extends S3TablesPlace {
  /** false = 该区平台表桶(部署期建);true = 平台管理员登记的外部表桶(平台只读它) */
  external: boolean;
  label?: string;
}

/**
 * 登记表读缓存(进程内,15s):同一页 / 同一次问数会连着解析好几次落点,不必每次都查 DDB。
 * 🔴 挂在 globalThis(Symbol.for)而不是模块级变量:Next 产物里同一源文件在不同路由 bundle 里是**不同的模块实例**
 *   (记忆 next-bundle-duplicate-module-instances),模块级 Map 会让登记路由的 forget 对表树路由的缓存静默失明 ——
 *   2026-10-13 s38 单跑 71b 就是这样红的(登记后立刻查表树没看见,15s 后才有)。跨任务(多个 ECS task)仍靠 15s TTL 收敛。
 */
const EXT_BUCKETS_TTL_MS = 15_000;
type ExtBucketsMemo = Map<string, { at: number; rows: Array<{ bucket: string; label?: string }> }>;
const EXT_MEMO_KEY = Symbol.for("bgp.lake.externalTableBuckets.memo");
function extBucketsMemo(): ExtBucketsMemo {
  const g = globalThis as unknown as Record<symbol, ExtBucketsMemo | undefined>;
  return (g[EXT_MEMO_KEY] ??= new Map());
}
/** 登记 / 撤销外部表桶后调用:本进程内所有模块实例立刻看到新清单。 */
export function forgetExternalBucketsMemo(): void { extBucketsMemo().clear(); }

export async function resolveS3TablesPlaces(targetId: string): Promise<S3TablesPlaceEx[]> {
  const primary = await resolveS3TablesPlace(targetId);
  const store = extBucketsMemo();
  const memo = store.get(primary.targetId);
  let ext: Array<{ bucket: string; label?: string }>;
  if (memo && Date.now() - memo.at < EXT_BUCKETS_TTL_MS) {
    ext = memo.rows;
  } else {
    const { listExternalTableBuckets } = await import("@/lib/lake/external-table-buckets");
    ext = (await listExternalTableBuckets(primary.targetId)).map((e) => ({ bucket: e.bucket, ...(e.label ? { label: e.label } : {}) }));
    store.set(primary.targetId, { at: Date.now(), rows: ext });
  }
  return [
    { ...primary, external: false },
    ...ext.map((e) => ({
      targetId: primary.targetId, region: primary.region, bucket: e.bucket,
      catalogRef: `${S3TABLES_CATALOG}/${e.bucket}`, home: primary.home, external: true, ...(e.label ? { label: e.label } : {}),
    })),
  ];
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
 * 平台表桶优先;外部桶按登记顺序;哪个桶都没有这个命名空间 ⇒ 回平台表桶(Athena 会如实报 schema 不存在,与改动前一致)。
 */
export async function resolveS3TablesPlaceForNamespace(targetId: string, namespace: string): Promise<S3TablesPlace> {
  const places = await resolveS3TablesPlaces(targetId);
  if (places.length === 1) return places[0];
  for (const p of places) {
    const c = clientForRegion(p.region);
    const arn = tableBucketArnOf(p);
    let tok: string | undefined;
    do {
      const r = await c.send(new ListNamespacesCommand({ tableBucketARN: arn, ...(tok ? { continuationToken: tok } : {}) }));
      const names = (r.namespaces || []).map((n) => (Array.isArray(n.namespace) ? n.namespace[0] : undefined));
      if (names.includes(namespace)) return p;
      tok = r.continuationToken;
    } while (tok);
  }
  return places[0];
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
// 🔴 B-26:落点**必填**(原来 `place?` 缺省 = 主控区;主控区调用方现在显式解析 home 的落点)。
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
