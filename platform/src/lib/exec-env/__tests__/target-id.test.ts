// G1—— targetId/targetSlug 契约单测。
//
// 【为什么必须有这个测试】外部审核 P1-6 抓到"targetId 合同自撞且**无资源长度预算**":
// SPEC 原写 `^tgt_[a-z0-9_]{1,40}$`(总长 44),而 `bgp-redshift-copy-role-` + 44 = 67
// **超过 IAM RoleName 的 64**。这种缺陷的可怕之处在于:它**不在写代码时报错**,而是等到
// 某个客户建了一个名字略长的 target、部署到某个组件时才炸,且报错在 CFN 里、离根因很远。
//
// 所以本测试不只断"格式对不对",而是把**长度预算本身**变成可执行不变量:
//   ① `TARGET_ID_MAX_LEN` 必须 ≤ 全部出口共同允许的上限;
//   ② 预算表里的 `prefixLen` 必须**与 infra 里真实的资源名字面量一致** —— 否则有人把
//      `bgp-workgroup` 改成更长的名字,预算表就悄悄失真了,而这里会立刻红。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  HOME_TARGET_ID,
  HOME_TARGET_SLUG,
  TARGET_ID_BODY_MAX,
  TARGET_ID_MAX_LEN,
  PER_TARGET_NAME_BUDGETS,
  allowedTargetIdLenFor,
  maxAllowedTargetIdLen,
  tightestNameBudgets,
  isValidTargetId,
  assertTargetId,
  isHome,
  toTargetSlug,
  fromTargetSlug,
  isDnsLabel,
  isS3BucketName,
  isCfnStackName,
} from "@/lib/exec-env/target-id";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../.."); // .../__tests__ → exec-env → lib → src → platform → 仓根
const INFRA_LIB = resolve(REPO, "infra/lib");

/** 把 infra/lib 下所有 .ts 拼成一大坨,用来核"资源名字面量还在不在"。 */
function infraLibSource(): string {
  const files = readdirSync(INFRA_LIB).filter((f) => f.endsWith(".ts"));
  expect(files.length, `读不到 infra/lib(REPO 解析成了 ${REPO}?)`).toBeGreaterThan(5);
  return files.map((f) => readFileSync(resolve(INFRA_LIB, f), "utf8")).join("\n");
}

const ACCOUNT_ID_LEN = 12; // AWS 账号号固定 12 位

describe("targetId 格式(SPEC §1.1a)", () => {
  it("接受合法形态,含 SPEC 里的两个示例", () => {
    for (const ok of ["tgt_home", "tgt_usw2_a", "tgt_euw1_prod", "tgt_a", "tgt_" + "a".repeat(TARGET_ID_BODY_MAX)]) {
      expect(isValidTargetId(ok), `${ok} 应合法`).toBe(true);
    }
  });

  it("拒绝每一类非法形态(每条都对应一个真实事故面)", () => {
    const bad: Array<[string, unknown]> = [
      ["缺前缀", "usw2_a"],
      ["空正文", "tgt_"],
      ["含 '#'(会破坏复合 runId 的分隔,SPEC §1.2)", "tgt_us#a"],
      ["含 '-'(会破坏 slug 的可逆映射)", "tgt_us-a"],
      ["含大写(多处 sanitize 会折叠大小写 → 撞名)", "tgt_USW2"],
      ["含点(进不了 DNS/证书 SAN)", "tgt_us.a"],
      ["超长(正文 > 上限)", "tgt_" + "a".repeat(TARGET_ID_BODY_MAX + 1)],
      ["非字符串", 123],
      ["null", null],
      ["undefined", undefined],
      // 🔴 v3.4 新增(外部审核 v2 P1-2 的两个实测反例):正文首尾必须 alnum。
      // 旧正则放行它们,而它们的 slug(`tgt-a-` / `tgt--`)**不是合法 DNS label**,
      // 会拖到"建 ACM 证书 / APIGW 自定义域名"那一步才炸。
      ["正文以 '_' 结尾 → slug 以 '-' 结尾 = 非法 DNS label", "tgt_a_"],
      ["正文全是 '_' → slug 全是 '-'", "tgt__"],
      ["正文以 '_' 开头(slug 以 '-' 开头,DNS label 同样非法)", "tgt__a"],
    ];
    for (const [why, v] of bad) {
      expect(isValidTargetId(v), `应拒绝:${why}`).toBe(false);
      expect(() => assertTargetId(v), `assertTargetId 应抛:${why}`).toThrow();
    }
  });

  it("'_' 在正文**内部**仍然合法(别把订正做过头,SPEC 示例就靠它)", () => {
    for (const ok of ["tgt_usw2_a", "tgt_a_b_c", "tgt_euw1_prod"]) {
      expect(isValidTargetId(ok), `${ok} 应仍合法`).toBe(true);
    }
  });

  it("assertTargetId 的报错要说清要求(否则调用方只看到'非法'不知道改什么)", () => {
    expect(() => assertTargetId("tgt_BAD")).toThrow(/tgt_\[a-z0-9\]/);
    expect(() => assertTargetId("tgt_a_"), "首尾约束必须写进报错,否则改不对").toThrow(/首尾必须/);
  });
});

