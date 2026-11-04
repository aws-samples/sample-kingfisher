// 🔴 (2026-10-25 读代码挖出,台账 v2.10):S3 源「建 Athena 外部表」的三条 DDL 一律 startQuery(sql, { database }) 不带落点、
//   getExecution(id) 不带区 ⇒ 第二区的 S3 源建出来的外部表落在**主控区**的 Glue 目录 / 工作组(主控区 Athena 跨区读桶),
//   而执行体明明已 noteDatasourceRowPlace(ds) 记了这条源所在区 —— 记了账、没把落点交给建表。
// 根治 = ensureExternalTable(spec, place) 落点必填(TS 上没有缺省,运行时缺也抛),执行体按行上的章(datasourceOwnerTarget,唯一读法)
//   经 resolveAthenaPlace 解析 ⇒ 非 home 用该区描述符的工作组 / 湖桶,三条 DDL 与状态查询都打到同一个区;home 逐字节等价。
// 只 mock 真外部:Athena SDK / S3 SDK(introspect 采样)/ DynamoDB(源行 + 审计)/ 注册表(DDB);
//   兄弟模块 ds-place / placement-shared / athena-external / datasource-spi 全真(装配层判据,不抹接缝)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  athena: [] as { region: string; name: string; input: any }[],
  s3: [] as { region: string; name: string; input: any }[],
  row: null as Record<string, any> | null,
  audits: [] as any[],
}));

// ── 只 mock 真外部 ──────────────────────────────────────────────────────────────
vi.mock("@aws-sdk/client-athena", async (orig) => {
  const real: any = await orig();
  class FakeAthena {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      h.athena.push({ region: this.region, name, input: cmd.input });
      if (name === "StartQueryExecutionCommand") return { QueryExecutionId: `q-${h.athena.length}` };
      if (name === "GetQueryExecutionCommand") return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      throw new Error(`FakeAthena: 本判据不该发出 ${name}`);
    }
    destroy() {}
  }
  return { ...real, AthenaClient: FakeAthena };
});

vi.mock("@aws-sdk/client-s3", async (orig) => {
  const real: any = await orig();
  class FakeS3 {
    region: string;
    constructor(cfg: { region: string }) { this.region = cfg.region; }
    async send(cmd: any) {
      const name = cmd.constructor.name;
      h.s3.push({ region: this.region, name, input: cmd.input });
      if (name === "ListObjectsV2Command") {
        // 顶层按 Delimiter 分组 ⇒ 一个子前缀 players/;子前缀下 ⇒ 一个 CSV 数据文件
        if (cmd.input.Delimiter === "/") return { CommonPrefixes: [{ Prefix: `${cmd.input.Prefix}players/` }], Contents: [] };
        return { Contents: [{ Key: `${cmd.input.Prefix}part-0.csv`, Size: 120 }] };
      }
      if (name === "GetObjectCommand") return { Body: { transformToString: async () => "player_id,country,score\n1,CN,10\n2,US,20\n" } };
      throw new Error(`FakeS3: 本判据不该发出 ${name}`);
    }
    destroy() {}
  }
  return { ...real, S3Client: FakeS3 };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  // 表名只在命令入参里出现;Proxy 让任何 TABLES.X 都有值,免得 import 期取不到就炸
  TABLES: new Proxy({}, { get: (_t, key) => `bgp-${String(key).toLowerCase().replace(/_/g, "-")}` }),
  docClient: {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const kind = cmd.constructor.name;
      if (kind === "GetCommand") return { Item: h.row ?? undefined };
      if (kind === "PutCommand") { h.audits.push(cmd.input); return {}; }
      return {};
    }),
  },
}));

vi.mock("@/lib/exec-env/registry", () => ({
  requireReadyTarget: vi.fn(async (id: string) => ({
    targetId: id,
    region: "us-west-2",
    resources: { athenaWorkgroup: "bgp-athena-tgt-usw2-a", datalakeBucket: "bgp-datalake-x-usw2" },
  })),
}));

const SRC = resolve(__dirname, "../../..");
// 接缝判据读的是**代码**,不是注释(文件头注释里写着缺陷原形 `startQuery(sql, { database })`,不剥会把它当调用点)
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(resolve(SRC, rel), "utf8"));
const T2_ROW = {
  userId: "default-user",
  datasourceId: "ds-s3x-1",
  name: "s3x",
  type: "s3",
  ownerTargetId: "tgt_usw2_a",
  connection: { bucket: "bgp-datalake-x-usw2", prefix: "gamedata/", region: "us-west-2", format: "auto", hasHeader: true },
};
const starts = () => h.athena.filter((call) => call.name === "StartQueryExecutionCommand");
const gets = () => h.athena.filter((call) => call.name === "GetQueryExecutionCommand");

async function runExecutor(params: { datasourceId: string; projectId: string; dataset?: string }) {
  const { DATASOURCE_LONG_OP_EXECUTORS } = await import("@/lib/datasource/long-ops");
  const { runInLongOp } = await import("@/lib/long-ops/context");
  const req = new NextRequest(`http://platform.test/api/datasources/${params.datasourceId}/s3-external`, { method: "POST" });
  return runInLongOp({ taskId: "t-s3x-judge", opKind: "datasource-s3-external" }, () =>
    DATASOURCE_LONG_OP_EXECUTORS["datasource-s3-external"](params, { req, identity: { userId: "u-judge", role: "admin" } as any })
  );
}

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  delete process.env.BGP_HOME_REGION;
  delete process.env.ATHENA_WORKGROUP;
  h.athena.length = 0;
  h.s3.length = 0;
  h.audits.length = 0;
  h.row = null;
});

