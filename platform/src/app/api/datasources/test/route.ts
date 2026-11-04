export const dynamic = "force-dynamic";
// 🔴 **改动前**:本端点**零守卫**(52 SPEC §2 缺口B 第 7 面;台账 52 DESIGN §11.2 第 4 项)。两条危害:
//   ① 带 `datasourceId` 时会**回写该数据源的 `status`/`testResult`** ⇒ 任一登录用户可跨项目改别人数据源的状态;
//   ② 不带 id 时按表单里的 host/port/账密真发起连接 ⇒ 平台变成一个**带凭证的对内网连通性探测器**。
// 🔴 **两道守卫,不是一道**:
//   · 顶层 `requireProject(editor)` —— 挡住"非本项目成员拿平台当探测器"(覆盖表单路径);
//   · 带 id 的路径**再过** `guardResourceAccess(editor)` 并且**按数据源的归属项目判**
//     —— 只看调用方 active project 就是**混淆代理**:A 项目的 editor 切个 header 就能改 B 项目的源。
import { NextRequest, NextResponse } from "next/server";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { testConnection } from "@/lib/aws/datasource-service";
import { settleAfterConfigCheck } from "@/lib/datasource/reachability-probe";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import { regionOfTarget } from "@/lib/exec-env/data-plane-target";
import type { DataSource } from "@/types/datasource";
import { apiOk, apiError } from "@/lib/api-response";
// 建源表单校验 + JDBC URL 由数据源 SPI 提供(取代此前本文件写死的第 3 份 JDBC_URL 副本)。
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";

const USER_ID = "default-user";

export async function POST(req: NextRequest) {
  // 守卫一:调用方至少是**某个项目的 editor**(挡住表单路径被当探测器用)。
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();

  // Test existing datasource by ID
  if (body.datasourceId) {
    try {
      const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: body.datasourceId } })
      );
      // 守卫二(🔴 权威那一道):按**数据源自己的归属项目**判,不是调用方的 active project。
      //    存量无 projectId 的源落默认工作区(guardResourceAccess 内部规则)。
      //    放在 `!Item?.glueConnectionName` 之前 —— 否则"该源存不存在/有没有连接"会先被泄露出去。
      const rctx = await guardResourceAccess(req, Item as { projectId?: string } | undefined, "editor");
      if (rctx instanceof NextResponse) return rctx;
      if (!Item?.glueConnectionName) return apiOk({ success: false, steps: [{ name: "error", status: "fail", message: "数据源未关联 Glue Connection" }], totalMs: 0 });

      // ① 配置核对打**该源所在区**的 Glue(原来不带区 ⇒ 恒查主控区,非主控区的源必报「连接不存在」);
      //   ② 不再拿配置核对写 active —— 配好了就接着做真正的连通性检测(与「检测」按钮同一作者),结论才写 status。
      const region = await regionOfTarget(datasourceOwnerTarget(Item));
      const result = await testConnection(Item.glueConnectionName, region);
      const outcome = await settleAfterConfigCheck(Item as unknown as DataSource, result);
      return apiOk({ ...result, status: outcome.status, reachability: outcome.kind });
    } catch (e: any) {
      return apiError(e.message, 500);
    }
  }

  // §10.5:非 JDBC 源(DynamoDB/S3 等,iam-role,needsGlueConnection=false)按范式分流,
  //   走 provider.testConnection 做真连测试(DescribeTable/HeadBucket),不要求 host/port/db/账密。
  //   JDBC 路径逐字保持不变(向后兼容零回归)。
  if (isDataSourceType(body.type)) {
    const p = getProvider(body.type);
    if (!p.capabilities.needsGlueConnection) {
      const conn = (body.connection && typeof body.connection === "object") ? body.connection : {};
      const v = p.validateConfig(conn);
      if (!v.ok) {
        return apiOk({ success: false, steps: [{ name: "config_check", status: "fail", message: v.errors.join("；") }], totalMs: 0 });
      }
      try {
        const result = await p.testConnection(toSourceRef({ type: body.type, connection: conn }));
        return apiOk(result);
      } catch (e: any) {
        return apiOk({ success: false, steps: [{ name: "error", status: "fail", message: String(e?.message || e).slice(0, 200) }], totalMs: 0 });
      }
    }
  }

  // Test with provided credentials (new datasource form)
  const { type, host, port, database, username, password } = body;
  if (!type || !host || !port || !database || !username || !password) {
    return apiOk({
      success: false,
      steps: [{ name: "validation", status: "fail", message: "请填写所有必填字段（类型、主机、端口、数据库、用户名、密码）" }],
      totalMs: 0,
    });
  }

  const start = Date.now();
  const steps: any[] = [];

  // Step 1: 类型必须已注册(数据源 SPI)。
  if (!isDataSourceType(type)) {
    steps.push({ name: "jdbc_url", status: "fail", message: `不支持的数据库类型: ${type}` });
    return apiOk({ success: false, steps, totalMs: Date.now() - start });
  }
  const provider = getProvider(type);

  // Step 2: 由 provider 校验连接配置(取代散落的 host/端口/库字符串校验)。JDBC URL 也由 provider 产出。
  // 用户填的附加参数一起校验、一起进 JDBC URL(与建源落库同一份 provider 逻辑);不合法时不构造 URL
  const conn = { host, port, database, ...(body.jdbcParams ? { jdbcParams: body.jdbcParams } : {}) };
  const v = provider.validateConfig(conn);
  const jdbcUrl = v.ok ? provider.buildConnection({ type, connection: conn }).jdbcUrl || "" : "";
  if (v.ok) {
    steps.push({ name: "jdbc_url", status: "pass", message: `JDBC URL: ${jdbcUrl}` });
    steps.push({ name: "config_check", status: "pass", message: `主机/端口/库校验通过 (${host}:${port}/${database})` });
  } else {
    steps.push({ name: "jdbc_url", status: jdbcUrl ? "pass" : "fail", message: jdbcUrl ? `JDBC URL: ${jdbcUrl}` : "无法构造 JDBC URL" });
    steps.push({ name: "config_check", status: "fail", message: v.errors.join("；") });
    return apiOk({ success: false, steps, totalMs: Date.now() - start });
  }

  // Step 3: Credentials check(与原一致:只确认已填,真实连通性在创建后经 Glue Connection 测)。
  steps.push({ name: "credentials", status: "pass", message: `用户: ${username} (密码已填写)` });

  // Summary(与原文案一致)。
  steps.push({ name: "summary", status: "pass", message: "配置验证通过，创建数据源后将自动创建 Glue Connection 并测试连通性" });

  return apiOk({ success: true, steps, totalMs: Date.now() - start });
}
