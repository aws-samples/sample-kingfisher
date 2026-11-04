// 4 收尾:管理页**只读**可服务性呈现(`describeServiceability`)。
//
// 【为什么必须有这个测试文件】它钉的不是"函数会不会算"，而是**一句承重断言**:
//   页面上写着「不承接:<原因>」的那句话，**逐字**就是数据面拒绝时给出的同一句。
// 这条一旦松掉，就会长出本模块最贵的那类缺陷:页面说能用、数据面拒收(或反过来)，
// 而两边各有一套判定、谁也不知道该信哪个。§20.26c 已经栽过一次同族的:
//   **parity 门禁只证"两侧一致"、不证"判得对"** —— 所以这里两样都钉:
//   ① 与数据面 `requireReadyTarget().why` 逐字相等(一致性);
//   ② 每一条拒因**分别**由一个刻意造出来的真实场景触发(正确性)。
//
// 🔴 还钉一条结构性的:`listActiveTargets()`(扇出侧)与本函数**共用内核** ⇒
//   "单点拒、列表放"这条裂缝在集合层面也不成立。
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock DDB(照 registry.test.ts 的 __kind 分派写法;🔴 顶层 import + 顶层 mock，
//    动态 import × vi.mock 不接管包名 ⇒ 会拿本机凭证真打 AWS，事故 E1 的教训）──
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
  describeServiceability,
  requireReadyTarget,
  getTarget,
  listActiveTargets,
  TargetNotReadyError,
  TARGET_FRESHNESS_MAX_AGE_MS,
  TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS,
  type ExecutionTarget,
} from "@/lib/exec-env/registry";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

/** 12 位账号号:**不写字面量** —— 红线扫描把任何 12 位连续数字当真账号拦下(不区分真假才不漏真的)。 */
const ACCOUNT = "0".repeat(12);

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

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * 合法 modern 描述符工厂。默认**新鲜且可服务**(双轴 ready/healthy/serve + 新鲜 probe)——
 * 让"不可服务"成为需要**显式制造**的条件，而不是默认条件(默认就坏的 fixture 测不出 fail-open)。
 */
function target(over: Record<string, unknown> = {}): ExecutionTarget {
  const probeAt = new Date().toISOString();
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
    updatedAt: probeAt,
    probe: { at: probeAt, ok: true, items: [{ name: "datalakeBucket", ok: true }] },
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: {
      phase: "ready",
      health: "healthy",
      components: ["core"],
      probe: { at: probeAt, ok: true, items: [{ name: "datalakeBucket", ok: true }] },
      lastReconcileAt: probeAt,
    },
    version: 3,
    ...over,
  } as unknown as ExecutionTarget;
}

function homeTarget(over: Record<string, unknown> = {}): ExecutionTarget {
  return target({
    sk: HOME_TARGET_ID,
    targetId: HOME_TARGET_ID,
    isHome: true,
    jurisdiction: "home",
    region: "us-east-1",
    ...over,
  });
}

/**
 * 把 probe/observed.probe/updatedAt 三处时间源**一起**挪老。
 * 🔴 只挪 `updatedAt` 造不出 stale —— 权威时间源是 `probe.at`(`descriptorAgeMs` 先读它)。
 *    我第一版 fixture 就只挪了 `updatedAt`，测试当场红:**fixture 比产品宽松测不出东西**。
 */
