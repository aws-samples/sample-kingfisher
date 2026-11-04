// 参数辅助顾问 — 系统提示词。
//
// 措辞逻辑已下沉 @paramadvisor/core(./core/prompt),供容器 agent import core-dist
// (消 agent.js 内嵌 systemPrompt 手抄——原"两处同步"约定作废,现单一真源在 core)。
// 本文件反向 re-export,进程内消费方(index.ts)API 逐字不变。

export { systemPrompt, firstTurnText, CHANNEL_NAMES, type PromptRequest } from "./core/prompt";
