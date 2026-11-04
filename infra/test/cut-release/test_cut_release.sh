#!/usr/bin/env bash
# scripts/cut-release.sh(切版本 / 打 tag / 推送 / 建 GitHub Release)的离线真跑判据。
#
#     bash infra/test/cut-release/test_cut_release.sh      # 退出码 0 = 全过
#
# 🔴 为什么必须有它:切版本只在发版机上手工跑一次,跑错的后果是「tag 推了、Release 没建」「发版说明是空的」「版本号三处不一致」,
#   而这些在真仓库上没法反复排练。本判据在一个**合成 git 仓库**(带裸仓当 origin、硬门章 pass @ HEAD)里把脚本**真跑**一遍:
#   真改 VERSION / CHANGELOG、真提交、真打 tag、真推到裸仓、真调 package-release.sh 打包、再经 PATH 替身的假 gh 收到 release create 的
#   全部参数与正文。零凭证、不联网(curl 也是替身:只回 AWS Date 头)。钉的是**事实**(推到哪、正文是什么、附件 sha256 对不对、
#   拒绝路径一个都没改东西),不钉脚本写法。只用 bash / git / tar / gzip / sha256sum / python3 / awk。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CUT="$ROOT/scripts/cut-release.sh"
PKG="$ROOT/scripts/package-release.sh"
EXCL="$ROOT/scripts/package-release.exclude"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0; n=0
ok()  { n=$((n+1)); printf '  ✅ %s\n' "$1"; }
bad() { n=$((n+1)); printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1($3)"; else bad "$1:期望 [$2],实际 [$3]"; fi; }
has() { if grep -q -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1 —— 输出里没有「$2」:$(tail -c 400 "$3" 2>/dev/null | tr '\n' ' ')"; fi; }
lacks() { if grep -q -- "$2" "$3" 2>/dev/null; then bad "$1 —— 输出里不该有「$2」"; else ok "$1"; fi; }

# 隔离本机 git 配置(签名 / 钩子 / 模板都不许影响合成仓库);打包器的临时目录也收进 TMP
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 TMPDIR="$TMP/tmpdir"; mkdir -p "$TMPDIR"

[ -x "$CUT" ] || bad "脚本不可执行:$CUT(chmod +x)"
bash -n "$CUT" && ok "bash -n 语法通过" || bad "bash -n 语法错误"

# ── PATH 替身:curl 只回 AWS Date 头;gh 按环境变量演三态并把 release create 的参数 / 正文落盘 ─────────────────────
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/curl" <<'SH'
#!/usr/bin/env bash
printf 'HTTP/1.1 200 OK\r\nDate: Wed, 04 Nov 2026 12:00:00 GMT\r\n\r\n'
SH
cat > "$SHIM/gh" <<'SH'
#!/usr/bin/env bash
# 替身 gh:FAKE_GH_UNAUTH=1 ⇒ 未登录;FAKE_GH_EXISTING=1 ⇒ Release 已存在;FAKE_GH_CREATE_FAIL=1 ⇒ 建 Release 失败
LOG="${FAKE_GH_LOG:?FAKE_GH_LOG 未设}"
case "$1 ${2:-}" in
  "--version ")     echo "gh version 9.9.9 (2026-01-01)";;
  "auth status")    if [ "${FAKE_GH_UNAUTH:-0}" = 1 ]; then echo "You are not logged into any GitHub hosts." >&2; exit 1; fi; echo "Logged in"; exit 0;;
  "release view")   if [ "${FAKE_GH_EXISTING:-0}" = 1 ]; then echo "$3 exists"; exit 0; fi; echo "release not found" >&2; exit 1;;
  "release create") if [ "${FAKE_GH_CREATE_FAIL:-0}" = 1 ]; then echo "HTTP 422: Validation Failed" >&2; exit 1; fi
                    TAG="$3"; printf '%s\n' "$@" > "$LOG"
                    while [ $# -gt 0 ]; do if [ "$1" = "--notes-file" ]; then cp "$2" "$LOG.notes"; shift 2; else shift; fi; done
                    echo "https://github.com/example/kingfisher/releases/tag/$TAG";;
  *)                echo "fake gh: unexpected arguments: $*" >&2; exit 97;;
