// 引擎必备权限基线 + 接线 —— 判据。
//
// 🔴🔴 夹具用的是 **2026-09-22 用户真实撞到的那次事故**,不是我编的场景:
//   copilot 建的 EMR 作业(channel_roi_calculation)填了角色顾问一键建出来的角色,一跑就
//     AccessDenied: s3:PutObject on ".../emr-logs/<jobId>/.../job-metadata.log"
//   逐层查实:那个角色**一条 S3 语句都没有**,CloudWatch 那条还写死指向 `/aws-glue/*`。
//   本文件每一条判据都对应那次事故里的一个具体缺陷 —— 它们必须能**打红修复前的实现**。

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { engineBaseline, baselineStatements, baselineProbes } from "../engine-baseline";
import { buildRoleAdvice } from "../policy-builder";
import { EMR_LOG_PREFIX, s3LogUri } from "../../engines/emr/log-destination";

const CTX = { region: "us-east-1", accountId: "123456789012", logBucket: "bgp-datalake-123456789012", scriptBucket: "bgp-glue-scripts-123456789012" };
const SRC = (p: string) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");
/** 🔴 负向文本断言前先剥注释(本仓老账:注释里的字会把判据打红/放行)。 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/**
 * 🔴🔴 接线判据必须**先剥 import 再查调用位置**(本仓记过的老账,一天同形栽三次)。
 *   本文件第一版就又栽了一次:拿 `indexOf("GetRoleCommand")` 去切「角色已存在」那个分支,
 *   结果命中的是 **import 行**里的 `GetRoleCommand,` ⇒ 切出来的片段只是 import 块,判据当场假红。
 */
const stripImports = (s: string) => s.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");

describe("EMR 必备权限基线(事故:缺日志落点写权限 ⇒ 作业起步即 AccessDenied)", () => {
  it("🔴🔴 ① 必须允许往**日志落点**写 —— 这就是那次 AccessDenied 的那一条", () => {
    const stmts = baselineStatements("emr", CTX);
    const logRes = `arn:aws:s3:::${CTX.logBucket}/${EMR_LOG_PREFIX}/*`;
    const hit = stmts.filter((s) => {
      const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return res.includes(logRes) && s.Action.includes("s3:PutObject");
    });
    expect(hit.length, `必备基线里必须有一条「s3:PutObject → ${logRes}」。\n`
      + `真实事故:2026-09-22 copilot 建的作业就是缺这一条,报错原文是\n`
      + `  AccessDenied: s3:PutObject on ".../emr-logs/<jobId>/.../job-metadata.log"\n`
      + `实得语句:${JSON.stringify(stmts.map((s) => ({ Sid: s.Sid, R: s.Resource })))}`).toBeGreaterThan(0);
  });

  it("🔴🔴 ② 日志前缀与**运行期**必须是同一个真值源(两个作者 = 这个 bug 会复发)", () => {
    // 运行期真正写到哪:`s3LogUri` 是唯一作者
    const uri = s3LogUri("JOB1", CTX.logBucket);
    expect(uri).toBe(`s3://${CTX.logBucket}/${EMR_LOG_PREFIX}/JOB1/`);
    // 授权侧的资源面必须覆盖它
    const covered = baselineStatements("emr", CTX).some((s) => {
      const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return res.some((r) => r === `arn:aws:s3:::${CTX.logBucket}/${EMR_LOG_PREFIX}/*`);
    });
    expect(covered, `运行期写 ${uri},而授权侧的资源面没覆盖那个前缀 ⇒ 又变成两个作者`).toBe(true);
    // 🔴 闭合:运行期那两个常量**不许**再回到 provider.ts 里(那正是事故的结构原因)
    const prov = stripComments(SRC("lib/engines/emr/provider.ts"));
    expect(prov).not.toMatch(/const\s+LOG_PREFIX\s*=/);
    expect(prov).not.toMatch(/const\s+LOG_BUCKET\s*=/);
  });

  it("🔴🔴 ③ 各引擎的 CloudWatch 日志组不许混(原实现对所有引擎都写 /aws-glue/*)", () => {
    const want: Record<string, string> = {
      emr: "/aws/emr-serverless/", glue: "/aws-glue/", flink: "/aws/kinesis-analytics/", dms: "dms-tasks-",
    };
    for (const [eng, frag] of Object.entries(want)) {
      const stmts = baselineStatements(eng as "emr", CTX);
      const logs = stmts.filter((s) => s.Action.some((a) => a.startsWith("logs:")));
      expect(logs.length, `${eng} 必须有日志权限`).toBeGreaterThan(0);
      const res = logs.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
      expect(res.some((r) => r.includes(frag)), `${eng} 的日志组应含 ${frag},实得 ${JSON.stringify(res)}`).toBe(true);
      if (eng !== "glue") {
        expect(res.some((r) => r.includes("/aws-glue/")),
          `🔴 ${eng} 的日志组不许是 Glue 的 /aws-glue/*(那次事故里线上那个角色就是这样)`).toBe(false);
      }
    }
  });

  it("🔴 ④ 分片上传三件套不能省(Spark 写大文件走 multipart,只给 PutObject 会在写大结果时失败)", () => {
    const acts = new Set(baselineStatements("emr", CTX).flatMap((s) => s.Action));
    for (const a of ["s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts"]) {
      expect(acts.has(a), `缺 ${a}`).toBe(true);
    }
  });

  it("🔴🔴 ⑤ 调用方**没给** s3Buckets 时,产出的策略也不许一条 S3 语句都没有(事故的直接形态)", () => {
    // 这正是线上那个坏角色的生成条件:resources 为空
    const advice = buildRoleAdvice({ engine: "emr", region: CTX.region, accountId: CTX.accountId });
    const s3 = advice.permissionPolicy.Statement.filter((s) => s.Action.some((a) => a.startsWith("s3:")));
    expect(s3.length, `没给 s3Buckets 时原实现只塞了一句 cautions 就把角色建出来了(整条 S3 语句不存在)。\n`
      + `实得 Sid:${advice.permissionPolicy.Statement.map((x) => x.Sid).join(",")}`).toBeGreaterThan(0);
  });

  it("🔴 ⑥ 拿不到 accountId 时必须**说出来**(而不是退化成 `*` 建出跨账号通配的资源面)", () => {
    const advice = buildRoleAdvice({ engine: "emr", region: CTX.region });
    expect(advice.cautions.join("\n")).toMatch(/accountId/);
    const flat = JSON.stringify(advice.permissionPolicy);
    expect(flat, "不许出现 `bgp-datalake-*` 这种跨账号通配").not.toMatch(/bgp-datalake-\*/);
  });

  it("⑦ 每条必备权限都要有**探针**(预检要拿它去 SimulatePrincipalPolicy)且探针资源不许是空", () => {
    const probes = baselineProbes("emr", CTX);
    expect(probes.length).toBe(engineBaseline("emr", CTX).length);
    for (const p of probes) {
      expect(p.action, JSON.stringify(p)).toMatch(/^[a-z0-9-]+:[A-Za-z]+$/);
      expect(p.resource.length, JSON.stringify(p)).toBeGreaterThan(0);
      expect(p.why.length, `探针必须带「为什么需要它」——预检报错直接用这句`).toBeGreaterThan(10);
    }
  });
});

