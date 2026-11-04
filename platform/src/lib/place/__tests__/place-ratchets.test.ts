// 落点一等化的**只减不增棘轮**(① 每条规则「今天的数字 → 目标」)。
//
// 🔴 每个数字都是**恰好等于**(不是 ≤):迁移掉一处就必须同笔把数字改小 —— 名单不许腐烂,
//    也不许「先降到 80 再悄悄长回 90」。数字变大 = 有人又按主控区默认的写法加了新代码。
// 🔴 数字变化要分清「东西多了」还是「量具看见得多了」(gate-enumerates-violations-not-legal-form):
//    改本文件的扫描规则时,同一笔提交里写明旧规则下的数是多少。
//
// 2026-10-01 基线(落地时,剥注释后的实数)。立包时写的 108/55 · 95 · 292 · 19 · 386 是**未剥注释的 grep 粗数**,
// 量具不同不可比 —— 以本文件为准(L1 那条粗数把 `targetId?: unknown` 这类输入行形状也算进去了)。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import ts from "typescript";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const NAMING = JSON.parse(readFileSync(resolve(SRC, "../naming.json"), "utf8")) as {
  kinds: Record<string, { home: string }>;
};

/** 唯一允许 `new XxxClient(` 的文件(L3)。 */
const FACTORY = "lib/aws/clients.ts";

/** 唯一允许读进程区变量(`BGP_HOME_REGION` / `AWS_REGION` / `AWS_DEFAULT_REGION`)的文件(L4 闭合门)。 */
const HOME_REGION_AUTHOR = "lib/place/home-region.ts";

