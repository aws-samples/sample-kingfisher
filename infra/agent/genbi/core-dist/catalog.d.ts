import type { SchemaTable, GenBiEngine } from "./types";
export declare const SCHEMA_SQL = "\n  SELECT t.schemaname, t.tablename, c.column_name, c.data_type, c.ordinal_position\n  FROM pg_tables t\n  LEFT JOIN information_schema.columns c\n    ON c.table_schema = t.schemaname AND c.table_name = t.tablename\n  WHERE t.schemaname NOT IN ('information_schema','pg_catalog','pg_internal','pg_automv')\n  ORDER BY t.schemaname, t.tablename, c.ordinal_position\n";
export interface CatalogTextOpts {
    engine?: GenBiEngine;
    athenaRef?: string;
    retrievalHeader?: boolean;
}
export interface CatalogTableExtra {
    description?: string;
    published?: {
        title?: string;
        question?: string;
    };
}
export declare function buildCatalogText(tables: (SchemaTable & CatalogTableExtra)[], database: string, opts?: CatalogTextOpts): string;