function agedFrom(base: ExecutionTarget, ms: number): ExecutionTarget {
  const at = isoAgo(ms);
  const t = base as unknown as Record<string, unknown>;
  t.updatedAt = at;
  t.probe = { at, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
  (t.observed as Record<string, unknown>).probe = { at, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
  return t as unknown as ExecutionTarget;
}

function aged(ms: number, over: Record<string, unknown> = {}): ExecutionTarget {
  return agedFrom(target(over), ms);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getMock.mockResolvedValue({ Item: undefined });
  putMock.mockResolvedValue({});
  updateMock.mockResolvedValue({});
  queryMock.mockResolvedValue({ Items: [] });
});

describe("管理页只读可服务性:正向", () => {
  it("新鲜 + ready + healthy + intent=serve ⇒ 可承接，并给出真实年龄与阈值", () => {
    const v = describeServiceability(target(), "tgt_usw2_a");
    expect(v.usable).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.ageSeconds).not.toBeNull();
    expect(v.ageSeconds!).toBeLessThan(5);
    expect(v.freshnessMaxAgeSeconds).toBe(TARGET_FRESHNESS_MAX_AGE_MS / 1000);
    expect(v.staleExempt).toBe(false);
  });

  it("🔴 只读:算一次可服务性**不写任何库**(读路径写库是外部审核 P1-1 的原缺陷)", () => {
    describeServiceability(target(), "tgt_usw2_a");
    describeServiceability(aged(20 * 60_000), "tgt_usw2_a");
    expect(putMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 home 豁免过期判定:陈旧的 home 仍可承接，且 staleExempt=true(页面据此解释原因)", () => {
    const v = describeServiceability(agedFrom(homeTarget(), 72 * 3600_000), HOME_TARGET_ID);
    expect(v.staleExempt).toBe(true);
    expect(v.usable).toBe(true);
    // 豁免不等于"看不见"——年龄照样给出来，让人自己判断。
    expect(v.ageSeconds!).toBeGreaterThan(TARGET_FRESHNESS_MAX_AGE_MS / 1000);
  });
});

describe("管理页只读可服务性:每条拒因都由一个真实场景触发", () => {
  it("stale(非 home 超阈值)⇒ 不承接，拒因带真实秒数与阈值", () => {
    const v = describeServiceability(aged(TARGET_FRESHNESS_MAX_AGE_MS + 5 * 60_000), "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("stale");
    expect(v.reason).toContain(String(TARGET_FRESHNESS_MAX_AGE_MS / 1000));
    expect(v.ageSeconds!).toBeGreaterThan(TARGET_FRESHNESS_MAX_AGE_MS / 1000);
  });

  it("阈值边界:略小于阈值放行、略大于拒(不许把边界写成 >= 或差一个数量级)", () => {
    expect(describeServiceability(aged(TARGET_FRESHNESS_MAX_AGE_MS - 30_000), "tgt_usw2_a").usable).toBe(true);
    expect(describeServiceability(aged(TARGET_FRESHNESS_MAX_AGE_MS + 30_000), "tgt_usw2_a").usable).toBe(false);
  });

  it("🔴 时间源在未来超容差 ⇒ 同样不承接(probe.at=2999 曾让 stale 闸长期形同虚设)", () => {
    const v = describeServiceability(aged(-(TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS + 60_000)), "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("未来");
  });

  it("🔴 缺时间源 ⇒ 判 stale(绝不「缺字段=新鲜」),ageSeconds 如实为 null", () => {
    // observed.components 必须留着 —— 删了会先撞 schema 闸，就测不到"缺时间源"这条了。
    const t = target({
      probe: undefined,
      updatedAt: undefined,
      observed: { phase: "ready", health: "healthy", components: ["core"] },
    });
    const v = describeServiceability(t, "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("时间源");
    expect(v.ageSeconds).toBeNull();
  });

  it("残留部署锁 ⇒ 不承接(在途会话期间不接新活)", () => {
    const v = describeServiceability(target({ deployLockOperationId: "op_x", deployLockToken: "tk" }), "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("部署锁");
  });

  it("🔴 已排空(spec.intent=drain)⇒ 不承接 —— 徽标可能还写着别的，这里必须说实话", () => {
    const v = describeServiceability(target({ spec: { intent: "drain", desiredComponents: ["core"] } }), "tgt_usw2_a");
    expect(v.usable).toBe(false);
  });

  it("phase 未到 ready(还在装)⇒ 不承接", () => {
    const t = target({
      status: "initializing",
      ready: false,
      observed: { phase: "provisioning", health: "unknown", components: ["core"] },
    });
    expect(describeServiceability(t, "tgt_usw2_a").usable).toBe(false);
  });

  it("描述符不存在 ⇒ 不承接，且 ageSeconds 为 null(不拿空对象算出个 0 秒来)", () => {
    const v = describeServiceability(null, "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("没有该描述符");
    expect(v.ageSeconds).toBeNull();
  });

  it("形态非法(资源袋坏)⇒ 不承接且拒因指向校验，而不是含糊的「不可用」", () => {
    const v = describeServiceability(target({ resources: coreResources({ emrSecurityGroupId: "sg-1" }) }), "tgt_usw2_a");
    expect(v.usable).toBe(false);
    expect(v.reason).toContain("校验不通过");
  });
});

describe("🔴 承重断言:页面那句话 = 数据面拒因(逐字)", () => {
  const cases: Array<{ name: string; item: ExecutionTarget }> = [
    { name: "stale", item: aged(TARGET_FRESHNESS_MAX_AGE_MS + 60_000) },
    { name: "未来时钟", item: aged(-(TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS + 60_000)) },
    { name: "残留锁", item: target({ deployLockOperationId: "op_x", deployLockToken: "tk" }) },
    { name: "已排空", item: target({ spec: { intent: "drain", desiredComponents: ["core"] } }) },
    {
      name: "未到 ready",
      item: target({
        status: "initializing",
        ready: false,
        observed: { phase: "provisioning", health: "unknown", components: ["core"] },
      }),
    },
    { name: "形态非法", item: target({ resources: coreResources({ emrSecurityGroupId: "sg-1" }) }) },
  ];

  for (const c of cases) {
    it(`${c.name}:describeServiceability().reason === requireReadyTarget() 抛出的 why`, async () => {
      getMock.mockResolvedValue({ Item: c.item });
      const view = describeServiceability(c.item, "tgt_usw2_a");
      expect(view.usable).toBe(false);

      let why: string | null = null;
      try {
        await requireReadyTarget("tgt_usw2_a");
      } catch (e) {
        expect(e).toBeInstanceOf(TargetNotReadyError);
        why = (e as TargetNotReadyError).why;
      }
      // 🔴 逐字相等 —— 不是"都包含 stale 字样"这种弱断言(那种断言两侧分叉了也照样绿)。
      expect(why).not.toBeNull();
      expect(view.reason).toBe(why);
      // 同一条件下 getTarget 必须返回 null(第三个读侧入口不许有自己的口径)
      await expect(getTarget("tgt_usw2_a")).resolves.toBeNull();
    });
  }

  it("可承接时三侧同样一致:reason=null ∧ getTarget 返回描述符 ∧ requireReadyTarget 不抛", async () => {
    const item = target();
    getMock.mockResolvedValue({ Item: item });
    expect(describeServiceability(item, "tgt_usw2_a").reason).toBeNull();
    await expect(getTarget("tgt_usw2_a")).resolves.toMatchObject({ targetId: "tgt_usw2_a" });
    await expect(requireReadyTarget("tgt_usw2_a")).resolves.toMatchObject({ targetId: "tgt_usw2_a" });
  });
});

describe("🔴 集合层面:扇出侧 listActiveTargets 与页面呈现共用同一内核", () => {
  it("列表放行的集合 === 页面判「可承接」的集合(消掉「单点拒、列表放」的裂缝)", async () => {
    const items = [
      target({ sk: "tgt_a", targetId: "tgt_a" }), // 可承接
      aged(TARGET_FRESHNESS_MAX_AGE_MS + 60_000, { sk: "tgt_b", targetId: "tgt_b" }), // stale
      target({ sk: "tgt_c", targetId: "tgt_c", spec: { intent: "drain", desiredComponents: ["core"] } }), // 已排空
      target({ sk: "tgt_d", targetId: "tgt_d", deployLockToken: "tk", deployLockOperationId: "op" }), // 有锁
      agedFrom(homeTarget(), 72 * 3600_000), // 陈旧 home:豁免 ⇒ 仍放行
    ];
    queryMock.mockResolvedValue({ Items: items });

    const admitted = (await listActiveTargets()).map((t) => t.sk).sort();
    const viewUsable = items
      .filter((t) => describeServiceability(t, String((t as unknown as { sk: string }).sk)).usable)
      .map((t) => (t as unknown as { sk: string }).sk)
      .sort();

    expect(admitted).toEqual(viewUsable);
    // 钉住「这个测试仍然有效」:集合必须**既有放行也有拒绝**，否则它可能在两边都空的情况下假绿。
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(items.length);
    expect(admitted).toEqual(["tgt_a", HOME_TARGET_ID].sort());
  });
});
