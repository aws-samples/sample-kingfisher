import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { buildRedshiftTableClause } from "@/lib/sync/glue-script-generator";

// SYNC-01: Channel recommendation
export function recommendChannel(sourceType: string, targetType: string, syncMode: string) {
  // 模块42 P42.4/P42.5:非 JDBC 范式(nosql/object-store/stream)由 provider.capabilities.syncChannels
  //   数据驱动,不走下面 JDBC 专属的 Zero-ETL/DMS 三通道逻辑。DynamoDB/S3 只支持 Glue 批读;
  //   stream(kinesis/msk)只支持 flink-cdc(不在本"同步任务"通道体系,实时计算页单列)。
  //   🔴 JDBC 四兄弟(needsGlueConnection=true)仍走原逻辑,逐字不变(零回归)。
  if (isDataSourceType(sourceType)) {
    const cap = getProvider(sourceType).capabilities;
    if (cap.paradigm !== "jdbc") {
      const supportsGlue = cap.syncChannels.includes("glue");
      const glueReason = cap.paradigm === "nosql"
        ? "Glue DynamoDB 连接器批读入湖仓(Redshift / S3Tables)"
        : cap.paradigm === "object-store"
        ? "Glue 读 S3 文件入湖仓;也可用 Athena 外部表直查"
        : "该源经实时计算(Flink)消费,不走批同步通道";
      return {
        recommended: supportsGlue ? "glue" : "",
        options: [
          { channel: "glue", supported: supportsGlue, recommended: supportsGlue, reason: glueReason },
          { channel: "zero-etl", supported: false, recommended: false, reason: "仅 MySQL/Aurora → Redshift 增量" },
          { channel: "dms", supported: false, recommended: false, reason: "DMS 仅支持关系型(JDBC)源的 CDC" },
        ],
      };
    }
  }

  const isMySQL = ["mysql", "aurora-mysql"].includes(sourceType);
  const isPG = ["postgresql", "aurora-pg"].includes(sourceType);
  const toRedshift = targetType === "redshift" || targetType === "both";

  // 模块 31: 实时(realtime)模式 = DMS 持续 CDC 通道(唯一实现)。Glue 是批 ETL、Zero-ETL 是托管
  // 复制,都不是"实时 CDC 任务";故 realtime 直接锁定 DMS 为唯一推荐+支持,避免被误推成 Glue。
  if (syncMode === "realtime") {
    const dmsSupported = isMySQL || isPG || ["oracle", "sqlserver"].includes(sourceType);
    return {
      recommended: "dms",
      options: [
        { channel: "glue", supported: false, recommended: false, reason: "Glue 为批 ETL，不支持实时 CDC" },
        { channel: "zero-etl", supported: false, recommended: false, reason: "实时 CDC 走 DMS 通道" },
        {
          channel: "dms",
          supported: dmsSupported,
          recommended: dmsSupported,
          reason: dmsSupported ? "持续 CDC 复制，实时同步源库变更(秒级)" : "不支持当前源类型",
        },
      ],
    };
  }

  const options = [
    { channel: "glue", supported: true, recommended: false, reason: "通用 ETL，支持所有 JDBC 源和目标" },
    { channel: "zero-etl", supported: false, recommended: false, reason: "" },
    { channel: "dms", supported: false, recommended: false, reason: "" },
  ];

  const isCDC = syncMode === "incremental";

  // Zero-ETL: MySQL/Aurora → Redshift,且仅【增量】(本质是近实时 CDC,无纯全量模式)。
  if (isMySQL && toRedshift && isCDC) {
    options[1].supported = true;
    options[1].recommended = true;
    options[1].reason = "近实时 CDC，零运维，推荐用于 MySQL → Redshift 增量";
  } else if (isMySQL && toRedshift) {
    options[1].reason = "Zero-ETL 为近实时 CDC，不支持纯全量(全量请用 Glue / DMS)";
  } else {
    options[1].reason = `不支持: ${!isMySQL ? "仅支持 MySQL/Aurora 源" : "仅支持 Redshift 目标"}`;
  }

  // DMS: 普通全量(full-load)或全量+CDC(full-load-and-cdc),取决于同步模式。
  if (isMySQL || isPG || ["oracle", "sqlserver"].includes(sourceType)) {
    options[2].supported = true;
    options[2].reason = isCDC
      ? "全量 + 持续 CDC 复制(增量场景),自管复制实例"
      : "一次性全量迁移(full-load),托管复制实例";
    if (isCDC && !options[1].recommended) { options[2].recommended = true; }
  } else {
    options[2].reason = "不支持当前源类型";
  }

  // Glue: default for full sync
  if (!isCDC || (!options[1].recommended && !options[2].recommended)) {
    options[0].recommended = true;
  }

  const recommended = options.find((o) => o.recommended)!.channel;
  return { recommended, options };
}

