// 🔴🔴 **编排 DAG 的「区」门禁** —— 真环境段 `scq` A2-1 抓到的那个缺陷的守护网。
//
// 缺陷形态(实测,不是推演):usw2 视角发布的工作流,DAG 文件**写进了 usw2 的桶**、
// 也**真跑在 usw2 的 Airflow**(A2-2 已绿),但**文件正文**是:
//     region = "us-east-1"
//     redshift.execute_statement(WorkgroupName="bgp-workgroup", ..., SecretArn="...us-east-1...")
// ⇒ 「调度在 usw2、活儿在主控区干」。对跨法域 target 这就是**数据出境**,而它**不报任何错**。
//
// 🔴 因此本文件的判据必须是**负向/结构性**的:区域下推错了不会抛异常,只会跑错区
//    ⇒ 只断「有没有报错」永远绿。这里断的是「单区写死的形态在源码里不存在」+「双区形态在」。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateAirflowDag } from "../dag-generator";
import { buildDagSpec } from "../dag-generator-v2";
import { assertDagPlace } from "../dag-place";
// 断**产物**(两份运行时的 Python 源),不断某个文件的文本
import { RUNTIME_LIB_SOURCE, RUNTIME_LIB_VERSION } from "../runtime-lib";
import { BGP_RUNTIME_PY } from "@/lib/scheduler/serverless/runtime-py";
import type { Workflow } from "@/types/workflow";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 负向文本断言前必须剥注释:本文件的说明文字里就写着被禁的形态(仓内老教训)。 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/^\s*#[^\n]*$/gm, " ");

const wf = (targetId?: string): Workflow =>
  ({
    workflowId: "W1",
    name: "w",
    airflowDagId: "bgp_W1",
    projectId: "proj-default",
    ...(targetId ? { targets: [targetId] } : {}),
    dagDefinition: { nodes: [{ id: "s1", type: "sql", data: { sql: "SELECT 1" } }], edges: [] },
  } as unknown as Workflow);

const PLACE_USW2 = {
  targetId: "tgt_usw2_a",
  execRegion: "us-west-2",
  workgroup: "bgp-workgroup-tgt-usw2-a",
  database: "dev",
  redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:redshift!bgp-namespace-tgt-usw2-a-admin-x",
};

