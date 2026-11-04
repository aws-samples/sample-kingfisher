// 候选区按「组织 SCP 是否拦住部署必需动作」分出 blocked。钉住用户可见的结果
//   · 组织层显式拒(AllowedByOrganizations=false)的区 ⇒ 不在 available,列进 blocked 且点名被拦的动作与拒因层;
//   · 正控制:没被拦的区照样可选(换到没有这条 SCP 的账号,同一段代码自动放回)—— **不写死任何区名**;
//   · 字段缺失 / null ≠ 被拦(只认显式 false);
//   · 量具坏了(读不到部署身份 / 某区模拟失败)⇒ unverified,**不**把区判死、也不装作量过;
//   · 模拟的是**部署身份**(CodeBuild 项目的 serviceRole),不是平台自己;
//   · 探测动作清单覆盖 buildspec 部署路径上的每个区域性 aws 调用(闭合核对,少一个 = 那个动作被拦时看不见)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  serviceRole: "arn:aws:iam::123456789012:role/BgpExecEnvDeployStack-ExecEnvBuildRoleA1-Xyz" as string | undefined,
  cbFails: false,
  /** region → 被组织拦的动作;"throw" = 该区每次都限流;"denied" = 无权限(非限流);"missing" = 字段缺失 */
  orgDeny: {} as Record<string, string[] | "throw" | "denied" | "missing">,
  /** region → 前 N 次限流,之后照 orgDeny 回 */
  throttleFirst: {} as Record<string, number>,
  sims: [] as any[],
  /** 构造时给的配置:判「有没有被塞数据面角色凭证」 */
  ctors: [] as Array<{ svc: string; hasCreds: boolean }>,
  regions: ["ap-northeast-1", "eu-west-1", "us-east-1", "us-west-2"],
  targets: [] as any[],
}));

vi.mock("@aws-sdk/client-codebuild", async (orig) => {
  const real: any = await orig();
  class FakeCb {
    constructor(cfg?: any) { h.ctors.push({ svc: "codebuild", hasCreds: cfg?.credentials !== undefined }); }
    async send(cmd: any) {
      if (cmd.constructor.name !== "BatchGetProjectsCommand") throw new Error(`未预期:${cmd.constructor.name}`);
      if (h.cbFails) throw Object.assign(new Error("not authorized arn:aws:iam::123456789012:role/x"), { name: "AccessDeniedException" });
      return { projects: [{ name: cmd.input.names[0], serviceRole: h.serviceRole }] };
    }
  }
  return { ...real, CodeBuildClient: FakeCb };
});
vi.mock("@aws-sdk/client-iam", async (orig) => {
  const real: any = await orig();
  class FakeIam {
    constructor(cfg?: any) { h.ctors.push({ svc: "iam", hasCreds: cfg?.credentials !== undefined }); }
    async send(cmd: any) {
      if (cmd.constructor.name !== "SimulatePrincipalPolicyCommand") throw new Error(`未预期:${cmd.constructor.name}`);
      h.sims.push(cmd.input);
      const region = cmd.input.ContextEntries.find((c: any) => c.ContextKeyName === "aws:RequestedRegion").ContextKeyValues[0];
      const d = h.orgDeny[region];
      if ((h.throttleFirst[region] ?? 0) > 0) {
        h.throttleFirst[region]--;
        throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" });
      }
      if (d === "throw") throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" });
      if (d === "denied") throw Object.assign(new Error("not authorized to perform iam:SimulatePrincipalPolicy"), { name: "AccessDenied" });
      return {
        EvaluationResults: cmd.input.ActionNames.map((a: string) => ({
          EvalActionName: a,
          EvalDecision: Array.isArray(d) && d.includes(a) ? "explicitDeny" : "implicitDeny",
          ...(d === "missing" ? {} : { OrganizationsDecisionDetail: { AllowedByOrganizations: !(Array.isArray(d) && d.includes(a)) } }),
        })),
        IsTruncated: false,
      };
    }
  }
  return { ...real, IAMClient: FakeIam };
});
vi.mock("@aws-sdk/client-ec2", async (orig) => {
  const real: any = await orig();
  class FakeEc2 {
    async send() { return { Regions: h.regions.map((RegionName) => ({ RegionName })) }; }
  }
  return { ...real, EC2Client: FakeEc2 };
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return { ...real, docClient: { send: async () => ({ Items: h.targets }) } };
});
vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: async () => ({ username: "admin", isPlatformAdmin: true }) }));

import { classifyRegionsByOrgPolicy, DEPLOY_PROBE_ACTIONS, DEPLOY_PROBE_EXCLUDED } from "../region-org-block";
import { GET } from "@/app/api/admin/exec-envs/candidate-regions/route";