// SYNC-02: Type mapping
const MYSQL_TO_REDSHIFT: Record<string, { type: string; compat: "compatible" | "conversion" | "truncation" }> = {
  "int": { type: "INTEGER", compat: "compatible" },
  "integer": { type: "INTEGER", compat: "compatible" },
  "tinyint": { type: "SMALLINT", compat: "compatible" },
  "smallint": { type: "SMALLINT", compat: "compatible" },
  "mediumint": { type: "INTEGER", compat: "compatible" },
  "bigint": { type: "BIGINT", compat: "compatible" },
  "float": { type: "REAL", compat: "compatible" },
  "double": { type: "DOUBLE PRECISION", compat: "compatible" },
  "decimal": { type: "DECIMAL", compat: "compatible" },
  "numeric": { type: "DECIMAL", compat: "compatible" },
  "char": { type: "CHAR", compat: "compatible" },
  "varchar": { type: "VARCHAR", compat: "compatible" },
  "tinytext": { type: "VARCHAR(256)", compat: "compatible" },
  "text": { type: "VARCHAR(65535)", compat: "compatible" },
  "mediumtext": { type: "VARCHAR(65535)", compat: "truncation" },
  "longtext": { type: "VARCHAR(65535)", compat: "truncation" },
  "date": { type: "DATE", compat: "compatible" },
  "datetime": { type: "TIMESTAMP", compat: "compatible" },
  "timestamp": { type: "TIMESTAMP", compat: "compatible" },
  "time": { type: "VARCHAR(20)", compat: "conversion" },
  "year": { type: "SMALLINT", compat: "conversion" },
  "boolean": { type: "BOOLEAN", compat: "compatible" },
  "tinyint(1)": { type: "BOOLEAN", compat: "compatible" },
  "json": { type: "SUPER", compat: "conversion" },
  "blob": { type: "VARCHAR(65535)", compat: "conversion" },
  "binary": { type: "VARCHAR(256)", compat: "conversion" },
  "enum": { type: "VARCHAR(256)", compat: "conversion" },
  "set": { type: "VARCHAR(256)", compat: "conversion" },
};

const PG_TO_REDSHIFT: Record<string, { type: string; compat: "compatible" | "conversion" | "truncation" }> = {
  "integer": { type: "INTEGER", compat: "compatible" },
  "bigint": { type: "BIGINT", compat: "compatible" },
  "smallint": { type: "SMALLINT", compat: "compatible" },
  "real": { type: "REAL", compat: "compatible" },
  "double precision": { type: "DOUBLE PRECISION", compat: "compatible" },
  "numeric": { type: "DECIMAL", compat: "compatible" },
  "decimal": { type: "DECIMAL", compat: "compatible" },
  "character varying": { type: "VARCHAR", compat: "compatible" },
  "character": { type: "CHAR", compat: "compatible" },
  "text": { type: "VARCHAR(65535)", compat: "compatible" },
  "boolean": { type: "BOOLEAN", compat: "compatible" },
  "date": { type: "DATE", compat: "compatible" },
  "timestamp without time zone": { type: "TIMESTAMP", compat: "compatible" },
  "timestamp with time zone": { type: "TIMESTAMPTZ", compat: "compatible" },
  "json": { type: "SUPER", compat: "conversion" },
  "jsonb": { type: "SUPER", compat: "conversion" },
  "uuid": { type: "VARCHAR(36)", compat: "conversion" },
  "bytea": { type: "VARCHAR(65535)", compat: "conversion" },
  "inet": { type: "VARCHAR(50)", compat: "conversion" },
  "interval": { type: "VARCHAR(50)", compat: "conversion" },
};

