// ② —— `ensureGlueRole` 出请求路径:进程内只核一次并缓存;只有 NoSuchEntity 才补建;失败不缓存。
// 【缺陷原形】原来每次建源都在请求路径上 GetRole 一次(第四十七轮实测这一跳停顿 64 秒 ⇒ 整条建源 504),且 `catch {}` 把网络超时 / 限流
//   也当「角色不存在」去 CreateRole ⇒ EntityAlreadyExists ⇒ 500,错误指向 IAM 而真因是一次网络抖动。
// 只 mock 真外部:IAM SDK 模块本身(客户端 + 四条命令);datasource-service ↔ clients 工厂真装配。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as string[], getRoleError: null as Error | null }));

vi.mock("@aws-sdk/client-iam", () => {
  class Cmd { constructor(public input: Record<string, unknown>) {} }
  return {
    IAMClient: class {
      constructor(public cfg: Record<string, unknown>) {}
      async send(c: { constructor: { name: string } }) {
        const cmd = c.constructor.name;
        h.calls.push(cmd);
        if (cmd === "GetRoleCommand" && h.getRoleError) throw h.getRoleError;
        return { Role: { Arn: "arn:aws:iam::000000000000:role/bgp-glue-role" } };
      }
    },
    GetRoleCommand: class GetRoleCommand extends Cmd {},
    CreateRoleCommand: class CreateRoleCommand extends Cmd {},
    AttachRolePolicyCommand: class AttachRolePolicyCommand extends Cmd {},
    PutRolePolicyCommand: class PutRolePolicyCommand extends Cmd {},
  };
});

import { ensureGlueRole, __resetGlueRoleCache } from "../datasource-service";

beforeEach(() => { h.calls.length = 0; h.getRoleError = null; __resetGlueRoleCache(); });

describe("ensureGlueRole 缓存", () => {
  it("成功一次后进程内不再核:连调三次只有一次 GetRole,都回同一 ARN", async () => {
    const arns = await Promise.all([ensureGlueRole(), ensureGlueRole(), ensureGlueRole()]);
    expect(new Set(arns)).toEqual(new Set(["arn:aws:iam::000000000000:role/bgp-glue-role"]));
    expect(h.calls).toEqual(["GetRoleCommand"]);
    await ensureGlueRole();
    expect(h.calls).toEqual(["GetRoleCommand"]);
  });

  it("🔴 非 NoSuchEntity 的错误(超时 / 限流)原样抛出,**不**走 CreateRole;且不缓存失败 —— 下一次重新核", async () => {
    h.getRoleError = Object.assign(new Error("socket timed out"), { name: "TimeoutError" });
    await expect(ensureGlueRole()).rejects.toThrow("socket timed out");
    expect(h.calls).toEqual(["GetRoleCommand"]);
    h.getRoleError = null;
    expect(await ensureGlueRole()).toBe("arn:aws:iam::000000000000:role/bgp-glue-role");
    expect(h.calls).toEqual(["GetRoleCommand", "GetRoleCommand"]);
  });

  it("NoSuchEntityException ⇒ 补建一次(CreateRole + 3 托管策略 + 1 内联)并缓存", async () => {
    h.getRoleError = Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
    expect(await ensureGlueRole()).toBe("arn:aws:iam::000000000000:role/bgp-glue-role");
    expect(h.calls).toEqual(["GetRoleCommand", "CreateRoleCommand", "AttachRolePolicyCommand", "AttachRolePolicyCommand", "AttachRolePolicyCommand", "PutRolePolicyCommand"]);
    await ensureGlueRole();
    expect(h.calls).toHaveLength(6);
  });

  it("缓存挂在 globalThis Symbol.for(进程级,不受 Next 多模块实例影响)", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    expect(Object.getOwnPropertySymbols(g).some((s) => s.description === "bgp.datasource-service.glueRoleArn")).toBe(true);
  });
});
