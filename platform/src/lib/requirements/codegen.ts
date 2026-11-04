// 模块 22 — 需求实现代码生成（研发侧 AI 辅助, v1.14.0）
//
// 复用 Bedrock Converse(与 GenBI 同 region;模型 @kf-batch 50-W5-seg2-WP8 起改为调用时经模块 51 解析链求值,
// 能力 key codegen,不再读模块加载期 GENBI.modelId)。给定需求与目标类型,
// 生成**生产级**的 ETL 实现代码：
//   - redshift：幂等 SQL（CREATE TABLE IF NOT EXISTS + 可重入写入），支持业务日期参数 ${ds}（模块16）。
//   - glue：PySpark 作业骨架（读源→变换→写 Redshift/S3），带配置占位与注释。
// 生成结果**绝不自动执行**；研发审阅后才在工作台一键建 ETL 作业（资源收口研发侧）。

// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GENBI } from "@/lib/genbi/config";
import { introspectSchema, buildCatalogText } from "@/lib/genbi/schema";
import { introspectS3Tables, S3TABLES_NAMESPACE } from "@/lib/genbi/athena";
import { retrieve, guard, sliceToPromptText } from "@/lib/cookbook";
import { GLUE_WAREHOUSE_HOWTO } from "@/lib/cookbook/seed/warehouse-facts";
// 序 53:提示词里的 Glue 运行环境(版本 / Spark / Python / 迁移点)来自单一作者,不再手写「Glue 5.1」
import { GLUE_VERSION_DEFAULT, GLUE_RUNTIME_FACTS, GLUE_VERSIONS, glueRuntimeSummary } from "@/lib/sync/glue-version";
import type { Requirement } from "./service";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:调用时求值 + 退避/降级;结果带实际用的模型供路由 `_meta` 回显。
import { invokeConverse } from "@/lib/ai/invoke";
import type { AiModelUse } from "@/lib/ai/meta";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: GENBI.region });

/** @kf-batch 50-B27-codegen-place —— 这次生成**按哪个区的目录**做的 grounding(回显给页面,不许让用户猜)。 */
export interface CodegenGrounding { targetId: string; region: string; workgroup: string; database: string }

export interface CodegenResult {
  targetType: "redshift" | "glue";
  /** @kf-batch 50-B27-codegen-place */
  groundedOn: CodegenGrounding;
  code: string;
  explanation: string;
  usage: { inputTokens: number; outputTokens: number };
  // @kf-batch 50-W5-seg2-WP8 — 模块 51 `_meta` 回显:实际用的模型(降级则为回落层)。
  model: AiModelUse;
  // 模块45:cookbook 方言校验报告(生成后已自动纠正/待提示的违规),供前端回显"AI 写了 X 已修正/违反 Y"。
  dialect?: { fixed: { ruleId: string; title: string }[]; violations: { ruleId: string; title: string; rule: string; severity: string }[] };
}

