// @kf-batch 50-WP17-serverless-workflow
// 判据 ACCEPTANCE 段 `slsw` **SW-11**:经典 mwaa **不再提供新装**,而**存量环境功能守恒**。
//
// 🔴 这一组的全部难点在**那条界线**:用户拍板「后面也不部署普通版本的 mwaa 了」,
// 但现网两个执行环境都装着它。把 `mwaa` 从合法组件全集里删掉 = 把**存量环境判成非法**
// (它们的描述符里就写着 `mwaa`)⇒ 探活 / 详情页 / 下线路径一起崩。
// 所以正确的语义是「**已实现且仍认,但不再提供**」= 一个新状态 `retired`,不是删掉、也不是 pending。
import { describe, expect, it } from "vitest";
import { registerTarget } from "@/lib/exec-env/registry";
import {
  IMPLEMENTED_COMPONENTS,
  OFFERED_OPTIONAL_COMPONENTS,
  OPTIONAL_IMPLEMENTED_COMPONENTS,
  PENDING_COMPONENTS,
  RETIRED_COMPONENTS,
  isComponentImplemented,
  isComponentRetired,
  planComponentAddition,
} from "@/lib/exec-env/implemented-components";

describe("SW-11 经典 mwaa:不再提供,存量守恒", () => {
  it("🔴 `mwaa` 仍是**已实现**组件(类型仍认它)—— 否则存量环境的描述符会被判非法", () => {
    expect(isComponentImplemented("mwaa")).toBe(true);
    expect(IMPLEMENTED_COMPONENTS).toContain("mwaa");
    expect(PENDING_COMPONENTS, "停供 ≠ 未实现,别混进 pending(那会让存量环境的探活报「栈不存在」)").not.toContain("mwaa");
  });

  it("🔴 但它**不在可新装清单**里(向导不给勾)", () => {
    expect(isComponentRetired("mwaa")).toBe(true);
    expect(RETIRED_COMPONENTS).toEqual(["mwaa"]);
    expect(OFFERED_OPTIONAL_COMPONENTS).not.toContain("mwaa");
    expect(OFFERED_OPTIONAL_COMPONENTS).toContain("airflow-serverless");
    // 可新装清单 = 已实现可选清单 − 停供清单(派生,不许各写一份)
    expect([...OFFERED_OPTIONAL_COMPONENTS].sort()).toEqual(
      OPTIONAL_IMPLEMENTED_COMPONENTS.filter((c) => !isComponentRetired(c)).sort()
    );
  });

  it("🔴🔴 补充部署:**没装过**就想装 mwaa ⇒ 拒(带出路);**已装**的必须照旧放行", () => {
    // 没装过 ⇒ 这是「新装」⇒ 拒
    const deny = planComponentAddition(["core"], ["core", "mwaa"], { isHome: false });
    expect(deny.ok).toBe(false);
    expect((deny as { message: string }).message).toMatch(/已停止提供[\s\S]*airflow-serverless/);

    // 🔴 已装 mwaa 的环境要补装别的组件时,`components` 是**全集**语义、且明令不许减组件
    //   ⇒ 它**必须**继续带着 mwaa。判据写成「全集里不许有 mwaa」就会把存量环境彻底锁死
    //   (连补装 airflow-serverless 都做不到)—— 差一个字,行为差很远。
    // @kf-batch 50-PROD-B-seq33 ②:补充部署 = 补齐到完整集 ⇒ 存量形状改成「缺 airflow-serverless、带着 mwaa」
    const keep = planComponentAddition(["core", "mwaa", "redshift", "dms", "flink"], ["core", "mwaa", "redshift", "dms", "flink", "airflow-serverless"], { isHome: false });
    expect(keep.ok, (keep as { message?: string }).message).toBe(true);
    expect((keep as { added: string[] }).added).toEqual(["airflow-serverless"]);

    // 存量环境「只想重跑一次预演」(全集 == 已装)也照旧
    const FULL_MWAA = ["core", "redshift", "mwaa", "dms", "flink", "airflow-serverless"];
    const preview = planComponentAddition(FULL_MWAA, FULL_MWAA, { isHome: false }, { allowNoAddition: true });
    expect(preview.ok).toBe(true);
  });

  // 🔴 变异抓到的判据洞:上一版只 grep 源码里有没有那两个符号 —— 把判断改成 `if (retired.length && false)`
  //   也照样绿。改成**真跑那个校验函数**(它在任何 IO 之前抛,所以单测里可以直接调)。
  it("🔴🔴 注册(= 新装)带 mwaa ⇒ **真的抛**(不是「源码里有那行」):拒因带出路", async () => {
    const input = { region: "us-east-1", partition: "aws", accountId: "123456789012", components: ["core", "mwaa"] };
    await expect(registerTarget(input as never, "tester")).rejects.toThrow(/已停止提供[\s\S]*airflow-serverless/);
    // 正向:不带停供组件时,这道校验放行(会继续往下走到别的校验/IO —— 只要不是被本条拒即可)
    const ok = { ...input, components: ["core", "airflow-serverless"] };
    await expect(registerTarget(ok as never, "tester")).rejects.not.toThrow(/已停止提供/);
  });

  it("拒因文本只许有**一处**定义(向导 / 注册 / 补充部署共用一份人话)", () => {
    const cat = readSource("lib/exec-env/implemented-components.ts");
    expect(cat.split("已停止提供:调度与编排统一走 airflow-serverless").length - 1).toBe(1);
    for (const f of ["lib/exec-env/registry.ts", "app/exec-envs/api.ts"]) {
      expect(readSource(f), `${f} 自己抄了一份拒因文案`).not.toContain("已停止提供:调度与编排统一走");
    }
  });

  // @kf-batch 50-PROD-B-seq33 ②:向导不再有勾选(组件集由法域唯一决定)⇒ 停供组件**根本不出现在向导里**;
  //   「已停止提供」的说明留在 api.ts 的元数据里,供详情页给存量已装 mwaa 的环境显示。
  it("🔴 向导:只读列完整组件集,停供的 mwaa 不出现;api.ts 元数据仍留 mwaa 一行(存量详情页要用)", () => {
    const api = readSource("app/exec-envs/api.ts");
    expect(api).toContain("isComponentRetired(c.key)");
    expect(api).toMatch(/available:\s*isComponentImplemented\(c\.key\)\s*&&\s*!isComponentRetired\(c\.key\)/);
    expect(api, "整行删掉 = 手上已有 mwaa 的人看不懂为什么它消失了").toMatch(/key: "mwaa"/);
    const wiz = readSource("app/exec-envs/CreateWizard.tsx");
    expect(wiz).toContain("requiredComponentsFor({ isHome: false, jurisdiction })");
    expect(wiz, "向导只列要求集").toContain("COMPONENT_META.filter((c) => required.includes(c.key))");
    expect(wiz, "向导里不许再有组件勾选框").not.toMatch(/<Checkbox[^>]*wizard-component/);
  });

  it("🔴 调度器偏好缺省 = serverless(两者都装时优先它)", () => {
    const src = readSource("lib/scheduler/mwaa-endpoint.ts");
    // 两处(home 与非 home)都必须是 `?? "serverless"`
    expect(src.match(/schedulerPreference\s*\?\?\s*"serverless"/g) ?? []).toHaveLength(2);
  });
});

function readSource(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
}
