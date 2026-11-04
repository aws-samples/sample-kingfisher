// Copilot 创建服务。只做【纯草稿、不碰云资源】的创建:同步/离线作业/Flink/业务口径。
// 数据源刻意不在此(其 POST 会真建 Secret+Glue 连接,碰云资源,违背"创建即草稿"——Copilot 对数据源只给建议)。
// 一律 status:"draft" / scheduleEnabled:false —— 建出来绝不运行/调度(安全契约:可建不可跑)。
// 直写 DynamoDB(照对应 route 的 item 结构),不改任何现有 route(纯增量)。审计由调用方(工具)统一记 copilot.*。

import { isSyncWriteMode } from "@/lib/sync/target-table-guard";
// 合并键的规整与校验(单一作者)
import { mergeKeysOf, usesGlueWriteMode, validateSyncCapabilityFields } from "@/lib/sync/run-vars";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
// 落点章的唯一作者(不在这里另写一份判定)
import { bindingForNewSyncTask } from "@/lib/exec-env/definition-binding";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import { createContext, isKind, type ContextKind } from "@/lib/genbi/context";
import type { CopilotCaller } from "./types";

// 单租户分区键(与 sync/etl-jobs/flink route 的 USER_ID 一致——建出来的草稿才和页面列表同分区可见)。
const USER_ID = "default-user";
const now = () => new Date().toISOString();
const VALID_TARGET_TYPES = ["s3-tables", "redshift", "both"];

// 防腐层(anti-corruption layer):规划大脑(planner)的领域词汇是 warehouse(数仓)/lake(数据湖)
// —— 见 discovery-tools.ts 的 discover_catalog(target=warehouse|lake)。但同步任务的 targetType
// 是另一套受控词表(s3-tables/redshift/both)。两套词在此交界处相撞:LLM 学会"warehouse=数仓"后
// 建同步草稿时会把 targetType 填成 "warehouse"/"lake",此前直接抛错(计划中心"确认这步"报
// 「非法 targetType「warehouse」」)。根因是同一概念有两套漂移的表示(违反 SSOT/DRY),不是某行写错。
// 正解:在收口点把 planner 域词汇归一化成合法 targetType(宽进严出),而非硬拒。别名大小写无关。
const TARGET_TYPE_ALIASES: Record<string, string> = {
  warehouse: "redshift",     // planner:数仓
  redshift: "redshift",
  "data-warehouse": "redshift",
  dwh: "redshift",
  lake: "s3-tables",         // planner:数据湖
  "data-lake": "s3-tables",
  datalake: "s3-tables",
  s3: "s3-tables",
  "s3-tables": "s3-tables",
  s3tables: "s3-tables",
  iceberg: "s3-tables",
  both: "both",
  all: "both",
};

/** 把可能来自 planner 域词汇的 targetType 归一化成合法值;无法识别的返回原值(交由下方校验兜底)。 */
export function normalizeTargetType(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const key = String(raw).trim().toLowerCase();
  return TARGET_TYPE_ALIASES[key] || String(raw);
}

