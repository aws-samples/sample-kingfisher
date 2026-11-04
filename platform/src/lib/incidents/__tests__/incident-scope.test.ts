/**
 * 钉住运维知识库的区维:
 *   ① 主档的 `targets[]` 必须走平台唯一的 B 类归属判定(含三级回落),不能在知识库里另写一份;
 *   ② 章的来源必须是**诊断关联的那条 run**,不是猜的;
 *   ③ `affectedTasks` 与 `targets` 必须在**同一次 Get** 里合并(两次读会拿到两个快照,
 *      合出来的任务名列表与区列表对不上)。
 *
 * 🔴 判别性夹具:两行**一行有章、一行无章**。若哪天有人把回落规则改成「无章 ⇒ 不属于任何区」,
 * 主控区视角就会**静默少一条**;若改成「无章 ⇒ 属于所有区」,usw2 视角会**多一条**。
 * 只用一行有章的数据测,这两种改法都测不出来(那正是「没有判别力的判据 = 空断言」)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterRowsByScope } from "@/lib/exec-env/scope";
import { COUNTABLE_KINDS, KIND_INDEX } from "@/lib/scope/resource-index";

const SRC = resolve(__dirname, "../../..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";

describe("运维知识库的执行范围归属", () => {
  const masters = [
    { signature: "sig-usw2-only", targets: [USW2] },
    { signature: "sig-legacy-no-stamp" }, // 落章之前的存量主档
    { signature: "sig-both", targets: [HOME, USW2] },
  ];

  it("单区视角只看得到发生在那个区的故障类别", () => {
    const got = filterRowsByScope(masters as Array<Record<string, unknown>>, { kind: "target", targetId: USW2 })
      .map((r) => r.signature);
    expect(got).toEqual(["sig-usw2-only", "sig-both"]);
  });

  it("🔴 无章的存量主档回落主控区(既不能消失,也不能出现在别的区)", () => {
    const home = filterRowsByScope(masters as Array<Record<string, unknown>>, { kind: "target", targetId: HOME })
      .map((r) => r.signature);
    expect(home, "存量主档必须在主控区视角看得见 —— 落章之前作业只在主控区跑过").toContain("sig-legacy-no-stamp");
    const usw2 = filterRowsByScope(masters as Array<Record<string, unknown>>, { kind: "target", targetId: USW2 })
      .map((r) => r.signature);
    expect(usw2, "存量主档不许出现在别的区视角(那是凭空造出一条那个区的故障)").not.toContain("sig-legacy-no-stamp");
  });

  it("全局视角一条不少", () => {
    expect(filterRowsByScope(masters as Array<Record<string, unknown>>, { kind: "global" })).toHaveLength(3);
  });

  it("🔴 章的来源必须是诊断关联的那条 run(不许在知识库里猜一个区)", () => {
    const rec = strip(read("lib/incidents/record.ts"));
    expect(rec, "没从 run 行读 targetId ⇒ 只能靠猜").toMatch(/ProjectionExpression:\s*"#e,\s*targetId"/);
    expect(rec, "取到的章要传给主档 upsert").toMatch(/targetId,?\s*\n?\s*\}\);/);
  });

  it("🔴 affectedTasks 与 targets 必须在同一次 Get 里合并", () => {
    const store = strip(read("lib/incidents/store.ts"));
    // 两个集合出自同一个 ProjectionExpression ⇒ 同一个快照
    expect(store).toMatch(/ProjectionExpression:\s*"affectedTasks,\s*#targets"/);
    // 不许再留着只读 affectedTasks 的旧读法(那就是第二次 Get)
    expect(store).not.toMatch(/ProjectionExpression:\s*"affectedTasks"\s*\}/);
  });

  it("🔴 `incident` 已登记为可计数资源,且读法复用 listMasters(另写 Scan 会数进别的项目)", () => {
    expect(COUNTABLE_KINDS).toContain("incident");
    expect(KIND_INDEX.incident.read).toBe("service-fn");
    expect(KIND_INDEX.incident.attribution).toBe("binding");
    expect(KIND_INDEX.incident.mirrorOf).toBe("lib/incidents/store.ts:listMasters");
  });
});
