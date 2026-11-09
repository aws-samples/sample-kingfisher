// 数据湖表桶路由(设计稿 §6.6)—— 按表桶量权限的探针 lib/role-advisor/lake-probes.ts + Glue 基线改探真 TempDir + 预检第 ④ 条出路。
//
// 【缺陷原形】自定义执行角色预检只量引擎基线 + 脚本 / 依赖的 s3:// 引用,对 S3 Tables 一个字不量 ⇒ 角色缺某只桶的 s3tables 权限照样保存成功,
//   运行到第一次访问表才 403;另一边 Glue 基线把「平台数据湖桶 temp/ 可写」当必备,只碰客户表桶的作业被迫给平台桶写权限。
// 【判什么】① 纯函数:读 7 条 / 写 11 条;Glue 引擎另量联邦目录三形态 × 读 3(写 +3);EMR 不量 Glue;sid = LakeRoute:<alias>:<access>;
//   ② 引擎基线:Glue 有 BaselineGlueTempDir(PutObject <脚本桶>/temp/probe),源码零 BaselineGlueDatalake;
//   ③ 行为:照 preflight-extension 的 IAM mock(GetRole + SimulatePrincipalPolicy),denied 一条 s3tables 动作 ⇒ ok=false 且文案第 ④ 条点名桶与别名;
//   不给路由 ⇒ 一条 s3tables 都不量;preflightCustomRoleForTargets 按区调 lakeRoutesFor 并把该区路由量进去。
// 只 mock 真外部(IAM 客户端 / 落点解析器 / 主控区区名)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({
  trustDoc: "" as string,
  denied: new Set<string>(), // `${action}|${resource}`
  simulateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-iam", () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    IAMClient: class {
      constructor(public cfg: Record<string, unknown>) {}
      async send(c: { constructor: { name: string }; input: Record<string, unknown> }) {
        const cmd = c.constructor.name;
        if (cmd === "GetRoleCommand") return { Role: { Arn: `arn:aws:iam::123456789012:role/${c.input.RoleName}`, AssumeRolePolicyDocument: h.trustDoc } };
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
  resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: targetId === "tgt_usw2_a" ? "us-west-2" : "us-east-1", roleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-x-glue-role", scriptsBucket: `bgp-glue-scripts-${targetId}`, datalakeBucket: `bgp-datalake-${targetId}`, tableBucket: "bgp-table-bucket", home: targetId === "tgt_home", jurisdiction: "home" }),
  resolveEmrBinding: async ({ targetId }: { targetId: string }) => ({ targetId, region: "us-east-1", roleArn: "x", executionRoleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-x-emr-role", scriptsBucket: "s", datalakeBucket: "d", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home" }),
}));
vi.mock("@/lib/realtime/flink-place", () => ({
  resolveFlinkPlace: async (targetId: string) => ({ targetId, region: "us-east-1", roleArn: "arn:aws:iam::123456789012:role/bgp-flink-role", codeBucket: "c" }),
}));
vi.mock("@/lib/place/home-region", () => ({ homeRegion: () => "us-east-1" }));

import { lakeRouteProbes, federatedCatalogArns, LAKE_ROUTE_SID_PREFIX } from "../lake-probes";
import { baselineProbes, baselineStatements, engineBaseline } from "../engine-baseline";
import { preflightExecutionRole, preflightCustomRoleForTargets } from "@/lib/execution-role/preflight";
import type { SelectedRoute } from "@/lib/lake/routes";

const ACCT = "123456789012";
const ROLE = "arn:aws:iam::123456789012:role/customer-glue-role";
const trust = (svc: string) => encodeURIComponent(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: svc }, Action: "sts:AssumeRole" }] }));
const route = (over: Partial<SelectedRoute> & { alias: string; bucket: string; access: "read" | "write" }): SelectedRoute => ({
  targetId: "tgt_home", region: "us-east-1", tier: "other", writable: true, platform: false,
  catalogRef: `s3tablescatalog/${over.bucket}`, bucketArn: `arn:aws:s3tables:us-east-1:${ACCT}:bucket/${over.bucket}`, ...over,
});
const AGG_W = route({ alias: "agg", bucket: "cust-agg", access: "write", tier: "agg" });
const ODS_R = route({ alias: "ods", bucket: "cust-ods", access: "read", tier: "ods" });
const B = (bucket: string) => `arn:aws:s3tables:us-east-1:${ACCT}:bucket/${bucket}`;
const T = (bucket: string) => `${B(bucket)}/table/*`;
const key = (p: { action: string; resource: string }) => `${p.action}→${p.resource}`;

