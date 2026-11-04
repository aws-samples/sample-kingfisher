// GenBI Agent 核心：模块46 阶段3 起改用 Strands Agents 框架承载 Converse 循环
// （替代手写 for 循环），大脑纯逻辑复用 @genbi/core，工具执行仍经 Gateway MCP
// （run_redshift_sql/run_athena_sql/introspect_*）。retrieval（语义表检索）在 prepare
// 阶段用 core.selectRelevantTables（做法A，与 platform inprocess 同构）。
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { MCPClient } from "./mcp.js";
// @genbi/core 编译产物（prebuild copy 进 core-dist）：语义表检索 + systemPrompt/catalog 拼装
// （阶段3 归一:容器与 platform inprocess 共用同一份 core,不再本地手抄 prompt/catalog）。
import { selectRelevantTables } from "./core-dist/retrieval-core.js";
import { systemPrompt } from "./core-dist/prompt.js";
import { buildCatalogText } from "./core-dist/catalog.js";
// 模块45 P45.5b:cookbook 方言 guard 纯核(编译产物,零 @/零 DynamoDB)。与 inprocess lib/genbi/agent.ts:189
// 同源纯核 → 消除"远程容器生成的 SQL 不过 cookbook guard"盲区(线上默认走 agentcore=主链路盲区)。
import { guard as cookbookGuard } from "./core-dist/cookbook/core-guard.js";
// @kf-batch 50-WP31-place-first-class —— 序 4(L6):PlaceWire 读取函数(与平台 / 技能 Lambda 同源)
import { readPlaceWire, placeWireLeg } from "./core-dist/place-wire.js";
// @kf-batch 51-v2-multi-vendor —— 模块 51 v2.0(51 SPEC §7.2 容器落点):厂商档案 + 请求整形,core-dist/ai 与平台 lib/ai/core 同一份源。
//   容器自己拼 ConverseCommand 的只有下面的检索重排 ModelClient;Strands 主循环只吃 maxTokens 系数(Kimi K3 ×2)。
import { shapeInferenceConfig, learnUnsupportedField } from "./core-dist/ai/converse-shape.js";
// @kf-batch 51-v2-multi-vendor(D17)—— 瞬态流错误判定 + 有界抖动退避,与平台 / 其它容器同一份清单(core-dist/ai)
import { describeModelError, TRANSIENT_MAX_RETRIES, transientBackoffMs } from "./core-dist/ai/transient.js";

const REGION = process.env.AWS_REGION || "us-east-1";
const GATEWAY_URL = process.env.GATEWAY_URL || "";

// @kf-batch 50-W5-seg2-WP8 — 模块 51(P51.2 容器读侧):模型 = payload.modelId(平台按运行时配置透传)‖ env BEDROCK_MODEL_ID。
// 🔴 删掉了手抄的兜底字面量(sonnet-4-5,已与 SSOT 漂移):容器读不到 ai-model.json,手抄必再漂;
// 两个来源都缺就明确报错(fail-closed),不静默用过期模型。生产由 CDK 恒注入 env。
function resolveContainerModelId(input) {
  const fromPayload = input && typeof input.modelId === "string" ? input.modelId.trim() : "";
  if (fromPayload) return { modelId: fromPayload, source: "payload" };
  const fromEnv = (process.env.BEDROCK_MODEL_ID || "").trim();
  if (fromEnv) return { modelId: fromEnv, source: "env" };
  throw new Error("模型未配置:payload.modelId 与 env BEDROCK_MODEL_ID 均为空(容器不再内置兜底模型名,防 SSOT 漂移)");
}
const MAX_ITERS = parseInt(process.env.GENBI_MAX_ITERS || "8", 10);
const MAX_TOKENS = parseInt(process.env.GENBI_MAX_TOKENS || "2200", 10);
const MODEL_ROWS = parseInt(process.env.GENBI_MODEL_ROWS || "50", 10);
// Athena 三段式联邦目录前缀(不带引号;core buildCatalogText 内部会套双引号)。
const S3T_REF = `${process.env.S3TABLES_CATALOG || "s3tablescatalog"}/${process.env.S3TABLES_BUCKET || "bgp-table-bucket"}`;
const S3T_NS = process.env.S3TABLES_NAMESPACE || "ecommerce";

