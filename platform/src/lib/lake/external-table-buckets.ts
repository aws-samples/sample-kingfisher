// 每个执行环境可登记**外部 S3 Tables 表桶**(客户自有、不是平台部署的那一个),唯一作者。
//
// 【缺陷原形(2026-10-13 客户生产环境)】直查表树 / 治理目录同步 / 问数都只认 `resolveS3TablesPlace(targetId)` 解析出的
//   **平台表桶**(主控区 bgp-table-bucket / 非 home 描述符 tableBucket)。客户把同步目标写进自己的表桶 bigdata-test-sg-tables
//   之后,作业成功、数据在,平台里却**一张表都看不到**(只能手写三段名查);用户只好把目标改回平台表桶。
// 【规则】登记 = 在 bgp-settings 落一行 `lake-ext-bucket#<targetId>#<bucket>`(平台管理员操作;登记前核该区真有这个表桶,
//   且不是该区的平台表桶);读侧 `resolveS3TablesPlaces(targetId)` = 平台表桶 + 已登记外部桶,三处消费面都改走它:
//   直查表树(每个命名空间标明来自哪个桶)/ 治理目录同步(每个桶一个 database)/ 问数(按命名空间找到它所在的桶)。
//   平台不主动写外部表桶(不建命名空间、不建表、不写数据);**只有把它选为 Table Bucket 的同步任务**才会在里面建命名空间 / 表。
// 登记表从此也是该执行环境**可写外部桶的唯一事实源**:非主控区执行环境的同步任务自带表桶,保存 / 启动都要求
//   它 ∈ {平台表桶} ∪ 本表(lib/sync/table-bucket.ts 唯一判定);主控区行为不变(历来允许任意自带桶)。
import { PutCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetTableBucketCommand, S3TablesClient } from "@aws-sdk/client-s3tables";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { sdkClient } from "@/lib/aws/clients";
import { SETTINGS_PK } from "@/lib/settings/model-store";

export const LAKE_EXT_BUCKET_SK_PREFIX = "lake-ext-bucket#";
/** S3 Tables 表桶名规则(3–63,小写字母 / 数字 / 连字符,首尾字母数字)。 */
export const TABLE_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface ExternalTableBucket {
  targetId: string;
  bucket: string;
  region: string;
  label?: string;
  addedBy: string;
  addedAt: string;
}

export class ExternalTableBucketError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "ExternalTableBucketError";
  }
}

export function lakeExtBucketSk(targetId: string, bucket: string): string {
  return `${LAKE_EXT_BUCKET_SK_PREFIX}${targetId}#${bucket}`;
}

export function assertTableBucketName(bucket: unknown): string {
  const s = typeof bucket === "string" ? bucket.trim() : "";
  if (!TABLE_BUCKET_NAME_RE.test(s)) {
    throw new ExternalTableBucketError(400, `表桶名不合法:${JSON.stringify(bucket)}(3–63 位小写字母 / 数字 / 连字符,首尾为字母或数字)`);
  }
  return s;
}

function rowOf(it: Record<string, unknown>): ExternalTableBucket {
  return {
    targetId: String(it.targetId ?? ""),
    bucket: String(it.bucket ?? ""),
    region: String(it.region ?? ""),
    ...(typeof it.label === "string" && it.label ? { label: it.label } : {}),
    addedBy: String(it.addedBy ?? ""),
    addedAt: String(it.addedAt ?? ""),
  };
}

/** 某个执行环境已登记的外部表桶(按登记时间稳定排序)。 */
export async function listExternalTableBuckets(targetId: string): Promise<ExternalTableBucket[]> {
  const out: ExternalTableBucket[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLES.SETTINGS,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": SETTINGS_PK, ":prefix": `${LAKE_EXT_BUCKET_SK_PREFIX}${targetId}#` },
      ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const it of (r.Items ?? []) as Record<string, unknown>[]) out.push(rowOf(it));
    key = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.bucket.localeCompare(b.bucket));
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

/**
 * 登记一个外部表桶:① 名字合法;② 不是该区的平台表桶;③ 该区真有这个表桶(GetTableBucket);④ 落库(幂等:重复登记回 409)。
 * 账号 = 平台所在账号(S3 Tables 表桶 ARN 带账号;跨账号表桶不在本刀范围 —— 客户生产是单账号多区,见 production-single-account-multi-region)。
 */
export async function registerExternalTableBucket(input: RegisterExternalTableBucketInput): Promise<ExternalTableBucket> {
  const bucket = assertTableBucketName(input.bucket);
  const { resolveS3TablesPlace, forgetExternalBucketsMemo } = await import("@/lib/athena/s3tables");
  const primary = await resolveS3TablesPlace(input.targetId);
  if (bucket === primary.bucket) {
    throw new ExternalTableBucketError(409, `${bucket} 就是执行环境 ${primary.targetId} 的平台表桶,本来就在表树里,不需要登记`);
  }
  const account = process.env.AWS_ACCOUNT_ID || "";
  const arn = `arn:aws:s3tables:${primary.region}:${account}:bucket/${bucket}`;
  const c = input.s3tablesClient ?? sdkClient("data-plane", S3TablesClient, { region: primary.region });
  try {
    await c.send(new GetTableBucketCommand({ tableBucketARN: arn }));
  } catch (e: unknown) {
    const err = (e ?? {}) as { name?: string; message?: string };
    if (err.name === "NotFoundException" || /not found|does not exist/i.test(String(err.message ?? ""))) {
      throw new ExternalTableBucketError(404, `在 ${primary.region} 没有名为 ${bucket} 的 S3 Tables 表桶(${arn})—— 登记前请先在该区建好,或核对名字`);
    }
    throw e;
  }
  const existing = (await listExternalTableBuckets(primary.targetId)).find((x) => x.bucket === bucket);
  if (existing) throw new ExternalTableBucketError(409, `${bucket} 已在执行环境 ${primary.targetId} 登记过(${existing.addedAt} by ${existing.addedBy})`);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : undefined;
  const row: ExternalTableBucket = {
    targetId: primary.targetId, bucket, region: primary.region, ...(label ? { label } : {}),
    addedBy: input.addedBy, addedAt: (input.now ?? new Date()).toISOString(),
  };
  await docClient.send(new PutCommand({
    TableName: TABLES.SETTINGS,
    Item: { pk: SETTINGS_PK, sk: lakeExtBucketSk(primary.targetId, bucket), ...row },
    ConditionExpression: "attribute_not_exists(sk)",
  }));
  // 登记变了 ⇒ 读缓存作废(本进程内所有模块实例立刻看到;跨 ECS task 靠 15s TTL)
  forgetExternalBucketsMemo();
  return row;
}

/** 撤销登记(只删登记行;表桶与里面的表一个不碰)。回 false = 本来就没登记。 */
export async function unregisterExternalTableBucket(targetId: string, bucket: unknown): Promise<boolean> {
  const b = assertTableBucketName(bucket);
  const r = await docClient.send(new DeleteCommand({
    TableName: TABLES.SETTINGS,
    Key: { pk: SETTINGS_PK, sk: lakeExtBucketSk(targetId, b) },
    ReturnValues: "ALL_OLD",
  }));
  if (r.Attributes) {
    const { forgetExternalBucketsMemo } = await import("@/lib/athena/s3tables");
    forgetExternalBucketsMemo();
  }
  return !!r.Attributes;
}
