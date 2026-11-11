// scripts/10-bootstrap-cognito.sh 的初始用户名单必须跟随部署模式(与 infra/lib/shared/deploy-mode.ts 的
// rosterForMode 同一条规则):production / 缺省 ⇒ 只建 admin;demo ⇒ 五个。把脚本里「名册 → resolve_deploy_mode → 裁剪」
// 这一段**原样切出来**用 bash 真跑。裁剪读的是 resolve_deploy_mode 的结果(SSM /bgp/deploy-mode 优先),
// 这里用 aws 函数桩让 SSM 恒读不到 ⇒ 走 env 缺省分支;SSM 优先 / 冲突拒绝两条分支由 infra/test/cognito-mode-guard 钉。
// resolve_deploy_mode 的本体在 scripts/lib/deploy-mode.sh(单一作者,脚本 source 它),切片前先 source 同一份。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPTS = resolve(__dirname, "../../../../../scripts");
const script = readFileSync(resolve(SCRIPTS, "10-bootstrap-cognito.sh"), "utf8");
// 函数本体按**内容**拼进片段(不是把路径拼进 shell 命令:路径进命令行会被静态分析判成不受控的绝对路径)
const libSrc = readFileSync(resolve(SCRIPTS, "lib/deploy-mode.sh"), "utf8");
const sourcesLib = script.includes('source "$HERE/lib/deploy-mode.sh"');
const lines = script.split("\n");
const i = lines.findIndex((l) => l.startsWith("USERS=("));
const j = lines.findIndex((l, k) => k > i && /^if \[ "\$DEPLOY_MODE" != "demo" \]; then USERS=\(admin\); fi$/.test(l));
const callsResolver = lines.slice(i, j + 1).some((l) => l.startsWith('DEPLOY_MODE="$(resolve_deploy_mode)"'));

function usersFor(mode: string | null): string[] {
  // aws 桩:SSM 读不到(非 0 退出、无输出)⇒ 脚本按 env 缺省 production;PROFILE / REGION 只为让 resolve_deploy_mode 的引用有值
  const snippet = `aws() { return 1; }\nPROFILE=x; REGION=x\n${libSrc}\n${lines.slice(i, j + 1).join("\n")}\necho "\${USERS[@]}"`;
  const env: Record<string, string> = { PATH: process.env.PATH || "/usr/bin:/bin" };
  if (mode !== null) env.BGP_DEPLOY_MODE = mode;
  return execFileSync("bash", ["-c", snippet], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/);
}

describe("初始用户名单跟随部署模式(bash 真执行)", () => {
  it("切得到名册与裁剪这两行,且裁剪前确实调了 resolve_deploy_mode(判据不许假绿)", () => {
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(callsResolver).toBe(true);
    expect(sourcesLib, "脚本必须 source scripts/lib/deploy-mode.sh(函数单一作者)").toBe(true);
  });
  it("缺省 ⇒ 只有 admin", () => expect(usersFor(null)).toEqual(["admin"]));
  it("production ⇒ 只有 admin", () => expect(usersFor("production")).toEqual(["admin"]));
  it("正控制:demo ⇒ 五个", () => expect(usersFor("demo")).toEqual(["admin", "pm-tester", "rbac-tester", "ops-analyst", "biz-tester"]));
});
