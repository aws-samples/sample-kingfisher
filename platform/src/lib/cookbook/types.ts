// 平台级工程知识库(Engine Cookbook)类型定义(单一事实源)。
//
// 定位:把平台【验证过的引擎工程知识】(Redshift 方言、S3 Table 写入核心代码、Glue/EMR/Flink 模式…)
// 沉淀成结构化"配方(Recipe)"+"方言规则(DialectRule)",供所有 AI codegen 出口复用:
//   · 生成前 retrieve(engine, opts) → 喂相关配方给大模型,照验证过的范式写(从源头写对);
//   · 生成后 guard(engine, code)   → 用同一份方言规则校验/纠正 LLM 偶发违规(安全网)。
//
// 谱系:从lib/copilot/recipes/* 提升 + 泛化而来。Copilot 降级为消费者之一(见 docs/design/45)。
// 抽象原则(全球级 + 可插拔):加一个引擎能力 = seed/ 目录加一个文件 + 注册一行,不改 retrieve/guard 核心。

// 支持的引擎(封闭枚举:唯一的强类型维度)。加引擎在这里加一个字面量。
export type CookbookEngine = "redshift" | "s3tables" | "glue" | "emr" | "flink" | "athena";

// 配方针对的产物形态:
//  · "sql"  声明式 SQL(Redshift/Athena/Flink SQL)——guard 可做正则 antiPattern + fix 机械纠正。
//  · "code" 命令式代码(Glue/EMR PySpark)——guard 【不做】正则改写(易误伤语义),只做 retrieve 范式引导 + warn 提示。
// 见 docs/design/45 §4.3 适用范围矩阵。DialectRule 未标 target 时按引擎默认(见 defaultTargetForEngine)。
export type CookbookTarget = "sql" | "code";

// 方言规则:某引擎"必须遵守/严禁"的语法约束。是 retrieve(注入提示词)与 guard(校验)的【共享事实源】。
//  - antiPattern:命中即违规的正则(如 Redshift 的 `CREATE TABLE IF NOT EXISTS ... AS`)。
//  - fix?:若可机械纠正,给出 (code) => 纠正后 code(guard 用);不可纠正则只报违规。
//  - severity:error=必然跑错(guard 纠正或拦截);warn=不推荐(仅提示,不改代码)。
//  - target?:该规则针对声明式 SQL 还是命令式代码。【硬约束:target="code" 的规则禁配 fix】
//    (命令式代码不做正则【改写】,易误伤语义);但【可配 antiPattern 纯检测】——检测是只读的、安全的,
//    guard-core.ts:67 已保证 target=code 永不进入 fix 分支,命中只报 violation+blocked(拦执行,不改代码)。
//    用于拦"命令式代码里必然跑错的硬错"(如 PySpark 用 jdbc:redshift 占位符连数仓)。未标时按引擎默认。
//  - engineVersion?:适用版本(如 "glue>=5.0")。本期只做展示标注,不参与择优过滤(见 docs/design/45 §5)。
export interface DialectRule {
  id: string; // "redshift.no-ctas-if-not-exists"
  engine: CookbookEngine;
  title: string; // 人读:规则名
  rule: string; // 给 AI 看:必须遵守什么(注入提示词 + 配方展示)
  antiPattern?: RegExp; // 命中=违规(guard 检测用;sql/code 规则皆可带——检测只读安全)
  fix?: (code: string) => string; // 可机械纠正的修法(guard 用;【仅 target=sql】可带,code 禁改写);无则仅报违规
  severity: "error" | "warn";
  target?: CookbookTarget; // 默认按引擎:sql 引擎→"sql",code 引擎→"code"
  engineVersion?: string; // 适用版本(展示用,本期不择优)
}

