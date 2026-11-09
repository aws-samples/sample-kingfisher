// 每个执行环境可登记**外部 S3 Tables 表桶**(客户自有、不是平台部署的那一个)。
//
// 【数据湖表桶路由(2026-11-04)起本文件只是薄壳】登记行长成了**路由**(bucket → alias / tier / namespaces / writable),唯一作者搬到
//   `lib/lake/routes.ts`(注入 / 预检 / 命名空间解析 / 读面都经它)。这里保留原函数名给存量调用方与判据:
//     listExternalTableBuckets      ⇒ 该执行环境的路由行(存量行当场派生 alias / tier / writable)
//     registerExternalTableBucket   ⇒ registerLakeRoute(别名按桶名派生、tier other、writable true;兼容口径)
//     unregisterExternalTableBucket ⇒ revokeLakeRoute
//   🔴 不要再往这里加逻辑;新代码直接 import `@/lib/lake/routes`。
// 【缺陷原形(2026-10-13 客户生产环境)】直查表树 / 治理目录同步 / 问数都只认平台表桶 ⇒ 客户把同步目标写进自己的表桶之后,
//   作业成功、数据在,平台里却一张表都看不到。
// 【2026-10-27】登记表从此也是该执行环境**可写外部桶的唯一事实源**;【2026-11-04】主控区同样只认路由,不再任意桶放行。
import {
  LakeRouteError, listLakeRouteRows, registerLakeRoute, revokeLakeRoute,
  LAKE_EXT_BUCKET_SK_PREFIX, TABLE_BUCKET_NAME_RE, lakeExtBucketSk, assertTableBucketName as assertTableBucketNameRoute,
  type LakeRouteRow,
} from "./routes";

export { LAKE_EXT_BUCKET_SK_PREFIX, TABLE_BUCKET_NAME_RE, lakeExtBucketSk };

/** 登记行(= 路由行;存量调用方只读其中的 targetId / bucket / region / label / addedBy / addedAt)。 */
export type ExternalTableBucket = LakeRouteRow;

/** 存量调用方 / 判据认的错误形态(status 400 / 404 / 409);新代码请直接处理 LakeRouteError。 */
export class ExternalTableBucketError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly code?: string, readonly detail?: unknown) {
    super(message);
    this.name = "ExternalTableBucketError";
  }
}

function rethrow(e: unknown): never {
  if (e instanceof LakeRouteError) throw new ExternalTableBucketError(e.status, e.message, e.code, e.detail);
  throw e;
}

export function assertTableBucketName(bucket: unknown): string {
  try { return assertTableBucketNameRoute(bucket); } catch (e) { return rethrow(e); }
}

/** 某个执行环境已登记的外部表桶(按登记时间稳定排序;直读 DDB,不走缓存)。 */
export async function listExternalTableBuckets(targetId: string): Promise<ExternalTableBucket[]> {
  return listLakeRouteRows(targetId);
}

export interface RegisterExternalTableBucketInput {
  targetId: string;
  bucket: unknown;
  label?: unknown;
  addedBy: string;
  /** 判据注入用;缺省按区建 s3tables 客户端 */
  s3tablesClient?: { send(cmd: unknown): Promise<unknown> };
  now?: Date;
}

/** 兼容登记入口:别名按桶名派生、分层 other、可写(§6.10.5)。 */
export async function registerExternalTableBucket(input: RegisterExternalTableBucketInput): Promise<ExternalTableBucket> {
  try {
    const route = await registerLakeRoute({ targetId: input.targetId, bucket: input.bucket, label: input.label, addedBy: input.addedBy, s3tablesClient: input.s3tablesClient, now: input.now });
    const { platform: _p, catalogRef: _c, bucketArn: _a, ...row } = route;
    return { ...row, addedBy: row.addedBy ?? input.addedBy, addedAt: row.addedAt ?? "" };
  } catch (e) {
    return rethrow(e);
  }
}

/** 撤销登记(只删登记行;表桶与里面的表一个不碰)。回 false = 本来就没登记。 */
export async function unregisterExternalTableBucket(targetId: string, bucket: unknown): Promise<boolean> {
  try { return await revokeLakeRoute(targetId, bucket); } catch (e) { return rethrow(e); }
}
