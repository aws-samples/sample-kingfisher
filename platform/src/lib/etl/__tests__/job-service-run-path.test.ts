// @kf-batch 50-P50.3-fanout
// 🔴🔴 **提交路径必须过真的 run 写通道** —— 这一条是被真环境咬出来的。
//
// ── 事故经过(2026-09-04,W3-a 真环境验收 W3a-5)────────────────────────────────
// W3-b 上半段给 `createRunRecord` 的 `extra` 里加了 `targetId: binding.targetId`(想让 run 行带上它)。
// 但归属字段**只能经 `stamp` 参数落地**:`putRunRecord` 里的 `assertStampable` 会当场抛
// (52 SPEC §1,防调用方绕过单一写通道写别的项目号)。后果是
// **所有 Redshift ETL 作业的运行都 500**(home 与非 home 一起挂,功能守恒被打破)。
// 而 tsc 全绿、1872 条单测全绿 —— 因为**没有一条测试真的调过提交路径**,
// 而它是运行期校验,mock 掉写通道就永远测不出来。
//
// ⇒ 本文件的规矩:**只打桩到 AWS SDK 边界**(DDB / redshift-data)与绑定解析,
//   `run-records` 用**真的**。于是"往 extra 里塞归属字段"这类错会在单测阶段就红。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, any>>,
  sent: [] as Array<{ ctor: string; input: Record<string, any> }>,
  statements: [] as Array<Record<string, any>>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { ETL_JOBS: "bgp-etl-jobs", TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = cmd.input || {};
      h.sent.push({ ctor: cmd.constructor.name, input });
      if (input.Item) {
        h.rows[`${input.Item.taskId}#${input.Item.runId}`] = { ...input.Item };
        return {};
      }
      return {};
    }),
  },
}));

vi.mock("@/lib/exec-env/target-clients", () => ({
  redshiftDataClientFor: vi.fn(() => ({
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name.startsWith("BatchExecuteStatement")) {
        h.statements.push(cmd.input);
        return { Id: "stmt-1" };
      }
      return { Status: "FINISHED", Duration: 1e9 };
    },
  })),
}));

vi.mock("@/lib/exec-env/data-plane-target", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (args: { targetId?: string }) => {
      const tid = args.targetId || "tgt_home";
      // @kf-batch 50-W5-seg2-WP10a:真 RedshiftBinding 带 `jurisdiction`(此前 mock 漏了;同法域 ⇒ 运行提交不写区域审计、不读注册表)
      return tid === "tgt_home"
        ? {
            targetId: tid, region: "us-east-1", workgroup: "bgp-workgroup", database: "dev",
            secretArn: "arn:home", degradedToLegacyAdmin: true, home: true, jurisdiction: "home",
          }
        : {
            targetId: tid, region: "us-west-2", workgroup: "bgp-workgroup-tgt-usw2-a", database: "dev",
            secretArn: "arn:usw2", degradedToLegacyAdmin: true, home: false, jurisdiction: "home",
          };
    }),
  };
});

import { runRedshiftSqlJob, dryRunRedshiftSqlJob } from "@/lib/etl/job-service";

