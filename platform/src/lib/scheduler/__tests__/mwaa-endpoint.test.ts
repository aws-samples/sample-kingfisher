// MWAA 端点解析器(单一作者)的可执行门禁 —— ACCEPTANCE 前半。
// 🔴 home 逐字节 = env(存量路径不变);非 home 缺组件 / 缺资源 ⇒ MwaaNotInstalled 且 missing 全列;绝不回落 home。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ targets: {} as Record<string, any> }));
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => h.targets[id] ?? null),
}));
vi.mock("@aws-sdk/client-mwaa", () => ({
  MWAAClient: class { async send() { return { CliToken: "t", WebServerHostname: "h" }; } },
  CreateCliTokenCommand: class { constructor(public input: any) {} },
}));

import {
  homeMwaaEndpoint,
  mwaaEndpointFor,
  mwaaMissingReason,
  requireMwaaForTargets,
  MwaaNotInstalled,
  mwaaFixHref,
  MWAA_NOT_INSTALLED_CODE,
  schedulerEndpointFor,
  serverlessEndpointFor,
  isServerlessEndpoint,
  serverlessMissingReason,
  unpauseWhenLoaded,
  SCHEDULER_ENDPOINT_VIA,
} from "@/lib/scheduler/mwaa-endpoint";
// 账本走真实现(请求存储用最小替身)
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const USW2 = "tgt_usw2_a";
const USW2B = "tgt_usw2_b";

beforeEach(() => {
  h.targets = {};
  process.env.AWS_REGION = "us-east-1";
  process.env.MWAA_ENV_NAME = "bgp-mwaa";
  process.env.MWAA_DAG_BUCKET = "bgp-mwaa-dags-123456789012";
});

describe("home:逐字节 = env(存量 14 处消费者的读法与兜底一模一样)", () => {
  it("有 env 取 env;无 env 兜底 bgp-mwaa / bgp-mwaa-dags / us-east-1", async () => {
    expect(homeMwaaEndpoint()).toEqual({ targetId: "tgt_home", region: "us-east-1", envName: "bgp-mwaa", dagBucket: "bgp-mwaa-dags-123456789012", home: true });
    delete process.env.MWAA_ENV_NAME;
    delete process.env.MWAA_DAG_BUCKET;
    delete process.env.AWS_REGION;
    expect(homeMwaaEndpoint()).toMatchObject({ envName: "bgp-mwaa", dagBucket: "bgp-mwaa-dags", region: "us-east-1" });
    expect(await mwaaEndpointFor("tgt_home")).toMatchObject({ home: true, envName: "bgp-mwaa" });
  });
});

describe("非 home:fail-closed,绝不回落 home", () => {
  it("装齐 ⇒ 该 target 自己的三元", async () => {
    h.targets[USW2] = { targetId: USW2, region: "us-west-2", displayName: "西部", components: ["core", "mwaa"], resources: { dagBucket: "bgp-mwaa-dags-123456789012-tgt-usw2-a", mwaaEnvName: "bgp-mwaa-tgt-usw2-a" } };
    expect(await mwaaEndpointFor(USW2)).toEqual({ targetId: USW2, region: "us-west-2", envName: "bgp-mwaa-tgt-usw2-a", dagBucket: "bgp-mwaa-dags-123456789012-tgt-usw2-a", home: false });
  });
  it("🔴 未装 mwaa ⇒ MwaaNotInstalled(code / missing 带 region、displayName、reason),不是 home 的桶", async () => {
    h.targets[USW2B] = { targetId: USW2B, region: "us-west-2", displayName: "eu-sim", components: ["core", "redshift", "residency-api"], resources: {} };
    const p = mwaaEndpointFor(USW2B);
    await expect(p).rejects.toBeInstanceOf(MwaaNotInstalled);
    const e = (await p.catch((x) => x)) as MwaaNotInstalled;
    expect(e.code).toBe(MWAA_NOT_INSTALLED_CODE);
    // 拒因泛化为「缺任一调度组件」⇒ 两种缺因一起列(serverless 在前)
    expect(e.code).toBe("SCHEDULER_NOT_INSTALLED");
    expect(e.missing).toEqual([{ targetId: USW2B, region: "us-west-2", displayName: "eu-sim", reason: expect.stringContaining("未安装 mwaa 组件") }]);
    expect(e.message).toMatch(/未安装调度组件/);
    expect(e.message).toMatch(/本区域的调度器/);
    expect(e.message).toMatch(/airflow-serverless/);
  });
  it("装了组件但资源袋没回写 ⇒ 也拒(reason 指向「检测初始化」),不拿 home 桶顶替", async () => {
    h.targets[USW2] = { targetId: USW2, region: "us-west-2", components: ["core", "mwaa"], resources: { dagBucket: "b" } };
    expect(mwaaMissingReason(h.targets[USW2])).toMatch(/缺 mwaaEnvName/);
    await expect(mwaaEndpointFor(USW2)).rejects.toThrow(/mwaaEnvName/);
  });
  it("目标不存在 ⇒ MwaaNotInstalled(reason 执行目标不存在);非法 targetId ⇒ 抛", async () => {
    await expect(mwaaEndpointFor("tgt_nope")).rejects.toThrow(/执行目标不存在/);
    await expect(mwaaEndpointFor("Bad Id")).rejects.toThrow();
  });
});

