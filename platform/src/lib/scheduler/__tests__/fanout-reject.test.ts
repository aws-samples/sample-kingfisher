/**
 * 扇出**接缝**的行为判据(2026-09-16 段 slsw 真环境抓到的一族缺陷)。
 *
 * 🔴 为什么必须是**行为**判据而不是文本判据:这一族缺陷的形态就是「代码写了、注释还写着必须保住,
 *   而对象在接缝上被换掉了」。grep 得到的只有「有没有写」,判不出「换没换」。
 *   变异对照(每条都在改前红):
 *     · `fanoutRejection` 改回 `new Error(summary)` ⇒ ①②③ 红
 *     · `tagFanoutFailure` 改回 `new Error(\`触发失败: \${e.message}\`)` ⇒ ④ 红
 *     · `fanoutRunBody` 去掉 `...runs[0]` ⇒ ⑤ 红
 */
import { describe, it, expect } from "vitest";
import {
  fanoutRejection,
  schedulerRejectResponse,
  fanoutRunBody,
  tagFanoutFailure,
  isTypedRejection,
} from "@/lib/scheduler/fanout-reject";
import { MwaaNotInstalled, SCHEDULER_NOT_INSTALLED_CODE } from "@/lib/scheduler/mwaa-endpoint";
import { ServerlessNodeUnsupported } from "@/lib/scheduler/serverless/workflow-yaml";

const notInstalled = () =>
  new MwaaNotInstalled([{ targetId: "tgt_usw2_a", region: "us-west-2", reason: "未安装调度组件" } as never]);

