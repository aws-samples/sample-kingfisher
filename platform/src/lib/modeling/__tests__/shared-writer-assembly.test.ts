// @kf-batch 50-WP11b-shared-writer
// 🔴🔴 **装配层**:建模落地 ↔ admin 执行器 ↔ 私有模板 ↔ 落点 SSOT ↔ 台账 —— 兄弟模块之间**一个都不 mock**
// (mock-hygiene-guard 的纪律;lib/modeling 原在欠账名单里,本文件补上后从名单删除)。
//
// 只 mock **真外部**:DynamoDB(台账)/ 执行环境注册表 / Redshift Data API + Secrets Manager(target-clients 的
// AWS 出口)/ 中央审计 / 区域审计 / 主控区 admin secret / OM 推送。数仓用一个**小型假 Redshift**代替:
// 它按「谁在执行(admin 还是 shared_writer)」判权限、按授权决定 information_schema 能不能看见那张表 ——
// 这两条正是本包的承重语义(E-230 / 观测必须在授权之后),mock 若不模拟它们,接缝就又被抹平了。
//
// 判据对应:E-229(该区真有那些行、写入者是窄权写者)· E-230(窄权写者只对授过的那张表有写权、无 DROP)·
// E-234(维度表 home 版与非 home 版列签名逐字节相同 = 建模 DDL 只有一个作者)· E-235(白名单最严态下建模照落、
// 同一状态下业务绑定照拒、落点伪造成 proj_ 照拒)· 成员资格(台账查不到即拒)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** DDB:`表名|id` → item */
  ddb: new Map<string, Record<string, unknown>>(),
  /** 假 Redshift:region → `schema.table` → 表 */
  wh: {} as Record<string, Record<string, { cols: string; rows: number; writer: Set<string> }>>,
  /** 每条真正执行过的语句(谁执行的) */
  log: [] as Array<{ region: string; sql: string; who: "admin" | "writer" }>,
  secrets: {} as Record<string, { arn: string; value: Record<string, unknown> }>,
  audits: [] as Array<{ action: string; detail: unknown }>,
  targets: {} as Record<string, Record<string, unknown>>,
}));

// ── 真外部 ① DynamoDB ──────────────────────────────────────────────────────────
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const keyOf = (o: Record<string, unknown>) => String(o.codeTableId ?? o.modelTableId ?? o.fqn ?? "");
  return {
    ...real,
    docClient: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
        const n = cmd.constructor.name;
        const t = cmd.input.TableName;
        if (n === "GetCommand") return { Item: h.ddb.get(`${t}|${keyOf(cmd.input.Key)}`) };
        if (n === "PutCommand") {
          h.ddb.set(`${t}|${keyOf(cmd.input.Item)}`, cmd.input.Item);
          return {};
        }
        if (n === "QueryCommand") return { Items: [...h.ddb.entries()].filter(([k]) => k.startsWith(`${t}|`)).map(([, v]) => v) };
        if (n === "DeleteCommand") {
          h.ddb.delete(`${t}|${keyOf(cmd.input.Key)}`);
          return {};
        }
        throw new Error(`假 DDB 未支持 ${n}`);
      }),
    },
  };
});

// ── 真外部 ② 执行环境注册表 ─────────────────────────────────────────────────────
vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (tid: string) => {
    const t = h.targets[tid];
    if (!t) throw new Error(`target ${tid} 不可用`);
    return t;
  }),
  getTargetRaw: vi.fn(async (tid: string) => h.targets[tid] ?? null),
}));

