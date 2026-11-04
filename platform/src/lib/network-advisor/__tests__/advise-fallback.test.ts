// Phase4 回退兜底单测(标准 §7② + §10.4)——验证 advise() 的双层 try:
//   ① NETADVISOR_BACKEND=agentcore 且 Runtime 调用成功 → backend="agentcore",直用容器结构化结果。
//   ② Runtime 调用抛错(冷启动/限流/Gateway 故障) → 自动回退进程内,backend="inprocess",仍出确定性结果。
//   ③ 未启用 agentcore → 直接走进程内,backend="inprocess"。
// 策略:mock agentcore-client(隔离 Runtime)+ advisor-agent(隔离进程内 L3 大模型)+ environment-probe。
// 裁决/候选/prefill 用真实纯函数模块,端到端验证组装骨架。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnvironmentFacts, SubnetFact, VpcFact, SecurityGroupFact, PlacedConnectivityRequest } from "../types";

// ── mock agentcore-client:可控 isAgentCoreConfigured / invokeNetAdvisorAgent ──
const invokeMock = vi.fn();
const configuredMock = vi.fn(() => true);
vi.mock("../agentcore-client", () => ({
  isAgentCoreConfigured: () => configuredMock(),
  invokeNetAdvisorAgent: (sid: string, input: unknown) => invokeMock(sid, input),
}));

// ── mock advisor-agent:进程内 L3 环,返回可控 AgentState(隔离 Bedrock)──
const runAdvisorMock = vi.fn();
vi.mock("../advisor-agent", () => ({
  runAdvisorAgent: (req: unknown, history: unknown) => runAdvisorMock(req, history),
}));

// ── mock environment-probe:进程内 advise() 在 agent.state.facts 缺失时会兜底探一次 ──
const probeMock = vi.fn<() => Promise<EnvironmentFacts>>();
vi.mock("../environment-probe", () => ({
  probeEnvironment: () => probeMock(),
}));

import { advise } from "../index";

// ── 事实构造(对齐 skills-handler.test.ts 风格)──
function sg(groupId: string, opts: Partial<SecurityGroupFact> = {}): SecurityGroupFact {
  return { groupId, vpcId: "vpc-1", name: groupId, ingress: [], egress: [], ...opts };
}
function subnet(id: string, opts: Partial<SubnetFact> = {}): SubnetFact {
  return { subnetId: id, vpcId: "vpc-1", az: "us-east-1a", cidr: "10.0.1.0/24", isPublic: false, routesToIgw: false, routesToNat: true, freeIps: 200, ...opts };
}
function vpc(opts: Partial<VpcFact> = {}): VpcFact {
  return {
    vpcId: "vpc-1", cidr: "10.0.0.0/16", isDefault: false, dnsSupport: true, dnsHostnames: true,
    azs: ["us-east-1a"], natGatewayAzs: ["us-east-1a"], hasIgw: false,
    subnets: [subnet("subnet-a")], securityGroups: [sg("sg-c")], endpoints: [], nacls: [], peerings: [], tgwAttachments: [],
    ...opts,
  };
}
function facts(): EnvironmentFacts {
  return {
    region: "us-east-1", vpcs: [vpc()],
    targets: [{ target: { kind: "rds", instanceId: "db1" }, vpcId: "vpc-1", port: 3306, azs: ["us-east-1a"], securityGroupIds: ["sg-db"], endpointModel: "in-vpc", discoverable: true }],
    degraded: false, missing: [], capturedAt: "2026-07-01T00:00:00Z",
  };
}
const req: PlacedConnectivityRequest = { computeKind: "glue", targets: [{ kind: "rds", instanceId: "db1" }], targetId: "tgt_home", region: "us-east-1" };

const OLD_ENV = process.env.NETADVISOR_BACKEND;
beforeEach(() => {
  invokeMock.mockReset();
  runAdvisorMock.mockReset();
  probeMock.mockReset();
  configuredMock.mockReturnValue(true);
});
afterEach(() => { process.env.NETADVISOR_BACKEND = OLD_ENV; });

describe("advise() 后端开关 + 回退兜底", () => {
  it("agentcore 成功 → backend=agentcore,直用容器结构化结果", async () => {
    process.env.NETADVISOR_BACKEND = "agentcore";
    invokeMock.mockResolvedValue({
      reasoning: "容器给的结论",
      verdict: "reachable",
      rulings: [{ ruleId: "ROUTE", title: "路由", status: "PASS", detail: "ok", forTargetIndex: 0, remediationType: "add-route-to-target-cidr" }],
      remediations: [],
      candidates: [{ placement: { vpcId: "vpc-1", subnetIds: ["subnet-a"], securityGroupIds: ["sg-c"], availabilityZones: ["us-east-1a"], rationale: "x" }, score: 90, reason: "同VPC" }],
      chosenPlacement: { vpcId: "vpc-1", subnetIds: ["subnet-a"], securityGroupIds: ["sg-c"], availabilityZones: ["us-east-1a"], rationale: "x" },
      facts: { degraded: false },
      llmAvailable: true,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const rec = await advise(req, [], { conversationId: "c1" });
    expect(rec.backend).toBe("agentcore");
    expect(rec.verdict).toBe("reachable");
    expect(rec.reasoning).toBe("容器给的结论");
    expect(rec.prefill).toBeTruthy(); // 平台补的 prefill(reachable + 有 placement)
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(runAdvisorMock).not.toHaveBeenCalled(); // 未走进程内
  });

  it("agentcore 抛错 → 自动回退进程内,backend=inprocess,仍出确定性结果", async () => {
    process.env.NETADVISOR_BACKEND = "agentcore";
    invokeMock.mockRejectedValue(new Error("Runtime 冷启动超时"));
    // 进程内 L3 返回(降级也算数):facts + 空 rulings,让 index 用真实 L2 重裁决。
    runAdvisorMock.mockResolvedValue({
      reasoning: "进程内确定性结论",
      state: { facts: facts(), rulings: [], chosenPlacement: null },
      usage: { inputTokens: 5, outputTokens: 5 },
      llmAvailable: false,
    });
    const rec = await advise(req, [], { conversationId: "c1" });
    expect(rec.backend).toBe("inprocess"); // 铁证:回退后如实标 inprocess
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(runAdvisorMock).toHaveBeenCalledOnce(); // 确实走了进程内回退
    expect(rec.verdict).toBeTruthy(); // 仍有确定性裁决结论
    expect(rec.facts.vpcs.length).toBeGreaterThan(0);
  });

  it("未启用 agentcore(默认) → 直接走进程内,不碰 Runtime", async () => {
    process.env.NETADVISOR_BACKEND = "inprocess";
    runAdvisorMock.mockResolvedValue({
      reasoning: "进程内结论",
      state: { facts: facts(), rulings: [], chosenPlacement: null },
      usage: { inputTokens: 5, outputTokens: 5 },
      llmAvailable: true,
    });
    const rec = await advise(req, []);
    expect(rec.backend).toBe("inprocess");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(runAdvisorMock).toHaveBeenCalledOnce();
  });

  it("agentcore 已配但 isAgentCoreConfigured=false → 走进程内", async () => {
    process.env.NETADVISOR_BACKEND = "agentcore";
    configuredMock.mockReturnValue(false); // RUNTIME_ARN 未配
    runAdvisorMock.mockResolvedValue({
      reasoning: "进程内结论",
      state: { facts: facts(), rulings: [], chosenPlacement: null },
      usage: { inputTokens: 5, outputTokens: 5 },
      llmAvailable: true,
    });
    const rec = await advise(req, []);
    expect(rec.backend).toBe("inprocess");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
