// 模块 40 — 成本事件 signature 归一(FinOps 自带,不改 43-A signature.ts)。
// 与 43-A 同一约定:signature = engine + "::" + key,key 为白名单常量(天生脱敏,
// 不含任务名/表名/金额等可变 token)。成本事件按【任务+执行环境+引擎+异常类】归并:同一任务在同一个区
// 反复成本突增 → 同一 signature 累加 occurrenceCount,复利沉淀。
//
// 纯函数、可单测。title(症状模板)同样只用白名单短语 + 倍数(数字非敏感)。
//
// @kf-batch 50-WP6-cost-by-region(WP-6 施工序 4,E-174)—— 🔴 签名加 **target 维**(服务级加 region 维)。
// 不加的后果:同一任务在 A、B 两区的成本突增落进**同一个**知识库主档,occurrenceCount 混计,
// 诊断 Agent 学到的「这个任务常常变贵」分不清是哪个区 —— 与基线池化是同一个病的另一半。
// target 维不喂 targetId 原文(出口清单:会被大写化折叠),喂 `targetSignatureCode` 哈希短码。
// ⚠️ 这一改让既有主档的签名换了形状:升级后的新事件进新主档,旧主档保留不动(不迁移、不删除)。

import { targetSignatureCode } from "@/lib/exec-env/target-id";
import type { CostAnomaly } from "./types";

export interface CostSignatureResult {
  signature: string;
  engine: string;
  title: string;
}

function slugOf(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

// taskId 是平台 ULID(非敏感、稳定),用它把"同一任务的成本回归"归并到一个知识库主档;
// service 级异常用服务名 slug(CE 服务名是公开常量)+ region slug(AWS region 是公开常量)。
export function costSignature(a: CostAnomaly, engine: string): CostSignatureResult {
  if (a.scope === "task") {
    return {
      signature: `${engine}::COST_SPIKE_TASK_${a.key}_AT_${targetSignatureCode(a.targetId)}`,
      engine,
      title: `任务单次运行成本突增(相对自身基线偏离 ${a.deviationX.toFixed(1)}×)`,
    };
  }
  return {
    signature: `finops::COST_SPIKE_SERVICE_${slugOf(a.key)}_IN_${slugOf(a.region)}`,
    engine: "finops",
    title: `服务日成本突增(相对近30日基线偏离 ${a.deviationX.toFixed(1)}×)`,
  };
}
