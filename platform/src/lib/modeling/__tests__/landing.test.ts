// @kf-batch 50-P50.3-modeling
// 建模逐 target 落地的门禁 —— 🔴 **全部可执行**(真调 `landToTargets`,打桩只到 AWS SDK 边界)。
//
// 合同点名的那句话是本组测试的主线:`landedByTarget` 是「**观测态**,非"我以为推了啥",防看板假绿」。
// 三个承重不变量都属于"不报错、只是判错了"这一类,所以只能靠可执行断言:
//   ① **先观测再动手**:该 target 已有结构不同的同名表 ⇒ 判 `drift` 且**一条语句都不执行**
//      (DDL 是 `CREATE TABLE IF NOT EXISTS`,硬跑下去只会在灌数那步报一个离根因很远的列名错);
//   ② **drift / residency-blocked 绝不判绿**(INTERACTION §4ter);
//   ③ 落地后**再观测一次**才写状态 —— 不再观测就等于"我以为推上去了"。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  /** 每个 region 上"库里现有的列签名";null/缺失 = 表不存在 */
  existing: {} as Record<string, string | null>,
  /** 执行过的语句(按 region) */
  executed: [] as Array<{ region: string; sql: string }>,
  /** 执行后库里变成什么(模拟建表生效) */
  afterExec: {} as Record<string, string>,
  bindings: {} as Record<string, any>,
  /** 这些 target 上 `resolveRedshiftBinding` 直接抛(用来验"一个区抛错不影响其它区") */
  throwFor: [] as string[],
  crossJurisdiction: [] as string[],
  // @kf-batch 50-WP11b-shared-writer —— 非 home 通道的观察点
  /** 已存在的 secret:名 → ARN */
  secrets: {} as Record<string, string>,
  /** admin 执行器收到的结构化请求(按序) */
  admin: [] as Array<Record<string, unknown>>,
  /** 供给窄权写者的次数(按 target) */
  provisioned: [] as string[],
  /** 观测语句用的 SecretArn(按序) */
  observedWith: [] as string[],
  /** 窄权写者直调 execOnTarget 执行的语句 */
  writerExec: [] as Array<{ region: string; sql: string; secretArn: string }>,
  /** 下一次 execOnTarget 抛这个错(只抛一次) */
  writerThrowOnce: null as string | null,
  /** 全局事件序(验「供给 → 结构 → 观测 → 灌数」的顺序) */
  order: [] as string[],
  bindOpts: [] as unknown[],
}));

vi.mock("@aws-sdk/client-redshift-data", () => {
  class ExecuteStatementCommand {
    constructor(public input: any) {}
  }
  class DescribeStatementCommand {
    constructor(public input: any) {}
  }
  class GetStatementResultCommand {
    constructor(public input: any) {}
  }
  return { ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand };
});

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn((region: string) => {
    let lastSql = "";
    return {
      async send(cmd: any) {
        const name = cmd.constructor.name;
        if (name.startsWith("ExecuteStatement")) {
          lastSql = String(cmd.input.Sql);
          if (/^SELECT column_name/.test(lastSql)) {
            h.observedWith.push(String(cmd.input.SecretArn ?? ""));
            h.order.push("observe");
          }
          if (!/^SELECT column_name/.test(lastSql)) h.executed.push({ region, sql: lastSql });
          return { Id: `stmt-${region}-${h.executed.length}` };
        }
        if (name.startsWith("DescribeStatement")) {
          return { Status: "FINISHED", HasResultSet: /^SELECT column_name/.test(lastSql) };
        }
        // GetStatementResult:把"库里现有列签名"拆回 information_schema 形状
        const sig = h.existing[region];
        if (!sig) return { Records: [] };
        const rows = sig.split(",").map((p) => {
          const [n, ty] = p.split(":");
          const m = ty.match(/^([a-z]+)\((\d+)(?:,(\d+))?\)$/);
          const base = m ? m[1] : ty;
          const std = base === "varchar" ? "character varying" : base === "double" ? "double precision" : base;
          return [{ stringValue: n }, { stringValue: std }, m && base !== "decimal" ? { longValue: Number(m[2]) } : { isNull: true },
                  m && base === "decimal" ? { longValue: Number(m[2]) } : { isNull: true },
                  m && base === "decimal" && m[3] ? { longValue: Number(m[3]) } : { isNull: true }];
        });
        return { Records: rows };
      },
    };
  }),
  // @kf-batch 50-WP11b-shared-writer —— 非 home 通道用到的三个出口(真外部:Secrets Manager / Data API)
  resolveTargetWarehouse: (t: { targetId: string }) => ({ targetId: t.targetId, region: t.targetId, workgroup: "wg-" + t.targetId, database: "dev" }),
  describeSecretArnByName: vi.fn(async (_region: string, name: string) => h.secrets[name]),
  execOnTarget: vi.fn(async (a: { warehouse: { region: string }; sql: string; secretArn: string }) => {
    if (h.writerThrowOnce) {
      const m = h.writerThrowOnce;
      h.writerThrowOnce = null;
      throw new Error(m);
    }
    h.writerExec.push({ region: a.warehouse.region, sql: a.sql, secretArn: a.secretArn });
    h.order.push("writer-dml");
    return { affected: 1, statementId: "w" };
  }),
}));

vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (tid: string) => ({ targetId: tid, region: tid, components: ["core", "redshift"] })),
  getTargetRaw: vi.fn(async (tid: string) => ({ targetId: tid })),
}));

// admin 执行器:这里只看「落地路径发了哪些结构化请求、按什么顺序」。
// 🔴 执行器 ↔ 模板 ↔ 落地的**真接缝**由同目录装配层 `shared-writer-assembly.test.ts` 不 mock 地跑。
vi.mock("@/lib/exec-env/admin-ddl-executor", () => ({
  executeAdminDdl: vi.fn(async (_actor: unknown, req: Record<string, unknown>) => {
    h.admin.push(req);
    h.order.push(`admin:${req.operation}`);
    return { affected: 0, auditId: "a" };
  }),
  provisionSharedWriter: vi.fn(async (_actor: unknown, a: { targetId: string }) => {
    h.provisioned.push(a.targetId);
    h.order.push("provision");
    h.secrets[`bgp/shared-writer/${a.targetId.replace(/_/g, "-")}`] = `arn:aws:secretsmanager:${a.targetId}:1:secret:bgp/shared-writer/${a.targetId}-W${h.provisioned.length}`;
    return { secretName: `bgp/shared-writer/${a.targetId.replace(/_/g, "-")}`, created: true, auditId: "p" };
  }),
}));

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      if (h.throwFor.includes(tid)) throw new Error(`解析绑定炸了: ${tid}`);
      return h.bindings[tid] ?? { targetId: tid, region: tid, workgroup: "wg", database: "dev", secretArn: "arn:x", degradedToLegacyAdmin: true, home: tid === "tgt_home", jurisdiction: "home" };
    }),
    assertBindableTarget: vi.fn(async (tid: string, _c: string, opts: unknown) => {
      h.bindOpts.push(opts);
      if (h.crossJurisdiction.includes(tid)) {
        throw new (real.TargetBindingRejected as any)("invalid-target", `执行目标 ${tid} 属跨法域(jurisdiction=eu)⇒ 本期不接受绑定`);
      }
      return tid;
    }),
  };
});

import {
  landToTargets as landToTargetsRaw,
  landedStateOf,
  landedNeedsAttention,
  normalizeTypeName,
  columnSignature,
  diffSignatures,
  CODE_TABLE_COLUMNS,
  LANDED_ATTENTION,
  LANDING_PLACE_VIA,
  unlandFromTarget as unlandFromTargetRaw,
  estimateRows as estimateRowsRaw,
  type LandedState,
} from "@/lib/modeling/landing";
// 模块 55 / 序 50:landing 的 Redshift Data 轮询经 awaitTerminal(无长操作 / 后台等待者上下文即抛 —— 路由侧由 submitLongOp 提供);
//   判据直接调库函数,所以在 op 帧里调(与真路由同一条路;「无上下文即抛」本身由 lib/long-ops/__tests__/context-await.test 钉)。
import { runInLongOp } from "@/lib/long-ops/context";
const inOp = <T,>(fn: () => Promise<T>): Promise<T> => runInLongOp({ taskId: "test", opKind: "modeling-land" }, fn);
const landToTargets: typeof landToTargetsRaw = (...a) => inOp(() => landToTargetsRaw(...a));
const unlandFromTarget: typeof unlandFromTargetRaw = (...a) => inOp(() => unlandFromTargetRaw(...a));
const estimateRows: typeof estimateRowsRaw = (...a) => inOp(() => estimateRowsRaw(...a));
// @kf-batch 50-WP31-place-first-class(序 31 第二刀 ③)—— 落点决策账本(真模块;请求存储由测试注入,与执行器判据同一写法)
const placeCtx = await import("@/lib/place/context");

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const CREATE = 'CREATE TABLE IF NOT EXISTS public.dim_code_x ("value" VARCHAR(64) NOT NULL, "label" VARCHAR(256), "seq" INTEGER)';
const ACTOR = { actor: "alice@x.com", isPlatformAdmin: true };
const args = (over: Record<string, unknown> = {}) => ({
  targets: [HOME],
  kind: "code-table" as const,
  objectId: "ct1",
  actor: ACTOR,
  schema: "public",
  table: "dim_code_x",
  expectedColumns: CODE_TABLE_COLUMNS,
  statements: [CREATE, "DELETE FROM public.dim_code_x"],
  writeStatements: ["DELETE FROM public.dim_code_x", "INSERT INTO public.dim_code_x VALUES (1)"],
  defHash: "abc123",
  ...over,
});

