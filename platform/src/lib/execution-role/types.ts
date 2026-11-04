// 任务执行角色可选:闭合清单与类型(单一作者)。
//
// 【为什么有这个目录】客户现网(2.1.2)把离线作业依赖库换到自己的桶、想把作业绑到自建角色:页面「执行角色 ARN」
//   承诺「可填自定义角色」,平台任务角色的 iam:PassRole 却只放平台固定名 ⇒ 绑不上;回退本区平台 Glue 角色读不到
//   客户桶 ⇒ Glue 启动期 403。ARN 正则 + 「自定义优先、留空回退」在四个入口各写一份,预检只在 EMR 路径。
// 【用户 2026-11-03 拍板】与 AWS 一致:每个任务可指定账号内任何**该服务可承担**的角色;平台默认 / 顾问角色照用;
//   下拉可在页面内刷新;兼容存量(字段 `executionRoleArn` 不变,空 = 平台默认)。
// 【范围】三种会被用户绑角色的作业服务;DMS / Redshift COPY 是平台内部编排角色,不在清单里(用户不选)。

export const EXEC_ROLE_ENGINES = ["glue", "emr", "flink"] as const;
export type ExecRoleEngine = (typeof EXEC_ROLE_ENGINES)[number];

export function isExecRoleEngine(v: unknown): v is ExecRoleEngine {
  return typeof v === "string" && (EXEC_ROLE_ENGINES as readonly string[]).includes(v);
}

/** 引擎 → 承担该角色的服务主体(信任策略必须含它;PassRole 的 iam:PassedToService 也锁它)。 */
export const SERVICE_PRINCIPAL_BY_ENGINE: Record<ExecRoleEngine, string> = {
  glue: "glue.amazonaws.com",
  emr: "emr-serverless.amazonaws.com",
  flink: "kinesisanalytics.amazonaws.com",
};

/** 引擎 → 用户看到的作业叫法(文案用)。 */
export const EXEC_ROLE_ENGINE_LABEL: Record<ExecRoleEngine, string> = {
  glue: "Glue 作业",
  emr: "EMR Serverless 作业",
  flink: "Flink 应用",
};

/** 下拉三组:平台默认(该落点解析出的角色)/ 角色顾问生成(`bgp-job-role-*`)/ 自建(其余)。 */
export type ExecRoleCandidateKind = "platform" | "advisor" | "custom";

export interface ExecRoleCandidate {
  arn: string;
  name: string;
  kind: ExecRoleCandidateKind;
  createDate?: string;
  description?: string;
}

export interface ExecRoleCandidates {
  engine: ExecRoleEngine;
  targetId: string;
  servicePrincipal: string;
  groups: Record<ExecRoleCandidateKind, ExecRoleCandidate[]>;
  /** 三组合计。 */
  total: number;
  /** ListRoles 读完的时刻(页面显示「已刷新」用)。 */
  fetchedAt: string;
}
