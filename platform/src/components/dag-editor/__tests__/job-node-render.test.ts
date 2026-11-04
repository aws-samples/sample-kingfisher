// 序 73 模块 57(57 DESIGN §3.8 / §4)—— 页面组件服务端真渲染(renderToStaticMarkup + 真 I18nProvider):
//   ① JobNode:testid dag-node-job;已关联 ⇒ 作业名 + 引擎 Tag;未关联 ⇒ 「未关联离线作业」;作业不存在 ⇒ 「作业不存在…」;
//   ② NodeConfigForm(job):testid job-node-picker 的 antd Select、「关联离线作业」、候选按执行区过滤的说明(带区名)、候选读取失败红字;
//      Form.Item 注入的 id=jobRef 透传到控件(B-94 教训);sync 节点下拉 testid sync-node-picker;
//   ③ 接线(源码字面):调色板自动出现(userPlaceable)、DagEditor nodeTypes 有 job、详情页把 wfTargets 传进编辑器、面板的三条候选 URL 都带 scope=;
//   ④ jobRef ⇄ Select 标量值的编解码闭合(kind 不在清单 ⇒ 不选中)。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { JobNode, jobEngineLabel } from "@/components/dag-editor/JobNode";
import { NodeConfigForm, encodeJobRef, decodeJobRef } from "@/components/dag-editor/NodeConfigPanel";
import { PALETTE_NODE_TYPES } from "@/lib/workflow/node-registry";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

function renderNode(data: Record<string, unknown>): string {
  const props = { id: "j1", type: "job", data, selected: false, isConnectable: true, xPos: 0, yPos: 0, zIndex: 0, dragging: false } as never;
  return renderToStaticMarkup(h(I18nProvider, null, h(ReactFlowProvider, null, h(JobNode, props))));
}
const CANDS = {
  syncTasks: [], etlJobs: [{ jobId: "01JOBGLUE000000000000000AB", name: "每日清洗", type: "glue", targets: ["tgt_home", "tgt_usw2_a"] }],
  emrJobs: [{ jobId: "01JOBEMR0000000000000000AD", name: "spark-roi", targets: ["tgt_usw2_a"] }], error: null as string | null, loaded: true,
};
function renderForm(node: Record<string, unknown>, cands = CANDS): string {
  return renderToStaticMarkup(h(I18nProvider, null, h(NodeConfigForm, { node: node as never, cands, wfTargets: ["tgt_usw2_a"], onChange: () => undefined })));
}

