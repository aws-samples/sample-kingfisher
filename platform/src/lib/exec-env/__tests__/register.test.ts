// §2.1 register 写通道单测(SPEC:153 / §1.1a)。
//
// 【本文件的三条承重】
// ① **服务端生成 targetId 且绝不 tgt_home**:客户端可指定 id ⇒ 可占用/可伪造 home 语义,
//    那是 P0-4 那类 fail-open 的温床;
// ② **不置 ready、不写 resources**:register 落的是"身份骨架",资源袋归部署回写(切片 e)——
//    半份描述符 + ready 位是 §20.11-N2 实测踩过的坑;
// ③ **条件写 attribute_not_exists(sk) + 撞 id 进位重试**:并发注册同 region 绝不覆盖已有 item。
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const putMock = vi.fn();
const queryMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: {
    send: (cmd: { __kind: string }) =>
      cmd.__kind === "get"
        ? getMock(cmd)
        : cmd.__kind === "put"
          ? putMock(cmd)
          : cmd.__kind === "update"
            ? updateMock(cmd)
            : queryMock(cmd),
  },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class {
    __kind = "get";
    constructor(public input: Record<string, unknown>) {}
  },
  PutCommand: class {
    __kind = "put";
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    __kind = "query";
    constructor(public input: Record<string, unknown>) {}
  },
  UpdateCommand: class {
    __kind = "update";
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { retireComponents, ComponentRetirementRefused, registerTarget, RegisterValidationError, RegisterNamespaceExhausted, RegionAlreadyHasEnvironmentError, TARGET_CELL_SPACE, regionAbbrev, listTargetsRaw } from "@/lib/exec-env/registry";
import { TARGET_ID_PATTERN } from "@/lib/exec-env/target-id";

const VALID = {
  region: "us-west-2",
  partition: "aws",
  accountId: "123456789012",
  jurisdiction: "home",
  // ②:注册必须带完整组件集(不提供精简形态)
  components: ["core", "redshift", "dms", "flink", "airflow-serverless"],
};

beforeEach(() => {
  vi.clearAllMocks();
  putMock.mockResolvedValue({});
  // register 现在要先读一遍全量描述符来分配 VPC 地址段
  //   (地址不重叠是**账号内全局**性质)⇒ 这个默认返回不给,所有用例都会死在 `reading 'Items'`。
  queryMock.mockResolvedValue({ Items: [] });
});

describe("regionAbbrev(确定性缩写:首段全取 + 中段首字母 + 尾数字)", () => {
  it.each([
    ["us-west-2", "usw2"],
    ["us-east-1", "use1"],
    ["ap-southeast-4", "aps4"],
    ["us-gov-west-1", "usgw1"],
    ["cn-north-1", "cnn1"],
  ])("%s → %s", (region, want) => {
    expect(regionAbbrev(region)).toBe(want);
  });
});

// ── 🔴🔴 2026-09-13:一个 region 只能有 3 个执行环境(真缺陷,当场挡住了造第 4 个夹具)──
// 病:生成循环写死 `MAX_TRIES = 3` ⇒ 只试 a/b/c;而拒因说「并发注册风暴,**请稍后重试**」——
// 那是**确定性耗尽**,重试永远不会成 ⇒ 运维会一直重试而不是去删一个不用的环境。
describe("🔴 targetId 命名空间必须给满 a..z,且耗尽要说人话", () => {
  /** 让前 n 个字母「已被占」:条件写抛 ConditionalCheckFailedException。 */
  function occupy(n: number) {
    let seen = 0;
    putMock.mockImplementation(async () => {
      if (seen++ < n) {
        const e = new Error("The conditional request failed") as Error & { name: string };
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      return {};
    });
  }

  it(`空间是 ${TARGET_CELL_SPACE} 个(不是 3)—— 前 25 个字母被占仍能注册到 z`, async () => {
    expect(TARGET_CELL_SPACE).toBe(26);
    occupy(25);
    const r = await registerTarget({ ...VALID, region: "us-east-1" } as never, "admin");
    // 🔴 断**具体那个 id**:只断「成功了」的话,把空间改回 3 也能靠 occupy(2) 通过
    expect(r.targetId, "第 26 个应该落在 z").toBe("tgt_use1_z");
    expect(putMock).toHaveBeenCalledTimes(26);
  });

  it("🔴 a..z 全占 ⇒ 抛 RegisterNamespaceExhausted,且**不许**说「稍后重试」", async () => {
    occupy(TARGET_CELL_SPACE);
    // 🔴 **只调一次**:occupy 的计数器是跨调用共享的,调第二次时前 26 个已经用光
    //    ⇒ 第二次压根不抛、msg 恒为空串 ⇒ 后面每条 `toContain` 都在断空串(它们会红,但红因是假的)。
    //    同族坑:mockImplementationOnce 被**别的**调用消耗掉,于是测试「因为错误的原因通过」。
    let err: unknown;
    try {
      await registerTarget({ ...VALID, region: "us-east-1" } as never, "admin");
    } catch (e) {
      err = e;
    }
    expect(err, "全空间被占却没抛").toBeInstanceOf(RegisterNamespaceExhausted);
    const msg = (err as Error).message;
    expect(msg).toContain("us-east-1");
    expect(msg).toContain("tgt_use1_a");
    expect(msg).toContain("tgt_use1_z");
    // 唯一的出路必须写出来
    expect(msg, "没告诉人该怎么办").toMatch(/删除/);
    // 🔴 负向:确定性耗尽绝不能引导去重试(原实现就是这么说的,害人一直重试)。
    //    只禁「稍后重试」这句引导 —— 「重试不会改变结果」是**故意**写的,它正是要打消重试念头。
    expect(msg, "🔴 确定性耗尽却引导人去重试").not.toContain("稍后重试");
    expect(msg, "该明说重试没用").toContain("重试不会改变结果");
  });

  it("空间没用满时不许抛耗尽错(否则第 2 个环境就注册不了)", async () => {
    occupy(1);
    const r = await registerTarget({ ...VALID, region: "us-east-1" } as never, "admin");
    expect(r.targetId).toBe("tgt_use1_b");
  });
});

describe("🔴 入参校验矩阵(每类非法各一条,全部 RegisterValidationError —— route 映射 400 而非 500)", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["region 非法", { ...VALID, region: "us-west" }, /region 非法/],
    ["partition 与 region 不一致", { ...VALID, partition: "aws-cn" }, /partition=.*与 region/],
    ["账号非 12 位", { ...VALID, accountId: "12345" }, /12 位数字/],
    ["components 空", { ...VALID, components: [] }, /非空数组/],
    ["缺 core", { ...VALID, components: ["redshift"] }, /必须含 core/],
    ["未知组件", { ...VALID, components: ["core", "corex"] }, /未知组件/],
    ["jurisdiction 非串", { ...VALID, jurisdiction: 42 }, /jurisdiction/],
    ["cellId 空串", { ...VALID, cellId: "" }, /cellId/],
    ["stage 空串", { ...VALID, stage: "" }, /stage/],
  ];
  for (const [label, input, re] of cases) {
    it(label, async () => {
      await expect(registerTarget(input as never, "admin")).rejects.toThrow(RegisterValidationError);
      await expect(registerTarget(input as never, "admin")).rejects.toThrow(re);
      expect(putMock, "校验失败绝不该发写请求").not.toHaveBeenCalled();
    });
  }

  it("actor 缺失也拒(审计要求 createdBy)", async () => {
    await expect(registerTarget(VALID as never, "")).rejects.toThrow(/actor/);
  });

  it("gov-cloud partition 交叉:us-gov-west-1 必须配 aws-us-gov", async () => {
    await expect(
      registerTarget({ ...VALID, region: "us-gov-west-1", partition: "aws" } as never, "admin")
    ).rejects.toThrow(/aws-us-gov/);
  });
});

