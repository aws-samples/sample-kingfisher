// 调度 DAG 的 **执行面 / 控制面 region 拆分** 门禁(50 SPEC §3.1 的 `_mk_exec` / `_mk_ctrl`)。
//
// 🔴 这里的承重不是"执行面跟着 target 走",而是**控制面绝不跟着 target 走**:
// DAG 里的 `ddb` 写的是 home 的 `bgp-etl-jobs`(作业锁)与 `bgp-task-runs`(运行记录),
// 而 Node 侧 `run-lock.ts` 写的是**同一张表同一属性**(memory `crackC-residual-mwaa-lock-handoff`,
// 有 lock-parity 单测钉着)。一旦 `ddb` 跟着执行 region 走,锁就落到另一个 region 的另一张表
// ⇒ **跨执行体互斥当场失效**,症状是 DROP+CTAS 撞同表 OID —— 裂缝C 修过的那个事故原地复活,
// 而且**不报错**,只是偶发失败。所以这条必须是负向可执行断言,不是注释。
//
// 第二条承重:非 home 缺参**必须抛**。兜底的后果不是报错,而是"手动跑在第二区域、定时跑回了 home"
// 刚为同一个病收编过 workgroup 兜底,不能在这里重新开一个。
import { describe, it, expect, beforeEach } from "vitest";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import type { EtlJob } from "@/types/etl-job";

const BASE: EtlJob = {
  userId: "default-user",
  jobId: "01M1N39N0ED1JG80QGB044767E",
  name: "t",
  type: "redshift",
  script: "SELECT 1;",
  projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const USW2_OPTS = {
  redshiftSecretArn: "arn:aws:secretsmanager:us-west-2:1:secret:bgp/project/tgt-usw2-a/x",
  execRegion: "us-west-2",
  workgroup: "bgp-workgroup-tgt-usw2-a",
  database: "dev",
};

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
});

describe("🔴 home:两个 region 同值,行为等价", () => {
  it("EXEC_REGION 与 CTRL_REGION 都是 env,且落点仍是三级兜底的结果", () => {
    const py = generateEtlJobDag(BASE);
    expect(py).toContain('EXEC_REGION = "us-east-1"');
    expect(py).toContain('CTRL_REGION = "us-east-1"');
    expect(py).toContain('WorkgroupName="bgp-workgroup"');
    expect(py).toContain('Database="dev"');
  });

  it("home 不传额外参也能生成(存量作业一字不改)", () => {
    expect(() => generateEtlJobDag({ ...BASE, targetId: undefined })).not.toThrow();
    expect(() => generateEtlJobDag({ ...BASE, targetId: "tgt_home" })).not.toThrow();
  });
});

describe("🔴🔴 控制面绝不跟着 target 走(锁落错 region = 裂缝C 事故复活)", () => {
  it("非 home:glue / redshift-data 用 EXEC_REGION,**dynamodb 用 CTRL_REGION**", () => {
    const py = generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, USW2_OPTS);
    expect(py).toContain('EXEC_REGION = "us-west-2"');
    expect(py).toContain('CTRL_REGION = "us-east-1"');
    expect(py).toContain('glue = boto3.client("glue", region_name=EXEC_REGION)');
    expect(py).toContain('rsdata = boto3.client("redshift-data", region_name=EXEC_REGION)');
    expect(py, "ddb 跟着执行 region 走 ⇒ 作业锁落到另一个 region 的另一张表,跨执行体互斥失效").toContain(
      'ddb = boto3.resource("dynamodb", region_name=CTRL_REGION)'
    );
    // 🔴 负向:整份 DAG 里不许出现"用 EXEC_REGION 建 dynamodb"的任何写法
    expect(py).not.toMatch(/dynamodb"?,\s*region_name\s*=\s*EXEC_REGION/);
  });

  it("非 home:落点与凭证都换成该 target 的(负向:不许还是 home 的)", () => {
    const py = generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, USW2_OPTS);
    expect(py).toContain('WorkgroupName="bgp-workgroup-tgt-usw2-a"');
    expect(py).toContain(`SecretArn="${USW2_OPTS.redshiftSecretArn}"`);
    expect(py, "workgroup 还是 home ⇒ 定时运行静默打回 home 数仓").not.toContain('WorkgroupName="bgp-workgroup"');
  });

  it("控制面的表名仍是 home 那几张(锁与 run 记录都在中心)", () => {
    const py = generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, USW2_OPTS);
    expect(py).toContain('ddb.Table("bgp-etl-jobs")');
    expect(py).toContain('bgp-task-runs');
  });
});

describe("🔴 非 home 缺参必须抛(fail-closed,绝不兜底回 home)", () => {
  it.each([
    ["execRegion", { ...USW2_OPTS, execRegion: undefined }],
    ["workgroup", { ...USW2_OPTS, workgroup: undefined }],
    ["database", { ...USW2_OPTS, database: undefined }],
  ])("缺 %s ⇒ 抛", (_what, opts) => {
    expect(() => generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, opts as never)).toThrow(
      /必须显式传入该目标的 execRegion \/ workgroup \/ database/
    );
  });

  it("🔴 非 home 的 redshift 作业缺 SecretArn ⇒ 抛(否则 DAG 省掉该参数 = 退回 MWAA worker 联邦身份 = 属主分叉)", () => {
    expect(() =>
      generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, { ...USW2_OPTS, redshiftSecretArn: undefined })
    ).toThrow(/禁 IAM fallback/);
  });

  it("非 home 的 **glue** 作业不要求 SecretArn(它不连数仓)", () => {
    expect(() =>
      generateEtlJobDag(
        { ...BASE, type: "glue", glueJobName: "bgp-etl-x", targetId: "tgt_usw2_a" },
        { ...USW2_OPTS, redshiftSecretArn: undefined }
      )
    ).not.toThrow();
  });
});

describe("run 的章跟着作业绑定的 target(与 W2-a 的唯一写通道同源)", () => {
  it("DAG 里盖的 targetId = 作业行的 targetId,不是硬编码 home", () => {
    const py = generateEtlJobDag({ ...BASE, targetId: "tgt_usw2_a" }, USW2_OPTS);
    expect(py).toContain('"targetId": "tgt_usw2_a"');
    expect(py).not.toContain('"targetId": "tgt_home"');
  });

  it("存量作业(无 targetId)仍盖 home(向后兼容)", () => {
    expect(generateEtlJobDag(BASE)).toContain('"targetId": "tgt_home"');
  });
});
