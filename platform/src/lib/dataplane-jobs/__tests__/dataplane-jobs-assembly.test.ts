// 🔴🔴 **装配层判据**(2)—— 只 mock **真外部**:
//   DynamoDB(内存假表,真求值条件表达式)/ Redshift Data · Secrets Manager · Redshift Serverless(FakeAws)/
//   执行环境注册表 / 项目台账。
//   runner ↔ store ↔ supply handler ↔ **真**闭合执行器(submit / settle / provisionProjectLogin)↔ statement 原语 ↔
//   target-clients ↔ 审计内核 **之间一律不 mock**(memory mock-hides-the-seam:变异不能创造判据本来没有的观察力)。
//
// 本文件对着的失败模式(每条都是「各自单测全绿、装起来是坏的」那一类):
//   · 双泵并发抢同一条作业 ⇒ 两边都以为自己抢到,同一步执行两次;
//   · 僵尸持有者(租约过期后醒来)带着旧 runToken 写回 ⇒ 覆盖掉新持有者的进度;
//   · DTO 把 lease / runToken / 审计 id / statementId 透给页面;
//   · 进程被杀后续跑 ⇒ 已完成的 provision-login 又做一遍(口令再轮换 = 重建);
//   · 读终态那一步重做 ⇒ 结果审计多一条(JB-4「每步恰一条」);
//   · 语句失败后 pending 没清 ⇒ 永远读同一条失败语句,不再重新提交;
//   · 停泵开关不生效。
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
  listTargetsRaw: vi.fn(async () => (target ? [target] : [])),
}));
const projects = new Set<string>([PID]);
vi.mock("@/lib/projects/project-service", () => ({
  getProject: vi.fn(async (id: string) => (projects.has(id) ? { projectId: id, name: id } : null)),
  getApproval: vi.fn(async () => null),
  listAllProjects: vi.fn(async () => Array.from(projects).map((projectId) => ({ projectId }))),
}));

const { enqueueSupplyJob, sweepAutoSupply, SUPPLY_STEPS } = await import("@/lib/exec-env/project-cred-supply");
const { runJobStep } = await import("@/lib/dataplane-jobs/runner");
const store = await import("@/lib/dataplane-jobs/store");
const { toPublicJob } = await import("@/lib/dataplane-jobs/dto");
const { queryDueJobIds } = await import("@/lib/dataplane-jobs/due");
const { JOB_LEASE_MS, MAX_ATTEMPTS, dataplaneJobId } = await import("@/lib/dataplane-jobs/model");
const { settleAdminDdl, submitAdminDdl, systemActor } = await import("@/lib/exec-env/admin-ddl-executor");
const { projectSecretName, projectDbUserName } = await import("@/lib/exec-env/project-schema");

const ACTOR = { actor: "alice@example.com", actorSub: "sub-alice", isPlatformAdmin: true };
const JOBS = "bgp-dataplane-jobs";
const noSleep = async () => {};

function seedTarget(overrides: Record<string, unknown> = {}) {
  target = {
    targetId: TID,
    region: "us-west-2",
    status: "active",
    ready: true,
    credentialIsolationState: "provisioning",
    credentialEpoch: 3,
    provisioningDeadlineAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    resources: { redshiftSecretArn: ADMIN_ARN, redshiftWorkgroup: "bgp-wg-usw2-a", redshiftDatabase: "dev" },
    ...overrides,
  };
}

/** 反复推进直到终态(模拟泵:每轮都把时钟拨到 nextRunAt 之后)。 */
async function runToEnd(jobId: string, opts: { maxRounds?: number } = {}) {
  let clock = Date.now();
  for (let i = 0; i < (opts.maxRounds ?? 60); i++) {
    const row = h.ddb.get(JOBS, { jobId });
    if (row && (row.phase === "succeeded" || row.phase === "failed")) return row;
    clock = Math.max(clock + 1, Number(row?.nextRunAt ?? 0) + 1);
    const now = clock;
    await runJobStep(jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep, rand: () => 0 });
  }
  throw new Error("作业在上限轮次内没有收口");
}

const auditRows = () => h.ddb.all("bgp-audit");

beforeEach(() => {
  h.ddb.tables.clear();
  h.ddb.calls.length = 0;
  h.ddb.failNext = null;
  h.aws.reset();
  delete process.env.BGP_DATAPLANE_JOBS_PAUSED;
  process.env.BGP_DATAPLANE_AUTO_SUPPLY = "on"; // 下面「自动供给」各条默认开着验行为;关着的那条单独设
  seedTarget();
});

