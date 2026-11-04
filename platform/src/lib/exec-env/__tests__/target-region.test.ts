// @kf-batch 50-WP31-place-first-class
// 序 31 第二刀 ②:区解析的唯一作者 `regionOfTarget` 记落点决策 —— 观测器据此把「同步任务日志 / Glue 状态 / 输出、
// 数仓工作组清单、统一结果 / 取消 …」这一族调用归到它们真正服务的 target(第四十轮 observe 未归因榜的请求内大头)。
// 🔴 只 mock 真外部(DynamoDB 文档客户端):注册表 `getTargetRaw` 走真实现(它是本文件被测函数的兄弟模块,mock 掉 = 抹平接缝,
//    mock-hygiene-guard 棘轮会拦);账本(context.ts)走真实现,请求存储用最小替身。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({ targets: {} as Record<string, { targetId: string; region?: string }> }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: { TableName?: string; Key?: { pk?: string; sk?: string } } }) => {
        if (cmd.constructor.name !== "GetCommand") throw new Error(`未预期的 DynamoDB 命令:${cmd.constructor.name}`);
        const id = String(cmd.input.Key?.sk ?? "");
        return { Item: h.targets[id] ? { pk: "env", sk: id, ...h.targets[id] } : undefined };
      },
    },
  };
});

import { regionOfTarget, REGION_OF_TARGET_VIA, TargetBindingRejected, __resetRegionCache } from "@/lib/exec-env/target-region";
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

function fakeRequest() {
  const store = { headers: new Headers() };
  __setRequestStoreProvider(() => store);
  return store;
}
const decided = () => decisionsOfCurrentRequest().decisions.filter((d) => d.via === REGION_OF_TARGET_VIA);

beforeEach(() => {
  h.targets = { tgt_usw2_a: { targetId: "tgt_usw2_a", region: "us-west-2" } };
  process.env.AWS_REGION = "us-east-1";
  __resetRegionCache();
  __setRequestStoreProvider(() => undefined);
});
afterEach(() => __setRequestStoreProvider(null));

describe("🔴 regionOfTarget 记落点决策(序 31 第二刀 ②)", () => {
  it("非主控区:回该区 + 记 {targetId}(观测器据此把这次请求后续的数据面调用归到该 target)", async () => {
    fakeRequest();
    expect(await regionOfTarget("tgt_usw2_a")).toBe("us-west-2");
    expect(decided()).toEqual([{ targetId: "tgt_usw2_a", via: REGION_OF_TARGET_VIA }]);
  });

  it("命中缓存那次也记(决策是「这次请求在哪儿做事」,不是「读了一次注册表」)", async () => {
    fakeRequest();
    await regionOfTarget("tgt_usw2_a");
    await regionOfTarget("tgt_usw2_a");
    expect(decided().map((d) => d.targetId)).toEqual(["tgt_usw2_a", "tgt_usw2_a"]);
  });

  it("主控区:记 tgt_home;🔴 空串:如实记 null(= 调用方没传、按老规矩回主控区),不许洗白成 tgt_home", async () => {
    fakeRequest();
    expect(await regionOfTarget("tgt_home")).toBe("us-east-1");
    expect(await regionOfTarget("")).toBe("us-east-1");
    expect(decided()).toEqual([
      { targetId: "tgt_home", via: REGION_OF_TARGET_VIA },
      { targetId: null, via: REGION_OF_TARGET_VIA },
    ]);
  });

  it("非法 id 仍抛 TargetBindingRejected,且不记决策(抛在记账之前:非法 id 不是一个落点)", async () => {
    fakeRequest();
    await expect(regionOfTarget("not-a-target")).rejects.toBeInstanceOf(TargetBindingRejected);
    expect(decided()).toEqual([]);
  });

  it("缺 region 的描述符仍抛(不回落主控区)—— 行为与改前逐字相同", async () => {
    fakeRequest();
    h.targets.tgt_usw2_b = { targetId: "tgt_usw2_b" };
    await expect(regionOfTarget("tgt_usw2_b")).rejects.toThrow(/没有 region/);
  });

  it("请求外(reconciler / 泵)调用:不抛、不记(账本只挂在请求存储上)", async () => {
    __setRequestStoreProvider(() => undefined);
    expect(await regionOfTarget("tgt_usw2_a")).toBe("us-west-2");
    expect(decisionsOfCurrentRequest().decisions).toEqual([]);
  });

  it("接线:数仓工作组清单路由的区经 regionOfTarget 取(不再直接读 t.region 建客户端)", () => {
    const src = readFileSync(new URL("../../../app/api/redshift/connections/route.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    expect(src).toMatch(/redshiftServerlessClientFor\(await regionOfTarget\(targetId\)\)/);
    expect(src, "又有人直接拿描述符的 region 建客户端 ⇒ 决策没人记").not.toMatch(/ClientFor\(t\.region\)/);
  });
});
