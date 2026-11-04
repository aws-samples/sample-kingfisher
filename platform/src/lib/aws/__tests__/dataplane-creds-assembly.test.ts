// @kf-batch 50-WP31-seq5-dataplane-role
// WP-31 序 5 第一刀 —— 数据面凭证三态的**装配层**判据(真 SDK 客户端 + 假 HTTP 处理器,永不出网)。
// 判的是「这次请求**真正用哪把钥匙签的**」(Authorization 头里的 Credential=AKID),不是某个配置字段:
//   taskrole ⇒ 任务角色的钥匙;enforce ⇒ 只用数据面角色的钥匙;observe ⇒ 角色先签,IAM 拒才用任务角色重发并记账。
// 只 mock 真外部(STS);区 → 角色由注入点给(注册表是 DDB);兄弟模块(clients / dataplane-creds / naming)全真。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";

const assumeCalls: Array<{ RoleArn: string; RoleSessionName: string }> = [];
vi.mock("@aws-sdk/client-sts", () => {
  class AssumeRoleCommand { constructor(public input: { RoleArn: string; RoleSessionName: string }) {} }
  class GetCallerIdentityCommand { constructor(public input: unknown) {} }
  class STSClient {
    constructor(public cfg: unknown) {}
    async send(c: { input: { RoleArn: string; RoleSessionName: string } }) {
      if (c instanceof GetCallerIdentityCommand) return { Account: "000000000000" };
      assumeCalls.push({ RoleArn: c.input.RoleArn, RoleSessionName: c.input.RoleSessionName });
      return { Credentials: { AccessKeyId: "ASIAROLE" + assumeCalls.length, SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 3600_000) } };
    }
  }
  return { STSClient, AssumeRoleCommand, GetCallerIdentityCommand };
});

import { sdkClient, regionalClient, __resetClients } from "../clients";
import { __setDataPlaneCredsTestHooks, pickDataPlaneRole, dataPlaneCredsMode, isIamDenied, isIdentitySensitive } from "../dataplane-creds";

type Seen = { akid: string; host: string };
/** 假 HTTP 处理器:记下签名用的 AKID;`deny(akid)` 为真 ⇒ 回 S3 风格 403 AccessDenied。 */
function handler(seen: Seen[], deny: (akid: string) => boolean) {
  return {
    handle: async (req: { headers: Record<string, string>; hostname: string }) => {
      const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
      const akid = /Credential=([A-Z0-9]+)\//.exec(auth)?.[1] ?? "?";
      seen.push({ akid, host: req.hostname });
      const { HttpResponse } = await import("@smithy/protocol-http");
      const { Readable } = await import("stream");
      if (deny(akid)) {
        const body = `<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>User: arn:aws:sts::000000000000:assumed-role/BgpExecEnv-tgt-usw2-a-platform-data-role/x is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::bgp-x"</Message></Error>`;
        return { response: new HttpResponse({ statusCode: 403, headers: { "content-type": "application/xml" }, body: Readable.from([body]) }) };
      }
      const body = `<?xml version="1.0"?><ListBucketResult><Name>bgp-x</Name><KeyCount>0</KeyCount></ListBucketResult>`;
      return { response: new HttpResponse({ statusCode: 200, headers: { "content-type": "application/xml" }, body: Readable.from([body]) }) };
    },
  };
}

const lines: Array<Record<string, unknown>> = [];
const ROLE = { targetId: "tgt_usw2_a", roleArn: "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-usw2-a-platform-data-role" };

// 🔴 shell 里的 AWS_PROFILE 会让 SDK 跳过环境变量凭证、去读本机 ~/.aws(本机陷阱)⇒ 测试期间摘掉
const savedProfile = process.env.AWS_PROFILE;
beforeEach(() => {
  delete process.env.AWS_PROFILE;
  process.env.AWS_ACCESS_KEY_ID = "AKIATASKROLE";
  process.env.AWS_SECRET_ACCESS_KEY = "x";
  process.env.AWS_REGION = "us-east-1";
  assumeCalls.length = 0;
  lines.length = 0;
  __resetClients();
  __setDataPlaneCredsTestHooks({ resolver: async (region) => (region === "us-west-2" ? ROLE : Promise.reject(Object.assign(new Error(`区 ${region} 取不到`), { name: "DataPlaneRoleUnresolved" }))), sink: (l) => lines.push(l) });
});
afterEach(() => {
  delete process.env.BGP_DATAPLANE_CREDS;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  __setDataPlaneCredsTestHooks(null);
  if (savedProfile !== undefined) process.env.AWS_PROFILE = savedProfile;
});

