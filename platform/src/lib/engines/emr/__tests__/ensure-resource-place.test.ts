// 🔴🔴 (2026-10-01,落点观测器在第九轮全量硬门里实测抓到):
//   EMR 作业创建路由 `provider.ensureResource(item)` → `ensureApplication(job)` **不带落点** ⇒ 给 us-west-2 建的作业
//   在**主控区**先建出一个 EMR application(观测记录:`emr-serverless POST /applications @ us-east-1` + `ec2 @ us-east-1`,
//   本次请求的显式决策是 tgt_usw2_a)⇒ 主控区多一个孤儿 application、作业的 applicationId 记在主控区名下。
// 装配层:provider ↔ application ↔ data-plane-target(落点作者)之间不 mock;只替换真外部 ——
//   EMR 客户端工厂(记录区与命令)、注册表(描述符)、主控区默认网络(EC2 边界)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as { region: string; cmd: string; input: any }[] }));

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    emrServerlessClientFor: async (region: string) => ({
      send: async (cmd: any) => {
        h.calls.push({ region, cmd: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "CreateApplicationCommand") return { applicationId: `app-${region}` };
        return {};
      },
    }),
  };
});

vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  // 🔴 角色名从命名 SSOT 派生(手写 `glue-usw2` 会被 SPEC §6.1 per-target 角色硬门正确拒绝 —— 第一版夹具就是这么红的)
  const { resourceName } = await import("@/lib/aws/naming");
  const role = (kind: string) => `arn:aws:iam::000000000000:role/${resourceName(kind, { targetId: "tgt_usw2_a", account: "000000000000" })}`;
  const USW2 = {
    targetId: "tgt_usw2_a", region: "us-west-2", accountId: "000000000000", partition: "aws", status: "active", ready: true,
    components: ["core", "redshift"],
    resources: {
      scriptsBucket: "scripts-usw2", datalakeBucket: "dl-usw2", tableBucket: "tb-usw2", athenaWorkgroup: "wg",
      glueRoleArn: role("glueRole"), emrSecurityGroupId: "sg-usw2", emrSubnetIds: ["subnet-usw2-a", "subnet-usw2-b"],
      emrExecutionRoleArn: role("emrServerlessRole"),
    },
  };
  return { ...real, requireReadyTarget: vi.fn(async (id: string) => (id === "tgt_usw2_a" ? USW2 : real.requireReadyTarget(id))) };
});

vi.mock("@/lib/engines/platform-env", () => ({
  getEmrDefaultNetwork: vi.fn(async () => ({ subnetIds: ["subnet-home"], securityGroupIds: ["sg-home"] })),
}));

import { emrServerlessProvider } from "../provider";
import { applicationFields, applicationIdOf, allApplicationRefs } from "../application";

const job = (targets: string[]) => ({ jobId: "01JOBJOBJOBJOBJOBJOBJOBJOB", engine: "emr-serverless", targets, spec: {} }) as any;
const creates = () => h.calls.filter((c) => c.cmd === "CreateApplicationCommand");

describe("🔴🔴 建 EMR 作业时,application 建在**作业绑定的区**(不是主控区)", () => {
  beforeEach(() => { h.calls.length = 0; process.env.AWS_REGION = "us-east-1"; });

  it("只绑 us-west-2 ⇒ 只在 us-west-2 建一个、用该区描述符的子网 / SG;主控区一次都不碰", async () => {
    const r = await emrServerlessProvider.ensureResource(job(["tgt_usw2_a"]));
    expect(r).toEqual({ tgt_usw2_a: "app-us-west-2" });
    expect(creates().map((c) => c.region)).toEqual(["us-west-2"]);
    expect(h.calls.every((c) => c.region === "us-west-2"), "主控区不许有任何 EMR 调用").toBe(true);
    expect(creates()[0].input.networkConfiguration).toEqual({ subnetIds: ["subnet-usw2-a", "subnet-usw2-b"], securityGroupIds: ["sg-usw2"] });
    expect(creates()[0].input.tags["bgp:targetId"]).toBe("tgt_usw2_a");
  });

  it("绑两个区 ⇒ 各建一个、各用各的网络", async () => {
    const r = await emrServerlessProvider.ensureResource(job(["tgt_home", "tgt_usw2_a"]));
    expect(r).toEqual({ tgt_home: "app-us-east-1", tgt_usw2_a: "app-us-west-2" });
    const net = Object.fromEntries(creates().map((c) => [c.region, c.input.networkConfiguration.subnetIds[0]]));
    expect(net).toEqual({ "us-east-1": "subnet-home", "us-west-2": "subnet-usw2-a" });
  });

  it("负向对照(判别力):只绑主控区 ⇒ 只在主控区建(证明上面不是「怎么建都在 us-west-2」)", async () => {
    expect(await emrServerlessProvider.ensureResource(job(["tgt_home"]))).toEqual({ tgt_home: "app-us-east-1" });
    expect(creates().map((c) => c.region)).toEqual(["us-east-1"]);
  });

  it("投影回作业行:主控区写老字段、其余进 applicationIdByTarget ⇒ 读侧(applicationIdOf / allApplicationRefs)认得", () => {
    const fields = applicationFields({ tgt_home: "a-home", tgt_usw2_a: "a-usw2" });
    expect(fields).toEqual({ applicationId: "a-home", applicationIdByTarget: { tgt_usw2_a: "a-usw2" } });
    const row = { ...job(["tgt_home", "tgt_usw2_a"]), ...fields };
    expect(applicationIdOf(row, "tgt_usw2_a")).toBe("a-usw2");
    expect(applicationIdOf(row, "tgt_home")).toBe("a-home");
    expect(allApplicationRefs(row).map((x) => x.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(applicationFields({ tgt_usw2_a: "a-usw2" }), "只绑别的区 ⇒ 不许写主控区老字段").toEqual({ applicationIdByTarget: { tgt_usw2_a: "a-usw2" } });
  });
});
