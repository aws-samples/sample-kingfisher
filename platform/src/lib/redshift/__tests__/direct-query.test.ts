// @kf-batch 50-WP2-directquery
// 数仓直查单一作者的可执行门禁(合同 50 SPEC §3.4;施工包 WP-2 ④ B 组)。
//
// 🔴 这里要钉住的三件事,每一件都是「错了不报错、只是悄悄换了个区/换了身份」:
//   ① home **不许**把 projectId 递给绑定解析(治理类本无项目,per-project 查找会 fail-closed);
//   ② 非 home **必须**递(缺了它绑定解析会拒,而拒因是「没凭证」不是「没装数仓」);
//   ③ 只有 `missing-component` 才降级 —— 别的拒因降级 = 用一句错的解释盖住真问题。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TargetBindingRejected } from "@/lib/exec-env/target-region";

type Sent = { name: string; input: Record<string, unknown> };
const sent: Sent[] = [];
let bindingCalls: Array<Record<string, unknown>> = [];
let bindingImpl: (args: Record<string, unknown>) => unknown = () => ({});
let statuses: string[] = [];
let clientRegions: string[] = [];

vi.mock("@/lib/exec-env/data-plane-target", () => ({
  resolveRedshiftBinding: vi.fn(async (args: Record<string, unknown>) => {
    bindingCalls.push(args);
    return bindingImpl(args);
  }),
}));

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn((region: string) => {
    clientRegions.push(region);
    return {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        sent.push({ name, input: cmd.input });
        if (name === "ExecuteStatementCommand") return { Id: "stmt-1" };
        if (name === "DescribeStatementCommand") return { Status: statuses.shift() ?? "FINISHED", Error: "库炸了" };
        return {
          ColumnMetadata: [{ name: "n" }, { name: "s" }],
          Records: [[{ longValue: 3 }, { stringValue: "x" }]],
        };
      }),
    };
  }),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directQuery, directQueryRaw, resolveDirectQueryPlace, degradeIfNoWarehouse, NO_WAREHOUSE_REASON } from "../direct-query";

const HOME_BINDING = {
  targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup",
  database: "dev", secretArn: "arn:home", home: true,
};
const USW2_BINDING = {
  targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a",
  database: "dev", secretArn: "arn:usw2", home: false,
};

beforeEach(() => {
  sent.length = 0;
  clientRegions.length = 0;
  bindingCalls = [];
  statuses = [];
  bindingImpl = (args) => (String(args.targetId) === "tgt_home" ? HOME_BINDING : USW2_BINDING);
  vi.useRealTimers();
});

describe("落点解析:home 与非 home 的 projectId 口径不同", () => {
  it("🔴 home **不传** projectId —— 传了会去查 per-project 凭证并 fail-closed", async () => {
    await resolveDirectQueryPlace({ targetId: "tgt_home", projectId: "proj-default" });
    expect(bindingCalls).toEqual([{ targetId: "tgt_home" }]);
    for (const c of bindingCalls) expect("projectId" in c).toBe(false);
  });

  // @kf-batch 50-WP31-place-first-class
  it("🔴 落点缺 / 空 / 非法 ⇒ 当场拒,**不回落主控区**(原来「缺省 = 主控区」⇒ 漏传就在主控区数仓上跑)", async () => {
    for (const bad of [undefined, "", "TGT-BAD"]) {
      await expect(resolveDirectQueryPlace({ targetId: bad as unknown as string, projectId: "p" })).rejects.toThrow(/非法 targetId/);
      await expect(directQuery({ targetId: bad as unknown as string, projectId: "p" }, "select 1")).rejects.toThrow(/非法 targetId/);
    }
    expect(bindingCalls).toEqual([]);
  });

  it("🔴 非 home **必须**把 projectId 递进去(缺了绑定解析会以「没凭证」拒,那是另一件事)", async () => {
    await resolveDirectQueryPlace({ targetId: "tgt_usw2_a", projectId: "proj-default" });
    expect(bindingCalls).toEqual([{ targetId: "tgt_usw2_a", projectId: "proj-default" }]);
  });

  it("落点四样原样带出(不自己拼 workgroup/database)", async () => {
    const p = await resolveDirectQueryPlace({ targetId: "tgt_usw2_a", projectId: "p" });
    expect(p).toEqual({
      targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a",
      database: "dev", secretArn: "arn:usw2", home: false,
    });
  });

  it("绑定没给 secretArn ⇒ 不带该键(走 IAM 身份,与收编前 `...(SecretArn ? {} : {})` 同形)", async () => {
    bindingImpl = () => ({ ...HOME_BINDING, secretArn: undefined });
    const p = await resolveDirectQueryPlace({ targetId: "tgt_home" });
    expect("secretArn" in p).toBe(false);
  });
});

