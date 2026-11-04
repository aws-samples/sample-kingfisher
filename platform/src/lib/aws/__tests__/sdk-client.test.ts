// 收尾 ③ —— 散建客户端的唯一构造入口 `sdkClient(use, Ctor, ...args)`。
// 承重三条:① 构造参数**原样**交给 SDK(行为保持);② 只有 data-plane 挂越区断言(拦截模式下零网络请求就拒);
// ③ 控制面 / 模型 / 中心件不挂(它们本来就只在主控区或按模型配置的区,不按落点)。
// 真 SDK 客户端 + build 步网络插桩(永不出网),不 mock 兄弟模块。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";
import { sdkClient } from "../clients";
import { runInPlace } from "@/lib/place/context";
import { CrossRegionDataPlaneCall, type Place } from "@/lib/place/types";

const USW2: Place = Object.freeze({
  targetId: "tgt_usw2_a", region: "us-west-2", accountId: "000000000000", partition: "aws", home: false,
  resources: {}, version: 1, source: "descriptor" as const,
});

function netStub(c: { middlewareStack: { add: (...a: any[]) => void } }) {
  const box = { n: 0 };
  c.middlewareStack.add(() => async () => { box.n++; throw new Error("net-stub"); }, { step: "build", name: "netStub", override: true });
  return box;
}

beforeEach(() => { process.env.BGP_PLACE_GUARD = "enforce"; });
afterEach(() => { delete process.env.BGP_PLACE_GUARD; });

describe("sdkClient", () => {
  it("构造参数原样交给 SDK(区 / 自定义选项都在)", async () => {
    const c = sdkClient("control-plane", S3Client, { region: "eu-central-1", maxAttempts: 7, forcePathStyle: true });
    expect(await c.config.region()).toBe("eu-central-1");
    expect(await c.config.maxAttempts()).toBe(7);
    expect(c.config.forcePathStyle).toBe(true);
  });

  it("🔴 data-plane:usw2 落点里用 us-east-1 的客户端 ⇒ CrossRegionDataPlaneCall,网络 0 次", async () => {
    const c = sdkClient("data-plane", S3Client, { region: "us-east-1" });
    const net = netStub(c);
    const err = await runInPlace(USW2, () => c.send(new ListBucketsCommand({}))).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CrossRegionDataPlaneCall);
    expect(net.n).toBe(0);
  });

  it("data-plane 同区 ⇒ 放行(打到网络插桩)", async () => {
    const c = sdkClient("data-plane", S3Client, { region: "us-west-2" });
    const net = netStub(c);
    await expect(runInPlace(USW2, () => c.send(new ListBucketsCommand({})))).rejects.toThrow("net-stub");
    expect(net.n).toBe(1);
  });

  it("控制面 / 模型 / 中心件不挂断言(主控区的平台表在任何落点的请求里都是合法调用)", async () => {
    for (const use of ["control-plane", "model", "central:agentcore", "central:openmetadata"] as const) {
      const c = sdkClient(use, S3Client, { region: "us-east-1" });
      const net = netStub(c);
      await expect(runInPlace(USW2, () => c.send(new ListBucketsCommand({}))), use).rejects.toThrow("net-stub");
      expect(net.n, use).toBe(1);
    }
  });

  it("data-plane 但区名非法(用户填错的数据源区)⇒ 照常构造、不挂断言(与原来 new 的行为相同,错误留给 SDK)", () => {
    expect(() => sdkClient("data-plane", S3Client, { region: "not-a-region" })).not.toThrow();
  });
});
