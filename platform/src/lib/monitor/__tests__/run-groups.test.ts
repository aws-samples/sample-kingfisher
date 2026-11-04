// O2 写通道 + 派生口径的**装配层**单测(50 SPEC v3.44 §1.3a S7 / §3.17;判据 ACCEPTANCE 段 `o2`)。
//
// 🔴🔴 **只 mock 唯一的真外部(DynamoDB 客户端)**;兄弟模块 `run-records` / `run-group` /
//    `version-service` **一律不 mock** —— 2026-09-13 的四个自埋缺陷全部长在被 mock 抹平的接缝上,
//    而 tsc 自洽 + 3000 单测全绿 + 60 变异全红(记忆 mock-hides-the-seam)。
// 🔴 内存 DDB 对**看不懂的表达式一律抛**:mock 绝不替产品「猜」语义,否则表达式改坏了它照样绿。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

/** 表名 → pk 值 → 行 */
const db: Record<string, Record<string, Record<string, any>>> = {};
const sent: Array<Record<string, any>> = [];
let failNextWriteWith: Error | null = null;

function keyOf(table: string, key: Record<string, any>): string {
  if (table === "bgp-task-runs") return `${key.taskId}#${key.runId}`;
  return String(key.runGroupId);
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { RUN_GROUPS: "bgp-run-groups", TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, any>; constructor: { name: string } }) => {
      const input = (cmd.input ?? {}) as Record<string, any>;
      const ctor = cmd.constructor.name;
      sent.push({ ctor, ...input });
      const table = String(input.TableName);
      db[table] ??= {};
      const rows = db[table];

      if (ctor === "PutCommand") {
        if (failNextWriteWith) { const e = failNextWriteWith; failNextWriteWith = null; throw e; }
        const k = keyOf(table, input.Item);
        if (input.ConditionExpression === "attribute_not_exists(runGroupId)" && rows[k]) {
          throw new ConditionalCheckFailedException("exists");
        }
        rows[k] = JSON.parse(JSON.stringify(input.Item));
        return {};
      }

      if (ctor === "GetCommand") return { Item: rows[keyOf(table, input.Key)] };

      if (ctor === "UpdateCommand") {
        if (failNextWriteWith) { const e = failNextWriteWith; failNextWriteWith = null; throw e; }
        const k = keyOf(table, input.Key);
        if (input.ConditionExpression !== "attribute_exists(runGroupId)") {
          throw new Error(`内存 DDB 看不懂的 ConditionExpression:${input.ConditionExpression}`);
        }
        if (!rows[k]) throw new ConditionalCheckFailedException("missing");
        const names = input.ExpressionAttributeNames ?? {};
        const vals = input.ExpressionAttributeValues ?? {};
        const expr = String(input.UpdateExpression);
        if (expr === "SET #a.#t = :v") {
          const attr = names["#a"];
          const t = names["#t"];
          rows[k][attr] ??= {};
          rows[k][attr][t] = JSON.parse(JSON.stringify(vals[":v"]));
          return {};
        }
        if (expr === "SET #s = :s") {
          rows[k][names["#s"]] = vals[":s"];
          return {};
        }
        if (expr === "SET #s = :s, finishedAt = if_not_exists(finishedAt, :f)") {
          rows[k][names["#s"]] = vals[":s"];
          if (rows[k].finishedAt === undefined) rows[k].finishedAt = vals[":f"];
          return {};
        }
        throw new Error(`内存 DDB 看不懂的 UpdateExpression:${expr}`);
      }

      if (ctor === "QueryCommand") {
        if (table === "bgp-task-runs") {
          const t = input.ExpressionAttributeValues[":t"];
          return { Items: Object.values(rows).filter((r) => r.taskId === t) };
        }
        if (input.IndexName !== "byDefinition") {
          throw new Error(`组表的 Query 必须走 GSI byDefinition(收到 ${input.IndexName}),不许 Scan / 不许裸 Query`);
        }
        const d = input.ExpressionAttributeValues[":d"];
        return { Items: Object.values(rows).filter((r) => r.definitionId === d) };
      }
      throw new Error(`内存 DDB 不支持的命令:${ctor}`);
    }),
  },
}));

