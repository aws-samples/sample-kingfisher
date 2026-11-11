// per-target 客户端与「禁 IAM fallback」的**可执行**门禁(50 SPEC §3.9a 第 8 步)。
//
// 🔴 本文件刻意打到**真的 SDK 入参**上,而不是断言源码里有 `SecretArn`:
// 现网 12 处的写法是 `...(SecretArn ? { SecretArn } : {})` —— 源码里"有 SecretArn 这个词",
// 但运行时解析不到就会**静默省掉它**、退回联邦身份。文本门禁看不出这个差别,入参断言看得出。
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: Array<Record<string, unknown>> = [];
let describeStatus = "FINISHED";
let describeError: string | undefined;

vi.mock("@aws-sdk/client-redshift-data", () => {
  class ExecuteStatementCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class DescribeStatementCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class RedshiftDataClient {
    constructor(public cfg: { region?: string }) {}
    async send(cmd: unknown) {
      if (cmd instanceof ExecuteStatementCommand) {
        sent.push({ kind: "exec", region: this.cfg.region, ...cmd.input });
        return { Id: `stmt-${sent.length}` };
      }
      return { Status: describeStatus, ...(describeError ? { Error: describeError } : {}), ResultRows: 3 };
    }
  }
  return { RedshiftDataClient, ExecuteStatementCommand, DescribeStatementCommand };
});

