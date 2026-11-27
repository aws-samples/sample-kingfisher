// 路由文件里「直接写库」的语句 —— **棘轮**(没包 orPayloadTooLarge 的处数只减不增)+ 已修的六个保存路由必须包着它。
//
// 缺陷原形(2026-11-27 读代码):编排画布、数仓查询任务、同步任务、Flink 作业的保存路由直接 `await docClient.send(...)`,
//   没有自己的 catch。存储层拒收(内容超过单条记录可保存的大小)时异常一路抛出去 ⇒ 框架回一张没有正文的 500,
//   页面只能说「服务响应异常」。同一件事在离线作业的保存路由上有人话,只因为那条路由碰巧有 catch 把原话交给了 apiError。
// 认法:路由文件里 `new PutCommand` / `new UpdateCommand` / `updateSyncTaskIfExists(` 各算一处写库;
//   紧跟在 `orPayloadTooLarge(` 之后的算「包着」。其余的逐文件登记在基线里并写明为什么不用包。
//   新路由再写一处直接写库 ⇒ 这里红:要么包上,要么在基线里说清它为什么不会因为内容太大被拒(或者已经有 catch 交给 apiError)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextResponse } from "next/server";
import { orPayloadTooLarge } from "@/lib/api-response";
import { PAYLOAD_TOO_LARGE_CODE, STORE_ITEM_TOO_LARGE_MESSAGE } from "../body-limits";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      routeFiles(p, out);
    } else if (name === "route.ts") out.push(p);
  }
  return out;
}

