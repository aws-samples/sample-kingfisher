// @kf-batch 50-P50.3a-add-components
// "哪些组件已实现" 的 SSOT + 补充部署的**纯判定**单测。
//
// 【本文件的三条承重】
// ① **名单只许缩短**:`PENDING_COMPONENTS` 变长 = 有人把未实现的组件偷偷登记成"待做"却在别处放开;
//    两份名单**不许相交**,否则"已实现"与"未实现"同时成立,界面与 API 会各按一半说话;
// ② **只增不减**:减组件必须被拒 —— 它意味着销毁有状态资源,只能走删除流程(§4.6);
// ③ **未实现组件如实拒绝**:在 API 层就拒,而不是让栈组在部署跑到一半时报错
//    (那会留下半截资源 + 一把要等 lease 过期的部署锁)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IMPLEMENTED_COMPONENTS,
  OPTIONAL_IMPLEMENTED_COMPONENTS,
  PENDING_COMPONENTS,
  isComponentImplemented,
  orderComponents,
  planComponentAddition,
  requiredComponentsFor,
  missingRequiredComponents,
  BASE_REQUIRED_COMPONENTS,
  // @kf-batch 50-WP22-external-components
  EXTERNAL_COMPONENTS,
  isComponentExternal,
} from "@/lib/exec-env/implemented-components";

describe("组件清单(SSOT 自洽)", () => {
  it("core 恒在已实现名单,且不在「可选」名单里(它没有补充部署语义)", () => {
    expect(IMPLEMENTED_COMPONENTS).toContain("core");
    expect(OPTIONAL_IMPLEMENTED_COMPONENTS as readonly string[]).not.toContain("core");
  });

  it("🔴 已实现 = core + 全部可选(两份名单不许各自漂移)", () => {
    expect([...IMPLEMENTED_COMPONENTS].sort()).toEqual(["core", ...OPTIONAL_IMPLEMENTED_COMPONENTS].sort());
  });

  it("🔴 已实现与待实现**零相交**(相交 = 同一组件两种身份,界面与 API 会各按一半说话)", () => {
    const overlap = (PENDING_COMPONENTS as readonly string[]).filter((c) =>
      (IMPLEMENTED_COMPONENTS as readonly string[]).includes(c)
    );
    expect(overlap).toEqual([]);
  });

  it("P50.3a 的实现范围如实钉住(改了范围必须同时改这条断言 —— 防悄悄放开)", () => {
    // @kf-batch 50-W5-seg1-WP10a:residency-api 片 1 落地 ⇒ 从待做移到已实现(名单只许缩短:4 → 3)
    // @kf-batch 50-WP15-airflow-serverless:airflow-serverless 直接进已实现(不先登记为待做 ⇒ PENDING 名单不变,仍只许缩短)
    expect([...IMPLEMENTED_COMPONENTS]).toEqual(["core", "redshift", "dms", "flink", "residency-api", "mwaa", "airflow-serverless"]);
    // @kf-batch 50-WP22-external-components:agentcore 从「待后续批次」搬去 `EXTERNAL_COMPONENTS`
    //   —— 它**已经装了**(由平台自己的栈部署),只是不由 exec-env 栈组建。名单仍只许缩短:2 → 1。
    expect([...PENDING_COMPONENTS]).toEqual(["kafka"]);
    expect([...EXTERNAL_COMPONENTS]).toEqual(["agentcore"]);
    // 🔴 三份名单必须**两两不相交**(重叠 = 两条规则打架,夹缝里的对象会被永久堵死 —— WP-22 的病根)
    const all = [...IMPLEMENTED_COMPONENTS, ...PENDING_COMPONENTS, ...EXTERNAL_COMPONENTS];
    expect(new Set(all).size, `三份名单有重叠:${all.join(",")}`).toBe(all.length);
  });

  it("isComponentImplemented:已实现 true / 待实现 false / 未知 false", () => {
    expect(isComponentImplemented("redshift")).toBe(true);
    expect(isComponentImplemented("mwaa")).toBe(true);
    expect(isComponentImplemented("kafka")).toBe(false);
    expect(isComponentImplemented("nosuch")).toBe(false);
  });

  it("orderComponents:去重 + 固定次序;未知项落尾部但不丢(调用方各自校验)", () => {
    expect(orderComponents(["flink", "core", "core", "redshift"])).toEqual(["core", "redshift", "flink"]);
    expect(orderComponents(["kafka", "core"])).toEqual(["core", "kafka"]);
  });
});