const smSent: Array<Record<string, unknown>> = [];
let describeSecretBehavior: () => unknown = () => ({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf" });
let createSecretBehavior: () => unknown = () => ({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:new-AbCdEf" });

vi.mock("@aws-sdk/client-secrets-manager", () => {
  class DescribeSecretCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class CreateSecretCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutSecretValueCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class SecretsManagerClient {
    constructor(public cfg: { region?: string }) {}
    async send(cmd: unknown) {
      if (cmd instanceof DescribeSecretCommand) {
        smSent.push({ kind: "describe", region: this.cfg.region, ...cmd.input });
        return describeSecretBehavior();
      }
      if (cmd instanceof CreateSecretCommand) {
        smSent.push({ kind: "create", region: this.cfg.region, ...cmd.input });
        return createSecretBehavior();
      }
      smSent.push({ kind: "put", region: this.cfg.region, ...(cmd as { input: object }).input });
      return {};
    }
  }
  return { SecretsManagerClient, DescribeSecretCommand, CreateSecretCommand, PutSecretValueCommand };
});

const {
  execOnTarget,
  resolveTargetWarehouse,
  resolveTargetGlue,
  resolveTargetEmr,
  redshiftDataClientFor,
  describeSecretArnByName,
  awaitSecretArnByName,
  putSecretJson,
  __resetTargetClients,
} = await import("@/lib/exec-env/target-clients");

const notFound = () => {
  const e = new Error("nf");
  e.name = "ResourceNotFoundException";
  throw e;
};
/** 前 n 次 Describe 回 ResourceNotFound(Secrets Manager 建后按名读的最终一致窗口),之后命中 */
const staleThenFound = (n: number, arn = "arn:aws:secretsmanager:us-east-1:1:secret:new-AbCdEf") => {
  let left = n;
  describeSecretBehavior = () => {
    if (left > 0) {
      left -= 1;
      notFound();
    }
    return { ARN: arn };
  };
};
const FAST = { intervalMs: 1 };

type Target = Parameters<typeof resolveTargetWarehouse>[0];
const HOME = { targetId: "tgt_home", region: "us-east-1" } as unknown as Target;
const USW2 = {
  targetId: "tgt_usw2_a",
  region: "us-west-2",
  resources: { redshiftWorkgroup: "bgp-workgroup-usw2a", redshiftDatabase: "dev" },
} as unknown as Target;

const WH = { targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "wg", database: "dev" };

beforeEach(() => {
  sent.length = 0;
  smSent.length = 0;
  describeStatus = "FINISHED";
  describeError = undefined;
  describeSecretBehavior = () => ({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf" });
  createSecretBehavior = () => ({ ARN: "arn:aws:secretsmanager:us-east-1:1:secret:new-AbCdEf" });
  __resetTargetClients();
});

describe("🔴 禁 IAM fallback:SecretArn 是必填,解析不到就拒", () => {
  it("正常路径:发出的 ExecuteStatement **一定**带 SecretArn(不是三元可省的)", async () => {
    const r = await execOnTarget({ warehouse: WH, sql: "CREATE SCHEMA x", secretArn: "arn:aws:sm:::s", pollIntervalMs: 1 });
    expect(r.affected).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].SecretArn, "入参里没有 SecretArn ⇒ 会退回联邦身份 = 属主分叉").toBe("arn:aws:sm:::s");
    expect(sent[0].WorkgroupName).toBe("wg");
    expect(sent[0].Database).toBe("dev");
  });

  it.each(["", "   ", "not-an-arn", "undefined"])(
    "SecretArn=%j ⇒ 抛,且**一条语句都不发**(不是发一条不带 SecretArn 的)",
    async (bad) => {
      await expect(
        execOnTarget({ warehouse: WH, sql: "CREATE SCHEMA x", secretArn: bad, pollIntervalMs: 1 })
      ).rejects.toThrow(/禁 IAM fallback|需要真实的 SecretArn/);
      expect(sent, "拒绝路径居然发出了请求").toHaveLength(0);
    }
  );

  it("客户端的 region 来自**落点**,不是 process.env(否则给非 home 建东西会静默打到 home)", async () => {
    await execOnTarget({ warehouse: WH, sql: "SELECT 1", secretArn: "arn:x", pollIntervalMs: 1 });
    expect(sent[0].region).toBe("us-west-2");
  });

  it("FAILED / ABORTED ⇒ 抛;不达终态 ⇒ 抛(绝不当成功)", async () => {
    describeStatus = "FAILED";
    describeError = "permission denied for schema proj_x";
    await expect(execOnTarget({ warehouse: WH, sql: "x", secretArn: "arn:x", pollIntervalMs: 1 })).rejects.toThrow(
      /permission denied/
    );
    describeStatus = "PICKED";
    describeError = undefined;
    await expect(
      execOnTarget({ warehouse: WH, sql: "x", secretArn: "arn:x", pollIntervalMs: 1, maxPolls: 2 })
    ).rejects.toThrow(/未达终态/);
  });

  it("非法 region ⇒ 建客户端就拒(不缓存出一个打错区的客户端)", () => {
    expect(() => redshiftDataClientFor("")).toThrow(/非法 region/);
    expect(() => redshiftDataClientFor("us-east")).toThrow(/非法 region/);
    // 同 region 复用同一个实例(缓存生效)
    expect(redshiftDataClientFor("us-east-1")).toBe(redshiftDataClientFor("us-east-1"));
    expect(redshiftDataClientFor("us-east-1")).not.toBe(redshiftDataClientFor("us-west-2"));
  });
});

describe("🔴 落点解析:home 逐字节等价 / 非 home 必须来自描述符,缺一即拒", () => {
  it("home ⇒ 走 warehouse-location(env → 命名 SSOT),值就是现网那两个", () => {
    const w = resolveTargetWarehouse(HOME);
    expect(w.workgroup).toBe("bgp-workgroup");
    expect(w.database).toBe("dev");
  });

  it("非 home ⇒ 取描述符 resources 袋 + 描述符 region", () => {
    const w = resolveTargetWarehouse(USW2);
    expect(w).toEqual({ targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "bgp-workgroup-usw2a", database: "dev" });
  });

  it("🔴 非 home 缺 workgroup / 缺 database / 缺 region ⇒ 各自抛(**没有** ?? home 兜底)", () => {
    const noWg = { targetId: "tgt_usw2_a", region: "us-west-2", resources: { redshiftDatabase: "dev" } } as unknown as Target;
    expect(() => resolveTargetWarehouse(noWg)).toThrow(/redshiftWorkgroup/);
    const noDb = {
      targetId: "tgt_usw2_a",
      region: "us-west-2",
      resources: { redshiftWorkgroup: "w" },
    } as unknown as Target;
    expect(() => resolveTargetWarehouse(noDb)).toThrow(/redshiftDatabase/);
    const noRegion = { targetId: "tgt_usw2_a", resources: { redshiftWorkgroup: "w", redshiftDatabase: "d" } } as unknown as Target;
    expect(() => resolveTargetWarehouse(noRegion)).toThrow(/没有 region/);
  });
});

describe("🔴 secret 读:只有 ResourceNotFound 才等于「没有」", () => {
  it("查到 ⇒ 回 ARN;而且 Describe 打的是**落点的 region**", async () => {
    const arn = await describeSecretArnByName("us-west-2", "bgp/project/usw2a/proj-x");
    expect(arn).toMatch(/^arn:aws:secretsmanager:/);
    expect(smSent[0]).toMatchObject({ kind: "describe", region: "us-west-2", SecretId: "bgp/project/usw2a/proj-x" });
  });

  it("ResourceNotFoundException ⇒ undefined(确认不存在)", async () => {
    describeSecretBehavior = () => {
      const e = new Error("nope");
      e.name = "ResourceNotFoundException";
      throw e;
    };
    await expect(describeSecretArnByName("us-east-1", "x")).resolves.toBeUndefined();
  });

  it.each(["AccessDeniedException", "ThrottlingException", "InternalServiceError"])(
    "🔴 %s ⇒ **抛**,绝不回 undefined(否则一次限流就把隔离撤掉、静默回落 admin)",
    async (name) => {
      describeSecretBehavior = () => {
        const e = new Error(name);
        e.name = name;
        throw e;
      };
      await expect(describeSecretArnByName("us-east-1", "x")).rejects.toThrow(name);
    }
  );

  it("describe 成功但没有 ARN ⇒ 抛(形态异常不许当成任何一种结论)", async () => {
    describeSecretBehavior = () => ({});
    await expect(describeSecretArnByName("us-east-1", "x")).rejects.toThrow(/没有 ARN/);
  });
});

describe("secret 写:幂等 + 一定拿到真 ARN + 返回即按名可读", () => {
  it("新建 ⇒ created=true,ARN 取自 CreateSecret 返回;返回前按名 Describe 一次确认已可读(写得进去 ≠ 读得到)", async () => {
    const r = await putSecretJson("us-west-2", "bgp/project/a/b", { username: "u", password: "p" });
    expect(r).toEqual({ arn: "arn:aws:secretsmanager:us-east-1:1:secret:new-AbCdEf", created: true });
    expect(smSent.map((s) => s.kind)).toEqual(["create", "describe"]);
    expect(smSent[1]).toMatchObject({ kind: "describe", region: "us-west-2", SecretId: "bgp/project/a/b" });
  });

  it("🔴 新建后按名读撞最终一致(前两次 ResourceNotFound)⇒ 等到可见再返回,不把传播窗口当失败", async () => {
    staleThenFound(2);
    const r = await putSecretJson("us-west-2", "bgp/project/a/b", { username: "u", password: "p" }, FAST);
    expect(r.created).toBe(true);
    expect(smSent.map((s) => s.kind)).toEqual(["create", "describe", "describe", "describe"]);
  });

  it("🔴 预算内按名始终查不到 ⇒ 抛「传播未完成」(不把半份 secret 当成功),Describe 次数 = 预算次数", async () => {
    describeSecretBehavior = notFound;
    await expect(putSecretJson("us-west-2", "bgp/project/a/b", { username: "u" }, { attempts: 3, intervalMs: 1 })).rejects.toThrow(/传播未完成/);
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(3);
  });

  it("新建后的确认读撞到**非** NotFound 的错误(限流 / AccessDenied)⇒ 立即抛原错,不重试、不吞", async () => {
    describeSecretBehavior = () => {
      const e = new Error("throttled");
      e.name = "ThrottlingException";
      throw e;
    };
    await expect(putSecretJson("us-west-2", "bgp/project/a/b", { username: "u" }, FAST)).rejects.toThrow(/throttled/);
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(1);
  });

  it("已存在 ⇒ PutSecretValue 覆盖 + DescribeSecret 换真 ARN,created=false", async () => {
    createSecretBehavior = () => {
      const e = new Error("exists");
      e.name = "ResourceExistsException";
      throw e;
    };
    const r = await putSecretJson("us-west-2", "bgp/project/a/b", { username: "u", password: "p" });
    expect(r.created).toBe(false);
    expect(smSent.map((s) => s.kind)).toEqual(["create", "put", "describe"]);
  });

  it("CreateSecret 没回 ARN ⇒ 抛(不许把「建了但拿不到 ARN」当成功)", async () => {
    createSecretBehavior = () => ({});
    await expect(putSecretJson("us-east-1", "n", {})).rejects.toThrow(/没有返回 ARN/);
  });
});

describe("🔴 写后按名读 awaitSecretArnByName:只在刚写过的路径上用,查不到 = 还没传播到", () => {
  it("立即可见 ⇒ 一次 Describe 就回 ARN", async () => {
    expect(await awaitSecretArnByName("us-west-2", "n", FAST)).toBe("arn:aws:secretsmanager:us-east-1:1:secret:x-AbCdEf");
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(1);
  });

  it("前 3 次 NotFound、第 4 次命中 ⇒ 回 ARN,Describe 恰 4 次", async () => {
    staleThenFound(3, "arn:aws:secretsmanager:us-west-2:1:secret:late-AbCdEf");
    expect(await awaitSecretArnByName("us-west-2", "n", { attempts: 5, intervalMs: 1 })).toBe("arn:aws:secretsmanager:us-west-2:1:secret:late-AbCdEf");
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(4);
  });

  it("预算用尽仍 NotFound ⇒ undefined(由调用方拒),Describe 次数 = attempts;attempts 下限 1", async () => {
    describeSecretBehavior = notFound;
    expect(await awaitSecretArnByName("us-west-2", "n", { attempts: 4, intervalMs: 1 })).toBeUndefined();
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(4);
    smSent.length = 0;
    expect(await awaitSecretArnByName("us-west-2", "n", { attempts: 0, intervalMs: 1 })).toBeUndefined();
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(1);
  });

  it("非 NotFound 的错误 ⇒ 立即抛(与 describeSecretArnByName 同一条方向:查失败 ≠ 没有)", async () => {
    describeSecretBehavior = () => {
      const e = new Error("denied");
      e.name = "AccessDeniedException";
      throw e;
    };
    await expect(awaitSecretArnByName("us-west-2", "n", FAST)).rejects.toThrow(/denied/);
    expect(smSent.filter((s) => s.kind === "describe")).toHaveLength(1);
  });
});

// 执行角色键规则 ①(SPEC v3.21 §3.1a / §6.1 段二)
describe("🔴 Spark / EMR 落点:非 home 的执行角色必须是**本 target 自己的**(共享角色只剩 home)", () => {
  const ACCT = "123456789012";
  const base = {
    targetId: "tgt_usw2_a",
    region: "us-west-2",
    resources: {
      scriptsBucket: `bgp-glue-scripts-${ACCT}-tgt-usw2-a`,
      datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`,
      tableBucket: "bgp-table-bucket-tgt-usw2-a",
    },
  };
  const withRes = (extra: Record<string, unknown>) => ({ ...base, resources: { ...base.resources, ...extra } }) as unknown as Target;

  it("glueRoleArn = 本 target 名 ⇒ 解析成功且 roleArn 就是它", () => {
    const g = resolveTargetGlue(withRes({ glueRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-glue-role` }));
    expect(g.roleArn).toBe(`arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-glue-role`);
    expect(g.home).toBe(false);
  });
  it("🔴 glueRoleArn 是 home 的 bgp-glue-role(存量)⇒ 抛,拒因指路「重新部署」,**不回落**", () => {
    const t = withRes({ glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role` });
    expect(() => resolveTargetGlue(t)).toThrow(/不是本 target 的 per-target 角色/);
    expect(() => resolveTargetGlue(t)).toThrow(/重新部署/);
  });
  it("🔴 glueRoleArn 缺 ⇒ 抛(缺 resources.glueRoleArn),不猜", () => {
    expect(() => resolveTargetGlue(withRes({}))).toThrow(/缺 resources\.glueRoleArn/);
  });
  it("resolveTargetEmr:home ⇒ 走 env(逐字节等价);非 home ⇒ 描述符里本 target 的 emrExecutionRoleArn", () => {
    const prev = process.env.EMR_EXECUTION_ROLE_ARN;
    process.env.EMR_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/bgp-emr-serverless-role";
    try {
      expect(resolveTargetEmr(HOME)).toEqual({ targetId: "tgt_home", executionRoleArn: "arn:aws:iam::123456789012:role/bgp-emr-serverless-role", home: true });
      delete process.env.EMR_EXECUTION_ROLE_ARN;
      expect(resolveTargetEmr(HOME).executionRoleArn).toBe(""); // 未配 ⇒ 空串,由调用方报「未配置」(与改动前一致)
    } finally {
      if (prev === undefined) delete process.env.EMR_EXECUTION_ROLE_ARN;
      else process.env.EMR_EXECUTION_ROLE_ARN = prev;
    }
    const per = `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-emr-role`;
    expect(resolveTargetEmr(withRes({ emrExecutionRoleArn: per })).executionRoleArn).toBe(per);
  });
  it("🔴 resolveTargetEmr 非 home:缺键 / home 名 / 别 target 名 ⇒ 各自抛(**没有** ?? home 兜底)", () => {
    expect(() => resolveTargetEmr(withRes({}))).toThrow(/缺 resources\.emrExecutionRoleArn/);
    expect(() => resolveTargetEmr(withRes({ emrExecutionRoleArn: `arn:aws:iam::${ACCT}:role/bgp-emr-serverless-role` }))).toThrow(/不是本 target 的 per-target 角色/);
    expect(() => resolveTargetEmr(withRes({ emrExecutionRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-euw1-b-emr-role` }))).toThrow(/不是本 target 的 per-target 角色/);
  });
});
