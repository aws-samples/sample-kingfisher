// 🔴🔴 **改了产物生成器,存量载体不会自动重发**
// 以后**每一次**契约改动都会让已发布的载体静默带着旧定义继续跑。
// 它不是「一个 bug」,是**一台产 bug 的机器**(本轮最重的那条就是从它的现场挖出来的)。
//
// 解法是**可派生**的:拿当前生成器重新生成一遍,与服务上已发布的定义**逐字节**比。
// 刻意不存 `generatorVersion` —— 版本号自己会漂(忘记 bump 就白搭),而且又多一份要同步的真值。
//
// 这一组判据钉三件事,都是闭合式:
//   ① 定义生成**只有一个作者**(否则「发布时怎么生成」与「比对时怎么生成」会分叉 ⇒ 误报落后);
//   ② 比对**零副作用**(检查不许把被检查的东西改掉);
//   ③ 归一清单**闭合**(只许 `start_date` 一项)+ 归一函数**真的有判别力**。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CARRIER_VOLATILE_FIELDS,
  compareCarrierReadback,
  normalizeCarrierDefinition,
} from "@/lib/workflow/publish-dag";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";
import { buildSyncCarrierWorkflow } from "@/lib/sync/schedule-carrier";
import { syncTaskCarrierLedger } from "@/lib/scheduler/carrier-ledger";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向文本断言前必先剥注释(否则会被「解释为什么不能这么写」的注释命中 ⇒ 假红)。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/** 切出一个顶层导出函数的函数体 —— 🔴 判据必须锚定到它要判的那个对象,不许整篇 indexOf。 */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`export async function ${name}(`);
  expect(i, `找不到 ${name} ⇒ 判据在空转(改名了?)`).toBeGreaterThan(-1);
  const rest = src.slice(i + 10);
  const nx = rest.search(/\nexport (async )?function |\nexport (const|interface|type) /);
  return rest.slice(0, nx > 0 ? nx : rest.length);
}

describe("① 产物生成只有一个作者", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("🔴 三个生成器的**调用点**只允许出现在 `buildCarrierArtifact` 里", () => {
    const build = fnBody(pub, "buildCarrierArtifact");
    // 判据自己先有判别力:那个函数里必须真的在生成
    expect(build, "buildCarrierArtifact 里没有 serverless 的生成调用 ⇒ 判据在空转").toContain("buildWorkflowTasksYaml({");
    for (const gen of ["buildWorkflowTasksYaml(", "generateAirflowDagV2(wfWithDag", "generateAirflowDag(wfWithDag"]) {
      const all = pub.split(gen).length - 1;
      const inside = build.split(gen).length - 1;
      expect(
        all,
        `🔴 \`${gen}\` 在 buildCarrierArtifact 之外还有调用点(全文 ${all} 处,唯一作者里 ${inside} 处)` +
          ` ⇒ 「发布时怎么生成」与「比对时怎么生成」会分叉,而分叉的表现是**误报载体落后**`
      ).toBe(inside);
    }
  });

  it("🔴 发布与比对**都**从那个唯一作者拿产物(谁绕过它,谁就会和另一边分叉)", () => {
    for (const fn of ["publishWorkflowDagToTarget", "carrierDefinitionDrift"]) {
      expect(fnBody(pub, fn), `${fn} 没有走 buildCarrierArtifact`).toContain("await buildCarrierArtifact(");
    }
  });
});

