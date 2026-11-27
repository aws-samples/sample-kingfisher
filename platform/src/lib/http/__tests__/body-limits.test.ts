// 应用接口请求体上限(唯一作者 lib/http/body-limits.ts)的判据:上限表、按 Content-Length / 按实际字节判、人话文案、
// 存储层「单条记录太大」的统一识别(经 apiError),以及跨层顺序(每个上限都比框架缓冲上限小一截;上传路由的请求体上限 > 文件上限;
// 页面与路由写的数、说的话都取自同一处)。
//
// 缺陷原形(2026-11-26 真实客户反馈):离线作业脚本约 160 行以上保存不了 —— 超过 8KB 的请求体被平台边缘拦成 403 HTML 页,
// 应用层说不上话。边缘不再按大小拦登录后的 /api/** 之后,大小由应用层统一管;这里钉的是「管得住、说得清」。
// 同日读框架源码:框架交给网关 / 路由的请求体最多 10MB,超过的部分读不到 ⇒ 页面写着「≤250MB / ≤100MB」的两条上传,
// 超过 10MB 的文件到路由手里是截断的,报的是不对题的错。⇒ 页面上传如实收在缓冲上限之内,超限由网关说清。
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_LIMIT_RULES,
  DEFAULT_MAX_BODY_BYTES,
  GATEWAY_BUFFER_LIMIT_BYTES,
  GENBI_CARD_MAX_BODY_BYTES,
  PAGE_UPLOAD_MAX_BODY_BYTES,
  PAGE_UPLOAD_MAX_FILE_BYTES,
  PAYLOAD_TOO_LARGE_CODE,
  STORE_ITEM_TOO_LARGE_MESSAGE,
  TRUNCATION_DETECT_MARGIN_BYTES,
  bodySizeVerdictByCount,
  bodySizeVerdictByHeader,
  bodyTooLargeMessage,
  etlDepTooLargeMessage,
  flinkConnectorTooLargeMessage,
  formatBytes,
  genbiCardTooLargeMessage,
  isStoreItemTooLarge,
  maxBodyBytesFor,
  tooLargeMessageFor,
} from "@/lib/http/body-limits";
import { apiError } from "@/lib/api-response";

const MB = 1024 * 1024;
const require_ = createRequire(import.meta.url);
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("🔴 上限表:缺省 4MB;三条上传路由各有自己的上限;带 id 的路径也认得", () => {
  it("普通保存路由(带 id、不带 id)都是缺省上限", () => {
    for (const [m, p] of [
      ["PUT", "/api/etl-jobs/01ABCDEF"],
      ["POST", "/api/etl-jobs"],
      ["PUT", "/api/workflow/wf-1"],
      ["PUT", "/api/sync/task-1"],
      ["POST", "/api/redshift/tasks"],
      ["PUT", "/api/bi/reports/r-1"],
    ] as const) {
      expect(maxBodyBytesFor(p, m), `${m} ${p}`).toBe(DEFAULT_MAX_BODY_BYTES);
    }
    expect(DEFAULT_MAX_BODY_BYTES).toBe(4 * MB);
  });

  it("连接器 JAR / 问数卡片:路径完全相同才用各自的上限;多一段或方法不同回缺省", () => {
    expect(maxBodyBytesFor("/api/flink/connectors", "POST")).toBe(PAGE_UPLOAD_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/flink/connectors", "post")).toBe(PAGE_UPLOAD_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/flink/connectors/c-1", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/flink/connectors", "PUT")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/genbi/cards", "POST")).toBe(GENBI_CARD_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/genbi/cards/card-1", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it("作业依赖文件上传:路径中间恰好一段作业 id 才算;少一段、多一段、空段都回缺省", () => {
    expect(maxBodyBytesFor("/api/etl-jobs/01ABCDEF/deps", "POST")).toBe(PAGE_UPLOAD_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/etl-jobs/deps", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/etl-jobs//deps", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/etl-jobs/a/b/deps", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/etl-jobs/01ABCDEF/deps", "GET")).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(maxBodyBytesFor("/api/etl-jobs/01ABCDEF/runs", "POST")).toBe(DEFAULT_MAX_BODY_BYTES);
  });
});

