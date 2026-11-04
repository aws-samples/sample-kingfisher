// 技能 Lambda handler 单测 —— 验证【工具无状态化契约】(标准 §7①)与分发,不碰真实 AWS。
// 策略:vi.mock 掉 environment-probe(唯一调 AWS 的依赖),喂构造的 EnvironmentFacts;裁决/补救/
// 候选选择用【真实模块】(它们是纯函数,已被 connectivity-judge.test.ts 覆盖),从而端到端验证
// handler 的编排骨架与进程内 index.ts advise() 一致。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EnvironmentFacts, SecurityGroupFact, SubnetFact, VpcFact, PlacedConnectivityRequest } from "../types";

// ── mock:把 probeEnvironment 换成返回可控 facts(隔离 AWS)──
const probeMock = vi.fn<() => Promise<EnvironmentFacts>>();
vi.mock("../environment-probe", () => ({
  probeEnvironment: () => probeMock(),
}));

// mock 之后再 import 被测模块(确保 handler 拿到的是 mock 版 probe)。
import { handler, toolNameOf } from "../skills-handler";

// ── 事实构造助手(对齐 connectivity-judge.test.ts 的风格)──
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
    subnets: [subnet("subnet-a")], securityGroups: [], endpoints: [], nacls: [], peerings: [], tgwAttachments: [],
    ...opts,
  };
}
function facts(v: VpcFact[], degraded = false): EnvironmentFacts {
  return {
    region: "us-east-1", vpcs: v,
    targets: [{ target: { kind: "rds", instanceId: "db1" }, vpcId: "vpc-1", port: 3306, azs: ["us-east-1a"], securityGroupIds: ["sg-db"], endpointModel: "in-vpc", discoverable: true }],
    degraded, missing: [], capturedAt: "2026-07-01T00:00:00Z",
  };
}
// 技能 Lambda 只收**已落点**的请求(targetId + 描述符解析出的 region)
const req: PlacedConnectivityRequest = { computeKind: "glue", targets: [{ kind: "rds", instanceId: "db1" }], targetId: "tgt_home", region: "us-east-1" };

// Gateway 编码工具名 "<target>___<tool>" 的 context。
const ctx = (tool: string) => ({ clientContext: { Custom: { bedrockAgentCoreToolName: `netadvisorskills___${tool}` } } });

beforeEach(() => {
  probeMock.mockReset();
});

describe("toolNameOf —— Gateway 工具名解析契约", () => {
  it("解析 <target>___<tool> 取末段", () => {
    expect(toolNameOf(ctx("analyze_connectivity"))).toBe("analyze_connectivity");
    expect(toolNameOf(ctx("inspect_security_group"))).toBe("inspect_security_group");
  });
  it("兼容小写 custom + 无编码裸名 + 缺失", () => {
    expect(toolNameOf({ clientContext: { custom: { bedrockAgentCoreToolName: "analyze_connectivity" } } })).toBe("analyze_connectivity");
    expect(toolNameOf(undefined)).toBe("");
  });
});

