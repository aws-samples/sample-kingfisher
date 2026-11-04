// 模块 44 — Copilot 工具注册表类型(抽象核心)。
// 设计原则 3(见 docs/design/44):Copilot 的可用动作抽象成声明式"能力注册表",
// 新增能力 = 加一行,不改分发核心。工具只有两类 kind,**永不存在 "execute"**——
// 执行/运行/发布/删除类动作在类型层面就不可表达(安全契约,见 [[module44-unified-copilot]])。

// 工具类别:read(只读,无副作用)| create(创建/生成/建议,回调平台"创建类"API)。
// 刻意不定义 "execute" —— 这是模块 44 的恒定安全边界(闸 1:能力面根除)。
export type CopilotToolKind = "read" | "create";

// 调用者上下文:透传当前登录身份 + 项目 + 环境,供工具回调平台 API 时复用现有 RBAC(闸 3)。
export interface CopilotCaller {
  token: string; // 当前登录用户的 ID token(不是服务账号——Copilot 不提权)
  projectId: string; // x-bgp-project
  env: string; // x-bgp-env
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-17)—— 这次计划**面向哪个执行区**。
   *
   * 🔴 为什么必须有:Copilot 建出来的 draft(同步任务 / 离线作业 / Flink 作业)最终要在某个区跑。
   * 而 `create-service.ts` 的三个 createXxxDraft **绕过了平台的落点作者**
   * (`bindingForNewSyncTask` / 新建路由里的落点校验)⇒ 建出来的行**一个章都没有** ⇒
   * 读侧三级回落把它们全归主控区。这与本仓记录过的教训是同一个:
   * 「planner 是唯一绕过环境注入的路径」——第二次现形。
   * 缺省 = 主控区(与改动前逐字节等价)。
   */
  targetId?: string;
}

export interface CopilotToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

// 一个工具的声明式描述。inputSchema 用 JSON Schema(喂给 Bedrock Converse toolConfig)。
export interface CopilotTool {
  name: string; // 工具名(snake_case),如 list_datasources
  kind: CopilotToolKind;
  description: string; // 给模型看的用途说明(运营化,便于命中)
  // audit action code:如 "datasource.create"。create 类工具的 actionCode 必须是"创建类"前缀,
  // 由 action-guard 用它做闸 2 白/黑名单校验(见 lib/copilot/action-guard.ts)。read 类可为 undefined。
  actionCode?: string;
  inputSchema: Record<string, any>; // JSON Schema(type:object)
  handler: (args: any, caller: CopilotCaller) => Promise<CopilotToolResult>;
}
