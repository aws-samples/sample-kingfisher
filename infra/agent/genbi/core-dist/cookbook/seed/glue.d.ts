import type { DialectRule, Recipe } from "../types";
export declare const COOKBOOK_GLUE_VERSIONS: string[];
export declare const COOKBOOK_GLUE_VERSION_DEFAULT = "6.0";
export declare const COOKBOOK_GLUE_DEFAULT_RUNTIME: {
    spark: string;
    python: string;
    iceberg: string;
};
export declare const GLUE_DIALECT_RULES: DialectRule[];
export declare const GLUE_RECIPES: Recipe[];
