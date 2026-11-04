export interface SchemaColumn {
    name: string;
    type: string;
}
export interface SchemaTable {
    schema: string;
    table: string;
    columns: SchemaColumn[];
}
export interface PublishedHint {
    targetTable: string;
    question?: string;
    title: string;
}
export interface CatalogEntry {
    schema: string;
    table: string;
    columns: {
        name: string;
        type: string;
    }[];
    description?: string;
    published?: {
        title: string;
        question?: string;
    };
}
export interface TableMatch {
    schema: string;
    table: string;
    reason: string;
    preferred: boolean;
}
export interface RetrievalResult {
    selected: CatalogEntry[];
    matches: TableMatch[];
    note?: string;
    usedFallback: boolean;
}
export type ContextKind = "caliber" | "term" | "rule";
export interface ContextEntry {
    projectId: string;
    entryId: string;
    kind: ContextKind;
    title: string;
    body: string;
    scope?: string;
    tags?: string[];
    enabled: boolean;
    createdBy?: string;
    createdAt: string;
    updatedAt: string;
}
export type GenBiEngine = "redshift" | "athena";
export type ChartType = "table" | "metric" | "bar" | "line";
export interface ChartSpec {
    type: ChartType;
    xField?: string;
    yField?: string;
    reason?: string;
}
export interface GenBiStep {
    sql: string;
    ok: boolean;
    rowCount?: number;
    error?: string;
    tool?: string;
    phase?: "prepare" | "reason";
    inputSummary?: string;
    outputSummary?: string;
    durationMs?: number;
}
export interface MatchedTable {
    schema: string;
    table: string;
    reason: string;
    preferred: boolean;
}
export interface UsedContextEntry {
    title: string;
    kindLabel: string;
    scope?: string;
}
