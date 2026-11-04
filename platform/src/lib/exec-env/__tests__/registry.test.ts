// @kf-batch 50-G7-P0P1P2
// G1/G7(模块 50)—— 执行目标注册表读侧单测。
//
// 【为什么必须有这个测试】外部审核 P0-4 抓到设计稿里那行 `registry.getTarget(id) ?? homeTarget`
// 是整份设计最危险的一行:**unknown / 已删 / 未 ready 的 target 被当成 home** ⇒ 跨法域守卫下一步的
// `jurisdiction === "home"` 成立 → 直接放行 ⇒ **A 区任务被静默打到 home 数据面 = 数据出境**。
// 这类缺陷不会报错、不会有日志异常,只会"看起来正常地跑错地方"。
//
// 🔴 **v3.4 新增的三组(外部审核 v2 P0-1 / P1-1 / P1-4)**,每组都是针对我自己上一轮的失误:
//   ① 「状态在缓存底下变了」—— 上一轮我把 `__resetRegistryCache()` 写在每次改状态**之前**,
//      恰好抹掉了 bug 需要的条件,还写了一条「同槽重复取只解析一次」把 bug 断言成正确行为。
//      现在反过来钉:**改状态后不清任何东西,必须立刻拒**。
//   ② 「强一致读」—— 上一轮我只 grep 到 env 名就当它被注入(单边核验)。现在**断真实入参**
//      (`ConsistentRead === true`),而不是断"没报错"。
//   ③ 「读路径不许写库」—— 断 `putMock` **一次都没被调用**。
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock DDB(照 query-handle.test.ts 的 __kind 分派写法)──
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

import {
  getTarget,
  getTargetRaw,
  requireReadyTarget,
  getHomeTarget,
  seedHomeTarget,
  reconcileTarget,
  listActiveTargets,
  listTargetsByRegion,
  descriptorViolation,
  descriptorAgeMs,
  TargetNotReadyError,
  TARGET_FRESHNESS_MAX_AGE_MS,
  TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS,
  REQUIRED_CORE_RESOURCES,
  RECONCILE_ALLOWED_FIELDS,
  descriptorSeedViolation,
  advanceCredentialIsolationState,
  CredentialTransitionRejected,
} from "@/lib/exec-env/registry";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

/** 12 位账号号:**不写字面量** —— 红线扫描会把任何 12 位连续数字当成真账号号拦下(它不区分真假,这样才不漏真的)。 */
const ACCOUNT = "0".repeat(12);
const OTHER_ACCOUNT = "9".repeat(12);

// 🔴 用**真实形态**的资源值:G8 起 `descriptorViolation` 会逐项校验形态
// (子网 `subnet-<8..17 hex>`、SG `sg-<8..17 hex>`、桶名 S3 规则、必须是 ARN 的键强制 ARN)。
// 上一版 fixture 用的是 `sg-1` / `subnet-aaa` 这种"看起来像"的值 —— 那正是外部审核 v3 P1-2
// 抓到的同一类问题:**我自己的样本比产品还宽松**,于是校验写松了也测不出来。
function coreResources(over: Record<string, unknown> = {}) {
  return {
    datalakeBucket: `bgp-datalake-${ACCOUNT}`,
    scriptsBucket: `bgp-glue-scripts-${ACCOUNT}`,
    tableBucket: "bgp-tables",
    athenaWorkgroup: "bgp-wg",
    glueRoleArn: `arn:aws:iam::${ACCOUNT}:role/bgp-glue-role`,
    emrSecurityGroupId: "sg-0123456789abcdef0",
    emrSubnetIds: ["subnet-0123456789abcdef0", "subnet-abcdef0123456789"],
    ...over,
  };
}

