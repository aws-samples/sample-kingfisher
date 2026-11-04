// Redshift schema introspection for GenBI grounding. Reuses the same catalog query as
// /api/redshift/schemas and renders a compact per-table column catalog injected into the
// agent's system prompt.

// @kf-batch 50-WP2-directquery —— 裸客户端 / 落点 / 轮询收编进 `lib/redshift/direct-query.ts`。
// 🔴🔴 **用户 2026-09-09 拍板「连问数都可以切区」**(原话:「我是不是连问数都可以切?查询的是每个区域的,
//    AgentCore 这一整套只是在主控区有。这样可以的我理解」)⇒ 本文件不再 `assertHomeOnly`:
//    schema 探查按**给定 target 的数仓**执行(AgentCore 仍只在主控区,它是控制面,不影响这里)。
import {
  directQueryRaw,
  resolveDirectQueryPlace,
  type DirectQueryScope,
} from "@/lib/redshift/direct-query";
import { GENBI } from "./config";
// SCHEMA_SQL 常量 / SchemaColumn / SchemaTable 类型 / buildCatalogText 已收敛进 @genbi/core
// （引擎无关纯逻辑,容器/Lambda 共用）。本文件保留 introspectSchema(Redshift Data API 适配器)。
import { SCHEMA_SQL } from "./core/catalog";
export { SCHEMA_SQL, buildCatalogText } from "./core/catalog";
export type { SchemaColumn, SchemaTable } from "./core/types";
import type { SchemaTable } from "./core/types";


function strCell(cell: unknown): string {
  if (cell == null) return "";
  const v = Object.values(cell as Record<string, unknown>)[0];
  return v == null ? "" : String(v);
}


export async function introspectSchema(
  workgroup: string,
  database: string,
  // @kf-batch 52-P52.5a-supply — 加 `project` 位。
  // 🔴 本函数有 7 个调用方,**purpose 不同**:问数/Copilot/BI schema = project-context;
  //    敏感扫描 / om-push / 治理健康 = governance-read(它们本无 project ⇒ **不传**)。
  //    所以归类不能写在本函数里,只能由**调用点**决定 —— 这正是 §3.9 那句
  //    「判定按调用点静态归类,非运行时看 SQL 猜」的意思。
  // @kf-batch 50-WP31-place-first-class —— 🔴 落点必填(原来可省 = 主控区;主控区也要点名 HOME_TARGET_ID)
  opts: { targetId: string; project: string | null }
): Promise<SchemaTable[]> {
  // @kf-batch 50-WP2-directquery
  // 🔴 落点取**这个 target 的**四样;`workgroup` / `database` 入参仍然被尊重(调用方显式指定的优先),
  //    与收编前逐字节一致 —— 收编只是把「客户端 / 凭证 / 轮询」换成单一作者。
  const scope: DirectQueryScope = { targetId: opts.targetId, projectId: opts.project };
  const place = await resolveDirectQueryPlace(scope);
  const raw = await directQueryRaw(
    { ...place, workgroup: workgroup || place.workgroup, database: database || place.database },
    SCHEMA_SQL,
    {
      rounds: GENBI.pollAttempts,
      intervalMs: GENBI.pollIntervalMs,
      // 文案与收编前逐字一致(GenBI 侧的错误处理读这几个字符串)
      failedMessage: (status, err) => err || status || "schema introspection failed",
      timeoutMessage: "schema introspection 超时",
    }
  );
  const map: Record<string, SchemaTable> = {};
  for (const row of raw.records) {
    const schema = strCell(row[0]);
    const table = strCell(row[1]);
    const col = strCell(row[2]);
    const type = strCell(row[3]);
    if (!schema || !table) continue;
    const key = `${schema}.${table}`;
    if (!map[key]) map[key] = { schema, table, columns: [] };
    if (col) map[key].columns.push({ name: col, type });
  }
  return Object.values(map);
}