// ── 真外部 ③ 审计(中央 / 区域)与主控区 admin secret、OM 推送 ─────────────────────
vi.mock("@/lib/audit", () => ({
  writeAuditRecord: vi.fn(async (_a: unknown, action: string, opts: { detail?: unknown }) => {
    h.audits.push({ action, detail: opts?.detail });
    return `audit#${h.audits.length}`;
  }),
  recordAudit: vi.fn(async () => {}),
}));
vi.mock("@/lib/exec-env/residency-audit", () => ({
  residencyAudit: vi.fn(async () => null),
  auditActorOrService: (a: unknown) => ({ actor: a ?? { actor: "svc" }, skipAck: true }),
}));
vi.mock("@/lib/redshift/admin-secret", () => ({ getRedshiftSecretArn: vi.fn(async () => "arn:aws:secretsmanager:us-east-1:1:secret:redshift!home-admin") }));
vi.mock("@/lib/projects/project-service", () => ({ getProject: vi.fn(async () => null), getApproval: vi.fn(async () => null) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushRedshiftSchemaToOpenMetadata: vi.fn(async () => {}) }));
vi.mock("@/lib/openmetadata/om-glossary", () => ({ pushStandardGlossary: vi.fn(async () => {}) }));

// ── 真外部 ④ Redshift Data API + Secrets Manager:一个按身份判权限的假数仓 ───────────────
function std(sig: string): Array<Array<{ stringValue: string }>> {
  return sig.split(/,(?![^()]*\))/).map((p) => { // 列之间的逗号(不切 decimal(18,2) 里的那个)
    const [n, ty] = p.split(":");
    const m = ty.match(/^([a-z ]+)\((\d+)(?:,(\d+))?\)$/);
    const b = m ? m[1] : ty;
    const s = b === "varchar" ? "character varying" : b;
    return [
      { stringValue: n },
      { stringValue: s },
      { stringValue: m && b !== "decimal" ? m[2] : "" },
      { stringValue: m && b === "decimal" ? m[2] : "" },
      { stringValue: m && b === "decimal" && m[3] ? m[3] : "" },
    ];
  });
}

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const shared = await import("@/lib/modeling/landing-shared");
  const run = (region: string, sql: string, secretArn: string): string[][] | Array<Array<{ stringValue: string }>> => {
    const who: "admin" | "writer" = secretArn.includes(":secret:bgp/shared-writer/") ? "writer" : "admin";
    const db = (h.wh[region] ??= {});
    const deny = (why: string) => {
      throw new Error(`ERROR: permission denied ${why}`);
    };
    h.log.push({ region, sql, who });
    let m: RegExpMatchArray | null;
    if (/^CREATE SCHEMA IF NOT EXISTS/.test(sql)) return who === "admin" ? [] : deny("for database (CREATE SCHEMA)");
    if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS "(\w+)"\."(\w+)" \(([\s\S]*)\)$/))) {
      if (who !== "admin") deny(`for schema ${m[1]}`);
      const key = `${m[1]}.${m[2]}`;
      if (!db[key]) {
        const cols = [...m[3].matchAll(/"(\w+)"\s+((?:DOUBLE PRECISION|[A-Z]+)(?:\(\d+(?:,\d+)?\))?)/g)].map((x) => ({
          name: x[1],
          type: shared.normalizeTypeName(x[2]),
        }));
        db[key] = { cols: shared.columnSignature(cols), rows: 0, writer: new Set() };
      }
      return [];
    }
    if (/^COMMENT ON /.test(sql) || /^GRANT USAGE ON SCHEMA /.test(sql)) return who === "admin" ? [] : deny("(COMMENT/GRANT)");
    if ((m = sql.match(/^GRANT ([A-Z, ]+) ON "(\w+)"\."(\w+)" TO "shared_writer"$/))) {
      if (who !== "admin") deny("(GRANT)");
      const t = db[`${m[2]}.${m[3]}`];
      if (!t) throw new Error(`ERROR: relation ${m[2]}.${m[3]} does not exist`);
      for (const p of m[1].split(",").map((x) => x.trim())) t.writer.add(p);
      return [];
    }
    if ((m = sql.match(/^DROP TABLE IF EXISTS "(\w+)"\."(\w+)"$/))) {
      if (who !== "admin") deny(`must be owner of relation ${m[2]}`);
      delete db[`${m[1]}.${m[2]}`];
      return [];
    }
    if ((m = sql.match(/^DELETE FROM "(\w+)"\."(\w+)"$/))) {
      const t = db[`${m[1]}.${m[2]}`];
      if (!t) throw new Error("relation does not exist");
      if (who === "writer" && !t.writer.has("DELETE")) deny(`for relation ${m[2]}`);
      t.rows = 0;
      return [];
    }
    if ((m = sql.match(/^INSERT INTO "(\w+)"\."(\w+)" \("value","label","seq"\) VALUES (.*)$/))) {
      const t = db[`${m[1]}.${m[2]}`];
      if (!t) throw new Error("relation does not exist");
      if (who === "writer" && !t.writer.has("INSERT")) deny(`for relation ${m[2]}`);
      t.rows += m[3].split("), (").length;
      return [];
    }
    if ((m = sql.match(/^SELECT column_name[\s\S]*table_schema = '(\w+)' AND table_name = '(\w+)'/))) {
      const t = db[`${m[1]}.${m[2]}`];
      // 🔴 information_schema 只列出当前用户**有权**的表
      if (!t || (who === "writer" && t.writer.size === 0)) return [];
      return std(t.cols);
    }
    if ((m = sql.match(/^SELECT count\(\*\) FROM "(\w+)"\."(\w+)"$/))) {
      const t = db[`${m[1]}.${m[2]}`];
      if (!t) throw new Error("relation does not exist");
      if (who === "writer" && !t.writer.has("SELECT")) deny(`for relation ${m[2]}`);
      return [[{ stringValue: String(t.rows) }]];
    }
    if (/^SELECT tbl_rows FROM svv_table_info/.test(sql)) return [];
    if (/^(CREATE|ALTER) USER "shared_writer" PASSWORD /.test(sql)) return [];
    throw new Error(`假 Redshift 未识别的语句:${sql}`);
  };
  const results = new Map<string, unknown[]>();
  return {
    ...real,
    redshiftDataClientFor: (region: string) => ({
      async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
        const n = cmd.constructor.name;
        if (n === "ExecuteStatementCommand") {
          const id = `st-${results.size + 1}`;
          results.set(id, run(region, String(cmd.input.Sql), String(cmd.input.SecretArn ?? "")) as unknown[]);
          return { Id: id };
        }
        if (n === "DescribeStatementCommand") return { Status: "FINISHED", HasResultSet: (results.get(cmd.input.Id) ?? []).length > 0 };
        return { Records: results.get(cmd.input.Id) ?? [] };
      },
    }),
    execOnTarget: vi.fn(async (a: { warehouse: { region: string }; sql: string; secretArn: string }) => {
      run(a.warehouse.region, a.sql, a.secretArn);
      return { affected: 0, statementId: "x" };
    }),
    describeSecretArnByName: vi.fn(async (region: string, name: string) => h.secrets[`${region}|${name}`]?.arn),
    putSecretJson: vi.fn(async (region: string, name: string, value: Record<string, unknown>) => {
      const created = !h.secrets[`${region}|${name}`];
      h.secrets[`${region}|${name}`] = { arn: `arn:aws:secretsmanager:${region}:1:secret:${name}-AbCdEf`, value };
      return { arn: h.secrets[`${region}|${name}`].arn, created };
    }),
    resolveTargetEndpoint: vi.fn(async () => ({ host: "wg.usw2.example", port: 5439 })),
  };
});