const WRITE = /new (?:Put|Update)Command\b|updateSyncTaskIfExists\(/g;
const WRAPPED = /orPayloadTooLarge\(\s*(?:docClient\.send\(\s*new (?:Put|Update)Command\b|updateSyncTaskIfExists\()/g;

function count(file: string): { total: number; wrapped: number; bare: number } {
  const src = readFileSync(file, "utf8");
  const total = (src.match(WRITE) ?? []).length;
  const wrapped = (src.match(WRAPPED) ?? []).length;
  return { total, wrapped, bare: total - wrapped };
}

/** 2026-11-27 基线(路径 ⇒ 没包的处数)。只许减少。 */
const BASELINE: Record<string, number> = {
  // 写库在 try 里,catch 把存储层的原话交给 apiError(它认得「内容太大」)
  "app/api/datasources/[id]/route.ts": 1,
  "app/api/datasources/route.ts": 1,
  "app/api/engines/[engine]/[id]/route.ts": 1,
  "app/api/engines/[engine]/route.ts": 1,
  "app/api/etl-jobs/[id]/route.ts": 1,
  "app/api/etl-jobs/route.ts": 1,
  "app/api/flink/jobs/route.ts": 1,
  "app/api/requirements/[id]/create-job/route.ts": 1,
  "app/api/sync/route.ts": 1,
  // 只写定时表达式与启用标记(几十个字节,不会因为内容太大被拒)
  "app/api/engines/[engine]/[id]/schedule/route.ts": 2,
  "app/api/etl-jobs/[id]/schedule/route.ts": 2,
  "app/api/schedule/enable/route.ts": 2,
  // 平台自己回写的运行期状态(状态、通道标识、上次运行),不是用户提交的内容
  "app/api/sync/[id]/glue-status/route.ts": 1,
  "app/api/sync/[id]/start-realtime/route.ts": 2,
  "app/api/sync/[id]/start/route.ts": 1,
  "app/api/sync/[id]/zeroetl-status/route.ts": 1,
  "app/api/workflow/[id]/runs/[runId]/status/route.ts": 1,
  // 查询历史:写不进去不影响查询结果,路由自己吞掉了
  "app/api/redshift/history/route.ts": 1,
};

/** 本批已修:保存用户内容的路由,写库必须包着 orPayloadTooLarge。 */
const FIXED = [
  "app/api/workflow/[id]/route.ts",
  "app/api/workflow/route.ts",
  "app/api/redshift/tasks/[id]/route.ts",
  "app/api/redshift/tasks/route.ts",
  "app/api/sync/[id]/route.ts",
  "app/api/flink/jobs/[id]/route.ts",
];

describe("🔴 路由里直接写库的语句:存储层说「内容太大」时要有人把它变成人话", () => {
  const files = routeFiles(resolve(SRC, "app/api"));
  const found: Record<string, { total: number; wrapped: number; bare: number }> = {};
  for (const f of files) {
    const c = count(f);
    if (c.total > 0) found[relative(SRC, f).split("\\").join("/")] = c;
  }

  it("扫得到东西(判别力):路由文件不少于 300 个,基线与已修名单里的文件都命中了写库语句", () => {
    expect(files.length).toBeGreaterThanOrEqual(300);
    for (const p of [...Object.keys(BASELINE), ...FIXED]) expect(found[p]?.total ?? 0, p).toBeGreaterThan(0);
  });

  it("没包的写库语句只减不增(逐文件不超过基线,基线外的文件为 0)", () => {
    const over = Object.entries(found).filter(([p, c]) => c.bare > (BASELINE[p] ?? 0)).map(([p, c]) => `${p}: ${c.bare}`);
    expect(over, "新增了直接写库的语句 —— 保存用户内容的包上 lib/api-response.ts 的 orPayloadTooLarge;确实不用包的登记进基线并写明原因").toEqual([]);
  });

  it("基线不留虚数:名单里的处数与实际相同(包上一处就把名单同步减掉)", () => {
    for (const [p, n] of Object.entries(BASELINE)) expect(found[p]?.bare ?? 0, p).toBe(n);
  });

  it("已修的六个保存路由:每一处写库都包着 orPayloadTooLarge,并且拿到应答就直接 return", () => {
    for (const p of FIXED) {
      const c = found[p];
      expect(c?.wrapped ?? 0, `${p} 没有包`).toBeGreaterThan(0);
      expect(c?.bare ?? -1, `${p} 还有没包的写库语句`).toBe(0);
      const src = readFileSync(resolve(SRC, p), "utf8");
      const returns = (src.match(/if \((?:written|stored) instanceof NextResponse\) return (?:written|stored);/g) ?? []).length;
      expect(returns, `${p}:包了却没有把应答 return 出去`).toBe(c!.wrapped);
    }
  });
});

describe("🔴 orPayloadTooLarge:存储层说「内容太大」⇒ 413 + 人话;别的一个字不动", () => {
  // 都是存储服务的原话(后三句 2026-11-27 测试账号页面实测:约 700KB、约 2MB、约 3.3MB 的更新各一句)
  const TOO_LARGE = [
    "Item size has exceeded the maximum allowed size",
    "Item size to update has exceeded the maximum allowed size",
    "1 validation error detected: Invalid UpdateExpression: Expression size has exceeded the maximum allowed size;",
    "1 validation error detected: ExpressionAttributeValues exceeds max size",
  ];

  it("写成了 ⇒ 原样拿到写库的结果", async () => {
    const out = await orPayloadTooLarge(Promise.resolve({ Attributes: { a: 1 } }));
    expect(out).toEqual({ Attributes: { a: 1 } });
    expect(out instanceof NextResponse).toBe(false);
  });

  it.each(TOO_LARGE)("存储层原话「%s」⇒ 413、PAYLOAD_TOO_LARGE、文案是人话", async (message) => {
    const out = await orPayloadTooLarge(Promise.reject(Object.assign(new Error(message), { name: "ValidationException" })));
    expect(out instanceof NextResponse).toBe(true);
    const res = out as NextResponse;
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ success: false, error: { message: STORE_ITEM_TOO_LARGE_MESSAGE, code: PAYLOAD_TOO_LARGE_CODE } });
  });

  it("别的错误(条件写失败、限流、凭证)原样抛,是同一个错误对象", async () => {
    const boom = Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
    await expect(orPayloadTooLarge(Promise.reject(boom))).rejects.toBe(boom);
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    await expect(orPayloadTooLarge(Promise.reject(throttled))).rejects.toBe(throttled);
  });
});