describe("② 比对零副作用", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("🔴 `carrierDefinitionDrift` 与 `buildCarrierArtifact` 里都不许有写操作", () => {
    // 🔴 闭合式:列「写操作的形状」,任一出现即红。检查不许把被检查的东西改掉;
    //   而「生成」若顺手写了东西,拒绝一次就会留下半份产物。
    const WRITES = [
      "PutObjectCommand", "DeleteObjectCommand", "UpdateCommand",
      "publishServerlessWorkflow(", "offlineServerlessWorkflow(",
      "recordWorkflowDeployment(", "unpauseWhenLoaded(",
    ];
    for (const fn of ["carrierDefinitionDrift", "buildCarrierArtifact"]) {
      const body = fnBody(pub, fn);
      for (const w of WRITES) {
        expect(body.includes(w), `🔴 ${fn} 里出现了写操作 \`${w}\` —— 它必须是只读的`).toBe(false);
      }
    }
  });

  it("🔴 「判不了」绝不许当成一致:missing / unknown / unsupported 三态都要在", () => {
    const body = fnBody(pub, "carrierDefinitionDrift");
    for (const st of ['"missing"', '"unknown"', '"unsupported"']) {
      expect(body, `少了 ${st} 这一态 ⇒ 判不了的情况会被当成 ok(最坏的假绿)`).toContain(st);
    }
    // 只有真比过且相等才允许回 ok
    expect(body, "ok 不是由「归一后逐字节相等」决定的").toMatch(/same\s*\?\s*"ok"\s*:\s*"stale"/);
  });
});