describe("🔴🔴 JB-3:一次供给走到底(真执行器 · 真 statement 原语 · 该区的落点)", () => {
  it("202 之后作业逐步推进到 succeeded;六步 SQL 顺序对、都打到 us-west-2 的 workgroup、都用 admin secret;secret 真写进该区", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    expect(r.created).toBe(true);
    const row = await runToEnd(r.jobId);
    expect(row.phase, String(row.lastError)).toBe("succeeded");
    expect(row.dueShard, "终态作业还挂在稀疏 GSI 上 ⇒ 泵会一直取到它").toBeUndefined();

    const sqls = h.aws.sqls();
    const at = (re: RegExp) => sqls.findIndex((s) => re.test(s));
    expect(at(/CREATE SCHEMA IF NOT EXISTS "shared"/)).toBeGreaterThanOrEqual(0);
    expect(at(/CREATE ROLE/)).toBeGreaterThan(at(/CREATE SCHEMA IF NOT EXISTS "shared"/));
    expect(at(/CREATE USER/)).toBeGreaterThan(at(/CREATE ROLE/));
    expect(at(/ALTER SCHEMA .* OWNER TO/)).toBeGreaterThan(at(/CREATE USER/));
    expect(at(/GRANT ROLE/)).toBeGreaterThan(at(/ALTER SCHEMA .* OWNER TO/));
    expect(at(/GRANT USAGE ON SCHEMA/)).toBeGreaterThan(at(/GRANT ROLE/));
    for (const st of h.aws.statements) {
      expect(st.region, "语句打到了别的区").toBe("us-west-2");
      expect(st.workgroup).toBe("bgp-wg-usw2-a");
      expect(st.secretArn, "admin DDL 没带 SecretArn(IAM fallback)").toBe(ADMIN_ARN);
    }
    const secret = h.aws.secrets.get(projectSecretName(TID, PID));
    expect(secret?.region).toBe("us-west-2");
    expect(JSON.parse(String(secret?.value)).username).toBe(projectDbUserName(PID));
    // 证据:每一步都有,且一个口令都没有
    expect(row.evidence.steps.map((s: { step: string }) => s.step)).toEqual(SUPPLY_STEPS.map((s) => s.step));
    expect(JSON.stringify(row)).not.toMatch(/"password"|Kf[A-Za-z0-9_-]{20,}7/);
  });

  it("🔴 两段式 statement 带 StatementName = 意图审计 id(从 Redshift 侧能反查到审计)", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    await runToEnd(r.jobId);
    const intents = auditRows().filter((a) => a.action === "exec-env.admin-ddl.intent").map((a) => a.ts);
    const named = h.aws.statements.filter((s) => s.statementName).map((s) => s.statementName);
    expect(named.length).toBe(intents.length);
    for (const n of named) expect(intents).toContain(n);
  });

  it("🔴 JB-4 审计每步恰一条:读终态那一步重做(settle 两次)⇒ 结果审计仍只有一条", async () => {
    const sub = await submitAdminDdl(ACTOR, { operation: "create-shared-schema", targetId: TID });
    const a = await settleAdminDdl(sub);
    const b = await settleAdminDdl(sub);
    expect(a.state).toBe("succeeded");
    expect(b.state).toBe("succeeded");
    const settled = auditRows().filter((x) => String(x.ts).startsWith(sub.auditId) && x.action === "exec-env.admin-ddl.done");
    expect(settled, "重做读终态多写了一条结果审计").toHaveLength(1);
    expect(settled[0].ts).toBe(`${sub.auditId}#settled`);
    expect(settled[0].actor, "结果审计不是记在发起者名下").toBe(ACTOR.actor);
  });

  // (=)
  // 🔴 第二条数据面通道(admin-DDL 执行器)原来只做准入、不记落点决策 ⇒ observe 观测器把本就该落到 us-west-2 的
  //   redshift-data / secretsmanager 调用判成 cross-region(第三十九 / 四十轮 16 / 12 条全是它);enforce 一开会误拦。
  //   装配层钉**事实**:真执行器 + 真 statement 原语跑一遍,提交请求与收口请求(两个请求存储)各自的决策袋都含该 target。
  it("🔴 submit / settle / 供给作业的每一步都把 tgt_usw2_a 记进各自请求的落点决策袋(via admin-ddl-executor)", async () => {
    const place = await import("@/lib/place/context");
    const decided = () => place.decisionsOfCurrentRequest().decisions.filter((d) => d.via === "admin-ddl-executor").map((d) => d.targetId);
    try {
      const reqSubmit = {};
      place.__setRequestStoreProvider(() => reqSubmit);
      const sub = await submitAdminDdl(ACTOR, { operation: "create-shared-schema", targetId: TID });
      expect(decided(), "提交请求没记落点 ⇒ 观测器只看到主控区那条决策").toEqual([TID]);
      const reqSettle = {};
      place.__setRequestStoreProvider(() => reqSettle);
      expect(decided(), "新请求的决策袋应为空(账本按请求隔离)").toEqual([]);
      await settleAdminDdl(sub);
      expect(decided(), "收口发生在另一个请求里,它对 submission.region 的读也要能归因").toEqual([TID]);
      // 供给作业(provisionProjectLogin + create-* 两段式)整条跑完:泵所在请求的决策袋含该 target,且没有 null(= 没人隐式回落主控区)
      const reqPump = {};
      place.__setRequestStoreProvider(() => reqPump);
      const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
      await runToEnd(r.jobId);
      const all = place.decisionsOfCurrentRequest().decisions;
      expect(all.filter((d) => d.via === "admin-ddl-executor").map((d) => d.targetId)).toContain(TID);
      expect(all.some((d) => d.targetId === null), "供给链里出现了 targetId=null 的决策 = 有人隐式回落主控区").toBe(false);
    } finally {
      place.__setRequestStoreProvider(null);
    }
  });

  it("🔴 入队幂等:同一 (target, project) 未终态时重复入队只有一条;force 只在终态后开下一代", async () => {
    const a = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const b = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    expect(b.jobId).toBe(a.jobId);
    expect(b.created).toBe(false);
    expect(h.ddb.all(JOBS)).toHaveLength(1);
    await runToEnd(a.jobId);
    const auto = await enqueueSupplyJob(TID, PID, { runAs: systemActor("dataplane-auto-supply"), force: false });
    expect(auto.jobId, "自动补队对已成功的作业又开了一代").toBe(a.jobId);
    const manual = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    expect(manual.jobId).toBe(dataplaneJobId("supply", TID, PID, "g2"));
    expect(manual.created).toBe(true);
  });
});

