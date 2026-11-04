export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 表结构探查改委托数据源 SPI(getProvider(type).introspect),取代此前硬 import mysql2
// 的 MySQL-only 实现。MySQL 走到的仍是同一 INFORMATION_SCHEMA 查询(mysql provider 收编);
// PostgreSQL/Oracle/SQLServer 现在也能 Browse tables(各自 provider 读对应系统表)。
// 这是「Browse tables」按钮调的端点,与 lib/datasource/schema-reader.ts 平行——一并收编。
// 🔴 **改动前零守卫**(52 SPEC §2 缺口B;台账 §11.2 第 8 项):任一登录用户凭 id 浏览**任意项目**
//    数据源的表清单与列结构 —— 这是「从数据源头隔离」这句话最直接的反例。读类用 `viewer`、按归属项目判。
//
// 浏览表可以走数据源自己的 Glue 连接(缺陷原形见 lib/datasource/glue-reach.ts):
//   · probeVia=auto(缺省):先控制面直连(数组应答,存量逐字不变);**直连失败且有 Glue 连接** ⇒ 起发现作业,202;
//   · probeVia=glue-connection:直接走发现作业;
//   · 发现作业在跑 ⇒ 202 { discovering };成功 ⇒ 200 { tables, via: "glue-discovery", discoveredAt }(缓存在源行,`?refresh=1` 才重跑);
//     失败 ⇒ 502 说清 Glue 的原话。
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
import { guardResourceAccess } from "@/lib/projects/guard";
import { dsCanUseGlueReach, dsProbeVia, advanceDiscovery, glueReachNote } from "@/lib/datasource/glue-reach";
import { patchDataSourceRow } from "@/lib/datasource/ds-patch";
// 浏览表读源库凭证(secret ARN 自带区)/ 读发现作业状态都替**这条源所在区**做事 ⇒ 先记落点决策再发第一个 AWS 调用
import { noteDatasourceRowPlace } from "@/lib/datasource/ds-place";
import type { DataSource } from "@/types/datasource";

const USER_ID = "default-user";

function discoveredPayload(schema: NonNullable<DataSource["discoveredSchema"]>, controlPlaneError?: string | null) {
  return { tables: schema.tables, via: "glue-discovery" as const, discoveredAt: schema.at, database: schema.database, note: glueReachNote("discovery", controlPlaneError) };
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: ds } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
  );
  // 🔴 先授权再回答"存不存在"(这里原本连 404 都不给、直接回空数组,更容易被当探测器)。
  const ctx = await guardResourceAccess(req, ds as { projectId?: string } | undefined, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  if (!ds) return NextResponse.json([]);

  if (!isDataSourceType(ds.type)) {
    return NextResponse.json({ error: `不支持的数据源类型: ${ds.type}` }, { status: 400 });
  }
  const row = ds as unknown as DataSource;
  noteDatasourceRowPlace(row);

  // 允许 query 覆盖 database(如浏览另一个库);归一成 SPI 入参。
  const database = req.nextUrl.searchParams.get("database") || ds.database;
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const ref = toSourceRef({
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database,
    username: ds.username,
    secretArn: ds.secretArn,
    connection: ds.connection,
  });

  let directError: string | null = null;
  if (!(dsCanUseGlueReach(row) && dsProbeVia(row) === "glue-connection")) {
    try {
      const datasets = await getProvider(ds.type).introspect(ref);
      // SPI SourceDataset[] → 本端点契约(name + database + columns),前端 Metadata browser 消费。
      const out = datasets.map((d) => ({
        name: d.name,
        database,
        columns: d.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          key: c.key,
          comment: c.comment,
        })),
      }));
      return NextResponse.json(out);
    } catch (e: any) {
      directError = String(e?.message || e);
      if (!dsCanUseGlueReach(row)) {
        return NextResponse.json({ error: `无法连接源数据库: ${directError}` }, { status: 500 });
      }
    }
  }

  // ── 经数据源自己的 Glue 连接发现表(推进一步的规则在 glue-reach.advanceDiscovery,与「检测」同一载体)──
  try {
    const db = String(database || "");
    const step = await advanceDiscovery(row, db, { refresh, persist: (patch) => patchDataSourceRow(params.id, patch) });
    if (step.kind === "running") {
      return NextResponse.json({ discovering: true, via: "glue-discovery", startedAt: step.rec.startedAt, jobRunId: step.rec.jobRunId, database: db, note: glueReachNote("discovery", directError) }, { status: 202 });
    }
    if (step.kind === "succeeded" || step.kind === "cached") {
      return NextResponse.json(discoveredPayload(step.schema, directError));
    }
    return NextResponse.json({ error: `经 Glue 连接发现表失败: ${step.error}`, via: "glue-discovery" }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: `经 Glue 连接发现表失败: ${String(e?.message || e)}`, via: "glue-discovery", ...(directError ? { controlPlaneError: directError } : {}) }, { status: 502 });
  }
}
