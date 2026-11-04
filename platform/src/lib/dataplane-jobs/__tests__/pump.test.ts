// 推进泵(④-2):只做「一次 Query + 回环 POST」;选主 / 停泵 / 缺密钥三种不跑的情形都必须真的不跑。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDdb, DDB_SPECS } from "./fake-ddb";

const h = vi.hoisted(() => ({ ddb: null as unknown as FakeDdb }));
h.ddb = new FakeDdb(DDB_SPECS);
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: (c: never) => h.ddb.send(c) } };
});

const { runPumpTick, SWEEP_EVERY_TICKS, selfBaseUrl } = await import("@/lib/dataplane-jobs/pump");
const { STEP_ENDPOINT_PATH, SWEEP_ENDPOINT_PATH } = await import("@/lib/dataplane-jobs/schema");
const { INTERNAL_KEY_HEADER, INTERNAL_SOURCE_HEADER, INTERNAL_SOURCE_DATAPLANE_JOB_PUMP } = await import(
  "@/lib/scheduler/internal-source"
);

type Posted = { url: string; headers: Record<string, string>; body: unknown };
let posted: Posted[] = [];
const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
  posted.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return { ok: true, status: 200 } as Response;
}) as unknown as typeof fetch;

function seed(jobId: string, nextRunAt: number, active = true) {
  h.ddb.put("bgp-dataplane-jobs", { jobId, targetId: "tgt_usw2_a", createdAt: "x", nextRunAt, ...(active ? { dueShard: "due" } : {}) });
}

beforeEach(() => {
  h.ddb.tables.clear();
  h.ddb.calls.length = 0;
  posted = [];
  delete process.env.BGP_DATAPLANE_JOBS_PAUSED;
});

const deps = (over: Record<string, unknown> = {}) => ({
  isLeader: () => true,
  now: () => 1_000_000,
  fetchImpl,
  loadKey: async () => "k-123",
  baseUrl: "http://self:3000",
  ...over,
});

