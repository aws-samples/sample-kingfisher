// run_sql executor for GenBI — runs read-only queries against Amazon Redshift via the
// Redshift Data API (ExecuteStatement -> poll DescribeStatement -> GetStatementResult),
// matching the platform's existing /api/redshift/* pattern.

// @kf-batch 50-WP2-directquery —— 裸客户端 / 落点 / 轮询收编进 `lib/redshift/direct-query.ts`。
// 🔴🔴 **用户 2026-09-09 拍板「连问数都可以切区」** ⇒ 不再 `assertHomeOnly`:
//    问数的 SQL 打到**当前执行范围那个区的数仓**;AgentCore(模型侧)仍只在主控区,不受影响。
import { directQueryRaw, resolveDirectQueryPlace } from "@/lib/redshift/direct-query";
import { GENBI } from "./config";
import { sanitizeSelect } from "./sql-guard";
import type { RanInMeta } from "@/lib/ai/meta";


export interface SqlRunResult {
  success: boolean;
  sql: string; // original model SQL (for display)
  executedSql?: string; // sanitized + capped SQL actually run
  columns: string[];
  columnTypes?: string[]; // 引擎列类型(与 columns 同序);供上层按类型格式化,可选(老消费者忽略)
  rows: (string | null)[][];
  rowCount: number;
  error?: string;
  /** @kf-batch 50-B26-lake-place —— 这条 SQL 真发出去的落点(执行层回报;落点没解析出来就没有) */
  ranIn?: RanInMeta;
}

function cellValue(cell: unknown): string | null {
  if (cell == null) return null;
  const obj = cell as Record<string, unknown>;
  if (obj.isNull) return null;
  const v = Object.values(obj)[0];
  return v == null ? null : String(v);
}


export async function runSelect(
  modelSql: string,
  workgroup: string,
  database: string,
  // @kf-batch 52-P52.5a-supply — 加 `project` 位(静态归类:**project-context**)。
  // @kf-batch 50-WP31-place-first-class —— 🔴 落点必填(原来可省 = 主控区;主控区也要点名 HOME_TARGET_ID)
  opts: { targetId: string; project: string | null }
): Promise<SqlRunResult> {
  const guard = sanitizeSelect(modelSql, GENBI.maxRows);
  if (!guard.ok || !guard.sql) {
    return { success: false, sql: modelSql, columns: [], rows: [], rowCount: 0, error: guard.error };
  }

  let ranIn: RanInMeta | undefined;
  try {
    // @kf-batch 50-WP2-directquery
    // 🔴 落点取**该 target 的**四样;`workgroup`/`database` 入参仍优先(调用方显式给的赢),与收编前一致。
    // 🔴 静态归类仍是 **project-context**(问数在项目上下文里取数)⇒ 非 home 的凭证由绑定解析按 project 发。
    const place = await resolveDirectQueryPlace({ targetId: opts.targetId, projectId: opts.project });
    const wgUsed = workgroup || place.workgroup;
    ranIn = { engine: "redshift", region: place.region, workgroup: wgUsed };
    const raw = await directQueryRaw(
      { ...place, workgroup: wgUsed, database: database || place.database },
      guard.sql,
      {
        rounds: GENBI.pollAttempts,
        intervalMs: GENBI.pollIntervalMs,
        // 🔴 文案与收编前逐字一致:引擎原文优先、否则状态字面量;超时是「查询超时」。
        //    收编前这两种情况是 `return {success:false,…}`,现在由 directQueryRaw 抛出、
        //    被本函数**已有的** catch 收成同一个形状(同 message)⇒ 对调用方逐字节等价。
        failedMessage: (status, err) => err || status,
        timeoutMessage: "查询超时",
      }
    );
    const rows = raw.records.map((row) => (row as unknown[]).map(cellValue));
    return {
      success: true,
      sql: modelSql,
      executedSql: guard.sql,
      columns: raw.columns,
      rows,
      rowCount: raw.totalNumRows ?? rows.length,
      ranIn,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, sql: modelSql, executedSql: guard.sql, columns: [], rows: [], rowCount: 0, error: msg, ...(ranIn ? { ranIn } : {}) };
  }
}
