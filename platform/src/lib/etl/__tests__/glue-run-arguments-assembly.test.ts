// @kf-batch 37-emr-run-date —— Glue 离线作业「立即运行 / 补数 / 重跑」(同一个 runGlueScriptJob)把**全套 15 个**业务日期参数
// 以 StartJobRun Arguments 传入(原来手抄 4 个:yesterday_ds_nodash / tomorrow_ds_nodash 从没传过),脚本对象逐字节 = 作业脚本(不烙日期)。
// 装配层:job-service ↔ run-params ↔ glue-job-name ↔ run-lock ↔ run-records 之间不 mock;只替换真外部:
//   Glue / S3 客户端工厂(记录命令)、DDB 写通道、数仓凭证(Secrets Manager)。home 落点走 env(与现网同一条路)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  glue: [] as Array<{ region: string; cmd: string; input: Record<string, unknown> }>,
  s3: [] as Array<{ region: string; cmd: string; input: Record<string, unknown> }>,
  ddb: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        h.ddb.push({ cmd: cmd.constructor.name, input: cmd.input });
        return cmd.constructor.name === "GetCommand" ? { Item: undefined } : {};
      },
    },
  };
});
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    glueClientFor: async (region: string) => ({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        h.glue.push({ region, cmd: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "GetJobCommand") throw new Error("EntityNotFoundException");
        if (cmd.constructor.name === "StartJobRunCommand") return { JobRunId: "jr_glue_0001" };
        return {};
      },
    }),
    s3ClientFor: async (region: string) => ({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        h.s3.push({ region, cmd: cmd.constructor.name, input: cmd.input });
        return {};
      },
    }),
  };
});
vi.mock("@/lib/redshift/admin-secret", () => ({
  getRedshiftSecretArn: async () => "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift-admin-AbCdEf",
}));

process.env.AWS_REGION = "us-east-1";
process.env.AWS_DEFAULT_REGION = "us-east-1";
process.env.AWS_ACCOUNT_ID = "123456789012";
process.env.GLUE_ROLE_ARN = "arn:aws:iam::123456789012:role/bgp-glue-role";
process.env.GLUE_SCRIPTS_BUCKET = "scripts-home";
process.env.EMR_LOG_BUCKET = "dl-home";
process.env.S3TABLES_BUCKET = "tb-home";

const { runGlueScriptJob } = await import("@/lib/etl/job-service");
const { runParamArguments, paramSet, RUN_PARAM_NAMES } = await import("@/lib/etl/run-params");

// 🔴 夹具 id 末 12 位必含字母
const JOB_ID = "01JGLUEDATEJOBXXXXXXXXXAB2";
const SCRIPT = "import sys\nfrom awsglue.utils import getResolvedOptions\nargs = getResolvedOptions(sys.argv, ['JOB_NAME', 'ds', 'bizdate'])\nprint(args)\n";
const job = (over: Record<string, unknown> = {}) =>
  ({
    userId: "default-user", jobId: JOB_ID, name: "glue-date-job", type: "glue", script: SCRIPT,
    projectId: "01HZZZZZZZZZZZZZZZZZZZZZZZ", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    glueConfig: {},
    ...over,
  }) as never;

const starts = () => h.glue.filter((c) => c.cmd === "StartJobRunCommand");
const creates = () => h.glue.filter((c) => c.cmd === "CreateJobCommand");
const scriptPuts = () => h.s3.filter((c) => c.cmd === "PutObjectCommand" && String(c.input.Key).startsWith("glue-scripts/etl/"));

beforeEach(() => { h.glue.length = 0; h.s3.length = 0; h.ddb.length = 0; });

describe("🔴 Glue 离线作业:业务日期参数全套、单一作者、脚本对象不烙日期", () => {
  it("指定日期 ⇒ StartJobRun.Arguments == runParamArguments(日期)(15 个,含原来漏掉的 nodash 两个与 biz 系)", async () => {
    const r = await runGlueScriptJob(job(), { runDate: "2026-09-01", triggeredBy: "manual", targetId: "tgt_home" });
    expect(r.runDate).toBe("2026-09-01");
    expect(starts()).toHaveLength(1);
    const args = starts()[0].input.Arguments as Record<string, string>;
    expect(args).toEqual(runParamArguments("2026-09-01"));
    expect(Object.keys(args)).toHaveLength(RUN_PARAM_NAMES.length);
    expect(args["--ds"]).toBe("2026-09-01");
    expect(args["--yesterday_ds_nodash"]).toBe("20260831");
    expect(args["--tomorrow_ds_nodash"]).toBe("20260902");
    expect(args["--bizdate"]).toBe("20260831");
    expect(args["--bizmonth"]).toBe("202608");
    for (const k of Object.keys(paramSet("2026-09-01"))) expect(args, `缺 --${k}`).toHaveProperty(`--${k}`);
  });

  it("补数 / 重跑(同一函数)按传入日期带参(负向对照:不同日期不同值)", async () => {
    await runGlueScriptJob(job(), { runDate: "2026-09-02", triggeredBy: "backfill", targetId: "tgt_home" });
    await runGlueScriptJob(job(), { runDate: "2026-09-03", triggeredBy: "rerun", targetId: "tgt_home" });
    expect(starts().map((c) => (c.input.Arguments as Record<string, string>)["--ds"])).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("🔴 脚本对象不随日期变:上传 Body 逐字节 = 作业脚本;作业定义里的 DefaultArguments 不含任何业务日期键(日期只在 StartJobRun 那一刻)", async () => {
    await runGlueScriptJob(job(), { runDate: "2026-09-01", targetId: "tgt_home" });
    expect(scriptPuts()).toHaveLength(1);
    expect(scriptPuts()[0].input.Body).toBe(SCRIPT);
    const def = creates()[0].input.DefaultArguments as Record<string, string>;
    for (const k of RUN_PARAM_NAMES) expect(def, `定义里不许烙 --${k}`).not.toHaveProperty(`--${k}`);
  });

  it("🔴 保留键:用户 jobParameters 写了 --bizdate / --yesterday_ds_nodash 也进不了定义(运行时由平台按日期注入)", async () => {
    await runGlueScriptJob(job({ glueConfig: { jobParameters: { "--bizdate": "19700101", yesterday_ds_nodash: "x", "--my_flag": "1" } } }), { runDate: "2026-09-01", targetId: "tgt_home" });
    const def = creates()[0].input.DefaultArguments as Record<string, string>;
    expect(def).not.toHaveProperty("--bizdate");
    expect(def).not.toHaveProperty("--yesterday_ds_nodash");
    expect(def["--my_flag"]).toBe("1");
    expect((starts()[0].input.Arguments as Record<string, string>)["--bizdate"]).toBe("20260831");
  });
});
