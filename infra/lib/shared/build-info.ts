// @kf-batch 39-release-visibility —— 发版号进镜像(序 39 第二刀;两轮冷启动演练都把「现网发版号不可读」列为新手第一缺口)
//
// **唯一作者**:平台镜像 docker build-arg 的键名与取值。容器里是同名环境变量(Dockerfile runner 段 ARG → ENV),
// 平台运行时由 `platform/src/lib/build-info.ts#BUILD_INFO_ENV_KEYS` 读回 —— 两侧键名必须逐字相同,跨包无法 import,
// 由 platform 侧守卫判据 `lib/__tests__/build-info.test.ts` 钉住(连 Dockerfile 的 ARG / ENV 一起钉)。
//
// 取值全部来自 **git 事实**(部署机必须是 git clone;AGENTS §1 本来就禁无 .git 的 ZIP):
//   · releaseTag      = 指向 HEAD 的发版 tag:**`v<主>.<次>.<补丁>`**(2026-11-01 用户拍板,2.2.0 起唯一命名;多个 ⇒ 语义版本最高的那个)
//                       ⇒ 没有 v tag 才回落到历史命名 `release-*`(多个 ⇒ 字典序最后一个 = 最新的紧急修复 tag);都没有 ⇒ ""(未发版构建)。
//                       选取规则是纯函数 `pickReleaseTag`(离线判据 infra/test/build-info 真跑);glob 清单 `RELEASE_TAG_GLOBS` 唯一作者。
//   · productCommit   = 最后一笔改了**产品字节**(platform / infra / scripts,AGENTS §1 口径)的提交短哈希。
//                       文档提交不改它 ⇒ docs 笔不会让镜像重建(CDK 把 buildArgs 算进资产哈希);产品字节变了本来就要重建。
//                       🔴 刻意**不带分支名**:同一产品字节在不同分支 / 变基前后应尽量是同一个镜像,分支名只会白白触发重建。
//   · productCommitAt = 该提交的提交时间(ISO 8601)
//   · version         = 仓库根 `VERSION` 文件内容
// 不是 git 克隆时(客户部署机解开 `scripts/package-release.sh` 打出的产品包)⇒ 读包根的 `BUILD-INFO.json`
//   (打包器从被打包的提交写入:指向该提交的全部 tag、产品字节最后一笔提交短哈希 / 时间、VERSION);
//   选 tag 的规则仍在本文件(`pickReleaseTag` + `RELEASE_TAG_GLOBS` 过滤),文件只提供原始事实,不替平台做判断。
// git 事实与包事实都取不到 ⇒ 对应值 ""、stderr 一句警告;**不抛**(不能让 synth 因版本标签失败),
// 页面侧把空值如实显示为「构建信息不可用」,不编一个。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const BUILD_ARG_KEYS = {
  releaseTag: "BGP_BUILD_RELEASE_TAG",
  productCommit: "BGP_BUILD_PRODUCT_COMMIT",
  productCommitAt: "BGP_BUILD_PRODUCT_COMMIT_AT",
  version: "BGP_BUILD_VERSION",
} as const;

/** 发版 tag 的两种命名(git tag --list 的 glob):`v<semver>`(2.2.0 起唯一命名)与历史 `release-<日期>[-热修]`。 */
export const RELEASE_TAG_GLOBS: readonly string[] = ["v[0-9]*", "release-*"];
const STRICT_SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * 从指向 HEAD 的候选 tag 里选发版 tag:严格 `v主.次.补丁` 优先、按数值比较取最高(v2.1.10 > v2.1.2);
 * 没有严格 v tag ⇒ 其余候选(历史 `release-*`、`v1.44.1-stable` 这类非严格名)取字典序最后一个;空 ⇒ ""。
 */
