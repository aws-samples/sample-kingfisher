export type CookbookEngine = "redshift" | "s3tables" | "glue" | "emr" | "flink" | "athena";
export type CookbookTarget = "sql" | "code";
export interface DialectRule {
    id: string;
    engine: CookbookEngine;
    title: string;
    rule: string;
    antiPattern?: RegExp;
    fix?: (code: string) => string;
    severity: "error" | "warn";
    target?: CookbookTarget;
    engineVersion?: string;
}
export interface Recipe {
    id: string;
    engine: CookbookEngine;
    capability: string;
    title: string;
    whenToUse: string;
    template: string;
    dialectNotes: string[];
    tags: string[];
    source?: "system" | "admin";
    engineVersion?: string;
    verifiedAt?: string;
    /**
     * 代码里出现什么就算**用到了这个范式**(扫描器用)。
     * 🔴 与 `DialectRule.antiPattern` 语义相反:那个是「命中即违规」,这个是「命中即用到」。
     */
    detect?: RegExp[];
    /** 用了这个范式就**必须**有的权限(扫描器据此自动推导;`resource` 支持占位符,见 script-scan)。 */
    requiredPermissions?: RecipePermission[];
}
/**
 * 配方声明的一条权限需求。
 * `resource` 里的占位符由扫描器按上下文替换(闭合清单,见 `script-scan.ts` 的 `PLACEHOLDERS`):
 *   `{region}` `{account}` `{datalakeBucket}` `{scriptBucket}` `{tableBucket}` `*`
 * 🔴 刻意不允许任意表达式:配方是**数据**,不是代码 —— 让管理员也能安全地加配方。
 */
export interface RecipePermission {
    actions: string[];
    resources: string[];
    /** 人话:为什么这个范式需要它(界面 / 预检报错直接用这句)。 */
    why: string;
}
export interface CookbookSlice {
    engine: CookbookEngine;
    dialectRules: {
        title: string;
        rule: string;
        severity: "error" | "warn";
    }[];
    recipes: Recipe[];
    totalMatched: number;
}
export interface GuardResult {
    code: string;
    fixed: {
        ruleId: string;
        title: string;
    }[];
    violations: {
        ruleId: string;
        title: string;
        rule: string;
        severity: "error" | "warn";
    }[];
    blocked: boolean;
}
export declare function defaultTargetForEngine(engine: CookbookEngine): CookbookTarget;
export declare function targetOfRule(rule: DialectRule): CookbookTarget;
