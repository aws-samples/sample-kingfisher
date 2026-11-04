// @kf-batch 52-P52.5a-supply
// 🔴 闭合 admin-DDL 执行器的门禁(50 SPEC §3.9a 九步固定序)。
//
// 本文件的每一条都对着一个**能真发生**的失败:
//   · 口令进审计 ⇒ 审计表变成口令库;
//   · 审计挪到执行之后 ⇒ 执行过但没记录;
//   · SecretArn 省掉 ⇒ 退回联邦身份、表属主分叉(P52.1-L1 修过);
//   · lint 少传 projectId ⇒ 跨项目归属校验形同不存在;
//   · 审批只看"带了单号" ⇒ 一张成员审批单就能当删库许可。
// 🔴 全部写成**可执行断言**:文本级门禁证明不了 `...(x ? {x} : {})` 这类"源码里有、运行时没有"。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── 被观察的调用轨迹(顺序即语义:审计必须在执行之前)──
type TraceEntry = { kind: string; detail?: unknown };
const trace: TraceEntry[] = [];

// ── target-clients:整体打桩(执行器的第 8 步由 target-clients.test.ts 单独真跑)──
const execCalls: Array<{ sql: string; secretArn: string; region: string; workgroup: string }> = [];
const secretWrites: Array<{ region: string; name: string; value: Record<string, unknown> }> = [];
vi.mock("@/lib/exec-env/target-clients", () => ({
  resolveTargetWarehouse: (t: { targetId: string; region?: string }) => ({
    targetId: t.targetId,
    region: t.region ?? "us-east-1",
    workgroup: t.targetId === "tgt_home" ? "bgp-workgroup" : "bgp-workgroup-usw2a",
    database: "dev",
  }),
  execOnTarget: vi.fn(async (a: { warehouse: { region: string; workgroup: string }; sql: string; secretArn: string }) => {
    execCalls.push({ sql: a.sql, secretArn: a.secretArn, region: a.warehouse.region, workgroup: a.warehouse.workgroup });
    trace.push({ kind: "exec", detail: a.sql });
    return { affected: 0, statementId: `s${execCalls.length}` };
  }),
  resolveTargetEndpoint: vi.fn(async () => ({ host: "wg.123.us-east-1.redshift-serverless.amazonaws.com", port: 5439 })),
  putSecretJson: vi.fn(async (region: string, name: string, value: Record<string, unknown>) => {
    secretWrites.push({ region, name, value });
    trace.push({ kind: "secret-write", detail: name });
    return { arn: `arn:aws:secretsmanager:${region}:1:secret:${name}-AbCdEf`, created: true };
  }),
  describeSecretArnByName: vi.fn(async () => undefined),
  secretsClientFor: vi.fn(),
  redshiftDataClientFor: vi.fn(),
  __resetTargetClients: vi.fn(),
}));

// ── 审计:打桩成可控可失败(fail-closed-on-audit 要能验)──
const audits: Array<{ actor: string; action: string; detail: unknown }> = [];
let auditThrowsOn: string | undefined;
vi.mock("@/lib/audit", () => ({
  writeAuditRecord: vi.fn(async (actorRef: { actor: string }, action: string, opts: { detail?: unknown }) => {
    if (auditThrowsOn && action.includes(auditThrowsOn)) throw new Error("DDB 挂了");
    audits.push({ actor: actorRef.actor, action, detail: opts?.detail });
    trace.push({ kind: `audit:${action}` });
    return `2026-09-04T00:00:00.000Z#${audits.length}`;
  }),
  recordAudit: vi.fn(async () => {}),
}));

// ── registry:只桩 requireReadyTarget(整包校验/准入的真实现在它自己的测试里)──
let currentTarget: Record<string, unknown> | null = null;
vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (targetId: string) => {
    if (!currentTarget) throw new Error(`target ${targetId} 不可用`);
    return currentTarget;
  }),
  getTargetRaw: vi.fn(async () => currentTarget),
}));

// ── 项目台账 ──
let projects = new Set<string>();
let approvals: Record<string, { approvalId: string; projectId: string; type: string; status: string }> = {};
vi.mock("@/lib/projects/project-service", () => ({
  getProject: vi.fn(async (id: string) => (projects.has(id) ? { projectId: id, name: id } : null)),
  getApproval: vi.fn(async (id: string) => approvals[id] ?? null),
  listAllProjects: vi.fn(async () => Array.from(projects).map((projectId) => ({ projectId }))),
}));

// ── @kf-batch 50-WP11b-shared-writer:建模台账(成员资格守卫的真值源;执行器第 2 步动态 import 它们)──
let codeTables: Record<string, { codeTableId: string; code: string }> = {};
let modelTables: Record<string, Record<string, unknown>> = {};
vi.mock("@/lib/modeling/service", () => ({
  getCodeTable: vi.fn(async (id: string) => codeTables[id] ?? null),
}));
vi.mock("@/lib/modeling/dimensions", () => ({
  getModelTable: vi.fn(async (id: string) => modelTables[id] ?? null),
}));

// ── 守卫:保留真实现,但套 spy(好断言"lint 真的带了 projectId")──
const guards = await vi.importActual<typeof import("@/lib/exec-env/admin-ddl-guards")>(
  "@/lib/exec-env/admin-ddl-guards"
);
const lintSpy = vi.fn(guards.lintGeneratedStatement);
vi.mock("@/lib/exec-env/admin-ddl-guards", () => ({ ...guards, lintGeneratedStatement: lintSpy }));

