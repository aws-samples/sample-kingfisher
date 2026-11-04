// 供给层门禁(50 SPEC §3.9b「进 `isolated` 的前置」)。
//
// 三条承重:
//  ① **步骤顺序是依赖**(role 先于 schema 的 OWNER TO、user 先于 GRANT ROLE);
//     第一版我按合同的行文顺序写,那个顺序在真库上跑不通 —— 所以顺序必须被钉住。
//  ② **`unverifiable` 是独立一栏**:读失败不是"没有",把它并进 `missing` 会让运维以为
//     "补上这几个就能切",并进 `present` 更糟(直接放行一个其实没凭证的项目)。
//  ③ **在用项目清单必须翻页**:漏掉的项目正是"没凭证却被放行进 isolated"的那一类。
//
// 同步入口 `provisionProjectCredential` 已删(唯一调用方改 202 + 作业);
//   ① 与「幂等与失败」两组改为驱动**作业 handler**(`supplyJobHandler`)逐步走 —— 同一份 `SUPPLY_STEPS`,
//   外加作业化之后才有的那条承重:**续跑不重做已完成的步骤**(尤其 provision-login:重做 = 口令再轮换一次)。
//   runner + store + 真执行器的装配见 lib/dataplane-jobs/__tests__/dataplane-jobs-assembly.test.ts。
import { describe, it, expect, vi, beforeEach } from "vitest";

const ops: string[] = [];
let failOn: { step: string; message: string } | undefined;
vi.mock("@/lib/exec-env/admin-ddl-executor", () => {
  class AdminDdlDenied extends Error {
    constructor(readonly step: string, message: string) {
      super(message);
      this.name = "AdminDdlDenied";
    }
  }
  return {
    AdminDdlDenied,
    systemActor: (reason: string) => ({ actor: `system:${reason}`, isPlatformAdmin: true }),
    submitAdminDdl: vi.fn(async (_a: unknown, req: { operation: string; targetId: string }) => {
      ops.push(req.operation);
      return {
        auditId: `2026-10-11T00:00:00.000Z#${ops.length}`,
        targetId: req.targetId,
        operation: req.operation,
        statementIds: [`st-${ops.length}`],
        region: "us-east-1",
        actor: "alice",
        submittedAt: "2026-10-11T00:00:00.000Z",
      };
    }),
    settleAdminDdl: vi.fn(async (sub: { operation: string; auditId: string }) => {
      if (failOn?.step === sub.operation) return { state: "failed", error: failOn.message, auditId: sub.auditId };
      return { state: "succeeded", affected: 0, auditId: sub.auditId };
    }),
    provisionProjectLogin: vi.fn(async (_a: unknown, args: { targetId: string; projectId: string }) => {
      ops.push("provision-login");
      if (failOn?.step === "provision-login") throw new Error(failOn.message);
      return {
        secretName: `bgp/project/tgt-home/${args.projectId}`,
        secretArn: `arn:aws:secretsmanager:us-east-1:1:secret:bgp/project/tgt-home/${args.projectId}-AbCdEf`,
        created: true,
        auditId: "aid",
      };
    }),
  };
});

let targetRow: Record<string, unknown> | null = null;
vi.mock("@/lib/exec-env/registry", () => ({ getTargetRaw: vi.fn(async () => targetRow) }));

let allProjects: string[] = [];
vi.mock("@/lib/projects/project-service", () => ({
  listAllProjects: vi.fn(async () => allProjects.map((projectId) => ({ projectId }))),
}));

// DDB:按表名逐页返回(用来验"不翻页就会漏")
let pagesByTable: Record<string, Array<Array<Record<string, unknown>>>> = {};
const queriedTables: string[] = [];
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "t-sync", WORKFLOWS: "t-wf", ETL_JOBS: "t-etl", ENGINE_JOBS: "t-eng", DATAPLANE_JOBS: "t-jobs" },
  docClient: {
    send: vi.fn(async (cmd: { input: Record<string, any> }) => {
      const table = String(cmd.input.TableName);
      queriedTables.push(table);
      const pages = pagesByTable[table] ?? [[]];
      const idx = Number((cmd.input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0);
      const more = idx + 1 < pages.length;
      return { Items: pages[idx] ?? [], ...(more ? { LastEvaluatedKey: { page: idx + 1 } } : {}) };
    }),
  },
}));

