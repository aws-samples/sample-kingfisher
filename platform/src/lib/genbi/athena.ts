// M1 (v1.18.0) — GenBI 的「数据湖 / S3 Tables」引擎：用 Amazon Athena 对联邦目录
// s3tablescatalog 查询 Iceberg 表。与 genbi/redshift.ts(runSelect) + genbi/schema.ts
// (introspectSchema) 对偶，供 agent 在 engine="athena" 时使用。统一只读。

import { startQuery, getExecution, getResults, resolveAthenaPlace } from "@/lib/athena/client";
// 数据湖侧也按区(表桶 / 联邦目录 / 客户端整体解析)
import { resolveS3TablesPlace, resolveS3TablesPlaceForNamespace } from "@/lib/athena/s3tables";
import { sanitizeReadOnly } from "@/lib/athena/sql-guard";
import { ATHENA_CATALOG_REF } from "@/lib/athena/s3tables";
import { GENBI } from "./config";
import type { SchemaTable } from "./schema";
import type { SqlRunResult } from "./redshift";
// 原先这里 import `assertHomeOnly`:那一批只开了参数位、
// 非 home 一律抛错(当时 Athena 客户端只有 home 一套)。现在 `lib/athena/client.ts` 与
// `lib/athena/s3tables.ts` 都能按区解析落点 ⇒ 那道 fail-closed 已经不需要,删掉即为真按区。

export const S3TABLES_NAMESPACE = process.env.S3TABLES_NAMESPACE || "ecommerce";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 用一条 information_schema 查询拿到整个命名空间所有表的列（高效，避免逐表 DESCRIBE）。
// 🔴🔴 (2026-10-01 无头实测):`opts?` 可省 ⇒ 问数主循环两处调用**都没传** ⇒ 在 us-west-2 视角问数据湖,
//   表结构与取数全部打在主控区(us-west-2 的 Athena 工作组自建成以来 0 条查询)。参数位早就开了,只是没人接上
//   (`warehouse-location.test.ts` 当年只验了「形参存在」)。⇒ 落点改成**必填键**:值可以是 `undefined`(= 显式主控区),
//   但调用方必须**写出来**,漏写编译不过 —— 同 [[silent-default-is-a-defect-class]] 的根治形状。
// 值也必填(原来 `undefined` = 显式主控区,仍是静默默认的一种写法)
// `catalogRef` 可选 —— 调用方明确知道命名空间在哪个表桶时(目录同步逐桶扫)显式给;
//   不给 ⇒ 按命名空间在「平台表桶 + 已登记外部表桶」里找(问数 / BI / 向导只让用户选了「库」)。
export type LakeTarget = { targetId: string; catalogRef?: string };

export async function introspectS3Tables(
  namespace: string,
  opts: LakeTarget
): Promise<SchemaTable[]> {
  // 🔴 原来这里是 `assertHomeOnly`(非 home 直接抛):
  // 那让「在 us-west-2 问数据湖」这件事**根本用不了**。现在落点整体解析:
  // region + workgroup + 结果桶 + **联邦目录引用**四样都取该 target 的(缺一样就是查错区)。
  const place = await resolveAthenaPlace(opts.targetId);
  const catalog = opts.catalogRef ?? (await resolveS3TablesPlaceForNamespace(opts.targetId, namespace)).catalogRef;
  const id = await startQuery(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = '${namespace}' ORDER BY table_name, ordinal_position`,
    { catalog, database: namespace },
    place
  );
  for (let i = 0; i < GENBI.pollAttempts; i++) {
    await sleep(GENBI.pollIntervalMs);
    // 🔴 轮询与取结果都必须打到发起它的那个区
    const ex = await getExecution(id, place.region);
    if (ex.state === "SUCCEEDED") {
      const res = await getResults(id, 1000, undefined, place.region);
      const map: Record<string, SchemaTable> = {};
      for (const row of res.rows) {
        const table = row[0];
        const col = row[1];
        const type = row[2];
        if (!table || !col) continue;
        const key = `${namespace}.${table}`;
        if (!map[key]) map[key] = { schema: namespace, table: String(table), columns: [] };
        map[key].columns.push({ name: String(col), type: String(type || "") });
      }
      return Object.values(map);
    }
    if (ex.state === "FAILED" || ex.state === "CANCELLED") {
      throw new Error(ex.error || ex.state || "S3 Tables schema introspection failed");
    }
  }
  throw new Error("S3 Tables schema introspection 超时");
}

// 在 Athena 执行模型生成的只读 SQL（Trino 方言，三段式联邦目录名）。返回与 Redshift 路径一致的 SqlRunResult。
export async function runSelectAthena(modelSql: string, opts: LakeTarget): Promise<SqlRunResult> {
  // 同上:不再 fail-closed 到 home,改真按区执行
  const place = await resolveAthenaPlace(opts.targetId);
  // 执行层回报真落点(问数 `_meta.ranIn` 的来源之一)
  const ranIn = { engine: "athena" as const, region: place.region, workgroup: place.workgroup };
  const guard = sanitizeReadOnly(modelSql, GENBI.maxRows);
  if (!guard.ok || !guard.sql) {
    return { success: false, sql: modelSql, columns: [], rows: [], rowCount: 0, error: guard.error };
  }
  try {
    const id = await startQuery(guard.sql, undefined, place);
    for (let i = 0; i < GENBI.pollAttempts; i++) {
      await sleep(GENBI.pollIntervalMs);
      const ex = await getExecution(id, place.region);
      if (ex.state === "SUCCEEDED") {
        const res = await getResults(id, GENBI.maxRows, undefined, place.region);
        return {
          success: true,
          sql: modelSql,
          executedSql: guard.sql,
          columns: res.columns,
          columnTypes: res.columnTypes,
          rows: res.rows,
          rowCount: res.rows.length,
          ranIn,
        };
      }
      if (ex.state === "FAILED" || ex.state === "CANCELLED") {
        return { success: false, sql: modelSql, executedSql: guard.sql, columns: [], rows: [], rowCount: 0, error: ex.error || ex.state, ranIn };
      }
    }
    return { success: false, sql: modelSql, executedSql: guard.sql, columns: [], rows: [], rowCount: 0, error: "查询超时", ranIn };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, sql: modelSql, columns: [], rows: [], rowCount: 0, error: msg, ranIn };
  }
}