beforeEach(() => { h.trustDoc = trust("glue.amazonaws.com"); h.denied = new Set(); h.simulateCalls = []; process.env.AWS_ACCOUNT_ID = ACCT; });

describe("① lakeRouteProbes(纯函数)", () => {
  it("读:桶 ARN 4 动作 + 表 ARN 3 动作 = 7;sid LakeRoute:<alias>:read;why 点名别名 / 桶 / 读;EMR 不量 Glue", () => {
    const p = lakeRouteProbes([ODS_R], { engine: "emr", account: ACCT });
    expect(p.map(key)).toEqual([
      `s3tables:GetTableBucket→${B("cust-ods")}`, `s3tables:ListNamespaces→${B("cust-ods")}`, `s3tables:GetNamespace→${B("cust-ods")}`, `s3tables:ListTables→${B("cust-ods")}`,
      `s3tables:GetTable→${T("cust-ods")}`, `s3tables:GetTableMetadataLocation→${T("cust-ods")}`, `s3tables:GetTableData→${T("cust-ods")}`,
    ]);
    expect(new Set(p.map((x) => x.sid))).toEqual(new Set(["LakeRoute:ods:read"]));
    expect(p[0].why).toContain("「ods」(cust-ods)为读");
    expect(p[0].why).toContain("403");
    expect(p.some((x) => x.action.startsWith("glue:"))).toBe(false);
  });
  it("写:再加桶 ARN CreateNamespace / CreateTable + 表 ARN PutTableData / UpdateTableMetadataLocation = 11;sid :write", () => {
    const p = lakeRouteProbes([AGG_W], { engine: "emr", account: ACCT });
    expect(p).toHaveLength(11);
    expect(p.slice(7).map(key)).toEqual([
      `s3tables:CreateNamespace→${B("cust-agg")}`, `s3tables:CreateTable→${B("cust-agg")}`,
      `s3tables:PutTableData→${T("cust-agg")}`, `s3tables:UpdateTableMetadataLocation→${T("cust-agg")}`,
    ]);
    expect(new Set(p.map((x) => x.sid))).toEqual(new Set(["LakeRoute:agg:write"]));
    expect(p[0].why).toContain("「agg」(cust-agg)为写");
  });
  it("Glue 引擎另量联邦目录三形态(catalog / database/* / table/*/*)× 读 3 ⇒ 读 16 条;写再 +3 × 3 ⇒ 29 条;ARN 形态逐字", () => {
    expect(federatedCatalogArns("us-east-1", ACCT, "cust-agg")).toEqual([
      `arn:aws:glue:us-east-1:${ACCT}:catalog/s3tablescatalog/cust-agg`,
      `arn:aws:glue:us-east-1:${ACCT}:database/s3tablescatalog/cust-agg/*`,
      `arn:aws:glue:us-east-1:${ACCT}:table/s3tablescatalog/cust-agg/*/*`,
    ]);
    const r = lakeRouteProbes([ODS_R], { engine: "glue", account: ACCT });
    expect(r).toHaveLength(16);
    const glueR = r.filter((x) => x.action.startsWith("glue:"));
    expect(new Set(glueR.map((x) => x.action))).toEqual(new Set(["glue:GetDatabase", "glue:GetTable", "glue:GetTables"]));
    expect(new Set(glueR.map((x) => x.resource))).toEqual(new Set(federatedCatalogArns("us-east-1", ACCT, "cust-ods")));
    const w = lakeRouteProbes([AGG_W], { engine: "glue", account: ACCT });
    expect(w).toHaveLength(29);
    const glueW = w.filter((x) => x.action.startsWith("glue:"));
    expect(glueW).toHaveLength(18);
    expect(new Set(glueW.map((x) => x.action))).toEqual(new Set(["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:CreateTable", "glue:UpdateTable", "glue:CreateDatabase"]));
    for (const arn of federatedCatalogArns("us-east-1", ACCT, "cust-agg")) expect(glueW.filter((x) => x.resource === arn)).toHaveLength(6);
  });
  it("多条路由按入参顺序各自成组;空 ⇒ [];区取自路由本身(非主控区路由量该区的桶 ARN)", () => {
    const usw2 = route({ alias: "west", bucket: "cust-west", access: "read", region: "us-west-2", targetId: "tgt_usw2_a" });
    const p = lakeRouteProbes([AGG_W, usw2], { engine: "emr", account: ACCT });
    expect(p.map((x) => x.sid)).toEqual([...Array(11).fill("LakeRoute:agg:write"), ...Array(7).fill("LakeRoute:west:read")]);
    expect(p[11].resource).toBe(`arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-west`);
    expect(lakeRouteProbes([], { engine: "glue", account: ACCT })).toEqual([]);
    expect(LAKE_ROUTE_SID_PREFIX).toBe("LakeRoute:");
  });
});

