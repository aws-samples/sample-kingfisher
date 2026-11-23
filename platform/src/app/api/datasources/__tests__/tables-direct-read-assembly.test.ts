// 「浏览表」路由 × 真数据源 provider 的装配层判据(探测与浏览表方式 = 自动)。
//
// 【缺陷原形(2026-11-19 测试账号,页面实测)】源库在执行区的私有网络里,平台控制面直连不到;数据源的探测方式是「自动」。
//   同步向导选中这条源后第 2 步一直没有表:`GET /api/datasources/<id>/tables` 回 200 `[]`,而源行里已经缓存着经 Glue 连接发现到的表。
//   根因 = MySQL(PostgreSQL / Oracle / SQL Server 同样)的读表结构把「连不上」折成空清单,路由当成「直连读到 0 张表」,
//   表单承诺的「连不上且有 Glue 连接时自动改经 Glue 连接」永远走不到。当时的路由判据把 provider 整个 mock 成「连不上就抛」,与真实现不同形,所以全绿。
// 【规则】直连读不到(连不上 / 凭证不对 / 凭证读不到)必须能看见:有 Glue 连接 ⇒ 用缓存的发现结果,没有缓存就起发现作业(202);
//   没有 Glue 连接 ⇒ 500 带驱动原话。直连读到了、库里就是没有表 ⇒ 200 `[]`,不起发现作业。
//   「读不到按空清单处理」的容错只留给不需要区分两者的调用方(注册元数据),唯一作者在 JDBC 基类。
// 【只 mock 真外部】MySQL 驱动、DynamoDB、按区 SDK 客户端工厂(Glue / S3 / Secrets Manager)、落点解析、鉴权。
//   数据源 SPI 注册表 / JDBC 基类 / MySQL provider / glue-reach / ds-patch 都是真的。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-s3";
import "@aws-sdk/client-secrets-manager";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  ds: {} as Record<string, any>,
  connectError: "" as string,                       // 驱动建连失败的原话;空 = 连得上
  rows: [] as Array<Record<string, unknown>>,       // INFORMATION_SCHEMA.COLUMNS 的行
  secretError: "" as string,                        // 读凭证失败的原话
  ended: 0,
}));
const DS_ID = "01DSDIRECTREAD0000A1B";
const JOB = `bgp-ds-discover-${DS_ID.slice(-12)}`;

// 真外部:MySQL 驱动。连不上 ⇒ createConnection 拒绝(与 mysql2 的行为同形:错误消息形如 connect ETIMEDOUT)。
vi.mock("mysql2/promise", () => {
  const createConnection = vi.fn(async (cfg: Record<string, unknown>) => {
    h.calls.push({ svc: "mysql", cmd: "createConnection", input: { host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user } });
    if (h.connectError) throw new Error(h.connectError);
    return {
      query: vi.fn(async (_sql: string, args: unknown[]) => { h.calls.push({ svc: "mysql", cmd: "query", input: { args } }); return [h.rows]; }),
      end: vi.fn(async () => { h.ended += 1; }),
    };
  });
  return { default: { createConnection }, createConnection };
});
vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      const n = cmd.constructor.name;
      h.calls.push({ svc: "ddb", cmd: n, input });
      if (n === "GetCommand") return { Item: { ...h.ds } };
      if (n === "UpdateCommand") {
        const vals = (input.ExpressionAttributeValues || {}) as Record<string, unknown>;
        const names = (input.ExpressionAttributeNames || {}) as Record<string, string>;
        for (const m of String(input.UpdateExpression || "").matchAll(/(#?\w+)\s*=\s*(:\w+)/g)) {
          const k = names[m[1]] ?? m[1];
          if (m[2] in vals) h.ds[k] = vals[m[2]];
        }
        return { Attributes: { ...h.ds } };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
  requireProject: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1", role: "editor" })),
}));
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const get = (svc: string) => async () => clients[svc];
  return { ...real, glueClientFor: get("glue"), s3ClientFor: get("s3"), secretsClientFor: get("secrets") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_usw2_a", region: "us-west-2", scriptsBucket: "bgp-glue-scripts-12345678901a-tgt-usw2-a", roleArn: "arn:aws:iam::12345678901a:role/BgpExecEnv-tgt-usw2-a-glue-role",
      datalakeBucket: "bgp-datalake-12345678901a-tgt-usw2-a", tableBucket: "bgp-table-bucket-tgt-usw2-a", home: false, jurisdiction: "home",
    })),
  };
});

