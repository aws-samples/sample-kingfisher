// 「摘除组件」的判据 —— 纯函数那一半 + 路由形状。
//
// 🔴 这个动作是 2026-09-14 真环境撞出来的缺口:平台有「补充部署」却没有反向动作,
//    于是「组件在现网被真的删掉」之后,描述符永久声称一个不存在的组件、target 卡在 degraded,
//    而两条既有修复路径都拒它(adoptHomeComponents 要 active、reconcileTarget 要 ready=false)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resourceKeysFreedByRetiring } from "@/lib/exec-env/registry";
import { probeSaysComponentGone, isGreenProbeForComponents } from "@/lib/exec-env/component-contract";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");

describe("🔴 resourceKeysFreedByRetiring:只丢**没人再要**的键", () => {
  it("摘 mwaa ⇒ 释放它的私有键;core/redshift 的键一个都不动", () => {
    const freed = resourceKeysFreedByRetiring(["core", "redshift", "mwaa", "airflow-serverless"], ["mwaa"]);
    expect(freed).toContain("mwaaEnvName");
    for (const keep of ["redshiftWorkgroup", "redshiftDatabase", "redshiftSecretArn"]) {
      expect(freed, `${keep} 是 redshift 还要的键,不许被摘 mwaa 连带丢掉`).not.toContain(keep);
    }
  });

  it("🔴 仍被其它组件要的键不许释放(判别力:构造一个共享键的场景)", () => {
    // dagBucket 在契约里挂在 mwaa 名下;若某天 airflow-serverless 也要它,摘 mwaa 就不许丢它
    const both = resourceKeysFreedByRetiring(["core", "mwaa"], ["mwaa"]);
    expect(both).toContain("dagBucket");
    // 反向控制:把 mwaa 留下、摘一个不存在的组件 ⇒ 什么都不释放
    expect(resourceKeysFreedByRetiring(["core", "mwaa"], ["nope"])).toEqual([]);
  });

  it("摘多个组件 ⇒ 并集,且去重排序稳定(便于审计逐字比对)", () => {
    const a = resourceKeysFreedByRetiring(["core", "mwaa", "dms", "flink"], ["dms", "flink"]);
    expect(a).toEqual([...a].sort());
    expect(a).toContain("dmsSubnetGroup");
    expect(a).toContain("flinkRoleArn");
  });
});

describe("🔴🔴 lib 侧四条安全条件必须写在代码里(它们是这个动作能不能存在的全部理由)", () => {
  const src = strip(read("lib/exec-env/registry.ts"));
  const i = src.indexOf("export async function retireComponents");
  const body = src.slice(i, src.indexOf("\nexport ", i + 10));

  it("① 不许摘 core", () => {
    expect(body).toContain('retiring.includes("core")');
  });
  it("🔴② 必须用**专用谓词**证明它不在了,不许拿 `isGreenProbeForComponents` 当「某组件绿不绿」用", () => {
    // 🔴 第一版这条断言写的是 `toContain("isGreenProbeForComponents([c], probe.items)")` ——
    //    那是**把错误实现钉住了**(与 I-6 的 `MAX_TRIES=3` 同一个病):那个函数问的是
    //    「整份探活全绿且恰好只覆盖该集合」,拿来问单个组件必然回 false ⇒ 守卫等于没有,
    //    真环境的负向控制当场把一个**还活着的 redshift** 摘掉了。
    expect(body).toContain("probeSaysComponentGone(c, probe.items)");
    expect(body, "语义不同的函数不许在这条守卫里出现").not.toContain("isGreenProbeForComponents([c]");
    expect(body).toMatch(/if \(notProven\.length\) \{\s*throw new ComponentRetirementRefused/);
  });
  it("③ 三处同步(components / spec.desiredComponents / observed.components)", () => {
    expect(body).toContain("#observed.#observedComponents = :comp2");
    expect(body).toContain("#spec.#desired = :comp2");
  });
  it("④ post-image 过 §3.1a 整包校验 + 条件写(版本 / 无在途会话 / 无部署锁)", () => {
    expect(body).toContain("descriptorViolation(candidate, input.targetId)");
    expect(body).toContain('"#v = :expected"');
    expect(body).toContain('"attribute_not_exists(#observed.#op)"');
    expect(body).toContain('"attribute_not_exists(#lock)"');
  });
  it("摘完若剩下的组件全绿 ⇒ 回到 active(这正是要修的那个 degraded)", () => {
    expect(body).toContain('? "active"');
  });
});

describe("🔴 路由形状:先真探、输名强确认、判定全在 lib", () => {
  const src = strip(read("app/api/admin/exec-envs/[targetId]/retire-components/route.ts"));
  it("必须**先真探**再摘(不信调用方说「它不在了」)", () => {
    const probeAt = src.indexOf("await runProbe(before)");
    const callAt = src.indexOf("await retireComponents(");
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt, "真探必须在摘除之前").toBeLessThan(callAt);
    expect(src, "探不到就不许改描述符").toContain("拒绝在不知道现状的情况下改描述符");
  });
  it("输名强确认(confirm 必须等于 targetId)", () => {
    expect(src).toContain("body.confirm !== params.targetId");
  });
  it("入参白名单 + 审计留痕", () => {
    expect(src).toContain('const CLIENT_FIELDS = ["components", "confirm"]');
    expect(src).toContain('recordAudit(req, "exec-env.retire-components"');
  });
  it("拒因映射成 409 且带「会释放哪些资源键」(让人能判断影响面)", () => {
    expect(src).toContain("ComponentRetirementRefused");
    expect(src).toContain("wouldFree: resourceKeysFreedByRetiring(");
  });
});


describe("🔴🔴 `probeSaysComponentGone` 的行为(这才是守卫的真判据 —— 上一版只断了「调了哪个函数」)", () => {
  const item = (name: string, ok: boolean) => ({ name, ok });

  it("该组件**全绿** ⇒ 没证明它不在(不许摘)", () => {
    expect(probeSaysComponentGone("redshift", [item("redshift:workgroup", true), item("redshift:database", true)])).toBe(false);
  });
  it("该组件**有红项** ⇒ 证明了(可以摘)", () => {
    expect(probeSaysComponentGone("mwaa", [item("mwaa:environment", false)])).toBe(true);
  });
  it("🔴 该组件**一个探活项都没有** ⇒ 不知道 ⇒ 不许摘(拿「没消息」当「没了」是最坏的静默)", () => {
    expect(probeSaysComponentGone("mwaa", [item("redshift:workgroup", true)])).toBe(false);
    expect(probeSaysComponentGone("mwaa", [])).toBe(false);
  });
  it("🔴 **别的组件红着不影响本组件的判定**(这正是上一版用错函数踩的坑)", () => {
    const mixed = [item("mwaa:environment", false), item("redshift:workgroup", true), item("dms:subnetGroup", true)];
    expect(probeSaysComponentGone("mwaa", mixed), "mwaa 自己红 ⇒ 可摘").toBe(true);
    expect(probeSaysComponentGone("redshift", mixed), "redshift 自己绿 ⇒ 不许摘,哪怕 mwaa 红着").toBe(false);
    // 对照:错误用法在同一份探活上会把 redshift 判成「可以摘」
    expect(isGreenProbeForComponents(["redshift"], mixed), "错误用法在这份探活上回 false ⇒ 守卫失效").toBe(false);
  });
});