// ── 被测:全部真模块 ─────────────────────────────────────────────────────────────
import { landCodeTableById as landCodeTableByIdRaw, unbindCodeTable as unbindCodeTableRaw } from "@/lib/modeling/service";
import { applyModelTableById as applyModelTableByIdRaw, createModelTable } from "@/lib/modeling/dimensions";
import { landToTargets as landToTargetsRaw, CODE_TABLE_COLUMNS } from "@/lib/modeling/landing";
// 模块 55 / 序 50:landing 的 Redshift Data 轮询经 awaitTerminal(无长操作 / 后台等待者上下文即抛 —— 路由侧由 submitLongOp 提供);
//   判据直接调库函数,所以在 op 帧里调(与真路由同一条路;「无上下文即抛」本身由 lib/long-ops/__tests__/context-await.test 钉)。
import { runInLongOp } from "@/lib/long-ops/context";
const inOp = <T,>(fn: () => Promise<T>): Promise<T> => runInLongOp({ taskId: "test", opKind: "modeling-land" }, fn);
const landCodeTableById: typeof landCodeTableByIdRaw = (...a) => inOp(() => landCodeTableByIdRaw(...a));
const unbindCodeTable: typeof unbindCodeTableRaw = (...a) => inOp(() => unbindCodeTableRaw(...a));
const applyModelTableById: typeof applyModelTableByIdRaw = (...a) => inOp(() => applyModelTableByIdRaw(...a));
const landToTargets: typeof landToTargetsRaw = (...a) => inOp(() => landToTargetsRaw(...a));
import { codeTableLandingFqn } from "@/lib/modeling/landing-fqn";
import { assertBindableTargetsForEngine } from "@/lib/exec-env/data-plane-target";
import { TABLES } from "@/lib/aws/dynamodb";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";
const ADMIN = { actor: "alice@x.com", isPlatformAdmin: true };
const usw2Target = (over: Record<string, unknown> = {}) => ({
  targetId: USW2,
  region: "us-west-2",
  jurisdiction: "home",
  status: "active",
  ready: true,
  components: ["core", "redshift"],
  credentialIsolationState: "provisioning",
  provisioningDeadlineAt: "2099-01-01T00:00:00Z",
  credentialEpoch: 0,
  // 🔴 E-235:白名单最严那一态(谁都不能绑)
  access: { mode: "allowlist", projects: [] },
  resources: {
    redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a",
    redshiftDatabase: "dev",
    redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:redshift!usw2-admin",
  },
  ...over,
});