describe("🔴 按 Content-Length 判:超限说清「有多大、上限多少、下一步」;不带请求体的方法不判", () => {
  it("客户那种脚本(几十 KB)过;正好等于上限过;多 1 字节拒", () => {
    expect(bodySizeVerdictByHeader("/api/etl-jobs/j1", "PUT", String(60 * 1024))).toEqual({ ok: true });
    expect(bodySizeVerdictByHeader("/api/etl-jobs/j1", "PUT", String(DEFAULT_MAX_BODY_BYTES))).toEqual({ ok: true });
    const v = bodySizeVerdictByHeader("/api/etl-jobs/j1", "PUT", String(DEFAULT_MAX_BODY_BYTES + 1));
    expect(v).toMatchObject({ ok: false, limitBytes: DEFAULT_MAX_BODY_BYTES, actualBytes: DEFAULT_MAX_BODY_BYTES + 1 });
  });

  it("文案带实际大小与上限两个数,并给下一步;不出现英文原话", () => {
    const v = bodySizeVerdictByHeader("/api/workflow/w1", "PUT", String(6 * MB));
    expect(v && !v.ok && v.message).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES, 6 * MB));
    const msg = bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES, 6 * MB);
    expect(msg).toContain("6MB");
    expect(msg).toContain("4MB");
    expect(msg).toContain("没有保存");
    expect(msg).toContain("精简");
    expect(msg).not.toMatch(/exceed|too large/i);
  });

  it("GET / HEAD / OPTIONS 不判(回 ok),哪怕带了一个很大的 Content-Length", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(bodySizeVerdictByHeader("/api/etl-jobs", m, String(100 * MB))).toEqual({ ok: true });
    }
  });

  it("请求头里没有可用的长度(缺 / 空 / 不是数字)⇒ 回 null,交给按实际字节数判 —— 不许当成「没超」放行", () => {
    for (const h of [null, undefined, "", "  ", "abc", "-1", "1e9", "12 34"]) {
      expect(bodySizeVerdictByHeader("/api/etl-jobs/j1", "PUT", h), JSON.stringify(h)).toBeNull();
    }
  });

  it("按实际字节数判:数到的没超上限过,超了拒(文案只说上限)", () => {
    expect(bodySizeVerdictByCount("/api/etl-jobs/j1", "PUT", 0)).toEqual({ ok: true });
    expect(bodySizeVerdictByCount("/api/etl-jobs/j1", "PUT", DEFAULT_MAX_BODY_BYTES)).toEqual({ ok: true });
    const v = bodySizeVerdictByCount("/api/etl-jobs/j1", "PUT", DEFAULT_MAX_BODY_BYTES + 1);
    expect(v).toMatchObject({ ok: false, limitBytes: DEFAULT_MAX_BODY_BYTES });
    expect(!v.ok && v.message).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES));
  });

  it("字节数的写法:不足 1MB 用 KB,整数 MB 不带小数,其余一位小数", () => {
    expect(formatBytes(400 * 1024)).toBe("400KB");
    expect(formatBytes(4 * MB)).toBe("4MB");
    expect(formatBytes(6.5 * MB)).toBe("6.5MB");
    expect(formatBytes(10)).toBe("1KB");
  });
});

describe("🔴 每条路由超限时说自己的那句话:上传说文件上限与「没有上传」,能指路的指路,没有路的不编", () => {
  it("作业依赖文件:说页面上传的文件上限(不是含包装的请求体上限),并指「先放进 S3 再填地址」", () => {
    const msg = tooLargeMessageFor("/api/etl-jobs/01ABCDEF/deps", "POST", 30 * MB);
    expect(msg).toBe(etlDepTooLargeMessage(30 * MB));
    expect(msg).toContain("有 30MB");
    expect(msg).toContain(`页面上传的上限 ${formatBytes(PAGE_UPLOAD_MAX_FILE_BYTES)}`);
    expect(msg).toContain("没有上传");
    expect(msg).toContain("S3");
    expect(msg).toContain("「依赖库」");
    expect(msg).not.toContain(formatBytes(PAGE_UPLOAD_MAX_BODY_BYTES));
  });

  it("连接器 JAR:只有上传这一个入口 ⇒ 只说事实,不指一条不存在的路", () => {
    const msg = tooLargeMessageFor("/api/flink/connectors", "POST", 52 * MB);
    expect(msg).toBe(flinkConnectorTooLargeMessage(52 * MB));
    expect(msg).toBe(`这个文件有 52MB,超过了页面上传的上限 ${formatBytes(PAGE_UPLOAD_MAX_FILE_BYTES)},没有上传。`);
  });

  it("问数卡片:说单张卡片的上限与「没有保存」", () => {
    const msg = tooLargeMessageFor("/api/genbi/cards", "POST", 15 * MB);
    expect(msg).toBe(genbiCardTooLargeMessage(15 * MB));
    expect(msg).toContain("有 15MB");
    expect(msg).toContain(formatBytes(GENBI_CARD_MAX_BODY_BYTES));
    expect(msg).toContain("没有保存");
  });

  it("其余路由说缺省那句;不知道实际大小时只说上限", () => {
    expect(tooLargeMessageFor("/api/etl-jobs/j1", "PUT", 6 * MB)).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES, 6 * MB));
    expect(tooLargeMessageFor("/api/etl-jobs/j1", "PUT")).toBe(bodyTooLargeMessage(DEFAULT_MAX_BODY_BYTES));
    expect(etlDepTooLargeMessage()).not.toContain("有 ");
  });

  it("两种判法(按请求头 / 按数到的字节)给的都是这条路由自己的那句", () => {
    const byHeader = bodySizeVerdictByHeader("/api/etl-jobs/01ABCDEF/deps", "POST", String(30 * MB));
    expect(byHeader).toMatchObject({ ok: false, limitBytes: PAGE_UPLOAD_MAX_BODY_BYTES, actualBytes: 30 * MB, message: etlDepTooLargeMessage(30 * MB) });
    const byCount = bodySizeVerdictByCount("/api/flink/connectors", "POST", PAGE_UPLOAD_MAX_BODY_BYTES + 1);
    expect(byCount).toMatchObject({ ok: false, limitBytes: PAGE_UPLOAD_MAX_BODY_BYTES, message: flinkConnectorTooLargeMessage() });
  });
});

