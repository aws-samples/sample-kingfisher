// 模块 38 — GenBI 执行体(纯函数,同步端点与异步执行体共用)。
//
// 把「一次问数从提问到 GenBiResult」的**全部**逻辑集中到这里:后端选择(agentcore→inprocess
// 回退)、脱敏(模块18)、命中表(模块23)、历史/记忆(模块26)。同步 `POST /api/genbi/ask`(flag 关)
// 与异步执行体(flag 开,轮询端点 detached 调用)**共用同一函数** —— 这是「零行为回归」的结构性
// 保证:两条路径产出逐字段一致,只是"何时/如何被拿到"不同。
//
// 关键:执行链路里凡是可长时间阻塞的调用(agentcore invoke / inprocess Bedrock 循环)都透传
// abortSignal —— 到达 300s 天花板时上层 abort,执行体立即停止消耗算力(见 §5.4)。

import { runGenBiAgent } from "@/lib/genbi/agent";
import { suggestChart } from "@/lib/genbi/chart";
import { getContextForGrounding, contextToPromptText, contextToUsedItems } from "@/lib/genbi/context";
import { recordGenBiHistory } from "@/lib/genbi/history";
import { maskRows } from "@/lib/governance/masking";
import { listPublishedDatasets } from "@/lib/requirements/service";
import { parseSqlLineage } from "@/lib/lineage/sql-lineage";
import { invokeGenBiAgent, isAgentCoreConfigured } from "@/lib/genbi/agentcore-client";
import { runtimeSessionId, loadShortTerm, loadLongTerm, appendTurn, maybeSummarize } from "@/lib/genbi/memory";
import type { GenBiResult } from "@/types/genbi";
import type { Identity } from "@/lib/auth/identity";
// @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显(SPEC §3.3a):主循环实际用的模型 + retrieval/memory 两条腿。
import { resolveModelRuntime } from "@/lib/ai/model";
// @kf-batch 50-WP2-directquery —— home 判定的唯一权威
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { buildAiMeta, mergeRanIn, type AiInvocationMeta, type AiModelUse, type RanInMeta } from "@/lib/ai/meta";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";

export interface ExecuteGenBiParams {
  question: string;
  engine: "redshift" | "athena";
  workgroup: string;
  database: string;
  /**
   * @kf-batch 50-WP2-directquery
   * 🔴🔴 **用户 2026-09-09 拍板「连问数都可以切区」**(原话:「我是不是连问数都可以切?
   * 查询的是每个区域的,AgentCore 这一整套只是在主控区有。这样可以的我理解」)。
   * @kf-batch 50-WP31-place-first-class —— 🔴 **必填**(原来缺省 = 主控区):同步路由从请求点名取,
   *   异步执行体取任务记录上的章(targetOfStamp)。
   */
  targetId: string;
  projectId?: string;
  conversationId?: string;
  userId: string;
  identity: Identity | null; // 已解析的调用者身份(脱敏用);在纯函数外解析,保持函数无 req 依赖
  /** @kf-batch 50-W5-seg2-WP8 请求链路 id(_meta.correlationId);异步执行体传认领请求的,缺省新生成 */
  correlationId?: string;
}

export interface ExecuteGenBiResult {
  result: GenBiResult;
  usedBackend: "agentcore" | "inprocess";
  /**
   * @kf-batch 50-WP4ter-coverage
   * 这次问数的 SQL **真打到了哪个区**(= payload 里那个落点的 targetId)。
   * 🔴 给历史行盖章用:可观测看板要按区回答「哪个区的问数在报错 / 在烧 token」,
   * 而历史行原来一个区维都没有 ⇒ 看板只能给全平台合计(工单 SC-6)。
   * 取值只来自**执行时真解析出来的落点**,不是请求里那个可空的入参(空 ⇒ 主控区)。
   */
  targetId: string;
}

