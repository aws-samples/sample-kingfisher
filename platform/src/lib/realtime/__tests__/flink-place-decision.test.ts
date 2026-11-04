// `resolveFlinkPlace`:落点必填 + **主控区也记决策**(D11:决策记账在第一个 await 之前、与分支无关)。
//
// 起因(2026-10-03 09:20Z 观测器实测):全局视角列实时作业,一次请求里混着两个区的作业 ⇒ us-west-2 那条记了决策,
// 主控区那条走 env 分支直接 return、一笔都没记 ⇒ 主控区那次 `DescribeApplication @ us-east-1` 在观测器里「无决策」,
// 被拿去和 us-west-2 的决策比对 ⇒ 误报越区。调用其实打对了区;缺的是账。
// 装配层:不 mock 决策账本(context.ts 是真的),只换掉请求存储的来源(Next 之外没有请求存储)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 主控区也读描述符(收尾):注册表是真外部(DDB 边界),这里给一份主控区描述符。
const h = vi.hoisted(() => ({ targets: new Map<string, Record<string, unknown>>() }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    requireReadyTarget: async (id: string) => {
      const t = h.targets.get(id);
      if (!t) throw new real.TargetNotReadyError(id, "no descriptor");
      return t;
    },
  };
});
const ACCT = "000000000000";
const HOME_DESC = {
  targetId: "tgt_home", region: "us-east-1", accountId: ACCT, partition: "aws", version: 1, status: "active", ready: true,
  components: ["core", "flink"],
  resources: {
    scriptsBucket: `bgp-glue-scripts-${ACCT}`, datalakeBucket: `bgp-datalake-${ACCT}`, tableBucket: "bgp-table-bucket",
    flinkRoleArn: `arn:aws:iam::${ACCT}:role/bgp-flink-role`, emrSubnetIds: ["subnet-h1", "subnet-h2"], emrSecurityGroupId: "sg-h",
  },
};
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";
import { resolveFlinkPlace } from "../flink-place";

let store: object;
beforeEach(() => {
  store = {};
  h.targets.clear();
  h.targets.set("tgt_home", HOME_DESC);
  __setRequestStoreProvider(() => store);
});
afterEach(() => __setRequestStoreProvider(null));

describe("resolveFlinkPlace", () => {
  it("🔴 主控区也记一笔决策(原来 env 分支直接 return ⇒ 账本里没有它)", async () => {
    const p = await resolveFlinkPlace("tgt_home");
    expect(p.home).toBe(true);
    expect(decisionsOfCurrentRequest().decisions).toEqual([{ targetId: "tgt_home", via: "resolveFlinkPlace" }]);
  });

  it("🔴🔴 主控区的值**全部来自描述符**(收尾:原来走 FLINK 常量)—— 与 env 无关", async () => {
    const p = await resolveFlinkPlace("tgt_home");
    expect(p).toEqual({
      targetId: "tgt_home", region: "us-east-1", account: ACCT,
      roleArn: `arn:aws:iam::${ACCT}:role/bgp-flink-role`,
      codeBucket: `bgp-glue-scripts-${ACCT}`, outputBucket: `bgp-datalake-${ACCT}`, s3tablesBucket: "bgp-table-bucket",
      subnetIds: ["subnet-h1", "subnet-h2"], securityGroupIds: ["sg-h"], home: true,
    });
  });

  it("🔴 主控区没装 flink / 缺桶 / 角色不是本区那个 / 没有描述符 ⇒ 409 PlaceUnavailable,**不回落** env 常量", async () => {
    const { PlaceUnavailable } = await import("@/lib/place/types");
    const cases: Array<[string, Record<string, unknown> | null, RegExp]> = [
      ["没装 flink", { ...HOME_DESC, components: ["core"] }, /没有装 flink/],
      ["缺代码桶", { ...HOME_DESC, resources: { ...HOME_DESC.resources, scriptsBucket: "" } }, /scriptsBucket/],
      ["角色指向别处", { ...HOME_DESC, resources: { ...HOME_DESC.resources, flinkRoleArn: `arn:aws:iam::${ACCT}:role/someone-else` } }, /flinkRoleArn/],
      ["没有描述符", null, /不可承接/],
    ];
    for (const [what, desc, re] of cases) {
      h.targets.clear();
      if (desc) h.targets.set("tgt_home", desc);
      const err = await resolveFlinkPlace("tgt_home").then(() => null, (e) => e);
      expect(err, what).toBeInstanceOf(PlaceUnavailable);
      expect(String(err?.message), what).toMatch(re);
    }
  });

  it("🔴 缺 / 空 / 非法 ⇒ 拒,不回落主控区;拒之前那笔决策照记(观测器能看见「有人没给落点」)", async () => {
    for (const bad of [undefined, "", "TGT-BAD"]) {
      await expect(resolveFlinkPlace(bad as unknown as string)).rejects.toThrow(/非法 targetId/);
    }
    expect(decisionsOfCurrentRequest().decisions.map((d) => d.via)).toEqual(["resolveFlinkPlace", "resolveFlinkPlace", "resolveFlinkPlace"]);
  });
});