const executorMod = await import("@/lib/exec-env/admin-ddl-executor");
const { executeAdminDdl, provisionProjectLogin, provisionSharedWriter, actorFromIdentity, systemActor, AdminDdlDenied, redactSql, ADMIN_DDL_PLACE_VIA } =
  executorMod;
// @kf-batch 50-WP31-place-first-class(B-98)—— 落点决策账本(真模块;请求存储由测试注入)
const placeCtx = await import("@/lib/place/context");
const { projectDbUserName, projectRoleName, projectSchema, projectSecretName } = await import(
  "@/lib/exec-env/project-schema"
);

const PROJ_A = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const PROJ_B = "proj-01M1KP594D2E6DJQC8EZ8CRAEZ";
const ADMIN = { actor: "alice@x.com", isPlatformAdmin: true };
const DEV = { actor: "bob@x.com", isPlatformAdmin: false };

const HOME_TARGET = {
  targetId: "tgt_home",
  region: "us-east-1",
  credentialIsolationState: "legacy-seeded",
  credentialEpoch: 0,
  resources: { redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:redshift!admin-x" },
};

// 🔴 打桩的**默认实现**单独抽出来:某个用例用 `mockRejectedValue`(非 Once)之后,
// 若不在 beforeEach 里恢复,它会一直拒绝下去 —— 后面的用例会以一个莫名其妙的错误红掉
// (本文件第一版就这样红了两条,而且红的位置离肇事用例很远)。
const execOnTargetDefault = async (a: {
  warehouse: { region: string; workgroup: string };
  sql: string;
  secretArn: string;
}) => {
  execCalls.push({ sql: a.sql, secretArn: a.secretArn, region: a.warehouse.region, workgroup: a.warehouse.workgroup });
  trace.push({ kind: "exec", detail: a.sql });
  return { affected: 0, statementId: `s${execCalls.length}` };
};

beforeEach(async () => {
  const tc = await import("@/lib/exec-env/target-clients");
  (tc.execOnTarget as unknown as { mockReset: () => void; mockImplementation: (f: unknown) => void }).mockReset();
  (tc.execOnTarget as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
    execOnTargetDefault
  );
  trace.length = 0;
  execCalls.length = 0;
  secretWrites.length = 0;
  audits.length = 0;
  auditThrowsOn = undefined;
  lintSpy.mockClear();
  currentTarget = { ...HOME_TARGET };
  projects = new Set([PROJ_A, PROJ_B]);
  approvals = {};
  codeTables = { region_cn: { codeTableId: "region_cn", code: "region_cn" } };
  modelTables = {};
});

describe("🔴 九步固定序:审计在执行**之前**,凭证在校验**之后**", () => {
  it("成功路径的轨迹 = 意图审计 → 执行 → 结果审计(顺序是语义,不是风格)", async () => {
    const r = await executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_home", projectId: PROJ_A });
    expect(r.auditId).toMatch(/^2026-/);
    expect(trace.map((t) => t.kind)).toEqual([
      "audit:exec-env.admin-ddl.intent",
      "exec",
      "audit:exec-env.admin-ddl.done",
    ]);
  });

  it("🔴 意图审计写不进去 ⇒ 拒绝执行,且**一条语句都没发**(fail-closed-on-audit)", async () => {
    auditThrowsOn = "intent";
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_home", projectId: PROJ_A })
    ).rejects.toThrow(/fail-closed-on-audit/);
    expect(execCalls, "审计失败却已经执行了 ⇒ 执行过但没有记录").toHaveLength(0);
  });

  it("执行失败 ⇒ 仍写一条 failed 审计(失败记录同样是复盘证据)", async () => {
    const { execOnTarget } = await import("@/lib/exec-env/target-clients");
    (execOnTarget as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("permission denied")
    );
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_home", projectId: PROJ_A })
    ).rejects.toThrow(/permission denied/);
    expect(audits.map((a) => a.action)).toEqual(["exec-env.admin-ddl.intent", "exec-env.admin-ddl.failed"]);
  });
});

describe("🔴 禁 IAM fallback:凭证解析不到就拒", () => {
  it("描述符没有 redshiftSecretArn ⇒ 抛(第 7 步),且零执行", async () => {
    currentTarget = { ...HOME_TARGET, resources: {} };
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" })
    ).rejects.toThrow(/禁 IAM fallback/);
    expect(execCalls).toHaveLength(0);
  });

  it("redshiftSecretArn 不是 ARN 形态 ⇒ 同样拒(而不是把垃圾串当凭证传下去)", async () => {
    currentTarget = { ...HOME_TARGET, resources: { redshiftSecretArn: "redshift!admin-x" } };
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" })
    ).rejects.toThrow(/禁 IAM fallback/);
  });

  it("正常路径:每条执行都带**该 target 的** admin ARN 与落点", async () => {
    currentTarget = {
      ...HOME_TARGET,
      targetId: "tgt_usw2_a",
      region: "us-west-2",
      resources: { redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:a" },
    };
    await executeAdminDdl(ADMIN, { operation: "grant", targetId: "tgt_usw2_a", projectId: PROJ_A });
    expect(execCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of execCalls) {
      expect(c.secretArn).toBe("arn:aws:secretsmanager:us-west-2:1:secret:a");
      expect(c.region, "打到了 home ⇒ 静默跨区执行").toBe("us-west-2");
      expect(c.workgroup).toBe("bgp-workgroup-usw2a");
    }
  });
});