describe("workflow-dag-region-guard(编排 DAG 的执行区)", () => {
  it("🔴🔴 两个生成器都不许再出现「单一 region」形态(那正是被修掉的缺陷)", () => {
    for (const f of ["lib/workflow/dag-generator.ts", "lib/workflow/dag-generator-v2.ts"]) {
      const src = stripComments(read(f));
      expect(src, `${f} 里仍有 \`region = "\${process.env.AWS_REGION\`(单区写死)`)
        .not.toMatch(/region\s*=\s*"\$\{process\.env\.AWS_REGION/);
      expect(src, `${f} 里仍把 spec 的区写成单一 region`).not.toMatch(/\bregion:\s*process\.env\.AWS_REGION/);
      expect(src, `${f} 里仍有 region_name=region(单区客户端)`).not.toMatch(/region_name=region\b/);
    }
  });

  it("🔴 四个 DAG 生成器都是双区形态(执行区 / 主控区分开)", () => {
    const pairs: Array<[string, RegExp, RegExp]> = [
      ["lib/etl/dag-generator.ts", /EXEC_REGION\s*=/, /CTRL_REGION\s*=/],
      ["lib/engines/emr/dag-generator.ts", /EXEC_REGION\s*=/, /CTRL_REGION\s*=/],
      ["lib/workflow/dag-generator.ts", /EXEC_REGION\s*=/, /CTRL_REGION\s*=/],
      ["lib/workflow/dag-generator-v2.ts", /exec_region:/, /ctrl_region:/],
    ];
    for (const [f, execRe, ctrlRe] of pairs) {
      const src = stripComments(read(f));
      expect(execRe.test(src), `${f} 缺执行区常量`).toBe(true);
      expect(ctrlRe.test(src), `${f} 缺主控区常量`).toBe(true);
    }
  });

  it("🔴 runtime-lib:干活的客户端用执行区,台账用主控区(合成一个就是那个 bug)", () => {
    // 🔴 判据改断**产物**(导出的 Python 源)而不是某个文件的文本
    //   `_mk` 已搬进单一作者 `node-exec-py.ts`(经典与 serverless 共用同一份字节),
    //   继续 grep runtime-lib.ts 会永远红 —— 而且断产物更强:两份产物里这三行都必须是对的。
    for (const [name, art] of [["经典 runtime-lib", RUNTIME_LIB_SOURCE], ["serverless 代码包", BGP_RUNTIME_PY]] as const) {
      expect(art, `${name} 的 glue 客户端没用执行区`).toMatch(/"glue":\s*boto3\.client\("glue",\s*region_name=exec_region\)/);
      expect(art, `${name} 的 redshift-data 客户端没用执行区`).toMatch(/"redshift":\s*boto3\.client\("redshift-data",\s*region_name=exec_region\)/);
      expect(art, `${name} 的台账客户端没用主控区`).toMatch(/"ddb":\s*boto3\.resource\("dynamodb",\s*region_name=ctrl_region\)/);
    }
    // 🔴 改了库必须升版本号(模块名带版本;不升 = 存量 DAG 仍 import 旧文件)
    expect(RUNTIME_LIB_VERSION, "改了 runtime-lib 却没升版本号").toBeGreaterThanOrEqual(7);
  });

  it("🔴🔴 publish 必须**先解析落点、再生成**(顺序反了生成器无从知道落点)", () => {
    const src = stripComments(read("lib/workflow/publish-dag.ts"));
    const iResolve = src.indexOf("schedulerEndpointFor(wfTarget)");
    const iBinding = src.indexOf("resolveRedshiftBinding(");
    // 🔴 必须找**调用点**:`indexOf("generateAirflowDag")` 会先命中顶部的 import 行,
    //    那样这条判据永远红(第一版就踩了 —— 量具错会逼人放宽判据)。
    const iGen = src.indexOf("generateAirflowDag(wfWithDag");
    expect(iResolve, "publish 里找不到落点解析").toBeGreaterThan(0);
    expect(iBinding, "publish 里找不到数仓落点解析(唯一作者)").toBeGreaterThan(0);
    expect(iResolve, "落点解析排在生成之后 ⇒ 生成器拿不到落点(这正是缺陷成因)").toBeLessThan(iGen);
    expect(iBinding, "数仓落点解析排在生成之后").toBeLessThan(iGen);
    // 🔴 **改判:从「形态」改到「事实」。**
    //   原来这一行钉的是那个三元的**长相**:
    //       /rsBinding\.home \? opts\.redshiftSecretArn : rsBinding\.secretArn/
    //   它要保证的**事实**是「非 home 必须用该 target 自己的凭证,不许拿主控区的 secret
    //   去连别的区」。该缺陷的前置把凭证收成**单一作者** `resolveRedshiftBinding` 之后,
    //   那个事实**依然成立而且更强**(所有 target 一律用自己的),但形态变了 ⇒ 这条判据会红在
    //   一件完全正确的改动上。(记忆 `criteria-pin-facts-not-shapes`:判据钉形态、承重是事实。)
    // ⇒ 改成钉事实:产物里的凭证**只能**来自 `rsBinding`(落点解析的结果),
    //   绝不能来自调用方 / env / 字面量。更严的闭合式版本在
    //   `secret-single-author.test.ts` ②③④⑤(那里还钉了「没有第二个调用方能传进来」)。
    const credLines = src.split("\n").filter((l) => /redshiftSecretArn:/.test(l));
    expect(credLines.length, "产物里一处凭证赋值都没有 ⇒ 这条判据在空转").toBe(1);
    expect(credLines[0].trim(), "产物里的凭证不是由落点解析派生 ⇒ 可能拿到别的区的 secret").toMatch(
      /^redshiftSecretArn:\s*rsBinding\.secretArn\s*,$/
    );
    // 🔴 三个执行面参数都必须真的传给生成器(只解析不传 = 白解析)
    expect(src).toMatch(/execRegion:\s*ep\.region/);
    expect(src).toMatch(/workgroup:\s*rsBinding\.workgroup/);
    expect(src).toMatch(/database:\s*rsBinding\.database/);
    expect(src).toMatch(/generateAirflowDagV2\(wfWithDag,\s*place\)/);
    expect(src).toMatch(/generateAirflowDag\(wfWithDag,\s*place\)/);
  });

  it("🔴🔴 非 home 产物:干活在该区、台账回主控区、数仓与凭证都是该区的", () => {
    const dag = generateAirflowDag(wf("tgt_usw2_a"), PLACE_USW2);
    expect(dag).toContain('EXEC_REGION = "us-west-2"');
    expect(dag).toContain('CTRL_REGION = "us-east-1"');
    expect(dag).toContain('boto3.client("glue", region_name=EXEC_REGION)');
    expect(dag).toContain('boto3.resource("dynamodb", region_name=CTRL_REGION)');
    expect(dag).toContain('WorkgroupName="bgp-workgroup-tgt-usw2-a"');
    expect(dag).toContain(`SecretArn="${PLACE_USW2.redshiftSecretArn}"`);
    // 🔴 判别性反向断言:主控区那套值**一个都不许**出现在非 home 的产物里
    expect(dag, "非 home 产物里出现了主控区 workgroup ⇒ 活儿会打回主控区").not.toContain('WorkgroupName="bgp-workgroup"');
    expect(dag, "非 home 产物里 glue 客户端仍指主控区").not.toMatch(/boto3\.client\("glue",\s*region_name="us-east-1"\)/);
  });

  it("🔴 home 产物语义守恒:两个区常量都是主控区,workgroup 仍是 home 的", () => {
    const dag = generateAirflowDag(wf(), {});
    expect(dag).toContain('EXEC_REGION = "us-east-1"');
    expect(dag).toContain('CTRL_REGION = "us-east-1"');
    expect(dag).toMatch(/WorkgroupName="bgp-workgroup"/);
  });

  it("🔴🔴 fail-closed:非 home 缺执行面参数一律抛(缺省兜底 = 静默打回主控区)", () => {
    // 单一作者直测:三项各缺一次 + 缺凭证
    expect(() => assertDagPlace("W1", { targetId: "tgt_usw2_a", workgroup: "w", database: "d" }, true)).toThrow(/execRegion/);
    expect(() => assertDagPlace("W1", { targetId: "tgt_usw2_a", execRegion: "us-west-2", database: "d" }, true)).toThrow(/workgroup/);
    expect(() => assertDagPlace("W1", { targetId: "tgt_usw2_a", execRegion: "us-west-2", workgroup: "w" }, true)).toThrow(/database/);
    expect(() =>
      assertDagPlace("W1", { targetId: "tgt_usw2_a", execRegion: "us-west-2", workgroup: "w", database: "d" }, true)
    ).toThrow(/redshiftSecretArn/);
    // 无 SQL 节点时不要求凭证(不许过度收紧)
    expect(() =>
      assertDagPlace("W1", { targetId: "tgt_usw2_a", execRegion: "us-west-2", workgroup: "w", database: "d" }, false)
    ).not.toThrow();
    // home 一律不拦(现网那条路不变)
    expect(() => assertDagPlace("W1", { targetId: "tgt_home" }, true)).not.toThrow();
    expect(() => assertDagPlace("W1", {}, true)).not.toThrow();
    // 两个生成器都必须真的调它(不是只有一个接了)
    expect(() => generateAirflowDag(wf("tgt_usw2_a"), { targetId: "tgt_usw2_a" })).toThrow(/execRegion/);
    expect(() => buildDagSpec(wf("tgt_usw2_a"), { targetId: "tgt_usw2_a" })).toThrow(/execRegion/);
  });

  it("🔴 v2 spec:两个区键都在,落点数仓来自入参", () => {
    const spec = buildDagSpec(wf("tgt_usw2_a"), PLACE_USW2) as unknown as Record<string, unknown>;
    expect(spec.exec_region).toBe("us-west-2");
    expect(spec.ctrl_region).toBe("us-east-1");
    expect(spec.workgroup).toBe("bgp-workgroup-tgt-usw2-a");
    expect(spec.region, "旧的单一 region 键必须消失(留着就会有人继续读它)").toBeUndefined();
  });

  it("🔴🔴 章的 target 必须等于**这份产物真正执行的那个 target**,不许被行上过期/非法的字段带偏", () => {
    // 形态:路由写的是 `targets: [tgt_usw2_a]`(落点权威,`bindingTargets` 读它),
    //      而 `...body` 顺手存下来的 `targetId` 是别的值(甚至非法)。
    //      老写法 `resolveRunStamp(workflow)` **只看 targetId** ⇒ DAG 在 usw2 跑而台账盖了别的章,
    //      连**作业锁属性名**和台账 `runId` 的复合段一起错(= 修过的「两区互相覆盖」再来一遍)。
    const rogue = {
      ...wf("tgt_usw2_a"),
      targets: ["tgt_usw2_a"],
      targetId: "tgt_home",          // ← 行上这个字段与落点分叉
    } as unknown as Parameters<typeof buildDagSpec>[0];
    const spec = buildDagSpec(rogue, PLACE_USW2) as unknown as Record<string, unknown>;
    expect(spec.target_id, "章跟着行上那个过期字段跑了 ⇒ 台账按区归因会错").toBe("tgt_usw2_a");
    const py = generateAirflowDag(rogue as never, PLACE_USW2);
    expect(py, "legacy 生成器同一条规则(EMR / ETL 早就这么做了,只有工作流这条路没接)").toContain('"tgt_usw2_a"');
    expect(py).not.toContain('#tgt_home');
    // 两个生成器都必须把 opts.targetId 传给章的派生函数(不许只有一个接了)
    for (const f of ["lib/workflow/dag-generator-v2.ts", "lib/workflow/dag-generator.ts"]) {
      expect(stripComments(read(f)), `${f} 的章没跟落点同源`).toMatch(/resolveRunStamp\(\s*(workflow|job)\s*,\s*opts\.targetId\s*\)/);
    }
  });

  it("🔴🔴 删工作流必须先收走 DAG,收不掉就不许删记录(否则留下没人管的孤儿)", () => {
    // DELETE 主体在执行体 workflow-delete(路由只 submitLongOp 自己的 kind)
    const route = stripComments(read("app/api/workflow/[id]/route.ts"));
    expect(route).toContain('kind: "workflow-delete"');
    expect(route, "路由里不许再直接删记录").not.toMatch(/new DeleteCommand\(/);
    const lib = stripComments(read("lib/workflow/long-ops.ts"));
    const src = lib.slice(lib.indexOf("const workflowDelete"), lib.indexOf("const workflowTrigger"));
    const iClean = src.indexOf("unpublishWorkflowDag(");
    const iDel = src.indexOf("new DeleteCommand(");
    expect(iClean, "DELETE 没有收走 DAG ⇒ 孤儿 DAG 继续按 cron 跑").toBeGreaterThan(0);
    expect(iClean, "先删记录再收 DAG ⇒ 落点信息已丢,再也定位不到那个文件").toBeLessThan(iDel);
    expect(src, "收不掉却照样删记录").toMatch(/DAG_CLEANUP_FAILED/);
    // 桶必须经解析器取(用主控区客户端删别区文件是静默 no-op)
    const pub = stripComments(read("lib/workflow/publish-dag.ts"));
    expect(pub).toMatch(/export async function unpublishWorkflowDag/);
    expect(pub).toMatch(/schedulerEndpointFor\(wfTarget\)/);
    expect(pub).toMatch(/s3ClientFor\(ep\.region\)/);
    expect(pub, "删除用了 home 桶字面量").not.toMatch(/homeMwaaEndpoint\(|MWAA_DAG_BUCKET/);
  });
});
