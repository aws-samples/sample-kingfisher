// @kf-batch 50-project-delete-orphans
// 🔴🔴 **装配层判据**:删项目空间 ⇒ 不许留下孤儿(真环境清理 128 个夹具项目时抓到的四类)。
//
// 只 mock **真外部**:DynamoDB(内存假表,真求值条件 / 过滤表达式、真分页)· Secrets Manager / Redshift Data
// (FakeAws,secret 按区存)· 执行环境注册表 · 鉴权守卫 · 审计落库 · 主控区 admin secret 的 ARN 查找。
// DELETE 路由 ↔ 盘点(project-resources)↔ 各模块自己的 owned-only 读法(Copilot 计划 / 平台动作调度 / 问数口径与技能)
// ↔ 回收作业入队 ↔ 作业表唯一写通道 ↔ runner ↔ 回收 handler ↔ secret 名 / 区派生 ↔ target-clients **之间一律不 mock**。
//
// 对着的失败模式:
//   ① 未收口的 Copilot 计划 / 定时治理 / 定时造数 / 卡片定时刷新不在清单 ⇒ 项目删了它们还在(后三类到点照样触发);
//   ② 归属算错:把别的项目的 / 全局的 / 已收口的算进来(空项目删不掉)或漏掉第二页(fail-open);
//   ③ 读不到当成 0(fail-open);
//   ④ per-project 凭证 secret 删项目后没人回收;回收删错区 / 删错名 ⇒ 报成功而真 secret 原封不动;
//   ⑤ 回收作业入队失败却照样删了项目 ⇒ 那个区的凭证永远没人回收;
//   ⑥ 回收作业在项目还在时动手 ⇒ 删掉在用项目的凭证。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { FakeDdb, DDB_SPECS } from "@/lib/dataplane-jobs/__tests__/fake-ddb";
import { FakeAws } from "@/lib/dataplane-jobs/__tests__/fake-aws";

/** 盘点会碰到的全部表(键形态与 infra/lib/database-stack.ts 同源) */
const SPECS = {
  ...DDB_SPECS,
  "bgp-datasources": { hash: "userId", range: "datasourceId" },
  "bgp-flink-jobs": { hash: "userId", range: "jobId" },
  "bgp-redshift-tasks": { hash: "userId", range: "taskId" },
  "bgp-genbi-cards": { hash: "pk", range: "sk" },
  "bgp-bi-reports": { hash: "projectId", range: "reportId" },
  "bgp-genbi-context": { hash: "projectId", range: "entryId" },
  "bgp-genbi-skills": { hash: "projectId", range: "skillId" },
  "bgp-alert-rules": { hash: "pk", range: "ruleId" },
  "bgp-copilot-plans": { hash: "pk", range: "planId" },
  "bgp-backfill-plans": { hash: "pk", range: "planId" },
  "bgp-incidents": { hash: "pk", range: "sk" },
  "bgp-action-schedules": { hash: "userId", range: "taskId" },
  "bgp-projects": { hash: "pk", range: "projectId" },
  "bgp-project-members": { hash: "projectId", range: "username" },
} as const;

const h = vi.hoisted(() => ({
  ddb: null as unknown as FakeDdb,
  aws: null as unknown as FakeAws,
  targets: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ action: string; opts: unknown }>,
}));
h.ddb = new FakeDdb(SPECS as never);
h.aws = new FakeAws();

