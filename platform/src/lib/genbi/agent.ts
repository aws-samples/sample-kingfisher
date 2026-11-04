// GenBI agent — Bedrock Converse loop with a single read-only `run_sql` tool, ported from
// the DataAgent reference. The model translates intent into SQL and interprets results;
// ALL arithmetic is done by Redshift. The conversation loops until the model stops asking
// for tools or the iteration cap is reached.

// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { GENBI } from "./config";
import { runSelect, type SqlRunResult } from "./redshift";
import { introspectSchema } from "./schema";
import { introspectS3Tables, runSelectAthena, S3TABLES_NAMESPACE } from "./athena";
import { systemPrompt, type GenBiEngine } from "./prompt";
import { buildCatalogText } from "./core/catalog";
import { guard as cookbookGuard } from "@/lib/cookbook";
import { resolveS3TablesPlaceForNamespace } from "@/lib/athena/s3tables";
import {
  selectRelevantTables,
  fetchOmDescriptions,
  type PublishedHint,
  type TableMatch,
  type CatalogEntry,
  type RetrievalResult,
} from "./retrieval";
import type { GenBiStep } from "@/types/genbi";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:主循环 modelId 改为调用处求值(循环外解析一次候选层,循环内每次 Converse 经
// invokeConverse 退避/降级);不再读模块加载期常量 GENBI.modelId。实际用的模型随 AgentOutput.model 回给 _meta。
import { resolveLayered } from "@/lib/ai/model";
import { invokeConverse } from "@/lib/ai/invoke";
import { mergeRanIn, type AiInvocationMeta, type AiModelUse, type RanInMeta } from "@/lib/ai/meta";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: GENBI.region });

// 模块 38 — 异步化强制结束：执行体到达 300s 天花板时 abort。inprocess 循环在每轮迭代前
// 与每次 SQL 执行前检查此信号 → 抛可识别的 AbortError → 立即停止消耗算力(不再进下一轮、
// 不再发 Bedrock/查询)。**同步路径(flag 关)不传 signal，signal?.aborted 恒 false，行为逐字节不变。**
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const e = new Error("GENBI_ABORTED");
    e.name = "AbortError";
    throw e;
  }
}

// 目录文本渲染已收敛进 @genbi/core buildCatalogText（阶段3 归一,容器/inprocess/codegen 共用）。
// 此处按 inprocess 场景包一层:检索命中表(retrievalHeader)+ Athena 用**该区**的联邦目录引用。
// 🔴 B-26:原来写死平台常量 ATHENA_CATALOG_REF(主控区表桶)⇒ 别的区问数据湖,目录里每张表都是主控区的名字。
function catalogText(entries: CatalogEntry[], database: string, engine: GenBiEngine, athenaRef: string): string {
  return buildCatalogText(entries, database, { engine, athenaRef, retrievalHeader: true });
}

function buildRunSqlTool(engine: GenBiEngine, athenaRef: string): Tool {
  const isAthena = engine === "athena";
  return {
    toolSpec: {
      name: "run_sql",
      description: isAthena
        ? '在 Amazon Athena 执行只读 SQL(仅 SELECT/WITH，Trino 方言) 查询数据湖 S3 Tables。表用三段式联邦目录名。返回列名与数据行。所有计算都在这里完成。'
        : "在 Amazon Redshift 执行只读 SQL(仅 SELECT/WITH)。返回列名与数据行。所有计算都在这里完成。",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            sql: {
              type: "string",
              description: isAthena
                ? `Athena(Trino 方言) SELECT 或 WITH 查询；表用 "${athenaRef}"."<命名空间>"."<表>"，中文别名用双引号`
                : "Redshift(PostgreSQL 方言) SELECT 或 WITH 查询；中文别名用双引号包裹",
            },
          },
          required: ["sql"],
        },
      },
    },
  };
}

export interface AgentOutput {
  answer: string;
  steps: GenBiStep[];
  last: SqlRunResult | null; // last successful query result, for display
  usage: { inputTokens: number; outputTokens: number };
  matchedTables: TableMatch[]; // 检索命中的表 + 理由（可解释）
  retrievalNote?: string;
  // @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显:主循环实际用的模型(降级则为回落层)+ 子调用(检索)明细。
  model: AiModelUse;
  invocations: AiInvocationMeta[];
  /** @kf-batch 50-B26-lake-place —— 本次每条 SQL 真发出去的落点(执行层回报,去重) */
  ranIn: RanInMeta[];
}