beforeEach(() => {
  h.existing = {};
  h.executed.length = 0;
  h.afterExec = {};
  h.bindings = {};
  h.crossJurisdiction = [];
  h.throwFor = [];
  h.secrets = {};
  h.admin = [];
  h.provisioned = [];
  h.observedWith = [];
  h.writerExec = [];
  h.writerThrowOnce = null;
  h.order = [];
  h.bindOpts = [];
});

describe("🔴 列类型规范化:同一个规范化器吃两种来源(否则每次观测都误报 drift)", () => {
  it("information_schema 的 SQL 标准名与我们 DDL 的写法必须归一到同一串", () => {
    expect(normalizeTypeName("character varying", 64)).toBe("varchar(64)");
    expect(normalizeTypeName("VARCHAR(64)")).toBe("varchar(64)");
    // 🔴 下面三条才真正**需要内联括号解析**:上面两条不走那个分支也能碰巧对
    //    (变异 M105 把 inline 解析拆掉后门禁仍全绿 —— 弱用例的典型)。
    expect(normalizeTypeName("NUMERIC(18,2)"), "带括号的别名没映射 ⇒ numeric(18,2) 与 decimal(18,2) 判不一致").toBe("decimal(18,2)");
    expect(normalizeTypeName("CHARACTER VARYING(64)")).toBe("varchar(64)");
    expect(normalizeTypeName("VARCHAR (64)"), "括号前的空格没去掉 ⇒ 每次观测都误报 drift").toBe("varchar(64)");
    expect(normalizeTypeName("integer")).toBe("integer");
    expect(normalizeTypeName("int4")).toBe("integer");
    expect(normalizeTypeName("numeric", null, 18, 2)).toBe("decimal(18,2)");
    expect(normalizeTypeName("DECIMAL(18,2)")).toBe("decimal(18,2)");
    expect(normalizeTypeName("timestamp without time zone")).toBe("timestamp");
  });

  it("列名大小写/空格不算差异(否则每次观测都误报)", () => {
    expect(columnSignature([{ name: " Value ", type: "varchar(64)" }])).toBe("value:varchar(64)");
  });
});

describe("🔴🔴 先观测再动手:已有结构不同的同名表 ⇒ drift 且**一条语句都不执行**", () => {
  it("drift 时不执行任何落地语句(硬跑下去只会在灌数那步报一个离根因很远的列名错)", async () => {
    h.existing[HOME] = "value:varchar(64),label:varchar(256)"; // 少一列 seq
    const recs = await landToTargets(args());
    expect(recs[HOME].status).toBe("drift");
    expect(h.executed, "判了 drift 却还是把 DDL 跑了 ⇒ 会在灌数那步报列名错,离根因极远").toEqual([]);
    expect(recs[HOME].observedColumns).toBe("value:varchar(64),label:varchar(256)");
    expect(recs[HOME].expectedColumns).toBe(CODE_TABLE_COLUMNS);
  });

  it("🔴 语句都成功了、但**落地后观测不到那张表** ⇒ 判 failed(不许因为「语句没报错」就写 ok)", async () => {
    // 打桩让两次观测都返回"不存在":语句执行成功、表却没出现。
    // 这正是"我以为推上去了"的形态 —— 合同点名要防的那一个。
    h.existing[HOME] = null;
    const recs = await landToTargets(args());
    expect(h.executed.map((x) => x.sql), "该执行的语句没执行").toEqual(args().statements);
    expect(recs[HOME].status, "语句成功就写 ok ⇒ 等于「我以为推上去了」(合同点名要防的)").toBe("failed");
    expect(recs[HOME].error).toContain("观测不到");
  });

  it("落地后观测到期望结构 ⇒ ok,且带 observedAt(界面要显示「观测于」)", async () => {
    // 让观测在"执行之后"返回期望结构:第一次 null、之后有值
    let calls = 0;
    Object.defineProperty(h.existing, HOME, {
      configurable: true,
      get() {
        calls++;
        return calls === 1 ? null : CODE_TABLE_COLUMNS;
      },
    });
    const recs = await landToTargets(args());
    expect(recs[HOME].status).toBe("ok");
    expect(recs[HOME].observedAt, "没有观测时间 ⇒ 界面只能把陈旧观测画成实时绿灯").toBeTruthy();
    expect(recs[HOME].observedColumns).toBe(CODE_TABLE_COLUMNS);
  });
});