export function pickReleaseTag(tags: readonly string[]): string {
  const strict = tags.filter((t) => STRICT_SEMVER_TAG.test(t));
  if (strict.length) {
    const key = (t: string) => (t.match(STRICT_SEMVER_TAG) as RegExpMatchArray).slice(1, 4).map(Number);
    return [...strict].sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    }).pop() as string;
  }
  const rest = tags.filter((t) => t.trim()).sort();
  return rest.pop() ?? "";
}

/** 产品字节的目录(与 AGENTS §1「产品字节」口径一致:docs 与根目录 *.md 不算)。 */
export const PRODUCT_DIRS: readonly string[] = ["platform", "infra", "scripts"];

/** 产品包里的构建事实文件(包根;由 `scripts/package-release.sh` 写入,git 克隆里不存在且被 .gitignore)。 */
export const BUILD_FACTS_FILE = "BUILD-INFO.json";

/** `git tag --list <glob>` 的 glob 转正则(只认 `*` 与 `[...]` 字符类,其余按字面;与 RELEASE_TAG_GLOBS 同一作者)。 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** 从产品包的 BUILD-INFO.json 读原始事实;文件缺失 / 不是 JSON / 形态不对 ⇒ null(调用方如实留空)。 */
function readPackagedFacts(repoRoot: string): BuildFacts | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(repoRoot, BUILD_FACTS_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string") : null;
  const productCommit = typeof o.productCommit === "string" && /^[0-9a-f]{7,40}$/.test(o.productCommit) ? o.productCommit : null;
  const productCommitAt =
    typeof o.productCommitAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(o.productCommitAt) ? o.productCommitAt : null;
  const version = typeof o.version === "string" ? o.version.trim() : "";
  if (!tags || !productCommit || !productCommitAt) return null;
  const globs = RELEASE_TAG_GLOBS.map(globToRegExp);
  const releaseTag = pickReleaseTag(tags.filter((t) => globs.some((g) => g.test(t))));
  return { releaseTag, productCommit, productCommitAt, version };
}

/** 仓库根(本文件在 infra/lib/shared/)。 */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export interface BuildFacts {
  releaseTag: string;
  productCommit: string;
  productCommitAt: string;
  version: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function collectBuildFacts(repoRoot: string = REPO_ROOT): BuildFacts {
  const tags = git(["tag", "--points-at", "HEAD", "--list", ...RELEASE_TAG_GLOBS], repoRoot);
  const releaseTag = pickReleaseTag(tags ? tags.split("\n").filter(Boolean) : []);
  const productCommit = git(["log", "-1", "--format=%h", "--", ...PRODUCT_DIRS], repoRoot) ?? "";
  const productCommitAt = git(["log", "-1", "--format=%cI", "--", ...PRODUCT_DIRS], repoRoot) ?? "";
  let version = "";
  try {
    version = readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim();
  } catch {
    // 如实留空
  }
  if (!productCommit) {
    const packaged = readPackagedFacts(repoRoot);
    if (packaged) {
      process.stderr.write(`[build-info] 在 ${repoRoot} 读不到 git 事实,改读产品包的 ${BUILD_FACTS_FILE}\n`);
      return { ...packaged, version: version || packaged.version };
    }
    process.stderr.write(
      `[build-info] 在 ${repoRoot} 读不到 git 事实(不是 git 克隆或没装 git),也没有 ${BUILD_FACTS_FILE} ⇒ 镜像构建信息留空,页面将显示「构建信息不可用」\n`
    );
  }
  return { releaseTag, productCommit, productCommitAt, version };
}

/** 平台镜像的 docker build-args(键 = 容器里的同名环境变量)。 */
export function platformImageBuildArgs(repoRoot: string = REPO_ROOT): Record<string, string> {
  const facts = collectBuildFacts(repoRoot);
  return {
    [BUILD_ARG_KEYS.releaseTag]: facts.releaseTag,
    [BUILD_ARG_KEYS.productCommit]: facts.productCommit,
    [BUILD_ARG_KEYS.productCommitAt]: facts.productCommitAt,
    [BUILD_ARG_KEYS.version]: facts.version,
  };
}
