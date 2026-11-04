#!/usr/bin/env bash
# 发版打包:从一个 git tag / ref 产出交付客户部署机的**干净产品包**(tar.gz + sha256)。
#
#     scripts/package-release.sh <tag-or-ref> [--out <dir>] [--verify] [--exclude-file <path>]
#
#     scripts/package-release.sh v2.2.0                      # ⇒ ./dist/kingfisher-v2.2.0.tar.gz(+ .sha256)
#     scripts/package-release.sh v2.2.0 --out /tmp/kf-out    # 指定输出目录
#     scripts/package-release.sh v2.2.0 --verify             # 打包后在解出的副本上真跑 npm ci / tsc / next build(慢、要联网)
#
# 【目的】
#   工程仓库(GitHub)是**唯一事实源**:单测、验收编排、硬门、CI、AI 工具配置、缺陷台账与排期都留在仓库里继续演进;
#   客户部署机拿到的只是它在某个 tag 上的**投影** —— 产品源码、CDK、部署 / 运维脚本、面向客户的文档。
#   以前交付靠手工挑文件打 zip,挑漏 / 挑错 / 带进测试与内部文档都发生过;本脚本把「挑什么、不挑什么」写成
#   清单(`scripts/package-release.exclude`)并机械执行,产物可复算、可核验。
#
# 【怎么做】
#   1. 只从 `git archive <ref>` 取字节(**绝不**读工作树,未提交的改动不可能混进包;ref 解析不出来 / 不在 git 仓库里一律拒跑);
#   2. 在临时目录里按 `scripts/package-release.exclude` 剔除(一行一个 git pathspec 风格的 glob,`#` 为注释,
#      `**` 跨目录,匹配到目录即整棵删;剔完顺手清掉空目录 —— git 本来也不跟踪空目录);
#   3. 写出 `<out>/kingfisher-<ref>.tar.gz` 与同名 `.sha256`(`sha256sum -c` 可直接核验),打印文件数与 sha256;
#      包根带 `BUILD-INFO.json`(被打包提交的 tag / 产品提交 / 版本),没有 .git 的部署机靠它显示发版号。
#
# 【剔除什么、为什么】(逐条理由见排除清单;这里只说类别)
#   · 单元测试与测试配置(`**/__tests__/**` / `**/*.test.ts` / vitest 配置 / `infra/test/**`):客户部署链(deploy-all /
#     redeploy-platform / CodeBuild)一条都不执行它们;`platform/tsconfig.json` 与 `next build` 已把它们排除在类型检查之外。
#   · 验收编排与无头浏览器判据(Showcase 造数、全区验收、页面向导加区、换账号重建、硬门入口、无头底座、夹具台账):
#     只在开发者自己的测试账号上跑,依赖不入库的 `qa-game/` 与 Playwright,客户环境不需要也不该跑。
#   · 工程仓库自身的配置(`.github` CI / `.githooks` / `.claude` / `.kiro` / 安全扫描器配置 / `.editorconfig`)与开发机专用工具。
#   · 内部工程文档(缺陷台账 / 排期 / 安全扫描定性 / 现网基线 / 技术深挖 / 设计索引与原则):内容面向开发团队,
#     含历史决策与测试账号细节;面向客户的手册、架构、模块总览、功能导览、成本模型、版本矩阵全部保留。
#   · 本脚本与排除清单自身(它们是工程侧的打包工具,不是产品)。
#   **保留**:`platform/`(含演示模式造数路由 —— 由部署模式在运行期门控,不是测试代码)、`infra/`、`scripts/` 的部署 / 运维 /
#   造数脚本、`flink-*`、`docs/` 面向客户文档、`README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` / `VERSION` / `LICENSE`。
#
# 【确定性】同一个 ref + 同一份排除清单 ⇒ **逐字节相同**的 tar.gz(sha256 相同):
#   `git archive` 的内容与文件模式只取自提交;tar 用 `--sort=name --mtime=@<提交时间> --owner=0 --group=0 --numeric-owner --format=gnu`
#   并在 `LC_ALL=C TZ=UTC` 下跑;目录 / 文件模式归一为 755 / 644(可执行位取自 git),不受本机 umask 影响;gzip 用 `-n` 不写文件名与时间戳。
#   离线判据 `infra/test/package-release/test_package_release.sh` 对同一 ref 打两次包比对 sha256。
#   ⇒ 客户拿到的 sha256 可以在任何一台有本仓库克隆的机器上重算核对。
#
# 【--verify】在解出的副本上执行
#     (cd platform && npm ci && npx tsc --noEmit -p tsconfig.json && npm run build)
#     (cd infra    && npm ci && npx tsc --noEmit)
#   证明「剔除之后仍能构建」(不跑测试 —— 测试已不在包里)。要联网装依赖、耗时数分钟,所以是可选项;离线判据不跑它。
#
# 【要求】GNU tar(需要 --sort / --mtime / --numeric-owner)、gzip、sha256sum、python3、git ≥ 2.x。不满足即拒跑,不退回别的写法。
# 【退出码】0 = 产物与 sha256 已写出(--verify 时还包含构建通过);任何一步失败即非零,临时目录由 trap 清理。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXCLUDE_DEFAULT="$HERE/package-release.exclude"

