// 编排详情页两条「页面显示必须来自真结论」的接线判据(页面驱动 p43b 在 …7698 坐实)。
// 「写了」≠「接上了」:发布成功后必须同步本地 workflow 状态;Serverless 运行行不许把运行时写死的 triggeredBy=schedule 当触发来源展示。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");
const strip = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("详情页「发布」成功后页头立刻反映 active + DAG 标", () => {
  const src = strip(read("[id]/page.tsx"));
  it("doPublish 成功分支 setWorkflow(status=active, airflowDagId 取服务端返回的 dagId);失败分支仍 message.error", () => {
    const m = src.match(/const doPublish = async \(\) => \{[\s\S]*?\n  \};/);
    expect(m, "doPublish 存在").toBeTruthy();
    const body = m![0];
    expect(body).toMatch(/if \(data\.success !== false && !data\.error\) \{\s*message\.success\(t\("已发布到 Airflow"\)\);/);
    expect(body).toMatch(/setWorkflow\(\(w: any\) => \(\{ \.\.\.\(w \|\| \{\}\), status: "active", airflowDagId: data\.dagId \|\| w\?\.airflowDagId \}\)\);/);
    expect(body).toMatch(/\} else message\.error\(data\.error\?\.message \|\| data\.error \|\| t\("发布失败"\)\);/);
    expect(body).not.toMatch(/data\.success !== false \? message\.success/); // 旧的三目形态(只弹 toast 不改状态)不许回来
  });
  it("页头 Badge / DAG 标读的就是 workflow.status / workflow.airflowDagId(发布后同步的字段)", () => {
    expect(src).toMatch(/<Badge status=\{workflow\?\.status === "active" \? "success" : "default"\} text=\{workflow\?\.status\} \/>/);
    expect(src).toMatch(/\{workflow\?\.airflowDagId && <Tag color="blue">DAG: \{workflow\.airflowDagId\}<\/Tag>\}/);
  });
});

describe("运行历史「触发方式」:serverless 运行只标调度器,不宣称 schedule / manual", () => {
  const src = strip(read("[id]/page.tsx"));
  it("列渲染按 r.scheduler === serverless 分叉:Serverless 标(带 testid)/ 否则原值(缺省 manual)", () => {
    expect(src).toMatch(/title: t\("触发方式"\), dataIndex: "triggeredBy", width: 100, render: \(v: string, r: any\) => r\.scheduler === "serverless"\s*\? <Tag color="gold" data-testid="run-scheduler-tag">Serverless<\/Tag>\s*: <Tag>\{v \|\| "manual"\}<\/Tag> \}/);
    expect(src).not.toMatch(/render: \(v: string\) => <Tag>\{v \|\| "manual"\}<\/Tag> \}/); // 旧形态不许回来
  });
  it("事实来源:serverless 运行时 __start 写台账的 triggeredBy 就是写死的 schedule(改展示不改台账,与一致)", () => {
    const rt = readFileSync(resolve(HERE, "..", "..", "..", "lib", "scheduler", "serverless", "runtime-py.ts"), "utf8");
    expect((rt.match(/"triggeredBy": "schedule"/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});
