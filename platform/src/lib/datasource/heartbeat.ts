// DS-05 — data source connectivity heartbeat.
//
// 改为委托数据源 SPI(getProvider(type).ping)。MySQL 走到的仍是同一段 SELECT 1 +
// connectTimeout(现收编在 lib/datasource-spi/jdbc/mysql.ts,逐字不变);PostgreSQL/Oracle/
// SQLServer 现在也能探活。canPing=false 的 provider 返回 reachable=null(不改状态,与原
// 「非 mysql 返 reachable:null」语义一致)。保留原导出类型,调用方零改动。

import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";

export interface PingTarget {
  type: string;
  host: string;
  port?: number;
  database?: string;
  username?: string;
  secretArn?: string;
}

export interface PingResult {
  reachable: boolean | null; // null = unsupported engine (don't change status)
  latencyMs?: number;
  error?: string;
}

export async function pingDataSource(ds: PingTarget): Promise<PingResult> {
  if (!isDataSourceType(ds.type)) {
    return { reachable: null, error: `心跳检测暂不支持 ${ds.type}` };
  }
  const ref = toSourceRef({
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database: ds.database,
    username: ds.username,
    secretArn: ds.secretArn,
  });
  return getProvider(ds.type).ping(ref);
}