describe("🔴🔴 JB-2:fencing —— 双泵并发只一个抢到;僵尸写不回", () => {
  it("两个推进者同时抢同一条 ⇒ 只有一个 claimed,revision 只 +1", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const now = Date.now() + 1;
    const [x, y] = await Promise.all([
      store.claimJob(r.jobId, now, { respectSchedule: true }),
      store.claimJob(r.jobId, now, { respectSchedule: true }),
    ]);
    const kinds = [x.kind, y.kind].sort();
    expect(kinds, "两边都抢到了 ⇒ 同一步会被执行两次").toEqual(["busy", "claimed"]);
    expect(h.ddb.get(JOBS, { jobId: r.jobId })?.revision).toBe(1);
  });

  it("两个 runJobStep 并发 ⇒ 一个推进、一个 busy;同一条 DDL 只提交一次", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const now = Date.now() + 1;
    const outs = await Promise.all([
      runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep, wallClockMs: 10 }),
      runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep, wallClockMs: 10 }),
    ]);
    expect(outs.map((o) => o.kind).sort()).toEqual(["advanced", "busy"]);
    const shared = h.aws.sqls().filter((s) => /CREATE SCHEMA IF NOT EXISTS "shared"/.test(s));
    expect(shared).toHaveLength(1);
  });

  it("🔴 僵尸:租约过期被别人接手后,旧持有者带旧 runToken 写回 ⇒ StaleJobFence,行保持新持有者写的样子", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const t0 = Date.now() + 1;
    const first = await store.claimJob(r.jobId, t0, { respectSchedule: true });
    if (first.kind !== "claimed") throw new Error("first claim failed");
    // 租约过期,第二个推进者接手
    const second = await store.claimJob(r.jobId, t0 + JOB_LEASE_MS + 1, { respectSchedule: false });
    if (second.kind !== "claimed") throw new Error("second claim failed");
    const patch = { phase: "succeeded" as const, state: { forged: true }, progress: { done: 9, total: 9 }, evidence: {}, lastError: null, attempts: 0, nextRunAt: 0 };
    await expect(store.commitJob(first.fence, patch, { release: true, now: t0 + JOB_LEASE_MS + 2 })).rejects.toBeInstanceOf(store.StaleJobFence);
    const row = h.ddb.get(JOBS, { jobId: r.jobId });
    expect(row?.runToken).toBe(second.fence.runToken);
    expect(row?.phase).toBe("running");
    expect(row?.state?.forged, "僵尸的写回落进去了").toBeUndefined();
    // 新持有者照常能写
    await store.commitJob(second.fence, { ...patch, phase: "waiting", state: row!.state }, { release: true, now: t0 + JOB_LEASE_MS + 3 });
    expect(h.ddb.get(JOBS, { jobId: r.jobId })?.phase).toBe("waiting");
  });

  it("🔴 runner 层的僵尸:handler 执行期间被接手 ⇒ outcome = stale,不覆盖接手者", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const t0 = Date.now() + 1;
    let thiefToken = "";
    const slowHandler = {
      async step() {
        const thief = await store.claimJob(r.jobId, t0 + JOB_LEASE_MS + 10, { respectSchedule: false });
        if (thief.kind === "claimed") thiefToken = thief.fence.runToken;
        return { state: { zombie: true }, progress: { done: 1, total: 1 }, evidence: {}, next: { kind: "continue" as const } };
      },
    };
    const out = await runJobStep(r.jobId, { respectSchedule: true }, { now: () => t0, sleep: noSleep, handlers: { supply: slowHandler } });
    expect(out.kind).toBe("stale");
    const row = h.ddb.get(JOBS, { jobId: r.jobId });
    expect(thiefToken).not.toBe("");
    expect(row?.runToken).toBe(thiefToken);
    expect(row?.state?.zombie).toBeUndefined();
  });

  it("未到期的作业:泵(respectSchedule)不抢;「立即推进」可以抢,但租约照样互斥", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true, now: Date.now() + 60_000 });
    const pump = await store.claimJob(r.jobId, Date.now(), { respectSchedule: true });
    expect(pump.kind).toBe("not-due");
    const manual = await store.claimJob(r.jobId, Date.now(), { respectSchedule: false });
    expect(manual.kind).toBe("claimed");
    const again = await store.claimJob(r.jobId, Date.now(), { respectSchedule: false });
    expect(again.kind, "立即推进绕过了租约").toBe("busy");
  });
});