/** 合法描述符工厂。默认**新鲜**(updatedAt=现在),让"新鲜度"成为需要显式制造的条件,而不是默认条件。 */
function target(over: Record<string, unknown> = {}) {
  return {
    pk: "env",
    sk: "tgt_usw2_a",
    targetId: "tgt_usw2_a",
    partition: "aws",
    accountId: ACCOUNT,
    region: "us-west-2",
    status: "active",
    ready: true,
    components: ["core"],
    resources: coreResources(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/** home 版本的合法描述符。 */
function homeTarget(over: Record<string, unknown> = {}) {
  return target({
    sk: HOME_TARGET_ID,
    targetId: HOME_TARGET_ID,
    isHome: true,
    jurisdiction: "home",
    region: "us-east-1",
    ...over,
  });
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getMock.mockResolvedValue({ Item: undefined });
  putMock.mockResolvedValue({});
  updateMock.mockResolvedValue({});
  queryMock.mockResolvedValue({ Items: [] });
});

describe("getTarget —— fail-closed:每一条 unusable 都必须拿不到 target", () => {
  it("描述符不存在 → null(**不是** home)", async () => {
    getMock.mockResolvedValue({ Item: undefined });
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
  });

  it("ready 未置位(描述符还没整包写完)→ null", async () => {
    getMock.mockResolvedValue({ Item: target({ ready: false }) });
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
    getMock.mockResolvedValue({ Item: target({ ready: undefined }) });
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
  });

  it("🔴 draining/decommissioning/failed 等状态一律 null —— 尤其 draining(删除 TOCTOU 防护:不许再进新 run)", async () => {
    for (const status of [
      "registered",
      "initializing",
      "testing",
      "failed",
      "upgrading",
      "draining",
      "decommissioning",
      "deleted",
    ]) {
      getMock.mockResolvedValue({ Item: target({ status }) });
      await expect(getTarget("tgt_usw2_a"), `status=${status} 不该可用`).resolves.toBeNull();
    }
  });

  it("active / degraded 可用(degraded 也放行:一次探活抖动不该停掉整个区域)", async () => {
    for (const status of ["active", "degraded"]) {
      getMock.mockResolvedValue({ Item: target({ status }) });
      const t = await getTarget("tgt_usw2_a");
      expect(t?.status, `status=${status} 应可用`).toBe(status);
    }
  });

  it("格式非法 → null,且**根本不打库**(免乱传 targetId 打爆 DDB)", async () => {
    for (const bad of ["tgt_BAD", "usw2", "tgt_a#b", "", "tgt_a_"]) {
      await expect(getTarget(bad)).resolves.toBeNull();
    }
    expect(getMock).not.toHaveBeenCalled();
  });

  it("🔴 未知 targetId 绝不返回 home 的描述符(P0-4 那行的反测)", async () => {
    // 库里只有 home;查一个不存在的 target。
    getMock.mockImplementation((cmd: { input: { Key: { sk: string } } }) =>
      Promise.resolve({ Item: cmd.input.Key.sk === HOME_TARGET_ID ? homeTarget() : undefined })
    );
    await expect(getTarget("tgt_eu1")).resolves.toBeNull();
  });
});

describe("requireReadyTarget —— 抛错且要说清为什么", () => {
  it("不存在 → TargetNotReadyError,原因提到未注册/已删除", async () => {
    getMock.mockResolvedValue({ Item: undefined });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(TargetNotReadyError);
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/未注册|已删除/);
  });

  it("未 ready → 原因提到 ready", async () => {
    getMock.mockResolvedValue({ Item: target({ ready: false }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/ready=false/);
  });

  it("状态不可用 → 原因带上真实 status", async () => {
    getMock.mockResolvedValue({ Item: target({ status: "draining" }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/status=draining/);
  });

  it("格式非法 → 抛(不是返回 null),错误里带格式要求", async () => {
    await expect(requireReadyTarget("tgt_BAD")).rejects.toThrow(/tgt_\[a-z0-9\]/);
  });

  it("可用 → 返回描述符", async () => {
    getMock.mockResolvedValue({ Item: target() });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toMatchObject({ targetId: "tgt_usw2_a" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 P0-1:准入判定不缓存 + 强一致读
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 P0-1 准入判定不得缓存 —— 状态在底下变了必须立刻生效", () => {
  it("🔴🔴【审核点名的反测】先读到 active,管理面改成 draining,**不清任何缓存** → 必须立刻拒", async () => {
    getMock.mockResolvedValue({ Item: target({ status: "active" }) });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toMatchObject({ status: "active" });

    // 另一个 ECS task / 管理面把它原子改成 draining。这里**故意不调用任何 reset**。
    getMock.mockResolvedValue({ Item: target({ status: "draining" }) });
    await expect(
      requireReadyTarget("tgt_usw2_a"),
      "旧实现会在 60s 内继续按 active 放行新 run(零 DDB 调用)—— 那是安全判定被缓存绕过"
    ).rejects.toThrow(/status=draining/);
  });

  it("getTarget 同样不吃缓存:active → deleted 立刻变 null", async () => {
    getMock.mockResolvedValue({ Item: target({ status: "active" }) });
    expect(await getTarget("tgt_usw2_a")).not.toBeNull();
    getMock.mockResolvedValue({ Item: target({ status: "deleted" }) });
    expect(await getTarget("tgt_usw2_a")).toBeNull();
  });

  it("重复取一定重新打库(**这条以前被写成了「只解析一次」= 把 bug 断言成功能**)", async () => {
    getMock.mockResolvedValue({ Item: target() });
    await getTarget("tgt_usw2_a");
    await getTarget("tgt_usw2_a");
    await requireReadyTarget("tgt_usw2_a");
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it("🔴 准入读必须 ConsistentRead:true(断真实入参,不断'没报错')", async () => {
    getMock.mockResolvedValue({ Item: target() });
    await getTarget("tgt_usw2_a");
    await requireReadyTarget("tgt_usw2_a");
    await getHomeTarget().catch(() => {});
    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [cmd] of getMock.mock.calls) {
      expect(
        (cmd as { input: { ConsistentRead?: boolean } }).input.ConsistentRead,
        "最终一致读读不到刚改成 draining 的状态 —— 准入必须强一致"
      ).toBe(true);
    }
  });

  // 🔴 上面那条只断"标志位设了没"。变异测试证明它**独木难支**:把 `ConsistentRead: true` 删掉
  // 只会红 1 条 —— 而"红 1 条"恰恰是我上一轮栽的形状(测试只覆盖了我自己想到的那一面)。
  // 下面两条从**行为**上钉:mock 模拟 DDB 的真实一致性语义(非强一致读返回旧副本),
  // 于是"不强一致就会放行一个已经 draining 的 target"变成可执行事实,而不是一句注释。
  function mockEventualConsistency(oldItem: Record<string, unknown>, newItem: Record<string, unknown>) {
    getMock.mockImplementation((cmd: { input: { ConsistentRead?: boolean } }) =>
      Promise.resolve({ Item: cmd.input.ConsistentRead ? newItem : oldItem })
    );
  }

  it("🔴 行为级:最终一致读会读到旧的 active —— requireReadyTarget 必须读到新的 draining 并拒", async () => {
    mockEventualConsistency(target({ status: "active" }), target({ status: "draining" }));
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/status=draining/);
  });

  it("🔴 行为级:同上,getTarget 必须返回 null(而不是那个陈旧副本)", async () => {
    mockEventualConsistency(target({ status: "active" }), target({ status: "deleted" }));
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
  });

  it("🔴 行为级:home 也一样(刚被改成 draining 的 home 不得放行)", async () => {
    mockEventualConsistency(homeTarget({ status: "active" }), homeTarget({ status: "draining" }));
    await expect(getHomeTarget()).rejects.toThrow(/status=draining/);
  });

  it("listActiveTargets 也强一致(它会被用于扇出下推 = 准入决定)", async () => {
    queryMock.mockResolvedValue({ Items: [] });
    await listActiveTargets();
    const input = queryMock.mock.calls[0][0].input as { ConsistentRead?: boolean };
    expect(input.ConsistentRead).toBe(true);
  });

  it("🔴 GSI 查询**不得**设 ConsistentRead(GSI 不支持;设了 AWS 直接报错)—— 这也是它禁用于准入的物理原因", async () => {
    queryMock.mockResolvedValue({ Items: [] });
    await listTargetsByRegion("us-west-2");
    const input = queryMock.mock.calls[0][0].input as { IndexName: string; ConsistentRead?: boolean };
    expect(input.IndexName).toBe("byRegion");
    expect(input.ConsistentRead).toBeUndefined();
  });
});

describe("🔴 P0-1 stale 的可执行定义(SPEC §1.1 v3.4)", () => {
  const OLD = TARGET_FRESHNESS_MAX_AGE_MS + 60_000;

  it("非 home:probe.at 超阈值 → 拒,且原因里带真实秒数", async () => {
    getMock.mockResolvedValue({ Item: target({ probe: { at: isoAgo(OLD), ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/stale/);
  });

  it("非 home:probe.at 缺失时退到 updatedAt;updatedAt 超阈值 → 拒", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: isoAgo(OLD) }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/stale/);
  });

  it("🔴 非 home:两个时间源都缺 → **判 stale 拒绝**(绝不'缺字段=新鲜')", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: undefined, probe: undefined }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/没有可用的新鲜度时间源/);
  });

  it("非 home:时间戳解析不出来 = 按缺失处理(不许把 'yesterday' 当新鲜)", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: "yesterday", probe: { at: "soon", ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/没有可用的新鲜度时间源/);
  });

  it("非 home:probe.at 新鲜但 updatedAt 很旧 → 放行(probe 才是权威时间源)", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: isoAgo(OLD), probe: { at: isoAgo(1000), ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toMatchObject({ targetId: "tgt_usw2_a" });
  });

  // 🔴 home 豁免拆成三条独立断言:变异测试显示"合在一个 it 里"只会红 1 条,
  // 而这个豁免一旦被删就是**全平台 fail-closed**级别的事故,值得三面各钉一条。
  it("🔴 home 豁免 stale ①:updatedAt 很旧也放行(探活写入方随 P50.2 才来)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ updatedAt: isoAgo(OLD), probe: undefined }) });
    await expect(getHomeTarget()).resolves.toMatchObject({ targetId: HOME_TARGET_ID });
  });

  it("🔴 home 豁免 stale ②:**连时间源都没有**也放行(否则 G0 接线当天全平台 fail-closed)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ updatedAt: undefined, probe: undefined }) });
    await expect(getHomeTarget()).resolves.toMatchObject({ targetId: HOME_TARGET_ID });
  });

  it("🔴 home 豁免 stale ③:陈旧的 home 在 listActiveTargets 里也必须留着", async () => {
    queryMock.mockResolvedValue({
      Items: [homeTarget({ updatedAt: isoAgo(OLD), probe: undefined }), target({ updatedAt: isoAgo(OLD) })],
    });
    const list = await listActiveTargets();
    expect(list.map((t) => t.targetId), "只该剔掉陈旧的**非 home**").toEqual([HOME_TARGET_ID]);
  });

  it("🔴 getTarget(字面 tgt_home) 与 getHomeTarget 同口径豁免(免出现两套判定)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ updatedAt: isoAgo(OLD), probe: undefined }) });
    await expect(getTarget(HOME_TARGET_ID)).resolves.toMatchObject({ targetId: HOME_TARGET_ID });
  });

  it("阈值边界:略小于阈值放行、略大于阈值拒(别把 > 写成 >=,也别写反)", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: isoAgo(TARGET_FRESHNESS_MAX_AGE_MS - 5_000) }) });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toBeTruthy();
    getMock.mockResolvedValue({ Item: target({ updatedAt: isoAgo(TARGET_FRESHNESS_MAX_AGE_MS + 5_000) }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/stale/);
  });

  it("descriptorAgeMs:优先 probe.at、退 updatedAt、都没有返回 null", () => {
    const t = target({ probe: { at: isoAgo(1_000), ok: true, items: [{ name: "core", ok: true }] }, updatedAt: isoAgo(100_000) }) as never;
    expect(descriptorAgeMs(t)).toBeLessThan(5_000);
    expect(descriptorAgeMs(target({ probe: undefined, updatedAt: isoAgo(100_000) }) as never)).toBeGreaterThan(
      90_000
    );
    expect(descriptorAgeMs(target({ probe: undefined, updatedAt: undefined }) as never)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 P1-4:运行时整包校验(SPEC §3.1a)
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 P1-4 描述符运行时整包校验 —— 裸 `as ExecutionTarget` 挡不住的每一类", () => {
  // 第 4 项 = 显式指定"请求的 targetId"(只有"查 A 拿到 B"那条需要它与 item 里的不同)。
  const cases: Array<[string, Record<string, unknown>, RegExp, string?]> = [
    ["sk 与 targetId 不一致(键值/属性漂移)", { sk: "tgt_x" }, /不一致/],
    [
      "描述符里的 targetId 不是请求的那个(查 A 拿到 B)",
      { targetId: "tgt_other", sk: "tgt_other" },
      /不是请求的/,
      "tgt_usw2_a",
    ],
    ["pk 不是 env", { pk: "envx" }, /schema/],
    ["accountId 不是 12 位", { accountId: "123" }, /12 位/],
    ["region 形态非法", { region: "US-WEST-2" }, /region/],
    ["partition 不在枚举内", { partition: "aws-mars" }, /schema/],
    ["partition 与 region 不匹配(cn 区却写 aws)", { region: "cn-north-1" }, /与 region.*不一致/],
    ["status 不在枚举内", { status: "zombie" }, /schema/],
    ["components 缺失", { components: undefined }, /components 缺失/],
    ["components 为空数组", { components: [] }, /components 缺失/],
    ["components 不含 core", { components: ["redshift"] }, /不含 core/],
    ["components 含未知组件", { components: ["core", "quantum"] }, /未知组件/],
    ["emrSubnetIds 为空", { resources: coreResources({ emrSubnetIds: [] }) }, /emrSubnetIds/],
    ["资源 ARN 的账号段是别的账号", { resources: coreResources({ glueRoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/x` }) }, /账号段/],
    ["资源 ARN 的 region 段是别的区", { resources: coreResources({ glueRoleArn: "arn:aws:glue:eu-west-1:" + ACCOUNT + ":x" }) }, /region/],
    ["资源 ARN 的 partition 段是别的分区", { resources: coreResources({ glueRoleArn: `arn:aws-cn:iam::${ACCOUNT}:role/x` }) }, /partition/],
  ];

  for (const [why, over, expected, requestedId] of cases) {
    it(`拒绝:${why}`, async () => {
      const item = target(over);
      getMock.mockResolvedValue({ Item: item });
      const v = descriptorViolation(item, requestedId ?? String(item.sk));
      expect(v, `${why} 应被 descriptorViolation 抓到`).toMatch(expected);
      await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/校验不通过|不是请求的/);
    });
  }

  it("core 资源**逐个**缺失都要被指名道姓(否则运维不知道补哪个)", async () => {
    for (const k of REQUIRED_CORE_RESOURCES) {
      const res = coreResources();
      delete (res as Record<string, unknown>)[k];
      const item = target({ resources: res });
      expect(descriptorViolation(item, String(item.sk)), `缺 ${k} 应被点名`).toContain(k);
    }
  });

  it("🔴 home 不变量:两侧都要挡 —— 冒充 home 与 home 被标成外法域", () => {
    // ① 非 home 的 targetId 却 isHome=true(冒充)
    const fake = target({ isHome: true });
    expect(descriptorViolation(fake, String(fake.sk))).toMatch(/home 不变量/);
    // ② 字面 home 却没有 isHome(反向)
    const h = homeTarget({ isHome: undefined });
    expect(descriptorViolation(h, HOME_TARGET_ID)).toMatch(/home 不变量/);
    // ③ home 被标成外法域 —— 这个若放过,驻留守卫就会对 home 走跨法域分支
    const h2 = homeTarget({ jurisdiction: "eu" });
    expect(descriptorViolation(h2, HOME_TARGET_ID)).toMatch(/jurisdiction/);
  });

  it("合法描述符必须通过(别把校验写得连自己造的正样本都过不了)", () => {
    expect(descriptorViolation(target(), "tgt_usw2_a")).toBeNull();
    expect(descriptorViolation(homeTarget(), HOME_TARGET_ID)).toBeNull();
  });

  it("未知多余属性放行(向前兼容:新版本平台写的新字段不该让旧实例判死)", () => {
    expect(descriptorViolation(target({ someFutureField: { a: 1 } }), "tgt_usw2_a")).toBeNull();
  });

  it("capabilities:存在须为字符串数组;**缺失不拒**(词表未定稿,归 P50.2)", () => {
    expect(descriptorViolation(target({ capabilities: undefined }), "tgt_usw2_a")).toBeNull();
    expect(descriptorViolation(target({ capabilities: ["x"] }), "tgt_usw2_a")).toBeNull();
    expect(descriptorViolation(target({ capabilities: "x" }), "tgt_usw2_a")).toMatch(/schema/);
  });

  it("校验不通过必须**告警**(静默拒绝会让人查不到原因)", async () => {
    getMock.mockResolvedValue({ Item: target({ accountId: "123" }) });
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("🔴 getTargetRaw 是例外:不校验、不过滤(运维必须能看到坏 item 才能修它)", async () => {
    getMock.mockResolvedValue({ Item: target({ ready: false, status: "initializing", accountId: "123" }) });
    const t = await getTargetRaw("tgt_usw2_a");
    expect(t?.status).toBe("initializing");
    expect(t?.accountId).toBe("123");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 P2-1:分页
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 P2-1 列表必须翻完分页(单页就返回 = 静默漏 target)", () => {
  it("listActiveTargets 翻页并把 LastEvaluatedKey 传成 ExclusiveStartKey", async () => {
    queryMock
      .mockResolvedValueOnce({
        Items: [target({ sk: "tgt_a", targetId: "tgt_a" })],
        LastEvaluatedKey: { pk: "env", sk: "tgt_a" },
      })
      .mockResolvedValueOnce({ Items: [target({ sk: "tgt_b", targetId: "tgt_b" })] });
    const list = await listActiveTargets();
    expect(list.map((t) => t.targetId)).toEqual(["tgt_a", "tgt_b"]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    const second = queryMock.mock.calls[1][0].input as { ExclusiveStartKey?: Record<string, unknown> };
    expect(second.ExclusiveStartKey).toEqual({ pk: "env", sk: "tgt_a" });
  });

  it("listTargetsByRegion 同样翻页", async () => {
    queryMock
      .mockResolvedValueOnce({
        Items: [target({ sk: "tgt_a", targetId: "tgt_a", status: "failed" })],
        LastEvaluatedKey: { region: "us-west-2", sk: "tgt_a" },
      })
      .mockResolvedValueOnce({ Items: [target({ sk: "tgt_b", targetId: "tgt_b" })] });
    const list = await listTargetsByRegion("us-west-2");
    expect(list).toHaveLength(2);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("分页失控(始终有 LastEvaluatedKey)要**抛**,不能静默返回可能不完整的结果", async () => {
    queryMock.mockResolvedValue({ Items: [], LastEvaluatedKey: { pk: "env", sk: "x" } });
    await expect(listActiveTargets()).rejects.toThrow(/分页超过/);
  });
});

describe("列表类语义", () => {
  it("listActiveTargets 过滤掉 unusable", async () => {
    queryMock.mockResolvedValue({
      Items: [
        target({ sk: "tgt_a", targetId: "tgt_a", status: "active" }),
        target({ sk: "tgt_b", targetId: "tgt_b", status: "draining" }),
        target({ sk: "tgt_c", targetId: "tgt_c", ready: false }),
        target({ sk: "tgt_d", targetId: "tgt_d", status: "degraded" }),
      ],
    });
    const list = await listActiveTargets();
    expect(list.map((t) => t.targetId)).toEqual(["tgt_a", "tgt_d"]);
  });

  it("🔴 listActiveTargets 也剔除**校验不通过**的 item(免出现'单点拒、列表放'的裂缝)", async () => {
    queryMock.mockResolvedValue({
      Items: [
        target({ sk: "tgt_a", targetId: "tgt_a" }),
        target({ sk: "tgt_b", targetId: "tgt_b", accountId: "123" }),
      ],
    });
    const list = await listActiveTargets();
    expect(list.map((t) => t.targetId)).toEqual(["tgt_a"]);
  });

  it("listTargetsByRegion 走 GSI byRegion,且**不过滤**(运维要看到失败/下线中的)", async () => {
    queryMock.mockResolvedValue({ Items: [target({ sk: "tgt_a", targetId: "tgt_a", status: "failed" })] });
    const list = await listTargetsByRegion("us-west-2");
    expect(queryMock.mock.calls[0][0].input.IndexName).toBe("byRegion");
    expect(list).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 P1-1:home seed 归部署期,读路径只读
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 P1-1 读路径绝不写库", () => {
  it("🔴🔴 home 不存在时 getHomeTarget **抛错**,而且**一次都不写库**", async () => {
    getMock.mockResolvedValue({ Item: undefined });
    await expect(getHomeTarget()).rejects.toThrow(TargetNotReadyError);
    expect(putMock, "读路径写库 = 第一个请求抢先落下不完整描述符并被条件写永久锁死").not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("报错要指向 seed 入口(否则运维只看到'不可用'不知道下一步)", async () => {
    getMock.mockResolvedValue({ Item: undefined });
    await expect(getHomeTarget()).rejects.toThrow(/seedHomeTarget|部署期/);
  });

  it("home 存在且完整 → 正常返回,同样不写库", async () => {
    getMock.mockResolvedValue({ Item: homeTarget() });
    await expect(getHomeTarget()).resolves.toMatchObject({ targetId: HOME_TARGET_ID, isHome: true });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("home 存在但不完整(旧实现的产物:缺 core 资源却 ready=true)→ 拒,不自愈", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ resources: {}, accountId: ACCOUNT }) });
    await expect(getHomeTarget()).rejects.toThrow(/core 资源缺失/);
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("🔴 P1-1 seedHomeTarget:完整才写、已存在要回读比对", () => {
  const full = {
    partition: "aws",
    accountId: ACCOUNT,
    region: "us-east-1",
    status: "active" as const,
    ready: true,
    components: ["core"],
    resources: coreResources(),
    createdBy: "deploy:step-N",
  };

  it("完整描述符 → created,且必须是条件写(绝不覆盖运维手工改过的 item)", async () => {
    const r = await seedHomeTarget(full);
    expect(r).toEqual({ outcome: "created" });
    const input = putMock.mock.calls[0][0].input as { ConditionExpression?: string; Item: Record<string, unknown> };
    expect(input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(input.Item.sk).toBe(HOME_TARGET_ID);
    expect(input.Item.isHome).toBe(true);
    expect(input.Item.jurisdiction, "jurisdiction 缺省 'home' 必须保留(P0-4 整改时差点被一起删掉的语义)").toBe(
      "home"
    );
  });

  it("🔴 不完整描述符 → **抛错且一个字节都不写**(旧实现会写 accountId='' + 缺 core + ready=true)", async () => {
    await expect(seedHomeTarget({ ...full, accountId: "" })).rejects.toThrow(/拒绝 seed/);
    await expect(seedHomeTarget({ ...full, resources: {} })).rejects.toThrow(/core 资源缺失/);
    await expect(seedHomeTarget({ ...full, components: [] })).rejects.toThrow(/components/);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("已存在且**合格** → already-complete(真正的幂等成功路径)", async () => {
    putMock.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
    getMock.mockResolvedValue({ Item: homeTarget() });
    await expect(seedHomeTarget(full)).resolves.toEqual({ outcome: "already-complete" });
  });

  it("🔴 已存在时**必须回读比对**,不许凭 ConditionalCheckFailed 就断言成功", async () => {
    putMock.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
    getMock.mockResolvedValue({ Item: homeTarget() });
    await seedHomeTarget(full);
    expect(getMock, "没回读 = 把'库里有个坏 item'静默当成 seed 成功(旧实现的病)").toHaveBeenCalledTimes(1);
    const input = getMock.mock.calls[0][0].input as { Key: { sk: string }; ConsistentRead?: boolean };
    expect(input.Key.sk).toBe(HOME_TARGET_ID);
    expect(input.ConsistentRead, "回读比对必须强一致,否则读到写之前的副本").toBe(true);
  });

  it("🔴 回读为空(并发删除)也不当成功", async () => {
    putMock.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
    getMock.mockResolvedValue({ Item: undefined });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("conflict-incomplete");
  });

  it("🔴🔴 已存在但**不合格** → conflict-incomplete,**绝不当成功**(旧实现把它静默当 seed 成功,而条件写保证它永远补不上)", async () => {
    putMock.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
    getMock.mockResolvedValue({ Item: homeTarget({ resources: {}, version: 7 }) });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("conflict-incomplete");
    expect(r).toMatchObject({ version: 7 });
    if (r.outcome === "conflict-incomplete") expect(r.violation).toMatch(/core 资源缺失/);
  });

  it("其它写失败仍要抛(别把真故障也吞掉)", async () => {
    putMock.mockRejectedValue(Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" }));
    await expect(seedHomeTarget(full)).rejects.toThrow(/boom/);
  });
});

describe("🔴 P1-1 reconcileTarget:带 version 条件的修补", () => {
  /** 🔴 v3.7:reconcile 只修**维修态**的 item ⇒ 测试必须先让库里那条处于维修态,否则一律被拒。 */
  function repairable(over: Record<string, unknown> = {}) {
    return target({ ready: false, status: "initializing", ...over });
  }

  it("条件写必须带 version 乐观锁 + ready=false + status ∈ 维修态,并把 version 自增", async () => {
    getMock.mockResolvedValue({ Item: repairable() });
    await reconcileTarget("tgt_usw2_a", { resources: coreResources() }, { expectedVersion: 3 });
    const input = updateMock.mock.calls[0][0].input as {
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(input.ConditionExpression).toContain("#v = :expected");
    expect(input.ConditionExpression).toContain("attribute_exists(sk)");
    expect(input.ExpressionAttributeValues[":expected"]).toBe(3);
    expect(input.ExpressionAttributeValues[":next"]).toBe(4);
    // 🔴 v3.7:条件里必须同时有 ready 与 status —— 只有 version 就能对 active/ready 的 target 在线改路由。
    expect(input.ConditionExpression).toContain("#r = :false");
    expect(input.ConditionExpression).toMatch(/#st IN \(/);
    expect(input.ExpressionAttributeValues[":false"]).toBe(false);
  });

  it("🔴🔴 v4-P1-2 反测:`active` / `ready=true` / `draining` 的 target **拒绝**被 reconcile(在线改路由)", async () => {
    for (const over of [
      { ready: true, status: "active" },
      { ready: true, status: "degraded" },
      { ready: false, status: "draining" },
      { ready: false, status: "decommissioning" },
      { ready: false, status: "deleted" },
    ]) {
      updateMock.mockClear();
      getMock.mockResolvedValue({ Item: target(over) });
      await expect(
        reconcileTarget("tgt_usw2_a", { resources: coreResources() }, { expectedVersion: 1 }),
        `${JSON.stringify(over)} 应被拒`
      ).rejects.toThrow(/只能修补.*维修态/);
      expect(updateMock, "被拒时不得发出任何写请求").not.toHaveBeenCalled();
    }
  });

  it("🔴 v4-P1-2 反测:合并 patch 后的 candidate 必须整包过校验(片段合法≠合起来合法)", async () => {
    getMock.mockResolvedValue({ Item: repairable() });
    // patch 片段本身"看起来正常",但合并后 glueRoleArn 指向别的账号 ⇒ 必须拒。
    await expect(
      reconcileTarget(
        "tgt_usw2_a",
        { resources: coreResources({ glueRoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/r` }) },
        { expectedVersion: 1 }
      )
    ).rejects.toThrow(/合并 patch 后的描述符不合法/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 v4-P1-2 反测:patch 删掉某组件的配套资源也要被拒(跨字段不变量)", async () => {
    const res = coreResources({ redshiftWorkgroup: "wg", redshiftDatabase: "dev", redshiftSecretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:x` });
    getMock.mockResolvedValue({ Item: repairable({ components: ["core", "redshift"], resources: res }) });
    await expect(
      reconcileTarget("tgt_usw2_a", { resources: coreResources() }, { expectedVersion: 1 })
    ).rejects.toThrow(/含 redshift 但 resources\.redshiftWorkgroup 缺失/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("target 不存在 ⇒ 拒(不发写请求)", async () => {
    getMock.mockResolvedValue({ Item: undefined });
    await expect(reconcileTarget("tgt_usw2_a", { displayName: "x" }, { expectedVersion: 1 })).rejects.toThrow(
      /不存在/
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  // 🔴🔴 E-19(外部审核 v3 的 N1 整改):安全承重字段的修改面必须用**允许列表**。
  // 上一版只禁 `pk/sk/targetId/ready` ⇒ 这个"修补"函数顺带能把 §3.9b 的单调状态机改回去,
  // 还能把 target 指向另一个账号。这条测试**逐字段穷举**,而不是只测我想到的那 4 个。
  it("🔴🔴 允许列表:只放行内容类字段,其余**逐个**被拒", async () => {
    const mustReject: Array<[string, unknown]> = [
      // 身份键
      ["pk", "x"],
      ["sk", "x"],
      ["targetId", "tgt_other"],
      // 整包标志(半套资源被标 ready 就是 P1-1 本身)
      ["ready", true],
      // 🔴 位置身份:静默改这些 = 把 target 指向另一个账号/区域
      ["accountId", "1".repeat(12)],
      ["region", "eu-west-1"],
      ["partition", "aws-cn"],
      ["cellId", "b"],
      ["stage", "prod"],
      // 🔴 法域:§3.2 驻留守卫的授权输入
      ["jurisdiction", "eu"],
      // 生命周期 / fencing:各有专门通道(§3.5)
      ["status", "active"],
      ["lockEpoch", 9],
      // 乐观锁:内部管理,patch 里出现会让同一属性在 SET 里出现两次
      ["version", 99],
      // 🔴 §3.9b 凭证状态机五字段:必须走 advanceCredentialIsolationState
      ["credentialIsolationState", "legacy-seeded"],
      ["credentialEpoch", 0],
      ["credentialStateUpdatedAt", "2026-01-01T00:00:00.000Z"],
      ["provisioningOperationId", "op-1"],
      ["provisioningDeadlineAt", "2026-01-01T00:00:00.000Z"],
    ];
    for (const [k, v] of mustReject) {
      await expect(
        reconcileTarget("tgt_usw2_a", { [k]: v } as never, { expectedVersion: 1 }),
        `${k} 必须被拒(它不在允许列表里)`
      ).rejects.toThrow(/只允许修补内容类字段/);
    }
    expect(updateMock, "一个都不该发出写请求").not.toHaveBeenCalled();
  });

  it("🔴 `isolated → legacy-seeded` 经通用 reconcile 必须拒(v3 实测它当时能改回去)", async () => {
    await expect(
      reconcileTarget("tgt_usw2_a", { credentialIsolationState: "legacy-seeded" } as never, { expectedVersion: 1 })
    ).rejects.toThrow(/advanceCredentialIsolationState/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("允许列表里的字段可以改(别把订正做过头,修补功能本身要留着)", async () => {
    // 🔴 每个字段用**类型正确**的值:post-image 整包校验会拒掉"给 resources 塞个字符串"这种懒 fixture
    //    —— 第一版就是这么写的,当场被新校验抓到(又一次"我的样本比产品还宽松")。
    const VALID: Record<string, unknown> = {
      resources: coreResources({ tableBucket: "bgp-tables-2" }),
      components: ["core"],
      capabilities: ["glue"],
      displayName: "Home 2",
      desiredVersion: "v2",
      observedVersion: "v2",
      agentcore: { genbiRuntimeArn: `arn:aws:bedrock-agentcore:us-west-2:${ACCOUNT}:runtime/x` },
      probe: { at: new Date().toISOString(), ok: true, items: [{ name: "core", ok: true }] },
    };
    for (const k of RECONCILE_ALLOWED_FIELDS) {
      updateMock.mockClear();
      getMock.mockResolvedValue({ Item: repairable() });
      expect(VALID[k], `${k} 少了合法样本值 ⇒ 这条测试对它形同不存在`).toBeDefined();
      await reconcileTarget("tgt_usw2_a", { [k]: VALID[k] } as never, { expectedVersion: 1 });
      expect(updateMock, `${k} 应被允许`).toHaveBeenCalledTimes(1);
    }
  });

  it("空 patch 直接拒(免发一条什么都不改的条件写、白耗一次 version)", async () => {
    await expect(reconcileTarget("tgt_usw2_a", {}, { expectedVersion: 1 })).rejects.toThrow(/patch 为空/);
  });

  it("targetId 格式非法直接抛", async () => {
    await expect(reconcileTarget("tgt_BAD", { stage: "prod" }, { expectedVersion: 1 })).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 G8 —— 外部审核 v3 的 8 条对抗断言,逐条变成回归测试
//
// 这一组的性质与其它测试不同:每一条都**曾经在真码上复现过**(不是我想象的场景),
// 报告 audit-results/v3/c45a3e5-c26d40c-review.md §7.2 有实测输出。
// 🔴 其中 N1–N4 是我上一批"整改"**自己引入的**,所以这组测试首先是对我自己的门禁。
// ══════════════════════════════════════════════════════════════════════════════

describe("🔴 v3-N2:seed 的「完整」必须包含 ready/status(实测曾 ready:false → created 并真写库)", () => {
  const full = {
    partition: "aws",
    accountId: ACCOUNT,
    region: "us-east-1",
    status: "active" as const,
    ready: true,
    components: ["core"],
    resources: coreResources(),
  };

  it("🔴 ready:false ⇒ 抛错且**一个字节都不写**", async () => {
    await expect(seedHomeTarget({ ...full, ready: false })).rejects.toThrow(/整包写完可承接工作|ready=false/);
    expect(putMock, "旧实现在这里返回 created 并真写库").not.toHaveBeenCalled();
  });

  it("🔴 ready 缺失 ⇒ 同样拒", async () => {
    await expect(seedHomeTarget({ ...full, ready: undefined } as never)).rejects.toThrow(/整包写完/);
    expect(putMock).not.toHaveBeenCalled();
  });

  it("🔴 status 不可承接工作(draining/initializing/failed)⇒ 拒", async () => {
    for (const status of ["draining", "initializing", "failed", "deleted"] as const) {
      putMock.mockClear();
      await expect(seedHomeTarget({ ...full, status } as never), `status=${status} 应拒`).rejects.toThrow(
        /整包写完可承接工作/
      );
      expect(putMock).not.toHaveBeenCalled();
    }
  });

  it("degraded 放行(与准入同口径:一次探活抖动不该让 seed 也做不了)", async () => {
    await expect(seedHomeTarget({ ...full, status: "degraded" } as never)).resolves.toEqual({ outcome: "created" });
  });

  it("descriptorSeedViolation = 整包校验 + 可承接工作(两个函数拼起来那一格补上了)", () => {
    const item = homeTarget({ ready: false });
    expect(descriptorViolation(item, HOME_TARGET_ID), "整包校验本身不管 ready —— 这是设计如此").toBeNull();
    expect(descriptorSeedViolation(item, HOME_TARGET_ID), "seed 口径必须管").toMatch(/ready=false/);
  });
});

describe("🔴 v3-N2b:已存在的 item 必须与**本次期望值**比对(实测曾把别的账号的 home 判成 already-complete)", () => {
  const full = {
    partition: "aws",
    accountId: ACCOUNT,
    region: "us-east-1",
    status: "active" as const,
    ready: true,
    components: ["core"],
    resources: coreResources(),
  };
  beforeEach(() => {
    putMock.mockRejectedValue(Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }));
  });

  it("🔴 已存在但属于**别的账号** ⇒ conflict-mismatch(不是 already-complete)", async () => {
    getMock.mockResolvedValue({
      Item: homeTarget({
        accountId: OTHER_ACCOUNT,
        resources: coreResources({ glueRoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/r` }),
        version: 5,
      }),
    });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("conflict-mismatch");
    if (r.outcome === "conflict-mismatch") {
      expect(r.differences.join(" ")).toMatch(/accountId/);
      expect(r.version).toBe(5);
    }
  });

  it("🔴 已存在但在**别的 region** ⇒ conflict-mismatch", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ region: "eu-west-1" }) });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("conflict-mismatch");
  });

  it("🔴 已存在但 ready:false ⇒ conflict-incomplete(不是 already-complete)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ ready: false }) });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("conflict-incomplete");
  });

  it("位置身份一致 ⇒ already-complete(真幂等路径仍要能走通)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget() });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("already-complete");
  });

  it("内容差异只**报告**不阻断(运维手工改过 resources 是合法的)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ resources: coreResources({ tableBucket: "ops-changed-it" }) }) });
    const r = await seedHomeTarget(full);
    expect(r.outcome).toBe("already-complete");
    if (r.outcome === "already-complete") expect(r.contentDrift?.join(" ")).toMatch(/resources/);
  });
});

