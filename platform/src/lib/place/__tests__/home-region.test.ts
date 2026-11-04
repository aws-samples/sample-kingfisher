// @kf-batch 50-WP31-place-first-class
// WP-31 L4 —— 唯一读区作者 lib/place/home-region.ts 的三态判据(+ 不回落版本 + 注入 env 版本)。
// 🔴 「都没有」那一态现在钉的是 `us-east-1` 回落(本包行为不变);序 6 改成「缺即抛」时这一条要同笔改成 toThrow。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homeRegion, homeRegionOf, homeRegionOrEmpty } from "@/lib/place/home-region";

const KEYS = ["BGP_HOME_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("homeRegion():BGP_HOME_REGION → AWS_REGION → us-east-1", () => {
  it("只有 BGP_HOME_REGION", () => {
    process.env.BGP_HOME_REGION = "us-west-2";
    expect(homeRegion()).toBe("us-west-2");
    expect(homeRegionOrEmpty()).toBe("us-west-2");
  });

  it("只有 AWS_REGION(当前生产形态:平台栈尚未注入 BGP_HOME_REGION)", () => {
    process.env.AWS_REGION = "eu-west-1";
    expect(homeRegion()).toBe("eu-west-1");
    expect(homeRegionOrEmpty()).toBe("eu-west-1");
  });

  it("两者都有 ⇒ BGP_HOME_REGION 赢(序 6 把 AWS_REGION 设空串后仍拿得到主控区)", () => {
    process.env.BGP_HOME_REGION = "us-west-2";
    process.env.AWS_REGION = "us-east-1";
    expect(homeRegion()).toBe("us-west-2");
  });

  it("都没有 ⇒ homeRegion 回落 us-east-1(过渡期保留),homeRegionOrEmpty 回空串", () => {
    expect(homeRegion()).toBe("us-east-1");
    expect(homeRegionOrEmpty()).toBe("");
  });

  it("空串当作没有(与迁移前 `process.env.AWS_REGION || …` 逐字节一致;序 6 的「设空串」正是靠这一点)", () => {
    process.env.BGP_HOME_REGION = "";
    process.env.AWS_REGION = "";
    expect(homeRegion()).toBe("us-east-1");
    expect(homeRegionOrEmpty()).toBe("");
    process.env.AWS_REGION = "ap-northeast-1";
    expect(homeRegion()).toBe("ap-northeast-1");
  });

  it("AWS_DEFAULT_REGION 不参与(迁移前 78 处没有一处读它;Fargate 自注入的它不许成为第二个来源)", () => {
    process.env.AWS_DEFAULT_REGION = "sa-east-1";
    expect(homeRegion()).toBe("us-east-1");
    expect(homeRegionOrEmpty()).toBe("");
  });
});

describe("homeRegionOf(env):与 homeRegion() 同序同回落,只是 env 可注入", () => {
  it("三态与 homeRegion() 逐一相同", () => {
    const cases: Array<Record<string, string>> = [
      { BGP_HOME_REGION: "us-west-2" },
      { AWS_REGION: "eu-west-1" },
      { BGP_HOME_REGION: "us-west-2", AWS_REGION: "us-east-1" },
      {},
      { BGP_HOME_REGION: "", AWS_REGION: "" },
      { AWS_DEFAULT_REGION: "sa-east-1" },
    ];
    for (const env of cases) {
      for (const k of KEYS) delete process.env[k];
      Object.assign(process.env, env);
      expect(homeRegionOf(env), JSON.stringify(env)).toBe(homeRegion());
    }
  });
});

describe("零依赖(middleware 跑在 edge,import 图碰 node 内置就构建失败)", () => {
  it("home-region.ts 没有任何 import / require", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../home-region.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
