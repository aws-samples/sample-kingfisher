// @kf-batch 50-B08-sync-task-write-guard
// 🔴🔴 **同步任务行的状态写回必须条件写** —— 否则已删的任务会被后台回写**凭空造回来**。
//
// 【真环境证据(2026-09-20 第三轮全量硬门 `wp24` 段)】
//   `WP24-4 删除 HTTP=['#1 200'] DMS 侧还在=False(轮询到消失) 平台行还在=True`
//   删除路由本身是对的(先撤通道 → 撤不下来 409/502 且不删行 → 否则才 Delete;Get/Delete 同一个 Key),
//   判据读行也用的是 **`--consistent-read`** ⇒ 「强一致读到行还在」只能是**被谁写回来了**。
//   那一轮是**并行 3 worker**,同时有别的段在刷同步任务列表、后台还有 `pollGlueJob` 在轮询。
//
// 【为什么不逐处去追「到底是哪一处」】DynamoDB 的 `UpdateItem` 默认 upsert ⇒ 只要还剩**一处**
//   直接发 `UpdateCommand`,这类缺陷就会回来(本仓「枚举违规写法一定漏第 N+1 种」的老账)。
//   ⇒ 反过来定**唯一允许的形态**:全部走 `updateSyncTaskIfExists`,它恒带
//     `ConditionExpression: attribute_exists(taskId)`,行不存在就 no-op 返回 false。
//
// 【这组判据钉三件事】
//   ① 唯一作者自己:恒带条件写 · 条件失败 ⇒ `{ok:false}` 不抛 · 其它错误照旧抛(不许吞成「行不存在」);
//   ② 覆盖面(闭合式):`src/app/api/sync/**` 与 `src/lib/sync/**` 里**没有任何**直接对
//      `TABLES.SYNC_TASKS` 发的 `UpdateCommand`;
//   ③ 最危险的那几处**点名**接上了(对账/后台轮询 —— 它们手里的 task 来自更早的读,窗口最大)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");

const sent: unknown[] = [];
let nextError: Error | null = null;

vi.mock("@/lib/aws/dynamodb", () => ({
  // 🔴 mock 只替**真外部**(AWS SDK 出口),且回传入参 —— 不许回自己编的值
  //   (记忆 mock-hides-the-seam / unwired-code-is-unverified)。
  docClient: {
    send: (cmd: { input?: unknown }) => {
      sent.push(cmd.input);
      if (nextError) {
        const e = nextError;
        nextError = null;
        return Promise.reject(e);
      }
      return Promise.resolve({ Attributes: { echoed: cmd.input } });
    },
  },
  TABLES: { SYNC_TASKS: "bgp-sync-tasks" },
}));

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 找出「直接对 SYNC_TASKS 发 UpdateCommand」的位置。
 * 🔴 切块而不是开字符窗口:窗口会跨到**下一个**调用去,既可能漏也可能误判
 *   (记忆 criteria-window-spans-rows:判据开窗口会拿邻居给自己放行)。
 */
function rawSyncTaskUpdates(src: string): string[] {
  const hits: string[] = [];
  const parts = src.split("new UpdateCommand(");
  for (let i = 1; i < parts.length; i++) {
    // 只看到本次调用参数结束(下一个 `new ` 之前),再要求 TableName 就在开头附近
    const block = parts[i].split(/\bnew [A-Z]/)[0];
    const head = block.slice(0, 400);
    if (/TableName:\s*TABLES\.SYNC_TASKS/.test(head)) hits.push(head.split("\n").slice(0, 3).join(" ").trim());
  }
  return hits;
}

