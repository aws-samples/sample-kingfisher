// @kf-batch 52-P52.1-L1-grant-public
// 模块 45 seed — **跨引擎共享的方言规则工厂**(本文件是这类规则的唯一作者)。
//
// 【为什么需要它】`DialectRule.engine` 是单值(封闭枚举),而"禁止把数仓表授权给 PUBLIC"这条约束
// 对 **redshift(声明式 SQL)/ glue / emr(命令式 PySpark 里的 redshift-data 调用)** 三个引擎同时成立。
// 照仓里既有先例(`no-jdbc-redshift` 在 glue.ts 与 emr.ts 各写一份)就得抄三份 ——
// 抄三份的代价是**三份会漂移**:改了一份忘另两份 = 某条生成路径悄悄没有护栏,
// 而"某条路径悄悄没护栏"正是本仓反复踩的那类坑(见 memory `fix-then-reaudit-loop`:共享契约必须单作者)。
// ⇒ 规则文本与 antiPattern 在这里写**一次**,三个引擎各 `noGrantToPublicRule(engine)` 实例化。
// 加引擎 = 那个引擎的 seed 文件多一行,不改本文件。
//
// 🔴 **本文件刻意不出现 `GRANT` 与 `PUBLIC` 相邻的字面文本**:L1 的扫描门禁
// (`platform/src/lib/projects/__tests__/l1-no-grant-to-public.test.ts`)禁止全仓出现该形态,
// 而"禁令自己"不该靠加豁免名单来通过 —— 名单每多一项就少一分绝对性。
// 机器判据交给 `antiPattern`(用 `\s+` 而非字面空格,故不自命中),人读判据用中文表述。

import type { CookbookEngine, DialectRule } from "../types";

/**
 * 命中即违规:把数仓对象**授权给 PUBLIC**(任何权限形态:ALL / SELECT / USAGE / INSERT …)。
 *
 * 🔴 与 `lib/exec-env/admin-ddl-guards.ts` 的 `cross-project-move` 名单里那一条**同形**
 * (`\bgrant\b[^;]*\bto\s+public\b`)。两处刻意不共用一个常量:那一处是 admin-DDL 通道的
 * 纵深自检(50 SPEC §3.9a),本处是 codegen 生成侧的方言硬规则,生命周期与消费者都不同;
 * 同形由 `l1-no-grant-to-public.test.ts` 的"两处正则对同一组样本判定一致"钉住,不靠人记得。
 *
 * `[^;]*` 而不是 `.*`:把匹配限制在**同一条语句内**,避免"前一句有 GRANT、后一句提到 public"这种误咬。
 */
export const GRANT_TO_PUBLIC_PATTERN = /\bgrant\b[^;]*\bto\s+public\b/i;

/** 人读规则文本(三引擎共用一份;各引擎只在开头点明自己的执行形态)。 */
const WHY = [
  "把数仓表/schema 授权给 PUBLIC 会让**该库内所有身份**读写它 —— 平台的项目空间隔离(模块 52)当场击穿:",
  "别的项目、别的作业、别的登录用户都能读到本项目的业务数据。",
  "而且它**根本没必要**:平台的建表/写入/查询页/智能问数/指标/质量各条路径统一用同一个数仓身份执行,",
  "建完表本来就看得见,不需要任何补授权(2026-09-03 L1 已把最后一处不一致的 `sync/execute-ddl` 并入)。",
  "要给别的身份权限,正解是授权给**具体的项目角色**(平台在 P52.5a 供给 `role_proj_<项目>`),永不用 PUBLIC。",
].join("");

const HOW: Record<string, string> = {
  redshift: "Redshift SQL 作业里建完表**直接结束**,不要再追加授权语句。",
  glue: "Glue PySpark 用 boto3 redshift-data 建完表**直接结束**,不要再 execute_statement 一条授权语句。",
  emr: "EMR PySpark 用 boto3 redshift-data 建完表**直接结束**,不要再 execute_statement 一条授权语句。",
};

/**
 * 生成某引擎的"禁止授权给 PUBLIC"方言硬规则。
 *
 * - `severity: "error"` ⇒ ① 自动进 planner 提示词(`registry.allDialectRulesForPrompt`,生成前就知道)
 *   ② 无 `fix` ⇒ guard 判 `blocked` ⇒ 运行前硬拦(glue: `job-service.ts` / emr: `engines/emr/provider.ts`
 *   / redshift SQL: `job-service.ts` 的 run 与 explain 两处)。**双管齐下的"管"就是这两条**。
 * - **不给 `fix`**:机械删一条语句要判断它是不是被字符串/事务包着、删完是否还合法 ——
 *   正则改写这种东西就是在制造新 bug(`target="code"` 本来就禁 fix)。命中即拦,让人改。
 */
export function noGrantToPublicRule(engine: CookbookEngine): DialectRule {
  return {
    id: `${engine}.no-grant-to-public`,
    engine,
    title: "严禁把数仓表授权给 PUBLIC(击穿项目隔离;平台统一身份本就可见,无需授权)",
    rule: `${HOW[engine] ?? HOW.redshift}${WHY}`,
    antiPattern: GRANT_TO_PUBLIC_PATTERN,
    severity: "error",
  };
}
