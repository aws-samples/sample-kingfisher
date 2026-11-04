// AWS DevOps Agent（signingName: aidevops）封装。
// 用真实 AWS 托管服务做故障诊断：发现/创建 Agent Space → 建会话 → 发送故障证据 →
// 收集 Agent 的调查回复文本，作为诊断报告。Agent 会自主关联 CloudWatch 日志/指标等。
//
// 注意：不硬编码 Agent Space id（按名 bgp-devops-agent 发现/创建），临时账号回收后自愈。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  DevOpsAgentClient,
  ListAgentSpacesCommand,
  CreateAgentSpaceCommand,
  CreateChatCommand,
  SendMessageCommand,
} from "@aws-sdk/client-devops-agent";

const region = homeRegion();
const AGENT_SPACE_NAME = process.env.DEVOPS_AGENT_SPACE_NAME || "bgp-devops-agent";

const client = sdkClient("control-plane", DevOpsAgentClient, { region });

let _spaceId: string | undefined; // 进程内缓存

export async function ensureAgentSpace(): Promise<string> {
  if (_spaceId) return _spaceId;
  // 按名发现
  const list = await client.send(new ListAgentSpacesCommand({}));
  const found = (list.agentSpaces || []).find((s: any) => s.name === AGENT_SPACE_NAME);
  if (found?.agentSpaceId) {
    _spaceId = found.agentSpaceId;
    return _spaceId;
  }
  // 不存在则创建
  const created = await client.send(
    new CreateAgentSpaceCommand({ name: AGENT_SPACE_NAME, description: "BGP 平台任务故障诊断" })
  );
  const id = created.agentSpace?.agentSpaceId;
  if (!id) throw new Error("创建 DevOps Agent Agent Space 失败");
  _spaceId = id;
  return id;
}

// SendMessage 的 events 可能是数组或事件流（异步可迭代）。统一收集 contentBlockDelta 的文本增量。
async function collectText(events: any): Promise<string> {
  if (!events) return "";
  const parts: string[] = [];
  const handle = (e: any) => {
    const t = e?.contentBlockDelta?.delta?.textDelta?.text;
    if (t) parts.push(t);
  };
  if (typeof events[Symbol.asyncIterator] === "function") {
    for await (const e of events) handle(e);
  } else if (Array.isArray(events)) {
    events.forEach(handle);
  }
  return parts.join("");
}

export interface InvestigateResult {
  report: string;
  agentSpaceId: string;
  executionId: string;
}

// 发起一次故障调查：建会话 → 发送证据充分的 prompt → 收集 Agent 回复为报告。
// 仅当首条回复过短（像"我先去查一下"而非结论）时，追问一次以拿到完整报告（避免重复）。
export async function investigate(prompt: string, userId = "bgp-platform"): Promise<InvestigateResult> {
  const agentSpaceId = await ensureAgentSpace();
  const chat = await client.send(new CreateChatCommand({ agentSpaceId, userId, userType: "IAM" }));
  const executionId = chat.executionId;
  if (!executionId) throw new Error("DevOps Agent 会话创建失败");

  const first = await client.send(new SendMessageCommand({ agentSpaceId, executionId, content: prompt, userId }));
  let report = (await collectText(first.events)).trim();

  const looksComplete = report.length >= 300 || /根因|修复建议|##|故障摘要/.test(report);
  if (!looksComplete) {
    const follow = await client.send(
      new SendMessageCommand({
        agentSpaceId,
        executionId,
        content: "请直接输出完整的中文故障诊断报告：① 故障摘要 ② 根因分析 ③ 修复建议（可操作） ④ 预防建议。",
        userId,
      })
    );
    const more = (await collectText(follow.events)).trim();
    if (more) report = (report ? report + "\n\n" : "") + more;
  }

  return { report, agentSpaceId, executionId };
}
