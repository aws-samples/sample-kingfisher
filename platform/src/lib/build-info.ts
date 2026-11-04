// @kf-batch 39-release-visibility —— 运行中的平台到底是哪一版(序 39 第二刀)。
//
// **唯一作者**:读 Dockerfile 注入的构建信息环境变量。键名与 `infra/lib/shared/build-info.ts#BUILD_ARG_KEYS` 逐字相同
// (跨包无法 import,由 `lib/__tests__/build-info.test.ts` 守卫钉两侧 + Dockerfile 的 ARG / ENV)。
// 🔴 只读事实、不编造:环境里没有就是 `null`、`known=false`,页面显示「构建信息不可用」;本机 dev server 没有这些变量,
//    同样如实显示(不许用 package.json 版本号冒充发版号)。
export const BUILD_INFO_ENV_KEYS = {
  releaseTag: "BGP_BUILD_RELEASE_TAG",
  productCommit: "BGP_BUILD_PRODUCT_COMMIT",
  productCommitAt: "BGP_BUILD_PRODUCT_COMMIT_AT",
  version: "BGP_BUILD_VERSION",
} as const;

export interface BuildInfo {
  /** 至少知道发版 tag 或产品提交之一 */
  known: boolean;
  /** 指向构建提交的发版 tag(2.2.0 起 `v<版本号>`;历史版本为 `release-<日期>`);未发版构建为 null */
  releaseTag: string | null;
  /** 最后一笔改了产品字节(platform / infra / scripts)的提交短哈希 */
  productCommit: string | null;
  /** 该提交的提交时间(ISO 8601) */
  productCommitAt: string | null;
  /** 仓库根 VERSION 文件内容 */
  version: string | null;
}

export function readBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const pick = (key: string): string | null => {
    const value = (env[key] ?? "").trim();
    return value ? value : null;
  };
  const releaseTag = pick(BUILD_INFO_ENV_KEYS.releaseTag);
  const productCommit = pick(BUILD_INFO_ENV_KEYS.productCommit);
  return {
    known: Boolean(releaseTag || productCommit),
    releaseTag,
    productCommit,
    productCommitAt: pick(BUILD_INFO_ENV_KEYS.productCommitAt),
    version: pick(BUILD_INFO_ENV_KEYS.version),
  };
}

/**
 * 一行标识的**结构**(文案由页面经 t() 拼):有发版 tag ⇒ 以它为主、不是未发版;只有提交 ⇒ 提交短哈希 + 未发版;
 * 都没有 ⇒ `primary = null`(页面显示「构建信息不可用」)。手册里的升级 / 回滚 / 对账都按 tag,所以 tag 永远优先。
 */
export function buildLabelParts(info: BuildInfo): { primary: string | null; unreleased: boolean } {
  if (info.releaseTag) return { primary: info.releaseTag, unreleased: false };
  if (info.productCommit) return { primary: info.productCommit, unreleased: true };
  return { primary: null, unreleased: false };
}
