// 2026-11-04(A)—— 工作流 SQL 节点补数在**实例自带的区**执行(工作流离线作业节点设计 §4「usw2 工作流:补数计划勾该工作流 ⇒ 节点按日期跑」)。
//
// 【缺陷原形】`lib/backfill/execute.ts` 的 SQL 分支用模块级 `redshiftClientForHomeOnly("workflow-no-target-dim")` + `homeWorkgroup()`
//   (写于编排没有区域维的年代),而计划早已按 日期 × 节点 × 绑定区展开、实例自带 `targetId` ⇒ 只能靠 「只支持主控区」守卫 的 400 守卫把绑了非主控区的
//   工作流整个拒掉。根治 = 按实例的区走唯一作者 `resolveRedshiftBinding`(region / workgroup / database / 凭证四样一起),
//   客户端 `redshiftDataClientFor(binding.region)`,锁名与 run 行的章都按这个区。
// 只 mock 真外部(DDB docClient / 数仓绑定解析器 / Redshift Data 客户端工厂);run-records · run-lock · run-extra 等兄弟模块一律真跑。
// 判据钉**事实**(调用参数:region / workgroup / database / SecretArn / 锁属性名 / run 行的 targetId),不钉写法。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const h = vi.hoisted(() => ({
  wf: {} as Record<string, unknown>,
  ddb: [] as Array<{ name: string; input: Record<string, any> }>,
  bindings: [] as Array<Record<string, unknown>>,
  clients: [] as string[],
  sends: [] as Array<{ region: string; name: string; input: Record<string, any> }>,
}));
const BINDINGS: Record<string, Record<string, unknown>> = {
  tgt_home: { targetId: "tgt_home", region: "us-east-1", workgroup: "bgp-workgroup", database: "dev", secretArn: "arn:aws:secretsmanager:us-east-1:123456789abc:secret:home", degradedToLegacyAdmin: true, home: true, jurisdiction: "home" },
  tgt_usw2_a: { targetId: "tgt_usw2_a", region: "us-west-2", workgroup: "bgp-workgroup-usw2-a", database: "dev", secretArn: "arn:aws:secretsmanager:us-west-2:123456789abc:secret:usw2", degradedToLegacyAdmin: false, home: false, jurisdiction: "home" },
};
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (cmd: Cmd) => {
        h.ddb.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "GetCommand") return { Item: h.wf };
        return {};
      },
    },
  };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    resolveRedshiftBinding: async (args: Record<string, unknown>) => {
      h.bindings.push(args);
      const b = BINDINGS[String(args.targetId)];
      if (!b) throw new Error(`执行环境 ${String(args.targetId)} 不存在或未就绪 —— 拒绝(不回落主控区)`);
      return b;
    },
  };
});
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    redshiftDataClientFor: (region: string) => {
      h.clients.push(region);
      return {
        send: async (cmd: Cmd) => {
          h.sends.push({ region, name: cmd.constructor.name, input: cmd.input });
          if (cmd.constructor.name === "BatchExecuteStatementCommand") return { Id: `stmt-${region}` };
          if (cmd.constructor.name === "DescribeStatementCommand") return { Status: "FINISHED", Duration: 3e9, ResultRows: 7 };
          return {};
        },
      };
    },
  };
});

const { TABLES } = await import("@/lib/aws/dynamodb");
const { executeInstance } = await import("@/lib/backfill/execute");

const PROJ = "proj-01M1KP594D2E6DJQC8EZ8CRAES";
const PLAN_ID = "01PLAN00000000000000000AAB";
const plan = { target: { scope: "workflow", kind: "workflow", id: "wf1", name: "日报" } } as never;
const inst = (over: Record<string, unknown>) =>
  ({ planId: PLAN_ID, sk: "x", date: "2026-10-01", nodeId: "n1", nodeName: "汇总", status: "running", dependsOn: [], attempts: 1, ttl: 0, ...over }) as never;
const wfRow = (targets: string[]) => ({
  userId: "default-user", workflowId: "wf1", name: "日报", projectId: PROJ, targets,
  dagDefinition: { nodes: [{ id: "n1", type: "sql", data: { label: "汇总", sql: "DROP TABLE IF EXISTS t_${ds}; CREATE TABLE t_${ds} AS SELECT 1" } }], edges: [] },
});
const lockUpdates = () => h.ddb.filter((c) => c.name === "UpdateCommand" && c.input.TableName === TABLES.WORKFLOWS);
const runPuts = () => h.ddb.filter((c) => c.name === "PutCommand" && c.input.TableName === TABLES.TASK_RUNS).map((c) => c.input.Item);

beforeEach(() => {
  h.wf = wfRow(["tgt_home", "tgt_usw2_a"]);
  h.ddb = []; h.bindings = []; h.clients = []; h.sends = [];
});
afterEach(() => vi.useRealTimers());