// 序 50 第二批:DELETE 经 submitLongOp(kind project-delete)⇒ 任务表 bgp-long-ops 交给内存夹具(真求值条件写 / 租约释放),其余表走 FakeDdb
vi.hoisted(() => {
  // 驱动器的进程内等待预算是 import 时读的 env(产品值 45s):判据缩到 5s(FakeDdb 盘点毫秒级就做完;「STARTED 两次后 FINISHED」要等 500+750+1125ms ⇒ 仍在同步路径),
  // 「数仓一直唤醒中」的用例靠它在 5s 后拿到 202;天花板放到 10 分钟,免得 150 轮 ≈ 296s 的盘点被 300s abort 抢先判 timeout
  process.env.LONG_OPS_SYNC_WAIT_MS = "5000";
  process.env.LONG_OPS_MAX_MS = "600000";
});
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    ...real,
    docClient: {
      send: (c: { input?: { TableName?: string } }) => (c.input?.TableName === "bgp-long-ops" ? mem.docClient.send(c) : h.ddb.send(c as never)),
    },
  };
});
vi.mock("@/lib/aws/clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    regionalClient: async (service: string, region: string) => h.aws.regional(service, region),
    redshiftDataClient: (region: string) => h.aws.redshiftData(region),
  };
});
// 真外部:主控区 admin secret 的 ARN(真实现会打真 Secrets Manager)
vi.mock("@/lib/redshift/admin-secret", () => ({
  getRedshiftSecretArn: vi.fn(async () => "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/redshift/admin-AbCdEf"),
}));
vi.mock("@/lib/exec-env/registry", () => ({
  listTargetsRaw: vi.fn(async () => h.targets),
  getTargetRaw: vi.fn(async (id: string) => h.targets.find((t) => t.targetId === id) ?? null),
  requireReadyTarget: vi.fn(async (id: string) => {
    const t = h.targets.find((x) => x.targetId === id);
    if (!t) throw new Error(`target ${id} 不可用`);
    return t;
  }),
}));
vi.mock("@/lib/projects/guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    requireProjectConfigAdmin: vi.fn(async () => ({
      projectId: "x",
      role: "owner",
      identity: { sub: "sub-alice", username: "alice", groups: ["bgp-admin"], isPlatformAdmin: true },
    })),
  };
});
vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn(async (_req: unknown, action: string, opts: unknown) => {
    h.audits.push({ action, opts });
  }),
}));

process.env.AWS_REGION = "us-east-1";

const { inventoryProject, PROJECT_RESOURCE_LABELS } = await import("@/lib/projects/project-resources");
const { listOpenPlansOwnedByProject } = await import("@/lib/copilot/plan/plan-service");
const backfill = await import("@/lib/backfill/service");
const { listActionSchedulesOwnedByProject } = await import("@/lib/scheduler/action-schedules");
const { listContextOwnedByProject } = await import("@/lib/genbi/context");
const { listSkillsOwnedByProject } = await import("@/lib/genbi/skills");
const { DELETE } = await import("@/app/api/projects/[id]/route");
const { runInLongOp } = await import("@/lib/long-ops/context");
const memLongOps = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
/** 直接调盘点时要有与执行体 project-delete 同一种等待上下文(盘点语句的等待经唯一原语 awaitTerminal,裸调即抛)。 */
const inventory = (pid: string) => runInLongOp({ taskId: "t-inv-judge", opKind: "project-delete" }, () => inventoryProject(pid));
const { enqueueProjectCredReclaim, RECLAIM_PROJECT_GONE_GRACE_MS } = await import("@/lib/exec-env/project-cred-reclaim");
const { runJobStep } = await import("@/lib/dataplane-jobs/runner");
const { getJob } = await import("@/lib/dataplane-jobs/store");
const { projectSecretName } = await import("@/lib/exec-env/project-schema");

const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const OTHER = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";
const HOME = { targetId: "tgt_home", region: "us-east-1", status: "active" };
const USW2 = {
  targetId: "tgt_usw2_a",
  region: "us-west-2",
  status: "active",
  resources: { redshiftWorkgroup: "bgp-wg-usw2-a", redshiftDatabase: "dev" },
};

function seedProject(pid: string) {
  h.ddb.put("bgp-projects", { pk: "project", projectId: pid, name: pid, ownerName: "alice" });
  h.ddb.put("bgp-project-members", { projectId: pid, username: "alice", role: "owner" });
}
function plan(pid: string, planId: string, status: string) {
  h.ddb.put("bgp-copilot-plans", { pk: `copilot#${pid}`, planId, projectId: pid, status });
}
function bfPlan(pid: string, planId: string, status: string) {
  h.ddb.put("bgp-backfill-plans", { pk: `backfill#${pid}`, planId, projectId: pid, status });
}
function schedule(taskId: string, kind: string, pid: string | undefined) {
  h.ddb.put("bgp-action-schedules", {
    userId: "default-user",
    taskId,
    kind,
    ...(pid ? { projectId: pid } : {}),
    targets: ["tgt_usw2_a"],
    scheduleEnabled: true,
    updatedAt: "2026-10-11T00:00:00Z",
  });
}
function seedSecret(targetId: string, region: string, pid: string) {
  const name = projectSecretName(targetId, pid);
  h.aws.secrets.set(name, { arn: `arn:aws:secretsmanager:${region}:000000000000:secret:${name}-AbCdEf`, value: "{}", region });
  return name;
}
const delReq = () => new NextRequest(`http://localhost/api/projects/${PID}`, { method: "DELETE" });
const counted = (inv: Awaited<ReturnType<typeof inventoryProject>>, kind: string) =>
  inv.resources.find((r) => r.kind === kind)?.count ?? 0;