function systemPrompt(targetType: "redshift" | "glue", catalog: string, g: CodegenGrounding, s3tablesCatalog?: string): string {
  const database = g.database;
  const common = `你是一名资深大数据研发工程师，为一个面向全球用户的数据平台编写**生产级** ETL 实现。
当前数据仓库：Amazon Redshift（PostgreSQL 方言），数据库 ${database}。可用表结构目录：
${catalog}

通用要求（务必遵守）：
- 只读取来源表，绝不修改/删除源数据。
- **幂等可重入**：重复运行结果一致（按目标引擎的正确方言实现幂等——见下方「引擎工程知识」的方言硬规则与范式；写入前清理当批数据或用引擎支持的 UPSERT/MERGE。切勿套用其它数据库的语法）。
- **参数化业务日期**：凡涉及按日增量，用占位符 \${ds}（运行时由平台替换为业务日期 YYYY-MM-DD）。
- 规范命名（目标表加业务前缀，避免与现有表冲突）、充分中文注释、可读。
- **不要编造目录中不存在的表/列**（表名、命名空间、列名必须与下方目录完全一致）。
- 输出格式：先给一个 \`\`\` 代码块（仅实现代码，不要多个代码块），代码块后用 2-4 句中文说明实现要点与如何运行。`;

  if (targetType === "redshift") {
    return `${common}

本次目标类型：**Redshift SQL 作业**。只输出 SQL（可多条语句，分号分隔）。`;
  }

  // Glue：必须贴合平台真实运行环境，否则脚本跑不起来（这是之前生成代码失败的根因）。
  return `${common}

本次目标类型：**Glue PySpark 作业**。该作业缺省在 **${glueRuntimeSummary()}** 运行${GLUE_RUNTIME_FACTS[GLUE_VERSION_DEFAULT].migrationNotes ? `（${GLUE_RUNTIME_FACTS[GLUE_VERSION_DEFAULT].migrationNotes}）` : ""}；作业若在表单里选了更低的 Glue 版本（可选 ${GLUE_VERSIONS.join(" / ")}），按该版本的 Spark API 写。平台已为它配置好环境，**严格遵守以下事实，不要臆测连接/目录**：

## 运行环境（已由平台配置好，直接用）
1. **数据湖 S3 Tables（Iceberg）已注册为 Spark 目录 \`s3tablescatalog\`**。用 \`spark.table("s3tablescatalog.<命名空间>.<表>")\` 读取。**写入结果表必须幂等可重跑**——用 DataFrame V2 API \`df.writeTo("s3tablescatalog.<ns>.<表>").using("iceberg").createOrReplace()\`（原子替换，可无限重跑）。⚠️ **严禁 \`DROP TABLE\` + \`.create()\`**：S3 Tables 托管 Iceberg 拒绝 \`purge=false\` 的 DROP（报 "must be purged when dropped"），且 \`.create()\` 遇已存在表报错 → 第二次运行必失败。建新命名空间前先 \`spark.sql("CREATE NAMESPACE IF NOT EXISTS s3tablescatalog.<ns>")\`（S3TablesCatalog 不自动建）。行级更新用 \`MERGE INTO\` / \`INSERT INTO\`（format-version=2）。**命名空间与表名必须与下方 S3 Tables 目录完全一致**（例如命名空间是 \`${S3TABLES_NAMESPACE}\`，订单表是 \`orders\` 而非 \`order\`）。
2. 业务日期：用 \`args = getResolvedOptions(sys.argv, ["JOB_NAME", "ds"])\` 读取 \`args["ds"]\`（平台运行时注入 \`--ds\`）。
3. 写 Redshift 数仓：**用 boto3 \`redshift-data\` Data API**（作业角色已有权限），${GLUE_WAREHOUSE_HOWTO}(本作业这次按 ${g.region} 生成:该区数仓工作组 \`${g.workgroup}\` / 库 \`${g.database}\` 只作理解用,**代码里照样读注入参数**)；**不要用 JDBC/连接串**（未配置 JDBC 连接，会失败）。🔴 **建完表不要再写授权语句，尤其【严禁把 PUBLIC 当授权对象】**（那会让库内所有身份读写这张表，击穿项目隔离；平台的方言规则 \`glue.no-grant-to-public\` 命中即拦，作业跑不起来）：平台各读写路径统一用同一个数仓身份执行，建完表**不需要任何 GRANT** 就能在查询页/智能问数里看到。
4. 标准骨架：\`SparkContext()\` → \`GlueContext(sc)\` → \`spark_session\` → \`Job(glueContext).init(...)\`，结尾 \`job.commit()\`。
5. 用 \`print(...)\` / \`df.show()\` 输出关键信息到日志（平台可在「日志」查看）。

## S3 Tables 数据湖目录（Spark 可直接读写）
${s3tablesCatalog || "（未能读取 S3 Tables 目录，请仅基于上方 Redshift 目录并谨慎处理）"}

输出一个完整、可直接运行的 PySpark 脚本。`;
}

