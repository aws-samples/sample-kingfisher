// 预检扩展:信任策略不含服务主体 ⇒ 当场拒并指路;作业引用的外部桶 GetObject 被拒 ⇒ gap 点名桶 ARN(客户现网那条 403
// 在保存那一刻被量出来);模拟带 aws:RequestedRegion = 落点区;平台默认角色不量。只 mock 真外部(IAM)与落点解析器。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  trustDoc: "" as string,
  denied: new Set<string>(), // `${action}|${resource}`
  getRoleError: null as null | { name: string },
  simulateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-iam", () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    IAMClient: class {
      constructor(public cfg: Record<string, unknown>) {}
      async send(c: { constructor: { name: string }; input: Record<string, unknown> }) {
        const cmd = c.constructor.name;
        if (cmd === "GetRoleCommand") {
          if (h.getRoleError) throw Object.assign(new Error("x"), h.getRoleError);
          return { Role: { Arn: `arn:aws:iam::123456789012:role/${c.input.RoleName}`, AssumeRolePolicyDocument: h.trustDoc } };
        }
        if (cmd === "SimulatePrincipalPolicyCommand") {
          h.simulateCalls.push(c.input);
          const res = (c.input.ResourceArns as string[])[0];
          return { EvaluationResults: (c.input.ActionNames as string[]).map((a) => ({ EvalActionName: a, EvalDecision: h.denied.has(`${a}|${res}`) ? "implicitDeny" : "allowed" })) };
        }
        throw new Error("unexpected " + cmd);
      }
    },
    GetRoleCommand: class GetRoleCommand extends Cmd {},
    SimulatePrincipalPolicyCommand: class SimulatePrincipalPolicyCommand extends Cmd {},
    ListRolesCommand: class ListRolesCommand extends Cmd {},
  };
});
vi.mock("@/lib/exec-env/data-plane-target", () => ({
  resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-east-1", roleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-use1-a-glue-role", scriptsBucket: "bgp-glue-scripts-123456789012-tgt-use1-a", datalakeBucket: "bgp-datalake-123456789012-tgt-use1-a", tableBucket: "t", home: false, jurisdiction: "home" }),
  resolveEmrBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-east-1", roleArn: "x", executionRoleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-use1-a-emr-role", scriptsBucket: "s", datalakeBucket: "d", tableBucket: "t", home: false, jurisdiction: "home" }),
}));
vi.mock("@/lib/realtime/flink-place", () => ({
  resolveFlinkPlace: async (targetId: string) => ({ targetId, region: "us-east-1", roleArn: "arn:aws:iam::123456789012:role/bgp-flink-role", codeBucket: "c" }),
}));
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "us-east-1" }));

import { preflightExecutionRole, preflightCustomRoleForTargets, assertPreflightPassed, ExecRolePreflightError } from "../preflight";
import { dependencyProbes, JOB_DEPENDENCY_SID } from "@/lib/role-advisor/preflight";

const trust = (svc: string) => encodeURIComponent(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: svc }, Action: "sts:AssumeRole" }] }));
const ROLE = "arn:aws:iam::123456789012:role/customer-glue-role";
const DEP = "s3://bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip";

beforeEach(() => { h.trustDoc = trust("glue.amazonaws.com"); h.denied = new Set(); h.getRoleError = null; h.simulateCalls = []; process.env.AWS_ACCOUNT_ID = "123456789012"; });