const {
  openRunGroup, recordAccepted, recordSkipped, getRunGroup, getRunGroupRow,
  listRunGroupChildren, listRunGroupsByDefinition, deriveGroupStatus, classifyChildStatus,
  isTerminalGroupStatus, RunGroupWriteFailed, RunGroupInputInvalid, RUN_CHILD_STATUSES,
} = await import("@/lib/monitor/run-groups");
const { putRunRecord } = await import("@/lib/monitor/run-records");
const { runGroupIdFor, RUN_GROUP_STATUSES } = await import("@/lib/monitor/run-group");

/** ULID 恰好 26 位 —— 手写数零最容易少一位(第一版就少了两位,全段红) */
const ulid26 = (head: string) => (head + "0".repeat(26)).slice(0, 26);
const RG = `rg_${ulid26("01J")}`;
const RGS = "rgs_0123456789abcdef01234567";
const BASE = {
  definitionKind: "etl-job" as const,
  definitionId: "job1",
  projectId: "proj-default",
  requestedTargets: ["tgt_home", "tgt_use1_a"],
};

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  sent.length = 0;
  failNextWriteWith = null;
});

// ───────────────────────────── 派生(纯函数,穷举)─────────────────────────────

describe("🔴 deriveGroupStatus:§3.17.1 的穷举 —— 两对刻意不合并的态", () => {
  const s = (...xs: string[]) => deriveGroupStatus(xs.map((status) => ({ status })));

  it("没有子 run ⇒ submitting(扇出循环还没提交出第一条)", () => {
    expect(s().status).toBe("submitting");
  });
  it("有 running ⇒ running(哪怕别的都终态了)", () => {
    expect(s("running").status).toBe("running");
    expect(s("succeeded", "running").status).toBe("running");
    expect(s("failed", "running").status).toBe("running");
    expect(s("stopped", "running").status).toBe("running");
  });
  it("🔴 一个失败 + 一个成功 ⇒ partial-failed,**不是** failed", () => {
    expect(s("succeeded", "failed").status).toBe("partial-failed");
  });
  it("全部失败 ⇒ failed", () => {
    expect(s("failed", "failed").status).toBe("failed");
  });
  it("🔴 有 stopped 且无 failed ⇒ cancelled,**不是** failed(取消是用户动作)", () => {
    expect(s("stopped", "stopped").status).toBe("cancelled");
    expect(s("succeeded", "stopped").status).toBe("cancelled");
  });
  it("failed 优先于 stopped(取消一半、另一半真失败 ⇒ 仍要看见失败)", () => {
    expect(s("failed", "stopped").status).toBe("failed");
    expect(s("succeeded", "failed", "stopped").status).toBe("partial-failed");
  });
  it("全部成功 ⇒ succeeded", () => {
    expect(s("succeeded", "succeeded").status).toBe("succeeded");
  });

  it("🔴 不认识的子状态:按**未终态**算 + 如实报出来(绝不静默当成功/失败)", () => {
    const r = s("succeeded", "queued-somehow");
    expect(r.status, "不认识就当没跑完 —— 反过来会出现「组说全部成功,其实有一条不知死活」").toBe("running");
    expect(r.unknownStatuses).toEqual(["queued-somehow"]);
    // 认识的四个一个都不许被当成 unknown
    for (const st of RUN_CHILD_STATUSES) expect(classifyChildStatus(st)).toBe(st);
    expect(classifyChildStatus("Succeeded"), "大小写不同就是另一个值,不许宽容匹配").toBeNull();
    expect(deriveGroupStatus([{ status: "succeeded" }]).unknownStatuses).toEqual([]);
  });

  it("派生结果永远落在状态词表里(穷举所有 ≤3 元的子状态组合)", () => {
    const pool = [...RUN_CHILD_STATUSES, "who-knows"];
    for (const a of pool) for (const b of pool) for (const c of pool) {
      expect(RUN_GROUP_STATUSES).toContain(s(a, b, c).status);
    }
    for (const st of RUN_GROUP_STATUSES) {
      expect(typeof isTerminalGroupStatus(st)).toBe("boolean");
    }
    expect(isTerminalGroupStatus("submitting")).toBe(false);
    expect(isTerminalGroupStatus("running")).toBe(false);
  });
});

