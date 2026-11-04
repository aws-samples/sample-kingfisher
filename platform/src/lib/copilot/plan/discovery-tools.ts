// Copilot 规划大脑的【只读发现工具】。规划前用它们摸清现状
// 广告数据在哪张表?有没有现成 ROI 指标?源数据同步过来没?在数据湖还是仓库?某任务最近跑成功没?
//
// 设计原则(与 create-service 同款):**直调 service 层,不自我发 HTTP**——更干净、无 token 转发。
// 全部只读、零副作用、零新后端能力(薄封装已存在的 service/Query)。鉴权复用 CopilotCaller 身份。
// 复用现有 CopilotTool 声明式结构(kind:"read"),既能进 inprocess registry,也能适配成 Strands tool()。
//
// 已核实的真实调用点(摸底):
//   find_metric            → listModelMetrics()               @ modeling/model-metrics
//   get_lineage            → getLineage(fqn, depth)           @ governance/lineage-service
//   introspect_source_tables → readSourceSchema(ds)           @ datasource/schema-reader
//   discover_catalog       → introspectSchema/introspectS3Tables @ genbi(避开 catalog route 内联逻辑)
//   check_run_status       → Query bgp-task-runs(pk=taskId, ScanIndexForward:false)
// 业务口径复用现有 read-tools 的 lookup_business_context(不再重复包)。

import { targetOfStamp } from "@/lib/exec-env/target-id";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listModelMetrics } from "@/lib/modeling/model-metrics";
import { getLineage } from "@/lib/governance/lineage-service";
import { readSourceSchema } from "@/lib/datasource/schema-reader";
import { introspectSchema } from "@/lib/genbi/schema";
import { introspectS3Tables, S3TABLES_NAMESPACE } from "@/lib/genbi/athena";
import { GENBI } from "@/lib/genbi/config";
import { getCookbook, listRecipeEngines } from "../recipes/registry";
import type { RecipeEngine } from "../recipes/types";
import type { CopilotTool, CopilotCaller, CopilotToolResult } from "../tools/types";
// run 可见性判据(与写侧盖章成对,单作者)。
import { canReadRunsOf } from "@/lib/monitor/run-owner";

// 单租户分区键(与 create-service / datasources route 一致:按 id 直取用 default-user 主键)。
const USER_ID = "default-user";

function ok(data: any): CopilotToolResult { return { success: true, data }; }
function fail(e: any): CopilotToolResult { return { success: false, error: String(e?.message || e).slice(0, 300) }; }

