// 🔴🔴 **「落点」这一类缺陷的结构性拦截**(不是再补一个点,而是把这一类关进笼子)。
//
// 【为什么必须有这道门】2026-09-11 一天之内,同一类缺陷在**六个**互不相干的地方各犯了一次:
//   ① `unpublish` 路由 `offlineDag(dagId)` 漏传落点 ⇒ 恒删主控区的 DAG,别区的照跑;
//   ② `schedule/enable` 解挂写 `homeMwaaEndpoint()` ⇒ 页面显示「已开启」而那个区的 DAG 永远 paused;
//   ③ 运行状态回填用**模块级** MWAA 客户端 + 主控区环境名 ⇒ 把别区**跑成功**的 run 在 3 分钟后标成 failed;
//   ④ 监控页任务日志的**日志组名**用主控区环境名 ⇒ 「暂无日志」和「真的没输出」长得一样;
//   ⑤ run 记录的**章**用行上的字段而不是落点 ⇒ 作业锁属性名与台账 runId 一起错;
//   ⑥ 依赖链(SCH-03)下游触发整条链打主控区 ⇒ 台账写着 running,其实一次都没跑。
// 共同根因**不是粗心**,而是:**「落点」是个有静默合法默认值的参数** —— `= HOME_TARGET_ID` 的默认值、
// `targetId?` 的可选参数、`process.env.AWS_REGION` 的模块级客户端、`homeMwaaEndpoint()` 这个永远可调的函数。
// 漏传**不报错**,只是「在错的区域干活」。⇒ 只靠 code review / grep 是打地鼠。
//
// 【这道门做三件事】
//   1. **谁有权解析落点是一份显式清单 + 只减不增的棘轮**:加一个新文件必须来改这份清单(= 有人复核),
//      而清单只允许缩小(目标态 = 全部收进 seam)。
//   2. **禁模块级 AWS 客户端**:落点相关文件里 `new XxxClient({ region: … })` 一律不许在模块顶层 ——
//      那正是缺陷 ③⑥ 的形状(客户端在 import 时就绑死了主控区)。
//   3. **主控区专用出口只许出现在声明为 home-only 的文件里**:`homeMwaaEndpoint()` 是合法函数(主控区是真的),
//      但它出现在一个**逐 target** 的文件里就等于把别区的活儿打回主控区。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../..");

/** 🔴 负向文本判据必须先剥注释:本仓注释里逐字写着「原来用的是 homeMwaaEndpoint()」。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "__tests__") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), code: stripComments(readFileSync(p, "utf8")) }));

/** 落点解析器(能决定「在哪个区/哪个 target 干活」的入口)。 */
const RESOLVERS = ["schedulerEndpointFor", "mwaaEndpointFor", "serverlessEndpointFor"];
/** 主控区专用出口 —— 只许 home-only 的文件用。 */
const HOME_ONLY_EXIT = "homeMwaaEndpoint";

/**
 * 🔴 **有权解析落点的文件清单**(只减不增)。目标态:工作流那几条路全部收进 `lib/workflow/publish-dag.ts`
 * 这条 seam,路由一个都不留。改这份清单 = 必须有人复核。
 */
const MAY_RESOLVE_PLACE = [
  // ── 解析器自身与逐 target 扇出的单一作者(合理常驻)──
  "lib/scheduler/mwaa-endpoint.ts",
  "lib/scheduler/mwaa-offline.ts",
  "lib/scheduler/trigger.ts",
  "lib/scheduler/dependency.ts",
  "lib/etl/dag-fanout.ts",
  "lib/engines/emr/schedule-fanout.ts",
  // ── 工作流 seam(目标态:下面那些路由都该只调它)──
  "lib/workflow/publish-dag.ts",
  // ── ⏳ 仍自己解析的路由(欠账,只减不增;每减一个把它从这里删掉)──
  // 手动触发的扇出主体从 trigger 路由搬进执行体(逐 target schedulerEndpointFor),欠账名额随之转移、不新增
  "lib/workflow/long-ops.ts",
  "app/api/workflow/[id]/runs/[runId]/status/route.ts",
  "app/api/workflow/[id]/runs/[runId]/nodes/route.ts",
  "app/api/workflow/[id]/runs/[runId]/nodes/[task]/logs/route.ts",
  "app/api/workflow/airflow/route.ts",
  "app/api/monitor/tasks/[id]/logs/route.ts",
];
/** 🔴 棘轮:有权解析落点的文件数**只减不增**(目标 7 = 只剩解析器 + 扇出 + seam)。 */
const PLACE_RESOLVER_LIMIT = 13;

