// 网关(middleware)对请求体大小的收口 —— 调用点判据:上限表「写了」不算,网关真的用它拦才算。
//   · 登录校验通过之后:超过上限 ⇒ 413 + 人话 + PAYLOAD_TOO_LARGE,不进路由;没超 ⇒ 放行;
//   · 没登录的大请求仍然是 401(先说登录,不说大小);
//   · 三条上传路由按各自的上限;登录前公开接口不归网关管大小(边缘照旧拦);
//   · 请求头里没有 Content-Length 时数实际读到的字节,不许因为没有长度就放行。
// 只 mock 真外部(jose 的 JWKS 校验);路径匹配、上限表、文案都跑真代码。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_MAX_BODY_BYTES,
  GATEWAY_BUFFER_LIMIT_BYTES,
  PAYLOAD_TOO_LARGE_CODE,
  bodyTooLargeMessage,
  etlDepTooLargeMessage,
  flinkConnectorTooLargeMessage,
  genbiCardTooLargeMessage,
} from "@/lib/http/body-limits";

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string) => {
    if (token !== "developer") throw new Error("bad token");
    return { payload: { aud: "client-body", token_use: "id", "cognito:groups": ["bgp-developer"] } };
  },
}));

const KEYS = ["BGP_AUTH_DISABLED", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "NEXT_PUBLIC_COGNITO_USER_POOL_ID", "NEXT_PUBLIC_COGNITO_CLIENT_ID"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.COGNITO_USER_POOL_ID = "us-east-1_bodypool";
  process.env.COGNITO_CLIENT_ID = "client-body";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const MB = 1024 * 1024;

type Out = { status: number; message: string; code: string; cid: string; passedOn: boolean };

async function run(req: NextRequest): Promise<Out> {
  const { middleware } = await import("@/middleware");
  const res = await middleware(req);
  let body: { error?: { message?: string; code?: string; correlationId?: string } } | null = null;
  if (res.status >= 400) body = await res.json();
  return {
    status: res.status,
    message: body?.error?.message ?? "",
    code: body?.error?.code ?? "",
    cid: body?.error?.correlationId ?? "",
    // 放行给路由的应答带这个头(NextResponse.next 的记号)
    passedOn: res.headers.get("x-middleware-next") === "1",
  };
}

/** 带 Content-Length 的请求(只判请求头,不需要真有那么大的请求体)。 */
function withLength(as: string | null, method: string, path: string, contentLength: number): NextRequest {
  const headers: Record<string, string> = { "content-length": String(contentLength) };
  if (as) headers.authorization = `Bearer ${as}`;
  return new NextRequest(`http://x${path}`, { method, headers });
}

/** 不带 Content-Length、请求体是一条流(分块传输的样子);共 `totalBytes` 字节,每块 256KB。 */
function streamed(method: string, path: string, totalBytes: number): { req: NextRequest; pulled: () => number } {
  let sent = 0;
  const chunk = new Uint8Array(256 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.byteLength, totalBytes - sent);
      sent += n;
      controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
    },
  });
  const init = { method, headers: { authorization: "Bearer developer" }, body: stream, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1];
  return { req: new NextRequest(`http://x${path}`, init), pulled: () => sent };
}

describe("🔴 登录后的保存请求:没超上限放行,超了 413 + 人话,不进路由", () => {
  it("客户那种长脚本(60KB,远超过去边缘的 8KB)⇒ 放行给路由", async () => {
    const out = await run(withLength("developer", "PUT", "/api/etl-jobs/01JOBAAAA", 60 * 1024));
    expect(out.status).toBe(200);
    expect(out.passedOn).toBe(true);
  });

  it("超过缺省上限 ⇒ 413、错误码 PAYLOAD_TOO_LARGE、文案带实际大小与上限、带关联号;没有放行给路由", async () => {
    const out = await run(withLength("developer", "PUT", "/api/etl-jobs/01JOBAAAA", 6 * MB));
    expect(out.status).toBe(413);
    expect(out.code).toBe(PAYLOAD_TOO_LARGE_CODE);
    expect(out.message).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES, 6 * MB));
    expect(out.cid).not.toBe("");
    expect(out.passedOn).toBe(false);
  });

  it("编排画布 / 同步任务 / 报表 / 数仓查询任务的保存同一条规则(整类,不是只修离线作业)", async () => {
    for (const [m, p] of [
      ["PUT", "/api/workflow/wf-1"],
      ["PUT", "/api/sync/task-1"],
      ["POST", "/api/sync"],
      ["PUT", "/api/bi/reports/r-1"],
      ["POST", "/api/redshift/tasks"],
    ] as const) {
      expect((await run(withLength("developer", m, p, 200 * 1024))).passedOn, `${m} ${p} 200KB`).toBe(true);
      expect((await run(withLength("developer", m, p, DEFAULT_MAX_BODY_BYTES + 1))).status, `${m} ${p} 超限`).toBe(413);
    }
  });
});