describe("🔴 强制重建:只有 force 才 DROP,而且 DROP 必须在建表之前", () => {
  it("force=false 时绝不出现 DROP", async () => {
    h.existing[HOME] = "value:varchar(64)";
    await landToTargets(args());
    expect(h.executed.some((x) => /DROP TABLE/i.test(x.sql))).toBe(false);
  });

  it("force=true 且确实 drift ⇒ 先 DROP 再建", async () => {
    let calls = 0;
    Object.defineProperty(h.existing, HOME, {
      configurable: true,
      get() {
        calls++;
        return calls === 1 ? "value:varchar(64)" : CODE_TABLE_COLUMNS;
      },
    });
    const recs = await landToTargets(args({ force: true }));
    expect(h.executed[0].sql, "DROP 不在最前 ⇒ CREATE IF NOT EXISTS 会先静默无效,再 DROP 掉刚建的").toMatch(/^DROP TABLE/);
    expect(recs[HOME].status).toBe("ok");
  });

  it("🔴 force=true 但结构本来就一致 ⇒ **不 DROP**(不许无谓地删一张好表)", async () => {
    h.existing[HOME] = CODE_TABLE_COLUMNS;
    await landToTargets(args({ force: true }));
    expect(h.executed.some((x) => /DROP TABLE/i.test(x.sql))).toBe(false);
  });
});

// @kf-batch 50-WP11b-shared-writer —— 原两组「非 home ⇒ credential-gap、一条语句都不执行」**反向改判**:
//   窄权写者通道已交付(SPEC §3.9d),非 home 走与 home **同样的四态**,没有第五态。
//   跨法域与同法域同一条路(DESIGN §18 决策 6quinquies,不设法务门)。
const SW = (tid: string) => `bgp/shared-writer/${tid.replace(/_/g, "-")}`;

