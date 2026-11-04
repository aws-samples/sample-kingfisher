// L2 规则目录 — 单一事实源(Single Source of Truth)。
//
// 反幻觉核心设计:本文件既被 connectivity-judge.ts(确定性引擎)执行,又被 prompt.ts 渲染进
// 大模型 system prompt。于是"大模型知道的网络规则" === "引擎执行的规则",模型无法编造规则。
//
// 【模块47 L3】规则目录已下沉 @netadvisor/core(./core/rules)——core 独立编译成 CJS 给容器
// agent import core-dist(消 RULES_TEXT 手抄;此前容器手抄本文件规则文本,已真实漂移)。本文件
// 反向 re-export core,进程内消费方(connectivity-judge/remediation/prompt)路径与用法逐字不变。
// 单一定义在 core → 模型看到的规则文本 === 引擎执行的规则(反幻觉),且无手抄漂移风险。

export type { RuleDef } from "./core/types";
export {
  RULES,
  RULE_BY_ID,
  renderRulesForPrompt,
  ruleApplies,
  TROUBLESHOOTING_ORDER,
} from "./core/rules";