describe("requireMwaaForTargets:一次核全部、缺的一起列(宪法 B6)", () => {
  it("两缺一齐 ⇒ missing 两条(含 home 在内的齐者不进 missing);全齐 ⇒ Map", async () => {
    h.targets[USW2] = { targetId: USW2, region: "us-west-2", components: ["core"], resources: {} };
    h.targets[USW2B] = { targetId: USW2B, region: "us-west-2", components: ["core", "mwaa"], resources: { dagBucket: "b", mwaaEnvName: "e" } };
    h.targets["tgt_euw1_a"] = { targetId: "tgt_euw1_a", region: "eu-west-1", components: [], resources: {} };
    const p = requireMwaaForTargets(["tgt_home", USW2, USW2B, "tgt_euw1_a", USW2]);
    const e = (await p.catch((x) => x)) as MwaaNotInstalled;
    expect(e).toBeInstanceOf(MwaaNotInstalled);
    expect(e.missing.map((m) => m.targetId)).toEqual([USW2, "tgt_euw1_a"]); // 去重、按传入序
    const ok = await requireMwaaForTargets(["tgt_home", USW2B]);
    expect(Array.from(ok.keys())).toEqual(["tgt_home", USW2B]);
    expect(ok.get(USW2B)!.dagBucket).toBe("b");
  });
  it("补装深链形态(列表页读 target + highlight)", () => {
    // 深链缺省高亮 serverless(推荐,分钟级);显式传 mwaa 仍可高亮经典行
    expect(mwaaFixHref(USW2B)).toBe("/exec-envs?target=tgt_usw2_b&highlight=airflow-serverless");
    expect(mwaaFixHref(USW2B, "mwaa")).toBe("/exec-envs?target=tgt_usw2_b&highlight=mwaa");
  });
});

