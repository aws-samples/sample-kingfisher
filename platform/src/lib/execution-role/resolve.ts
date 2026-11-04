// 执行角色 ARN 形态 + 「自定义优先、留空回退平台默认」的**唯一作者**。
//
// 改动前这两件事在 lib/etl/job-service.ts · lib/sync/start-run.ts · lib/realtime/flink-service.ts ·
// lib/engines/emr/{provider,schedule-fanout}.ts · app/api/flink/jobs/{route,[id]/route}.ts 各写一份(同一条正则抄了七遍);
// 现在只此一处,棘轮 `lib/execution-role/__tests__/resolve-ssot.test.ts` 钉:`iam::\d{12}:role` 这条正则在产品源码里只许出现在本文件。

/** IAM 角色 ARN 形态(分区可带后缀,如 aws-cn / aws-us-gov;路径与名字至少一个字符)。 */
export const ROLE_ARN_RE = /^arn:aws[\w-]*:iam::\d{12}:role\/.+$/;

export function isRoleArn(v: unknown): v is string {
  return typeof v === "string" && ROLE_ARN_RE.test(v);
}

/** 形态不对 ⇒ 给用户的一句话(与改动前四入口的原话逐字一致);对 ⇒ null。 */
export function roleArnShapeRejection(arn: string): string | null {
  return ROLE_ARN_RE.test(arn) ? null : `执行角色 ARN 格式非法:${arn}(应形如 arn:aws:iam::<账号>:role/<角色名>)`;
}

/** `role/<path?>/<name>` 整段(含路径);不是角色 ARN ⇒ null。 */
export function rolePathAndNameOfArn(arn: unknown): string | null {
  if (!isRoleArn(arn)) return null;
  return arn.slice(arn.indexOf(":role/") + ":role/".length) || null;
}

/** 角色名(路径取最后一段);不是角色 ARN ⇒ null。 */
export function roleNameOfArn(arn: unknown): string | null {
  const full = rolePathAndNameOfArn(arn);
  if (full === null) return null;
  const name = full.split("/").pop() ?? "";
  return name.length > 0 ? name : null;
}

/** 入口级可修拒因(400):形态非法 / 既没自定义也没平台默认。调用方按自己的错误通道映射(抛 / ensureReject / apiError)。 */
export class ExecRoleRejected extends Error {
  readonly status = 400 as const;
  readonly code = "VALIDATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecRoleRejected";
  }
}

export interface ResolvedExecutionRole {
  roleArn: string;
  /** true = 用户自定义(要预检);false = 平台默认(CDK 建的,权限本来就齐,不预检)。 */
  isCustom: boolean;
}

/**
 * 自定义优先、留空回退平台默认;都没有 ⇒ `ExecRoleRejected`(message = 调用方给的 `missingMessage`,与改动前原话一致)。
 * `custom` 收任意值:非字符串 / 空白 一律当「留空」。
 */
export function resolveExecutionRoleArn(args: {
  custom: unknown;
  fallback: string | null | undefined;
  missingMessage: string;
}): ResolvedExecutionRole {
  const custom = typeof args.custom === "string" ? args.custom.trim() : "";
  if (custom) {
    const reject = roleArnShapeRejection(custom);
    if (reject) throw new ExecRoleRejected(reject);
    return { roleArn: custom, isCustom: true };
  }
  const fallback = typeof args.fallback === "string" ? args.fallback.trim() : "";
  if (!fallback) throw new ExecRoleRejected(args.missingMessage);
  return { roleArn: fallback, isCustom: false };
}
