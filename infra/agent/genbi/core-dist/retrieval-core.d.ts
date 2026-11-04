import type { SchemaTable, PublishedHint, CatalogEntry, RetrievalResult } from "./types";
import type { ModelClient } from "./model-client";
export declare const PREFILTER_CAP = 40;
export declare const TOPK = 6;
export declare function buildSemanticCatalog(tables: SchemaTable[], omDesc: Record<string, string>, published: PublishedHint[]): CatalogEntry[];
export declare function selectRelevantTables(question: string, tables: SchemaTable[], published: PublishedHint[], omDesc: Record<string, string>, model: ModelClient): Promise<RetrievalResult>;
