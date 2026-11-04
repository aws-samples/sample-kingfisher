// Reads a data source's schema (tables + columns) for registration into OpenMetadata.
//
// 模块 42:改为委托数据源 SPI(getProvider(type).introspect)。MySQL 走到的仍是同一段
// INFORMATION_SCHEMA 查询(现收编在 lib/datasource-spi/jdbc/mysql.ts,逐字不变);PostgreSQL/
// Oracle/SQLServer 现在也能探查(各自 provider 实现)。不支持 introspect 的 provider 返回 [],
// 调用方仍注册 service/database 但无表(与原「非 mysql 返 []」语义一致)。
// 保留原导出类型(SourceConnInfo/SourceTable/SourceColumn),下游 route.ts 零改动。

import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
import type { SourceColumn as SpiColumn } from "@/lib/datasource-spi/types";

export interface SourceColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  key?: string;
  comment?: string;
}
export interface SourceTable {
  name: string;
  columns: SourceColumn[];
}

export interface SourceConnInfo {
  type: string;
  host: string;
  port?: number;
  database: string;
  username?: string;
  secretArn?: string;
}

export async function readSourceSchema(ds: SourceConnInfo): Promise<SourceTable[]> {
  if (!isDataSourceType(ds.type)) return []; // 未注册类型:无直连读取器(与原「非 mysql 返 []」一致)
  // 归一成 SPI 入参(SourceConnInfo 是旧扁平形态 → readConnection 映射进 connection 袋)。
  const ref = toSourceRef({
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database: ds.database,
    username: ds.username,
    secretArn: ds.secretArn,
  });
  const datasets = await getProvider(ds.type).introspect(ref);
  // SPI 的 SourceDataset[] → 本模块 SourceTable[](形状一致,仅取 name+columns)。
  return datasets.map((d) => ({ name: d.name, columns: d.columns.map((c: SpiColumn) => ({ ...c })) }));
}