beforeEach(() => {
  h.serviceRole = "arn:aws:iam::123456789012:role/BgpExecEnvDeployStack-ExecEnvBuildRoleA1-Xyz";
  h.cbFails = false;
  h.orgDeny = {};
  h.throttleFirst = {};
  h.sims = [];
  h.ctors = [];
  delete process.env.BGP_DATAPLANE_CREDS;
  h.targets = [{ pk: "env", sk: "tgt_home", targetId: "tgt_home", region: "us-east-1", status: "active" }];
});

describe("组织策略分类(SimulatePrincipalPolicy 的组织层裁决)", () => {
  it("显式 false ⇒ blocked 并点名动作;其它区放行(正控制);模拟的是部署身份", async () => {
    h.orgDeny = { "ap-northeast-1": ["s3tables:ListTableBuckets", "cloudformation:CreateStack"] };
    const v = await classifyRegionsByOrgPolicy(["ap-northeast-1", "us-west-2", "eu-west-1"]);
    expect(v.blocked.map((b) => b.region)).toEqual(["ap-northeast-1"]);
    expect(v.blocked[0].actions).toEqual(["cloudformation:CreateStack", "s3tables:ListTableBuckets"]);
    expect(v.blocked[0].layer).toBe("organizations-scp");
    expect(v.blocked[0].reason).toMatch(/SCP/);
    expect(v.unverified).toEqual([]);
    expect(h.sims.every((s) => s.PolicySourceArn === h.serviceRole)).toBe(true);
    expect(v.principal).toBe("BgpExecEnvDeployStack-ExecEnvBuildRoleA1-Xyz"); // 不回带账号号的完整 ARN
  });

  it("字段缺失 ≠ 被拦;implicitDeny(我方策略没给)也不算组织拦", async () => {
    h.orgDeny = { "eu-west-1": "missing" };
    const v = await classifyRegionsByOrgPolicy(["eu-west-1", "us-west-2"]);
    expect(v.blocked).toEqual([]);
  });

  it("量具坏了 ⇒ unverified(不判死、不装作量过):读不到部署身份 ⇒ 全部;某区限流 ⇒ 只那一区", async () => {
    h.cbFails = true;
    const v1 = await classifyRegionsByOrgPolicy(["eu-west-1", "us-west-2"]);
    expect(v1.blocked).toEqual([]);
    expect(v1.unverified.map((u) => u.region)).toEqual(["eu-west-1", "us-west-2"]);
    expect(v1.unverified[0].reason).not.toContain("123456789012");
    h.cbFails = false;
    h.orgDeny = { "eu-west-1": "throw" };
    const sleeps: number[] = [];
    const v2 = await classifyRegionsByOrgPolicy(["eu-west-1", "us-west-2"], { sleep: async (ms) => { sleeps.push(ms); } });
    expect(v2.unverified.map((u) => u.region)).toEqual(["eu-west-1"]);
    // 有界:一直限流 ⇒ 第一遍 6 次 + 冷却 1 次 + 串行补查 6 次就停,不无限重试
    expect(h.sims.filter((x) => x.ContextEntries[0].ContextKeyValues[0] === "eu-west-1")).toHaveLength(12);
    expect(sleeps).toHaveLength(11);
    expect(sleeps.every((ms) => ms >= 0 && ms <= 4000)).toBe(true);
  });

  it("🔴 第一遍预算用完仍限流的区 ⇒ 冷却后串行补查一遍:被拦的照实 blocked、放行的可选,都不落进 unverified", async () => {
    h.orgDeny = { "sa-east-1": ["s3tables:ListTableBuckets"] };
    h.throttleFirst = { "sa-east-1": 8, "eu-west-2": 7 };
    const v = await classifyRegionsByOrgPolicy(["sa-east-1", "eu-west-2", "us-west-2"], { sleep: async () => {} });
    expect(v.unverified).toEqual([]);
    expect(v.blocked.map((b) => b.region)).toEqual(["sa-east-1"]);
    // 补查是串行的:第二遍里两区的模拟不交错(先补完一个再补下一个)
    //   sa-east-1 剩 2 次限流 + 1 次成功 = 3 次,eu-west-2 剩 1 + 1 = 2 次 ⇒ 最后 5 次模拟里区名只切换一次
    const second = h.sims.slice(-5).map((x) => x.ContextEntries[0].ContextKeyValues[0]);
    expect(new Set(second)).toEqual(new Set(["sa-east-1", "eu-west-2"]));
    expect(second.filter((r, i) => i > 0 && r !== second[i - 1])).toHaveLength(1);
  });

  it("🔴 限流几次后放行 ⇒ 照实分类(被拦的区仍是 blocked、放行的区可选),不落进 unverified", async () => {
    h.orgDeny = { "ap-northeast-1": ["cloudformation:CreateStack"] };
    h.throttleFirst = { "ap-northeast-1": 3, "us-west-2": 2 };
    const v = await classifyRegionsByOrgPolicy(["ap-northeast-1", "us-west-2"], { sleep: async () => {} });
    expect(v.unverified).toEqual([]);
    expect(v.blocked.map((b) => b.region)).toEqual(["ap-northeast-1"]);
  });

  it("只重试限流:无权限这类失败重试不会变 ⇒ 立刻 unverified、只模拟一次", async () => {
    h.orgDeny = { "eu-west-1": "denied" };
    const sleeps: number[] = [];
    const v = await classifyRegionsByOrgPolicy(["eu-west-1"], { sleep: async (ms) => { sleeps.push(ms); } });
    expect(v.unverified.map((u) => u.region)).toEqual(["eu-west-1"]);
    expect(h.sims).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("退避是 full jitter(同一批并发不齐步重撞):同一档位的等待时长不全相同", async () => {
    h.orgDeny = { "eu-west-1": "throw", "eu-west-2": "throw", "eu-west-3": "throw" };
    const sleeps: number[] = [];
    await classifyRegionsByOrgPolicy(["eu-west-1", "eu-west-2", "eu-west-3"], { sleep: async (ms) => { sleeps.push(ms); } });
    // 第一档(n=0)的上限是 250ms:固定退避会恰好全是 250;full jitter 是 [0,250) 里各不相同的随机数
    const tier0 = sleeps.filter((x) => x <= 250);
    expect(tier0.length).toBeGreaterThanOrEqual(3);
    expect(tier0.every((x) => x === 250)).toBe(false);
    expect(new Set(tier0).size).toBeGreaterThan(1);
  });

  it.each(["observe", "enforce"])("🔴 %s 下探测仍用任务角色(控制面):CodeBuild / IAM 客户端不带数据面角色凭证,每区只模拟一次", async (mode) => {
    process.env.BGP_DATAPLANE_CREDS = mode;
    try {
      const v = await classifyRegionsByOrgPolicy(["eu-west-1", "us-west-2"], { sleep: async () => {} });
      expect(v.unverified).toEqual([]);
      expect(h.ctors.map((c) => c.svc).sort()).toEqual(["codebuild", "iam"]);
      expect(h.ctors.filter((c) => c.hasCreds)).toEqual([]);
      expect(h.sims).toHaveLength(2);
    } finally {
      delete process.env.BGP_DATAPLANE_CREDS;
    }
  });

  it("候选区路由:被拦的区不在 available、列进 blocked;已占的区不去量;没拦的区可选", async () => {
    h.orgDeny = { "ap-northeast-1": ["s3tables:ListTableBuckets"] };
    const res = await GET(new NextRequest("http://x/api/admin/exec-envs/candidate-regions"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.available).toEqual(["eu-west-1", "us-west-2"]);
    expect(body.data.blocked).toEqual([expect.objectContaining({ region: "ap-northeast-1", actions: ["s3tables:ListTableBuckets"] })]);
    // us-east-1 已被主控区占 ⇒ 不为它多打模拟
    const simulated = h.sims.map((s) => s.ContextEntries[0].ContextKeyValues[0]).sort();
    expect(simulated).toEqual(["ap-northeast-1", "eu-west-1", "us-west-2"]);
  });

  it("探测动作清单覆盖 buildspec 部署路径上的每个区域性 aws 调用(闭合:要么在清单里,要么在排除表里写明理由)", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bs = readFileSync(resolve(HERE, "../../../../../infra/buildspec/exec-env-deploy.yml"), "utf8");
    const pascal = (op: string) => op.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    const used = new Set<string>();
    for (const m of bs.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)) used.add(`${m[1]}:${pascal(m[2])}`);
    // 销毁才用的删除动作(s3tables:DeleteTableBucket 是孤儿清理,只在 core 栈不存在时;它被拦不影响「能不能部署」)
    used.delete("s3tables:DeleteTableBucket");
    expect(used.size, "从 buildspec 里一个 aws 调用都没抽到 ⇒ 判据空转").toBeGreaterThanOrEqual(6);
    const known = new Set<string>([...DEPLOY_PROBE_ACTIONS, ...Object.keys(DEPLOY_PROBE_EXCLUDED)]);
    const missing = [...used].filter((a) => !known.has(a)).sort();
    expect(missing, `buildspec 部署路径用了这些动作,候选区探测清单却没有:${missing.join(", ")}`).toEqual([]);
  });
});