function err(name: string, message: string) { const e = new Error(message); e.name = name; return e; }
function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      const n = cmd.constructor.name;
      h.calls.push({ svc, cmd: n, input });
      if (svc === "secrets" && n === "GetSecretValueCommand") {
        if (h.secretError) throw err("ResourceNotFoundException", h.secretError);
        return { SecretString: JSON.stringify({ username: "kf_app", password: "not-a-real-credential" }) };
      }
      if (svc === "glue" && n === "GetJobCommand") throw err("EntityNotFoundException", "Job not found");
      if (svc === "glue" && n === "CreateJobCommand") return { Name: input.Name };
      if (svc === "glue" && n === "StartJobRunCommand") return { JobRunId: "jr_discover_9" };
      if (svc === "glue" && n === "GetJobRunCommand") return { JobRun: { JobRunState: "RUNNING" } };
      return {};
    }),
  };
}

// 源行形态取自真落库的行(2026-11-19 测试账号里页面新建的执行区 MySQL 源,探测方式「自动」;标识已换成夹具值)
const baseDs = () => ({
  userId: "default-user", datasourceId: DS_ID, projectId: "p1", name: "exec-private-mysql", type: "mysql", env: "dev", status: "active",
  host: "kf-fixture.cluster-abc.us-west-2.rds.amazonaws.com", port: 3306, database: "kfp86", username: "kf_app",
  secretArn: "arn:aws:secretsmanager:us-west-2:12345678901a:secret:bgp/datasource/01DSDIRECTREAD0000A1B-AbCdEf",
  glueConnectionName: "bgp-conn-DIRECTREAD0A1B", ownerTargetId: "tgt_usw2_a", probeVia: "auto",
  networkConfig: { subnetId: "subnet-0aaa", securityGroupIds: ["sg-0bbb"], availabilityZone: "us-west-2a" },
});
// 源行里缓存的发现结果(真行同形:at / database / tables[{ name, database, columns[] }] / via)
const cachedSchema = () => ({
  at: "2026-11-19T12:17:02.022769Z", database: "kfp86", via: "glue-discovery",
  tables: [{ name: "orders", database: "kfp86", columns: [
    { name: "id", type: "bigint", nullable: false, key: "PRI", comment: "" },
    { name: "sku", type: "varchar(32)", nullable: false, key: "   ", comment: "" },
  ] }],
});
const columnsRows = () => [
  { TABLE_NAME: "orders", COLUMN_NAME: "id", COLUMN_TYPE: "bigint", IS_NULLABLE: "NO", COLUMN_KEY: "PRI", COLUMN_COMMENT: "" },
  { TABLE_NAME: "orders", COLUMN_NAME: "sku", COLUMN_TYPE: "varchar(32)", IS_NULLABLE: "NO", COLUMN_KEY: "", COLUMN_COMMENT: "" },
];
const req = (p: string) => new NextRequest(`http://x${p}`, { method: "GET" });
const get = async (qs = "?database=kfp86") => {
  const m: any = await import("@/app/api/datasources/[id]/tables/route");
  return m.GET(req(`/api/datasources/${DS_ID}/tables${qs}`), { params: Promise.resolve({ id: DS_ID }) });
};
const of = (svc: string, cmd?: string) => h.calls.filter((c) => c.svc === svc && (!cmd || c.cmd === cmd));

