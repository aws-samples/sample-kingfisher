// 扫描推导(代码解析 + 源头/目标绑定 + 配方库匹配)—— 判据。
//
// 🔴 用户 2026-09-22 原话:「目标/源头,都要扫描,自动生成所需要的权限,这里面涉及到代码解析,
//   匹配配方库等操作。」本文件钉的就是这四个来源各自**真的起作用**,而且每条权限都带**证据**。

import { describe, it, expect } from "vitest";
import { scanForPermissions, recipeSid } from "../script-scan";
import { EMR_RECIPES } from "../../cookbook/seed/emr";
import { EMR_LOG_PREFIX } from "../../engines/emr/log-destination";

const BASE = { engine: "emr" as const, region: "us-east-1", accountId: "123456789012",
  logBucket: "bgp-datalake-123456789012", scriptBucket: "bgp-glue-scripts-123456789012" };

/** 🔴 夹具 = 用户那次真实作业(channel_roi_calculation)脚本的开头,逐字抄下来的。 */
const REAL_SCRIPT = [
  "# EMR Serverless PySpark：计算各渠道 ROI 并写入 Redshift ads.channel_roi",
  "import boto3",
  "import time",
  "",
  "# 平台真实值（严禁占位符）",
  "WORKGROUP = 'bgp-workgroup'",
  "DATABASE = 'dev'",
  "",
  "rs = boto3.client('redshift-data')",
].join("\n");

const actionsOf = (r: ReturnType<typeof scanForPermissions>) => new Set(r.needs.flatMap((n) => n.actions));

describe("代码解析", () => {
  it("🔴🔴 ① 用户那次真实脚本 ⇒ 必须推出**日志落点写权限**,哪怕脚本里一个字都没提日志", () => {
    const r = scanForPermissions({ ...BASE, script: REAL_SCRIPT, recipes: EMR_RECIPES });
    const want = `arn:aws:s3:::${BASE.logBucket}/${EMR_LOG_PREFIX}/*`;
    const hit = r.needs.filter((n) => n.resources.includes(want) && n.actions.includes("s3:PutObject"));
    expect(hit.length, `脚本里没有「日志」二字,但 EMR **就是**用执行角色写日志的 ⇒ 这条权限必须由\n`
      + `**引擎必备基线**兜出来(不能指望代码里有信号)。这正是 2026-09-22 事故的判别力所在。\n`
      + `实得:${JSON.stringify(r.needs.map((n) => n.sid))}`).toBeGreaterThan(0);
  });

  it("② `boto3.client('redshift-data')` ⇒ 推出 Data API 权限,且带**代码行号**证据", () => {
    const r = scanForPermissions({ ...BASE, script: REAL_SCRIPT, recipes: [] });
    const n = r.needs.find((x) => x.actions.includes("redshift-data:ExecuteStatement"));
    expect(n, "没推出 redshift-data 权限").toBeTruthy();
    const ev = n!.evidence.find((e) => e.origin === "code");
    expect(ev, `必须带「哪一行代码要它」的证据,否则用户没法判断该不该给。实得:${JSON.stringify(n!.evidence)}`).toBeTruthy();
    expect(ev!.line).toBe(9); // `rs = boto3.client('redshift-data')` 在第 9 行
  });

  it("🔴 ③ 代码里**写死的 s3:// 落点**要被扫出来(这是「扫目标/源头」最直接的一刀)", () => {
    const script = "df.write.parquet('s3://some-other-bucket/out/')\n";
    const r = scanForPermissions({ ...BASE, script, recipes: [] });
    const flat = JSON.stringify(r.needs);
    expect(flat, `代码往 some-other-bucket 写,绑定里没有它 ⇒ 只有扫代码才看得见`).toContain("arn:aws:s3:::some-other-bucket/*");
  });

  it("🔴🔴 ④ 认不出来的 AWS 调用必须进 `unknown`,**绝不许静默丢掉**", () => {
    const script = "import boto3\nc = boto3.client('comprehend')\n";
    const r = scanForPermissions({ ...BASE, script, recipes: [] });
    expect(r.unknown.length, `平台不认识 comprehend ⇒ 必须说出来,并告诉人「去补一条配方」——\n`
      + `静默忽略就等于回到「等 AccessDenied 再找人改源码」,那正是用户不要的。`).toBe(1);
    expect(r.unknown[0].line).toBe(2);
    expect(r.unknown[0].hint).toMatch(/配方/);
  });

  it("⑤ 没给脚本时要能分清「没扫」和「扫了没发现」", () => {
    const r = scanForPermissions({ ...BASE, recipes: [] });
    expect(r.scannedLines).toBe(0);
    const r2 = scanForPermissions({ ...BASE, script: "x = 1\n", recipes: [] });
    expect(r2.scannedLines).toBe(1);
  });
});

describe("源头 / 目标绑定", () => {
  it("🔴 ⑥ 源头的密钥 ⇒ **精确 ARN** 的 secrets 语句(不是前缀通配),且证据说清是哪个源头", () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:bgp/mysql-AbCdEf";
    const r = scanForPermissions({ ...BASE, sources: [{ name: "游戏库", secretArn: arn }], recipes: [] });
    const n = r.needs.find((x) => x.resources.includes(arn));
    expect(n, `没把源头的密钥 ARN 收进来。实得:${JSON.stringify(r.needs.map((x) => x.sid))}`).toBeTruthy();
    expect(n!.evidence.some((e) => e.origin === "binding" && e.match.includes("游戏库"))).toBe(true);
  });

  it("⑦ 目标是 Redshift ⇒ 推出 Data API;目标桶 ⇒ 推出那个桶的读写", () => {
    const r = scanForPermissions({
      ...BASE,
      targets: [{ name: "数仓", redshift: true }, { name: "结果桶", bucket: "my-out-bucket" }],
      recipes: [],
    });
    expect(actionsOf(r).has("redshift-data:BatchExecuteStatement")).toBe(true);
    expect(JSON.stringify(r.needs)).toContain("arn:aws:s3:::my-out-bucket/*");
  });
});

