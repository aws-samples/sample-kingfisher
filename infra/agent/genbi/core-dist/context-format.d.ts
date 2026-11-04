import type { ContextEntry, ContextKind } from "./types";
export declare const CONTEXT_KIND_LABEL: Record<ContextKind, string>;
export declare const CONTEXT_SECTION_TITLE = "\u4E1A\u52A1\u53E3\u5F84\u4E0E\u89C4\u5219\uFF08\u5FC5\u987B\u9075\u5FAA\uFF09";
export declare function contextToPromptText(entries: ContextEntry[]): string;
export interface UsedContextItem {
    title: string;
    kindLabel: string;
    scope?: string;
}
export declare function contextToUsedItems(entries: ContextEntry[]): UsedContextItem[];
export declare const GROUNDING_MAX_ENTRIES = 40;
export declare function filterAndRankContext(entries: ContextEntry[], keywords?: string, limit?: number): ContextEntry[];
export interface GroundingItem {
    kind: string;
    title: string;
    definition: string;
    scope: string | null;
    tags: string[];
}
export declare function contextToGroundingItems(entries: ContextEntry[]): GroundingItem[];