describe("🔴 第 2 步交叉验证 + 第 3 步隔离状态", () => {
  it("body 里的 projectId 在台账里不存在 ⇒ 拒(不只信 body)", async () => {
    projects = new Set([PROJ_B]);
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_home", projectId: PROJ_A })
    ).rejects.toThrow(/项目台账里不存在/);
    expect(execCalls).toHaveLength(0);
  });

  it("缺 credentialIsolationState ⇒ 拒(绝不隐式当 legacy)", async () => {
    currentTarget = { ...HOME_TARGET, credentialIsolationState: undefined };
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" })
    ).rejects.toThrow(/credentialIsolationState 缺失或未知/);
  });

  it("epoch 进审计(事后能复盘「当时是哪一世代」)", async () => {
    currentTarget = { ...HOME_TARGET, credentialEpoch: 7 };
    await executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" });
    expect((audits[0].detail as { credentialEpoch: number }).credentialEpoch).toBe(7);
  });
});

describe("🔴 第 4 步 RBAC / 审批", () => {
  it("非平台管理员 ⇒ 全部 operation 都拒", async () => {
    for (const op of ["create-shared-schema", "dms-ingest-bootstrap"] as const) {
      await expect(executeAdminDdl(DEV, { operation: op, targetId: "tgt_home" })).rejects.toThrow(/平台管理员/);
    }
    await expect(
      executeAdminDdl(DEV, { operation: "create-role", targetId: "tgt_home", projectId: PROJ_A })
    ).rejects.toThrow(/平台管理员/);
    expect(execCalls).toHaveLength(0);
  });

  it("匿名 actor / 缺 isPlatformAdmin ⇒ 拒(缺省即拒,不静默降级成不鉴权)", async () => {
    await expect(
      executeAdminDdl({ actor: "", isPlatformAdmin: true }, { operation: "create-shared-schema", targetId: "tgt_home" })
    ).rejects.toThrow(/具名 actor/);
    await expect(
      executeAdminDdl(
        { actor: "x" } as unknown as { actor: string; isPlatformAdmin: boolean },
        { operation: "create-shared-schema", targetId: "tgt_home" }
      )
    ).rejects.toThrow(/isPlatformAdmin 必须显式给出/);
  });

  const dropReq = (approvalId: string, projectId = PROJ_A) => ({
    operation: "drop-project-schema" as const,
    targetId: "tgt_home",
    projectId,
    approvalId,
  });

  it("🔴 破坏性操作:审批单不存在 ⇒ 拒(「带了单号」≠「批过」)", async () => {
    await expect(executeAdminDdl(ADMIN, dropReq("ap1"))).rejects.toThrow(/不存在/);
  });

  it("审批单是 pending / rejected ⇒ 拒", async () => {
    for (const status of ["pending", "rejected"]) {
      approvals = { ap1: { approvalId: "ap1", projectId: PROJ_A, type: "project-delete", status } };
      await expect(executeAdminDdl(ADMIN, dropReq("ap1"))).rejects.toThrow(new RegExp(status));
    }
  });

  it("🔴 审批单属于**别的项目** ⇒ 拒(否则拿 A 批过的单子删 B 的 schema)", async () => {
    approvals = { ap1: { approvalId: "ap1", projectId: PROJ_B, type: "project-delete", status: "approved" } };
    await expect(executeAdminDdl(ADMIN, dropReq("ap1", PROJ_A))).rejects.toThrow(/与请求的.*不符/);
  });

  it("🔴 审批单类型不在破坏性白名单里 ⇒ 拒(一张成员审批单不能当删库许可)", async () => {
    approvals = { ap1: { approvalId: "ap1", projectId: PROJ_A, type: "membership", status: "approved" } };
    await expect(executeAdminDdl(ADMIN, dropReq("ap1"))).rejects.toThrow(/不在破坏性操作白名单/);
  });

  it("四项全对 ⇒ 放行,并真的发出 DROP SCHEMA … CASCADE", async () => {
    approvals = { ap1: { approvalId: "ap1", projectId: PROJ_A, type: "project-delete", status: "approved" } };
    await executeAdminDdl(ADMIN, dropReq("ap1"));
    expect(execCalls[0].sql).toBe(`DROP SCHEMA IF EXISTS "${projectSchema(PROJ_A)}" CASCADE`);
  });
});