describe("isHome —— 只认字面 tgt_home(修 P0-4 那类 fail-open)", () => {
  it("字面 tgt_home 为真,字符串与对象两种入参都支持", () => {
    expect(isHome(HOME_TARGET_ID)).toBe(true);
    expect(isHome({ targetId: HOME_TARGET_ID })).toBe(true);
  });

  it("🔴 缺失/空/未知一律 false —— 绝不把'没传'当 home(那等于跨法域静默回落)", () => {
    for (const v of [undefined, null, "", "tgt_eu1", { targetId: "tgt_eu1" }, {}, "home", "TGT_HOME"]) {
      expect(isHome(v as never), `${JSON.stringify(v)} 不该被当成 home`).toBe(false);
    }
  });
});

describe("targetSlug 映射(禁 `_` 的出口专用)", () => {
  it("往返可逆(可逆的前提就是 targetId 禁 '-')", () => {
    for (const id of ["tgt_home", "tgt_usw2_a", "tgt_euw1_prod", "tgt_x"]) {
      const slug = toTargetSlug(id);
      expect(slug).not.toContain("_");
      expect(fromTargetSlug(slug)).toBe(id);
    }
  });

  it("HOME_TARGET_SLUG 与函数结果一致(常量别写歪)", () => {
    expect(HOME_TARGET_SLUG).toBe(toTargetSlug(HOME_TARGET_ID));
    expect(HOME_TARGET_SLUG).toBe("tgt-home");
  });

  it("slug 与 id 长度相同(逐字符替换,不改长度 ⇒ 预算对二者同时成立)", () => {
    const longest = "tgt_" + "a".repeat(TARGET_ID_BODY_MAX);
    expect(toTargetSlug(longest).length).toBe(longest.length);
    expect(longest.length).toBe(TARGET_ID_MAX_LEN);
  });

  it("拒绝非法 slug,不做静默兜底", () => {
    for (const bad of ["tgt_home", "tgt-HOME", "usw2-a", "tgt-"]) {
      expect(() => fromTargetSlug(bad), `应拒绝 ${bad}`).toThrow();
    }
  });
});

describe("🔴 资源名长度预算(外部审核 P1-6)——把算术变成可执行不变量", () => {
  it("TARGET_ID_MAX_LEN 必须 ≤ 全部出口共同允许的上限", () => {
    const max = maxAllowedTargetIdLen();
    const tightest = tightestNameBudgets().map((b) => `${b.kind}(≤${allowedTargetIdLenFor(b)})`);
    expect(
      TARGET_ID_MAX_LEN,
      `targetId 上限 ${TARGET_ID_MAX_LEN} 超过了最紧出口允许的 ${max}。最紧出口:${tightest.join(", ")}。` +
        `要么调小 TARGET_ID_BODY_MAX,要么改短那个资源名前缀。`
    ).toBeLessThanOrEqual(max);
  });

  it("审核原话那条要成立:`bgp-redshift-copy-role-` + 最长 targetId ≤ IAM 的 64", () => {
    // 审核指出 44 + 23 = 67 > 64。用当前上限重算必须过。
    const prefix = "bgp-redshift-copy-role-";
    expect(prefix.length + TARGET_ID_MAX_LEN).toBeLessThanOrEqual(64);
  });

  it("每个出口都留了 cell 后缀余量(同 region 第二个 target 不会撞名)", () => {
    for (const b of PER_TARGET_NAME_BUDGETS) {
      expect(b.suffixReserve, `${b.kind} 没留后缀余量`).toBeGreaterThan(0);
      expect(allowedTargetIdLenFor(b), `${b.kind} 预算已为负,说明前缀本身就超了`).toBeGreaterThan(0);
    }
  });

  it("预算表不许为空、且新增 per-target 资源必须登记(数量下界钉住)", () => {
    expect(PER_TARGET_NAME_BUDGETS.length).toBeGreaterThanOrEqual(5);
    const kinds = PER_TARGET_NAME_BUDGETS.map((b) => b.kind);
    expect(new Set(kinds).size, "预算表里有重复 kind").toBe(kinds.length);
  });
});