info() { printf '[package-release] %s\n' "$*"; }
die()  { printf '[package-release] ❌ %s\n' "$*" >&2; exit 1; }
usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── 参数 ────────────────────────────────────────────────────────────────────────
REF=""; OUT=""; VERIFY=0; EXCLUDE_FILE="$EXCLUDE_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0;;
    --out)          [ $# -ge 2 ] || die "--out 需要一个目录参数"; OUT="$2"; shift 2;;
    --verify)       VERIFY=1; shift;;
    --exclude-file) [ $# -ge 2 ] || die "--exclude-file 需要一个文件参数"; EXCLUDE_FILE="$2"; shift 2;;
    --*)            die "未知参数:$1(用 --help 看用法)";;
    *)              [ -z "$REF" ] || die "只接受一个 ref,多给了:$1"; REF="$1"; shift;;
  esac
done
[ -n "$REF" ] || { usage >&2; die "缺少 <tag-or-ref>"; }

# ── 前置:必须在 git 仓库里、ref 必须解析得出、工具必须齐 ────────────────────────
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$ROOT 不是 git 仓库(本脚本只从 git 对象打包,不接受无 .git 的目录)"
COMMIT="$(git -C "$ROOT" rev-parse --verify --quiet "${REF}^{commit}" 2>/dev/null || true)"
[ -n "$COMMIT" ] || die "ref 解析不出来:$REF(先 git fetch --tags;tag / 分支 / 提交哈希都可以)"
EPOCH="$(git -C "$ROOT" log -1 --format=%ct "$COMMIT")"
[ "$EPOCH" -gt 0 ] 2>/dev/null || die "读不到提交 $COMMIT 的时间戳"

for bin in tar gzip sha256sum python3; do command -v "$bin" >/dev/null 2>&1 || die "缺少命令 $bin"; done
tar --version 2>/dev/null | head -1 | grep -q 'GNU tar' || die "需要 GNU tar(--sort / --mtime / --numeric-owner);当前:$(tar --version | head -1)"
[ -f "$EXCLUDE_FILE" ] || die "排除清单不存在:$EXCLUDE_FILE(没有清单就不知道该剔什么,拒绝打一个「全量」包)"

# 文件名:ref 里的 `/` 换成 `-`(release/2.2.0 ⇒ release-2.2.0);其它字符只许 [A-Za-z0-9._-],不做静默改写
SAFE_REF="${REF//\//-}"
case "$SAFE_REF" in
  *[!A-Za-z0-9._-]*) die "ref 含不能进文件名的字符:$REF(只允许字母 / 数字 / . _ - 与 /)";;
esac
NAME="kingfisher-$SAFE_REF"

if [ -z "$OUT" ]; then OUT="$ROOT/dist"; fi
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT";; esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/kf-package-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/stage"; mkdir -p "$STAGE/$NAME"

info "ref=$REF  commit=$COMMIT  提交时间=$(date -u -d "@$EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
info "排除清单:$EXCLUDE_FILE"

# ── 1. git archive → 临时目录(-p:文件模式按 git 记录的 0644 / 0755 还原,不受 umask 影响)──
git -C "$ROOT" archive --format=tar "$COMMIT" | tar -x -p -C "$STAGE/$NAME"
TOTAL_BEFORE="$(find "$STAGE/$NAME" -type f | wc -l | tr -d ' ')"

