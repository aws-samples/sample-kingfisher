/**
 * 钉住「编排按分区隔离」。用户 2026-09-10 **第三次**强调:
 * 「**这个是误区,我一开始要求的就是按照分区隔离,每一个分区都有 MWAA serverless 的调度能力,
 * 调度只能在自己的区域执行。只是元数据收集上报到主控区而已。**」
 *
 * 🔴 我此前把「一个 AgentCore / 一个 OpenMetadata」那条中心化纪律套到了编排上 —— 那条只管
 * AgentCore 与 OM。这一组判据就是为了让那个错法**写不回来**:编排链路上任何一处出现
 * `homeMwaaEndpoint()`,就等于「把别区的工作流塞回主控区调度」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向断言必须先剥注释:本仓注释里逐字写着「原来用的是 homeMwaaEndpoint()」。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** 编排链路上的每一个文件:发布 / 触发 / 节点状态 / 任务日志 / 控制台入口 / DAG 下发 */
const WORKFLOW_PATH_FILES = [
  "lib/workflow/publish-dag.ts",
  // 发布 / 下线 / 触发 / 删除的主体在执行体里(路由只留鉴权 + submitLongOp)
  "lib/workflow/long-ops.ts",
  "app/api/workflow/[id]/publish/route.ts",
  "app/api/workflow/[id]/trigger/route.ts",
  "app/api/workflow/[id]/runs/[runId]/nodes/route.ts",
  "app/api/workflow/[id]/runs/[runId]/nodes/[task]/logs/route.ts",
  "app/api/workflow/airflow/route.ts",
];

describe("编排按分区隔离", () => {
  it("🔴 编排链路上不许再出现 homeMwaaEndpoint()(= 把别区工作流塞回主控区调度)", () => {
    const bad: string[] = [];
    for (const f of WORKFLOW_PATH_FILES) {
      if (strip(read(f)).includes("homeMwaaEndpoint(")) bad.push(f);
    }
    expect(bad, `这些文件还在用主控区端点:${bad.join(" / ")}`).toEqual([]);
  });

  it("🔴 编排链路上不许再有模块级 MWAAClient(那是「默认主控区」的来源)", () => {
    const bad: string[] = [];
    for (const f of WORKFLOW_PATH_FILES) {
      if (/new\s+MWAAClient\(/.test(strip(read(f)))) bad.push(f);
    }
    expect(bad, bad.join(" / ")).toEqual([]);
  });

  it("每一处都必须从**工作流行上的章**解析端点(自己解析,或经一个会解析的单一作者)", () => {
    // 🔴 判据放宽的**方向要对**:
    //   发布路由现在把「解挂」交给 `ensureDagUnpaused`(它自己按落点解析)⇒ 路由里不再直接出现
    //   `schedulerEndpointFor(`。那是**更强**的形态(端点解析只有一处),不是退步。
    //   所以判据改成:要么自己解析,要么经登记过的单一作者;而「用主控区端点」那条负向判据一个字不改
    //   (上面那个 it 仍在钉 homeMwaaEndpoint)。
    // 路由经 submitLongOp 把主体交给执行体(lib/workflow/long-ops.ts 自己在清单里被钉),也算经单一作者
    const DELEGATES = ["ensureDagUnpaused(", "publishWorkflowDag(", "unpublishWorkflowDag(", "submitLongOp("];
    for (const f of WORKFLOW_PATH_FILES) {
      const src = strip(read(f));
      const ok = src.includes("schedulerEndpointFor(") || DELEGATES.some((d) => src.includes(d));
      expect(ok, `${f} 既没自己解析端点、也没经单一作者`).toBe(true);
      if (f !== "app/api/workflow/airflow/route.ts") {
        // 控制台入口按 `?targetId=` 取(它不属于某一个工作流);其余五处都必须读行上的章
        const rowOk = src.includes("bindingTargets(") || DELEGATES.some((d) => src.includes(d));
        expect(rowOk, `${f} 没从行上取 targets[]`).toBe(true);
      }
    }
  });

  it("DAG 必须写进**那个区**的桶;serverless 也发到**那个区**(而不是回落主控区)", () => {
    const pub = strip(read("lib/workflow/publish-dag.ts"));
    expect(pub).toContain("const bucket = ep.dagBucket;");
    expect(pub).toContain("await s3ClientFor(ep.region)");
    // 🔴 本条原来钉的是「遇 serverless 必须抛」。
    //   那个抛的前提(dag-factory 表达不了多节点)已被 2026-09-11 的真跑证伪 ⇒ 现在必须**真发过去**。
    //   判据换成:serverless 分支存在、产物落**该 target 的** workflowBucket、且全程没有 home 字面量。
    expect(pub).toContain("isServerlessEndpoint(ep)");
    expect(pub).toContain("publishServerlessWorkflow({");
    expect(pub, "serverless 产物必须落该 target 的桶(publishServerlessWorkflow 只吃 ep)").toContain("definitionYaml: yaml");
    expect(pub, "抛错分支必须删干净,否则下一个人以为还不支持").not.toContain("WorkflowSchedulerUnsupported");
  });

  it("新建工作流要盖章,并在建之前就核**每一个**非 home 区都有调度组件(不许先建后发现发不了)", () => {
    const src = strip(read("app/api/workflow/route.ts"));
    // 创建改成**可绑多区**(用户 2026-09-15 点名的
    //   「在美东1 发布、多个区域执行」;原来恒写单值 `targets: [wantTarget]` ⇒ 那套扇出通道永远没有输入)。
    //   判据跟着钉**事实**:落多值 + 逐个校验合法性 + 非 home 逐个核调度组件 + 不从 ...body 裸抄。
    expect(src).toContain("targets: wantTargets");
    expect(src, "非 home 的每个区都要核调度组件").toContain("requireMwaaForTargets(nonHome)");
    // 合法性 / 非空 / 去重 由唯一作者 requestedTargets 判(行为判据见 requested-target.test.ts)
    expect(src, "落点不许从 ...body 裸抄,且缺落点不许默认主控区").toMatch(/requestedTargets\(body, "新建工作流"\)/);
    // 🔴 反例:不许再回到「只取一个」的写法
    expect(src).not.toContain("targets: [wantTarget]");
  });

  it("🔴 拒因码已登记(避免又出现一个字符串码没进联合类型)", () => {
    expect(strip(read("lib/api-response.ts"))).toContain('"WORKFLOW_SCHEDULER_UNSUPPORTED"');
  });
});