export const DISCOVERY_TOOLS: CopilotTool[] = [
  {
    name: "lookup_recipe",
    kind: "read",
    description:
      "【写 SQL/代码前必查】查平台的工程配方库:某引擎(redshift/s3tables/glue/emr/flink)的【方言硬规则】+ " +
      "【验证过的代码范式】。写 redshift-sql 步骤前必查 engine=redshift(拿 CTAS/UPSERT/窗口等正确写法,避免方言报错);" +
      "写 S3 Table/EMR 前查 engine=s3tables/emr(拿 S3TablesCatalog 等核心配置)。可给 capability 关键词过滤。",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", description: "引擎:redshift / s3tables / glue / emr / flink" },
        capability: { type: "string", description: "可选,能力关键词过滤,如 aggregate/roi/upsert/window/s3table-write/conversion/retention" },
      },
      required: ["engine"],
    },
    handler: async (args) => {
      try {
        const engine = String(args?.engine || "").trim().toLowerCase() as RecipeEngine;
        if (!listRecipeEngines().includes(engine)) {
          return ok({ engines: listRecipeEngines(), note: `未知引擎「${engine}」,可用:${listRecipeEngines().join("/")}` });
        }
        const cb = await getCookbook(engine, args?.capability ? String(args.capability) : undefined);
        return ok(cb);
      } catch (e) { return fail(e); }
    },
  },
  {
    name: "find_metric",
    kind: "read",
    description:
      "查询建模指标体系里【有没有现成的指标】(如 ROI/ROAS/转化率/留存)。规划前先查:若已有现成指标,可能不必再建同步/作业,直接指引用户去指标页看。可给 keyword 按指标名/口径过滤。",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string", description: "可选,按指标名称/口径关键词过滤,如 'ROI' / '留存'" } },
      required: [],
    },
    handler: async (args) => {
      try {
        const all = await listModelMetrics();
        const kw = String(args?.keyword || "").trim().toLowerCase();
        let items = all.map((m) => ({
          modelMetricId: m.modelMetricId, name: m.name, metricType: m.metricType,
          domainId: m.domainId, caliber: m.caliber, unit: m.unit, fqn: m.fqn,
          agg: m.agg, measureColumn: m.measureColumn, lastValue: m.lastValue, lastComputedAt: m.lastComputedAt,
        }));
        if (kw) items = items.filter((m) => (String(m.name) + String(m.caliber || "")).toLowerCase().includes(kw));
        return ok({ count: items.length, items: items.slice(0, 50) });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: "discover_catalog",
    kind: "read",
    description:
      "列出【数据仓库/数据湖里已有哪些表和列】(用于判断源数据是否已同步过来、在哪)。target=warehouse 查 Redshift 数仓;target=lake 查 S3 Tables 数据湖(Iceberg)。可给 keyword 过滤表名。规划'算 X'前先查目标表在不在。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "warehouse(Redshift 数仓,默认)或 lake(S3 Tables 数据湖)" },
        keyword: { type: "string", description: "可选,按表名关键词过滤" },
      },
      required: [],
    },
    handler: async (args, caller) => {
      try {
        const target = String(args?.target || "warehouse").toLowerCase();
        // 🔴🔴 原来两支都不带区 ⇒ 面向 us-west-2 的计划,规划大脑看到的是**主控区**的仓/湖目录
        //   (「源数据同步过来没」答错区)。计划面向哪个区由 `caller.targetId` 承载(已接到这里),
        //   与 `/api/bi/schema` 同一口径:选了区就不传主控区的工作组实名,由落点作者解析。
        // 计划的落点是计划记录上的章(无章 = 存量计划 = 主控区,唯一作者 targetOfStamp)
        const tid = targetOfStamp(caller?.targetId);
        const tables = target === "lake"
          ? await introspectS3Tables(S3TABLES_NAMESPACE, { targetId: tid })
          : await introspectSchema("", "", { targetId: tid, project: caller?.projectId ?? null });
        const kw = String(args?.keyword || "").trim().toLowerCase();
        let items = tables.map((t) => ({
          schema: t.schema, table: t.table,
          columns: (t.columns || []).slice(0, 60).map((c) => ({ name: c.name, type: c.type })),
        }));
        if (kw) items = items.filter((t) => (t.schema + "." + t.table).toLowerCase().includes(kw));
        return ok({ target, count: items.length, items: items.slice(0, 80) });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: "introspect_source_tables",
    kind: "read",
    description:
      "探查【源数据库(MySQL 数据源)里有哪些表和列】(用于判断源头有没有相关业务数据、够不够算目标指标)。必须给 datasourceId(先用 list_datasources 拿到)。仅支持 MySQL 源,连不上/非 MySQL 返回空。",
    inputSchema: {
      type: "object",
      properties: {
        datasourceId: { type: "string", description: "数据源 ID(用 list_datasources 获取)" },
        database: { type: "string", description: "可选,指定库名(默认数据源自身库名)" },
      },
      required: ["datasourceId"],
    },
    handler: async (args, caller) => {
      try {
        const datasourceId = String(args?.datasourceId || "").trim();
        if (!datasourceId) return fail(new Error("缺少 datasourceId"));
        const { Item: ds } = await docClient.send(new GetCommand({
          TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId },
        }));
        if (!ds) return ok({ count: 0, items: [], note: "数据源不存在或不可见" });
        // RBAC 一致性:按 id 直取的记录须属当前项目(闸3,不看别项目的源库)。
        if (ds.projectId && caller.projectId && ds.projectId !== caller.projectId) {
          return fail(new Error("该数据源不属于当前项目空间"));
        }
        const tables = await readSourceSchema({
          type: ds.type, host: ds.host, port: ds.port,
          database: String(args?.database || ds.database || ""),
          username: ds.username, secretArn: ds.secretArn,
        });
        const items = tables.map((t) => ({
          name: t.name,
          columns: (t.columns || []).slice(0, 60).map((c) => ({ name: c.name, type: c.type, key: c.key })),
        }));
        return ok({ count: items.length, items: items.slice(0, 80) });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: "get_lineage",
    kind: "read",
    description:
      "查某张表的【数据血缘】(上下游:数据从哪来、流向哪)。必须给 fqn(完全限定名,如 redshift.dev.public.ad_events 或 s3.<bucket>.<ns>.<table>)。用于判断某表数据来源、是否已有同步/计算链路。",
    inputSchema: {
      type: "object",
      properties: {
        fqn: { type: "string", description: "表的完全限定名 FQN,如 redshift.dev.public.orders" },
        depth: { type: "number", description: "可选,上下游追溯跳数,默认 2" },
      },
      required: ["fqn"],
    },
    handler: async (args) => {
      try {
        const fqn = String(args?.fqn || "").trim();
        if (!fqn) return fail(new Error("缺少 fqn"));
        const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(5, Number(args.depth))) : 2;
        const g = await getLineage(fqn, depth);
        return ok({
          centerNode: g.centerNode,
          nodes: g.nodes, // {fqn,type}
          edges: g.edges.map((e: any) => ({ source: e.source, target: e.target, lineageType: e.lineageType })),
        });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: "check_run_status",
    kind: "read",
    description:
      "查某个任务/作业【最近一次运行成功了没】(按 taskId/jobId 查运行流水)。用于判断某同步/作业是否已成功跑过、数据是否已就绪。传 taskId(同步任务 id 或作业 jobId,它们复用同一运行表)。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务/作业 id(sync taskId 或 etl/engine jobId)" } },
      required: ["taskId"],
    },
    handler: async (args, caller) => {
      try {
        const taskId = String(args?.taskId || "").trim();
        if (!taskId) return fail(new Error("缺少 taskId"));
        // 🔴 **本批补上的越权面**:改动前本 handler 签名是 `async (args)` —— 拿到了 caller 却不用,
        //    A 项目的用户报一个 B 项目的 taskId 就能读 B 的运行流水(含 error 文本:SQL/表名/报错栈)。
        //    判据走**资源归属项目**(与  guardResourceAccess 同一条),
        //    刻意**不用** FilterExpression:这条 Query 带 `Limit: 20`,加过滤就会撞
        //    「过滤在截断之后 ⇒ 静默少报」那个 DDB 陷阱。
        if (!(await canReadRunsOf(taskId, caller.projectId))) {
          return fail(new Error("无权查看该任务的运行记录(任务不在当前项目空间,或任务不存在)"));
        }
        const { Items = [] } = await docClient.send(new QueryCommand({
          TableName: TABLES.TASK_RUNS,
          KeyConditionExpression: "taskId = :t",
          ExpressionAttributeValues: { ":t": taskId },
          ScanIndexForward: false, // runId=ULID → 最近在前
          Limit: 20,
        }));
        const runs = (Items || []).map((r: any) => ({
          runId: r.runId, status: r.status, triggeredBy: r.triggeredBy,
          startedAt: r.startedAt, finishedAt: r.finishedAt, duration: r.duration,
          error: r.error ? String(r.error).slice(0, 200) : undefined,
        }));
        const latest = runs[0] || null;
        const latestSucceeded = latest?.status === "succeeded";
        const everSucceeded = runs.some((r) => r.status === "succeeded");
        return ok({ taskId, latest, latestSucceeded, everSucceeded, recentCount: runs.length, recent: runs.slice(0, 5) });
      } catch (e) { return fail(e); }
    },
  },
];
