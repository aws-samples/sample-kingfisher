// EMR Serverless 作业的业务日期**从未进作业**。
//
// 【真实缺口】provider.submit 收到 opts.runDate 只写进台账;StartJobRun 的 entryPointArguments 恒为用户填的
//   那几个,脚本 j.script 原样上传 ⇒ 手动「指定日期运行」/ 补数 / 同日期重跑对 EMR 作业全是空转
//   (页面写着业务日期 2026-09-01,作业里拿不到任何日期)。
// 【装配层】provider ↔ application ↔ script ↔ run-record ↔ data-plane-target(落点)↔ run-lock 之间**不 mock**;
//   只替换真外部:EMR / S3 客户端工厂(记录命令)、DDB 写通道、主控区默认网络(EC2)、数仓凭证(Secrets Manager)、血缘双写。
// 【判据钉事实】StartJobRun 入参的 entryPointArguments = 用户入参 + 与 Glue 离线作业同一张表的 15 个业务日期参数
//   (单一作者 lib/etl/run-params.ts#runParamArgv);上传到 S3 的脚本**逐字节 = 作业脚本**(不含日期,存量脚本对象不随某一天变)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  emr: [] as Array<{ region: string; cmd: string; input: Record<string, unknown> }>,
  s3: [] as Array<{ region: string; cmd: string; input: Record<string, unknown> }>,
  ddb: [] as Array<{ cmd: string; input: Record<string, unknown> }>,
  job: {} as Record<string, unknown>,
}));

vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const TABLES = real.TABLES as Record<string, string>;
  return {
    ...real,
    docClient: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        h.ddb.push({ cmd: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "GetCommand") {
          return cmd.input.TableName === TABLES.ENGINE_JOBS ? { Item: h.job } : { Item: undefined };
        }
        return {};
      },
    },
  };
});

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    emrServerlessClientFor: async (region: string) => ({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        h.emr.push({ region, cmd: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "GetApplicationCommand") {
          return { application: { state: "STARTED", networkConfiguration: { subnetIds: ["subnet-home"], securityGroupIds: ["sg-home"] } } };
        }
        if (cmd.constructor.name === "StartJobRunCommand") return { jobRunId: "jr-0001" };
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

vi.mock("@/lib/engines/platform-env", () => ({
  getEmrDefaultNetwork: async () => ({ subnetIds: ["subnet-home"], securityGroupIds: ["sg-home"] }),
}));
vi.mock("@/lib/redshift/admin-secret", () => ({
  getRedshiftSecretArn: async () => "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift-admin-AbCdEf",
}));
vi.mock("@/lib/governance/lineage-service", () => ({ recordComputeLineage: async () => {} }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushComputeLineageToOM: async () => {} }));

process.env.AWS_REGION = "us-east-1";
process.env.AWS_DEFAULT_REGION = "us-east-1";
process.env.AWS_ACCOUNT_ID = "123456789012";
process.env.EMR_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/bgp-emr-serverless-role";
process.env.GLUE_SCRIPTS_BUCKET = "scripts-home";
process.env.EMR_LOG_BUCKET = "dl-home";
process.env.S3TABLES_BUCKET = "tb-home";
process.env.EMR_S3TABLES_JAR = "s3://scripts-home/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar";

const { emrServerlessProvider } = await import("@/lib/engines/emr/provider");
const { EMR_SPEC_DEFAULT } = await import("@/lib/engines/emr/spec");
const { runParamArgv, paramSet } = await import("@/lib/etl/run-params");

// 🔴 夹具 id 末 12 位必含字母(redline 门只认纯数字 12 位为账号号)
const JOB_ID = "01JEMRDATEJOBXXXXXXXXXXAB1";
const PID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const SCRIPT = "import sys\nprint(sys.argv)\n# 业务日期从 --ds 读,脚本文本里不含日期\n";
const job = (over: Record<string, unknown> = {}) =>
  ({
    userId: "default-user", jobId: JOB_ID, engine: "emr-serverless", name: "emr-date-job", projectId: PID,
    script: SCRIPT, spec: EMR_SPEC_DEFAULT, network: { subnetIds: ["subnet-home"], securityGroupIds: ["sg-home"] },
    targets: ["tgt_home"], applicationId: "app-home-0001", entryPointArguments: ["--mode", "daily"],
    ...over,
  }) as never;

const startJobRuns = () => h.emr.filter((c) => c.cmd === "StartJobRunCommand");
const scriptPuts = () => h.s3.filter((c) => c.cmd === "PutObjectCommand" && String(c.input.Key).startsWith("emr-scripts/"));
const sparkSubmit = (c: { input: Record<string, unknown> }) =>
  (c.input.jobDriver as { sparkSubmit: { entryPoint: string; entryPointArguments: string[]; sparkSubmitParameters: string } }).sparkSubmit;

beforeEach(() => {
  h.emr.length = 0; h.s3.length = 0; h.ddb.length = 0;
  h.job = job();
});

describe("🔴🔴 EMR submit 把业务日期以参数形式传进作业(手动 / 补数 / 重跑同一条路)", () => {
  it("指定业务日期 ⇒ entryPointArguments = 用户入参 + 全套业务日期参数(与 Glue 离线作业同一张表、同一顺序)", async () => {
    const r = await emrServerlessProvider.submit(job(), { runDate: "2026-09-01", triggeredBy: "manual", targetId: "tgt_home" });
    expect(r.runDate).toBe("2026-09-01");
    expect(startJobRuns()).toHaveLength(1);
    const args = sparkSubmit(startJobRuns()[0]).entryPointArguments;
    // 用户入参在前(位置参数的下标不变),平台参数追加在后
    expect(args.slice(0, 2)).toEqual(["--mode", "daily"]);
    expect(args.slice(2)).toEqual(runParamArgv("2026-09-01"));
    // 事实(不是形状):--ds 后面紧跟的是那一天;15 个键一个不少
    const i = args.indexOf("--ds");
    expect(i).toBeGreaterThan(1);
    expect(args[i + 1]).toBe("2026-09-01");
    for (const k of Object.keys(paramSet("2026-09-01"))) expect(args, `缺 --${k}`).toContain(`--${k}`);
    expect(args[args.indexOf("--bizdate") + 1]).toBe("20260831");
    expect(args[args.indexOf("--bizmonth") + 1]).toBe("202608");
  });

  it("补数(triggeredBy=backfill)与同日期重跑(rerun)走同一条路:实例日期 ⇒ 参数里就是那一天(负向对照:不同日期不同值)", async () => {
    await emrServerlessProvider.submit(job(), { runDate: "2026-09-02", triggeredBy: "backfill", targetId: "tgt_home" });
    await emrServerlessProvider.submit(job(), { runDate: "2026-09-03", triggeredBy: "rerun", targetId: "tgt_home" });
    const runs = startJobRuns();
    expect(runs).toHaveLength(2);
    const dsOf = (c: { input: Record<string, unknown> }) => { const a = sparkSubmit(c).entryPointArguments; return a[a.indexOf("--ds") + 1]; };
    expect(runs.map(dsOf)).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("没传日期 ⇒ 与 Glue 离线作业同一缺省:今天(UTC),参数照样带、台账 runDate 不再是空", async () => {
    const r = await emrServerlessProvider.submit(job(), { triggeredBy: "manual", targetId: "tgt_home" });
    const today = new Date().toISOString().slice(0, 10);
    expect(r.runDate).toBe(today);
    const args = sparkSubmit(startJobRuns()[0]).entryPointArguments;
    expect(args[args.indexOf("--ds") + 1]).toBe(today);
    const put = h.ddb.find((c) => c.cmd === "PutCommand");
    expect(put, "台账行必须写").toBeTruthy();
    expect((put!.input.Item as Record<string, unknown>).runDate).toBe(today);
  });

  it("用户没填入参 ⇒ 参数就只有平台追加的那一套(首个即 --ds,不再是空列表)", async () => {
    const r = await emrServerlessProvider.submit(job({ entryPointArguments: undefined }), { runDate: "2026-09-01", targetId: "tgt_home" });
    expect(r.runId).toBeTruthy();
    const args = sparkSubmit(startJobRuns()[0]).entryPointArguments;
    expect(args).toEqual(runParamArgv("2026-09-01"));
    expect(args[0]).toBe("--ds");
  });

  it("🔴 脚本对象不随日期变:上传到 S3 的 Body 逐字节 = 作业脚本,entryPoint 指向该对象", async () => {
    await emrServerlessProvider.submit(job(), { runDate: "2026-09-01", targetId: "tgt_home" });
    const puts = scriptPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0].input.Body).toBe(SCRIPT);
    expect(String(puts[0].input.Body)).not.toContain("2026-09-01");
    expect(String(puts[0].input.Body)).not.toContain("20260901");
    expect(sparkSubmit(startJobRuns()[0]).entryPoint).toBe(`s3://scripts-home/${puts[0].input.Key}`);
  });

  it("非法日期当场拒,不上传脚本、不 StartJobRun", async () => {
    await expect(emrServerlessProvider.submit(job(), { runDate: "20260901", targetId: "tgt_home" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(startJobRuns()).toHaveLength(0);
    expect(scriptPuts()).toHaveLength(0);
  });
});

// 起手模板 ↔ 平台追加参数的接缝:模板里的读参函数真能从 runParamArgv 的形状里读出那一天(真 python3)
describe("EMR 起手模板按参数名读业务日期(与平台追加的形态一致)", () => {
  it("用户入参在前 + 平台追加在后 ⇒ 模板读到 ds / ds_nodash / bizdate 就是那一天;没有参数 ⇒ 空串(不再误把 --ds 当日期)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { EMR_PYSPARK_TEMPLATE } = await import("@/types/engine-job");
    expect(EMR_PYSPARK_TEMPLATE).not.toContain("sys.argv[1] if len(sys.argv) > 1");
    expect(EMR_PYSPARK_TEMPLATE).toContain('ds = _arg("ds")');
    // 只取模板里「import sys」到「spark = SparkSession」之前的读参部分(pyspark 不在本机)
    const head = EMR_PYSPARK_TEMPLATE.split("spark = SparkSession")[0].split("\n").filter((l) => !l.startsWith("from pyspark")).join("\n");
    const run = (argv: string[]) =>
      JSON.parse(execFileSync("python3", ["-c", `${head}\nimport json\nprint(json.dumps([ds, ds_nodash, bizdate]))`, ...argv], { encoding: "utf8" }).trim());
    expect(run(["--mode", "daily", ...runParamArgv("2026-09-01")])).toEqual(["2026-09-01", "20260901", "20260831"]);
    expect(run(runParamArgv("2026-03-01"))).toEqual(["2026-03-01", "20260301", "20260228"]);
    expect(run([])).toEqual(["", "", ""]);
  });
});