describe("🔴 S3 外部表建在数据源所在区(执行体 datasource-s3-external 装配判据)", () => {
  it("第二区的 S3 源 ⇒ 三条 DDL 与全部状态查询都打到 us-west-2 的该区工作组 / 湖桶;主控区零调用;响应回 targetId / region", async () => {
    h.row = { ...T2_ROW };
    const out = await runExecutor({ datasourceId: T2_ROW.datasourceId, projectId: "proj-a" });
    const data = out.data as any;
    expect(data.qualifiedName).toBe("bgp_s3_ext.players");
    expect(data.targetId).toBe("tgt_usw2_a");
    expect(data.region).toBe("us-west-2");
    expect(data.sampleQuery).toBe("SELECT * FROM bgp_s3_ext.players LIMIT 100");
    expect(data.location).toBe("s3://bgp-datalake-x-usw2/gamedata/players/");
    expect(data.columns.map((c: any) => c.name)).toEqual(["player_id", "country", "score"]);
    // 三条 DDL:建库 / DROP / CREATE EXTERNAL TABLE —— 全在 us-west-2、该区工作组、该区湖桶结果位置
    const ddl = starts();
    expect(ddl.map((call) => String(call.input.QueryString).split("\n")[0])).toEqual([
      "CREATE DATABASE IF NOT EXISTS bgp_s3_ext",
      "DROP TABLE IF EXISTS bgp_s3_ext.players",
      "CREATE EXTERNAL TABLE IF NOT EXISTS bgp_s3_ext.players (",
    ]);
    for (const call of ddl) {
      expect(call.region).toBe("us-west-2");
      expect(call.input.WorkGroup).toBe("bgp-athena-tgt-usw2-a");
      expect(call.input.ResultConfiguration?.OutputLocation).toBe("s3://bgp-datalake-x-usw2/athena-results/");
    }
    expect(String(ddl[2].input.QueryString)).toContain("LOCATION 's3://bgp-datalake-x-usw2/gamedata/players/'");
    // 状态查询必须打到发起它的那个区
    expect(gets().length).toBeGreaterThanOrEqual(3);
    expect(new Set(gets().map((call) => call.region))).toEqual(new Set(["us-west-2"]));
    expect(h.athena.filter((call) => call.region === "us-east-1")).toEqual([]);
    // 审计记了真落点
    const audit = h.audits.find((put) => JSON.stringify(put).includes("datasource.s3-external"));
    expect(JSON.stringify(audit)).toContain('"targetId":"tgt_usw2_a"');
  }, 30_000);

  it("存量无章的源(= 主控区)⇒ 逐字节等价于修前:主控区 region、工作组 bgp-athena、不带 ResultConfiguration;targetId = tgt_home", async () => {
    h.row = { ...T2_ROW, ownerTargetId: undefined, connection: { ...T2_ROW.connection, region: "us-east-1" } };
    const out = await runExecutor({ datasourceId: T2_ROW.datasourceId, projectId: "proj-a" });
    const data = out.data as any;
    expect(data.targetId).toBe("tgt_home");
    expect(data.region).toBe("us-east-1");
    expect(starts().length).toBe(3);
    for (const call of starts()) {
      expect(call.region).toBe("us-east-1");
      expect(call.input.WorkGroup).toBe("bgp-athena");
      expect(call.input.ResultConfiguration).toBeUndefined();
    }
    expect(new Set(h.athena.map((call) => call.region))).toEqual(new Set(["us-east-1"]));
  }, 30_000);

  it("🔴 ensureExternalTable 裸调(没给落点)⇒ 抛且一条 Athena 调用都不发(不许「没给就落主控区」)", async () => {
    const { ensureExternalTable } = await import("@/lib/datasource-spi/object-store/athena-external");
    const spec = { table: "t", location: "s3://b/p/", format: "csv", columns: [{ name: "a", type: "string" }] };
    await expect((ensureExternalTable as any)(spec)).rejects.toThrow(/缺落点/);
    await expect((ensureExternalTable as any)(spec, { targetId: "tgt_usw2_a", region: "", workgroup: "" })).rejects.toThrow(/缺落点/);
    expect(h.athena).toEqual([]);
  });

  it("接缝(源码调用点,不是 import):执行体按行上的章解析落点并整体交给 ensureExternalTable;athena-external 没有不带落点的 startQuery / getExecution", () => {
    const executor = read("lib/datasource/long-ops.ts");
    expect(executor).toMatch(/const place = await resolveAthenaPlace\(datasourceOwnerTarget\(ds\)\);/);
    expect(executor).toMatch(/ensureExternalTable\(\s*\{[\s\S]*?\},\s*place\s*\)/);
    const builder = read("lib/datasource-spi/object-store/athena-external.ts");
    const startCalls = builder.match(/\bstartQuery\([^;]*\)/g) || [];
    expect(startCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of startCalls) expect(call, `startQuery 调用没带落点:${call}`).toMatch(/,\s*place\s*\)$/);
    const getCalls = builder.match(/\bgetExecution\([^)]*\)/g) || [];
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of getCalls) expect(call, `getExecution 调用没带区:${call}`).toMatch(/,\s*region\s*\)$/);
  });
});
