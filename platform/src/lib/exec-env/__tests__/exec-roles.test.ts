// @kf-batch 50-W5-seg1-WP3
// exec-roles.ts —— 执行角色键三规则的单测(SPEC v3.21 §3.1a「执行角色键」)。
// 🔴 期望值**从命名 SSOT 派生**(resourceName),不手抄字面名:手抄一份 = 第二处定义,naming.json 一改这里就假绿/假红。
import { describe, it, expect } from "vitest";
import { resourceName } from "@/lib/aws/naming";
import {
  EXEC_ROLE_RESOURCE_KEYS,
  EXEC_ROLE_KIND_BY_KEY,
  assertPerTargetExecRole,
  execRoleRotationVerdict,
  execRoleVerdict,
  expectedExecRoleName,
  hasPerTargetExecRoles,
  homeExecRoleName,
  isExecRoleResourceKey,
  missingPerTargetExecRoles,
  requiredExecRoleKeys,
  roleNameOfArn,
} from "@/lib/exec-env/exec-roles";

const ACCT = "123456789012";
const USW2 = "tgt_usw2_a";
const arn = (name: string) => `arn:aws:iam::${ACCT}:role/${name}`;
const per = (key: (typeof EXEC_ROLE_RESOURCE_KEYS)[number]) => arn(expectedExecRoleName(USW2, key));
const home = (key: (typeof EXEC_ROLE_RESOURCE_KEYS)[number]) => arn(homeExecRoleName(key));

describe("键 ↔ kind ↔ 命名 SSOT", () => {
  it("四键各映射到一个已登记 kind;本 target 名带 slug、home 名是存量固定名", () => {
    for (const key of EXEC_ROLE_RESOURCE_KEYS) {
      const kind = EXEC_ROLE_KIND_BY_KEY[key];
      expect(expectedExecRoleName(USW2, key)).toBe(resourceName(kind, { targetId: USW2 }));
      expect(expectedExecRoleName(USW2, key)).toContain("tgt-usw2-a");
      expect(homeExecRoleName(key)).toBe(resourceName(kind, { targetId: "tgt_home" }));
      expect(homeExecRoleName(key)).not.toContain("tgt-usw2-a");
    }
    expect(expectedExecRoleName(USW2, "glueRoleArn")).toBe("BgpExecEnv-tgt-usw2-a-glue-role");
    expect(homeExecRoleName("glueRoleArn")).toBe("bgp-glue-role");
  });
  it("isExecRoleResourceKey 只认四键(flinkRoleArn / redshiftSecretArn 不是)", () => {
    for (const k of EXEC_ROLE_RESOURCE_KEYS) expect(isExecRoleResourceKey(k)).toBe(true);
    for (const k of ["flinkRoleArn", "redshiftSecretArn", "datalakeBucket", "", 42, undefined]) expect(isExecRoleResourceKey(k)).toBe(false);
  });
  it("roleNameOfArn:取 role/ 后最后一段;非 ARN / 非 role ARN ⇒ null", () => {
    expect(roleNameOfArn(arn("x-role"))).toBe("x-role");
    expect(roleNameOfArn(`arn:aws:iam::${ACCT}:role/path/sub/y-role`)).toBe("y-role");
    expect(roleNameOfArn(`arn:aws-cn:iam::${ACCT}:role/z`)).toBe("z");
    for (const bad of ["not-an-arn", `arn:aws:iam::${ACCT}:user/u`, `arn:aws:iam::${ACCT}:role/`, "", null, 1]) {
      expect(roleNameOfArn(bad), String(bad)).toBeNull();
    }
  });
});

describe("规则 ①:数据面解析 —— 非 home 必须是本 target 自己的角色", () => {
  it("本 target 名 ⇒ ok 回 ARN", () => {
    const t = { targetId: USW2, resources: { glueRoleArn: per("glueRoleArn") } };
    expect(execRoleVerdict(t, "glueRoleArn")).toEqual({ ok: true, arn: per("glueRoleArn") });
    expect(assertPerTargetExecRole(t, "glueRoleArn")).toBe(per("glueRoleArn"));
  });
  it("🔴 home 名(P50.2 存量形态)⇒ not-per-target 且拒因**指路**「重新部署」", () => {
    const t = { targetId: USW2, resources: { glueRoleArn: home("glueRoleArn") } };
    const v = execRoleVerdict(t, "glueRoleArn");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("not-per-target");
    expect(() => assertPerTargetExecRole(t, "glueRoleArn")).toThrow(/不是本 target 的 per-target 角色/);
    expect(() => assertPerTargetExecRole(t, "glueRoleArn")).toThrow(/重新部署/);
  });
  it("缺键 ⇒ missing 且指路;别的 target 的名 ⇒ not-per-target", () => {
    expect(execRoleVerdict({ targetId: USW2, resources: {} }, "emrExecutionRoleArn").ok).toBe(false);
    expect(() => assertPerTargetExecRole({ targetId: USW2, resources: {} }, "emrExecutionRoleArn")).toThrow(/缺 resources\.emrExecutionRoleArn/);
    const other = { targetId: USW2, resources: { emrExecutionRoleArn: arn(expectedExecRoleName("tgt_euw1_b", "emrExecutionRoleArn")) } };
    expect(() => assertPerTargetExecRole(other, "emrExecutionRoleArn")).toThrow(/不是本 target 的 per-target 角色/);
  });
  it("home 恒 ok(home 走 env,本函数不管 home 的值)", () => {
    expect(execRoleVerdict({ targetId: "tgt_home", resources: {} }, "glueRoleArn").ok).toBe(true);
    expect(execRoleVerdict({ targetId: "tgt_home", resources: { glueRoleArn: home("glueRoleArn") } }, "glueRoleArn")).toEqual({ ok: true, arn: home("glueRoleArn") });
  });
});

