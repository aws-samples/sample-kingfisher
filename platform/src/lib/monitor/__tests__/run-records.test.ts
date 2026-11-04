// @kf-batch 52-P52.2-W2a-run-stamp
// `bgp-task-runs` 唯一写通道的门禁 + 变异靶子(52 SPEC §1 / 50 SPEC §1.2 / §6 S10)。
//
// 🔴 **本文件刻意全部写成「可执行断言」**。上一批(P52.1-D4)有一条分页门禁**第一版是假门禁**:
// 它只扫标识符名字,于是把 `ExclusiveStartKey = undefined` 这个变异照样判绿。
// ⇒ 这里凡是能跑的都跑:内存 DDB 打桩 + 真的调生成器 + 真的调 AST 量具,
// 只有「Python 源码」这一处没法执行(它在 MWAA 里跑),那一处才退回文本断言。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
// @kf-batch 50-W3f-T0-T3(零依赖模块,静态 import 不受下面的 DDB mock 影响)
import { runGroupIdFor, RUN_GROUP_ATTR } from "@/lib/monitor/run-group";

// ── 内存 DDB:只实现本通道用到的语义(Put 整行替换 / Update 条件写 + if_not_exists / Query 翻页)──
type Row = Record<string, unknown>;
const store: Record<string, Row> = {}; // key = `${taskId}#${runId}`
/** 每次 Query 返回一页;用来验证「不翻页就会漏」。 */
let queryPages: Row[][] = [];
const sent: Array<Record<string, unknown>> = []; // 发出的原始入参,供结构断言

