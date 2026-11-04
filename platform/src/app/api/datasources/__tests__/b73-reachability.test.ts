// 「已连接」只许来自真正连上的结论(装配层判据 + 调用点判据)。
//
// 【缺陷原形(s38 负向源 10.255.255.1)】建源收口与「测试连接(按 id)」都拿 `testConnection(glueConnectionName)`
//   (只核 Glue 连接存在 + JDBC URL + 子网,不登录源库)的结论写 status=active ⇒ host 不可达的源建完就显示「已连接 (115ms)」。
// 【规则】配置核对只回答「配好了没」:没配好 ⇒ error;配好了 ⇒ 不写 status,交给与「检测」同一作者的连通性检测
//   (直连可达 ⇒ active;直连不到且有 Glue 连接 ⇒ testing + 发现作业;探测发不起来 ⇒ error 写明原因,不停在「测试中」)。
// 【只 mock 真外部】DDB、JDBC 驱动(pingDataSource)、SPI registry、按区 SDK 客户端工厂、落点解析。
//   reachability-probe / glue-reach / glue-job-upsert / ds-patch 真装配。
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-s3";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  ds: {} as Record<string, any>,
  ping: { reachable: true as boolean | null, latencyMs: 12, error: undefined as string | undefined },
}));
const DS_ID = "01DSB73REACH0000000A1";

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc: "ddb", cmd: cmd.constructor.name, input });
      if (cmd.constructor.name === "UpdateCommand") {
        const vals = (input.ExpressionAttributeValues || {}) as Record<string, unknown>;
        const names = (input.ExpressionAttributeNames || {}) as Record<string, string>;
        for (const m of String(input.UpdateExpression || "").matchAll(/(#?\w+)\s*=\s*(:\w+)/g)) {
          const k = names[m[1]] ?? m[1];
          if (m[2] in vals) h.ds[k] = vals[m[2]];
        }
        return { Attributes: { ...h.ds } };
      }
      if (cmd.constructor.name === "GetCommand") return { Item: { ...h.ds } };
      return {};
    }),
  },
}));
vi.mock("@/lib/datasource/heartbeat", () => ({
  pingDataSource: vi.fn(async () => { h.calls.push({ svc: "node", cmd: "ping", input: {} }); return { ...h.ping }; }),
}));
vi.mock("@/lib/datasource-spi/registry", () => ({
  isDataSourceType: (t: string) => ["mysql", "postgresql"].includes(t),
  getProvider: () => ({
    capabilities: { paradigm: "jdbc", needsGlueConnection: true },
    buildConnection: () => ({ paradigm: "jdbc", jdbcUrl: "jdbc:mysql://db.cust.internal:3306/gamedb", driverClass: "com.mysql.cj.jdbc.Driver" }),
  }),
}));
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const get = (svc: string) => async () => clients[svc];
  return { ...real, glueClientFor: get("glue"), s3ClientFor: get("s3") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "us-east-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
  };
});

function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "GetJobCommand") { const e = new Error("Job not found"); e.name = "EntityNotFoundException"; throw e; }
      if (svc === "glue" && n === "CreateJobCommand") return { Name: input.Name };
      if (svc === "glue" && n === "StartJobRunCommand") return { JobRunId: "jr_b73_1" };
      if (svc === "s3" && n === "PutObjectCommand") return {};
      return {};
    }),
  };
}

const baseDs = () => ({
  userId: "default-user", datasourceId: DS_ID, projectId: "p1", name: "neg-src", type: "mysql",
  host: "10.255.255.1", port: 3306, database: "gamedb", username: "u", status: "testing",
  secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:bgp-ds-x", glueConnectionName: "bgp-conn-B73000000A1",
  ownerTargetId: "tgt_home",
});
const okConfig = () => ({ success: true, steps: [{ name: "connection_exists", status: "pass" as const, message: "Glue Connection 已创建" }], totalMs: 115 });
const badConfig = () => ({ success: false, steps: [{ name: "connection_exists", status: "fail" as const, message: "Glue Connection 不存在" }], totalMs: 40 });
const ddbSets = () => h.calls.filter((c) => c.svc === "ddb" && c.cmd === "UpdateCommand");

