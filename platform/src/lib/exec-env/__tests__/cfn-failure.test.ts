// `eip-preflight.test.ts` 的继任者:EIP 预检随零出网下线,但 CFN 失败原因翻译器留了下来(见 cfn-failure.ts 的说明)。
import { describe, it, expect } from "vitest";
import { explainCfnFailure, EIP_QUOTA_CODE } from "@/lib/exec-env/cfn-failure";

describe("CFN 失败原因 → 人话", () => {
  it("EIP 上限:带配额码,并指向「重新部署切零出网」这条新出路(不再提「改精简档」——那个档已退役)", () => {
    const out = explainCfnFailure("The maximum number of addresses has been reached.");
    expect(out).toContain(EIP_QUOTA_CODE);
    expect(out).toContain("零出网");
    expect(out).toContain("重新部署");
    // 🔴 负向:退役的措辞不许再出现(否则运维会去找一个已经不存在的开关)
    expect(out).not.toContain("精简");
  });

  it("🆕 跨区端点缺授权:必须点名 vpce:AllowMultiRegion 且说清「通配符策略覆盖不到」", () => {
    const out = explainCfnFailure("User is not authorized to perform: ec2:CreateVpcEndpoint ... vpce:AllowMultiRegion");
    expect(out).toContain("vpce:AllowMultiRegion");
    expect(out).toContain("通配符");
    expect(out).toContain("cdk-hnb659fds-cfn-exec-role");
  });

  it("未知原因原样返回;空 ⇒ undefined", () => {
    expect(explainCfnFailure("Some other CFN reason")).toBe("Some other CFN reason");
    expect(explainCfnFailure(undefined)).toBeUndefined();
    expect(explainCfnFailure("")).toBeUndefined();
  });
});