class ConditionalCheckFailedException extends Error {
  name = "ConditionalCheckFailedException";
}

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { TASK_RUNS: "bgp-task-runs" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown>; constructor: { name: string } }) => {
      const input = (cmd.input ?? {}) as Record<string, any>;
      sent.push({ ctor: cmd.constructor.name, ...input });

      if (input.Item) {
        // PutCommand:整行替换(存量语义,zero-etl 靠它推进状态)
        store[`${input.Item.taskId}#${input.Item.runId}`] = { ...input.Item };
        return {};
      }
      if (input.KeyConditionExpression) {
        // QueryCommand:按 queryPages 逐页返回,最后一页不带 LastEvaluatedKey
        const idx = Number((input.ExclusiveStartKey as { page?: number } | undefined)?.page ?? 0);
        const page = queryPages[idx] ?? [];
        const more = idx + 1 < queryPages.length;
        return { Items: page, ...(more ? { LastEvaluatedKey: { page: idx + 1 } } : {}) };
      }
      // UpdateCommand
      const rowKey = `${input.Key.taskId}#${input.Key.runId}`;
      const row = store[rowKey];
      const cond = String(input.ConditionExpression ?? "");
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const vals = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      // 🔴 条件在**应用更新之前**判(DDB 的真实语序)。第一版 mock 先 SET 再判,
      //    于是 `attribute_not_exists(downstreamFired)` 第一次就自己把自己判否 —— 那是 mock 的 bug。
      if (cond.includes("attribute_exists(taskId)") && !row) {
        throw new ConditionalCheckFailedException("row missing");
      }
      // @kf-batch 50-WP18b-fanout-seam
      // 🔴 真的**求值**条件表达式,别只认几个特例:「不许改写已取消的 run」那道守卫写的是
      //   `(attribute_not_exists(#k0) OR #k0 <> :gstopped)` —— 老 mock 的 `\w+` 匹配不到 `#k0`,
      //   于是守卫**被 mock 静默忽略**,针对它写的判据会变成空断言(mock 抹平接缝的典型形态)。
      const attrOf = (tok: string) => (tok.startsWith("#") ? names[tok] : tok);
      const evalAtom = (atomRaw: string): boolean => {
        const atom = atomRaw.trim().replace(/^\((.*)\)$/s, "$1").trim();
        let m = atom.match(/^attribute_exists\(\s*([#\w]+)\s*\)$/);
        if (m) return row ? row[attrOf(m[1])] !== undefined : false;
        m = atom.match(/^attribute_not_exists\(\s*([#\w]+)\s*\)$/);
        if (m) return row ? row[attrOf(m[1])] === undefined : true;
        m = atom.match(/^([#\w]+)\s*(<>|=)\s*(:\w+)$/);
        if (m) {
          const cur = row ? row[attrOf(m[1])] : undefined;
          const want = vals[m[3]];
          return m[2] === "=" ? cur === want : cur !== want;
        }
        throw new Error(`mock 求值不了这段 ConditionExpression 原子:${atom}`);
      };
      const evalClause = (clause: string): boolean =>
        clause.split(" OR ").some((part) => evalAtom(part));
      // 顶层按 AND 切(本通道只产出 `A AND (B OR C) AND (D)` 这种形状)
      const topClauses = cond
        .split(/\s+AND\s+(?![^(]*\))/)
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.replace(/^\((.*)\)$/s, "$1"));
      if (!topClauses.every((c) => evalClause(c))) {
        throw new ConditionalCheckFailedException("condition failed");
      }
      const target = row ?? (store[rowKey] = { taskId: input.Key.taskId, runId: input.Key.runId });
      // 解析 `SET #k0 = :v0, #sp = if_not_exists(#sp, :sp), …`
      // ⚠️ 不能按 "," 切:`if_not_exists(#sp, :sp)` 里就有一个逗号(第一版 mock 正是这么炸的)。
      const body = String(input.UpdateExpression ?? "").replace(/^SET\s+/, "");
      const assign = /(#\w+)\s*=\s*(?:if_not_exists\(\s*#\w+\s*,\s*(:\w+)\s*\)|(:\w+))/g;
      let consumed = 0;
      for (const m of body.matchAll(assign)) {
        consumed += m[0].length;
        const attr = names[m[1]];
        if (!attr) throw new Error(`未起别名的属性引用:${m[1]}`);
        const isIfAbsent = Boolean(m[2]);
        const value = vals[(m[2] ?? m[3]) as string];
        if (isIfAbsent && target[attr] !== undefined) continue;
        target[attr] = value;
      }
      // 🔴 整条表达式必须被赋值项吃干净(只剩逗号空格)—— 否则说明出现了 mock 不认识的写法,
      //    此时静默放过就等于"门禁在测一个它没看懂的东西"。
      const leftover = body.replace(assign, "").replace(/[\s,]/g, "");
      if (leftover) throw new Error(`mock 解析不了这段 UpdateExpression 的剩余部分:${leftover}`);
      if (consumed === 0) throw new Error(`空的 UpdateExpression:${body}`);
      return {};
    }),
  },
}));

const {
  putRunRecord,
  updateRunRecord,
  settleRunningRuns,
  resolveRunStamp,
  pythonStampFields,
  RUN_STAMP_ATTRS,
} = await import("@/lib/monitor/run-records");

const STAMP = { projectId: "proj-01M1KP594D2E6DJQC8EZ8CRAES", targetId: "tgt_usw2_a" };

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  queryPages = [];
  sent.length = 0;
});

describe("🔴 建行:章是必填参数,无章的 run 行造不出来", () => {
  it("Put 出来的行一定带 projectId / targetId(值来自 stamp)", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    expect(store["t1#r1"]).toMatchObject({ projectId: STAMP.projectId, targetId: STAMP.targetId, taskType: "sync" });
    // 缺省值也要有(否则监控页拿不到时间轴)
    expect(String(store["t1#r1"].startedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store["t1#r1"].status).toBe("running");
  });

  it("🔴 归属字段不许从自由字段混进来(绕过 stamp 写别的项目号 = 单一通道白设)", async () => {
    for (const attr of RUN_STAMP_ATTRS) {
      await expect(
        putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP, extra: { [attr]: "proj-evil" } })
      ).rejects.toThrow(/不许直接携带归属字段/);
    }
  });

  it("同一个 runId 反复 Put = 整行替换(zero-etl / dms 的存量语义必须保住)", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP, extra: { logs: ["a"] } });
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", status: "succeeded", stamp: STAMP });
    expect(store["t1#r1"].status).toBe("succeeded");
    expect(store["t1#r1"].logs).toBeUndefined(); // 整行替换,不是合并 —— 这条就是「刻意不加条件」的理由
  });
});