describe("🔴 页面与路由写的数、说的话都取自上限表这一处(各写各的,迟早对不上)", () => {
  it("两条上传路由:文件上限用同一个常量,超限用同一句话、413、同一个错误码", () => {
    const flink = read("app/api/flink/connectors/route.ts");
    expect(flink).toMatch(/const MAX_BYTES = PAGE_UPLOAD_MAX_FILE_BYTES;/);
    expect(flink).toMatch(/buf\.length > MAX_BYTES\) return apiError\(flinkConnectorTooLargeMessage\(buf\.length\), 413, \{ code: PAYLOAD_TOO_LARGE_CODE \}\)/);
    const dep = read("app/api/etl-jobs/[id]/deps/route.ts");
    expect(dep).toMatch(/const MAX_BYTES = PAGE_UPLOAD_MAX_FILE_BYTES;/);
    expect(dep).toMatch(/buf\.length > MAX_BYTES\) return apiError\(etlDepTooLargeMessage\(buf\.length\), 413, \{ code: PAYLOAD_TOO_LARGE_CODE \}\)/);
  });

  it("两个页面:上限那个数由常量算出来,不再写死过去那两个到不了的数", () => {
    for (const page of ["app/realtime-compute/page.tsx", "app/etl-jobs/page.tsx"]) {
      const src = read(page);
      expect(src, `${page} 没有用上限常量`).toMatch(/\{ max: formatBytes\(PAGE_UPLOAD_MAX_FILE_BYTES\) \}/);
      expect(src, `${page} 还写着 ≤250MB`).not.toContain("≤250MB");
      expect(src, `${page} 还写着 ≤100MB`).not.toContain("≤100MB");
    }
  });
});

