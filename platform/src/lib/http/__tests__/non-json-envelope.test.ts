// 页面拿到非 JSON 的 /api 响应 ⇒ 可读错误而不是「Unexpected token <」(整形逻辑判据 + 调用点判据)。
//
// 【缺陷原形(第四十三轮 c …9435 18:07Z)】平台边缘访问频率规则把 `/api/*` 拦成 HTML 403;CloudFront / ALB 502 / 504 也是 HTML。
//   页面调用点 `await res.json()` 抛异常,用户零提示。只给七条 AI 路由包过。
// 【根治】全局 fetch 拦截器(AuthProvider)对所有 /api/* 响应 normalizeApiResponse:≥ 400 且不是 JSON ⇒ 标准错误信封;
//   2xx / JSON / 正文其实是 JSON 的一律原样。aiFetchJson 文案从同一作者 import。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeApiResponse, nonJsonEnvelope, describeNonJson, isJsonContentType } from "@/lib/http/non-json-envelope";

const html = (status: number, body = "<!DOCTYPE html><html><body><h1>403 ERROR</h1></body></html>") =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (status: number, body: unknown, contentType = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });

describe("🔴 normalizeApiResponse:≥ 400 且不是 JSON ⇒ 同状态码的错误信封", () => {
  it("缺陷原形:边缘访问规则 HTML 403 ⇒ `{ success:false, error.message 可读, status:403, nonJson:true }`,状态码不变、content-type 变 JSON", async () => {
    const out = await normalizeApiResponse(html(403));
    expect(out.status).toBe(403);
    expect(isJsonContentType(out.headers.get("content-type"))).toBe(true);
    const body = await out.json();
    expect(body).toMatchObject({ success: false, status: 403, nonJson: true, error: { code: "UPSTREAM_ERROR" } });
    expect(body.error.message).toContain("HTTP 403");
    expect(body.error.message).toContain("稍候");
    expect(body.error.message).not.toContain("<");
  });

  it("网关 504 HTML ⇒ 文案说清是网关超时、code=UPSTREAM_TIMEOUT;502 / 503 同一类文案", async () => {
    const b504 = await (await normalizeApiResponse(html(504, "<html>504 Gateway Time-out</html>"))).json();
    expect(b504.error).toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(b504.error.message).toContain("网关超时");
    for (const st of [502, 503]) {
      const body = await (await normalizeApiResponse(new Response("Bad Gateway", { status: st, headers: { "content-type": "text/plain" } }))).json();
      expect(body.error.message).toContain(`HTTP ${st}`);
      expect(body.error.code).toBe("UPSTREAM_ERROR");
    }
  });

  it("平台自己的 JSON 错误(apiError 400 / 500)原样放行 —— 同一个对象、正文一个字节不动", async () => {
    const res = json(400, { success: false, error: { message: "缺 targetId", code: "VALIDATION_FAILED" } });
    const out = await normalizeApiResponse(res);
    expect(out).toBe(res);
    expect((await out.json()).error.message).toBe("缺 targetId");
  });

  it("2xx 一律不碰(文件下载 / 流式响应走 /api 也是 2xx):不读 body、原对象返回", async () => {
    const csv = new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } });
    const out = await normalizeApiResponse(csv);
    expect(out).toBe(csv);
    expect(csv.bodyUsed).toBe(false);
    const sse = new Response("data: x\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    expect(await normalizeApiResponse(sse)).toBe(sse);
  });

  it("头声明不是 JSON 但正文是 JSON(上游 content-type 没写对)⇒ 原样放行,正文可照常 json()", async () => {
    const res = new Response(JSON.stringify({ success: false, error: { message: "x" } }), { status: 500, headers: { "content-type": "text/plain" } });
    const out = await normalizeApiResponse(res);
    expect(out).toBe(res);
    expect((await out.json()).error.message).toBe("x");
  });

  it("content-type 判定:application/json 与 +json 变体算 JSON;text/html / 空 不算", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });

  it("nonJsonEnvelope / describeNonJson:信封形状与 aiFetchJson 既有口径一致(success:false + error.message + status + nonJson)", () => {
    const env = nonJsonEnvelope(504);
    expect(env).toMatchObject({ success: false, status: 504, nonJson: true });
    expect(env.error.message).toBe(describeNonJson(504));
    expect(describeNonJson(418)).toContain("HTTP 418");
  });
});

describe("🔴 调用点判据:全局 fetch 拦截器与 aiFetchJson 都经同一作者", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("AuthProvider 拦截器:/api/*(含 /api/public/)的响应都 return normalizeApiResponse(…),非 /api 不碰", () => {
    const src = strip(read("lib/auth/AuthProvider.tsx"));
    expect(src).toContain('import { normalizeApiResponse } from "@/lib/http/non-json-envelope"');
    const fn = src.slice(src.indexOf("function installFetchInterceptor"), src.indexOf("installFetchInterceptor();"));
    expect(fn).toContain('input.startsWith("/api/public/")) return normalizeApiResponse(await orig(input, init))');
    expect(fn).toContain("return normalizeApiResponse(res);");
    // 带鉴权头那条路里不再裸 return res
    expect(fn).not.toMatch(/\n\s*return res;\n/);
    expect(fn).toContain("return orig(input, init);");
  });

  it("aiFetchJson:非 JSON 文案只 import,不再保留第二份 describeNonJson 实现", () => {
    const src = strip(read("lib/ai/client/ai-fetch.ts"));
    expect(src).toContain('import { describeNonJson } from "@/lib/http/non-json-envelope"');
    expect(src).not.toMatch(/function describeNonJson\(/);
  });
});