describe("🔴 回写:绝不凭空造行(幽灵行洞)", () => {
  it("行不存在 ⇒ 回 false,且 store 里**没有**多出一行", async () => {
    const ok = await updateRunRecord({ taskId: "nope", runId: "nope", set: { status: "failed" } });
    expect(ok).toBe(false);
    expect(store["nope#nope"]).toBeUndefined();
  });

  it("行存在 ⇒ 回 true 并写入字段", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    const ok = await updateRunRecord({ taskId: "t1", runId: "r1", set: { status: "succeeded", duration: 42 } });
    expect(ok).toBe(true);
    expect(store["t1#r1"]).toMatchObject({ status: "succeeded", duration: 42 });
  });

  it("🔴 `fireDownstreamOnce` 那个洞:extraCondition 恒真也不能造出行", async () => {
    // 原实现条件只有 `attribute_not_exists(downstreamFired)` —— 它对**不存在的行恒真** ⇒ upsert 出幽灵行。
    const ok = await updateRunRecord({
      taskId: "ghost", runId: "ghost", set: { downstreamFired: true },
      extraCondition: "attribute_not_exists(downstreamFired)",
    });
    expect(ok).toBe(false);
    expect(store["ghost#ghost"]).toBeUndefined();
  });

  it("extraCondition 仍然生效:已 fire 过的行拿不到第二次", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    const first = await updateRunRecord({
      taskId: "t1", runId: "r1", set: { downstreamFired: true },
      extraCondition: "attribute_not_exists(downstreamFired)",
    });
    const second = await updateRunRecord({
      taskId: "t1", runId: "r1", set: { downstreamFired: true },
      extraCondition: "attribute_not_exists(downstreamFired)",
    });
    expect([first, second]).toEqual([true, false]);
  });

  it("🔴 保留字类 bug 不可能再犯:set 里**每个** key 都起了别名", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    sent.length = 0;
    // status/duration/error/metrics/result 都是 DDB 保留字;还混一个普通字段
    await updateRunRecord({
      taskId: "t1", runId: "r1",
      set: { status: "failed", duration: 1, error: "x", metrics: { a: 1 }, result: "r", logS3Key: "k" },
    });
    const upd = sent.find((s) => typeof s.UpdateExpression === "string")!;
    const names = upd.ExpressionAttributeNames as Record<string, string>;
    const expr = String(upd.UpdateExpression);
    for (const attr of ["status", "duration", "error", "metrics", "result", "logS3Key"]) {
      expect(Object.values(names), `${attr} 没进 ExpressionAttributeNames`).toContain(attr);
      // 表达式里只能出现别名,不能出现裸字段名
      expect(expr, `${attr} 以裸名出现在 UpdateExpression 里`).not.toMatch(new RegExp(`\\b${attr}\\s*=`));
    }
  });

  it("值为 undefined 的键自动跳过;全空则不发空 Update", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    sent.length = 0;
    const ok = await updateRunRecord({ taskId: "t1", runId: "r1", set: { a: undefined, b: undefined } });
    expect(ok).toBe(false);
    expect(sent.filter((s) => typeof s.UpdateExpression === "string")).toHaveLength(0);
  });
});

describe("🔴 回写补章只补空缺,绝不覆盖(14 个回写点 = 14 次算错机会)", () => {
  it("行上已有章 ⇒ 传别的章也不改", async () => {
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    await updateRunRecord({
      taskId: "t1", runId: "r1", set: { status: "succeeded" },
      stamp: { projectId: "proj-other", targetId: "tgt_home" },
    });
    expect(store["t1#r1"]).toMatchObject({ projectId: STAMP.projectId, targetId: STAMP.targetId });
  });

  it("行上没有章(存量行)⇒ 补上", async () => {
    store["legacy#r0"] = { taskId: "legacy", runId: "r0", status: "running" };
    await updateRunRecord({ taskId: "legacy", runId: "r0", set: { status: "succeeded" }, stamp: STAMP });
    expect(store["legacy#r0"]).toMatchObject({ projectId: STAMP.projectId, targetId: STAMP.targetId });
  });
});

