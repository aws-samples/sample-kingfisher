/**
 * `scripts/cut-release.sh` 的离线替身必须**真的在门禁里跑**(「写了」≠「接上了」)。
 *
 * 🔴 为什么:切版本只在发版机上手工跑一次(改 VERSION / CHANGELOG ⇒ 提交 ⇒ 分支 ⇒ 注解 tag ⇒ 推送 ⇒ 交付包 ⇒ GitHub Release),
 *   跑错的后果是「tag 推了、Release 没建」「发版说明为空」「版本号三处不一致」,而真仓库上没法反复排练。
 *   台账 infra/prod-only-layers.json 指向 infra/test/cut-release/test_cut_release.sh —— 指针对不等于替身在跑。
 *   这里 spawn 真 bash 跑替身:它在合成 git 仓库(裸仓当 origin、硬门章 pass @ HEAD)里真跑脚本,gh / curl 走 PATH 替身,
 *   零凭证、不联网;逐条点名它必须覆盖的拒绝路径、演练、真切与 Release 正文判据。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..");

describe("cut-release.sh 离线替身(用法 / 工具前置 / 演练 / 真切 + Release / 推后失败 / 硬门拒绝)", () => {
  it("🔴 替身全过,且真的跑了每一组判据", () => {
    const r = spawnSync("bash", ["infra/test/cut-release/test_cut_release.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-2000)).toBe(0);
    expect(all).toContain("✅ cut-release 离线判据全过");
    for (const needle of [
      "① 漏传版本号 ⇒ 拒",
      "① 未知参数 ⇒ 拒",
      "② 没装 gh ⇒ 拒",
      "② gh 未登录 ⇒ 拒",
      "② GitHub 已有 Release v0.2.0 ⇒ 拒",
      "③ 演练结束语",
      "④ 真切退出码(0)",
      "④ 远端 tag v0.2.0 已推且指向新提交",
      "④ sha256sum -c 核验通过",
      "④ 交付包 BUILD-INFO.json 记着 tag v0.2.0",
      "④ gh 参数:--verify-tag",
      "④ 正文第一行 = CHANGELOG 段首行",
      "④ 正文不含旧版条目",
      "④ 正文里的 sha256 = .sha256 文件里的值",
      "④ 同一版本再切一次 ⇒ 拒",
      "⑤ 没调 gh",
      "⑥ 如实报告 tag 已推、Release 未建",
      "⑥ 给出重试命令 gh release create v0.3.0",
      "⑦ 章 result=fail ⇒ 拒",
      "⑦ 章后产品字节有差 ⇒ 拒",
      "⑦ 章后只有 docs 笔 ⇒ 允许",
      "⑦ [Unreleased] 段为空 ⇒ 拒",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(`✅ ${needle}`);
    }
    expect(all).not.toContain("❌");
  }, 120_000);
});
