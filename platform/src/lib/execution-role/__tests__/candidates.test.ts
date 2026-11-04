// 下拉候选:ListRoles 分页全量 → 信任该引擎服务主体者入选 → 三组;平台内部角色不列;平台默认恒在。
// 只 mock 真外部(IAM 客户端)与落点解析器(它读注册表 / env);信任解析是本目录的纯函数,不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ pages: [] as Array<{ Roles: unknown[]; IsTruncated?: boolean; Marker?: string }>, calls: [] as unknown[] }));

vi.mock("@aws-sdk/client-iam", () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    IAMClient: class {
      constructor(public cfg: Record<string, unknown>) {}
      async send(c: { constructor: { name: string }; input: Record<string, unknown> }) {
        h.calls.push(c.input);
        const idx = c.input.Marker ? Number(c.input.Marker) : 0;
        return h.pages[idx];
      }
    },
    ListRolesCommand: class ListRolesCommand extends Cmd {},
    GetRoleCommand: class GetRoleCommand extends Cmd {},
    SimulatePrincipalPolicyCommand: class SimulatePrincipalPolicyCommand extends Cmd {},
  };
});
vi.mock("@/lib/exec-env/data-plane-target", () => ({
  resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-west-2", roleArn: `arn:aws:iam::123456789012:role/BgpExecEnv-${targetId.replace(/_/g, "-")}-glue-role`, scriptsBucket: "b", datalakeBucket: "d", tableBucket: "t", home: false, jurisdiction: "home" }),
  resolveEmrBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-west-2", roleArn: "x", executionRoleArn: `arn:aws:iam::123456789012:role/BgpExecEnv-${targetId.replace(/_/g, "-")}-emr-role`, scriptsBucket: "b", datalakeBucket: "d", tableBucket: "t", home: false, jurisdiction: "home" }),
}));
vi.mock("@/lib/realtime/flink-place", () => ({
  resolveFlinkPlace: async (targetId: string) => ({ targetId, region: "us-west-2", roleArn: "arn:aws:iam::123456789012:role/bgp-flink-role", codeBucket: "c" }),
}));
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "us-east-1" }));

import { listExecutionRoleCandidates, classifyRole, platformDefaultRoleArn } from "../candidates";
import { trustsService } from "../trust";

const trust = (svc: string | string[]) => encodeURIComponent(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: svc }, Action: "sts:AssumeRole" }] }));
const role = (name: string, doc: string, extra: Record<string, unknown> = {}) => ({ RoleName: name, Arn: `arn:aws:iam::123456789012:role/${name}`, Path: "/", AssumeRolePolicyDocument: doc, CreateDate: new Date("2026-11-03T00:00:00Z"), ...extra });

beforeEach(() => { h.pages = []; h.calls = []; });

describe("trustsService(URL 编码的信任策略)", () => {
  it("Allow + sts:AssumeRole + Principal.Service 含该服务 ⇒ true;数组 / sts:* 也认;Deny / 别的服务 / 坏文档 ⇒ false", () => {
    expect(trustsService(trust("glue.amazonaws.com"), "glue.amazonaws.com")).toBe(true);
    expect(trustsService(trust(["ec2.amazonaws.com", "glue.amazonaws.com"]), "glue.amazonaws.com")).toBe(true);
    expect(trustsService(encodeURIComponent(JSON.stringify({ Statement: { Effect: "Allow", Principal: { Service: "glue.amazonaws.com" }, Action: ["sts:*"] } })), "glue.amazonaws.com")).toBe(true);
    expect(trustsService(trust("ec2.amazonaws.com"), "glue.amazonaws.com")).toBe(false);
    expect(trustsService(encodeURIComponent(JSON.stringify({ Statement: [{ Effect: "Deny", Principal: { Service: "glue.amazonaws.com" }, Action: "sts:AssumeRole" }] })), "glue.amazonaws.com")).toBe(false);
    expect(trustsService("%7Bnot-json", "glue.amazonaws.com")).toBe(false);
    expect(trustsService(undefined, "glue.amazonaws.com")).toBe(false);
  });
});

