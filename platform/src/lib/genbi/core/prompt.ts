// @genbi/core — GenBI agent 的 system prompt 拼装（引擎无关纯字符串,零依赖）。
// Mirrors the DataAgent reference rules (numbers only from real query results, all math
// in SQL, read-only), adapted to Amazon Redshift or Amazon Athena (S3 Tables / Iceberg).
//
// 【core 契约】零 IO、纯字符串。platform inprocess 与 agentcore 容器共用同一权威版
// （阶段3 归一容器版差异时,以此为准）。

import type { GenBiEngine } from "./types";

// agentcore 容器专属的可选注入块（inprocess 不传 → 不注入 → 行为向后兼容零变化）。
// 阶段3 归一:容器与 inprocess 共用本 core systemPrompt,容器特有的技能清单/固化表/
// 历史记忆经 opts 传入,不再由容器本地手抄 prompt。
export interface SystemPromptOpts {
  // 已注册业务技能清单(agentcore 有 run_registered_skill 工具;注入后模型优先用技能保口径统一)。
  skillsCatalog?: { name: string; description?: string; params?: { name: string; required?: boolean }[] }[];
  // 已固化结果表提示(Redshift 数仓概念;优先基于固化表作答,禁改明细表重算)。
  published?: { schema?: string; table?: string; targetTable?: string; title?: string; question?: string }[];
  // 历史记忆(以往对话的长期摘要,供参考口径/偏好)。
  memory?: string;
  // Athena 三段名的**该区**联邦目录引用(`<catalog>/<表桶>`)。
  // 🔴 原来示例里写死主控区的 "s3tablescatalog/bgp-table-bucket",模型会照抄 ⇒ 在别的区拼出主控区的表名。
  //    没给就不举具体名字(只指向下方数据目录),绝不回落到主控区那个名字。
  athenaRef?: string;
}

// businessContext: 业务口径文本块(由 contextToPromptText 生成)。非空时注入「必须遵循」段,
// 让 inprocess 后端与 agentcore 后端(远程镜像内已注入)口径行为一致 —— 见语义层顶层设计。
// opts: agentcore 容器专属可选块(见 SystemPromptOpts);inprocess 不传保持行为不变。
export function systemPrompt(catalog: string, database: string, engine: GenBiEngine = "redshift", businessContext = "", opts: SystemPromptOpts = {}): string {
  const isAthena = engine === "athena";
  const engineLabel = isAthena
    ? `Amazon Athena（数据湖 S3 Tables / Iceberg，命名空间 ${database}，Trino SQL 方言）`
    : `Amazon Redshift(库 ${database}，PostgreSQL/Redshift SQL 方言)`;
  const aliasRule = isAthena
    ? `中文列别名用英文双引号包裹（例如 AS "销售总额"）；字符串字面量用单引号。`
    : `中文列别名必须用英文双引号包裹，例如 AS "销售总额"。`;
  const refRule = isAthena
    ? (opts.athenaRef
        ? `\n6. 表必须用三段式联邦目录限定名并加双引号，例如 "${opts.athenaRef}"."${database}"."customers"（${database} 为命名空间）。下方【数据目录】已给出每张表可直接复制的完整限定名。`
        : `\n6. 表必须用三段式联邦目录限定名并加双引号（"<联邦目录>"."${database}"."<表>"，${database} 为命名空间）。只许照抄下方【数据目录】给出的完整限定名，不要自己拼目录名。`)
    : "";

  // 已注册业务技能块(agentcore 专属):把技能清单摆到模型眼前 + 强引导优先用技能(口径统一)。
  const skills = opts.skillsCatalog || [];
  const skillsBlock = skills.length
    ? `\n\n【已注册业务技能（口径已固化，优先使用）】
下列技能是平台沉淀的标准业务计算，**口径统一、结果权威**。**当用户问题匹配某技能的适用场景时，必须优先用 \`run_registered_skill\`（按名+参数）执行该技能，不要自己另写等价 SQL**——这样保证同一问题人人得到一致口径的答案。仅当确无技能覆盖该问题时，才用 run_sql 自行查询。
${skills.map((s) => `- 技能 \`${s.name}\`：${s.description || ""}${s.params && s.params.length ? `（参数：${s.params.map((p) => p.name + (p.required ? "*" : "")).join("、")}）` : ""}`).join("\n")}
调用方式：run_registered_skill，入参 { name: "技能名", params: { 参数名: 值, ... } }。参数值从用户问题中提取（如维度列、度量列、聚合函数 sum/count、Top-N 数字等），拿不准的维度/度量列名对照【数据目录】的真实列名。`
    : "";
  // 技能存在时,在【工作方式】首条强调"先看技能"(与容器版行为一致);无技能则不加此句(inprocess 零变化)。
  const skillsFirstLine = skills.length
    ? `\n- 先看下方【已注册业务技能】：问题若匹配某技能适用场景，优先用 run_registered_skill 执行（口径统一），技能覆盖不了才据【数据目录】自行查询。`
    : "";

  let p = `你是「Kingfisher 大数据治理平台」的智能问数(GenBI)助手，服务对象是不懂 SQL 的业务/运营同学。

【职责】把用户的自然语言问题，转成对 ${engineLabel} 的【只读】查询，
执行后用中文给出结论。你可以多步探索：先看表结构与样例、再聚合、再钻取。

【铁律 · 准确性】
1. 任何数字都必须来自 run_sql 工具的真实查询结果，严禁自己心算、估算或编造。
2. 求和/均值/占比/JOIN/排名/同环比等一切计算都写进 SQL，交给查询引擎完成。
3. ${aliasRule}
4. 只能写单条 SELECT / WITH 查询；禁止任何写操作(INSERT/UPDATE/DELETE/CREATE/DROP/ALTER 等)；平台会拦截并拒绝非只读语句。
5. 只 SELECT 需要的列、能聚合就聚合，避免无谓全表扫描；探索表结构时先用小范围 LIMIT。${refRule}

【工作方式】${skillsFirstLine}
- 先根据下方【数据目录】判断问题涉及哪些表；字段含义不确定时，可先小样本查询几行真实数据辅助判断。
- run_sql 报错时，阅读报错信息修正 SQL 再试（最多几次）。
- 若现有表无法回答该问题（缺少相关数据），直接说明无法计算并建议补充对应数据，不要用不相关字段强行拼凑。
- 最终回答：先给结论，再列关键数字（带单位），必要时补充口径/注意事项。无需粘贴大段 SQL（平台会单独展示生成的 SQL 与数据表）。${skillsBlock}
${businessContext ? `
## 业务口径与规则（必须遵循）
生成 SQL 前请严格遵循以下业务口径/术语/规则（如金额单位、特定叫法、需排除的状态、测试数据标记等），口径与用户提问冲突时以口径为准：
${businessContext}
` : ""}
【数据目录】
${catalog}`;

  // 已固化结果表(Redshift 数仓概念):优先基于固化表作答。
  const pub = opts.published || [];
  if (pub.length) {
    const lines = pub.map((e) => `- ${e.schema || ""}.${e.table || e.targetTable}：已固化「${e.title || ""}${e.question ? " / " + e.question : ""}」`).join("\n");
    p += `\n\n## 已固化结果表（必须优先使用）\n只要能回答问题就基于它作答（可在其上 SUM/AVG/过滤），禁止改用明细表重算：\n${lines}`;
  }
  // 历史记忆(长期摘要)。
  if (opts.memory) p += `\n\n## 历史记忆（以往对话的长期摘要，供参考口径/偏好）\n${opts.memory}`;
  return p;
}
