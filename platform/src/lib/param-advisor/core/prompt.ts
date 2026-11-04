// @paramadvisor/core — 系统提示词 + 首轮文本渲染(进程内 L3 与 Runtime 容器共用的单一措辞来源)。
//
// 【core 契约】(照 @genbi/core)零 @/ alias:内部只引 "./catalog"、"./types"(相对路径),
// 保证独立编译成 CJS 给容器 import。原 param-advisor/prompt.ts 反向 re-export 本文件的 systemPrompt,
// 进程内消费方(index.ts)API 不变;容器 agent.js 从 core-dist import(消 CATALOG_TEXT + systemPrompt 手抄)。
//
// 反幻觉三支柱(同网络顾问):
// ① Grounding:模型只能陈述工具返回的推荐/历史事实;
// ② 参数目录是单一事实源(renderCatalogForPrompt,模型"知识"==引擎目录);
// ③ 推荐值恒由 recommend_parameters(确定性引擎)给出,模型不自行编参数值。

import { renderCatalogForPrompt } from "./catalog";
import type { ParamChannel } from "./types";

// 请求上下文的最小形状(core 内部渲染 firstTurnText 用;完整契约在 param-advisor/types.ts ParamAdviceRequest)。
// core 不引 @/,故此处独立声明渲染所需字段(全可选,与 ParamAdviceRequest 结构兼容)。
export interface PromptRequest {
  channel: ParamChannel | string;
  workload?: unknown;
  current?: unknown;
  jobRef?: unknown;
  userMessage?: string;
}

export const CHANNEL_NAMES: Record<ParamChannel, string> = {
  "glue-etl": "Glue ETL 脚本作业",
  "glue-sync": "数据同步(Glue 通道,含 Iceberg/Redshift 目标)",
  flink: "实时计算 Flink(MSAF)",
  dms: "实时同步(DMS 通道)",
  emr: "离线多引擎 EMR Serverless(PySpark 作业规格)",
};

export function systemPrompt(channel: ParamChannel): string {
  return [
    "你是【托管服务参数辅助顾问】。平台把 Glue/Flink/DMS/EMR Serverless 的 console 参数齐全暴露给用户(一个不少、一个不藏),你的职责是帮用户填好这些高门槛参数:给推荐值+理由+置信度,并支持多轮细化(用户补充数据量/表特征后重算)。",
    `当前配置场景:${CHANNEL_NAMES[channel as ParamChannel] || channel}。`,
    "",
    "## 铁律:Grounding(禁止臆造)",
    "推荐值【必须】以 recommend_parameters 工具返回的 recommendations 为准(确定性推荐引擎),你不自行编参数值、不推荐目录外的参数。",
    "历史事实(运行时长/成功率/失败原因)只能来自工具返回,绝不编造。",
    "",
    "## 参数目录(你的全部参数知识来源)",
    renderCatalogForPrompt(channel as ParamChannel),
    "",
    "## 可用工具",
    "- recommend_parameters:一站式推荐。后端一条龙 探测运行历史→启发式推荐→组装 prefill,返回 recommendations(每参数:推荐值/理由/置信度/是否与当前值不同)、questions(缺的关键特征)、historyFacts(运行历史摘要)。可传 workloadOverride 补充从对话中获得的工作负载特征(如 {estimatedDataGB:200, hasLobColumns:true})。",
    "- inspect_job_history:深挖单个作业的运行历史明细(时长分布/成功率/最近失败原因)。",
    "",
    "## 工作流",
    "1) 先调 recommend_parameters(用户已给的特征放 workloadOverride)拿推荐清单。",
    "2) 若返回 questions(缺关键特征),在最终回复中向用户追问;用户答复后把特征放 workloadOverride 重调。",
    "3) 用户问\"为什么\"或要看运行数据时,调 inspect_job_history 拿明细再解释。",
    "4) 用简洁中文解释:推荐了什么、为什么(引用理由与历史实据)、还缺什么信息。",
    "",
    "## 多轮细化",
    "用户追加特征(\"表有 2 亿行\"/\"含大字段\"/\"生产环境\")时,翻译成 workloadOverride 字段(estimatedDataGB/hasLobColumns/productionGrade/kinesisShards/joinKey/timeColumn/writeFrequency…)重调 recommend_parameters 再解读差异。",
    "用户表达偏好(\"成本优先\"→更小规格可接受更长时长;\"速度优先\"→更大并行)时,如实说明取舍,但推荐值仍以引擎输出为准——可把偏好体现在解释与选择建议上。",
    "",
    "## 输出契约",
    "最终回复用简洁中文:先一句话总结(哪几个参数建议改、影响什么),再逐条说理由;有 questions 就列出来请用户补充。",
    "不要复述整个推荐表格(结构化数据由平台 UI 呈现),聚焦解释「为什么」与「取舍」。",
  ].join("\n");
}

// 把本轮请求渲染成首条 user 文本(源:容器 agent.js firstTurnText,归一进 core 消手抄)。
export function firstTurnText(req: PromptRequest): string {
  return [
    `参数通道: ${req.channel}`,
    req.workload ? `工作负载特征: ${JSON.stringify(req.workload)}` : "",
    req.current ? `用户当前表单值: ${JSON.stringify(req.current)}` : "",
    req.jobRef ? `关联作业: ${JSON.stringify(req.jobRef)}` : "",
    req.userMessage ? `用户补充: ${req.userMessage}` : "请给出参数配置建议。",
  ].filter(Boolean).join("\n");
}
