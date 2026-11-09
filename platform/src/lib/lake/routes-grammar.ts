// 数据湖表桶路由—— 数据湖表桶路由的**文法与派生**(纯函数,零 AWS / 零 DDB;页面与服务端共用这一份)。
//
// 【为什么单独一个文件】`lib/lake/routes.ts` 是路由表的唯一作者,但它 import 了 S3 Tables / DynamoDB 客户端;
//   系统设置页要在输入表桶名时**当场**预填别名(`aliasFromBucket`),离线作业页要校验别名文法 —— 客户端组件不能把
//   AWS SDK 拉进浏览器包。⇒ 文法 / 闭合清单 / 派生规则放这里,服务端作者 re-export 它们;两处只有一份事实。
// 【设计稿】docs/design/58-lake-bucket-routing/DESIGN.en.md §6.1(Alias / Tier / Writable)、§8(alias 派生)。

/** Spark 目录名(别名)文法:小写字母开头,`[a-z0-9_]`,最长 32。 */
export const LAKE_ALIAS_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const LAKE_ALIAS_MAX_LEN = 32;

/** 平台表桶那条**隐式路由**的别名(D5:固定、不落行、与存量脚本 `s3tablescatalog.<ns>.<t>` 逐字相同)。 */
export const PLATFORM_ROUTE_ALIAS = "s3tablescatalog";

/** 保留别名:平台路由 / Spark 会话目录 / 常见 Glue 目录名 / default —— 外部路由不许用。 */
export const LAKE_RESERVED_ALIASES: ReadonlySet<string> = new Set([PLATFORM_ROUTE_ALIAS, "spark_catalog", "glue_catalog", "default"]);

/** 分层(闭合清单,D12:只做展示 / 合规标签,不带权限语义)。 */
export const LAKE_TIERS = ["detail", "agg", "result", "ods", "dim", "other"] as const;
export type LakeTier = (typeof LAKE_TIERS)[number];
export const LAKE_TIER_DEFAULT: LakeTier = "other";
/** 分层的中文标签(页面下拉与表格;英文词典键 = 这些中文串)。 */
export const LAKE_TIER_LABELS_ZH: Record<LakeTier, string> = {
  detail: "明细层",
  agg: "聚合层",
  result: "结果层",
  ods: "ODS 层",
  dim: "维度层",
  other: "其它",
};

/** 作业声明里每个桶的访问方式(D3:按桶分读 / 写)。 */
export const LAKE_ACCESS_MODES = ["read", "write"] as const;
export type LakeAccessMode = (typeof LAKE_ACCESS_MODES)[number];

/** 作业的一条数据湖表桶声明(Glue 作业 glueConfig / EMR 作业顶层的 `lakeBuckets[]` 元素;§6.2)。 */
export interface LakeBucketDeclaration { bucket: string; access: LakeAccessMode }

/** S3 Tables 表桶名规则(3–63,小写字母 / 数字 / 连字符,首尾字母数字)。 */
export const TABLE_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** 路由图(`别名=桶,别名=桶`)注进作业的键:Glue 作业参数 / EMR Spark conf(都是平台保留键,用户不许覆盖)。 */
export const GLUE_LAKE_CATALOGS_ARG = "--bgp_lake_catalogs";
export const EMR_LAKE_CATALOGS_CONF = "spark.bgp.lakeCatalogs";

/** S3 Tables 命名空间文法(服务侧:小写字母 / 数字 / 下划线,与 lib/sync/s3tables-identifier 的产物同形)。 */
export const LAKE_NAMESPACE_RE = /^[a-z0-9_]{1,255}$/;

export function isLakeTier(v: unknown): v is LakeTier {
  return typeof v === "string" && (LAKE_TIERS as readonly string[]).includes(v);
}

export function isLakeAccessMode(v: unknown): v is LakeAccessMode {
  return typeof v === "string" && (LAKE_ACCESS_MODES as readonly string[]).includes(v);
}

/** 别名文法判定(不抛;抛的版本在服务端作者 `assertAlias`)。回 null = 合法;否则一句话说明哪里不合法。 */
export function aliasProblem(alias: unknown): string | null {
  if (typeof alias !== "string" || !alias.trim()) return "别名不能为空";
  const a = alias.trim();
  if (!LAKE_ALIAS_RE.test(a)) return `别名「${a}」不合法:小写字母开头,只能含小写字母 / 数字 / 下划线,最长 ${LAKE_ALIAS_MAX_LEN} 位`;
  if (LAKE_RESERVED_ALIASES.has(a)) return `别名「${a}」是保留名(${Array.from(LAKE_RESERVED_ALIASES).join(" / ")}),请换一个`;
  return null;
}

/**
 * 按表桶名派生缺省别名(§8):小写、非 `[a-z0-9_]` 字符 → `_`、首字符不是字母则加前缀 `b_`、截到 32 位;
 * 与 `taken` 里已有的别名撞上 ⇒ 加 `_2` / `_3` … 后缀(截断后仍保证 ≤ 32)。保留名也算「被占」。
 * 🔴 纯函数、确定性:同一输入永远同一输出 —— 升级迁移脚本(scripts/lib/lake-routes-migrate.mjs)另有一份**逐字相同**的实现,
 *    由 parity 判据(lib/lake/__tests__/migrate-script.test.ts)拿同一组输入比对两侧输出。
 */
export function aliasFromBucket(bucket: string, taken: ReadonlySet<string> = new Set()): string {
  let base = String(bucket ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(base)) base = `b_${base}`;
  base = base.slice(0, LAKE_ALIAS_MAX_LEN);
  const isTaken = (a: string) => taken.has(a) || LAKE_RESERVED_ALIASES.has(a);
  if (!isTaken(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `_${n}`;
    const cand = `${base.slice(0, LAKE_ALIAS_MAX_LEN - suffix.length)}${suffix}`;
    if (!isTaken(cand)) return cand;
  }
  throw new Error(`aliasFromBucket: 无法为表桶 ${bucket} 派生不冲突的别名`);
}

/** 三段名示例(页面「复制示例」/ 提示用;与 Spark 实际解析规则一致:跨目录必须三段)。 */
export function threePartNameExample(alias: string, namespace = "<命名空间>", table = "<表>"): string {
  return `${alias}.${namespace}.${table}`;
}