describe("🔴 跨层顺序(反了用户就拿不到该拿到的那句话)", () => {
  it("每个上限(缺省与上限表每一行)都比框架交给网关的缓冲上限小一截:否则超限的请求到网关时已被截断,数字节也数不出「超了」", () => {
    const ceiling = GATEWAY_BUFFER_LIMIT_BYTES - TRUNCATION_DETECT_MARGIN_BYTES;
    expect(TRUNCATION_DETECT_MARGIN_BYTES).toBeGreaterThanOrEqual(1 * MB);
    expect(DEFAULT_MAX_BODY_BYTES).toBeLessThanOrEqual(ceiling);
    for (const r of BODY_LIMIT_RULES) expect(r.maxBytes, r.name).toBeLessThanOrEqual(ceiling);
  });

  it("框架缓冲上限这个数与框架的实际配置一致:缺省值相同,且项目配置没有改它", () => {
    const { defaultConfig } = require_("next/dist/server/config-shared") as { defaultConfig: { experimental?: { middlewareClientMaxBodySize?: number } } };
    expect(defaultConfig.experimental?.middlewareClientMaxBodySize, "框架缺省值变了 ⇒ GATEWAY_BUFFER_LIMIT_BYTES 要跟着改").toBe(GATEWAY_BUFFER_LIMIT_BYTES);
    const projectConfig = require_("../../../../next.config.js") as { experimental?: { middlewareClientMaxBodySize?: unknown } };
    expect(projectConfig.experimental?.middlewareClientMaxBodySize, "项目配置改了这个上限 ⇒ GATEWAY_BUFFER_LIMIT_BYTES 要写成同一个数").toBeUndefined();
  });

  it("上传路由:请求体上限 > 路由自己核的文件上限(留出 multipart 包装的余量);两个数是 8MB 与 9MB", () => {
    const of = (name: string) => BODY_LIMIT_RULES.find((r) => r.name === name)!.maxBytes;
    expect(of("flink-connector-upload")).toBe(PAGE_UPLOAD_MAX_BODY_BYTES);
    expect(of("etl-job-dep-upload")).toBe(PAGE_UPLOAD_MAX_BODY_BYTES);
    expect(PAGE_UPLOAD_MAX_BODY_BYTES).toBeGreaterThan(PAGE_UPLOAD_MAX_FILE_BYTES);
    expect(PAGE_UPLOAD_MAX_FILE_BYTES).toBe(8 * MB);
    expect(PAGE_UPLOAD_MAX_BODY_BYTES).toBe(9 * MB);
    expect(of("genbi-card-save")).toBe(9 * MB);
  });

  it("上限表每行都比缺省大(比缺省小的不该写进这张表),名字不重复", () => {
    for (const r of BODY_LIMIT_RULES) expect(r.maxBytes, r.name).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);
    expect(new Set(BODY_LIMIT_RULES.map((r) => r.name)).size).toBe(BODY_LIMIT_RULES.length);
  });
});

describe("🔴 存储层「单条记录太大」:任何路由把存储服务的原话交给 apiError,用户拿到的都是人话 + 413", () => {
  it("写入与更新两种原话都认得;别的校验错误不认", () => {
    expect(isStoreItemTooLarge("Item size has exceeded the maximum allowed size")).toBe(true);
    expect(isStoreItemTooLarge("Item size to update has exceeded the maximum allowed size")).toBe(true);
    expect(isStoreItemTooLarge("保存失败: Item size to update has exceeded the maximum allowed size")).toBe(true);
    expect(isStoreItemTooLarge("The provided key element does not match the schema")).toBe(false);
    expect(isStoreItemTooLarge(undefined)).toBe(false);
  });

  // 2026-11-27 测试账号页面实测(离线作业保存一段脚本,原话逐字):约 700KB 得到的是「Item size to update …」;
  //   约 2MB 与约 3.3MB 各是下面的一句 —— 说法完全不同。只认第一句时,后两档页面露出了英文原话与 500。
  const AT_2MB = "1 validation error detected: Invalid UpdateExpression: Expression size has exceeded the maximum allowed size;";
  const AT_3MB = "1 validation error detected: ExpressionAttributeValues exceeds max size";

  it.each([AT_2MB, AT_3MB])("更大的内容得到的另外两种原话也认得:%s", async (message) => {
    expect(isStoreItemTooLarge(message)).toBe(true);
    const res = apiError(message, 500);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ success: false, error: { message: STORE_ITEM_TOO_LARGE_MESSAGE, code: PAYLOAD_TOO_LARGE_CODE } });
    expect(STORE_ITEM_TOO_LARGE_MESSAGE).not.toMatch(/Expression|validation error|exceeds/);
  });

  it("读路径上的表达式超限不归这里(那不是「内容太大、没有保存」)", () => {
    expect(isStoreItemTooLarge("Invalid FilterExpression: Expression size has exceeded the maximum allowed size;")).toBe(false);
    expect(isStoreItemTooLarge("Invalid KeyConditionExpression: Expression size has exceeded the maximum allowed size;")).toBe(false);
  });

  it("路由照旧写 apiError(e.message, 500) ⇒ 应答 413、PAYLOAD_TOO_LARGE、文案是人话(带约 400KB 与下一步)", async () => {
    const res = apiError("Item size to update has exceeded the maximum allowed size", 500);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: { message: STORE_ITEM_TOO_LARGE_MESSAGE, code: PAYLOAD_TOO_LARGE_CODE } });
    expect(STORE_ITEM_TOO_LARGE_MESSAGE).toContain("400KB");
    expect(STORE_ITEM_TOO_LARGE_MESSAGE).toContain("没有保存");
    expect(STORE_ITEM_TOO_LARGE_MESSAGE).not.toMatch(/Item size/);
  });

  it("别的错误一个字不动(状态、文案、错误码原样)", async () => {
    const res = apiError("缺 targetId", 400, { code: "VALIDATION_FAILED" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: { message: "缺 targetId", code: "VALIDATION_FAILED" } });
  });
});
