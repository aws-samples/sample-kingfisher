// @kf-batch 50-P50.3-matrix2
// 看板「处置」派发表的门禁(INTERACTION §3.1b)。
//
// 🔴 这一组测试防的是**一类**很难被别的门禁抓到的错:混排之后多了 code-table / model-table 两种行,
// 而处置动作原来是**硬编码**打 `/api/etl-jobs/{id}/schedule` ⇒ 拿一个 codeTableId 去发 DAG。
// 所以这里逐条钉:
//   ① `MATRIX_COVERED` 里每一种行类型都有落点(新加一种类型忘了接,这条就红);
//   ② 未知类型**只许 skip**,绝不回落到任务端点;
//   ③ 免判态(⊘/—/🔶)一律 skip —— 给它们发一次是白跑 + 误导;
//   ④ `drift` **不给一键**:对齐它只能 DROP 重建(有损、不可逆);
//   ⑤ HTTP 200 ≠ 那一格绿了(建模落地在 drift / 缺通道时也回 200)。
import { describe, it, expect } from "vitest";
import { matrixRepublishAction, readMatrixActionResult } from "@/lib/exec-env/matrix-actions";
import { MATRIX_COVERED } from "@/lib/exec-env/consistency-matrix";
import { ATTENTION_STATES, type CellState } from "@/lib/exec-env/deployments-shared";

const T = "tgt_usw2_a";
const row = (type: string, over: Record<string, unknown> = {}) => ({ type, id: "id-1", group: "task" as const, ...over });

describe("🔴🔴 覆盖面:矩阵里出现的每一种行类型都必须有下发落点", () => {
  it.each([...MATRIX_COVERED])("%s 有明确端点(新加行类型忘接派发表 ⇒ 这条红)", (type) => {
    const r = matrixRepublishAction(
      { type, id: "id-1", group: type === "etl-job" ? "task" : "modeling", cronExpression: "0 1 * * *" },
      T,
      "never-deployed"
    );
    expect(r.kind, `资源类型 ${type} 在派发表里没有落点`).toBe("post");
    if (r.kind === "post") {
      expect(r.body).toMatchObject({ targets: [T] });
      expect(r.endpoint).toContain("id-1");
    }
  });

  it("端点逐个对得上(打错端点比报错更糟:它会成功地做错一件事)", () => {
    const etl = matrixRepublishAction(row("etl-job", { cronExpression: "0 1 * * *" }), T, "stale");
    const ct = matrixRepublishAction(row("code-table", { group: "modeling" }), T, "stale");
    const mt = matrixRepublishAction(row("model-table", { group: "modeling" }), T, "stale");
    expect(etl.kind === "post" && etl.endpoint).toBe("/api/etl-jobs/id-1/schedule");
    expect(etl.kind === "post" && etl.body).toEqual({ cronExpression: "0 1 * * *", targets: [T] });
    expect(ct.kind === "post" && ct.endpoint).toBe("/api/modeling/codetables/id-1/land");
    expect(mt.kind === "post" && mt.endpoint).toBe("/api/modeling/dimensions/id-1/apply");
  });

  it("🔴🔴 未知资源类型 ⇒ **skip**,绝不回落到任务调度端点(那等于拿别的 id 去发 DAG)", () => {
    const r = matrixRepublishAction(row("sync", { cronExpression: "0 1 * * *" }), T, "never-deployed");
    expect(r.kind).toBe("skip");
    expect(r.kind === "skip" && r.reason).toMatch(/不回落/);
    // 负向:任何情况下都不许出现 etl-jobs 端点
    expect(JSON.stringify(r)).not.toContain("etl-jobs");
  });

  it("任务行没有 cron ⇒ skip(没有调度就没有可下发的东西),并说清去哪儿补", () => {
    const r = matrixRepublishAction(row("etl-job"), T, "never-deployed");
    expect(r.kind).toBe("skip");
    expect(r.kind === "skip" && r.reason).toMatch(/cron/);
  });
});

