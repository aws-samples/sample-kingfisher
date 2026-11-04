// @kf-batch 50-init-region-enablement
import { describe, it, expect } from "vitest";
import { controlPlaneRegions, isControlPlaneRegionEnabled, regionNotEnabledHint } from "@/lib/exec-env/control-plane-regions";

describe("控制面放行 region 清单(init 段 I-4 真因可见化)", () => {
  it("缺 EXECUTION_REGIONS ⇒ 只放行 home(不猜宽)", () => {
    expect(controlPlaneRegions({ AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv)).toEqual(["us-east-1"]);
    expect(isControlPlaneRegionEnabled("us-west-2", { AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("有清单 ⇒ 含 home、去重排序、非法项丢弃", () => {
    const env = { AWS_REGION: "us-east-1", EXECUTION_REGIONS: "us-west-2, us-east-1,usw2,us-west-2" } as NodeJS.ProcessEnv;
    expect(controlPlaneRegions(env)).toEqual(["us-east-1", "us-west-2"]);
    expect(isControlPlaneRegionEnabled("us-west-2", env)).toBe(true);
    expect(isControlPlaneRegionEnabled("eu-west-1", env)).toBe(false);
  });
  it("提示语带 region、当前清单与确切运维命令(redeploy-platform.sh),不带账号号", () => {
    const h = regionNotEnabledHint("us-west-2", { AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv);
    expect(h).toMatch(/控制面尚未放行 region us-west-2/);
    expect(h).toMatch(/当前只放行:us-east-1/);
    expect(h).toMatch(/redeploy-platform\.sh/);
    expect(h).not.toMatch(/\d{12}/);
  });
  // 序 48:提示语必须告诉运维「以后怎么不用每加一区跑一次」—— 候选区预授权的环境变量名要逐字出现(与 scripts/lib/execution-regions.sh 同名)
  it("提示语带候选区预授权的做法(EXEC_REGION_CANDIDATES),不只给一次性的放行命令", () => {
    const h = regionNotEnabledHint("eu-central-1", { AWS_REGION: "ap-southeast-1" } as NodeJS.ProcessEnv);
    expect(h).toMatch(/EXEC_REGION_CANDIDATES=/);
    expect(h).toMatch(/all-enabled/);
  });
  // 序 48:预授权的候选区与注册表在用区在 env 里不可区分,也不该区分 —— IAM 条件里两者同样生效
  it("候选区进了 EXECUTION_REGIONS 就是「已放行」(与注册表在用区同口径)", () => {
    const env = { AWS_REGION: "ap-southeast-1", EXECUTION_REGIONS: "ap-southeast-1,eu-central-1,ap-northeast-1" } as NodeJS.ProcessEnv;
    expect(isControlPlaneRegionEnabled("ap-northeast-1", env)).toBe(true);
    expect(controlPlaneRegions(env)).toEqual(["ap-northeast-1", "ap-southeast-1", "eu-central-1"]);
  });
});