describe("🔴 JB-5:DTO 不泄 lease / runToken / revision / 私有 state", () => {
  it("一条塞满内部字段的行过 toPublicJob ⇒ JSON 里一个都找不到", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const now = Date.now() + 1;
    await runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep, wallClockMs: 1 });
    const row = h.ddb.get(JOBS, { jobId: r.jobId })!;
    const loaded = { ...row, lease: { token: "LEASE-TOKEN-X", expiresAt: 1 }, runToken: "RUN-TOKEN-Y", revision: 77, idempotencyKey: "IDEM-Z", ttl: 123 };
    loaded.state = { ...loaded.state, pending: { auditId: "AUDIT-ID-W", statementIds: ["STMT-V"] } };
    const json = JSON.stringify(toPublicJob(loaded as never));
    for (const secret of ["LEASE-TOKEN-X", "RUN-TOKEN-Y", "IDEM-Z", "AUDIT-ID-W", "STMT-V", "\"lease\"", "\"runToken\"", "\"revision\"", "\"state\"", "\"ttl\""]) {
      expect(json, `DTO 透出了 ${secret}`).not.toContain(secret);
    }
    expect(JSON.parse(json)).toMatchObject({ jobId: r.jobId, kind: "supply", targetId: TID, projectId: PID });
  });

  it("runner 的返回值同样是 DTO(内部端点 / 立即推进直接把它回给调用方)", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const now = Date.now() + 1;
    const out = await runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"runToken"|"lease"|"revision"|"statementIds"|"auditId"/);
  });
});