describe("规则 ②:补充部署窄通道的唯一例外 —— 新增 / home → 本 target 单向切换", () => {
  it("前值不存在 ∧ 新值 = 本 target 名 ⇒ add", () => {
    expect(execRoleRotationVerdict(USW2, "emrExecutionRoleArn", undefined, per("emrExecutionRoleArn"))).toBe("add");
    expect(execRoleRotationVerdict(USW2, "redshiftCopyRoleArn", null, per("redshiftCopyRoleArn"))).toBe("add");
  });
  it("前值 = home 名 ∧ 新值 = 本 target 名 ⇒ rotate", () => {
    expect(execRoleRotationVerdict(USW2, "glueRoleArn", home("glueRoleArn"), per("glueRoleArn"))).toBe("rotate");
  });
  it.each([
    ["切成别的 target 的名", home("glueRoleArn"), arn(expectedExecRoleName("tgt_euw1_b", "glueRoleArn"))],
    ["切回 home 名", per("glueRoleArn"), home("glueRoleArn")],
    ["本 target 名 → 别的 target 名", per("glueRoleArn"), arn(expectedExecRoleName("tgt_euw1_b", "glueRoleArn"))],
    ["前值是随便一个角色(非 home 名)→ 本 target 名", arn("someone-else"), per("glueRoleArn")],
    ["新值不是 ARN", home("glueRoleArn"), "BgpExecEnv-tgt-usw2-a-glue-role"],
    // 别账号用红线白名单里的占位号 000000000000(≠ ACCT);任何别的 12 位数字都会被 redline-scan 当真账号号拦下 commit
    ["新值是别账号的本 target 名", home("glueRoleArn"), `arn:aws:iam::000000000000:role/${expectedExecRoleName(USW2, "glueRoleArn")}`],
  ])("🔴 %s ⇒ null(拒)", (_n, before, after) => {
    // 别账号那条:角色名对、账号不对 —— 名字判定放行,由 §3.1a 资源归属校验(账号段)在 post-image 拒;这里只断名字规则
    const v = execRoleRotationVerdict(USW2, "glueRoleArn", before, after);
    if (_n.startsWith("新值是别账号")) expect(v).toBe("rotate");
    else expect(v).toBeNull();
  });
  it("🔴 home target 一律 null(home 的执行角色走 env、seed 不动)", () => {
    expect(execRoleRotationVerdict("tgt_home", "glueRoleArn", undefined, home("glueRoleArn"))).toBeNull();
    expect(execRoleRotationVerdict("tgt_home", "emrExecutionRoleArn", undefined, arn("bgp-emr-serverless-role"))).toBeNull();
  });
});

describe("规则 ③ 的判据:missingPerTargetExecRoles / hasPerTargetExecRoles(WP-10a 接进准入)", () => {
  it("要哪些键随组件:core 两键恒需;redshift / dms 各加一键", () => {
    expect(requiredExecRoleKeys(["core"])).toEqual(["glueRoleArn", "emrExecutionRoleArn"]);
    expect(requiredExecRoleKeys(["core", "redshift"])).toEqual(["glueRoleArn", "emrExecutionRoleArn", "redshiftCopyRoleArn"]);
    expect(requiredExecRoleKeys(["core", "redshift", "dms", "flink"])).toEqual([...EXEC_ROLE_RESOURCE_KEYS]);
    expect(requiredExecRoleKeys(undefined)).toEqual(["glueRoleArn", "emrExecutionRoleArn"]);
  });
  it("存量 usw2(glue 是 home 名、其余缺)⇒ 全部算缺;切换后 ⇒ 无缺", () => {
    const legacy = { targetId: USW2, components: ["core", "redshift", "dms", "flink"], resources: { glueRoleArn: home("glueRoleArn") } };
    expect(missingPerTargetExecRoles(legacy)).toEqual([...EXEC_ROLE_RESOURCE_KEYS]);
    expect(hasPerTargetExecRoles(legacy)).toBe(false);
    const rotated = {
      targetId: USW2,
      components: ["core", "redshift", "dms", "flink"],
      resources: Object.fromEntries(EXEC_ROLE_RESOURCE_KEYS.map((k) => [k, per(k)])),
    };
    expect(missingPerTargetExecRoles(rotated)).toEqual([]);
    expect(hasPerTargetExecRoles(rotated)).toBe(true);
  });
  it("只装 core 的 target 不要求 copy / dms 角色;home 恒不缺", () => {
    const coreOnly = { targetId: USW2, components: ["core"], resources: { glueRoleArn: per("glueRoleArn"), emrExecutionRoleArn: per("emrExecutionRoleArn") } };
    expect(missingPerTargetExecRoles(coreOnly)).toEqual([]);
    expect(missingPerTargetExecRoles({ targetId: "tgt_home", components: ["core", "redshift"], resources: {} })).toEqual([]);
  });
});