const list = () => new ListObjectsV2Command({ Bucket: "bgp-x" });

describe("序 5 数据面凭证三态(按签名用的钥匙判)", () => {
  it("开关只认 observe / enforce 两个字面值;其余(含拼错、空)一律 taskrole", () => {
    for (const [v, want] of [["observe", "observe"], ["enforce", "enforce"], ["Enforce", "taskrole"], ["", "taskrole"], [undefined, "taskrole"], ["on", "taskrole"]] as const) {
      if (v === undefined) delete process.env.BGP_DATAPLANE_CREDS;
      else process.env.BGP_DATAPLANE_CREDS = v;
      expect(dataPlaneCredsMode(), String(v)).toBe(want);
    }
  });

  it("taskrole(现状):数据面客户端用任务角色签名,一次 AssumeRole 都不发", async () => {
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, () => false) });
    await c.send(list());
    expect(seen.map((s) => s.akid)).toEqual(["AKIATASKROLE"]);
    expect(assumeCalls).toEqual([]);
  });

  it("🔴 enforce:只用该区平台数据面角色签名(RoleArn 来自命名真源);被拒就是拒,不回落任务角色", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, (k) => k.startsWith("ASIA")) });
    const err = await c.send(list()).then(() => null, (e) => e);
    expect(err?.name).toBe("AccessDenied");
    expect(seen.map((s) => s.akid)).toEqual(["ASIAROLE1"]);
    expect(assumeCalls).toEqual([{ RoleArn: ROLE.roleArn, RoleSessionName: "bgp-platform-tgt_usw2_a" }]);
  });

  it("🔴 observe:角色先签;IAM 拒 ⇒ 记 place.creds.denied(带 AWS 原话)再用任务角色重发,调用方拿到成功结果", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, (k) => k.startsWith("ASIA")) });
    const out = await c.send(list());
    expect(out.Name).toBe("bgp-x");
    expect(seen.map((s) => s.akid)).toEqual(["ASIAROLE1", "AKIATASKROLE"]);
    const d = lines.filter((l) => l.event === "place.creds.denied");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ region: "us-west-2", targetId: "tgt_usw2_a", operation: "ListObjectsV2", DataPlaneRoleGap: 1 });
    expect(String(d[0].detail)).toContain("s3:ListBucket");
  });

  it("🔴 B-47 记账的 operation 来自 SDK 操作模式而不是类名(Next 产物里类名被压成单字母)", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const X = class extends ListObjectsV2Command {};
    expect(X.name).not.toBe("ListObjectsV2Command");
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler([], (k) => k.startsWith("ASIA")) });
    await c.send(new X({ Bucket: "bgp-x" }));
    expect(lines.filter((l) => l.event === "place.creds.denied").map((l) => l.operation)).toEqual(["ListObjectsV2"]);
  });

  it("🔴 B-49 observe:带要交给服务的角色 ARN(PassRole)⇒ 不试数据面角色、直接任务角色并记 identity-sensitive —— DMS 对 PassRole 不足回的是 InvalidParameterValue 而不是 AccessDenied", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const { DatabaseMigrationServiceClient, CreateEndpointCommand } = await import("@aws-sdk/client-database-migration-service");
    const seen: Seen[] = [];
    const { HttpResponse } = await import("@smithy/protocol-http");
    const { Readable } = await import("stream");
    const requestHandler = {
      handle: async (req: { headers: Record<string, string>; hostname: string }) => {
        const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
        const akid = /Credential=([A-Z0-9]+)\//.exec(auth)?.[1] ?? "?";
        seen.push({ akid, host: req.hostname });
        const j = (o: unknown, code: number) => ({ response: new HttpResponse({ statusCode: code, headers: { "content-type": "application/x-amz-json-1.1" }, body: Readable.from([JSON.stringify(o)]) }) });
        return akid.startsWith("ASIA")
          ? j({ __type: "InvalidParameterValueException", message: "SecretsManagerSecretId is invalid." }, 400)
          : j({ Endpoint: { EndpointArn: "arn:aws:dms:us-west-2:000000000000:endpoint:X" } }, 200);
      },
    };
    const c = sdkClient("data-plane", DatabaseMigrationServiceClient, { region: "us-west-2", requestHandler });
    const out = await c.send(new CreateEndpointCommand({
      EndpointIdentifier: "bgp-tgt-x", EndpointType: "target", EngineName: "redshift",
      RedshiftSettings: { SecretsManagerSecretId: "arn:aws:secretsmanager:us-west-2:000000000000:secret:s", SecretsManagerAccessRoleArn: "arn:aws:iam::000000000000:role/bgp-dms-role" },
    }));
    expect(out.Endpoint?.EndpointArn).toContain("endpoint:X");
    expect(seen.map((x) => x.akid)).toEqual(["AKIATASKROLE"]);
    expect(lines.filter((l) => l.event === "place.creds.identity-sensitive").map((l) => l.operation)).toEqual(["CreateEndpoint"]);
  });

  it("observe:角色放行 ⇒ 只发一次、不记账(没有缺口就没有噪音)", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, () => false) });
    await c.send(list());
    expect(seen.map((s) => s.akid)).toEqual(["ASIAROLE1"]);
    expect(lines.filter((l) => String(l.event).startsWith("place.creds."))).toEqual([]);
  });

  it("observe:该区没有执行环境(取不到角色)⇒ 记 place.creds.unavailable 并用任务角色;不是静默", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "eu-west-1", requestHandler: handler(seen, () => false) });
    await c.send(list());
    expect(seen.map((s) => s.akid)).toEqual(["AKIATASKROLE"]);
    expect(lines.map((l) => l.event)).toEqual(["place.creds.unavailable"]);
  });

  it("observe:非 IAM 拒绝的错误原样抛(业务错误不许被重发一遍)", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const seen: Seen[] = [];
    const h = { handle: async (req: { headers: Record<string, string>; hostname: string }) => {
      seen.push({ akid: "?", host: req.hostname });
      const { HttpResponse } = await import("@smithy/protocol-http");
      const { Readable } = await import("stream");
      return { response: new HttpResponse({ statusCode: 404, headers: { "content-type": "application/xml" }, body: Readable.from([`<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>no</Message></Error>`]) }) };
    } };
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: h });
    const err = await c.send(list()).then(() => null, (e) => e);
    expect(err?.name).toBe("NoSuchBucket");
    expect(seen).toHaveLength(1);
  });

  it("🔴 observe:身份敏感(Athena 查询异步用调用者身份读数据)⇒ 不试角色、直接任务角色并记 identity-sensitive", async () => {
    process.env.BGP_DATAPLANE_CREDS = "observe";
    const seen: Seen[] = [];
    const h = { handle: async (req: { headers: Record<string, string>; hostname: string }) => {
      const akid = /Credential=([A-Z0-9]+)\//.exec(req.headers.authorization ?? "")?.[1] ?? "?";
      seen.push({ akid, host: req.hostname });
      const { HttpResponse } = await import("@smithy/protocol-http");
      const { Readable } = await import("stream");
      return { response: new HttpResponse({ statusCode: 200, headers: { "content-type": "application/x-amz-json-1.1" }, body: Readable.from([JSON.stringify({ QueryExecutionId: "q1" })]) }) };
    } };
    const c = sdkClient("data-plane", AthenaClient, { region: "us-west-2", requestHandler: h });
    await c.send(new StartQueryExecutionCommand({ QueryString: "select 1" }));
    expect(seen.map((s) => s.akid)).toEqual(["AKIATASKROLE"]);
    expect(lines.map((l) => l.event)).toEqual(["place.creds.identity-sensitive"]);
  });

  it("工厂 regionalClient 同样经唯一作者注入(enforce 下签名钥匙 = 角色)", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    const c = await regionalClient("s3", "us-west-2");
    const creds = await (c.config.credentials as () => Promise<{ accessKeyId: string }>)();
    expect(creds.accessKeyId).toBe("ASIAROLE1");
  });

  it("控制面客户端永不代入(主控区平台表 / 身份不归任何 target)", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    const seen: Seen[] = [];
    const c = sdkClient("control-plane", S3Client, { region: "us-east-1", requestHandler: handler(seen, () => false) });
    await c.send(list());
    expect(seen.map((s) => s.akid)).toEqual(["AKIATASKROLE"]);
    expect(assumeCalls).toEqual([]);
  });

  it("调用方显式给了 credentials(数据源自带凭证)⇒ 尊重它,不覆盖", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", credentials: { accessKeyId: "AKIAOWNER", secretAccessKey: "x" }, requestHandler: handler(seen, () => false) });
    await c.send(list());
    expect(seen.map((s) => s.akid)).toEqual(["AKIAOWNER"]);
  });

  it("并发同区只代入一次;凭证按角色缓存", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    const seen: Seen[] = [];
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, () => false) });
    await Promise.all([c.send(list()), c.send(list()), c.send(list())]);
    expect(assumeCalls).toHaveLength(1);
    expect(new Set(seen.map((s) => s.akid))).toEqual(new Set(["ASIAROLE1"]));
  });
});