beforeEach(() => {
  h.calls.length = 0; h.ds = baseDs(); h.connectError = ""; h.rows = columnsRows(); h.secretError = ""; h.ended = 0;
  for (const s of ["glue", "s3", "secrets"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "12345678901a";
  vi.resetModules();
});

describe("浏览表(自动):控制面直连不到的源", () => {
  it("源行里有缓存的发现结果 ⇒ 200 回缓存的表(经 Glue 连接发现),不是空数组;不起新的发现作业", async () => {
    h.connectError = "connect ETIMEDOUT";
    h.ds.discoveredSchema = cachedSchema();
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(b)).toBe(false);
    expect(b.via).toBe("glue-discovery");
    expect(b.tables.map((x: any) => x.name)).toEqual(["orders"]);
    expect(b.database).toBe("kfp86");
    expect(String(b.note)).toContain("控制面直连不到该源");
    expect(of("mysql", "createConnection")).toHaveLength(1);       // 先试过直连
    expect(of("glue", "StartJobRunCommand")).toHaveLength(0);
  });

  it("没有缓存 ⇒ 起发现作业,202 { discovering };源行记下在跑的这一次", async () => {
    h.connectError = "connect ETIMEDOUT";
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(202);
    expect(b).toMatchObject({ discovering: true, via: "glue-discovery", database: "kfp86", jobRunId: "jr_discover_9" });
    const start = of("glue", "StartJobRunCommand");
    expect(start).toHaveLength(1);
    expect(start[0].input.JobName).toBe(JOB);
    expect(h.ds.discovery).toMatchObject({ state: "running", jobRunId: "jr_discover_9", database: "kfp86", region: "us-west-2" });
  });

  it("凭证不对(驱动回 Access denied)同样算没读到 ⇒ 改经 Glue 连接,不回空数组", async () => {
    h.connectError = "Access denied for user 'kf_app'@'10.0.1.23' (using password: YES)";
    const r = await get();
    expect(r.status).toBe(202);
    expect(of("glue", "StartJobRunCommand")).toHaveLength(1);
  });

  it("凭证读不到 ⇒ 不去连库,同样改经 Glue 连接", async () => {
    h.secretError = "Secrets Manager can't find the specified secret.";
    const r = await get();
    expect(r.status).toBe(202);
    expect(of("mysql", "createConnection")).toHaveLength(0);
    expect(of("glue", "StartJobRunCommand")).toHaveLength(1);
  });

  it("没有 Glue 连接 ⇒ 500「无法连接源数据库」带驱动原话,零 Glue 调用", async () => {
    h.connectError = "connect ECONNREFUSED 10.0.1.9:3306";
    delete h.ds.glueConnectionName;
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(500);
    expect(String(b.error)).toContain("无法连接源数据库");
    expect(String(b.error)).toContain("ECONNREFUSED");
    expect(of("glue")).toHaveLength(0);
  });
});

describe("浏览表(自动):控制面直连得到的源", () => {
  it("读到表 ⇒ 数组应答(name / database / columns),零 Glue 调用,连接用完即关", async () => {
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(b)).toBe(true);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ name: "orders", database: "kfp86" });
    expect(b[0].columns.map((c: any) => c.name)).toEqual(["id", "sku"]);
    expect(of("mysql", "query")[0].input.args).toEqual(["kfp86"]);
    expect(of("glue")).toHaveLength(0);
    expect(h.ended).toBe(1);
  });

  it("连得上、库里一张表都没有 ⇒ 200 空数组;「没有表」不当成「没读到」,不起发现作业", async () => {
    h.rows = [];
    h.ds.discoveredSchema = cachedSchema();       // 即使行里有旧的发现缓存,也以这次直连读到的为准
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(200);
    expect(b).toEqual([]);
    expect(of("glue")).toHaveLength(0);
  });
});

describe("JDBC provider 的两个读取入口(真 MySQL provider)", () => {
  const ref = () => ({ type: "mysql" as const, connection: { host: "db.internal", port: 3306, database: "kfp86" }, secretArn: baseDs().secretArn, username: "kf_app" });

  it("introspectStrict:连不上就抛驱动原话;introspect:同一种失败按空清单处理(注册元数据的调用方靠它)", async () => {
    h.connectError = "connect ETIMEDOUT";
    const { getProvider } = await import("@/lib/datasource-spi/registry");
    const p = getProvider("mysql");
    await expect(p.introspectStrict!(ref())).rejects.toThrow("ETIMEDOUT");
    await expect(p.introspect(ref())).resolves.toEqual([]);
  });

  it("两个入口读到的是同一份表清单", async () => {
    const { getProvider } = await import("@/lib/datasource-spi/registry");
    const p = getProvider("mysql");
    const strict = await p.introspectStrict!(ref());
    const tolerant = await p.introspect(ref());
    expect(strict).toEqual(tolerant);
    expect(strict.map((d) => d.name)).toEqual(["orders"]);
    expect(h.ended).toBe(2);
  });

  it("四种 JDBC 方言都有读不到就抛的入口;不直连读系统表的范式没有", async () => {
    const { getProvider } = await import("@/lib/datasource-spi/registry");
    for (const t of ["mysql", "postgresql", "oracle", "sqlserver"] as const) {
      expect(typeof getProvider(t).introspectStrict, t).toBe("function");
    }
    expect(getProvider("dynamodb").introspectStrict).toBeUndefined();
  });
});
