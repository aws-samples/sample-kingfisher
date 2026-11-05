import { NextResponse } from "next/server";

// 统一 API 响应封装。
//
// 扩展:apiError 增加可选的机器可读 `code` 与 `correlationId`,便于前端按
// 错误类型分支处理、便于支持/排障凭 correlationId 串起整条请求链路。**向后兼容**——既有
// 的 apiError(message) / apiError(message, status) 调用无需改动。

// 机器可读错误码(稳定枚举,前端可据此分支;新增请在此登记)。
export type ApiErrorCode =
  | "VALIDATION_FAILED" // 入参/请求体校验失败
  | "UNAUTHENTICATED" // 未认证 / 登录态失效 (401)
  | "RBAC_DENIED" // 项目角色/权限不足 (403)
  | "NOT_FOUND" // 资源不存在 (404)
  | "GONE" // 能力已下线 (410):数据服务 2026-09-05 下线(50 SPEC §3.9c),对外端点与 BI dataapi 源统一用它
  | "CONFLICT" // 乐观锁/并发冲突 (409) —— WS5 会用到
  | "MWAA_NOT_INSTALLED"
  | "SCHEDULER_NOT_INSTALLED" // (409):非 home target 未装 mwaa 却被纳入调度(50 SPEC v3.26 §2.1);
                         // error.detail = { missing:[{targetId,region,displayName,reason}], fix:{label,href} },前端据此直达补装
  | "DECISION_REQUIRED" // 需用户显式决策才能继续 (409):平台不代劳有损/改变数据语义的动作,
                        // 返回诊断+可执行选项(见 error.detail),由用户确认后带 confirm 重试
  // (409):同步通道**正在停的路上**(还没到终态)⇒ 可重试。
  // 🔴 与 UPSTREAM_ERROR 分开:「还在停」是可恢复的,过几十秒再点一次就成;混成一个码
  //   等于把可恢复说成故障(而在此之前它连码都没有 —— 请求会一直等到 **504**「不知道成没成」)。
  | "TEARDOWN_IN_PROGRESS"
  // (409):同一条 DMS 同步任务已有一条启动编排在飞(provisioning 且不陈旧)
  //   ⇒ 这次**没有**再起一条。🔴 与 CONFLICT 分开:它不是写冲突要重试,而是「已经在做了,等它」;
  //   与 TEARDOWN_IN_PROGRESS 对称(一个是停的路上、一个是启的路上)。
  | "START_IN_PROGRESS"
  // (409):删数据源时它仍被同步 / 实时任务引用 ⇒ 拒绝,detail = { syncTasks:[{id,name,…}], flinkJobs:[…] };
  //   🔴 与 CONFLICT 分开:不是并发写冲突,是「先删掉 / 改掉引用它的任务」—— 用户可修,文案逐条点名。
  | "DATASOURCE_IN_USE"
  // (409):数据源依赖的**用户自带**网络对象(安全组 / 子网)或凭证密钥已不存在,平台不代建 ⇒ 拒绝启动 / 探测,
  //   detail = { object, objectId, userOwned };文案点名对象并指到「编辑数据源 → 网络配置 / 重填口令」。平台自建的对象缺失不走这个码:
  //   平台在使用时刻自动重建(自愈),只在重建失败时才用它。🔴 与 CONFLICT 分开:不是并发写冲突,是「账号里有东西被删了」。
  | "DATASOURCE_NETWORK_BROKEN"
  // R7 (409):删离线计算 / EMR 作业时它仍被编排 DAG 的「离线作业节点」引用 ⇒ 拒绝,detail = { workflows:[{id,name,nodeIds}] };
  //   🔴 与 CONFLICT 分开:不是并发写冲突,是「先去工作流里摘掉该节点」—— 用户可修,文案逐条点名(与 DATASOURCE_IN_USE 同口径)。
  | "JOB_IN_USE"
  // 2026-11-04(409):删离线计算 / EMR 作业时它仍有**在途运行**(task-runs 未终态的 run 行,或作业行上刚续租的运行锁)⇒ 拒绝,
  //   detail = { runs:[{runId,status,startedAt,targetId}], locks:[{targetId,expiresAt,renewedAgoMs}] };文案逐条列 runId 指路「等终态 / 先停止」。
  //   🔴 与 LONG_OP_IN_PROGRESS 分开:那是长操作框架的对象租约(提交段);这里是运行本身还没结束(Glue JobRun / EMR job-run 还在跑)。
  | "JOB_RUN_IN_PROGRESS"
  | "UPSTREAM_TIMEOUT" // 依赖(AWS/查询)超时
  | "UPSTREAM_ERROR" // 依赖调用失败
  // 执行范围三种拒因(50 SPEC v3.34 §2.6.5)。
  // 🔴 放进本 union 而不是另起一套 code 词表:`error.code` 只能有一个词表,
  // 否则验收脚本与前端要维护两份映射,而「两份词表」正是本包在 §2.6.0 里刚拆掉的那种漂移。
  | "INVALID_SCOPE" // ?scope= 文法非法 (400)
  | "TARGET_NOT_FOUND" // scope 指向的执行环境不存在/已删 (404) —— 🔴 绝不回落 home
  | "TARGET_FORBIDDEN" // 存在但本项目未获授权 (403)
  // 定义的区章与「这条执行通道能到哪个区」不一致 (409)。
  // 🔴 语义是**拒跑**,不是「稍后重试」:替它在错误的区跑一遍会让界面/审计/成本一致地记错区,
  // 跨法域下即数据出境。error.detail = { bound:string[], runningIn:string },前端据此提示去哪操作。
  | "TARGET_PUSHDOWN_UNAVAILABLE"
  // 同步执行逐区下推后的两种**永久/如实**拒因 (409):
  // 🔴 CROSS_REGION_SOURCE 不是过渡态:源在 A 区、活在 B 区跑 = 数据出境,**设计如此永久拒**
  //   (原则 2;error.detail = { datasourceOwner, bound })。
  | "CROSS_REGION_SOURCE"
  // zero-etl / DMS 是主控区里的托管通道,尚未逐区 ⇒ 非 home 章任务选它们如实拒(原则 3)。
  | "CHANNEL_NOT_PUSHED_DOWN"
  // 50-WP17-serverless-workflow
  // 🔴 语义已**收窄**:此后多节点编排在 serverless 上是**支持**的(发布 / 触发 / 状态 / 日志都通),
  // 这个码现在只剩一处真用途 = **Airflow Web 控制台**(serverless 压根没有 Web UI)。
  // 「这张图里有服务侧表达不了的节点」是另一件事,走 400 + `SERVERLESS_NODE_UNSUPPORTED`。
  | "WORKFLOW_SCHEDULER_UNSUPPORTED"
  // 这张图里有 serverless 表达不了的节点(目前只有 `external`:sensor 被 operator 白名单拒 +
  // 服务侧 run 没有 logical date)⇒ **400**(补装什么都没用,要改图)。
  | "SERVERLESS_NODE_UNSUPPORTED"
  // 台账 / 服务两边都找不到这个工作流的调度产物(名字也查不到)⇒ 让人去重新发布,
  // 🔴 绝不静默回一个空列表(那会看起来像「它没跑过」——「读不到」不许回落成「没有」)。
  | "SCHEDULER_ARTIFACT_MISSING"
  // 问数会话卡片(54 DESIGN v1.3 §5)
  // 🔴 满额是 409 而不是 400:它不是「请求写错了」,而是**状态冲突** —— 用户删掉几张就能成功。
  //    文案必须给出真实的 used/limit 并引导去删,**绝不静默淘汰最旧的**(护栏一「不丢东西」)。
  | "GENBI_CARD_QUOTA_EXCEEDED"
  // 单卡超限(轮数 / 字节)。拒因必须指明**是哪一项、超了多少**,不静默截断。
  | "GENBI_CARD_TOO_LARGE"
  // 该 target 的本区正文存储不可用(描述符缺 datalakeBucket / 该区读写失败)。🔴 绝不回落主控区。
  | "CARD_STORE_UNAVAILABLE"
  // 落点推不出 (400) / 落点描述符不可用 (409)。🔴 两者都**不回落主控区**。
  | "PLACE_UNDECIDABLE"
  | "PLACE_UNAVAILABLE"
  // 删除执行环境的拒因 (409 除注明外)。每一个都是「用户可修」:说清下一步做什么。
  | "USE_DISCARD" // 从没部署过 ⇒ 走弃置
  | "NOT_DRAINED" // 还在承接 ⇒ 先〔停止承接〕
  | "DUPLICATE_REQUEST" // 已有一张待审批的删除申请
  | "IMPACT_NOT_ZERO" // 绑定 / 启用调度 / 运行中 run 还有 ⇒ 先解绑
  | "IMPACT_UNVERIFIABLE" // 影响预览有来源读不到(读不到 ≠ 没有)
  | "PREVIEW_DRIFT" // 影响清单在预览 / 申请之后变了 ⇒ 重新预览
  | "NOT_APPROVED" // 重试销毁时找不到已批准的删除审批
  | "BROKER_REJECTED" // broker 拒绝销毁(状态码随 broker 码映射)
  | "INTERNAL"; // 兜底未分类错误

export interface ApiErrorOptions {
  code?: ApiErrorCode;
  correlationId?: string;
  /** 结构化补充信息(如 DECISION_REQUIRED 的诊断/选项/确认令牌)。可选,不破坏既有消费者。 */
  detail?: unknown;
}

// 兼容签名(照下方 apiError 的先例):第三参 `meta` 存在时在信封上加 `_meta`(SPEC §3.3a 的
// `{ modelId, modelSource, correlationId, invocations? }` 回显块)。既有两参调用 **逐字节不变**。
export function apiOk(data: any, status = 200, meta?: object) {
  return NextResponse.json({ success: true, data, ...(meta ? { _meta: meta } : {}) }, { status });
}

// 兼容签名:第三参既可是旧式无(默认),也可传 { code, correlationId }。
export function apiError(message: string, status = 400, opts: ApiErrorOptions = {}) {
  const error: { message: string; code?: ApiErrorCode; correlationId?: string; detail?: unknown } = { message };
  if (opts.code) error.code = opts.code;
  if (opts.correlationId) error.correlationId = opts.correlationId;
  if (opts.detail !== undefined) error.detail = opts.detail;
  return NextResponse.json({ success: false, error }, { status });
}