const BASELINE = {
  /** L3:工厂之外散建的 AWS SDK 客户端(处 / 文件)。
   *  2026-10-11 量具换成 **AST**(TypeScript 解析 `new X(` 且 X 来自 `@aws-sdk/client-*`):旧的「剥注释 + 正则」量具
   *  被注释里的 `/api/redshift/*` 当成块注释开头、把 athena/client.ts 的 import 整段吞掉 ⇒ 旧量具 113 / 58,同一棵树
   *  AST 量具 115 / 59(多看见 athena/client.ts 的 2 处 —— 量具看见得多了,不是东西多了)。
   *  2026-10-11 115 / 59 → 36 / 6(收尾:79 处迁到 `lib/aws/clients.ts#sdkClient`,构造参数原样、按用途分类)。
   *  剩下的 36 / 6 全在**另一个施工包正在改**的执行环境部署 / 探测 / 成本文件里(probe-runner 18 · deploy-control 7 ·
   *  seed-home 7 · stack-outputs 2 · finops/collector 1 · admin/exec-envs/candidate-regions 1),本笔刻意不碰以免冲突;
   *  这不是豁免 —— 它们照样计数,迁一处减一处。 */
  //   2026-10-11 36 / 6 → **0 / 0**:执行环境部署 / 探测 / 成本那 6 个文件也迁进 `sdkClient`(按用途分类
  //   探测本 target 资源 = data-plane;IAM / Route53 / CFN / CodeBuild / Lambda / CE / DescribeRegions = control-plane;
  //   AgentCore 控制面 = central:agentcore)⇒ **闭合门**:工厂之外再出现一处 `new XxxClient(` 就红。
  //   为什么现在必须归零:数据面凭证(代入本 target 的平台数据面角色)**只在工厂里注入**,散建一处就是一处绕过。
  bareClients: 0,
  bareClientFiles: 0,
  /** L4:读进程环境里的默认区 */
  envRegionReads: 2, // 2026-10-11 78 → 2(L4 收口):全部迁到唯一作者 lib/place/home-region.ts(homeRegion / homeRegionOf / homeRegionOrEmpty),剩下的 2 处就在它里面;🔴 同笔加了 AST 闭合门(下方 L4 闭合门),量具看见得更多:旧正则看不见的两处也一并迁走:`env.AWS_REGION`(control-plane-regions 注入 env)· lib/athena/client.ts(注释里的 `/api/redshift/*` 让剥注释正则把它吞了)⇒ 实际迁移 80 处
  // 2026-10-11 81 → 78(合并 integ/seq35):finops/cost-region 收成 homeRegion()(−1)+ 后一半 模型目录 / 模型探测改从描述符取区(−2)
  // 2026-10-01 82 → 81:ensureApplication 去掉「没传落点 = process.env.AWS_REGION」
  /** L2:主控区分支(`isHome(` / `HOME_TARGET_ID`) */
  // 2026-10-24 259 → 257(-2):probeEnvironment 的决策改记**真实落点**(req.targetId),HOME_TARGET_ID 引用 + import 两处退场
  homeBranches: 257, // 2026-10-23 257 → 259(+2):lib/network-advisor/environment-probe.ts
  //   `probeEnvironment` 开头 `notePlaceDecision({ targetId: HOME_TARGET_ID, … homeReason })` 一处 + 它的 import 一处(量具对 import 也计数,
  //   与 start-run.ts 那条「import 1」同口径)—— 不是分支、不是回落:L1 探测的 EC2 客户端本来就是模块级主控区客户端,这一笔只是把事实
  //   写进账本(观测器归因);非主控区网络事实的缺口登记。
  // 2026-10-20 256 → 257:lib/exec-env/data-plane-target.ts
  //   `listComponentCapableTargets` 的 airflow 维度谓词「主控区恒列」一处 —— 与写路径同口径(新建编排 `requireMwaaForTargets`
  //   只核非 home 的调度组件,列表不许比写路径更严);落点仍是注册表里的那一行,不是「没传 = 回落主控区」。
  // 2026-10-20 255 → 256:图形化改表 lib/modeling/alter-service.ts 一处
  //   home 直跑 / 非主控区经 admin 执行器 `alter-model-table`,与 landing.ts `landOne` 同形(落点仍是入参 targetId,不是回落默认值);
  //   catalog-ddl.ts 的 home 判断改用 `binding.home`,没有再加一处。
  // 2026-10-12 254 → 255:**量具看见得多了,不是分支多了**
  //   同步启动路由里原有的 `isHome(tid)`(zero-etl 通道卡)一直被量具的注释剥离吃掉:路由里有个字符串 `bucket/*`,
  //   `strip()` 把它当成块注释开头一路剥到后面某个 `*/`。那段代码搬到 lib/sync/start-run.ts 后这一处重新被数到。
  //   主控区分支实数不变(路由里仍是那 4 处:import 1 + zero-etl 卡 1 + zero-etl 盖章 2)。
  // 2026-10-11 261 → 254(合并 integ/seq35):−11(下两行)+ o4-REG +1 + CAP-SEED +1 + +2(再下几段)
  //   2026-10-11 256 → 250(后一半):fetchCatalog / probeModel 去掉「没给 = 主控区」· 目录路由删掉无用的 HOME_TARGET_ID · 探测路由只剩一处显式点名
  // 2026-10-11 261 → 256(收尾 · Flink 主控区分支改走描述符):resolveFlinkPlace 的 isHome 分支 + 两处 HOME_TARGET_ID ·
  //   resolveTargetFlink 的主控区 env 分支 · 新建实时作业「主控区跳过真解析」(`t === HOME_TARGET_ID`)
  //   2026-10-11 262 → 263(+1,CAP-SEED):`seedKindOf` —— 主控区造数 = 灌**源库**(bgp-game-seed)、
  //   其它区 = 写**该区湖**(bgp-game-seed-<targetId>),是两种作业(部署期两支脚本各建一种),不是缺省回落;
  //   作业名 / 启动参数 / 页面「会重写什么」都从这一处来(落点仍必填:requestedTargetId,不给 ⇒ 400)。
  //   2026-10-11 261 → 262(+1,o4-REG):`syncOmPlaceIsHome` —— 同步推 OM 的坐标「主控区逐字节沿用存量 FQN」
  //   (零迁移硬要求:主控区 OM 里已有的同步表 / 血缘 FQN 不许变);整条链路(启动推送 / 物理端点 / 成功回填)只判这一处,
  //   且它不是「没给 = 主控区」—— 落点必填,非主控区缺表桶 / 库名就抛。同批把数据源章的读法收进 `targetOfStamp`(净 0)。
  //   2026-10-11 261 → 263(+2):删除流程入口(decommission.loadTarget)与停止承接路由的 `isHome(`
  //   都是**身份**判定「主控区永不可删 / 不许停止承接」(用户反复拍板的不变量,与 discard.ts 已有那处同形),不是「没给 = 主控区」的缺省回落。
  //   2026-10-10 260 → 261(+1):`requiredComponentsForTarget` —— **身份**判定(AgentCore 只属主控区,用户拍板「一个 AgentCore」),
  //   把注册 / 补齐 / deploy / 摘组件四处本要各写一个 isHome 的地方收成这一处;它不是「没给 = 主控区」那类缺省回落。
  //   2026-10-03 263 → 260:治理健康分不再「没给 = 主控区」· 问数落点不再按 isHome 决定传不传项目
  //   2026-10-03 265 → 263:需求生成实现不再写死主控区(按页面点名的区)
  //   2026-10-03 266 → 265:Flink 落点解析器不再「没给 = 主控区」
  //   2026-10-02 268 → 266:实时元数据 / Airflow 控制台 / 数仓连接不再「没给 / 非法 ⇒ 主控区」
  //   2026-10-02 269 → 268:模型目录「没给 / 非法 ⇒ 主控区」去掉
  //   2026-10-02 271 → 269:问数 / BI / Copilot 发现不再按「没给区 ⇒ 拿 GENBI 主控区实名」分支(主控区也由落点作者解析,同源)
  //   2026-10-02 274 → 271:三个新建入口(实时作业 / 工作流 / 数据源)去掉「没给 = 主控区」
  //  2026-10-02 278 → 274:六个数据面解析器去掉「缺省 = 主控区」+ 存量章 / 视角落点各收成一个作者(targetOfStamp / landingOfScope)
  /** L2:主控区资源名字面量(由 naming.json 的 home 模板派生,不手抄清单) */
  // 2026-11-03 30 → 29:依赖库上传路由不再手拼主控区脚本桶名,改按作业绑定的每个落点 resolveGlueBinding 取脚本桶
  homeLiterals: 29, // 2026-10-11 31 → 30(o4-REG):同步推 OM 的两份 `bgp-table-bucket` 缺省收成坐标作者 om-sync-coords 的一处(主控区分支)
  /** L1:落点签名里的可选 / undefined(`targetId?: string` / `targetId: string | undefined|null`) */
  optionalTargetSigs: 66, // 2026-10-22 68 → 66:model-metrics compute 路由主体搬进执行体,路由里两处 `targetId?: string` 局部签名随之消失
  //   2026-10-11 72 → 68(合并 integ/seq35):计划落点必填(createPlanTask / createPlan)−2 + 后一半 fetchCatalog / probeModel 落点必填 −2
  // 2026-10-03 73 → 72:computeHealth 落点必填
  //  2026-10-03 76 → 73:resolveFlinkPlace / ctxFor / StartOptions.targetId 必填(观测器误报牵出)
  //  2026-10-03 82 → 76:直查范围 DirectQueryScope · 问数 runSql / introspectSchema · AI 代码生成三处落点必填
  //  2026-10-02 89 → 82:Athena / S3Tables 解析器 + 问数执行体 / BI 取数 / 问数大脑落点必填
  //  2026-10-02 90 → 89:resolveDsPlace 落点必填
  //  2026-10-02 107 → 90:(数据面解析器 6 + run 章 6 处 + 三个入口路由 + 建模 / 指标计算)
  // 2026-10-01 115 → 107:flink-service 8 个落点参数改必填(观测器抓到 captureRootError 漏传)
  /**
   * L5(🆕 2026-10-02):API 路由**从请求直接读落点**(没经过 requestedTargetId / requestedTargets / placeOfRequest)。
   * 这类读法后面几乎都跟着「没给 = 主控区」⇒ 前端漏传就静默做在主控区(段 wp31 一次坐实三处)。
   * 迁一处减一处,目标 0。⚠️ 这是欠账计数器、不是闭合门:解构成别名再读等写法它看不见 —— 闭合靠迁完后
   * 改成「app/api 里只许出现这三个作者」的唯一合法形态判据。
   */
  // 2026-10-02 118/51 → 78/41:(三个新建入口 + 三个编辑入口 + 七个运行 / 发布 / 触发子集收成 requestedSubset)
  // 2026-10-02 78/41 → 69/36:(Athena 5 路由 + 问数 + BI 三路由 + 表结构)
  // 2026-10-02 69/36 → 46/20:🔴 其中 11 处是**量具校准**(网络顾问 `targets` 不是执行区 5 · 值已交给 biLandingOf / 作者 6)、
  //   1 文件显式豁免(镜像总览);真迁移 = 解绑 ×2 / 解绑预览 ×2 / 驻留确认 / 采集镜像 / 模型目录
  // 2026-10-02 46/20 → 23/11:写回 / 删字段不再计数(量具校准)· 编辑三路由收成 hasTargetsPatch · 建模落地 / 应用收成 requestedSubset ·
  //   实时元数据 / Airflow 控制台 / 数仓连接改点名
  // 2026-10-03 23/11 → 0/0:(指标计算 ×2 · 治理 ×4 · 数仓直查页 execute / tasks / history / result · 问数卡片)全是真迁移;
  //   同批把量具放宽到**任意接收者**的 `.get("targetId")`(实测 `sp.get("targetId") || undefined` 漏数了两处:库清单 / 库表树),
  //   放宽后多看见的 1 处(监控运行筛选)进显式豁免。🔴 归零后它就是**闭合门**:app/api 新增任何一处裸读都会红。
  rawRequestTargetReads: 0,
  rawRequestTargetReadFiles: 0,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "__tests__", ".next", "core-dist"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 剥注释(说明文字里引用被禁形状是正当的)。 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

const FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).split("\\").join("/"), src: strip(readFileSync(f, "utf8")) }));