describe("🔴 出口形态(v3.4;外部审核 v2 P1-2:'预算测试应再覆盖 DNS label / S3 名称,而不只是长度算术')", () => {
  // 为什么要这层:长度算术只能证明"塞得进去",不能证明"塞进去以后名字合法"。
  // `tgt_a_` 长度完全够,但生成的 `tgt-a-` 在 DNS/ACM 出口是非法的 —— 这正是审核抓到的那条。
  const samples = ["tgt_home", "tgt_a", "tgt_usw2_a", "tgt_euw1_prod", "tgt_" + "a".repeat(TARGET_ID_BODY_MAX)];
  const ACCOUNT = "0".repeat(ACCOUNT_ID_LEN); // 不用 12 位数字字面量:红线扫描会当成真账号号拦下

  it("每个合法 targetId 的 slug 都必须是合法 DNS label(DNS / ACM / APIGW 出口)", () => {
    for (const id of samples) {
      const slug = toTargetSlug(id);
      expect(isDnsLabel(slug), `${id} → ${slug} 不是合法 DNS label`).toBe(true);
    }
  });

  it("S3 出口:`bgp-glue-scripts-<账号>-<slug>` 必须是合法桶名(长度 + 字符形态一起过)", () => {
    for (const id of samples) {
      const name = `bgp-glue-scripts-${ACCOUNT}-${toTargetSlug(id)}`;
      expect(name.length, `${name} 超过 S3 的 63`).toBeLessThanOrEqual(63);
      expect(isS3BucketName(name), `${name} 不是合法 S3 桶名`).toBe(true);
    }
  });

  it("CFN 出口:`BgpExecEnv-<slug>-<组件段>` 必须是合法栈名", () => {
    for (const id of samples) {
      const name = `BgpExecEnv-${toTargetSlug(id)}-redshift-writer`;
      expect(name.length, `${name} 超过 CFN 的 128`).toBeLessThanOrEqual(128);
      expect(isCfnStackName(name), `${name} 不是合法 CFN 栈名`).toBe(true);
    }
  });

  it("🔴 toTargetSlug 自己带 DNS 断言(万一以后有人放宽 TARGET_ID_RE,炸点要落在这里)", () => {
    // 直接验断言存在:非法 id 进去必须抛,而不是安静地吐一个坏 slug。
    expect(() => toTargetSlug("tgt_a_")).toThrow();
    expect(() => toTargetSlug("tgt-a")).toThrow(); // 含 '-' 的 id 本身非法
  });
});

describe("🔴 防预算失真:prefixLen 必须与 infra 里真实的资源名字面量一致", () => {
  // 为什么要这层:预算表里的数字是"当时量出来的"。只要有人把资源名改长(哪怕加两个字母),
  // 预算就悄悄失真,而且**不会有任何地方报错**——直到某个客户建了长名字 target 才炸。
  const src = infraLibSource();

  it("s3-bucket:`bgp-glue-scripts-${accountId}` 仍在,且长度=预算里的 prefixLen", () => {
    const base = "bgp-glue-scripts-";
    expect(src, "infra 里已找不到该桶名字面量(改名了?请同步预算表)").toContain(base);
    const budget = PER_TARGET_NAME_BUDGETS.find((b) => b.kind === "s3-bucket")!;
    expect(base.length + ACCOUNT_ID_LEN).toBe(budget.prefixLen);
  });

  it("iam-role-name:`bgp-paramadvisor-runtime-role` 仍在,且长度=预算里的 prefixLen", () => {
    const name = "bgp-paramadvisor-runtime-role";
    expect(src, "infra 里已找不到该角色名字面量(改名了?请同步预算表)").toContain(name);
    const budget = PER_TARGET_NAME_BUDGETS.find((b) => b.kind === "iam-role-name")!;
    expect(name.length).toBe(budget.prefixLen);
  });

  it("redshift-workgroup:`bgp-workgroup` 仍在,且长度=预算里的 prefixLen", () => {
    const name = "bgp-workgroup";
    expect(src).toContain(name);
    const budget = PER_TARGET_NAME_BUDGETS.find((b) => b.kind === "redshift-workgroup")!;
    expect(name.length).toBe(budget.prefixLen);
  });

  it("mwaa-environment:`bgp-mwaa` 仍在,且长度=预算里的 prefixLen", () => {
    const name = "bgp-mwaa";
    expect(src).toContain(name);
    const budget = PER_TARGET_NAME_BUDGETS.find((b) => b.kind === "mwaa-environment")!;
    expect(name.length).toBe(budget.prefixLen);
  });

  it("🔴 infra 里没有比预算表更长的 per-target 角色基名(否则 iam 预算是假的)", () => {
    // 扫出所有 roleName: "bgp-…" 字面量,取最长,和预算表比。
    const found = [...src.matchAll(/roleName:\s*["'`](bgp-[a-z0-9-]+)["'`]/g)].map((m) => m[1]);
    expect(found.length, "一个 roleName 字面量都没扫到,正则可能失效了").toBeGreaterThan(0);
    const longest = found.reduce((a, b) => (b.length > a.length ? b : a));
    const budget = PER_TARGET_NAME_BUDGETS.find((b) => b.kind === "iam-role-name")!;
    expect(
      longest.length,
      `infra 里最长的角色基名是 ${longest}(${longest.length}),超过预算表登记的 ${budget.prefixLen}。` +
        `请更新 PER_TARGET_NAME_BUDGETS 的 iam-role-name.prefixLen 并重跑本测试。`
    ).toBeLessThanOrEqual(budget.prefixLen);
  });
});