// 执行一次问数,返回最终 GenBiResult + 实际使用的后端。抛出异常由调用方处理(同步→apiError;
// 异步→写任务表 failed)。**abortSignal 到达 300s 天花板时,内部长调用抛 AbortError**。
export async function executeGenBiAsk(
  params: ExecuteGenBiParams,
  opts: { abortSignal?: AbortSignal } = {}
): Promise<ExecuteGenBiResult> {
  const { question, engine, workgroup, database, targetId, projectId, conversationId, userId, identity, correlationId } = params;
  const { abortSignal } = opts;

  const backend = (process.env.GENBI_BACKEND || "inprocess").toLowerCase();
  // @kf-batch 50-WP2-one-agentcore-one-om
  // 🔴🔴 **用户 2026-09-10 拍板(逐字):「不管你怎么设计,我的要求是:都走同一个 AgentCore 即可。」**
  //
  // 上一版按「非主控区走进程内引擎」分流 —— 理由是 AgentCore 的技能 Lambda 只会用自己 env 里的
  // 主控区落点。用户否决了那个方案,理由是**多一套要维护的东西 = 迟早不兼容 / 忘记同步修**。
  // ⇒ 定案:**一个 AgentCore 服务所有区**。做法是把「取数落点」变成 payload 的一部分:
  //   平台解析 target 的 region/workgroup/database/secretArn → 容器**确定性注入**每次工具调用
  //   → 技能 Lambda 按落点建 per-region 客户端(缺省回落 env = 主控区,逐字节不变)。
  // 🔴 这样「问数走哪条路」在任何区都是**同一条**:同一个 Runtime、同一个 Gateway、同一份技能与记忆。
  const useAgentCore = backend === "agentcore" && isAgentCoreConfigured();

  // 固化结果表(仅数仓引擎)。两后端共用。
  const published = engine === "athena" ? [] : await listPublishedDatasets(projectId).catch(() => []);

  // 【语义层收口点】业务口径统一在此查一次(单一读取入口 getContextForGrounding,读 body):
  //  · inprocess 后端:注入 systemPrompt(此前零注入,根治默认部署问数不遵循口径);
  //  · agentcore 后端:远程镜像内已自注入,此处不重复注入,仅用同一份口径填 usedContext;
  //  · 两后端最终都在 result.usedContext 暴露"本次参考了哪些口径"(可观测,让口径生效可见)。
  // 口径与表全集无关、失败降级为空(绝不阻塞问数)。
  const ctxEntries = await getContextForGrounding(projectId || "proj-default", question).catch(() => []);
  const businessContext = contextToPromptText(ctxEntries);
  const usedContext = contextToUsedItems(ctxEntries);

  let answer = "";
  let columns: string[] = [];
  let rows: (string | null)[][] = [];
  let genSql: string | null = null;
  let steps: any[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let retrievalNote: string | undefined;
  // @kf-batch 50-W5-seg2-WP8:实际用的模型(inprocess 由 agent 返回;agentcore 由容器回执)+ 子调用明细。
  let modelUse: AiModelUse | null = null;
  const invocations: AiInvocationMeta[] = [];
  // 🔴 本次实际喂进去的前序轮数(见 AiMeta.contextTurns 的理由);两条后端分路都要填。
  let contextTurns = 0;
  // 实际使用的后端(用于历史标签):AgentCore 调用失败回落 inprocess 时须如实改为 "inprocess"。
  let usedBackend: "agentcore" | "inprocess" = useAgentCore ? "agentcore" : "inprocess";
  // @kf-batch 50-WP4ter-coverage —— 执行时真解析出来的落点(AgentCore 分路里赋值)
  let placeTargetId: string | null = null;
  // @kf-batch 50-B26-lake-place —— 执行层回报的真落点(两条后端分路都要填;去重)
  const ranIn: RanInMeta[] = [];

  // 进程内后端(直连 Bedrock Converse 循环,大脑逻辑已全复用 @genbi/core)。
  // 【模块46 阶段4 定位·有意保留,勿删】GenBI 双引擎收敛后,inprocess 已不是"待删的第二套引擎",
  // 而是 core 的直连兜底壳,守住三个 AgentCore 无法替代的实质价值:
  //   1) AgentCore 故障自动兜底(冷启动/限流/Gateway/MCP 故障时无感回落,见下方 catch);
  //   2) 唯一能"真停算力"的路径(abortSignal 每轮/每次 SQL 前检查,模块38 的 300s 天花板到点
  //      能真正中断 Bedrock;AgentCore 的 abort 只断客户端等待,杀不掉远端容器算力);
  //   3) 本地开发路径(GENBI_BACKEND=inprocess 不连 AgentCore 即可测 GenBI)。
  // 大脑逻辑无独立副本(prompt/catalog/retrieval/守卫全走 core),故保留成本≈0,不构成漂移源。
  const runInprocess = async () => {
    const out = await runGenBiAgent(question, workgroup, database, published, engine, {
      abortSignal,
      businessContext,
      // @kf-batch 52-P52.5a-supply — 把项目上下文透到取数身份(flag=off 时只进缓存键,逐字节等价)。
      project: projectId,
      // @kf-batch 50-WP2-directquery —— 取数落点(缺省 home)
      targetId,
    });
    answer = out.answer;
    columns = out.last?.columns || [];
    rows = out.last?.rows || [];
    genSql = out.last?.sql || (out.steps.length ? out.steps[out.steps.length - 1].sql : null);
    steps = out.steps;
    usage = out.usage;
    retrievalNote = out.retrievalNote;
    modelUse = out.model;
    invocations.push(...out.invocations);
    mergeRanIn(ranIn, out.ranIn);
  };

  if (useAgentCore) {
    try {
      // 注入短期(当前对话上下文)+长期(历史摘要)记忆。
      const [history, memory] = await Promise.all([
        conversationId ? loadShortTerm(conversationId, projectId || "proj-default").catch(() => []) : Promise.resolve([]),
        loadLongTerm(projectId || "proj-default", question).catch(() => ""),
      ]);
      contextTurns = Array.isArray(history) ? history.length : 0;
      const sid = runtimeSessionId(conversationId || `${userId}-default`);
      // @kf-batch 50-WP2-one-agentcore-one-om
      // 🔴 取数落点在**平台侧**解析(唯一权威 = 注册表描述符 + `resolveRedshiftBinding`),随 payload 交给容器。
      //    在容器/Lambda 里再算一遍就是第二份落点逻辑,而那类副本的失效形态是**静默打回主控区**。
      // 🔴🔴 **恒带落点(含主控区)** —— 契约门禁 `contract-drift` 的负向清单当场逮到我原来的写法
      //    「缺省不传 ⇒ Lambda 回落自己的 env」:那等于给非 home 留了一条**静默打回主控区**的路
      //    (平台哪天漏传 place,Lambda 分不出「没指定 target」与「target 的落点丢了」,
      //     于是在主控区跑完、把结果当成那个区的答案)。§1.1/§2.2 的 fail-closed 不许有这种面。
      //    ⇒ 平台**每次**都算好落点并带上;技能 Lambda 的 env 只是「完全没有调用方信息」时的兜底
      //      (例如有人直接调 Gateway 工具),不再是按区执行链路的回落点。
      // eslint-disable-next-line prefer-const
      // 🔴🔴 B-26:落点按**引擎**解析(唯一作者 `resolveGenBiPlace`)。原来 Athena 也拿 Redshift 的落点,
      //   容器只并 `rs*`、技能 Lambda 的 Athena 用主控区客户端 ⇒ 别的区问数据湖整条落回主控区。
      const { resolveGenBiPlace, placeWireOfGenBi } = await import("@/lib/genbi/place");
      // 序 38 B-71:Athena 引擎把用户选的「库」(S3 Tables 命名空间)带给落点解析 ⇒ 已登记外部表桶里的命名空间也能问
      const place = await resolveGenBiPlace(engine, targetId, projectId, engine === "athena" && typeof database === "string" && database ? database : undefined);
      placeTargetId = place.targetId; // @kf-batch 50-WP4ter-coverage —— 历史行的区章取这里
      // @kf-batch 50-WP31-place-first-class —— 序 4(L6):容器读 `placeWire`(PlaceWire v1);`place` 只给旧镜像过渡
      const placeWire = placeWireOfGenBi(place);
      const out = await invokeGenBiAgent(sid, { prompt: question, engine, database, projectId: projectId || "proj-default", published, history, memory, place, placeWire }, { abortSignal });
      answer = out.answer;
      columns = out.columns;
      rows = out.rows;
      genSql = out.sql || (out.steps.length ? out.steps[out.steps.length - 1].sql : null);
      steps = out.steps;
      usage = out.usage;
      modelUse = out.model ?? null;
      // @kf-batch 50-W5-seg2-WP8:容器回执的子调用腿(genbi-retrieval)并进 _meta.invocations[](与 inprocess 的 sink 同一形状)
      invocations.push(...(out.invocations ?? []));
      mergeRanIn(ranIn, out.ranIn ?? []);
    } catch (e: unknown) {
      // 到达天花板的 abort 不该被"回落 inprocess"吞掉——直接上抛让上层写 timeout。
      if (abortSignal?.aborted) throw e;
      // @kf-batch 50-W5-seg2-WP8:模型回执不匹配是**接线故障**不是可用性抖动 —— fail-closed 上抛(路由 503),不回落假装成功。
      if (e instanceof AgentCoreModelMismatch) throw e;
      // AgentCore 故障(冷启动/限流/Gateway/MCP 等)不应让本可用功能失败:自动回落进程内后端。
      console.warn(`[genbi] AgentCore 调用失败,回退 inprocess: ${e instanceof Error ? e.message : String(e)}`);
      usedBackend = "inprocess";
      await runInprocess();
    }
  } else {
    await runInprocess();
  }

  // 模块 18: 脱敏(admins/授权者豁免)。identity 由调用方预先解析后传入。
  const masked = await maskRows({ columns: columns.map((name) => ({ name })), rows, sql: genSql || undefined, database, identity });

  // 模块 23: 命中数据表以实际 SQL 为准(athena 三段式不解析)。
  const matchedTables = (() => {
    if (engine === "athena" || !genSql) return [];
    try {
      const parsed = parseSqlLineage(genSql, { database });
      const pubByTable = new Map(published.map((p: any) => [String(p.targetTable || "").toLowerCase(), p]));
      const seen = new Set<string>();
      const arr: { schema: string; table: string; reason: string; preferred: boolean }[] = [];
      for (const s of parsed.sources || []) {
        const key = `${s.schema}.${s.table}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const pub = pubByTable.get(s.table.toLowerCase());
        arr.push({ schema: s.schema, table: s.table, preferred: !!pub, reason: pub ? `已固化结果表（来源：${pub.question || pub.title}）` : "本次查询使用" });
      }
      return arr;
    } catch { return []; }
  })();

  const result: GenBiResult = {
    answer,
    sql: genSql,
    columns,
    rows: masked.rows as (string | null)[][],
    rowCount: rows.length,
    chart: suggestChart(columns, masked.rows as (string | null)[][]),
    steps,
    usage,
    ...(masked.maskedColumns.length ? { maskedColumns: masked.maskedColumns } : {}),
    ...(matchedTables.length ? { matchedTables } : {}),
    ...(usedContext.length ? { usedContext } : {}),
    ...(retrievalNote ? { retrievalNote } : {}),
  };

  // @kf-batch 50-W5-seg2-WP8 — `_meta`(SPEC §3.3a):
  //  · modelId/modelSource = 主循环**实际**用的(降级则为回落层,M14);兜底用解析链(理论不可达:两条后端都会给)。
  //  · invocations[]:genbi 主调用 + retrieval(sink 收集的真实子调用)+ memory(🔴 deferred:长期摘要在
  //    persistGenBiSideEffects 里响应后 fire-and-forget、且每 6 轮才触发,这里回显的是它**将要用**的解析值,不冒充铁证)。
  const primary: AiModelUse = modelUse ?? (await resolveModelRuntime("genbi").then((r) => ({ modelId: r.modelId, modelSource: r.source })));
  const metaInvocations: AiInvocationMeta[] = [{ capability: "genbi", modelId: primary.modelId, modelSource: primary.modelSource, ...(primary.degraded ? { degraded: true } : {}) }, ...invocations];
  if (conversationId) {
    const mem = await resolveModelRuntime("genbi-memory");
    metaInvocations.push({ capability: "genbi-memory", modelId: mem.modelId, modelSource: mem.source, deferred: true });
  }
  // @kf-batch 50-WP2-directquery —— 回显本次实际后端(非主控区会是 inprocess;见 SPEC §3.4.5)
  result._meta = buildAiMeta(null, primary, { invocations: metaInvocations, correlationId, backend: usedBackend, contextTurns, ranIn });

  // 注意:历史/记忆等**副作用**不在此写(见 persistGenBiSideEffects)。原因:异步路径下任务可能被
  // 重认领重跑(心跳 stale),若在纯函数内 fire-and-forget 记历史,重跑会写两条。改由「成功落终态的
  // 那个 owner」显式调 persistGenBiSideEffects → 天然只记一次(条件写终态保证单一 owner)。同步路径
  // 亦在拿到结果后调它 → 两条路径时机/产出与改造前一致(零回归)。
  // @kf-batch 50-WP4ter-coverage —— 落点回给调用方(它要用来给历史行盖章)。
  // 回落 inprocess 的分路没有 place 解析,但它用的就是同一个入参 target(空 = 主控区)。
  return { result, usedBackend, targetId: placeTargetId ?? (targetId || HOME_TARGET_ID) };
}

// 记录副作用:历史(bgp-genbi-history) + 对话记忆(短期 turns + 长期摘要)。fire-and-forget,
// 永不阻塞/影响主结果。由「产出被真正采纳」的时机调用一次(同步=返回前;异步=markSucceeded 成功后)。
export function persistGenBiSideEffects(params: {
  userId: string; question: string; answer: string; sql: string | null;
  engine: string; backend: string; projectId?: string; conversationId?: string; result: GenBiResult;
  /** @kf-batch 50-WP4ter-coverage —— 这次问数真打到的区(必填:少传就等于又回到「没有区维」) */
  targetId: string;
}): void {
  const { userId, question, answer, sql, engine, backend, projectId, conversationId, result, targetId } = params;
  recordGenBiHistory(userId, question, result, { engine, backend, targetId }).catch(() => {});
  if (conversationId) {
    appendTurn(conversationId, { question, answer, sql }, projectId || "proj-default")
      .then(() => maybeSummarize(conversationId, projectId || "proj-default"))
      .catch(() => {});
  }
}