/** 一个文件里从 `@aws-sdk/client-*` 拿到的客户端类名(静态 import 与 `await import()` 解构都算)。 */
function sdkClientNames(src: string): Set<string> {
  const names = new Set<string>();
  const add = (list: string) => {
    for (const part of list.split(",")) {
      const m = /^\s*(?:type\s+)?(\w+Client)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (m) names.add(m[2] ?? m[1]);
    }
  };
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@aws-sdk\/client-[\w-]+["']/g)) add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*["']@aws-sdk\/client-[\w-]+["']\s*\)/g)) add(m[1]);
  return names;
}

/**
 * L3 量具(AST):一个文件里 `new X(…)` 且 X 是从 `@aws-sdk/client-*` 拿到的 `…Client`(静态命名 import 与
 * `const { … } = await import(…)` 解构都算,含 `as` 别名)。不剥注释、不靠正则 —— 注释与字符串天然不在 AST 的
 * NewExpression 里(旧正则量具就是栽在注释里的 `/api/redshift/*` 上)。
 */
function astBareClientCount(rel: string, text: string): number {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set<string>();
  const isSdk = (spec: string) => /^@aws-sdk\/client-/.test(spec);
  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && isSdk(n.moduleSpecifier.text)) {
      const nb = n.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (/Client$/.test((el.propertyName ?? el.name).text)) names.add(el.name.text);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a0 = init.arguments[0];
        if (a0 && ts.isStringLiteral(a0) && isSdk(a0.text)) {
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : "";
            if (/Client$/.test(prop) && ts.isIdentifier(el.name)) names.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) count++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

/**
 * L4 闭合门量具(AST):一个文件里对区变量名的**访问**,不论接收者是谁 ——
 * `X.AWS_REGION` · `X["AWS_REGION"]` · `const { AWS_REGION } = X`(含 AWS_DEFAULT_REGION / BGP_HOME_REGION)。
 * 🔴 判的是「合法形态只有一种(在 home-region.ts 里)」,不是枚举 `process.env.` 这一种违规拼法:
 *    `env.AWS_REGION`(env 是注入的 process.env)旧正则看不见,本量具看得见。字符串与注释天然不在 AST 的访问节点里
 *    (EMR 的 `spark.executorEnv.AWS_REGION=…` 模板串、cookbook 里的 `os.environ.get('AWS_REGION')` 都不算)。
 */
const REGION_VARS = new Set(["AWS_REGION", "AWS_DEFAULT_REGION", "BGP_HOME_REGION"]);
function astEnvRegionAccesses(rel: string, text: string): number {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && REGION_VARS.has(n.name.text)) count++;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && REGION_VARS.has(n.argumentExpression.text)) count++;
    else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && REGION_VARS.has(key.text)) count++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

