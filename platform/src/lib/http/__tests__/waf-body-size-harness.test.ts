/**
 * 边缘「请求体大小」规则的离线判据(`infra/test/waf-body-size/`)必须**真的在门禁里跑**(「写了」≠「接上了」)。
 *
 * 那份判据在**合成出来的模板**上判:托管通用规则集里按大小拦的那一条只计数、按标签拦的规则在样例请求上的求值
 * (页面 / 登录前接口拦,登录后的应用接口不拦,没有标签不拦)、优先级不撞号、OpenMetadata 那张 ACL 没被带上。
 * 同目录的跨层判据(`lib/genbi/__tests__/waf-large-body-guard.test.ts`)只读源码文本,看不到模板真正长什么样;
 * 没有这个替身,模板判据只有手工才会跑 —— 改坏防火墙栈时门禁照样绿。
 * 这里 spawn 真 bash 跑它(零凭证、不联网),并逐条点名它必须跑到的判据。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

describe("边缘请求体大小规则的模板判据(只计数 + 按标签拦 / 样例请求求值 / 优先级 / 另一张 ACL 不受影响)", () => {
  it("🔴 模板判据全过,且真的跑了每一条", () => {
    const r = spawnSync("bash", ["infra/test/waf-body-size/test_waf_body_size.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-2000)).toBe(0);
    expect(all).toContain("✅ 请求体大小规则判据全过");
    for (const needle of [
      "⓪ 两张 ACL 都在",
      "① 托管通用规则集:按大小拦的那一条改成只计数",
      "② 带标签拦的规则:动作是拦",
      "③ 优先级:整条放行的占 0..n-1 且都在预留区内",
      "④ OpenMetadata 那张 ACL 没有被带上大小规则",
    ]) {
      expect(all, `模板判据少跑了这条:${needle}`).toContain(`  ok  ${needle}`);
    }
    expect(all).not.toContain("✗");
    expect(all).not.toContain("❌");
  }, 180_000);
});
