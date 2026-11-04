export interface ModelConverseInput {
    system: string;
    messages: {
        role: "user" | "assistant";
        content: string;
    }[];
    maxTokens?: number;
    temperature?: number;
}
export interface ModelConverseOutput {
    text: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
export interface ModelClient {
    converse(input: ModelConverseInput): Promise<ModelConverseOutput>;
}
