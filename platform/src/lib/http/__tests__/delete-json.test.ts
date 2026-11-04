// 序 41 B-117 —— `deleteJson` 的行为判据(只 mock 真外部 fetch)。缺陷原形见 delete-json.ts 头注。
import { describe, it, expect, vi, afterEach } from "vitest";
import { deleteJson, DeleteRejected } from "@/lib/http/delete-json";

function fakeFetch(status: number, body: unknown | null) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === null) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deleteJson —— 成功才算成功", () => {
  it("200 + {success:true, teardown} ⇒ 返回信封(页面据此才提示「已删除」)", async () => {
    const f = fakeFetch(200, { success: true, teardown: { channel: "dms" } });
    vi.stubGlobal("fetch", f);
    const out = await deleteJson<{ teardown: { channel: string } }>("/api/sync/t1");
    expect(out.teardown.channel).toBe("dms");
    expect(f).toHaveBeenCalledWith("/api/sync/t1", expect.objectContaining({ method: "DELETE" }));
  });
  it("204 无正文 ⇒ 视为成功,返回 {}", async () => {
    vi.stubGlobal("fetch", fakeFetch(204, null));
    expect(await deleteJson("/api/x/1")).toEqual({});
  });
  it("🔴 B-117 原形:409 TEARDOWN_IN_PROGRESS 信封 ⇒ 抛 DeleteRejected,message 是服务端原话、code / status 带上(页面不许再说「已删除」)", async () => {
    vi.stubGlobal("fetch", fakeFetch(409, { success: false, error: { message: "同步通道没能真正停下来(dms):复制任务 — 还在 creating。请稍后再试", code: "TEARDOWN_IN_PROGRESS" } }));
    const e = await deleteJson("/api/sync/t1").catch((x) => x);
    expect(e).toBeInstanceOf(DeleteRejected);
    expect((e as DeleteRejected).message).toContain("还在 creating");
    expect((e as DeleteRejected).code).toBe("TEARDOWN_IN_PROGRESS");
    expect((e as DeleteRejected).status).toBe(409);
  });
  it("200 但 success:false(路由用 200 包错误的老形态)⇒ 同样抛", async () => {
    vi.stubGlobal("fetch", fakeFetch(200, { success: false, error: "删不掉" }));
    await expect(deleteJson("/api/x/1")).rejects.toThrow("删不掉");
  });
  it("非 JSON 错误页(拦截器不在的环境)⇒ 抛「删除失败(HTTP 502)」而不是 Unexpected token", async () => {
    vi.stubGlobal("fetch", fakeFetch(502, null));
    await expect(deleteJson("/api/x/1")).rejects.toThrow("删除失败(HTTP 502)");
  });
  it("Next 老路由形态 `{ error: \"Not found\" }` + 404 ⇒ 抛且 message = Not found", async () => {
    vi.stubGlobal("fetch", fakeFetch(404, { error: "Not found" }));
    await expect(deleteJson("/api/sync/nope")).rejects.toThrow("Not found");
  });
});
