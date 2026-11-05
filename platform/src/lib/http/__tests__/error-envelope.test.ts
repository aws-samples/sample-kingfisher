// 2026-11-04(B)—— 页面读错误信封文案的唯一作者 `errorMessageOf`:
//   ① 喂**真实**的 apiError 信封(lib/api-response 真造、真 .json()),拿回服务端原话逐字;并钉住缺陷原形:老写法 `d?.error || 兜底`
//      对这个信封得到的是**对象**(正是 antd 收到对象 ⇒ React error #31 ⇒ 零提示的根因);
//   ② 非 JSON 信封 / Next 老路由 `{ error: "字串" }` / 空信封 / 非对象 四种形态;
//   ③ 守卫(闭合门):app / components 里不许再有 `message.xxx(<信封>.error || …)` 这种把对象递给 antd 的写法;补数页三处必须经唯一作者;
//      deleteJson 不再内联第二份判断。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiError } from "@/lib/api-response";
import { nonJsonEnvelope, describeNonJson } from "@/lib/http/non-json-envelope";
import { errorMessageOf, errorCodeOf } from "@/lib/http/error-envelope";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

const VERBATIM = "工作流补数失败:节点「清洗」引用的作业不绑 tgt_usw2_a";

describe("errorMessageOf:真实信封 ⇒ 服务端原话逐字", () => {
  it("apiError 信封(lib/api-response 真造)⇒ message 原话;code 读得出", async () => {
    const d = await apiError(VERBATIM, 400, { code: "VALIDATION_FAILED" }).json();
    expect(errorMessageOf(d, "预览失败")).toBe(VERBATIM);
    expect(errorCodeOf(d)).toBe("VALIDATION_FAILED");
  });
  it("🔴 缺陷原形:老写法 `d?.error || 兜底` 对真实信封得到的是**对象**(antd 收到对象 ⇒ React error #31 ⇒ 零提示)", async () => {
    const d = await apiError(VERBATIM, 400).json();
    const legacy = d?.error || "预览失败";
    expect(typeof legacy).toBe("object");
    expect(typeof errorMessageOf(d, "预览失败")).toBe("string");
  });
  it("非 JSON 信封(网关 504 页被拦截器整形)⇒ 其可读文案", () => {
    expect(errorMessageOf(nonJsonEnvelope(504), "x")).toBe(describeNonJson(504));
    expect(errorCodeOf(nonJsonEnvelope(504))).toBe("UPSTREAM_TIMEOUT");
  });
  it("Next 老路由形态 `{ error: \"Not found\" }` ⇒ 字串原样;code 无", () => {
    expect(errorMessageOf({ error: "Not found" }, "x")).toBe("Not found");
    expect(errorCodeOf({ error: "Not found" })).toBeUndefined();
  });
  it("没有可读文案的形态一律回兜底(空对象信封 / 空 message / null / 非对象 / undefined)", () => {
    for (const body of [{ success: false, error: {} }, { error: { message: "" } }, { error: null }, null, undefined, "<html>", 42, { success: true }]) {
      expect(errorMessageOf(body, "创建失败"), JSON.stringify(body)).toBe("创建失败");
      expect(errorCodeOf(body)).toBeUndefined();
    }
  });
});

describe("🔴 守卫:把信封对象直接递给 antd message 的写法零命中;读法只有一个作者", () => {
  const files = [...walk(resolve(SRC, "app")), ...walk(resolve(SRC, "components"))];
  // `message.error(d?.error || …)` / `message.warning(resp.error ?? …)` …:第一个实参是 `<标识符>(?.)error` 且紧跟 `||` / `??` / `)`
  const BAD = /\bmessage\.(?:error|warning|info|success|open)\(\s*\w+\??\.error\s*(?:\|\||\?\?|\))/;
  it("扫描面成立", () => {
    expect(files.length).toBeGreaterThan(100);
    // 量具自检(正反两例)
    expect(BAD.test('message.error(d?.error || t("预览失败"))')).toBe(true);
    expect(BAD.test("message.error(d.error ?? x)")).toBe(true);
    expect(BAD.test('message.error(d?.error?.message || t("预览失败"))')).toBe(false);
    expect(BAD.test('message.error(errorMessageOf(d, t("预览失败")))')).toBe(false);
  });
  it("app / components 里零命中(新页面再写一处就红)", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      src.split("\n").forEach((line, i) => { if (BAD.test(line)) bad.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`); });
    }
    expect(bad, "这些调用点把信封对象直接递给了 antd message(用户看不到任何提示)⇒ 改用 lib/http/error-envelope#errorMessageOf").toEqual([]);
  });
  it("补数页三处(预览 / 创建 / 控制)都经唯一作者;deleteJson 不再内联第二份判断", () => {
    const page = strip(readFileSync(resolve(SRC, "app/backfill/page.tsx"), "utf8"));
    expect(page).toContain('import { errorMessageOf } from "@/lib/http/error-envelope";');
    expect(page).toContain('message.error(errorMessageOf(d, t("预览失败")))');
    expect(page).toContain('message.error(errorMessageOf(d, t("创建失败")))');
    expect(page).toContain('message.error(errorMessageOf(d, t("操作失败")))');
    const del = strip(readFileSync(resolve(SRC, "lib/http/delete-json.ts"), "utf8"));
    expect(del).toContain('import { errorCodeOf, errorMessageOf } from "./error-envelope";');
    expect(del).not.toMatch(/typeof err === "object" \? err\.message/);
  });
});