describe("🔴 第 5 步:模板产物逐条过 lint,且**带 projectId**", () => {
  it("有项目维的 operation:lint 的第二参必须含 projectId(少了它归属校验形同不存在)", async () => {
    await executeAdminDdl(ADMIN, { operation: "grant", targetId: "tgt_home", projectId: PROJ_A });
    expect(lintSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of lintSpy.mock.calls) {
      expect(call[1], "lint 少传 projectId ⇒ assertOwnedByProject 不会跑").toMatchObject({ projectId: PROJ_A });
    }
  });

  it("target 级 operation:不传 projectId(传了反而说明语义搞错)", async () => {
    await executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" });
    expect(lintSpy.mock.calls[0][1]).toBeUndefined();
  });

  it("`grant-role-to-login` 产物 = 零字面量的纯权限语句(所以它进审计是安全的)", async () => {
    await executeAdminDdl(ADMIN, { operation: "grant-role-to-login", targetId: "tgt_home", projectId: PROJ_A });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].sql).toBe(`GRANT ROLE "${projectRoleName(PROJ_A)}" TO "${projectDbUserName(PROJ_A)}"`);
    expect(execCalls[0].sql, "出现了单引号字面量 ⇒ 就不该留在模板里").not.toContain("'");
  });

  it("审计只写**骨架**,不写完整语句(字面量已被 mask)", async () => {
    approvals = { ap1: { approvalId: "ap1", projectId: PROJ_A, type: "project-delete", status: "approved" } };
    await executeAdminDdl(ADMIN, {
      operation: "land-code-table",
      targetId: "tgt_home",
      codeTableId: "region_cn",
    });
    const skeletons = (audits[0].detail as { sqlSkeletons: string[] }).sqlSkeletons;
    // COMMENT ON … IS 'code-table:region_cn' 里的字面量必须已经被抹掉
    expect(skeletons.join(" ")).not.toContain("code-table:region_cn");
    expect(skeletons.join(" ")).toContain("comment on table");
  });
});

describe("🔴🔴 create-project-schema:属主必须是**登录用户**,不是 role(真环境逮到的真 bug)", () => {
  // 【为什么这条必须是可执行断言】原模板写的是 `ALTER SCHEMA … OWNER TO "role_proj_…"`,
  // 真环境第一次执行就报 `ERROR: user "role_proj_proj_01m1…" does not exist` ——
  // Redshift 的 schema 属主**必须是 user**,role 不能当属主。
  // 而 1801 个单测一个都没抓到,因为本模板在 G2R 落地时**零生产调用方**、单测只断"产物里有 role 名",
  // mock 也不会真跑 Redshift(memory `unwired-code-is-unverified`)。
  // ⇒ 这里把"属主是登录用户"钉成逐字节断言,并配一条负向断言堵回退。
  it("产物 = CREATE SCHEMA IF NOT EXISTS + ALTER SCHEMA … OWNER TO 「登录用户」", async () => {
    await executeAdminDdl(ADMIN, { operation: "create-project-schema", targetId: "tgt_home", projectId: PROJ_A });
    expect(execCalls.map((c) => c.sql)).toEqual([
      `CREATE SCHEMA IF NOT EXISTS "${projectSchema(PROJ_A)}"`,
      `ALTER SCHEMA "${projectSchema(PROJ_A)}" OWNER TO "${projectDbUserName(PROJ_A)}"`,
    ]);
  });

  it("🔴 负向:OWNER TO 后面**不许**出现 role 名(变异改回 role ⇒ 本条必红)", async () => {
    await executeAdminDdl(ADMIN, { operation: "create-project-schema", targetId: "tgt_home", projectId: PROJ_A });
    const alter = execCalls.map((c) => c.sql).find((x) => x.includes("OWNER TO"))!;
    expect(alter, "属主写成了 role ⇒ Redshift 会报 user does not exist").not.toContain(projectRoleName(PROJ_A));
    expect(alter).toContain(projectDbUserName(PROJ_A));
  });
});