# ── 1b. 构建事实文件 BUILD-INFO.json(包根):没有 .git 的部署机靠它显示发版号 / 产品提交
#   (读者 = infra/lib/shared/build-info.ts,git 事实缺失时回落读它;选 tag 的规则在读者那边,这里只写原始事实)。
#   全部取自被打包的提交,不含本机时间 ⇒ 不破坏确定性。产品字节目录与读者的 PRODUCT_DIRS 一致(平台侧守卫钉住)。
PRODUCT_COMMIT="$(git -C "$ROOT" log -1 --format=%h "$COMMIT" -- platform infra scripts)"
PRODUCT_COMMIT_AT="$(git -C "$ROOT" log -1 --format=%cI "$COMMIT" -- platform infra scripts)"
PKG_VERSION="$(git -C "$ROOT" show "$COMMIT:VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
#   tag 清单走参数而不是管道:python 的 stdin 已被 heredoc 占用,管道进去的字节会丢(tags 永远为空),而且 git 写向已关闭的管道会
#   撞 SIGPIPE(pipefail ⇒ 退 141)—— 恰好只在「被打包的提交上有 tag」时发生,也就是真发版那一次(2026-11-04 离线判据抓到)。
TAGS_AT="$(git -C "$ROOT" tag --points-at "$COMMIT" | tr '\n' ' ')"
python3 -I - "$STAGE/$NAME/BUILD-INFO.json" "$REF" "$COMMIT" "$PRODUCT_COMMIT" "$PRODUCT_COMMIT_AT" "$PKG_VERSION" "$TAGS_AT" <<'PY'
import json, sys
out, ref, commit, product_commit, product_commit_at, version, tags_at = sys.argv[1:8]
tags = sorted(t for t in tags_at.split() if t)
facts = {"ref": ref, "commit": commit, "tags": tags, "productCommit": product_commit,
         "productCommitAt": product_commit_at, "version": version}
with open(out, "w", encoding="utf-8") as f:
    json.dump(facts, f, ensure_ascii=False, indent=2, sort_keys=True)
    f.write("\n")
PY
info "BUILD-INFO.json:tags=[$TAGS_AT] productCommit=$PRODUCT_COMMIT version=$PKG_VERSION"

# ── 2. 按排除清单剔除(内嵌 python:pathspec 风格 glob → 正则;目录命中整棵删;逐条打印命中数)─
#   语义:模式锚定在包根;`*` / `?` 不跨 `/`;`**` 匹配任意多级目录(含零级);`X/**` 同时匹配目录 X 自身。
#   0 命中只提示不报错(老 tag 可能还没有那个文件),但清单文件为空 ⇒ 拒(等于没有清单)。
REMOVED="$(python3 -I - "$EXCLUDE_FILE" "$STAGE/$NAME" <<'PY'
import os, re, shutil, sys

exclude_file, root = sys.argv[1], sys.argv[2]

def to_regex(pattern: str) -> re.Pattern:
    parts = pattern.strip("/").split("/")
    out = "^"
    for i, seg in enumerate(parts):
        last = i == len(parts) - 1
        if seg == "**":
            out += ".*" if last else "(?:[^/]+/)*"
            continue
        for ch in seg:
            if ch == "*":
                out += "[^/]*"
            elif ch == "?":
                out += "[^/]"
            else:
                out += re.escape(ch)
        if not last:
            out += "/"
    return re.compile(out + "$")

patterns = []
with open(exclude_file, encoding="utf-8") as fh:
    for lineno, raw in enumerate(fh, 1):
        line = raw.split("#", 1)[0].strip() if not raw.lstrip().startswith("#") else ""
        if not line:
            continue
        if line.startswith("!"):
            sys.exit(f"排除清单第 {lineno} 行:不支持取反模式 {line!r}(清单只做剔除)")
        patterns.append((line, to_regex(line)))
if not patterns:
    sys.exit(f"排除清单 {exclude_file} 里没有任何模式(全是注释 / 空行)⇒ 拒绝打包")

hits = {p: 0 for p, _ in patterns}
removed = 0

def matches(rel: str, is_dir: bool):
    probe = rel + "/" if is_dir else rel
    for p, rx in patterns:
        if rx.match(rel) or (is_dir and rx.match(probe)):
            return p
    return None

