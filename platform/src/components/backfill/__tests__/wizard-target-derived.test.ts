// 2026-11-04(C)—— 补数向导「随所选目标变化」的派生块:
//   ① 服务端真渲染(renderToStaticMarkup + 真 I18nProvider + 真 antd Form,不 mock 兄弟模块)钉 DOM 事实:选中工作流 ⇒ 「级联下游依赖」开关
//      (Form.Item 注入 id="cascade",label for 指向它)出现;含同步节点 ⇒ 提示出现;同步任务 ⇒ 同步提示;离线作业 / 未选 ⇒ 三块都没有;
//   ② 接缝(源码调用点):页面不再在渲染期读 Form 值仓(`form.getFieldValue("targetId")`),所选目标 id 进 React state、在 onValuesChange 里写、
//      打开向导时清空;派生块与并发置灰都从同一个 state 派生;
//   ③ 判定单一作者:并发置灰与「含同步节点」判定只在本组件文件里定义(页面 import,不自己再写一份)。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Form } from "antd";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import I18nProvider from "@/lib/i18n/I18nProvider";
import WizardTargetDerived, { isConcurrencyForced, workflowHasSyncNode, type BackfillTargetOption } from "@/components/backfill/WizardTargetDerived";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const h = React.createElement;
const render = (target: BackfillTargetOption | undefined) =>
  renderToStaticMarkup(h(I18nProvider, null, h(Form, null, h(WizardTargetDerived, { target }))));

const WF_SQL: BackfillTargetOption = { id: "wf-sql-01AB", name: "日报", scope: "workflow", kind: "workflow", taskType: "workflow", nodeCount: 2, nodeTypes: ["sql"] };
const WF_SYNC: BackfillTargetOption = { ...WF_SQL, id: "wf-sync-02CD", nodeTypes: ["sync", "sql"] };
const SYNC_TASK: BackfillTargetOption = { id: "st-03EF", name: "订单同步", scope: "task", kind: "sync-task", taskType: "sync" };
const ETL_JOB: BackfillTargetOption = { id: "job-04GH", name: "清洗", scope: "task", kind: "etl-job", taskType: "etl-glue" };

describe("WizardTargetDerived 服务端真渲染", () => {
  it("选中工作流 ⇒ 「级联下游依赖」开关出现(Form.Item 注入 id=cascade,label for 指向它);纯 SQL 工作流没有同步提示", () => {
    const html = render(WF_SQL);
    expect(html).toContain("级联下游依赖");
    expect(html).toMatch(/<button[^>]*\bid="cascade"/);
    expect(html).toMatch(/<label[^>]*\bfor="cascade"/);
    expect(html).not.toContain('data-testid="backfill-hint-wf-sync"');
    expect(html).not.toContain('data-testid="backfill-hint-sync-task"');
  });
  it("含同步节点的工作流 ⇒ 同步节点提示 + 级联开关都出现", () => {
    const html = render(WF_SYNC);
    expect(html).toContain('data-testid="backfill-hint-wf-sync"');
    expect(html).toContain("该工作流含数据同步节点");
    expect(html).toMatch(/<button[^>]*\bid="cascade"/);
  });
  it("同步任务 ⇒ 只有同步任务提示(没有级联开关)", () => {
    const html = render(SYNC_TASK);
    expect(html).toContain('data-testid="backfill-hint-sync-task"');
    expect(html).toContain("同步任务按业务日期逐天补数");
    expect(html).not.toContain('id="cascade"');
  });
  it("负向对照:离线作业 / 未选目标 ⇒ 三块都不渲染(上面不是凭空成立)", () => {
    for (const target of [ETL_JOB, undefined]) {
      const html = render(target);
      expect(html).not.toContain("级联下游依赖");
      expect(html).not.toContain("backfill-hint-");
    }
  });
  it("并发置灰判定与提示同口径:同步任务 / 含同步节点工作流 ⇒ 置灰;纯 SQL 工作流 / 离线作业 / 未选 ⇒ 不置灰", () => {
    expect(isConcurrencyForced(SYNC_TASK)).toBe(true);
    expect(isConcurrencyForced(WF_SYNC)).toBe(true);
    expect(workflowHasSyncNode(WF_SYNC)).toBe(true);
    expect(isConcurrencyForced(WF_SQL)).toBe(false);
    expect(isConcurrencyForced(ETL_JOB)).toBe(false);
    expect(isConcurrencyForced(undefined)).toBe(false);
  });
});

describe("接缝:补数页所选目标进 React state(渲染期不再读 Form 值仓)", () => {
  const page = strip(readFileSync(resolve(SRC, "app/backfill/page.tsx"), "utf8"));
  it("🔴 页面渲染期不再 form.getFieldValue(\"targetId\")(那正是派生 UI 不出现的根因)", () => {
    expect(page).not.toMatch(/getFieldValue\(\s*["']targetId["']\s*\)/);
  });
  it("所选目标 id 是 React state:onValuesChange 里写、打开向导时清空、派生块从它取", () => {
    expect(page).toMatch(/const \[selectedTargetId, setSelectedTargetId\] = useState<string>\(""\);/);
    expect(page).toMatch(/onValuesChange=\{\(_changed, all\) => \{\s*setPreview\(null\);\s*setSelectedTargetId\(String\(all\?\.targetId \?\? ""\)\);\s*\}\}/);
    expect(page).toMatch(/const openWizard = \(\) => \{[\s\S]*?setSelectedTargetId\(""\);/);
    expect(page).toMatch(/const tgtSel = targets\.find\(\(x\) => x\.id === selectedTargetId\);/);
    expect(page).toContain("<WizardTargetDerived target={tgtSel} />");
    expect(page).toContain("disabled={concurrencyForced}");
    expect(page).toMatch(/const concurrencyForced = isConcurrencyForced\(tgtSel\);/);
  });
  it("判定单一作者:页面不再自己写一份 nodeTypes.includes(\"sync\") / kind === \"sync-task\" 的派生", () => {
    expect(page).not.toMatch(/nodeTypes\.includes\(\s*["']sync["']\s*\)/);
    expect(page).not.toMatch(/tgtSel\?\.kind === ["']sync-task["']/);
    expect(page).toContain('import WizardTargetDerived, { isConcurrencyForced } from "@/components/backfill/WizardTargetDerived";');
  });
});