describe("🔴 没登录的大请求:先说登录(401),不说大小", () => {
  it("没有令牌 / 令牌不对,请求体再大也是 401", async () => {
    expect((await run(withLength(null, "PUT", "/api/etl-jobs/01JOBAAAA", 50 * MB))).status).toBe(401);
    expect((await run(withLength("someone-else", "PUT", "/api/etl-jobs/01JOBAAAA", 50 * MB))).status).toBe(401);
  });
});

describe("🔴 上传路由按各自的上限;登录前公开接口不归网关管大小", () => {
  it("连接器 JAR 6MB / 依赖文件 6MB / 问数卡片 8MB ⇒ 放行(它们的上限比缺省大)", async () => {
    expect((await run(withLength("developer", "POST", "/api/flink/connectors", 6 * MB))).passedOn).toBe(true);
    expect((await run(withLength("developer", "POST", "/api/etl-jobs/01JOBAAAA/deps", 6 * MB))).passedOn).toBe(true);
    expect((await run(withLength("developer", "POST", "/api/genbi/cards", 8 * MB))).passedOn).toBe(true);
  });

  it("超过各自的上限 ⇒ 413 + 这条路由自己的那句话(过去页面写着 ≤250MB / ≤100MB,而超过框架缓冲上限的文件到路由手里是截断的)", async () => {
    const dep = await run(withLength("developer", "POST", "/api/etl-jobs/01JOBAAAA/deps", 30 * MB));
    expect(dep.status).toBe(413);
    expect(dep.code).toBe(PAYLOAD_TOO_LARGE_CODE);
    expect(dep.message).toBe(etlDepTooLargeMessage(30 * MB));
    expect(dep.passedOn).toBe(false);
    const jar = await run(withLength("developer", "POST", "/api/flink/connectors", 52 * MB));
    expect(jar.status).toBe(413);
    expect(jar.message).toBe(flinkConnectorTooLargeMessage(52 * MB));
    const card = await run(withLength("developer", "POST", "/api/genbi/cards", 15 * MB));
    expect(card.status).toBe(413);
    expect(card.message).toBe(genbiCardTooLargeMessage(15 * MB));
  });

  it("上传时请求头里没有长度:数到超过这条路由的上限即 413 —— 上限比框架缓冲上限小一截,被截断的请求体也数得出「超了」", async () => {
    // 框架最多交给网关 GATEWAY_BUFFER_LIMIT_BYTES;这里给的流正好那么长(= 一个更大的文件被截断之后的样子)
    const { req } = streamed("POST", "/api/flink/connectors", GATEWAY_BUFFER_LIMIT_BYTES - 256 * 1024);
    const out = await run(req);
    expect(out.status).toBe(413);
    expect(out.message).toBe(flinkConnectorTooLargeMessage());
  });

  it("登录前公开接口:网关不判大小(边缘照旧按 8KB 拦),原样放行", async () => {
    const out = await run(withLength(null, "POST", "/api/public/anything", 50 * MB));
    expect(out.passedOn).toBe(true);
  });
});

describe("🔴 请求头里没有 Content-Length:数实际读到的字节,超了照样 413 —— 不许因为没有长度就放行", () => {
  it("流式请求体 1MB ⇒ 放行", async () => {
    const { req } = streamed("PUT", "/api/etl-jobs/01JOBAAAA", 1 * MB);
    expect((await run(req)).passedOn).toBe(true);
  });

  it("流式请求体 9MB ⇒ 413(文案只说上限);数到超过上限就停,不把 9MB 读完", async () => {
    const { req, pulled } = streamed("PUT", "/api/etl-jobs/01JOBAAAA", 9 * MB);
    const out = await run(req);
    expect(out.status).toBe(413);
    expect(out.message).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES));
    expect(pulled()).toBeLessThan(6 * MB);
  });

  it("不带请求体的写请求(触发 / 发布这类 POST、DELETE)没有长度 ⇒ 放行", async () => {
    for (const m of ["POST", "DELETE"]) {
      const req = new NextRequest("http://x/api/workflow/wf-1/publish", { method: m, headers: { authorization: "Bearer developer" } });
      expect((await run(req)).passedOn, m).toBe(true);
    }
  });
});
