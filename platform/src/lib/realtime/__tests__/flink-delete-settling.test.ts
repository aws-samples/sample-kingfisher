// @kf-batch 50-B28-flink-delete-settling
// 🔴🔴 B-28(2026-10-01 新账号硬门 `scq` A3-撤 真撞):停止后紧接着删除 ⇒ 应用正 STOPPING ⇒ 原实现只等 RUNNING_LIKE(不含 STOPPING)
//   ⇒ 直接 DeleteApplication ⇒ ResourceInUse ⇒ 页面 502「请重试」,作业留着(验收残留就是这么攒出来的)。
// 只 mock 真外部:MSAF / 日志客户端工厂(target-clients)+ DynamoDB(忠实执行 SET / 条件删除的假表)。
// @kf-batch 50-B28b-flink-delete-async —— 🔴 B-28 第二次:判据改钉**用户结果**(点一次删除 ⇒ 行最终消失),
//   第一次只钉了「回 409」,于是第九轮硬门同一条再红(用户:「别总是在同一个地方踩坑」)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const h = vi.hoisted(() => ({
  statuses: [] as (string | null)[],
  sent: [] as string[],
  afterStop: null as (string | null)[] | null,
  rows: new Map<string, Record<string, any>>(),
}));

vi.mock("@/lib/aws/dynamodb", () => {
  const TABLES = new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) });
  const applySet = (row: Record<string, any>, expr: string, names: Record<string, string>, values: Record<string, any>) => {
    for (const part of expr.replace(/^SET\s+/, "").split(",")) {
      const [l, r] = part.split("=").map((x) => x.trim());
      row[names[l] ?? l] = values[r];
    }
  };
  return {
    TABLES,
    docClient: {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        const i = cmd.input;
        const key = i.Key?.jobId;
        if (n === "GetCommand") return { Item: h.rows.get(key) };
        if (n === "UpdateCommand") {
          const row = h.rows.get(key) ?? { jobId: key };
          applySet(row, i.UpdateExpression, i.ExpressionAttributeNames ?? {}, i.ExpressionAttributeValues ?? {});
          h.rows.set(key, row);
          return {};
        }
        if (n === "DeleteCommand") {
          const row = h.rows.get(key);
          if (i.ConditionExpression) {
            const field = i.ExpressionAttributeNames["#s"];
            if (!row || row[field] !== i.ExpressionAttributeValues[":d"]) {
              const e: any = new Error("ccf"); e.name = "ConditionalCheckFailedException"; throw e;
            }
          }
          h.rows.delete(key);
          return {};
        }
        return {};
      },
    },
  };
});

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const kda = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      h.sent.push(n);
      // 🔴 RUNNING 的应用只有**真收到** StopApplication 才会往下走(第一版 fake 自己就会变 READY ⇒ 「不先停」变异没抓到)
      if (n === "StopApplicationCommand" && h.afterStop) { h.statuses = h.afterStop; h.afterStop = null; return {}; }
      if (n === "DescribeApplicationCommand") {
        const st = h.statuses.length > 1 ? h.statuses.shift()! : h.statuses[0];
        if (st === null) { const e: any = new Error("nf"); e.name = "ResourceNotFoundException"; throw e; }
        if (st === "DENIED") { const e: any = new Error("denied"); e.name = "AccessDeniedException"; throw e; }
        return { ApplicationDetail: { ApplicationStatus: st, CreateTimestamp: new Date(0) } };
      }
      if (n === "DeleteApplicationCommand") {
        const cur = h.statuses[0];
        if (cur && cur !== "READY") { const e: any = new Error(`in use: ${cur}`); e.name = "ResourceInUseException"; throw e; }
        return {};
      }
      return {};
    },
  };
  const noop = { send: async () => ({}) };
  return { ...real, kdaClientFor: async () => kda, logsClientFor: async () => noop, s3ClientFor: async () => noop, cloudWatchClientFor: async () => noop, secretsClientFor: async () => noop };
});