describe("预检扩展", () => {
  it("dependencyProbes:每个 URI ⇒ GetObject(对象)+ ListBucket(桶),去重,sid JobDependencyRead", () => {
    const p = dependencyProbes([DEP, "s3://bigdata-pro-va-glue-assets/scripts/other.zip", "nope"]);
    expect(p.map((x) => `${x.action} ${x.resource}`)).toEqual([
      "s3:GetObject arn:aws:s3:::bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip",
      "s3:ListBucket arn:aws:s3:::bigdata-pro-va-glue-assets",
      "s3:GetObject arn:aws:s3:::bigdata-pro-va-glue-assets/scripts/other.zip",
    ]);
    expect(p.every((x) => x.sid === JOB_DEPENDENCY_SID)).toBe(true);
  });

  it("客户现网那条路:自建角色读不到依赖库所在的桶 ⇒ ok=false,gap 点名该桶对象 ARN 与 s3:GetObject,文案给三条出路", async () => {
    h.denied.add("s3:GetObject|arn:aws:s3:::bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip");
    const r = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a", extraS3Uris: [DEP] });
    expect(r.ok).toBe(false);
    expect(r.roleExists).toBe(true);
    expect(r.trusted).toBe(true);
    expect(r.gaps.map((g) => `${g.sid}:${g.action}→${g.resource}`)).toContain("JobDependencyRead:s3:GetObject→arn:aws:s3:::bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip");
    expect(r.message).toContain("bigdata-pro-va-glue-assets");
    expect(r.message).toContain("s3:GetObject");
    expect(r.message).toContain("上传依赖文件");
    // 模拟带落点区上下文
    expect(h.simulateCalls.length).toBeGreaterThan(0);
    for (const c of h.simulateCalls) {
      expect(c.PolicySourceArn).toBe(ROLE);
      expect(c.ContextEntries).toEqual([{ ContextKeyName: "aws:RequestedRegion", ContextKeyValues: ["us-east-1"], ContextKeyType: "string" }]);
    }
  });

  it("信任策略不含 glue.amazonaws.com ⇒ 不去模拟,ok=false,文案点名服务主体与「信任实体」出路", async () => {
    h.trustDoc = trust("ec2.amazonaws.com");
    const r = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a" });
    expect(r.ok).toBe(false);
    expect(r.trusted).toBe(false);
    expect(r.gaps).toEqual([]);
    expect(h.simulateCalls.length).toBe(0);
    expect(r.message).toContain("glue.amazonaws.com");
    expect(r.message).toContain("信任实体");
  });

  it("全齐 ⇒ ok=true、checked>0、trusted=true;脚本里的 s3:// 字面也进探针", async () => {
    const r = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a", scriptCode: 'spark.read.parquet("s3://cust-data/raw/")' });
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(0);
    expect(r.trusted).toBe(true);
    const resources = h.simulateCalls.map((c) => (c.ResourceArns as string[])[0]);
    expect(resources).toContain("arn:aws:s3:::cust-data/raw/");
    expect(resources).toContain("arn:aws:s3:::cust-data");
  });

  it("角色不存在 ⇒ ok=false roleExists=false;GetRole 别的错 ⇒ ok=true + unverifiable(三态)", async () => {
    h.getRoleError = { name: "NoSuchEntityException" };
    const a = await preflightExecutionRole({ engine: "emr", roleArn: ROLE, targetId: "tgt_use1_a" });
    expect(a.ok).toBe(false); expect(a.roleExists).toBe(false);
    h.getRoleError = { name: "ThrottlingException" };
    const b = await preflightExecutionRole({ engine: "flink", roleArn: ROLE, targetId: "tgt_home" });
    expect(b.ok).toBe(true); expect(b.unverifiable).toContain("没有");
  });

  it("assertPreflightPassed:不通过抛 ExecRolePreflightError(status 400,message = 预检原话);preflightCustomRoleForTargets:空角色 ⇒ null,缺 ⇒ 400 响应 detail 带 reason / gaps", async () => {
    h.denied.add("s3:GetObject|arn:aws:s3:::bigdata-pro-va-glue-assets/scripts/glue_sql_runner.zip");
    const r = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a", extraS3Uris: [DEP] });
    expect(() => assertPreflightPassed(r, { engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a", what: "t" })).toThrow(ExecRolePreflightError);
    try { assertPreflightPassed(r, { engine: "glue", roleArn: ROLE, targetId: "tgt_use1_a", what: "t" }); } catch (e) {
      expect((e as ExecRolePreflightError).status).toBe(400);
      expect((e as Error).message).toBe(r.message);
    }
    expect(await preflightCustomRoleForTargets({ engine: "glue", customRoleArn: "", targets: ["tgt_use1_a"] })).toBeNull();
    const res = await preflightCustomRoleForTargets({ engine: "glue", customRoleArn: ROLE, targets: ["tgt_use1_a"], extraS3Uris: [DEP] });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.detail.reason).toBe("exec-role-preflight");
    expect(body.error.detail.targetId).toBe("tgt_use1_a");
    expect(body.error.detail.gaps.length).toBe(1);
    expect(body.error.message).toContain("bigdata-pro-va-glue-assets");
  });
});
