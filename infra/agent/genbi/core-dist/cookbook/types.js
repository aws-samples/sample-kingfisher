"use strict";
// 平台级工程知识库(Engine Cookbook)类型定义(单一事实源)。
//
// 定位:把平台【验证过的引擎工程知识】(Redshift 方言、S3 Table 写入核心代码、Glue/EMR/Flink 模式…)
// 沉淀成结构化"配方(Recipe)"+"方言规则(DialectRule)",供所有 AI codegen 出口复用:
//   · 生成前 retrieve(engine, opts) → 喂相关配方给大模型,照验证过的范式写(从源头写对);
//   · 生成后 guard(engine, code)   → 用同一份方言规则校验/纠正 LLM 偶发违规(安全网)。
//
// 谱系:从lib/copilot/recipes/* 提升 + 泛化而来。Copilot 降级为消费者之一(见 docs/design/45)。
// 抽象原则(全球级 + 可插拔):加一个引擎能力 = seed/ 目录加一个文件 + 注册一行,不改 retrieve/guard 核心。
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultTargetForEngine = defaultTargetForEngine;
exports.targetOfRule = targetOfRule;
// 引擎默认产物形态:sql 引擎的 DialectRule 默认 target="sql",code 引擎默认 "code"。
const CODE_ENGINES = new Set(["glue", "emr"]);
function defaultTargetForEngine(engine) {
    return CODE_ENGINES.has(engine) ? "code" : "sql";
}
// 某规则的有效 target(显式优先,否则按引擎默认)。
function targetOfRule(rule) {
    return rule.target ?? defaultTargetForEngine(rule.engine);
}
