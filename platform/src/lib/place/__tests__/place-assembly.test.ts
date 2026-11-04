// @kf-batch 50-WP31-place-first-class
// WP-31 序 1 装配层:types ↔ resolve ↔ context ↔ route ↔ aws/clients ↔ observer 之间**一律不 mock**。
// 只替换真外部:注册表(DDB 边界)、Next 请求存储(Next 之外不存在)、网络(SDK build 步插桩,永不出网)。
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  targets: new Map<string, Record<string, unknown>>(),
  notReady: new Set<string>(),
}));

vi.mock("@/lib/exec-env/registry", async () => {
  class TargetNotReadyError extends Error {
    constructor(readonly targetId: string, why: string) {
      super(why);
      this.name = "TargetNotReadyError";
    }
  }
  return {
    HOME_TARGET_ID: "tgt_home",
    TargetNotReadyError,
    requireReadyTarget: vi.fn(async (id: string) => {
      const t = h.targets.get(id);
      if (!t || h.notReady.has(id)) throw new TargetNotReadyError(id, "not ready");
      return t;
    }),
    listTargetsRaw: vi.fn(async () => Array.from(h.targets.values())),
  };
});

import { AthenaClient, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { GlueClient, GetJobCommand, StartJobRunCommand } from "@aws-sdk/client-glue";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { resolvePlace, placeOfRequest, placeOfBinding, placeResource, targetRef } from "../resolve";
import { runInPlace, currentPlace, forEachPlace, notePlaceDecision, __setRequestStoreProvider } from "../context";
import { withPlace } from "../route";
import { PlaceUnavailable, PlaceUndecidable, CrossRegionDataPlaneCall, type Place } from "../types";
import { regionalClient, __resetClients } from "@/lib/aws/clients";
import {
  buildTargetIndex,
  judgeCall,
  installPlaceObserver,
  parseAwsHost,
  requestFacts,
  resourceIdsOfBody,
  placeObservationSummary,
  extractResourceIds,
  controlPlaneSecretTokens,
  __drainObserver,
  __setObserverTestHooks,
} from "../observer";

const ACCT = "000000000000";
const HOME = {
  pk: "env", sk: "tgt_home", targetId: "tgt_home", region: "us-east-1", accountId: ACCT, partition: "aws", version: 7,
  status: "active", ready: true, isHome: true,
  resources: { athenaWorkgroup: "bgp-athena", datalakeBucket: `bgp-datalake-${ACCT}`, tableBucket: "bgp-table-bucket", redshiftDatabase: "dev" },
};
const USW2 = {
  pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", region: "us-west-2", accountId: ACCT, partition: "aws", version: 3,
  status: "active", ready: true,
  resources: { athenaWorkgroup: "bgp-athena-tgt-usw2-a", datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`, tableBucket: "bgp-table-bucket-tgt-usw2-a", redshiftDatabase: "dev" },
};

/** 一个请求:Next 请求存储的最小替身(观测器只读它的 headers)。 */
function fakeRequest(url: string) {
  const store = { headers: new Headers({ "x-bgp-observe-url": url }) };
  __setRequestStoreProvider(() => store);
  return store;
}

/** 网络插桩:在 build 步计数并短路 —— 拦截模式在 initialize 步就抛,所以计数 = 0 才说明「零网络请求」。 */
function countNetwork(c: { middlewareStack: { add: (...a: any[]) => void } }) {
  const box = { n: 0 };
  c.middlewareStack.add(
    () => async () => {
      box.n++;
      throw new Error("net-stub");
    },
    { step: "build", name: "netStub", override: true }
  );
  return box;
}

beforeEach(() => {
  h.targets.clear();
  h.notReady.clear();
  h.targets.set("tgt_home", HOME);
  h.targets.set("tgt_usw2_a", USW2);
  __resetClients();
  __setRequestStoreProvider(() => undefined);
  delete process.env.BGP_PLACE_GUARD;
});
afterEach(() => __setRequestStoreProvider(null));

describe("resolvePlace:主控区也读描述符(不读 env 常量)", () => {
  it("home 的 region 来自 tgt_home 描述符 —— 判别夹具:env 故意写成别的区", async () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    try {
      const p = await resolvePlace({ kind: "home", reason: "project-inventory" });
      expect(p).toMatchObject({ targetId: "tgt_home", region: "us-east-1", home: true, version: 7, source: "descriptor" });
      expect(placeResource(p, "athenaWorkgroup")).toBe("bgp-athena");
    } finally {
      process.env.AWS_REGION = prev;
    }
  });

  it("非主控区:资源全部取自它自己的描述符", async () => {
    const p = await resolvePlace(targetRef("tgt_usw2_a"));
    expect(p).toMatchObject({ targetId: "tgt_usw2_a", region: "us-west-2", home: false });
    expect(placeResource(p, "athenaWorkgroup")).toBe("bgp-athena-tgt-usw2-a");
  });

  it("🔴 fail-closed:不就绪 / 不存在 / 缺 region / 缺资源 —— 一律报错,绝不回落主控区", async () => {
    h.notReady.add("tgt_usw2_a");
    await expect(resolvePlace(targetRef("tgt_usw2_a"))).rejects.toBeInstanceOf(PlaceUnavailable);
    await expect(resolvePlace(targetRef("tgt_nope"))).rejects.toBeInstanceOf(PlaceUnavailable);
    h.notReady.clear();
    h.targets.set("tgt_usw2_a", { ...USW2, region: "" });
    await expect(resolvePlace(targetRef("tgt_usw2_a"))).rejects.toThrow(/合法 region/);
    const p = await resolvePlace({ kind: "home", reason: "project-inventory" });
    expect(() => placeResource(p, "flinkRoleArn")).toThrow(PlaceUnavailable);
    expect(() => targetRef("not-a-target")).toThrow(PlaceUndecidable);
  });

  it("Place 是冻结快照(请求内同一份,改不动)", async () => {
    const p = await resolvePlace(targetRef("tgt_usw2_a"));
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.resources)).toBe(true);
  });
});

describe("决策:对象绑定 > URL 视角;推不出就 400,没有「没传 = 主控区」", () => {
  const req = (url: string, method = "GET") => new NextRequest(new URL(url, "http://localhost"), { method });

  it("读路由:视角选了一个区 ⇒ 那个区", () => {
    expect(placeOfRequest(req("/api/x?scope=tgt_usw2_a"))).toEqual({ kind: "target", targetId: "tgt_usw2_a" });
  });
  it("视角为全部 / 对比 / 缺省 / 非法 ⇒ PlaceUndecidable(不默认主控区)", () => {
    for (const u of ["/api/x", "/api/x?scope=global", "/api/x?scope=cmp:tgt_home,tgt_usw2_a", "/api/x?scope=BAD"]) {
      expect(() => placeOfRequest(req(u)), u).toThrow(PlaceUndecidable);
    }
  });
  it("🔴 写路由不读视角:POST 只给视角 ⇒ 拒;给了对象 ⇒ 用对象的绑定(视角被忽略)", () => {
    expect(() => placeOfRequest(req("/api/x?scope=tgt_usw2_a", "POST"))).toThrow(/不读视角/);
    expect(placeOfRequest(req("/api/x?scope=tgt_home", "POST"), { targets: ["tgt_usw2_a"] })).toEqual({
      kind: "target",
      targetId: "tgt_usw2_a",
    });
  });
  it("对象绑定:单个 ⇒ 它;多个 ⇒ 只许 forEachPlace;🔴 没有绑定 ⇒ 拒(不同于 bindingTargets 的「存量 = 主控区」)", () => {
    expect(placeOfBinding({ targetId: " tgt_usw2_a " })).toEqual({ kind: "target", targetId: "tgt_usw2_a" });
    expect(placeOfBinding({ targets: ["tgt_home", "tgt_home"] })).toEqual({ kind: "target", targetId: "tgt_home" });
    expect(() => placeOfBinding({ targets: ["tgt_home", "tgt_usw2_a"] })).toThrow(/forEachPlace/);
    expect(() => placeOfBinding({})).toThrow(PlaceUndecidable);
    expect(() => placeOfBinding(null)).toThrow(PlaceUndecidable);
  });
});

describe("withPlace:路由包装器", () => {
  it("视角区 ⇒ handler 在显式上下文里跑;视角全部 ⇒ 400 PLACE_UNDECIDABLE;不就绪 ⇒ 409", async () => {
    let seen: string | undefined;
    const GET = withPlace(async (_req, place) => {
      seen = currentPlace()?.targetId;
      return Response.json({ region: place.region });
    });
    const ok = await GET(new NextRequest("http://localhost/api/x?scope=tgt_usw2_a"), {});
    expect(await ok.json()).toEqual({ region: "us-west-2" });
    expect(seen).toBe("tgt_usw2_a");
    const bad = await GET(new NextRequest("http://localhost/api/x"), {});
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("PLACE_UNDECIDABLE");
    h.notReady.add("tgt_usw2_a");
    const busy = await GET(new NextRequest("http://localhost/api/x?scope=tgt_usw2_a"), {});
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toMatchObject({ code: "PLACE_UNAVAILABLE", detail: { targetId: "tgt_usw2_a" } });
  });

  it("objectOf:对象绑定优先;objectOf 自己回的响应(如 404)原样返回", async () => {
    const POST = withPlace(async (_r, place) => Response.json({ t: place.targetId }), {
      objectOf: async (r) => (r.nextUrl.searchParams.get("id") === "x" ? { targets: ["tgt_usw2_a"] } : new Response("nf", { status: 404 })),
    });
    expect(await (await POST(new NextRequest("http://localhost/api/o?id=x&scope=tgt_home", { method: "POST" }), {})).json()).toEqual({ t: "tgt_usw2_a" });
    expect((await POST(new NextRequest("http://localhost/api/o?id=y", { method: "POST" }), {})).status).toBe(404);
  });
});

describe("🔴 唯一工厂的越区断言(L3):拦截模式零网络请求;观测模式照常发出", () => {
  it("enforce:usw2 落点里用 us-east-1 客户端 ⇒ CrossRegionDataPlaneCall,网络 0 次", async () => {
    process.env.BGP_PLACE_GUARD = "enforce";
    const usw2 = await resolvePlace(targetRef("tgt_usw2_a"));
    const home = await regionalClient("athena", "us-east-1");
    const net = countNetwork(home);
    const err = await runInPlace(usw2, () => home.send(new StartQueryExecutionCommand({ QueryString: "select 1" }))).catch((e) => e);
    expect(err).toBeInstanceOf(CrossRegionDataPlaneCall);
    expect((err as CrossRegionDataPlaneCall).detail).toMatchObject({ clientRegion: "us-east-1", placeRegion: "us-west-2", targetId: "tgt_usw2_a" });
    expect(net.n).toBe(0);
  });

  it("负向对照(判别力):同区客户端 ⇒ 放行(走到网络插桩);没有上下文 ⇒ 放行", async () => {
    process.env.BGP_PLACE_GUARD = "enforce";
    const usw2 = await resolvePlace(targetRef("tgt_usw2_a"));
    const c = await regionalClient("athena", "us-west-2");
    const net = countNetwork(c);
    await expect(runInPlace(usw2, () => c.send(new StartQueryExecutionCommand({ QueryString: "select 1" })))).rejects.toThrow("net-stub");
    const home = await regionalClient("glue", "us-east-1");
    const net2 = countNetwork(home);
    await expect(home.send(new GetJobCommand({ JobName: "j" }))).rejects.toThrow("net-stub");
    expect([net.n, net2.n]).toEqual([1, 1]);
  });

  it("observe(缺省)与拼错的模式值:越区也放行(序 6 之前不拦)", async () => {
    for (const mode of [undefined, "ENFORCE", "on"]) {
      if (mode === undefined) delete process.env.BGP_PLACE_GUARD;
      else process.env.BGP_PLACE_GUARD = mode;
      __resetClients();
      const usw2 = await resolvePlace(targetRef("tgt_usw2_a"));
      const home = await regionalClient("athena", "us-east-1");
      const net = countNetwork(home);
      await expect(runInPlace(usw2, () => home.send(new StartQueryExecutionCommand({ QueryString: "q" })))).rejects.toThrow("net-stub");
      expect(net.n, String(mode)).toBe(1);
    }
  });

  it("forEachPlace:每个分支各见各的落点(并发不串),退出后恢复父上下文", async () => {
    const [a, b] = [await resolvePlace(targetRef("tgt_home")), await resolvePlace(targetRef("tgt_usw2_a"))];
    const seen = await runInPlace(a, () =>
      forEachPlace([b, a, b], async (p) => {
        await new Promise((r) => setTimeout(r, p.home ? 1 : 5));
        return `${p.targetId}=${currentPlace()?.targetId}`;
      }).then((r) => [...r, `parent=${currentPlace()?.targetId}`])
    );
    expect(seen).toEqual(["tgt_usw2_a=tgt_usw2_a", "tgt_home=tgt_home", "tgt_usw2_a=tgt_usw2_a", "parent=tgt_home"]);
  });
});

describe("🔴🔴 全局观测器(真 SDK → 真 Node http → 诊断通道;本机假服务端,永不出网)", () => {
  const lines: Record<string, any>[] = [];
  let server: http.Server;
  let port = 0;
  let hits = 0;
  // 任何主机名都解析到本机 ⇒ 主机头仍是真实的 AWS 端点形状(观测器靠它判区)
  // Node 20 默认 autoSelectFamily ⇒ lookup 以 `all: true` 调,回调要数组形态;两种都给
  const lookup = (_h: string, o: { all?: boolean }, cb: (e: null, a: unknown, f?: number) => void) =>
    o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  const agent = new http.Agent({ lookup: lookup as any });
  const handler = new NodeHttpHandler({ httpAgent: agent });
  const creds = { accessKeyId: "AKIDTEST", secretAccessKey: "x" };
  const ep = (svc: string, region: string) => `http://${svc}.${region}.amazonaws.com:${port}`;
  // 🔴 「模块级单例」:在任何请求上下文之外、装观测器之前就建好
  let singletonHomeAthena: AthenaClient;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      res.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify({ __type: "InvalidRequestException", message: "stub" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    singletonHomeAthena = new AthenaClient({ region: "us-east-1", endpoint: ep("athena", "us-east-1"), credentials: creds, requestHandler: handler, maxAttempts: 1 });
    expect(await installPlaceObserver()).toBe(true);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  beforeEach(() => {
    lines.length = 0;
    hits = 0;
    __setObserverTestHooks({ loader: async () => buildTargetIndex(Array.from(h.targets.values()) as any, "tgt_home"), sink: (l) => lines.push(l) });
  });

  const violations = () => lines.filter((l) => l.event === "place.observe.violation");
  const athena = (region: string) => new AthenaClient({ region, endpoint: ep("athena", region), credentials: creds, requestHandler: handler, maxAttempts: 1 });

  it("B-26 形态:us-west-2 视角 + 解析层走了「没传 = 主控区」+ 主控区单例 ⇒ 记违规 + EMF 指标", async () => {
    fakeRequest("/api/genbi/ask?scope=tgt_usw2_a");
    notePlaceDecision({ targetId: null, via: "resolveAthenaPlace" });
    await singletonHomeAthena.send(new StartQueryExecutionCommand({ QueryString: "q", WorkGroup: "bgp-athena" })).catch(() => {});
    await __drainObserver();
    expect(hits, "请求真的发到了(假)服务端").toBe(1);
    const v = violations();
    expect(v).toHaveLength(1);
    expect(v[0].kinds).toEqual(expect.arrayContaining(["implicit-home-under-target-view", "cross-region", "foreign-resource"]));
    expect(v[0]).toMatchObject({ service: "athena", operation: "StartQueryExecution", clientRegion: "us-east-1", url: "/api/genbi/ask?scope=tgt_usw2_a" });
    expect(v[0]._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: "BGP/Place", Metrics: [{ Name: "CrossRegionDataPlaneCall" }] });
    expect(v[0].CrossRegionDataPlaneCall).toBe(1);
    expect(JSON.stringify(v[0]), "🔴 不许把请求体(SQL)记进日志").not.toContain("QueryString");
    expect(v[0].resourceIds, "违规行带资源名(归不了属的也要看得见)").toContain("bgp-athena");
  });

  it("负向对照:同一视角、显式决策 usw2、usw2 客户端 + usw2 工作组 ⇒ 0 违规", async () => {
    fakeRequest("/api/genbi/ask?scope=tgt_usw2_a");
    notePlaceDecision({ targetId: "tgt_usw2_a", via: "resolveAthenaPlace" });
    await athena("us-west-2").send(new StartQueryExecutionCommand({ QueryString: "q", WorkGroup: "bgp-athena-tgt-usw2-a" })).catch(() => {});
    await __drainObserver();
    expect(violations()).toEqual([]);
    expect(placeObservationSummary().counts).toMatchObject({ "ok|athena": 1 });
  });

  it("E4(S3 全局桶名):usw2 客户端读主控区的桶(虚拟主机式)⇒ foreign-resource + resource-region-mismatch", async () => {
    fakeRequest("/api/files?scope=tgt_usw2_a");
    const s3 = new S3Client({ region: "us-west-2", endpoint: ep("s3", "us-west-2"), credentials: creds, requestHandler: handler, maxAttempts: 1 });
    await s3.send(new GetObjectCommand({ Bucket: `bgp-datalake-${ACCT}`, Key: "k" })).catch(() => {});
    await __drainObserver();
    expect(violations()[0]?.kinds).toEqual(expect.arrayContaining(["foreign-resource", "resource-region-mismatch"]));
  });

  it("请求体里的 ARN:usw2 视角下 Glue 作业带着主控区的角色 ⇒ foreign-resource(IAM 是全局的,这种错不会报错)", async () => {
    fakeRequest("/api/etl-jobs/run?scope=tgt_usw2_a");
    h.targets.set("tgt_home", { ...HOME, resources: { ...HOME.resources, glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role` } });
    const glue = new GlueClient({ region: "us-west-2", endpoint: ep("glue", "us-west-2"), credentials: creds, requestHandler: handler, maxAttempts: 1 });
    await glue.send(new StartJobRunCommand({ JobName: "j", Arguments: { "--role": `arn:aws:iam::${ACCT}:role/bgp-glue-role` } })).catch(() => {});
    await __drainObserver();
    expect(violations()[0]?.kinds).toEqual(["foreign-resource"]);
  });

  it("显式上下文优先于视角:runInPlace(home) 里用主控区客户端 ⇒ 不报 cross-region", async () => {
    // 落点在请求外解析(后台循环的形态)⇒ 本请求账本里没有决策,只剩视角 usw2 与显式上下文 home —— 判别夹具
    const home = await resolvePlace({ kind: "home", reason: "project-inventory" });
    fakeRequest("/api/x?scope=tgt_usw2_a");
    await runInPlace(home, () => athena("us-east-1").send(new StartQueryExecutionCommand({ QueryString: "q" })).catch(() => {}));
    await __drainObserver();
    expect(hits).toBe(1);
    expect(violations().filter((v) => v.kinds.includes("cross-region"))).toEqual([]);
  });

  it("请求外 / 全局视角且无决策 ⇒ unattributed(只计数,不记违规)", async () => {
    __setRequestStoreProvider(() => undefined);
    await athena("us-east-1").send(new StartQueryExecutionCommand({ QueryString: "q" })).catch(() => {});
    fakeRequest("/api/jobs");
    await athena("us-east-1").send(new StartQueryExecutionCommand({ QueryString: "q" })).catch(() => {});
    await __drainObserver();
    expect(violations()).toEqual([]);
    const s = placeObservationSummary();
    expect(s.counts).toMatchObject({ "unattributed|athena": 2 });
    expect(Object.keys(s.unattributedTop as object)).toEqual(expect.arrayContaining(["athena.StartQueryExecution (请求外)", "athena.StartQueryExecution /api/jobs"]));
  });

  it("同一违规 60s 内只打一行(其余计 suppressed),免得一轮硬门把日志打爆", async () => {
    fakeRequest("/api/genbi/ask?scope=tgt_usw2_a");
    for (let i = 0; i < 5; i++) {
      await singletonHomeAthena.send(new StartQueryExecutionCommand({ QueryString: "q", WorkGroup: "bgp-athena" })).catch(() => {});
    }
    await __drainObserver();
    expect(violations()).toHaveLength(1);
    expect(placeObservationSummary().counts).toMatchObject({ suppressed: 4 });
  });

  it("🔴 观测器永不影响调用本身:索引装不出来 ⇒ 调用照常到达服务端,只计 indexUnavailable", async () => {
    __setObserverTestHooks({ loader: async () => { throw new Error("ddb down"); }, sink: (l) => lines.push(l) });
    fakeRequest("/api/genbi/ask?scope=tgt_usw2_a");
    await singletonHomeAthena.send(new StartQueryExecutionCommand({ QueryString: "q" })).catch(() => {});
    await __drainObserver();
    expect(hits).toBe(1);
    expect(placeObservationSummary().indexUnavailable).toBe(1);
  });

  it("重复安装是幂等的(不会订阅两次 ⇒ 一次请求只记一笔)", async () => {
    expect(await installPlaceObserver()).toBe(true);
    fakeRequest("/api/x?scope=tgt_usw2_a");
    await athena("us-west-2").send(new StartQueryExecutionCommand({ QueryString: "q" })).catch(() => {});
    await __drainObserver();
    expect(placeObservationSummary().counts).toEqual({ "ok|athena": 1 });
  });

  it("拿不到 getBuiltinModule(Node < 20.16)/ 拿不到诊断通道 ⇒ 如实报 unavailable、返回 false,不抛", async () => {
    vi.resetModules();
    const fresh = await import("../observer");
    const out: Record<string, any>[] = [];
    fresh.__setObserverTestHooks({ sink: (l) => out.push(l) });
    const orig = (process as any).getBuiltinModule;
    (process as any).getBuiltinModule = undefined;
    try {
      expect(await fresh.installPlaceObserver()).toBe(false);
    } finally {
      (process as any).getBuiltinModule = orig;
    }
    expect(await fresh.installPlaceObserver(() => undefined)).toBe(false);
    expect(out.map((l) => l.event)).toEqual(["place.observe.unavailable", "place.observe.unavailable"]);
  });
});

describe("🔴🔴 上下文与账本是**进程级**单例(Next 把同一源文件编成多个模块实例)", () => {
  it("两个独立的模块实例:A 里 runInPlace / 记决策,B 里看得见", async () => {
    vi.resetModules();
    const A = await import("../context");
    vi.resetModules();
    const B = await import("../context");
    expect(A).not.toBe(B);
    const store = {};
    A.__setRequestStoreProvider(() => store);
    B.__setRequestStoreProvider(() => store);
    A.notePlaceDecision({ targetId: "tgt_usw2_a", via: "x" });
    expect(B.decisionsOfCurrentRequest().decisions).toEqual([{ targetId: "tgt_usw2_a", via: "x" }]);
    const p = { targetId: "tgt_usw2_a", region: "us-west-2" } as Place;
    expect(A.runInPlace(p, () => B.currentPlace()?.targetId)).toBe("tgt_usw2_a");
    A.__setRequestStoreProvider(null);
    B.__setRequestStoreProvider(null);
  });
});

describe("主机名 / 请求 → 事实(纯函数)", () => {
  it("parseAwsHost:区域端点 / S3 虚拟主机 / 全局端点 / 非 AWS", () => {
    expect(parseAwsHost("athena.us-west-2.amazonaws.com")).toEqual({ service: "athena", region: "us-west-2" });
    expect(parseAwsHost("bgp-datalake-1.s3.us-east-1.amazonaws.com:443")).toEqual({ service: "s3", region: "us-east-1", bucket: "bgp-datalake-1" });
    expect(parseAwsHost("s3tables.us-west-2.amazonaws.com")).toEqual({ service: "s3tables", region: "us-west-2" });
    expect(parseAwsHost("glue-fips.us-east-1.amazonaws.com")).toEqual({ service: "glue", region: "us-east-1" });
    expect(parseAwsHost("iam.amazonaws.com")).toEqual({ service: "iam", region: "global" });
    expect(parseAwsHost("openmetadata.internal:8585")).toBeNull();
  });
  it("requestFacts:x-amz-target 取操作;S3 Tables 路径里的表桶 ARN 抽成资源;S3 的 body 永不解析", () => {
    const req = (host: string, path: string, h: Record<string, string> = {}) => ({ method: "GET", path, getHeader: (n: string) => (n === "host" ? host : h[n]) });
    const t = requestFacts(req("s3tables.us-west-2.amazonaws.com", "/namespaces/arn%3Aaws%3As3tables%3Aus-west-2%3A000000000000%3Abucket%2Fbgp-table-bucket-tgt-usw2-a"), undefined)!;
    expect(t).toMatchObject({ service: "s3tables", clientRegion: "us-west-2" });
    expect(t.resourceIds).toContain("bgp-table-bucket-tgt-usw2-a");
    const a = requestFacts(req("athena.us-east-1.amazonaws.com", "/", { "x-amz-target": "AmazonAthena.GetQueryResults" }), '{"QueryExecutionId":"q"}')!;
    expect(a.operation).toBe("GetQueryResults");
    expect(resourceIdsOfBody("s3", '{"Bucket":"bgp-datalake-x","arn":"arn:aws:iam::000000000000:role/r"}')).toEqual([]);
  });
});

describe("judgeCall / 资源抽取(纯函数)", () => {
  const idx = buildTargetIndex([HOME, USW2] as any, "tgt_home");

  it("主控区的控制面服务豁免;同一服务建在别的区就照常判", () => {
    const base = { operation: "Q", decisions: [], view: { kind: "target" as const, targetId: "tgt_usw2_a" }, resourceIds: [] };
    expect(judgeCall({ ...base, service: "dynamodb", clientRegion: "us-east-1" }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...base, service: "dynamodb", clientRegion: "eu-west-1" }, idx).kinds).toEqual(["cross-region"]);
  });

  it("平台自身遥测(monitoring.PutMetricData @ 主控区)= 控制面;读某区作业指标(GetMetricStatistics)仍按区判", () => {
    const f = { decisions: [], view: { kind: "target" as const, targetId: "tgt_usw2_a" }, resourceIds: [] };
    expect(judgeCall({ ...f, service: "monitoring", operation: "PutMetricData", clientRegion: "us-east-1" }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...f, service: "monitoring", operation: "GetMetricStatistics", clientRegion: "us-east-1" }, idx).kinds).toEqual(["cross-region"]);
    expect(judgeCall({ ...f, service: "monitoring", operation: "PutMetricData", clientRegion: "eu-west-1" }, idx).kinds).toEqual(["cross-region"]);
  });

  // 序 31 三刀 IAM 侧(2026-10-21):账号级清点 s3.ListBuckets @ 主控区 = 控制面(测试账号 observe 实测它是 unattributedTop 仅剩的 1 类);
  //   同服务别的操作(ListObjectsV2 等)碰的是某个区的桶 ⇒ 仍按区判;在别的区发 ListBuckets 也不豁免。
  it("账号级清点 s3.ListBuckets @ 主控区 = 控制面;s3 别的操作仍按区判;别的区发 ListBuckets 不豁免", () => {
    const f = { decisions: [], view: { kind: "target" as const, targetId: "tgt_usw2_a" }, resourceIds: [] };
    expect(judgeCall({ ...f, service: "s3", operation: "ListBuckets", clientRegion: "us-east-1" }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...f, service: "s3", operation: "ListObjectsV2", clientRegion: "us-east-1" }, idx).kinds).toEqual(["cross-region"]);
    expect(judgeCall({ ...f, service: "s3", operation: "ListBuckets", clientRegion: "eu-west-1" }, idx).kinds).toEqual(["cross-region"]);
  });

  // @kf-batch 50-WP31-place-first-class —— 第十一轮越区清单只剩中心件两类 ⇒ 声明它们(central.ts),且**只认资源名 / 显式决策**
  it("🔴 中心件 OM:请求明确落在 us-west-2 时取 OM bot 密钥 @ 主控区 = 合法;同场景取数据源密钥 = 越区(负向对照)", () => {
    const f = { service: "secretsmanager", operation: "GetSecretValue", clientRegion: "us-east-1", explicit: { targetId: "tgt_usw2_a", region: "us-west-2" }, decisions: [], view: null };
    expect(judgeCall({ ...f, resourceIds: ["bgp/om/ingestion-bot-token"] }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...f, resourceIds: ["arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/om/ingestion-bot-token-AbCd"] }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...f, resourceIds: ["bgp/datasource/ds-01"] }, idx).kinds).toEqual(["cross-region"]);
    expect(judgeCall({ ...f, resourceIds: ["bgp/om/ingestion-bot-token", "bgp/datasource/ds-01"] }, idx).kinds, "混一个非中心件资源 ⇒ 不豁免").toEqual(["cross-region"]);
    expect(judgeCall({ ...f, resourceIds: [] }, idx).kinds, "抽不到资源名 ⇒ 不豁免(不按服务整块放过)").toEqual(["cross-region"]);
    expect(judgeCall({ ...f, clientRegion: "eu-west-1", resourceIds: ["bgp/om/ingestion-bot-token"] }, idx).kinds, "中心件只在主控区").toEqual(["cross-region"]);
  });

  // @kf-batch 50-WP31-place-first-class —— 序 31 第二刀 ②:平台自身的内部端点共享密钥(推进泵 / 内部守卫每 5 分钟读一次,
  //   第四十三轮 observe 实测 16 次请求外 + 8 次 sweep 路由)= 控制面;靠 env 里那一个 ARN 的资源 token 认,不整块豁免 secretsmanager。
  it("🔴 平台控制面密钥(ACTION_DISPATCH_SECRET_ARN)@ 主控区 = control;数据源密钥 / 别的区 / 索引没登记 ⇒ 照常判", () => {
    const ARN = "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/internal/action-dispatch-key-Ab12Cd";
    const idxWithKey = buildTargetIndex([HOME, USW2] as any, "tgt_home", { controlSecretIds: controlPlaneSecretTokens(ARN) });
    // 资源 token 的来源与观测器从**请求体**抽出来的完全同一条路(resourceIdsOfBody)⇒ 两侧 token 必然一致;这里就用它造事实
    const ids = (arn: string) => resourceIdsOfBody("secretsmanager", JSON.stringify({ SecretId: arn }));
    const f = { service: "secretsmanager", operation: "GetSecretValue", clientRegion: "us-east-1", decisions: [], view: null };
    expect(judgeCall({ ...f, resourceIds: ids(ARN) }, idxWithKey).kinds, "请求外读内部密钥(泵)").toEqual(["control"]);
    expect(
      judgeCall({ ...f, resourceIds: ids(ARN), view: { kind: "target" as const, targetId: "tgt_usw2_a" } }, idxWithKey).kinds,
      "非主控区视角下的 sweep 路由读内部密钥:仍是控制面,不报 cross-region"
    ).toEqual(["control"]);
    expect(
      judgeCall({ ...f, resourceIds: ids("arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/ds-01-XyZ") }, idxWithKey).kinds,
      "数据源密钥不是控制面"
    ).toEqual(["unattributed"]);
    expect(judgeCall({ ...f, clientRegion: "eu-west-1", resourceIds: ids(ARN) }, idxWithKey).kinds, "控制面密钥只在主控区").toEqual(["unattributed"]);
    expect(judgeCall({ ...f, resourceIds: ids(ARN) }, idx).kinds, "索引没登记控制面密钥(env 缺)⇒ 不豁免").toEqual(["unattributed"]);
    expect(judgeCall({ ...f, resourceIds: [] }, idxWithKey).kinds, "抽不到资源名 ⇒ 不豁免").toEqual(["unattributed"]);
    expect(judgeCall({ ...f, operation: "PutSecretValue", resourceIds: ids(ARN) }, idxWithKey).kinds, "只豁免读取").toEqual(["unattributed"]);
    expect(controlPlaneSecretTokens(undefined).size, "env 缺 ⇒ 空集(不是把所有密钥都放过)").toBe(0);
    expect(controlPlaneSecretTokens("  ").size).toBe(0);
  });

  it("接线:观测器装载索引时把 env 里的控制面密钥 ARN 交给 buildTargetIndex(漏接 ⇒ 判据上面全绿而真环境照样未归因)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../observer.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const loaderBody = src.slice(src.indexOf("let loader: IndexLoader"), src.indexOf("let cached"));
    expect(loaderBody).toMatch(/controlSecretIds: controlPlaneSecretTokens\(process\.env\.ACTION_DISPATCH_SECRET_ARN\)/);
    // 读这把钥匙的两处(泵 / 内部守卫)与观测器用的是同一个 env 键 —— 三处字面一致才是「同一把钥匙」
    for (const rel of ["../../dataplane-jobs/pump.ts", "../../scheduler/internal-guard.ts"]) {
      expect(readFileSync(new URL(rel, import.meta.url), "utf8"), rel).toContain("process.env.ACTION_DISPATCH_SECRET_ARN");
    }
  });

  it("🔴 中心件 AgentCore:问数指标路由显式记了 central 决策 ⇒ 主控区读指标合法;没记的同一调用 = 越区", () => {
    const f = { service: "monitoring", operation: "GetMetricStatistics", clientRegion: "us-east-1", view: { kind: "target" as const, targetId: "tgt_usw2_a" }, resourceIds: [] };
    expect(judgeCall({ ...f, decisions: [{ targetId: "tgt_home", via: "genbi-observability", homeReason: "central:agentcore" }] }, idx).kinds).toEqual(["ok"]);
    expect(judgeCall({ ...f, decisions: [] }, idx).kinds).toEqual(["cross-region"]);
  });

  it("接线:问数指标路由在**第一个 await 之前**声明中心件(放到 await 之后账本看不见,D11)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../app/api/observability/genbi/route.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const body = src.slice(src.indexOf("export async function GET"));
    const note = body.indexOf('noteCentralComponent("agentcore"');
    expect(note, "没声明").toBeGreaterThan(0);
    expect(note, "声明在 await 之后").toBeLessThan(body.indexOf("await "));
  });

  it("隐式主控区只在**数据面**调用上报;同一请求里读注册表的那次控制面调用不报", () => {
    const f = { operation: "Q", decisions: [{ targetId: null, via: "resolveAthenaPlace" }], view: { kind: "target" as const, targetId: "tgt_usw2_a" }, resourceIds: [] };
    expect(judgeCall({ ...f, service: "dynamodb", clientRegion: "us-east-1" }, idx).kinds).toEqual(["control"]);
    expect(judgeCall({ ...f, service: "athena", clientRegion: "us-east-1" }, idx).kinds).toEqual(["implicit-home-under-target-view", "cross-region"]);
  });

  it("太短 / 多个 target 共有的资源值不进归属索引(`dev` 不许把一切都判成主控区的)", () => {
    expect(idx.ownerOf.has("dev")).toBe(false);
    expect(idx.ownerOf.get("bgp-athena-tgt-usw2-a")).toBe("tgt_usw2_a");
  });

  it("从 s3:// URI、ARN、联邦目录引用里抽出桶名", () => {
    const ids = extractResourceIds({
      ResultConfiguration: { OutputLocation: "s3://bgp-datalake-x/athena-results/" },
      QueryExecutionContext: { Catalog: "s3tablescatalog/bgp-table-bucket-tgt-usw2-a" },
      tableBucketARN: "arn:aws:s3tables:us-west-2:000000000000:bucket/bgp-table-bucket-tgt-usw2-a",
    });
    expect(ids).toEqual(expect.arrayContaining(["bgp-datalake-x", "bgp-table-bucket-tgt-usw2-a"]));
  });
});
