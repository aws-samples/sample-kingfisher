// 瞬态模型错误判定单测(51 SPEC §7.2b;DESIGN §12 D17)。夹具用 2026-10-14 …7698 真环境原话。
// 钉三件事:① 清单内的原话 / 错误名 / 状态码判 transient,清单外(含 ValidationException 字段被拒、账号级被拒)判 false;
// ② 退避有界且全幅抖动(rand=0 ⇒ 0,rand=1 ⇒ 顶到 cap);③ describeModelError 不吞字段、message 截 400。
import { describe, it, expect } from "vitest";
import { TRANSIENT_MAX_RETRIES, TRANSIENT_MODEL_ERROR_RE, describeModelError, isTransientModelError, transientBackoffMs } from "../transient";

const STREAM_ENDED = new Error("Stream ended without completing a message");          // 2026-10-14 14:50Z Kimi K3 问数容器原话
const KIMI_FIELD = Object.assign(new Error("This model doesn't support the temperature field. Remove temperature and try again."), { name: "ValidationException" });
const NOT_FOR_ACCOUNT = Object.assign(new Error("zai.glm-5.3 is not available for this account. You can explore other available models on Amazon Bedrock."), { name: "AccessDeniedException" });

describe("① 判定", () => {
  it("流中途断 / 模型流错误 / 限流 / 5xx 服务不可用 / 底层 socket ⇒ transient", () => {
    expect(isTransientModelError(STREAM_ENDED)).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("x"), { name: "ModelStreamErrorException" }))).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("Too many requests"), { name: "ThrottlingException" }))).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("x"), { name: "ServiceUnavailableException" }))).toBe(true);
    expect(isTransientModelError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientModelError({ name: "Unknown", message: "boom", $metadata: { httpStatusCode: 503 } })).toBe(true);
    expect(isTransientModelError({ name: "Unknown", message: "boom", $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isTransientModelError("socket hang up")).toBe(true);
  });
  it("字段被拒(D12 要学的那种)/ 账号级未开放 / 普通 Error / null / 空对象 ⇒ 不是 transient(交给各自的处理路径,不许被重试掩盖)", () => {
    expect(isTransientModelError(KIMI_FIELD)).toBe(false);
    expect(isTransientModelError(NOT_FOR_ACCOUNT)).toBe(false);
    expect(isTransientModelError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientModelError(null)).toBe(false);
    expect(isTransientModelError(undefined)).toBe(false);
    expect(isTransientModelError({})).toBe(false);
    expect(isTransientModelError({ $metadata: { httpStatusCode: 400 }, message: "bad" })).toBe(false);
  });
  it("清单是闭合的:正则不匹配空串 / 泛词", () => {
    expect(TRANSIENT_MODEL_ERROR_RE.test("")).toBe(false);
    expect(TRANSIENT_MODEL_ERROR_RE.test("error")).toBe(false);
    expect(TRANSIENT_MODEL_ERROR_RE.test("stream")).toBe(false);
  });
});

describe("② 退避有界 + 全幅抖动", () => {
  it("最多重试 1 次", () => expect(TRANSIENT_MAX_RETRIES).toBe(1));
  it("rand=0 ⇒ 0ms;rand=1 ⇒ min(cap, base×2^attempt);attempt 大也顶在 cap", () => {
    expect(transientBackoffMs(0, () => 0)).toBe(0);
    expect(transientBackoffMs(0, () => 1)).toBe(600);
    expect(transientBackoffMs(1, () => 1)).toBe(1200);
    expect(transientBackoffMs(2, () => 1)).toBe(2400);
    expect(transientBackoffMs(9, () => 1)).toBe(2400);
    expect(transientBackoffMs(-3, () => 1)).toBe(600);
    expect(transientBackoffMs(0, () => 7)).toBe(600); // rand 越界夹到 [0,1]
  });
  it("真随机下落在 [0, ceil] 内(100 次)", () => {
    for (let i = 0; i < 100; i++) {
      const v = transientBackoffMs(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });
});

describe("③ describeModelError", () => {
  it("带 name / message / status / transient;message 截 400;非 Error 也能描述", () => {
    const d = describeModelError(Object.assign(new Error("m".repeat(1000)), { name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }));
    expect(d.name).toBe("ThrottlingException");
    expect(d.message.length).toBe(400);
    expect(d.status).toBe(429);
    expect(d.transient).toBe(true);
    expect(describeModelError(STREAM_ENDED)).toEqual({ name: "Error", message: "Stream ended without completing a message", status: null, transient: true });
    expect(describeModelError("plain")).toEqual({ name: "string", message: "plain", status: null, transient: false });
    expect(describeModelError(null).transient).toBe(false);
  });
});
