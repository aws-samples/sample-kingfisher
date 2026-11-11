/**
 * `scripts/11-seed-demo-memberships.sh` 的离线替身必须**真的在门禁里跑**(「写了」≠「接上了」)。
 *
 * 🔴 为什么:demo 模式建出的四个演示角色账号此前从不拿到任何项目成员资格,服务端又没有隐式成员 ⇒ 登得进去、处处 403
 *   「无权访问该项目空间」(2026-11-10 测试账号页面驱动段真撞)。补齐这一步只在真部署机上执行(deploy-all 11.6 / redeploy-platform 3d),
 *   台账 infra/prod-only-layers.json 指向 infra/test/demo-memberships/test_seed_demo_memberships.sh —— 指针对不等于替身在跑。
 *   这里 spawn 真 bash 跑替身(假 aws / curl,零凭证),逐条点名它必须覆盖的护栏与结果。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

describe("11-seed-demo-memberships.sh 离线替身(模式护栏 · 幂等补齐 · --check 三态 · 口令卫生)", () => {
  it("🔴 替身全过,且真的跑了:production 零写入 / 冲突拒绝 / 只补缺的 / 请求体逐字 / 收口核对 / 口令与令牌不进输出与命令行", () => {
    const r = spawnSync("bash", ["infra/test/demo-memberships/test_seed_demo_memberships.sh"], { cwd: REPO, encoding: "utf8" });
    const all = `${r.stdout || ""}${r.stderr || ""}`;
    expect(r.status, all.slice(-2000)).toBe(0);
    expect(all).toContain("✅ demo-memberships 离线判据全过");
    for (const needle of [
      "C1 报「用法错误」",
      "C2 说「不造演示成员」",
      "C2 一次 curl 都没发",
      "C3 报「拒绝」",
      "C4 POST 恰 4 次",
      "C4 请求体 pm-tester=owner 逐字",
      "C4 请求体 ops-analyst=viewer 逐字",
      "C4 口令不进输出",
      "C4 令牌不进输出",
      "C4 口令不进 aws 命令行",
      "C5 不碰 ops-analyst(角色 editor 不被盖回 viewer)",
      "C6 报「拿不到 admin 口令」+ 补跑法",
      "C6b 口令取自落盘文件 ⇒ exit 0",
      "C6c 报「IdToken 失败」并指路改口令",
      "C7b 点名「缺:biz-tester」",
      "C7c 读不到表 ⇒ exit 2(读不到 ≠ 齐)",
      "C7 --check 没去取令牌",
      "C8 点名 rbac-tester 加入失败",
      "C8b 报「六次都不成功」",
      "C9 名册 ⊆ 10-bootstrap USERS 且角色闭合",
      "C9 默认空间 id 与 constants.ts 同字面",
      "C9 成员表名与 dynamodb.ts 同字面",
      "C10 deploy-all 调用",
      "C10 redeploy-platform 调用",
      "C10 真就位第 12 条 --check",
    ]) {
      expect(all, `替身少跑了这条:${needle}`).toContain(`ok  ${needle}`);
    }
    expect(all).not.toContain("❌");
  }, 120_000);
});
