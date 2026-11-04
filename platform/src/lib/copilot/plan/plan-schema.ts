// 模块 44 — Copilot 规划大脑的结构化产出 Zod schema(喂给 Strands structuredOutputSchema)。
// Strands Agent 用它强约束模型产出符合 PlanSpec 的 JSON,并【自动校验 + 校验失败重试】
// (StructuredOutputError 兜底)。schema 与 types.ts 的 PlanSpec/StepSpec 一一对应(单一事实源)。
//
// 为什么用 Zod 而非自由文本:计划要落库、渲染成卡片、校验(步骤类型必须已注册、dependsOn 必须
// 指向本计划内步骤)。Zod 同时给 TS 类型推断 + 运行时校验,双重保障。

import { z } from "zod";
import { STEP_TYPES } from "./types";

// 单个步骤规格:规划大脑只产"想做什么"(类型/标题/理由/入参/依赖),不产运行时字段。
export const StepSpecSchema = z.object({
  seq: z.number().int().min(1).describe("步骤序号(从 1 开始,唯一,用于被其它步骤依赖引用)"),
  stepType: z
    .enum(STEP_TYPES as unknown as [string, ...string[]])
    .describe(
      "步骤类型。sync-glue=建Glue批同步任务;sync-dms=建DMS实时同步;redshift-sql=建Redshift SQL离线作业;" +
      "glue=建Glue PySpark作业;emr=建EMR Serverless作业;query-only=直接查数据(仅作计划终点,指引用户去查询页)"
    ),
  title: z.string().min(1).describe("给用户看的步骤标题,如「创建 MySQL→Redshift 同步任务」"),
  rationale: z.string().describe("为什么需要这一步(基于发现结果的理由),如「源库有广告数据但仓库还没同步」"),
  params: z
    .record(z.string(), z.unknown())
    .describe(
      "该步骤的入参(建 draft 用,按 stepType 异构)。例:sync-glue 给 {name, datasourceId, sourceTable, targetType};" +
      "redshift-sql/glue 给 {name, script};emr 给 {name, script, subnetIds, securityGroupIds};query-only 给 {sql 或 说明}"
    ),
  dependsOnSeq: z
    .array(z.number().int())
    .describe("本步骤依赖的其它步骤 seq 列表(必须先完成那些步骤)。无依赖给空数组 []"),
});

// 完整执行计划:发现结论 + 一句话说明 + 异构步骤(可为空 = 无需执行,直接答)。
export const PlanSpecSchema = z.object({
  summary: z.string().describe("整个执行计划的一句话说明(给用户看)"),
  findings: z
    .string()
    .describe(
      "发现阶段的现状结论:数据在哪、有没有现成指标、源数据同步了没、在数据湖还是仓库。" +
      "若发现不到源数据,如实说明「源库里没有相关数据,无法继续」,不要臆造步骤。"
    ),
  steps: z
    .array(StepSpecSchema)
    .describe(
      "执行步骤(异构,含依赖)。若已有现成指标/数据可直接查,steps 可能只有 1 步(query-only)甚至 0 步(直接答)。" +
      "只产真正必要的最小步骤路径,不要多余步骤。"
    ),
});

// TS 类型从 Zod 推断(与 types.ts 的 PlanSpec 结构一致;这里作为 Strands 产出的运行时校验源)。
export type PlanSpecFromSchema = z.infer<typeof PlanSpecSchema>;
