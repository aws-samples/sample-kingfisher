// @kf-batch 50-W5-seg2-WP8
// 类型级门禁靶(51 SPEC §6.1① / §6.4(b);ACCEPTANCE M15):探测**失败**的结果不能进 putGlobalModel。
// 本文件由 model-config-guard.test.ts 用 TypeScript 编译器 API 真编译:
//   · 带 @ts-expect-error 的这一版必须 **0 诊断**(= 该行确实报了错,指令被消费掉);
//   · 去掉指令的对照版(测试内动态生成)必须 **恰好 1 个** TS2322/TS2345。
// 它在 tsconfig 的 exclude(src/**/__tests__/**)里,不进 next build。
import { putGlobalModel } from "@/lib/settings/model-store";
import type { ProbeResult } from "@/lib/ai/capabilities";

const failed: ProbeResult = { ok: false, error: "AccessDenied" };

export const attempt = putGlobalModel({
  scope: "global",
  modelId: "global.anthropic.claude-opus-4-8",
  actor: { actor: "admin" },
  // @ts-expect-error probeOk 字面量 true:ok:false 的探测结果类型上写不进去(M15)
  probe: failed,
});
