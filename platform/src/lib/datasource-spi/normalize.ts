// 数据源连接归一层(向后兼容的关键)。
//
// 【零迁移策略】现网 DynamoDB 里已有 MySQL 数据源 item 是扁平 host/port/database/username。
// 不做破坏性数据迁移(违「零迁移」稳态),改用归一读取层:把任意 item(旧扁平 / 新属性袋)
// 统一成 provider 能读的 connection 属性袋。
//   · 新建源:写 connection 属性袋(不再写扁平字段)。
//   · 旧源读取:归一层把扁平字段映射进袋,provider 无感知。
// → 老 MySQL 源零改动继续跑,新源用新模型。见 DESIGN.md §5.2 + memory wired-but-not-persisted-bugs。

import type { DataSourceType } from "./types";
import type { SourceRef } from "./spi";

// DataSource item 的最小读取形状(不强依赖 @/types/datasource 完整定义,保持低耦合可单测)。
interface DataSourceItemLike {
  type: string;
  connection?: Record<string, any>;
  // 旧扁平字段(向后兼容)
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  // JDBC 源的附加连接参数(扁平字段,与 host/port/database 同列;归一进袋供 buildConnection 读)
  jdbcParams?: string;
  secretArn?: string;
  glueConnectionName?: string;
}

// 把 DataSource item 的连接信息归一成属性袋。
//  · 新格式(有 connection)直接用。
//  · 旧格式(扁平 host/port/database)兜底映射进袋——这是 JDBC 四兄弟旧数据的兼容路径。
export function readConnection(ds: DataSourceItemLike): Record<string, any> {
  if (ds.connection && typeof ds.connection === "object" && Object.keys(ds.connection).length > 0) {
    // 既有袋又有扁平 jdbcParams(编辑 PUT 只写扁平键)⇒ 扁平的补进袋,不让它被袋静默盖掉
    if (ds.jdbcParams !== undefined && ds.connection.jdbcParams === undefined) return { ...ds.connection, jdbcParams: ds.jdbcParams };
    return ds.connection;
  }
  // 旧扁平兜底(JDBC 语义:host/port/database)。仅回填有值的键,避免塞一堆 undefined。
  const bag: Record<string, any> = {};
  if (ds.host !== undefined) bag.host = ds.host;
  if (ds.port !== undefined) bag.port = ds.port;
  if (ds.database !== undefined) bag.database = ds.database;
  if (ds.jdbcParams !== undefined) bag.jdbcParams = ds.jdbcParams;
  return bag;
}

// 把 DataSource item 归一成 provider 入参 SourceRef。调用方统一走这个,不再各自拼字段。
export function toSourceRef(ds: DataSourceItemLike): SourceRef {
  return {
    type: ds.type as DataSourceType,
    connection: readConnection(ds),
    secretArn: ds.secretArn,
    username: ds.username,
    glueConnectionName: ds.glueConnectionName,
  };
}