beforeEach(() => {
  h.ddb = new FakeDdb(SPECS as never);
  memLongOps.resetMemLongOps();
  h.aws.reset();
  // 盘点 proj_<id> schema 表数:主控区数仓回 0 张
  h.aws.behaviors.push({ match: /information_schema\.tables/, value: "0" });
  h.targets = [HOME, USW2];
  h.audits = [];
  seedProject(PID);
  seedProject(OTHER);
});

describe("① 用户建的、会跑的 / 有内容的三类 ⇒ 进清单、有就阻断", () => {
  it("正控制:空项目可删 —— 别的项目的未收口计划 / 调度、缺 projectId 的调度都不算它的", async () => {
    plan(OTHER, "01P1", "running");
    schedule("gov_other", "governance", OTHER);
    schedule("seed_noproj", "seed", undefined);
    const inv = await inventory(PID);
    expect(inv.unresolved).toEqual([]);
    expect(inv.blockers, "空项目被别人的东西挡住 = 「能看见什么」被当成了「拥有什么」").toEqual([]);
  }, 20_000);

  it("Copilot 计划:只数**未收口**的(含不认识的状态);已收口的是历史,不数", async () => {
    plan(PID, "01A", "planned");
    plan(PID, "01B", "awaiting");
    plan(PID, "01C", "paused");
    plan(PID, "01D", "weird-new-status"); // 看不清 ⇒ 当未收口
    plan(PID, "01E", "succeeded");
    plan(PID, "01F", "cancelled");
    plan(PID, "01G", "partially-failed");
    const inv = await inventory(PID);
    expect(counted(inv, "copilot-plan")).toBe(4);
    expect(inv.blockers.join("|")).toContain(`${PROJECT_RESOURCE_LABELS["copilot-plan"]} 4 个`);
  }, 20_000);

  it("只剩已收口的计划 ⇒ 不阻断(计划没有删除入口;否则跑过 Copilot 的项目永远删不掉)", async () => {
    plan(PID, "01E", "succeeded");
    plan(PID, "01F", "cancelled");
    const inv = await inventory(PID);
    expect(inv.blockers).toEqual([]);
  }, 20_000);

  it("补数计划:只数本项目**未收口**的(含不认识的状态);已收口 / 别的项目的不数", async () => {
    bfPlan(PID, "01A", "planned");
    bfPlan(PID, "01B", "running");
    bfPlan(PID, "01C", "paused");
    bfPlan(PID, "01D", "weird");
    bfPlan(PID, "01E", "succeeded");
    bfPlan(PID, "01F", "cancelled");
    bfPlan(PID, "01G", "partially-failed");
    bfPlan(OTHER, "01H", "running");
    // 脏数据:落在本项目分区、属性却写着别的项目 ⇒ 不算(第二道值核)
    h.ddb.put("bgp-backfill-plans", { pk: `backfill#${PID}`, planId: "01Z", projectId: OTHER, status: "running" });
    const inv = await inventory(PID);
    expect(counted(inv, "backfill-plan")).toBe(4);
    expect(inv.blockers.join("|")).toContain(`${PROJECT_RESOURCE_LABELS["backfill-plan"]} 4 个`);
  }, 20_000);

  it("运维知识库条目**不阻断**(派生知识、无删除入口;理由登记在 PROJECT_SCOPED_NOT_COUNTED)", async () => {
    h.ddb.put("bgp-incidents", { pk: `incident#${PID}`, sk: "sig#abc", projectId: PID, status: "unresolved", resolution: { markdown: "x" } });
    bfPlan(PID, "01E", "succeeded");
    const inv = await inventory(PID);
    expect(inv.blockers).toEqual([]);
  }, 20_000);

  it("定时治理 / 定时造数 / 卡片定时刷新:按种类各数各的,只数本项目的", async () => {
    schedule("gov_1", "governance", PID);
    schedule("gov_2", "governance", PID);
    schedule("seedsch_1", "seed", PID);
    schedule("gcard_1", "genbi-card", PID);
    schedule("gov_x", "governance", OTHER);
    const inv = await inventory(PID);
    expect(counted(inv, "governance-schedule")).toBe(2);
    expect(counted(inv, "seed-schedule")).toBe(1);
    expect(counted(inv, "genbi-card-schedule")).toBe(1);
    const b = inv.blockers.join("|");
    expect(b).toContain(`${PROJECT_RESOURCE_LABELS["governance-schedule"]} 2 个`);
    expect(b).toContain(`${PROJECT_RESOURCE_LABELS["seed-schedule"]} 1 个`);
    expect(b).toContain("需本人删除");
  }, 20_000);

  it("🔴 DELETE 路由真的拦下来:有定时造数 ⇒ 400 列明细,项目行还在、回收作业一条都没入队", async () => {
    schedule("seedsch_1", "seed", PID);
    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("定时造数任务");
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeTruthy();
    expect(h.ddb.all("bgp-dataplane-jobs")).toEqual([]);
  }, 20_000);
});