describe("🔴 收口残留 running:必须翻页(5 处复制循环原本都没翻)", () => {
  it("running 在**第三页**也照样被收口(变异:去掉 ExclusiveStartKey ⇒ 本条必红)", async () => {
    store["t1#a"] = { taskId: "t1", runId: "a", status: "succeeded" };
    store["t1#b"] = { taskId: "t1", runId: "b", status: "running" };
    store["t1#c"] = { taskId: "t1", runId: "c", status: "running" };
    queryPages = [
      [{ taskId: "t1", runId: "a", status: "succeeded" }],
      [{ taskId: "t1", runId: "b", status: "running" }],
      [{ taskId: "t1", runId: "c", status: "running" }],
    ];
    const n = await settleRunningRuns({ taskId: "t1", status: "stopped", set: { finishedAt: "T" }, stamp: STAMP });
    expect(n).toBe(2);
    expect(store["t1#b"].status).toBe("stopped");
    expect(store["t1#c"].status).toBe("stopped"); // ← 第三页那条
    expect(store["t1#a"].status).toBe("succeeded"); // 非 running 不动
  });

  it("maxPages 是**有界**的(防翻页死循环把请求挂死)", async () => {
    // 造一个永远还有下一页的 pager:2 页内容 + 循环索引
    queryPages = Array.from({ length: 200 }, () => [] as Row[]);
    const n = await settleRunningRuns({ taskId: "t1", status: "stopped", maxPages: 3 });
    expect(n).toBe(0);
    expect(sent.filter((s) => typeof s.KeyConditionExpression === "string")).toHaveLength(3);
  });
});

describe("resolveRunStamp:归属取资源行,两个缺省各有出处", () => {
  it("有 projectId 用它;没有则落默认工作区(与 guardResourceAccess 同口径)", () => {
    expect(resolveRunStamp({ projectId: "proj-x" }).projectId).toBe("proj-x");
    expect(resolveRunStamp({}).projectId).toBe("proj-default");
    expect(resolveRunStamp(null).projectId).toBe("proj-default");
  });

  it("targetId 优先级:显式传参 > 资源行 > home(P50.3 扇出靠第一档)", () => {
    expect(resolveRunStamp({ targetId: "tgt_a" }, "tgt_b").targetId).toBe("tgt_b");
    expect(resolveRunStamp({ targetId: "tgt_a" }).targetId).toBe("tgt_a");
    expect(resolveRunStamp({}).targetId).toBe("tgt_home");
  });
});

describe("🔴 MWAA 旁路:章在生成时注入,且值不可注入 Python", () => {
  it("片段形状 = 两个 JSON 键值(属性名与 TS 侧同源)", () => {
    const frag = pythonStampFields(STAMP);
    for (const attr of RUN_STAMP_ATTRS) expect(frag).toContain(`"${attr}"`);
    expect(frag).toBe(`"projectId": "${STAMP.projectId}", "targetId": "${STAMP.targetId}"`);
  });

  it("🔴 fail-closed:值里带引号/换行/表达式一律抛,绝不清洗后继续生成 DAG", () => {
    for (const bad of ['a" , "x": __import__("os").system("rm -rf /"), "y": "', "a\nb", 'a\\"b', "", "x".repeat(200)]) {
      expect(() => pythonStampFields({ projectId: bad, targetId: "tgt_home" }), JSON.stringify(bad)).toThrow(
        /盖章值非法/
      );
      expect(() => pythonStampFields({ projectId: "proj-default", targetId: bad })).toThrow(/盖章值非法/);
    }
  });
});

