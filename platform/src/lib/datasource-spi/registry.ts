// 模块 42 — 数据源注册表(表驱动,照抄 lib/engines/registry.ts)。
// 加数据源 = 这张表加一行 + 独立 provider 文件纯增量;老代码零改动。

import type { DataSourceProvider } from "./spi";
import type { DataSourceType, DataSourceCapabilities } from "./types";
import { mysqlProvider } from "./jdbc/mysql";
import { postgresProvider } from "./jdbc/postgresql";
import { oracleProvider } from "./jdbc/oracle";
import { sqlserverProvider } from "./jdbc/sqlserver";
import { kinesisProvider } from "./stream/kinesis";
import { mskProvider } from "./stream/msk";
import { dynamodbProvider } from "./nosql/dynamodb";
import { s3Provider } from "./object-store/s3";

const PROVIDERS: Record<DataSourceType, DataSourceProvider> = {
  mysql: mysqlProvider,
  postgresql: postgresProvider,
  oracle: oracleProvider,
  sqlserver: sqlserverProvider,
  kinesis: kinesisProvider, // 流范式(P42.7)
  msk: mskProvider, // 流范式第二个:MSK / Kafka(P42.6)
  dynamodb: dynamodbProvider, // NoSQL 范式首个(P42.5)
  s3: s3Provider, // 对象存储范式首个(P42.4)
};

export function isDataSourceType(v: unknown): v is DataSourceType {
  return typeof v === "string" && v in PROVIDERS;
}

export function getProvider(type: DataSourceType): DataSourceProvider {
  return PROVIDERS[type];
}

export function listSourceTypes(): DataSourceType[] {
  return Object.keys(PROVIDERS) as DataSourceType[];
}

// UI 建源下拉/类型目录:由各 provider 的 capabilities 派生(取代 DS_TYPE_OPTIONS 硬编码)。
export function sourceTypeCatalog(): Array<{ type: DataSourceType } & DataSourceCapabilities> {
  return listSourceTypes().map((t) => ({ type: t, ...getProvider(t).capabilities }));
}
