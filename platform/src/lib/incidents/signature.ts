// 模块 43-A — 故障指纹(signature)算法:运维知识库归并的核心。
//
// 目标:同类故障稳定归并、不同类不误并。给定 (taskType, errorText) → 一个确定性、已脱敏的
// signature 字符串。同一根因(仅表名/日期/账号/数字不同)→ 同一 signature;不同根因 → 不同。
//
// 设计要点:
//  1) 分型确定性提取:一张【有序规则表】RULES,每条规则用正则匹配某类故障的判别 token
//     (错误码/异常类名),命中即产出白名单化的 category —— 这条路径天生脱敏(category 是常量,
//     不含任何来自 errorText 的可变量)。规则可跨 taskType(如缺 mysql 驱动在 emr 与 flink 下
//     判别 token 不同,靠不同规则区分)。
//  2) 兜底:无规则命中时,对错误文本做【归一化脱敏】(去表名/路径/主机/账号/UUID/数字/端口/
//     日期/ULID 等一切可变 token)→ 取归一化模板的稳定 hash 前缀。保证"没有明确错误码"也能
//     稳定归并,且不泄漏敏感 token。
//  3) taskType 归一到粗粒度引擎族(etl-glue/etl-redshift → glue/redshift;emr-serverless → emr),
//     signature = engine + "::" + key。
//
// 纯函数、无副作用、可单测(见 __tests__/signature.test.ts,黄金语料取自历史真实事故)。
// 安全:signature 与本文件产出的 symptomTemplate 严禁包含表名/路径/账号/UUID/密钥等敏感 token
// (继承模块36 E5"只存元数据"铁律)。