describe("② Glue 引擎基线:探真 TempDir,不再把平台数据湖桶写权限当必备", () => {
  const ctx = { region: "us-east-1", accountId: ACCT, scriptBucket: "bgp-glue-scripts-x", logBucket: "bgp-datalake-x" };
  it("baselineProbes(glue) 含 BaselineGlueTempDir = s3:PutObject arn:aws:s3:::<脚本桶>/temp/probe;语句资源 = 桶 + 桶/temp/*;why 点名 --TempDir", () => {
    const probes = baselineProbes("glue", ctx);
    expect(probes).toContainEqual(expect.objectContaining({ sid: "BaselineGlueTempDir", action: "s3:PutObject", resource: "arn:aws:s3:::bgp-glue-scripts-x/temp/probe" }));
    const st = baselineStatements("glue", ctx).find((s) => s.Sid === "BaselineGlueTempDir")!;
    expect(st.Resource).toEqual(["arn:aws:s3:::bgp-glue-scripts-x", "arn:aws:s3:::bgp-glue-scripts-x/temp/*"]);
    expect(st.Action).toContain("s3:PutObject");
    expect(engineBaseline("glue", ctx).find((n) => n.sid === "BaselineGlueTempDir")!.why).toContain("--TempDir = s3://bgp-glue-scripts-x/temp/");
  });
  it("🔴 棘轮:glue 基线没有任何探针 / 语句落在数据湖桶上;源码零 `sid: \"BaselineGlueDatalake\"`", () => {
    expect(baselineProbes("glue", ctx).map((p) => p.sid)).not.toContain("BaselineGlueDatalake");
    expect(baselineStatements("glue", ctx).flatMap((s) => s.Resource as string[]).some((r) => r.includes("bgp-datalake-x"))).toBe(false);
    const src = readFileSync(resolve(__dirname, "..", "engine-baseline.ts"), "utf8");
    expect(src).not.toMatch(/sid:\s*"BaselineGlueDatalake"/);
    expect(src).toMatch(/sid:\s*"BaselineGlueTempDir"/);
  });
});

