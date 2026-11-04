// @kf-batch 50-W5-seg2-WP8
// probe 限频单测(51 SPEC §3.4a 卡点④;ACCEPTANCE M12)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const mem = vi.hoisted(() => ({ db: null as unknown as import("./mem-ddb").MemDdb }));
vi.mock("@/lib/aws/dynamodb", async () => {
  const { createMemDdb } = await import("./mem-ddb");
  mem.db = createMemDdb({ "bgp-settings": ["pk", "sk"], "bgp-audit": ["pk", "ts"] });
  return { TABLES: { SETTINGS: "bgp-settings", AUDIT: "bgp-audit" }, docClient: { send: (cmd: any) => mem.db.send(cmd) } };
});

import { consumeProbeQuota, probeRateLimitSk, probeMinuteBucket, PROBE_RATE_LIMIT_PER_MINUTE } from "../probe-ratelimit";

beforeEach(() => mem.db.reset());

describe("consumeProbeQuota", () => {
  const epoch = 1_800_000_030; // 分钟内第 30 秒

  it("sk 形态 = ratelimit#probe#<adminSub>#m#<floor(epochSec/60)>;计数项带 ttl(epoch 秒,5min)", async () => {
    expect(probeRateLimitSk("sub-a", epoch)).toBe(`ratelimit#probe#sub-a#m#${Math.floor(epoch / 60)}`);
    expect(probeMinuteBucket(epoch)).toBe(30_000_000);
    await consumeProbeQuota("sub-a", epoch);
    const row = mem.db.dump("bgp-settings")[0];
    expect(row.sk).toBe(probeRateLimitSk("sub-a", epoch));
    expect(row.ttl).toBe(epoch + 300);
    expect(row.count).toBe(1);
  });

  it("一次 UpdateItem + ReturnValues UPDATED_NEW 原子读回(不是两次调用)", async () => {
    await consumeProbeQuota("sub-a", epoch);
    expect(mem.db.log).toHaveLength(1);
    expect(mem.db.log[0].cmd).toBe("UpdateCommand");
    expect(mem.db.log[0].input.ReturnValues).toBe("UPDATED_NEW");
    expect(mem.db.log[0].input.UpdateExpression).toBe("ADD #c :one SET #ttl = if_not_exists(#ttl, :ttl)");
  });

  it("≤6 次放行,第 7 次 429 语义(allowed=false, retryAfterSec=60-秒偏移)", async () => {
    for (let i = 1; i <= PROBE_RATE_LIMIT_PER_MINUTE; i++) {
      const d = await consumeProbeQuota("sub-a", epoch);
      expect(d.allowed).toBe(true);
      expect(d.count).toBe(i);
    }
    const seventh = await consumeProbeQuota("sub-a", epoch);
    expect(seventh.allowed).toBe(false);
    expect(seventh.reason).toBe("over-limit");
    expect(seventh.retryAfterSec).toBe(30);
  });

  it("不同管理员 / 下一分钟各自独立计数", async () => {
    for (let i = 0; i < 6; i++) await consumeProbeQuota("sub-a", epoch);
    expect((await consumeProbeQuota("sub-b", epoch)).allowed).toBe(true);
    expect((await consumeProbeQuota("sub-a", epoch + 60)).allowed).toBe(true);
  });

  it("🔴 store 出错 ⇒ fail-closed 拒绝(probe 会烧真 Bedrock,宁拒不放)", async () => {
    mem.db.injectError(() => Object.assign(new Error("table missing"), { name: "ResourceNotFoundException" }));
    const d = await consumeProbeQuota("sub-a", epoch);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("store-error");
    expect(d.retryAfterSec).toBe(30);
  });
});