describe("同步任务行的状态写回:唯一写通道 + 条件写(B-08)", () => {
  beforeEach(() => {
    sent.length = 0;
    nextError = null;
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("① 唯一作者恒带 `attribute_exists(taskId)` 条件写,且 Key 补全", async () => {
    const { updateSyncTaskIfExists } = await import("@/lib/sync/task-write");
    const r = await updateSyncTaskIfExists({
      taskId: "t-1",
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "running" },
    });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const input = sent[0] as Record<string, unknown>;
    expect(input.TableName).toBe("bgp-sync-tasks");
    expect(input.Key).toEqual({ userId: "default-user", taskId: "t-1" });
    expect(
      input.ConditionExpression,
      "少了条件写 ⇒ 行已删时会 upsert 出一条只有 Key 的残行(B-08 那个形态)"
    ).toBe("attribute_exists(taskId)");
    // 调用方给的表达式必须原样带过去(不许被作者悄悄改写)
    expect(input.UpdateExpression).toBe("SET #s = :s");
    expect(input.ExpressionAttributeValues).toEqual({ ":s": "running" });
  });

  it("② 行已不存在 ⇒ `{ok:false}` **静默 no-op**,不抛、也不建行", async () => {
    const { updateSyncTaskIfExists } = await import("@/lib/sync/task-write");
    const err = new Error("cond failed");
    err.name = "ConditionalCheckFailedException";
    nextError = err;
    const r = await updateSyncTaskIfExists({ taskId: "gone", UpdateExpression: "SET a = :a" });
    expect(r.ok).toBe(false);
    expect(r.Attributes).toBeUndefined();
  });

  it("③ 其它错误照旧抛 —— 不许把凭证/限流吞成「行不存在」", async () => {
    const { updateSyncTaskIfExists } = await import("@/lib/sync/task-write");
    const err = new Error("ExpiredToken");
    err.name = "ExpiredTokenException";
    nextError = err;
    await expect(
      updateSyncTaskIfExists({ taskId: "t", UpdateExpression: "SET a = :a" })
    ).rejects.toThrow(/ExpiredToken/);
  });

  // @kf-batch 41-B121-dms-start-single-flight —— 状态机守卫(「只许一条启动编排在飞」)也必须经本通道
  it("⑥ 带 `onlyIf` ⇒ 条件**叠**在 attribute_exists 之后(AND),且让 DDB 把旧行带回来以便分清「行没了 / 条件没过」", async () => {
    const { updateSyncTaskIfExists } = await import("@/lib/sync/task-write");
    const r = await updateSyncTaskIfExists({
      taskId: "t-1",
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "provisioning" },
      onlyIf: "#s <> :s",
    });
    expect(r.ok).toBe(true);
    const input = sent[0] as Record<string, unknown>;
    expect(input.ConditionExpression, "调用方的条件不许替掉 attribute_exists —— 那是 B-08 的命根").toBe("attribute_exists(taskId) AND (#s <> :s)");
    expect(input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    expect("onlyIf" in input, "onlyIf 是本通道的参数,不许漏给 SDK").toBe(false);
    // 不带 onlyIf 时不要这个开销(与 ① 的字面一致)
    sent.length = 0;
    await updateSyncTaskIfExists({ taskId: "t-1", UpdateExpression: "SET a = :a" });
    expect((sent[0] as Record<string, unknown>).ReturnValuesOnConditionCheckFailure).toBeUndefined();
  });

  it("⑦ 条件失败分两种:DDB 带回了旧行 ⇒ `miss: precondition`(行在、被别人抢先);没带 ⇒ `miss: gone`(行没了)", async () => {
    const { updateSyncTaskIfExists } = await import("@/lib/sync/task-write");
    const withItem: Error & { Item?: unknown } = new Error("cond failed");
    withItem.name = "ConditionalCheckFailedException";
    withItem.Item = { taskId: { S: "t-1" } };
    nextError = withItem;
    const r1 = await updateSyncTaskIfExists({ taskId: "t-1", UpdateExpression: "SET a = :a", onlyIf: "attribute_not_exists(b)" });
    expect(r1).toEqual({ ok: false, miss: "precondition" });

    const bare = new Error("cond failed");
    bare.name = "ConditionalCheckFailedException";
    nextError = bare;
    const r2 = await updateSyncTaskIfExists({ taskId: "t-1", UpdateExpression: "SET a = :a", onlyIf: "attribute_not_exists(b)" });
    expect(r2).toEqual({ ok: false, miss: "gone" });

    // 不带 onlyIf 时即使异常上挂了 Item 也只能是 gone(没要求带回旧行 ⇒ 不许据此臆断)
    nextError = withItem;
    const r3 = await updateSyncTaskIfExists({ taskId: "t-1", UpdateExpression: "SET a = :a" });
    expect(r3.miss).toBe("gone");
  });

  it("④ 🔴 覆盖面(闭合式):sync 的读写面里**没有**直接对 SYNC_TASKS 发的 UpdateCommand", () => {
    const files = [...walk(join(SRC, "app/api/sync")), ...walk(join(SRC, "lib/sync"))];
    expect(files.length, "一个文件都没扫到 ⇒ 判据在空转(目录改名了?)").toBeGreaterThan(8);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("task-write.ts")) continue; // 唯一作者自己就是那个出口
      for (const h of rawSyncTaskUpdates(readFileSync(f, "utf8"))) {
        offenders.push(`${f.replace(SRC, "src")} :: ${h.slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      "这些位置绕过了唯一写通道 ⇒ 行已删时会 upsert 出幽灵任务。改成 updateSyncTaskIfExists(...)"
    ).toEqual([]);
  });

  it("⑤ 最危险的那几处点名接上了(对账 / 后台轮询:它们手里的 task 来自更早的读)", () => {
    const rec = readFileSync(join(SRC, "lib/sync/reconcile.ts"), "utf8");
    expect(
      /updateSyncTaskIfExists\s*\(/.test(rec.replace(/^\s*import[\s\S]*?;\s*$/gm, "")),
      "读时对账没走唯一写通道 —— 它的 task 来自**列表**(没有重新 Get),窗口最大"
    ).toBe(true);
    // @kf-batch 37-sync-backfill —— 启动 / 后台轮询已原样搬到 lib/sync/start-run.ts ⇒ 这条路 = 路由 + 启动核心
    const start =
      readFileSync(join(SRC, "app/api/sync/[id]/start/route.ts"), "utf8") + "\n" + readFileSync(join(SRC, "lib/sync/start-run.ts"), "utf8");
    const noImports = start.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
    expect(
      (noImports.match(/updateSyncTaskIfExists\s*\(/g) || []).length,
      "启动/后台轮询那条路上有多处写回(启动态 / 水位线 / 终态),必须都走唯一写通道"
    ).toBeGreaterThanOrEqual(3);
  });
});
