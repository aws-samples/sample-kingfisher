// @kf-batch 50-P50.3-mirror
// 元数据镜像的**数仓目录**采集(Redshift `SVV_ALL_TABLES`)—— 只在**有请求上下文**时跑。
//
// ── 🔴 为什么它必须是独立文件、并且由调用方"注入"进采集流程 ──────────────────
// 两个理由叠在一起,任一条都足以拆:
// ① **编译边界**:定时采集挂在周期 reconciler 上,而 reconciler 被 `instrumentation.ts` 引用
//    ⇒ Next 会把它**同时编进 edge bundle**(那个编译没有 node 内置模块)。本文件经
//    `data-plane-target` → `privileged-cred` → `project-schema` 会用到 `crypto` ⇒
//    只要 `metadata-mirror.ts` **引用**了本文件(哪怕是 `await import()`),`next build` 就失败
//    (动态 import 只拆 chunk,webpack 照样 build 那个模块)。真部署已经吃过这一次。
// ② **语义边界**:非 home 的数仓绑定按 §3.9b **必须带 projectId**(project-context 不接受缺 projectId),
//    而定时循环里根本没有 projectId。⇒ 「定时采不了数仓」不是限制,是合同本身的形状。
//
// ⇒ 做法:`mirrorMetadata()` 只内建 Glue 采集;数仓采集由**路由**(有请求上下文的一侧)
//   import 本文件、造出 puller **注入**进去。于是「定时把每个区的 Serverless 数仓唤醒」这件事
//   **在类型层就不可能发生** —— 比我原来在运行期 `throw` 一句要硬。

import { resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import type { MirrorPullOutcome, MirrorSourcePuller } from "@/lib/exec-env/metadata-mirror";
import { sanitizeDbPayload, sanitizeTablePayload, MIRROR_MAX_ENTRIES } from "@/lib/exec-env/metadata-mirror";

/** 翻页上限(防一个畸形目录把请求拖死)。 */
const MAX_PAGES = 20;

/**
 * 造一个数仓目录 puller。
 *
 * 🔴 回来的行是**表名/schema 名**,不是表里的数据 —— 元数据边界仍然成立;
 * 条目 payload 仍然走 `sanitize*` 白名单重建(与 Glue 侧同一个作者)。
 */
/**
 * 列数仓目录的那一条 SQL。🔴 B-42:LIMIT 必须是 **MAX+1** —— 只取 MAX 行时第 MAX+1 行永远读不到
 * ⇒ 「超过上限」永远报不出来(截断判定 fail-open),而差集删除(镜像 + OM 对账)只在「不截断」时做。
 */
export const WAREHOUSE_TABLES_SQL =
  // 🔴 排除系统 schema:`pg_*` / `information_schema` 是引擎自带的,列进资产数是虚高
  "SELECT database_name, schema_name, table_name, table_type FROM SVV_ALL_TABLES " +
  "WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' " +
  `ORDER BY database_name, schema_name, table_name LIMIT ${MIRROR_MAX_ENTRIES + 1}`;

/** 结果行 → 采集产出(纯函数,截断判定的唯一作者)。`pagesExhausted` = 分页读到上限还没读完。 */
export function warehouseRowsToOutcome(rows: ReadonlyArray<readonly string[]>, pagesExhausted: boolean): MirrorPullOutcome {
  const entries: MirrorPullOutcome["entries"] = [];
  const dbs = new Map<string, number>();
  let tables = 0;
  let truncated = pagesExhausted;
  for (const [db, schema, table, ttype] of rows) {
    if (!db || !schema || !table) continue;
    if (tables >= MIRROR_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const dbKey = `${db}.${schema}`;
    entries.push({
      kind: "table",
      fqn: `redshift.${dbKey}.${table}`,
      payload: sanitizeTablePayload({ name: table, db: dbKey, source: "redshift", tableType: ttype, columns: [] }),
    });
    dbs.set(dbKey, (dbs.get(dbKey) ?? 0) + 1);
    tables++;
  }
  for (const [dbKey, n] of Array.from(dbs.entries())) {
    entries.push({
      kind: "db",
      fqn: `redshift.${dbKey}`,
      payload: sanitizeDbPayload({ name: dbKey, source: "redshift", tables: n }),
    });
  }
  // 🔴 列数**不编**:这条查询没查列(再查一次 `SVV_ALL_COLUMNS` 是第二条计费语句)⇒ 报 0,
  //    界面上由「列(Glue 侧)」这一行的口径说明覆盖(资产/库是真的,列只统计 Glue 侧)。
  // 数仓这条是一条 SQL 全量列出,没有「某个库读失败」的局部失败形态 ⇒ 恒空(失败整体抛)
  return { entries, databases: dbs.size, tables, columns: 0, truncated, unreadDatabases: [] };
}

export function warehousePuller(projectId: string): MirrorSourcePuller {
  return async (targetId: string): Promise<MirrorPullOutcome> => {
    const { GetStatementResultCommand } = await import("@aws-sdk/client-redshift-data");
    const { redshiftDataClientFor, execOnTarget } = await import("@/lib/exec-env/target-clients");
    const binding = await resolveRedshiftBinding({ targetId, projectId });
    if (!binding.secretArn) {
      throw new Error(
        `目标 ${targetId} 解析不到数仓凭证 ⇒ 拒绝采集(§3.9a:禁 IAM fallback,不省略 SecretArn)`
      );
    }
    const sql = WAREHOUSE_TABLES_SQL;
    const { statementId } = await execOnTarget({
      warehouse: {
        targetId: binding.targetId,
        region: binding.region,
        workgroup: binding.workgroup,
        database: binding.database,
      },
      sql,
      secretArn: binding.secretArn,
    });

    const client = redshiftDataClientFor(binding.region);
    const rows: string[][] = [];
    let pagesExhausted = false;
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.send(
        new GetStatementResultCommand({ Id: statementId, ...(token ? { NextToken: token } : {}) })
      );
      for (const row of r.Records ?? []) {
        const cell = (i: number) => String(row[i]?.stringValue ?? "").trim();
        rows.push([cell(0), cell(1), cell(2), cell(3)]);
      }
      token = r.NextToken;
      if (!token) break;
      if (page === MAX_PAGES - 1) pagesExhausted = true;
    }
    return warehouseRowsToOutcome(rows, pagesExhausted);
  };
}