describe("🔴 盖章覆盖门禁:裸写入点只允许出现在写通道自己那一个文件里", () => {
  // 🔴 本条要 spawn 一个 node 子进程跑真量具 ⇒ 对机器负载敏感。实测在全量并行 + 机器忙时
  //    曾超过 vitest 默认 5s 超时而假红。给足余量:**假红会让人去删门禁**,比门禁本身失效更糟。
  it("AST 量具复核(跑真脚本,判据不在测试里复制一份 ⇒ 不会与量具漂移)", { timeout: 60_000 }, () => {
    const out = execFileSync("node", [resolve(process.cwd(), "scripts/ast-task-runs-writes.mjs"), "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const { direct, indirect } = JSON.parse(out) as {
      direct: Array<{ file: string; line: number; ctor: string }>;
      indirect: Array<{ file: string }>;
    };
    const outsiders = direct.filter((d) => d.file !== "lib/monitor/run-records.ts");
    expect(
      outsiders.map((d) => `${d.file}:${d.line}`),
      "这些站点在写通道之外裸写 bgp-task-runs ⇒ 会漏盖章 / 造幽灵行(50 SPEC §6 S10)"
    ).toEqual([]);
    // 通道自己必须还在(别把门禁做过头,把真正的写口也删了)
    expect(direct.length, "写通道自身的 Put/Update 不见了 ⇒ 根本没人写 run 记录了").toBeGreaterThanOrEqual(2);
    expect(indirect, "出现了间接实参的写入点,门禁扫不到,必须人工收口").toEqual([]);
  });
});

// @kf-batch 50-W3f-T0-T3
describe("🔴 T2:runGroupId 只经一等参数进入写通道(50 SPEC §1.3a S6 ②)", () => {
  it("多区扇出:两条 run 同一个 runGroupId;单区:行上**没有**该属性(不是 null / 空串)", async () => {
    const rg = runGroupIdFor(["tgt_home", "tgt_usw2_a"]) as string;
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "etl-redshift", stamp: STAMP, runGroupId: rg });
    await putRunRecord({ taskId: "t1", runId: "r2", taskType: "etl-redshift", stamp: { ...STAMP, targetId: "tgt_home" }, runGroupId: rg });
    expect(store["t1#r1"][RUN_GROUP_ATTR]).toBe(rg);
    expect(store["t1#r2"][RUN_GROUP_ATTR]).toBe(rg);
    await putRunRecord({ taskId: "t1", runId: "r3", taskType: "etl-redshift", stamp: STAMP, runGroupId: runGroupIdFor(["tgt_home"]) });
    expect(RUN_GROUP_ATTR in store["t1#r3"], "单区运行不许落 runGroupId(读侧靠「有值 = 多区」判)").toBe(false);
  });

  it("形态非法 ⇒ 抛且**不写**(把 targetId 当组号塞进来是最可能的误用)", async () => {
    await expect(
      putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP, runGroupId: "tgt_home" })
    ).rejects.toThrow(/形态非法/);
    expect(store["t1#r1"]).toBeUndefined();
  });

  // @kf-batch 50-WP5-rungroup
  it("🔴 定时触发的确定性键 `rgs_<24hex>` 必须能写进台账(O2;漏了它 = 定时运行整批没有历史)", async () => {
    const rgs = "rgs_0123456789abcdef01234567";
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "etl-glue", stamp: STAMP, runGroupId: rgs });
    expect(store["t1#r1"][RUN_GROUP_ATTR]).toBe(rgs);
  });

  it("从 extra / 回写 set 混进来 ⇒ 抛(单一作者:建行时定,回写不可改)", async () => {
    await expect(
      putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP, extra: { [RUN_GROUP_ATTR]: "rg_x" } })
    ).rejects.toThrow(/runGroupId/);
    await putRunRecord({ taskId: "t1", runId: "r1", taskType: "sync", stamp: STAMP });
    await expect(updateRunRecord({ taskId: "t1", runId: "r1", set: { [RUN_GROUP_ATTR]: "rg_x" } })).rejects.toThrow(/runGroupId/);
    expect(store["t1#r1"][RUN_GROUP_ATTR]).toBeUndefined();
  });
});

