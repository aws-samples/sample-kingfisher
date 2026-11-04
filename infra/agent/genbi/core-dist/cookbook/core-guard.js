"use strict";
// cookbook 方言 guard 的【容器/core 化入口】。
//
// 【为什么单独一个入口】GenBI AgentCore 远程 Runtime 容器要在"模型生成 SQL 后、执行前"过方言 guard
// (消除 inprocess 有、远程无的盲区)。容器经 core-dist 机制 import 编译产物,静态图必须零 @/、零 DynamoDB。
// 原 guard.ts 走 registry(顶层 import store→@/lib/aws/dynamodb),编进产物容器解析失败。
// 本入口直取系统内嵌方言规则 SYSTEM_DIALECT_RULES(seed 常量),【不 import registry/store】,
// 委托与 inprocess 完全相同的纯核 runGuardWithRules → 行为逐字等价,零漂移。
//
// 规则来源等价性:inprocess 的 dialectRulesFor(engine) === SYSTEM_DIALECT_RULES.filter(r=>r.engine===engine)
// (见 registry.ts:26-28,dialectRulesFor 本体就是这个 filter)。故二入口同输入同输出,由单测双跑锁死。
//
// 方言规则只来自 seed(客观事实,系统维护,管理员不可改——见 registry.ts:4-6);容器不需要 store 的
// 管理员动态【配方】(那是 retrieve 的生成前引导,与执行前 guard 校验无关)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.guard = guard;
exports.guardCode = guardCode;
const seed_1 = require("./seed");
const guard_core_1 = require("./guard-core");
// 与 lib/genbi/agent.ts:189 inprocess 的 cookbookGuard 完全同构:给定 engine+SQL → 纠正方言后的结果。
// 容器 agent.js 在 run_redshift_sql/run_athena_sql 执行前调用本函数(取 .code)。
function guard(engine, code) {
    const rules = seed_1.SYSTEM_DIALECT_RULES.filter((r) => r.engine === engine);
    return (0, guard_core_1.runGuardWithRules)(rules, engine, code);
}
// 便捷:仅要纠正后的脚本(容器执行前用 .code)。
function guardCode(engine, code) {
    return guard(engine, code).code;
}
