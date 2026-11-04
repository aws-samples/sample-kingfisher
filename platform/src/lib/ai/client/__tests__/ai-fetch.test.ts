// → —— aiFetchJson 薄壳判据:非 JSON 响应包成可读错误(同一口径)、JSON 原样;不再轮询(202 由全局拦截器在它之前跟到终态)。
import { describe, it, expect, vi, afterEach } from "vitest";
import { aiFetchJson, readJsonEnvelope } from "../ai-fetch";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("aiFetchJson 薄壳", () => {
  it("200 JSON 信封原样;错误信封补 status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: true, data: { sql: "x" }, _meta: { modelId: "m" } })));
    expect(await aiFetchJson("/api/flink/ai-sql", { method: "POST" })).toEqual({ success: true, data: { sql: "x" }, _meta: { modelId: "m" } });
    vi.stubGlobal("fetch", vi.fn(async () => json({ success: false, error: { message: "坏了", code: "VALIDATION_FAILED" } }, 400)));
    expect(await aiFetchJson("/api/flink/ai-sql", { method: "POST" })).toEqual({ success: false, status: 400, error: { message: "坏了", code: "VALIDATION_FAILED" } });
  });

  it("非 JSON(网关 504 HTML)⇒ success:false + nonJson + 可读文案;不抛「Unexpected token」", async () => {
    const env = await readJsonEnvelope(new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }));
    expect(env.success).toBe(false);
    expect((env as { nonJson?: true }).nonJson).toBe(true);
    expect((env as { status?: number }).status).toBe(504);
    expect((env as { error: { message: string } }).error.message).toMatch(/HTTP 504/);
  });

  it("只发一次 fetch、不轮询任何任务端点(202 → 终态是全局拦截器的事)", async () => {
    const fetchMock = vi.fn(async () => json({ success: true, data: { taskId: "t", async: true, protocol: "long-op/1" } }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const out = await aiFetchJson("/api/copilot/ask", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ success: true, data: { taskId: "t", async: true, protocol: "long-op/1" } });
  });
});
