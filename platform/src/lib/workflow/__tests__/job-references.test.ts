// (R7 / §3.7 项目内)—— 删作业前核工作流引用:workflowsReferencingJob 扫 bgp-workflows(分页)按 data.jobRef.jobId 找,
// 按作业所属项目分摊:本项目逐条点名(id / name / nodeIds);其他项目只给数量(名字不出项目);两摊任一非空 ⇒ jobInUseResponse 409 JOB_IN_USE;
// 两条 DELETE 路由(ETL / EMR)都在删行之前调它(传作业行的 projectId,经 resolveRunStamp 同一口径);ApiErrorCode 闭合清单含 JOB_IN_USE;
// EMR 面板删除改经 deleteJson(409 原话给用户看)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ pages: [] as Array<{ Items: unknown[]; LastEvaluatedKey?: Record<string, unknown> }>, scans: [] as Record<string, unknown>[] }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: { send: async (cmd: { input: Record<string, unknown> }) => { h.scans.push(cmd.input); return h.pages[h.scans.length - 1] ?? { Items: [] }; } },
  };
});
const { workflowsReferencingJob, jobInUseResponse, hasJobReferences } = await import("@/lib/workflow/job-references");

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
const JOB_ID = "01JOBGLUE000000000000000AB";
const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const OTHER = "proj-OTHER0000000000000000AF";
// projectId 传 null = 存量行没有 projectId 字段(传 undefined 会落到缺省参数 PROJ,所以用 null 表示「没有」)
const wfRow = (id: string, name: string, nodes: unknown[], projectId: string | null = PROJ) => ({ workflowId: id, name, ...(projectId ? { projectId } : {}), dagDefinition: { nodes, edges: [] } });
const jobNode = (id: string, kind = "etl", jobId = JOB_ID) => ({ id, type: "job", data: { jobRef: { kind, jobId } } });

beforeEach(() => { h.pages = []; h.scans = []; });