// @kf-batch 50-WP18b-fanout-seam
describe("🔴🔴 用户取消的终态不许被任何自动化写回改写", () => {
  it("已 stopped 的 run:写 failed / succeeded 都被拒(返回 false 且行**一个字节没变**)", async () => {
    await putRunRecord({ taskId: "j1", runId: "r1", taskType: "etl-redshift", stamp: STAMP });
    // 取消:唯一写通道写 stopped(run-cancel.settleStopped 就是这么写的)
    expect(await updateRunRecord({ taskId: "j1", runId: "r1", set: { status: "stopped", finishedAt: "T0" } })).toBe(true);
    const snapshot = JSON.stringify(store["j1#r1"]);
    // 对账 / 轮询随后想把它改成 failed(线上真实形态:describe-statement 说 ABORTED 或查不到)
    expect(
      await updateRunRecord({ taskId: "j1", runId: "r1", set: { status: "failed", error: "记录已过期" } }),
      "把用户取消改写成 failed ⇒ 页面显示「失败」、组派生状态从 cancelled 变 failed"
    ).toBe(false);
    expect(await updateRunRecord({ taskId: "j1", runId: "r1", set: { status: "succeeded" } })).toBe(false);
    expect(JSON.stringify(store["j1#r1"]), "被拒的写不许留下半截字段(error/finishedAt 都不许落)").toBe(snapshot);
  });

  it("同值幂等:再写一次 stopped 允许(重复取消 / 重放不许把通道堵死)", async () => {
    await putRunRecord({ taskId: "j2", runId: "r1", taskType: "etl-redshift", stamp: STAMP });
    await updateRunRecord({ taskId: "j2", runId: "r1", set: { status: "stopped" } });
    expect(await updateRunRecord({ taskId: "j2", runId: "r1", set: { status: "stopped", duration: 3 } })).toBe(true);
    expect(store["j2#r1"].duration).toBe(3);
  });

  it("正控制:running ⇒ failed / succeeded 照样写得进去(守卫只挡「已取消」一个态)", async () => {
    await putRunRecord({ taskId: "j3", runId: "r1", taskType: "etl-redshift", stamp: STAMP });
    expect(await updateRunRecord({ taskId: "j3", runId: "r1", set: { status: "failed" } })).toBe(true);
    expect(store["j3#r1"].status).toBe("failed");
    // 终态之间的**纠正**不在这道守卫的射程内(对账把「记录已过期」判失败之后仍能被改对)
    expect(await updateRunRecord({ taskId: "j3", runId: "r1", set: { status: "succeeded" } })).toBe(true);
  });

  it("不写 status 的更新(只补 logs / metrics)不受守卫影响", async () => {
    await putRunRecord({ taskId: "j4", runId: "r1", taskType: "etl-redshift", stamp: STAMP });
    await updateRunRecord({ taskId: "j4", runId: "r1", set: { status: "stopped" } });
    expect(await updateRunRecord({ taskId: "j4", runId: "r1", set: { logs: "…" } })).toBe(true);
    expect(store["j4#r1"].status).toBe("stopped");
  });
});

// @kf-batch 50-WP18b-fanout-seam —— 语义映射:被取消 ≠ 失败(三处写点同一张表)
describe("🔴 ABORTED / STOPPED 是「被取消」,不是「失败」", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const svc = strip(fs.readFileSync(new URL("../../etl/job-service.ts", import.meta.url), "utf8"));

  it("Redshift 对账与进程内轮询都把 ABORTED 映射成 stopped(不是 failed)", () => {
    expect(svc).toMatch(/st === "ABORTED"\s*\)\s*\{\s*real = "stopped"/);
    expect(svc).toMatch(/desc\.Status === "ABORTED" \? "stopped"/);
    // 🔴 反例:再出现「ABORTED 与 FAILED 合并成 failed」就红
    expect(svc).not.toMatch(/st === "FAILED" \|\| st === "ABORTED"\s*\)\s*\{\s*real = "failed"/);
  });

  it("Glue 侧 STOPPED 同样映射成 stopped", () => {
    expect(svc).toMatch(/st === "STOPPED" \? "stopped"/);
  });

  it("读时对账遇到「run 行已终态、作业行还 running」⇒ 用 run 行回填作业行(不再去后端重新判)", () => {
    const i = svc.indexOf('typeof run.status === "string" && run.status !== "running"');
    expect(i, "缺少「run 行已终态」这道判据 ⇒ 会一路走到把用户取消判成 failed").toBeGreaterThan(0);
    const blk = svc.slice(i, i + 260);
    expect(blk, "回填作业行要用 run 行的状态").toMatch(/updateJobStatus\(job\.jobId, run\.status/);
    expect(blk).toMatch(/return \{ \.\.\.job, status: run\.status/);
  });
});
