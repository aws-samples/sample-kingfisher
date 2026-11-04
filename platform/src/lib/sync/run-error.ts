// 序 61 B-133 —— 同步 / 发现作业**运行失败原话**的分类与中文呈现(唯一作者)。
//
// 【为什么要有】Glue 作业失败时 `JobRun.ErrorMessage` 是 AWS 原话(「… failed to execute with exception Security Group Not Found
//   The security group 'sg-…' does not exist (Service: AWSGlueJobExecutor; …)」),原来被 `pollGlueJob` / 读时对账 / 调度运行时
//   原样写进运行行,用户在运行历史里看到的就是这一串英文,既不知道是什么、也不知道下一步点哪里(2026-10-28 测试账号真撞)。
// 【规则】
//   · 写侧(`pollGlueJob` / `reconcileGlue`):终态时过 `classifyRunError`,运行行 `error` 写中文结论、`errorRaw` 存原话;
//   · 读侧(运行列表路由):存量行 / 调度运行时(Python)写的行没有 `errorRaw` ⇒ `presentRunRow` 按原话分类后替换 `error`、补 `errorRaw`;
//     已有 `errorRaw` 的行原样返回(写侧已经分类过)。
//   · 分类是**闭合清单**;认不出的原话原样保留(`kind: "unknown"`),不编造结论。
//   · 「网络漂移」类(安全组 / 子网 / Glue 连接不存在)同时让调用方把源行标 broken ⇒ 下一次启动前 `reconcileDatasourceNetwork` 自愈
//     (覆盖核对与 StartJobRun 之间对象被删的竞态窗口,以及不经 TS 启动核心的调度运行时路径)。
export type RunErrorKind =
  | "network-drift-security-group"
  | "network-drift-subnet"
  | "glue-connection-missing"
  | "concurrent-runs"
  | "foreign-table-guard"
  /** 不是 Glue 原话:启动前核对就发现用户自带的网络对象 / 密钥缺失(B-133 预检拒绝),扇出路径落 failed 运行行时用 */
  | "datasource-network-broken"
  | "unknown";

export interface RunErrorClassification {
  kind: RunErrorKind;
  /** 给人看的中文结论(unknown ⇒ 原话) */
  message: string;
  /** AWS / 脚本原话(写侧另存 `errorRaw`) */
  raw: string | null;
  /** 点名的对象 id(安全组 / 子网 / 连接名) */
  objectId?: string;
}

const SG_ID_RE = /(sg-[0-9a-f]{8,})/i;
const SUBNET_ID_RE = /(subnet-[0-9a-f]{8,})/i;
const CONN_NAME_RE = /(bgp-conn-[A-Za-z0-9]+)/;

const RULES: ReadonlyArray<{ kind: RunErrorKind; test: RegExp; objectRe?: RegExp; message: (objectId?: string) => string }> = [
  {
    kind: "network-drift-security-group",
    test: /Security Group Not Found|security group '?sg-[0-9a-f]+'? does not exist|InvalidGroup\.NotFound/i,
    objectRe: SG_ID_RE,
    message: (id) => `数据源的安全组 ${id ?? ""} 已不存在(被平台外删除)。平台会在下一次启动前自动重建平台自建的组并接回 Glue 连接;本次运行失败。若该组是用户自己指定的,请到「数据源 → 编辑 → 网络配置」换一个`,
  },
  {
    kind: "network-drift-subnet",
    test: /subnet '?subnet-[0-9a-f]+'? does not exist|InvalidSubnetID\.NotFound|Subnet Not Found/i,
    objectRe: SUBNET_ID_RE,
    message: (id) => `数据源的子网 ${id ?? ""} 已不存在(被平台外删除)。平台探测选定的子网会在下一次启动前自动重选;用户指定的子网请到「数据源 → 编辑 → 网络配置」换一个`,
  },
  {
    kind: "glue-connection-missing",
    test: /Connection .* not found|EntityNotFoundException.*[Cc]onnection|Could not find connection/i,
    objectRe: CONN_NAME_RE,
    message: (id) => `数据源的 Glue 连接 ${id ?? ""} 已不存在(被平台外删除或源已删)。源仍在时平台会在下一次启动前按源行与凭证重建;源已删请删除引用它的任务`,
  },
  {
    kind: "concurrent-runs",
    test: /ConcurrentRunsExceeded|Concurrent runs exceeded/i,
    message: () => "上一次运行仍在收尾(同一个 Glue 作业同时只能跑一个),请稍后再启动",
  },
  {
    kind: "foreign-table-guard",
    test: /SYNC_REFUSED_CLEAR_FOREIGN_TABLE/,
    message: () => "目标表已存在且不是平台建的,本任务未逐表确认覆盖 ⇒ 运行被拒(一行未动);到任务编辑里确认覆盖或换目标表名",
  },
];

export function classifyRunError(raw: string | null | undefined): RunErrorClassification {
  const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (!text.trim()) return { kind: "unknown", message: text, raw: text || null };
  for (const r of RULES) {
    if (!r.test.test(text)) continue;
    const objectId = r.objectRe ? r.objectRe.exec(text)?.[1] : undefined;
    return { kind: r.kind, message: r.message(objectId), raw: text, ...(objectId ? { objectId } : {}) };
  }
  return { kind: "unknown", message: text, raw: text };
}

export function isNetworkDrift(kind: RunErrorKind): boolean {
  return kind === "network-drift-security-group" || kind === "network-drift-subnet" || kind === "glue-connection-missing";
}

/**
 * 读侧呈现:没有 `errorRaw` 的行(存量 / 调度运行时写的)按原话分类 ⇒ `error` 换成中文结论、`errorRaw` 补原话;
 * 认不出的原样返回。已有 `errorRaw` 的行不再动(写侧分类过)。
 */
export function presentRunRow<T extends { error?: unknown; errorRaw?: unknown }>(row: T): T {
  if (typeof row.error !== "string" || !row.error || row.errorRaw != null) return row;
  const c = classifyRunError(row.error);
  if (c.kind === "unknown") return row;
  return { ...row, error: c.message, errorRaw: c.raw, errorKind: c.kind };
}
