// 故障注入 seam 单测:运行期 env 门 + 仅非生产标记下生效(51 SPEC §3.4a③ / 50 ACCEPTANCE §8ter.2)。
import { describe, it, expect } from "vitest";
import { faultSeamStatus, isThrottleInjected, injectedThrottleError, isNonProdTarget } from "../fault-seam";

describe("FAULT_THROTTLE_MODEL seam", () => {
  it("两个 env 都在才 armed;缺任一 ⇒ 惰性(fail-closed)", () => {
    expect(faultSeamStatus({}).armed).toBe(false);
    expect(faultSeamStatus({ FAULT_THROTTLE_MODEL: "m1" }).armed).toBe(false); // 忘标非生产 ⇒ 不注入
    expect(faultSeamStatus({ BGP_NONPROD_TARGET: "1" }).armed).toBe(false);
    expect(faultSeamStatus({ BGP_NONPROD_TARGET: "1", FAULT_THROTTLE_MODEL: "m1" })).toEqual({ nonprod: true, throttleModel: "m1", armed: true });
    expect(isNonProdTarget({ BGP_NONPROD_TARGET: "true" })).toBe(false); // 只认字面 "1"
  });
  it("只对指定 modelId 注入", () => {
    const env = { BGP_NONPROD_TARGET: "1", FAULT_THROTTLE_MODEL: "m1" };
    expect(isThrottleInjected("m1", env)).toBe(true);
    expect(isThrottleInjected("m2", env)).toBe(false);
    expect(isThrottleInjected("m1", { FAULT_THROTTLE_MODEL: "m1" })).toBe(false);
  });
  it("注入的异常与 Bedrock ThrottlingException 同名、429、带 injected 标记", () => {
    const e = injectedThrottleError("m1") as Error & { $metadata?: { httpStatusCode: number }; injected?: boolean };
    expect(e.name).toBe("ThrottlingException");
    expect(e.$metadata?.httpStatusCode).toBe(429);
    expect(e.injected).toBe(true);
  });
});