describe("targetId 生成", () => {
  it("形如 tgt_usw2_a、匹配权威正则、绝不是 tgt_home", async () => {
    const r = await registerTarget(VALID as never, "admin");
    expect(r).toEqual({ targetId: "tgt_usw2_a", status: "registered" });
    expect(r.targetId).toMatch(new RegExp(TARGET_ID_PATTERN));
    expect(r.targetId).not.toBe("tgt_home");
  });

  it("🔴 撞 id(ConditionalCheckFailed)⇒ 换下一个字母重试,不覆盖已有 item", async () => {
    putMock
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockRejectedValueOnce({ name: "ConditionalCheckFailedException" })
      .mockResolvedValueOnce({});
    const r = await registerTarget(VALID as never, "admin");
    expect(r.targetId).toBe("tgt_usw2_c");
    expect(putMock).toHaveBeenCalledTimes(3);
    // 三次尝试的 id 依序 a → b → c
    const ids = putMock.mock.calls.map((c) => (c[0].input.Item as { sk: string }).sk);
    expect(ids).toEqual(["tgt_usw2_a", "tgt_usw2_b", "tgt_usw2_c"]);
  });

  // 🔴🔴 **这条判据自己曾经是缺陷的保镖**(2026-09-13 修):它原来写
  //    `rejects.toThrow(/重试 3 次仍撞/)` —— 把「一个 region 只能有 3 个执行环境」**当成正确行为钉住了**。
  //    于是那个上限连同「请稍后重试」这句错误引导,在门禁全绿的情况下活了下来。
  //    教训:判据钉的必须是**要保的性质**(撞了要进位、不无限重试、不被当 400),
  //    而不是**当时那个实现的具体数字**(见 [[stale-blockers-must-be-reprobed]] 的「写死个数是定时炸弹」)。
  it("全空间都撞 ⇒ 报错(不无限重试),且不是 RegisterValidationError(不该被当 400)", async () => {
    putMock.mockRejectedValue({ name: "ConditionalCheckFailedException" });
    const p = registerTarget(VALID as never, "admin");
    await expect(p).rejects.toBeInstanceOf(RegisterNamespaceExhausted);
    await expect(p).rejects.not.toBeInstanceOf(RegisterValidationError);
    // 「不无限重试」= 尝试次数恰好等于空间大小(既不少试、也不多试)
    expect(putMock.mock.calls.length / 1).toBe(TARGET_CELL_SPACE);
  });

  it("非撞 id 的写错误原样抛(不吞、不重试)", async () => {
    putMock.mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"));
    await expect(registerTarget(VALID as never, "admin")).rejects.toThrow(/ProvisionedThroughput/);
    expect(putMock).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 写入的 item 形状(与 SPEC §1.1 字段表逐项对)", () => {
  it("条件写 + 初始字段齐 + 刻意不写 ready/resources/isHome", async () => {
    await registerTarget({ ...VALID, cellId: "blue", stage: "prod" } as never, "alice");
    const { input } = putMock.mock.calls[0][0];
    expect(input.TableName).toBe("bgp-execution-envs");
    expect(input.ConditionExpression).toBe("attribute_not_exists(sk)");
    const item = input.Item as Record<string, unknown>;
    expect(item).toMatchObject({
      pk: "env",
      sk: "tgt_usw2_a",
      targetId: "tgt_usw2_a",
      partition: "aws",
      accountId: "123456789012",
      region: "us-west-2",
      jurisdiction: "home",
      status: "registered",
      components: ["core", "redshift", "dms", "flink", "airflow-serverless"],
      // 🔴 **本条原来断的是 `legacy-seeded` —— 那是把一处现网 fail-open 钉住了**。
      // §3.9b 权威合同:「仅部署迁移脚本显式登记的**存量 home** 可 `legacy-seeded`;
      // **新 target 从 `provisioning` 开始**」。差别是硬的:`legacy-seeded` 不要求 deadline
      // ⇒ 新建的非 home target 能**无限期**回落共享 admin secret,隔离永不收敛。
      credentialIsolationState: "provisioning",
      credentialEpoch: 0,
      version: 1,
      createdBy: "alice",
      cellId: "blue",
      stage: "prod",
    });
    // 🔴 负向:绝不允许回到 legacy-seeded 这个形态(它是上面那个 fail-open 的形状)
    expect(item.credentialIsolationState).not.toBe("legacy-seeded");
    // 🔴 deadline 必须真的可执行:可解析 + 在未来 + 不超过 30 天(§3.9b「deadline 必须可执行」)
    const dl = Date.parse(String(item.provisioningDeadlineAt));
    expect(Number.isFinite(dl), `provisioningDeadlineAt 不可解析:${String(item.provisioningDeadlineAt)}`).toBe(true);
    expect(dl).toBeGreaterThan(Date.now());
    expect(dl - Date.now()).toBeLessThanOrEqual(30 * 24 * 60 * 60_000);
    expect(typeof item.credentialStateUpdatedAt).toBe("string");
    // 🔴 三个"刻意不写"逐个断(写了任何一个都是把切片 e 的活抢来做半截)
    expect(item).not.toHaveProperty("ready");
    expect(item).not.toHaveProperty("resources");
    expect(item).not.toHaveProperty("isHome");
    expect(typeof item.updatedAt).toBe("string");
  });

  it("jurisdiction 缺省补 home;components 归一(去重 + 枚举序)", async () => {
    await registerTarget(
      {
        region: "us-west-2",
        partition: "aws",
        accountId: "123456789012",
        components: ["airflow-serverless", "redshift", "core", "core", "flink", "dms"],
      } as never,
      "admin"
    );
    const item = putMock.mock.calls[0][0].input.Item as Record<string, unknown>;
    expect(item.jurisdiction).toBe("home");
    expect(item.components).toEqual(["core", "redshift", "dms", "flink", "airflow-serverless"]);
  });
});

// ② —— 🔴🔴 不提供精简形态(用户 2026-10-10):注册的组件集必须逐项等于完整组件集
describe("🔴🔴 注册:组件集必须等于完整组件集(少一个 / 多一个都拒)", () => {
  const FULL_HOME = ["core", "redshift", "dms", "flink", "airflow-serverless"];
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["只装 core(精简形态)", { ...VALID, components: ["core"] }, /完整组件集.*缺 redshift, dms, flink, airflow-serverless/],
    ["少 airflow-serverless", { ...VALID, components: FULL_HOME.slice(0, 4) }, /缺 airflow-serverless/],
    ["多 kafka(未实现)", { ...VALID, components: [...FULL_HOME, "kafka"] }, /多出 kafka/],
    ["非主控区带 agentcore(只有一个 AgentCore)", { ...VALID, components: [...FULL_HOME, "agentcore"] }, /多出 agentcore/],
    ["同法域多带 residency-api", { ...VALID, components: [...FULL_HOME, "residency-api"] }, /多出 residency-api/],
  ];
  for (const [label, input, re] of cases) {
    it(label, async () => {
      await expect(registerTarget(input as never, "admin")).rejects.toThrow(re);
      expect(putMock).not.toHaveBeenCalled();
    });
  }
  it("跨法域:必须另带 residency-api;不带 ⇒ 拒", async () => {
    const { currentDisclaimerAck } = await import("@/lib/residency/disclaimer");
    const base = { ...VALID, jurisdiction: "eu-sim", residencyAck: currentDisclaimerAck() };
    await expect(registerTarget({ ...base, components: FULL_HOME } as never, "admin")).rejects.toThrow(/缺 residency-api/);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("listTargetsRaw(管理面口径)", () => {
  it("ConsistentRead + 不过滤坏 item(运维要看得到才修得了)", async () => {
    const badItem = { pk: "env", sk: "tgt_bad", targetId: "tgt_bad", status: "failed" }; // 缺一堆字段的坏 item
    queryMock.mockResolvedValueOnce({ Items: [badItem] });
    const out = await listTargetsRaw();
    expect(out).toEqual([badItem]);
    expect(queryMock.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });

  it("翻页翻到底(LastEvaluatedKey 续查)", async () => {
    queryMock
      .mockResolvedValueOnce({ Items: [{ sk: "tgt_a" }], LastEvaluatedKey: { pk: "env", sk: "tgt_a" } })
      .mockResolvedValueOnce({ Items: [{ sk: "tgt_b" }] });
    const out = await listTargetsRaw();
    expect(out.map((t) => (t as { sk?: string }).sk)).toEqual(["tgt_a", "tgt_b"]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ pk: "env", sk: "tgt_a" });
  });
});

// 🔴 VPC 地址段必须在**注册这一刻**落进描述符:broker 只读描述符,而 CDK 不给 ipAddresses 时
//    的默认段与主控区逐位相同 ⇒ 跨区 peering 建不出来(症状是栈全绿、台账回写静默超时)。
describe("🔴 register 分配 VPC 地址段", () => {
  const itemOf = () => putMock.mock.calls[0][0].input.Item as Record<string, unknown>;

  it("注册表空 ⇒ 池子第一个;字段真的写进 item", async () => {
    await registerTarget({ ...VALID, region: "us-east-1" } as never, "admin");
    expect(itemOf().vpcCidr, "🔴 断具体值:只断「有这个字段」的话,写死一个常量也能过").toBe("10.128.0.0/16");
  });

  it("避开已用段(含 home 这种压根没有该字段的 item)", async () => {
    queryMock.mockResolvedValue({
      Items: [
        { pk: "env", sk: "tgt_home", targetId: "tgt_home", isHome: true }, // 没有 vpcCidr
        { pk: "env", sk: "tgt_use1_a", targetId: "tgt_use1_a", vpcCidr: "10.128.0.0/16" },
        { pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", vpcCidr: "10.130.0.0/16" },
      ],
    });
    await registerTarget({ ...VALID, region: "eu-west-1" } as never, "admin");
    expect(itemOf().vpcCidr, "10.129 是最小空闲槽位(删掉环境后地址要能被回收)").toBe("10.129.0.0/16");
  });

  it("🔴 读全量描述符这一步不许省(不读就无从知道哪些段已被占)", async () => {
    await registerTarget({ ...VALID, region: "us-east-1" } as never, "admin");
    expect(queryMock, "register 必须先扫一遍注册表").toHaveBeenCalled();
    const q = queryMock.mock.calls[0][0].input as Record<string, unknown>;
    expect(q.ConsistentRead, "强一致读:刚注册的那个环境必须算在已用里").toBe(true);
  });
});

// 🔴🔴 用户 2026-09-15(第 N 次):「一个 region 只能有一个执行环境」。
//   这条约束今天**真的被违反了** —— 验收段的一条判据为了证明字母空间不是 3,在 us-west-2
//   注册了 `_b/_c/_d`,而**平台一个都没拦**,页面上出现 4 个。凡靠「记得别这么做」维持的约束
//   迟早被某条自动化路径踩穿(这已是第二次)⇒ 做成注册通道的硬拒。
describe("🔴🔴 一个 region 只允许一套执行环境(产品硬拒,不是纪律)", () => {
  const occupied = (status: string, region = "us-west-2", targetId = "tgt_usw2_a") =>
    queryMock.mockResolvedValue({ Items: [{ pk: "env", sk: targetId, targetId, region, status }] });

  it.each([["active"], ["registered"], ["failed"], ["initializing"], ["draining"]])(
    "同区已有一个 status=%s 的执行环境 ⇒ 拒(连「没建成」的也算占位:用户看到的就是「这个区有两个」)",
    async (st) => {
      occupied(st);
      let err: unknown;
      try {
        await registerTarget({ ...VALID, region: "us-west-2" } as never, "admin");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RegionAlreadyHasEnvironmentError);
      const msg = (err as Error).message;
      expect(msg).toContain("us-west-2");
      expect(msg, "必须点名占位者,否则运维不知道删哪个").toContain("tgt_usw2_a");
      expect(msg, "唯一出路要写出来").toMatch(/先把上面那个删掉/);
      expect(msg, "确定性冲突不许引导重试").not.toMatch(/稍后重试/);
      // 🔴 一个字节都不许写
      expect(putMock).not.toHaveBeenCalled();
    }
  );

  it("🔴 已删的不算占位(删掉之后同一个区要能再建 —— 否则一个区用一次就永久废了)", async () => {
    occupied("deleted");
    const r = await registerTarget({ ...VALID, region: "us-west-2" } as never, "admin");
    expect(r.targetId).toMatch(/^tgt_usw2_/);
    expect(putMock).toHaveBeenCalled();
  });

  it("🔴 别的区有环境不影响本区(守卫按 region 判,不是全局单例)", async () => {
    occupied("active", "us-east-1", "tgt_home");
    const r = await registerTarget({ ...VALID, region: "us-west-2" } as never, "admin");
    expect(r.targetId).toBe("tgt_usw2_a");
  });

  it("🔴 home 所在的区同样受约束(第二套要建到 us-east-1 也得先删 home —— 那正是上一次踩穿的形态)", async () => {
    occupied("active", "us-east-1", "tgt_home");
    await expect(registerTarget({ ...VALID, region: "us-east-1" } as never, "admin")).rejects.toBeInstanceOf(
      RegionAlreadyHasEnvironmentError
    );
  });
});

// ② —— 🔴🔴 摘组件不许把环境摘成精简形态(行为判据:真调 retireComponents)
describe("🔴🔴 摘组件:完整组件集里的一个都不许摘;要求集以外的存量组件(mwaa)照旧可摘", () => {
  const item = (components: string[]) => ({
    Item: {
      pk: "tgt_usw2_a",
      sk: "tgt_usw2_a",
      targetId: "tgt_usw2_a",
      region: "us-west-2",
      jurisdiction: "home",
      version: 7,
      components,
    },
  });
  const redProbe = (names: string[]) => ({
    targetId: "tgt_usw2_a",
    at: "2026-10-10T00:00:00.000Z",
    ok: false,
    items: names.map((n) => ({ name: n, ok: false, error: "gone" })),
  });
  it("摘 redshift ⇒ ComponentRetirementRefused(且一行都不写)", async () => {
    getMock.mockResolvedValueOnce(item(["core", "redshift", "dms", "flink", "airflow-serverless"]));
    await expect(
      retireComponents({ targetId: "tgt_usw2_a", components: ["redshift"], expectedVersion: 7, probe: redProbe(["redshift.workgroup"]) as never })
    ).rejects.toThrow(/属于该执行环境的完整组件集,不许摘/);
    expect(updateMock).not.toHaveBeenCalled();
  });
  it("跨法域摘 residency-api ⇒ 同样拒", async () => {
    getMock.mockResolvedValueOnce({ Item: { ...item(["core", "redshift", "dms", "flink", "residency-api", "airflow-serverless"]).Item, jurisdiction: "eu-sim" } });
    await expect(
      retireComponents({ targetId: "tgt_usw2_a", components: ["residency-api"], expectedVersion: 7, probe: redProbe(["residency-api.audit"]) as never })
    ).rejects.toThrow(/residency-api 属于该执行环境的完整组件集/);
  });
  it("反向控制:摘 mwaa(要求集以外)不被这条拦(后面的探活证明照旧要过)", async () => {
    getMock.mockResolvedValueOnce(item(["core", "redshift", "mwaa", "dms", "flink", "airflow-serverless"]));
    await expect(
      retireComponents({ targetId: "tgt_usw2_a", components: ["mwaa"], expectedVersion: 7, probe: redProbe(["x"]) as never })
    ).rejects.not.toThrow(/完整组件集/);
  });
});