describe("② 翻页到底 / 翻不完就抛(只数第一页 = fail-open)", () => {
  it("每页 2 行:计划 / 调度 / 口径都要数到第二页以后", async () => {
    h.ddb.pageSize = 2;
    for (let i = 0; i < 5; i++) plan(PID, `01P${i}`, "running");
    for (let i = 0; i < 5; i++) schedule(`gov_${i}`, "governance", PID);
    for (let i = 0; i < 3; i++) h.ddb.put("bgp-genbi-context", { projectId: PID, entryId: `e${i}` });
    expect((await listOpenPlansOwnedByProject(PID)).length).toBe(5);
    expect((await listActionSchedulesOwnedByProject("governance", PID)).length).toBe(5);
    expect((await listContextOwnedByProject(PID)).length).toBe(3);
    for (let i = 0; i < 5; i++) bfPlan(PID, `01B${i}`, "running");
    expect((await backfill.listOpenPlansOwnedByProject(PID)).length).toBe(5);
    for (let i = 0; i < 3; i++) h.ddb.put("bgp-genbi-skills", { projectId: PID, skillId: `s${i}` });
    h.ddb.put("bgp-genbi-skills", { projectId: "global", skillId: "g1" }); // 全局共享的不算本项目拥有
    expect((await listSkillsOwnedByProject(PID)).length).toBe(3);
  });

  it("页数上限内翻不完 ⇒ 抛,不回一个偏小的数", async () => {
    h.ddb.pageSize = 1;
    for (let i = 0; i < 3; i++) plan(PID, `01P${i}`, "running");
    for (let i = 0; i < 3; i++) schedule(`gov_${i}`, "governance", PID);
    await expect(listOpenPlansOwnedByProject(PID, 2)).rejects.toThrow(/数不清/);
    await expect(listActionSchedulesOwnedByProject("governance", PID, 2)).rejects.toThrow(/数不清/);
    for (let i = 0; i < 3; i++) bfPlan(PID, `01B${i}`, "running");
    await expect(backfill.listOpenPlansOwnedByProject(PID, 2)).rejects.toThrow(/数不清/);
  });
});

describe("③ 读不到 ≠ 没有", () => {
  it("调度表 / 计划表 / 口径表读失败 ⇒ count:null ⇒ 阻断", async () => {
    const specs: Record<string, unknown> = { ...SPECS };
    delete specs["bgp-action-schedules"];
    delete specs["bgp-copilot-plans"];
    delete specs["bgp-genbi-context"];
    delete specs["bgp-genbi-skills"];
    delete specs["bgp-backfill-plans"];
    h.ddb = new FakeDdb(specs as never);
    seedProject(PID);
    const inv = await inventory(PID);
    const nul = inv.unresolved.map((r) => r.kind).sort();
    expect(nul).toEqual(["backfill-plan", "copilot-plan", "genbi-card-schedule", "genbi-context", "genbi-skill", "governance-schedule", "seed-schedule"]);
    expect(inv.blockers.filter((b) => b.includes("无法核实")).length).toBe(7);
  }, 20_000);
});