describe("analyze_connectivity —— 一条龙确定性分析(工具无状态化)", () => {
  it("正常环境:探一次→裁决→出 verdict + 候选 + 补救 + facts 摘要", async () => {
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [sg("sg-x")] })]));
    const out = await handler({ request: req }, ctx("analyze_connectivity"));

    expect(out.success).toBe(true);
    expect(probeMock).toHaveBeenCalledTimes(1); // 完整 facts 只探一次,活在单次调用内
    expect(out.verdict).toBeTruthy();
    expect(Array.isArray(out.rulings)).toBe(true);
    expect(Array.isArray(out.remediations)).toBe(true);
    expect(Array.isArray(out.candidates)).toBe(true);
    expect(out.facts).toBeTruthy();
  });

  it("facts 摘要【不泄露完整 SG 规则】(只给 ingressCount/egressCount)", async () => {
    const heavySg = sg("sg-x", {
      ingress: [{ protocol: "tcp", fromPort: 3306, toPort: 3306, cidrs: ["10.0.0.0/16"], sgRefs: [], prefixListIds: [] }],
      egress: [{ protocol: "-1", cidrs: ["0.0.0.0/0"], sgRefs: [], prefixListIds: [] }],
    });
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [heavySg] })]));
    const out = await handler({ request: req }, ctx("analyze_connectivity"));

    const summarySg = (out.facts as any).vpcs[0].securityGroups[0];
    expect(summarySg.ingressCount).toBe(1);
    expect(summarySg.egressCount).toBe(1);
    expect(summarySg.ingress).toBeUndefined(); // 完整规则不回模型
    expect(summarySg.egress).toBeUndefined();
  });

  it("空环境 → needs-input + questions", async () => {
    probeMock.mockResolvedValue(facts([]));
    const out = await handler({ request: req }, ctx("analyze_connectivity"));
    expect(out.verdict).toBe("needs-input");
    expect(Array.isArray(out.questions)).toBe(true);
    expect((out.questions as string[]).length).toBeGreaterThan(0);
  });

  it("探测降级 + 本会 reachable → 诚实封顶 unknown", async () => {
    // 目标 SG=sg-x,计算 SG 自引用 + 放行 3306,单 VPC 单 AZ,子网走 NAT → 本应 reachable;degraded 后封顶。
    const computeSg = sg("sg-x", {
      ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-x"], prefixListIds: [] }],
      egress: [{ protocol: "-1", cidrs: ["0.0.0.0/0"], sgRefs: [], prefixListIds: [] }],
    });
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [computeSg] })], true));
    const out = await handler({ request: req, placement: { vpcId: "vpc-1", subnetIds: ["subnet-a"], securityGroupIds: ["sg-x"], availabilityZones: ["us-east-1a"] } }, ctx("analyze_connectivity"));
    expect(out.verdict).not.toBe("reachable"); // degraded 时绝不报 reachable
  });

  it("模型指定 placement 时用它裁决(而非确定性 top1)", async () => {
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [sg("sg-x")] })]));
    const out = await handler(
      { request: req, placement: { vpcId: "vpc-1", subnetIds: ["subnet-a"], securityGroupIds: ["sg-x"], availabilityZones: ["us-east-1a"] } },
      ctx("analyze_connectivity")
    );
    expect((out.chosenPlacement as any)?.vpcId).toBe("vpc-1");
    expect((out.chosenPlacement as any)?.securityGroupIds).toContain("sg-x");
  });
});

describe("inspect_security_group —— 深挖单 SG 完整规则", () => {
  it("找到 → 返回完整 ingress/egress(与摘要相反,这里给全规则)", async () => {
    const full = sg("sg-x", {
      ingress: [{ protocol: "tcp", fromPort: 3306, toPort: 3306, cidrs: ["10.0.0.0/16"], sgRefs: [], prefixListIds: [] }],
    });
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [full] })]));
    const out = await handler({ request: req, groupId: "sg-x" }, ctx("inspect_security_group"));
    expect(out.success).toBe(true);
    expect((out.securityGroup as SecurityGroupFact).ingress).toHaveLength(1);
  });

  it("找不到 → success:false + 错误说明", async () => {
    probeMock.mockResolvedValue(facts([vpc({ securityGroups: [sg("sg-x")] })]));
    const out = await handler({ request: req, groupId: "sg-missing" }, ctx("inspect_security_group"));
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain("sg-missing");
  });

  it("缺 groupId → success:false", async () => {
    probeMock.mockResolvedValue(facts([vpc()]));
    const out = await handler({ request: req }, ctx("inspect_security_group"));
    expect(out.success).toBe(false);
  });
});

describe("handler —— 契约守卫", () => {
  it("缺 request → success:false,不调 probe", async () => {
    const out = await handler({}, ctx("analyze_connectivity"));
    expect(out.success).toBe(false);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("未知工具 → success:false", async () => {
    const out = await handler({ request: req }, ctx("frobnicate"));
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain("unknown tool");
  });

  it("probe 抛错 → 兜成 success:false(不抛出)", async () => {
    probeMock.mockRejectedValue(new Error("EC2 throttled"));
    const out = await handler({ request: req }, ctx("analyze_connectivity"));
    expect(out.success).toBe(false);
    expect(String(out.error)).toContain("throttled");
  });
});