for dirpath, dirnames, filenames in os.walk(root, topdown=True):
    rel_dir = os.path.relpath(dirpath, root)
    rel_dir = "" if rel_dir == "." else rel_dir
    keep = []
    for d in sorted(dirnames):
        rel = f"{rel_dir}/{d}" if rel_dir else d
        p = matches(rel, True)
        if p:
            n = sum(len(fs) for _, _, fs in os.walk(os.path.join(dirpath, d)))
            shutil.rmtree(os.path.join(dirpath, d))
            hits[p] += n
            removed += n
        else:
            keep.append(d)
    dirnames[:] = keep
    for f in sorted(filenames):
        rel = f"{rel_dir}/{f}" if rel_dir else f
        p = matches(rel, False)
        if p:
            os.remove(os.path.join(dirpath, f))
            hits[p] += 1
            removed += 1

# 剔完清掉空目录(自底向上;包根本身不动)
for dirpath, dirnames, filenames in os.walk(root, topdown=False):
    if dirpath != root and not os.listdir(dirpath):
        os.rmdir(dirpath)

for p, _ in patterns:
    flag = "  " if hits[p] else "  (0 命中)"
    print(f"  剔除 {hits[p]:5d}  {p}{flag}", file=sys.stderr)
print(removed)
PY
)"

# ── 3. 模式归一(目录 755;文件按 git 的可执行位 755 / 644)—— 让产物不受 umask / 文件系统影响 ──
find "$STAGE/$NAME" -type d -exec chmod 755 {} +
find "$STAGE/$NAME" -type f -perm -u+x -exec chmod 755 {} +
find "$STAGE/$NAME" -type f ! -perm -u+x -exec chmod 644 {} +

TOTAL_AFTER="$(find "$STAGE/$NAME" -type f | wc -l | tr -d ' ')"
[ "$TOTAL_AFTER" -gt 0 ] || die "剔除后一个文件都不剩(排除清单写错了?)"
[ -f "$STAGE/$NAME/platform/package.json" ] && [ -f "$STAGE/$NAME/infra/bin/app.ts" ] \
  || die "产品骨架不完整(platform/package.json 或 infra/bin/app.ts 不在)—— 排除清单剔多了,拒绝写出"

# ── 4. 确定性 tar.gz + sha256 ─────────────────────────────────────────────────────
mkdir -p "$OUT"
ARCHIVE="$OUT/$NAME.tar.gz"
( cd "$STAGE" && LC_ALL=C TZ=UTC tar \
    --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu \
    -cf - "$NAME" ) | gzip -n -9 > "$ARCHIVE"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
SHA="$(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"

info "git archive 文件数 $TOTAL_BEFORE,剔除 $REMOVED,入包文件数 $TOTAL_AFTER"
info "产物:$ARCHIVE($(du -h "$ARCHIVE" | cut -f1))"
info "sha256:$SHA  (核验:cd $OUT && sha256sum -c $NAME.tar.gz.sha256)"

# ── 5. 可选:在解出的副本上真构建(不跑测试;要联网)────────────────────────────────
if [ "$VERIFY" = 1 ]; then
  for bin in npm npx; do command -v "$bin" >/dev/null 2>&1 || die "--verify 需要 $bin"; done
  V="$TMP/verify"; mkdir -p "$V"
  tar -xzf "$ARCHIVE" -C "$V"
  # 先 next build 再 tsc(与 CI 顺序一致):tsconfig 的 include 带 .next/types/**(next build 生成、不入库),build 自带整项目类型检查,
  #   之后的 tsc 是对同一份代码的第二次独立确认。
  info "--verify:platform(npm ci → next build → tsc)"
  ( cd "$V/$NAME/platform" && npm ci --no-audit --no-fund && npm run build && npx tsc --noEmit -p tsconfig.json ) \
    || die "--verify:platform 构建失败(包里缺了构建需要的文件,或该 ref 本身不可构建)"
  info "--verify:infra(npm ci → tsc)"
  ( cd "$V/$NAME/infra" && npm ci --no-audit --no-fund && npx tsc --noEmit ) \
    || die "--verify:infra 类型检查失败"
  info "✅ --verify 通过:剔除后的产品包可构建"
fi
