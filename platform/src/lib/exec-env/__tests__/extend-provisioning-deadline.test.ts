// @kf-batch 50-WP9a-durable-jobs
// §3.9b 延期专用操作 `extendProvisioningDeadline`(WP-9 合同差分 ③-2;判据 HC-1 的本机版)。
// 只 mock DDB(内存假表,真求值条件表达式)—— registry 真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeDdb, DDB_SPECS } from "../../dataplane-jobs/__tests__/fake-ddb";

const h = vi.hoisted(() => ({ ddb: null as unknown as FakeDdb }));
h.ddb = new FakeDdb(DDB_SPECS);
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, docClient: { send: (c: never) => h.ddb.send(c) } };
});

const { extendProvisioningDeadline, CredentialTransitionRejected, PROVISIONING_MAX_WINDOW_MS } = await import("@/lib/exec-env/registry");

const TID = "tgt_usw2_a";
const ENVS = "bgp-execution-envs";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-11T00:00:00.000Z");
const row = () => h.ddb.get(ENVS, { pk: "env", sk: TID })!;

beforeEach(() => {
  h.ddb.tables.clear();
  h.ddb.put(ENVS, {
    pk: "env",
    sk: TID,
    targetId: TID,
    credentialIsolationState: "provisioning",
    credentialEpoch: 3,
    provisioningDeadlineAt: "2026-10-19T00:00:00.000Z",
    version: 7,
  });
});

describe("🔴🔴 HC-1:延期 = provisioning → provisioning,带 epoch、≤30 天", () => {
  it("合法延期 ⇒ deadline 更新、epoch++、version++、记操作号", async () => {
    const at = new Date(NOW + 20 * DAY).toISOString();
    const r = await extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: at, operationId: "extend-1", now: NOW });
    expect(r.newEpoch).toBe(4);
    expect(row()).toMatchObject({ provisioningDeadlineAt: at, credentialEpoch: 4, version: 8, provisioningOperationId: "extend-1", credentialIsolationState: "provisioning" });
  });

  it("🔴 超过 30 天(以现在为基准)⇒ 拒,行不变", async () => {
    const before = JSON.stringify(row());
    const at = new Date(NOW + PROVISIONING_MAX_WINDOW_MS + 60_000).toISOString();
    await expect(extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: at, now: NOW })).rejects.toBeInstanceOf(CredentialTransitionRejected);
    expect(JSON.stringify(row())).toBe(before);
  });

  it("过去的时间 / 解析不了的串 ⇒ 拒", async () => {
    await expect(extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: new Date(NOW - 1).toISOString(), now: NOW })).rejects.toThrow(/未来/);
    await expect(extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: "soon", now: NOW })).rejects.toThrow(/无法解析/);
  });

  it("🔴 epoch 不符(别人已经延期 / 推进过)⇒ 拒", async () => {
    await expect(
      extendProvisioningDeadline(TID, { expectedEpoch: 2, provisioningDeadlineAt: new Date(NOW + DAY).toISOString(), now: NOW })
    ).rejects.toThrow(/凭证世代/);
    expect(row().credentialEpoch).toBe(3);
  });

  it("🔴 已 isolated / legacy-seeded ⇒ 拒(延期不是给任意状态开的自环)", async () => {
    for (const st of ["isolated", "legacy-seeded"]) {
      h.ddb.put(ENVS, { ...row(), credentialIsolationState: st });
      await expect(
        extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: new Date(NOW + DAY).toISOString(), now: NOW })
      ).rejects.toBeInstanceOf(CredentialTransitionRejected);
      expect(row().credentialIsolationState).toBe(st);
    }
  });

  it("两次并发延期带同一个 epoch ⇒ 只有一次成功", async () => {
    const at = (d: number) => new Date(NOW + d * DAY).toISOString();
    const rs = await Promise.allSettled([
      extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: at(10), now: NOW }),
      extendProvisioningDeadline(TID, { expectedEpoch: 3, provisioningDeadlineAt: at(20), now: NOW }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(row().credentialEpoch).toBe(4);
  });

  it("目标不存在 ⇒ 拒", async () => {
    await expect(
      extendProvisioningDeadline("tgt_usw2_b", { expectedEpoch: 0, provisioningDeadlineAt: new Date(NOW + DAY).toISOString(), now: NOW })
    ).rejects.toBeInstanceOf(CredentialTransitionRejected);
  });
});

describe("延期路由:理由必填 · 只延不缩 · 审计 fail-closed(文本门禁;真实行为归 HC-1 无头判据)", () => {
  it("路由先写意图审计、失败即 503 不延期;要求理由;新截止必须晚于旧截止;只经 extendProvisioningDeadline 写", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/api/admin/exec-envs/[targetId]/provisioning-deadline/route.ts"),
      "utf8"
    );
    const intent = src.indexOf("provisioning-deadline.extend.intent");
    const write = src.indexOf("await extendProvisioningDeadline(");
    expect(intent).toBeGreaterThan(-1);
    expect(write, "延期写在意图审计之前 ⇒ 可能没有记录").toBeGreaterThan(intent);
    expect(src.slice(intent, write)).toMatch(/catch[\s\S]{0,200}return apiError\([\s\S]{0,200}503/);
    expect(src).toMatch(/newMs <= curMs/);
    expect(src).toMatch(/reason\.length < 4/);
    expect(src, "延期路由绕过专用通道去推状态机").not.toContain("advanceCredentialIsolationState");
  });
});