/** 归一化后的诊断结果:signature(归并键)+ symptomTemplate(已脱敏的现象模板,可入库/导出)。 */
export interface SignatureResult {
  /** 归并键,形如 "glue::REQUIRES_SINGLE_PART_NAMESPACE"。同因稳定、异因区分、已脱敏。 */
  signature: string;
  /** 命中的引擎族(glue/redshift/flink/dms/emr/athena/...);无法判定时为 "unknown"。 */
  engine: string;
  /** 判别键(错误码/异常类/归一化 hash),signature = engine + "::" + key。 */
  key: string;
  /** 人类可读的现象模板(已脱敏),供 UI 标题与 DataOps-Bench 导出。不含任何可变敏感 token。 */
  symptomTemplate: string;
  /** 命中方式:规则命中("rule:<id>")或兜底归一化("normalized")。便于诊断算法覆盖度。 */
  matchedBy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// taskType → 引擎族。平台各写入点的 taskType 取值(见 lib/alerting/types.ts 与各 run 写入点):
//   etl-glue / etl-redshift / etl-redshift-dryrun / sync / workflow / emr-serverless / flink / unknown
// 归一到粗粒度引擎族做 signature 前缀;错误特征可覆盖它(如 sync 作业底层跑 Glue 报 Spark 错)。
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeEngine(taskType: string | undefined | null): string {
  const t = (taskType || "").toLowerCase().trim();
  if (!t || t === "unknown") return "unknown";
  if (t.startsWith("etl-redshift")) return "redshift";
  if (t.startsWith("etl-glue") || t === "glue") return "glue";
  if (t.startsWith("etl")) return "glue"; // 裸 "etl" 兜底当 glue(平台 ETL 主力引擎)
  if (t === "emr-serverless" || t === "emr") return "emr";
  if (t === "flink") return "flink";
  if (t === "dms" || t.startsWith("dms")) return "dms";
  if (t === "zero-etl" || t === "zeroetl") return "zero-etl";
  if (t === "athena") return "athena";
  if (t === "sync") return "sync"; // sync 底层可能是 Glue/DMS,交由规则的 engineOverride 细化
  if (t === "workflow") return "workflow";
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// 有序规则表:第一条命中的规则决定 signature。每条规则:
//   - id:稳定短名(用于 matchedBy 与测试引用)
//   - test:对 errorText 的正则(大小写不敏感,按需)
//   - engine:该故障归属的引擎族(可覆盖 taskType 推断,undefined = 用 taskType 推断值)
//   - key:判别键(白名单常量,不含来自 errorText 的可变量)
//   - symptom:脱敏的现象模板
//   - engineGuard?:仅当归一化引擎属于集合时才允许命中(消歧,避免跨引擎误并)
//
// 语料来源标注(历史真实事故,见 __tests__/signature.test.ts 黄金集):
//   RESUME-*/QA-FINDINGS/memory 里的 REQUIRES_SINGLE_PART_NAMESPACE、Spectrum Scan Error 15007、
//   resolving configuration FATAL、ClassNotFound: com.mysql.cj.jdbc.Driver 等。
// ─────────────────────────────────────────────────────────────────────────────
interface Rule {
  id: string;
  test: RegExp;
  engine?: string;
  key: string;
  symptom: string;
  /** 若给出,仅当归一化引擎 ∈ engineGuard 时该规则可命中(跨引擎消歧)。 */
  engineGuard?: string[];
}

const RULES: Rule[] = [
  // ── Glue/EMR(Spark)──────────────────────────────────────────────────────
  {
    // 语料 A:S3 Tables 三段式命名空间被 Spark 当两段 hive namespace。dim_channel/07-08 等可变。
    id: "spark-single-part-namespace",
    test: /REQUIRES_SINGLE_PART_NAMESPACE/i,
    key: "REQUIRES_SINGLE_PART_NAMESPACE",
    symptom: "Spark 无法解析多段命名空间(S3 Tables 三段式未注册 catalog)",
  },
  {
    // Spark 内存不足。堆大小/executor id 等可变。emr 与 glue 都可能,靠 taskType 分引擎。
    id: "spark-oom",
    test: /OutOfMemoryError|java\.lang\.OutOfMemory|GC overhead limit exceeded/i,
    key: "OutOfMemoryError",
    symptom: "Spark 执行内存不足(OOM / GC overhead)",
  },
  {
    // 缺 JDBC 驱动类 —— EMR 侧典型为 ClassNotFoundException(spark.jars 到不了 driver classpath)。
    // 与 Flink 的 NoClassDefFoundError 是不同异常类,必须区分(见 flink-mysql-driver 规则)。
    id: "spark-jdbc-class-not-found",
    test: /ClassNotFoundException.*(?:jdbc|Driver|mysql|postgres)|(?:mysql|postgres).*Driver.*ClassNotFoundException|ClassNotFoundException:\s*com\.mysql/i,
    engineGuard: ["glue", "emr"],
    key: "ClassNotFoundException",
    symptom: "Spark 缺少 JDBC 驱动类(用户 jar 未进 driver classpath)",
  },
  // ── Redshift ──────────────────────────────────────────────────────────────
  {
    // 语料 B:Spectrum 扫描 Parquet schema 不兼容。错误码 15007 是稳定判别键,须【保留】;
    // 列名 is_paying / 表名 players / 行数 / 耗时全部可变,由 key 常量隔绝。
    id: "redshift-spectrum-scan-15007",
    test: /Spectrum\s+Scan\s+Error\s*15007|15007[^0-9].*incompatible\s+Parquet\s+schema|incompatible\s+Parquet\s+schema.*15007/i,
    engine: "redshift",
    key: "spectrum-scan-error#15007",
    symptom: "Redshift Spectrum 扫描错误 15007:Parquet schema 不兼容",
  },
  {
    // 其它 Spectrum 扫描错误(非 15007):保留错误码维度但归到通用 spectrum-scan。
    id: "redshift-spectrum-scan-generic",
    test: /Spectrum\s+Scan\s+Error/i,
    engine: "redshift",
    key: "spectrum-scan-error",
    symptom: "Redshift Spectrum 扫描错误",
  },
  {
    // 权限拒绝(schema/database/relation + 对象名可变)→ 统一归并。
    id: "redshift-permission-denied",
    test: /permission denied for (?:schema|database|relation|table)/i,
    engine: "redshift",
    key: "permission-denied",
    symptom: "Redshift 权限不足(对某对象无权限)",
  },
  {
    id: "redshift-disk-full",
    test: /disk\s*full|Disk Full|out of disk/i,
    engine: "redshift",
    key: "disk-full",
    symptom: "Redshift 磁盘空间不足",
  },
  // ── Flink ───────────────────────────────────────────────────────────────
  {
    // 缺 MySQL 驱动 —— Flink CDC fat jar 未内嵌驱动,典型 NoClassDefFoundError。
    // ★与 EMR 的 ClassNotFoundException 是不同异常类,engineGuard=flink 双保险,绝不与 emr 并。
    id: "flink-mysql-driver-noclassdef",
    test: /NoClassDefFoundError.*(?:mysql|cj\.jdbc|Driver)|NoClassDefFoundError:\s*com\/mysql/i,
    engineGuard: ["flink"],
    key: "NoClassDefFoundError",
    symptom: "Flink 缺少 MySQL 驱动类(CDC 连接器 jar 未内嵌驱动)",
  },
  {
    // Debezium server-id 冲突:CDC 模板写死 server-id 范围,多作业/重启撞车。数字范围可变。
    id: "flink-server-id-conflict",
    test: /server[_-]?id|server_uuid|Error\s*1236|A replica with the same/i,
    engineGuard: ["flink"],
    key: "server-id-conflict#1236",
    symptom: "Flink CDC server-id/server-uuid 冲突(binlog 复制被踢)",
  },
  {
    // SQL 解析失败:含分号注释被 split(;) 切碎致 EOF。line/column 数字可变。
    id: "flink-sql-parse-eof",
    test: /Encountered\s+"<EOF>"|Could not execute application.*Encountered|SQL parse failed/i,
    engineGuard: ["flink"],
    key: "sql-parse-error",
    symptom: "Flink SQL 解析失败(EOF / 语法)",
  },
  {
    id: "flink-checkpoint-failure",
    test: /checkpoint (?:expired|failed|declined)|Checkpoint Coordinator is suspending|failed checkpoint/i,
    engineGuard: ["flink"],
    key: "checkpoint-failure",
    symptom: "Flink checkpoint 失败/过期",
  },
  // ── DMS ─────────────────────────────────────────────────────────────────
  {
    // 语料 C:DMS "Failed in resolving configuration" FATAL(角色缺权限等)。task id/表名/日期可变。
    id: "dms-resolving-configuration-fatal",
    test: /Failed in resolving configuration|resolving configuration.*FATAL/i,
    engine: "dms",
    key: "resolving-configuration-fatal",
    symptom: "DMS 配置解析失败(FATAL,常见于目标角色权限缺失)",
  },
  {
    id: "dms-lob-constraint",
    test: /limited lob mode should be enabled|LobMaxSize should have value/i,
    engine: "dms",
    key: "lob-constraint",
    symptom: "DMS LOB 模式约束(须启用 limited LOB 且 ≤63KB)",
  },
  {
    id: "dms-start-type-invalid",
    test: /START_REPLICATION, valid only for tasks running for the first time|valid only for tasks running/i,
    engine: "dms",
    key: "start-type-invalid",
    symptom: "DMS 启动类型非法(对非首次任务用了 start-replication)",
  },
  // ── 跨引擎基建/前置 ────────────────────────────────────────────────────────
  {
    // Redshift Serverless namespace 瞬时锁。ConflictException 通用,靠 namespace 关键词收窄。
    id: "namespace-operation-conflict",
    test: /ConflictException.*operation running on the namespace|operation running on the namespace/i,
    key: "namespace-operation-conflict",
    symptom: "Redshift namespace 上有并发操作(瞬时锁冲突)",
  },
  {
    id: "zeroetl-binlog-missing",
    test: /binlog_format:\s*ROW|binlog_row_image:\s*FULL|missing parameter.*binlog/i,
    engine: "zero-etl",
    key: "binlog-params-missing",
    symptom: "Zero-ETL 前置参数缺失(binlog_format=ROW / binlog_row_image=FULL)",
  },
  {
    // Athena/Spark 找不到 schema/namespace(未带 s3tablescatalog 前缀)。
    id: "schema-not-found",
    test: /SCHEMA_NOT_FOUND|Schema .* does not exist|Database .* not found/i,
    key: "schema-not-found",
    symptom: "查询目标 schema/namespace 不存在(可能未带 catalog 前缀)",
  },
  {
    // 通用 Py4J 包装:仅当没有更具体规则命中时到这(在 OOM/CNF 之后),提取被包装的异常类。
    // 注意:此规则本身不产出 key(仅作最后的 Spark 归类前缀提示),实际 key 由被包装类决定;
    // 若无法提取则落兜底归一化。放在规则表末尾。
    id: "spark-py4j-generic",
    test: /Py4JJavaError/i,
    engineGuard: ["glue", "emr"],
    key: "Py4JJavaError",
    symptom: "Spark Py4J 调用异常(未识别的具体异常类)",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 归一化脱敏:把错误文本里一切可变/敏感 token 抹成占位符,得到稳定模板。
// 用于:① 兜底 hash 的输入;② 导出安全(不泄漏表名/账号/路径)。
// 顺序敏感:先长后短、先具体后通用,避免子串误替换。
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeErrorText(raw: string): string {
  let s = String(raw || "");

  // 统一空白,便于正则(保留单空格)。
  s = s.replace(/\s+/g, " ").trim();

  // 1) UUID(含带连字符标准式)。
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
  // 2) ULID(Crockford Base32,26 位;平台脚本/诊断 id 常见)。
  s = s.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<ULID>");
  // 3) ARN。
  s = s.replace(/arn:aws[a-z-]*:[^\s"']+/gi, "<ARN>");
  // 4) S3 URI 与一般路径(先于账号/数字,免得把桶名里的数字先抹了)。
  s = s.replace(/s3[an]?:\/\/[^\s"'\)]+/gi, "<S3URI>");
  s = s.replace(/(?:file|hdfs|https?):\/\/[^\s"'\)]+/gi, "<URI>");
  s = s.replace(/(?:\/[A-Za-z0-9._\-]+){2,}\/?/g, "<PATH>");
  // 5) 12 位 AWS 账号。
  s = s.replace(/\b\d{12}\b/g, "<ACCOUNT>");
  // 6) IP:port / 高端口 / IP。
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ADDR>");
  // 7) 平台资源 id 前缀(bgp-rt-xxx / bgp-xxx 的随机后缀)。保留 "bgp-" 语义,抹随机尾。
  s = s.replace(/\bbgp-[a-z]+-[a-z0-9]{6,}\b/gi, "<RESID>");
  // 8) 日期 / 时间戳。
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, "<DATE>");
  s = s.replace(/\b\d{2}-\d{2}\b/g, "<DATE>"); // 07-08 等短日期
  // 9) 引号内标识符(表名/列名/schema 名),如 "players"、`dim_channel`、'fx_rates'。
  s = s.replace(/["'`][A-Za-z_][A-Za-z0-9_.$]*["'`]/g, "<IDENT>");
  // 10) "for column X" / "for schema X" / "for database X" / "for relation X" / "for table X" 的裸标识符。
  s = s.replace(/\b(for (?:column|schema|database|relation|table))\s+[A-Za-z_][A-Za-z0-9_.$]*/gi, "$1 <IDENT>");
  // 10b) 裸的 "table X" / "schema X" / "namespace X" / "database X" / "relation X" / "catalog X"
  //      (无引号、无 for 前缀,如 "at table orders"、"in schema gamedata")→ 抹标识符。
  //      注意:占位符 <IDENT> 以 "<" 开头,不匹配 [A-Za-z_],故已抹过的不会被重复处理。
  s = s.replace(/\b(table|schema|namespace|database|relation|catalog)\s+[A-Za-z_][A-Za-z0-9_.$]*/gi, "$1 <IDENT>");
  // 11) "at line N, column M" 位置数字。
  s = s.replace(/\b(line)\s+\d+/gi, "$1 <N>").replace(/\b(column)\s+\d+/gi, "$1 <N>");
  // 12) jar 版本号 x.y.z。
  s = s.replace(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/g, "<VER>");
  // 13) server-id 范围 5400-5404。
  s = s.replace(/\b\d{3,}-\d{3,}\b/g, "<RANGE>");
  // 14) 剩余独立数字(行数/耗时/大小),但保留字母紧邻的(如 15007 已被具体规则消费;此处泛化)。
  s = s.replace(/\b\d+\b/g, "<N>");
  // 15) 十六进制对象地址 o123 / 0xdeadbeef。
  s = s.replace(/\b0x[0-9a-f]+\b/gi, "<HEX>").replace(/\bo\d+\b/g, "<OBJ>");

  return s;
}

// FNV-1a 32-bit,确定性、无依赖。用于兜底签名的稳定短 hash。
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 计算故障指纹。纯函数、确定性。
 * @param taskType 平台任务类型(etl-glue/etl-redshift/sync/workflow/emr-serverless/flink/...)
 * @param errorText 错误文本(来自 bgp-task-runs.error 或 bgp-flink-jobs.lastError,已是服务摘要串)
 */
export function computeSignature(taskType: string | undefined | null, errorText: string | undefined | null): SignatureResult {
  const engineFromType = normalizeEngine(taskType);
  const text = String(errorText || "").trim();

  // 空错误文本:无法归并到具体类别,给一个稳定的 "empty" 桶(按引擎分)。
  if (!text) {
    return {
      signature: `${engineFromType}::no-error-text`,
      engine: engineFromType,
      key: "no-error-text",
      symptomTemplate: "(无错误文本)",
      matchedBy: "empty",
    };
  }

  // 有序规则匹配:第一条命中即定签名。
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    const engine = rule.engine || engineFromType;
    // engineGuard:该规则仅对特定引擎族有效(跨引擎消歧)。
    if (rule.engineGuard && !rule.engineGuard.includes(engine)) continue;
    return {
      signature: `${engine}::${rule.key}`,
      engine,
      key: rule.key,
      symptomTemplate: rule.symptom,
      matchedBy: `rule:${rule.id}`,
    };
  }

  // 兜底:归一化脱敏 → hash 前缀。保证无明确错误码也稳定归并且不泄漏敏感 token。
  const template = normalizeErrorText(text);
  const hash = fnv1a(template);
  // 现象模板截断,只保留前若干字符做人类可读提示(已脱敏)。
  const preview = template.length > 160 ? template.slice(0, 160) + "…" : template;
  return {
    signature: `${engineFromType}::h-${hash}`,
    engine: engineFromType,
    key: `h-${hash}`,
    symptomTemplate: preview,
    matchedBy: "normalized",
  };
}
