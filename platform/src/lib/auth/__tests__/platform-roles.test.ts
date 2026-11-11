// 用户管理页的「平台角色」= 四个真实平台组 + 「无平台组」,角色 ↔ 组只在 lib/auth/groups.ts 一处定义。
//   2026-11-09 用户指南取证核到:页面 / 路由只认 Admin / Developer / Viewer,「Viewer」被建进四组之外的 bgp-viewer(没有任何守卫认它),
//   bgp-manager / bgp-analyst 的账号被显示成「Viewer」,在页面改一次角色就把 manager / analyst 组摘掉。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PLATFORM_ROLES, PLATFORM_ROLE_GROUP, PLATFORM_ROLE_LABEL, PLATFORM_GROUPS, LEGACY_VIEWER_GROUP,
  PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP, ANALYST_GROUP, isPlatformRole, roleFromGroups,
} from "@/lib/auth/groups";
import { isAnalystOnly } from "@/lib/auth/roles";
import { EN } from "@/lib/i18n/messages/en";

const SRC = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

describe("平台角色闭合清单与组映射(单一作者)", () => {
  it("五个角色:四个真实平台组 + None;组名与组常量同字面", () => {
    expect([...PLATFORM_ROLES]).toEqual(["Admin", "Manager", "Developer", "Analyst", "None"]);
    expect(PLATFORM_ROLE_GROUP).toEqual({ Admin: PLATFORM_ADMIN_GROUP, Manager: MANAGER_GROUP, Developer: DEVELOPER_GROUP, Analyst: ANALYST_GROUP });
    expect([...PLATFORM_GROUPS]).toEqual(["bgp-admin", "bgp-manager", "bgp-developer", "bgp-analyst"]);
    expect(PLATFORM_GROUPS).not.toContain(LEGACY_VIEWER_GROUP);
  });

  it("isPlatformRole 闭合:Viewer(旧三档)与任何别的值都不是角色", () => {
    for (const r of PLATFORM_ROLES) expect(isPlatformRole(r)).toBe(true);
    for (const bad of ["Viewer", "viewer", "admin", "", undefined, null, 1]) expect(isPlatformRole(bad), String(bad)).toBe(false);
  });

  it("roleFromGroups 按特权取最高;四组都不在(含历史遗留 bgp-viewer)⇒ None", () => {
    expect(roleFromGroups(["bgp-admin", "bgp-analyst"])).toBe("Admin");
    expect(roleFromGroups(["bgp-manager", "bgp-developer"])).toBe("Manager");
    expect(roleFromGroups(["bgp-developer"])).toBe("Developer");
    expect(roleFromGroups(["bgp-analyst"])).toBe("Analyst");
    expect(roleFromGroups([LEGACY_VIEWER_GROUP])).toBe("None");
    expect(roleFromGroups([])).toBe("None");
  });

  it("每个角色标签在英文词典有译(页面经 t() 渲染,动态键守卫扫不到,这里钉)", () => {
    for (const r of PLATFORM_ROLES) expect(EN[PLATFORM_ROLE_LABEL[r]], PLATFORM_ROLE_LABEL[r]).toBeTruthy();
    expect(PLATFORM_ROLE_LABEL.None).toContain("无平台组");
  });

  it("isAnalystOnly 与组常量同源:仅 analyst ⇒ true;兼有任一特权组 ⇒ false", () => {
    expect(isAnalystOnly([ANALYST_GROUP])).toBe(true);
    expect(isAnalystOnly([ANALYST_GROUP, DEVELOPER_GROUP])).toBe(false);
    expect(isAnalystOnly([ANALYST_GROUP, MANAGER_GROUP])).toBe(false);
    expect(isAnalystOnly([ANALYST_GROUP, PLATFORM_ADMIN_GROUP])).toBe(false);
    expect(isAnalystOnly([LEGACY_VIEWER_GROUP])).toBe(false);
  });

  it("🔴 棘轮:用户管理页 / 路由 / 需求工作台 / 前端角色判定里不再有字面量组名或 Viewer 档(只许 import 常量)", () => {
    for (const rel of ["app/admin/users/page.tsx", "app/api/admin/users/route.ts", "app/requirements/page.tsx", "lib/auth/roles.ts"]) {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${rel} 仍有字面量组名`).not.toMatch(/["'`]bgp-(admin|manager|developer|analyst|viewer)["'`]/);
      expect(code, `${rel} 仍有旧三档 Viewer`).not.toMatch(/["']Viewer["']/);
    }
  });
});