describe("🔴🔴 免判态与 drift:该不动的一律不动", () => {
  const immune: CellState[] = ["unbound", "specialized", "unavailable", "residency-blocked", "credential-gap", "ok"];
  it.each(immune)("%s ⇒ skip(给一个「本就不该有」的格子发一次 = 白跑 + 让人以为再试一次就好了)", (s) => {
    const r = matrixRepublishAction(row("code-table", { group: "modeling" }), T, s);
    expect(r.kind).toBe("skip");
  });

  it("🔴🔴 drift ⇒ skip,理由必须点明**要 DROP**(有损)与去处(建模页逐字确认)", () => {
    const r = matrixRepublishAction(row("code-table", { group: "modeling" }), T, "drift");
    expect(r.kind).toBe("skip");
    expect(r.kind === "skip" && r.reason).toMatch(/DROP/);
    expect(r.kind === "skip" && r.reason).toMatch(/FORCE-REBUILD/);
  });

  it("除 drift 外的待处理态都能一键(否则看板上一堆红点没有任何入口)", () => {
    for (const s of ATTENTION_STATES.filter((x) => x !== "drift")) {
      expect(matrixRepublishAction(row("code-table", { group: "modeling" }), T, s).kind, `${s} 没有处置入口`).toBe("post");
    }
  });
});

describe("🔴🔴 读结果:HTTP 200 不等于那一格现在是绿的(界面层假绿)", () => {
  it("建模落地回 200 但观测态是 credential-gap / drift ⇒ 必须报**没成功**", () => {
    const r = row("code-table", { group: "modeling" });
    expect(
      readMatrixActionResult(r, T, { landedByTarget: { [T]: { status: "credential-gap", error: "缺窄权 shared-writer 通道" } } }).ok,
      "只看 HTTP 200 就报「已落地」⇒ 用户以为那个区已经有表了"
    ).toBe(false);
    expect(readMatrixActionResult(r, T, { landedByTarget: { [T]: { status: "drift" } } }).ok).toBe(false);
    const good = readMatrixActionResult(r, T, { landedByTarget: { [T]: { status: "ok", table: "public.dim_code_x" } } });
    expect(good.ok).toBe(true);
    expect(good.note).toContain("public.dim_code_x");
  });

  it("结果里**没有**这个 region 的记录 ⇒ 报「无法确认」,不许当成成功", () => {
    expect(readMatrixActionResult(row("code-table", { group: "modeling" }), T, { landedByTarget: {} }).ok).toBe(false);
    expect(readMatrixActionResult(row("etl-job"), T, { rows: [] }).ok).toBe(false);
    expect(readMatrixActionResult(row("etl-job"), T, {}).ok).toBe(false);
  });

  it("任务下发:逐 target 结果里 failed ⇒ 报失败并带原始错误;ok ⇒ 带产物名", () => {
    const r = row("etl-job");
    const bad = readMatrixActionResult(r, T, { rows: [{ targetId: T, status: "failed", error: "AccessDenied" }] });
    expect(bad.ok).toBe(false);
    expect(bad.note).toBe("AccessDenied");
    const ok = readMatrixActionResult(r, T, { rows: [{ targetId: T, status: "ok", dagId: "bgp_etl_j1__tgt_usw2_a" }] });
    expect(ok.ok).toBe(true);
    expect(ok.note).toContain("bgp_etl_j1__tgt_usw2_a");
  });

  it("🔴 只认**自己那个 region** 的记录(别的区成功了不算这一格成功)", () => {
    const r = readMatrixActionResult(row("etl-job"), T, { rows: [{ targetId: "tgt_home", status: "ok", dagId: "d" }] });
    expect(r.ok, "拿别的区的成功当自己的成功 ⇒ 看板刷新前用户以为已经补齐了").toBe(false);
  });
});
