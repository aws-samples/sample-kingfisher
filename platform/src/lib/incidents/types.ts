// 运维知识库(Incident Memory)数据类型。
// 单表 bgp-incidents 两类 item(pk="incident#<projectId>"):
//   · 主档 sk="sig#<signature>"    —— 按 signature 归并的故障类别,永久沉淀(无 ttl)。
//   · 发生 sk="occ#<sig>#<diagId>" —— 每次发生快照,ttl 180d 自动过期。
// 安全:只存元数据(signature/症状模板/根因归纳/引擎),严禁存表名/路径/账号/密钥(继承E5)。

export type IncidentStatus = "unresolved" | "resolved-verified" | "silenced";
export type FixKind = "config" | "code" | "backfill" | "infra" | "data";

// 人工维护的"已验证修复手册"。
export interface IncidentResolution {
  markdown: string;
  verified: boolean;
  verifiedBy?: string;
  verifiedAt?: string;
  fixKind?: FixKind;
  // 若修复=补数,供 43-C 一键联动(43-A.2/43-C.2 用;A.1 仅存不消费)。
  backfillHint?: { taskId: string; dateRange?: string };
}

export interface MttrStats {
  lastMttrSec?: number;
  avgMttrSec?: number;
  samples: number;
}

// 故障类别主档(按 signature 归并)。
export interface IncidentMaster {
  pk: string; // "incident#<projectId>"
  sk: string; // "sig#<signature>"
  projectId: string;
  signature: string;
  engine: string; // glue/redshift/flink/dms/emr/...
  title: string; // 已脱敏的现象模板(symptomTemplate)
  status: IncidentStatus;
  occurrenceCount: number; // 复发计数
  affectedTasks: string[]; // 去重任务名(resourceName)
  firstSeenAt: string;
  lastSeenAt: string;
  // **这类故障在哪些区发生过**。
  // 🔴 字段名刻意就叫 `targets`:它等于平台 B 类绑定的默认字段名(`DEFAULT_BINDING_ATTR`),
  // 于是 `filterRowsByScope` 与 `bindingTargets` 的**三级回落**(targets → targetId → home)直接可用,
  // 不需要在这里再写一份「归哪个区」的判定 —— 多写一份就多一处会漂的规则。
  // 无章的存量主档回落主控区:知识库落章之前,平台的作业只在主控区跑过,这是历史事实。
  targets?: string[];
  rootCauseSummary?: string; // 最近一次诊断归纳的根因(可被修复手册覆盖)
  resolution?: IncidentResolution;
  mttrStats?: MttrStats;
  silenceUntil?: string;
  version: number; // 乐观锁
  createdAt: string;
  updatedAt: string;
}

// 单次发生记录(每次诊断落 done 沉淀一条)。
export interface IncidentOccurrence {
  pk: string; // "incident#<projectId>"
  sk: string; // "occ#<signature>#<diagnosticId>"
  projectId: string;
  signature: string;
  occurredAt: string;
  taskId: string;
  taskName: string;
  taskType: string;
  runId: string;
  diagnosticId: string; // 关联 bgp-diagnostics(报告全文在那,此处只存摘要)。幂等去重键。
  symptomDigest: string; // 现象摘要(已脱敏:错误码/首行/引擎)
  // 这**一次**发生在哪个区(从 run 行上的章读来,不猜)。
  targetId?: string;
  resolvedAt?: string; // 该次何时恢复(用于 MTTR)——A.1 暂不填,预留
  ttl: number; // epoch 秒,180d
}

// 归并后的知识库行(列表 API 返回主档 + 派生展示字段)。
export interface IncidentCategory extends IncidentMaster {
  hasVerifiedFix: boolean;
}