describe("③ 行为:预检把路由探针量进 SimulatePrincipalPolicy,缺口走第 ④ 条出路", () => {
  const simulated = () => h.simulateCalls.flatMap((c) => (c.ActionNames as string[]).map((a) => `${a}→${(c.ResourceArns as string[])[0]}`));

  it("🔴 denied 一条 s3tables:PutTableData ⇒ ok=false;gap sid LakeRoute:agg:write;文案「④ 数据湖表桶权限不够」点名表桶 cust-agg 与「agg」并给三个动作;Glue 联邦目录也被量", async () => {
    h.denied.add(`s3tables:PutTableData|${T("cust-agg")}`);
    const r = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_home", lakeRoutes: [AGG_W, ODS_R] });
    expect(r.ok).toBe(false);
    expect(r.gaps.map((g) => `${g.sid}:${g.action}→${g.resource}`)).toEqual([`LakeRoute:agg:write:s3tables:PutTableData→${T("cust-agg")}`]);
    expect(r.message).toContain("④ 数据湖表桶权限不够");
    expect(r.message).toContain("表桶 cust-agg");
    expect(r.message).toContain("把「agg」从作业的「数据湖表桶」声明里移除");
    expect(r.message).toContain("或把它的访问改成「读」");
    expect(r.message).not.toContain("「ods」");
    const sim = simulated();
    expect(sim).toContain(`s3tables:GetTableBucket→${B("cust-ods")}`);
    expect(sim).toContain(`s3tables:PutTableData→${T("cust-agg")}`);
    expect(sim).toContain(`glue:CreateTable→arn:aws:glue:us-east-1:${ACCT}:table/s3tablescatalog/cust-agg/*/*`);
    expect(sim).not.toContain(`s3tables:PutTableData→${T("cust-ods")}`);
    for (const c of h.simulateCalls) expect(c.ContextEntries).toEqual([{ ContextKeyName: "aws:RequestedRegion", ContextKeyValues: ["us-east-1"], ContextKeyType: "string" }]);
  });
  it("不给路由 ⇒ 一条 s3tables / 联邦目录都不量;EMR 引擎给路由 ⇒ 量 s3tables 但不量 glue:*;全齐 ⇒ ok=true", async () => {
    const none = await preflightExecutionRole({ engine: "glue", roleArn: ROLE, targetId: "tgt_home" });
    expect(none.ok).toBe(true);
    expect(simulated().some((s) => s.startsWith("s3tables:") || s.includes(":catalog/s3tablescatalog/"))).toBe(false);
    h.simulateCalls = [];
    h.trustDoc = trust("emr-serverless.amazonaws.com");
    const emr = await preflightExecutionRole({ engine: "emr", roleArn: ROLE, targetId: "tgt_home", lakeRoutes: [AGG_W] });
    expect(emr.ok).toBe(true);
    const sim = simulated();
    expect(sim.filter((s) => s.startsWith("s3tables:"))).toHaveLength(11);
    expect(sim.some((s) => s.startsWith("glue:"))).toBe(false);
  });
  it("preflightCustomRoleForTargets:按每个绑定区调 lakeRoutesFor,该区路由被量;第一个不通过的区回 400 响应(detail 带 gaps)并停在那一区", async () => {
    const asked: string[] = [];
    const west = route({ alias: "west", bucket: "cust-west", access: "write", region: "us-west-2", targetId: "tgt_usw2_a" });
    h.denied.add(`s3tables:CreateTable|arn:aws:s3tables:us-west-2:${ACCT}:bucket/cust-west`);
    const res = await preflightCustomRoleForTargets({
      engine: "glue", customRoleArn: ROLE, targets: ["tgt_home", "tgt_usw2_a", "tgt_never"],
      lakeRoutesFor: async (tid) => { asked.push(tid); return tid === "tgt_home" ? [ODS_R] : [west]; },
    });
    expect(asked).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json() as { error: { code: string; message: string; detail: { gaps: Array<{ sid: string }> } } };
    expect(body.error.detail.gaps.map((g) => g.sid)).toEqual(["LakeRoute:west:write"]);
    expect(body.error.message).toContain("表桶 cust-west");
    expect(simulated()).toContain(`s3tables:GetTableBucket→${B("cust-ods")}`);
    // 不是自定义角色 ⇒ 不量、不调 lakeRoutesFor
    asked.length = 0;
    expect(await preflightCustomRoleForTargets({ engine: "glue", customRoleArn: "", targets: ["tgt_home"], lakeRoutesFor: async (tid) => { asked.push(tid); return []; } })).toBeNull();
    expect(asked).toEqual([]);
  });
});