let secretExists: (region: string, name: string) => Promise<string | undefined> = async () => "arn:aws:sm:::x";
vi.mock("@/lib/exec-env/target-clients", () => ({
  describeSecretArnByName: vi.fn((region: string, name: string) => secretExists(region, name)),
  resolveTargetWarehouse: (t: { targetId: string; region?: string }) => ({
    targetId: t.targetId,
    region: t.region ?? "us-east-1",
    workgroup: "wg",
    database: "dev",
  }),
}));

const { SUPPLY_STEPS, supplyJobHandler, listProjectsWithBindings, verifyProjectCredentials } = await import(
  "@/lib/exec-env/project-cred-supply"
);
const { projectSecretName } = await import("@/lib/exec-env/project-schema");

const PROJ_A = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const PROJ_B = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";
const ACTOR = { actor: "alice", isPlatformAdmin: true };

type Job = Record<string, any>;
function newJob(projectId: string): Job {
  return {
    jobId: "dpj_" + "0".repeat(40),
    kind: "supply",
    targetId: "tgt_home",
    projectId,
    idempotencyKey: "g1",
    phase: "running",
    state: { stepIndex: 0, runAs: ACTOR, steps: [] },
    progress: { done: 0, total: SUPPLY_STEPS.length },
    evidence: {},
    attempts: 0,
    revision: 1,
    nextRunAt: 0,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    createdBy: "alice",
  };
}

/** 逐步驱动 handler,直到出现非 continue 的结论(模拟 runner 的「每步存档后再走下一步」)。 */
async function drive(job: Job, maxSteps = 40): Promise<{ job: Job; next: { kind: string; reason?: string } }> {
  for (let i = 0; i < maxSteps; i++) {
    const r = await supplyJobHandler.step({ job, now: () => Date.now(), deadline: Date.now() + 1e9, sleep: async () => {} });
    job = { ...job, state: r.state, evidence: r.evidence, progress: r.progress };
    if (r.next.kind !== "continue") return { job, next: r.next as { kind: string; reason?: string } };
  }
  throw new Error("handler 一直回 continue,没有收口");
}

beforeEach(() => {
  ops.length = 0;
  queriedTables.length = 0;
  failOn = undefined;
  targetRow = { targetId: "tgt_home", region: "us-east-1" };
  allProjects = [PROJ_A, PROJ_B];
  pagesByTable = {};
  secretExists = async () => "arn:aws:sm:::x";
});

