import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  logger,
  newCorrelationId,
  getCorrelationId,
  CORRELATION_HEADER,
} from "../logger";

// The observability base (WS0). Logs must be single-line JSON, never throw, and never be
// emitted below the configured level.
describe("correlation id", () => {
  it("mints distinct, non-empty ids", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("reads the id from the request header when present", () => {
    const req = { headers: { get: (n: string) => (n === CORRELATION_HEADER ? "cid-123" : null) } };
    expect(getCorrelationId(req)).toBe("cid-123");
  });

  it("mints a fresh id when the header is absent", () => {
    const req = { headers: { get: () => null } };
    expect(getCorrelationId(req)).toBeTruthy();
  });
});

describe("logger output", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("emits a single line of valid JSON with ts/level/event + fields", () => {
    logger.info("sync.start", { correlationId: "cid-x", taskId: "t1" });
    expect(spy).toHaveBeenCalledOnce();
    const line = spy.mock.calls[0][0] as string;
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("sync.start");
    expect(parsed.correlationId).toBe("cid-x");
    expect(parsed.taskId).toBe("t1");
    expect(typeof parsed.ts).toBe("string");
  });

  it("suppresses logs below LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    logger.info("should.be.dropped", {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("error() serializes an Error into name/message/truncated stack", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error("sync.failed", new Error("boom"), { correlationId: "cid-y" });
      const line = errSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("sync.failed");
      expect(parsed.errMessage).toBe("boom");
      expect(parsed.errName).toBe("Error");
      expect(parsed.correlationId).toBe("cid-y");
      // stack is truncated to a bounded number of lines
      expect(parsed.stack.split("\n").length).toBeLessThanOrEqual(8);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("never throws even on a circular-reference field", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("weird", { circular })).not.toThrow();
  });
});
