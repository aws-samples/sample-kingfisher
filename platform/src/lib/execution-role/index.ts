// 任务执行角色可选:对外出口。
export * from "./types";
export * from "./resolve";
export * from "./s3-uris";
export * from "./trust";
export { listExecutionRoleCandidates, platformDefaultRoleArn, classifyRole } from "./candidates";
export * from "./preflight";
