// 步 4 的结构性判据(ACCEPTANCE v1.43 段 `slsw`:SW-3 / SW-9 / N-3 的发布期一半;真跑那一半在段里)。
//
// 🔴 这一批判据的母题是本仓反复出现的那个元 bug:**机制早就建好,只是那条路径没接**。
// 本步一次抓到三处同族:① 多节点编排遇 serverless 直接抛(前提已被真跑证伪);
// ② `unpublish` 路由调 `offlineDag(dagId)` **不传 target ⇒ 恒打主控区**(别区的 DAG 照跑);
// ③ `schedule/enable` 解挂写的是 `homeMwaaEndpoint()` ⇒ 页面显示「已开启」而那个区的 DAG 永远 paused。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向文本断言前必先剥注释(否则会被「解释为什么不能这么写」的注释命中 ⇒ 假红)。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

describe("SW-3 发布:serverless 分支真的接上了", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("🔴 端点解析排在**引擎能力门之前**(反了会让现网 flag=legacy 把带 branch 的图挡在 serverless 之外)", () => {
    const iEp = pub.indexOf("schedulerEndpointFor(wfTarget)");
    const iCap = pub.indexOf("checkEngineCapability(");
    expect(iEp).toBeGreaterThan(0);
    expect(iCap).toBeGreaterThan(0);
    expect(iEp, "能力门排在端点解析之前 ⇒ serverless 也被 legacy 引擎的能力门挡住").toBeLessThan(iCap);
  });

  it("🔴 落点解析仍排在生成之前(scq A2-1 的教训不许回退),serverless 与经典两条路都是", () => {
    const iBind = pub.indexOf("resolveRedshiftBinding(");
    for (const gen of ["buildWorkflowTasksYaml({", "generateAirflowDag(wfWithDag", "generateAirflowDagV2(wfWithDag"]) {
      const i = pub.indexOf(gen);
      expect(i, `找不到生成调用 ${gen}`).toBeGreaterThan(0);
      expect(iBind, `${gen} 排在落点解析之前 ⇒ 生成器拿不到落点`).toBeLessThan(i);
    }
  });

  it("serverless 分支:预建 YAML + 有 cron 才 scheduled + ARN 台账优先/服务兜底 + 写 deployments", () => {
    expect(pub).toContain("definitionYaml: yaml");
    expect(pub).toMatch(/triggerMode:\s*cron\s*\?\s*"scheduled"\s*:\s*"manual_only"/);
    // 🔴 变异抓到的判据洞:这个模式在 publish 与 unpublish **各有一处**,只断「存在」时,
    //   把其中一处退回「只看台账」也会绿。改成**逐个函数切片**断。
    // 🔴 切片锚点必须是**代码**:这里读的是剥过注释的源,拿注释当锚点会 indexOf === -1 ⇒
    //   `slice(x, -1)` 悄悄把整份源都切进来,判据又变成「只要别处有就算过」(第二次踩同一个坑)。
    //
    // 🔴🔴 **改判(第三次踩同一个坑,这次终于按意图写)**:
    //   上一版写的是「整篇 `indexOf('if (isServerlessEndpoint(ep)) {')`」。把产物生成抽成
    //   唯一作者 `buildCarrierArtifact` 之后,**同样的锚点在两个函数里都有**
    //   ⇒ 整篇 indexOf 命中的是**生成函数**里那一个 ⇒ 切片里当然没有 ARN 兜底 ⇒ 判据红在
    //   一次完全正确的重构上。注释里早写着「改成**逐个函数切片**断」,而实现从来没做到。
    // ⇒ 现在**先切出 `publishWorkflowDagToTarget` 的函数体**,再在它里面找分支
    //   —— 判据必须锚定到**它要判的那个对象**(本仓纪律)。
    const iFn = pub.indexOf("export async function publishWorkflowDagToTarget(");
    expect(iFn, "找不到发布函数 ⇒ 判据在空转(改名了?)").toBeGreaterThan(0);
    const fnBody = pub.slice(iFn, pub.indexOf("\nexport ", iFn + 10) + 1 || undefined);
    const iSls = fnBody.indexOf("if (isServerlessEndpoint(ep)) {");
    expect(iSls, "发布函数里找不到 serverless 分支").toBeGreaterThan(-1);
    const iClassic = fnBody.indexOf("const engine = art.engine!");
    expect(iClassic, "发布函数里找不到经典分支的锚点").toBeGreaterThan(iSls);
    const pubBranch = fnBody.slice(iSls, iClassic);
    expect(pubBranch, "发布侧 ARN 没有「台账没有就问服务」的兜底").toMatch(/known\s*\|\|\s*\(await findWorkflowArnByName\(ep\.region, dagId\)\)/);
    expect(pub).toContain("recordWorkflowDeployment(");
  });

  it("🔴 那个「多节点编排只支持经典 MWAA」的抛错分支必须**删干净**(留着 = 下一个人以为还不支持)", () => {
    expect(pub).not.toContain("WorkflowSchedulerUnsupported");
    expect(strip(read("app/api/workflow/[id]/publish/route.ts"))).not.toContain("WorkflowSchedulerUnsupported");
  });

  // 判据从「形态」改判到「事实」:
  //   承重的是**「external 节点发布 ⇒ 400」**,不是「路由源码里出现 ServerlessNodeUnsupported」。
  //   这条判定 2026-09-16 收进了单一作者 `schedulerRejectResponse`(扇出会把拒因包一层,
  //   路由各写一遍的 instanceof 全落空 ⇒ 真环境回了 500)。钉形态的写法在那次演进里假红。
  it("N-3 external 节点 ⇒ **400**(不是 409:补装什么都没用,要改图),且路由接的是那个单一作者", async () => {
    const { schedulerRejectResponse } = await import("@/lib/scheduler/fanout-reject");
    const { ServerlessNodeUnsupported } = await import("@/lib/scheduler/serverless/workflow-yaml");
    // 事实层:真拿一个 external 拒因过分派器
    const r = schedulerRejectResponse(new ServerlessNodeUnsupported(["external"]));
    expect(r?.status, "external 节点必须 400(409 = 「去补装」,而补什么都没用)").toBe(400);
    const body = (await r!.json()) as { error?: { code?: string; nodeTypes?: string[] } };
    expect(body.error?.nodeTypes).toEqual(["external"]);
    expect(body.error?.code).toBe("SERVERLESS_NODE_UNSUPPORTED");
    // 接线层:执行体必须走那个作者(自己再判一遍 = 两处判定,迟早只改一处);:发布主体在 lib/workflow/long-ops.ts,路由只 submitLongOp
    const route = strip(read("app/api/workflow/[id]/publish/route.ts"));
    expect(route).toContain('kind: "workflow-publish"');
    expect(route).not.toContain("publishWorkflowDag(");
    const exec = strip(read("lib/workflow/long-ops.ts"));
    expect(exec).toContain("schedulerRejectResponse(e)");
    expect(exec).not.toContain("instanceof ServerlessNodeUnsupported");
  });
});