const RAW_FILES = walk(SRC).map((f) => ({ rel: relative(SRC, f).split("\\").join("/"), text: readFileSync(f, "utf8") }));

function countBareClients(): { n: number; files: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  for (const f of RAW_FILES) {
    if (f.rel === FACTORY) continue;
    const n = astBareClientCount(f.rel, f.text);
    if (n) byFile[f.rel] = n;
  }
  const n = Object.values(byFile).reduce((a, b) => a + b, 0);
  return { n, files: Object.keys(byFile).length, byFile };
}

function countRe(re: RegExp, skip: (rel: string) => boolean = () => false): number {
  let n = 0;
  for (const f of FILES) if (!skip(f.rel)) n += (f.src.match(re) ?? []).length;
  return n;
}

/** 主控区资源名的字面量形状:模板里 `{` 之前的那段是固定前缀;太短的(`dev`)与栈名模板不收(会误伤)。 */
function homeLiteralRegexes(): RegExp[] {
  const out: RegExp[] = [];
  for (const [kind, rule] of Object.entries(NAMING.kinds)) {
    if (kind === "stackName") continue;
    const brace = rule.home.indexOf("{");
    const fixed = brace < 0 ? rule.home : rule.home.slice(0, brace);
    if (fixed.length < 6) continue;
    const esc = fixed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push(brace < 0 ? new RegExp(`["'\`]${esc}["'\`]`, "g") : new RegExp(`["'\`]${esc}\\$\\{`, "g"));
  }
  return out;
}

