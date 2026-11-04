// 🔴🔴 执行区必须注入到 driver/executor 环境 —— 判据(B-21 第八层)。
//
// 【真实失败】2026-09-22:IAM 全部补齐之后,用户那个 copilot 生成的 ROI 作业仍然 ExitCode 1:
//     botocore.exceptions.NoRegionError: You must specify a region.
//   因为 `boto3.client('redshift-data')` 不带 region,而 **EMR Serverless 容器里没有默认区域**。
// ⇒ 平台注入(根治)+ 配方规则(另一半)。本文件钉住:注入真的发生、**两条提交路径都有**。

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { bgpLandingParameters, regionEnvParameters, RESERVED_SPARK_CONF } from "../spec";
import { EMR_DIALECT_RULES } from "../../../cookbook/seed/emr";
import { engineBaseline } from "../../../role-advisor/engine-baseline";

const SRC = (p: string) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const LANDING = { targetId: "tgt_usw2_a", region: "us-west-2", datalakeBucket: "b-dl", tableBucket: "b-tb" };

describe("执行区注入", () => {
  it("🔴🔴 ① driver 与 executor **都**要拿到 AWS_REGION / AWS_DEFAULT_REGION", () => {
    const p = regionEnvParameters("us-west-2");
    for (const k of ["spark.emr-serverless.driverEnv.AWS_REGION",
                     "spark.emr-serverless.driverEnv.AWS_DEFAULT_REGION",
                     "spark.executorEnv.AWS_REGION",
                     "spark.executorEnv.AWS_DEFAULT_REGION"]) {
      expect(p, `缺 ${k} —— executor 少了它,分布式那半照样 NoRegionError`).toContain(`${k}=us-west-2`);
    }
  });

  it("🔴 ② 注入的区必须是**该 run 的落点区**,不是主控区", () => {
    expect(bgpLandingParameters(LANDING)).toContain("AWS_REGION=us-west-2");
    expect(bgpLandingParameters(LANDING)).not.toContain("AWS_REGION=us-east-1");
  });

  it("🔴🔴 ③ 手动提交与定时调度**两条路**都要经过同一个作者(漏一处 = 那条路仍然 NoRegionError)", () => {
    // 手动提交(provider.submit)直接调 bgpLandingParameters;定时调度(schedule-fanout)自序 73 起经**再上一层**的单一作者
    //   `job-spec.ts#emrSparkSubmitParametersFor`(工作流离线作业节点拼同一份)—— 判据跟着钉到那一跳:schedule-fanout 必须调它,它必须调 bgpLandingParameters。
    const provider = stripComments(SRC("lib/engines/emr/provider.ts"));
    const fanout = stripComments(SRC("lib/engines/emr/schedule-fanout.ts"));
    const jobSpec = stripComments(SRC("lib/engines/emr/job-spec.ts"));
    expect(provider, "provider.ts 必须调 bgpLandingParameters").toMatch(/bgpLandingParameters\(/);
    expect(fanout, "schedule-fanout.ts 必须经 emrSparkSubmitParametersFor(spark 参数的单一作者)").toMatch(/emrSparkSubmitParametersFor\(/);
    expect(jobSpec, "job-spec.ts 必须调 bgpLandingParameters").toMatch(/bgpLandingParameters\(/);
    for (const [f, src] of [["lib/engines/emr/provider.ts", provider], ["lib/engines/emr/schedule-fanout.ts", fanout], ["lib/engines/emr/job-spec.ts", jobSpec]] as const) {
      // 负向:不许再各写一份 spark.bgp.* 清单(两份必然走岔)
      expect(src, `${f} 里不许再内联 spark.bgp.targetId(要走单一作者)`).not.toMatch(/--conf spark\.bgp\.targetId=/);
    }
  });

  it("🔴 ④ 区域四个键是**保留键**:用户 sparkConf 不许覆盖(覆盖 = 把调用打到别的区,是驻留问题)", () => {
    for (const k of ["spark.emr-serverless.driverEnv.AWS_REGION", "spark.executorEnv.AWS_REGION"]) {
      expect(RESERVED_SPARK_CONF.has(k), `${k} 必须在保留键里`).toBe(true);
    }
  });

  it("⑤ 配方库里留下了这条知识(配方是另一半:用户手写/planner 生成的代码也要安全)", () => {
    const r = EMR_DIALECT_RULES.find((x) => x.id === "emr.boto3-client-needs-region");
    expect(r, "配方库里必须有这一条").toBeTruthy();
    expect(r!.rule).toMatch(/NoRegionError/);
    expect(r!.antiPattern!.test("rs = boto3.client('redshift-data')")).toBe(true);
    // 负向:带了 region 的写法不许被判违规
    expect(r!.antiPattern!.test("boto3.client('redshift-data', region_name=REGION)")).toBe(false);
  });

});

describe("Redshift 连接事实注入(第九层:IAM 放行 ≠ 库内有授权)", () => {
  const RS = { ...LANDING, redshiftWorkgroup: "wg-x", redshiftDatabase: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:redshift!x-Ab" };

  it("🔴🔴 ① 三个连接事实都要注入(少了 SecretArn ⇒ permission denied for database dev)", () => {
    const p = bgpLandingParameters(RS);
    expect(p).toContain("spark.bgp.redshiftWorkgroup=wg-x");
    expect(p).toContain("spark.bgp.redshiftDatabase=dev");
    expect(p, "🔴 少了它,生成的代码只能用没有授权的临时库用户").toContain(`spark.bgp.redshiftSecretArn=${RS.redshiftSecretArn}`);
  });

  it("② 没解析到就**不注入空值**(注入空串会让代码拿到 '' 而以为拿到了)", () => {
    const p = bgpLandingParameters(LANDING);
    expect(p).not.toContain("spark.bgp.redshiftSecretArn=");
    expect(p).not.toContain("spark.bgp.redshiftWorkgroup=");
  });

  it("🔴🔴 ③ 手动提交与定时调度**两条路**都要解析该区的 Redshift 连接事实", () => {
    // 定时调度自序 73 起经单一作者 `job-spec.ts#emrRedshiftFactsFor`(它调 resolveRedshiftBinding;工作流离线作业节点同一份)
    expect(stripComments(SRC("lib/engines/emr/provider.ts")), "provider.ts 必须调 resolveRedshiftBinding(漏一处 = 那条路仍 permission denied)").toMatch(/resolveRedshiftBinding\(/);
    expect(stripComments(SRC("lib/engines/emr/schedule-fanout.ts")), "schedule-fanout.ts 必须经 emrRedshiftFactsFor").toMatch(/emrRedshiftFactsFor\(/);
    expect(stripComments(SRC("lib/engines/emr/job-spec.ts")), "job-spec.ts 必须调 resolveRedshiftBinding").toMatch(/resolveRedshiftBinding\(/);
  });

  it("④ 角色必备基线里要有「读该区 Redshift 凭证」这一条", () => {
    const sids = engineBaseline("emr", { region: "us-east-1", accountId: "123456789012" }).map((n) => n.sid);
    expect(sids, `实得 ${sids.join(",")}`).toContain("BaselineRedshiftCredential");
  });

  it("🔴 ⑤ 配方规则:不带 SecretArn 的调用要被检出,带了的**不许**被判违规", () => {
    const r = EMR_DIALECT_RULES.find((x) => x.id === "emr.redshift-data-needs-secret-arn");
    expect(r, "配方库里必须有这一条").toBeTruthy();
    expect(r!.rule).toMatch(/permission denied/);
    expect(r!.antiPattern!.test("rs.execute_statement(WorkgroupName=WG, Database=DB, Sql=sql)")).toBe(true);
    expect(r!.antiPattern!.test("rs.execute_statement(WorkgroupName=WG, Database=DB, SecretArn=SEC, Sql=sql)")).toBe(false);
    expect(r!.severity, "平台注入已经兜住了 ⇒ warn 而非 error(判据不许比事实更严)").toBe("warn");
  });
});