describe("SW-9 下线:两种调度器都能撤,且**不许恒打主控区**", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("单一作者按落点分派:经典 offlineDag(dagId, wfTarget) / serverless offlineServerlessWorkflow", () => {
    expect(pub).toContain("offlineDag(dagId, wfTarget)");
    expect(pub).toContain("offlineServerlessWorkflow({ ep, dagId, workflowArn })");
    // 🔴 变异抓到的判据洞:原来用正则钉 `return { removed: false }` 这个**字面形状**,
    //   而只要多写一个字段(`return { removed: false, scheduler: … }`)就绕过去了。
    //   改成钉**可达性**:serverless 分支从判断到真正下线之间不许有任何 return。
    const un = pub.slice(pub.indexOf("export async function unpublishWorkflowDag"));
    const iIf = un.indexOf("if (isServerlessEndpoint(ep))");
    const iOff = un.indexOf("offlineServerlessWorkflow({");
    expect(iIf).toBeGreaterThan(0);
    expect(iOff).toBeGreaterThan(iIf);
    expect(un.slice(iIf, iOff), "serverless 分支在真正下线之前就 return 了 ⇒ 孤儿 workflow(真环境学费)").not.toMatch(/\breturn\b/);
    // ARN 兜底(台账丢了也不许留孤儿)
    expect(un.slice(iIf, iOff)).toMatch(/known\s*\|\|\s*\(await findWorkflowArnByName\(ep\.region, dagId\)\)/);
  });

  it("🔴 全仓不许再出现 `offlineDag(x)` 这种**不传 target** 的调用(恒打主控区 = 别区的 DAG 照跑)", () => {
    const files = [
      "app/api/workflow/[id]/unpublish/route.ts",
      "app/api/workflow/[id]/route.ts",
      "lib/workflow/publish-dag.ts",
      "lib/etl/dag-fanout.ts",
      "lib/engines/emr/schedule-fanout.ts",
    ];
    for (const f of files) {
      const src = strip(read(f));
      const bad = Array.from(src.matchAll(/offlineDag\(([^)]*)\)/g)).filter((m) => !m[1].includes(","));
      expect(bad.map((m) => `${f}: offlineDag(${m[1]})`), "缺 targetId ⇒ 缺省主控区").toEqual([]);
    }
  });

  it("unpublish 执行体走单一作者;撤不下来 ⇒ 502 且**不许**把记录改成 draft", () => {
    // 下线主体在执行体 workflow-unpublish(路由只 submitLongOp 自己的 kind)
    const unpublishRoute = strip(read("app/api/workflow/[id]/unpublish/route.ts"));
    expect(unpublishRoute).toContain('kind: "workflow-unpublish"');
    expect(unpublishRoute).not.toContain("unpublishWorkflowDag(");
    const lib = strip(read("lib/workflow/long-ops.ts"));
    const route = lib.slice(lib.indexOf("const workflowUnpublish"), lib.indexOf("const workflowDelete"));
    expect(route).toContain("unpublishWorkflowDag(");
    expect(route, "还在直接调 offlineDag ⇒ 又绕过了落点解析").not.toMatch(/offlineDag\(/);
    const iUpdate = route.indexOf("UpdateCommand");
    const iCatch = route.indexOf("catch (e");
    expect(iUpdate, "改 draft 排在 catch 之后 ⇒ 撤失败也照样清台账").toBeLessThan(iCatch);
    expect(route).toContain("DAG_CLEANUP_FAILED");
    expect(route).toContain("502");
    // 产物撤了,deployments 里那条也要撤(留旧 ARN = 台账撒谎)
    // 🔴 v1.68 改判:原来钉的是字面量 `deployments.#tid` —— 那是**形状**;承重的事实是
    //   「**每一个**真撤下来的区的台账都要清」。扇出修好之后(逐区派生)这个字面量当场把判据打红,
    //   而产品行为变好了 ⇒ 判据钉事实:清理清单必须从逐区结果派生,且老的「只清一个」写法不许再出现。
    expect(route, "台账清理必须按逐区结果派生(只清 head 那一个 ⇒ 另一个区的台账继续说「已部署」)")
      .toMatch(/result\.perTarget\.filter\(.*\)\.map\(/);
    expect(route).not.toContain("deployments.#tid");
    // 🔴 「有区撤不下来 ⇒ 不许动记录」这条不变量现在由**返回字段**承担(异常已不再冒泡)
    expect(route, "扇出把逐区异常收进 perTarget 之后,守卫必须改看 allRemoved").toContain("allRemoved");
    // 行为侧(502 一条记录都不写 / 逐区台账都清 / 「该区没装调度器」不算失败 / DELETE 同一条)
    // 由 `app/api/workflow/__tests__/unpublish-fanout.test.ts` 真跑路由断言(3 变异验红)。
  });
});