describe("workflowsReferencingJob(jobId, projectId)", () => {
  it("分页扫全表;只认 type=job 且 jobRef.jobId 相等(sync 节点 / 别的作业 / 形态不对的引用都不算);同图多节点合成一条;**其他项目**的只计数不列名", async () => {
    h.pages = [
      { Items: [
        wfRow("wfA", "链 A", [jobNode("j1"), jobNode("j2"), { id: "s1", type: "sync", data: { syncTaskId: JOB_ID } }]),
        wfRow("wfB", "链 B", [jobNode("j1", "etl", "01OTHER00000000000000000AC")]),
      ], LastEvaluatedKey: { userId: "default-user", workflowId: "wfB" } },
      { Items: [
        wfRow("wfC", "链 C", [{ id: "x", type: "job", data: { jobRef: { kind: "bogus", jobId: JOB_ID } } }]),
        wfRow("wfD", "链 D(别的项目)", [jobNode("k", "emr")], OTHER),
        wfRow("wfE", "链 E(别的项目)", [jobNode("k2")], OTHER),
      ] },
    ];
    const refs = await workflowsReferencingJob(JOB_ID, PROJ);
    expect(refs).toEqual({
      inProject: [{ id: "wfA", name: "链 A", projectId: PROJ, nodeIds: ["j1", "j2"] }],
      otherProjectCount: 2,
    });
    expect(hasJobReferences(refs)).toBe(true);
    expect(h.scans.length).toBe(2);
    expect(h.scans[1].ExclusiveStartKey).toEqual({ userId: "default-user", workflowId: "wfB" });
    expect(h.scans[0].FilterExpression).toBe("userId = :uid");
    expect(await workflowsReferencingJob("", PROJ)).toEqual({ inProject: [], otherProjectCount: 0 });
    expect(hasJobReferences({ inProject: [], otherProjectCount: 0 })).toBe(false);
  });
  it("项目归属走 resolveRunStamp 口径:无 projectId 的工作流行与无 projectId 的作业同归默认项目 ⇒ 算本项目;作业有项目而行没有 ⇒ 算其他项目", async () => {
    h.pages = [{ Items: [wfRow("wfLegacy", "存量链", [jobNode("j1")], null), wfRow("wfP", "项目链", [jobNode("j1")], PROJ)] }];
    const legacyJob = await workflowsReferencingJob(JOB_ID, undefined);
    expect(legacyJob.inProject.map((r) => r.id)).toEqual(["wfLegacy"]);
    expect(legacyJob.otherProjectCount).toBe(1);
    h.scans = [];
    const projJob = await workflowsReferencingJob(JOB_ID, PROJ);
    expect(projJob.inProject.map((r) => r.id)).toEqual(["wfP"]);
    expect(projJob.otherProjectCount).toBe(1);
  });
  it("jobInUseResponse ⇒ 409 JOB_IN_USE:本项目原话逐条点名(原话不变)+ detail.workflows 带 id / name / nodeIds;其他项目只有「另有 N 个其他项目的工作流引用了它」与计数", async () => {
    const r = jobInUseResponse({ inProject: [{ id: "wfA", name: "链 A", nodeIds: ["j1"] }, { id: "wfD", name: "链 D", nodeIds: ["k"] }], otherProjectCount: 0 });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { success: boolean; error: { code: string; message: string; detail: { workflows: unknown[]; otherProjects: { count: number } } } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("JOB_IN_USE");
    expect(body.error.message).toBe(
      "这个作业仍被 2 个工作流的离线作业节点引用:「链 A」、「链 D」 —— 已拒绝删除。" +
        "请先在这些工作流的画布里移除该节点(或改为引用别的作业)再删;删掉会让这些工作流下次运行时在该节点失败。"
    );
    expect(body.error.detail.workflows).toEqual([{ id: "wfA", name: "链 A", nodeIds: ["j1"] }, { id: "wfD", name: "链 D", nodeIds: ["k"] }]);
    expect(body.error.detail.otherProjects).toEqual({ count: 0 });

    // 两摊都有:本项目点名 + 其他项目只计数
    const both = (await jobInUseResponse({ inProject: [{ id: "wfA", name: "链 A", nodeIds: ["j1"] }], otherProjectCount: 3 }).json()) as { error: { message: string; detail: { workflows: unknown[]; otherProjects: { count: number } } } };
    expect(both.error.message).toContain("这个作业仍被 1 个工作流的离线作业节点引用:「链 A」;另有 3 个其他项目的工作流引用了它 —— 已拒绝删除。");
    expect(both.error.detail.otherProjects).toEqual({ count: 3 });

    // 只有其他项目:不泄名字(连 detail 都没有名字),但一样 409
    const only = jobInUseResponse({ inProject: [], otherProjectCount: 2 });
    expect(only.status).toBe(409);
    const ob = (await only.json()) as { error: { code: string; message: string; detail: { workflows: unknown[]; otherProjects: { count: number } } } };
    expect(ob.error.code).toBe("JOB_IN_USE");
    expect(ob.error.message).toContain("另有 2 个其他项目的工作流引用了它");
    expect(ob.error.message).toContain("已拒绝删除");
    expect(ob.error.message).not.toContain("「");
    expect(ob.error.detail.workflows).toEqual([]);
    expect(ob.error.detail.otherProjects).toEqual({ count: 2 });
  });
});

describe("接缝:两条 DELETE 路由删前都核(传作业行的项目);词表闭合;页面把 409 原话给用户看", () => {
  it.each(["app/api/etl-jobs/[id]/route.ts", "app/api/engines/[engine]/[id]/route.ts"])("%s:workflowsReferencingJob(params.id, resolveRunStamp(Item).projectId) + hasJobReferences ⇒ jobInUseResponse 排在 DeleteCommand 之前", (f) => {
    const src = read(f);
    const iDel = src.indexOf("export async function DELETE(");
    const del = src.slice(iDel);
    const iRef = del.indexOf("const jobRefs = await workflowsReferencingJob(params.id, resolveRunStamp(Item as { projectId?: string }).projectId);");
    const iResp = del.indexOf("if (hasJobReferences(jobRefs)) return jobInUseResponse(jobRefs);");
    const iDelete = del.indexOf("new DeleteCommand(");
    expect(iRef).toBeGreaterThan(-1);
    expect(iResp).toBeGreaterThan(iRef);
    expect(iDelete).toBeGreaterThan(iResp);
    // 删前核也要排在「撤调度产物」之前(被引用就一个字节都不动)
    expect(del.indexOf("offline")).toBeGreaterThan(iResp);
  });
  it("ApiErrorCode 含 JOB_IN_USE;EmrJobPanel 删除经 deleteJson 并呈现服务端原话", () => {
    expect(read("lib/api-response.ts")).toMatch(/\|\s*"JOB_IN_USE"/);
    const panel = read("components/engines/EmrJobPanel.tsx");
    expect(panel).toContain('import { deleteJson } from "@/lib/http/delete-json";');
    expect(panel).toMatch(/await deleteJson\(`\/api\/engines\/\$\{ENGINE\}\/\$\{job\.jobId\}`\)/);
    expect(panel).toMatch(/catch \(e\) \{(?:\s*\/\/[^\n]*\n)*\s*message\.error\(\(e as Error\)\.message/);
  });
});
