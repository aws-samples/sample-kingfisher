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
export declare const GRANT_TO_PUBLIC_PATTERN: RegExp;
/**
 * 生成某引擎的"禁止授权给 PUBLIC"方言硬规则。
 *
 * - `severity: "error"` ⇒ ① 自动进 planner 提示词(`registry.allDialectRulesForPrompt`,生成前就知道)
 *   ② 无 `fix` ⇒ guard 判 `blocked` ⇒ 运行前硬拦(glue: `job-service.ts` / emr: `engines/emr/provider.ts`
 *   / redshift SQL: `job-service.ts` 的 run 与 explain 两处)。**双管齐下的"管"就是这两条**。
 * - **不给 `fix`**:机械删一条语句要判断它是不是被字符串/事务包着、删完是否还合法 ——
 *   正则改写这种东西就是在制造新 bug(`target="code"` 本来就禁 fix)。命中即拦,让人改。
 */
export declare function noGrantToPublicRule(engine: CookbookEngine): DialectRule;