describe("🔴 落点棘轮(恰好等于基线;迁一处减一处)", () => {
  it("扫描面成立(扫到 0 个文件 = 门禁在测空气)", () => {
    expect(FILES.length).toBeGreaterThan(400);
    expect(homeLiteralRegexes().length, "naming.json 派生不出字面量形状").toBeGreaterThan(15);
    // 量具自检:剥注释后的工厂文件里确实认得出 SDK 客户端名
    const factory = FILES.find((f) => f.rel === "lib/exec-env/target-clients.ts")!;
    expect(sdkClientNames(factory.src).has("RedshiftDataClient")).toBe(true);
    // AST 量具自检(正反两例):认得出静态 import / 动态 import 解构 / 别名;注释与字符串里的 `new XClient(` 不算
    const probe = [
      'import { S3Client as S } from "@aws-sdk/client-s3";',
      "const a = new S({ region: 'x' });",
      "// const b = new S({})",
      "const c = `new S(${1})`;",
      "async function f() { const { GlueClient } = await import(\"@aws-sdk/client-glue\"); return new GlueClient({}); }",
      "class Mine { } const d = new Mine();",
    ].join("\n");
    expect(astBareClientCount("probe.ts", probe)).toBe(2);
    expect(astBareClientCount("lib/aws/clients.ts", RAW_FILES.find((f) => f.rel === FACTORY)!.text), "工厂自己的 new(RedshiftData / DynamoDB 底层)认不出 ⇒ 量具失明").toBeGreaterThanOrEqual(2);
  });

  it("L3 工厂之外散建的 SDK 客户端", () => {
    const got = countBareClients();
    expect({ n: got.n, files: got.files }, JSON.stringify(got.byFile, null, 1)).toEqual({
      n: BASELINE.bareClients,
      files: BASELINE.bareClientFiles,
    });
  }, 60_000); // AST 量具全仓解析 —— 全量并行负载下 > 5s(合并 integ/seq35 实测 5.7s 超时)

  it("L4 读进程环境的默认区(process.env.AWS_REGION / AWS_DEFAULT_REGION)", () => {
    expect(countRe(/process\.env\.AWS_(?:DEFAULT_)?REGION\b/g)).toBe(BASELINE.envRegionReads);
    expect(countRe(/process\.env\.AWS_(?:DEFAULT_)?REGION\b/g, (r) => r === HOME_REGION_AUTHOR), "唯一作者之外出现了 process.env 区读取").toBe(0);
  });

  it("🔴 L4 闭合门:区变量只许在 lib/place/home-region.ts 里读(任何别的文件出现一处就红)", () => {
    // 量具自检(正反两例):认得出 process.env.X / 注入 env 的 env.X / 下标 / 解构;注释、字符串、模板串里的不算
    const probe = [
      "const a = process.env.AWS_REGION || 'x';",
      "function f(env: NodeJS.ProcessEnv) { return env.AWS_DEFAULT_REGION; }",
      "const b = process.env[`BGP_HOME_REGION`];",
      "const { AWS_REGION: r } = process.env;",
      "// const c = process.env.AWS_REGION;",
      "/* process.env.AWS_DEFAULT_REGION */",
      "const d = 'process.env.AWS_REGION';",
      "const e = `--conf spark.executorEnv.AWS_REGION=${a}`;",
      "const g = process.env.AWS_REGION_X;",
    ].join("\n");
    expect(astEnvRegionAccesses("probe.ts", probe)).toBe(4);
    const author = RAW_FILES.find((f) => f.rel === HOME_REGION_AUTHOR);
    expect(author, "唯一作者文件不存在 ⇒ 门在测空气").toBeTruthy();
    // homeRegion / homeRegionOf / homeRegionOrEmpty 各读 BGP_HOME_REGION + AWS_REGION 一次
    expect(astEnvRegionAccesses(author!.rel, author!.text), "唯一作者里的读取认不出 ⇒ 量具失明").toBe(6);
    const offenders: Record<string, number> = {};
    for (const f of RAW_FILES) {
      if (f.rel === HOME_REGION_AUTHOR) continue;
      const n = astEnvRegionAccesses(f.rel, f.text);
      if (n) offenders[f.rel] = n;
    }
    expect(offenders, "区变量只许经 lib/place/home-region.ts 的 homeRegion() / homeRegionOf() / homeRegionOrEmpty() 读").toEqual({});
  }, 60_000); // 全仓 AST 解析,与 L3 同理放宽超时

  it("L2 主控区分支(isHome( / HOME_TARGET_ID;定义它们的 target-id.ts 不算)", () => {
    expect(countRe(/\bisHome\(|\bHOME_TARGET_ID\b/g, (r) => r === "lib/exec-env/target-id.ts")).toBe(BASELINE.homeBranches);
  });

  it("L2 主控区资源名字面量(命名 SSOT 自己不算)", () => {
    let n = 0;
    for (const re of homeLiteralRegexes()) n += countRe(re, (r) => r === "lib/aws/naming.ts");
    expect(n).toBe(BASELINE.homeLiterals);
  });

  it("L1 落点签名里的可选 / undefined", () => {
    expect(countRe(/\btargetId\?\s*:\s*string\b|\btargetId\s*:\s*string\s*\|\s*(?:undefined|null)\b/g)).toBe(BASELINE.optionalTargetSigs);
  });

  it("L5 API 路由从请求直接读落点(没经过点名作者)", () => {
    const RAW = /\.get\(\s*["']targetId["']\s*\)|\bbody\??\.(?:targets|targetId)\b|\{[^{}]*\btarget(?:s|Id)\b[^{}]*\}\s*=\s*await\s+req\.json\(\)/g;
    // `requestedRegisteredPlace`(点名 + 已注册且装好)也是点名作者
    const AUTHOR = /requested(?:TargetId|Targets|Subset|RegisteredPlace)\(|hasTargetsPatch\(|placeOfRequest\(|biLandingOf\(/;
    // 显式豁免(逐文件 + 理由,不按目录整块豁免;新增一行要说清为什么「没给」不等于主控区)
    const EXEMPT = new Map<string, string>([
      ["app/api/network-advisor/advise/route.ts", "`targets` = 网络目标端点列表,不是执行区"],
      ["app/api/network-advisor/probe/route.ts", "`targets` = 网络目标端点列表,不是执行区"],
      ["app/api/metadata-mirror/route.ts", "不给 targetId = 全部区的镜像总览(不是主控区);给了才下钻且非法即 400"],
      ["app/api/monitor/runs/route.ts", "`targetId` = 运行列表的筛选条件,不给 = 不筛(不是主控区);主轴是 `?scope=`"],
    ]);
    let n = 0;
    const files = new Set<string>();
    for (const f of FILES.filter((x) => x.rel.startsWith("app/api/") && !EXEMPT.has(x.rel))) {
      for (const line of f.src.split("\n")) {
        if (AUTHOR.test(line)) continue;
        // 只数**读**:写回校验后的值(`body.targets = …`)与删字段(`delete body.targetId`)不是落点决定
        const k = Array.from(line.matchAll(RAW)).filter((m) => {
          const after = line.slice((m.index ?? 0) + m[0].length);
          const before = line.slice(0, m.index ?? 0);
          return !/^\s*=(?!=)/.test(after) && !/\bdelete\s+$/.test(before);
        }).length;
        if (k) { n += k; files.add(f.rel); }
      }
    }
    expect({ n, files: files.size }).toEqual({ n: BASELINE.rawRequestTargetReads, files: BASELINE.rawRequestTargetReadFiles });
    for (const [rel, why] of EXEMPT) expect(FILES.some((f) => f.rel === rel), `豁免了一个不存在的文件(${rel}:${why})⇒ 删掉这行`).toBe(true);
  });

  it("新代码不许再加:lib/place 自己零散建、零 env 区、零可选落点", () => {
    for (const f of FILES.filter((x) => x.rel.startsWith("lib/place/"))) {
      // home-region.ts 是 L4 的唯一作者(闭合门另行断言),别的 lib/place 文件照旧零 env 区
      if (f.rel !== HOME_REGION_AUTHOR) expect(f.src, f.rel).not.toMatch(/process\.env\.AWS_(?:DEFAULT_)?REGION/);
      expect(f.src, f.rel).not.toMatch(/\btargetId\?\s*:\s*string/);
      expect(sdkClientNames(f.src).size === 0 || f.rel === "lib/place/observer.ts", f.rel).toBe(true);
      expect(f.src, f.rel).not.toMatch(/\bnew\s+\w+Client\s*\(/);
    }
  });
});

describe("🔴 观测头只是观测输入(不许变成第二个落点来源)", () => {
  it("只有 middleware(写)与观测器(读)引用它;任何业务代码不许读", () => {
    const users = FILES.filter((f) => /OBSERVE_URL_HEADER|x-bgp-observe-url/.test(f.src)).map((f) => f.rel).sort();
    expect(users).toEqual(["lib/place/observe-header.ts", "lib/place/observer.ts", "middleware.ts"]);
    const mw = FILES.find((f) => f.rel === "middleware.ts")!.src;
    expect(mw, "必须**覆盖**入站同名头(set,不是 append / 不是有了就跳过)").toMatch(/requestHeaders\.set\(OBSERVE_URL_HEADER,/);
  });

  it("Next 请求存储的内部模块还在(升级 Next 时它变了就该红,而不是观测器静默失明)", async () => {
    // Next 15:请求级存储 = work-unit-async-storage.external#workUnitAsyncStorage(14.2 是 request-async-storage.external#requestAsyncStorage)
    const m = await import("next/dist/server/app-render/work-unit-async-storage.external");
    expect(typeof m.workUnitAsyncStorage.getStore).toBe("function");
    expect(m.workUnitAsyncStorage.getStore()).toBeUndefined();
  });

  it("instrumentation 启动时装观测器,且装失败不挡启动", () => {
    const ins = FILES.find((f) => f.rel === "instrumentation.ts")!.src;
    expect(ins).toMatch(/try \{\s*const \{ installPlaceObserver \} = await import\("@\/lib\/place\/observer"\);\s*await installPlaceObserver\(\);\s*\} catch/);
  });
});
