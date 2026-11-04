// @kf-batch 50-WP9a-durable-jobs
// 进 isolated 的四项服务端前置(WP-9 ④-3 末句)—— 每一项都必须能**单独**把门关上,且「拿不准」一律算不满足。
// 只 mock 真外部(DDB 假表 / FakeAws / 项目台账);注册表真跑(描述符就是假表里的一行);供给层的在用项目口径、canary 最新结果、CloudWatch 求和都真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDdb, DDB_SPECS } from "../../dataplane-jobs/__tests__/fake-ddb";
import { FakeAws } from "../../dataplane-jobs/__tests__/fake-aws";

const h = vi.hoisted(() => ({ ddb: null as unknown as FakeDdb, aws: null as unknown as FakeAws }));
h.ddb = new FakeDdb(DDB_SPECS);
h.aws = new FakeAws();
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: (c: never) => h.ddb.send(c) } };
});
vi.mock("@/lib/aws/clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    regionalClient: async (service: string, region: string) => h.aws.regional(service, region),
    redshiftDataClient: (region: string) => h.aws.redshiftData(region),
  };
});
const TID = "tgt_usw2_a";
const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
vi.mock("@/lib/projects/project-service", () => ({
  listAllProjects: vi.fn(async () => [{ projectId: PID }]),
}));

const { evaluateIsolationPrereqs, countCredentialFallback7d } = await import("@/lib/exec-env/isolation-prereqs");
const { projectSecretName } = await import("@/lib/exec-env/project-schema");
const { dataplaneJobId } = await import("@/lib/dataplane-jobs/model");

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const okScan = async () => ({ status: "ok" as const, adminArnHits: 0 });

function seedCanary(verdict: string, epoch: number, at: string) {
  h.ddb.put("bgp-dataplane-jobs", {
    jobId: dataplaneJobId("canary", TID, PID, `seed-${at}`),
    kind: "canary",
    targetId: TID,
    projectId: PID,
    phase: "succeeded",
    createdAt: at,
    evidence: { verdict, credentialEpoch: epoch, at, checks: [] },
  });
}

beforeEach(() => {
  h.ddb.tables.clear();
  h.aws.reset();
  h.ddb.put("bgp-execution-envs", {
    pk: "env",
    sk: TID,
    targetId: TID,
    region: "us-west-2",
    resources: { redshiftWorkgroup: "wg", redshiftDatabase: "dev" },
  });
  // 在用项目:一条盖了该 target 的同步任务
  h.ddb.put("bgp-sync-tasks", { userId: "default-user", taskId: "t1", targetId: TID, projectId: PID });
  const name = projectSecretName(TID, PID);
  h.aws.secrets.set(name, { arn: `arn:aws:secretsmanager:us-west-2:0:secret:${name}-x`, value: "{}", region: "us-west-2" });
  seedCanary("pass", 5, new Date(NOW - 3_600_000).toISOString());
});

describe("🔴 进 isolated 的前置:四项都满足才放行", () => {
  it("四项全满足 ⇒ ok(正控制:没有它,下面的「拒」都可能只是判据坏了)", async () => {
    const v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.projects).toEqual([PID]);
  });

  it("🔴 产物扫描用默认实现(9b 之前)⇒ 一定不满足,并说明归 WP-9b", async () => {
    const v = await evaluateIsolationPrereqs(TID, 5, NOW);
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.key)).toEqual(["artifact-scan"]);
    expect(v.failures[0].message).toMatch(/WP-9b/);
  });

  it("产物里还有 admin ARN ⇒ 不满足", async () => {
    const v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: async () => ({ status: "ok", adminArnHits: 2 }) });
    expect(v.failures.map((f) => f.key)).toEqual(["artifact-scan"]);
  });

  it("近 7 天有回落 ⇒ 不满足;CloudWatch 读失败 ⇒ 也不满足(读不到 ≠ 0)", async () => {
    h.aws.metricValues = [0, 2, 1];
    let v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures.map((f) => f.key)).toEqual(["fallback-7d"]);
    expect(v.failures[0].message).toMatch(/3 次/);
    h.aws.metricValues = [];
    h.aws.metricError = "AccessDeniedException";
    v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures.map((f) => f.key)).toEqual(["fallback-7d"]);
    expect(v.failures[0].message).toMatch(/AccessDenied/);
  });

  it("项目 secret 不存在 / 读失败 ⇒ 不满足并点名", async () => {
    h.aws.secrets.clear();
    let v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures.find((f) => f.key === "secrets")?.projects?.[0]).toMatchObject({ projectId: PID });
    h.aws.secretReadErrors.set(projectSecretName(TID, PID), "ThrottlingException");
    v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures.find((f) => f.key === "secrets")?.projects?.[0].why).toMatch(/无法核实/);
  });

  it("canary 最新一次不是 pass / epoch 不符 / 超过 24h ⇒ 不满足(CN-4 点名项目)", async () => {
    seedCanary("fail", 5, new Date(NOW - 60_000).toISOString()); // 更新的一次是 fail
    let v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures.map((f) => f.key)).toEqual(["canary"]);
    expect(v.failures[0].projects?.[0]).toMatchObject({ projectId: PID });
    h.ddb.tables.get("bgp-dataplane-jobs")?.clear();
    seedCanary("pass", 4, new Date(NOW - 60_000).toISOString());
    v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures[0].projects?.[0].why).toMatch(/世代/);
    h.ddb.tables.get("bgp-dataplane-jobs")?.clear();
    seedCanary("pass", 5, new Date(NOW - 25 * 3_600_000).toISOString());
    v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.failures[0].projects?.[0].why).toMatch(/24 小时/);
  });

  it("没有在用项目 ⇒ 不满足(无从证明「全部项目都满足」)", async () => {
    h.ddb.tables.get("bgp-sync-tasks")?.clear();
    const v = await evaluateIsolationPrereqs(TID, 5, NOW, { scanArtifacts: okScan });
    expect(v.ok).toBe(false);
  });

  it("CloudWatch 查询按该 target 的维度求和,跨日期点相加", async () => {
    h.aws.metricValues = [1, 4];
    expect(await countCredentialFallback7d(TID, NOW)).toEqual({ status: "ok", count: 5 });
    expect(h.aws.calls).toContain("cloudwatch:GetMetricDataCommand");
  });
});
