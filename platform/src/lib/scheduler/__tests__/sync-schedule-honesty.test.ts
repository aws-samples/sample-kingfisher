// (前身 50-sync-schedule-honesty)
// 🔴🔴 **同步任务的「启用调度」从「空壳 + 诚实」变成「真有载体」** —— 这组判据跟着往前走一格。
//
// 【它原来钉什么】2026-09-19 无头验收抓到:在调度配置页给 `Showcase-home-GameSync-7tables` 配
//   `*/10 * * * *` + 打开「启用」,页面报「调度已启用 (EventBridge Scheduler)」、行上打「自动调度」绿标
//   —— 然后**等了 25 分钟一次都没跑**。真值:`bgp-sync-tasks` 里两个字段写了,而 `airflowDagId` 空、
//   两个 region 的 EventBridge Scheduler **各 0 条**、MWAA Serverless 里没有 sync 的 DAG。
//   ⇒ 当时先修**诚实**:接口回 `carrier: "none"` + 人话,页面报警不报喜、绿标改橙色「定时未交付」。
//   那一版判据的最后一条刻意写成「**载体真交付时这条会红**」—— 它现在红了,所以这组判据整体改写。
//
// 【现在钉什么(交付之后)】用户 2026-09-20:「我们后面所有的调度都走 mwaa serverless,
//   而且日志要拿得到,在任务监控里面要能看到日志。」
//   ① 载体真的是**单节点 sync 工作流 + MWAA Serverless**(不是又长出一条平行机制);
//   ② **先办载体、再改记录**:发布失败不许把 `enabled` 写进库(否则又是一个空壳);
//      停用时**撤不下来就不许动记录**(铁律:孤儿 workflow 会继续按 cron 跑);
//   ③ 台账归属:run 记录记在**这个同步任务**头上(`taskType="sync"`),且**不回写 `bgp-workflows`**
//      —— 那张表里没有它的行,盲写会 upsert 出幽灵工作流(与 schedule/enable 已修过的那条同类);
//   ④ 界面的绿标只给**真有产物**的那一行(看 `deployments` 里的 workflowArn,**不看** `scheduleEnabled`
//      这个愿望字段)—— 否则存量「enabled 但从没发过载体」的行又会显示成「自动调度」,同一句谎话回来。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyncCarrierWorkflow, syncCarrierDagId, carrierPrereqReason } from "@/lib/sync/schedule-carrier";
import { syncTaskCarrierLedger, workflowCarrierLedger } from "@/lib/scheduler/carrier-ledger";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** 🔴 负向文本判据前**必须剥注释**:否则「注释里解释了那句假话」会被当成「那句假话还在」。
 *  (本文件第一版就这么假红了一次 —— 我在 route.ts 的注释里引用了那句旧文案。) */
/**
 * 🔴🔴 **接线类判据必须查「在调用位置用了」,不是「文件里出现过这个名字」。**
 *   2026-09-20 一天之内栽了**三次**:把调用点换成自己编的字面量 / 换成 `null`,而 `import` 行还留着
 *   那个名字 ⇒ `toContain("foo")` 照样绿,变异溜过去。⇒ 先剥掉 import 语句,再要求它以 `foo(` 出现。
 */
function callsFn(src: string, fn: string): boolean {
  const noImports = src.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
  return new RegExp(`\\b${fn}\\s*\\(`).test(noImports);
}