describe("扇出聚合不许抹平类型化拒因", () => {
  it("① 单区失败:聚合后仍然 instanceof MwaaNotInstalled,且 missing 字段还在(补装链接靠它拼)", () => {
    const cause = notInstalled();
    const agg = fanoutRejection([cause], [{ targetId: "tgt_usw2_a", ok: false }], "全部执行范围都没发布成功:…");
    expect(agg).toBeInstanceOf(MwaaNotInstalled);
    expect((agg as unknown as MwaaNotInstalled).missing[0].targetId).toBe("tgt_usw2_a");
    // 逐区明细不许丢
    expect(agg.fanoutPerTarget).toEqual([{ targetId: "tgt_usw2_a", ok: false }]);
    expect(agg.fanoutSummary).toContain("全部执行范围都没发布成功");
  });

  it("② 多区失败且拒因混合:带语义的那个胜出(裸 Error 不许把它盖掉)", () => {
    const bare = new Error("触发失败(tgt_home/us-east-1): 网络抖了一下");
    const typed = new ServerlessNodeUnsupported(["external"]);
    expect(fanoutRejection([bare, typed], [], "s")).toBeInstanceOf(ServerlessNodeUnsupported);
    expect(fanoutRejection([typed, bare], [], "s")).toBeInstanceOf(ServerlessNodeUnsupported);
  });

  it("③ 聚合结果过分派器:409 带补装直达 / 400 带 nodeTypes / 不认识的回 undefined(交给 500)", () => {
    const r409 = schedulerRejectResponse(fanoutRejection([notInstalled()], [], "s"));
    expect(r409?.status).toBe(409);
    const r400 = schedulerRejectResponse(fanoutRejection([new ServerlessNodeUnsupported(["external"])], [], "s"));
    expect(r400?.status).toBe(400);
    // 真·未知拒因 ⇒ 分派器如实说「我不认识」,由调用方兜 500(不许假装 4xx)
    expect(schedulerRejectResponse(new Error("DynamoDB 抖了"))).toBeUndefined();
  });

  it("③b 409 响应体里真的有 code 与补装链接(用户唯一的出路),400 体里真的有 nodeTypes", async () => {
    const r409 = schedulerRejectResponse(fanoutRejection([notInstalled()], [], "s"))!;
    const b409 = (await r409.json()) as { error?: { code?: string; detail?: { fix?: { href?: string } } }; code?: string; detail?: { fix?: { href?: string } } };
    const flat = JSON.stringify(b409);
    expect(flat).toContain(SCHEDULER_NOT_INSTALLED_CODE);
    expect(flat).toMatch(/href/);
    expect(flat).toMatch(/exec-env|执行环境/);
    const r400 = schedulerRejectResponse(
      fanoutRejection([new ServerlessNodeUnsupported(["external"])], [{ targetId: "tgt_usw2_a", ok: false }], "s")
    )!;
    const b400 = (await r400.json()) as { error?: { nodeTypes?: string[] }; perTarget?: unknown[] };
    expect(b400.error?.nodeTypes).toEqual(["external"]);
    // 🔴 逐区明细必须一并回(界面要说清「哪个区没成」)
    expect(b400.perTarget).toEqual([{ targetId: "tgt_usw2_a", ok: false }]);
  });

  it("④ 加「哪个区」前缀不许丢 code / 不许把子类降级成裸 Error", () => {
    const withCode = Object.assign(new Error("找不到 serverless workflow"), { code: "SCHEDULER_ARTIFACT_MISSING" });
    const tagged = tagFanoutFailure(withCode, "tgt_usw2_a", "us-west-2");
    expect((tagged as { code?: string }).code).toBe("SCHEDULER_ARTIFACT_MISSING");
    expect(tagged.message).toContain("tgt_usw2_a");
    // 子类原样回(instanceof 要立得住);它的文本本来就点名了区域
    const typed = notInstalled();
    expect(tagFanoutFailure(typed, "tgt_usw2_a", "us-west-2")).toBe(typed);
    // 真裸 Error:加前缀,且**不许**凭空造出 code
    const bare = tagFanoutFailure(new Error("网络抖了一下"), "tgt_home", "us-east-1");
    expect(bare.message).toContain("tgt_home/us-east-1");
    expect((bare as { code?: string }).code).toBeUndefined();
  });

  it("⑤ 扇出成功响应:顶层摊平第一条 run(与离线作业侧同一约定),多区时 runs/runGroupId 恒在", () => {
    const one = fanoutRunBody({
      dagId: "bgp_x",
      runs: [{ targetId: "tgt_usw2_a", region: "us-west-2", scheduler: "serverless", serviceRunId: "R1" }],
    });
    expect(one.serviceRunId).toBe("R1");
    expect(one.scheduler).toBe("serverless");
    expect((one.runs as unknown[]).length).toBe(1);
    expect(one.runGroupId).toBeUndefined();

    const two = fanoutRunBody({
      dagId: "bgp_x",
      runGroupId: "rg_1",
      runs: [
        { targetId: "tgt_home", serviceRunId: "R1" },
        { targetId: "tgt_usw2_a", serviceRunId: "R2" },
      ],
    });
    // 顶层是兼容层(第一条),真相在 runs[] —— 两者都必须在,少哪个都会有一类消费者瞎掉
    expect(two.serviceRunId).toBe("R1");
    expect((two.runs as Array<{ serviceRunId: string }>).map((r) => r.serviceRunId)).toEqual(["R1", "R2"]);
    expect(two.runGroupId).toBe("rg_1");
    expect(String(two.message)).toContain("2");
  });

  it("⑥ isTypedRejection 的判别力:有 code / 是子类 / dag-spec-invalid ⇒ 真;裸 Error ⇒ 假", () => {
    expect(isTypedRejection(Object.assign(new Error("x"), { code: "engine-capability" }))).toBe(true);
    expect(isTypedRejection(notInstalled())).toBe(true);
    expect(isTypedRejection(new Error("dag-spec-invalid: 节点缺 id"))).toBe(true);
    expect(isTypedRejection(new Error("网络抖了一下"))).toBe(false);
    expect(isTypedRejection(undefined)).toBe(false);
  });
});