const bedrock = new BedrockRuntimeClient({ region: REGION });

// ModelClient 适配器：core.selectRelevantTables 需注入（LLM 重排序用）。Bedrock 直连。
// @kf-batch 50-W5-seg2-WP8:改工厂,按本次 invoke 解析出的 modelId 建(检索重排与主循环同一模型)。
// @kf-batch 50-W5-seg2-WP8 — 模块 51:该 client 只给检索重排(selectRelevantTables)用;每次真发 Converse 后经 onInvocation 回报,
//   让容器回执 `_meta.invocations[]` 带上 genbi-retrieval 腿(51 SPEC §3.3a 三条腿在 agentcore 后端下同样可观测;真环境 p51 M6-② 抓到缺这一腿)。
const makeBedrockModelClient = (MODEL_ID, onInvocation) => ({
  async converse({ system, messages, maxTokens, temperature }) {
    const base = {
      modelId: MODEL_ID,
      system: system ? [{ text: system }] : undefined,
      messages: (messages || []).map((m) => ({ role: m.role, content: [{ text: m.content }] })),
    };
    const want = { maxTokens: maxTokens || 1000, temperature: temperature ?? 0 };
    // D12:按厂商档案(+ 运行期学到的)剥掉该模型不支持的字段、放大 maxTokens(Claude 恒等);
    //   Bedrock 回「This model doesn't support the X field」⇒ 学到 X 后立刻重试一次(这次整形会剥掉 X),别的错误原样抛。
    const send = () => bedrock.send(new ConverseCommand({ ...base, inferenceConfig: shapeInferenceConfig(MODEL_ID, want).config }));
    let resp;
    try {
      resp = await send();
    } catch (e) {
      const learned = learnUnsupportedField(MODEL_ID, e);
      if (!learned) throw e;
      console.warn(`[genbi-agent] ${MODEL_ID} 不支持 inferenceConfig.${learned}(Bedrock 原话),已学到并剥掉,重试一次`);
      resp = await send();
    }
    if (typeof onInvocation === "function") onInvocation();
    const text = (resp.output?.message?.content || []).map((b) => ("text" in b ? b.text : "")).join("");
    return { text, usage: { inputTokens: resp.usage?.inputTokens || 0, outputTokens: resp.usage?.outputTokens || 0 } };
  },
});

// systemPrompt / catalogText 已收敛进 @genbi/core（阶段3 归一,与 platform inprocess 共用）。
// 容器特有的 skillsCatalog/published/memory 经 core systemPrompt 的 opts 传入(见调用处)。

