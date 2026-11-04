// 🔴🔴 **「多区域自动」必须是机械可查的,不能靠「我们记得别写死」**
//
// 【用户 2026-09-20 原话】
//   「你不一定要跑第三个区域,只要第二个区域和第一个区域的逻辑是对的,后面在正式账号上运行,
//     即便是开 N 个区域,也是一样的。所以,你主要验证两个区域的就 OK,**不能硬编码两个,
//     应该是多区域自动的**。」
//
// 【勘定结论(这一点很要紧)】后端**本来就是 N 区自动的**:`registerTarget` 只校验 region 的**形态**
//   (`/^[a-z]{2}(-[a-z]+)+-\d$/`),任何合法区都收;扇出、落点解析、调度端点全部按注册表遍历。
//   天花板只在**界面**:`CreateWizard.tsx` 里 `REGION_OPTIONS` 是**写死的 7 个区**、默认值写死
//   `us-west-2` ⇒ 真实账号里开第 8 个区(如 `ap-south-1`)在页面上根本选不到。
//   而那个默认值本身就有案底 —— 段 `w5a` 的拒因里写着:「那个默认值在 2026-09-15 真建出第 5 套环境」。
//
// 【这组判据钉三件事】
//   ① 界面的候选区**来自账号真值**(`ec2:DescribeRegions` + 注册表占位),不是写死的候选表;
//   ② region **没有默认值**,且没选就不许往下走 / 不许提交(有静默默认值的参数 = 一整类缺陷的温床);
//   ③ 产品代码里「写死非 home 区名 / 区 id」的处数做成**只减不增的棘轮** ——
//      这一条才是「多区域自动」的可量形式:靠纪律挡不住第 N+1 处,靠数字挡得住。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC = resolve(__dirname, "../../..");          // → platform/src
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** 递归列出 src 下的非测试源文件。 */
function sources(dir = SRC, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue;
      sources(p, out);
    } else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/** 剥注释再做负向文本断言(累计教训:注释里的例子会把判据打红)。 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

describe("多区域自动:不许把区数 / 区名写死", () => {
  it("① 新建向导的候选区来自**账号真值**,不是写死的候选表", () => {
    const wiz = read("app/exec-envs/CreateWizard.tsx");
    // 写死的候选表必须已经没了
    expect(
      /const REGION_OPTIONS\s*=\s*\[/.test(wiz),
      "CreateWizard 又出现写死的 REGION_OPTIONS 候选表 ⇒ 账号里开第 8 个区在页面上选不到"
    ).toBe(false);
    // 改为从后端取,而后端的真值源是账号 + 注册表
    expect(wiz, "向导没去取账号真值的候选区").toContain("getCandidateRegions");
    const route = read("app/api/admin/exec-envs/candidate-regions/route.ts");
    expect(route, "候选区路由没用 ec2:DescribeRegions —— 那它的清单又是我编的").toContain("DescribeRegionsCommand");
    expect(route, "候选区路由没读注册表 ⇒ 无法标出「已被占用」的区").toContain("listTargetsRaw");
    // 🔴 拿不到账号清单时**不许静默回落**到一份写死的清单(那正是本刀要消灭的东西)
    expect(route, "候选区路由缺「拿不到就响亮报错」").toMatch(/不许静默回落|apiError\(/);
  });

  it("② region **没有默认值**,没选不许往下走 / 不许提交", () => {
    const wiz = stripComments(read("app/exec-envs/CreateWizard.tsx"));
    expect(
      /useState\(\s*["']us-[a-z]+-\d["']\s*\)/.test(wiz),
      "region 又有了写死的默认值 —— 「那个默认值在 2026-09-15 真建出第 5 套环境」"
    ).toBe(false);
    expect(wiz, "region 的初值不是 undefined(必须显式选)").toMatch(/useState<string \| undefined>\(undefined\)/);
    expect(wiz, "第一步的「下一步」没有按 region 门控").toMatch(/disabled=\{!jurisdictionValid \|\| !region\}/);
    expect(wiz, "提交前没有 fail-closed 地拦住「没选区」").toMatch(/if \(!region\)/);
  });

  it("③ 「已被占用的区」列出来但**点不动**(一区一套提前到选区那一刻,而不是提交后 409)", () => {
    const wiz = read("app/exec-envs/CreateWizard.tsx");
    expect(wiz).toMatch(/disabled:\s*Boolean\(o\)/);
    expect(wiz, "禁用了但没写占位者是谁 —— 最坏的不是点不动,是看不出为什么点不动").toContain("已有执行环境");
  });

  it("④ 棘轮:产品代码里写死**非 home 区名 / 非 home targetId** 的处数只减不增", () => {
    // 🔴 为什么只查「非 home」:`us-east-1` 是主控区、`tgt_home` 是产品的一等概念(HOME_TARGET_ID),
    //   它们出现在代码里是正当的。会把 N 卡住的是**写死某个具体的第二/第三区**。
    const BAD = /(["'])(us-west-[12]|us-east-2|eu-west-[123]|eu-central-[12]|ap-southeast-[123]|ap-northeast-[123]|ap-south-1|sa-east-1|ca-central-1)\1|(["'])tgt_(usw2|use1|euw1|apse1)_[a-z]\3/;
    const hits: string[] = [];
    for (const f of sources()) {
      const body = stripComments(readFileSync(f, "utf8"));
      body.split("\n").forEach((line, i) => {
        if (BAD.test(line)) hits.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    // 只减不增:今天的实数就是上限。降下来要**同笔**把这个数改小(和别的棘轮同一条纪律)。
    const HARDCODED_REGION_LIMIT = 0;
    expect(
      hits.length,
      `产品代码里写死了具体的非 home region / targetId(${hits.length} 处,上限 ${HARDCODED_REGION_LIMIT}):\n` +
        hits.slice(0, 20).join("\n") +
        "\n⇒ 这类字面量会把「开 N 个区域也一样」卡死在某个具体区上。" +
        "该从注册表 / 账号真值派生,或由调用方按 targetId 传进来。"
    ).toBeLessThanOrEqual(HARDCODED_REGION_LIMIT);
  });

  // 用户 2026-10-09:「每次刷新列表都去真实查询一次」
  it("⑥ 候选区**每次都真查**:路由 no-store + 回带查询时刻 · 客户端 no-store · 向导有「刷新」且它触发重新取数", () => {
    const route = stripComments(read("app/api/admin/exec-envs/candidate-regions/route.ts"));
    expect(route, "路由没禁缓存 ⇒ 浏览器 / CloudFront 可能回旧清单").toMatch(/Cache-Control["']\s*,\s*["']no-store/);
    expect(route, "路由没回带查询时刻 ⇒ 界面说不出这份清单是什么时候查的").toMatch(/queriedAt:\s*new Date\(\)/);
    // 🔴 路由里不许出现模块级缓存(查一次存起来复用 = 不是「每次真查」)
    expect(/^(let|const)\s+\w*(cache|Cache)\w*\s*[:=]/m.test(route), "路由出现模块级缓存").toBe(false);
    const api = stripComments(read("app/exec-envs/api.ts"));
    expect(api).toMatch(/"\/api\/admin\/exec-envs\/candidate-regions",\s*\{\s*cache:\s*"no-store"\s*\}/);
    const wiz = stripComments(read("app/exec-envs/CreateWizard.tsx"));
    expect(wiz, "向导没有「刷新」按钮").toContain('data-testid="wizard-region-refresh"');
    expect(wiz, "「刷新」没有推动重新取数").toMatch(/onClick=\{\(\) => setRegionReload\(/);
    // 取数 effect 的依赖里必须有刷新计数,否则按钮点了什么也不发生
    expect(wiz, "取数 effect 不依赖刷新计数 ⇒ 点「刷新」不会真查").toMatch(/\}, \[open, t, regionReload\]\);/);
  });

  it("⑤ 后端对 region 只校验**形态**(任何合法区都收)—— N 区自动的地基,不许退回白名单", () => {
    const reg = read("lib/exec-env/registry.ts");
    // 形态正则在(两处:zod 与命令式校验)
    const shape = reg.match(/\^\[a-z\]\{2\}\(-\[a-z\]\+\)\+-\\d\$/g) || [];
    expect(shape.length, "register 的 region 形态校验不见了 ⇒ 可能被换成了白名单").toBeGreaterThanOrEqual(2);
    // 反向:不许出现「region 必须在某个白名单里」这种写法
    const body = stripComments(reg);
    expect(
      /ALLOWED_REGIONS|REGION_WHITELIST|SUPPORTED_REGIONS/.test(body),
      "register 侧出现了 region 白名单 ⇒ 真实账号开新区会被产品自己拦住"
    ).toBe(false);
  });
});
