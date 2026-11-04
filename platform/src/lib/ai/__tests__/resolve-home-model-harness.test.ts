/**
 * @kf-batch 51-v2-multi-vendor(序 40,2026-10-14):`scripts/resolve-home-model.sh` 的离线替身必须**真的在门禁里跑**。
 *
 * 🔴 为什么:台账 infra/prod-only-layers.json 里它早就有 harness 指针(infra/test/resolve-model/test_resolve_model.sh),
 *   但此前没有任何 vitest 执行它 —— 指针对不等于替身在跑(「写了」≠「接上了」)。本波把候选链(D14)加进脚本,
 *   替身也随之改写(⑥⑦⑧⑨ 新增);这里 spawn 真 bash 跑它,逐条点名。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

describe("resolve-home-model.sh 离线替身(候选链 + 真值反推基础模型)", () => {
  it("🔴 替身全过,且真的跑了 ①–⑩", () => {
    const r = spawnSync("bash", ["infra/test/resolve-model/test_resolve_model.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-1600)).toBe(0);
    expect(all).toContain("✅ 主控区模型解析判据全过");
    for (const needle of [
      "① 本区地理配置优先",
      "② 本区配置调不通 ⇒ global.",
      "③ 全链调不通 ⇒ 非零退出、stdout 空",
      "③ 第二候选(glm-5.3)的展开与账号级原话列出",
      "④ 候选只有指向该基础模型且 ACTIVE 的",
      "⑤ 列配置被拒 ⇒ 按形态剥前缀仍试基础模型",
      "⑥ 候选链:glm-5.3 账号级被拒 ⇒ 落到第二候选的本区推理配置",
      "⑥ 调用顺序:eu.zai → global.zai → zai 裸 id → eu.kimi(成功即停)",
      "⑦ env 覆盖候选链时 stderr 标明「候选来自 env」",
      "⑧ 候选本身是本区推理配置 id ⇒ 先试它本身",
      "⑨ 脚本里没有厂商正则",
      "⑩ 01-preflight 第 7 项改调解析器",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(`ok  ${needle}`);
    }
    expect(all).not.toContain("❌");
  }, 120_000);
});
