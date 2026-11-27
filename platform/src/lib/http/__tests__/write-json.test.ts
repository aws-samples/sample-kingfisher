// 页面「保存 / 提交」读应答的唯一作者(lib/http/write-json.ts):成功才算成功,服务端拒绝时把原话交给页面。
//
// 缺陷原形(2026-11-26 读代码):编排画布「保存」等六处 `await fetch(PUT/POST)` 之后不看应答就提示「已保存」。
// 只替换真外部(全局 fetch);信封读法跑真代码。
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeJson, WriteRejected } from "@/lib/http/write-json";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(res: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return res;
  }) as unknown as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("🔴 writeJson:发出去的请求", () => {
  it("带请求体:方法、JSON 请求头、序列化后的正文", async () => {
    const calls = stubFetch(json(200, { workflowId: "wf-1" }));
    await writeJson("/api/workflow/wf-1", "PUT", { dagDefinition: { nodes: [], edges: [] } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/workflow/wf-1");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0].init.body).toBe(JSON.stringify({ dagDefinition: { nodes: [], edges: [] } }));
  });

  it("不带请求体(payload 省略):不发正文也不发 JSON 请求头", async () => {
    const calls = stubFetch(json(200, { success: true }));
    await writeJson("/api/workflow/wf-1/publish", "POST");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers).toBeUndefined();
  });
});

describe("🔴 writeJson:成败只看 HTTP 状态与信封的 success", () => {
  it("2xx + 保存后的那一行(没有信封)⇒ 成功,原样返回", async () => {
    stubFetch(json(200, { workflowId: "wf-1", name: "x" }));
    await expect(writeJson("/api/workflow/wf-1", "PUT", {})).resolves.toEqual({ workflowId: "wf-1", name: "x" });
  });

  it("2xx + 行上带一个叫 error 的字段(同步任务上一次失败的原因)⇒ 仍是成功,不许判成保存失败", async () => {
    stubFetch(json(200, { taskId: "t-1", status: "error", error: "上一次运行:连接超时" }));
    await expect(writeJson("/api/sync/t-1", "PUT", { cronExpression: "0 3 * * *" })).resolves.toMatchObject({ taskId: "t-1" });
  });

  it("2xx 无正文(204)⇒ 成功,返回空对象", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(writeJson("/api/x", "POST", {})).resolves.toEqual({});
  });

  it("413 标准信封 ⇒ 抛 WriteRejected,带服务端原话、状态与错误码", async () => {
    stubFetch(json(413, { success: false, error: { message: "这次提交的内容有 6MB,超过了一次可提交的上限 4MB,没有保存。", code: "PAYLOAD_TOO_LARGE" } }));
    const err = await writeJson("/api/workflow/wf-1", "PUT", {}).catch((e) => e);
    expect(err).toBeInstanceOf(WriteRejected);
    expect(err.message).toContain("上限 4MB");
    expect(err.status).toBe(413);
    expect(err.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("老形态 `{ error: \"字串\" }` + 非 2xx ⇒ 抛,文案取那个字串", async () => {
    stubFetch(json(400, { error: "无更新字段" }));
    const err = await writeJson("/api/workflow/wf-1", "PUT", {}).catch((e) => e);
    expect(err).toBeInstanceOf(WriteRejected);
    expect(err.message).toBe("无更新字段");
    expect(err.status).toBe(400);
  });

  it("2xx 但信封 success:false ⇒ 抛", async () => {
    stubFetch(json(200, { success: false, error: { message: "对象正在被另一个操作占用" } }));
    await expect(writeJson("/api/x", "POST", {})).rejects.toThrow("对象正在被另一个操作占用");
  });

  it("非 2xx 且读不出 JSON ⇒ 抛,文案带 HTTP 状态", async () => {
    stubFetch(new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(writeJson("/api/x", "PUT", {})).rejects.toThrow("保存失败(HTTP 502)");
  });
});