// ── 同步任务草稿(照 app/api/sync/route.ts item 结构;status=draft,不 start)──
export async function createSyncDraft(args: any, caller: CopilotCaller): Promise<{ taskId: string; name: string }> {
  const name = String(args?.name || "").trim();
  if (!name) throw new Error("缺少同步任务名称 name");
  // 先经防腐层归一化(warehouse→redshift / lake→s3-tables),再校验。
  const targetType = normalizeTargetType(args?.targetType);
  if (targetType !== undefined && !VALID_TARGET_TYPES.includes(targetType)) {
    throw new Error(`非法 targetType「${args?.targetType}」(合法值:${VALID_TARGET_TYPES.join(" / ")})`);
  }
  const syncMode = args?.syncMode === "realtime" ? "realtime" : args?.syncMode === "incremental" ? "incremental" : "full";
  // 编辑向导第1步对 writeMode 是必填校验(overwrite|append|merge);草稿若不落它,用户打开草稿点「下一步」
  // 会被卡在第1步("请选择写入模式")、进不到选表页——虽数据源已回填也误以为"选表不显示/需选数据源"。
  // 🔴 生产上线批次 A:草稿缺省改成 **append**(原来是 overwrite = 每次运行整表清空目标表)。
  //   Copilot 替用户选写模式时只许选「不删数据」的那个;要覆盖必须由用户在页面上显式改。
  //   同理 targetType 缺省给 redshift 保证向导可推进。合法值唯一来源 = target-table-guard。
  const writeMode = isSyncWriteMode(args?.writeMode) ? args.writeMode : "append";
  // merge 必须带合并键(planner 产出的字段名就叫 mergeKeys;没有就在这里**响亮**拒绝,不许落一个
  //   运行时才现形的草稿)。规则单一作者 = run-vars.validateSyncCapabilityFields / mergeKeysOf。
  const channel = syncMode === "realtime" ? "dms" : (args?.channel || "glue");
  const mergeKeys = writeMode === "merge" ? mergeKeysOf({ mergeKeys: args?.mergeKeys }) : [];
  if (writeMode === "merge") {
    const bad = validateSyncCapabilityFields({ writeMode, syncMode, channel, mergeKeys: Array.isArray(args?.mergeKeys) ? args.mergeKeys : undefined });
    if (bad) throw new Error(`合并写入(merge)必须给合并键 mergeKeys(非空列名数组):${bad}`);
  }
  // 🔴 落点章。
  // 同步任务的章由**它引用的数据源**派生(与 `/api/sync` POST 同一个作者 `bindingForNewSyncTask`),
  // 拿不到数据源行时回落到计划面向的区。绕过这个作者的后果:草稿无章 ⇒ 读侧全归主控区,
  // 而用户在 us-west-2 视角下让 Copilot 建的任务**在他的列表里根本看不见**。
  let dsRow: Record<string, unknown> | undefined;
  if (args?.datasourceId) {
    try {
      const got = await docClient.send(
        new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: String(args.datasourceId) } })
      );
      dsRow = got.Item as Record<string, unknown> | undefined;
    } catch {
      dsRow = undefined; // 读不到就退回计划面向的区(不猜)
    }
  }
  const binding = dsRow
    ? bindingForNewSyncTask(dsRow)
    : { targets: [caller.targetId || HOME_TARGET_ID] };
  const item: any = {
    userId: USER_ID,
    taskId: ulid(),
    projectId: caller.projectId,
    env: caller.env,
    ...binding,
    name,
    channel,
    syncMode,
    writeMode,
    ...(writeMode === "merge" && usesGlueWriteMode({ syncMode, channel }) ? { mergeKeys } : {}),
    ...(args?.datasourceId ? { datasourceId: args.datasourceId } : {}),
    ...(args?.sourceTable ? { sourceTable: args.sourceTable } : {}),
    targetType: targetType || "redshift",
    createdBy: "copilot",
    status: "draft",
    createdByCopilot: true,
    createdAt: now(),
    updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.SYNC_TASKS, Item: item }));
  return { taskId: item.taskId, name };
}

// ── 离线作业草稿(照 app/api/etl-jobs/route.ts;status=draft,不 run/schedule)──
export async function createEtlDraft(args: any, caller: CopilotCaller): Promise<{ jobId: string; name: string }> {
  const name = String(args?.name || "").trim();
  const type = args?.type;
  if (!name) throw new Error("缺少作业名称 name");
  if (!["glue", "redshift"].includes(type)) throw new Error("type 必须是 glue 或 redshift");
  const item: any = {
    userId: USER_ID,
    jobId: ulid(),
    projectId: caller.projectId,
    env: caller.env,
    // 离线作业的章 = 计划面向的区(缺省主控区)
    targets: [caller.targetId || HOME_TARGET_ID],
    name,
    type,
    script: String(args?.script || ""), // 空脚本也可,用户后续在页面补/用 AI 生成
    ...(type === "redshift" ? { redshiftConfig: args?.redshiftConfig || {} } : { glueConfig: args?.glueConfig || {} }),
    scheduleEnabled: false, // 不调度
    status: "draft",
    createdByCopilot: true,
    createdAt: now(),
    updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.ETL_JOBS, Item: item }));
  return { jobId: item.jobId, name };
}

// ── Flink 作业草稿(照 app/api/flink/jobs/route.ts;status=draft,不 start)──
export async function createFlinkDraft(args: any, caller: CopilotCaller): Promise<{ jobId: string; name: string }> {
  const name = String(args?.name || "").trim();
  if (!name) throw new Error("缺少作业名称 name");
  const sinkType = args?.sinkType || "s3"; // s3 | mysql | s3table | custom
  const item: any = {
    userId: USER_ID,
    jobId: ulid(),
    projectId: caller.projectId,
    env: caller.env,
    name,
    sinkType,
    sourceType: args?.sourceType === "mysql-cdc" ? "mysql-cdc" : "kinesis",
    sql: String(args?.sql || ""), // 空则用户在页面补/用 AI 生成;建草稿不校验 INSERT(启动时才校验)
    status: "draft",
    createdByCopilot: true,
    createdAt: now(),
    updatedAt: now(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.FLINK_JOBS, Item: item }));
  return { jobId: item.jobId, name };
}

// ── 业务口径/知识(复用现有 createContext service)──
export async function createContextEntry(args: any, caller: CopilotCaller): Promise<{ entryId: string; title: string }> {
  const title = String(args?.title || "").trim();
  const body = String(args?.body || "").trim();
  if (!title) throw new Error("缺少口径标题 title");
  if (!body) throw new Error("缺少口径内容 body");
  const kind: ContextKind = isKind(args?.kind) ? args.kind : "caliber";
  const e = await createContext({ projectId: caller.projectId, kind, title, body, createdBy: "copilot" });
  return { entryId: e.entryId, title: e.title };
}
