// @kf-batch 50-WP28-platform-action-node
// 🔴🔴 内部端点守卫:无身份 / 错身份 ⇒ 401/403;经 CloudFront(公网)进来 ⇒ 403;没配密钥 ⇒ 503(fail-closed)。
// 外加三条**接线**判据:中间件对 /api/internal/ 先挡 CloudFront;路由先过守卫再碰命令;请求体只认 commandId。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyInternalCaller,
  __resetInternalKeyCache,
  INTERNAL_KEY_HEADER,
  INTERNAL_SOURCE_HEADER,
  INTERNAL_SOURCE_ACTION_DISPATCHER,
  CLOUDFRONT_ORIGIN_HEADER,
} from "@/lib/scheduler/internal-guard";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (rel: string) =>
  readFileSync(resolve(SRC, rel), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const ARN = "arn:aws:secretsmanager:us-east-1:{acct}:secret:bgp/internal/action-dispatch-key-AbCdEf";
const KEY = "s3cr3t-key-value-0123456789";

function h(over: Record<string, string | null> = {}): Headers {
  const base: Record<string, string> = {
    [INTERNAL_SOURCE_HEADER]: INTERNAL_SOURCE_ACTION_DISPATCHER,
    [INTERNAL_KEY_HEADER]: KEY,
  };
  const out = new Headers();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) out.set(k, v);
  return out;
}

beforeEach(() => __resetInternalKeyCache());

