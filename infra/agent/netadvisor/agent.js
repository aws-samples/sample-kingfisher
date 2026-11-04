// 网络连通性顾问 Agent —— 模块47 L3:接入 ②runtime 件(agent-runner),只声明"我的差异"。
//
// 【收敛前】本文件曾是 213 行:手写 for(iter) ConverseCommand 循环(与 paramadvisor 逐字 73% 相同)
// + RULES_TEXT(手抄自 rules.ts,已真实漂移:AZ_MATCH 丢"运行时才失败"对比语义、PRIVATE_EGRESS
// 丢"拉脚本/写结果/暂存"括注)+ TROUBLESHOOTING_ORDER 手抄。
// 【收敛后】循环骨架 → _runtime/agent-runner(Strands 装配,与 paramadvisor/copilot 共用);
// 规则文本 → core-dist/rules(与 platform inprocess connectivity-judge 同源,消手抄漂移)。
//
// 【与 L2 paramadvisor 的真实差异 —— systemPrompt 归属】
// paramadvisor 容器与进程内共用同一 systemPrompt(全搬 core);netadvisor 不共用:
//   · 容器技能 = 2 合并工具(analyze_connectivity 一条龙 / inspect_security_group),无状态。
//   · 进程内 prompt.ts = 4 细粒度工具(probe_environment/adjudicate_path/list_remediations/inspect_sg),有状态。
// 故 systemPrompt【外壳】(2工具工作流措辞)是 netadvisor 容器特有,保留在本文件(进程内不用它);
// 但它内部拼 core 的 renderRulesForPrompt()+TROUBLESHOOTING_ORDER —— 手抄的高危部分(规则文本)已消除,
// 低频改的 2工具工作流外壳留容器可接受。这是"能力分级"精神:共性(rules 数据 + 循环)抽走,个性(工具粒度)保留。
//
// _runtime/core-dist 均为平台级共享源(infra/agent/_runtime、network-advisor/core),由 prebuild 分发
// 进本容器目录内(Docker 构建上下文=本目录,COPY 不能出上下文,故分发进来后走相对 import)。
import { runAdvisorAgent } from "./_runtime/agent-runner.js";
// @netadvisor/core 编译产物(prebuild copy 进 core-dist):规则文本与 platform inprocess 同源,消手抄漂移。
import { renderRulesForPrompt, TROUBLESHOOTING_ORDER } from "./core-dist/rules.js";

const MAX_ITERS = parseInt(process.env.NETADVISOR_MAX_ITERS || "8", 10);
const MAX_TOKENS = parseInt(process.env.NETADVISOR_MAX_TOKENS || "2600", 10);