// 缺省读钥匙的那条路(deps.loadKey 不注入时真走的)。
//   只 mock 真外部(Secrets Manager SDK 的客户端类);工厂 sdkClient 走真实现 ⇒ 证的是「控制面构造 + 主控区 + 5 分钟缓存」。
describe("loadInternalDispatchKey(缺省读法)", () => {
  it("🔴 经控制面工厂在主控区建 Secrets Manager 客户端(不注入数据面角色),读到即缓存 5 分钟", async () => {
    const ctorConfigs: Array<{ region?: string }> = [];
    let sends = 0;
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: class {
        constructor(cfg: { region?: string }) {
          ctorConfigs.push(cfg);
        }
        async send() {
          sends++;
          return { SecretString: "k-from-sm" };
        }
      },
      GetSecretValueCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    const prevArn = process.env.ACTION_DISPATCH_SECRET_ARN;
    const prevRegion = process.env.AWS_REGION;
    process.env.ACTION_DISPATCH_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/internal/action-dispatch-key-AbCdEf";
    process.env.AWS_REGION = "us-east-1";
    try {
      const { loadInternalDispatchKey, __resetPumpKeyCache } = await import("@/lib/dataplane-jobs/pump");
      __resetPumpKeyCache();
      expect(await loadInternalDispatchKey()).toBe("k-from-sm");
      expect(await loadInternalDispatchKey(), "5 分钟内第二次读走缓存").toBe("k-from-sm");
      expect(sends).toBe(1);
      // 控制面工厂原样 new(数据面工厂会注入 credentials 字段);③ 起唯一多出的两个键 = 网络预算(建连 5 s / 空闲 60 s / 3 次有界重试)
      expect(ctorConfigs).toEqual([{ region: "us-east-1", requestHandler: { connectionTimeout: 5000, socketTimeout: 60000 }, maxAttempts: 3 }]);
      expect(Object.keys(ctorConfigs[0]).sort()).toEqual(["maxAttempts", "region", "requestHandler"]);
      expect(ctorConfigs[0]).not.toHaveProperty("credentials");
    } finally {
      vi.doUnmock("@aws-sdk/client-secrets-manager");
      if (prevArn === undefined) delete process.env.ACTION_DISPATCH_SECRET_ARN;
      else process.env.ACTION_DISPATCH_SECRET_ARN = prevArn;
      if (prevRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prevRegion;
    }
  });
});

describe("推进泵", () => {
  it("持租约 ⇒ 取到期未终态的作业,逐条回环 POST 内部端点,带来源头与密钥", async () => {
    seed("dpj_a", 999_000);
    seed("dpj_b", 2_000_000); // 未到期
    seed("dpj_c", 1, false); // 终态(无 dueShard)
    const s = await runPumpTick(1, deps());
    expect(s).toMatchObject({ ran: true, due: 1, posted: 1, failed: 0 });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(`http://self:3000${STEP_ENDPOINT_PATH}`);
    expect(posted[0].body).toEqual({ jobId: "dpj_a" });
    expect(posted[0].headers[INTERNAL_SOURCE_HEADER]).toBe(INTERNAL_SOURCE_DATAPLANE_JOB_PUMP);
    expect(posted[0].headers[INTERNAL_KEY_HEADER]).toBe("k-123");
  });

  it("🔴 不持租约 ⇒ 一次 Query 都不发(N 个副本不许一起敲)", async () => {
    seed("dpj_a", 1);
    const s = await runPumpTick(1, deps({ isLeader: () => false }));
    expect(s).toMatchObject({ ran: false, skipped: "not-leader" });
    expect(h.ddb.calls).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("🔴 停泵(=1)⇒ 不取不敲;其它值不算停泵", async () => {
    seed("dpj_a", 1);
    process.env.BGP_DATAPLANE_JOBS_PAUSED = "1";
    expect(await runPumpTick(1, deps())).toMatchObject({ ran: false, skipped: "paused" });
    expect(posted).toHaveLength(0);
    process.env.BGP_DATAPLANE_JOBS_PAUSED = "yes";
    expect(await runPumpTick(1, deps())).toMatchObject({ ran: true, posted: 1 });
  });

  it("读不到内部密钥 ⇒ 本轮不跑(不带空密钥去敲)", async () => {
    seed("dpj_a", 1);
    expect(await runPumpTick(1, deps({ loadKey: async () => "" }))).toMatchObject({ ran: false, skipped: "no-key" });
    expect(posted).toHaveLength(0);
  });

  it("每 SWEEP_EVERY_TICKS 轮补一次队;409(别人在推)不算失败,网络错误算失败", async () => {
    seed("dpj_a", 1);
    const s = await runPumpTick(SWEEP_EVERY_TICKS, deps());
    expect(s.swept).toBe(true);
    expect(posted.map((p) => p.url)).toContain(`http://self:3000${SWEEP_ENDPOINT_PATH}`);
    posted = [];
    const conflict = (async () => ({ ok: false, status: 409 }) as Response) as unknown as typeof fetch;
    expect(await runPumpTick(1, deps({ fetchImpl: conflict }))).toMatchObject({ posted: 1, failed: 0 });
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await runPumpTick(1, deps({ fetchImpl: boom }))).toMatchObject({ posted: 0, failed: 1 });
  });

  it("回环地址跟随 Next standalone 的监听规则(HOSTNAME),可被 BGP_SELF_BASE_URL 覆盖", () => {
    const save = { h: process.env.HOSTNAME, p: process.env.PORT, b: process.env.BGP_SELF_BASE_URL };
    try {
      delete process.env.BGP_SELF_BASE_URL;
      process.env.HOSTNAME = "ip-10-0-1-2.ec2.internal";
      process.env.PORT = "3000";
      expect(selfBaseUrl()).toBe("http://ip-10-0-1-2.ec2.internal:3000");
      process.env.HOSTNAME = "0.0.0.0";
      expect(selfBaseUrl()).toBe("http://127.0.0.1:3000");
      process.env.BGP_SELF_BASE_URL = "http://x:1/";
      expect(selfBaseUrl()).toBe("http://x:1");
    } finally {
      for (const [k, v] of [["HOSTNAME", save.h], ["PORT", save.p], ["BGP_SELF_BASE_URL", save.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
