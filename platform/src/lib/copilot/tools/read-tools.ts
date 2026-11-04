// Copilot 只读工具。全部无副作用:列资源/查血缘/查最近运行/查业务口径。
// 复用平台既有的项目/环境过滤(projectFilter/envFilter)——RBAC 作用域不重造。
// 调用者身份(caller.projectId/env)透传,只看当前项目可见的资源(闸 3 的读侧体现)。

import { ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { projectFilter, envFilter } from "@/lib/projects/guard";
import { getContextForGrounding, CONTEXT_KIND_LABEL } from "@/lib/genbi/context";
import type { CopilotTool, CopilotCaller, CopilotToolResult } from "./types";

// 项目 + 环境作用域扫描一张表,只回传给模型少量安全字段(避免把敏感连接串等喂给模型)。
async function scopedScan(
  table: string,
  caller: CopilotCaller,
  pick: (item: any) => Record<string, any>,
  opts: { withEnv?: boolean; limit?: number } = {}
): Promise<CopilotToolResult> {
  try {
    const pf = projectFilter(caller.projectId);
    const clauses = [pf.clause];
    const names: Record<string, string> = {};
    const values: Record<string, any> = { ...pf.values };
    if (opts.withEnv) {
      const ef = envFilter(caller.env as any);
      clauses.push(ef.clause);
      Object.assign(values, ef.values);
      if (ef.clause.includes("#env")) names["#env"] = "env";
    }
    const res = await docClient.send(new ScanCommand({
      TableName: table,
      FilterExpression: clauses.join(" AND "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      Limit: opts.limit || 200,
    }));
    const items = (res.Items || []).map(pick);
    return { success: true, data: { count: items.length, items } };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e).slice(0, 300) };
  }
}

// ── 只读工具注册(每个 = 一行声明 + handler) ──

export const READ_TOOLS: CopilotTool[] = [
  {
    name: "list_datasources",
    kind: "read",
    description: "列出当前项目空间的数据源(名称/类型/主机/是否已建 Glue 连接)。用户问'我有哪些数据源/数据库连接'时用。",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_args, caller) => scopedScan(TABLES.DATASOURCES, caller, (d) => ({
      datasourceId: d.datasourceId, name: d.name, type: d.type,
      host: d.host, database: d.database, hasGlueConnection: !!d.glueConnectionName, env: d.env,
    })),
  },
  {
    name: "list_sync_tasks",
    kind: "read",
    description: "列出当前项目的数据同步任务(名称/通道/源→目标/状态)。用户问'有哪些同步/数据集成任务'时用。",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_args, caller) => scopedScan(TABLES.SYNC_TASKS, caller, (t) => ({
      taskId: t.taskId, name: t.name, channel: t.channel,
      source: t.sourceDatasourceId || t.sourceTable, target: t.targetType, status: t.status, env: t.env,
    })),
  },
  {
    name: "list_etl_jobs",
    kind: "read",
    description: "列出当前项目的离线计算作业(Glue/Redshift SQL)。用户问'有哪些离线作业/ETL'时用。",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_args, caller) => scopedScan(TABLES.ETL_JOBS, caller, (j) => ({
      jobId: j.jobId, name: j.name, type: j.type,
      scheduleEnabled: !!j.scheduleEnabled, cron: j.cronExpression, env: j.env,
    })),
  },
  {
    name: "list_flink_jobs",
    kind: "read",
    description: "列出当前项目的实时计算 Flink SQL 流作业(名称/源/sink/状态)。用户问'有哪些实时/流作业'时用。",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_args, caller) => scopedScan(TABLES.FLINK_JOBS, caller, (j) => ({
      jobId: j.jobId, name: j.name, sourceType: j.sourceType, sinkType: j.sinkType, status: j.status, env: j.env,
    })),
  },
  {
    name: "list_engine_jobs",
    kind: "read",
    description: "列出当前项目的多引擎作业(EMR Serverless 等)。用户问'有哪些 EMR/Spark 作业'时用。",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_args, caller) => scopedScan(TABLES.ENGINE_JOBS, caller, (j) => ({
      jobId: j.jobId, name: j.name, engine: j.engine, scheduleEnabled: !!j.scheduleEnabled, env: j.env,
    })),
  },
  {
    name: "list_recent_runs",
    kind: "read",
    description: "查看最近的任务运行记录(状态/触发方式/时间),可用于回答'最近哪些任务失败了/跑了'。默认最近 30 条。",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "可选,按状态过滤,如 failed / succeeded / running" } },
      required: [],
    },
    handler: async (args, _caller) => {
      try {
        // task-runs 是跨项目的运行流水(无 projectId 维度);只回传安全摘要字段,按需过滤状态。
        const res = await docClient.send(new ScanCommand({ TableName: TABLES.TASK_RUNS, Limit: 200 }));
        let items = (res.Items || []).map((r: any) => ({
          taskId: r.taskId, runId: r.runId, taskType: r.taskType, status: r.status,
          triggeredBy: r.triggeredBy, startedAt: r.startedAt, finishedAt: r.finishedAt,
          error: r.error ? String(r.error).slice(0, 200) : undefined,
        }));
        const want = String(args?.status || "").trim().toLowerCase();
        if (want) items = items.filter((r) => String(r.status || "").toLowerCase() === want);
        items.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
        return { success: true, data: { count: items.length, items: items.slice(0, 30) } };
      } catch (e: any) {
        return { success: false, error: String(e?.message || e).slice(0, 300) };
      }
    },
  },
  {
    name: "lookup_business_context",
    kind: "read",
    description: "查询业务口径与规则库(指标定义/计算口径/命名规范等 global 或本项目的知识)。回答业务语义问题、或为后续建议提供依据时用。",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string", description: "可选关键词,匹配标题/内容" } },
      required: [],
    },
    handler: async (args, caller) => {
      try {
        // 业务口径【统一读取入口】getContextForGrounding(语义层单一事实源):读 body(正文)、
        // global+本项目合并、enabled 过滤、关键词相关性排序。此前 Copilot 自写 Scan 且读错字段
        // (c.content,实际字段是 body)导致口径正文恒为空——根治见语义层顶层设计。
        const kw = String(args?.keyword || "").trim();
        const entries = await getContextForGrounding(caller.projectId, kw);
        const items = entries.map((e) => ({
          title: e.title,
          kind: CONTEXT_KIND_LABEL[e.kind] || e.kind,
          scope: e.projectId === "global" ? "global" : "project",
          content: e.body ? String(e.body).slice(0, 500) : "",  // ← 读 body(正文),不再是恒空的 content
        }));
        return { success: true, data: { count: items.length, items } };
      } catch (e: any) {
        return { success: false, error: String(e?.message || e).slice(0, 300) };
      }
    },
  },
];
