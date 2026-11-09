// 数据湖表桶路由(设计稿 §6.6 第四个预检入口)—— Flink 应用预检要量的数据湖路由(纯函数)。
//
// Phase 1 的 Flink 还只能写**平台表桶**(模板目录 `s3t` 的 warehouse = `${TABLE_BUCKET_ARN}`,flink-service.ts#resolveS3TableSink);
//   Phase 3 才有 `lakeRoute` 选桶。所以这里的规则只有一条:SQL 真用到了 S3 Tables sink(引用 `s3t.` 目录,或带 `${TABLE_BUCKET_ARN}` 占位)
//   ⇒ 预检按**平台路由 write** 量 s3tables 写集;没用到 ⇒ 不量(一个只写 MySQL / Kinesis 的 Flink 作业不该被要求 s3tables 权限)。
// 🔴 不扫 SQL 就一律量 = 给自建 Flink 角色凭空加一条「必须能写湖」的要求,会把客户现网能跑的作业在保存时拒掉(假红)。
import { platformRouteOf, type SelectedRoute } from "@/lib/lake/routes";
import type { FlinkPlace } from "./flink-place";

/** SQL 是否用到了 S3 Tables sink(模板目录名 `s3t`,或平台占位符)。 */
export function flinkSqlSinksLake(sql: string | undefined): boolean {
  const s = String(sql ?? "");
  return /\bs3t\s*\./i.test(s) || s.includes("${TABLE_BUCKET_ARN}");
}

export function flinkLakeRoutesFor(place: Pick<FlinkPlace, "targetId" | "region" | "s3tablesBucket">, sql: string | undefined): SelectedRoute[] {
  if (!flinkSqlSinksLake(sql)) return [];
  return [{ ...platformRouteOf({ targetId: place.targetId, region: place.region, tableBucket: place.s3tablesBucket }), access: "write" }];
}
