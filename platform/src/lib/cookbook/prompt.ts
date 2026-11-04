// 检索切片 → 提示词文本(所有 codegen 出口共用同一注入格式)。
//
// 定位:retrieve(engine, opts) 拿到 CookbookSlice 后,用本函数渲染成一段可直接拼进 system prompt 的文本。
// 离线 ETL、GenBI、Flink 等所有出口复用同一格式 → 大模型看到的方言/范式呈现一致,一处维护多处生效。
//
// 纯函数(无 IO),便于单测;不含任何引擎特定逻辑(引擎差异已在 seed 配方里表达)。

import type { CookbookSlice } from "./types";

export interface SliceToPromptOpts {
  // 是否包含配方模板正文(codegen 需要照抄范式→true;仅想给"约束提醒"可 false 省 token)。
  includeTemplates?: boolean;
  // 标题前缀(默认"引擎工程知识");不同出口可定制展示名。
  heading?: string;
}

// 把方言规则 + topK 配方渲染成提示词块。空切片(无规则无配方)返回空串(不占 token)。
export function sliceToPromptText(slice: CookbookSlice, opts: SliceToPromptOpts = {}): string {
  const includeTemplates = opts.includeTemplates ?? true;
  const heading = opts.heading ?? "引擎工程知识";
  const rules = slice.dialectRules || [];
  const recipes = slice.recipes || [];
  if (!rules.length && !recipes.length) return "";

  const lines: string[] = [];
  lines.push(`## ${heading}(${slice.engine} —— 平台验证过的方言规则与范式,生成代码务必遵守)`);

  // 方言硬规则(error 在前,retrieve 已排序):这是"必须遵守/严禁",违反会跑错。
  if (rules.length) {
    lines.push("");
    lines.push("### 方言硬规则(违反会导致作业执行报错)");
    for (const r of rules) {
      const tag = r.severity === "error" ? "【必须】" : "【建议】";
      lines.push(`- ${tag}${r.title}:${r.rule}`);
    }
  }

  // 验证过的范式(topK):给 AI 照抄的正确写法。
  if (recipes.length) {
    lines.push("");
    lines.push("### 验证过的代码范式(优先照此结构改写,勿凭空造方言)");
    for (const rc of recipes) {
      lines.push("");
      lines.push(`#### ${rc.title}`);
      if (rc.whenToUse) lines.push(`适用:${rc.whenToUse}`);
      if (rc.dialectNotes?.length) {
        for (const note of rc.dialectNotes) lines.push(`- 注意:${note}`);
      }
      if (includeTemplates && rc.template) {
        lines.push("```");
        lines.push(rc.template);
        lines.push("```");
      }
    }
    if (slice.totalMatched > recipes.length) {
      lines.push("");
      lines.push(`(另有 ${slice.totalMatched - recipes.length} 条相关范式未展开;如需更多写法可细化诉求。)`);
    }
  }

  return lines.join("\n");
}
