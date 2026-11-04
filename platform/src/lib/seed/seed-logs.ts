// @kf-batch 50-CAPSEED-seed-dispatch
// 手动造数那条 run 的日志(任务监控「日志」按钮):**去这条 run 实际执行的那个区**取 Glue 的 error / output 两个流。
// 🔴 不回落主控区:区从 run 行上的章(`targetId`)解析;解析不到就如实说,绝不拿主控区的空日志冒充「作业没输出」。
// 形状与离线作业的读取器(`app/api/etl-jobs/[id]/logs`)同口径:日志组 `/aws-glue/jobs/{error,output}`,流 = JobRunId。
import { regionalClient } from "@/lib/aws/clients";
import { resolveGlueBinding } from "@/lib/exec-env/data-plane-target";

export async function readSeedRunLogs(run: Record<string, unknown>): Promise<Array<{ message: string }>> {
  const out: Array<{ message: string }> = [];
  const targetId = String(run.targetId || "");
  const jobName = String(run.glueJobName || "");
  const jobRunId = String(run.glueJobRunId || "");
  out.push({ message: `造数作业 ${jobName || "(未记录)"} · run ${jobRunId || "(未记录)"} · 执行范围 ${targetId || "(空)"} · 状态 ${String(run.status || "")}` });
  if (run.error) out.push({ message: `失败原因:${String(run.error)}` });
  if (!targetId || !jobRunId) return out;
  let region = "";
  try {
    region = (await resolveGlueBinding({ targetId })).region;
  } catch (e) {
    out.push({ message: `取不到这条运行的执行区域(${targetId}):${(e as Error)?.message ?? String(e)} —— 刻意不回落主控区去取` });
    return out;
  }
  const { GetLogEventsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
  const cwl = await regionalClient("logs", region);
  for (const group of ["/aws-glue/jobs/error", "/aws-glue/jobs/output"]) {
    try {
      const r = await cwl.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: jobRunId, limit: 300, startFromHead: true }));
      const lines = (r.events || []).map((e) => e.message || "").filter(Boolean);
      out.push({ message: `===== ${group}(${region})${lines.length ? "" : ":暂无(作业刚启动或还没输出)"} =====` });
      for (const l of lines) out.push({ message: l });
    } catch (e) {
      out.push({ message: `===== ${group}(${region}):读取失败 ${(e as Error)?.message ?? String(e)} =====` });
    }
  }
  return out;
}
