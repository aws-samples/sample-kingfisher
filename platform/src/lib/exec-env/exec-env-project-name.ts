// 执行环境部署用的 CodeBuild 项目名及其日志组名 —— **零 import 叶子**,两类消费方共用同一份字面:
//   · 控制 / 预演 / 恢复侧(`deploy-control.ts` re-export,`region-org-block.ts`):调 CodeBuild API 要项目名;
//   · 落点观测器(`lib/place/observer.ts`):读这个日志组 = 读平台**自己**的控制面产物(CodeBuild 在主控区跑,日志组也在主控区),
//     要把它从「cross-region」里摘出来 —— 观测器在 instrumentation 可达面上,不能 import 带 AWS SDK 的 deploy-control。
// 🔴 与 `infra/lib/exec-env/deploy-stack.ts` 导出的 EXEC_ENV_PROJECT_NAME 是**同一个字面量**,
//    由 `lib/exec-env/__tests__/deploy-control.test.ts` 读 infra 源码逐字钉住(两侧跨构建边界无法共享常量)。
export const EXEC_ENV_PROJECT_NAME = "bgp-exec-env-deploy";

/** CodeBuild 的缺省日志组名(`BatchGetBuilds` 回的 `logs.groupName` 就是它;观测器按**全名**匹配,不按前缀)。 */
export const EXEC_ENV_CODEBUILD_LOG_GROUP = `/aws/codebuild/${EXEC_ENV_PROJECT_NAME}`;
