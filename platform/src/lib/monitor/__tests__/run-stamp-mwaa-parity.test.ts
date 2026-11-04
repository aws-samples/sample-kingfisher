// @kf-batch 52-P52.2-W2a-run-stamp
// **MWAA 旁路**那 4 处建行点的盖章门禁 + 两侧 parity(照 `runtime-lib-lock-parity.test.ts` 的先例)。
//
// 为什么单独一个文件:这 4 处的代码在 **MWAA 里**执行,平台的写通道管不到它们
// (memory `bug-fix-dual-track-cookbook`:只改执行侧挡不住生成侧)。它们的章只能在生成时注入,
// 所以门禁必须**真的调生成器、在产物里找章**,而不是在源码里 grep 一个 `projectId` 字样。
//
// 🔴 强断言纪律:一律用一个**非默认**的真实形态 projectId 去断言 —— 若只断言"产物里有 projectId
// 这个词",那么把章写死成 `proj-default` 的实现也能全绿(P52.1 验收踩过的同款弱断言)。
import { describe, it, expect } from "vitest";
import { RUN_STAMP_ATTRS } from "@/lib/monitor/run-records";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import { generateEmrJobDag } from "@/lib/engines/emr/dag-generator";
import { generateAirflowDag } from "@/lib/workflow/dag-generator";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION, RUNTIME_LIB_FILENAME } from "@/lib/workflow/runtime-lib";
import type { EtlJob } from "@/types/etl-job";
import type { Workflow } from "@/types/workflow";
import type { EmrEngineJob } from "@/lib/engines/emr/types";

const PID = "proj-01M1KP594D2E6DJQC8EZ8CRAES"; // 真环境形态(大写 ULID),刻意不是 proj-default

/**
 * 取出生成的 Python 里 run 记录那个字典的邻域(只在**它附近**找章,不在整份文件里找)。
 *
 * ⚠️ 窗口必须**双向**:两种写法都存在 —— `put_item(Item={ … })` 把字典写在表名之后,
 * 而 legacy / runtime-lib 是先 `item = { … }` 再 `put_item(Item=item)`,字典在表名**之前**。
 * (第一版只往后取,于是把两处判红,是测试工具的 bug 不是产品的。)
 */
function taskRunsPutBody(py: string): string {
  const at = py.indexOf("bgp-task-runs");
  expect(at, "生成的 DAG 里没有 bgp-task-runs 的写入 —— 建行点丢了").toBeGreaterThan(-1);
  const body = py.slice(Math.max(0, at - 1500), at + 1200);
  // 锚点:窗口里必须有 run 记录的键,证明我们看的确实是那个字典(而不是隔壁某段代码)
  expect(body, "窗口里没有 taskId ⇒ 取到的不是 run 记录字典").toContain('"taskId"');
  return body;
}

describe("🔴 三个模板式生成器:产物里真的带章(值 = 作业/工作流行上的 projectId)", () => {
  it("ETL 作业 DAG", () => {
    const job = {
      userId: "u", jobId: "j1", name: "n", projectId: PID, type: "glue",
      script: "print(1)", cronExpression: "0 1 * * *", createdAt: "", updatedAt: "",
    } as unknown as EtlJob;
    const py = generateEtlJobDag(job);
    const body = taskRunsPutBody(py);
    expect(body).toContain(`"projectId": "${PID}"`);
    expect(body).toContain('"targetId": "tgt_home"');
  });

  it("EMR 引擎作业 DAG", () => {
    const job = {
      userId: "u", jobId: "j2", engine: "emr-serverless", name: "n", projectId: PID,
      env: "dev", script: "print(1)", status: "ready", createdBy: "u",
    } as unknown as EmrEngineJob;
    const py = generateEmrJobDag(job, {
      entryPoint: "s3://b/k.py", sparkSubmitParameters: "--conf a=b",
      executionRoleArn: "arn:aws:iam::123456789012:role/r", applicationId: "app1",
      logUri: "s3://b/logs/", entryPointArguments: [],
    });
    const body = taskRunsPutBody(py);
    expect(body).toContain(`"projectId": "${PID}"`);
    expect(body).toContain('"targetId": "tgt_home"');
  });

  it("workflow legacy DAG(现网默认引擎 —— 冻结文件的破例点)", () => {
    const wf = {
      userId: "u", workflowId: "w1", name: "n", description: "", projectId: PID,
      dagDefinition: { nodes: [{ id: "n1", type: "sql", data: { sql: "SELECT 1" } }], edges: [] },
      scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "",
    } as unknown as Workflow;
    const py = generateAirflowDag(wf);
    const body = taskRunsPutBody(py);
    expect(body).toContain(`"projectId": "${PID}"`);
    expect(body).toContain('"targetId": "tgt_home"');
  });

  it("存量资源(行上没有 projectId)⇒ 落默认工作区,而不是生成一个缺章的 DAG", () => {
    const job = { userId: "u", jobId: "j3", name: "n", type: "glue", script: "x" } as unknown as EtlJob;
    expect(taskRunsPutBody(generateEtlJobDag(job))).toContain('"projectId": "proj-default"');
  });
});

