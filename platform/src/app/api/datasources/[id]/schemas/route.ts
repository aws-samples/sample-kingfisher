export const dynamic = "force-dynamic";
import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 52-P52.1-guards
// 🔴 **改动前零守卫**(52 SPEC §2 缺口B B-2 读泄露;台账 §11.2 第 7 项):任一登录用户凭 id 就能
//    浏览**任意项目**数据源的库/表结构。库名表名本身就是业务情报(泄露"对方有哪些业务实体")。
// 🔴 读类用 `viewer`,按数据源归属项目判。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { GlueClient, GetConnectionCommand } from "@aws-sdk/client-glue";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
// 序 31 二刀 ⑤:读该源的 Glue 连接前先记落点决策(观测器据此归因;非主控区源用主控区 glue 客户端的旧形态会被如实记成越区)
import { noteDatasourceRowPlace } from "@/lib/datasource/ds-place";

const USER_ID = "default-user";
const glue = sdkClient("data-plane", GlueClient, { region: homeRegion() });

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: ds } = await docClient.send(
    new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: params.id } })
  );
  // 🔴 先授权再回答"存不存在"(顺序反了= id 存在性探测器)。
  const ctx = await guardResourceAccess(req, ds as { projectId?: string } | undefined, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  if (!ds) return NextResponse.json({ error: "Not found" }, { status: 404 });
  noteDatasourceRowPlace(ds);

  try {
    if (ds.glueConnectionName) {
      const { Connection } = await glue.send(new GetConnectionCommand({ Name: ds.glueConnectionName }));
      const jdbcUrl = Connection?.ConnectionProperties?.JDBC_CONNECTION_URL || "";
      const dbName = jdbcUrl.split("/").pop()?.split("?")[0] || ds.database;
      return NextResponse.json([{ name: dbName, isDefault: true }]);
    }
    return NextResponse.json([{ name: ds.database, isDefault: true }]);
  } catch (err: any) {
    return NextResponse.json([{ name: ds.database, isDefault: true }]);
  }
}