// @kf-batch 50-WP31-place-first-class —— 主控区的 Flink 落点也读描述符了(序 3 收尾)⇒ 注册表是真外部(DDB 边界),在这里给主控区一份描述符
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  const ACCT = "000000000000";
  const home = {
    targetId: "tgt_home", region: "us-east-1", accountId: ACCT, partition: "aws", version: 1, status: "active", ready: true,
    components: ["core", "flink"],
    resources: {
      scriptsBucket: `bgp-glue-scripts-${ACCT}`, datalakeBucket: `bgp-datalake-${ACCT}`, tableBucket: "bgp-table-bucket",
      flinkRoleArn: `arn:aws:iam::${ACCT}:role/bgp-flink-role`, emrSubnetIds: ["subnet-a"], emrSecurityGroupId: "sg-a",
    },
  };
  return { ...real, requireReadyTarget: async (id: string) => { if (id === "tgt_home") return home; throw new real.TargetNotReadyError(id, "no descriptor"); } };
});

import { runInLongOp, LongOpContextMissing } from "@/lib/long-ops/context";
import {
  deleteFlinkApp,
  FlinkAppSettling,
  FLINK_SETTLING_STATUSES,
  requestFlinkDeletion,
  ensureFlinkDeletion,
  reconcileFlinkStatus,
  mapAppStatusToDb,
  __flinkDeletionsSettled,
} from "../flink-service";

// 序 50 第二批:等 MSAF 过渡态改经唯一原语 awaitTerminal ⇒ 请求路径里的调用必须在长操作上下文(submitLongOp)或登记过的后台等待者里;
//   判据直接调服务函数时用 runInLongOp 包一层(与执行体 flink-delete 同一种上下文),反向钉「裸调即抛」。
const inOp = <T,>(fn: () => Promise<T>) => runInLongOp({ taskId: "t-flink-judge", opKind: "flink-delete" }, fn);

describe("🔴 删除 Flink 应用:等过渡态稳下来,等不到就明确说(不撞 ResourceInUse)", () => {
  beforeEach(() => { h.statuses = []; h.sent = []; h.afterStop = null; h.rows.clear(); });

  it("🔴 模块 55 闸门 ②:请求路径裸调(无长操作上下文)⇒ 抛 LongOpContextMissing,一次 MSAF 命令都不发", async () => {
    h.statuses = ["STOPPING", "STOPPING", "STOPPING", "READY"];
    await expect(deleteFlinkApp("01JOBJOBJOBJOBJOBJOBJOBJOB", "tgt_home", { pollMs: 1, budgetMs: 2000 })).rejects.toBeInstanceOf(LongOpContextMissing);
    expect(h.sent).not.toContain("DeleteApplicationCommand");
  });

  it("🔴 B-28 原状:STOPPING → STOPPING → READY ⇒ 等到 READY 再删(原实现在第一个 STOPPING 就删,撞 ResourceInUse)", async () => {
    h.statuses = ["STOPPING", "STOPPING", "STOPPING", "READY"];
    await inOp(() => deleteFlinkApp("01JOBJOBJOBJOBJOBJOBJOBJOB", "tgt_home", { pollMs: 1, budgetMs: 2000 }));
    expect(h.sent).toContain("DeleteApplicationCommand");
    expect(h.sent).not.toContain("StopApplicationCommand");
  });

  it("RUNNING ⇒ 先停,停稳再删", async () => {
    h.statuses = ["RUNNING"];
    h.afterStop = ["STOPPING", "READY"];
    await inOp(() => deleteFlinkApp("01JOBJOBJOBJOBJOBJOBJOBJOB", "tgt_home", { pollMs: 1, budgetMs: 300 }));
    expect(h.sent.indexOf("StopApplicationCommand")).toBeGreaterThan(-1);
    expect(h.sent.indexOf("DeleteApplicationCommand")).toBeGreaterThan(h.sent.indexOf("StopApplicationCommand"));
  });

  it("一直 STOPPING(超出请求内预算)⇒ 抛 FlinkAppSettling,**不**去调 DeleteApplication", async () => {
    h.statuses = ["STOPPING"];
    await expect(inOp(() => deleteFlinkApp("01JOBJOBJOBJOBJOBJOBJOBJOB", "tgt_home", { pollMs: 1, budgetMs: 30 }))).rejects.toBeInstanceOf(FlinkAppSettling);
    expect(h.sent).not.toContain("DeleteApplicationCommand");
  });

  it("应用已不存在 ⇒ 视为成功(幂等)", async () => {
    h.statuses = [null];
    await inOp(() => deleteFlinkApp("01JOBJOBJOBJOBJOBJOBJOBJOB", "tgt_home", { pollMs: 1, budgetMs: 30 }));
    expect(h.sent).not.toContain("DeleteApplicationCommand");
  });

  it("过渡态清单至少含 STOPPING / FORCE_STOPPING / DELETING(B-28 就是漏了 STOPPING)", () => {
    for (const s of ["STOPPING", "FORCE_STOPPING", "DELETING"]) expect(FLINK_SETTLING_STATUSES as readonly string[]).toContain(s);
  });

});

