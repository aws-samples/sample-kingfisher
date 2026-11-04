import { describe, it, expect } from "vitest";
import { roleAtLeast, isProjectRole, isEnv, isProtectedEnv } from "../constants";
import { isAnalystOnly } from "@/lib/auth/roles";

// RBAC ordering is security-critical: a regression here could grant editor/owner powers to a
// viewer. These pin the role lattice (owner ⊇ editor ⊇ viewer).
describe("roleAtLeast", () => {
  it("owner satisfies every minimum", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("owner", "owner")).toBe(true);
  });

  it("editor satisfies editor/viewer but NOT owner", () => {
    expect(roleAtLeast("editor", "viewer")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("editor", "owner")).toBe(false);
  });

  it("viewer satisfies only viewer", () => {
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("viewer", "owner")).toBe(false);
  });

  it("null/undefined role never satisfies any minimum", () => {
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
  });
});

describe("isProjectRole / isEnv / isProtectedEnv", () => {
  it("recognizes valid project roles", () => {
    expect(isProjectRole("owner")).toBe(true);
    expect(isProjectRole("nope")).toBe(false);
    expect(isProjectRole(undefined)).toBe(false);
  });

  it("recognizes valid environments", () => {
    expect(isEnv("dev")).toBe(true);
    expect(isEnv("staging")).toBe(true);
    expect(isEnv("prod")).toBe(true);
    expect(isEnv("production")).toBe(false);
  });

  it("flags prod as the protected env (promotion requires approval)", () => {
    expect(isProtectedEnv("prod")).toBe(true);
    expect(isProtectedEnv("dev")).toBe(false);
    expect(isProtectedEnv("staging")).toBe(false);
  });
});

// Analyst lockdown is enforced both at the edge (middleware) and the UI (roles.ts). Pin the
// predicate: ONLY a pure bgp-analyst (no privileged group) is locked down.
describe("isAnalystOnly", () => {
  it("locks down a pure analyst", () => {
    expect(isAnalystOnly(["bgp-analyst"])).toBe(true);
  });

  it("does NOT lock down an analyst who also holds a privileged group", () => {
    expect(isAnalystOnly(["bgp-analyst", "bgp-admin"])).toBe(false);
    expect(isAnalystOnly(["bgp-analyst", "bgp-manager"])).toBe(false);
    expect(isAnalystOnly(["bgp-analyst", "bgp-developer"])).toBe(false);
  });

  it("does not apply to non-analysts", () => {
    expect(isAnalystOnly(["bgp-developer"])).toBe(false);
    expect(isAnalystOnly([])).toBe(false);
  });
});
