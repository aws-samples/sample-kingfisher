// 🔴🔴 **产物里的数仓凭证只许有一个作者 = `resolveRedshiftBinding`。**
//
// 【这条判据是该缺陷的前置,不是附带的洁癖】
// (「改了产物生成器,存量载体不会自动重发」)的解法是**可派生**的
//   拿当前生成器**重新生成**一遍该对象的定义,与 `get-workflow` 回来的 `WorkflowDefinition`
//   **逐字节比对**,不一致 = 载体落后。(刻意不存 `generatorVersion` —— 版本号自己会漂,
//    而且又多一份要同步的真值;「重新生成再比」没有第二份真值。)
//
// 🔵 开包勘定(2026-09-21)当场发现这条路上有一个**会造成假红的陷阱**:
//   `publishWorkflowDagToTarget` 原来写的是
//       redshiftSecretArn: rsBinding.home ? opts.redshiftSecretArn : rsBinding.secretArn
//   —— home 走**调用方传进来的那一个**,理由写的是「home 产物逐字节不变」。
//   但 `resolveRedshiftBinding` 的 home 分支**本来就算出了** `secretArn`(同一个
//   `getRedshiftSecretArn`)⇒ home 的凭证有**两个作者**。
//   于是「重新生成再比对」在 home 上必然误报「载体落后」:重新生成时没有「调用方传进来的那个」。
//
// 🔵 逐条查实三个调用方,结论是它们与 `rsBinding.secretArn` **同函数同入参**:
//     · api/workflow/[id]/publish → getRedshiftSecretArn({ project: Item.projectId })  (工作流行)
//     · api/schedule/enable       → getRedshiftSecretArn({ project: wf.projectId })    (工作流行)
//     · sync/schedule-carrier     → getRedshiftSecretArn({ project: task.projectId }),
//        而它合成的 `wf.projectId` **就是** `task.projectId`
//   ⇒ 那个参数是**纯多余的第二作者**,删掉不改变任何产物。
//
// 🔴 判据写成**闭合式**(列「唯一允许的形态」),不枚举违规写法 ——
//   本仓的铁律:门禁写成「枚举违规」就一定漏掉第 N+1 种。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
/** 🔴 负向文本断言前必先剥注释(否则会被「解释为什么不能这么写」的注释命中 ⇒ 假红)。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

describe("产物里的数仓凭证只有一个作者(前置)", () => {
  const pub = strip(read("lib/workflow/publish-dag.ts"));

  it("① 判据自己先有判别力:锚点都在(改名了就该红,不许静默空转)", () => {
    expect(pub, "找不到 publishWorkflowDagToTarget").toContain("publishWorkflowDagToTarget");
    expect(pub, "找不到落点解析 resolveRedshiftBinding").toContain("resolveRedshiftBinding(");
    expect(pub.match(/redshiftSecretArn:/g)?.length, "产物里一处凭证赋值都没有 ⇒ 判据在空转").toBe(1);
  });

  it("② 🔴 闭合式:`redshiftSecretArn:` 的值**只允许**来自 `rsBinding`", () => {
    // 列「唯一允许的形态」。多一种形态就红 —— 包括将来有人写成三元、写成 `opts.xxx`、写成字面量。
    const ALLOWED = [/redshiftSecretArn:\s*rsBinding\.secretArn\s*,/];
    for (const line of pub.split("\n").filter((l) => /redshiftSecretArn:/.test(l))) {
      expect(
        ALLOWED.some((p) => p.test(line.trim())),
        `🔴 产物里的凭证赋值出现了**未登记的形态** ⇒ 又多了一个作者:\n    ${line.trim()}\n` +
          `    (唯一允许:\`redshiftSecretArn: rsBinding.secretArn,\` —— 它由 resolveRedshiftBinding 派生)`
      ).toBe(true);
    }
  });

  it("③ 🔴 负向:发布函数的 `opts` 里不许再有 `redshiftSecretArn`(那就是那个第二作者的入口)", () => {
    expect(
      /opts:\s*\{[^}]*redshiftSecretArn/.test(pub),
      "🔴 `opts` 又能传凭证进来了 ⇒ home 的凭证回到两个作者,载体落后比对会误报"
    ).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 **这一条的第一版写错了,记下来:判据必须锚定到它要判的那个对象。**
  // 第一版写的是「全仓不许出现 `redshiftSecretArn`」,当场红 12 行 —— 而那 12 行**全是正当的**:
  //   `resources.redshiftSecretArn` 是**执行环境描述符的资源袋键名**(部署期从 CFN Output 读),
  //   与「发布函数的参数」是**同名不同物**两件事(`registry.ts` 的必需键清单 /
  //   `privileged-cred.ts` 与 `admin-ddl-executor.ts` 读袋 / `stack-outputs.ts` 写袋 / 错误文案)。
  // ⇒ 判据的对象不是「这个词」,是「**调发布函数时把它当实参传进去**」。
  //   (记忆 `criteria-must-anchor-to-its-own-object`;今天第 N 次栽在同名不同物上。)
  // ══════════════════════════════════════════════════════════════════════════
  it("④ 🔴 闭合式覆盖:**任何**调发布函数的地方都不许传凭证(第 N+1 个调用方也逃不掉)", () => {
    let hits = "";
    try {
      // 扫「调用点 + 随后 4 行」—— 不点名文件,所以将来新增的调用方自动进判据。
      hits = execFileSync(
        "grep",
        ["-rn", "-A", "4", "--include=*.ts", "--include=*.tsx",
         "-e", "publishWorkflowDag(", "-e", "publishWorkflowDagToTarget(", resolve(SRC)],
        { encoding: "utf8" }
      );
    } catch {
      hits = ""; // grep 无匹配 ⇒ 退出码 1
    }
    expect(hits, "一个发布函数的调用点都没扫到 ⇒ 判据在空转(函数改名了?)").toContain("publishWorkflowDag");
    const offenders = hits
      .split("\n")
      .filter((l) => /redshiftSecretArn/.test(l))
      // 发布函数自己的定义行(它的 opts 由 ③ 单独钉)与本判据文件不算调用方
      .filter((l) => !/\/lib\/workflow\/publish-dag\.ts[:-]/.test(l))
      .filter((l) => !/\/__tests__\//.test(l));
    expect(
      offenders,
      `🔴 还有调用方把凭证传进发布函数(= 凭证的第二个作者,载体落后比对会在 home 上误报):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("⑤ 🔴 同源证明:落点解析的 home 分支必须用 `getRedshiftSecretArn`,且传给它的是**资源行上的** projectId", () => {
    const dpt = strip(read("lib/exec-env/data-plane-target.ts"));
    // home 分支里凭证必须由 getRedshiftSecretArn 派生(不是别处捞一个)
    const iHome = dpt.indexOf("if (isHome(targetId)) {");
    expect(iHome, "找不到 home 分支 ⇒ 判据在空转").toBeGreaterThan(-1);
    const homeBranch = dpt.slice(iHome, iHome + 1200);
    expect(homeBranch, "home 分支的 secretArn 不是由 getRedshiftSecretArn 派生").toMatch(
      /secretArn:\s*await\s+getRedshiftSecretArn\(/
    );
    // 而发布路径传给它的 projectId 必须是**工作流行**上的那个(不是请求头里的 active project)
    expect(pub, "发布路径给落点解析传的不是 workflow.projectId ⇒ 归属会跟着请求头漂").toMatch(
      /resolveRedshiftBinding\(\{\s*targetId:\s*wfTarget,\s*projectId:\s*workflow\.projectId\s*\}\)/
    );
  });
});
