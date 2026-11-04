// @kf-batch 50-WP9a-durable-jobs
// 🔴🔴 permission canary 的**装配层判据**(WP-9 ④-3;判据 CN-1..CN-5 的本机版)。
// 只 mock 真外部(DDB 假表 / FakeAws / 注册表 / 项目台账);canary handler ↔ runner ↔ store ↔ 真执行器(建探针)↔
// statement 原语 ↔ project-secret 查找 **一律真跑**。
//
// 最要紧的三条(都是「七条全绿但隔离是坏的」的形状):
//   · 负向检查把**任何**失败都当「被拒」⇒ 口令改坏了七条反而全绿(CN-3);
//   · 正控制没过还照样采信负向结果 ⇒「连不上」被读成「隔离好好的」;
//   · 用 admin 身份跑检查 ⇒ 什么都能读,canary 说明不了项目身份。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDdb, DDB_SPECS } from "./fake-ddb";
import { FakeAws } from "./fake-aws";

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
const ADMIN_ARN = "arn:aws:secretsmanager:us-west-2:000000000000:secret:bgp/redshift/admin-usw2-AbCdEf";
let target: Record<string, unknown> | null = null;
vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (id: string) => {
    if (!target || target.targetId !== id) throw new Error(`target ${id} 不可用`);
    return target;
  }),
  getTargetRaw: vi.fn(async (id: string) => (target && target.targetId === id ? target : null)),
}));
vi.mock("@/lib/projects/project-service", () => ({
  getProject: vi.fn(async (id: string) => (id === PID ? { projectId: id } : null)),
  getApproval: vi.fn(async () => null),
  listAllProjects: vi.fn(async () => [{ projectId: PID }]),
}));

const canary = await import("@/lib/exec-env/permission-canary");
const { runJobStep } = await import("@/lib/dataplane-jobs/runner");
const { projectSecretName, projectDbUserName, projectSchema } = await import("@/lib/exec-env/project-schema");
const { canaryPublicProbeTable } = await import("@/lib/exec-env/canary-names");

const ACTOR = { actor: "alice@example.com", isPlatformAdmin: true };
const JOBS = "bgp-dataplane-jobs";
let PROJECT_ARN = "";

function seedTarget(epoch = 3) {
  target = {
    targetId: TID,
    region: "us-west-2",
    credentialIsolationState: "provisioning",
    credentialEpoch: epoch,
    provisioningDeadlineAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    resources: { redshiftSecretArn: ADMIN_ARN, redshiftWorkgroup: "bgp-wg-usw2-a", redshiftDatabase: "dev" },
  };
}

/** 一个隔离**正确**的库:七条各自该有的真实反应。 */
function healthyWarehouse() {
  const own = { secretArn: PROJECT_ARN };
  h.aws.behaviors.push(
    { match: /^SELECT current_user$/, value: projectDbUserName(PID), ...own },
    { match: /bgp_canary_deny/, error: 'ERROR: permission denied for schema bgp_canary_deny', ...own },
    { match: /^INSERT INTO "shared"/, error: "ERROR: permission denied for relation bgp_canary", ...own },
    { match: /CREATE TABLE "public"/, error: "ERROR: permission denied for schema public", ...own },
    { match: /current_schemas/, value: `{${projectSchema(PID)},shared,public}`, ...own }
  );
}

async function runCanary(opts: { epoch?: number } = {}) {
  const r = await canary.enqueueCanaryJob(TID, PID, { runAs: ACTOR, credentialEpoch: opts.epoch ?? 3 });
  let clock = Date.now();
  for (let i = 0; i < 80; i++) {
    const row = h.ddb.get(JOBS, { jobId: r.jobId })!;
    if (row.phase === "succeeded" || row.phase === "failed") return row;
    clock = Math.max(clock + 1, Number(row.nextRunAt) + 1);
    const now = clock;
    await runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: async () => {}, rand: () => 0 });
  }
  throw new Error("canary 没有收口");
}

const outcomes = (row: Record<string, any>) =>
  Object.fromEntries((row.evidence.checks as Array<{ id: string; outcome: string }>).map((c) => [c.id, c.outcome]));

beforeEach(() => {
  h.ddb.tables.clear();
  h.aws.reset();
  seedTarget();
  const name = projectSecretName(TID, PID);
  PROJECT_ARN = `arn:aws:secretsmanager:us-west-2:000000000000:secret:${name}-AbCdEf`;
  h.aws.secrets.set(name, { arn: PROJECT_ARN, value: "{}", region: "us-west-2" });
});

