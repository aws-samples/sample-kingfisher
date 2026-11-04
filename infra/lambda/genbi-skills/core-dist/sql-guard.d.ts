export interface GuardResult {
    ok: boolean;
    sql?: string;
    error?: string;
}
/**
 * 只读判定(单条 + SELECT/WITH 开头 + 写类关键字整词扫描)。返回规整后的 SQL 或拒因。
 * 问数(sanitizeSelect)与数仓直查的非管理员只读闸(生产上线批次 A)共用这一份,不另写第二套词表。
 */
export declare function readOnlySelect(raw: string): {
    ok: true;
    sql: string;
} | {
    ok: false;
    error: string;
};
export declare function sanitizeSelect(raw: string, maxRows: number): GuardResult;
export declare function sanitizeReadOnly(raw: string, maxRows: number): GuardResult;