export async function runAgent(input) {
  // @kf-batch 50-W5-seg2-WP8:每次 invoke 求值(payload 优先);实际用的模型回显在返回 wire 的 _meta(平台侧校验相等)。
  const { modelId: MODEL_ID, source: modelSource } = resolveContainerModelId(input);
  const _meta = { modelId: MODEL_ID, modelSource, invocations: [], ranIn: [] };
  const bedrockModelClient = makeBedrockModelClient(MODEL_ID, () => {
    if (!_meta.invocations.some((i) => i.capability === "genbi-retrieval")) _meta.invocations.push({ capability: "genbi-retrieval", modelId: MODEL_ID, modelSource });
  });
  // @kf-batch 50-WP4ter-coverage —— 入站 payload 是否带落点(区分「平台没发」与「容器丢了」)
  try {
    console.log(JSON.stringify({
      tag: "agent-input", inputKeys: Object.keys(input || {}).sort(),
      hasPlace: !!(input && input.place), placeKeys: Object.keys((input && input.place) || {}).sort(),
      hasPlaceWire: !!(input && input.placeWire),
    }));
  } catch (_) { /* 日志绝不影响执行 */ }
  const isAthena = input.engine === "athena";
  // 命名空间/库优先用前端传入(Athena=选中的 S3 Tables 命名空间如 gamedata;Redshift=库)。
  // 此前 Athena 写死 S3T_NS(默认 ecommerce),游戏环境无该命名空间 → introspect 404。
  const db = isAthena ? (input.database || S3T_NS) : (input.database || "dev");
  if (!GATEWAY_URL) throw new Error("GATEWAY_URL 未配置");

  const mcp = new MCPClient(GATEWAY_URL, REGION);
  await mcp.init();
  const tools = await mcp.listTools();
  const findTool = (suffix) => {
    const t = tools.find((x) => (x.name || "").endsWith(suffix));
    return t ? t.name : suffix; // 退化用裸名
  };
  const introspectName = findTool(isAthena ? "introspect_s3tables_schema" : "introspect_redshift_schema");

  // 执行链路:每次工具/技能调用都记一步(准备阶段 + 推理阶段),前端按 Timeline 展示。
  const steps = [];
  const brief = (v, n) => { try { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; } catch { return ""; } };
  const summarizeOut = (res) => {
    if (!res) return "";
    if (res.error) return brief(String(res.error), 200);
    if (Array.isArray(res.rows)) return `${res.rowCount ?? res.rows.length} 行 × ${(res.columns || []).length} 列`;
    if (Array.isArray(res.tables)) return `${res.tables.length} 张表`;
    if (Array.isArray(res.entries)) return `${res.entries.length} 条口径`;
    return brief(res, 200);
  };
  // @kf-batch 50-WP2-one-agentcore-one-om
  // 🔴🔴 **用户 2026-09-10 拍板「都走同一个 AgentCore」** ⇒ 本容器必须能在**任意执行环境的数仓**上取数。
  // 落点由平台在 payload 里给(`input.place`),这里**确定性地**并进每一次工具调用的入参 ——
  // 🔴 刻意**不**让模型决定:模型可能漏传、也可能编一个别的区(那就是在错的区执行并把结果当成对的),
  //    而这类错误在答案里**看不出来**。与既有的 `projectId` 注入同一手法、同一理由。
  // @kf-batch 50-WP31-place-first-class —— 序 4(L6):🔴 rs* / ath* 八个平面字段**合并**成一个 `place` 入参(PlaceWire v1 的 JSON 文本)。
  //   读取函数与平台、技能 Lambda **同一份源**(core-dist/place-wire.js ← platform/src/lib/genbi/core/place-wire.ts)。
  //   🔴 落点**必填**:缺 / 不合法 ⇒ 当场抛(平台收到错误回落进程内后端,那边用的是同一个落点)——
  //   原来「没给 place ⇒ 不注入 ⇒ 技能 Lambda 用自己 env 里的主控区」,那正是静默打回主控区的那条路。
  const placeWire = readPlaceWire(input && input.placeWire);
  const placeArgs = { place: JSON.stringify(placeWire) };
  // @kf-batch 50-WP4ter-coverage
  // 🔴🔴 **唯一漏斗**(2026-09-10 真环境抓到的静默跨区执行的根治):此前落点只在 `tracedCall` 里并进,
  // 而**模型驱动的工具循环**(下面 `callback`)是另一处 `mcp.callTool`,它没并 ⇒ 探查表结构去了
  // 正确的区、**真正取数的那几条 SQL 落回主控区**,报「relation does not exist」看起来像数据问题。
  // ⇒ 现在**所有**对 Gateway 的调用都经 `callTool()` 这一个出口,落点在这里并进;
  //   门禁 `agentcore-place-schema` 断言全文件 `mcp.callTool(` **只出现一次**(就是这里)。
  const callTool = async (name, args) => {
    const argsWithPlace = { ...(args && typeof args === "object" ? args : {}), ...placeArgs };
    // @kf-batch 50-WP4ter-coverage —— 🔴 落点可观测:这次真正发给 Gateway 的入参键 + 落点摘要。
    // 上一次排查「问数落回主控区」时,这一层完全没有痕迹,只能靠 Redshift 侧的查询历史反推。
    // 只打键名与 region/workgroup(不打 secret 值,与错误脱敏同一纪律)。
    try {
      console.log(JSON.stringify({
        tag: "agent-callTool", tool: String(name).split("___").pop(),
        argKeys: Object.keys(argsWithPlace).sort(),
        placeKeys: Object.keys(placeArgs).sort(),
        targetId: placeWire.targetId, region: placeWire.region,
        rsWorkgroup: placeWire.redshift ? placeWire.redshift.workgroup : null,
        athWorkgroup: placeWire.athena ? placeWire.athena.workgroup : null,
      }));
    } catch (_) { /* 日志绝不影响执行 */ }
    const res = await mcp.callTool(name, argsWithPlace);
    // @kf-batch 50-B26-lake-place —— 技能 Lambda 回报的**真落点**汇总进 `_meta.ranIn`(去重;形状不对的丢掉)。
    //   放在唯一漏斗里 ⇒ 预取、模型循环、技能三条路都收得到,不会出现「某条路执行了却没回报」。
    try {
      const r = res && res.ranIn;
      if (r && typeof r.region === "string" && r.region && (r.engine === "redshift" || r.engine === "athena") && typeof r.workgroup === "string"
          && !_meta.ranIn.some((x) => x.engine === r.engine && x.region === r.region && x.workgroup === r.workgroup)) {
        _meta.ranIn.push({ engine: r.engine, region: r.region, workgroup: r.workgroup });
      }
    } catch (_) { /* 回报失败绝不影响执行 */ }
    return res;
  };
  const tracedCall = async (name, args, phase) => {
    const t0 = Date.now();
    let res, err;
    try { res = await callTool(name, args); } catch (e) { err = e; }
    const ok = !err && !(res && res.success === false);
    steps.push({
      tool: name.split("___").pop() || name, phase,
      // sql 优先用入参(run_sql);技能调用入参无 sql,则用返回里渲染后的 sql(run_registered_skill),使执行链路也展示技能实际 SQL。
      sql: (args && args.sql ? String(args.sql) : "") || (res && res.sql ? String(res.sql) : ""),
      inputSummary: args && args.sql ? "" : brief(args || {}, 200),
      outputSummary: err ? brief(String(err.message || err), 200) : summarizeOut(res),
      ok, rowCount: res && res.rowCount, error: err ? String(err.message || err) : (res && res.error),
      durationMs: Date.now() - t0,
    });
    if (err) throw err;
    return res;
  };

  // 阶段一：探查 schema（经 MCP 工具）。Athena 传 namespace(前端选中的 S3 Tables 命名空间),否则 introspect 用默认常量致 404。
  const introspectRes = await tracedCall(introspectName, isAthena ? { namespace: db } : {}, "prepare");
  const allTables = (introspectRes && introspectRes.tables) || [];

  // 阶段一(a2)：语义表检索（模块46 阶段3 新增,做法A——与 platform inprocess 同构）。
  // 从全部表中选出与问题最相关的表(TOPK),grounding 更聚焦。OM 描述经 MCP 工具 fetch_om_descriptions
  // 取(容器非 VPC,由 Lambda 代读,best-effort);检索本身用 core.selectRelevantTables + Bedrock 重排。
  // 检索结果记成 prepare 阶段一步(tool=select_relevant_tables,与 TS 端契约一致,retrievalNote 走 steps 不扩 wire)。
  let catTables = allTables;
  let retrievalMatches = [];
  if (allTables.length > 1) {
    const tRetr = Date.now();
    let omDesc = {};
    try {
      const omName = findTool("fetch_om_descriptions");
      const omRes = await callTool(omName, {}); // 不单独记 step(内部增强,失败静默;走唯一漏斗)
      if (omRes && omRes.descriptions && typeof omRes.descriptions === "object") omDesc = omRes.descriptions;
    } catch { /* best-effort：OM 取不到不影响检索(回退表名/列名+LLM 重排) */ }
    const published = isAthena ? [] : (Array.isArray(input.published) ? input.published : []);
    let retrieval = { selected: [], matches: [], usedFallback: true };
    try {
      retrieval = await selectRelevantTables(input.prompt, allTables, published, omDesc, bedrockModelClient);
    } catch (e) { retrieval = { selected: [], matches: [], usedFallback: true, note: `检索异常:${String(e && e.message || e).slice(0, 80)}` }; }
    // 回退(检索异常/未命中)用全部表,避免空目录无法作答。
    catTables = retrieval.selected.length ? retrieval.selected : allTables;
    retrievalMatches = retrieval.matches || [];
    steps.push({
      tool: "select_relevant_tables", phase: "prepare", sql: "",
      inputSummary: brief({ question: input.prompt.slice(0, 80), candidates: allTables.length }, 200),
      outputSummary: retrieval.usedFallback ? "检索回退:使用全部表" : `命中 ${retrieval.selected.length} 张表`,
      ok: !retrieval.usedFallback, durationMs: Date.now() - tRetr,
    });
  }

  // 阶段一(b)：查业务口径/术语/规则（lookup_business_context 技能），注入提示供 grounding。
  let businessContext = "";
  try {
    const ctxToolName = findTool("lookup_business_context");
    const ctxRes = await tracedCall(ctxToolName, { projectId: input.projectId || "proj-default", keywords: input.prompt }, "prepare");
    if (ctxRes && Array.isArray(ctxRes.entries) && ctxRes.entries.length) {
      businessContext = ctxRes.entries
        .map((e) => `- [${e.kind}] ${e.title}${e.scope ? `（适用：${e.scope}）` : ""}：${e.definition}`)
        .join("\n");
    }
  } catch { /* best-effort：无口径库不影响问数 */ }

  // 阶段一(c)：预取已注册技能清单，直接注入系统提示(A)——让模型一眼看到有哪些技能可用,
  // 消除"盲盒"(否则模型得先自己想到调 list_registered_skills 才知道有技能,运营大白话往往触发不了)。
  // 只透当前引擎的技能(技能按 engine 区分 redshift / athena_lake)。best-effort。
  let skillsCatalog = [];
  try {
    const listName = findTool("list_registered_skills");
    const skRes = await tracedCall(listName, { projectId: input.projectId || "proj-default" }, "prepare");
    const all = (skRes && Array.isArray(skRes.skills)) ? skRes.skills : [];
    // 只保留与当前引擎匹配的技能(engine 字段;seed 里 athena 版技能名以 _lake 结尾)。
    skillsCatalog = all.filter((s) => {
      if (s && s.engine) return isAthena ? s.engine === "athena" : s.engine === "redshift";
      return isAthena ? /_lake$/.test(s.name || "") : !/_lake$/.test(s.name || "");
    });
  } catch { /* best-effort：无技能或列取失败不影响问数 */ }

  // 阶段二：用 Strands Agent 承载 Converse 循环（替代手写 for；循环/工具调度/重试交给框架）。
  // systemPrompt/catalogText 走 @genbi/core（与 inprocess 共用）；容器特有的技能清单/固化表/
  // 记忆经 core systemPrompt 的 opts 传入(Athena 不注入固化表,与原行为一致)。
  const engine = isAthena ? "athena" : "redshift";
  // 🔴 B-26:目录引用取**该区**的(平台随落点给);原来恒用 env 里主控区的 S3T_REF ⇒ 模型拿到的表名全是主控区的
  // @kf-batch 50-WP31-place-first-class —— 序 4(L6):目录引用从 PlaceWire 的数据湖腿取;数据湖问数而落点没有这条腿 ⇒ 拒(不回落 env 的 S3T_REF)
  const athenaRef = isAthena ? placeWireLeg(placeWire, "athena").catalogRef : S3T_REF;
  const catalog = buildCatalogText(catTables, db, { engine, athenaRef });
  const system = systemPrompt(catalog, db, engine, businessContext, {
    athenaRef: isAthena ? athenaRef : undefined,
    skillsCatalog,
    published: isAthena ? [] : (Array.isArray(input.published) ? input.published : []),
    memory: input.memory,
  });

  // 多轮对话历史 → Strands messages（交替 user/assistant，与手写版同构）。
  const messages = [];
  for (const h of (input.history || []).slice(-6)) {
    if (!h || !h.question) continue;
    messages.push({ role: "user", content: [{ text: String(h.question) }] });
    messages.push({ role: "assistant", content: [{ text: String(h.answer || "（上一轮无文字结论）").slice(0, 4000) }] });
  }

  // last：最后一次成功 SQL 结果（供前端展示；闭包被下方 tool 回调更新）。
  let last = null;

  // 热加载：Gateway 发现的工具 → Strands tool。排除阶段一已预取的 introspect + 非当前引擎的 SQL。
  // 每个工具包一层回调：转发 MCP（注入 projectId B11）+ 记 step（B4）+ 截断 payload（B2）+ 捕获 last（B3）+ 错误回传（B8）。
  const exclude = ["introspect_redshift_schema", "introspect_s3tables_schema", isAthena ? "run_redshift_sql" : "run_athena_sql", "fetch_om_descriptions"];
  const modelTools = (tools || []).filter((t) => t && t.name && !exclude.some((s) => t.name.endsWith(s)));
  const strandsTools = modelTools.map((t) => tool({
    name: t.name.split("___").pop() || t.name, // 用短名（去 Gateway target 前缀）作为模型可见工具名
    description: t.description || t.name,
    inputSchema: (t.inputSchema && typeof t.inputSchema === "object") ? t.inputSchema : { type: "object", properties: {} },
    callback: async (rawInput) => {
      const args = { ...(rawInput && typeof rawInput === "object" ? rawInput : {}), projectId: input.projectId || "proj-default" };
      // 模块45 P45.5b:模型生成的 SQL 在执行前过 cookbook 方言 guard(与 inprocess lib/genbi/agent.ts:189
      // 同构)。仅拦 SQL 执行工具(run_redshift_sql/run_athena_sql);纯 CPU 幂等,只纠方言语法不改语义
      // (主命中反引号→双引号:Redshift/Trino 都拒反引号)。与 skills Lambda 内既有只读 sanitize 并存不替代。
      // 不动 retrieval/循环/结果固化任何既有链路——只在此工具回调内改写 args.sql。
      if ((t.name.endsWith("run_redshift_sql") || t.name.endsWith("run_athena_sql")) && args.sql) {
        args.sql = cookbookGuard(t.name.endsWith("run_athena_sql") ? "athena" : "redshift", String(args.sql)).code;
      }
      const t0 = Date.now();
      let res, err;
      // @kf-batch 50-WP4ter-coverage —— 🔴 必须走唯一漏斗(带落点):这里是**真正执行取数 SQL** 的地方,
      // 漏了落点 = 在主控区跑完并把结果当成那个区的答案(2026-09-10 真环境实测过的形态)。
      try { res = await callTool(t.name, args); } catch (e) { err = e; } // 用完整 Gateway 名调用
      const ok = !err && !(res && res.success === false);
      const sqlIn = args && args.sql ? String(args.sql) : "";
      steps.push({
        tool: t.name.split("___").pop() || t.name, phase: "reason",
        sql: sqlIn || (res && res.sql ? String(res.sql) : ""),
        inputSummary: args && args.sql ? "" : brief(args || {}, 200),
        outputSummary: err ? brief(String(err.message || err), 200) : summarizeOut(res),
        ok, rowCount: res && res.rowCount, error: err ? String(err.message || err) : (res && res.error),
        durationMs: Date.now() - t0,
      });
      if (err) return { success: false, error: String((err.message) || err) }; // 错误回传模型自愈（B8）
      // 执行型工具：返回 columns+rows 即视为数据结果，捕获为展示结果（B3）。
      if (res && Array.isArray(res.columns) && Array.isArray(res.rows) && res.success !== false) {
        last = { sql: sqlIn || res.sql || last?.sql || null, columns: res.columns, rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      }
      // 行数过多截断给模型（B2）。
      return (res && Array.isArray(res.rows) && res.rows.length > MODEL_ROWS)
        ? { ...res, rows: res.rows.slice(0, MODEL_ROWS), shown_rows: MODEL_ROWS }
        : (res || { ok: true });
    },
  }));

  // @kf-batch 51-v2-multi-vendor(D17)—— Agent 用工厂建:瞬态流错误重试时**重建**(上一轮可能留下半截 assistant 消息),历史用浅拷贝不被改。
  const mkAgent = () => new Agent({
    // maxTokens 经厂商档案系数(恒带推理块的 Kimi K3 ×2,其余 ×1;51 SPEC §7.2)
    model: new BedrockModel({ modelId: MODEL_ID, region: REGION, maxTokens: shapeInferenceConfig(MODEL_ID, { maxTokens: MAX_TOKENS }).config.maxTokens }),
    systemPrompt: system,
    tools: strandsTools,
    messages: [...messages],
    printer: false,               // 关闭 Strands 控制台进度输出（容器日志干净，B/遗漏3）
    limits: { turns: MAX_ITERS },  // 迭代上限（对应原 MAX_ITERS=8，超限优雅停止，B10）
  });

  let result;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    try {
      result = await mkAgent().invoke(input.prompt);
      break;
    } catch (e) {
      // 🔴 2026-10-14 …7698 真环境(Kimi K3):第 6 轮模型调用收到「Stream ended without completing a message」,这里原来**静默**吞错
      //   只回「问数执行异常」,现场只剩时间线 ⇒ 现在必留一行结构化日志;瞬态(流断 / 限流 / 5xx)重试一次(有界、全幅抖动),其它错误不重试。
      const d = describeModelError(e);
      console.error(JSON.stringify({ tag: "agent-error", capability: "genbi", modelId: MODEL_ID, attempt, elapsedMs: Date.now() - t0, stepsN: steps.length, ...d }));
      if (e && e.stack) console.error(`[genbi] stack: ${String(e.stack).slice(0, 800)}`);
      if (d.transient && attempt < TRANSIENT_MAX_RETRIES) {
        const waitMs = transientBackoffMs(attempt);
        steps.push({ tool: "model", phase: "retry", sql: "", inputSummary: `瞬态模型错误,${waitMs}ms 后重试(第 ${attempt + 1} 次)`, outputSummary: d.message.slice(0, 200), ok: false, error: d.message.slice(0, 200), durationMs: Date.now() - t0 });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // 兜底：Strands 抛错时仍返回可用 wire（已记的 steps + last）。
      return { answer: `（问数执行异常：${d.message.slice(0, 200)}）`, sql: last?.sql || null, columns: last?.columns || [], rows: last?.rows || [], rowCount: last?.rowCount || 0, steps, usage: { inputTokens: 0, outputTokens: 0 }, _meta };
    }
  }

  const answer = (result.lastMessage?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
  const usage = result.metrics?.accumulatedUsage || {};
  // 达迭代/token 上限的兜底文案（B10）：stopReason 非正常结束且无文字答案时提示。
  const stopped = result.stopReason && !["endTurn", "end_turn", "stop", "stopSequence"].includes(result.stopReason);
  const finalAnswer = answer || (stopped ? "（已达最大推理步数，未能完成。请把问题拆得更具体后重试。）" : "（未能生成结论，请重试。）");
  return {
    answer: finalAnswer,
    sql: last?.sql || null, columns: last?.columns || [], rows: last?.rows || [], rowCount: last?.rowCount || 0,
    steps, usage: { inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0 },
    _meta,
  };
}