// ───────────────────────────── 写通道 ─────────────────────────────

describe("🔴 openRunGroup:结构上不可能违反的三条", () => {
  it("正常建行:status=submitting、accepted/skipped 是空 map、requestedTargets 去重", async () => {
    expect(await openRunGroup({ runGroupId: RG, ...BASE, requestedTargets: ["tgt_home", "tgt_home", "tgt_use1_a"] }))
      .toEqual({ created: true });
    const row = (await getRunGroupRow(RG))!;
    expect(row.status).toBe("submitting");
    expect(row.accepted).toEqual({});
    expect(row.skipped).toEqual({});
    expect(row.requestedTargets).toEqual(["tgt_home", "tgt_use1_a"]);
    expect(row.failurePolicy).toBe("continue");
  });

  it("🔴 单区不建组(在结构上不可能违反,而不是靠调用方记得判)", async () => {
    await expect(openRunGroup({ runGroupId: RG, ...BASE, requestedTargets: ["tgt_home"] }))
      .rejects.toThrow(RunGroupInputInvalid);
    await expect(openRunGroup({ runGroupId: RG, ...BASE, requestedTargets: ["tgt_home", "tgt_home"] }))
      .rejects.toThrow(/不足两个执行目标/);
    expect(await getRunGroupRow(RG), "拒了还建了行 = 更坏").toBeNull();
  });

  it("形态 / 值域非法一律拒(组 id、definitionKind、归属)", async () => {
    await expect(openRunGroup({ runGroupId: "tgt_home", ...BASE })).rejects.toThrow(/形态非法/);
    await expect(openRunGroup({ runGroupId: RG, ...BASE, definitionKind: "warehouse" as never }))
      .rejects.toThrow(/ResourceType/);
    await expect(openRunGroup({ runGroupId: RG, ...BASE, projectId: "" })).rejects.toThrow(/必填/);
  });

  it("🔴 定时确定性键被 N 个区各自建一次 ⇒ 第二个是**加入**不是错误(条件写撞了 = 一个答案)", async () => {
    expect(await openRunGroup({ runGroupId: RGS, ...BASE, triggeredBy: "schedule" })).toEqual({ created: true });
    expect(await openRunGroup({ runGroupId: RGS, ...BASE, triggeredBy: "schedule" })).toEqual({ created: false });
    // 第二次不许把第一次的进度冲掉
    await recordAccepted(RGS, "tgt_home", { runId: "r1" });
    expect(await openRunGroup({ runGroupId: RGS, ...BASE, triggeredBy: "schedule" })).toEqual({ created: false });
    expect((await getRunGroupRow(RGS))!.accepted).toEqual({ tgt_home: { runId: "r1" } });
  });

  it("🔴 组行写失败 ⇒ 抛 RunGroupWriteFailed(运行路由必须据此拒绝,不许 fail-open)", async () => {
    failNextWriteWith = new Error("AccessDeniedException: not authorized");
    await expect(openRunGroup({ runGroupId: RG, ...BASE })).rejects.toThrow(RunGroupWriteFailed);
    failNextWriteWith = new Error("boom");
    await expect(openRunGroup({ runGroupId: RG, ...BASE })).rejects.toThrow(/本次运行已拒绝/);
  });
});