// system prompt 外壳(netadvisor 容器特有:围绕 2 个合并工具)。规则/排障文本来自 core(消手抄)。
function systemPrompt() {
  return [
    "你是【网络连通性智能顾问】。平台的护城河是：把 VPC/子网/安全组/路由这些网络细节从用户手里接管掉。",
    "用户在配 DMS/Glue/Flink/Zero-ETL 等数据管道，他们不想（也不该）去手动判断网络。你的职责：借助工具探测真实环境 → 依据权威规则裁决 → 给出「选哪个 VPC/子网/SG + 为什么 + 要打通还需做什么」，并支持多轮对话细化（最小权限、免 NAT 成本、高可用等）。",
    "",
    "## 铁律：Grounding（禁止臆造）",
    "你【只能】陈述工具返回结果里出现的网络事实。绝不编造子网 ID、安全组 ID、路由条目、endpoint、或「能/不能到达」的结论。",
    "判定可达性【必须】以 analyze_connectivity 工具返回的 verdict/rulings 为准（确定性规则引擎），不要自己推断 PASS/FAIL。若缺事实就再调工具或向用户索取——不要猜。",
    "",
    "## 权威规则（你的全部网络知识来源）",
    renderRulesForPrompt(), // ← core 单一事实源(消 RULES_TEXT 手抄)
    "",
    TROUBLESHOOTING_ORDER, // ← core 单一事实源(消 TROUBLESHOOTING_ORDER 手抄)
    "",
    "## 可用工具",
    "- analyze_connectivity：一站式分析。它在后端一条龙 探测环境 → 裁决可达性 → 生成整改建议，返回 verdict（可达性结论）、rulings（每条规则 PASS/FAIL/UNKNOWN）、candidates（候选放置及打分）、chosenPlacement（选定放置）、remediations（最小补救动作，每条带 API 预览）、facts（环境摘要）。可选传 placement 指定要评估的候选（缺省用确定性 top1）。",
    "- inspect_security_group：深挖单个安全组的完整入站/出站规则（做最小权限分析、定位缺失放行规则时用；analyze_connectivity 的摘要只给规则条数不给明细）。",
    "",
    "## 工作流",
    "1) 先调 analyze_connectivity（通常无需传 placement，用其确定性候选）拿到 verdict/rulings/candidates/remediations。",
    "2) 若要对比多个候选，可对不同 placement 多次调 analyze_connectivity。",
    "3) 需要最小权限分析或定位缺失规则时，对相关 SG 调 inspect_security_group 看明细。",
    "4) 依据工具返回结果，用简洁中文解释结论。",
    "",
    "## 多轮细化",
    "用户追加约束时，带上新约束重新调 analyze_connectivity 再解读：",
    "- 「最小权限」→ 结合 inspect_security_group 找 CIDR 规则，建议换成引用计算 SG-ID、收窄端口。",
    "- 「免 NAT 成本」→ 优先 S3 gateway endpoint（免费）+ interface endpoint，而非 NAT；对外部 SaaS 如实说明 NAT/PrivateLink 不可避免。",
    "",
    "## 输出契约",
    "最终回复用简洁中文解释结论（verdict + 选了什么 + 为什么 + 还需做什么）。",
    "每条补救必须对应某条 FAIL 的 ruling，不要给无依据的建议。",
    "任一硬性规则 FAIL 或 UNKNOWN 时，绝不下「完全可达(reachable)」的结论——如实说「需修复后可达」或「信息不足」。",
  ].join("\n");
}

// 把本轮请求渲染成首条 user 文本。
function firstTurnText(req) {
  return [
    `计算类型: ${req.computeKind}`,
    `目标: ${JSON.stringify(req.targets)}`,
    req.constraints ? `约束: ${JSON.stringify(req.constraints)}` : "",
    req.source ? `已有放置: ${JSON.stringify(req.source)}` : "",
    req.userMessage ? `用户补充: ${req.userMessage}` : "请给出网络连通建议。",
  ].filter(Boolean).join("\n");
}

// 网络顾问 spec(差异声明):
//   systemPrompt  —— 无参(netadvisor systemPrompt 不依赖 channel);外壳留容器,内部拼 core 规则文本
//   inject        —— 无状态请求上下文 request 注入每个工具调用(技能 Lambda 的 SkillEvent.request 契约)
//   captureSuffix —— analyze_connectivity 是一站式分析(结构化字段的权威来源)
//   finalize      —— 组装网络顾问 wire(verdict/rulings/remediations/candidates/chosenPlacement/facts)
export async function runAgent(input) {
  return runAdvisorAgent(input, {
    clientName: "bgp-netadvisor-agent",
    systemPrompt: () => systemPrompt(),
    firstTurnText: (req) => firstTurnText(req),
    inject: (raw, req) => ({ ...raw, request: req }),
    captureSuffix: "analyze_connectivity",
    maxIters: MAX_ITERS,
    maxTokens: MAX_TOKENS,
    finalize: (reasoning, lastAnalysis, steps, usage) => ({
      reasoning,
      verdict: lastAnalysis?.verdict || "unknown",
      rulings: lastAnalysis?.rulings || [],
      remediations: lastAnalysis?.remediations || [],
      candidates: lastAnalysis?.candidates || [],
      chosenPlacement: lastAnalysis?.chosenPlacement || null,
      facts: lastAnalysis?.facts || null,
      steps,
      llmAvailable: true,
      usage,
    }),
  });
}
