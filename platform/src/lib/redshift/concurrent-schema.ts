// @kf-batch 50-concurrent-schema-create
// **`CREATE SCHEMA IF NOT EXISTS` 在 Redshift 不是并发安全的** —— 这一类缺陷的唯一作者。
//
// 🔴 2026-09-19 真环境(全新账号,第二个 region):6 个同步任务并发跑,每个都先建自己的目标 schema
//   (同一个 `showcase`)⇒ 其中 3 个当场失败:
//     `CREATE SCHEMA failed: ERROR: duplicate key violates unique constraint
//      "pg_namespace_nspname_index" (possibly caused by concurrent transaction conflict)`
//   后果不是「慢」,是**级联**:3 张表没落地 ⇒ 依赖它们的 ETL 报 `relation "showcase.ad_channels"
//   does not exist` ⇒ 编排那条链跟着红 ⇒ 治理在目录里找不到产物表。**一个根因,六条红**,
//   而根因离症状很远(用户看到的是「ETL 失败」)。
//   主控区没现形,只因为那边是「7 张表一个同步任务」——**并发度是 1**。
//
// 🔴 为什么 `IF NOT EXISTS` 挡不住:它不是原子的。两个会话同时看到「schema 不存在」,
//   于是都去往 `pg_namespace` 插一行,后提交的那个撞唯一索引。Redshift 自己的提示词就写着
//   `possibly caused by concurrent transaction conflict`。这是「先查再建」的经典竞态,
//   与语句里写不写 `IF NOT EXISTS` 无关。
//
// 🔴 判别力(为什么不是一层盲重试):重试只在**两个条件同时成立**时才做 ——
//   ① 错误是那个并发签名;② 这条语句本身是**幂等的** schema 创建(带 `IF NOT EXISTS`)。
//   这样:真写错的 `CREATE SCHEMA x`(x 已存在、没写 IF NOT EXISTS)照旧**立刻红**,
//   权限不足 / 拼写错等一切别的错误**一次都不重试** —— 不许把真故障拖成「慢」。

/** 并发创建者赢了的签名(Redshift 对 `pg_namespace` 唯一索引的报错)。 */
export function isConcurrentSchemaCreate(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "").toLowerCase();
  if (!msg) return false;
  if (msg.includes("pg_namespace_nspname_index")) return true;
  // 不同版本措辞可能只给「duplicate key」+「schema already exists」;两者都要落在 schema 语境里。
  const dup = msg.includes("duplicate key") || msg.includes("already exists");
  return dup && (msg.includes("schema") || msg.includes("namespace"));
}

/** 这条 SQL 是不是**幂等的** schema 创建(只有它才配得上重试)。 */
export function isIdempotentSchemaCreate(sql: string): boolean {
  return /^\s*create\s+schema\s+if\s+not\s+exists\b/i.test(sql || "");
}

export interface SchemaRetryOpts {
  attempts?: number;
  /** 退避基数(毫秒);第 i 次等 delayMs * (i + 1)。测试传 0。 */
  delayMs?: number;
}

/**
 * 跑一条 DDL;只在「并发创建者赢了 + 这条语句是幂等 schema 创建」时重试。
 *
 * 重试为什么就能好:并发者提交之后,再跑一次 `CREATE SCHEMA IF NOT EXISTS` 就是真正的 no-op 成功
 * —— 也就是说重试后的成功**本身**就证明 schema 已经在了,不需要另外查一次。
 */
export async function withSchemaCreateRetry<T>(
  sql: string,
  run: () => Promise<T>,
  opts: SchemaRetryOpts = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const delayMs = opts.delayMs ?? 1500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
      const retryable = isIdempotentSchemaCreate(sql) && isConcurrentSchemaCreate(e);
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}