// 一条配方:某引擎某能力的验证过的范式(模板 + 方言注意 + 何时用 + 检索标签)。
export interface Recipe {
  id: string; // "redshift.ctas-aggregate"
  engine: CookbookEngine;
  capability: string; // 能力标签(归一到受控词表打分,见 capability-vocab):"aggregate" / "s3table-write" / "upsert" …
  title: string; // 人读标题:"Redshift 聚合建表(CTAS)"
  whenToUse: string; // 何时用(给 AI 判断命中):"把聚合/JOIN 结果落成一张新结果表时"
  template: string; // 验证过的模板/示例代码(可含占位符,AI 照此改)
  dialectNotes: string[]; // 该配方相关的方言注意(从 DialectRule 派生 or 补充)
  tags: string[]; // 检索标签:["aggregate","roi","conversion","retention"]
  source?: "system" | "admin"; // 内嵌只读 / 管理员扩展(系统配方可省略,retrieve 归一为 system)
  engineVersion?: string; // 范式适用版本(展示用,本期不择优)
  verifiedAt?: string; // 验证时间戳(ISO;证明"真跑过",非凭记忆)。系统配方入库纪律见 docs/design/45 §6

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 2026-09-22 新增的一维:**这个范式需要哪些 IAM 权限**(用户拍板)。
  //
  // 用户原话:「这种能力我认为需要加入到配方库里面,不能我每次都需要手动处理这种错误。」
  //          「**他需要知道这种任务需要添加哪些权限**,而不是报错了之后我通过你改源代码重新发布解决问题。」
  //          「目标/源头,都要扫描,自动生成所需要的权限,这里面涉及到代码解析,匹配配方库等操作。」
  //
  // 【为什么这一维必须长在配方里】事故当天的真相是:「EMR 作业跑起来要哪些权限」这件知识
  //   **在代码里没有任何地方声明过** —— 它只活在 CDK 那个默认角色的实现细节里。于是
  //   角色顾问不知道、copilot 不知道、planner 不知道,只有 AccessDenied 之后由人来补。
  // ⇒ 把它变成配方的一部分:配方 = 「怎么写」+「**要什么权限**」。
  //   从此 `lib/role-advisor/script-scan.ts` 能靠 `detect` 命中配方、把 `requiredPermissions` 自动并入
  //   推荐策略;planner 生成前 `lookup_recipe` 也会连权限一起读到。
  // 🔴 加一种新范式 = 加一条配方(带这两个字段),**不改扫描器核心** —— 与本仓「加引擎只加 seed 文件」同形。
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * 代码里出现什么就算**用到了这个范式**(扫描器用)。
   * 🔴 与 `DialectRule.antiPattern` 语义相反:那个是「命中即违规」,这个是「命中即用到」。
   */
  detect?: RegExp[];
  /** 用了这个范式就**必须**有的权限(扫描器据此自动推导;`resource` 支持占位符,见 script-scan)。 */
  requiredPermissions?: RecipePermission[];
}

/**
 * 配方声明的一条权限需求。
 * `resource` 里的占位符由扫描器按上下文替换(闭合清单,见 `script-scan.ts` 的 `PLACEHOLDERS`):
 *   `{region}` `{account}` `{datalakeBucket}` `{scriptBucket}` `{tableBucket}` `*`
 * 🔴 刻意不允许任意表达式:配方是**数据**,不是代码 —— 让管理员也能安全地加配方。
 */
export interface RecipePermission {
  actions: string[];
  resources: string[];
  /** 人话:为什么这个范式需要它(界面 / 预检报错直接用这句)。 */
  why: string;
}

// retrieve 返回的检索切片:该引擎方言规则(全,但小)+ 打分后 topK 相关配方。
// 注入 codegen 提示词 → token 只花在相关内容上。
export interface CookbookSlice {
  engine: CookbookEngine;
  dialectRules: { title: string; rule: string; severity: "error" | "warn" }[]; // 该引擎方言硬规则(AI 生成前必读)
  recipes: Recipe[]; // 打分排序后的 topK 配方(系统 + 管理员合并)
  totalMatched: number; // 命中总数(未截断前),便于调用方感知是否被 topK 裁剪
}

// guard 结果:纠正后脚本 + 已修记录 + 未能自动修的违规(供审计/回显/阻断,见 docs/design/45 §4.2c)。
export interface GuardResult {
  code: string; // 纠正后的脚本(无违规则原样返回)
  fixed: { ruleId: string; title: string }[]; // 被机械纠正的规则(应记审计 + 回显给用户)
  violations: { ruleId: string; title: string; rule: string; severity: "error" | "warn" }[]; // 检出但【无法机械纠正】的违规
  blocked: boolean; // true = 存在 error 级且无 fix 的违规 → 默认应阻断落库(admin 可覆盖,见 §9-⑥)
}

// 引擎默认产物形态:sql 引擎的 DialectRule 默认 target="sql",code 引擎默认 "code"。
const CODE_ENGINES: ReadonlySet<CookbookEngine> = new Set<CookbookEngine>(["glue", "emr"]);
export function defaultTargetForEngine(engine: CookbookEngine): CookbookTarget {
  return CODE_ENGINES.has(engine) ? "code" : "sql";
}

// 某规则的有效 target(显式优先,否则按引擎默认)。
export function targetOfRule(rule: DialectRule): CookbookTarget {
  return rule.target ?? defaultTargetForEngine(rule.engine);
}
