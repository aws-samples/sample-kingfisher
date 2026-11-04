import type { GenBiEngine } from "./types";
export interface SystemPromptOpts {
    skillsCatalog?: {
        name: string;
        description?: string;
        params?: {
            name: string;
            required?: boolean;
        }[];
    }[];
    published?: {
        schema?: string;
        table?: string;
        targetTable?: string;
        title?: string;
        question?: string;
    }[];
    memory?: string;
    athenaRef?: string;
}
export declare function systemPrompt(catalog: string, database: string, engine?: GenBiEngine, businessContext?: string, opts?: SystemPromptOpts): string;