describe("🔴🔴 断进程续跑:不重建、不重复", () => {
  it("每轮墙钟只够走一小步(模拟反复被杀 / 换副本)⇒ 最终 succeeded,CREATE USER 与 CREATE ROLE 各只发一次", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    let clock = Date.now();
    for (let i = 0; i < 80; i++) {
      const row = h.ddb.get(JOBS, { jobId: r.jobId })!;
      if (row.phase === "succeeded" || row.phase === "failed") break;
      clock = Math.max(clock + 1, Number(row.nextRunAt) + 1);
      const now = clock;
      // wallClockMs=0 ⇒ 每次只够「抢到 → 一步 → 存档」,然后交还租约(就像那一步之后进程被杀)
      let ticks = 0;
      await runJobStep(r.jobId, { respectSchedule: true }, { now: () => now + ticks++, sleep: noSleep, wallClockMs: 1 });
    }
    expect(h.ddb.get(JOBS, { jobId: r.jobId })?.phase).toBe("succeeded");
    expect(h.aws.sqls().filter((s) => /^CREATE USER/.test(s)), "续跑把登录用户又建了一遍").toHaveLength(1);
    expect(h.aws.sqls().filter((s) => /^ALTER USER/.test(s)), "续跑轮换了口令(= 重建)").toHaveLength(0);
    expect(h.aws.sqls().filter((s) => /^CREATE ROLE/.test(s))).toHaveLength(1);
  });

  it("语句先 STARTED 若干次 ⇒ 作业进 waiting、statementId 留在行上,下一轮读终态而不是重新提交", async () => {
    h.aws.behaviors.push({ match: /CREATE ROLE/, pendingPolls: 50 });
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const row = await runToEnd(r.jobId, { maxRounds: 200 });
    expect(row.phase).toBe("succeeded");
    expect(h.aws.sqls().filter((s) => /^CREATE ROLE/.test(s)), "没等终态就重新提交了").toHaveLength(1);
  });
});

describe("🔴 失败与重试", () => {
  it("一步失败 ⇒ pending 清掉、attempts+1、退避后**重新提交**并最终成功", async () => {
    h.aws.behaviors.push({ match: /GRANT USAGE ON SCHEMA/, error: "ERROR: could not serialize access", times: 1 });
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const row = await runToEnd(r.jobId);
    expect(row.phase).toBe("succeeded");
    expect(h.aws.statements.filter((s) => s.sqls.some((q) => /GRANT USAGE ON SCHEMA/.test(q))), "失败后没有重新提交").toHaveLength(2);
    const failedAudit = auditRows().filter((a) => a.action === "exec-env.admin-ddl.failed");
    expect(failedAudit).toHaveLength(1);
  });

  it("create-role 已存在 ⇒ 幂等跳过;别的步「已存在」照样判失败", async () => {
    h.aws.behaviors.push({ match: /CREATE ROLE/, error: 'ERROR: role "role_proj_x" already exists' });
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const row = await runToEnd(r.jobId);
    expect(row.phase).toBe("succeeded");
    expect(row.evidence.steps.find((s: { step: string }) => s.step === "create-role").note).toMatch(/已存在/);
  });

  it(`连续失败 ${MAX_ATTEMPTS} 次 ⇒ 终态 failed、摘掉稀疏 GSI、lastError 说清原因`, async () => {
    h.aws.behaviors.push({ match: /CREATE SCHEMA IF NOT EXISTS "shared"/, error: "ERROR: disk full" });
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const row = await runToEnd(r.jobId, { maxRounds: 100 });
    expect(row.phase).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.dueShard).toBeUndefined();
    expect(String(row.lastError)).toMatch(/disk full/);
    expect(await queryDueJobIds(Date.now() + 10 * 86_400_000), "终态失败的作业还会被泵取到").toEqual([]);
  });

  it("RBAC 拒(不可恢复)⇒ 直接 failed,不重试", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: { actor: "bob", isPlatformAdmin: false }, force: true });
    const row = await runToEnd(r.jobId);
    expect(row.phase).toBe("failed");
    expect(row.attempts).toBe(0);
    expect(String(row.lastError)).toMatch(/不可重试/);
    expect(h.aws.statements, "RBAC 拒了还发了语句").toHaveLength(0);
  });
});