describe("🔴 工作流 SQL 节点补数按实例的区执行", () => {
  it("usw2 实例 ⇒ 绑定按 (tgt_usw2_a, 工作流 projectId) 解析;客户端取 us-west-2;语句提交到该区的 workgroup / database / 密钥", async () => {
    const r = await executeInstance(plan, inst({ targetId: "tgt_usw2_a" }));
    expect(h.bindings).toEqual([{ targetId: "tgt_usw2_a", projectId: PROJ }]);
    expect(h.clients).toEqual(["us-west-2"]);
    const submit = h.sends.find((s) => s.name === "BatchExecuteStatementCommand")!;
    expect(submit.region).toBe("us-west-2");
    expect(submit.input).toEqual({
      Sqls: ["DROP TABLE IF EXISTS t_2026-10-01", "CREATE TABLE t_2026-10-01 AS SELECT 1"],
      WorkgroupName: "bgp-workgroup-usw2-a",
      Database: "dev",
      SecretArn: BINDINGS.tgt_usw2_a.secretArn,
    });
    expect(r.runTaskId).toBe("wf1");
    expect(typeof r.runId).toBe("string");
  });

  it("run 行的章 = 实例的区(任务监控按它显示区),triggeredBy=backfill,带计划 / 节点引用与该区的 statementId", async () => {
    await executeInstance(plan, inst({ targetId: "tgt_usw2_a" }));
    const [row] = runPuts();
    expect(row).toMatchObject({
      taskId: "wf1", taskType: "workflow", triggeredBy: "backfill", status: "running",
      projectId: PROJ, targetId: "tgt_usw2_a",
      runDate: "2026-10-01", statementId: "stmt-us-west-2", backfillPlanId: PLAN_ID, backfillNode: "n1",
    });
  });

  it("节点锁的 target 维 = 实例的区(与 usw2 运行时 _lock_attr_for 同一把锁;home 实例逐字节沿用存量名)", async () => {
    await executeInstance(plan, inst({ targetId: "tgt_usw2_a" }));
    expect(lockUpdates()[0].input.ExpressionAttributeNames).toEqual({ "#t": "runLock-tgt_usw2_a-n1Token", "#e": "runLock-tgt_usw2_a-n1ExpiresAt" });
    h.ddb = [];
    await executeInstance(plan, inst({ targetId: "tgt_home" }));
    expect(lockUpdates()[0].input.ExpressionAttributeNames).toEqual({ "#t": "runLock_n1Token", "#e": "runLock_n1ExpiresAt" });
  });

  it("home 实例:客户端 us-east-1、主控区 workgroup、章 = tgt_home(存量路径逐字节等价)", async () => {
    await executeInstance(plan, inst({ targetId: "tgt_home" }));
    expect(h.clients).toEqual(["us-east-1"]);
    expect(h.sends.find((s) => s.name === "BatchExecuteStatementCommand")!.input).toMatchObject({ WorkgroupName: "bgp-workgroup", Database: "dev", SecretArn: BINDINGS.tgt_home.secretArn });
    expect(runPuts()[0].targetId).toBe("tgt_home");
  });

  it("存量实例没有 targetId ⇒ 回落工作流绑定的第一个区(只绑 usw2 的工作流 ⇒ usw2),绝不静默回主控区", async () => {
    h.wf = wfRow(["tgt_usw2_a"]);
    await executeInstance(plan, inst({ targetId: undefined }));
    expect(h.bindings[0].targetId).toBe("tgt_usw2_a");
    expect(h.clients).toEqual(["us-west-2"]);
    expect(runPuts()[0].targetId).toBe("tgt_usw2_a");
  });

  it("🔴 绑定解析不到(区不存在 / 未就绪)⇒ 如实抛,且**没有**抢锁、没有提交语句、没有 run 行(不替它挑区)", async () => {
    await expect(executeInstance(plan, inst({ targetId: "tgt_eu_x" }))).rejects.toThrow("不回落主控区");
    expect(lockUpdates()).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(runPuts()).toEqual([]);
  });

  it("后台轮询用**提交时同一个区**的客户端 Describe,终态回写 run 行(章仍是该区)并释放该区的锁", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await executeInstance(plan, inst({ targetId: "tgt_usw2_a" }));
    h.ddb = [];
    await vi.advanceTimersByTimeAsync(2100);
    const desc = h.sends.filter((s) => s.name === "DescribeStatementCommand");
    expect(desc.length).toBe(1);
    expect(desc[0]).toMatchObject({ region: "us-west-2", input: { Id: "stmt-us-west-2" } });
    const runUpdate = h.ddb.find((c) => c.name === "UpdateCommand" && c.input.TableName === TABLES.TASK_RUNS)!;
    expect(runUpdate, "终态没有回写 run 行").toBeTruthy();
    expect(Object.values(runUpdate.input.ExpressionAttributeValues)).toContain("succeeded");
    expect(runUpdate.input.ExpressionAttributeValues[":st"]).toBe("tgt_usw2_a");
    const release = h.ddb.find((c) => c.name === "UpdateCommand" && c.input.TableName === TABLES.WORKFLOWS && /^REMOVE/.test(c.input.UpdateExpression))!;
    expect(release, "终态后没有释放节点锁").toBeTruthy();
    expect(release.input.ExpressionAttributeNames["#t"]).toBe("runLock-tgt_usw2_a-n1Token");
  });
});