const job = (over: Record<string, unknown> = {}) =>
  ({
    userId: "default-user",
    jobId: "J1",
    name: "n",
    type: "redshift",
    projectId: "proj-x",
    script: "SELECT 1;",
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as any;

const runRowsOf = (taskId: string) =>
  Object.values(h.rows).filter((r) => r.taskId === taskId && r.taskType?.startsWith("etl-"));

beforeEach(() => {
  h.rows = {};
  h.sent.length = 0;
  h.statements.length = 0;
});

describe("🔴🔴 正式运行:真的过 run 写通道(往 extra 塞归属字段会当场红)", () => {
  it("home 作业提交成功,run 行带 projectId + targetId=tgt_home", async () => {
    const res = await runRedshiftSqlJob(job({ targets: ["tgt_home"] }));
    expect(res.runId, "提交路径抛了 ⇒ 现网表现为「运行失败 500」").toBeTruthy();
    const rows = runRowsOf("J1");
    expect(rows.length).toBe(1);
    expect(rows[0].projectId).toBe("proj-x");
    expect(rows[0].targetId).toBe("tgt_home");
    // 章只能来自 stamp;`extra` 里若也带一份,写通道会抛(这正是本文件存在的理由)
    expect(rows[0].statementId).toBe("stmt-1");
  });

  it("🔴 绑定非 home 的作业:章是那个 target,且 SQL 打的是它的 workgroup", async () => {
    const res = await runRedshiftSqlJob(job({ targets: ["tgt_usw2_a"] }));
    expect(res.targetId).toBe("tgt_usw2_a");
    expect(runRowsOf("J1")[0].targetId, "章回落 home ⇒ 监控页按区域筛选从此不可信").toBe("tgt_usw2_a");
    expect(h.statements[0].WorkgroupName).toBe("bgp-workgroup-tgt-usw2-a");
    expect(h.statements[0].SecretArn, "省略 SecretArn 会退回联邦身份 ⇒ 表属主分叉").toBe("arn:usw2");
  });

  it("扇出:同一作业逐 target 提交 ⇒ 两条 run,各自盖自己的章", async () => {
    await runRedshiftSqlJob(job({ targets: ["tgt_home", "tgt_usw2_a"] }), { targetId: "tgt_home" });
    await runRedshiftSqlJob(job({ targets: ["tgt_home", "tgt_usw2_a"] }), { targetId: "tgt_usw2_a" });
    const stamps = runRowsOf("J1").map((r) => r.targetId).sort();
    expect(stamps).toEqual(["tgt_home", "tgt_usw2_a"]);
  });

  it("试运行(EXPLAIN)同样过真写通道", async () => {
    const res = await dryRunRedshiftSqlJob(job({ targets: ["tgt_usw2_a"], script: "SELECT 1;" }));
    expect(res.runId).toBeTruthy();
    const rows = Object.values(h.rows).filter((r) => r.taskType === "etl-redshift-dryrun");
    expect(rows.length).toBe(1);
    expect(rows[0].targetId).toBe("tgt_usw2_a");
    expect(rows[0].dryRun).toBe(true);
  });

  it("🔴 锁属性名带 target:非 home 的锁不许落在存量 home 的属性上", async () => {
    await runRedshiftSqlJob(job({ targets: ["tgt_usw2_a"] }));
    const lockWrites = h.sent.filter((x) => JSON.stringify(x.input.ExpressionAttributeNames || {}).includes("runLock"));
    expect(lockWrites.length, "根本没抢锁 ⇒ 并发 DROP+CTAS 会撞同表 OID").toBeGreaterThan(0);
    const names = JSON.stringify(lockWrites[0].input.ExpressionAttributeNames);
    expect(names).toContain("runLock-tgt_usw2_a");
  });
});

// @kf-batch 50-W3f-T0-T3
describe("🔴 T2:扇出分组透传到 run 行(真过写通道)", () => {
  it("同一次请求的两条 run 带**同一个** runGroupId;单区运行不带;试运行同样透传", async () => {
    const { runGroupIdFor } = await import("@/lib/monitor/run-group");
    const rg = runGroupIdFor(["tgt_home", "tgt_usw2_a"]);
    const j = job({ targets: ["tgt_home", "tgt_usw2_a"] });
    await runRedshiftSqlJob(j, { targetId: "tgt_home", runGroupId: rg });
    await runRedshiftSqlJob(j, { targetId: "tgt_usw2_a", runGroupId: rg });
    expect(runRowsOf("J1").map((r) => r.runGroupId)).toEqual([rg, rg]);

    h.rows = {};
    await runRedshiftSqlJob(job({ targets: ["tgt_home"] }), { targetId: "tgt_home", runGroupId: runGroupIdFor(["tgt_home"]) });
    expect("runGroupId" in runRowsOf("J1")[0], "单区运行不许落 runGroupId").toBe(false);

    h.rows = {};
    await dryRunRedshiftSqlJob(j, { targetId: "tgt_usw2_a", runGroupId: rg });
    expect(Object.values(h.rows)[0].runGroupId).toBe(rg);
  });
});