describe("🔴🔴 provisionProjectLogin:口令**绝不**落审计,也不进返回值", () => {
  it("口令真的被用了(写进了 secret),但审计里一个字都没有", async () => {
    const r = await provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A });

    // ① 口令真的生成并写进了 secret —— 先证明"有东西可泄露",否则下面的负向断言是空的
    expect(secretWrites).toHaveLength(1);
    const pw = String(secretWrites[0].value.password);
    expect(pw.length).toBeGreaterThan(20);
    expect(secretWrites[0].value.username).toBe(projectDbUserName(PROJ_A));
    // 🔴 名字来自 SSOT `projectSecretName()` ⇒ 这里**不手写**期望值,而是与 SSOT 逐字节对。
    // (第一版我手写成 `bgp/project/home/…`,而 `toTargetSlug("tgt_home")` 其实是 `tgt-home` ——
    //  手写期望值就是在给同一个名字造第二个作者。)
    expect(secretWrites[0].name).toBe(projectSecretName("tgt_home", PROJ_A));

    // ② 审计里没有口令、也没有 `password` 这个词
    const auditJson = JSON.stringify(audits);
    expect(auditJson, "口令进了审计 ⇒ 审计表变成口令库").not.toContain(pw);
    expect(auditJson.toLowerCase(), "审计 detail 里出现了 password 字面量").not.toContain("password");

    // ③ 审计里有的是**固定脱敏描述符**
    expect(auditJson).toContain(`create-login:${projectDbUserName(PROJ_A)}@tgt_home`);

    // ④ 返回值里没有口令(只有该项目自己 secret 的 ARN + 名字)
    expect(JSON.stringify(r)).not.toContain(pw);
    expect(Object.keys(r).sort()).toEqual(["auditId", "created", "secretArn", "secretName"]);
  });

  it("🔴 执行侧也不许把口令带出来:CREATE USER 语句没有进任何审计", async () => {
    await provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A });
    const sqlSent = execCalls.map((c) => c.sql).join(" ");
    expect(sqlSent, "该语句本身当然含口令(它就是干这个的)").toMatch(/^CREATE USER "user_proj_/);
    expect(JSON.stringify(audits), "带口令的语句进了审计").not.toContain("CREATE USER");
  });

  it("CREATE USER 撞已存在 ⇒ 回落 ALTER USER 重设口令(幂等),且仍不泄露", async () => {
    const { execOnTarget } = await import("@/lib/exec-env/target-clients");
    (execOnTarget as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('user "user_proj_x" already exists')
    );
    await provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A });
    expect(execCalls.map((c) => c.sql.split(" ").slice(0, 2).join(" "))).toEqual(["ALTER USER"]);
    expect(secretWrites).toHaveLength(1);
  });

  it("🔴 执行报错时抛出去的文本已脱敏(错误会进日志/HTTP 响应)", async () => {
    const { execOnTarget } = await import("@/lib/exec-env/target-clients");
    const m = execOnTarget as unknown as { mockRejectedValue: (e: Error) => void; mockReset: () => void };
    m.mockRejectedValue(new Error("syntax error at PASSWORD 'Kf-super-secret-7'"));
    await expect(provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A })).rejects.toThrow(
      /redacted/
    );
    await expect(provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A })).rejects.not.toThrow(
      /Kf-super-secret-7/
    );
    expect(JSON.stringify(audits)).not.toContain("Kf-super-secret-7");
  });

  it("非管理员 / 项目不存在 / 审计失败 ⇒ 三条各自拒,且不写 secret", async () => {
    await expect(provisionProjectLogin(DEV, { targetId: "tgt_home", projectId: PROJ_A })).rejects.toThrow(
      /平台管理员/
    );
    projects = new Set([PROJ_B]);
    await expect(provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A })).rejects.toThrow(
      /台账里不存在/
    );
    projects = new Set([PROJ_A]);
    auditThrowsOn = "intent";
    await expect(provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A })).rejects.toThrow(
      /fail-closed-on-audit/
    );
    expect(secretWrites).toHaveLength(0);
  });

  it("端点解析不到 ⇒ 抛,绝不写**半份** secret(写得进去 ≠ 是对的)", async () => {
    const { resolveTargetEndpoint } = await import("@/lib/exec-env/target-clients");
    (resolveTargetEndpoint as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error("GetWorkgroup 失败")
    );
    await expect(provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A })).rejects.toThrow(
      /GetWorkgroup 失败/
    );
    expect(secretWrites).toHaveLength(0);
  });
});

describe("🔴 返回面封闭:本模块不导出任何拿得到 admin 凭证的口子", () => {
  it("导出名里不出现 admin+secret / password 组合;白名单式钉住导出面", () => {
    const names = Object.keys(executorMod).sort();
    for (const n of names) {
      expect(n, "导出名暗示能拿到 admin 凭证").not.toMatch(/admin.*secret|secret.*admin|password|credential.*arn/i);
    }
    // 白名单:新增导出必须在这里显式过一遍(防有人偷偷加回取凭证的口子)
    expect(names).toEqual([
      // @kf-batch 50-WP31-place-first-class(B-98)—— 落点决策署名常量(字面 "admin-ddl-executor"),不是取凭证的口子
      "ADMIN_DDL_PLACE_VIA",
      "AdminDdlDenied",
      "actorFromIdentity",
      "executeAdminDdl",
      "provisionProjectLogin",
      // @kf-batch 50-WP11b-shared-writer —— 第三个公开入口(SPEC §3.9d.4);返回值里同样没有 ARN / 口令
      "provisionSharedWriter",
      "redactSql",
      // @kf-batch 50-WP9a-durable-jobs —— 两段式入口(§3.9a 合同差分 ③-1):提交凭据里只有 auditId / statementId / region,
      //   读终态只回 affected / 脱敏错误 —— 与同步入口同一条「返回面封闭」
      "settleAdminDdl",
      "submitAdminDdl",
      "systemActor",
    ]);
  });

  it("`adminSecretArnOf` 是模块私有(源码里必须**没有** export 它)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../admin-ddl-executor.ts"),
      "utf8"
    );
    expect(src).toMatch(/^function adminSecretArnOf/m);
    expect(src, "adminSecretArnOf 被导出了 ⇒ admin 凭证有了正门出口").not.toMatch(
      /^export\s+(async\s+)?function adminSecretArnOf/m
    );
  });

  it("两个公开入口的返回值里都没有 secret 明文 / admin ARN", async () => {
    const r1 = await executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" });
    expect(Object.keys(r1).sort()).toEqual(["affected", "auditId"]);
    const r2 = await provisionProjectLogin(ADMIN, { targetId: "tgt_home", projectId: PROJ_A });
    // 唯一的 ARN 是**该项目自己的** secret,不是 admin 那个
    expect(r2.secretArn).toContain(projectSecretName("tgt_home", PROJ_A));
    expect(r2.secretArn).not.toContain("redshift!admin");
  });
});