function userPrompt(r: Requirement): string {
  const src = r.source;
  return [
    `# 需求标题\n${r.title}`,
    `# 需求描述\n${r.description || "（无）"}`,
    r.businessValue ? `# 业务价值\n${r.businessValue}` : "",
    r.acceptanceCriteria ? `# 验收标准\n${r.acceptanceCriteria}` : "",
    src?.question ? `# 来源问题（业务方在智能问数中的提问）\n${src.question}` : "",
    src?.sql ? `# 来源参考 SQL（智能问数生成，仅供参考，请据需求改写为生产实现）\n${src.sql}` : "",
    `请据此生成上述目标类型的生产级实现。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// 从模型输出中分离代码块与说明。
function splitCodeAndExplanation(text: string): { code: string; explanation: string } {
  const fence = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (fence) {
    const code = fence[1].trim();
    const explanation = text.replace(fence[0], "").trim();
    return { code, explanation };
  }
  // 没有围栏时，整体当代码、说明留空。
  return { code: text.trim(), explanation: "" };
}

export async function generateImplementation(
  r: Requirement,
  targetType: "redshift" | "glue",
  businessContext: string | undefined,
  // @kf-batch 50-B27-codegen-place —— 按哪个区的目录生成(@kf-batch 50-WP31-place-first-class:必填,主控区也点名)
  targetId: string,
  // @kf-batch 50-WP31-place-first-class —— 🔴 项目必填:非主控区的数仓凭证按项目发(§3.9b),缺了 ⇒ 落点解析当场拒
  //   ⇒ 非主控区的 AI 生成**一律 500**(2026-10-03 段 wp31 W31-R1 无头坐实;单测 mock 掉了落点解析,接缝被抹平)
  projectId: string
): Promise<CodegenResult> {
  return generateCore(targetType, userPrompt(r), businessContext, targetId, projectId);
}

// 作业开发（模块12）AI 辅助：自由意图（+ 可选现有代码）→ 生产级实现，复用与需求侧同一套
// system 提示与目录 grounding。不绑定 Requirement，供「作业开发」页直接调用。
export async function generateEtlCode(
  input: { intent: string; currentCode?: string },
  targetType: "redshift" | "glue",
  businessContext: string | undefined,
  // @kf-batch 50-B27-codegen-place —— 作业绑定的区(多区作业取第一个,页面回显「按哪个区生成」)
  targetId: string,
  // @kf-batch 50-WP31-place-first-class —— 🔴 项目必填:非主控区的数仓凭证按项目发(§3.9b),缺了 ⇒ 落点解析当场拒
  //   ⇒ 非主控区的 AI 生成**一律 500**(2026-10-03 段 wp31 W31-R1 无头坐实;单测 mock 掉了落点解析,接缝被抹平)
  projectId: string
): Promise<CodegenResult> {
  const parts = [
    `# 开发意图（请据此生成 ${targetType === "glue" ? "Glue PySpark" : "Redshift SQL"} 作业实现）\n${input.intent}`,
  ];
  if (input.currentCode && input.currentCode.trim()) {
    parts.push(
      `# 现有代码（在此基础上修改/补全，保持风格一致；若意图与现有代码冲突以意图为准）\n\`\`\`\n${input.currentCode.trim().slice(0, 6000)}\n\`\`\``
    );
  }
  parts.push("请输出生产级实现。");
  return generateCore(targetType, parts.join("\n\n"), businessContext, targetId, projectId);
}

