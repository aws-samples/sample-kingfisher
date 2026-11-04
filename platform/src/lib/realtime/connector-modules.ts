// 模块 32-CR — 连接器运行时:模块注册表 + resolveModules 纯函数(CR.1)。
//
// 设计文档:docs/design/32-realtime-compute/DESIGN-connector-runtime-modular.md §2.1/§2.4。
//
// 【本期(CR.1)只做纯函数解析,不接线、不碰 S3、不拼装、不改任何现有启动路径】——
// 把「Flink SQL 里用了哪些 connector/catalog/format → 需要哪些连接器模块」这个映射,
// 从数据驱动的注册表 + 一个纯函数落地,并用单测锁死。后续 CR.3 才把它接进拼装。
//
// 与模块42 数据源 SPI registry 同精神:加一个源/sink 的连接器 = 注册表加一行,零散点。

/** 连接器模块 id(对应 S3 flink/modules/<id>-<version>.jar,CR.2 构建产物)。
 *  这里只列已在现有两个 runner(base/s3t)中真实打包、可拆出的连接器 + MSK 新增两项。
 *  🔴 不臆造未构建的模块:每个 id 在 CR.2 都要有对应的、继承统一 version parent 的模块 pom。 */
export type ConnectorModuleId =
  | "kinesis"        // flink-sql-connector-aws-kinesis-streams(源)
  | "kafka"          // flink-sql-connector-kafka(MSK/Kafka 源,CR.2 构建)
  | "msk-iam-auth"   // aws-msk-iam-auth(MSK IAM 认证类,kafka 用 AWS_MSK_IAM 时追加)
  | "mysql-cdc"      // flink-sql-connector-mysql-cdc(源,含 mysql 驱动)
  | "jdbc"           // flink-connector-jdbc + mysql 驱动(sink)
  | "files"          // flink-connector-files(filesystem sink)
  | "json"           // flink-json(format)
  | "avro"           // flink-avro(format;iceberg manifest 亦需,但那在 iceberg-s3tables 模块内自带)
  | "iceberg-s3tables"; // iceberg + s3tables catalog + hadoop 捆包(重栈,预 shade 成一个黑盒模块)

/** 注册表一条规则:一个 SQL token(正则)→ 需要的模块 id(+ 可选条件追加)。
 *  数据驱动:加 source/sink 连接器 = 这张表加一行(+ CR.2 加对应模块 pom)。 */
interface ModuleRule {
  /** 命中即需要 baseModules 里的模块。对 finalSql 全文匹配(大小写不敏感)。 */
  test: RegExp;
  /** 命中后必需的模块 id。 */
  modules: ConnectorModuleId[];
  /** 可选:命中主 test 后,若 finalSql 另外匹配 whenAlso,则追加 alsoModules(如 kafka + AWS_MSK_IAM → msk-iam-auth)。 */
  whenAlso?: RegExp;
  alsoModules?: ConnectorModuleId[];
}

// 🔴 严格对齐 DESIGN §2.1 注册表映射,不增不减 token:
//   'connector'='kinesis'                          → [kinesis]
//   'connector'='kafka'  (+ 含 AWS_MSK_IAM → +msk-iam-auth) → [kafka] (+[msk-iam-auth])
//   'connector'='mysql-cdc'                        → [mysql-cdc]
//   'connector'='jdbc'                             → [jdbc]
//   'connector'='filesystem'                       → [files]
//   catalog-impl=...S3TablesCatalog / type='iceberg' → [iceberg-s3tables]
//   'format'='avro' → [avro]     'format'='json' → [json]
// token 正则风格对齐 flink-service.ts 现有 'connector' = '...' 写法(允许引号内外空白)。
const MODULE_RULES: ModuleRule[] = [
  {
    test: /'connector'\s*=\s*'kinesis'/i,
    modules: ["kinesis"],
  },
  {
    test: /'connector'\s*=\s*'kafka'/i,
    modules: ["kafka"],
    // kafka 源用 MSK IAM 认证(SQL 里出现 AWS_MSK_IAM)→ 追加 msk-iam-auth 认证模块。
    whenAlso: /AWS_MSK_IAM/i,
    alsoModules: ["msk-iam-auth"],
  },
  {
    test: /'connector'\s*=\s*'mysql-cdc'/i,
    modules: ["mysql-cdc"],
  },
  {
    test: /'connector'\s*=\s*'jdbc'/i,
    modules: ["jdbc"],
  },
  {
    test: /'connector'\s*=\s*'filesystem'/i,
    modules: ["files"],
  },
  {
    // S3 Tables Iceberg catalog:catalog-impl=...S3TablesCatalog 或 type='iceberg'。任一命中即需重栈模块。
    test: /'catalog-impl'\s*=\s*'[^']*S3TablesCatalog'|'type'\s*=\s*'iceberg'/i,
    modules: ["iceberg-s3tables"],
  },
  {
    test: /'format'\s*=\s*'avro'/i,
    modules: ["avro"],
  },
  {
    test: /'format'\s*=\s*'json'/i,
    modules: ["json"],
  },
];

/** 解析【已注入的 finalSql】需要的连接器模块 id 集合(去重 + 稳定排序)。纯函数,无副作用。
 *
 * 🔴 输入必须是 finalSql(占位符已解析、认证已注入)——因 msk-iam-auth 的判定依赖注入后的 AWS_MSK_IAM。
 *    (与 §2.4/§4 一致:resolveModules 在 guard 之后、注入之后跑。)
 * 稳定排序:供 CR.3 用「模块 id 有序列表」算内容哈希(相同集合→同 key→缓存命中),故此处必须确定性排序。
 *
 * @param finalSql 已注入的完整 Flink SQL
 * @returns 去重且升序排序的模块 id 数组(可能为空:SQL 未用任何已知 connector)
 */
export function resolveModules(finalSql: string): ConnectorModuleId[] {
  const sql = String(finalSql || "");
  const set = new Set<ConnectorModuleId>();
  for (const rule of MODULE_RULES) {
    if (rule.test.test(sql)) {
      for (const m of rule.modules) set.add(m);
      if (rule.whenAlso && rule.alsoModules && rule.whenAlso.test(sql)) {
        for (const m of rule.alsoModules) set.add(m);
      }
    }
  }
  // 稳定排序(字典序):保证同一模块集合每次产出完全相同的有序数组 → CR.3 内容哈希稳定。
  return Array.from(set).sort();
}
