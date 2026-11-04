// @kf-batch 50-P50.3-dataplane
// 数据面下推的**接线覆盖门禁**(P50.3;判据来自 50 SPEC §3.1 / §3.4)。
//
// ── 为什么这一组是文本级 ────────────────────────────────────────────────────
// 仓内没有单测 Next route 的先例(要构造 NextRequest / app-router 上下文),而 `job-service`
// 的两条提交路径要真跑就得把 Glue/S3/DDB/Redshift 四个 SDK 全打桩 —— 那种测试**测的是打桩**。
// 真实行为归本批的真环境无头验收(在 `tgt_usw2_a` 上真跑一个作业到 succeeded)。
// 这里防的是另一类事:**接线被顺手改回去而全绿**。每条都配了负向断言,而且判据都很窄。
//
// 🔴 **先剥注释**(同一教训已第 8 次):本批的说明性注释里就写着被禁的标识符
//    (「原来 glue / redshift-data / dynamodb 共用一个 region」),不剥的话负向断言会咬自己的注释。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

const stripComments = (raw: string) =>
  raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
    .join("\n");

const read = (rel: string) => stripComments(readFileSync(resolve(SRC, rel), "utf8"));

describe("🔴 写入路径:targetId 必须过服务端校验(`{...body}` 展开是 fail-open)", () => {
  // @kf-batch 50-P50.3-multibind —— 判据随合同(S1)从单值升到 `targets[]`。
  it("创建路由:逐个校验 targets,且归一值写在 `...body` **之后**", () => {
    const src = read("app/api/etl-jobs/route.ts");
    // @kf-batch 50-P50.3-fanout —— 判据升到**按引擎**的入口(Glue 只许 home,理由见该函数注释)。
    expect(src, "创建路由没校验绑定 ⇒ 客户端可指定作业在哪些区域跑").toContain("assertBindableTargetsForEngine(");
    const spread = src.indexOf("...body");
    const assign = src.indexOf("targets: boundTargets");
    expect(spread, "找不到 `...body`,判据锚点失效").toBeGreaterThan(-1);
    expect(assign, "没把归一后的 targets 写回 item").toBeGreaterThan(-1);
    expect(assign, "归一值写在展开**之前** ⇒ 会被 body 里的原值覆盖掉,校验白做").toBeGreaterThan(spread);
  });

  it("更新路由:targets 进了白名单,**并且**同一条判据校验过", () => {
    const src = read("app/api/etl-jobs/[id]/route.ts");
    expect(src, "白名单没加 targets ⇒ 改不了执行目标").toMatch(/"scheduleEnabled",\s*"targets"/);
    expect(src, "白名单加了 targets 却没校验 ⇒ 改的口子比建的口子还宽").toContain("assertBindableTargetsForEngine(");
    // @kf-batch 50-P50.3-fanout —— 🔴 引擎必须取**存量行**:`type` 不在可改字段白名单里,
    // 信 body 的 type 等于给了个"声明成 redshift 就能给 Glue 作业绑非 home"的绕过口。
    expect(src, "更新路由从 body 取引擎 ⇒ 客户端声明 type 即可绕过 Glue 只许 home 的限制").toMatch(
      /assertBindableTargetsForEngine\(\s*\n?\s*String\(\(current/
    );
  });

  // @kf-batch 50-P50.3-fanout
  it("🔴 解绑必须连下线一起做(否则那个区继续按 cron 往自己的数仓写数)", () => {
    const src = read("app/api/etl-jobs/[id]/route.ts");
    expect(src, "PUT 改了绑定却不下线被摘掉的 target ⇒ 孤儿 DAG 永久按 cron 跑").toContain("offlineUnboundTargets(");
    expect(src, "删作业不先撤 DAG ⇒ MWAA 继续触发一个已删的作业").toContain("offlineFanout(");
  });
});

describe("🔴 执行路径:手动与调度必须打**同一个** target", () => {
  it("job-service 的两条提交都走 resolveRedshiftBinding,且用**该 target 的**客户端", () => {
    const src = read("lib/etl/job-service.ts");
    // @kf-batch 50-B27-codegen-place —— 本文件现在有**两类**调用:提交路径(正式运行 + 试运行,各带 projectId)
    //   与 Glue 作业定义注入本区数仓事实(`{ targetId: landing.targetId }`,B-27)。分开数,不把总数放宽了事。
    const factInjection = src.match(/resolveRedshiftBinding\(\{ targetId: landing\.targetId \}\)/g) || [];
    expect(factInjection.length, "Glue 作业定义注入本区数仓事实只许一处").toBe(1);
    const bindings = (src.match(/resolveRedshiftBinding\(/g) || []).length - factInjection.length;
    expect(bindings, "正式运行 + 试运行两条路径都必须解析绑定(少一条就会两条路径打不同的区)").toBe(2);
    const viaClient = src.match(/client\.send\(\s*new BatchExecuteStatementCommand/g) || [];
    expect(viaClient.length, "提交没用 per-target 客户端").toBe(2);
    // 🔴 负向:提交绝不许再用模块级 home 客户端
    expect(src, "提交仍用模块级 rsData(home region)⇒ 非 home 作业会打回 home").not.toMatch(
      /rsData\.send\(\s*new BatchExecuteStatementCommand/
    );
    // 🔴 负向:落点解析不许在本文件里另起一条(P50.1 收编的形态)
    expect(src, "job-service 又自己解析了一次 workgroup ⇒ 第二个落点真值源").not.toContain("resolveWorkgroup(");
  });

  it("🔴 轮询必须用**提交时那个 region**(statementId 是 region 内的)", () => {
    const src = read("lib/etl/job-service.ts");
    // @kf-batch 50-P50.3-multibind —— 判据从"最后一个实参是 binding.region"升级为
    // "**两样都传了**"(region 用于查 statementId,targetId 用于补章)。
    // 🔴 本条第一版写成 `[^)]*binding\.region\)` —— 多绑定给轮询加了第 7 个实参后它就不匹配了,
    //    当场把我自己咬红。那是门禁该有的样子(锚点太紧会假红、太松会漏),这里改成不依赖参数个数。
    const polls = src.match(/pollRedshiftRun\([^;]*?\)\s*\.catch/g) || [];
    expect(polls.length, "轮询调用点数变了 ⇒ 判据锚点失效").toBeGreaterThanOrEqual(2);
    for (const call of polls) {
      expect(call, "轮询没带 region ⇒ 非 home 的 statementId 在 home 查不到,run 永远停在 running 且保持持锁").toContain(
        "binding.region"
      );
      expect(call, "轮询没带生效 target ⇒ 回写终态时会把章补成 home").toContain("binding.targetId");
    }
    expect(src, "pollRedshiftRun 没接 region 形参").toMatch(/region\?\s*:\s*string/);
    expect(src, "轮询仍写死用 rsData").toContain("poller.send(new DescribeStatementCommand");
  });

  // @kf-batch 50-P50.3-fanout —— 判据从"调度路由自己解析绑定"移到**扇出作者**身上:
  // 路由现在只调 `publishFanout`,四样的组装在 `lib/etl/dag-fanout.ts`(单一作者)。
  it("扇出作者把四样都喂给 DAG 生成器,并逐 target 指定 targetId/dagId", () => {
    const src = read("lib/etl/dag-fanout.ts");
    expect(src).toContain("resolveRedshiftBinding(");
    for (const k of ["redshiftSecretArn: binding.secretArn", "execRegion: binding.region", "workgroup: binding.workgroup", "database: binding.database"]) {
      expect(src, `DAG 生成器少了 ${k} ⇒ 定时运行会打回 home`).toContain(k);
    }
    // 🔴 逐 target 的两样:少了 targetId ⇒ 锁属性名与章都回落绑定的第一个;少了 dagId ⇒ N 份产物同名互相覆盖
    expect(src, "没逐 target 传 targetId ⇒ 锁属性名与 run 的章都会回落到绑定的第一个").toMatch(/^\s*targetId,\s*$/m);
    expect(src, "没逐 target 传 dagId ⇒ N 个区的 DAG 同名,互相覆盖,只剩最后一个").toMatch(/^\s*dagId,\s*$/m);
    // 🔴 负向:扇出不许直接取 home 的 secret(那样非 home 作业的 DAG 会带 home 的凭证)
    expect(src, "扇出仍直接调 getRedshiftSecretArn ⇒ 绕过了 target 绑定").not.toContain("getRedshiftSecretArn(");
  });

  it("🔴 运行路由缺省扇出到**全部**绑定,不许截成第一个(**Glue 也不例外**,W3-g)", () => {
    const src = read("app/api/etl-jobs/[id]/run/route.ts");
    // 🔴 W3-g 起 Glue 也按 target 执行 ⇒ 那句"glue 只取第一个"的折叠必须**消失**。
    //    用户 2026-09-04 的要求是「多种任务在多个区域都跑成功」——
    //    留着折叠就等于:界面上两个区都亮着,而 Glue 只在第一个区跑(静默漏区)。
    expect(src, "运行默认只跑绑定的第一个 ⇒ 「绑了两个区、只有一个区有数据」会悄悄发生").toMatch(
      /const bound\s*=\s*bindingTargets\(job\)/
    );
    expect(src, "Glue 那一支还在被折叠成绑定的第一个 ⇒ 多区域跑不起来").not.toMatch(
      /job\.type === "glue"\s*\?\s*\[bindingTargets/
    );
    expect(src, "Glue 提交没带 targetId ⇒ 两条 run 都会跑到同一个区").toMatch(
      /runGlueScriptJob\(job,\s*\{[^}]*targetId[^}]*\}\)/
    );
    expect(src, "没有逐 target 提交的循环 ⇒ 根本没扇出").toMatch(/forEachTargetPlace\(\s*runTargets,\s*async \(targetId\) =>[\s\S]*?\{ sequential: true/); // @kf-batch 50-WP31-place-first-class:L10 唯一写法,逐区顺序
    expect(src, "子集校验没了 ⇒ 传个不在绑定里的 target 会被静默忽略(等于「我按你说的跑了」而其实没跑)").toContain(
      "不在该作业的绑定里"
    );
  });

  it("调度路由只经扇出作者下发/下线,不自己再拼一份 S3 写入", () => {
    const src = read("app/api/etl-jobs/[id]/schedule/route.ts");
    expect(src, "发布没走扇出 ⇒ 绑了 N 个区只发第一个(静默漏区)").toContain("publishFanout(");
    expect(src, "下线没走扇出 ⇒ 非 home 那份 DAG 永久留在 MWAA 里按 cron 跑").toContain("offlineFanout(");
    // 🔴 负向:路由里不许再有第二条 DAG 写入路径(那正是 33-B 消灭副本要防的形态)
    expect(src, "调度路由又自己 PutObject 一份 DAG ⇒ 与扇出作者两个副本,必然漂移").not.toContain("PutObjectCommand");
    expect(src, "调度路由自己调生成器 ⇒ 绕过扇出").not.toContain("generateEtlJobDag(");
  });
});

// @kf-batch 50-P50.3-multibind
describe("🔴🔴 绑定只有一个真值源:生产代码不许直读 `job.targetId`", () => {
  // 【这条门禁是被自己咬出来的】W3-b 把绑定从单值 `targetId` 迁到 `targets[]` 之后,
  // 有两处仍在直读 `job.targetId` ⇒ 拿到 `undefined` ⇒ **绑了 us-west-2 的作业静默发出 home 的 DAG**。
  // tsc 全绿、单测全绿(可选字段读 undefined 完全合法),只有真跑才会发现定时运行打回了 home。
  // ⇒ 唯一能结构性挡住的办法:把"只许走归一口 `bindingTargets()`"做成机械断言。
  const FILES = [
    "lib/etl/job-service.ts",
    "lib/etl/dag-generator.ts",
    "lib/etl/dag-fanout.ts",
    "app/api/etl-jobs/[id]/schedule/route.ts",
    "app/api/etl-jobs/[id]/run/route.ts",
  ];
  // 🔴 判据用**允许列表**,不是禁止列表。第一版写 `not.toMatch(/\bjob\.targetId\b/)`,
  //    结果变异 M64 用 `(job as { targetId?: string }).targetId` 就绕过去了、门禁全绿 ——
  //    禁止列表在承重面上永远漏(与 §1.1 的 `RECONCILE_ALLOWED_FIELDS` 同一条教训)。
  //    改成:凡出现 `.targetId` 读取,其**前缀**必须在允许集合里。
  // 允许持有者:全部**不是作业行** —— `binding`(解析结果)/`opts`/`args`(入参)/`run`(run 记录)/
  // `res`(运行结果)/`row`(扇出预览行)/`fail`(失败行)/`d`/`x`/`cur`/`item`(局部投影)。
  // `landing` = `resolveGlueBinding()` 的解析结果(Glue/EMR 侧的 binding,W3-g 新增)——
  // 与 `binding` 同类:它**已经是解析出来的落点**,不是作业行上的单值字段。
  const ALLOWED_TARGETID_OWNERS = new Set([
    "binding", "landing", "opts", "args", "run", "res", "row", "fail", "d", "x", "cur", "item",
  ]);
  // 🔴 **同时**钉住反向:作业行的常见标识符**绝不许**出现 `.targetId` 读取。
  //    允许列表管"新写法会不会漏",这一条管"有人把作业行改叫 `row` 也不行"。
  const JOB_ROW_IDENTIFIERS = ["job", "current", "Item", "sel", "saved", "del", "j", "wf"];
  it.each(FILES)("%s 的 .targetId 读取只出现在允许的持有者上(不许直读作业行)", (rel) => {
    const src = read(rel);
    const owners = [...src.matchAll(/([A-Za-z_$][\w$]*)\s*(?:as\s+[^)]*\)?)?\s*\)?\.targetId\b/g)].map((m) => m[1]);
    const bad = owners.filter((o) => !ALLOWED_TARGETID_OWNERS.has(o));
    expect(
      bad,
      `这些持有者直读了绑定字段:${bad.join(",")} —— 迁到 targets[] 后会拿到 undefined,` +
        "于是绑了非 home 的作业**静默按 home 处理**(不报错,只是打回了 home)"
    ).toEqual([]);
    const jobRowReads = owners.filter((o) => JOB_ROW_IDENTIFIERS.includes(o));
    expect(jobRowReads, `直读了作业行的单值绑定字段:${jobRowReads.join(",")}`).toEqual([]);
  });

  it("归一口自己必须同时认三种形态(targets / 单值 targetId / 都没有)", () => {
    const src = read("lib/exec-env/data-plane-target.ts");
    expect(src).toContain("export function bindingTargets(");
    expect(src, "归一口不看 targets ⇒ 合同字段读不到").toMatch(/row\?\.targets/);
    expect(src, "归一口不看单值 targetId ⇒ W3-a 已经在真环境产生的行会被当成 home").toMatch(/row\!?\??\.targetId/);
    expect(src, "归一口没有 home 缺省 ⇒ 存量行会得到空数组").toContain("HOME_TARGET_ID");
  });

  it("写入路径只写 targets,不写单值字段(两个字段同时可写 = 两个说法)", () => {
    const create = read("app/api/etl-jobs/route.ts");
    expect(create).toContain("targets: boundTargets");
    expect(create, "创建仍写单值字段 ⇒ 两个真值源").toMatch(/targetId:\s*undefined/);
    const put = read("app/api/etl-jobs/[id]/route.ts");
    expect(put).toMatch(/"scheduleEnabled",\s*"targets"/);
    expect(put, "更新白名单里还留着单值字段").not.toMatch(/"targetId"/);
  });
});

describe("🔴 绑定被拒必须是 4xx,不是 500(真环境验收 W3a-9 暴露出来的)", () => {
  // 【为什么值得一条门禁】`TargetBindingRejected` 全是**用户可修**的原因:目标没装 redshift /
  // 落点冲突 / 缺凭证 / 跨法域。混进 500 会把人引去查平台故障 —— 而正确处置是换目标或清字段。
  // 这类"错误分类错了"的问题不会让功能挂,只会让每次排障多花半小时,所以只能靠门禁钉。
  // @kf-batch 50-P50.3-fanout —— 🔴 两条路由的**结构不同**,不能再用一条"隔多远"的窗口判据:
  // 扇出把运行路径拆成了「逐 target 收集 → 统一判 allRejected」,原来的 300 字符窗口当场假红,
  // 而我为修它写的负向正则又把调度路由的正常写法误判成红(它紧邻着一个 500 的兜底分支)。
  // ⇒ 拆成两条,各自钉自己那一处的**判据来源**,不猜距离。
  it("run 路由:逐 target 记录 rejected,且「全被拒」时回 409(不是 500)", () => {
    const src = read("app/api/etl-jobs/[id]/run/route.ts");
    expect(src, "没识别绑定被拒 ⇒ 会当成 500").toContain("e instanceof TargetBindingRejected");
    expect(src, "没把「是否可修」逐 target 记下来").toMatch(/rejected:\s*e instanceof TargetBindingRejected/);
    expect(src, "没有「全被拒 ⇒ 409」这条分支").toMatch(/allRejected[\s\S]{0,200}?409/);
  });

  it("schedule 路由:instanceof 分支紧跟 409", () => {
    const src = read("app/api/etl-jobs/[id]/schedule/route.ts");
    const i = src.indexOf("instanceof TargetBindingRejected");
    expect(i, "没识别绑定被拒 ⇒ 会当成 500").toBeGreaterThan(-1);
    expect(src.slice(i, i + 200), "识别了却没在同一分支里给 409").toContain("409");
  });

  it("创建/更新路由同样给 4xx(400 校验类 / 409 冲突类)", () => {
    for (const rel of ["app/api/etl-jobs/route.ts", "app/api/etl-jobs/[id]/route.ts"]) {
      const src = read(rel);
      expect(src, `${rel} 没把绑定被拒映射成 409`).toMatch(/TargetBindingRejected[\s\S]{0,200}?409/);
    }
  });
});

// @kf-batch 50-P50.3-mrquery
describe("🔴🔴 读回**存储的 statementId** 时必须解出它自己的 region(2026-09-04 用户实测报的 bug)", () => {
  // 【事故经过】用户第一次自己点页面就撞上:非 home 的 Redshift 作业点「日志」显示
  // 「无法获取语句详情: Query does not exist.」。根因 = `statementId` 是 **region 内**的,
  // 而"读回 run 记录再 Describe"的路径全都在用**模块级 home 客户端**。
  //
  // 🔴 同源的第二处**更严重**、用户还没撞上:`reconcileEtlJob`(刷新作业列表时的读时对账)
  // 把 `does not exist` 当成"执行记录已过期"⇒ **把一条其实成功的 run 写成 failed**。
  // 日志那处只是显示不出来,这处是**写坏状态**。
  //
  // 🔴 为什么之前的门禁没挡住:W3-a 只钉了「**提交侧**的轮询」(`pollRedshiftRun` 带 region),
  // 而"**事后**读回 run 记录再查"是另一条路径,当时根本没进视野。
  // ⇒ 这条门禁按**允许列表**列出"所有读 `run.statementId` 的文件",逐个要求它解 region。
  const RUN_READERS = [
    "app/api/etl-jobs/[id]/logs/route.ts",
    "lib/etl/job-service.ts",
    "lib/diagnostics/evidence.ts",
  ];
  it.each(RUN_READERS)("%s 读 run.statementId 时用 redshiftClientForTarget 解 region", (rel) => {
    const src = read(rel);
    expect(src, "该文件不再读 run.statementId ⇒ 判据锚点失效,请更新 RUN_READERS").toContain("run.statementId");
    expect(src, "用模块级 home 客户端 Describe 存储的 statementId ⇒ 非 home 一律 `Query does not exist`").toContain(
      "redshiftClientForTarget("
    );
    // 🔴 负向:Describe 不许直接打在模块级 home 客户端上
    expect(src, "仍有 `rsData.send(new DescribeStatementCommand` ⇒ 那条路径没修").not.toMatch(
      /rsData\.send\(\s*new DescribeStatementCommand/
    );
  });

  it("🔴 对账解不出 region 时**什么都不写**(写状态的路径不许在没确认的情况下下结论)", () => {
    const src = read("lib/etl/job-service.ts");
    expect(src, "解 region 失败没有 fail-closed 分支 ⇒ 会退回旧行为把 run 判成 failed").toMatch(
      /catch[\s\S]{0,240}?本轮不改状态/
    );
    expect(src, "没有「解出来了才查」的门 ⇒ 解析失败时仍会走判定分支").toMatch(/if \(rsForRun\) \{/);
  });

  it("🔴 `redshiftClientForTarget` 解不出 region 时**抛**,不回落 home(回落就是这个 bug 本身)", () => {
    // @kf-batch 50-WP31-place-first-class —— 🔴 判据改锚到**它要判的那两个函数体**:原来那条正则在整篇上
    //   开 400 字符窗口,实际命中的是 `resolveRedshiftBinding` 上面一个**别的函数**的报错串(假绿;
    //   WP-31 在那附近加了一行就露馅)。现在:redshiftClientForTarget 只经 regionOfTarget 取区,
    //   而 regionOfTarget 缺 region 时抛 TargetBindingRejected(不回落)。
    const src = read("lib/exec-env/data-plane-target.ts");
    const fnBody = (s: string, sig: string) => {
      const i = s.indexOf(sig);
      expect(i, `找不到 ${sig}`).toBeGreaterThan(-1);
      return s.slice(i, s.indexOf("\n}\n", i));
    };
    const client = fnBody(src, "export async function redshiftClientForTarget(");
    expect(client).toMatch(/redshiftDataClientFor\(await regionOfTarget\(/);
    const region = fnBody(read("lib/exec-env/target-region.ts"), "export async function regionOfTarget(");
    expect(region, "regionOfTarget 缺 region 时回落 home ⇒ 又变成拿 home 客户端查别的区").toMatch(
      /if \(!region\) \{[\s\S]{0,300}?throw new TargetBindingRejected/
    );
  });

  it("🔴🔴 Glue 侧**每一处**都按 target 建客户端(W3-g 放开非 home 之后,home 客户端就是 bug 源)", () => {
    // 🔴 这条门禁替换了原来那条「Glue 结构上只在 home ⇒ 用 home 客户端是对的」——
    //    W3-g 放开了非 home,于是那个"前提"不成立了。现在要钉的是**反面**:
    //    · 写入路径不许再把 glue 折叠成 home;
    //    · 执行/对账/取日志三处都必须经 per-target 客户端;
    //    · 文件里**不许再有模块级 home 客户端**(有一个,就会有人顺手用它)。
    const dpt = read("lib/exec-env/data-plane-target.ts");
    expect(dpt, "还在把 glue 的绑定折叠成 home ⇒ 多区域 Glue 根本绑不上").not.toMatch(
      /if \(engine === "glue"\)[\s\S]{0,600}?return \[HOME_TARGET_ID\]/
    );
    expect(dpt, "缺少 Glue 落点解析出口 ⇒ 每处又要自己拼 region/桶/角色").toContain("export async function resolveGlueBinding(");

    const js = read("lib/etl/job-service.ts");
    expect(js, "Glue 运行锁必须按**这次跑的 target** 算(定时/手动同一口径,否则互斥失效)").toMatch(
      /acquireJobRunLock\(TABLES\.ETL_JOBS, job\.jobId, runLockWaitMs\(triggeredBy\), targetId\)/
    );
    expect(js, "章还钉死 home ⇒ 非 home 的 Glue run 在监控页会被当成 home 的").not.toMatch(
      /createRunRecord\([^;]*"etl-glue"[^;]*HOME_TARGET_ID\)/
    );
    // 🔴 负向:模块级 home 客户端必须**不存在**(它们是这一类 bug 的唯一来源)
    for (const bad of ['const glue = new GlueClient(', 'const s3 = new S3Client(', 'const rsData = new RedshiftDataClient(']) {
      expect(js, `job-service 里还留着模块级客户端 ${bad} ⇒ 谁顺手用一下,非 home 就静默打回 home`).not.toContain(bad);
    }
    // 对账两半都必须按 run 的 target 解析(Glue 那半原来用的是 home 客户端 ⇒ 会把成功写成 failed)
    expect(js, "Glue 对账没按 run 的区域解析 ⇒ 非 home 成功的 run 被写成 failed").toContain("glueClientForTarget(");

    const logs = read("app/api/etl-jobs/[id]/logs/route.ts");
    for (const bad of ['const glue = new GlueClient(', 'const cwl = new CloudWatchLogsClient(']) {
      expect(logs, `日志路由还留着模块级客户端 ${bad} ⇒ 非 home 取到的是**别的区域的空日志**`).not.toContain(bad);
    }
    expect(logs, "日志路由没按 target 建 CloudWatch 客户端 ⇒ 空日志与「作业没输出」无法区分").toContain("logsClientFor(");
  });
});

describe("🔴 DAG 的控制面 region 不许跟着 target 走", () => {
  it("生成器里 dynamodb 绑 CTRL_REGION、glue/redshift-data 绑 EXEC_REGION", () => {
    const src = read("lib/etl/dag-generator.ts");
    expect(src).toContain('ddb = boto3.resource("dynamodb", region_name=CTRL_REGION)');
    expect(src).toContain('glue = boto3.client("glue", region_name=EXEC_REGION)');
    expect(src).toContain('rsdata = boto3.client("redshift-data", region_name=EXEC_REGION)');
    // 🔴 负向:整个文件里不许出现"dynamodb 用 EXEC_REGION"
    expect(src, "作业锁落到执行 region ⇒ 跨执行体互斥失效(裂缝C 事故复活),而且不报错").not.toMatch(
      /dynamodb"?,\s*region_name\s*=\s*EXEC_REGION/
    );
    // 🔴 负向:旧的单 region 变量不许残留(残留说明拆得不彻底)
    expect(src, "还留着单一 region 变量的 python 赋值 ⇒ 拆分没做干净").not.toMatch(/^region = "/m);
  });
});

describe("🔴 呈现端点不许要管理员权限(否则多区域被锁死在管理员手里)", () => {
  it("/api/exec-targets 用 requireProject(viewer),不是 requireExecEnvAdmin", () => {
    const src = read("app/api/exec-targets/route.ts");
    expect(src).toContain('requireProject(req, "viewer")');
    expect(src, "数据面选目标要管理员 = 普通开发者用不了多区域").not.toContain("requireExecEnvAdmin");
    // 🔴 负向:不许回资源袋/凭证(呈现端点的最小面)
    expect(src, "呈现端点回了资源袋/凭证 ⇒ 越界").not.toMatch(/resources|secretArn/);
    // 读失败不许静默回空列表(空列表在界面上等于"只有 home 可选")
    expect(src).toMatch(/catch[\s\S]{0,300}apiError/);
  });
});

// @kf-batch 50-P50.3-engines
describe("🔴🔴 EMR Serverless 也必须逐 target(用户 2026-09-04:三种任务类型都要在多个区域跑成功)", () => {
  it("provider 里**不许有模块级 home 客户端**,且 application/日志/对账全按 run 的 target 解析", () => {
    const src = read("lib/engines/emr/provider.ts");
    for (const bad of ["const emr = new EMRServerlessClient(", "const s3 = new S3Client("]) {
      expect(src, `EMR provider 还留着模块级客户端 ${bad} ⇒ 非 home 的 job-run 一律 ResourceNotFound(而"找不到"在轮询里长得像"还在跑")`).not.toContain(bad);
    }
    expect(src, "没有按 run 反解执行上下文 ⇒ 改一次绑定就把历史 run 的对账/日志指到别的区").toContain("async function runCtx(");
    // 🔴 光有这个函数不够 —— **每处读侧都得真调它**(poll / stop / readLogs 三处)。
    //    只断"函数存在"是弱断言:把调用换回 `j.applicationId` 也照样绿。
    expect(
      (src.match(/await runCtx\(/g) || []).length,
      "poll / stop / readLogs 至少三处必须按 run 的 target 解析"
    ).toBeGreaterThanOrEqual(3);
    expect(src, "对账没按 run 的 region 建客户端 ⇒ 非 home 的 run 永远卡 running").toMatch(
      /reconcile[\s\S]{0,900}?emrServerlessClientFor\(landing\.region\)/
    );
    expect(src, "没把 S3Tables jar 备到该 target 的桶 ⇒ 非 home 的 run 在拉 jar 那步失败").toContain("ensureS3TablesJar(landing");
    expect(src, "提交没带 targetId ⇒ 两个区的 run 会都建在 home").toMatch(/const targetId = \(opts as \{ targetId\?: string \}\)\.targetId \|\| "tgt_home"/);
    expect(src, "锁属性没按 target ⇒ 定时与手动算出不同属性名,互斥失效").toMatch(
      /acquireJobRunLock\(TABLES\.ENGINE_JOBS, j\.jobId, emrRunLockWaitMs\(triggeredBy\), targetId\)/
    );
    // @kf-batch 50-W3f-T0-T3 —— T2 之后第 7 个实参是 runGroupId(只透传);target 仍必须钉在第 6 位。
    expect(src, "run 记录没盖这次真跑的 target ⇒ 监控页按区筛静默少报").toMatch(
      /createRunRecord\([^;]*triggeredBy, targetId(?:, opts\.runGroupId)?\)/
    );
    expect(src, "删作业只删了一个 application ⇒ 别的区留孤儿(还占额度)").toContain("allApplicationRefs(");
  });

  it("🔴 application / 脚本 / jar / 网络 四样都按 target(少一样就是「看起来在那个区跑」)", () => {
    const app = read("lib/engines/emr/application.ts");
    expect(app, "application id 没按 target 存 ⇒ 拿 home 的 id 去别的区查,必然重建出孤儿").toContain("export function applicationIdOf(");
    // 🔴 断**行为**不断注释:非 home 且没有该 target 的网络事实 ⇒ 必须 throw(不许回落 home 的子网)
    // 🔴 必须钉住**那个谓词本身**:第一版写成 `if (landing && !landing.home)[\s\S]{0,400}?throw`,
    //    而把内层判断改成 `if (false)` 之后外层 if 与 throw 都还在 ⇒ 正则照样匹配、变异不红(M132)。
    //    又一次同族的弱断言:**跨过被改掉的那一行去匹配后面的东西**。
    const appNoComments = app.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      appNoComments,
      "非 home 缺网络事实时没有 fail-closed ⇒ 会回落 home 的子网,把作业挂进**另一个 VPC**"
    ).toMatch(
      /if \(!\(targetNetwork\?\.subnetIds\?\.length && targetNetwork\?\.securityGroupIds\?\.length\)\)\s*\{\s*throw new Error/
    );
    const script = read("lib/engines/emr/script.ts");
    expect(script, "脚本桶没按 target ⇒ 非 home 的 run 去 home 的桶找 entryPoint").toContain("s3ClientFor(");
    expect(script, "S3Tables jar 没按 target 备好 ⇒ 非 home 的 run 在拉 jar 那步就失败").toContain("export async function ensureS3TablesJar(");
  });

  // @kf-batch 50-P50.3-mirror
  it("🔴 跨地域元数据镜像:读端点 viewer 可看、写端点管理员、payload 只经 sanitizer", () => {
    // ① 读端点**不许**落在 `/api/admin/**`(middleware 把那一整段强制 bgp-admin ⇒
    //    看板就成了非管理员点不开的死按钮。与 `/api/exec-targets` 同一条判据)
    const readSrc = read("app/api/metadata-mirror/route.ts");
    expect(readSrc, "呈现端点没用 viewer 门 ⇒ 普通开发者看不到跨地域总览").toContain('requireProject(req, "viewer")');
    expect(readSrc, "读端点要管理员 = 多区域看板被锁死在管理员手里").not.toContain("requireExecEnvAdmin");
    expect(readSrc, "读失败回了空总览 ⇒ 界面上等于「那些区没有资产」(假绿)").toMatch(/catch[\s\S]{0,400}?502/);

    // ② 写端点(会真打那个区的 API、数仓那一路还唤醒 Serverless 数仓 = 花钱)必须管理员
    const write = read("app/api/admin/metadata-mirror/route.ts");
    expect(write, "采集端点没有管理员门 ⇒ 任何成员都能触发跨区 API 调用与数仓唤醒").toContain(
      "requireExecEnvAdmin(req)"
    );
    expect(write, "sources 没走允许列表 ⇒ 客户端能塞任意来源名").toContain("MIRROR_SOURCES");

    // ③ 🔴 条目 payload **只能**由 sanitizer 重建(白名单重建,不是过滤)——
    //    加一种条目类型时若直接写字面量对象,行数据/抽样值就能顺着进中央镜像。
    // 🔴 两个采集层都要数:数仓那一半在 W3-e 的编译边界整改里搬去了 `metadata-mirror-warehouse.ts`
    //    (见那个文件的文件头)。判据是「**所有** payload 构造点都过 sanitize」,不是「某个文件里有 4 个」。
    const lib = read("lib/exec-env/metadata-mirror.ts");
    const wh = read("lib/exec-env/metadata-mirror-warehouse.ts");
    const viaSanitizer = (lib + wh).match(/payload:\s*sanitize(Table|Db)Payload\(/g) || [];
    expect(
      viaSanitizer.length,
      "条目 payload 的构造点数变了 —— 每一个都必须过 sanitize*(否则「只搬元数据」这条边界只靠自觉)"
    ).toBe(4);
    for (const [name, src2] of [["metadata-mirror", lib], ["metadata-mirror-warehouse", wh]] as const) {
      expect(src2, `${name} 里有条目用字面量对象当 payload ⇒ 绕过了白名单重建`).not.toMatch(
        /entries\.push\(\{[\s\S]{0,240}?payload:\s*\{/
      );
    }

    // ④ 🔴 读侧必须**自己判 ttl**:DDB 的 TTL 删除最长滞后 48h,过期条目照样会被 Query 返回
    expect(lib, "下钻不自己判 ttl ⇒ 会把过期(正在半消失)的镜像条目当有效数据列出来").toMatch(
      /raw\.ttl \* 1000 <= Date\.now\(\)/
    );

    // ⑤ 🔴 定时刷新失败不许拖垮探活:镜像 tick 必须在自己的 try/catch 里、且只在 leader 跑
    const loop = read("lib/exec-env/reconciler-loop.ts");
    expect(loop, "镜像 tick 没被独立 try/catch 包住 ⇒ 一个看板的异常会掀翻周期探活").toMatch(
      /if \(s\.leader\) \{\s*try \{\s*const m = await runMirrorTick\(\)/
    );
    expect(loop, "镜像 tick 没有预算上限 ⇒ 采集慢就会把 leader 租约拖掉(探活也停)").toContain(
      "MIRROR_TICK_BUDGET_MS"
    );
  });

  it("🔴 engine-job 的运行路由必须扇出,且绑定校验与 etl-jobs 同一个作者", () => {
    // B-136:提交段(逐区循环 / partial 回报)在长操作执行体;路由只留快校验(targets 子集解析仍在路由)
    const run = read("lib/engines/long-ops.ts");
    expect(read("app/api/engines/[engine]/[id]/run/route.ts"), "路由仍要解析 targets 子集并全部传给执行体").toMatch(/runTargets/);
    expect(run, "没有逐 target 提交的循环 ⇒ 绑了两个区只跑一个").toMatch(/forEachTargetPlace\(\s*runTargets,\s*async \(targetId\) =>[\s\S]*?\{ sequential: true/); // @kf-batch 50-WP31-place-first-class:L10 唯一写法,逐区顺序
    expect(run, "部分失败没如实回报 ⇒ 把「2 个区跑成 1 个」说成成功").toContain("partial");
    const create = read("app/api/engines/[engine]/route.ts");
    expect(create, "创建时不校验 targets ⇒ 客户端塞什么都原样落库,下次运行才发作").toContain("assertBindableTargetsForEngine(");
  });
});

// @kf-batch 50-W5-seg1-WP3 —— 执行角色的 env 字面**单作者**(SPEC v3.21 §6.1 段二落地口径 3)
describe("🔴🔴 WP-3 per-target 执行角色:env 字面只许出现在 target-clients.ts,EMR 提交 / 调度按 target 解析角色", () => {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
      const fp = resolve(dir, e);
      if (statSync(fp).isDirectory()) walk(fp, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(fp);
    }
    return acc;
  };
  const files = walk(SRC);

  it("`process.env.EMR_EXECUTION_ROLE_ARN` 全 src 只在 lib/exec-env/target-clients.ts(留第二处 = 留一个非 home 也顺手用 home 角色的口子)", () => {
    expect(files.length, "扫到的源文件太少 ⇒ 路径错了").toBeGreaterThan(200);
    const hits = files.filter((fp) => read(fp.slice(SRC.length + 1)).includes("EMR_EXECUTION_ROLE_ARN")).map((fp) => fp.slice(SRC.length + 1));
    // 允许:单作者 + 两处只在**报错文案**里提到它(「EMR_EXECUTION_ROLE_ARN 未配置」是给运维看的字,不是读 env)
    const allowed = new Set(["lib/exec-env/target-clients.ts", "lib/engines/emr/provider.ts", "app/api/engines/[engine]/[id]/schedule/route.ts", "lib/engines/emr/spec.ts", "components/engines/EmrJobPanel.tsx"]);
    expect(hits.filter((h) => !allowed.has(h)), "有新文件直接读 EMR 执行角色 env").toEqual([]);
    for (const h of ["lib/engines/emr/provider.ts", "app/api/engines/[engine]/[id]/schedule/route.ts"]) {
      expect(read(h), `${h} 仍在读 process.env.EMR_EXECUTION_ROLE_ARN ⇒ 非 home 会拿 home 的角色`).not.toContain("process.env.EMR_EXECUTION_ROLE_ARN");
    }
    expect(read("lib/exec-env/target-clients.ts")).toContain("process.env.EMR_EXECUTION_ROLE_ARN");
  });

  it("EMR provider 的提交按 target 解析执行角色(resolveEmrBinding),customRole 之外只用 landing.executionRoleArn", () => {
    const src = read("lib/engines/emr/provider.ts");
    expect(src).toContain("resolveEmrBinding({ targetId })");
    // 序 72 B-139:「自定义优先 || 回退该 target 角色」收口到单一作者 resolveExecutionRoleArn,回退值仍只许是 landing.executionRoleArn
    expect(src).toMatch(/resolveExecutionRoleArn\(\{[\s\S]{0,200}fallback: landing\.executionRoleArn/);
    expect(src, "模块级 EXEC_ROLE_ARN 常量必须消失").not.toMatch(/^const EXEC_ROLE_ARN/m);
  });

  it("调度扇出(每个 target 自己的 MWAA,WP-13)逐 target 经 resolveEmrBinding 取**该 target** 的角色,不再自己读 env / 不再钉 home", () => {
    const src = read("lib/engines/emr/schedule-fanout.ts");
    expect(src).toContain("resolveEmrBinding({ targetId })");
    // 序 72 B-139:「自定义优先 || 回退该 target 角色」收口到单一作者 resolveExecutionRoleArn,回退值仍只许是 landing.executionRoleArn
    expect(src).toMatch(/resolveExecutionRoleArn\(\{[\s\S]{0,200}fallback: landing\.executionRoleArn/);
    expect(src, "调度不许再钉 home 角色").not.toContain("resolveEmrBinding({ targetId: HOME_TARGET_ID })");
    const route = read("app/api/engines/[engine]/[id]/schedule/route.ts");
    expect(route).toContain("publishEmrFanout(");
    expect(route).not.toContain("process.env.EMR_EXECUTION_ROLE_ARN");
  });

  it("Spark 落点对非 home 断言 per-target 角色名(assertPerTargetExecRole),不再裸 requireStringResource(glueRoleArn)", () => {
    const src = read("lib/exec-env/target-clients.ts");
    expect(src).toContain('assertPerTargetExecRole(t, "glueRoleArn")');
    expect(src).toContain('assertPerTargetExecRole(t, "emrExecutionRoleArn")');
    expect(src, "glueRoleArn 又回到裸取值 ⇒ home 名的共享角色会被非 home 继续用").not.toContain('requireStringResource(t, "glueRoleArn")');
  });

  it("EMR 绑定校验在**绑定那一刻**就核执行角色(免得「绑得上、跑不了」)", () => {
    const src = read("lib/exec-env/data-plane-target.ts");
    expect(src).toMatch(/if \(engine === "emr-serverless"\) for \(const t of ok\) await resolveEmrBinding\(\{ targetId: t \}\)/);
  });

  it("窄通道对执行角色键走 SSOT 判定(execRoleRotationVerdict),其余键照旧只增不改", () => {
    const src = read("lib/exec-env/registry.ts");
    expect(src).toContain("execRoleRotationVerdict(targetId, k, before, v)");
    expect(src).toContain("if (isExecRoleResourceKey(k))");
  });
});