// @kf-batch 50-PROD-B-seq33 ②:planComponentAddition 的第三参(它是谁)必填
const S = { isHome: false, jurisdiction: "home" };
const FULL = ["core", "redshift", "dms", "flink", "airflow-serverless"];

describe("planComponentAddition(补充部署的判定)", () => {
  // @kf-batch 50-PROD-B-seq33 ②:补充部署 = 补齐到完整组件集(不提供精简形态)
  it("正常:core-only 的存量环境补齐 ⇒ 全集 = 完整组件集 + added 只含缺的", () => {
    const p = planComponentAddition(["core"], ["core", "redshift", "dms", "flink", "airflow-serverless"], S);
    expect(p).toEqual({ ok: true, wanted: ["core", "redshift", "dms", "flink", "airflow-serverless"], added: ["redshift", "dms", "flink", "airflow-serverless"] });
  });

  it("正常:一次补两个,次序按 SSOT 归一(不按客户端给的顺序)", () => {
    const p = planComponentAddition(["core", "redshift", "airflow-serverless"], ["flink", "airflow-serverless", "core", "redshift", "dms"], S);
    expect(p.ok && p.wanted).toEqual(["core", "redshift", "dms", "flink", "airflow-serverless"]);
    expect(p.ok && p.added).toEqual(["dms", "flink"]);
  });

  it("形状:非数组 / 空数组 / 含非字符串 ⇒ 拒", () => {
    for (const bad of ["core", [], [1, "core"], null, undefined, {}]) {
      const p = planComponentAddition(["core"], bad, S);
      expect(p.ok, `${JSON.stringify(bad)} 应被拒`).toBe(false);
      expect(p.ok === false && p.message).toMatch(/非空字符串数组/);
    }
  });

  it("🔴 缺 core ⇒ 拒(全集语义下省略 core 等于要求卸掉它)", () => {
    const p = planComponentAddition(["core"], ["redshift"], S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/必须含 core/);
  });

  it("🔴 含未实现组件 ⇒ 拒,且拒因点名该组件 + 给出两份名单", () => {
    const p = planComponentAddition(["core"], ["core", "kafka"], S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/kafka/);
    expect(p.ok === false && p.message).toMatch(/尚未实现/);
  });

  it("🔴 只增不减:全集里缺了已装组件 ⇒ 拒并指向删除流程(绝不靠少传一个组件卸载有状态资源)", () => {
    const p = planComponentAddition(["core", "redshift"], ["core"], S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/不允许用补充部署减少组件/);
    expect(p.ok === false && p.message).toMatch(/redshift/);
    expect(p.ok === false && p.message).toMatch(/删除流程/);
  });

  it("没有新增(全集 == 已装)⇒ 拒并指向「重新部署」(避免一次点击变成两条部署路径)", () => {
    const p = planComponentAddition(FULL, [...FULL].reverse(), S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/没有要新增的组件/);
  });

  // @kf-batch 50-W5-seg1-WP3 —— 升级预演(SPEC §2.1 v3.21):preview 传 allowNoAddition,同集放行且 added=[]
  it("allowNoAddition(升级预演):全集 == 已装 ⇒ ok 且 added=[];减组件照旧拒", () => {
    expect(planComponentAddition(FULL, [...FULL].reverse(), S, { allowNoAddition: true })).toEqual({ ok: true, wanted: FULL, added: [] });
    const p = planComponentAddition(FULL, ["core"], S, { allowNoAddition: true });
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/不允许用补充部署减少组件/);
  });

  it("注册表里的 components 是脏值(含非字符串)时不炸:只按字符串项判定", () => {
    const p = planComponentAddition(["core", 42 as unknown as string, "redshift", "dms", "airflow-serverless"], FULL, S);
    expect(p).toEqual({ ok: true, wanted: FULL, added: ["flink"] });
  });

  // ── @kf-batch 50-PROD-B-seq33 ② —— 🔴🔴 不提供精简形态(用户 2026-10-10)──
  it("🔴 只补一半(补完仍不完整)⇒ 拒,拒因点名还缺的", () => {
    const p = planComponentAddition(["core"], ["core", "redshift"], S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/执行环境不完整:缺少 dms、flink、airflow-serverless/);
  });
  it("🔴 升级预演也不放过不完整的环境(先补齐再升级)", () => {
    const p = planComponentAddition(["core", "dms"], ["core", "dms"], S, { allowNoAddition: true });
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/执行环境不完整/);
  });
  it("🔴 另装要求集以外的组件 ⇒ 拒(同法域多装 residency-api)", () => {
    const p = planComponentAddition(FULL, [...FULL, "residency-api"], S);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.message).toMatch(/不在该执行环境的完整组件集/);
  });
  it("跨法域:完整集含 residency-api;补齐它 ⇒ ok", () => {
    const X = { isHome: false, jurisdiction: "eu-sim" };
    const p = planComponentAddition(FULL, [...FULL, "residency-api"], X);
    expect(p).toEqual({ ok: true, wanted: [...FULL.slice(0, 4), "residency-api", "airflow-serverless"], added: ["residency-api"] });
  });
});