describe("执行:客户端按落点 region 建、SQL 打到落点的 workgroup/database", () => {
  it("非 home 的查询打到 us-west-2 的 workgroup(不是 home 的)", async () => {
    const r = await directQuery({ targetId: "tgt_usw2_a", projectId: "p" }, "select 1");
    expect(r.capability).toBe("available");
    expect(clientRegions).toEqual(["us-west-2"]);
    const exec = sent.find((s) => s.name === "ExecuteStatementCommand")!;
    expect(exec.input).toEqual({
      Sql: "select 1", WorkgroupName: "bgp-workgroup-tgt-usw2-a", Database: "dev", SecretArn: "arn:usw2",
    });
  });

  it("回的是**原样**列名与记录(不归一单元格 —— 七个消费者口径不同)", async () => {
    const r = await directQuery({ targetId: "tgt_home" }, "select 1");
    expect(r.capability === "available" && r.columns).toEqual(["n", "s"]);
    expect(r.capability === "available" && r.records).toEqual([[{ longValue: 3 }, { stringValue: "x" }]]);
  });

  it("FAILED / ABORTED ⇒ 抛引擎原文(文案与收编前逐字一致)", async () => {
    statuses = ["FAILED"];
    await expect(directQuery({ targetId: "tgt_home" }, "select 1")).rejects.toThrow("库炸了");
    statuses = ["ABORTED"];
    await expect(directQuery({ targetId: "tgt_home" }, "select 1")).rejects.toThrow("库炸了");
  });

  it("一直不终态 ⇒ 「查询超时」,且**轮完预算次数**才放弃", async () => {
    // 🔴 用**很小的预算**跑这条:按缺省 50 × 700ms 跑会真睡 35 秒 ——
    //    那不只是慢,它会在全量 vitest 里把机器压住,把别的**基于时间**的判据(如凭证缓存 TTL)
    //    压成假红。「测超时」不需要真等 35 秒,需要的是「轮完就放弃 + 文案对」。
    statuses = Array(10).fill("STARTED");
    await expect(directQueryRaw({ targetId: "tgt_home", region: "us-east-1", workgroup: "wg", database: "dev", home: true }, "select 1", { rounds: 3, intervalMs: 1 })).rejects.toThrow("查询超时");
    expect(sent.filter((s) => s.name === "DescribeStatementCommand")).toHaveLength(3);
  });

  it("🔴 缺省轮询预算仍是 50 × 700ms(收编前多数副本的原值 —— 改小会把慢查询判成超时)", () => {
    // 常量是模块私有 ⇒ 按源码钉住(比"跑 35 秒验一遍"划算,且同样抓得住有人顺手改小)
    const src = readFileSync(resolve(__dirname, "../direct-query.ts"), "utf8");
    expect(src).toMatch(/const POLL_ROUNDS = 50;/);
    expect(src).toMatch(/const POLL_INTERVAL_MS = 700;/);
  });
});

describe("降级:只有「没装数仓」才是能力态", () => {
  it("missing-component ⇒ unavailable + 人话文案,且**一条 SQL 都没发**", async () => {
    bindingImpl = () => {
      throw new TargetBindingRejected("missing-component", "执行目标 tgt_core_only 没有安装 redshift 组件");
    };
    const r = await directQuery({ targetId: "tgt_core_only", projectId: "p" }, "select 1");
    expect(r).toEqual({
      capability: "unavailable", targetId: "tgt_core_only", missing: "redshift", reason: NO_WAREHOUSE_REASON,
    });
    expect(sent).toEqual([]);
    expect(NO_WAREHOUSE_REASON).toContain("数据湖");
  });

  it("🔴 其它拒因**照抛**,不许伪装成「没装数仓」", async () => {
    for (const reason of ["invalid-target", "project-not-allowed", "no-credential", "warehouse-conflict"] as const) {
      bindingImpl = () => {
        throw new TargetBindingRejected(reason, `拒因 ${reason}`);
      };
      await expect(directQuery({ targetId: "tgt_usw2_a", projectId: "p" }, "select 1")).rejects.toThrow(`拒因 ${reason}`);
    }
  });

  it("普通异常(库都没连上)也照抛", async () => {
    bindingImpl = () => {
      throw new Error("DDB 挂了");
    };
    await expect(directQuery({ targetId: "tgt_usw2_a", projectId: "p" }, "select 1")).rejects.toThrow("DDB 挂了");
  });

  it("degradeIfNoWarehouse 只对 missing-component 返回非 null", () => {
    expect(degradeIfNoWarehouse(new TargetBindingRejected("missing-component", "x"), "t")).not.toBeNull();
    expect(degradeIfNoWarehouse(new TargetBindingRejected("invalid-target", "x"), "t")).toBeNull();
    expect(degradeIfNoWarehouse(new Error("x"), "t")).toBeNull();
  });
});