describe("④ 系统代管的 per-project 凭证:删项目后自动回收(作业化)", () => {
  async function drain(jobId: string, now = Date.now()) {
    return runJobStep(jobId, { respectSchedule: false }, { now: () => now, sleep: async () => {} });
  }

  it("删项目 ⇒ 每个执行区一条回收作业;推进后该项目在**各自那个区**的 secret 被删,别的项目的不动", async () => {
    const homeName = seedSecret("tgt_home", "us-east-1", PID);
    const usw2Name = seedSecret("tgt_usw2_a", "us-west-2", PID);
    const otherName = seedSecret("tgt_usw2_a", "us-west-2", OTHER);

    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const jobs = body.data.credentialReclaim.jobs as Array<{ targetId: string; jobId: string }>;
    expect(jobs.map((j) => j.targetId).sort()).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID }), "项目行没删").toBeUndefined();
    // 删除审计里带着回收作业(人能从审计追到作业)
    const audit = h.audits.find((a) => a.action === "project.delete");
    expect(JSON.stringify(audit?.opts)).toContain(jobs[0].jobId);

    for (const j of jobs) {
      const r = await drain(j.jobId);
      expect(r.kind).toBe("advanced");
      const row = await getJob(j.jobId);
      expect(row?.phase, `回收作业 ${j.targetId} 没成功:${row?.lastError}`).toBe("succeeded");
      expect(row?.evidence).toMatchObject({ outcome: "deleted", region: j.targetId === "tgt_home" ? "us-east-1" : "us-west-2" });
    }
    expect(h.aws.secrets.has(homeName), "主控区的 per-project secret 还在").toBe(false);
    expect(h.aws.secrets.has(usw2Name), "us-west-2 的 per-project secret 还在(删错区 / 删错名会回 absent)").toBe(false);
    expect(h.aws.secrets.has(otherName), "别的项目的凭证被删了").toBe(true);
  }, 20_000);

  it("🔴 回收作业入队失败 ⇒ 拒绝删项目(项目与成员都还在)+ 审计如实记下", async () => {
    h.ddb.failNext = { op: "PutCommand", table: "bgp-dataplane-jobs", error: new Error("ProvisionedThroughputExceeded") };
    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("已拒绝删除");
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeTruthy();
    expect(h.ddb.get("bgp-project-members", { projectId: PID, username: "alice" })).toBeTruthy();
    expect(h.audits.map((a) => a.action)).toContain("project.delete.cred-reclaim-refused");
    expect(h.audits.map((a) => a.action)).not.toContain("project.delete");
  }, 20_000);

  it("读不到执行环境清单 ⇒ 拒绝删项目", async () => {
    const reg = await import("@/lib/exec-env/registry");
    vi.mocked(reg.listTargetsRaw).mockRejectedValueOnce(new Error("Throttling"));
    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(503);
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeTruthy();
  }, 20_000);

  it("🔴 项目还在 ⇒ 不动 secret(wait);过了宽限期还在 ⇒ 终态失败,secret 依旧不动", async () => {
    const name = seedSecret("tgt_usw2_a", "us-west-2", PID);
    const t0 = Date.now();
    const { jobs } = await enqueueProjectCredReclaim(PID, { createdBy: "alice", now: t0 });
    const j = jobs.find((x) => x.targetId === "tgt_usw2_a")!;
    await drain(j.jobId, t0 + 1000);
    expect((await getJob(j.jobId))?.phase).toBe("waiting");
    expect(h.aws.secrets.has(name), "项目还在就把它的凭证删了").toBe(true);
    await drain(j.jobId, t0 + RECLAIM_PROJECT_GONE_GRACE_MS + 60_000);
    const row = await getJob(j.jobId);
    expect(row?.phase).toBe("failed");
    expect(row?.lastError).toContain("仍然存在");
    expect(h.aws.secrets.has(name)).toBe(true);
    // 失败的那一代不挡重试:再删一次项目会开下一代
    const again = await enqueueProjectCredReclaim(PID, { createdBy: "alice" });
    const j2 = again.jobs.find((x) => x.targetId === "tgt_usw2_a")!;
    expect(j2.jobId).not.toBe(j.jobId);
    expect(j2.created).toBe(true);
  });

  it("重复入队(双击删除 / 重放)只有一条;删 secret 被拒 ⇒ 可重试、如实记错,secret 还在;恢复后成功", async () => {
    const name = seedSecret("tgt_usw2_a", "us-west-2", PID);
    const a = await enqueueProjectCredReclaim(PID, { createdBy: "alice" });
    const b = await enqueueProjectCredReclaim(PID, { createdBy: "alice" });
    expect(b.jobs.map((x) => x.jobId)).toEqual(a.jobs.map((x) => x.jobId));
    expect(b.jobs.every((x) => x.created === false)).toBe(true);
    h.ddb.tables.get("bgp-projects")!.clear(); // 项目已删
    const j = a.jobs.find((x) => x.targetId === "tgt_usw2_a")!;
    h.aws.secretDeleteErrors.set(name, "AccessDeniedException");
    await drain(j.jobId);
    let row = await getJob(j.jobId);
    expect(row?.phase).toBe("waiting");
    expect(row?.lastError).toContain("回收凭证失败");
    expect(row?.lastError).toContain("AccessDeniedException");
    expect(h.aws.secrets.has(name)).toBe(true);
    h.aws.secretDeleteErrors.clear();
    await drain(j.jobId);
    row = await getJob(j.jobId);
    expect(row?.phase).toBe("succeeded");
    expect(h.aws.secrets.has(name)).toBe(false);
  });

  it("🔴 B-48 已删除且从没装出数仓的环境 ⇒ 一步成功、标 never-supplied(不再留一条重试 6 次的失败作业);负向:已删除但有数仓的照样真删、在用但缺资源的照样重试", async () => {
    const APN1 = { targetId: "tgt_apn1_a", region: "ap-northeast-1", status: "deleted" };
    const USE1 = { targetId: "tgt_use1_a", region: "us-east-1", status: "deleted", resources: { redshiftWorkgroup: "bgp-wg-use1-a", redshiftDatabase: "dev" } };
    const EUW1 = { targetId: "tgt_euw1_a", region: "eu-west-1", status: "active" };
    h.targets = [HOME, USW2, APN1, USE1, EUW1];
    const use1Name = seedSecret("tgt_use1_a", "us-east-1", PID);
    h.ddb.tables.get("bgp-projects")!.clear();
    const { jobs } = await enqueueProjectCredReclaim(PID, { createdBy: "alice" });
    const by = Object.fromEntries(jobs.map((j) => [j.targetId, j.jobId]));
    await drain(by.tgt_apn1_a);
    const apn1 = await getJob(by.tgt_apn1_a);
    expect(apn1?.phase).toBe("succeeded");
    expect(apn1?.evidence).toMatchObject({ outcome: "never-supplied" });
    await drain(by.tgt_use1_a);
    expect((await getJob(by.tgt_use1_a))?.evidence).toMatchObject({ outcome: "deleted" });
    expect(h.aws.secrets.has(use1Name), "已删除但装过数仓的环境:secret 必须真删").toBe(false);
    await drain(by.tgt_euw1_a);
    const euw1 = await getJob(by.tgt_euw1_a);
    expect(euw1?.phase, "在用环境缺资源是异常,不许当成「没东西可回收」").not.toBe("succeeded");
  }, 20_000);

  it("该区从没供给过 ⇒ 回收成功且如实标 absent(不是「删掉了」)", async () => {
    h.ddb.tables.get("bgp-projects")!.clear();
    const { jobs } = await enqueueProjectCredReclaim(PID, { createdBy: "alice" });
    for (const j of jobs) {
      await drain(j.jobId);
      const row = await getJob(j.jobId);
      expect(row?.phase).toBe("succeeded");
      expect(row?.evidence).toMatchObject({ outcome: "absent" });
    }
  });
});

