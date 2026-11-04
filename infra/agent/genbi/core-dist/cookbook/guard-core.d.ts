import type { CookbookEngine, DialectRule, GuardResult } from "./types";
export declare function runGuardWithRules(dialectRules: DialectRule[], engine: CookbookEngine, code: string): GuardResult;
