// residency.ts —— 跨法域技术前置 / 项目白名单 / 法域格式(SPEC v3.22 §1.1 / §2.1 / §3.2 / §3.12;DESIGN §18 决策 6quinquies)。
import { describe, it, expect } from "vitest";
import {
  JURISDICTION_RE,
  accessAllows,
  accessDeniedReason,
  isCrossJurisdiction,
  jurisdictionOf,
  parseTargetAccess,
  residencyPrerequisite,
} from "@/lib/exec-env/residency";
import { expectedExecRoleName } from "@/lib/exec-env/exec-roles";

const ACCT = "123456789012";
const T3 = "tgt_euw1_a";
const per = (key: Parameters<typeof expectedExecRoleName>[1], tid = T3) => `arn:aws:iam::${ACCT}:role/${expectedExecRoleName(tid, key)}`;
const fullRoles = (tid = T3) => ({
  glueRoleArn: per("glueRoleArn", tid),
  emrExecutionRoleArn: per("emrExecutionRoleArn", tid),
  redshiftCopyRoleArn: per("redshiftCopyRoleArn", tid),
});

describe("法域格式 JURISDICTION_RE(SPEC §1.1 v3.22)", () => {
  it.each(["home", "eu-sim", "cn", "us-gov-west", "a1"])("合法:%s", (j) => expect(JURISDICTION_RE.test(j)).toBe(true));
  it.each(["Home", "HOME", "EU", "eu_sim", "-eu", "e", "", "eu sim", "x".repeat(33)])("非法:%j", (j) => expect(JURISDICTION_RE.test(j)).toBe(false));
  it("jurisdictionOf 缺省 home;非字符串 / 空串按 home", () => {
    expect(jurisdictionOf({})).toBe("home");
    expect(jurisdictionOf({ jurisdiction: "" })).toBe("home");
    expect(jurisdictionOf({ jurisdiction: 42 })).toBe("home");
    expect(jurisdictionOf({ jurisdiction: "eu-sim" })).toBe("eu-sim");
    expect(isCrossJurisdiction({ jurisdiction: "eu-sim" })).toBe(true);
    expect(isCrossJurisdiction({ jurisdiction: "home" })).toBe(false);
  });
});

describe("🔴 residencyPrerequisite:跨法域 target 的唯一技术前置(不设法务门)", () => {
  it("home 法域 ⇒ null(与此前完全一样,不多判任何东西)", () => {
    expect(residencyPrerequisite({ targetId: "tgt_usw2_a", jurisdiction: "home", components: ["core"], resources: {} })).toBeNull();
    expect(residencyPrerequisite({ targetId: "tgt_home", jurisdiction: "home", components: ["core"], resources: {} })).toBeNull();
  });
  it("🔴 跨法域未装 residency-api ⇒ 拒因指路「补充部署」(M-a 靶:删掉这一判 ⇒ 未装也 active)", () => {
    const r = residencyPrerequisite({ targetId: T3, jurisdiction: "eu-sim", components: ["core", "redshift"], resources: fullRoles() });
    expect(r).toMatch(/未装 residency-api/);
    expect(r).toMatch(/补充部署/);
  });
  it("🔴 跨法域缺 per-target 执行角色 ⇒ 拒因点名缺哪几个并指路「重新部署」(M-b 靶:hasPerTargetExecRoles 恒 true ⇒ 放行)", () => {
    const r = residencyPrerequisite({ targetId: T3, jurisdiction: "eu-sim", components: ["core", "redshift", "residency-api"], resources: { glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role` } });
    expect(r).toMatch(/缺 per-target 执行角色/);
    expect(r).toMatch(/glueRoleArn/);
    expect(r).toMatch(/emrExecutionRoleArn/);
    expect(r).toMatch(/redshiftCopyRoleArn/);
    expect(r).toMatch(/重新部署/);
  });
  it("跨法域 + 装了 residency-api + 角色齐 ⇒ null(与同法域同一条路,**没有**任何法务判定)", () => {
    expect(residencyPrerequisite({ targetId: T3, jurisdiction: "eu-sim", components: ["core", "redshift", "residency-api"], resources: fullRoles() })).toBeNull();
  });
  it("🔴 拒因文本里不出现法务定性(拍板负向 单测面)", () => {
    for (const r of [
      residencyPrerequisite({ targetId: T3, jurisdiction: "eu-sim", components: ["core"], resources: {} }),
      residencyPrerequisite({ targetId: T3, jurisdiction: "eu-sim", components: ["core", "residency-api"], resources: {} }),
    ]) {
      expect(r).not.toMatch(/法务|备案|担责|出境/);
    }
  });
});

describe("项目白名单 access(SPEC §3.12 v3.22,通用)", () => {
  it("缺省 / all-projects ⇒ 任何项目都放行(含无项目上下文)", () => {
    expect(accessAllows({}, "proj-a")).toBe(true);
    expect(accessAllows({}, undefined)).toBe(true);
    expect(accessAllows({ access: { mode: "all-projects" } }, null)).toBe(true);
  });
  it("allowlist ⇒ 只放名单内;缺项目上下文 ⇒ 拒(不许借缺省绕过);空名单 ⇒ 谁都不能绑", () => {
    const t = { access: { mode: "allowlist", projects: ["proj-a", "proj-b"] } };
    expect(accessAllows(t, "proj-a")).toBe(true);
    expect(accessAllows(t, "proj-c")).toBe(false);
    expect(accessAllows(t, undefined)).toBe(false);
    expect(accessAllows(t, "")).toBe(false);
    expect(accessAllows({ access: { mode: "allowlist", projects: [] } }, "proj-a")).toBe(false);
  });
  it("🔴 access 形态非法 ⇒ 拒(fail-closed:坏数据不当「全部项目」)", () => {
    expect(accessAllows({ access: { mode: "everyone" } }, "proj-a")).toBe(false);
    expect(accessAllows({ access: { mode: "allowlist", projects: "proj-a" } }, "proj-a")).toBe(false);
    expect(accessAllows({ access: "all" }, "proj-a")).toBe(false);
  });
  it("parseTargetAccess:归一(去重 / 排序 / trim);非法即抛", () => {
    expect(parseTargetAccess(undefined)).toEqual({ mode: "all-projects" });
    expect(parseTargetAccess({ mode: "allowlist", projects: [" b ", "a", "a"] })).toEqual({ mode: "allowlist", projects: ["a", "b"] });
    expect(() => parseTargetAccess({ mode: "allowlist", projects: ["", "a"] })).toThrow(/字符串数组/);
    expect(() => parseTargetAccess({ mode: "nope" })).toThrow(/只允许/);
    expect(() => parseTargetAccess("x")).toThrow(/须为对象/);
  });
  it("拒因指路管理员加白名单", () => {
    expect(accessDeniedReason({ targetId: T3 }, "proj-c")).toMatch(/未授权给项目 proj-c/);
    expect(accessDeniedReason({ targetId: T3 }, "proj-c")).toMatch(/授权项目/);
  });
});