// 序 49 ③ B-95 → 序 50 第二批 —— 数仓冷启动:盘点语句一直没出结果 ⇒ 整条删除由统一框架转 202 `protocol:"long-op/1"`(项目一个字节没动),
//   执行体在后台等到 150 轮预算用尽 ⇒ 任务终态 failed 400「无法核实」(fail-closed 不变,只是不再在 45s 处放弃);醒了 ⇒ 同一条 DELETE 直接 200;
//   语句 FAILED ⇒ 仍 400 fail-closed。真外部只有 FakeAws 的 Redshift Data(pendingPolls 脚本)与内存 bgp-long-ops;路由 ↔ 驱动器 ↔ 执行体 ↔ 盘点 ↔ 阻断算法真装配。
describe("⑤ B-95 数仓正在唤醒 ⇒ 202 统一长操作协议(不再是删项目专用 warming 协议);醒了同一请求 200;失败仍 400", () => {
  const SCHEMA_WAIT_MS = 300_000; // 150 轮 ≈ 296s 盘点等待(见 lib/projects/__tests__/b95-delete-warming.test.ts)
  // 任务行(不是租约行:租约行也带 kind)按 taskId 取
  const taskRow = (taskId: string) => memLongOps.rows.get(taskId);

  it("🔴 缺陷原形:语句一直 STARTED ⇒ 等待预算到期回 202 long-op/1(项目行还在、回收作业零条、无删除审计);后台等满 150 轮 ⇒ 任务 failed 400「无法核实」", async () => {
    h.aws.behaviors.length = 0;
    h.aws.behaviors.push({ match: /information_schema\.tables/, value: "0", pendingPolls: 1_000_000 });
    vi.useFakeTimers();
    try {
      const inflight = DELETE(delReq(), { params: { id: PID } });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await inflight;
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({ kind: "project-delete", label: "删除项目空间", status: "running", async: true, protocol: "long-op/1" });
      expect(body.data.status, "删项目专用 warming 协议已退役").not.toBe("warming");
      expect(body.data.retryAfterMs).toBeUndefined();
      expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID }), "项目行不许动").toBeTruthy();
      expect(h.ddb.all("bgp-dataplane-jobs")).toEqual([]);
      expect(h.audits.find((a) => a.action === "project.delete")).toBeUndefined();
      expect(taskRow(body.data.taskId)).toMatchObject({ taskId: body.data.taskId, status: "running" });
      // 后台继续等:150 轮用尽 ⇒ unavailable ⇒ 阻断 ⇒ 任务终态 failed,状态码 / 文案与同步路径逐字一致(fail-closed)
      await vi.advanceTimersByTimeAsync(SCHEMA_WAIT_MS + 10_000);
      expect(taskRow(body.data.taskId)).toMatchObject({ status: "failed", errorStatus: 400 });
      expect(String(taskRow(body.data.taskId)!.error)).toContain("无法核实数据面 schema");
      expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID }), "失败后项目行仍不许动").toBeTruthy();
      expect(h.ddb.all("bgp-dataplane-jobs")).toEqual([]);
      // 租约随终态释放(否则用户修好后再删会一直 409)
      expect([...memLongOps.rows.keys()].filter((k) => k.startsWith("lease#"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("数仓醒了(STARTED 两次后 FINISHED 回 0)⇒ 同一条 DELETE 不回 202,直接 200 删掉", async () => {
    h.aws.behaviors.length = 0;
    h.aws.behaviors.push({ match: /information_schema\.tables/, value: "0", pendingPolls: 2 });
    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(200);
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeUndefined();
  }, 20_000);

  it("控制面还有内容 + 数仓唤醒中 ⇒ 先 202,后台等满后 400 一并列明阻断原因与「无法核实」(盘点一次做完,不再分两段说)", async () => {
    h.aws.behaviors.length = 0;
    h.aws.behaviors.push({ match: /information_schema\.tables/, value: "0", pendingPolls: 1_000_000 });
    schedule("seedsch_b95", "seed", PID);
    vi.useFakeTimers();
    try {
      const inflight = DELETE(delReq(), { params: { id: PID } });
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await inflight;
      expect(res.status).toBe(202);
      const body = await res.json();
      await vi.advanceTimersByTimeAsync(SCHEMA_WAIT_MS + 10_000);
      const task = taskRow(body.data.taskId)!;
      expect(task).toMatchObject({ status: "failed", errorStatus: 400 });
      expect(String(task.error)).toContain("定时造数任务");
      expect(String(task.error)).toContain("无法核实");
      expect(String(task.error)).not.toContain("唤醒");
      expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("语句 FAILED ⇒ 仍是 400「无法核实」fail-closed(唤醒中 ≠ 不可达)", async () => {
    h.aws.behaviors.length = 0;
    h.aws.behaviors.push({ match: /information_schema\.tables/, error: "permission denied for schema" });
    const res = await DELETE(delReq(), { params: { id: PID } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("无法核实数据面 schema");
    expect(h.ddb.get("bgp-projects", { pk: "project", projectId: PID })).toBeTruthy();
  }, 20_000);
});