describe("actor 构造与脱敏工具", () => {
  it("actorFromIdentity:email > username > sub;isPlatformAdmin 原样透传", () => {
    expect(
      actorFromIdentity({ sub: "s1", username: "u1", email: "e@x", isPlatformAdmin: true } as never)
    ).toMatchObject({ actor: "e@x", actorSub: "s1", email: "e@x", isPlatformAdmin: true });
    expect(actorFromIdentity({ sub: "s1", username: "u1", isPlatformAdmin: false } as never)).toMatchObject({
      actor: "u1",
      isPlatformAdmin: false,
    });
    expect(actorFromIdentity({ sub: "s1", username: "", isPlatformAdmin: false } as never).actor).toBe("s1");
  });

  it("systemActor 必须写用途(审计里要看出是哪条后台流程)", () => {
    expect(() => systemActor("")).toThrow(/必须写明用途/);
    expect(() => systemActor("x")).toThrow(/必须写明用途/);
    expect(systemActor("cred-supply")).toEqual({ actor: "system:cred-supply", isPlatformAdmin: true });
  });

  it("redactSql:抹掉单引号字面量与 password 后面的东西", () => {
    expect(redactSql("CREATE USER \"u\" PASSWORD 'abc123'")).not.toContain("abc123");
    expect(redactSql("password Kf9xyz")).not.toContain("Kf9xyz");
    expect(redactSql("no secrets here")).toBe("no secrets here");
  });

  it("AdminDdlDenied 带上是第几步拒的(排障最想知道的信息)", async () => {
    currentTarget = { ...HOME_TARGET, resources: {} };
    await executeAdminDdl(ADMIN, { operation: "create-shared-schema", targetId: "tgt_home" }).catch((e) => {
      expect(e).toBeInstanceOf(AdminDdlDenied);
      expect((e as InstanceType<typeof AdminDdlDenied>).step).toBe("7-credential");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP11b-shared-writer —— E-233(单测):窄权写者通道的执行器侧不变量(SPEC §3.9d)
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴🔴 E-233 台账成员资格守卫:id 在码表 / 模型表台账里查不到 ⇒ 第 2 步拒,零执行零审计", () => {
  it("码表类三个 operation:台账查不到 ⇒ 拒(不是判一个不存在的 kind 字段)", async () => {
    codeTables = {};
    for (const req of [
      { operation: "land-code-table", targetId: "tgt_home", codeTableId: "orders" },
      { operation: "grant-shared-writer", targetId: "tgt_home", codeTableId: "orders" },
      { operation: "drop-landed-table", targetId: "tgt_home", kind: "code-table", objectId: "orders" },
    ]) {
      const err = await executeAdminDdl(ADMIN, req).catch((e) => e);
      expect(err, `${req.operation} 没拒 ⇒ 业务表名冒充码表 id 就能进平台全局 schema`).toBeInstanceOf(AdminDdlDenied);
      expect((err as InstanceType<typeof AdminDdlDenied>).step).toBe("2-cross-verify");
    }
    expect(execCalls, "成员资格没过却执行了语句").toHaveLength(0);
    expect(audits, "成员资格没过就不该走到意图审计").toHaveLength(0);
  });

  it("模型表类两个 operation:台账查不到 ⇒ 拒;🔴 正控制:查得到 ⇒ 放行并真的发出语句", async () => {
    for (const req of [
      { operation: "land-model-table", targetId: "tgt_home", modelTableId: "01MT" },
      { operation: "drop-landed-table", targetId: "tgt_home", kind: "model-table", objectId: "01MT" },
    ]) {
      await expect(executeAdminDdl(ADMIN, req)).rejects.toThrow(/模型表台账里查不到/);
    }
    expect(execCalls).toHaveLength(0);
    modelTables = {
      "01MT": { modelTableId: "01MT", schema: "dw", physicalTable: "dim_user", columns: [{ name: "id", dataType: "BIGINT" }] },
    };
    await executeAdminDdl(ADMIN, { operation: "land-model-table", targetId: "tgt_home", modelTableId: "01MT" });
    expect(execCalls.length, "正控制:台账里有就必须能建(否则守卫是恒拒,等于功能缺失)").toBeGreaterThan(0);
  });

  it("🔴 门②:台账里的模型表落点是 proj_<…> ⇒ 拒(模板侧落点守卫),零执行", async () => {
    modelTables = {
      "01MT": { modelTableId: "01MT", schema: "proj_x", physicalTable: "t", columns: [{ name: "id", dataType: "BIGINT" }] },
    };
    await expect(
      executeAdminDdl(ADMIN, { operation: "land-model-table", targetId: "tgt_home", modelTableId: "01MT" })
    ).rejects.toThrow(/项目私有 schema/);
    expect(execCalls).toHaveLength(0);
  });

  it("land-model-table 不接受调用方传落点(schema / table / columns 一律当场拒)", async () => {
    modelTables = { "01MT": { modelTableId: "01MT", schema: "dw", physicalTable: "t", columns: [{ name: "id", dataType: "BIGINT" }] } };
    for (const f of ["schema", "table", "physicalTable", "columns"]) {
      await expect(
        executeAdminDdl(ADMIN, { operation: "land-model-table", targetId: "tgt_home", modelTableId: "01MT", [f]: "x" })
      ).rejects.toThrow(new RegExp(f));
    }
    expect(execCalls).toHaveLength(0);
  });
});

describe("🔴🔴 E-233 grant-shared-writer:逐表授权、零 schema 级写权", () => {
  it("产物逐字节 = USAGE ON SCHEMA + 这一张表的四个 DML 权(主体名 / 落点都来自 SSOT)", async () => {
    await executeAdminDdl(ADMIN, { operation: "grant-shared-writer", targetId: "tgt_home", codeTableId: "region_cn" });
    expect(execCalls.map((c) => c.sql)).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "shared_writer"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."dim_code_region_cn" TO "shared_writer"`,
    ]);
  });

  it("🔴 负向:任何建模类模板都不许出现 ON ALL TABLES / CREATE ON SCHEMA / GRANT ALL / 授给 shared_writer 的 CREATE", async () => {
    modelTables = {
      "01MT": { modelTableId: "01MT", schema: "dw", physicalTable: "dim_user", columns: [{ name: "id", dataType: "BIGINT" }] },
    };
    for (const req of [
      { operation: "land-code-table", targetId: "tgt_home", codeTableId: "region_cn" },
      { operation: "grant-shared-writer", targetId: "tgt_home", codeTableId: "region_cn" },
      { operation: "land-model-table", targetId: "tgt_home", modelTableId: "01MT" },
      { operation: "drop-landed-table", targetId: "tgt_home", kind: "code-table", objectId: "region_cn" },
    ]) {
      await executeAdminDdl(ADMIN, req);
    }
    const grants = execCalls.map((c) => c.sql).filter((x) => /^GRANT\b/i.test(x));
    expect(grants.length, "样本里没有 GRANT ⇒ 下面的负向断言是空断言").toBeGreaterThanOrEqual(4);
    for (const g of grants) {
      expect(g, "schema 级写权 ⇒ 它能写将来任何进这个 schema 的表").not.toMatch(/ON\s+ALL\s+TABLES/i);
      expect(g).not.toMatch(/\bCREATE\b/i);
      expect(g).not.toMatch(/GRANT\s+ALL\b/i);
    }
    // 模型表那张只给窄权写者 SELECT(观测用),没有任何写权
    const mt = grants.filter((g) => g.includes(`"dw"."dim_user"`));
    expect(mt).toEqual([`GRANT SELECT ON "dw"."dim_user" TO "shared_writer"`]);
  });

  it("drop-landed-table 只删台账给的那张表(IF EXISTS,落点同一个 SSOT)", async () => {
    await executeAdminDdl(ADMIN, { operation: "drop-landed-table", targetId: "tgt_home", kind: "code-table", objectId: "region_cn" });
    expect(execCalls.map((c) => c.sql)).toEqual([`DROP TABLE IF EXISTS "public"."dim_code_region_cn"`]);
  });

  it("非平台管理员 ⇒ 建模类 operation 一律拒", async () => {
    await expect(
      executeAdminDdl(DEV, { operation: "grant-shared-writer", targetId: "tgt_home", codeTableId: "region_cn" })
    ).rejects.toThrow(/平台管理员/);
    expect(execCalls).toHaveLength(0);
  });
});

describe("🔴🔴 E-233 provisionSharedWriter:口令不出函数、返回值没有 ARN、只建用户不授权", () => {
  const USW2_TARGET = {
    targetId: "tgt_usw2_a",
    region: "us-west-2",
    credentialIsolationState: "provisioning",
    provisioningDeadlineAt: "2099-01-01T00:00:00Z",
    credentialEpoch: 0,
    resources: { redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:redshift!usw2-admin-x" },
  };

  it("secret 建在该 target 所在 region、名字来自 SSOT;口令进了 secret,但审计 / 返回值里一个字都没有", async () => {
    currentTarget = { ...USW2_TARGET };
    const r = await provisionSharedWriter(ADMIN, { targetId: "tgt_usw2_a" });
    expect(secretWrites).toHaveLength(1);
    expect(secretWrites[0].region).toBe("us-west-2");
    expect(secretWrites[0].name).toBe("bgp/shared-writer/tgt-usw2-a");
    expect(secretWrites[0].value.username).toBe("shared_writer");
    const pw = String(secretWrites[0].value.password);
    expect(pw.length, "口令没生成").toBeGreaterThan(16);
    expect(JSON.stringify(audits), "口令进了审计 ⇒ 审计表变成口令库").not.toContain(pw);
    expect(JSON.stringify(r)).not.toContain(pw);
    expect(Object.keys(r).sort(), "返回值多出 secretArn ⇒ 一份会漂的副本(SPEC §3.9d.4)").toEqual(["auditId", "created", "secretName"]);
    expect(r.secretName).toBe("bgp/shared-writer/tgt-usw2-a");
    // 执行用的是该 target 的 admin 凭证;语句只有建用户这一条(不授任何权)
    expect(execCalls.map((c) => c.secretArn)).toEqual(["arn:aws:secretsmanager:us-west-2:1:secret:redshift!usw2-admin-x"]);
    expect(execCalls[0].sql).toMatch(/^CREATE USER "shared_writer" PASSWORD '/);
    expect(execCalls.some((c) => /^GRANT/i.test(c.sql)), "供给不许顺手授权(授权只走逐表模板)").toBe(false);
  });

  it("CREATE USER 撞已存在 ⇒ ALTER USER 轮换(幂等),口令仍不进审计", async () => {
    currentTarget = { ...USW2_TARGET };
    const tc = await import("@/lib/exec-env/target-clients");
    (tc.execOnTarget as unknown as { mockImplementationOnce: (f: unknown) => void }).mockImplementationOnce(async () => {
      throw new Error("user already exists");
    });
    await provisionSharedWriter(ADMIN, { targetId: "tgt_usw2_a" });
    expect(execCalls.map((c) => c.sql.split(" PASSWORD")[0])).toEqual([`ALTER USER "shared_writer"`]);
    const pw = String(secretWrites[0].value.password);
    expect(JSON.stringify(audits)).not.toContain(pw);
  });

  it("非管理员 / 审计失败 ⇒ 拒且不写 secret;执行报错 ⇒ 抛出的文本已脱敏", async () => {
    currentTarget = { ...USW2_TARGET };
    await expect(provisionSharedWriter(DEV, { targetId: "tgt_usw2_a" })).rejects.toThrow(/平台管理员/);
    auditThrowsOn = "provision-shared-writer.intent";
    await expect(provisionSharedWriter(ADMIN, { targetId: "tgt_usw2_a" })).rejects.toThrow(/fail-closed-on-audit/);
    expect(secretWrites).toHaveLength(0);
    auditThrowsOn = undefined;
    const tc = await import("@/lib/exec-env/target-clients");
    (tc.execOnTarget as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (a: { sql: string }) => {
      throw new Error(`syntax error near ${a.sql}`);
    });
    const err = await provisionSharedWriter(ADMIN, { targetId: "tgt_usw2_a" }).catch((e) => e);
    expect(String(err.message)).toMatch(/<redacted>/);
    expect(String(err.message)).not.toMatch(/PASSWORD '[^<]/);
  });
});

// @kf-batch 50-WP31-place-first-class(序 31 第二刀 ① = B-98)
// 🔴 本执行器是**第二条**数据面通道:建模落地 / 维表 DDL 的非主控区一跳走它而不走 resolveRedshiftBinding。
//   原来只做准入、不记落点决策 ⇒ observe 把该区的 redshift-data / secretsmanager 调用判成 cross-region(第三十九 / 四十轮
//   16 / 12 条全是它);enforce 一开会误拦。判据钉事实:决策在**准入之后、第一次数据面执行之前**进账本;被拒不记;请求外不抛。
describe("🔴 B-98 admin-DDL 执行器记落点决策(准入之后、执行之前;被拒不记)", () => {
  let store: object = {};
  const decided = () =>
    placeCtx.decisionsOfCurrentRequest().decisions.filter((d) => d.via === ADMIN_DDL_PLACE_VIA).map((d) => d.targetId);
  const USW2 = {
    ...HOME_TARGET,
    targetId: "tgt_usw2_a",
    region: "us-west-2",
    resources: { redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:a" },
  };
  beforeEach(() => {
    store = {};
    placeCtx.__setRequestStoreProvider(() => store);
  });
  afterEach(() => placeCtx.__setRequestStoreProvider(null));

  it("executeAdminDdl 非主控区 ⇒ 决策袋含该 target(via admin-ddl-executor),且在第一次数据面执行**之前**就已记下", async () => {
    currentTarget = { ...USW2 };
    let decidedAtFirstExec: Array<string | null> | undefined;
    const tc = await import("@/lib/exec-env/target-clients");
    (tc.execOnTarget as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (a: Parameters<typeof execOnTargetDefault>[0]) => {
        decidedAtFirstExec ??= decided();
        return execOnTargetDefault(a);
      }
    );
    await executeAdminDdl(ADMIN, { operation: "grant", targetId: "tgt_usw2_a", projectId: PROJ_A });
    expect(decided()).toEqual(["tgt_usw2_a"]);
    expect(decidedAtFirstExec, "第一次数据面执行时决策还没记 ⇒ 观测器对那次调用归不了因").toEqual(["tgt_usw2_a"]);
    expect(ADMIN_DDL_PLACE_VIA).toBe("admin-ddl-executor");
  });

  it("provisionProjectLogin / provisionSharedWriter 同样记(供给层走它们;各自请求各记一笔)", async () => {
    currentTarget = { ...USW2 };
    await provisionProjectLogin(ADMIN, { targetId: "tgt_usw2_a", projectId: PROJ_A });
    expect(decided()).toEqual(["tgt_usw2_a"]);
    store = {}; // 新请求
    await provisionSharedWriter(ADMIN, { targetId: "tgt_usw2_a" });
    expect(decided()).toEqual(["tgt_usw2_a"]);
  });

  it("🔴 准入之前被拒(项目不存在 / target 不可用)⇒ 一笔都不记:被拒的请求不许被归到某个区", async () => {
    projects = new Set([PROJ_B]);
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_usw2_a", projectId: PROJ_A })
    ).rejects.toThrow(/项目台账里不存在/);
    expect(decided()).toEqual([]);
    projects = new Set([PROJ_A, PROJ_B]);
    currentTarget = null;
    await expect(
      executeAdminDdl(ADMIN, { operation: "create-role", targetId: "tgt_usw2_a", projectId: PROJ_A })
    ).rejects.toThrow(/不可用/);
    expect(decided()).toEqual([]);
  });

  it("请求外(没有请求存储:泵 / 脚本上下文)不抛、不记", async () => {
    placeCtx.__setRequestStoreProvider(() => undefined);
    currentTarget = { ...USW2 };
    await expect(executeAdminDdl(ADMIN, { operation: "grant", targetId: "tgt_usw2_a", projectId: PROJ_A })).resolves.toBeTruthy();
    expect(placeCtx.decisionsOfCurrentRequest().decisions).toEqual([]);
  });
});