describe("🔴🔴 非 home 建模落地:窄权写者通道(E-229 / E-233 单测侧)", () => {
  it("码表:缺 secret ⇒ 先供给 → admin 建表 → 逐表授权 → 观测 → 窄权写者灌数 → 再观测 ⇒ ok", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS; // admin 建表之后,窄权写者能观测到期望结构
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("ok");
    expect(h.provisioned, "没有 secret 却没先供给 ⇒ GRANT 的对象不存在").toEqual([USW2]);
    expect(h.admin.map((r) => r.operation)).toEqual(["land-code-table", "grant-shared-writer"]);
    expect(h.admin.every((r) => r.objectId === undefined && r.codeTableId === "ct1"), "admin 请求只带台账 id").toBe(true);
    // 顺序:供给 → 结构 → 授权 → 观测 → 灌数 → 再观测
    expect(h.order).toEqual(["provision", "admin:land-code-table", "admin:grant-shared-writer", "observe", "writer-dml", "writer-dml", "observe"]);
    // 🔴 只有数据层用窄权身份,而且用的是**窄权写者**的 ARN,不是 admin 的
    expect(h.writerExec.map((x) => x.sql)).toEqual(args().writeStatements);
    expect(h.writerExec.every((x) => x.secretArn.includes("bgp/shared-writer/"))).toBe(true);
    expect(h.observedWith.every((a) => a.includes("bgp/shared-writer/")), "观测用了别的身份").toBe(true);
    // home 那份完整语句(含建表)绝不在非 home 用 admin 绑定直接执行
    expect(h.executed, "非 home 绕过 admin 模板直接执行了语句").toEqual([]);
  });

  it("已有 secret ⇒ 不再供给(幂等:轮换不是每次都做)", async () => {
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OLD";
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("ok");
    expect(h.provisioned).toEqual([]);
    expect(h.writerExec.every((x) => x.secretArn.endsWith("-OLD"))).toBe(true);
  });

  it("🔴 门①:准入用 scope=platform-global(建模没有项目维,不受项目白名单约束;台账 B-17)", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    await landToTargets(args({ targets: [USW2] }));
    expect(h.bindOpts).toEqual([{ scope: "platform-global" }]);
  });

  it("🔴 门②:落点伪造成 proj_xxx ⇒ failed,**一条 admin 请求都没发**(白名单换成落点守卫,不是 fail-open)", async () => {
    const recs = await landToTargets(args({ targets: [USW2], schema: "proj_xxx" }));
    expect(recs[USW2].status).toBe("failed");
    expect(recs[USW2].error).toMatch(/项目私有 schema/);
    expect(h.admin).toEqual([]);
    expect(h.provisioned).toEqual([]);
    expect(h.writerExec).toEqual([]);
  });

  it("跨法域 target ⇒ 与 usw2 同一条路、同一结果(没有第五态,拒因零法域词)", async () => {
    const EU = "tgt_eusim_a";
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.existing[EU] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ targets: [USW2, EU] }));
    expect(recs[USW2].status).toBe("ok");
    expect(recs[EU].status).toBe("ok");
    const shape = (tid: string) => h.admin.filter((r) => r.targetId === tid).map((r) => r.operation);
    expect(shape(EU)).toEqual(shape(USW2));
    expect(String(recs[EU].status)).not.toBe("credential-gap");
  });

  it("🔴 落地后观测到结构不同(那个区早有一张别人建的同名表)⇒ drift 且**不灌数**", async () => {
    h.existing[USW2] = "value:varchar(64)";
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("drift");
    expect(h.writerExec, "drift 时还灌数 ⇒ 会报一个离根因很远的列名错").toEqual([]);
    expect(h.admin.some((r) => r.operation === "drop-landed-table"), "没 force 就 DROP 了别人的表").toBe(false);
  });

  it("force + drift ⇒ admin drop-landed-table → 重建 → 灌数(DROP 只有属主做得了)", async () => {
    let calls = 0;
    Object.defineProperty(h.existing, USW2, {
      configurable: true,
      get() {
        calls++;
        return calls === 1 ? "value:varchar(64)" : CODE_TABLE_COLUMNS;
      },
    });
    const recs = await landToTargets(args({ targets: [USW2], force: true }));
    expect(recs[USW2].status).toBe("ok");
    expect(h.admin.map((r) => r.operation)).toEqual([
      "land-code-table",
      "grant-shared-writer",
      "drop-landed-table",
      "land-code-table",
      "grant-shared-writer",
    ]);
    expect(h.admin[2]).toMatchObject({ kind: "code-table", objectId: "ct1", targetId: USW2 });
    expect(h.writerExec.length).toBe(2);
  });

  it("维度/事实表:只发 land-model-table、没有数据层;观测仍用窄权写者(它对这张表只有 SELECT)", async () => {
    h.existing[USW2] = "id:bigint";
    const recs = await landToTargets(
      args({ targets: [USW2], kind: "model-table", objectId: "mt1", schema: "dw", table: "dim_user", expectedColumns: "id:bigint", writeStatements: [] })
    );
    expect(recs[USW2].status).toBe("ok");
    expect(h.admin).toEqual([{ operation: "land-model-table", targetId: USW2, modelTableId: "mt1" }]);
    expect(h.writerExec).toEqual([]);
  });

  it("只观测:不供给、不发 admin、不灌数;没有 secret ⇒ failed 并说清「尚未供给」", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    const r1 = (await landToTargets(args({ targets: [USW2], probeOnly: true })))[USW2];
    expect(r1.status).toBe("failed");
    expect(r1.error).toContain("尚未供给 shared-writer 身份");
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    const r2 = (await landToTargets(args({ targets: [USW2], probeOnly: true })))[USW2];
    expect(r2.status).toBe("ok");
    expect(h.admin).toEqual([]);
    expect(h.provisioned).toEqual([]);
    expect(h.writerExec).toEqual([]);
  });

  it("actor 为 null(调用方显式声明没有)⇒ failed,一条 admin 请求都不发", async () => {
    const r = (await landToTargets(args({ targets: [USW2], actor: null })))[USW2];
    expect(r.status).toBe("failed");
    expect(r.error).toContain("具名操作者");
    expect(h.admin).toEqual([]);
  });

  it("窄权写者凭证被并发轮换覆盖(库里拒的是它的口令)⇒ 重新供给一次再试,一次成功", async () => {
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-STALE";
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.writerThrowOnce = 'FATAL: password authentication failed for user "shared_writer"';
    const r = (await landToTargets(args({ targets: [USW2] })))[USW2];
    expect(r.status).toBe("ok");
    expect(h.provisioned).toEqual([USW2]);
    expect(h.writerExec.length).toBe(2);
  });

  it("🔴 别的错误不重试(权限不足就是权限不足)⇒ failed 带原文", async () => {
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.writerThrowOnce = "permission denied for relation dim_code_x";
    const r = (await landToTargets(args({ targets: [USW2] })))[USW2];
    expect(r.status).toBe("failed");
    expect(r.error).toContain("permission denied");
    expect(h.provisioned).toEqual([]);
  });

  it("🔴 落地路径不再产出 credential-gap;旧记录仍判 credential-gap(只读兼容)且不算「需要处理」", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).not.toBe("credential-gap");
    expect(landedNeedsAttention("credential-gap")).toBe(false);
    expect(landedStateOf({ status: "credential-gap", defHash: "h1", table: "t", at: "x" } as any, "h1")).toBe("credential-gap");
  });
});

