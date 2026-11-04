export type ParamChannel = "glue-etl" | "glue-sync" | "flink" | "dms" | "emr";
export interface ParamDef {
    key: string;
    label: string;
    consoleRef: string;
    type: "string" | "number" | "boolean" | "enum";
    options?: string[];
    min?: number;
    max?: number;
    unit?: string;
    platformDefault: unknown;
}