describe("配方库匹配", () => {
  it("🔴🔴 ⑧ 命中配方的 `detect` ⇒ 并入它声明的 `requiredPermissions`,且占位符被换成真实桶名", () => {
    const r = scanForPermissions({ ...BASE, script: REAL_SCRIPT, recipes: EMR_RECIPES });
    const fromRecipe = r.needs.filter((n) => n.evidence.some((e) => e.origin === "recipe"));
    expect(fromRecipe.length, `配方里已经写了 requiredPermissions,扫描器却一条都没并进来 ⇒ 那一维等于没写`).toBeGreaterThan(0);
    const flat = JSON.stringify(fromRecipe);
    expect(flat, "占位符必须被替换").not.toContain("{datalakeBucket}");
    expect(flat).toContain(BASE.logBucket);
  });

  it("🔴 ⑨ 配方里那条「EMR 必备 IAM 权限」必须存在,且带 detect + requiredPermissions", () => {
    const r = EMR_RECIPES.find((x) => x.id === "emr.iam-required-permissions");
    expect(r, "配方库里必须有这一条(用户:这种能力要加入配方库)").toBeTruthy();
    expect(r!.detect?.length, "没有 detect ⇒ 扫描器永远命中不了它").toBeGreaterThan(0);
    expect(r!.requiredPermissions?.length, "没有 requiredPermissions ⇒ 它只是一段文字,推导用不上").toBeGreaterThan(0);
    // 🔴 配方文本里必须写清那次事故的**报错原文特征**,否则下次的人搜不到它
    const text = `${r!.title}\n${r!.whenToUse}\n${r!.template}\n${r!.dialectNotes.join("\n")}\n${r!.tags.join(",")}`;
    for (const kw of ["AccessDenied", "emr-logs", "job-metadata", "/aws/emr-serverless/"]) {
      expect(text, `配方里应出现 ${kw}(用户按报错原文来搜)`).toContain(kw);
    }
  });

  it("⑩ 同一条权限被多个来源要求时只出现**一条**语句(动作/资源取并集,证据累加)", () => {
    const r = scanForPermissions({
      ...BASE, script: REAL_SCRIPT, recipes: EMR_RECIPES,
      targets: [{ name: "数仓", redshift: true }],
    });
    const sids = r.needs.map((n) => n.sid);
    expect(new Set(sids).size, `出现了重复 Sid:${sids.join(",")}`).toBe(sids.length);
  });
});

describe("IAM 对策略本身的硬约束(离线判据结构上看不见,靠真环境抓到的)", () => {
  /**
   * 🔴🔴 2026-09-22 真环境当场撞到:一键补齐报
   *   `MalformedPolicyDocumentException: Statement IDs (SID) must be alpha-numeric ... [0-9A-Za-z]*`
   * 因为配方 id 派生的 Sid 是 `Recipe_emr_redshift_and_lake_access`(**带下划线**)。
   * 当时 21 条单测 + 变异 5/5 **全绿** —— 判据从没让 Sid 过一遍 IAM 的校验。
   * ⇒ 补这条**闭合式**判据:凡我们产出的 Sid,一律必须匹配 IAM 的那个正则。
   */
  const IAM_SID = /^[0-9A-Za-z]+$/;

  it("🔴🔴 ⑪ 所有产出的 Sid 必须是纯字母数字(IAM 硬约束 [0-9A-Za-z]*)", () => {
    const r = scanForPermissions({
      ...BASE, script: REAL_SCRIPT, recipes: EMR_RECIPES,
      sources: [{ name: "源", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:bgp/x-a1" }],
      targets: [{ name: "仓", redshift: true }, { name: "桶", bucket: "b1" }, { name: "表桶", tableBucketArn: "arn:aws:s3tables:us-east-1:123456789012:bucket/tb" }, { name: "表", dynamodbTable: "t1" }],
    });
    const bad = r.needs.map((n) => n.sid).filter((x) => !IAM_SID.test(x));
    expect(bad, `这些 Sid 会让 PutRolePolicy 报 MalformedPolicyDocument:${bad.join(", ")}`).toEqual([]);
  });

  it("🔴 ⑫ 配方 id → Sid 必须**驼峰化**(不丢信息、不把两条配方拼成同一个 Sid)", () => {
    expect(recipeSid("emr.redshift-and-lake-access")).toBe("RecipeEmrRedshiftAndLakeAccess");
    expect(recipeSid("emr.iam-required-permissions")).toBe("RecipeEmrIamRequiredPermissions");
    // 负向:两条不同的配方不许塌成同一个 Sid
    expect(recipeSid("emr.a-b")).not.toBe(recipeSid("emr.ab"));
    for (const id of EMR_RECIPES.map((x) => x.id)) expect(IAM_SID.test(recipeSid(id)), id).toBe(true);
  });
});
