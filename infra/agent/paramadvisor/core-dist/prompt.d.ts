import type { ParamChannel } from "./types";
export interface PromptRequest {
    channel: ParamChannel | string;
    workload?: unknown;
    current?: unknown;
    jobRef?: unknown;
    userMessage?: string;
}
export declare const CHANNEL_NAMES: Record<ParamChannel, string>;
export declare function systemPrompt(channel: ParamChannel): string;
export declare function firstTurnText(req: PromptRequest): string;