describe("🔴 ① 供给步骤的顺序 = 依赖顺序(不是合同的行文顺序)", () => {
  it("六步依序:shared → role → **login** → schema → grant-role-to-login → grant(再加回读核验)", async () => {
    const { job, next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("succeeded");
    expect(ops).toEqual([
      "create-shared-schema",
      "create-role",
      "provision-login",
      "create-project-schema",
      "grant-role-to-login",
      "grant",
    ]);
    expect(job.evidence.secretName).toBe(`bgp/project/tgt-home/${PROJ_A}`);
    expect(projectSecretName("tgt_home", PROJ_A)).toBeTruthy();
    expect(job.evidence.steps.map((s: { step: string }) => s.step)).toEqual(SUPPLY_STEPS.map((s) => s.step));
    expect(job.evidence.steps.every((s: { ok: boolean }) => s.ok)).toBe(true);
  });

  const order = SUPPLY_STEPS.map((s) => s.step) as string[];
  it("🔴 `provision-login` 必须在 `create-project-schema` **之前** —— 真环境逮到的那个 bug 的连带约束", () => {
    // schema 的 `ALTER SCHEMA … OWNER TO` 指向**登录用户**(Redshift 的 schema 属主必须是 user,
    // role 不能当属主)。第一版把 schema 排在 login 前面,真环境当场报 user does not exist。
    expect(order.indexOf("provision-login")).toBeLessThan(order.indexOf("create-project-schema"));
  });

  it("🔴 `provision-login` 必须在 `grant-role-to-login` **之前**(GRANT ROLE 引用那个用户)", () => {
    expect(order.indexOf("provision-login")).toBeLessThan(order.indexOf("grant-role-to-login"));
  });

  it("🔴 `create-shared-schema` 必须在 `grant` **之前**(grant 会授 shared 上的权限)", () => {
    expect(order.indexOf("create-shared-schema")).toBeLessThan(order.indexOf("grant"));
  });

  it("🔴 回读核验是**最后一步**(写得进去 ≠ 是对的)", () => {
    expect(order[order.length - 1]).toBe("verify");
  });
});

describe("🔴 幂等与失败(作业化)", () => {
  it("`create-role` 报 already exists ⇒ 幂等跳过并继续(Redshift 没有 CREATE ROLE IF NOT EXISTS)", async () => {
    failOn = { step: "create-role", message: 'role "role_proj_x" already exists' };
    const { job, next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("succeeded");
    expect(job.evidence.steps.find((s: { step: string }) => s.step === "create-role")).toEqual({
      step: "create-role",
      ok: true,
      note: "已存在(幂等跳过)",
    });
    expect(ops).toContain("grant"); // 没有半途而废
  });

  it("🔴 容忍**只**作用在标了 tolerate 的那一步:其它步的 already-exists 照样判失败(retry),且 pending 被清掉", async () => {
    failOn = { step: "grant", message: "already exists" };
    const { job, next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("retry");
    expect(next.reason).toMatch(/第「grant」步失败/);
    // 🔴 pending 必须清掉:否则下一轮读的还是那条已失败的语句,永远不重新提交
    expect(job.state.pending).toBeUndefined();
    expect(job.state.stepIndex).toBe(SUPPLY_STEPS.findIndex((s) => s.step === "grant"));
  });

  it("失败时**已完成的步骤**留在证据里(半套凭证要能看出停在哪)", async () => {
    failOn = { step: "provision-login", message: "GetWorkgroup 失败" };
    const { job, next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("retry");
    expect(next.reason).toMatch(/provision-login/);
    expect(job.evidence.steps.map((s: { step: string }) => s.step)).toEqual(["create-shared-schema", "create-role"]);
  });

  it("🔴🔴 续跑不重做:login 之后「进程被杀」⇒ 从存档接着走,provision-login 只发生一次(重做 = 口令再轮换 = 重建)", async () => {
    // 走到 login 刚做完就停(模拟进程在下一步之前被杀):手动驱动 3 步(submit shared / settle shared … )
    let job = newJob(PROJ_A);
    for (let i = 0; i < 20; i++) {
      const r = await supplyJobHandler.step({ job, now: () => Date.now(), deadline: Date.now() + 1e9, sleep: async () => {} });
      job = { ...job, state: r.state, evidence: r.evidence };
      if (ops.includes("provision-login")) break;
    }
    expect(ops.filter((o) => o === "provision-login")).toHaveLength(1);
    // 「重启」:拿存档里的 state 重新驱动到底
    const persisted = JSON.parse(JSON.stringify(job));
    const { next } = await drive(persisted);
    expect(next.kind).toBe("succeeded");
    expect(ops.filter((o) => o === "provision-login"), "续跑把已完成的 login 又做了一遍").toHaveLength(1);
    expect(ops.filter((o) => o === "create-role"), "续跑把已完成的 create-role 又提交了一遍").toHaveLength(1);
  });

  it("回读核验发现 secret 不存在 ⇒ retry(不许宣称供给成功)", async () => {
    secretExists = async () => undefined;
    const { next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("retry");
    expect(next.reason).toMatch(/不存在/);
  });

  it("回读核验读失败 ⇒ retry 并说「无法核实」(读不到 ≠ 没有,也 ≠ 有)", async () => {
    secretExists = async () => {
      throw new Error("ThrottlingException");
    };
    const { next } = await drive(newJob(PROJ_A));
    expect(next.kind).toBe("retry");
    expect(next.reason).toMatch(/无法核实/);
  });

  it("非法 projectId ⇒ 一步都不发(名字派生不出来就不该动库)", async () => {
    await expect(drive(newJob("proj-lowercase-bad"))).rejects.toThrow(/非法 projectId/);
    expect(ops).toHaveLength(0);
  });
});

describe("🔴 ② verifyProjectCredentials 必须三分(present / missing / unverifiable)", () => {
  it("有 ⇒ present;明确没有(undefined)⇒ missing", async () => {
    secretExists = async (_r, name) => (name.endsWith(PROJ_A) ? "arn:aws:sm:::a" : undefined);
    const v = await verifyProjectCredentials("tgt_home", [PROJ_A, PROJ_B]);
    expect(v.present).toEqual([PROJ_A]);
    expect(v.missing).toEqual([PROJ_B]);
    expect(v.unverifiable).toEqual([]);
  });

  it("🔴 读失败 ⇒ 进 **unverifiable**,不许并进 missing 也不许并进 present", async () => {
    secretExists = async (_r, name) => {
      if (name.endsWith(PROJ_B)) throw new Error("AccessDeniedException");
      return "arn:aws:sm:::a";
    };
    const v = await verifyProjectCredentials("tgt_home", [PROJ_A, PROJ_B]);
    expect(v.present).toEqual([PROJ_A]);
    expect(v.missing, "读失败被当成「没有」⇒ 运维会以为补上就能切").toEqual([]);
    expect(v.unverifiable.map((u) => u.projectId)).toEqual([PROJ_B]);
    expect(v.unverifiable[0].why).toMatch(/AccessDenied/);
  });

  it("projectId 形态非法(名字派生不出来)⇒ 也进 unverifiable,不当成「没有」", async () => {
    const v = await verifyProjectCredentials("tgt_home", ["proj-bad"]);
    expect(v.unverifiable.map((u) => u.projectId)).toEqual(["proj-bad"]);
    expect(v.missing).toEqual([]);
  });

  it("target 不存在 ⇒ 抛(不是回一份空的「都没问题」)", async () => {
    targetRow = null;
    await expect(verifyProjectCredentials("tgt_usw2_a", [PROJ_A])).rejects.toThrow(/执行目标不存在/);
  });
});

describe("🔴 ③ 在用项目清单", () => {
  it("home ⇒ 全部项目(宁可多算:多算只让 isolated 的门更严)", async () => {
    const list = await listProjectsWithBindings("tgt_home");
    expect(list).toEqual([PROJ_A, PROJ_B].sort());
    expect(queriedTables, "home 不该去扫资源表").toHaveLength(0);
  });

  it("非 home ⇒ 扫四张资源表,只取显式盖了该 targetId 的行", async () => {
    pagesByTable = {
      "t-sync": [[{ targetId: "tgt_usw2_a", projectId: PROJ_A }, { targetId: "tgt_home", projectId: PROJ_B }]],
      "t-wf": [[{ projectId: PROJ_B }]], // 无 targetId = home,不算
      "t-etl": [[]],
      "t-eng": [[]],
    };
    const list = await listProjectsWithBindings("tgt_usw2_a");
    expect(list).toEqual([PROJ_A]);
    expect(new Set(queriedTables)).toEqual(new Set(["t-sync", "t-wf", "t-etl", "t-eng"]));
  });

  it("🔴 **第三页**上的项目也要被算进来(变异:去掉 ExclusiveStartKey ⇒ 本条必红)", async () => {
    pagesByTable = {
      "t-sync": [
        [{ targetId: "tgt_home", projectId: PROJ_A }],
        [{ targetId: "tgt_usw2_a", projectId: PROJ_A }],
        [{ targetId: "tgt_usw2_a", projectId: PROJ_B }],
      ],
      "t-wf": [[]],
      "t-etl": [[]],
      "t-eng": [[]],
    };
    const list = await listProjectsWithBindings("tgt_usw2_a");
    expect(list, "漏掉的项目正是「没凭证却被放行进 isolated」的那一类").toEqual([PROJ_A, PROJ_B].sort());
  });

  it("资源行上的 projectId 若不在项目台账里 ⇒ 不算(幽灵项目不该卡住 isolated)", async () => {
    allProjects = [PROJ_A];
    pagesByTable = {
      "t-sync": [[{ targetId: "tgt_usw2_a", projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAEZ" }]],
      "t-wf": [[]],
      "t-etl": [[]],
      "t-eng": [[]],
    };
    expect(await listProjectsWithBindings("tgt_usw2_a")).toEqual([]);
  });
});
