"use strict";
// @netadvisor/core — 规则目录/提示词渲染所需的核心类型单一来源。
//
// 【core 契约】(照 @genbi/core、@paramadvisor/core)core 内部所有文件引用类型都走 "./types"
// (相对路径,不用 @/ alias),保证 core 能独立编译成 CJS 给容器 agent import 时无 alias 解析问题。
//
// 只放 core(rules 目录/renderRulesForPrompt 渲染)真正需要的 4 个类型
//   RuleDef(规则定义) + ComputeKind/RemediationType/RuleStatus/Target(RuleDef 字段引用)。
// 其余顾问契约(ConnectivityRequest/Recommendation/EnvironmentFacts/Prefill/Ruling…)仍留
// network-advisor/types.ts(不牵连进 core);后者反向 re-export 本文件这些类型,对外 API 逐字不变。
//
// ⚠️ 下列类型定义必须与 network-advisor/types.ts 的原始定义逐字一致(RemediationType/Target 是大
// 联合类型)。原 types.ts 反向 re-export 本文件 → 全平台单一定义,杜绝"两个 Target"漂移。
Object.defineProperty(exports, "__esModule", { value: true });