describe("🔴 runtime-lib(v2 引擎):章走 JSON spec,不做字符串注入", () => {
  const wf = {
    userId: "u", workflowId: "w2", name: "n", description: "", projectId: PID,
    dagDefinition: { nodes: [{ id: "n1", type: "empty", data: {} }], edges: [] },
    scheduleEnabled: false, status: "draft", createdAt: "", updatedAt: "",
  } as unknown as Workflow;

  it("spec 携带 project_id / target_id(与 TS 写通道同一个派生函数)", () => {
    const spec = buildDagSpec(wf);
    expect(spec.project_id).toBe(PID);
    expect(spec.target_id).toBe("tgt_home");
  });

  it("库把 spec 的章读进 env,并写进 run 记录", () => {
    // 这一处**无法执行**(Python 在 MWAA 里跑)⇒ 只能做文本断言,但断的是两条具体语句而非某个词。
    expect(RUNTIME_LIB_SOURCE).toContain('"project_id": spec.get("project_id")');
    expect(RUNTIME_LIB_SOURCE).toContain('"target_id": spec.get("target_id")');
    expect(RUNTIME_LIB_SOURCE).toContain('"projectId": env["project_id"], "targetId": env["target_id"]');
  });

  it("🔴 改库必升版本(否则 MWAA 的 Python 模块缓存会让新旧混跑)", () => {
    expect(RUNTIME_LIB_VERSION).toBeGreaterThanOrEqual(3);
    expect(RUNTIME_LIB_FILENAME).toBe(`bgp_workflow_runtime_v${RUNTIME_LIB_VERSION}.py`);
  });
});

describe("🔴 parity:Python 侧用的属性名必须与 TS 侧同源", () => {
  it("4 处旁路产物里的属性名都取自 RUN_STAMP_ATTRS(改一侧漏另一侧即红)", () => {
    const job = { userId: "u", jobId: "j1", name: "n", projectId: PID, type: "glue", script: "x" } as unknown as EtlJob;
    const wf = {
      userId: "u", workflowId: "w1", name: "n", description: "", projectId: PID,
      dagDefinition: { nodes: [], edges: [] }, scheduleEnabled: false, status: "draft",
    } as unknown as Workflow;
    const emr = {
      userId: "u", jobId: "j2", engine: "emr-serverless", name: "n", projectId: PID,
      env: "dev", script: "x", status: "ready", createdBy: "u",
    } as unknown as EmrEngineJob;
    const bodies = [
      taskRunsPutBody(generateEtlJobDag(job)),
      taskRunsPutBody(generateAirflowDag(wf)),
      taskRunsPutBody(
        generateEmrJobDag(emr, {
          entryPoint: "s3://b/k.py", sparkSubmitParameters: "", executionRoleArn: "arn:aws:iam::123456789012:role/r",
          applicationId: "a", logUri: "s3://b/", entryPointArguments: [],
        })
      ),
      // @kf-batch 50-WP26-sync-schedule-carrier
      // 🔴 锚点从**源码字面量** `"taskId": env["workflow_id"]` 换成**函数名** `_update_run_record`:
      //   WP-26 把「台账归属」做成参数(`env.get("ledger_task_id") or env["workflow_id"]`)之后,
      //   那个字面量消失 ⇒ `indexOf` 回 -1 ⇒ `slice(-1)` 几乎切成空串 ⇒ 这条判据**假红**
      //   (而且是「看起来像少了属性」这种指不到根因的假红)。
      //   判据要钉**事实**(那段回写里有没有这几个属性名),不是钉某一行长什么样
      //   —— 记忆 criteria-pin-facts-not-shapes,今天第三次现形。
      RUNTIME_LIB_SOURCE.slice(RUNTIME_LIB_SOURCE.indexOf("def _update_run_record")),
    ];
    for (const [i, body] of bodies.entries()) {
      for (const attr of RUN_STAMP_ATTRS) {
        expect(body, `旁路 #${i} 少了属性 ${attr}`).toContain(`"${attr}"`);
      }
    }
  });
});