describe("内部端点守卫(WP-28 序 3/4)", () => {
  const load = async () => KEY;

  it("正确来源 + 正确密钥 ⇒ 放行,映射为系统主体且带 via=schedule", async () => {
    const v = await verifyInternalCaller(h(), { secretArn: ARN, loadSecret: load });
    expect(v).toEqual({ ok: true, principal: { actor: "system:action-dispatcher", via: "schedule" } });
  });

  it("经 CloudFront 进来(带 X-Amz-Cf-Id)⇒ 403,即使密钥正确", async () => {
    const v = await verifyInternalCaller(h({ [CLOUDFRONT_ORIGIN_HEADER]: "abc==" }), { secretArn: ARN, loadSecret: load });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("来源头缺 / 不对 ⇒ 403", async () => {
    for (const src of [null, "someone-else"]) {
      const v = await verifyInternalCaller(h({ [INTERNAL_SOURCE_HEADER]: src }), { secretArn: ARN, loadSecret: load });
      expect(v, String(src)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("无密钥 ⇒ 401;错密钥 ⇒ 401(含长度相同的错值)", async () => {
    expect(await verifyInternalCaller(h({ [INTERNAL_KEY_HEADER]: null }), { secretArn: ARN, loadSecret: load })).toMatchObject({ ok: false, status: 401 });
    expect(await verifyInternalCaller(h({ [INTERNAL_KEY_HEADER]: "wrong" }), { secretArn: ARN, loadSecret: load })).toMatchObject({ ok: false, status: 401 });
    const sameLen = KEY.replace(/.$/, "X");
    expect(await verifyInternalCaller(h({ [INTERNAL_KEY_HEADER]: sameLen }), { secretArn: ARN, loadSecret: load })).toMatchObject({ ok: false, status: 401 });
  });

  it("🔴 没配密钥 ARN / 读不到 / 密钥为空 ⇒ 503 fail-closed(绝不「没配就放行」)", async () => {
    expect(await verifyInternalCaller(h(), { secretArn: "", loadSecret: load })).toMatchObject({ ok: false, status: 503 });
    expect(await verifyInternalCaller(h(), { secretArn: ARN, loadSecret: async () => { throw new Error("AccessDenied"); } })).toMatchObject({ ok: false, status: 503 });
    __resetInternalKeyCache();
    expect(await verifyInternalCaller(h(), { secretArn: ARN, loadSecret: async () => "" })).toMatchObject({ ok: false, status: 503 });
  });

  it("密钥轮换:缓存里是旧值时强读一次新值,新密钥立即可用", async () => {
    let cur = "old-key-0000000000000000000";
    const loader = async () => cur;
    expect((await verifyInternalCaller(h({ [INTERNAL_KEY_HEADER]: cur }), { secretArn: ARN, loadSecret: loader, now: () => 1000 })).ok).toBe(true);
    cur = KEY;
    expect((await verifyInternalCaller(h(), { secretArn: ARN, loadSecret: loader, now: () => 40_000 })).ok).toBe(true);
  });
});

describe("接线:中间件 / 路由", () => {
  it("中间件对 /api/internal/ 在 JWT 校验之前先挡 CloudFront 来源;且只 import 纯头部模块(edge 安全)", () => {
    const mw = code("middleware.ts");
    const i = mw.indexOf("pathname.startsWith(INTERNAL_API_PREFIX)");
    const j = mw.indexOf('req.headers.get("authorization")');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
    expect(mw.slice(i, i + 600)).toContain("internalSourceVerdict(req.headers)");
    expect(mw).toContain('from "@/lib/scheduler/internal-source"');
    expect(mw).not.toContain("internal-guard"); // 带 node:crypto 的那个不许进 edge
    expect(readFileSync(resolve(SRC, "lib/scheduler/internal-source.ts"), "utf8")).not.toMatch(/from\s+["']node:/);
  });

  it("路由:先过守卫再碰命令;被拒也写审计;请求体只认 commandId;回 202 后台执行", () => {
    const r = code("app/api/internal/actions/run/route.ts");
    const g = r.indexOf("await verifyInternalCaller(req.headers)");
    const d = r.indexOf("await dispatchCommand(commandId, ACTION_HANDLERS)");
    expect(g).toBeGreaterThan(-1);
    expect(d).toBeGreaterThan(g);
    expect(r.slice(g, d)).toContain('audit("internal.action.denied"');
    expect(r).toContain("json(202");
    // 🔴 body 里除了 commandId 什么都不读(动作 / 参数 / 落点一律来自命令行)
    expect(r).not.toMatch(/body\??\.(action|params|targetId|projectId)/);
  });

  it("基础设施两侧同源:命令表名 / 调度表名 / 密钥 ARN 环境变量 / ALB 给分发 Lambda 开的入站", () => {
    const ROOT = resolve(SRC, "..", "..");
    const ad = readFileSync(resolve(ROOT, "infra/lib/action-dispatch.ts"), "utf8");
    expect(ad).toContain('ACTION_COMMANDS_TABLE_NAME = "bgp-action-commands"');
    expect(ad).toContain("stream: dynamodb.StreamViewType.NEW_IMAGE");
    expect(ad).toContain('timeToLiveAttribute: "ttl"');
    expect(ad).toContain("props.albSecurityGroup.addIngressRule(sg,");
    expect(ad).toContain('eventName: lambda.FilterRule.isEqual("INSERT")');
    const ps = readFileSync(resolve(ROOT, "infra/lib/platform-stack.ts"), "utf8");
    expect(ps).toContain("ACTION_DISPATCH_SECRET_ARN: actionDispatch.secret.secretArn");
    // 序 33 ③:调度对象表与命令表同在平台栈(只重部署平台栈的环境也建得出它)
    expect(ad).toContain('ACTION_SCHEDULES_TABLE_NAME = "bgp-action-schedules"');
    expect(ad).toMatch(/tableName: ACTION_SCHEDULES_TABLE_NAME,\s*partitionKey: \{ name: "userId"[^}]*\},\s*sortKey: \{ name: "taskId"/);
    expect(readFileSync(resolve(ROOT, "infra/lib/database-stack.ts"), "utf8")).not.toContain('{ name: "bgp-action-schedules"');
    // 平台读的就是这两个名字
    expect(code("lib/scheduler/internal-guard.ts")).toContain("process.env.ACTION_DISPATCH_SECRET_ARN");
    // 序 31 第三刀 ①:这把钥匙是控制面的 ⇒ 两个读点都经 sdkClient("control-plane")(不注入数据面角色;observe 下不再每 5 分钟
    //   先被拒一次,enforce 下不会把泵 / 内部端点整条打断),且不许再回到数据面工厂 regionalClient("secrets")
    for (const rel of ["lib/scheduler/internal-guard.ts", "lib/dataplane-jobs/pump.ts"]) {
      const src = code(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
      expect(src, rel).toContain('sdkClient("control-plane", SecretsManagerClient, { region: ctrlRegionOf() })');
      expect(src, `${rel} 又经数据面工厂读控制面密钥`).not.toContain('regionalClient("secrets"');
    }
    expect(code("lib/aws/dynamodb.ts")).toContain('"bgp-action-commands"');
    expect(code("lib/aws/dynamodb.ts")).toContain('ACTION_SCHEDULES: "bgp-action-schedules"');
    // 分发 Lambda 用的头名与平台守卫同值
    const lam = readFileSync(resolve(ROOT, "infra/lambda/action-dispatcher/index.mjs"), "utf8");
    expect(lam).toContain(`INTERNAL_KEY_HEADER = "${INTERNAL_KEY_HEADER}"`);
    expect(lam).toContain(`INTERNAL_SOURCE_HEADER = "${INTERNAL_SOURCE_HEADER}"`);
    expect(lam).toContain(`INTERNAL_SOURCE = "${INTERNAL_SOURCE_ACTION_DISPATCHER}"`);
    expect(lam).toContain('INTERNAL_PATH = "/api/internal/actions/run"');
  });
});

// @kf-batch 50-WP9a-durable-jobs —— 第二个登记来源 `dataplane-job-pump`(数据面长作业的推进泵,平台进程回环调用)
describe("🔴 内部来源按端点精确判(WP-9 ④-2)", () => {
  const load = async () => KEY;
  const PUMP = "dataplane-job-pump";

  it("泵来源 + 正确密钥 + 端点声明收泵 ⇒ 放行,主体是泵的系统主体(不是分发 Lambda)", async () => {
    const v = await verifyInternalCaller(h({ [INTERNAL_SOURCE_HEADER]: PUMP }), { secretArn: ARN, loadSecret: load, expectedSource: PUMP });
    expect(v).toEqual({ ok: true, principal: { actor: "system:dataplane-job-pump", via: "dataplane-job" } });
  });

  it("🔴 泵的头敲分发端点(缺省 expectedSource)⇒ 403;分发 Lambda 的头敲泵的端点 ⇒ 403(即使密钥正确)", async () => {
    expect(await verifyInternalCaller(h({ [INTERNAL_SOURCE_HEADER]: PUMP }), { secretArn: ARN, loadSecret: load })).toMatchObject({ ok: false, status: 403 });
    expect(await verifyInternalCaller(h(), { secretArn: ARN, loadSecret: load, expectedSource: PUMP })).toMatchObject({ ok: false, status: 403 });
  });

  it("端点声明了一个未登记的来源 ⇒ 403(不许靠传参开新口子)", async () => {
    const v = await verifyInternalCaller(h({ [INTERNAL_SOURCE_HEADER]: "someone-else" }), { secretArn: ARN, loadSecret: load, expectedSource: "someone-else" });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("泵路由:先过守卫(expectedSource = 泵)再碰作业", () => {
    for (const rel of ["app/api/internal/dataplane-jobs/step/route.ts", "app/api/internal/dataplane-jobs/sweep/route.ts"]) {
      const r = code(rel);
      const g = r.indexOf("await verifyInternalCaller(req.headers, { expectedSource: INTERNAL_SOURCE_DATAPLANE_JOB_PUMP })");
      expect(g, `${rel} 没过内部守卫或没声明只收泵`).toBeGreaterThan(-1);
      const work = Math.max(r.indexOf("runJobStep("), r.indexOf("sweepAutoSupply("));
      expect(work, `${rel} 在守卫之前就干活了`).toBeGreaterThan(g);
    }
  });
});