// 共享核心：目录 grounding + Bedrock Converse + 拆分代码/说明。
// 🔴🔴 B-27(2026-10-01):原来仓目录 `introspectSchema(GENBI.workgroup, GENBI.database)` + 湖目录 + 提示词里的
//   `workgroup=bgp-workgroup、database=dev` **全是主控区** ⇒ 给 us-west-2 的作业生成代码,模型看到的是主控区的表、
//   写进代码的是主控区的工作组实名(在那个区根本不存在)。⇒ 三样都按**作业绑定的区**解析(唯一作者:直查落点
//   `resolveDirectQueryPlace` / 湖 `introspectS3Tables` 的必填落点),并把「按哪个区生成」回显给页面。
async function generateCore(targetType: "redshift" | "glue", userText: string, businessContext: string | undefined, targetId: string, projectId: string): Promise<CodegenResult> {
  const { resolveDirectQueryPlace } = await import("@/lib/redshift/direct-query");
  const place = await resolveDirectQueryPlace({ targetId, projectId });
  const groundedOn: CodegenGrounding = { targetId: place.targetId, region: place.region, workgroup: place.workgroup, database: place.database };
  const tables = place.home
    ? await introspectSchema(GENBI.workgroup, GENBI.database, { targetId: place.targetId, project: projectId })
    : await introspectSchema("", "", { targetId: place.targetId, project: projectId });
  // Glue 作业用 Spark 直读/写 S3 Tables（数据湖），额外注入真实的 S3 Tables 目录（命名空间/表/列），
  // 让模型用正确的 spark.table("s3tablescatalog.<ns>.<表>") 名称，而非臆测。
  let s3tablesCatalog: string | undefined;
  if (targetType === "glue") {
    s3tablesCatalog = await buildS3TablesCatalogText(place.targetId).catch(() => undefined);
  }
  let systemText = systemPrompt(targetType, buildCatalogText(tables, groundedOn.database), groundedOn, s3tablesCatalog);
  // 模块45(生成前引导):注入平台 cookbook 该引擎的【方言硬规则 + 验证过的范式】,让模型照正确方言写。
  // 成本诚实说明:seed 配方是代码常量(零 IO);admin 配方首次调用打一次 DynamoDB Query(之后 60s 走进程内缓存)。
  // 单次 Query ~数十 ms,相对 Bedrock 生成(10-30s)可忽略,不构成 60s 墙威胁;keywords 用用户意图做相关性打分。
  try {
    const slice = await retrieve(targetType, { keywords: userText, topK: 3 });
    const cookbookText = sliceToPromptText(slice);
    if (cookbookText) systemText += `\n\n${cookbookText}`;
    // 根治(R1):Spark(glue/emr)作业写 S3 Tables 数据湖,但 glue 引擎【无 S3Tables 写回配方】
    // (统一指向 s3tables 引擎)。故对 Spark 目标【额外注入 s3tables 切片】,让"createOrReplace 幂等
    // 写回"范式真正进提示词——否则模型只能凭 glue 切片臆测,写出 DROP+create 致重跑失败(B2/B3 根因)。
    // EMR 作业 AI 生成复用本函数的 "glue" 目标(engines/generate/route.ts),故此注入同时覆盖 EMR。
    if (targetType === "glue") {
      const s3tSlice = await retrieve("s3tables", { keywords: userText, topK: 2 });
      const s3tText = sliceToPromptText(s3tSlice);
      if (s3tText) systemText += `\n\n## S3 Tables(Iceberg)写回范式(数据湖结果表必读)\n${s3tText}`;
    }
  } catch { /* cookbook 不可用时静默降级:提示词仍含既有指导,不阻断生成 */ }
  if (businessContext && businessContext.trim()) {
    systemText += `\n\n## 业务口径与规则（必须遵循）\n生成代码须严格遵循以下业务口径/术语叫法/规则与注意事项（如金额单位、特定叫法、需排除的状态、测试数据标记等），与之冲突时以此为准：\n${businessContext}`;
  }
  const system = [{ text: systemText }];
  // @kf-batch 50-W5-seg2-WP8:modelId 每次调用求值(codegen),经 invokeConverse 退避/降级。
  const inv = await invokeConverse("codegen", undefined, bedrock, (modelId) =>
    new ConverseCommand({
      modelId,
      system,
      messages: [{ role: "user", content: [{ text: userText }] }],
      inferenceConfig: { maxTokens: 3000, temperature: 0 },
    })
  );
  const resp = inv.response;
  const out = (resp.output?.message?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
  const { code, explanation } = splitCodeAndExplanation(out);
  // 模块45(生成后校验,安全网):用同源方言规则校验/纠正模型偶发违规(如 Redshift CTAS 误写 IF NOT EXISTS)。
  // redshift→SQL 可机械纠正;glue→PySpark 无 antiPattern 规则,guard 天然 no-op(§4.3),code 原样返回。guard 纯 CPU 无网络。
  const g = guard(targetType, code);
  return {
    targetType,
    groundedOn,
    code: g.code,
    explanation,
    usage: { inputTokens: resp.usage?.inputTokens || 0, outputTokens: resp.usage?.outputTokens || 0 },
    dialect: { fixed: g.fixed, violations: g.violations },
    model: { modelId: inv.usedModelId, modelSource: inv.usedSource, ...(inv.degraded ? { degraded: true } : {}) },
  };
}

// 读取真实 S3 Tables（数据湖）目录，渲染为可注入提示的文本（命名空间 + 表 + 列）。
async function buildS3TablesCatalogText(targetId: string): Promise<string> {
  const tables = await introspectS3Tables(S3TABLES_NAMESPACE, { targetId });
  if (!tables.length) return "（S3 Tables 命名空间暂无表）";
  const lines = [`命名空间: ${S3TABLES_NAMESPACE}（用 spark.table("s3tablescatalog.${S3TABLES_NAMESPACE}.<表>") 读取）`, ""];
  for (const t of tables) {
    lines.push(`### s3tablescatalog.${t.schema}.${t.table}`);
    for (const c of t.columns) lines.push(`  - ${c.name} ${c.type}`);
    lines.push("");
  }
  return lines.join("\n");
}