// Oracle → Redshift(P42.3)。Oracle 类型名来自 ALL_TAB_COLUMNS.DATA_TYPE(大写,introspect 已归一
// 传下来时按 toLowerCase 匹配)。NUMBER 无精度时 Redshift 用 DECIMAL(38,10) 兜底(Oracle NUMBER 最大
// 精度 38);带精度的 NUMBER(p,s) 由下方 size 逻辑保留。VARCHAR2/NVARCHAR2 → VARCHAR;CLOB/LONG → 大 VARCHAR。
const ORACLE_TO_REDSHIFT: Record<string, { type: string; compat: "compatible" | "conversion" | "truncation" }> = {
  // NUMBER(p,s):走下方 size 保留逻辑 → DECIMAL(p,s)(与 MySQL/PG decimal 同款语义)。无精度 NUMBER
  // (size 空)得到光秃秃 DECIMAL(=Redshift DECIMAL(18,0));真搬数时 Glue 按 Spark 读出的 Decimal(p,s)
  // 精度重新建列(glue-script-generator 用 f.dataType.precision/scale),预览 DDL 的精度不影响落库精度。
  "number": { type: "DECIMAL", compat: "conversion" },
  "integer": { type: "INTEGER", compat: "compatible" },
  "int": { type: "INTEGER", compat: "compatible" },
  "smallint": { type: "SMALLINT", compat: "compatible" },
  "float": { type: "DOUBLE PRECISION", compat: "compatible" },
  "binary_float": { type: "REAL", compat: "compatible" },
  "binary_double": { type: "DOUBLE PRECISION", compat: "compatible" },
  "decimal": { type: "DECIMAL", compat: "compatible" },
  "numeric": { type: "DECIMAL", compat: "compatible" },
  "varchar2": { type: "VARCHAR", compat: "compatible" },
  "nvarchar2": { type: "VARCHAR", compat: "compatible" },
  "varchar": { type: "VARCHAR", compat: "compatible" },
  "char": { type: "CHAR", compat: "compatible" },
  "nchar": { type: "CHAR", compat: "compatible" },
  "clob": { type: "VARCHAR(65535)", compat: "truncation" },
  "nclob": { type: "VARCHAR(65535)", compat: "truncation" },
  "long": { type: "VARCHAR(65535)", compat: "truncation" },
  "date": { type: "TIMESTAMP", compat: "compatible" }, // Oracle DATE 含时分秒 → TIMESTAMP
  "timestamp": { type: "TIMESTAMP", compat: "compatible" },
  "timestamp(6)": { type: "TIMESTAMP", compat: "compatible" },
  "timestamp with time zone": { type: "TIMESTAMPTZ", compat: "compatible" },
  "timestamp with local time zone": { type: "TIMESTAMPTZ", compat: "compatible" },
  "raw": { type: "VARCHAR(65535)", compat: "conversion" },
  "blob": { type: "VARCHAR(65535)", compat: "conversion" },
  "rowid": { type: "VARCHAR(64)", compat: "conversion" },
};

// SQL Server → Redshift(P42.3)。类型名来自 sys.types.name(小写)。bit→BOOLEAN;nvarchar/nchar
// 归 VARCHAR/CHAR;datetime2/datetimeoffset→TIMESTAMP;money→DECIMAL;uniqueidentifier→VARCHAR(36)。
const SQLSERVER_TO_REDSHIFT: Record<string, { type: string; compat: "compatible" | "conversion" | "truncation" }> = {
  "int": { type: "INTEGER", compat: "compatible" },
  "bigint": { type: "BIGINT", compat: "compatible" },
  "smallint": { type: "SMALLINT", compat: "compatible" },
  "tinyint": { type: "SMALLINT", compat: "compatible" }, // MSSQL tinyint 无符号 0-255 → SMALLINT 安全
  "bit": { type: "BOOLEAN", compat: "compatible" },
  "decimal": { type: "DECIMAL", compat: "compatible" },
  "numeric": { type: "DECIMAL", compat: "compatible" },
  "money": { type: "DECIMAL(19,4)", compat: "compatible" },
  "smallmoney": { type: "DECIMAL(10,4)", compat: "compatible" },
  "float": { type: "DOUBLE PRECISION", compat: "compatible" },
  "real": { type: "REAL", compat: "compatible" },
  "char": { type: "CHAR", compat: "compatible" },
  "nchar": { type: "CHAR", compat: "compatible" },
  "varchar": { type: "VARCHAR", compat: "compatible" },
  "nvarchar": { type: "VARCHAR", compat: "compatible" },
  "text": { type: "VARCHAR(65535)", compat: "compatible" },
  "ntext": { type: "VARCHAR(65535)", compat: "truncation" },
  "date": { type: "DATE", compat: "compatible" },
  "datetime": { type: "TIMESTAMP", compat: "compatible" },
  "datetime2": { type: "TIMESTAMP", compat: "compatible" },
  "smalldatetime": { type: "TIMESTAMP", compat: "compatible" },
  "datetimeoffset": { type: "TIMESTAMPTZ", compat: "compatible" },
  "time": { type: "VARCHAR(20)", compat: "conversion" }, // Redshift 无独立 TIME 类型
  "uniqueidentifier": { type: "VARCHAR(36)", compat: "conversion" },
  "binary": { type: "VARCHAR(256)", compat: "conversion" },
  "varbinary": { type: "VARCHAR(65535)", compat: "conversion" },
  "image": { type: "VARCHAR(65535)", compat: "conversion" },
  "xml": { type: "VARCHAR(65535)", compat: "conversion" },
};