describe("🔴🔴 B-28b 用户结果:点一次删除 ⇒ 作业最终从列表消失(不管引擎要停多久)", () => {
  const J = "01JOBJOBJOBJOBJOBJOBJOBJOB";
  beforeEach(() => {
    h.statuses = []; h.sent = []; h.afterStop = null; h.rows.clear();
    h.rows.set(J, { jobId: J, status: "running", appName: "bgp-flink-x" });
  });

  it("引擎停得比一次请求的预算慢(真环境 44s > 40s 的形状)⇒ 已受理 + 行标 deleting ⇒ 后台停稳后销毁并删行", async () => {
    h.statuses = ["RUNNING"];
    h.afterStop = ["STOPPING", "STOPPING", "STOPPING", "STOPPING", "STOPPING", "STOPPING", "READY"];
    const r = await inOp(() => requestFlinkDeletion(J, "tgt_home", { pollMs: 1, budgetMs: 2, background: { pollMs: 1, budgetMs: 2000 } }));
    expect(r).toBe("accepted");
    expect(h.rows.get(J)?.status).toBe("deleting");
    expect(h.sent).not.toContain("DeleteApplicationCommand");
    await __flinkDeletionsSettled();
    expect(h.sent).toContain("DeleteApplicationCommand");
    expect(h.rows.has(J), "🔴 点了一次删除,行最终必须没了").toBe(false);
  });

  it("停得快 ⇒ 当场删完(deleted),不走后台", async () => {
    h.statuses = ["READY"];
    expect(await inOp(() => requestFlinkDeletion(J, "tgt_home", { pollMs: 1, budgetMs: 200 }))).toBe("deleted");
    expect(h.rows.has(J)).toBe(false);
  });

  it("后台也等不到(一直 STOPPING)⇒ 行改 error + lastError 说清「作业未删除」,**不删行**(不留看不见的孤儿)", async () => {
    h.statuses = ["STOPPING"];
    expect(await inOp(() => requestFlinkDeletion(J, "tgt_home", { pollMs: 1, budgetMs: 2, background: { pollMs: 1, budgetMs: 20, attemptBudgetMs: 5 } }))).toBe("accepted");
    await __flinkDeletionsSettled();
    expect(h.rows.get(J)).toMatchObject({ status: "error" });
    expect(h.rows.get(J)?.lastError).toMatch(/作业未删除/);
    expect(h.sent).not.toContain("DeleteApplicationCommand");
  });

  it("真失败(非过渡态)⇒ 原样抛(路由回 502),**行不动**", async () => {
    h.statuses = ["READY"];
    const orig = h.sent.push.bind(h.sent);
    h.sent.push = (...x: string[]) => { if (x[0] === "DeleteApplicationCommand") throw new Error("AccessDenied"); return orig(...x); };
    await expect(inOp(() => requestFlinkDeletion(J, "tgt_home", { pollMs: 1, budgetMs: 50 }))).rejects.toThrow(/AccessDenied/);
    expect(h.rows.get(J)?.status).toBe("running");
  });

  it("进程重启兜底:行停在 deleting ⇒ 任一次读取对账把它做完;同进程只跑一份", async () => {
    h.rows.set(J, { jobId: J, status: "deleting", appName: "bgp-flink-x" });
    h.statuses = ["READY"];
    const r = await reconcileFlinkStatus(h.rows.get(J));
    expect(r.dbStatus).toBe("deleting");
    expect(ensureFlinkDeletion(J, "tgt_home"), "同一作业已经在做 ⇒ 不再起第二份").toBe(false);
    await __flinkDeletionsSettled();
    expect(h.rows.has(J)).toBe(false);
  });

  it("🔴 平台不许先于引擎说「已停止」:STOPPING ⇒ stopping(不短路,继续对账);READY 才是 stopped", async () => {
    expect(mapAppStatusToDb("STOPPING", true, "running")).toBe("stopping");
    expect(mapAppStatusToDb("FORCE_STOPPING", true, "running")).toBe("stopping");
    expect(mapAppStatusToDb("READY", true, "stopping")).toBe("stopped");
    h.rows.set(J, { jobId: J, status: "stopping", appName: "bgp-flink-x" });
    h.statuses = ["READY"];
    const r = await reconcileFlinkStatus(h.rows.get(J));
    expect(h.sent, "stopping 必须真去问引擎(不许短路)").toContain("DescribeApplicationCommand");
    expect(r.dbStatus).toBe("stopped");
  });

  it("🔴🔴 看不了 ≠ 不存在:Describe 抛 AccessDenied / 落点解析不开 ⇒ 保留 running、**不写库**(原来被推导成 deleted 并写回)", async () => {
    h.rows.set(J, { jobId: J, status: "running", appName: "bgp-flink-x" });
    h.statuses = ["DENIED"];
    const r = await reconcileFlinkStatus(h.rows.get(J));
    expect(r.dbStatus).toBe("running");
    expect(h.rows.get(J)?.status, "不许写库").toBe("running");
    // 落点解析不开(章指向一个不存在的区)同理
    const r2 = await reconcileFlinkStatus({ jobId: J, status: "running", appName: "bgp-flink-x", targets: ["tgt_nope_zz"] });
    expect(r2.dbStatus).toBe("running");
    expect(h.rows.get(J)?.status).toBe("running");
    // 对照:真不存在(ResourceNotFound ⇒ describe 回 null)才推导成 deleted
    h.statuses = [null];
    expect((await reconcileFlinkStatus(h.rows.get(J))).dbStatus).toBe("deleted");
  });

  it("接线:停止执行体写 stopping(不写 stopped);删除执行体只经 requestFlinkDeletion,已受理回 202;两条路由只 submitLongOp 自己的 kind", () => {
    // 序 50 第二批:启 / 停 / 删三条路由的主体搬进 lib/realtime/long-ops.ts;后台销毁入口 ensureFlinkDeletion 包进登记过的后台等待者
    const SRC = resolve(__dirname, "../../..");
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const exec = strip(readFileSync(join(SRC, "lib/realtime/long-ops.ts"), "utf8"));
    const stopExec = exec.slice(exec.indexOf("const flinkStop"), exec.indexOf("const flinkDelete"));
    expect(stopExec).toMatch(/":s": "stopping"/);
    expect(stopExec).not.toMatch(/":s": "stopped"/);
    const delExec = exec.slice(exec.indexOf("const flinkDelete"));
    expect(delExec).toMatch(/outcome = await requestFlinkDeletion\(jobId, targetId\)/);
    expect(delExec).not.toMatch(/deleteFlinkApp\(/);
    expect(delExec).toMatch(/resultStatus: 202/);
    const stopRoute = strip(readFileSync(join(SRC, "app/api/flink/jobs/[id]/stop/route.ts"), "utf8"));
    expect(stopRoute).toContain('kind: "flink-stop"');
    expect(stopRoute).not.toMatch(/pauseFlinkJob\(/);
    const delRoute = strip(readFileSync(join(SRC, "app/api/flink/jobs/[id]/route.ts"), "utf8"));
    expect(delRoute).toContain('kind: "flink-delete"');
    expect(delRoute).not.toMatch(/requestFlinkDeletion\(|deleteFlinkApp\(/);
    const svc = strip(readFileSync(join(SRC, "lib/realtime/flink-service.ts"), "utf8"));
    expect(svc).toMatch(/runAsBackgroundWaiter\("flink-deletion", \(\) => finishFlinkDeletion\(jobId, targetId, opts\)\)/);
  });
});