describe("🔴 recordAccepted / recordSkipped:按 target 幂等 + 不造幽灵行", () => {
  beforeEach(async () => { await openRunGroup({ runGroupId: RG, ...BASE }); });

  it("🔴 同一个 target 重复上报 = 覆盖同一格(存 list 的话这里会出现两条)", async () => {
    await recordAccepted(RG, "tgt_home", { runId: "r1" });
    await recordAccepted(RG, "tgt_home", { runId: "r1" });
    await recordAccepted(RG, "tgt_use1_a", { runId: "r2", definitionVersion: 7 });
    const row = (await getRunGroupRow(RG))!;
    expect(Object.keys(row.accepted).sort()).toEqual(["tgt_home", "tgt_use1_a"]);
    expect(row.accepted.tgt_use1_a).toEqual({ runId: "r2", definitionVersion: 7 });
  });

  it("skipped 必须带原因(没有原因的跳过在页面上等于凭空少一个区)", async () => {
    await expect(recordSkipped(RG, "tgt_use1_a", "")).rejects.toThrow(RunGroupInputInvalid);
    await recordSkipped(RG, "tgt_use1_a", "该执行环境没装调度组件");
    expect((await getRunGroupRow(RG))!.skipped).toEqual({ tgt_use1_a: { reason: "该执行环境没装调度组件" } });
  });

  it("🔴 组行不存在 ⇒ 抛,且**不**凭空造出一行(UpdateItem 在 DDB 里是 upsert)", async () => {
    await expect(recordAccepted(`rg_${ulid26("01J9")}`, "tgt_home")).rejects.toThrow(RunGroupWriteFailed);
    expect(await getRunGroupRow(`rg_${ulid26("01J9")}`)).toBeNull();
  });

  it("targetId 为空 ⇒ 拒(空键会写出一格没人认领的记录)", async () => {
    await expect(recordAccepted(RG, "")).rejects.toThrow(/targetId 为空/);
  });
});

// ───────────────────────── 读:派生 + 对账写回 ─────────────────────────

