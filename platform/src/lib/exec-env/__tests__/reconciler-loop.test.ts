// @kf-batch 50-P50.3b-2a-reconciler
// reconciler-loop 的 tick 逻辑:选主门 + 遍历 listTargetsRaw + 逐 target reconcileOneTarget(隔离)。
// 🔴 三个依赖顶层 vi.mock:leader-lease(选主)/ registry.listTargetsRaw(列全表)/ reconcile.reconcileOneTarget(SSOT)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const acquireMock = vi.fn();
const listMock = vi.fn();
const reconcileMock = vi.fn();
vi.mock("@/lib/exec-env/leader-lease", () => ({
  acquireOrRenewLeaderLease: (...a: unknown[]) => acquireMock(...a),
  RECONCILER_LEASE_MS: 8 * 60 * 1000,
}));
vi.mock("@/lib/exec-env/registry", () => ({ listTargetsRaw: (...a: unknown[]) => listMock(...a) }));
vi.mock("@/lib/exec-env/reconcile", () => ({ reconcileOneTarget: (...a: unknown[]) => reconcileMock(...a) }));
import { runReconcileTick, runForTarget } from "@/lib/exec-env/reconciler-loop";
// 🔴 账本 / 上下文走**真实现**(它正是本组用例要证的接缝);镜像层**不 mock**(兄弟模块,mock-hygiene 棘轮)——
//    镜像 tick 那一支的包装靠 runForTarget 直测 + 两处调用点的静态判据钉住。
import { currentPlace } from "@/lib/place/context";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

const ACCT = "000000000000";
const HOME_T = { targetId: "tgt_home", region: "us-east-1", accountId: ACCT, partition: "aws", version: 7, status: "active", ready: true, resources: {} };
const USW2_T = { targetId: "tgt_usw2_a", region: "us-west-2", accountId: ACCT, partition: "aws", version: 3, status: "active", ready: true, resources: {} };

beforeEach(() => {
  acquireMock.mockReset();
  listMock.mockReset();
  reconcileMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {}); // 隔离测试会打 error,静音免噪
});

describe("runReconcileTick", () => {
  it("非 leader(选主返 null)→ 不列表、不探活", async () => {
    acquireMock.mockResolvedValue(null);
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: false, total: 0, reconciled: 0, errors: 0 });
    expect(listMock).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("leader → 遍历全表,对每个 target 调 reconcileOneTarget(SSOT)", async () => {
    acquireMock.mockResolvedValue({ token: "t" });
    listMock.mockResolvedValue([{ targetId: "tgt_home" }, { targetId: "tgt_usw2_a" }]);
    reconcileMock.mockResolvedValue({});
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: true, total: 2, reconciled: 2, errors: 0 });
    expect(reconcileMock).toHaveBeenCalledWith("tgt_home");
    expect(reconcileMock).toHaveBeenCalledWith("tgt_usw2_a");
  });

  it("🔴 逐 target 隔离:一个 target 抛错不掀翻其它(reconciled=2 / errors=1)", async () => {
    acquireMock.mockResolvedValue({ token: "t" });
    listMock.mockResolvedValue([{ targetId: "a" }, { targetId: "b" }, { targetId: "c" }]);
    reconcileMock.mockImplementation((id: string) =>
      id === "b" ? Promise.reject(new Error("boom")) : Promise.resolve({})
    );
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: true, total: 3, reconciled: 2, errors: 1 });
  });

  it("listTargetsRaw 抛错 → errors:1,不崩(leader 仍 true)", async () => {
    acquireMock.mockResolvedValue({ token: "t" });
    listMock.mockRejectedValue(new Error("ddb down"));
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: true, total: 0, reconciled: 0, errors: 1 });
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

// @kf-batch 50-WP31-place-first-class —— 序 31 第二刀 ②:请求外的循环自己建显式落点上下文(context.ts 文件头 ①)。
//   第四十三轮 observe:未归因榜 13 类里 11 类「(请求外)」全出自这两个 tick(探活 ec2 / s3 / cloudformation / s3tables /
//   glue / redshift-serverless / dms / athena;镜像 glue.GetDatabases / GetTables)。
describe("🔴 两个 tick 都在该 target 的显式落点上下文里跑(观测器据此归因;enforce 下控制面客户端不挂守卫,不会自拦)", () => {
  it("reconcile tick:每个 target 的 reconcileOneTarget 看到的 currentPlace 就是它自己(targetId + region 来自描述符)", async () => {
    acquireMock.mockResolvedValue({ token: "t" });
    listMock.mockResolvedValue([HOME_T, USW2_T]);
    const seen: Array<{ id: string; place: { targetId: string; region: string; home: boolean } | undefined }> = [];
    reconcileMock.mockImplementation(async (id: string) => {
      const p = currentPlace();
      seen.push({ id, place: p ? { targetId: p.targetId, region: p.region, home: p.home } : undefined });
      return {};
    });
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: true, total: 2, reconciled: 2, errors: 0 });
    expect(seen).toEqual([
      { id: "tgt_home", place: { targetId: "tgt_home", region: "us-east-1", home: true } },
      { id: "tgt_usw2_a", place: { targetId: "tgt_usw2_a", region: "us-west-2", home: false } },
    ]);
    expect(currentPlace(), "循环结束后上下文必须退出(不许泄漏到下一个 tick / 别的后台任务)").toBeUndefined();
  });

  it("🔴 描述符投影不出 Place(缺 accountId)⇒ 仍探活、只是无上下文;不许因为观测归因建不起来就让该 target 停摆", async () => {
    acquireMock.mockResolvedValue({ token: "t" });
    listMock.mockResolvedValue([{ ...USW2_T, accountId: undefined }, HOME_T]);
    const seen: Array<string | undefined> = [];
    reconcileMock.mockImplementation(async () => {
      seen.push(currentPlace()?.targetId);
      return {};
    });
    const s = await runReconcileTick(1);
    expect(s).toEqual({ leader: true, total: 2, reconciled: 2, errors: 0 });
    expect(seen).toEqual([undefined, "tgt_home"]);
  });

  it("runForTarget(镜像 tick 也经它):合格描述符 ⇒ fn 在该 target 上下文里跑;null / 不合格 ⇒ 无上下文照常跑;fn 抛错原样抛且上下文退出", async () => {
    expect(await runForTarget(USW2_T as unknown as ExecutionTarget, async () => currentPlace()?.targetId)).toBe("tgt_usw2_a");
    expect(await runForTarget(undefined, async () => currentPlace()?.targetId)).toBeUndefined();
    expect(await runForTarget({ ...USW2_T, partition: "" } as unknown as ExecutionTarget, async () => currentPlace()?.targetId)).toBeUndefined();
    await expect(runForTarget(HOME_T as unknown as ExecutionTarget, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(currentPlace()).toBeUndefined();
  });

  it("接线:两个 tick 都经同一个 runForTarget(一个包了一个没包 = 又回到半边归因)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../reconciler-loop.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    expect(src).toMatch(/await runForTarget\(t, \(\) => reconcileOneTarget\(t\.targetId\)\)/);
    expect(src).toMatch(/await runForTarget\(descriptors\.get\(targetId\), \(\) => mirrorMetadata\(targetId\)\)/);
    expect(src, "裸调 reconcileOneTarget / mirrorMetadata ⇒ 这一支的调用没有上下文").not.toMatch(/\n\s*await (reconcileOneTarget|mirrorMetadata)\(/);
  });
});
