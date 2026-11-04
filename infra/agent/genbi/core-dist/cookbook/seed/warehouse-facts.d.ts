import type { CookbookEngine, DialectRule } from "../types";
/** Glue 作业读本区数仓事实的唯一写法(规则 / 模板 / 提示词共用)。 */
export declare const GLUE_WAREHOUSE_HOWTO: string;
/** EMR 作业读本区数仓事实的唯一写法(同一组值,经 Spark conf 注入)。 */
export declare const EMR_WAREHOUSE_HOWTO: string;
/** 命中 = 代码里把数仓工作组写成了字面量(`WorkgroupName='xxx'` / `WORKGROUP = 'xxx'`)。 */
export declare const HARDCODED_WORKGROUP_PATTERN: RegExp;
export declare function hardcodedWarehouseRule(engine: Extract<CookbookEngine, "glue" | "emr">): DialectRule;
