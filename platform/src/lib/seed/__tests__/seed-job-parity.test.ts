// @kf-batch 50-CAPSEED-seed-dispatch
// 🔴 平台「复用部署期那个造数作业」⇒ 作业名必须与部署脚本**逐字同名**。从两支脚本里把名字抽出来比
//    (改一侧漏另一侧的症状:接口 409「该区没有造数作业」,而控制台里明明有)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_SEED_JOB,
  REGION_SEED_JOB_PREFIX,
  seedJobNameFor,
  seedJobArguments,
  seedKindOf,
  seedRunTaskId,
  isSeedRunTaskId,
  targetOfSeedRunTaskId,
} from "../seed-job";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const script = (f: string) => readFileSync(resolve(REPO, "scripts", f), "utf8");

describe("CAP-SEED 造数作业名 ↔ 部署脚本(两侧同名)", () => {
  it("主控区:22-seed-game.sh 建的、启动的、轮询的都是 bgp-game-seed", () => {
    const s = script("22-seed-game.sh");
    expect(s).toMatch(new RegExp(`--name ${HOME_SEED_JOB}\\b`));
    expect(s).toContain(`start-job-run --job-name ${HOME_SEED_JOB} `);
    expect(seedJobNameFor("tgt_home")).toBe(HOME_SEED_JOB);
  });

  it("其它区:23-seed-game-region.sh 的 JOB=“bgp-game-seed-$TARGET” 与平台派生同形", () => {
    const s = script("23-seed-game-region.sh");
    const m = s.match(/^JOB="([^"$]+)\$TARGET"$/m);
    expect(m, "23-seed-game-region.sh 里找不到 JOB=…$TARGET 那一行(判据锚点失效)").toBeTruthy();
    expect(m![1]).toBe(REGION_SEED_JOB_PREFIX);
    expect(seedJobNameFor("tgt_usw2_a")).toBe("bgp-game-seed-tgt_usw2_a");
    // 脚本按描述符的 datalakeBucket 写湖;平台启动时显式带同名参数(以描述符为准)
    expect(s).toContain('"--datalake":"$LAKE"');
  });

  it("种类只判一处:主控区 = 灌源库(不带参数),其它区 = 写该区湖(必带 --datalake = 描述符的湖桶)", () => {
    expect(seedKindOf("tgt_home")).toBe("source-db");
    expect(seedKindOf("tgt_usw2_a")).toBe("region-lake");
    expect(seedJobArguments("tgt_home", { datalakeBucket: "whatever" })).toEqual({});
    expect(seedJobArguments("tgt_usw2_a", { datalakeBucket: "lake-usw2" })).toEqual({ "--datalake": "lake-usw2" });
    // 🔴 描述符缺湖桶 ⇒ 拒绝启动(不许让作业写进它记着的另一个桶)
    expect(() => seedJobArguments("tgt_usw2_a", { datalakeBucket: "" })).toThrow(/datalakeBucket/);
    // 非法落点 ⇒ 抛(不许让坏值变成「查不到 = 主控区」)
    expect(() => seedJobNameFor("Bad-Id")).toThrow();
  });

  it("手动造数的台账对象 id:每区一个,可反解;别的 id 不会被认成它", () => {
    expect(seedRunTaskId("tgt_usw2_a")).toBe("seed_tgt_usw2_a");
    expect(isSeedRunTaskId("seed_tgt_usw2_a")).toBe(true);
    expect(targetOfSeedRunTaskId("seed_tgt_usw2_a")).toBe("tgt_usw2_a");
    for (const bad of ["seedsch_01ABC", "gov_01ABC", "seed_", "seed_Bad", "tgt_usw2_a"]) {
      expect(isSeedRunTaskId(bad), bad).toBe(false);
    }
  });
});
