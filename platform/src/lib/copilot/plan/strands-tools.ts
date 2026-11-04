// 把平台的只读发现工具适配成 Strands tool()(供规划大脑 planner 用)。
//
// 现有 CopilotTool 用 JSON Schema + handler(args, caller);Strands tool() 用 Zod + callback(input)。
// 本文件是【单向适配桥】:把 CopilotTool 包装成 Strands InvokableTool——
//   · Zod schema:规划大脑的发现工具入参都很简单(可选 keyword/id),用统一的宽松 Zod 承接,
//     真正的字段校验仍在各 handler 内(与 inprocess 路径同一份 handler,防两处漂移)。
//   · callback:闭包捕获 caller(调用者身份),转调 CopilotTool.handler,返回其 data(或抛错让 Strands 记录)。
//
// 为什么不给规划大脑装创建/执行工具:本期规划大脑【只读】——发现现状 + 产结构化计划(structuredOutput)。
// 建 draft 延迟到用户"确认某步"时才做(StepHandler.createDraft,走 API 路由),不在规划回合内发生。
// 这样 Strands agent 再自主,工具箱里也【没有】任何建/跑工具(闸1 能力面根除,在框架内依然成立)。

import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import type { CopilotTool, CopilotCaller } from "../tools/types";
import { DISCOVERY_TOOLS } from "./discovery-tools";
import { READ_TOOLS } from "../tools/read-tools";

// 规划大脑可用的只读工具全集 = 现有通用只读工具(列资源/口径/血缘/运行)+ 新发现工具。
// 去重(按 name),发现工具优先(若与现有重名)。
function planReadTools(): CopilotTool[] {
  const byName = new Map<string, CopilotTool>();
  for (const t of READ_TOOLS) byName.set(t.name, t);
  for (const t of DISCOVERY_TOOLS) byName.set(t.name, t); // 覆盖同名(发现工具优先)
  return Array.from(byName.values());
}

// 把 JSON Schema 的 properties 粗映射成 Zod(发现工具入参都是可选 string / 可选 number 的浅对象)。
// 这里刻意宽松:Strands 只需要一个能承接入参的 schema,严格校验在 handler 内。复杂类型一律 unknown。
function jsonPropsToZod(inputSchema: Record<string, any>): z.ZodType {
  const props = (inputSchema?.properties || {}) as Record<string, any>;
  const required: string[] = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, spec] of Object.entries(props)) {
    const desc = String((spec as any)?.description || "");
    let base: z.ZodType;
    switch ((spec as any)?.type) {
      case "number": base = z.number(); break;
      case "boolean": base = z.boolean(); break;
      case "string": base = z.string(); break;
      default: base = z.unknown();
    }
    if (desc) base = base.describe(desc);
    shape[key] = required.includes(key) ? base : base.optional();
  }
  return z.object(shape);
}

// 把一个 CopilotTool 包成 Strands tool()。caller 由闭包捕获(每次规划请求带当前调用者身份)。
function toStrandsTool(t: CopilotTool, caller: CopilotCaller) {
  return tool({
    name: t.name,
    description: t.description,
    inputSchema: jsonPropsToZod(t.inputSchema),
    callback: async (input: unknown) => {
      const res = await t.handler((input as Record<string, unknown>) || {}, caller);
      if (res.success === false) {
        // 让模型看到失败原因(Strands 会把抛错作为工具错误结果反馈给模型,便于其调整)。
        throw new Error(res.error || `${t.name} failed`);
      }
      // 返回 data(JSON 可序列化);Strands 会喂回模型。
      return (res.data ?? {}) as any;
    },
  });
}

// 供 planner 构建规划大脑的只读工具集(Strands 形态)。
export function buildStrandsReadTools(caller: CopilotCaller) {
  return planReadTools().map((t) => toStrandsTool(t, caller));
}

// 供能力透明化/测试:规划大脑可用的只读工具元数据。
export function planReadToolMeta() {
  return planReadTools().map((t) => ({ name: t.name, kind: t.kind, description: t.description }));
}