/** 声明为 **home-only** 的文件(整份文件只服务主控区,用 `homeMwaaEndpoint()` 是对的)。 */
const HOME_ONLY_FILES = [
  "lib/scheduler/mwaa-endpoint.ts",   // 它就是那个出口的定义处
  "app/api/settings/route.ts",        // 平台设置:展示主控区自己的配置(§2.6.7 已判为 global-only)
];
/**
 * 🔴 **逐 target 文件里的主控区出口 = 必须写封闭理由**(与本仓 `global-only` 路由、不带范围的读取
 * 同一条纪律:编不出理由 = 它不该用主控区出口)。写法 = 调用点上方 3 行内出现
 * `home-only-exit: <理由>`。这些是**欠账**,数量只减不增。
 */
const HOME_ONLY_EXIT_MARK = "home-only-exit:";
const HOME_ONLY_EXIT_LIMIT = 1;

describe("🔴🔴 落点(region / target)决定权的结构性拦截", () => {
  it("有权解析落点的文件 == 显式清单(加一个新文件必须来改清单 = 有人复核)", () => {
    const actual = FILES.filter((f) => RESOLVERS.some((r) => new RegExp(`\\b${r}\\s*\\(`).test(f.code))).map((f) => f.rel);
    expect([...actual].sort(), `实际解析落点的文件与清单不一致 ⇒ 要么把新文件收进 seam,要么显式登记(并说明为什么它必须自己解析)`)
      .toEqual([...MAY_RESOLVE_PLACE].sort());
  });

  it("🔴 棘轮:这份清单只减不增(每把一条路收进 seam 就把数字改小)", () => {
    expect(MAY_RESOLVE_PLACE.length, "清单长了 ⇒ 落点决定权又散开了").toBe(PLACE_RESOLVER_LIMIT);
  });

  it("🔴 主控区专用出口 `homeMwaaEndpoint()`:要么在 home-only 文件里,要么**每个调用点写封闭理由**", () => {
    const unexplained: string[] = [];
    const explained: string[] = [];
    for (const f of FILES) {
      if (HOME_ONLY_FILES.includes(f.rel)) continue;
      const raw = readFileSync(resolve(SRC, f.rel), "utf8").split("\n");
      // 🔴 用**剥过注释**的那份判「有没有真的调用」,再回原文找理由标记(否则注释里提一句就被算成调用)
      if (!new RegExp(`\\b${HOME_ONLY_EXIT}\\s*\\(`).test(f.code)) continue;
      raw.forEach((line, i) => {
        if (!new RegExp(`\\b${HOME_ONLY_EXIT}\\s*\\(`).test(line)) return;
        const near = raw.slice(Math.max(0, i - 3), i + 1).join("\n");
        const m = near.includes(HOME_ONLY_EXIT_MARK) && near.split(HOME_ONLY_EXIT_MARK)[1].trim().length > 6;
        (m ? explained : unexplained).push(`${f.rel}:${i + 1}`);
      });
    }
    expect(unexplained, `这些是逐 target 的文件却用了主控区出口,且**没写理由** ⇒ 把别区的活儿打回主控区(今天犯了四次)`).toEqual([]);
    expect(explained.length, `带理由的主控区出口是欠账,只减不增(现有:${explained.join(" / ")})`).toBe(HOME_ONLY_EXIT_LIMIT);
  });

  it("🔴 落点相关文件里不许有**模块级** AWS 客户端(import 时就绑死主控区 = 缺陷 ③⑥ 的形状)", () => {
    const CLIENTS = ["MWAAClient", "GlueClient", "S3Client", "RedshiftDataClient", "EMRServerlessClient", "CloudWatchLogsClient", "MWAAServerlessClient"];
    const bad: string[] = [];
    for (const f of FILES) {
      if (!MAY_RESOLVE_PLACE.includes(f.rel) && !f.rel.startsWith("lib/scheduler/")) continue;
      for (const c of CLIENTS) {
        // 模块级 = 顶层 `const x = new XClient(` / `= new XClient(`,且不在函数体缩进里
        const re = new RegExp(`^(const|let|var)\\s+\\w+\\s*[:=][^\\n]*new\\s+${c}\\s*\\(`, "m");
        if (re.test(f.code)) bad.push(`${f.rel}: ${c}`);
      }
    }
    expect(bad, "客户端必须按落点在函数内取(target-clients.ts 的 xClientFor)").toEqual([]);
  });

  it("🔴 `offlineDag` 的落点是**必填**(有默认值 = 漏传不报错、只是删错区的 DAG)", () => {
    const src = FILES.find((f) => f.rel === "lib/scheduler/mwaa-offline.ts")!.code;
    expect(src).toMatch(/export async function offlineDag\(dagId: string, targetId: string\)/);
    expect(src, "默认值回来了 ⇒ 这一类缺陷的入口又开了").not.toMatch(/targetId: string\s*=/);
  });
});
