// @kf-batch 50-P50.3-modeling
// 建模落地的**纯函数部分**(判态 / 列签名规范化 / 字段级 diff)—— 唯一作者。
//
// 🔴 **为什么单独一个文件**:落地面板是**客户端组件**,而 `landing.ts` 依赖 `node:crypto` 与 AWS SDK
// ⇒ 客户端 import 它会把服务端依赖拖进浏览器包。而"四态怎么判""diff 怎么算"**必须前后端同一份**
// (各写一遍 = 界面显示的态与服务端记的态有两个说法,而不一致的表现恰好是"看板说 ok、点进去是 drift")。
// ⇒ 纯的放这里,两边都 import;打 AWS 的留在 `landing.ts`。

/** 一个 (建模定义 × target) 的落地观测记录(合同 §1.3 轴A 的 `landedByTarget` 值形态)。 */
export interface LandedRecord {
  /**
   * 落地/观测时的**观测态**。
   * 🔴 `drift` **绝不**显示为 ✓(INTERACTION §4ter)。@kf-batch 50-W5-seg1-WP10a:`residency-blocked` 态已删(不设法务门)。
   */
  status: "ok" | "drift" | "credential-gap" | "failed";
  /** 落地时的**定义哈希**。读侧拿它与当前定义比 ⇒ 不用查库就能判「版本不齐」。 */
  defHash: string;
  /** 落到哪张表(schema.table) */
  table: string;
  /** 这条记录写入的时间 */
  at: string;
  /** 最近一次**真正观测**库里结构的时间(界面必须显示它,不许把陈旧观测画成实时绿灯) */
  observedAt?: string;
  /** 观测到的列签名(drift 时给字段级 diff 用) */
  observedColumns?: string;
  /** 平台定义期望的列签名 */
  expectedColumns?: string;
  error?: string;
}

/** 读侧的四态 + 两个"还没有记录 / 定义变了"的态。 */
export type LandedState =
  | "never-landed"
  | "ok"
  | "stale"
  | "drift"
  /**
   * 🔴 **合同缺口(如实登记,不是"漏做")**:非 home 的建模落地**当前没有合法凭证通道**。
   * · §3.9a 定案「admin 级 DDL 一律走闭合执行器」,而合同的 `land-code-table` 模板
   *   **刻意不做数据写入**(灌数移出 admin 通道,走「窄权 shared-writer」);
   * · 那条窄权通道是 **P52.5a 的遗留交付项,至今没有**;
   * · 就算传一个 project 也不行:per-project 身份对 `public` 无权。
   * ⇒ 本期建模产物**只能落 home**。硬绕只有两条路,都不可接受:
   *   砍掉灌数(=废掉码表落地)、或把 raw admin ARN 交给调用方(=违反 §3.9a 的安全定案)。
   * ⇒ 判这个态、原因写进记录,**不算"需要处理"**(用户在那个区做不了任何事),但界面必须显示原因。
   */
  | "credential-gap"
  | "failed";

/**
 * 🔴 只有这三个态**需要处理**。
 * `never-landed` 归入"需要处理"是因为:建模定义一旦绑了某个 target,那个区就**应该**有这张表;
 * 而 `credential-gap` **不算** —— 用户在那个区做不了任何事(与矩阵 §2bis.4 的免判纪律同源)。
 */
export const LANDED_ATTENTION: readonly LandedState[] = ["never-landed", "stale", "drift", "failed"] as const;

export function landedNeedsAttention(s: LandedState): boolean {
  return LANDED_ATTENTION.includes(s);
}

/**
 * 列签名:`name:type` 逗号连接(带长度/精度)。
 *
 * 🔴 **必须规范化**(小写 + 去空格 + 统一别名),否则 `VARCHAR(64)` 与 `character varying(64)`
 * 会被判成不一致 ⇒ 每次观测都报 drift = 天天误报,看板做废。
 * information_schema 回的是 `character varying` 这类 SQL 标准名,而我们的 DDL 写的是 `VARCHAR`。
 */