describe("🔴🔴 CN-1:七条用项目自己的 secret 在该区真跑", () => {
  it("隔离正确的库 ⇒ 七条全 pass;检查语句全用**项目** secret,建探针那一步才用 admin", async () => {
    healthyWarehouse();
    const row = await runCanary();
    expect(row.phase, String(row.lastError)).toBe("succeeded");
    expect(row.evidence.verdict).toBe("pass");
    expect(outcomes(row)).toEqual({ "C-1": "pass", "C-2": "pass", "C-3": "pass", "C-4": "pass", "C-5": "pass", "C-6": "pass", "C-7": "pass" });
    expect(row.evidence.credentialEpoch).toBe(3);
    const probe = h.aws.statements.filter((s) => s.sqls.some((q) => /CREATE TABLE IF NOT EXISTS/.test(q)));
    expect(probe).toHaveLength(1);
    expect(probe[0].secretArn, "建探针没走 admin(闭合执行器)").toBe(ADMIN_ARN);
    const checks = h.aws.statements.filter((s) => s !== probe[0]);
    expect(checks).toHaveLength(7);
    for (const c of checks) {
      expect(c.secretArn, `检查 ${c.sqls[0]} 没用项目身份 ⇒ canary 说明不了隔离`).toBe(PROJECT_ARN);
      expect(c.region).toBe("us-west-2");
      expect(c.workgroup).toBe("bgp-wg-usw2-a");
    }
  });

  it("C-1 读到的不是 user_proj_<id>(比如 admin)⇒ C-1 fail,整组负向作废", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: /^SELECT current_user$/, value: "bgp_admin" });
    const row = await runCanary();
    expect(row.evidence.verdict).toBe("fail");
    const o = outcomes(row);
    expect(o["C-1"]).toBe("fail");
    for (const id of ["C-3", "C-5", "C-6"]) expect(o[id], `${id} 在正控制失败时还被采信`).toBe("unverifiable");
  });
});

describe("🔴 CN-2:跨项目负测真有判别力", () => {
  it("deny 探针被误授(读成功)⇒ C-3 fail,verdict fail", async () => {
    healthyWarehouse();
    h.aws.behaviors = h.aws.behaviors.filter((b) => !String(b.match).includes("bgp_canary_deny"));
    const row = await runCanary();
    expect(outcomes(row)["C-3"]).toBe("fail");
    expect(row.evidence.verdict).toBe("fail");
  });

  it("撤掉本项目对自己探针的 grant ⇒ C-2 fail(permission denied),verdict fail", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: new RegExp(`FROM "${projectSchema(PID)}"`), error: "ERROR: permission denied for relation bgp_canary" });
    const row = await runCanary();
    expect(outcomes(row)["C-2"]).toBe("fail");
    expect(row.evidence.verdict).toBe("fail");
  });
});

describe("🔴🔴 CN-3:口令改坏 / 连不上 ⇒ 整组 unverifiable(绝不是 pass)", () => {
  it("每条都报 password authentication failed ⇒ 七条全 unverifiable", async () => {
    h.aws.behaviors.push({ match: /.*/, error: 'FATAL: password authentication failed for user "user_proj_x"', secretArn: PROJECT_ARN });
    const row = await runCanary();
    expect(row.evidence.verdict).toBe("unverifiable");
    expect(Object.values(outcomes(row)).every((o) => o === "unverifiable"), JSON.stringify(outcomes(row))).toBe(true);
  });

  it("🔴 负向检查报的是「表不存在」这类非权限错误 ⇒ unverifiable,不许算 pass", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: /bgp_canary_deny/, error: 'ERROR: relation "bgp_canary_deny.bgp_canary" does not exist', secretArn: PROJECT_ARN });
    const row = await runCanary();
    expect(outcomes(row)["C-3"]).toBe("unverifiable");
    expect(row.evidence.verdict).toBe("unverifiable");
  });

  it("该项目没有 per-project secret ⇒ 一条都不跑,verdict unverifiable 并说明原因", async () => {
    h.aws.secrets.clear();
    const row = await runCanary();
    expect(row.phase).toBe("succeeded");
    expect(row.evidence.verdict).toBe("unverifiable");
    expect(String(row.evidence.reason)).toMatch(/per-project 凭证/);
    expect(h.aws.statements).toHaveLength(0);
  });

  it("C-6:public 里有上次残留的探针表(already exists)⇒ unverifiable 并点名残留", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: /CREATE TABLE "public"/, error: 'ERROR: relation "bgp_canary_c6_x" already exists' });
    const row = await runCanary();
    const c6 = row.evidence.checks.find((c: { id: string }) => c.id === "C-6");
    expect(c6.outcome).toBe("unverifiable");
    expect(c6.detail).toMatch(/残留/);
  });

  it("🔴 C-6 建成了(撤权前的真实状态)⇒ fail,且**同一事务**里先清旧探针、建、再删 —— public 里不留残留,下一轮还能判", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: /CREATE TABLE "public"/, secretArn: PROJECT_ARN }); // 建成功
    const row = await runCanary();
    expect(outcomes(row)["C-6"]).toBe("fail");
    const c6 = h.aws.statements.find((s) => s.sqls.some((q) => /CREATE TABLE "public"/.test(q)))!;
    const tbl = canaryPublicProbeTable(PID);
    expect(c6.secretArn).toBe(PROJECT_ARN);
    expect(c6.sqls).toEqual([
      `DROP TABLE IF EXISTS "public"."${tbl}"`,
      `CREATE TABLE "public"."${tbl}" (probe INTEGER)`,
      `DROP TABLE "public"."${tbl}"`,
    ]);
  });

  it("C-7:search_path 首位不是项目 schema ⇒ C-7 fail", async () => {
    healthyWarehouse();
    h.aws.behaviors.unshift({ match: /current_schemas/, value: "{public}" });
    const row = await runCanary();
    expect(outcomes(row)["C-7"]).toBe("fail");
  });
});