describe("触发 / 解挂:落点必须来自解析器", () => {
  it("🔴 serverless 手动触发 = StartWorkflowRun,且**不预写台账行**(键由服务侧决定,预写就是第二行)", () => {
    // 逐 target 触发的主体 triggerOneTarget 在执行体文件里(路由只留子集校验 / 法域同意 / 运行组开立 + submitLongOp)
    const triggerRoute = strip(read("app/api/workflow/[id]/trigger/route.ts"));
    expect(triggerRoute).toContain('kind: "workflow-trigger"');
    expect(triggerRoute).not.toContain("startWorkflowRun(");
    const t = strip(read("lib/workflow/long-ops.ts"));
    const iSls = t.indexOf("isServerlessEndpoint(ep)");
    const iClassic = t.indexOf("const envName = ep.envName");
    expect(iSls).toBeGreaterThan(0);
    expect(iClassic).toBeGreaterThan(iSls);
    const slsBranch = t.slice(iSls, iClassic);
    expect(slsBranch).toContain("startWorkflowRun(ep.region, workflowArn)");
    expect(slsBranch, "serverless 分支预写了台账行 ⇒ 一次 run 两行").not.toContain("putRunRecord(");
    expect(slsBranch, "拿不到 ARN 时必须如实拒(而不是静默不触发)").toContain("SCHEDULER_ARTIFACT_MISSING");
  });

  it("🔴 解挂只有一个作者(`ensureDagUnpaused`),两个调用方都不许自己解析端点", () => {
    // 发布的解挂在执行体里(且从 fire-and-forget 改为等它做完);publish 路由本身只 submitLongOp
    expect(strip(read("app/api/workflow/[id]/publish/route.ts"))).not.toContain("unpauseWhenLoaded(");
    expect(strip(read("lib/workflow/long-ops.ts"))).toContain("await ensureDagUnpaused(");
    for (const f of ["app/api/schedule/enable/route.ts", "lib/workflow/long-ops.ts"]) {
      const src = strip(read(f));
      expect(src, `${f} 没走解挂的单一作者`).toContain("ensureDagUnpaused(");
      expect(src, `${f} 还在自己调 unpauseWhenLoaded ⇒ 端点解析又长出第二处`).not.toContain("unpauseWhenLoaded(");
      expect(src, `${f} 还在用 homeMwaaEndpoint() ⇒ 恒打主控区(别区的 DAG 永远 paused)`).not.toContain("homeMwaaEndpoint(");
    }
    const lib = strip(read("lib/workflow/publish-dag.ts"));
    expect(lib).toMatch(/export async function ensureDagUnpaused/);
    // 解挂改成**逐个绑定区**之后,这条判据钉的应该是**事实**
    //   (serverless 分支不去 unpause、如实标 scheduler),而不是当时那一行的写法。
    const fn = lib.slice(lib.indexOf("export async function ensureDagUnpaused"));
    const iSls = fn.indexOf("isServerlessEndpoint(ep)");
    const iUnpause = fn.indexOf("unpauseWhenLoaded(");
    expect(iSls, "解挂里必须先判 serverless").toBeGreaterThan(0);
    expect(iUnpause, "经典分支才 unpause").toBeGreaterThan(iSls);
    expect(fn.slice(iSls, iUnpause), "serverless 没有 pause 概念,必须如实 no-op(不许落到 unpause 上)")
      .toMatch(/scheduler:\s*"serverless"/);
    // 🔴 扇出:解挂必须遍历全部绑定(只解第一个区 ⇒ 第二个区的 cron 永远不触发)
    expect(fn).toMatch(/for \(const wfTarget of targets\)/);
  });
});

