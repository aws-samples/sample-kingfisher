// 模块 44 — Copilot 动作守卫(闸 2:平台侧白/黑名单)。
// 安全契约:Copilot 只能执行"创建/生成/建议/只读"类动作,永不执行/运行/发布/删除。
// 设计为【默认拒绝 + 显式白名单】(而非黑名单兜底)——新增动作若不在白名单,一律拒,宁可漏放不可错放。
// 三闸纵深:闸1=工具集不含执行工具(能力面);本文件=闸2;闸3=ask 入口 requireProject(editor)+审计。
// 依据:docs/design/44-unified-copilot/ENDPOINT-INVENTORY.md(Explore 穷举分类)。

// Copilot 允许的"安全创建/写元数据"动作白名单(actionCode = 对应平台 audit action)。
// 只列【建草稿/写配置且无执行、无对外暴露、无云资源销毁、非平台管理】的动作。
const ALLOWED_CREATE_ACTIONS = new Set<string>([
  "datasource.create", // 建数据源(建 Glue 连接属配置,不跑作业)
  "sync.create", // 建同步任务(draft,不 start)
  "etl-job.create", // 建离线作业(draft,不 run/schedule)
  "flink.create", // 建 Flink 作业(draft,不 start)
  "engine.create", // 建多引擎作业(draft)
  "quality.rule.create", // 建质量规则(配置)
  "genbi.context.create", // 建业务口径/知识(项目级)
  "workflow.create", // 建编排(draft,不 publish/trigger)
]);

// 明确【禁止】的动作前缀/精确名 —— 即便后缀像 create/issue 也拒(纵深冗余,防白名单误加)。
// 执行/运行/发布/删除/落库/对外授信/平台管理/晋升审批/回滚,全在此拦。
const FORBIDDEN_SUFFIXES = [
  ".run", ".start", ".stop", ".trigger", ".backfill", ".rerun", ".schedule",
  ".apply", ".land", ".compute", ".scan", ".execute", ".produce", ".evaluate",
  ".publish", ".delete", ".offline", ".detect", ".collect", ".learn", ".predict",
];
const FORBIDDEN_EXACT = new Set<string>([
  "data-api-key.issue", // 对外授信(签发 API Key)
  "role-advisor.create", // 建 IAM 角色(提权风险)
  "network-advisor.apply", // 建 VPC/endpoint(改云网络)
  "project.create", // 建项目空间(平台管理级)
  "promote.request", "promote.execute", // 跨环境晋升
  "approval.decide", // 审批落实副作用
  "resource.rollback", // 版本回滚
  "sensitive.adopt", // 采纳→写分级(可单独评估,先禁)
]);

export interface ActionGuardResult {
  allowed: boolean;
  reason?: string;
}

// 判定一个 actionCode 是否允许 Copilot 执行。默认拒绝。
export function guardCopilotAction(actionCode: string | undefined): ActionGuardResult {
  const code = (actionCode || "").trim();
  if (!code) return { allowed: false, reason: "缺少 actionCode,默认拒绝" };
  if (FORBIDDEN_EXACT.has(code)) return { allowed: false, reason: `动作 ${code} 在禁止清单(对外/提权/平台管理类)` };
  for (const suf of FORBIDDEN_SUFFIXES) {
    if (code.endsWith(suf)) return { allowed: false, reason: `动作 ${code} 属执行/运行/发布/删除类(后缀 ${suf}),Copilot 永不执行` };
  }
  if (ALLOWED_CREATE_ACTIONS.has(code)) return { allowed: true };
  return { allowed: false, reason: `动作 ${code} 不在 Copilot 允许的创建白名单内,默认拒绝` };
}

// 供测试/展示:当前允许的创建动作清单。
export function allowedCreateActions(): string[] {
  return Array.from(ALLOWED_CREATE_ACTIONS);
}