describe("🔴 只观测(probeOnly):不动库", () => {
  it("probeOnly 时一条语句都不执行,只把「现在」的事实记下来", async () => {
    h.existing[HOME] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ probeOnly: true }));
    expect(h.executed).toEqual([]);
    expect(recs[HOME].status).toBe("ok");
  });

  it("🔴🔴 观测**绝不许盖上当前定义指纹** —— 否则点一下〔重新检测〕就能把「值改了」的表判成已落", async () => {
    // 码表最常见的改法就是**加一个枚举值**:列结构一个字没变、表里少一行。
    // 观测只看得见 information_schema,看不见数据 ⇒ 它没有资格宣布「这份定义已经落了」。
    // (W3-d2 写读侧时发现的真 bug:probe 之前那格是 ⚠版本不齐,probe 之后变 ✓已落。)
    h.existing[HOME] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(
      args({ probeOnly: true, defHash: "hash-new", previous: { [HOME]: { status: "ok", defHash: "hash-old", table: "public.dim_code_x", at: "x" } } })
    );
    expect(recs[HOME].status, "结构确实还对,状态是 ok").toBe("ok");
    expect(recs[HOME].defHash, "把新指纹盖进去 ⇒ 读侧判「已落最新版」= 假绿(那个区少一行)").toBe("hash-old");
    expect(landedStateOf(recs[HOME], "hash-new"), "读侧必须仍然判「版本不齐」").toBe("stale");
  });

  it("🔴 没有历史记录时观测出正确结构 ⇒ 指纹为空 ⇒ 读侧判「版本不齐」(诚实:平台没落过这份定义)", async () => {
    h.existing[HOME] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ probeOnly: true, defHash: "hash-new" }));
    expect(recs[HOME].defHash).toBe("");
    expect(landedStateOf(recs[HOME], "hash-new")).toBe("stale");
  });

  it("🔴 **真落地**(非 probe)才有资格写当前指纹(它确实把数据灌进去了)", async () => {
    let calls = 0;
    Object.defineProperty(h.existing, HOME, {
      configurable: true,
      get() {
        calls++;
        return calls === 1 ? null : CODE_TABLE_COLUMNS;
      },
    });
    const recs = await landToTargets(
      args({ defHash: "hash-new", previous: { [HOME]: { status: "ok", defHash: "hash-old", table: "t", at: "x" } } })
    );
    expect(recs[HOME].status).toBe("ok");
    expect(recs[HOME].defHash, "真落地却沿用旧指纹 ⇒ 永远显示「版本不齐」,用户怎么点都不绿").toBe("hash-new");
  });

  it("probeOnly 且结构不同 ⇒ drift;表不存在 ⇒ failed(说清「不存在」而不是含糊)", async () => {
    h.existing[HOME] = "value:varchar(64)";
    expect((await landToTargets(args({ probeOnly: true })))[HOME].status).toBe("drift");
    h.existing[HOME] = null;
    const r = (await landToTargets(args({ probeOnly: true })))[HOME];
    expect(r.status).toBe("failed");
    expect(r.error).toContain("不存在");
  });
});

describe("🔴🔴 判态纯函数:drift / 门控**绝不**因为定义没变而变成 ok", () => {
  const rec = (over: Record<string, unknown> = {}) => ({ status: "ok", defHash: "h1", table: "public.t", at: "x", ...over }) as any;

  it("没有记录 ⇒ never-landed(绑了却没落 = 那个区现在没这张表)", () => {
    expect(landedStateOf(undefined, "h1")).toBe("never-landed");
  });

  it("定义变了 ⇒ stale;没变 ⇒ ok", () => {
    expect(landedStateOf(rec(), "h1")).toBe("ok");
    expect(landedStateOf(rec(), "h2")).toBe("stale");
  });

  it("🔴 drift / credential-gap / failed 优先于「定义有没有变」—— 它们是**观测到的事实**", () => {
    expect(landedStateOf(rec({ status: "drift" }), "h1"), "drift 因为定义没变就判绿 = 假绿").toBe("drift");
    expect(landedStateOf(rec({ status: "credential-gap" }), "h1")).toBe("credential-gap");
    expect(landedStateOf(rec({ status: "failed" }), "h1")).toBe("failed");
  });

  it("需要处理的恰好是那四个(多一个 = 误报,少一个 = 漏报);观测态共 6 个(@kf-batch 50-W5-seg1-WP10a:residency-blocked 已删)", () => {
    expect([...LANDED_ATTENTION].sort()).toEqual(["drift", "failed", "never-landed", "stale"]);
    for (const s of ["ok", "credential-gap"] as LandedState[]) expect(landedNeedsAttention(s)).toBe(false);
  });
});