export function normalizeTypeName(raw: string, len?: number | null, prec?: number | null, scale?: number | null): string {
  // 🔴 **同一个规范化器要吃两种来源**:information_schema(基础类型 + 独立的长度/精度列)
  // 与我们自己的 DDL 串(`VARCHAR(256)` / `DECIMAL(18,2)` 内联括号)。
  // 写两个规范化器 = 两套口径 = 每次观测都报 drift(天天误报,看板做废)。
  let t = String(raw || "").trim().toLowerCase();
  const inline = t.match(/^([a-z ]+?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/);
  if (inline) {
    t = inline[1].trim();
    const n1 = Number(inline[2]);
    const n2 = inline[3] ? Number(inline[3]) : null;
    if (t === "decimal" || t === "numeric") {
      prec = prec ?? n1;
      scale = scale ?? n2;
    } else {
      len = len ?? n1;
    }
  }
  const alias: Record<string, string> = {
    "character varying": "varchar",
    character: "char",
    "double precision": "double",
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    int: "integer",
    bool: "boolean",
    numeric: "decimal",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz",
    float4: "real",
    float8: "double",
  };
  const base = alias[t] ?? t;
  if ((base === "varchar" || base === "char") && len) return `${base}(${len})`;
  if (base === "decimal" && prec) return `${base}(${prec}${scale ? `,${scale}` : ""})`;
  return base;
}

export function columnSignature(cols: Array<{ name: string; type: string }>): string {
  return cols.map((c) => `${String(c.name).trim().toLowerCase()}:${c.type}`).join(",");
}

/** 字段级 diff(给 INTERACTION §4ter 的〔查看差异〕用)。 */
export interface ColumnDiff {
  onlyInDefinition: string[];
  onlyInTarget: string[];
  typeMismatch: Array<{ column: string; expected: string; observed: string }>;
}

export function diffSignatures(expected: string, observed: string): ColumnDiff {
  const parse = (s: string) =>
    new Map(
      String(s || "")
        .split(",")
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf(":");
          return [p.slice(0, i), p.slice(i + 1)] as [string, string];
        })
    );
  const e = parse(expected);
  const o = parse(observed);
  const onlyInDefinition: string[] = [];
  const onlyInTarget: string[] = [];
  const typeMismatch: ColumnDiff["typeMismatch"] = [];
  for (const [k, v] of Array.from(e.entries())) {
    if (!o.has(k)) onlyInDefinition.push(k);
    else if (o.get(k) !== v) typeMismatch.push({ column: k, expected: v, observed: o.get(k)! });
  }
  for (const k of Array.from(o.keys())) if (!e.has(k)) onlyInTarget.push(k);
  return { onlyInDefinition, onlyInTarget, typeMismatch };
}

/**
 * 读侧判态。**纯函数、不查库**(界面列表要能一次渲染几十行)。
 *
 * 🔴 判定顺序即语义:`credential-gap` / `drift` / `failed` 是**观测到的事实**,
 * 优先于"定义有没有变" —— 一张 drift 的表,不会因为定义没变就变成 ✓。
 */
export function landedStateOf(rec: LandedRecord | undefined | null, currentDefHash: string): LandedState {
  if (!rec) return "never-landed";
  if (rec.status === "credential-gap") return "credential-gap";
  if (rec.status === "drift") return "drift";
  if (rec.status === "failed") return "failed";
  return rec.defHash === currentDefHash ? "ok" : "stale";
}

/**
 * 🔴🔴 **逐 target 真值属性**(资源行上"哪个区有什么"的那部分)—— **单一清单**。
 *
 * 为什么需要它:码表/维度表的编辑走的是**全量 Put**,而那一行有**两个作者** ——
 * 定义编辑(name/code/values/columns)与落地记录(下面这些)。不显式带过,
 * 编辑一次定义就把另一个作者的东西**抹掉**;而抹掉的后果不是"少个字段",是
 * **看板误报 + 残留被藏**:改个中文名就让每一格从 ⚠版本不齐 退化成 ⚠未落地
 * (库里那些表还在),连 `targets` 一起丢之后连「残留」都看不见了。
 *
 * 🔴 将来在资源行上新增逐 target 属性,**只需加进这个清单** —— 两处编辑与门禁都读它。
 */
export const PER_TARGET_TRUTH_KEYS = ["targets", "landedByTarget"] as const;

/** 从现有行里挑出逐 target 真值(缺的键不生成,免得 Put 出一堆 undefined)。 */
export function perTargetTruth(row: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PER_TARGET_TRUTH_KEYS) {
    const v = (row ?? {})[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
