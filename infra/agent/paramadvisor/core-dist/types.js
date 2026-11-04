"use strict";
// @paramadvisor/core — 参数目录/提示词渲染所需的核心类型单一来源。
//
// 【core 契约】(照 @genbi/core)core 内部所有文件引用类型都走 "./types"(相对路径,不用 @/ alias),
// 保证 core 能独立编译成 CJS 给容器 agent import 时无 alias 解析问题。
//
// 只放 core(catalog/prompt 渲染)真正需要的两个类型:ParamChannel + ParamDef。
// 其余顾问契约(WorkloadProfile/ParamAdviceRequest/HistoryFacts/ParamAdvice…)仍留
// param-advisor/types.ts(不牵连进 core);后者反向 re-export 本文件这两个类型,对外 API 不变。
Object.defineProperty(exports, "__esModule", { value: true });