describe("① JobNode 服务端真渲染", () => {
  it("已关联 ⇒ 根节点 testid + 作业名 + 引擎 Tag", () => {
    const html = renderNode({ label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" }, jobName: "每日清洗", jobEngine: "glue" });
    expect(html).toContain('data-testid="dag-node-job"');
    expect(html).toContain("清洗");
    expect(html).toMatch(/data-testid="dag-node-job-name"[^>]*>每日清洗</);
    expect(html).toMatch(/data-testid="dag-node-job-engine"[^>]*>Glue</);
    expect(html).not.toContain("未关联离线作业");
  });
  it("未关联 ⇒ 「未关联离线作业」;作业不存在 ⇒ 「作业不存在或不再绑定本工作流的执行区」", () => {
    expect(renderNode({ label: "清洗" })).toMatch(/data-testid="dag-node-job-warning"[^>]*>未关联离线作业</);
    expect(renderNode({ label: "清洗", jobRef: { kind: "emr", jobId: "x" }, jobMissing: true })).toContain("作业不存在或不再绑定本工作流的执行区");
    expect(jobEngineLabel("emr-serverless")).toBe("EMR Serverless");
    expect(jobEngineLabel("redshift")).toBe("Redshift");
  });
});

describe("② NodeConfigForm(job / sync)服务端真渲染", () => {
  it("job:picker testid + antd Select + 「关联离线作业」+ 执行区说明;Form.Item 注入 id=jobRef 透传到控件", () => {
    const html = renderForm({ id: "j1", type: "job", data: { label: "清洗" } });
    expect(html).toContain('data-testid="job-node-picker"');
    expect(html).toMatch(/class="[^"]*ant-select[^"]*"/);
    expect(html).toContain("关联离线作业");
    expect(html).toContain("选择离线作业(只列出绑定了本工作流执行区的作业)");
    expect(html).toMatch(/data-testid="node-candidates-scope"[^>]*>候选按本工作流的执行区过滤:tgt_usw2_a</);
    expect(html).toMatch(/\bid="jobRef"/);
    expect(html).not.toContain('data-testid="node-candidates-error"');
  });
  it("候选读取失败 ⇒ 红字原话(不静默回空);引用的作业不在候选里 ⇒ 「作业不存在…」提示", () => {
    const html = renderForm({ id: "j1", type: "job", data: { label: "清洗" } }, { ...CANDS, error: "HTTP 403" });
    expect(html).toMatch(/data-testid="node-candidates-error"[^>]*>候选读取失败:HTTP 403</);
    const missing = renderForm({ id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: "01GONE00000000000000000AG" } } });
    expect(missing).toMatch(/data-testid="job-node-missing"[^>]*>作业不存在或不再绑定本工作流的执行区</);
    const present = renderForm({ id: "j1", type: "job", data: { label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" } } });
    expect(present).not.toContain('data-testid="job-node-missing"');
  });
  it("sync:下拉 testid sync-node-picker,同样带执行区说明", () => {
    const html = renderForm({ id: "s1", type: "sync", data: { label: "同步" } });
    expect(html).toContain('data-testid="sync-node-picker"');
    expect(html).toContain('data-testid="node-candidates-scope"');
    expect(html).toMatch(/\bid="syncTaskId"/);
  });
});

describe("③ 接线(源码字面)", () => {
  it("调色板自动列出 job(userPlaceable);DagEditor nodeTypes 有 job 且把 wfTargets 传给面板;详情页传 wfTargets", () => {
    expect(PALETTE_NODE_TYPES).toContain("job");
    const editor = strip(read("components/dag-editor/DagEditor.tsx"));
    expect(editor).toContain('import { JobNode } from "./JobNode";');
    expect(editor).toMatch(/job: JobNode,/);
    expect(editor).toMatch(/<NodeConfigPanel[\s\S]{0,200}wfTargets=\{wfTargets\}/);
    const page = strip(read("app/workflow/[id]/page.tsx"));
    expect(page).toMatch(/<DagEditor nodes=\{nodes\} edges=\{edges\} wfTargets=\{wfTargets\}/);
  });
  it("面板三条候选读取都带 scope=(执行范围读取守卫认它),且只用三条已有读接口", () => {
    const panel = strip(read("components/dag-editor/NodeConfigPanel.tsx"));
    expect(panel).toMatch(/fetch\(`\$\{base\}\?scope=\$\{encodeURIComponent\(tid\)\}`\)/);
    for (const api of ['"/api/sync"', '"/api/etl-jobs"', '"/api/engines/emr-serverless"']) expect(panel).toContain(`fetchScoped(${api}, targets,`);
    expect(panel, "不许再裸 fetch(\"/api/sync\")").not.toMatch(/fetch\("\/api\/sync"\)/);
  });
  it("④ jobRef ⇄ 标量编解码闭合", () => {
    expect(encodeJobRef({ kind: "etl", jobId: "a" })).toBe("etl:a");
    expect(encodeJobRef({ kind: "emr", jobId: "b" })).toBe("emr:b");
    expect(encodeJobRef({ kind: "flink", jobId: "a" })).toBeUndefined();
    expect(encodeJobRef(undefined)).toBeUndefined();
    expect(decodeJobRef("etl:01X")).toEqual({ kind: "etl", jobId: "01X" });
    expect(decodeJobRef("bogus:01X")).toBeUndefined();
    expect(decodeJobRef("etl:")).toBeUndefined();
  });
});