const CT = {
  pk: "codetable",
  codeTableId: "01CT",
  name: "国家",
  code: "country",
  values: [
    { value: "CN", label: "中国", seq: 0 },
    { value: "US", label: "美国", seq: 1 },
    { value: "JP", label: "日本", seq: 2 },
  ],
  createdAt: "x",
  updatedAt: "x",
};

beforeEach(() => {
  h.ddb.clear();
  h.wh = {};
  h.log.length = 0;
  h.secrets = {};
  h.audits.length = 0;
  h.targets = { [USW2]: usw2Target(), [HOME]: { targetId: HOME, region: "us-east-1" } };
  h.ddb.set(`${TABLES.CODE_TABLES}|01CT`, { ...CT });
});

describe("🔴🔴 装配层:非主控区码表落地走窄权写者(E-229 / E-230 / E-235)", () => {
  it("E-229:该区真有那些行(行数 == 枚举数),DDL 由 admin 执行、DML 由 shared_writer 执行;台账回写 ok", async () => {
    const ct = await landCodeTableById("01CT", { targets: [USW2], actor: ADMIN });
    const rec = ct.landedByTarget?.[USW2];
    expect(rec?.status, `落地记录:${JSON.stringify(rec)}`).toBe("ok");
    const fqn = codeTableLandingFqn(CT);
    const tbl = h.wh["us-west-2"][fqn.fqn];
    expect(tbl?.rows, "接口 ok 不算 —— 该区表里必须真有那些行").toBe(CT.values.length);
    expect(tbl.cols).toBe(CODE_TABLE_COLUMNS);
    // 谁执行了什么:结构 / 授权只由 admin,数据只由窄权写者
    const writerSql = h.log.filter((x) => x.who === "writer" && !/^SELECT/.test(x.sql)).map((x) => x.sql.split(" ")[0]);
    expect(writerSql).toEqual(["DELETE", "INSERT"]);
    const adminDdl = h.log.filter((x) => x.who === "admin").map((x) => x.sql.split(" (")[0]);
    expect(adminDdl.some((x) => /^CREATE TABLE/.test(x))).toBe(true);
    expect(h.log.some((x) => x.who === "writer" && /^(CREATE|DROP|GRANT|COMMENT)/.test(x.sql)), "窄权写者执行了 DDL").toBe(false);
    // 窄权写者身份:secret 建在该区、名字来自 SSOT、只供给一次
    expect(Object.keys(h.secrets)).toEqual(["us-west-2|bgp/shared-writer/tgt-usw2-a"]);
    expect(h.secrets["us-west-2|bgp/shared-writer/tgt-usw2-a"].value.username).toBe("shared_writer");
    // 台账真的写回了(DDB 里那一行的 landedByTarget)
    const saved = h.ddb.get(`${TABLES.CODE_TABLES}|01CT`) as { landedByTarget: Record<string, { status: string }> };
    expect(saved.landedByTarget[USW2].status).toBe("ok");
    // 口令不进任何审计
    const pw = String(h.secrets["us-west-2|bgp/shared-writer/tgt-usw2-a"].value.password);
    expect(JSON.stringify(h.audits)).not.toContain(pw);
  });

  it("E-230(假数仓侧):窄权写者对**别的表**写被拒、DROP 被拒;🔴 正控制:对授过的那张表写成功", async () => {
    await landCodeTableById("01CT", { targets: [USW2], actor: ADMIN });
    const tc = await import("@/lib/exec-env/target-clients");
    const arn = h.secrets["us-west-2|bgp/shared-writer/tgt-usw2-a"].arn;
    const warehouse = { targetId: USW2, region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev" };
    // 同 schema 里另一张不是本次授权的表(admin 建的)
    h.wh["us-west-2"]["public.dim_code_other"] = { cols: CODE_TABLE_COLUMNS, rows: 0, writer: new Set() };
    await expect(
      tc.execOnTarget({ warehouse, secretArn: arn, sql: `INSERT INTO "public"."dim_code_other" ("value","label","seq") VALUES ('a', 'b', 0)` })
    ).rejects.toThrow(/permission denied/);
    await expect(tc.execOnTarget({ warehouse, secretArn: arn, sql: `DROP TABLE IF EXISTS "public"."dim_code_country"` })).rejects.toThrow(
      /must be owner/
    );
    await expect(
      tc.execOnTarget({ warehouse, secretArn: arn, sql: `INSERT INTO "public"."dim_code_country" ("value","label","seq") VALUES ('KR', '韩国', 3)` })
    ).resolves.toBeTruthy();
    // 🔴 闭合式:窄权写者有任何权的表的全集 == 平台显式授过的那一张
    const granted = Object.entries(h.wh["us-west-2"]).filter(([, t]) => t.writer.size > 0).map(([k]) => k);
    expect(granted).toEqual(["public.dim_code_country"]);
  });

  it("🔴🔴 E-235 成对:allowlist=[] 下建模照落;同一状态下业务作业绑这个区照拒 project-not-allowed", async () => {
    const ct = await landCodeTableById("01CT", { targets: [USW2], actor: ADMIN });
    expect(ct.landedByTarget?.[USW2]?.status).toBe("ok");
    expect(JSON.stringify(ct.landedByTarget?.[USW2]), "建模路径上不许再出现这句拒因").not.toContain("无项目上下文");
    const err = await assertBindableTargetsForEngine("redshift", [USW2], "redshift", {
      scope: "per-project",
      projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
    }).catch((e) => e);
    expect(String(err?.message), "白名单对业务数据依然有效(缺这条 = 拆了白名单还说自己修好了)").toMatch(/未授权给项目/);
  });

  it("成员资格:台账里没有的 id ⇒ failed,该区一条语句都没执行", async () => {
    const recs = await landToTargets({
      targets: [USW2],
      kind: "code-table",
      objectId: "01NOPE",
      actor: ADMIN,
      schema: "public",
      table: "orders",
      expectedColumns: CODE_TABLE_COLUMNS,
      statements: [],
      writeStatements: [],
      defHash: "h",
    });
    expect(recs[USW2].status).toBe("failed");
    expect(recs[USW2].error).toMatch(/码表台账里查不到/);
    expect(h.log.filter((x) => !/^(CREATE|ALTER) USER/.test(x.sql)), "成员资格没过却动了库").toEqual([]);
  });

  it("解绑并清理:DROP 由 admin 模板执行(窄权写者删不了),删完观测为空才去记录", async () => {
    await landCodeTableById("01CT", { targets: [USW2], actor: ADMIN });
    const r = await unbindCodeTable("01CT", { targetId: USW2, cleanup: true, confirm: "public.dim_code_country", actor: ADMIN });
    expect(r.dropped).toBe(true);
    expect(h.wh["us-west-2"]["public.dim_code_country"]).toBeUndefined();
    const drop = h.log.find((x) => /^DROP TABLE/.test(x.sql));
    expect(drop?.who).toBe("admin");
    expect(r.codeTable.landedByTarget?.[USW2]).toBeUndefined();
  });
});

describe("🔴🔴 装配层:维度 / 事实表(E-234 + 门②)", () => {
  it("E-234:同一张维度表 home 版与 usw2 版列签名逐字节相同(建模 DDL 只有一个作者)", async () => {
    const mt = await createModelTable({
      name: "用户维度",
      tableType: "dimension",
      schema: "dw",
      physicalTable: "dim_user",
      columns: [
        { name: "user_id", dataType: "BIGINT", isPrimaryKey: true },
        { name: "user_name", dataType: "VARCHAR", length: 128, comment: "用户名 'x'" },
        { name: "amount", dataType: "NUMERIC(18,2)" },
      ],
    });
    const out = await applyModelTableById(mt.modelTableId, "alice", { targets: [HOME, USW2], actor: ADMIN });
    expect(out.landedByTarget?.[HOME]?.status, JSON.stringify(out.landedByTarget?.[HOME])).toBe("ok");
    expect(out.landedByTarget?.[USW2]?.status, JSON.stringify(out.landedByTarget?.[USW2])).toBe("ok");
    const homeCols = h.wh["us-east-1"]["dw.dim_user"].cols;
    const usw2Cols = h.wh["us-west-2"]["dw.dim_user"].cols;
    expect(usw2Cols).toBe(homeCols);
    // usw2 的建表语句与 home 的逐字节相同(模板只 brand,不再拼一遍)
    const createOf = (region: string) => h.log.find((x) => x.region === region && /^CREATE TABLE/.test(x.sql))?.sql;
    expect(createOf("us-west-2")).toBe(createOf("us-east-1"));
    // 维度表没有数据层:窄权写者在该区只做过观测(SELECT)
    expect(h.log.filter((x) => x.region === "us-west-2" && x.who === "writer" && !/^SELECT/.test(x.sql))).toEqual([]);
    expect([...h.wh["us-west-2"]["dw.dim_user"].writer]).toEqual(["SELECT"]);
  });

  it("🔴 门②:定义里填 proj_<…> schema 当场拒;台账被直接改成 proj_ 落点 ⇒ 落地仍被拒(两处同一守卫)", async () => {
    await expect(
      createModelTable({ name: "x", schema: "proj_abc", physicalTable: "t", columns: [{ name: "id", dataType: "BIGINT" }] })
    ).rejects.toThrow(/项目私有 schema/);
    h.ddb.set(`${TABLES.MODEL_TABLES}|01MT`, {
      pk: "modeltable",
      modelTableId: "01MT",
      name: "x",
      tableType: "dimension",
      schema: "proj_abc",
      physicalTable: "t",
      columns: [{ name: "id", dataType: "BIGINT" }],
    });
    const out = await applyModelTableById("01MT", "alice", { targets: [USW2], actor: ADMIN });
    expect(out.landedByTarget?.[USW2]?.status).toBe("failed");
    expect(out.landedByTarget?.[USW2]?.error).toMatch(/项目私有 schema/);
    expect(h.wh["us-west-2"]?.["proj_abc.t"]).toBeUndefined();
  });
});