esac
SH
chmod +x "$SHIM/curl" "$SHIM/gh"
# 「没装 gh」的 PATH:只有 dirname(脚本在 ⓪ 之前只用到它),其余全是 bash 内建
NOGH="$TMP/nogh"; mkdir -p "$NOGH"; ln -s "$(command -v dirname)" "$NOGH/dirname"

# ── 合成仓库:工作仓(main)+ 裸仓 origin;VERSION 0.1.0;CHANGELOG 有两条 Unreleased + 一段旧版;产品骨架;硬门章 pass @ HEAD ──
mk_fixture() { # $1 = 容器目录 [$2 = CHANGELOG 变体:empty-unreleased]
  local D="$1" W="$1/work" B="$1/origin.git"
  mkdir -p "$W" && git init -q --bare "$B" || return 1
  (
    cd "$W" && git init -q && git checkout -q -b main && git config user.email t@example.invalid && git config user.name t \
    && mkdir -p platform/src infra/bin scripts .claude docs \
    && printf '0.1.0\n' > VERSION
    if [ "${2:-}" = "empty-unreleased" ]; then
      printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n- Older entry.\n' > CHANGELOG.md
    else
      cat > CHANGELOG.md <<'CL'
# Changelog

Intro paragraph that stays above the sections.

## [Unreleased]

### Added

- Thing one: a release-notes line that must appear verbatim.
- Thing two with `code` and a [link](docs/x.md).

### Fixed

- Thing three.

## [0.1.0] - 2026-01-01

- Older entry that must not leak into the new release body.
CL
    fi
    echo '{"name":"fixture"}' > platform/package.json && echo '// app' > infra/bin/app.ts && echo 'export const a = 1;' > platform/src/a.ts \
    && echo '# docs' > docs/README.md && echo 'MIT-0' > LICENSE \
    && cp "$CUT" "$PKG" scripts/ && cp "$EXCL" scripts/package-release.exclude && chmod +x scripts/*.sh \
    && printf '.claude/mr-gate-stamp.json\ndist/\n' > .gitignore \
    && git add -A && git commit -q -m "init" && git remote add origin "$B" && git push -q -u origin main \
    && printf '{"result":"pass","sha":"%s","at":"2026-11-04T00:00:00Z"}\n' "$(git rev-parse HEAD)" > .claude/mr-gate-stamp.json
  ) >/dev/null 2>&1
}
# 在合成仓库里跑脚本:$1 = 工作仓 $2 = 日志 其余 = 脚本参数;PATH 前置替身;FAKE_GH_LOG 指到日志旁
run_cut() { local W="$1" LOG="$2"; shift 2; ( cd "$W" && PATH="$SHIM:$PATH" FAKE_GH_LOG="$LOG.gh" bash scripts/cut-release.sh "$@" ) >"$LOG" 2>&1; }
unchanged() { # $1 = 说明前缀 $2 = 工作仓 $3 = 裸仓:VERSION 仍 0.1.0、没 tag、没 release 分支、远端 main 没动
  local W="$2" B="$3"
  chk "$1 VERSION 没动" "0.1.0" "$(tr -d '\n' < "$W/VERSION")"
  chk "$1 本地没有任何 tag" "" "$(git -C "$W" tag | tr '\n' ' ')"
  chk "$1 远端没有任何 tag" "" "$(git -C "$B" tag | tr '\n' ' ')"
  chk "$1 远端只有 main 分支" "main" "$(git -C "$B" for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' ' | sed 's/ $//')"
}

echo "== ① 用法:版本号必填且形如 x.y.z;未知参数拒;--assets-dir 只跟 --github-release =="
F1="$TMP/f1"; mk_fixture "$F1" || bad "① 合成仓库建不出来"
W1="$F1/work"; B1="$F1/origin.git"
run_cut "$W1" "$TMP/u1.log"; rc=$?; [ "$rc" != 0 ] && ok "① 漏传版本号 ⇒ 拒($rc)" || bad "① 漏传版本号居然退 0"; has "① 漏传版本号的报错给出用法" "用法:bash scripts/cut-release.sh" "$TMP/u1.log"
run_cut "$W1" "$TMP/u2.log" 1.2; rc=$?; [ "$rc" != 0 ] && ok "① 版本号 1.2 不是 x.y.z ⇒ 拒" || bad "① 版本号 1.2 居然过了"
run_cut "$W1" "$TMP/u3.log" 0.2.0 --bogus; rc=$?; [ "$rc" != 0 ] && ok "① 未知参数 ⇒ 拒" || bad "① 未知参数居然过了"; has "① 未知参数被点名" "未知参数:--bogus" "$TMP/u3.log"
run_cut "$W1" "$TMP/u4.log" 0.2.0 --assets-dir "$TMP/x"; rc=$?; [ "$rc" != 0 ] && ok "① --assets-dir 没带 --github-release ⇒ 拒" || bad "① 孤立 --assets-dir 居然过了"
run_cut "$W1" "$TMP/u5.log" 0.2.0 0.3.0; rc=$?; [ "$rc" != 0 ] && ok "① 两个版本号 ⇒ 拒" || bad "① 两个版本号居然过了"
unchanged "①" "$W1" "$B1"

echo "== ② --github-release 的工具前置:没装 gh / gh 未登录 / GitHub 已有同名 Release ⇒ 开跑前就拒,什么都不改 =="
BASH_BIN="$(command -v bash)"
( cd "$W1" && PATH="$NOGH" "$BASH_BIN" scripts/cut-release.sh 0.2.0 --github-release ) >"$TMP/g1.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "② 没装 gh ⇒ 拒($rc)" || bad "② 没装 gh 居然退 0"; has "② 没装 gh 的报错点名 gh" "需要 GitHub CLI gh" "$TMP/g1.log"
( cd "$W1" && PATH="$SHIM:$PATH" FAKE_GH_LOG="$TMP/g2.gh" FAKE_GH_UNAUTH=1 bash scripts/cut-release.sh 0.2.0 --github-release ) >"$TMP/g2.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "② gh 未登录 ⇒ 拒" || bad "② gh 未登录居然退 0"; has "② gh 未登录的报错指路 gh auth login" "gh auth login" "$TMP/g2.log"
( cd "$W1" && PATH="$SHIM:$PATH" FAKE_GH_LOG="$TMP/g3.gh" FAKE_GH_EXISTING=1 bash scripts/cut-release.sh 0.2.0 --github-release ) >"$TMP/g3.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "② GitHub 已有 Release v0.2.0 ⇒ 拒" || bad "② 已有 Release 居然退 0"; has "② 已有 Release 的报错点名版本" "已有 Release v0.2.0" "$TMP/g3.log"
[ ! -e "$TMP/g3.gh" ] && ok "② 拒绝路径上 gh release create 一次都没被调" || bad "② 拒绝路径上居然调了 release create"
unchanged "②" "$W1" "$B1"

echo "== ③ 演练(不带 --yes):打印计划、退 0、什么都不改 =="
run_cut "$W1" "$TMP/d1.log" 0.2.0; rc=$?; chk "③ 演练退出码" "0" "$rc"
has "③ 演练打印 VERSION 0.1.0 → 0.2.0" "0.1.0 → 0.2.0" "$TMP/d1.log"
has "③ 演练打印发版日期(来自 Date 头,不是本机时钟)" "发版日期(AWS)= 2026-11-04" "$TMP/d1.log"
has "③ 演练说明不建 Release" "GitHub Release    不建" "$TMP/d1.log"
has "③ 演练结束语" "演练结束,没有改任何东西" "$TMP/d1.log"
run_cut "$W1" "$TMP/d2.log" 0.2.0 --github-release --assets-dir "$TMP/assets-dry"; rc=$?; chk "③ 带 --github-release 的演练退出码" "0" "$rc"
has "③ 演练列出交付包文件名" "kingfisher-v0.2.0.tar.gz + .sha256" "$TMP/d2.log"
has "③ 演练列出 gh release create v0.2.0" "gh release create v0.2.0" "$TMP/d2.log"
[ ! -e "$TMP/d2.log.gh" ] && ok "③ 演练没调 gh release create" || bad "③ 演练居然调了 release create"
[ ! -e "$TMP/assets-dry" ] && ok "③ 演练不建附件目录" || bad "③ 演练建了附件目录"
unchanged "③" "$W1" "$B1"

echo "== ④ 真切 + GitHub Release:VERSION / CHANGELOG / 提交 / 分支 / tag / 推送 / 交付包 / Release 参数与正文 =="
HEAD0="$(git -C "$W1" rev-parse HEAD)"
run_cut "$W1" "$TMP/r1.log" 0.2.0 --yes --github-release --assets-dir "$TMP/assets"; rc=$?; chk "④ 真切退出码" "0" "$rc"
[ "$rc" = 0 ] || { echo "---- 脚本输出 ----"; cat "$TMP/r1.log"; }
chk "④ VERSION" "0.2.0" "$(tr -d '\n' < "$W1/VERSION")"
has "④ CHANGELOG 新标题 ## [0.2.0] - 2026-11-04" "## \[0.2.0\] - 2026-11-04" "$W1/CHANGELOG.md"
chk "④ CHANGELOG 新开的 [Unreleased] 段为空" "0" "$(awk '/^## \[Unreleased\]/{f=1;next} f&&/^## \[/{exit} f&&NF{n++} END{print n+0}' "$W1/CHANGELOG.md")"
chk "④ CHANGELOG 里 [Unreleased] 在 [0.2.0] 之上" "yes" "$(awk '/^## \[Unreleased\]/{u=NR} /^## \[0.2.0\]/{v=NR} END{print (u&&v&&u<v)?"yes":"no"}' "$W1/CHANGELOG.md")"
chk "④ 原 Unreleased 的内容现在归到 [0.2.0] 段" "3" "$(awk '/^## \[0.2.0\]/{f=1;next} f&&/^## \[/{exit} f&&/^- Thing/{n++} END{print n+0}' "$W1/CHANGELOG.md")"
chk "④ 只有一笔新提交,且在 main 上" "main" "$(git -C "$W1" rev-parse --abbrev-ref HEAD)"
chk "④ 新提交的父 = 切版本前的 HEAD" "$HEAD0" "$(git -C "$W1" rev-parse HEAD^)"
git -C "$W1" log -1 --format=%s | grep -q '^chore(release): VERSION 0.2.0 + CHANGELOG \[0.2.0\] - 2026-11-04' && ok "④ 提交信息 chore(release): VERSION 0.2.0 + CHANGELOG [0.2.0] - 2026-11-04" || bad "④ 提交信息不对:$(git -C "$W1" log -1 --format=%s)"
chk "④ 提交只改 VERSION 与 CHANGELOG" "CHANGELOG.md VERSION" "$(git -C "$W1" show --name-only --format= HEAD | sort | tr '\n' ' ' | sed 's/ $//')"
HEAD1="$(git -C "$W1" rev-parse HEAD)"
chk "④ tag v0.2.0 是注解 tag" "tag" "$(git -C "$W1" cat-file -t v0.2.0 2>/dev/null)"
chk "④ tag v0.2.0 指向新提交" "$HEAD1" "$(git -C "$W1" rev-parse 'v0.2.0^{commit}' 2>/dev/null)"
chk "④ 分支 release/0.2.0 = 新提交" "$HEAD1" "$(git -C "$W1" rev-parse release/0.2.0 2>/dev/null)"
chk "④ 远端 main 已推到新提交" "$HEAD1" "$(git -C "$B1" rev-parse main 2>/dev/null)"
chk "④ 远端 release/0.2.0 已推" "$HEAD1" "$(git -C "$B1" rev-parse release/0.2.0 2>/dev/null)"
chk "④ 远端 tag v0.2.0 已推且指向新提交" "$HEAD1" "$(git -C "$B1" rev-parse 'v0.2.0^{commit}' 2>/dev/null)"
AR="$TMP/assets/kingfisher-v0.2.0.tar.gz"
[ -s "$AR" ] && ok "④ 交付包存在:kingfisher-v0.2.0.tar.gz" || bad "④ 交付包不存在:$AR"
[ -s "$AR.sha256" ] && ok "④ .sha256 存在" || bad "④ .sha256 不存在"
( cd "$TMP/assets" && sha256sum -c --quiet kingfisher-v0.2.0.tar.gz.sha256 >/dev/null 2>&1 ) && ok "④ sha256sum -c 核验通过" || bad "④ sha256sum -c 核验失败"
SHA="$(cut -d' ' -f1 "$AR.sha256" 2>/dev/null)"
X="$TMP/x"; mkdir -p "$X"; tar -xzf "$AR" -C "$X" 2>/dev/null && ok "④ 交付包可解" || bad "④ 交付包解不开"
chk "④ 交付包里的 VERSION = 0.2.0(取自 tag,不是旧工作树)" "0.2.0" "$(tr -d '\n' < "$X/kingfisher-v0.2.0/VERSION" 2>/dev/null)"
chk "④ 交付包 BUILD-INFO.json 记着 tag v0.2.0" "v0.2.0" "$(python3 -I -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["tags"]))' "$X/kingfisher-v0.2.0/BUILD-INFO.json" 2>/dev/null)"
[ ! -e "$X/kingfisher-v0.2.0/scripts/cut-release.sh" ] && ok "④ 交付包不含切版本脚本自身" || bad "④ 交付包里混进了 cut-release.sh"
GH="$TMP/r1.log.gh"
[ -s "$GH" ] && ok "④ gh release create 被调了一次" || bad "④ gh release create 没被调"
chk "④ gh 参数:子命令 + tag" "release create v0.2.0" "$(sed -n '1,3p' "$GH" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
grep -qx -- "$AR" "$GH" && ok "④ gh 参数:附件 tar.gz" || bad "④ gh 参数里没有 tar.gz 附件"
grep -qx -- "$AR.sha256" "$GH" && ok "④ gh 参数:附件 .sha256" || bad "④ gh 参数里没有 .sha256 附件"
chk "④ gh 参数:--title" "Kingfisher v0.2.0" "$(awk '$0=="--title"{getline;print}' "$GH" 2>/dev/null)"
grep -qx -- "--verify-tag" "$GH" && ok "④ gh 参数:--verify-tag(tag 必须已在远端)" || bad "④ gh 参数缺 --verify-tag"
NOTES="$GH.notes"
[ -s "$NOTES" ] && ok "④ 正文文件已交给 gh(--notes-file)" || bad "④ 没有 --notes-file 正文"
chk "④ 正文第一行 = CHANGELOG 段首行(不含 ## [0.2.0] 标题行)" "### Added" "$(head -1 "$NOTES" 2>/dev/null)"
has "④ 正文含 Unreleased 第一条(逐字)" "- Thing one: a release-notes line that must appear verbatim." "$NOTES"
has "④ 正文含第二条(含反引号与链接,逐字)" '- Thing two with `code` and a \[link\](docs/x.md).' "$NOTES"
has "④ 正文含 Fixed 段" "- Thing three." "$NOTES"
lacks "④ 正文不含旧版条目" "Older entry" "$NOTES"
lacks "④ 正文不含 [Unreleased] 标题" "\[Unreleased\]" "$NOTES"
lacks "④ 正文不含 ## [0.2.0] 标题行" "## \[0.2.0\]" "$NOTES"
lacks "④ 正文不含 CHANGELOG 文首段" "Intro paragraph" "$NOTES"
has "④ 正文带交付包 sha256 表(文件名)" '| `kingfisher-v0.2.0.tar.gz` |' "$NOTES"
has "④ 正文里的 sha256 = .sha256 文件里的值" "$SHA" "$NOTES"
has "④ 正文给出核验命令" "sha256sum -c kingfisher-v0.2.0.tar.gz.sha256" "$NOTES"
[ -s "$TMP/assets/kingfisher-v0.2.0.release-notes.md" ] && ok "④ 正文另存在附件目录(供重试)" || bad "④ 附件目录里没有 release-notes.md"
cmp -s "$TMP/assets/kingfisher-v0.2.0.release-notes.md" "$NOTES" && ok "④ 另存的正文与交给 gh 的逐字相同" || bad "④ 另存的正文与交给 gh 的不同"
has "④ 屏幕打印 Release URL" "Release 已建:https://github.com/example/kingfisher/releases/tag/v0.2.0" "$TMP/r1.log"
run_cut "$W1" "$TMP/r1b.log" 0.2.0 --yes --github-release --assets-dir "$TMP/assets"; rc=$?
[ "$rc" != 0 ] && ok "④ 同一版本再切一次 ⇒ 拒(VERSION 已是 / tag 已存在)" || bad "④ 同一版本居然切了两次"
[ ! -e "$TMP/r1b.log.gh" ] && ok "④ 第二次没调 gh release create" || bad "④ 第二次居然又建了 Release"

echo "== ⑤ 不带 --github-release 的真切:只推 tag,不打包、不碰 gh =="
F5="$TMP/f5"; mk_fixture "$F5" || bad "⑤ 合成仓库建不出来"; W5="$F5/work"; B5="$F5/origin.git"
run_cut "$W5" "$TMP/r5.log" 0.2.0 --yes; rc=$?; chk "⑤ 退出码" "0" "$rc"
chk "⑤ 远端 tag v0.2.0 已推" "$(git -C "$W5" rev-parse HEAD)" "$(git -C "$B5" rev-parse 'v0.2.0^{commit}' 2>/dev/null)"
[ ! -e "$TMP/r5.log.gh" ] && ok "⑤ 没调 gh" || bad "⑤ 不该调 gh 却调了"
[ ! -e "$W5/dist" ] && ok "⑤ 没打交付包(dist/ 不存在)" || bad "⑤ 不该打包却打了"
lacks "⑤ 完成语不提附件目录" "或交付" "$TMP/r5.log"

echo "== ⑥ 推送之后建 Release 失败 ⇒ 退非零、如实说 tag 已推、给出可直接重试的命令 =="
F6="$TMP/f6"; mk_fixture "$F6" || bad "⑥ 合成仓库建不出来"; W6="$F6/work"; B6="$F6/origin.git"
( cd "$W6" && PATH="$SHIM:$PATH" FAKE_GH_LOG="$TMP/r6.gh" FAKE_GH_CREATE_FAIL=1 bash scripts/cut-release.sh 0.3.0 --yes --github-release --assets-dir "$TMP/assets6" ) >"$TMP/r6.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "⑥ Release 失败 ⇒ 退非零($rc)" || bad "⑥ Release 失败居然退 0"
has "⑥ 如实报告 tag 已推、Release 未建" "tag v0.3.0 已推" "$TMP/r6.log"
has "⑥ 给出重试命令 gh release create v0.3.0" "gh release create v0.3.0" "$TMP/r6.log"
has "⑥ 重试命令带 --verify-tag" "\-\-verify-tag" "$TMP/r6.log"
chk "⑥ 远端 tag v0.3.0 确实已推(状态与报告一致)" "$(git -C "$W6" rev-parse HEAD)" "$(git -C "$B6" rev-parse 'v0.3.0^{commit}' 2>/dev/null)"
[ -s "$TMP/assets6/kingfisher-v0.3.0.tar.gz" ] && ok "⑥ 附件留在附件目录供重试" || bad "⑥ 附件不在"
[ -s "$TMP/assets6/kingfisher-v0.3.0.release-notes.md" ] && ok "⑥ 正文留在附件目录供重试" || bad "⑥ 正文不在"

echo "== ⑦ 硬门拒绝:章 fail / 章后产品字节有差 / 不在 main / 工作树脏 / 本地落后远端 / Unreleased 为空 ⇒ 一律拒且不改 =="
F7="$TMP/f7"; mk_fixture "$F7" || bad "⑦ 合成仓库建不出来"; W7="$F7/work"; B7="$F7/origin.git"
cp "$W7/.claude/mr-gate-stamp.json" "$TMP/stamp.bak"
sed -i 's/"result":"pass"/"result":"fail"/' "$W7/.claude/mr-gate-stamp.json"
run_cut "$W7" "$TMP/h1.log" 0.2.0 --yes; rc=$?; [ "$rc" != 0 ] && ok "⑦ 章 result=fail ⇒ 拒" || bad "⑦ 章 fail 居然切了"; has "⑦ 章 fail 的报错" "不是 pass" "$TMP/h1.log"
cp "$TMP/stamp.bak" "$W7/.claude/mr-gate-stamp.json"
rm -f "$W7/.claude/mr-gate-stamp.json.tmp"
( cd "$W7" && echo 'export const a = 2;' > platform/src/a.ts && git commit -qam "feat: product change after stamp" && git push -q origin main ) >/dev/null 2>&1
run_cut "$W7" "$TMP/h2.log" 0.2.0 --yes; rc=$?; [ "$rc" != 0 ] && ok "⑦ 章后产品字节有差 ⇒ 拒" || bad "⑦ 章后产品字节有差居然切了"; has "⑦ 产品字节有差的报错" "产品字节与硬门章提交" "$TMP/h2.log"
( cd "$W7" && printf '{"result":"pass","sha":"%s","at":"2026-11-04T00:00:00Z"}\n' "$(git rev-parse HEAD)" > .claude/mr-gate-stamp.json \
  && echo '# docs after stamp' >> docs/README.md && git commit -qam "docs: after stamp" && git push -q origin main ) >/dev/null 2>&1
run_cut "$W7" "$TMP/h3.log" 0.2.0; rc=$?; chk "⑦ 章后只有 docs 笔 ⇒ 允许(演练退 0)" "0" "$rc"
( cd "$W7" && git checkout -q -b feat/x ) >/dev/null 2>&1
run_cut "$W7" "$TMP/h4.log" 0.2.0; rc=$?; [ "$rc" != 0 ] && ok "⑦ 不在 main ⇒ 拒" || bad "⑦ 不在 main 居然过了"; has "⑦ 不在 main 的报错" "必须在 main 上切版本" "$TMP/h4.log"
( cd "$W7" && git checkout -q main && echo dirty > platform/src/dirty.ts ) >/dev/null 2>&1
run_cut "$W7" "$TMP/h5.log" 0.2.0; rc=$?; [ "$rc" != 0 ] && ok "⑦ 工作树脏 ⇒ 拒" || bad "⑦ 工作树脏居然过了"; has "⑦ 工作树脏的报错" "工作树不干净" "$TMP/h5.log"
( cd "$W7" && rm -f platform/src/dirty.ts && echo '# more' >> docs/README.md && git commit -qam "docs: unpushed" ) >/dev/null 2>&1
run_cut "$W7" "$TMP/h6.log" 0.2.0; rc=$?; [ "$rc" != 0 ] && ok "⑦ 本地 main 领先 origin ⇒ 拒" || bad "⑦ 本地领先居然过了"; has "⑦ 本地领先的报错" "与 origin/main 不一致" "$TMP/h6.log"
unchanged "⑦" "$W7" "$B7"
F8="$TMP/f8"; mk_fixture "$F8" empty-unreleased || bad "⑦ 空 Unreleased 合成仓库建不出来"; W8="$F8/work"; B8="$F8/origin.git"
run_cut "$W8" "$TMP/h7.log" 0.2.0 --yes; rc=$?; [ "$rc" != 0 ] && ok "⑦ [Unreleased] 段为空 ⇒ 拒(没有发版说明)" || bad "⑦ 空 Unreleased 居然切了"; has "⑦ 空 Unreleased 的报错" "\[Unreleased\] 段是空的" "$TMP/h7.log"
unchanged "⑦ 空 Unreleased" "$W8" "$B8"

echo
if [ "$fails" = 0 ]; then
  echo "✅ cut-release 离线判据全过($n 条)"
  exit 0
else
  echo "❌ cut-release 离线判据失败 $fails / $n 条"
  exit 1
fi
