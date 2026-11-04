// 模块 44 — Copilot 工具注册表(单一事实源)。
// 只读工具人人可用;创建工具【仅当调用者具 editor 角色时】才装入(闸3:能力随角色收敛)。
// 注册表同时供:① inprocess agent(lib/copilot/agent.ts)② 将来 AgentCore 容器(共享同一份声明,防漂移)。

import type { CopilotTool } from "./types";
import { READ_TOOLS } from "./read-tools";
import { CREATE_TOOLS } from "./create-tools";

// 按调用者能力构建本次可用工具集。canCreate=false(如 viewer/未授权)→ 只给只读工具,
// 创建工具【根本不进工具集】(闸1 能力面:模型无法调用不存在的工具)。
export function buildTools(canCreate: boolean): CopilotTool[] {
  return canCreate ? [...READ_TOOLS, ...CREATE_TOOLS] : [...READ_TOOLS];
}

export function getTool(tools: CopilotTool[], name: string): CopilotTool | undefined {
  return tools.find((t) => t.name === name);
}

// 供 Bedrock Converse toolConfig 用的工具规格(name/description/inputSchema)。
export function toolSpecs(tools: CopilotTool[]) {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.inputSchema },
    },
  }));
}

// 全部只读工具元数据(能力透明化展示用;不含随角色收敛的创建工具)。
export function readToolMeta() {
  return READ_TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description }));
}
