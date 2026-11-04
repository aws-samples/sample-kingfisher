// 方言校验【纯核】(inprocess + AgentCore 容器共用的唯一逻辑源)。
//
// 【为什么抽这一层】guard.ts 原本 `import { dialectRulesFor } from "./registry"`,而 registry 顶层
// `import store`→`@/lib/aws/dynamodb`。tsc 无 tree-shaking,这条静态边会把 DynamoDB SDK/@/ alias
// 编进 core-dist 产物 → GenBI AgentCore 容器内解析失败(容器无 @/、无该 SDK 布线)。
// 故把 guard 的【纯逻辑】(mask→匹配→区间 fix→fixpoint,零 IO 纯 CPU)抽到本文件,规则集【由参数传入】:
//   · inprocess 的 guard.ts 传 dialectRulesFor(engine)(经 registry,行为逐字不变);
//   · 容器的 core-guard.ts 传 SYSTEM_DIALECT_RULES.filter(byEngine)(直取 seed,不碰 registry/store)。
// 二者共用本纯核 → 零手抄漂移([[module45-cookbook-platform-knowledge]] 一贯原则)。
//
// 纯核不 import registry/store/retrieve —— 只依赖 types(纯) + mask(纯)。core 化时 tsconfig 只需
// include {guard-core, mask, types, seed/**},静态图零 @/ 零 DynamoDB。
//
// 词法安全/幂等/违规处置三处硬要求(见 docs/design/45 §4.2)逻辑与原 guard.ts 逐字一致:
//  🔴A 词法安全:antiPattern 在 masked(遮蔽注释/单引号串)上判定+定位,fix 应用到原文同区间。
//  🟠D 幂等:多规则迭代到 fixpoint(每条规则应用前对当前文本重新 mask+重算区间,偏移对齐当前文本)。
//  🟡G 违规处置:返回 {code,fixed[],violations[],blocked};error 级命中(无 fix 或 target=code)→ blocked。

import type { CookbookEngine, DialectRule, GuardResult } from "./types";
import { targetOfRule } from "./types";
import { maskSqlLiterals } from "./mask";

const MAX_FIXPOINT_ROUNDS = 6; // 防死循环上限(正常 1-2 轮到不动点;规则耦合异常时兜底)

// 在 masked 文本上找 rule.antiPattern 的所有命中区间 [start,end)(全局扫描,重置 lastIndex)。
function matchRanges(pattern: RegExp, masked: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // 复制正则(带 g 标志),避免污染规则对象上的共享 lastIndex 状态。
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // 零宽匹配保护
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

// 对 code(原始文本)在 [start,end) 区间应用 rule.fix:抽出该段 → fix → 拼回(区间外原样)。
function applyFixAtRange(code: string, range: { start: number; end: number }, fix: (s: string) => string): string {
  const before = code.slice(0, range.start);
  const seg = code.slice(range.start, range.end);
  const after = code.slice(range.end);
  return before + fix(seg) + after;
}

// 【纯核】给定一组方言规则,校验并纠正某引擎脚本的方言问题。无 IO、无副作用、纯 CPU。
//  - error 级 + target=sql + 有 fix + 命中(masked) → 在原文对应区间纠正,记 fixed。
//  - error 级 + 命中但无 fix(或 target=code)→ 记 violation,blocked=true。
//  - warn 级 + 命中 → 记 violation(不 blocked、不改代码,仅提示)。
export function runGuardWithRules(dialectRules: DialectRule[], engine: CookbookEngine, code: string): GuardResult {
  const result: GuardResult = { code: code || "", fixed: [], violations: [], blocked: false };
  if (!code) return result;

  const rules = dialectRules.filter((r) => !!r.antiPattern);
  if (!rules.length) return result; // 该引擎无可检测规则(如纯命令式引擎)→ 原样返回(no-op)

  const fixedIds = new Set<string>();
  const violationIds = new Set<string>();

  // 不动点迭代到收敛(无改动即停)。
  // 【正确性关键】每条规则应用前,对当前 result.code 重新 mask + 重算区间——前一条规则的 fix 会改变文本长度,
  //   后一条规则若用旧偏移去切已变长的文本,会切进字符串/注释就地改写(静默损坏数据)。重新 mask 使偏移对齐当前文本。
  for (let round = 0; round < MAX_FIXPOINT_ROUNDS; round++) {
    let changedThisRound = false;

    for (const rule of rules) {
      const canFix = rule.severity === "error" && targetOfRule(rule) === "sql" && typeof rule.fix === "function";
      if (!canFix) continue;
      const { masked } = maskSqlLiterals(result.code);
      const ranges = matchRanges(rule.antiPattern!, masked);
      if (!ranges.length) continue;
      // 同一规则内多命中:从后往前应用,前面区间的 index 不被前序改动位移。
      const before = result.code;
      for (const range of ranges.sort((a, b) => b.start - a.start)) {
        result.code = applyFixAtRange(result.code, range, rule.fix!);
      }
      // 仅当 fix 真的改变了文本才算"这轮有变化"(幂等 fix 命中已纠正文本时不改动 → 视为已收敛)。
      if (result.code !== before) {
        fixedIds.add(rule.id);
        changedThisRound = true;
      }
    }

    if (!changedThisRound) break; // 收敛到不动点
  }

  // 收敛后再判定"未能自动修"的违规:凡仍命中的规则即违规。
  // 🔴 mask 选择按规则 target 分流(修复:此前 code 规则也走 SQL-mask 导致漏检):
  //  · target=sql:在 maskSqlLiterals 遮蔽后的文本上扫——保护 SQL 字符串/注释里恰好出现的 anti-pattern
  //    不被误判(如 INSERT ... VALUES('CREATE TABLE ...') 里的 DDL 是数据非语句)。这是 SQL 的 🔴A 词法安全。
  //  · target=code(命令式 PySpark 等):在【原始文本】上扫——code 引擎的 anti-pattern(如 jdbc:redshift 连接串)
  //    恰恰【总在字符串字面量里】,SQL-mask 会把检测目标吞掉;且 maskSqlLiterals 只懂 SQL 词法(--/* */),
  //    不认 Python 的 # 与三引号,套用语义本就不对。code 引擎【禁 fix】(仅检测/拦截,不改写),故无"改到
  //    字符串损坏数据"之虞——那类风险只存在于会改写的 SQL fix 路径。因此 code 检测直接打原文,准确无副作用。
  const { masked: finalMasked } = maskSqlLiterals(result.code);
  for (const rule of rules) {
    const scanTarget = targetOfRule(rule) === "code" ? result.code : finalMasked;
    const ranges = matchRanges(rule.antiPattern!, scanTarget);
    if (!ranges.length) continue;
    if (violationIds.has(rule.id)) continue;
    violationIds.add(rule.id);
    result.violations.push({ ruleId: rule.id, title: rule.title, rule: rule.rule, severity: rule.severity });
    if (rule.severity === "error") result.blocked = true;
  }

  result.fixed = Array.from(fixedIds).map((id) => {
    const r = rules.find((x) => x.id === id)!;
    return { ruleId: r.id, title: r.title };
  });

  return result;
}