function code(rel: string): string {
  return read(rel)
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

const TASK = {
  taskId: "01TESTSYNCTASK0000000000",
  name: "Showcase-home-GameSync-7tables",
  projectId: "proj-default",
  targets: ["tgt_home", "tgt_usw2_a"],
  glueJobName: "bgp-sync-ABCDEF",
};

describe("同步任务的定时调度:载体真交付", () => {
  const route = code("app/api/schedule/enable/route.ts");
  const panel = code("components/monitor/SchedulePanel.tsx");
  const carrier = read("lib/sync/schedule-carrier.ts");
  // 🔴🔴 顺序类判据必须**先锚定到它要判的那个对象**:这个路由里 workflow 与 sync 两个分支
  //   **各有一处** `UpdateExpression: "SET scheduleEnabled...`,而 workflow 那处在前 ⇒
  //   在整篇文本上比下标会拿**另一个分支**的位置来判自己,判据当场假红(我在这一文件里连栽两次:
  //   先是拿「表名第一次出现」当写记录锚点,再是拿「整篇里的 SET scheduleEnabled」)。
  //   ⇒ 先切出 sync 分支(它从第一次出现 `TABLES.SYNC_TASKS` 开始),再在里面比顺序。
  //   记忆 criteria-must-anchor-to-its-own-object,今天第 N 次。
  const syncBranch = route.slice(route.indexOf("TABLES.SYNC_TASKS"));
  const WRITE_IN_SYNC = 'UpdateExpression: "SET scheduleEnabled';

  it("① 载体 = **单节点 sync 工作流**,节点带 syncTaskId,产物名一眼可追溯", () => {
    const wf = buildSyncCarrierWorkflow(TASK, "*/10 * * * *");
    expect(wf.dagDefinition.nodes).toHaveLength(1);
    expect(wf.dagDefinition.nodes[0].type).toBe("sync");
    expect(wf.dagDefinition.nodes[0].data.syncTaskId).toBe(TASK.taskId);
    expect(wf.dagDefinition.edges).toHaveLength(0);
    expect(wf.cronExpression).toBe("*/10 * * * *");
    expect(wf.airflowDagId).toBe(syncCarrierDagId(TASK.taskId));
    expect(syncCarrierDagId(TASK.taskId)).toContain("sync_");
    // 逐区扇出要用得上 `targets`(同步任务行就是这个字段名)
    expect((wf as unknown as { targets?: string[] }).targets).toEqual(["tgt_home", "tgt_usw2_a"]);
    // 停用形态:cron 为空
    expect(buildSyncCarrierWorkflow(TASK, null).cronExpression).toBeUndefined();
  });

  it("② 台账归属:记在**同步任务**头上、`taskType=\"sync\"`、**不回写** bgp-workflows", () => {
    const l = syncTaskCarrierLedger(TASK.taskId, "bgp-sync-tasks");
    expect(l.taskType).toBe("sync");
    expect(l.taskId).toBe(TASK.taskId);
    expect(l.key).toEqual({ userId: "default-user", taskId: TASK.taskId });
    // 🔴 幽灵行那一条:合成载体在 bgp-workflows 里没有行 ⇒ 绝不许回写
    expect(l.writesWorkflowRow).toBe(false);
    // 缺省(编排自己)必须保持原样 —— 零回归
    const w = workflowCarrierLedger("w1", "bgp-workflows");
    expect(w).toEqual({
      table: "bgp-workflows",
      key: { userId: "default-user", workflowId: "w1" },
      taskType: "workflow",
      taskId: "w1",
      writesWorkflowRow: true,
    });
  });

  it("③ 运行期读归属时**带缺省**(旧 spec 没有这三个字段也照旧跑),且 workflow 行回写可关", () => {
    const exec = read("lib/workflow/node-exec-py.ts");
    expect(exec).toContain('"ledger_task_id": spec.get("ledger_task_id") or spec["workflow_id"]');
    expect(exec).toContain('"ledger_task_type": spec.get("ledger_task_type") or "workflow"');
    expect(exec).toMatch(/if not env\.get\("writes_workflow_row", True\):\s*\n\s*return/);
    // 两个运行期(编排 runtime-lib / serverless runtime)都要按归属写台账
    for (const f of ["lib/workflow/runtime-lib.ts", "lib/scheduler/serverless/runtime-py.ts"]) {
      // 🔴 两个运行期的 env 变量名不同(`env` / `e`)⇒ 判据钉**事实**(读了归属字段),不钉变量名
      expect(read(f), `${f} 的 run 台账没按归属写 ⇒ 同步任务的运行在监控页会归到工作流头上`).toMatch(
        /\.get\("ledger_task_id"\)/
      );
    }
  });

  it("③b 🔴🔴 **接缝**:归属字段必须真的进 YAML 的 env(两端都写了判据,中间那一层没有 ⇒ 真环境出事)", () => {
    // 【为什么单独一条】第一版把 `ledger_*` 加进了 `DagSpec`、也让运行期 python 去读,
    //   唯独漏了中间这一层:`runEnvOf` 是一张**白名单**,没列的字段压根到不了运行期。
    //   真环境当场坐实:同步任务的定时调度**真跑起来了**(`triggeredBy=schedule`,一条 succeeded),但
    //     ① run 台账写成 `taskType: "workflow"` ⇒ 监控页按工作流查名字、查不到 ⇒ 收弹等 1810s 说没有;
    //     ② `writes_workflow_row` 回落成 true ⇒ 往 `bgp-workflows` **真 upsert 出一条幽灵行**。
    //   ⇒ 「写了但接不上」的第 N 次;判据必须钉**每一层**,不是只钉两端。
    const ye = read("lib/scheduler/serverless/workflow-yaml.ts");
    for (const f of ["ledger_task_id", "ledger_task_type", "writes_workflow_row"]) {
      // 既要在类型里(否则编译期就漏),也要在 `runEnvOf` 的返回体里(否则运行期拿不到)
      expect(ye, `WorkflowRunEnv 少了 ${f} ⇒ 它到不了运行期`).toContain(`${f}:`);
      expect(
        new RegExp(`${f}:\\s*spec\\.`).test(ye),
        `runEnvOf 没把 ${f} 从 spec 带出来 ⇒ 运行期只能回落缺省(这正是 2026-09-20 真环境出事的那一处)`
      ).toBe(true);
    }
    // 缺省必须保留(旧 spec / 编排那条路零回归)
    expect(ye).toMatch(/ledger_task_type:\s*spec\.ledger_task_type \|\| "workflow"/);
    expect(ye).toMatch(/writes_workflow_row:\s*spec\.writes_workflow_row !== false/);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 **③c:归属的「值」必须真的从 ledger 派生出来 —— 光有字段等于没有。**
  //
  // 【为什么 ③b 没能挡住它】③b 钉的是「`runEnvOf` 白名单里有这三个字段」= **形态**;
  //   而承重的事实是「**那三个字段的值来自 `CarrierLedger`**」。2026-09-20 第三轮硬门真环境坐实
  //     · 载体真发出去了(`deployments[*].workflowArn` 在、`WorkflowStatus=READY`);
  //     · `get-workflow` 的定义里三个 `ledger_*` 字段**全都在**(所以 ③b 是绿的);
  //     · 但值是 `ledger_task_type: "workflow"` / `writes_workflow_row: true` —— **缺省值**;
  //     · 于是定时真烧了、Glue 真跑了、run 行 `succeeded`,却记成工作流 ⇒ 监控页查不到
  //       ⇒ 收弹判据等满 1811s 判红,两个区都红。
  //   根因在**第三层**:`publishWorkflowDagToTarget` 拿到了 `opts.ledger`,只喂给了
  //   `recordWorkflowDeployment`(台账归属),没喂给 `buildDagSpec`(运行期归属)。
  //   ⇒ 同一个对象两个消费点,只接了一个。判据钉每一层还不够 —— 还要钉**值的来源**。
  //
  // 【本条钉三件事,且带负向对照】
  //   ① 端到端:`syncTaskCarrierLedger` → `place` → `buildDagSpec` → YAML,
  //      YAML 文本里必须是 `sync` / `false` / 那个 taskId(**断值**,不断字段在不在);
  //   ② 负向对照:不带 ledger 的 place ⇒ 必须仍是 `workflow` / `true`(编排零回归);
  //   ③ 覆盖面做成**唯一形态**:`publish-dag.ts` 里三条生成路(serverless / v2 / legacy)
  //      的落点实参必须是**同一个** `place` 变量,且 `place` 里带 `ledger`
  //      —— 这样新增第 N+1 条生成路自动带上,不靠「记得再补一处」。
  // ══════════════════════════════════════════════════════════════════════════
  it("③c 🔴🔴 归属的**值**真从 ledger 派生进 YAML(光有字段 = 缺省值 = 真环境出事)", () => {
    const ledger = syncTaskCarrierLedger(TASK.taskId, "bgp-sync-tasks");
    const wf = buildSyncCarrierWorkflow(TASK, "*/10 * * * *");
    const place = {
      targetId: "tgt_home",
      execRegion: "us-east-1",
      workgroup: "bgp-workgroup",
      database: "dev",
      redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:1:secret:redshift!x-abc",
      ledger,
    };
    // 🔴 不 mock 兄弟模块:真走 buildDagSpec + buildWorkflowTasksYaml(mock 会把接缝抹平,
    //   而本条判据要看的恰恰是接缝上的**值**)。
    const spec = buildDagSpec(wf as unknown as Parameters<typeof buildDagSpec>[0], place);
    expect(spec.ledger_task_type, "DagSpec 的归属没从 ledger 来 ⇒ 运行期只能回落 workflow").toBe("sync");
    expect(spec.ledger_task_id).toBe(TASK.taskId);
    expect(spec.writes_workflow_row, "回写 bgp-workflows 没关掉 ⇒ 又会造幽灵工作流行").toBe(false);

    // 🔴 归属三项是**嵌在 YAML 里的 spec JSON**(不是 YAML 顶层键)⇒ 键带引号。
    //   判据刻意写成「引号可有可无」:钉的是**值**,不是它今天被序列化成什么形状
    //   (记忆 criteria-pin-facts-not-shapes:钉形态的判据一到产品演进就整片假红)。
    const yaml = buildWorkflowTasksYaml({ spec, cron: "*/10 * * * *" });
    expect(yaml, "YAML 里 ledger_task_type 不是 sync ⇒ run 行会记成工作流、监控页查不到").toMatch(
      /ledger_task_type"?:\s*"?sync/
    );
    expect(yaml).toMatch(/writes_workflow_row"?:\s*false/);
    expect(yaml).toContain(TASK.taskId);

    // 🔴🔴 **判别夹具**:上面那三条断言里 `ledger.taskId` 恰好 == `workflow.workflowId`
    //   (同步载体的 workflowId 就是 taskId)⇒ 「从 ledger 取」与「从 workflowId 取」**同果**,
    //   判据分不出来。变异实测:把生成器改成 `ledger_task_id: workflow.workflowId` 照样全绿。
    //   ⇒ 必须造一个两者**不等**的夹具,才判得出归属到底跟谁走
    //   (记忆 mutation-test-never-git-checkout:现网数据让对错两种实现同果时,判据没有判别力)。
    const distinct = buildDagSpec(
      { ...(wf as unknown as Record<string, unknown>), workflowId: "wf-NOT-the-task-id" } as unknown as Parameters<typeof buildDagSpec>[0],
      { ...place, ledger: syncTaskCarrierLedger("01OTHERTASKID00000000000", "bgp-sync-tasks") }
    );
    expect(
      distinct.ledger_task_id,
      "归属 taskId 没跟着 ledger 走(拿了 workflowId)⇒ run 行会挂到载体自己头上,同步任务页仍查不到"
    ).toBe("01OTHERTASKID00000000000");
    expect(distinct.workflow_id, "workflow_id 不该被归属覆盖(它是载体自己的身份)").toBe("wf-NOT-the-task-id");

    // ② 负向对照:不带 ledger ⇒ 必须仍是缺省(编排那条路逐字节零回归)
    const { ledger: _drop, ...placeNoLedger } = place;
    const plain = buildDagSpec(wf as unknown as Parameters<typeof buildDagSpec>[0], placeNoLedger);
    expect(plain.ledger_task_type, "不带 ledger 时缺省变了 ⇒ 编排那条路会被改坏").toBe("workflow");
    expect(plain.writes_workflow_row).toBe(true);
    expect(buildWorkflowTasksYaml({ spec: plain, cron: null })).toMatch(/writes_workflow_row"?:\s*true/);
  });

  it("③d 🔴 **落点对象是唯一形态**:三条生成路都从同一个 place 拿归属(不靠逐处补参数)", () => {
    const pub = code("lib/workflow/publish-dag.ts");
    // ① place 里必须带 ledger —— 这是「归属跟着落点走」的那一处接线
    expect(
      /const place = \{[\s\S]*?\bledger:\s*opts\.ledger\b[\s\S]*?\};/.test(pub),
      "publish-dag.ts 的 place 里没有 ledger ⇒ 生成器拿不到归属,run 行会记成工作流(2026-09-20 真环境那一处)"
    ).toBe(true);
    // ② 三条生成路的落点实参必须**就是** place 这个变量(而不是各自另拼一个对象)
    for (const call of ["buildDagSpec(wfWithDag, place)",
                        "generateAirflowDagV2(wfWithDag, place)",
                        "generateAirflowDag(wfWithDag, place)"]) {
      expect(
        pub.replace(/\s+/g, " ").includes(call),
        `生成路 ${call} 没有用同一个 place ⇒ 它这一条会漏掉归属(枚举式补参数一定漏第 N+1 条)`
      ).toBe(true);
    }
    // ③ 负向:不许再出现「只把 ledger 给台账、不给生成器」那个形态 ——
    //    即 opts.ledger 的消费点**不止** recordWorkflowDeployment 一处
    const uses = (pub.match(/opts\.ledger/g) || []).length;
    expect(uses, "opts.ledger 只被用了一次 ⇒ 十成是只接了台账那半(运行期归属又丢了)").toBeGreaterThanOrEqual(2);
  });

  it("④ 发布台账是**条件写**(行必须存在)—— 否则 taskId 打错就 upsert 出幽灵任务", () => {
    const pub = read("lib/workflow/publish-dag.ts");
    expect(pub).toContain("ConditionExpression");
    expect(pub).toMatch(/attribute_exists/);
    expect(pub, "发布台账的表/键没做成参数 ⇒ 合成载体会往 bgp-workflows 写").toContain("ledger?.table");
  });

  it("⑤ 接口:**先办载体再改记录**;启用回真 carrier;发布失败不许写 enabled", () => {
    expect(callsFn(route, "publishSyncScheduleCarrier"), "发布载体函数只被 import 了、没真调用").toBe(true);
    expect(route).toContain('carrier: enabled ? "mwaa-serverless" : "none"');
    // 顺序判据:发布/下线必须**排在** UpdateCommand 之前
    expect(syncBranch.indexOf("publishSyncScheduleCarrier")).toBeLessThan(syncBranch.indexOf(WRITE_IN_SYNC));
    // 失败路径:早返回,不落库
    expect(route).toMatch(/发布定时调度载体失败/);
    // 前置条件:没有后台作业就响亮拒(否则到点「无事可做」,错误离根因很远)
    expect(callsFn(route, "carrierPrereqReason"), "前置条件函数只被 import 了、没在判的地方调用").toBe(true);
    expect(carrierPrereqReason({ taskId: "t" })).toContain("手动运行一次");
    expect(carrierPrereqReason(TASK)).toBeNull();
  });

  it("⑥ 停用:**撤不下来就不许动记录**(孤儿 workflow 会继续按 cron 跑)", () => {
    expect(callsFn(route, "offlineSyncScheduleCarrier"), "下线载体函数只被 import 了、没真调用").toBe(true);
    expect(route).toContain("allRemoved");
    expect(syncBranch.indexOf("allRemoved")).toBeLessThan(syncBranch.indexOf(WRITE_IN_SYNC));
    expect(carrier, "下线没复用编排那条路的集合口径(绑定 ∪ 有产物的区)").toContain("unpublishWorkflowDag");
  });

  it("⑦ 界面:绿标只给**真有产物**的行(看 deployments,不看 scheduleEnabled 这个愿望字段)", () => {
    expect(panel).toContain("workflowArn");
    expect(panel).toMatch(/data-testid="schedule-armed"/);
    // 存量「enabled 但没产物」必须单列出来给出路,不许混进绿标
    expect(panel).toMatch(/data-testid="sync-schedule-not-armed"/);
    expect(panel).toContain("待发布载体");
    // 🔴 负向:那句实测为假的话不许回来(两个 region 的 EventBridge Scheduler 各 0 条)
    expect(panel).not.toContain("EventBridge Scheduler");
    expect(route).not.toContain("EventBridge Scheduler");
    // 🔴 负向:旧的「定时未交付」文案也不该再出现(载体已交付,留着就是另一种说谎)
    expect(panel).not.toContain("定时未交付");
  });

  it("⑧ 「所有调度都走 MWAA Serverless」:载体不许自己再开一条平行机制", () => {
    // 载体走的是编排那套(publishWorkflowDag → serverless publish),不是 EventBridge / 经典 MWAA
    expect(carrier).toContain("publishWorkflowDag");
    const c = code("lib/sync/schedule-carrier.ts");
    for (const bad of ["SchedulerClient", "CreateScheduleCommand", "mwaa-env", "airflow-1."]) {
      expect(c, `载体里出现了 ${bad} ⇒ 又长出一条平行调度机制`).not.toContain(bad);
    }
  });
});