describe("classifyRole", () => {
  const platform = "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-a-glue-role";
  it("平台默认恒 platform(哪怕名字是内部形态);bgp-job-role-* ⇒ advisor;BgpExecEnv-* / Bgp*Stack-* / bgp-* / 服务关联角色 ⇒ 不列;其余 custom", () => {
    expect(classifyRole({ arn: platform, name: "BgpExecEnv-tgt-usw2-a-glue-role" }, platform)).toBe("platform");
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/bgp-job-role-glue1", name: "bgp-job-role-glue1" }, platform)).toBe("advisor");
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-use1-a-glue-role", name: "BgpExecEnv-tgt-use1-a-glue-role" }, platform)).toBeNull();
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/BgpPlatformStack-TaskRoleABC", name: "BgpPlatformStack-TaskRoleABC" }, platform)).toBeNull();
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/bgp-glue-role", name: "bgp-glue-role" }, platform)).toBeNull();
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/aws-service-role/x", name: "AWSServiceRoleForX", path: "/aws-service-role/" }, platform)).toBeNull();
    expect(classifyRole({ arn: "arn:aws:iam::123456789012:role/customer-glue-role", name: "customer-glue-role" }, platform)).toBe("custom");
  });
});

describe("listExecutionRoleCandidates", () => {
  it("分页读全;只留信任 glue 的;分组;平台默认在 platform 组;自建按名排序;total / fetchedAt 齐", async () => {
    h.pages = [
      { Roles: [
        role("customer-glue-role-b", trust("glue.amazonaws.com")),
        role("customer-emr-only", trust("emr-serverless.amazonaws.com")),
        role("bgp-job-role-glue1", trust("glue.amazonaws.com"), { Description: "advisor made" }),
        role("BgpExecEnv-tgt-use1-a-glue-role", trust("glue.amazonaws.com")),
      ], IsTruncated: true, Marker: "1" },
      { Roles: [
        role("customer-glue-role-a", trust(["glue.amazonaws.com", "ec2.amazonaws.com"])),
        role("BgpExecEnv-tgt-usw2-a-glue-role", trust("glue.amazonaws.com")),
      ] },
    ];
    const out = await listExecutionRoleCandidates({ engine: "glue", targetId: "tgt_usw2_a" });
    expect(h.calls.length).toBe(2);
    expect(out.servicePrincipal).toBe("glue.amazonaws.com");
    expect(out.groups.platform.map((r) => r.name)).toEqual(["BgpExecEnv-tgt-usw2-a-glue-role"]);
    expect(out.groups.advisor.map((r) => r.name)).toEqual(["bgp-job-role-glue1"]);
    expect(out.groups.advisor[0].description).toBe("advisor made");
    expect(out.groups.custom.map((r) => r.name)).toEqual(["customer-glue-role-a", "customer-glue-role-b"]);
    expect(out.total).toBe(4);
    expect(out.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ListRoles 没回平台默认角色 ⇒ platform 组仍由落点解析补上(「留空」的实名永远有)", async () => {
    h.pages = [{ Roles: [role("customer-flink-role", trust("kinesisanalytics.amazonaws.com"))] }];
    const out = await listExecutionRoleCandidates({ engine: "flink", targetId: "tgt_home" });
    expect(out.groups.platform).toEqual([{ arn: "arn:aws:iam::123456789012:role/bgp-flink-role", name: "bgp-flink-role", kind: "platform" }]);
    expect(out.groups.custom.map((r) => r.name)).toEqual(["customer-flink-role"]);
  });

  it("platformDefaultRoleArn 按引擎走各自的落点解析器(glue / emr / flink)", async () => {
    expect(await platformDefaultRoleArn("glue", "tgt_usw2_a")).toContain("-glue-role");
    expect(await platformDefaultRoleArn("emr", "tgt_usw2_a")).toContain("-emr-role");
    expect(await platformDefaultRoleArn("flink", "tgt_home")).toContain("bgp-flink-role");
  });
});
