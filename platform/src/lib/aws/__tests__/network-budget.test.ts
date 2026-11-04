// ③ —— SDK 客户端的网络预算(lib/aws/clients.ts withNetworkBudget,唯一作者)。
//
// 【缺陷原形】平台进程里一次 IAM GetRole 在上一跳之后空档 64 秒才到达(CloudTrail),CPU 14% / 无限流 / 无 5xx —— AWS SDK v3 缺省
//   connectionTimeout = requestTimeout = 0,一跳停顿只能干等,外层 CloudFront 60 秒就 504。
// 【判据钉的事实】
//   ① 两个工厂入口(sdkClient / regionalClient)与 Redshift Data / DynamoDB 都带预算:connectionTimeout 5 s、socketTimeout 60 s、maxAttempts 3;
//   ② 🔴 model / central:agentcore 不设空闲超时(推理 / 智能体流式响应会合法沉默),但仍有建连预算;
//   ③ 调用方显式给的 requestHandler / maxAttempts 原样保留(sdk-client.test 的「构造参数原样」继续成立);
//   ④ 🔴 真 socket 事实:对端建连后持续不回字节 ⇒ 到点 TimeoutError、SDK 标准重试到 maxAttempts 才放弃(有界),不再无限期挂住。
// 真 SDK 客户端 + 本机 TCP 服务(永不出网),不 mock 兄弟模块。
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { sdkClient, regionalClient, redshiftDataClient, dynamoDocClient, withNetworkBudget, SDK_NETWORK_BUDGET, __resetClients } from "../clients";

async function handlerConfig(client: { config: { requestHandler: unknown } }): Promise<Record<string, unknown>> {
  const handler = client.config.requestHandler as NodeHttpHandler & { configProvider: Promise<Record<string, unknown>> };
  expect(handler).toBeInstanceOf(NodeHttpHandler);
  return handler.configProvider;
}

describe("withNetworkBudget:预算形态", () => {
  it("控制面 / 数据面 / OM 中心件:connectionTimeout 5000 + socketTimeout 60000 + maxAttempts 3(调用方其它选项原样)", () => {
    for (const use of ["control-plane", "data-plane", "central:openmetadata"] as const) {
      expect(withNetworkBudget(use, { region: "us-east-1", forcePathStyle: true }), use).toEqual({
        region: "us-east-1", forcePathStyle: true,
        requestHandler: { connectionTimeout: 5000, socketTimeout: 60000 },
        maxAttempts: 3,
      });
    }
    expect(SDK_NETWORK_BUDGET).toEqual({ connectionTimeoutMs: 5000, socketTimeoutMs: 60000, maxAttempts: 3 });
  });

  it("🔴 model / central:agentcore:只有建连预算,**没有**空闲超时键(慢回答不是故障)", () => {
    for (const use of ["model", "central:agentcore"] as const) {
      const out = withNetworkBudget(use, { region: "us-east-1" });
      expect(out.requestHandler, use).toEqual({ connectionTimeout: 5000 });
      expect("socketTimeout" in out.requestHandler, use).toBe(false);
      expect(out.maxAttempts).toBe(3);
    }
  });

  it("调用方显式给了 requestHandler / maxAttempts ⇒ 原样保留", () => {
    const mine = { connectionTimeout: 1 };
    const out = withNetworkBudget("control-plane", { region: "us-east-1", requestHandler: mine, maxAttempts: 7 });
    expect(out.requestHandler).toBe(mine);
    expect(out.maxAttempts).toBe(7);
  });
});

describe("两个工厂入口都把预算装进真 SDK 客户端", () => {
  afterAll(() => __resetClients());

  it("sdkClient(control-plane):NodeHttpHandler 配置 = 5000 / 60000;maxAttempts 3", async () => {
    const c = sdkClient("control-plane", S3Client, { region: "us-east-1" });
    expect(await handlerConfig(c)).toMatchObject({ connectionTimeout: 5000, socketTimeout: 60000 });
    expect(await c.config.maxAttempts()).toBe(3);
  });

  it("sdkClient(model):只有 connectionTimeout", async () => {
    const c = sdkClient("model", S3Client, { region: "us-east-1" });
    const cfg = await handlerConfig(c);
    expect(cfg.connectionTimeout).toBe(5000);
    expect(cfg.socketTimeout).toBeUndefined();
  });

  it("regionalClient / redshiftDataClient / dynamoDocClient(数据面按区缓存)同样带预算", async () => {
    __resetClients();
    const secrets = await regionalClient("secrets", "us-east-1");
    expect(await handlerConfig(secrets as never)).toMatchObject({ connectionTimeout: 5000, socketTimeout: 60000 });
    expect(await (secrets as S3Client).config.maxAttempts()).toBe(3);
    const rsd = redshiftDataClient("us-west-2");
    expect(await handlerConfig(rsd as never)).toMatchObject({ connectionTimeout: 5000, socketTimeout: 60000 });
    const doc = await dynamoDocClient("us-west-2");
    const base = (doc as unknown as { config: { requestHandler: unknown } });
    expect(await handlerConfig(base)).toMatchObject({ connectionTimeout: 5000, socketTimeout: 60000 });
  });
});

describe("🔴 真 socket:对端建连后不回字节 ⇒ 到点失败并有界重试", () => {
  let server: Server;
  let port = 0;
  const sockets = new Set<Socket>();
  const accepted: number[] = [];

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("socketTimeout 300 ms ⇒ TimeoutError;$metadata.attempts === 3(与 SDK_NETWORK_BUDGET.maxAttempts 相同形态的有界重试);总耗时远小于无预算时的无限期", async () => {
    server = createServer((sock) => { sockets.add(sock); accepted.push(Date.now()); sock.on("data", () => { /* 收下请求,永不回应 */ }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
    // 预算形态与工厂一致,只把空闲超时缩到 300 ms 让判据在秒级内跑完(缩的是数值,不是机制)
    const c = sdkClient("control-plane", S3Client, {
      region: "us-east-1", endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true,
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
      requestHandler: { connectionTimeout: SDK_NETWORK_BUDGET.connectionTimeoutMs, socketTimeout: 300 },
    });
    const started = Date.now();
    const err = await c.send(new ListBucketsCommand({})).then(() => null, (e: unknown) => e as Error & { $metadata?: { attempts?: number } });
    const elapsed = Date.now() - started;
    expect(err).toBeTruthy();
    expect(err!.name).toBe("TimeoutError");
    expect(err!.$metadata?.attempts).toBe(SDK_NETWORK_BUDGET.maxAttempts);
    expect(accepted.length, "每次重试都真的重新建连").toBe(SDK_NETWORK_BUDGET.maxAttempts);
    expect(elapsed).toBeLessThan(5_000);
  });
});