// ── 步 4b:观察面(状态回填 / 节点状态 / 任务日志 / 监控日志)────────────────────────
describe("SW-12 观察面:落点必须来自解析器,serverless 走服务 API", () => {
  it("🔴 状态回填不许有模块级主控区客户端 / 主控区环境名(那会把别区跑好的 run 标成 failed)", () => {
    const st = strip(read("app/api/workflow/[id]/runs/[runId]/status/route.ts"));
    expect(st, "还在用 homeMwaaEndpoint() ⇒ 别区的 list-runs 恒空 ⇒ 3 分钟后被「孤儿宽限期」标 failed").not.toContain("homeMwaaEndpoint(");
    expect(st, "模块级 new MWAAClient = 默认主控区").not.toMatch(/new\s+MWAAClient\(/);
    expect(st).toContain("schedulerEndpointFor(");
    expect(st).toContain("bindingTargets(");
  });

  it("🔴 SW-12 reconcile-on-read:serverless 以**服务侧 RunState** 为准回填,只认终态", () => {
    const st = strip(read("app/api/workflow/[id]/runs/[runId]/status/route.ts"));
    expect(st).toContain("readServerlessRunState(");
    expect(st).toMatch(/st === "SUCCESS" \? "succeeded"/);
    expect(st, "非终态也回填 ⇒ 会把还在跑的 run 标成终态").toMatch(/if \(!mapped\) return apiOk/);
    expect(st).toContain("updateRunRecord(");
  });

  it("节点状态 / 任务日志:serverless 分支真的接上了,拿不到产物时**如实拒**", () => {
    for (const f of [
      "app/api/workflow/[id]/runs/[runId]/nodes/route.ts",
      "app/api/workflow/[id]/runs/[runId]/nodes/[task]/logs/route.ts",
    ]) {
      const src = strip(read(f));
      expect(src, `${f} 还在对 serverless 回 409 不支持`).not.toContain("WORKFLOW_SCHEDULER_UNSUPPORTED");
      expect(src).toContain("serverlessWorkflowArnOf(");
      expect(src, `${f} 找不到产物时给了空结果 ⇒ 看起来像「没跑过」`).toContain("SCHEDULER_ARTIFACT_MISSING");
    }
    expect(strip(read("app/api/workflow/[id]/runs/[runId]/nodes/route.ts"))).toContain("listServerlessNodeStates(");
    expect(strip(read("app/api/workflow/[id]/runs/[runId]/nodes/[task]/logs/route.ts"))).toMatch(/readServerlessTaskLogs\([\s\S]{0,300}taskId,/);
  });

  it("🔴 监控页任务日志的**日志组名**必须来自该工作流落点的环境(不是主控区),落点也要读 targets[]", () => {
    const src = strip(read("app/api/monitor/tasks/[id]/logs/route.ts"));
    expect(src, "日志组名恒用主控区环境 ⇒ region 对了组名不对 ⇒ 页面「暂无日志」与真的没输出长得一样").not.toContain("homeMwaaEndpoint(");
    expect(src).toContain("airflow-${wfEp.envName}-Task");
    expect(src, "落点还从 (wf as {targetId}).targetId 取 ⇒ 用 targets[] 绑的工作流解成 undefined").toContain("bindingTargets(wf");
  });
});

describe("🔴 第 6 处「恒打主控区」:依赖链的下游触发(SCH-03)", () => {
  const dep = strip(read("lib/scheduler/dependency.ts"));
  it("不许有模块级主控区客户端 / 主控区环境名", () => {
    expect(dep, "还在用 homeMwaaEndpoint() ⇒ 对别区下游 `dags trigger` 静默失败,而平台照样写 running 行").not.toContain("homeMwaaEndpoint(");
    expect(dep).not.toMatch(/new\s+MWAAClient\(/);
    expect(dep, "模块级 Glue 客户端 ⇒ 别区的 Glue 作业 EntityNotFound 被吞成一行 log").not.toMatch(/new\s+GlueClient\(/);
  });
  it("两条下游都按**自己的落点**解析,serverless 走 StartWorkflowRun 且不预写台账行", () => {
    expect(dep).toContain("schedulerEndpointFor(target)");
    expect(dep).toContain("glueClientFor(binding.region)");
    // 🔴 切片锚点要**在它后面**:`const runId = ulid()` 在 startDownstreamSync 里也有一处、且更靠前
    //   ⇒ 反向切出空串,判据变成「对空串做 toContain」⇒ 永远红(第三次踩切片锚点了,记在这)。
    const iSls = dep.indexOf("isServerlessEndpoint(ep)");
    const sls = dep.slice(iSls, dep.indexOf("} else {", iSls));
    expect(sls).toContain("startWorkflowRun(ep.region, arn)");
    expect(sls, "serverless 分支预写台账行 ⇒ 一次 run 两行").not.toContain("putRunRecord(");
    // 🔴 变异抓到的判据洞:只断「解析了端点」不够 —— 经典分支必须**真的拿 ep 去打 CLI**
    //   (把 mwaaCli 换成一个假的 { ok: true } 也能让上面那些断言全绿)。
    expect(dep).toContain("await mwaaCli(ep, `dags trigger");
    expect(dep, "章必须跟落点(否则台账按区归因会错)").toContain("resolveRunStamp(wf, target)");
  });
});
