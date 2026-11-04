// 智能运维 / 统一告警中心：类型单一事实源。
//
// 告警规则(AlertRule)+ 通知通道(AlertChannel)+ 告警事件(AlertEvent)。规则匹配的对象是
// 共享运行台账 bgp-task-runs 的终态运行；命中后写事件(幂等)+ 分发到通道(钉钉/企微/邮件/通用)。
// 严禁把 webhook secret 等敏感值写进代码——它们是用户在 UI 填的运行期数据,随表 CMK 加密存储。

// ─── 告警级别 ────────────────────────────────────────────────────────────────
// P1 最高(生产事故) → P3 最低(提示)。首期仅影响通知文案与事件色标,不做分级路由(留二期)。
export type Severity = "P1" | "P2" | "P3";
export const SEVERITIES: Severity[] = ["P1", "P2", "P3"];

// ─── 规则触发条件 ────────────────────────────────────────────────────────────
// failure     ：作用域内任务失败(status=failed)即告警。
// timeout     ：运行时长 duration > thresholdMinutes(分钟)。
// success-rate：作用域内最近 windowMinutes 分钟成功率 < thresholdPercent(%)。
// no-run      ：作用域内最近 windowMinutes 分钟无成功运行(断流,规则式先顶,预测留二期)。
export type ConditionType = "failure" | "timeout" | "success-rate" | "no-run";
export const CONDITION_TYPES: ConditionType[] = ["failure", "timeout", "success-rate", "no-run"];

export interface AlertCondition {
  type: ConditionType;
  thresholdMinutes?: number; // timeout 用
  thresholdPercent?: number; // success-rate 用(低于则告警)
  windowMinutes?: number; // success-rate / no-run 的滚动窗口
  /**
   * (合同 INTERACTION §4sexies「默认按区分别评估」)
   *
   * 聚合类条件(`success-rate` / `no-run`)的评估口径:
   * · `per-target`(**缺省**)= **每个执行环境各算一遍**,各自独立去重;
   * · `pooled` = 全部区揉在一起算一个数(只在用户显式要求「看总体」时用)。
   *
   * 🔴🔴 为什么缺省必须是 per-target:`pooled` 下**一个区全挂会被健康区平均掉** ——
   * 两个区各 10 次运行,A 区全失败、B 区全成功 ⇒ 总体成功率 50%,阈值设 40% 就**不告警**。
   * `no-run` 更糟:A 区完全断流,只要 B 区有一次成功就永远不报。这是**静默漏告**,
   * 比显示错一个数严重得多(值班的人看到一片绿,而一个区已经停了)。合同 §4sexies 早就写了
   * 「默认按区分别评估」,实现一直是池化的 —— 本批订正。
   */
  evaluation?: "per-target" | "pooled";
}

// 作用域：按任务类型 + 可选具体任务 id 圈定要监视的运行。taskType="all" 表示全部类型。
export type ScopeTaskType = "all" | "sync" | "etl" | "emr-serverless" | "workflow" | "flink";
export const SCOPE_TASK_TYPES: ScopeTaskType[] = ["all", "sync", "etl", "emr-serverless", "workflow", "flink"];

export interface AlertScope {
  taskType: ScopeTaskType;
  taskId?: string; // 留空=该类型全部；填=只盯这一个任务
  /**
   * 只盯这几个执行环境(留空 = 全部)。🔴 与 `evaluation` 是两件事:
   * 本字段决定**看哪些区**,`evaluation` 决定**怎么算**(合起来 or 各算一遍)。
   */
  targets?: string[];
}

// ─── 告警规则(bgp-alert-rules)─────────────────────────────────────────────────
export interface AlertRule {
  pk: string; // 恒 "alertrule"
  ruleId: string; // ULID
  name: string;
  projectId: string;
  enabled: boolean;
  scope: AlertScope;
  condition: AlertCondition;
  severity: Severity;
  channelIds: string[]; // 命中后通知哪些通道
  enrichWithDiagnosis: boolean; // 失败类是否自动挂 AI 诊断(复用)
  silenced: boolean; // 静默开关(临时噤声,不删规则)
  lastEvaluatedAt?: string; // 水位：只评估此时间之后的终态运行
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number; // 乐观锁(WS5 约定)
}

// ─── 通知通道(bgp-alert-channels)──────────────────────────────────────────────
// dingtalk：钉钉群机器人 webhook,可选 secret(加签 HMAC-SHA256)。
// wecom   ：企业微信群机器人 webhook,直发 markdown,无签名。
// email   ：SES 发信(sandbox 需先验证发件人/收件人)。
// generic ：通用 JSON webhook(POST 任意端点;也用于平台自测 sink 做无头验证)。
export type ChannelType = "dingtalk" | "wecom" | "email" | "generic";
export const CHANNEL_TYPES: ChannelType[] = ["dingtalk", "wecom", "email", "generic"];

export interface AlertChannel {
  pk: string; // 恒 "alertchannel"
  channelId: string; // ULID
  name: string;
  type: ChannelType;
  webhookUrl?: string; // dingtalk / wecom / generic
  secret?: string; // dingtalk 加签密钥(可选)
  emailFrom?: string; // email：已在 SES 验证的发件人
  emailTo?: string[]; // email：收件人
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// 单通道一次投递结果(写进事件的 channelResults,便于排障)。
export interface ChannelDeliveryResult {
  channelId: string;
  channelType: ChannelType;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  at: string;
}

// ─── 告警事件(bgp-alert-events)────────────────────────────────────────────────
// firing   ：刚命中,尚未分发完；notified：全部通道成功；partial：部分成功；failed：全失败。
export type EventStatus = "firing" | "notified" | "partial" | "failed";

export interface AlertEvent {
  ruleId: string; // 分区键
  sk: string; // = dedupeKey(见下),幂等去重
  eventId: string; // ULID(展示用)
  ruleName: string;
  severity: Severity;
  projectId: string;
  status: EventStatus;
  dedupeKey: string; // "run#<runId>" | "win#<bucket>#<targetId>"(聚合类按区去重,见 AlertCondition.evaluation)
  /** 这条告警属于哪个执行环境(池化评估的事件没有此字段) */
  targetId?: string;
  message: string; // 中文成品串(webhook 投递 + 兜底显示)
  msgKey?: string; // i18n 模板 key(前端按当前语种 t(msgKey, msgParams) 渲染)
  msgParams?: Record<string, string | number>;
  trigger: {
    taskId?: string;
    taskName?: string;
    runId?: string;
    taskType?: string;
    metricValue?: number; // 触发时的度量值(时长/成功率等)
    /** 值班第一个问题是「哪个区挂了」⇒ 必须带 */
    targetId?: string;
  };
  diagnosisId?: string; // 若挂了 AI 诊断
  channelResults: ChannelDeliveryResult[];
  createdAt: string;
  ttl: number; // epoch 秒,~90 天
}
