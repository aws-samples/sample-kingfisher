/**
 * 序 39 B-76(2026-10-14):`scripts/redeploy-agents.sh` 的离线替身必须**真的在门禁里跑**(「写了」≠「接上了」)。
 *
 * 🔴 为什么:它是升级客户环境前要跑的那条路(`--check` 决定要不要刷智能体镜像),而它只在真部署机上执行;
 *   台账 infra/prod-only-layers.json 指向 infra/test/redeploy-agents/test_redeploy_agents.sh —— 指针对不等于替身在跑。
 *   这里 spawn 真 bash 跑替身(假 aws / docker / npx,零凭证),逐条点名它必须覆盖的三态与前置校验。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

describe("redeploy-agents.sh 离线替身(--check 三态 + 前置校验)", () => {
  it("🔴 替身全过,且真的跑了:旗标当 profile / 漏参 / 凭证坏 / 读不到 ≠ 一致 ≠ 需要刷新 / 模式不许中途换 / --only 过滤", () => {
    const r = spawnSync("bash", ["infra/test/redeploy-agents/test_redeploy_agents.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-1600)).toBe(0);
    expect(all).toContain("✅ redeploy-agents 离线判据全过");
    for (const needle of [
      "C1 报「用法错误」",
      "C2 报「必须显式给」",
      "C3 报「凭证不可用」",
      "C3 凭证坏时不许误诊成栈没建",
      "C4 每个智能体说「读不到」",
      "C4 「读不到」≠「一致」",
      "C5 结论=不用刷",
      "C6 说「本机没有提交」",
      "C8 报「拒绝中途换模式」",
      "C9 报「未知智能体」",
      "C10 只核 1 个智能体",
      "C10 假 docker / npx 一次都没被碰",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(`ok  ${needle}`);
    }
    expect(all).not.toContain("❌");
  }, 120_000);
});