describe("③ 归一清单闭合 + 归一函数有判别力", () => {
  it("🔴 清单只许 `start_date` 一项,且每项必须写明**为什么它会变**", () => {
    expect(
      CARRIER_VOLATILE_FIELDS.length,
      `🔴 归一清单从 1 项变成了 ${CARRIER_VOLATILE_FIELDS.length} 项 —— 每加一项都要想清楚` +
        `「这个字段为什么会变、变了为什么不该算落后」,想清楚了再改这个数字`
    ).toBe(1);
    expect(CARRIER_VOLATILE_FIELDS[0].key).toBe("start_date");
    for (const f of CARRIER_VOLATILE_FIELDS) {
      expect((f.why || "").length, `${f.key} 没写明为什么它会变`).toBeGreaterThan(10);
    }
  });

  it("🔴🔴 **行为**:只差 start_date ⇒ 归一后相等;差在别处 ⇒ 归一后仍不等(判别力)", () => {
    const base = [
      '"bgp_x":',
      '  "schedule": "0 2 * * *"',
      '  "start_date": "2026-09-22"',
      '  "tasks":',
      '    "__start":',
      '      "op_kwargs":',
      '        "env":',
      '          "exec_region": "us-east-1"',
    ].join("\n");
    // ① 只差那个按设计必须变的字段 ⇒ 必须判成一致(否则每过一天误报一次)
    const tomorrow = base.replace('"2026-09-22"', '"2026-09-30"');
    expect(
      normalizeCarrierDefinition(base),
      "只差 start_date 却判成不一致 ⇒ 每过一天就误报一次「载体落后」"
    ).toBe(normalizeCarrierDefinition(tomorrow));
    // ② 差在**承重字段** ⇒ 必须判成不一致(这就是判别力:少了它,归一函数抹平一切都"通过")
    const drifted = base.replace('"us-east-1"', '"us-west-2"');
    expect(
      normalizeCarrierDefinition(base),
      "🔴 连 exec_region 变了都判成一致 ⇒ 归一抹得太狠,这条机制等于没有"
    ).not.toBe(normalizeCarrierDefinition(drifted));
    // ③ 新增/删除一整个字段也要判出来(闭合:不枚举「哪些字段承重」)
    const added = base + '\n          "ledger_task_type": "sync"';
    expect(
      normalizeCarrierDefinition(base),
      "新增了一个 env 字段却判成一致 ⇒ 正是「字段在、值是缺省的」那种漏不掉的地方"
    ).not.toBe(normalizeCarrierDefinition(added));
  });

  it("🔴 归一只动 start_date 那一行,不许顺手改别的行", () => {
    const one = '  "start_date": "2026-09-22"\n  "other": "2026-09-22"';
    const out = normalizeCarrierDefinition(one);
    expect(out, "把别的行里的日期也抹了 ⇒ 会掩盖真正的漂移").toContain('"other": "2026-09-22"');
    expect(out, "start_date 没被抹平").toContain("<volatile>");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ③b **服务读回的那一份不完整时,不许判成落后,也不许判成一致**
//   2026-11-24 真环境:启用了定时的同步任务恒显示「载体需重新发布」,重新发布也消不掉。
//   调度服务的读接口在定义含非 ASCII 字符时只回前缀,末尾少「UTF-8 字节数 − 字符数」个字符
//   (存量载体 2991 字符 / 3015 字节 ⇒ 读回 2967;3111 / 3147 ⇒ 3075;另建一次性工作流按
//    2 / 3 / 4 字节字符与混排各量一条,规律相同;纯 ASCII 原样读回)。
//   这一组判据的夹具 = **真生成链**编出来的同步载体定义 + 按实测规律截出来的「服务读回」。
// ════════════════════════════════════════════════════════════════════════════
describe("③b 服务读回被截断 ⇒ 判不了(不是落后,也不是一致)", () => {
  /** 实测到的服务读回规律:只回前「字符数 −(UTF-8 字节数 − 字符数)」个字符。 */
  const serviceReadback = (full: string) => full.slice(0, full.length - (Buffer.byteLength(full, "utf8") - full.length));

  /** 真生成链:同步任务 ⇒ 单节点载体工作流 ⇒ spec ⇒ 定义 YAML(与发布 / 比对走的是同一串函数)。 */
  function syncCarrierYaml(name: string, cron = "0 2 * * *"): string {
    const taskId = "01TESTSYNCTASK0000000000AB";
    const wf = buildSyncCarrierWorkflow({ taskId, name, projectId: "proj-default", targets: ["tgt_home"], glueJobName: "bgp-sync-x" }, cron);
    const spec = buildDagSpec(wf, {
      targetId: "tgt_home",
      execRegion: "us-east-1",
      workgroup: "bgp-workgroup",
      database: "dev",
      redshiftSecretArn: null as unknown as string,
      ledger: syncTaskCarrierLedger(taskId, "bgp-sync-tasks"),
    });
    return buildWorkflowTasksYaml({ spec, cron });
  }

  it("夹具自己先站得住:同步载体的定义里真有中文,按实测规律读回的是它的真前缀", () => {
    const full = syncCarrierYaml("Showcase-home-GameSync-7tables");
    const excess = Buffer.byteLength(full, "utf8") - full.length;
    expect(full, "同步载体名不再带中文后缀 ⇒ 这组判据的夹具失效,先看生成器改了什么").toContain("(定时同步)");
    expect(excess, "定义里没有非 ASCII 字符 ⇒ 夹具没有判别力").toBeGreaterThan(0);
    const back = serviceReadback(full);
    expect(back.length).toBe(full.length - excess);
    expect(full.startsWith(back)).toBe(true);
    expect(back).not.toBe(full);
  });

  it("🔴🔴 读回的是同一份定义的截断 ⇒ truncated,并如实报读到多少、少多少", () => {
    const full = syncCarrierYaml("Showcase-home-GameSync-7tables");
    const excess = Buffer.byteLength(full, "utf8") - full.length;
    const rel = compareCarrierReadback(serviceReadback(full), full);
    expect(rel, "含中文的载体又被判成了落后 / 一致 ⇒ 页面回到「载体需重新发布」消不掉,或者假绿").toEqual({
      kind: "truncated",
      readChars: normalizeCarrierDefinition(full).length - excess,
      missingChars: excess,
    });
  });

  it("读回是隔天的那一份(只差 start_date)且被截断 ⇒ 仍是 truncated(归一照常生效)", () => {
    const full = syncCarrierYaml("每日订单同步");
    const m = full.match(/start_date"?\s*:\s*"?(\d{4}-\d{2}-\d{2})/);
    expect(m, "定义里找不到 start_date ⇒ 这条判据在空转").toBeTruthy();
    const yesterdayPublished = full.replace(m![1], "2026-01-02");
    expect(yesterdayPublished).not.toBe(full);
    expect(compareCarrierReadback(serviceReadback(yesterdayPublished), full).kind).toBe("truncated");
  });

  it("🔴 读到的部分里有不同(改了 cron 没重发)⇒ differ:截断不许把真落后吞掉", () => {
    // 等长的改动(只换 cron 里的一个数字):长度关系与「同一份被截断」完全一样,只有逐字比才分得出来
    const published = syncCarrierYaml("每日订单同步", "0 2 * * *");
    const current = syncCarrierYaml("每日订单同步", "0 5 * * *");
    expect(current.length, "这条判据要的是等长的改动").toBe(published.length);
    expect(compareCarrierReadback(serviceReadback(published), current).kind).toBe("differ");
    // 不等长的改动也一样
    expect(compareCarrierReadback(serviceReadback(published), syncCarrierYaml("每日订单同步", "30 4 * * *")).kind).toBe("differ");
    // 改了名字(中文段变长)也一样
    expect(compareCarrierReadback(serviceReadback(syncCarrierYaml("每日订单同步")), syncCarrierYaml("每日订单与退款同步")).kind).toBe("differ");
  });

  it("🔴 纯 ASCII 的定义:读回比当前短(真前缀)⇒ differ —— 服务对纯 ASCII 原样读回,短了就是真的不一样", () => {
    const published = ['"bgp_x":', '  "schedule": "0 2 * * *"', '  "tasks":', '    "a":', '      "operator": "x"'].join("\n");
    const current = published + '\n    "b":\n      "operator": "y"';
    expect(current.startsWith(published)).toBe(true);
    expect(compareCarrierReadback(published, current).kind).toBe("differ");
  });

  it("🔴 边界:少的字符数恰好等于「字节数 − 字符数」⇒ truncated;多一个 ⇒ differ(截断解释不了)", () => {
    const full = syncCarrierYaml("每日订单同步");
    const excess = Buffer.byteLength(full, "utf8") - full.length;
    expect(compareCarrierReadback(full.slice(0, full.length - excess), full).kind).toBe("truncated");
    expect(compareCarrierReadback(full.slice(0, full.length - excess - 1), full).kind).toBe("differ");
    // 当前这份在末尾多出一整个节点(远多于截断能解释的长度)⇒ 确定落后
    const appended = full + '\n    "extra_node":\n      "operator": "airflow.providers.standard.operators.python.PythonOperator"\n      "python_callable": "bgp_runtime.run_node"\n';
    expect(appended.length - serviceReadback(full).length).toBeGreaterThan(Buffer.byteLength(appended, "utf8") - appended.length);
    expect(compareCarrierReadback(serviceReadback(full), appended).kind).toBe("differ");
  });

  it("逐字相等 ⇒ same;读回为空 ⇒ 不是 truncated(那一态由调用方单列)", () => {
    const full = syncCarrierYaml("每日订单同步");
    expect(compareCarrierReadback(full, full).kind).toBe("same");
    expect(compareCarrierReadback("", full).kind).toBe("differ");
    const ascii = '"bgp_x":\n  "schedule": "0 2 * * *"';
    expect(compareCarrierReadback(ascii, ascii).kind).toBe("same");
  });

  it("🔴 接线:`carrierDefinitionDrift` 在调用位置用它,截断 ⇒ unknown 并带原因;ok 只来自 same", () => {
    const body = fnBody(strip(read("lib/workflow/publish-dag.ts")), "carrierDefinitionDrift");
    expect(body, "比对没走 compareCarrierReadback ⇒ 含中文的载体恒判落后").toMatch(/compareCarrierReadback\(published,\s*art\.content\)/);
    const i = body.indexOf('rel.kind === "truncated"');
    expect(i, "没有单列「读回被截断」这一支").toBeGreaterThan(-1);
    const branch = body.slice(i, i + 700);
    expect(branch, "读回被截断没有回 unknown").toMatch(/state:\s*"unknown"/);
    expect(branch, "读回被截断没带原因 ⇒ 页面上只有一个说不清的「无法确认」").toContain("调度服务读回的定义不完整");
    expect(body, "ok 不是只来自「归一后逐字相等」").toMatch(/const same = rel\.kind === "same"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ③c **撤了载体,发布记录要跟着清;记着的载体不在了,要如实回「没有」**
//   2026-11-25 真环境:同步任务 / 平台动作的定时停用后,调度服务里的载体真删了,行里的发布记录没清
//   ⇒ 比对拿着那条已不存在的 ARN 去读,抛出一句英文「Resource not found」,页面对已停用的行显示「无法确认」。
// ════════════════════════════════════════════════════════════════════════════
describe("③c 撤载体清记录 · 记着的载体不在 ⇒ missing", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("🔴 `unpublishWorkflowDag`:给了记录归属就逐区清 —— 清在「真撤下来」之后、记进结果之前(清不掉 = 这个区没撤干净)", () => {
    const body = fnBody(pub, "unpublishWorkflowDag");
    const iOff = body.indexOf("await unpublishWorkflowDagFromTarget(workflow, wfTarget, dagId)");
    const iClear = body.indexOf("await removeDeployment({ table: opts.ledger.table, key: opts.ledger.key");
    const iPush = body.indexOf("perTarget.push(r)");
    expect(iOff, "找不到逐区下线的调用 ⇒ 判据在空转").toBeGreaterThan(-1);
    expect(iClear, "撤下来之后没有清发布记录").toBeGreaterThan(iOff);
    expect(iPush, "清记录排在记结果之后 ⇒ 清失败也会报成功").toBeGreaterThan(iClear);
    expect(body, "没撤下来也清记录 ⇒ 载体还在而平台已认为没有").toMatch(/if \(opts\.ledger && r\.removed\)/);
    expect(body, "清的不是刚撤下来的那个区").toMatch(/targetId: wfTarget/);
  });

  it("🔴 同步任务与平台动作的下线都把记录归属带下去(少带 = 停用后记录还留着)", () => {
    const sync = strip(read("lib/sync/schedule-carrier.ts"));
    const i = sync.indexOf("export async function offlineSyncScheduleCarrier(");
    expect(i).toBeGreaterThan(-1);
    expect(sync.slice(i, i + 500)).toMatch(/unpublishWorkflowDag\([\s\S]*?ledger:\s*syncTaskCarrierLedger\(task\.taskId, TABLES\.SYNC_TASKS\)/);
    const act = strip(read("lib/scheduler/action-schedules.ts"));
    const j = act.indexOf("export async function offlineActionScheduleCarrier(");
    expect(j).toBeGreaterThan(-1);
    expect(act.slice(j, j + 400)).toMatch(/unpublishWorkflowDag\([\s\S]*?\{ ledger: ledgerOf\(row\) \}/);
  });

  it("🔴 比对:读记着的那条抛「不存在」⇒ 按名字再问一次服务,都没有 ⇒ missing(不把服务的原话漏给页面)", () => {
    const body = fnBody(pub, "carrierDefinitionDrift");
    const iGet = body.indexOf("live = await getWorkflow(art.ep.region, arn)");
    expect(iGet, "读已发布定义的调用变了 ⇒ 判据在空转").toBeGreaterThan(-1);
    const tail = body.slice(iGet, iGet + 700);
    expect(tail, "「不存在」之外的错误被吞了").toMatch(/if \(!isWorkflowNotFound\(e\)\) throw e;/);
    expect(tail, "记着的不在时没有按名字再问一次").toMatch(/await findWorkflowArnByName\(art\.ep\.region, art\.dagId\)/);
    expect(tail, "都没有时没回 missing").toContain("return noCarrier");
    expect(body).toMatch(/noCarrier = \{ state: "missing" as const/);
  });

  it("「这条 workflow 不存在」只有一个判法", () => {
    const cli = strip(read("lib/scheduler/serverless/workflow-client.ts"));
    expect(cli.split("/ResourceNotFound/i").length - 1, "判法又散成了多处").toBe(1);
    expect(cli.split("isWorkflowNotFound(e)").length - 1).toBeGreaterThanOrEqual(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ④ **接线** —— 🔴 本仓那个元 bug:「机制早就建好了,只是那条路径没接」。
//   机制在库里而没有任何用户能看见的出口 = 写了等于没写,而且**两层测试都会全绿**。
// 🔴 接线判据要**剥 import 之后查调用位置**(本仓栽过三次:token 出现过会被 import 行放行)。
// ════════════════════════════════════════════════════════════════════════════
describe("④ 接线:两个清单接口都真的出 drift 态", () => {
  const wf = strip(read("app/api/workflow/route.ts"));
  const sync = strip(read("app/api/sync/route.ts"));
  const carrier = strip(read("lib/sync/schedule-carrier.ts"));

  it("🔴 两处都在**调用位置**用上了(不是只 import)", () => {
    expect(wf, "/api/workflow 没在调用位置用 carrierDefinitionDrift").toMatch(/await\s+carrierDefinitionDrift\(/);
    expect(sync, "/api/sync 没在调用位置用 syncCarrierDrift").toMatch(/await\s+syncCarrierDrift\(/);
  });

  it("🔴 是**显式开关**,没有静默默认(默认不查,省钱且不改既有调用方的行为)", () => {
    for (const [nm, src] of [["workflow", wf], ["sync", sync]] as const) {
      expect(src, `${nm} 的 drift 不是显式开关 ⇒ 所有调用方都被迫多打一遍 MSAF`).toMatch(
        /withDrift"\)\s*===\s*"1"/
      );
    }
  });

  it("🔴🔴 「没查」与「查了=最新」必须能区分:不许用 ok 当缺省,查不动必须回 unknown", () => {
    for (const [nm, src] of [["workflow", wf], ["sync", sync]] as const) {
      // 查不动 ⇒ 如实 unknown(而不是 catch 掉什么都不写 ⇒ 前端以为是最新)
      expect(src, `${nm} 的 drift 查失败时没有如实回 unknown`).toMatch(/state:\s*"unknown"/);
      // 🔴 负向:不许出现「缺省成 ok」的形状
      expect(
        /state:\s*"ok"/.test(src),
        `🔴 ${nm} 的接线里出现了写死的 state:"ok" ⇒ 那就是把「没查」或「查不动」说成「最新」`
      ).toBe(false);
    }
  });

  it("🔴 同步载体必须走**单一作者** `syncCarrierDrift`(它带 ledger),不许自己拼 workflow", () => {
    // /api/sync 不许自己调 buildSyncCarrierWorkflow / carrierDefinitionDrift(那样会漏掉 ledger)
    for (const bad of ["buildSyncCarrierWorkflow(", "carrierDefinitionDrift("]) {
      expect(
        sync.includes(bad),
        `🔴 /api/sync 自己拼了 \`${bad}\` ⇒ 会漏掉 ledger ⇒ **每个同步载体都误报落后**`
      ).toBe(false);
    }
    // 而那个单一作者自己必须真的把 ledger 传下去
    const i = carrier.indexOf("export async function syncCarrierDrift(");
    expect(i, "找不到 syncCarrierDrift ⇒ 判据在空转").toBeGreaterThan(-1);
    const body = carrier.slice(i, i + 700);
    expect(body, "syncCarrierDrift 没把 ledger 传给比对 ⇒ ledger_* 会退回缺省值").toMatch(
      /ledger:\s*syncTaskCarrierLedger\(/
    );
    expect(body, "syncCarrierDrift 没用编译出来的载体工作流").toMatch(/buildSyncCarrierWorkflow\(/);
  });

  it("🔴 只对**已发布的**行查(没载体的行不谈「落后」,那是「待发布」另一态)", () => {
    for (const [nm, src] of [["workflow", wf], ["sync", sync]] as const) {
      expect(src, `${nm} 没有「没有载体就跳过」的短路 ⇒ 会对从未发布的行也打一次 MSAF`).toMatch(
        /if\s*\(!targets\.length\)\s*return/
      );
    }
  });
});