describe("字段级 diff(§4ter 的〔查看差异〕)", () => {
  it("三类差异各自分开列出(只说「不一致」等于没说)", () => {
    const d = diffSignatures("a:integer,b:varchar(64),c:date", "a:bigint,b:varchar(64),z:date");
    expect(d.typeMismatch).toEqual([{ column: "a", expected: "integer", observed: "bigint" }]);
    expect(d.onlyInDefinition).toEqual(["c"]);
    expect(d.onlyInTarget).toEqual(["z"]);
  });
});

describe("🔴 逐 target 各自 try:一个区失败不影响其它区", () => {
  it("一个区**真抛异常** ⇒ 它记 failed(带原始错误文本),另一个区照常 ok", async () => {
    // 🔴 必须让它**真抛**:原用例把 bindings[USW2] 设成 null,而 `?? 默认值` 把 null 当缺失
    //    ⇒ 根本没抛,那条 failed 是"观测不到表"造成的 ⇒ 钉不住"逐 target 各自 try"这条不变量。
    // 用 **home** 作抛错的那个区(home 走 resolveRedshiftBinding;非 home 走窄权通道,各自 try)。
    h.throwFor = [HOME];
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    let calls = 0;
    Object.defineProperty(h.existing, HOME, {
      configurable: true,
      get() {
        calls++;
        return calls === 1 ? null : CODE_TABLE_COLUMNS;
      },
    });
    const recs = await landToTargets(args({ targets: [HOME, USW2] }));
    expect(recs[HOME].status).toBe("failed");
    expect(recs[HOME].error, "异常没被逐 target 接住 ⇒ 整体抛,别的区的结果全丢").toContain("解析绑定炸了");
    expect(recs[USW2].status, "另一个区照样得到自己的判定(没被前一个区的异常带走)").toBe("ok");
  });
});

