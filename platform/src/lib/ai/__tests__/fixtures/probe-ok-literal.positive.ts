// 类型级门禁对照(正向):只有 ok:true 的探测结果才能进 putGlobalModel —— 本文件必须 0 诊断。
import { putGlobalModel } from "@/lib/settings/model-store";
import type { ProbeOk } from "@/lib/ai/capabilities";

const passed: ProbeOk = { ok: true, toolUseOk: true };

export const attempt = putGlobalModel({
  scope: "global",
  modelId: "global.anthropic.claude-opus-4-8",
  actor: { actor: "admin" },
  probe: passed,
});
