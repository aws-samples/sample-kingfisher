// → 45 迁移兼容层。方言校验已提升为平台级 lib/cookbook/guard(词法安全 + fixpoint + 违规阻断)。
// 保留旧 guardScript(engine, script) 签名:step-handlers 继续调用,行为等价(纠正后脚本一致)。
// 新代码请直接用 @/lib/cookbook 的 guard(engine, code)(拿完整 {code,fixed,violations,blocked} 报告)。

import { guard } from "@/lib/cookbook/guard";
import type { CookbookEngine } from "@/lib/cookbook/types";

export interface DialectGuardResult {
  script: string; // 纠正后的脚本(无违规则原样返回)
  fixed: { ruleId: string; title: string }[];
  violations: { ruleId: string; title: string; rule: string }[];
}

// 旧签名:返回 { script, fixed, violations }。委托平台级 guard,字段名映射(code→script)。
export function guardScript(engine: CookbookEngine, script: string): DialectGuardResult {
  const g = guard(engine, script);
  return {
    script: g.code,
    fixed: g.fixed,
    violations: g.violations.map((v) => ({ ruleId: v.ruleId, title: v.title, rule: v.rule })),
  };
}
