// 治理目录「同步列信息」的工作体(唯一作者;原在 app/api/governance/sync-redshift-schema/route.ts,模块 55 第二批搬到 lib 让执行体调)。
//
// 把 Redshift + S3 Tables 真实列信息回填到 OpenMetadata(修治理目录「字段数」恒为 1,并为列级血缘提供真实列名来源)。
// 幂等、只读 information_schema + 写 OM 元数据。
//
// 🔴 列级血缘根治(时序自愈):真实列回填后,【立即重推同步血缘(sync 边)+ 计算血缘(sql 边)】,
//    让列级 identity/shared-column 映射用刚回填的真实列名重新派生。根治「首次同步推血缘时
//    OM 里表列还是 _row 占位 → 列级映射为空 → 之后回填列却不重推 → 列级永久消失」的缺陷。
//    因列级血缘 = f(OM 真实列, 边集合) 的幂等纯函数,在"真实列变化"这唯一状态变更点重求值一次,
//    无论同步/回填谁先谁后,终态都收敛到正确列级血缘。
import { pushRedshiftSchemaToOpenMetadata, pushS3TablesSchemaToOpenMetadata } from "@/lib/openmetadata/om-push";
import { backfillComputeLineageToOM, repushSyncLineageToOM } from "@/lib/governance/lineage-service";
import type { SchemaSyncResult } from "./schema-sync-run";

export async function schemaSyncWork(): Promise<SchemaSyncResult> {
  const rs = await pushRedshiftSchemaToOpenMetadata();
  // S3 Tables (Iceberg) 列回填是最佳努力:Athena 不可达/命名空间为空不应让整个回填失败。
  let s3 = { tables: 0, columns: 0 };
  try {
    s3 = await pushS3TablesSchemaToOpenMetadata();
  } catch (e: unknown) {
    console.error(`[schema-sync] S3 Tables 列回填失败(忽略): ${(e as Error)?.message || e}`);
  }
  // 真实列已就绪 → 重推列级血缘。sync 边:重放 pushSync;compute 边:shared-column 重算。
  // 【异步化(fire-and-forget)】:血缘是旁路(best-effort),不阻塞回填结论 —— 后台跑,幂等 merge-preserve,最终收敛。
  void (async () => {
    try {
      await repushSyncLineageToOM(); // sync 边列级(真实列 identity)
      await backfillComputeLineageToOM(); // compute 边列级(shared-column)
    } catch (e: unknown) {
      console.error(`[schema-sync] 列级血缘重推失败(忽略): ${(e as Error)?.message || e}`);
    }
  })();
  return { tables: rs.tables + s3.tables, columns: rs.columns + s3.columns, redshift: rs, s3tables: s3 };
}
