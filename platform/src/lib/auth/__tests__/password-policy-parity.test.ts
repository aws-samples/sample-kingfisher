// @kf-batch 50-PROD-A-launch-hardening
// 页面「修改密码」的前端预校验必须与用户池策略同口径:读 infra/lib/auth-stack.ts 的 passwordPolicy 逐项比。
// 任何一侧改了另一侧没改 ⇒ 这里红(前端放行而 Cognito 拒 / 前端拒掉合法密码,两种都是用户可见的错)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { passwordPolicyError, PASSWORD_MIN_LENGTH } from "@/lib/auth/password-policy";

const stack = readFileSync(resolve(__dirname, "../../../../../infra/lib/auth-stack.ts"), "utf8");
const block = (stack.match(/passwordPolicy:\s*\{([\s\S]*?)\}/) || [])[1] || "";

describe("密码策略:前端预校验 == 用户池策略", () => {
  it("用户池策略块读得到(判据不许假绿)", () => {
    expect(block).toContain("minLength");
  });
  it("最小长度一致", () => {
    expect(Number((block.match(/minLength:\s*(\d+)/) || [])[1])).toBe(PASSWORD_MIN_LENGTH);
  });
  it.each([
    ["requireLowercase", "ABCDEFGHIJ1!", "需包含小写字母"],
    ["requireUppercase", "abcdefghij1!", "需包含大写字母"],
    ["requireDigits", "Abcdefghijk!", "需包含数字"],
    ["requireSymbols", "Abcdefghijk1", "需包含符号"],
  ])("%s:用户池要求 ⇔ 前端拒缺它的密码", (key, pw, err) => {
    const required = new RegExp(`${key}:\\s*true`).test(block);
    expect(required, `${key} 在用户池里不是 true —— 前端却在要求它`).toBe(true);
    expect(passwordPolicyError(pw)).toBe(err);
  });
  it("正控制:符合全部要求 ⇒ 放行", () => {
    expect(passwordPolicyError("Abcdefghij1!")).toBeNull();
    expect(passwordPolicyError("Ab1!")).toMatch(/至少/);
  });
});