describe("🔴 停泵开关 + 到期队列", () => {
  it("BGP_DATAPLANE_JOBS_PAUSED=1 ⇒ runJobStep 回 paused,行一个字节都不变、一条语句都不发", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    const before = JSON.stringify(h.ddb.get(JOBS, { jobId: r.jobId }));
    process.env.BGP_DATAPLANE_JOBS_PAUSED = "1";
    const out = await runJobStep(r.jobId, { respectSchedule: false }, { sleep: noSleep });
    expect(out.kind).toBe("paused");
    expect(JSON.stringify(h.ddb.get(JOBS, { jobId: r.jobId }))).toBe(before);
    expect(h.aws.statements).toHaveLength(0);
  });

  it("「1」以外的值不算停泵(拼错不许变成第三态)", async () => {
    const r = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true });
    process.env.BGP_DATAPLANE_JOBS_PAUSED = "true";
    const now = Date.now() + 1;
    const out = await runJobStep(r.jobId, { respectSchedule: true }, { now: () => now, sleep: noSleep });
    expect(out.kind).toBe("advanced");
  });

  it("queryDueJobIds 只回到期且未终态的;countActiveJobs 数未终态的", async () => {
    const now = Date.now();
    const a = await enqueueSupplyJob(TID, PID, { runAs: ACTOR, force: true, now });
    projects.add("proj-01M1KP594D2E6DJQC8EZ8CRAEZ");
    const b = await enqueueSupplyJob(TID, "proj-01M1KP594D2E6DJQC8EZ8CRAEZ", { runAs: ACTOR, force: true, now: now + 3_600_000 });
    expect(await queryDueJobIds(now + 1)).toEqual([a.jobId]);
    expect(new Set(await queryDueJobIds(now + 3_600_001))).toEqual(new Set([a.jobId, b.jobId]));
    expect(await store.countActiveJobs(TID)).toBe(2);
    await runToEnd(a.jobId);
    expect(await store.countActiveJobs(TID)).toBe(1);
    projects.delete("proj-01M1KP594D2E6DJQC8EZ8CRAEZ");
  });
});

describe("🔴 写点拓扑:作业表只有 store.ts 一个写入方", () => {
  it("src 下(除 __tests__)只有 lib/dataplane-jobs/store.ts 对作业表发写命令", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve, dirname, relative } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) {
          if (e !== "__tests__" && e !== "node_modules") walk(p);
        } else if (/\.tsx?$/.test(e)) {
          const src = readFileSync(p, "utf8");
          if (!/DATAPLANE_JOBS|bgp-dataplane-jobs/.test(src)) continue;
          if (/new\s+(Put|Update|Delete|TransactWrite|BatchWrite)Command\s*\(/.test(src)) hits.push(relative(SRC, p));
        }
      }
    };
    walk(SRC);
    expect(hits, "作业表多了一个写入方 ⇒ fencing 可以被绕过").toEqual(["lib/dataplane-jobs/store.ts"]);
  });
});

describe("🔴 绑定即自动供给(sweep,systemActor)", () => {
  const bind = () => h.ddb.put("bgp-sync-tasks", { userId: "default-user", taskId: "t-1", targetId: TID, projectId: PID });

  it("provisioning 的执行环境上新绑定的项目 ⇒ 自动入队一条供给作业(以系统主体名义);再扫不重复入队", async () => {
    bind();
    const a = await sweepAutoSupply();
    expect(a).toMatchObject({ targets: 1, enqueued: 1, existing: 0, errors: [] });
    const jobs = h.ddb.all(JOBS);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].createdBy).toBe("system:dataplane-auto-supply");
    const b = await sweepAutoSupply();
    expect(b).toMatchObject({ enqueued: 0, existing: 1 });
    expect(h.ddb.all(JOBS)).toHaveLength(1);
  });

  it("🔴 开关缺省关(未设 / 拼错)⇒ 一条都不入队,且回 disabled(部署即自动切项目身份 = 该区读不到 public 存量表)", async () => {
    bind();
    for (const v of [undefined, "1", "true", "ON"]) {
      if (v === undefined) delete process.env.BGP_DATAPLANE_AUTO_SUPPLY;
      else process.env.BGP_DATAPLANE_AUTO_SUPPLY = v;
      expect(await sweepAutoSupply()).toMatchObject({ disabled: true, targets: 0, enqueued: 0 });
    }
    expect(h.ddb.all(JOBS)).toHaveLength(0);
  });

  it("legacy-seeded 的执行环境不自动供给(存量 home 按 ④-7 的序由人手动)", async () => {
    bind();
    seedTarget({ credentialIsolationState: "legacy-seeded" });
    expect(await sweepAutoSupply()).toMatchObject({ targets: 0, enqueued: 0 });
    expect(h.ddb.all(JOBS)).toHaveLength(0);
  });

  it("🔴 自动路径不重开已终态失败的作业(失败要人看见、人决定)", async () => {
    bind();
    h.aws.behaviors.push({ match: /CREATE SCHEMA IF NOT EXISTS "shared"/, error: "ERROR: disk full" });
    await sweepAutoSupply();
    const id = h.ddb.all(JOBS)[0].jobId;
    expect((await runToEnd(id, { maxRounds: 100 })).phase).toBe("failed");
    expect(await sweepAutoSupply()).toMatchObject({ enqueued: 0, existing: 1 });
    expect(h.ddb.all(JOBS)).toHaveLength(1);
  });
});