const TYPE_REGISTRIES: Record<string, Record<string, { type: string; compat: "compatible" | "conversion" | "truncation" }>> = {
  postgresql: PG_TO_REDSHIFT,
  oracle: ORACLE_TO_REDSHIFT,
  sqlserver: SQLSERVER_TO_REDSHIFT,
  mysql: MYSQL_TO_REDSHIFT,
};

export function mapColumnType(sourceDb: string, sourceType: string): { targetType: string; compatibility: string } {
  const normalized = sourceType.toLowerCase().replace(/\s+/g, " ").trim();
  const baseType = normalized.replace(/\(.*\)/, "").trim();
  const sizeMatch = normalized.match(/\((\d+(?:,\d+)?)\)/);
  const size = sizeMatch ? sizeMatch[1] : "";

  // P42.3:按源库选映射表(oracle/sqlserver 各自专属,取代此前 postgresql ? PG : MYSQL 的二选一,
  // 后者会让 Oracle/SQLServer 全部 fallback 到 MySQL 表 → 未命中 → VARCHAR(256))。默认 MySQL(兼容旧行为)。
  const registry = TYPE_REGISTRIES[sourceDb] || MYSQL_TO_REDSHIFT;
  const mapping = registry[normalized] || registry[baseType];

  if (mapping) {
    let targetType = mapping.type;
    // Preserve size for varchar/char/decimal
    if (size && ["VARCHAR", "CHAR", "DECIMAL"].includes(mapping.type)) {
      targetType = `${mapping.type}(${size})`;
    }
    return { targetType, compatibility: mapping.compat };
  }

  return { targetType: "VARCHAR(256)", compatibility: "conversion" };
}

export function mapAllColumns(sourceDb: string, columns: { name: string; type: string }[]) {
  return columns.map((col) => {
    const { targetType, compatibility } = mapColumnType(sourceDb, col.type);
    return { source: col.name, sourceType: col.type, target: col.name, targetType, compatibility };
  });
}

// SYNC-06: Generate CREATE TABLE DDL
export function generateDDL(
  tableName: string,
  columns: { target: string; targetType: string; nullable?: boolean }[],
  config?: { distKey?: string; sortKeys?: string[]; distStyle?: string }
): string {
  const colDefs = columns.map((c) => {
    const nullable = c.nullable === false ? " NOT NULL" : "";
    return `  ${c.target} ${c.targetType}${nullable}`;
  }).join(",\n");

  let ddl = `CREATE TABLE IF NOT EXISTS ${tableName} (\n${colDefs}\n)`;

  // Bug#3 + SSOT:DISTKEY/DISTSTYLE/SORTKEY 收敛到 buildRedshiftTableClause(消除此前预览侧重复拼的
  // 第二套规则),并传入真实列做校验 —— 预览就剔除引用不存在列的键(与执行侧 Glue 同规则),让
  // "预览 DDL = 执行 DDL",不再出现预览拼了、执行建表 column-not-exist 的错位。
  ddl += buildRedshiftTableClause(config || {}, columns.map((c) => c.target));

  return ddl + ";";
}
