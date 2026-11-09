// 🔴🔴 Glue 作业原来**没有**本区数仓事实可读(EMR 早有 `spark.bgp.redshift*`)⇒ 配方只能教 AI「写死 bgp-workgroup」
//   ⇒ 绑到别的区的作业打到主控区的工作组名。现在 ensureGlueJob 注入 `--bgp_redshift_workgroup/_database/_secret_arn`
//   (与 EMR 同一个作者 `resolveRedshiftBinding`),且列为保留键(用户 jobParameters 盖不掉)。
// 只 mock 真外部:Glue / S3 客户端(target-clients)与落点解析(注册表边界,data-plane-target)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ sent: [] as { name: string; input: any }[], rsFail: false }));

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const fake = { send: async (cmd: any) => { h.sent.push({ name: cmd.constructor.name, input: cmd.input }); if (cmd.constructor.name === "GetJobCommand") throw new Error("EntityNotFoundException"); return {}; } };
  return { ...real, glueClientFor: async () => fake, s3ClientFor: async () => fake };
});

// 数据湖表桶路由:ensureGlueJob 按本区路由表注入目录(真外部 DDB:bgp-settings 的路由行;本判据没有外部路由 ⇒ 只有平台路由)
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real: any = await orig();
  return { ...real, docClient: { send: async (cmd: any) => (cmd.constructor.name === "QueryCommand" ? { Items: [] } : {}) } };
});

vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: async ({ targetId }: { targetId: string }) => ({
      targetId, region: "us-west-2", scriptsBucket: "scripts-usw2", datalakeBucket: "dl-usw2", tableBucket: "tb-usw2",
      roleArn: "arn:aws:iam::000000000000:role/glue-usw2", jurisdiction: "home",
    }),
    resolveRedshiftBinding: async ({ targetId }: { targetId: string }) => {
      if (h.rsFail) throw new Error("missing-component redshift");
      return { targetId, region: "us-west-2", workgroup: "wg-usw2", database: "db-usw2", secretArn: "arn:secret:usw2", home: false };
    },
  };
});

import { ensureGlueJob } from "../job-service";

const job = (extra: Record<string, unknown> = {}) => ({ jobId: "01JOBJOBJOBJOBJOBJOB", type: "glue", script: "print(1)", glueConfig: { ...extra } }) as any;
const created = () => h.sent.find((x) => x.name === "CreateJobCommand")!.input.DefaultArguments as Record<string, string>;

describe("🔴 ensureGlueJob 注入本区数仓三事实", () => {
  beforeEach(() => { h.sent.length = 0; h.rsFail = false; });

  it("usw2:DefaultArguments 带 --bgp_redshift_workgroup / _database / _secret_arn = 该区实名", async () => {
    await ensureGlueJob(job(), "tgt_usw2_a");
    const a = created();
    expect(a["--bgp_redshift_workgroup"]).toBe("wg-usw2");
    expect(a["--bgp_redshift_database"]).toBe("db-usw2");
    expect(a["--bgp_redshift_secret_arn"]).toBe("arn:secret:usw2");
    expect(a["--bgp_region"]).toBe("us-west-2");
  });

  it("🔴 保留键:用户 jobParameters 盖不掉(盖掉 = 允许把作业指到别的区)", async () => {
    await ensureGlueJob(job({ jobParameters: { "--bgp_redshift_workgroup": "evil", bgp_redshift_database: "x" } }), "tgt_usw2_a");
    const a = created();
    expect(a["--bgp_redshift_workgroup"]).toBe("wg-usw2");
    expect(a["--bgp_redshift_database"]).toBe("db-usw2");
  });

  it("该区解析不出数仓 ⇒ 不阻断作业,但也**不**填别的区的值(读这些参数的代码会当场报缺参)", async () => {
    h.rsFail = true;
    await ensureGlueJob(job(), "tgt_usw2_a");
    const a = created();
    expect(Object.keys(a).filter((k) => k.startsWith("--bgp_redshift_"))).toEqual([]);
    expect(a["--bgp_region"]).toBe("us-west-2");
  });
});