// 联合解析:两者都缺 ⇒ 两种缺因一起列;只装 serverless ⇒ serverless 端点;两者都装 ⇒ 缺省 serverless、偏好 mwaa 可切
describe("schedulerEndpointFor(SPEC v3.27 §3.15)", () => {
  const SLS_RES = { workflowBucket: "bgp-airflow-sls-123456789012-tgt-usw2-a", airflowServerlessRoleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-a-airflow-sls-role", airflowServerlessSgId: "sg-1", emrSubnetIds: ["subnet-a", "subnet-b"] };
  it("两者都缺 ⇒ SchedulerNotInstalled 一次列两种缺因(serverless 在前)", async () => {
    h.targets["tgt_usw2_c"] = { targetId: "tgt_usw2_c", region: "us-west-2", components: ["core", "redshift"], resources: {} };
    const e = (await schedulerEndpointFor("tgt_usw2_c").catch((x) => x)) as MwaaNotInstalled;
    expect(e).toBeInstanceOf(MwaaNotInstalled);
    expect(e.code).toBe("SCHEDULER_NOT_INSTALLED");
    expect(e.missing[0].reason).toBe("未安装 airflow-serverless 组件;未安装 mwaa 组件");
  });
  it("只装 airflow-serverless ⇒ serverless 端点(桶 / 角色 / SG / 子网 ×2 全部来自描述符)", async () => {
    h.targets["tgt_usw2_d"] = { targetId: "tgt_usw2_d", region: "us-west-2", components: ["core", "airflow-serverless"], resources: SLS_RES };
    const ep = await schedulerEndpointFor("tgt_usw2_d");
    expect(isServerlessEndpoint(ep)).toBe(true);
    expect(ep).toEqual({ kind: "serverless", targetId: "tgt_usw2_d", region: "us-west-2", workflowBucket: SLS_RES.workflowBucket, roleArn: SLS_RES.airflowServerlessRoleArn, sgId: "sg-1", subnetIds: ["subnet-a", "subnet-b"], home: false });
  });
  it("装了组件但资源袋缺键 / 缺子网 ⇒ 缺因指名那个键(先检测初始化回写)", async () => {
    h.targets["tgt_usw2_e"] = { targetId: "tgt_usw2_e", region: "us-west-2", components: ["core", "airflow-serverless"], resources: { workflowBucket: "b" } };
    const e = (await schedulerEndpointFor("tgt_usw2_e").catch((x) => x)) as MwaaNotInstalled;
    expect(e.missing[0].reason).toContain("airflowServerlessRoleArn");
    expect(serverlessMissingReason({ components: ["airflow-serverless"], resources: { ...SLS_RES, emrSubnetIds: ["only-one"] } })).toContain("私有子网");
  });
  it("两者都装 ⇒ 缺省 serverless;描述符 schedulerPreference=mwaa 或显式 prefer ⇒ 经典端点", async () => {
    h.targets["tgt_usw2_f"] = { targetId: "tgt_usw2_f", region: "us-west-2", components: ["core", "mwaa", "airflow-serverless"], resources: { ...SLS_RES, dagBucket: "bgp-mwaa-dags-123456789012-tgt-usw2-f", mwaaEnvName: "bgp-mwaa-tgt-usw2-f" } };
    expect(isServerlessEndpoint(await schedulerEndpointFor("tgt_usw2_f"))).toBe(true);
    expect(isServerlessEndpoint(await schedulerEndpointFor("tgt_usw2_f", "mwaa"))).toBe(false);
    h.targets["tgt_usw2_f"].schedulerPreference = "mwaa";
    const ep = await schedulerEndpointFor("tgt_usw2_f");
    expect(isServerlessEndpoint(ep)).toBe(false);
    expect((ep as { envName: string }).envName).toBe("bgp-mwaa-tgt-usw2-f");
  });
  it("requireMwaaForTargets 走联合解析:混合 target 各得其所;unpauseWhenLoaded 对 serverless 免解挂", async () => {
    h.targets["tgt_usw2_d"] = { targetId: "tgt_usw2_d", region: "us-west-2", components: ["core", "airflow-serverless"], resources: SLS_RES };
    h.targets[USW2] = { targetId: USW2, region: "us-west-2", components: ["core", "mwaa"], resources: { dagBucket: "bgp-mwaa-dags-123456789012-tgt-usw2-a", mwaaEnvName: "bgp-mwaa-tgt-usw2-a" } };
    const m = await requireMwaaForTargets(["tgt_usw2_d", USW2]);
    expect(isServerlessEndpoint(m.get("tgt_usw2_d")!)).toBe(true);
    expect(isServerlessEndpoint(m.get(USW2)!)).toBe(false);
    expect(await unpauseWhenLoaded(m.get("tgt_usw2_d")!, ["a", "b"])).toEqual(["a", "b"]);
  });
});

// 端点解析 = 「这个工作流的产物在哪个区」的落点决策,在唯一作者记账。
//   DELETE /api/workflow/<id> 撤 DAG 的 s3.DeleteObject(该区 workflow 桶,没越区)因撤回链只经
//   bindingTargets()(纯解析)而未归因;发布 / 触发 / 取日志同链。
describe("🔴 三个端点解析入口都记落点决策(observer 据此归因)", () => {
  const SLS_RES = { workflowBucket: "bgp-airflow-sls-123456789012-tgt-usw2-a", airflowServerlessRoleArn: "arn:aws:iam::123456789012:role/BgpExecEnv-tgt-usw2-a-airflow-sls-role", airflowServerlessSgId: "sg-1", emrSubnetIds: ["subnet-a", "subnet-b"] };
  const decided = () => decisionsOfCurrentRequest().decisions.filter((d) => d.via === SCHEDULER_ENDPOINT_VIA).map((d) => d.targetId);
  // 🔴 账本按「请求存储对象」挂(WeakMap)⇒ 替身必须是同一个对象,每次回新对象 = 每次都是新请求
  beforeEach(() => {
    const store = { headers: new Headers() };
    __setRequestStoreProvider(() => store);
  });
  afterEach(() => __setRequestStoreProvider(null));

  it("schedulerEndpointFor:非主控区记该 target;主控区记 tgt_home;一次解析只记一笔", async () => {
    h.targets["tgt_usw2_d"] = { targetId: "tgt_usw2_d", region: "us-west-2", components: ["core", "airflow-serverless"], resources: SLS_RES };
    await schedulerEndpointFor("tgt_usw2_d");
    await schedulerEndpointFor("tgt_home");
    expect(decided()).toEqual(["tgt_usw2_d", "tgt_home"]);
  });

  it("serverlessEndpointFor / mwaaEndpointFor 同样记;缺组件抛 MwaaNotInstalled 的那次也记(决策在准入之前,观测要看见「想去哪」)", async () => {
    h.targets["tgt_usw2_d"] = { targetId: "tgt_usw2_d", region: "us-west-2", components: ["core", "airflow-serverless"], resources: SLS_RES };
    h.targets[USW2] = { targetId: USW2, region: "us-west-2", components: ["core", "mwaa"], resources: { dagBucket: "bgp-mwaa-dags-123456789012-tgt-usw2-a", mwaaEnvName: "bgp-mwaa-tgt-usw2-a" } };
    await serverlessEndpointFor("tgt_usw2_d");
    await mwaaEndpointFor(USW2);
    await mwaaEndpointFor("tgt_home");
    await expect(mwaaEndpointFor("tgt_usw2_d")).rejects.toBeInstanceOf(MwaaNotInstalled);
    expect(decided()).toEqual(["tgt_usw2_d", USW2, "tgt_home", "tgt_usw2_d"]);
  });

  it("非法 id 抛在记账之前(非法 id 不是一个落点)", async () => {
    await expect(schedulerEndpointFor("nope")).rejects.toThrow();
    expect(decided()).toEqual([]);
  });

  it("接线:下线 / 发布链经 schedulerEndpointFor(撤回链不许绕过唯一作者自己拼端点)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../workflow/publish-dag.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const unpub = src.slice(src.indexOf("async function unpublishWorkflowDagFromTarget("));
    expect(unpub).toMatch(/const ep = await schedulerEndpointFor\(wfTarget\)/);
  });
});