// @kf-batch 50-WP31-place-first-class(序 31 第二刀 ③)
// 🔴 非 home 落地 / 清理在进 admin 执行器(它自己记 B-98 那笔)**之前**就先打 Secrets Manager(窄权写者 secret 按名现查)、
//   再用窄权身份打 Redshift Data(观测)—— 这些调用在账本上没有任何决策 ⇒ observe 判 unattributed
//   (…7237 第四十三轮窗口 `unattributedTop` 仅剩的 1 类 = `secretsmanager.DescribeSecret /api/modeling/codetables/<id>/land`)。
//   判据钉事实:拿到该区仓位(requireReadyTarget 之后)即记决策,且在**第一笔** describeSecretArnByName 之前;
//   准入 / 落点被拒不记;home 不经本 via(它走 resolveRedshiftBinding 自己记);请求外不抛。
describe("🔴 序 31 二刀 ③ 非 home 建模落地 / 清理记落点决策(拿到仓位之后、第一笔 Secrets Manager 调用之前)", () => {
  let store: object = {};
  const decided = () =>
    placeCtx.decisionsOfCurrentRequest().decisions.filter((d) => d.via === LANDING_PLACE_VIA).map((d) => d.targetId);
  const describeDefault = async (_region: string, name: string) => h.secrets[name];
  let decidedAtFirstDescribe: Array<string | null> | undefined;
  type Mockable = { mockImplementation: (f: unknown) => void };
  beforeEach(async () => {
    store = {};
    decidedAtFirstDescribe = undefined;
    placeCtx.__setRequestStoreProvider(() => store);
    const tc = await import("@/lib/exec-env/target-clients");
    (tc.describeSecretArnByName as unknown as Mockable).mockImplementation(async (region: string, name: string) => {
      decidedAtFirstDescribe ??= decided();
      return describeDefault(region, name);
    });
  });
  afterEach(async () => {
    placeCtx.__setRequestStoreProvider(null);
    const tc = await import("@/lib/exec-env/target-clients");
    (tc.describeSecretArnByName as unknown as Mockable).mockImplementation(describeDefault);
  });

  it("真落地(码表,已有 secret)⇒ 决策袋含该 target(via modeling-landing),且第一笔 describeSecret 时就已记下", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("ok");
    expect(decided()).toEqual([USW2]);
    expect(decidedAtFirstDescribe, "第一笔 Secrets Manager 调用时决策还没记 ⇒ 观测器对它归不了因").toEqual([USW2]);
    expect(LANDING_PLACE_VIA).toBe("modeling-landing");
  });

  it("缺 secret ⇒ 先供给:供给之前那笔 describeSecret 也已有决策(不靠执行器补记;本 via 恰一笔)", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("ok");
    expect(h.provisioned).toEqual([USW2]);
    expect(decidedAtFirstDescribe).toEqual([USW2]);
    expect(decided()).toEqual([USW2]);
  });

  it("probeOnly(只观测)同样记 —— 观测也是在那个区发出的调用", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    const rec = (await landToTargets(args({ targets: [USW2], probeOnly: true })))[USW2];
    expect(rec.status).toBe("ok");
    expect(decided()).toEqual([USW2]);
    expect(decidedAtFirstDescribe).toEqual([USW2]);
  });

  it("🔴 门①被拒(跨法域)/ 门②被拒(proj_ 落点)⇒ 一笔都不记,且一次 Secrets Manager 调用都没发", async () => {
    h.crossJurisdiction = [USW2];
    const r1 = (await landToTargets(args({ targets: [USW2] })))[USW2];
    expect(r1.status).toBe("failed");
    expect(decided()).toEqual([]);
    expect(decidedAtFirstDescribe, "被拒后不该再碰 Secrets Manager").toBeUndefined();
    h.crossJurisdiction = [];
    store = {};
    const r2 = (await landToTargets(args({ targets: [USW2], schema: "proj_xxx" })))[USW2];
    expect(r2.status).toBe("failed");
    expect(decided()).toEqual([]);
    expect(decidedAtFirstDescribe).toBeUndefined();
  });

  it("home 落地不经本 via(home 走 resolveRedshiftBinding 自己记,不许重复署名)", async () => {
    h.existing[HOME] = CODE_TABLE_COLUMNS;
    const recs = await landToTargets(args({ targets: [HOME] }));
    expect(recs[HOME].status).toBe("ok");
    expect(decided()).toEqual([]);
  });

  it("unlandFromTarget 非 home:同样先记决策再按名查 secret(表不存在 ⇒ 零语句,但决策已记)", async () => {
    h.existing[USW2] = null;
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    const res = await unlandFromTarget(USW2, { schema: "public", table: "dim_code_x", kind: "code-table", objectId: "ct1", actor: ACTOR });
    expect(res).toEqual({ dropped: false, observedBefore: null });
    expect(h.admin).toEqual([]);
    expect(decided()).toEqual([USW2]);
    expect(decidedAtFirstDescribe).toEqual([USW2]);
  });

  // 序 31 二刀 ④(2026-10-21):解绑预览的行数估算 estimateRows 非 home 分支 —— …7237 升级后 observe 实测 unattributedTop 里
  //   `…/unbind-preview` 的 DescribeSecret / ExecuteStatement / DescribeStatement / GetStatementResult 一类 16 项,就是这条路没记决策。
  it("estimateRows 非 home:拿到仓位即记决策,第一笔 describeSecret 时已记(解绑预览路径归因)", async () => {
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    await estimateRows(USW2, { schema: "public", table: "dim_code_x" });
    expect(decided()).toEqual([USW2]);
    expect(decidedAtFirstDescribe, "解绑预览的第一笔 Secrets Manager 调用时决策还没记 ⇒ 观测器归不了因").toEqual([USW2]);
  });

  it("estimateRows home:不经本 via(home 走 homeBindingOrNull 自己的落点)", async () => {
    await estimateRows(HOME, { schema: "public", table: "dim_code_x" }).catch(() => null);
    expect(decided()).toEqual([]);
  });

  it("请求外(没有请求存储:脚本 / 泵上下文)不抛、不记", async () => {
    placeCtx.__setRequestStoreProvider(() => undefined);
    h.existing[USW2] = CODE_TABLE_COLUMNS;
    h.secrets[SW(USW2)] = "arn:aws:secretsmanager:x:1:secret:bgp/shared-writer/tgt-usw2-a-OK";
    const recs = await landToTargets(args({ targets: [USW2] }));
    expect(recs[USW2].status).toBe("ok");
    expect(placeCtx.decisionsOfCurrentRequest().decisions).toEqual([]);
  });
});