describe("🔴🔴 requiredComponentsFor:完整组件集的唯一作者(seq33 ②)", () => {
  it("非主控区 · 同法域 = 五件套;跨法域另加 residency-api;主控区另加 agentcore", () => {
    expect(requiredComponentsFor({ isHome: false, jurisdiction: "home" })).toEqual(FULL);
    expect(requiredComponentsFor({ isHome: false })).toEqual(FULL);
    expect(requiredComponentsFor({ isHome: false, jurisdiction: "" }), "空串按 home(与 jurisdictionOf 同口径)").toEqual(FULL);
    expect(requiredComponentsFor({ isHome: false, jurisdiction: "eu-sim" })).toEqual([...FULL.slice(0, 4), "residency-api", "airflow-serverless"]);
    expect(requiredComponentsFor({ isHome: true, jurisdiction: "home" })).toEqual([...FULL, "agentcore"]);
  });
  it("要求集里没有停供(mwaa)/ 未实现(kafka)的组件", () => {
    for (const s of [{ isHome: true }, { isHome: false, jurisdiction: "eu-sim" }]) {
      const r = requiredComponentsFor(s);
      expect(r).not.toContain("mwaa");
      expect(r).not.toContain("kafka");
    }
  });
  it("missingRequiredComponents:只报缺的;多装的存量组件不算缺", () => {
    expect(missingRequiredComponents(["core", "mwaa"], { isHome: false })).toEqual(["redshift", "dms", "flink", "airflow-serverless"]);
    expect(missingRequiredComponents([...FULL, "mwaa"], { isHome: false })).toEqual([]);
  });
  it("🔴 infra 副本(context.ts EXEC_ENV_REQUIRED_BASE_COMPONENTS)== 本侧 BASE_REQUIRED_COMPONENTS(逐项同序)", () => {
    const src = readFileSync(resolve(__dirname, "..", "..", "..", "..", "..", "infra", "lib", "exec-env", "context.ts"), "utf8");
    const m = src.match(/export const EXEC_ENV_REQUIRED_BASE_COMPONENTS\s*=\s*\[([^\]]*)\]/);
    expect(m, "infra 侧找不到 EXEC_ENV_REQUIRED_BASE_COMPONENTS").toBeTruthy();
    const infraList = (m![1].match(/"([a-z-]+)"/g) ?? []).map((x) => x.replace(/"/g, ""));
    expect(infraList).toEqual([...BASE_REQUIRED_COMPONENTS]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 跨构建边界的契约:同一份"已实现组件"名单在 infra 侧也有一份
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 与 infra 侧 IMPLEMENTED_COMPONENTS 必须逐字一致(跨构建边界无法共享常量)", () => {
  // 【为什么必须钉】platform 与 infra 是两个独立构建,常量没法 import 过去 ⇒ 各存一份。
  // 一旦漂移:平台说"flink 已实现"而栈组照旧 throw ⇒ 用户点「补充部署」→ broker 起 build →
  // build 在 synth 阶段炸(白等 15 分钟);反向漂移则是"栈组支持却被平台拦住"。
  // 手法照既有先例:deploy-control.test.ts 用 readFileSync 逐字比对 infra 源码里的 broker/项目名。
  it("infra/lib/exec-env/stack-group.ts 的名单 == 本侧名单", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "..", "infra", "lib", "exec-env", "stack-group.ts"),
      "utf8"
    );
    const m = src.match(/export const IMPLEMENTED_COMPONENTS\s*=\s*\[([^\]]*)\]/);
    expect(m, "infra 侧找不到 IMPLEMENTED_COMPONENTS(改名了?那本测试要同步)").toBeTruthy();
    const infraList = (m![1].match(/"([a-z-]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
    expect(infraList.length, "infra 侧名单解析为空 —— 正则坏了会让本测试变成假绿").toBeGreaterThan(1);
    expect([...infraList].sort()).toEqual([...IMPLEMENTED_COMPONENTS].sort());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// @kf-batch 50-WP22-external-components
// 🔴🔴 WP-22:`components` 被当成两件事用 ⇒ 夹缝里的已装组件把整条「补充部署」堵死
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴🔴 external 组件(由平台自己的栈部署)不许把补充部署堵死", () => {
  // 真环境形状:home 装了 core/redshift/dms/flink/airflow-serverless/**agentcore**,
  // 而 agentcore 没有 exec-env 组件栈。修前:任何 wanted 都必含 agentcore(不许减组件)
  // ⇒ 被「栈尚未实现」拒 ⇒ **home 永远补装不了任何组件**,拒因还说的是 agentcore(与请求无关)。
  const HOME = ["core", "redshift", "dms", "flink", "airflow-serverless", "agentcore"];
  const HS = { isHome: true, jurisdiction: "home" };

  it("🔴 已装 external 组件的 target **能**补装别的组件,且 added 只含真正新增的那个", () => {
    // @kf-batch 50-PROD-B-seq33 ②:补的必须是要求集里缺的 ⇒ 用「缺 flink 的 home」造形状
    const r = planComponentAddition(HOME.filter((c) => c !== "flink"), HOME, HS);
    expect(r.ok, r.ok ? "" : `被拒了:${r.message}`).toBe(true);
    if (r.ok) {
      expect(r.added).toEqual(["flink"]);
      // 🔴 描述符要保留**事实**:全集里 agentcore 还在(它真的装了)
      expect(r.wanted).toContain("agentcore");
    }
  });

  it("🔴 过滤**只在 infra 侧**做:平台侧不许先滤掉 external(那会让描述符丢掉 agentcore 这个事实)", () => {
    // 喂给 broker 的数组同时是它写回描述符的 `components` 投影(validate.mjs 的 plan.projection.components)
    // ⇒ 平台侧先滤 ⇒ 组件列表里看不见 agentcore 了。所以这里断**平台侧没有这样一个函数**。
    // 🔴 负向文本断言**必须先剥注释** —— 我在注释里写了「不要再造一个 componentsForStackGroup」,
    //    结果当场被自己的断言咬中(同族今天第三次)。
    const strip = (x: string) =>
      x.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    const src = strip(readFileSync(resolve(__dirname, "..", "implemented-components.ts"), "utf8"));
    expect(src, "平台侧又造了一个「给栈组的集合」⇒ 会把描述符事实滤掉").not.toContain("componentsForStackGroup");
    // 反向控制:剥注释别把代码也剥没了(剥完仍要认得出真正的导出)
    expect(src, "剥注释剥过头 ⇒ 上面那条负向断言变成恒真").toContain("export function isComponentExternal");
    const route = readFileSync(
      resolve(__dirname, "..", "..", "..", "app", "api", "admin", "exec-envs", "[targetId]", "add-components", "route.ts"),
      "utf8"
    );
    expect(route, "补充部署必须把**全集**交给 broker(external 由 infra 侧栈组跳过)").toContain("invokeDeployBroker(params.targetId, wanted,");
  });

  it("🔴 **没装** external 组件的 target 想装它 ⇒ 仍然拒,且拒因说清它由平台自己的栈部署", () => {
    const r = planComponentAddition(["core", "redshift"], ["core", "redshift", "agentcore"], S);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("平台自己的栈");
      expect(r.message, "别再说成「栈尚未实现」——那句话把人引去等一个永远不会来的批次").not.toContain("尚未实现");
    }
  });

  it("真正未实现的组件(kafka)照旧被拒 —— 放行 external 不许连带把 fail-closed 放掉", () => {
    const r = planComponentAddition(["core"], ["core", "kafka"], S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("尚未实现");
  });

  it("减掉已装组件仍然被拒(external 放行不许把「只增不减」放掉)", () => {
    const r = planComponentAddition(HOME, HOME.filter((c) => c !== "redshift"), HS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("不允许用补充部署减少组件");
  });

  it("名单自洽:external 与 pending / implemented 互不重叠(重叠 = 两条规则打架)", () => {
    for (const c of EXTERNAL_COMPONENTS) {
      expect(isComponentExternal(c)).toBe(true);
      expect(PENDING_COMPONENTS as readonly string[], `${c} 同时在 pending 里`).not.toContain(c);
      expect(IMPLEMENTED_COMPONENTS as readonly string[], `${c} 同时在 implemented 里`).not.toContain(c);
    }
    expect(isComponentExternal("redshift")).toBe(false);
  });

  it("🔴 infra 侧 stack-group.ts 的 EXTERNAL_COMPONENTS == 本侧(跨构建边界,漂移 ⇒ 栈组照旧报错)", () => {
    const src = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "..", "infra", "lib", "exec-env", "stack-group.ts"),
      "utf8"
    );
    const m = src.match(/export const EXTERNAL_COMPONENTS\s*=\s*\[([^\]]*)\]/);
    expect(m, "infra 侧找不到 EXTERNAL_COMPONENTS").toBeTruthy();
    const infraList = (m![1].match(/"([a-z-]+)"/g) ?? []).map((x) => x.replace(/"/g, ""));
    expect(infraList.length, "解析为空 ⇒ 本测试变假绿").toBeGreaterThan(0);
    expect([...infraList].sort()).toEqual([...EXTERNAL_COMPONENTS].sort());
    // 🔴 栈组必须**跳过**它而不是报错:那句 notYet 过滤里要同时排除 external
    const notYet = src.match(/const notYet = ctx\.components\.filter\(([\s\S]*?)\);/);
    expect(notYet, "找不到 notYet 过滤 ⇒ 形状变了,请同步本门禁").toBeTruthy();
    expect(notYet![1], "notYet 没排除 external ⇒ CodeBuild 会在 agentcore 上炸").toContain("EXTERNAL_COMPONENTS");
  });
});