describe("🔴 getRunGroup:UI 只许看派生值;物化 status 只是缓存", () => {
  const stamp = (targetId: string) => ({ projectId: "proj-default", targetId });

  beforeEach(async () => {
    await openRunGroup({ runGroupId: RG, ...BASE });
    await putRunRecord({ taskId: "job1", runId: "r1", taskType: "etl-glue", stamp: stamp("tgt_home"), runGroupId: RG, status: "succeeded" });
    await putRunRecord({ taskId: "job1", runId: "r2", taskType: "etl-glue", stamp: stamp("tgt_use1_a"), runGroupId: RG, status: "failed" });
  });

  it("一失一成 ⇒ derivedStatus=partial-failed,并把物化值对账写回 + 盖 finishedAt", async () => {
    const v = (await getRunGroup(RG))!;
    expect(v.derivedStatus).toBe("partial-failed");
    expect(v.children.map((c) => c.targetId).sort()).toEqual(["tgt_home", "tgt_use1_a"]);
    const row = (await getRunGroupRow(RG))!;
    expect(row.status, "物化投影要跟着派生值对账").toBe("partial-failed");
    expect(row.finishedAt, "终态要盖完成时间").toBeTruthy();
  });

  it("🔴 表里的物化值被人改坏了 ⇒ 读出来仍以**派生值**为准(不是反过来信表)", async () => {
    db["bgp-run-groups"][RG].status = "succeeded"; // 伪造一个「全部成功」
    const v = (await getRunGroup(RG))!;
    expect(v.derivedStatus).toBe("partial-failed");
    expect(v.group.status).toBe("partial-failed");
  });

  it("🔴 对账写回失败**不影响本次读**(缓存写不进去 ≠ 读错)", async () => {
    failNextWriteWith = new Error("ProvisionedThroughputExceededException");
    const v = (await getRunGroup(RG))!;
    expect(v.derivedStatus).toBe("partial-failed");
  });

  it("🔴 只读子 run,**绝不**反过来改它们(把组的结论写回子 run = 伪造历史)", async () => {
    const before = JSON.stringify(db["bgp-task-runs"]);
    await getRunGroup(RG);
    expect(JSON.stringify(db["bgp-task-runs"])).toBe(before);
  });

  it("同一个任务里别的组 / 无组的 run 不许串进来", async () => {
    await putRunRecord({ taskId: "job1", runId: "r3", taskType: "etl-glue", stamp: stamp("tgt_home"), runGroupId: `rg_${ulid26("01J1")}`, status: "running" });
    await putRunRecord({ taskId: "job1", runId: "r4", taskType: "etl-glue", stamp: stamp("tgt_home"), runGroupId: runGroupIdFor(["tgt_home"]), status: "running" });
    const row = (await getRunGroupRow(RG))!;
    expect((await listRunGroupChildren(row)).map((c) => c.runId).sort()).toEqual(["r1", "r2"]);
    expect((await getRunGroup(RG))!.derivedStatus, "串进来一条 running 就会把组说成还在跑").toBe("partial-failed");
  });

  it("组不存在 ⇒ null(不是空组 —— 空组会被前端渲染成「这次什么都没跑」)", async () => {
    expect(await getRunGroup(`rg_${ulid26("01J2")}`)).toBeNull();
  });

  it("listRunGroupsByDefinition 走 GSI byDefinition(内存 DDB 对裸 Query 直接抛)", async () => {
    const rows = await listRunGroupsByDefinition("job1");
    expect(rows.map((r) => r.runGroupId)).toEqual([RG]);
    expect(sent.filter((c) => c.ctor === "QueryCommand" && c.TableName === "bgp-run-groups").every((c) => c.IndexName === "byDefinition")).toBe(true);
  });
});

// ─────────────── 单一作者门禁(A4:状态不许被静默默认;组表只许一个作者写)───────────────

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("🔴 单一作者门禁", () => {
  const src = readFileSync(resolve(SRC, "lib/monitor/run-groups.ts"), "utf8");

  it("`getRunGroup` 必须真的去派生,而不是把物化的 `group.status` 当结论", () => {
    const i = src.indexOf("export async function getRunGroup(");
    expect(i).toBeGreaterThan(-1);
    // 切出整个函数体再判(不猜正则;下一个 `\nexport ` 就是边界)
    const body = src.slice(i, src.indexOf("\nexport ", i + 10));
    expect(body).toContain("deriveGroupStatus(children)");
    expect(body, "把缓存值当结论回给 UI = 造了第二真值源").not.toContain("derivedStatus: group.status");
    expect(body, "对账方向只能是「派生 → 写回表」,不许「表 → 改子 run」").not.toContain("TASK_RUNS");
  });

  it("组状态不许有静默默认值(`?? \"succeeded\"` 这类写法一处都不许有)", () => {
    for (const st of RUN_GROUP_STATUSES) {
      expect(src.includes(`?? "${st}"`), `run-groups.ts 出现了 ?? "${st}" —— 有静默合法默认值的状态是一整类缺陷的温床`).toBe(false);
      expect(src.includes(`|| "${st}"`), `run-groups.ts 出现了 || "${st}"`).toBe(false);
    }
  });

  it("🔴 全仓只有 `lib/monitor/run-groups.ts` 碰 `TABLES.RUN_GROUPS`(组行的唯一写通道)", () => {
    // 🔴 **必须剥掉注释再判**:第一版直接 `grep -rl`,结果被两个 fanout 文件里
    //    「别处不许再写 TABLES.RUN_GROUPS」这句**注释**触发 ⇒ 门禁对着散文报红。
    //    同族教训:负向/存在性断言不许对着原始文本猜(要么剥注释、要么切片、要么断计数)。
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ");
    const candidates = execFileSync("grep", ["-rl", "TABLES.RUN_GROUPS", "--include=*.ts", "--include=*.tsx", SRC], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean)
      .map((f) => f.replace(SRC + "/", ""))
      .filter((f) => !f.includes("__tests__"))
      .sort();
    const inCode = candidates.filter((f) => strip(readFileSync(resolve(SRC, f), "utf8")).includes("TABLES.RUN_GROUPS"));
    expect(inCode, "多一个文件直接写组表 ⇒ 状态就有了第二个作者").toEqual(["lib/monitor/run-groups.ts"]);
    // 反向:候选里必须真有别的文件(否则上面那条会因为「grep 什么都没找到」而空过)
    expect(candidates.length, "候选文件数 ≤1 ⇒ 说明剥注释这一步没有被真正考验").toBeGreaterThan(1);
  });
});

