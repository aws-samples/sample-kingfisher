// @kf-batch 50-WP16-zero-egress(退役 K-5 网络规模)
// 🔴 **本文件从「链路守卫」翻转成「退役守卫」**。
//   原来它钉的是:注册表 networkProfile → broker env `EXEC_ENV_NAT_GATEWAYS` → buildspec / p0e-gate
//   `-c exec-env-nat-gateways` → context.ts 这条链不许断。WP-16 之后执行环境零出网、NAT 恒为 0,
//   这条链**整条退役** ⇒ 现在要钉的是**它不许复活**,以及退役退得干净(残留半条链比没有更危险:
//   buildspec 传一个 context.ts 会抛的入参 = 每次部署都炸在第一步)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_PROFILES, isNetworkProfile } from "@/lib/exec-env/network-profile";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

describe("K-5 网络规模:只剩「读得懂存量描述符」", () => {
  it("值域与类型守卫保留(registry 的 zod 还要认存量值),但**不再导出任何会产生行为的东西**", () => {
    expect([...NETWORK_PROFILES]).toEqual(["standard", "economy"]);
    expect(isNetworkProfile("economy")).toBe(true);
    expect(isNetworkProfile("eco")).toBe(false);
    const src = read("platform/src/lib/exec-env/network-profile.ts");
    // 🔴 先剥注释再做负向断言(本仓反复踩:解释性注释里就写着被禁标识符)
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const dead of ["NETWORK_PROFILE_NAT", "natGatewaysOf", "NETWORK_PROFILE_LABEL", "DEFAULT_NETWORK_PROFILE"]) {
      expect(code, `${dead} 复活了 —— 留着 NAT 映射/文案就等于留一个「可以再开 NAT」的口子`).not.toContain(dead);
    }
  });
});

describe("🔴 退役守卫:NAT 链路不许复活,且退得干净", () => {
  it("broker / buildspec / p0e-gate 里不许再出现 NAT 入参(残留半条链 = 每次部署炸在第一步)", () => {
    for (const rel of [
      "infra/lambda/exec-env-broker/index.mjs",
      "infra/buildspec/exec-env-deploy.yml",
      "infra/scripts/p0e-gate.mjs",
    ]) {
      const code = read(rel)
        .split("\n")
        .filter((l) => !/^\s*(#|\/\/|\*)/.test(l))
        .join("\n");
      expect(code, `${rel} 仍在传 exec-env-nat-gateways`).not.toContain("exec-env-nat-gateways");
      expect(code, `${rel} 仍在注入 EXEC_ENV_NAT_GATEWAYS`).not.toContain("EXEC_ENV_NAT_GATEWAYS");
      expect(code, `${rel} 仍有 NETWORK_PROFILE_NAT 映射`).not.toContain("NETWORK_PROFILE_NAT");
    }
  });

  it("context.ts:natGateways 从类型里删除,且收到该入参必须**抛**(不是忽略)", () => {
    const src = read("infra/lib/exec-env/context.ts");
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code, "ExecEnvContext 里还留着 natGateways 字段").not.toMatch(/natGateways\s*:/);
    // 抛的那条在代码里(不是注释里)
    expect(code).toContain('str(get("exec-env-nat-gateways")) !== undefined');
    expect(code).toContain("已退役");
  });

  it("base 栈:NAT 恒 0、私有子网走单一真值(PRIVATE_ISOLATED),公有层 reserved 不建子网", () => {
    const code = read("infra/lib/exec-env/base-stack.ts")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("natGateways: 0");
    expect(code).toContain("EXEC_ENV_PRIVATE_SUBNET_TYPE");
    expect(code).toContain("reserved: true");
    // 🔴 不许再出现带 NAT 出网的子网类型(选不中时 selectSubnets 静默返回空集,漏改一处的症状离根因极远)
    expect(code).not.toContain("PRIVATE_WITH_EGRESS");
  });

  it("两条退役路由都回 410 GONE,并且仍然过管理员守卫(不给退役件在门禁上开豁免口子)", () => {
    for (const rel of [
      "platform/src/app/api/admin/exec-envs/preflight/route.ts",
      "platform/src/app/api/admin/exec-envs/[targetId]/network-profile/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toContain("410");
      expect(src).toContain('code: "GONE"');
      expect(src).toContain("await requireExecEnvAdmin(req)");
    }
  });

  it("向导不再有网络规模单选与 EIP 预检,改成零出网只读说明", () => {
    const src = read("platform/src/app/exec-envs/CreateWizard.tsx");
    expect(src).not.toContain("wizard-network-profile");
    expect(src).not.toContain("eip-preflight");
    expect(src).toContain("wizard-zero-egress-note");
  });
});