describe("🔴 v3-N3:stale 必须挡未来(实测 probe.at=2999 曾放行)", () => {
  it("🔴 probe.at 在遥远未来 ⇒ 非 home 判 stale 拒绝", async () => {
    getMock.mockResolvedValue({ Item: target({ probe: { at: "2999-01-01T00:00:00.000Z", ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/时间源在未来/);
  });

  it("🔴 updatedAt 在遥远未来 ⇒ 同样拒(两个时间源都要挡)", async () => {
    getMock.mockResolvedValue({ Item: target({ updatedAt: "2999-01-01T00:00:00.000Z", probe: undefined }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/时间源在未来/);
  });

  it("容差内的轻微超前放行(正常 NTP 抖动不该把区域判死)", async () => {
    const slightlyAhead = new Date(Date.now() + TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS / 2).toISOString();
    getMock.mockResolvedValue({ Item: target({ probe: { at: slightlyAhead, ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toBeTruthy();
  });

  it("刚超容差就拒(边界:别把容差写成无限)", async () => {
    const tooFar = new Date(Date.now() + TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS + 30_000).toISOString();
    getMock.mockResolvedValue({ Item: target({ probe: { at: tooFar, ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/时间源在未来/);
  });

  it("home 仍豁免(未来值也不判它 stale —— 与过去侧同口径)", async () => {
    getMock.mockResolvedValue({ Item: homeTarget({ probe: { at: "2999-01-01T00:00:00.000Z", ok: true, items: [{ name: "core", ok: true }] } }) });
    await expect(getHomeTarget()).resolves.toMatchObject({ targetId: HOME_TARGET_ID });
  });

  it("容差必须远小于 stale 阈值(否则'未来容差'自己变成一条绕过窗口)", () => {
    expect(TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS).toBeLessThan(TARGET_FRESHNESS_MAX_AGE_MS / 3);
  });
});

describe("🔴 v3-P1-2:资源袋逐项形态 + 组件↔资源配套(实测 malformed 曾整包放行)", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["glueRoleArn 是 'not-an-arn'(旧实现因解析不出反而**跳过**归属校验)", { resources: coreResources({ glueRoleArn: "not-an-arn" }) }, /必须是合法 ARN/],
    ["emrSubnetIds 含 null(旧实现只判数组非空)", { resources: coreResources({ emrSubnetIds: [null] }) }, /emrSubnetIds 含形态非法/],
    ["emrSubnetIds 元素不像子网 id", { resources: coreResources({ emrSubnetIds: ["subnet-xyz"] }) }, /emrSubnetIds 含形态非法/],
    ["emrSecurityGroupId 形态非法", { resources: coreResources({ emrSecurityGroupId: "sg-1" }) }, /emrSecurityGroupId 形态非法/],
    ["桶名形态非法(大写)", { resources: coreResources({ tableBucket: "BadBucket" }) }, /tableBucket 形态非法/],
    ["声明 redshift 但无 workgroup/database/secret", { components: ["core", "redshift"] }, /含 redshift 但 resources\.redshiftWorkgroup 缺失/],
    ["声明 mwaa 但无 dagBucket", { components: ["core", "mwaa"], resources: coreResources({ mwaaEnvName: "bgp-mwaa" }) }, /dagBucket 缺失/],
    ["声明 dms 但无 dmsSubnetGroup", { components: ["core", "dms"] }, /dmsSubnetGroup 缺失/],
    ["声明 flink 但无 flinkRoleArn", { components: ["core", "flink"] }, /flinkRoleArn 缺失/],
    ["声明 agentcore 但 agentcore 袋不全", { components: ["core", "agentcore"], agentcore: { gatewayUrl: "https://x" } }, /agentcore\.genbiRuntimeArn 缺失/],
  ];
  for (const [why, over, expected] of cases) {
    it(`拒绝:${why}`, () => {
      const item = target(over);
      expect(descriptorViolation(item, String(item.sk))).toMatch(expected);
    });
  }

  // 🔴 变异测试实测:只有上面那一条覆盖"畸形 ARN",删掉校验只红 1 条 ⇒ 按规矩必须**换维度**补强。
  // 三个维度:① 每个 ARN 键都要拒;② 端到端(准入入口)也要拒;③ 方向性 —— 畸形值绝不能因为
  // "解析不出来"而跳过归属校验(那正是旧实现的错向)。
  it("🔴 每个必须是 ARN 的键都要拒畸形值(逐键,不只 glueRoleArn)", () => {
    const arnKeys: Array<[string, Record<string, unknown>]> = [
      ["glueRoleArn", { components: ["core"] }],
      ["redshiftSecretArn", { components: ["core", "redshift"], extra: { redshiftWorkgroup: "wg", redshiftDatabase: "dev" } }],
      ["flinkRoleArn", { components: ["core", "flink"] }],
    ];
    for (const [key, over] of arnKeys) {
      const res = coreResources({ ...(over.extra as object), [key]: "not-an-arn" });
      const item = target({ components: over.components, resources: res });
      expect(descriptorViolation(item, "tgt_usw2_a"), `${key} 畸形应被拒`).toMatch(/必须是合法 ARN/);
    }
  });

  it("🔴 端到端:畸形 ARN 的描述符在**准入入口**就被拒(不只是纯函数层)", async () => {
    getMock.mockResolvedValue({ Item: target({ resources: coreResources({ glueRoleArn: "arn:aws:iam" }) }) });
    await expect(requireReadyTarget("tgt_usw2_a")).rejects.toThrow(/必须是合法 ARN/);
    await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
  });

  it("🔴 方向性:畸形值不得因为「解析不出来」而跳过归属校验(旧实现的错向)", () => {
    // `arn:aws:iam` 段数不足 ⇒ 旧实现 parseArn 返回 null ⇒ continue ⇒ **完全不检查**。
    // 现在它必须被拒;而**合法**的 ARN 仍要走归属校验(下一断言证明检查没被整体关掉)。
    expect(descriptorViolation(target({ resources: coreResources({ glueRoleArn: "arn:aws:iam" }) }), "tgt_usw2_a")).toMatch(
      /必须是合法 ARN/
    );
    expect(
      descriptorViolation(
        target({ resources: coreResources({ glueRoleArn: `arn:aws:iam::${OTHER_ACCOUNT}:role/r` }) }),
        "tgt_usw2_a"
      ),
      "合法但属于别的账号 ⇒ 归属校验仍必须生效"
    ).toMatch(/账号段/);
  });

  it("配套齐全就放行(别把订正做过头,装了组件的 target 要能用)", () => {
    const ok = target({
      components: ["core", "redshift", "mwaa", "dms", "flink", "agentcore", "kafka", "residency-api"],
      agentcore: { genbiRuntimeArn: "arn:aws:x", genbiMemoryId: "m", gatewayUrl: "https://x" },
      resources: coreResources({
        redshiftWorkgroup: "bgp-workgroup",
        redshiftDatabase: "dev",
        redshiftSecretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:x`,
        dagBucket: "bgp-dags",
        mwaaEnvName: "bgp-mwaa",
        dmsSubnetGroup: "bgp-dms-sg",
        flinkRoleArn: `arn:aws:iam::${ACCOUNT}:role/flink`,
        flinkSubnetIds: ["subnet-0123456789abcdef0"],
        // @kf-batch 50-W5-seg1-WP10a:residency-api 片 1 三样(SPEC v3.22 §1.3a S4)
        residencyAuditTable: "bgp-region-audit-tgt-usw2-a",
        residencyResultsTable: "bgp-region-results-tgt-usw2-a",
        residencyBucket: `bgp-region-results-${ACCOUNT}-tgt-usw2-a`,
      }),
    });
    expect(descriptorViolation(ok, "tgt_usw2_a")).toBeNull();
  });
});

describe("🔴 v3-N1:凭证状态迁移只能走专用 API(§3.9b 单调不可逆)", () => {
  // 🔴 2026-10-01 这里原来写死 "2026-09-30" 当「未来的截止时间」⇒ 过了那天产品(正确地)拒绝已过期截止,
  //   测试自己变红 —— 定时炸弹。截止时间必须相对「现在」推出来,别写死日历日期。
  const FUTURE_DEADLINE = new Date(Date.now() + 30 * 86400_000).toISOString();
  it("合法前进:legacy-seeded → provisioning,带前态+epoch 条件,epoch++", async () => {
    await advanceCredentialIsolationState("tgt_usw2_a", {
      fromState: "legacy-seeded",
      toState: "provisioning",
      expectedEpoch: 3,
      provisioningDeadlineAt: FUTURE_DEADLINE,
      operationId: "op-1",
      at: "2026-08-31T00:00:00.000Z",
    });
    const input = updateMock.mock.calls[0][0].input as {
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(input.ConditionExpression).toContain("#s = :from");
    expect(input.ConditionExpression).toContain("#e = :expectedEpoch");
    expect(input.ExpressionAttributeValues[":from"]).toBe("legacy-seeded");
    expect(input.ExpressionAttributeValues[":to"]).toBe("provisioning");
    expect(input.ExpressionAttributeValues[":nextEpoch"], "epoch 必须 ++,否则旧缓存槽仍命中").toBe(4);
  });

  it("合法前进:provisioning → isolated", async () => {
    await advanceCredentialIsolationState("tgt_usw2_a", {
      fromState: "provisioning",
      toState: "isolated",
      expectedEpoch: 0,
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("🔴 逆向一律拒,且**不发写请求**(§3.9b:不实现逆向 API)", async () => {
    const backwards: Array<[string, string]> = [
      ["isolated", "provisioning"],
      ["isolated", "legacy-seeded"],
      ["provisioning", "legacy-seeded"],
      ["legacy-seeded", "isolated"], // 跳级也不行
      ["legacy-seeded", "legacy-seeded"], // 自环也不行
    ];
    for (const [from, to] of backwards) {
      await expect(
        advanceCredentialIsolationState("tgt_usw2_a", {
          fromState: from as never,
          toState: to as never,
          expectedEpoch: 1,
          provisioningDeadlineAt: FUTURE_DEADLINE,
        }),
        `${from} → ${to} 必须拒`
      ).rejects.toThrow(CredentialTransitionRejected);
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 进 provisioning 必须带 deadline(§3.9b:回落不得无期限)", async () => {
    await expect(
      advanceCredentialIsolationState("tgt_usw2_a", {
        fromState: "legacy-seeded",
        toState: "provisioning",
        expectedEpoch: 0,
      })
    ).rejects.toThrow(/provisioningDeadlineAt/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("epoch 非法直接拒(负数 / 非整数)", async () => {
    for (const e of [-1, 1.5, NaN]) {
      await expect(
        advanceCredentialIsolationState("tgt_usw2_a", {
          fromState: "provisioning",
          toState: "isolated",
          expectedEpoch: e,
        })
      ).rejects.toThrow(/expectedEpoch/);
    }
  });

  it("targetId 格式非法直接拒", async () => {
    await expect(
      advanceCredentialIsolationState("tgt_BAD", {
        fromState: "provisioning",
        toState: "isolated",
        expectedEpoch: 0,
      })
    ).rejects.toThrow();
  });
});
