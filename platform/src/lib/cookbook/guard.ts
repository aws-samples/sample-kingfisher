// 模块 45 — 方言校验层(生成后安全网)。消费【与 retrieve 同源的 DialectRule】,
// 在落库/执行前检测并机械纠正 LLM 偶发的方言违规(即便提示词+配方已引导,LLM 仍可能偶发违反)。
//
// 【P45.5b 重构(2026-07-24)】纯逻辑(mask→匹配→区间 fix→fixpoint)已抽到 guard-core.ts 的
// runGuardWithRules(rules,engine,code),inprocess 与 AgentCore 容器共用同一纯核(零手抄漂移)。
// 本文件只做"取规则(经 registry,即系统内嵌 seed)+ 委托纯核",对外 API(guard/guardCode/detectableRuleCount)
// 逐字不变——4 个消费者(GenBI inprocess/Copilot/离线ETL/实时Flink)零改动。
// 容器侧的等价入口见 core-guard.ts(规则直取 seed,不经 registry,避静态 import 边拖 DynamoDB/@/)。
//
// 词法安全/幂等/违规处置三处硬要求(见 docs/design/45 §4.2)的实现在 guard-core.ts:
//  🔴A 词法安全  🟠D 幂等/不动点  🟡G 违规处置(error 无 fix → blocked,admin 可覆盖)
//  §4.3 target="code"(命令式 PySpark)绝不正则改写,只报违规/提示。
// 设计:遍历某引擎所有 DialectRule 逐条判定——加方言规则 = seed/<engine>.ts 加一条,guard 自动生效。

import type { CookbookEngine, DialectRule, GuardResult } from "./types";
import { dialectRulesFor } from "./registry";
import { runGuardWithRules } from "./guard-core";

// 校验并纠正某引擎脚本的方言问题(规则来源=系统内嵌 seed,经 registry.dialectRulesFor)。
export function guard(engine: CookbookEngine, code: string): GuardResult {
  return runGuardWithRules(dialectRulesFor(engine), engine, code);
}

// 便捷:仅要纠正后的脚本(忽略报告)。迁移期兼容旧 guardScript 调用语义。
export function guardCode(engine: CookbookEngine, code: string): string {
  return guard(engine, code).code;
}

// 供测试/调试:某引擎当前生效的可检测规则数。
export function detectableRuleCount(engine: CookbookEngine): number {
  return dialectRulesFor(engine).filter((r: DialectRule) => !!r.antiPattern).length;
}
