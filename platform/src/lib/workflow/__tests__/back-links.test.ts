// 序 73 模块 57(57 DESIGN R3 / R8 ③)—— 「双写回链」两个方向在页面上的判据:
//   ① 地址唯一作者(back-links.ts):运行行 → `/workflow/<id>?run=<runId 编码>`;节点 → `/etl-jobs?jobId=&tab=runs` / `/sync/<taskId>`;
//      节点详情行(task_id)↔ 定义节点用生成器那一份 buildIdMap(碰撞后缀也对得上);
//   ② 运行历史「触发」格(RunTriggerCell,三处共用)服务端真渲染:工作流触发行 ⇒ Next <Link> + testid run-trigger-workflow + 「由工作流「X」触发」,
//      老行没名字 ⇒ 显示 workflowId;非工作流行 ⇒ 原值 + 调度器 tag 照旧;
//   ③ 工作流名字从发布产物一路到运行期:DagSpec.workflow_name → runEnvOf → YAML env → _mk 读 → _record / _sync_node_record 写 workflowName(接缝逐层钉);
//   ④ 页面接线(源码字面):离线计算页 / EMR 面板 / 同步详情页三处「触发」格都走 RunTriggerCell;离线计算页在 effect 里读 ?jobId / ?tab 选作业切页签(首帧不读);
//      工作流页在 effect 里读 ?run 开节点详情(只开一次);节点详情行按 backLink 渲 node-job-run-link;节点状态接口两条分支都挂 backLink;
//   ⑤ jobMissing 不落库:stripTransientNodeData 只剥 jobMissing、其余逐字节不动;PUT 路由落库前经它(路由级判据见 app/api/workflow/__tests__/put-strips-transient-node-data.test.ts)。
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import I18nProvider from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/messages/en";
import { RunTriggerCell } from "@/components/monitor/RunTriggerCell";
import { workflowRunHref, nodeBackLinkOf, nodeBackLinkHref, isEtlJobsTab, ETL_JOBS_TABS } from "@/lib/workflow/back-links";
import { nodeBackLinksByTaskId, withNodeBackLinks } from "@/lib/workflow/run-node-back-links";
import { stripTransientNodeData, TRANSIENT_NODE_DATA_KEYS } from "@/lib/workflow/node-data-transient";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { runEnvOf, buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";
import { NODE_EXEC_PY } from "@/lib/workflow/node-exec-py";
import type { Workflow } from "@/types/workflow";

const h = React.createElement;
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
const USW2 = "tgt_usw2_a";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const RUN_ID = "ex_abc#tgt_usw2_a";

describe("① 地址唯一作者", () => {
  it("运行行 → 工作流实例:runId 的 # 必须编码;没有 runId 只到工作流页;没有 workflowId ⇒ null", () => {
    expect(workflowRunHref({ workflowId: "wf1", workflowRunId: RUN_ID })).toBe("/workflow/wf1?run=ex_abc%23tgt_usw2_a");
    expect(workflowRunHref({ workflowId: "wf1" })).toBe("/workflow/wf1");
    expect(workflowRunHref({ workflowRunId: RUN_ID })).toBeNull();
    expect(workflowRunHref({ workflowId: " " })).toBeNull();
  });
  it("节点 → 作业 / 同步任务:ETL 与 EMR 都进离线计算页(?jobId=&tab=runs),同步进详情页;不是作业 / 同步节点或引用缺失 ⇒ null;页签参数闭合", () => {
    expect(nodeBackLinkOf({ id: "j1", type: "job", data: { jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" } } })).toEqual({ nodeId: "j1", nodeType: "job", kind: "etl", jobId: "01JOBGLUE000000000000000AB" });
    expect(nodeBackLinkHref(nodeBackLinkOf({ id: "j1", type: "job", data: { jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" } } }))).toBe("/etl-jobs?jobId=01JOBGLUE000000000000000AB&tab=runs");
    expect(nodeBackLinkHref(nodeBackLinkOf({ id: "j2", type: "job", data: { jobRef: { kind: "emr", jobId: "01JOBEMR0000000000000000AD" } } }))).toBe("/etl-jobs?jobId=01JOBEMR0000000000000000AD&tab=runs");
    expect(nodeBackLinkHref(nodeBackLinkOf({ id: "s1", type: "sync", data: { syncTaskId: "01SYNC000000000000000000AE" } }))).toBe("/sync/01SYNC000000000000000000AE");
    expect(nodeBackLinkOf({ id: "j3", type: "job", data: { jobRef: { kind: "flink", jobId: "x" } } })).toBeNull();
    expect(nodeBackLinkOf({ id: "s2", type: "sync", data: {} })).toBeNull();
    expect(nodeBackLinkOf({ id: "q", type: "sql", data: { sql: "SELECT 1" } })).toBeNull();
    expect(nodeBackLinkHref(null)).toBeNull();
    expect(ETL_JOBS_TABS).toEqual(["edit", "runs", "rungroups"]);
    expect(isEtlJobsTab("runs")).toBe(true);
    expect(isEtlJobsTab("bogus")).toBe(false);
  });
  it("节点详情行(task_id)↔ 定义节点:用生成器那一份 buildIdMap —— 两个节点归一后同名(a-b / a.b)时第二个带 _2 后缀也对得上;没有回链的行 backLink 恒为 null", () => {
    const def = {
      nodes: [
        { id: "a-b", type: "job", data: { jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" } } },
        { id: "a.b", type: "sync", data: { syncTaskId: "01SYNC000000000000000000AE" } },
        { id: "q", type: "sql", data: { sql: "SELECT 1" } },
      ],
      edges: [],
    };
    const links = nodeBackLinksByTaskId(def);
    expect(Object.keys(links).sort()).toEqual(["a_b", "a_b_2"]);
    expect(links.a_b).toEqual({ nodeId: "a-b", nodeType: "job", kind: "etl", jobId: "01JOBGLUE000000000000000AB" });
    expect(links.a_b_2).toEqual({ nodeId: "a.b", nodeType: "sync", syncTaskId: "01SYNC000000000000000000AE" });
    const rows = withNodeBackLinks([{ taskId: "a_b", state: "success" }, { taskId: "a_b_2", state: "failed" }, { taskId: "q", state: "success" }, { taskId: "__start", state: "success" }], def);
    expect(rows.map((r) => r.backLink)).toEqual([links.a_b, links.a_b_2, null, null]);
    expect(rows[0]).toMatchObject({ taskId: "a_b", state: "success" });
    expect(nodeBackLinksByTaskId(null)).toEqual({});
  });
});

function cell(run: Record<string, unknown>): string {
  return renderToStaticMarkup(h(I18nProvider, null, h(RunTriggerCell, { run })));
}

describe("② 运行历史「触发」格(RunTriggerCell)服务端真渲染", () => {
  it("工作流触发的行 ⇒ <a data-testid=run-trigger-workflow href=/workflow/<id>?run=<编码 runId>>由工作流「链」触发</a> + 调度器 tag", () => {
    const html = cell({ triggeredBy: "workflow", scheduler: "serverless", workflowId: "wf1", workflowRunId: RUN_ID, workflowName: "链" });
    // 属性顺序不钉(Next <Link> 把 data-testid 排在 href 前);钉三件事实:是 <a>、href 是编码后的回链、文案与 testid
    expect(html).toMatch(/<a(?=[^>]*href="\/workflow\/wf1\?run=ex_abc%23tgt_usw2_a")(?=[^>]*data-testid="run-trigger-workflow")[^>]*>由工作流「链」触发<\/a>/);
    expect(html).toMatch(/data-testid="run-scheduler-tag"[^>]*>Serverless</);
    expect(html).not.toContain(">workflow<");
  });
  it("老行没有 workflowName ⇒ 显示 workflowId(不编名字);没有 workflowRunId ⇒ 链接只到工作流页", () => {
    const html = cell({ triggeredBy: "workflow", scheduler: "mwaa", workflowId: "wf1" });
    expect(html).toMatch(/<a(?=[^>]*href="\/workflow\/wf1")(?=[^>]*data-testid="run-trigger-workflow")[^>]*>由工作流「wf1」触发</);
    expect(html).toMatch(/data-testid="run-scheduler-tag"[^>]*>MWAA</);
  });
  it("非工作流触发的行照旧:原值 + 调度器 tag;没有 scheduler 就没有 tag;triggeredBy=workflow 却没有 workflowId(坏行)⇒ 不给链接、照显原值", () => {
    const manual = cell({ triggeredBy: "manual" });
    expect(manual).toContain("<span>manual</span>");
    expect(manual).not.toContain("run-trigger-workflow");
    expect(manual).not.toContain("run-scheduler-tag");
    const sched = cell({ triggeredBy: "schedule", scheduler: "serverless" });
    expect(sched).toContain("<span>schedule</span>");
    expect(sched).toMatch(/data-testid="run-scheduler-tag"[^>]*>Serverless</);
    const broken = cell({ triggeredBy: "workflow", scheduler: "serverless" });
    expect(broken).toContain("<span>workflow</span>");
    expect(broken).not.toContain("run-trigger-workflow");
  });
  it("英文词典有这三条(英文模式不回落中文)", () => {
    expect(EN["由工作流「{name}」触发"]).toBe('Triggered by workflow "{name}"');
    expect(EN["作业运行历史"]).toBeTruthy();
    expect(EN["同步运行历史"]).toBeTruthy();
  });
});

describe("③ 工作流名字从发布产物一路到运行期(接缝逐层钉)", () => {
  const WF = {
    userId: "default-user", workflowId: "wf1", name: "链", description: "", projectId: PROJ, targets: [USW2], airflowDagId: "bgp_wf1",
    dagDefinition: { nodes: [{ id: "q", type: "sql", data: { sql: "SELECT 1" } }], edges: [] }, scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "",
  } as unknown as Workflow;
  const PLACE = { targetId: USW2, execRegion: "us-west-2", workgroup: "wg", database: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:x-AbC" };
  it("DagSpec.workflow_name = workflow.name(没有名字 ⇒ null);runEnvOf 白名单带它;YAML env 里真有这个键", () => {
    const spec = buildDagSpec(WF, PLACE);
    expect(spec.workflow_name).toBe("链");
    expect(buildDagSpec({ ...WF, name: "" } as Workflow, PLACE).workflow_name).toBeNull();
    const env = runEnvOf(spec);
    expect(env.workflow_name).toBe("链");
    const yaml = buildWorkflowTasksYaml({ spec, cron: null });
    expect(yaml).toContain('"workflow_name": "链"');
    // 与 ledger_* 同一教训:白名单没列就到不了运行期 —— 源码字面钉住 runEnvOf 真从 spec 带
    const ye = strip(read("lib/scheduler/serverless/workflow-yaml.ts"));
    expect(ye).toMatch(/workflow_name:\s*spec\.workflow_name \?\? null/);
  });
  it("运行期 _mk 读 workflow_name;_exec_job / _sync_node_record 经同一个作者 _put_workflow_name 写 workflowName(真跑判据在 job-node-exec.test ②⑤)", () => {
    expect(NODE_EXEC_PY).toContain('"workflow_name": str(spec.get("workflow_name") or ""),');
    expect(NODE_EXEC_PY.split("def _put_workflow_name(").length - 1).toBe(1);
    expect(NODE_EXEC_PY.split("_put_workflow_name(env, ").length - 1).toBe(3); // 定义里的 item + _sync_node_record 的 item + _exec_job 的 extra
    expect(NODE_EXEC_PY).toMatch(/_put_workflow_name\(env, item\)/);
    expect(NODE_EXEC_PY).toMatch(/_put_workflow_name\(env, extra\)/);
  });
});

describe("④ 页面接线(源码字面)", () => {
  it("三处运行历史的「触发」格都走 RunTriggerCell(不许再各写一份 <span>{v}</span> + tag)", () => {
    for (const f of ["app/etl-jobs/page.tsx", "components/engines/EmrJobPanel.tsx", "app/sync/[id]/page.tsx"]) {
      const src = strip(read(f));
      expect(src, f).toContain('import RunTriggerCell from "@/components/monitor/RunTriggerCell";');
      expect(src, f).toMatch(/title: t\("触发"\), dataIndex: "triggeredBy", width: 200, render: \(_v?: (?:string|any), r: any\) => <RunTriggerCell run=\{r\} \/>/);
      expect(src, f).not.toMatch(/<span>\{v\}<\/span>\s*\{r\.scheduler \? <Tag data-testid="run-scheduler-tag"/);
    }
  });
  it("离线计算页:挂载后的 effect 里读 ?jobId / ?tab(首帧不读 window),列表到了才选中(ETL → selectJob / EMR → selectEmrJob)并切页签;ETL Tabs 与 EMR 面板共用 jobTab", () => {
    const src = strip(read("app/etl-jobs/page.tsx"));
    expect(src).toContain('import { useSearchParams } from "next/navigation";');
    expect(src).toContain("const searchParams = useSearchParams();");
    expect(src).toMatch(/useEffect\(\(\) => \{\s*const wantJob = searchParams\?\.get\("jobId"\) \|\| "";\s*const wantTab = searchParams\?\.get\("tab"\) \|\| "";/);
    expect(src).toContain("if (etl) selectJob(etl); else if (emr) selectEmrJob(emr);");
    expect(src).toContain("if (isEtlJobsTab(wantTab)) setJobTab(wantTab);");
    expect(src).toMatch(/\}, \[jobs, emrJobs, searchParams\]\);/);
    expect(src).toMatch(/<Tabs activeKey=\{jobTab\} onChange=\{\(k\) => \{ if \(isEtlJobsTab\(k\)\) setJobTab\(k\); \}\} items=\{\[/);
    expect(src).toMatch(/<EmrJobPanel[\s\S]{0,300}activeTab=\{jobTab\}\s*onTabChange=\{setJobTab\}/);
    expect(src, "首帧不许读浏览器状态决定页签").not.toMatch(/useState[^\n]*window\.location/);
    const panel = strip(read("components/engines/EmrJobPanel.tsx"));
    expect(panel).toMatch(/<Tabs activeKey=\{tab\} onChange=\{setTab\} items=\{\[/);
    expect(panel).toContain("const tab = activeTab ?? ownTab;");
  });
  it("工作流页:挂载后的 effect 里读 ?run,运行列表到过一次才切到运行历史并 viewNodes(只开一次);节点详情行按 backLink 渲 node-job-run-link", () => {
    const src = strip(read("app/workflow/[id]/page.tsx"));
    expect(src).toContain('import { useParams, useRouter, useSearchParams } from "next/navigation";');
    expect(src).toMatch(/const want = searchParams\?\.get\("run"\) \|\| "";\s*if \(!want \|\| !runsLoaded \|\| openedRunFromQueryRef\.current === want\) return;\s*openedRunFromQueryRef\.current = want;\s*setActiveTab\("runs"\);\s*viewNodes\(want\);/);
    expect(src).toMatch(/\} finally \{\s*setRunsLoaded\(true\);\s*\}/);
    expect(src).toMatch(/const href = nodeBackLinkHref\(r\.backLink\);\s*return href \? <Link href=\{href\} data-testid="node-job-run-link"[^>]*>\{r\.backLink\?\.nodeType === "sync" \? t\("同步运行历史"\) : t\("作业运行历史"\)\}<\/Link> : null;/);
  });
  it("节点状态接口:serverless 与经典两条分支都把 backLink 挂到行上(withNodeBackLinks 唯一作者,读的是工作流行的 dagDefinition)", () => {
    const src = strip(read("app/api/workflow/[id]/runs/[runId]/nodes/route.ts"));
    expect(src).toContain('import { withNodeBackLinks } from "@/lib/workflow/run-node-back-links";');
    expect(src.split("withNodeBackLinks(").length - 1).toBe(2);
    expect(src).toMatch(/nodes: withNodeBackLinks\(r\.nodes, \(wf as [^)]*\)\?\.dagDefinition\), scheduler: "serverless"/);
  });
});

describe("⑤ jobMissing 不落库(编辑期派生字段的闭合清单 + 剥离作者)", () => {
  it("只剥 jobMissing;jobRef / label / jobName 等逐字节保留;没有要剥的 ⇒ 返回同一个对象;null / 非数组安全", () => {
    expect(TRANSIENT_NODE_DATA_KEYS).toEqual(["jobMissing"]);
    const def = {
      nodes: [
        { id: "j1", type: "job", position: { x: 1, y: 2 }, data: { label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" }, jobName: "每日清洗", jobEngine: "glue", jobMissing: true } },
        { id: "q", type: "sql", data: { sql: "SELECT 1" } },
      ],
      edges: [{ source: "q", target: "j1" }],
    };
    const out = stripTransientNodeData(def);
    expect(out.nodes[0]).toEqual({ id: "j1", type: "job", position: { x: 1, y: 2 }, data: { label: "清洗", jobRef: { kind: "etl", jobId: "01JOBGLUE000000000000000AB" }, jobName: "每日清洗", jobEngine: "glue" } });
    expect("jobMissing" in (out.nodes[0] as { data: Record<string, unknown> }).data).toBe(false);
    expect(out.nodes[1]).toBe(def.nodes[1]);
    expect(out.edges).toBe(def.edges);
    // 输入不被改(落库前的剥离不许把画布上的对象改掉)
    expect((def.nodes[0] as { data: Record<string, unknown> }).data.jobMissing).toBe(true);
    const clean = { nodes: [{ id: "q", type: "sql", data: { sql: "SELECT 1" } }], edges: [] };
    expect(stripTransientNodeData(clean)).toBe(clean);
    expect(stripTransientNodeData(null)).toBeNull();
    expect(stripTransientNodeData({ nodes: undefined } as never)).toEqual({ nodes: undefined });
  });
  it("PUT /api/workflow/[id] 落库前经 stripTransientNodeData(单一作者;面板仍可在编辑期写 jobMissing 给画布显示)", () => {
    const route = strip(read("app/api/workflow/[id]/route.ts"));
    expect(route).toContain('import { stripTransientNodeData } from "@/lib/workflow/node-data-transient";');
    expect(route).toContain("if (body.dagDefinition !== undefined) body.dagDefinition = stripTransientNodeData(body.dagDefinition);");
    expect(route.indexOf("stripTransientNodeData(body.dagDefinition)")).toBeLessThan(route.indexOf("const fields = Object.keys(body);"));
  });
});
