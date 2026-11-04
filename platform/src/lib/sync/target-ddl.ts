/**
 * 同步向导「生成 DDL / 执行 DDL」的**唯一作者**:建表参数 ⇒ 目标表全名 + 建表语句。
 *
 * 【为什么收成一处】
 *   · 原来 `execute-ddl` 收**客户端传来的任意 SQL** 并以数仓 admin 身份执行 —— 任何 editor 都能借它
 *     DROP / DELETE 客户的表。现在它只收建表参数,服务端用本函数**现生成**那一条 CREATE TABLE。
 *   · 原来预览 DDL 用带引号保大小写的 `"public"."Orders"`,而 Glue 脚本写小写安全化的 `public.orders`
 *     ⇒ 表名带大写时,向导建的表和同步写的**不是同一张**。现在两边都走 `sanitizeS3TablesIdentifier`。
 *   · 列名 / 列类型进 DDL 之前过白名单(列名 = 标识符,类型 = 类型字符),不合法即抛(调用方 400)。
 */
import { mapAllColumns, generateDDL } from "@/lib/sync/sync-service";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";
import { safeIdent } from "@/lib/modeling/redshift";

// Redshift 不带引号的标识符:ASCII 字母 / 下划线 / UTF-8 多字节开头,其后再允许数字与 `$`。
//   这正好挡掉一切 SQL 元字符(空格 / 引号 / 括号 / 分号 / 注释符),又不误伤中文列名。
const COL = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*$/;
const TYPE = /^[A-Za-z][A-Za-z0-9 _(),]*$/;

export interface TargetDdlInput {
  sourceDb?: string;
  tableName?: string;
  columns?: { name: string; type: string }[];
  redshiftConfig?: { schema?: string; distKey?: string; sortKeys?: string[]; distStyle?: string };
}

export interface TargetDdl {
  /** `schema.table`(小写、安全化;与 Glue 脚本的 rs_table、守卫的确认清单同一形态) */
  fq: string;
  ddl: string;
  mapped: ReturnType<typeof mapAllColumns>;
}

export class TargetDdlRejected extends Error {}

export function buildTargetDdl(input: TargetDdlInput): TargetDdl {
  const { sourceDb, tableName, columns, redshiftConfig } = input;
  if (!tableName || !columns?.length) throw new TargetDdlRejected("缺少 tableName 或 columns");
  const schemaRaw = redshiftConfig?.schema || "public";
  try {
    // 白名单校验放在任何拼接之前(safeIdent 非法即抛);目标名再按同步脚本的规则安全化。
    safeIdent(schemaRaw);
  } catch (e) {
    throw new TargetDdlRejected(`schema 不是合法标识符(只允许字母数字下划线、且不以数字开头):${String((e as Error)?.message ?? e)}`);
  }
  const table = sanitizeS3TablesIdentifier(tableName);
  const fq = `${schemaRaw.toLowerCase()}.${table}`;
  const mapped = mapAllColumns(sourceDb || "mysql", columns);
  for (const m of mapped) {
    if (!COL.test(String(m.target))) throw new TargetDdlRejected(`列名「${m.target}」不是合法标识符`);
    if (!TYPE.test(String(m.targetType))) throw new TargetDdlRejected(`列类型「${m.targetType}」不合法`);
  }
  const ddl = generateDDL(fq, mapped.map((m) => ({ target: m.target, targetType: m.targetType })), {
    distKey: redshiftConfig?.distKey,
    sortKeys: redshiftConfig?.sortKeys,
    distStyle: redshiftConfig?.distStyle,
  });
  return { fq, ddl, mapped };
}