describe("删了重注册(同区新 targetId)", () => {
  it("🔴 角色解析过期后换成新角色 ⇒ 重新代入;旧角色的凭证即使没过期也不再用", async () => {
    process.env.BGP_DATAPLANE_CREDS = "enforce";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let cur = { targetId: "tgt_use1_a", roleArn: "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-a-platform-data-role" };
      __setDataPlaneCredsTestHooks({ resolver: async () => cur, sink: (l) => lines.push(l) });
      const seen: Seen[] = [];
      const c = sdkClient("data-plane", S3Client, { region: "us-west-2", requestHandler: handler(seen, () => false) });
      await c.send(list());
      cur = { targetId: "tgt_use1_b", roleArn: "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-b-platform-data-role" };
      vi.setSystemTime(Date.now() + 6 * 60_000); // 角色解析缓存 5 分钟过期;凭证(1h)仍有效
      await c.send(list());
      expect(assumeCalls.map((a) => a.RoleArn)).toEqual([
        "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-a-platform-data-role",
        "arn:aws:iam::000000000000:role/BgpExecEnv-tgt-use1-b-platform-data-role",
      ]);
      expect(seen.map((s) => s.akid)).toEqual(["ASIAROLE1", "ASIAROLE2"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("区 → 角色(一区一套)", () => {
  const ctx = { accountId: "000000000000", partition: "aws" };
  it("主控区 / 非主控区的角色名都出自命名真源", () => {
    expect(pickDataPlaneRole("us-east-1", [{ targetId: "tgt_home", region: "us-east-1", status: "active" }], ctx).roleArn).toBe("arn:aws:iam::000000000000:role/bgp-platform-data-role");
    expect(pickDataPlaneRole("us-west-2", [{ targetId: "tgt_usw2_a", region: "us-west-2", status: "active" }], ctx).roleArn).toBe(ROLE.roleArn);
  });
  it("已删除的不算;删了重注册的那个才是", () => {
    const rows = [{ targetId: "tgt_use1_a", region: "us-east-1", status: "deleted" }, { targetId: "tgt_use1_b", region: "us-east-1", status: "active" }];
    expect(pickDataPlaneRole("us-east-1", rows, ctx).targetId).toBe("tgt_use1_b");
  });
  it("0 个 / 2 个 ⇒ 抛(不猜)", () => {
    expect(() => pickDataPlaneRole("eu-west-1", [], ctx)).toThrow(/没有执行环境/);
    expect(() => pickDataPlaneRole("us-west-2", [{ targetId: "tgt_usw2_a", region: "us-west-2", status: "active" }, { targetId: "tgt_usw2_b", region: "us-west-2", status: "initializing" }], ctx)).toThrow(/一区一套/);
  });
});

describe("分类器", () => {
  it("IAM 拒绝的几种形态都认;业务错误不认", () => {
    expect(isIamDenied({ name: "AccessDeniedException" })).toBe(true);
    expect(isIamDenied({ name: "UnauthorizedOperation" })).toBe(true);
    expect(isIamDenied({ name: "X", $metadata: { httpStatusCode: 403 }, message: "User is not authorized to perform" })).toBe(true);
    expect(isIamDenied({ name: "ValidationException", $metadata: { httpStatusCode: 400 } })).toBe(false);
    expect(isIamDenied({ name: "X", $metadata: { httpStatusCode: 403 }, message: "Request has expired" })).toBe(false);
  });
  it("身份敏感:Athena 查询 / 不带 SecretArn 与 DbUser 的 Redshift Data 语句", () => {
    expect(isIdentitySensitive({ QueryString: "select 1" })).toBe(true);
    expect(isIdentitySensitive({ Sql: "select 1", WorkgroupName: "w" })).toBe(true);
    expect(isIdentitySensitive({ Sqls: ["a"], WorkgroupName: "w" })).toBe(true);
    expect(isIdentitySensitive({ Sql: "select 1", WorkgroupName: "w", SecretArn: "arn:x" })).toBe(false);
    expect(isIdentitySensitive({ Bucket: "b" })).toBe(false);
    // B-49:深层带角色 ARN ⇒ 身份敏感;别的 ARN(secret / bucket)不算
    expect(isIdentitySensitive({ RedshiftSettings: { SecretsManagerAccessRoleArn: "arn:aws:iam::000000000000:role/r" } })).toBe(true);
    expect(isIdentitySensitive({ jobDriver: {}, executionRoleArn: "arn:aws-cn:iam::000000000000:role/r" })).toBe(true);
    expect(isIdentitySensitive({ SecretId: "arn:aws:secretsmanager:us-east-1:000000000000:secret:s", Bucket: "arn:aws:s3:::b" })).toBe(false);
  });
});