// 接线:definitionVersion 必须**真有人写**
describe("🔴 definitionVersion 端到端:唯一作者 = 组行的 accepted;子行合并出来", () => {
  const stamp = (targetId: string) => ({ projectId: "proj-default", targetId });

  it("recordAccepted 写进去 ⇒ 子行读得到;没写过 ⇒ 子行**没有**这个字段(不许编一个 v0)", async () => {
    await openRunGroup({ runGroupId: RG, ...BASE });
    await putRunRecord({ taskId: "job1", runId: "r1", taskType: "etl-glue", stamp: stamp("tgt_home"), runGroupId: RG, status: "succeeded" });
    await putRunRecord({ taskId: "job1", runId: "r2", taskType: "etl-glue", stamp: stamp("tgt_use1_a"), runGroupId: RG, status: "succeeded" });
    await recordAccepted(RG, "tgt_home", { runId: "r1", definitionVersion: 7 });
    await recordAccepted(RG, "tgt_use1_a", { runId: "r2" }); // 这一区没记版本
    const v = (await getRunGroup(RG))!;
    const byT = Object.fromEntries(v.children.map((c) => [c.targetId, c]));
    expect(byT.tgt_home.definitionVersion, "写过就要读得到").toBe(7);
    expect("definitionVersion" in byT.tgt_use1_a, "没写过就不许有这个字段(编一个 0 会显示成「v0」骗人)").toBe(false);
  });

  it("🔴 跨区版本差**看得见**:两区不同版本 ⇒ 两个子行两个值,而**组仍是一个**", async () => {
    await openRunGroup({ runGroupId: RG, ...BASE });
    await putRunRecord({ taskId: "job1", runId: "r1", taskType: "etl-glue", stamp: stamp("tgt_home"), runGroupId: RG, status: "succeeded" });
    await putRunRecord({ taskId: "job1", runId: "r2", taskType: "etl-glue", stamp: stamp("tgt_use1_a"), runGroupId: RG, status: "succeeded" });
    await recordAccepted(RG, "tgt_home", { runId: "r1", definitionVersion: 8 });
    await recordAccepted(RG, "tgt_use1_a", { runId: "r2", definitionVersion: 7 });
    const v = (await getRunGroup(RG))!;
    expect(new Set(v.children.map((c) => c.definitionVersion))).toEqual(new Set([8, 7]));
    expect(v.derivedStatus, "版本不同**不许**把组拆开或改变组状态").toBe("succeeded");
    expect(v.children).toHaveLength(2);
  });

  it("🔴 全仓 `definitionVersion` 只许从组行的 accepted 出来(不许悄悄在 run 行上写第二份)", () => {
    const src = readFileSync(resolve(SRC, "lib/monitor/run-groups.ts"), "utf8");
    // 子行取值必须来自 row.accepted
    expect(src).toContain("const acceptedVersion = row.accepted?.[targetId]?.definitionVersion;");
    expect(src, "🔴 从 run 行读 = 第二个作者").not.toContain("r.definitionVersion");
  });
});