beforeEach(() => {
  h.calls.length = 0; h.ds = baseDs();
  h.ping = { reachable: true, latencyMs: 12, error: undefined };
  for (const s of ["glue", "s3"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.resetModules();
});

describe("🔴 配置核对之后的收口 settleAfterConfigCheck(建源 / 测试连接共用)", () => {
  const settle = async (result: any) => {
    const m: any = await import("@/lib/datasource/reachability-probe");
    return m.settleAfterConfigCheck(h.ds, result);
  };

  it("配置核对通过 + 源库真连得上 ⇒ active 来自控制面直连(心跳 via=control-plane),testResult 只是附带记录", async () => {
    const out = await settle(okConfig());
    expect(out.kind).toBe("settled");
    expect(h.ds.status).toBe("active");
    expect(h.ds.heartbeat).toMatchObject({ via: "control-plane", state: "settled", reachable: true, latencyMs: 12 });
    expect(h.ds.testResult).toMatchObject({ success: true, totalMs: 115 });
    expect(h.calls.filter((c) => c.svc === "node" && c.cmd === "ping")).toHaveLength(1);
  });

  it("🔴 缺陷原形:配置核对通过但源库连不上(host 不可达)+ 有 Glue 连接 ⇒ **绝不写 active**:status=testing 且发现作业已起,结论留给探测", async () => {
    h.ping = { reachable: false, latencyMs: undefined as any, error: "connect ETIMEDOUT 10.255.255.1:3306" };
    const out = await settle(okConfig());
    expect(out.kind).toBe("glue-testing");
    expect(h.ds.status).toBe("testing");
    expect(h.ds.heartbeat).toMatchObject({ via: "glue-connection", state: "testing", reachable: null, jobRunId: "jr_b73_1", controlPlane: { reachable: false } });
    // 全程没有任何一笔 UpdateCommand 把 status 写成 active
    const activeWrites = ddbSets().filter((c) => Object.values((c.input.ExpressionAttributeValues || {}) as Record<string, unknown>).includes("active"));
    expect(activeWrites, "配置核对通过不等于连上了").toHaveLength(0);
    expect(h.calls.filter((c) => c.svc === "glue" && c.cmd === "StartJobRunCommand")).toHaveLength(1);
  });

  it("配置核对**没过**(Glue 连接缺 / 没 JDBC URL)⇒ error + testResult,不去探测", async () => {
    const out = await settle(badConfig());
    expect(out.kind).toBe("config-failed");
    expect(h.ds.status).toBe("error");
    expect(h.ds.testResult).toMatchObject({ success: false });
    expect(h.calls.filter((c) => c.svc === "node")).toHaveLength(0);
  });

  it("探测发不起来(源没填库名 ⇒ 起不了发现作业)⇒ error + 心跳写明原因,不留在「测试中」", async () => {
    h.ping = { reachable: false, latencyMs: undefined as any, error: "connect ETIMEDOUT" };
    h.ds.database = "";
    const out = await settle(okConfig());
    expect(out.kind).toBe("probe-failed");
    expect(h.ds.status).toBe("error");
    expect(String(h.ds.heartbeat.error)).toContain("数据库名");
    expect(h.ds.heartbeat).toMatchObject({ state: "unknown", reachable: null });
  });
});

describe("🔴 调用点判据:三条路都经唯一作者,配置核对写 active 的旧写法一处不留", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("建源 POST(JDBC 路径;主体在执行体 lib/datasource/long-ops.ts):testConnection 的 then 里是 settleAfterConfigCheck,JDBC 块里不再自己拿配置核对写 active", () => {
    const src = strip(read("lib/datasource/long-ops.ts"));
    expect(src).toMatch(/testConnection\(glueConnectionName, dsPlace\.region\)\s*\.then\(\(result\) => settleAfterConfigCheck\(/);
    // 只盯 JDBC 块(从 Glue 连接建成到该路径的 apiOk):非 JDBC 范式的 provider.testConnection 是**真探测**(HeadBucket / DescribeTable /
    //   DescribeStream),它写 active 合法,不在之列。
    const jdbcStart = src.indexOf("createGlueConnection(datasourceId");
    const jdbcEnd = src.indexOf("provisionedResources:", jdbcStart);
    expect(jdbcStart).toBeGreaterThan(0); expect(jdbcEnd).toBeGreaterThan(jdbcStart);
    const jdbcBlock = src.slice(jdbcStart, jdbcEnd);
    expect(jdbcBlock, "旧写法:拿 Glue 连接配置核对的结论写 active").not.toMatch(/result\.success \? "active"/);
    expect(jdbcBlock).not.toContain("UpdateCommand");
  });

  it("测试连接(按 id):先按源所在区核配置,再 settleAfterConfigCheck;不再直接写 status", () => {
    const src = strip(read("app/api/datasources/test/route.ts"));
    expect(src).toContain("regionOfTarget(datasourceOwnerTarget(Item))");
    expect(src).toContain("testConnection(Item.glueConnectionName, region)");
    expect(src).toContain("settleAfterConfigCheck(Item as unknown as DataSource, result)");
    expect(src).not.toMatch(/result\.success \? "active"/);
    expect(src).not.toContain("UpdateCommand");
  });

  it("检测 POST(heartbeat)经 probeDataSourceReachability(与建源收口同一作者)", () => {
    const src = strip(read("app/api/datasources/[id]/heartbeat/route.ts"));
    expect(src).toContain("await probeDataSourceReachability(row)");
    expect(src, "本地不再保留第二份探测实现").not.toContain("pingDataSource(");
  });

  it("页面状态格:不再把配置核对耗时 testResult.totalMs 贴在「已连接」旁边(那不是连上源库的延迟)", () => {
    const src = strip(read("app/datasources/page.tsx"));
    expect(src).not.toContain("r.testResult?.totalMs");
  });
});
