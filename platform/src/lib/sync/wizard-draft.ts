// (用户 2026-10-15:「任务配置失败了,点击『完成』按钮没反应,退出后需要重新从头配置,最好增加一个临时保存按钮,或者其他兜底策略」)
// 🔴 同步任务向导的**本地草稿**(单一作者):向导每一步的改动都落到浏览器 localStorage,保存成功才清;
//   弹窗再打开时若有草稿就问「恢复 / 丢弃」。只存配置,不存密钥(向导里本来就没有密钥字段)。
//   纯函数 + 可注入的 storage(单测不碰 window);键按「新建」/ 某个 taskId 分开,互不覆盖。

export interface SyncWizardDraft {
  version: 1;
  savedAt: string;                        // ISO
  step: number;
  formValues: Record<string, unknown>;    // form.getFieldsValue(true)
  selectedTables: string[];
  templateTables: string[];
  fieldMappings: Record<string, unknown[]>;
  /** 带日期变量的源表名 → 样例表(旧草稿没有这个键 ⇒ 视为没选样例) */
  templateSamples?: Record<string, string>;
  /**
   * 写这份草稿时看到的「任务配置最近一次保存」标记(任务行的 configSavedAt;新建任务 / 旧草稿 / 还没有这个标记的任务 = 没有这个键)。
   * 再打开时与任务当前的标记不一样 ⇒ 任务在草稿之后又被保存过 ⇒ 草稿作废(见 isDraftStale)。
   */
  baseConfigSavedAt?: string;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SYNC_DRAFT_KEY_PREFIX = "bgp-sync-wizard-draft:";
/** 草稿过期时间:7 天(更久的配置大概率已经不对,恢复出来反而误导)。 */
export const SYNC_DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;

export function syncDraftKey(taskId?: string | null): string {
  return SYNC_DRAFT_KEY_PREFIX + (taskId && String(taskId).trim() ? String(taskId).trim() : "new");
}

function defaultStorage(): DraftStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch { /* 隐私模式等拿不到 */ }
  return null;
}

/** 有可恢复内容才算草稿:至少填了名字 / 选了源 / 选了表之一;否则不存(刚打开就关的空壳不值得问用户)。 */
export function isDraftWorthSaving(d: Pick<SyncWizardDraft, "formValues" | "selectedTables" | "templateTables">): boolean {
  const fv = d.formValues || {};
  const name = typeof fv.name === "string" ? fv.name.trim() : "";
  return !!name || !!fv.datasourceId || (d.selectedTables?.length ?? 0) > 0 || (d.templateTables?.length ?? 0) > 0;
}

export function saveSyncDraft(taskId: string | null | undefined, d: Omit<SyncWizardDraft, "version" | "savedAt">, storage: DraftStorage | null = defaultStorage(), now: () => Date = () => new Date()): boolean {
  if (!storage) return false;
  if (!isDraftWorthSaving(d)) return false;
  const payload: SyncWizardDraft = { version: 1, savedAt: now().toISOString(), ...d };
  try {
    storage.setItem(syncDraftKey(taskId), JSON.stringify(payload));
    return true;
  } catch {
    return false; // 配额满 / 被禁:草稿是兜底,不许反过来打断向导
  }
}

/** 读草稿;形状不对 / 过期 / 解析失败 ⇒ null(并顺手清掉坏的)。 */
export function loadSyncDraft(taskId: string | null | undefined, storage: DraftStorage | null = defaultStorage(), now: () => Date = () => new Date()): SyncWizardDraft | null {
  if (!storage) return null;
  const key = syncDraftKey(taskId);
  let raw: string | null = null;
  try { raw = storage.getItem(key); } catch { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<SyncWizardDraft>;
    if (d.version !== 1 || typeof d.savedAt !== "string" || typeof d.step !== "number" || !d.formValues || !Array.isArray(d.selectedTables) || !Array.isArray(d.templateTables) || typeof d.fieldMappings !== "object") {
      storage.removeItem(key);
      return null;
    }
    if (now().getTime() - new Date(d.savedAt).getTime() > SYNC_DRAFT_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return d as SyncWizardDraft;
  } catch {
    try { storage.removeItem(key); } catch { /* 忽略 */ }
    return null;
  }
}

/**
 * 草稿是不是已经作废:任务在草稿写下之后又被保存过(换了浏览器 / 别人保存 / 本机草稿没清掉)。
 * 🔴 不比时钟(浏览器时钟与服务器时钟会差):比的是「写草稿时看到的保存标记」与「任务现在的保存标记」是不是同一个值。
 *   两边都没有(新建任务 / 旧草稿配还没有标记的任务)⇒ 不算作废,行为与没有这个判断时一样。
 */
export function isDraftStale(d: Pick<SyncWizardDraft, "baseConfigSavedAt">, currentConfigSavedAt: string | null | undefined): boolean {
  return String(d.baseConfigSavedAt ?? "") !== String(currentConfigSavedAt ?? "");
}

/** 打开向导时读草稿:作废的(任务在它之后又保存过)当场清掉并当作没有,不拿出来问用户「恢复 / 丢弃」。 */
export function loadUsableSyncDraft(taskId: string | null | undefined, currentConfigSavedAt: string | null | undefined, storage: DraftStorage | null = defaultStorage(), now: () => Date = () => new Date()): SyncWizardDraft | null {
  const d = loadSyncDraft(taskId, storage, now);
  if (!d) return null;
  if (isDraftStale(d, currentConfigSavedAt)) {
    clearSyncDraft(taskId, storage);
    return null;
  }
  return d;
}

export function clearSyncDraft(taskId: string | null | undefined, storage: DraftStorage | null = defaultStorage()): void {
  if (!storage) return;
  try { storage.removeItem(syncDraftKey(taskId)); } catch { /* 忽略 */ }
}

/** 给人看的「上次保存于」:只到分钟。 */
export function describeDraftAge(d: SyncWizardDraft, now: () => Date = () => new Date()): string {
  const ms = now().getTime() - new Date(d.savedAt).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