describe("🔴 CN-4:结果绑 epoch + 时间", () => {
  it("运行期间 epoch 变了 ⇒ 结果作废成 unverifiable", async () => {
    healthyWarehouse();
    const r = await canary.enqueueCanaryJob(TID, PID, { runAs: ACTOR, credentialEpoch: 3 });
    let clock = Date.now();
    for (let i = 0; i < 80; i++) {
      const row = h.ddb.get(JOBS, { jobId: r.jobId })!;
      if (row.phase === "succeeded") break;
      if (row.state?.phase === "checks" && row.state.idx === 3) seedTarget(4); // 中途有人延期 / 推进
      clock = Math.max(clock + 1, Number(row.nextRunAt) + 1);
      let t = clock;
      await runJobStep(r.jobId, { respectSchedule: true }, { now: () => t++, sleep: async () => {}, wallClockMs: 1 });
      clock = t;
    }
    const row = h.ddb.get(JOBS, { jobId: r.jobId })!;
    expect(row.evidence.verdict).toBe("unverifiable");
    expect(String(row.evidence.reason)).toMatch(/世代/);
  });

  it("canaryPrerequisite:pass 但 epoch 不符 / 超过 24h / 没有结果 ⇒ 点名不满足;全对 ⇒ 满足", async () => {
    healthyWarehouse();
    await runCanary();
    const latest = await canary.latestCanaryByProject(TID);
    expect(latest.get(PID)?.verdict).toBe("pass");
    const now = Date.now();
    expect(canary.canaryPrerequisite([PID], latest, 3, now).ok).toBe(true);
    const wrongEpoch = canary.canaryPrerequisite([PID], latest, 4, now);
    expect(wrongEpoch.ok).toBe(false);
    expect(wrongEpoch.failing[0].why).toMatch(/世代/);
    const stale = canary.canaryPrerequisite([PID], latest, 3, now + canary.CANARY_MAX_AGE_MS + 60_000);
    expect(stale.ok).toBe(false);
    expect(stale.failing[0].why).toMatch(/24 小时/);
    const other = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";
    const missing = canary.canaryPrerequisite([PID, other], latest, 3, now);
    expect(missing.failing.map((f) => f.projectId)).toEqual([other]);
  });
});

describe("纯判定(classifyCheck / evaluateCanary)", () => {
  const spec = (id: string) => canary.CANARY_CHECKS.find((c) => c.id === id)!;
  it("负向:只有 permission denied 才算 pass;成功 = fail;别的错误 = unverifiable", () => {
    expect(canary.classifyCheck(spec("C-5"), { ok: false, error: "ERROR: Permission denied for relation x" }, PID).outcome).toBe("pass");
    expect(canary.classifyCheck(spec("C-5"), { ok: true }, PID).outcome).toBe("fail");
    for (const err of ["timeout", "ERROR: syntax error", "ThrottlingException", "connection refused"]) {
      expect(canary.classifyCheck(spec("C-5"), { ok: false, error: err }, PID).outcome, err).toBe("unverifiable");
    }
  });
  it("七条不全 ⇒ 不许 pass", () => {
    const passes = canary.CANARY_CHECKS.slice(0, 6).map((c) => ({ id: c.id, outcome: "pass" as const, detail: "" }));
    expect(canary.evaluateCanary(passes).verdict).toBe("unverifiable");
  });
  it("firstSchemaOf 解析 Data API 回的数组文本", () => {
    expect(canary.firstSchemaOf("{proj_a,shared,public}")).toBe("proj_a");
    expect(canary.firstSchemaOf('{"proj_a",public}')).toBe("proj_a");
    expect(canary.firstSchemaOf("{}")).toBe("");
  });
});