export async function runGenBiAgent(
  question: string,
  workgroup: string,
  database: string,
  published: PublishedHint[] = [],
  engine: GenBiEngine = "redshift",
  // @kf-batch 52-P52.5a-supply — 加 `project` 位:问数是**项目上下文**取数(静态归类 project-context)。
  // @kf-batch 50-WP2-directquery —— `targetId` = 取数落点(缺省 home);两个原子都要收到它,
  // 少给一个就会出现「schema 探的是这个区、SQL 跑在另一个区」这种最难查的错位。
  // @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 home)
  opts: { abortSignal?: AbortSignal; businessContext?: string; project?: string; targetId: string }
): Promise<AgentOutput> {
  const { abortSignal, businessContext, project, targetId } = opts;
  const isAthena = engine === "athena";
  // athena 引擎查数据湖 S3 Tables 命名空间；redshift 引擎查数仓库。
  // 命名空间优先用前端选中的 database(如游戏环境的 gamedata);未选时回退默认常量。
  // 此前写死 S3TABLES_NAMESPACE(默认 ecommerce),游戏环境无该命名空间 → S3Tables 404。
  const effectiveDb = isAthena ? (database || S3TABLES_NAMESPACE) : database;
  const steps: GenBiStep[] = [];
  const tIntrospect = Date.now();
  // 🔴🔴 B-26:Athena 两处原来都没传 targetId ⇒ 非主控区视角的数据湖问数整条落回主控区(无头实测 10/10 条)。
  //   现在两个原子 + 目录引用都取同一个 targetId;`introspectS3Tables`/`runSelectAthena` 的落点已是必填键。
  // 序 38 B-71:目录引用按**用户选的命名空间**找所在表桶(平台表桶 / 已登记外部表桶),不再恒取平台表桶
  const athenaRef = isAthena ? (await resolveS3TablesPlaceForNamespace(targetId, effectiveDb)).catalogRef : "";
  const tables = isAthena
    ? await introspectS3Tables(effectiveDb, { targetId })
    : await introspectSchema(workgroup, database, { project: project ?? null, targetId });
  // 执行链路准备步:探查 schema(与 AgentCore 后端的 introspect 工具对齐)。
  steps.push({
    sql: "", ok: true, tool: isAthena ? "introspect_s3tables_schema" : "introspect_redshift_schema",
    phase: "prepare", inputSummary: isAthena ? JSON.stringify({ namespace: effectiveDb }) : JSON.stringify({ workgroup, database }),
    outputSummary: `${tables.length} 张表`, durationMs: Date.now() - tIntrospect,
  });
  // 阶段一：语义表检索（OM 描述 best-effort + 固化加权 + LLM 重排序；异常回退全部表）。
  // 固化结果表是 Redshift（数仓）概念，athena 引擎不注入。
  const omDesc = await fetchOmDescriptions().catch(() => ({}));
  const pubHints = isAthena ? [] : published;
  const tRetrieval = Date.now();
  // @kf-batch 50-W5-seg2-WP8:子调用(检索重排)实际用的模型经 sink 收进 invocations(_meta.invocations[] 的第二条腿)。
  const invocations: AiInvocationMeta[] = [];
  const retrieval = await selectRelevantTables(question, tables, pubHints, omDesc, { onInvocation: (inv) => invocations.push(inv) }).catch(
    (): RetrievalResult => ({ selected: [], matches: [], usedFallback: true })
  );
  steps.push({
    sql: "", ok: !retrieval.usedFallback, tool: "select_relevant_tables", phase: "prepare",
    inputSummary: JSON.stringify({ question: question.slice(0, 80), candidates: tables.length }),
    outputSummary: retrieval.usedFallback ? "检索回退:使用全部表" : `命中 ${retrieval.selected.length} 张表`,
    durationMs: Date.now() - tRetrieval,
  });
  // 检索异常回退：用全部表，避免空目录导致无法作答。
  const selected = retrieval.selected.length
    ? retrieval.selected
    : tables.map((t): CatalogEntry => ({ schema: t.schema, table: t.table, columns: t.columns }));

  // 阶段二：仅以检索命中的表 grounding 生成 SQL。businessContext 注入业务口径(见语义层顶层设计:
  // 让 inprocess 后端与 agentcore 后端口径行为一致)。
  let systemText = systemPrompt(catalogText(selected, effectiveDb, engine, athenaRef), effectiveDb, engine, businessContext || "", { athenaRef: athenaRef || undefined });

  // 固化结果表优先（仅 Redshift 引擎）：候选中若含固化表，强调"口径一致就直接查结果表"。
  const pub = isAthena ? [] : selected.filter((e) => e.published);
  if (pub.length) {
    const linesP = pub
      .map((e) => `- ${e.schema}.${e.table}（字段：${e.columns.map((c) => c.name).join(", ")}）：已固化「${e.published!.title}${e.published!.question ? ` / ${e.published!.question}` : ""}」`)
      .join("\n");
    systemText +=
      `\n\n## 已固化结果表（必须优先使用）\n以下结果表已固定业务口径并预计算。**只要它能回答用户问题，就必须基于它作答**` +
      `（必要时在其上做 SUM / AVG / 过滤 等聚合即可），**禁止改用原始明细表重新计算**——这正是"固化"的目的：复用、加速、口径统一。\n${linesP}\n` +
      `仅当固化表确实无法回答（缺所需维度/字段）时，才使用其它表。`;
  }

  const system = [{ text: systemText }];
  const messages: Message[] = [{ role: "user", content: [{ text: question }] }];
  const toolConfig = { tools: [buildRunSqlTool(engine, athenaRef)] };
  const ranIn: RanInMeta[] = [];

  let last: SqlRunResult | null = null;
  let inTok = 0;
  let outTok = 0;

  // @kf-batch 50-W5-seg2-WP8:循环外求值一次候选层(51 SPEC §3.3「非每轮迭代求值」);循环内每次 Converse 经
  // invokeConverse 走同一份候选层做退避/降级。`used` 记录最近一次实际用的模型(降级后为回落层,M14)。
  const layers = await resolveLayered("genbi");
  let used: AiModelUse = { modelId: layers[0].modelId, modelSource: layers[0].source };

  for (let iter = 0; iter < GENBI.maxIters; iter++) {
    // 模块 38：到达 300s 天花板则本轮开始前即停(不再发 Bedrock 推理)。
    throwIfAborted(abortSignal);
    const inv = await invokeConverse(
      "genbi",
      undefined,
      bedrock,
      (modelId) =>
        new ConverseCommand({
          modelId,
          system,
          messages,
          toolConfig,
          inferenceConfig: { maxTokens: GENBI.maxTokens },
        }),
      { abortSignal },
      { layers }
    );
    const resp = inv.response;
    used = { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) };

    inTok += resp.usage?.inputTokens || 0;
    outTok += resp.usage?.outputTokens || 0;

    const outMsg = resp.output?.message;
    if (outMsg) messages.push(outMsg);

    if (resp.stopReason !== "tool_use") {
      const answer = (outMsg?.content || [])
        .map((b) => ("text" in b ? b.text : ""))
        .join("")
        .trim();
      return { answer, steps, last, usage: { inputTokens: inTok, outputTokens: outTok }, matchedTables: retrieval.matches, retrievalNote: retrieval.note, model: used, invocations, ranIn };
    }

    const toolResults: Message["content"] = [];
    for (const blk of outMsg?.content || []) {
      const tu = "toolUse" in blk ? blk.toolUse : undefined;
      if (!tu || !tu.toolUseId) continue;

      if (tu.name === "run_sql") {
        const input = (tu.input || {}) as { sql?: string };
        const rawSql = input.sql || "";
        // 模块45(生成后方言校验):用 cookbook 同源方言规则纠正模型偶发违规(GenBI 产 SELECT,
        // 主要命中反引号→双引号:Redshift/Trino 都拒反引号)。纯 CPU、幂等;不改语义只纠方言语法。
        // 与执行器内既有只读守卫(sanitizeSelect/sanitizeReadOnly,拒非SELECT+限行)并存:此处先纠方言、执行前再兜只读安全。
        const sql = cookbookGuard(isAthena ? "athena" : "redshift", rawSql).code;
        // 模块 38：到达天花板则不再发起新查询(避免长查询继续占用连接/算力)。
        throwIfAborted(abortSignal);
        const tRun = Date.now();
        const res = isAthena ? await runSelectAthena(sql, { targetId }) : await runSelect(sql, workgroup, database, { project: project ?? null, targetId });
        mergeRanIn(ranIn, [res.ranIn]);
        steps.push({
          sql, ok: res.success, rowCount: res.rowCount, error: res.error,
          tool: "run_sql", phase: "reason",
          outputSummary: res.success ? `${res.rowCount} 行 × ${res.columns.length} 列` : String(res.error || "").slice(0, 200),
          durationMs: Date.now() - tRun,
        });
        if (res.success) last = res;
        const payload: Record<string, unknown> = res.success
          ? {
              columns: res.columns,
              rows: res.rows.slice(0, GENBI.modelRows),
              row_count: res.rowCount,
              shown_rows: Math.min(res.rows.length, GENBI.modelRows),
            }
          : { error: res.error || "查询失败" };
        toolResults.push({
          toolResult: { toolUseId: tu.toolUseId, content: [{ json: payload as any }] },
        });
      } else {
        toolResults.push({
          toolResult: {
            toolUseId: tu.toolUseId,
            content: [{ json: { error: `unknown tool ${tu.name}` } }],
            status: "error",
          },
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: "（已达最大推理步数，未能完成。请把问题拆得更具体，或缩小时间/范围后重试。）",
    steps,
    last,
    usage: { inputTokens: inTok, outputTokens: outTok },
    matchedTables: retrieval.matches,
    retrievalNote: retrieval.note,
    model: used,
    invocations,
    ranIn,
  };
}
