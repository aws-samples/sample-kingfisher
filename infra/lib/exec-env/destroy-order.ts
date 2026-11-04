// 执行环境**下线销毁**的栈删除顺序 —— 唯一作者。
//
// 【为什么要有一个作者】销毁顺序只在两处被用到:buildspec 的 destroy 分支(按它逐栈删)与 synth-gate 的顺序判据
//   (按真 synth 出来的 manifest 依赖图核对它)。两处各写一份 = 下一次加组件时一处漏改 ⇒ 先删 core 再删依赖它的组件栈,
//   CFN 报 Export 正被引用、整条删除链停住(N-5 那种「删一半停住」的同族)。
//
// 【规则】组件栈先走(反依赖序:IMPLEMENTED 里越晚加入的越先删)→ core → base。
//   🔴 组件全集取 `stack-group.ts` 的 IMPLEMENTED_COMPONENTS(栈组装配的唯一真值),不在这里手抄名单;
//   🔴 「组件栈都只依赖 base / core」这条前提由 synth-gate 用**真实 manifest 依赖**逐条核对(不是靠注释)。
//
// 🔴 删栈之前,buildspec 还有一步**托管服务先走**(Flink 应用 / MWAA Serverless 工作流 / Glue / EMR Serverless /
//   DMS 任务 / Redshift 工作组与命名空间):它们由平台运行期创建、或带 RETAIN,占着子网与安全组 ⇒ 不先删,base 栈删 VPC 必卡。
//   那一步在 `infra/scripts/exec-env-destroy.sh` 里,顺序判据同样在 synth-gate。
import { IMPLEMENTED_COMPONENTS } from "./stack-group";
import { BASE_STACK_SUFFIX } from "./context";

/** 栈名后缀的删除顺序(`BgpExecEnv-<slug>-<后缀>`;后缀 = 组件键 / base)。 */
export function execEnvDestroyStackSuffixes(): string[] {
  const optional: string[] = IMPLEMENTED_COMPONENTS.filter((c) => c !== "core");
  return [...optional].reverse().concat(["core", BASE_STACK_SUFFIX]);
}