describe("接线(写了 ≠ 接上了)", () => {
  it("🔴🔴 一键创建必须走**带扫描推导**的入口 `adviseRole`,不许直接用纯规则那层", () => {
    const src = stripImports(stripComments(SRC("lib/role-advisor/provisioner.ts")));
    expect(src, "provisionRole 必须 await adviseRole(...)").toMatch(/await\s+adviseRole\(/);
    expect(src, "🔴 不许绕过扫描层直接调 buildRoleAdvice").not.toMatch(/\bbuildRoleAdvice\s*\(/);
  });

  it("🔴🔴 一键创建对**已存在**的角色必须对账补齐(原来是「存在就跳过」⇒ 坏角色永远修不好)", () => {
    const src = stripImports(stripComments(SRC("lib/role-advisor/provisioner.ts")));
    // 先切到「角色已存在」那个分支里,再判 —— 判据必须锚定到它要判的那个对象。
    // 🔴 锚点用 `new XxxCommand(` 这个**调用形态**,不是裸 token(裸 token 会命中 import 行)。
    const i = src.indexOf("new GetRoleCommand(");
    const j = src.indexOf("new CreateRoleCommand(");
    expect(i).toBeGreaterThan(-1);
    const branch = src.slice(i, j > i ? j : undefined);
    expect(branch, "已存在分支里必须调 reconcilePolicy").toMatch(/reconcilePolicy\(/);
  });

  it("🔴🔴 EMR 提交路径必须在 StartJobRun **之前**做执行角色预检(钉顺序,不只钉存在)", () => {
    const src = stripImports(stripComments(SRC("lib/engines/emr/provider.ts")));
    // 序 72 B-139:提交路径改走落点化统一入口 preflightExecutionRole(内部仍是 preflightRole 这一个量法)
    const pf = src.indexOf("preflightExecutionRole(");
    const start = src.indexOf("StartJobRunCommand(");
    expect(pf, "provider 里必须调 preflightExecutionRole").toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(pf, `预检必须在 StartJobRun 之前(实得 preflight@${pf} / StartJobRun@${start})`).toBeLessThan(start);
  });

  it("🔴 对外推荐接口必须是**异步**的 adviseRole(同步的 recommendRole 会静默跳过扫描)", () => {
    const idx = stripImports(stripComments(SRC("lib/role-advisor/index.ts")));
    expect(idx).toMatch(/export\s+async\s+function\s+recommendRole/);
    const route = stripImports(stripComments(SRC("app/api/role-advisor/recommend/route.ts")));
    expect(route, "路由必须 await recommendRole(...) —— 忘了 await 会把 Promise 当结果返回").toMatch(/await\s+recommendRole\(/);
  });

  it("🔴🔴 `GetRole` 的 catch **不许**罩住对账补齐(否则把 B 的失败报成 A 的失败)", () => {
    const src = stripImports(stripComments(SRC("lib/role-advisor/provisioner.ts")));
    // 先锚到 `new GetRoleCommand(` 的**调用位置**,再往回找罩住它的那个 `try {`
    const call = src.indexOf("new GetRoleCommand(");
    expect(call, "provisioner 必须调 GetRole").toBeGreaterThan(-1);
    const t = src.lastIndexOf("try {", call);
    const c = src.indexOf("} catch", call);
    expect(t).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(t);
    const tryBlock = src.slice(t, c);
    expect(tryBlock, "🔴 2026-09-22 真环境吃到的教训:PutRolePolicy 的 MalformedPolicyDocument 被报成"
      + "「查角色是否已存在时失败」—— 一个 catch 罩住两件事,就必然把 B 的失败说成 A 的失败")
      .not.toMatch(/reconcilePolicy\(/);
  });
});
