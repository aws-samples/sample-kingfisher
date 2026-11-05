#!/usr/bin/env bash
# scripts/package-release.sh(发版产品包打包器)的离线真跑判据:对**本仓库的 HEAD** 真打包、真解包、真比对。
#
#     bash infra/test/package-release/test_package_release.sh      # 退出码 0 = 全过
#
# 🔴 为什么必须有它:交付物边界以前靠手挑文件,「测试 / 内部文档混进客户包」「部署脚本漏打」都真发生过;
#   本判据钉的是**事实**(解包后哪些路径不在、哪些必须在、两次打包 sha256 逐字节相同、坏 ref 必拒),不钉脚本写法。
#   不联网、不装依赖、不跑 --verify(那一段要 npm ci,属于发版机手工步骤);只用 bash / git / tar / gzip / sha256sum / python3。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PKG="$ROOT/scripts/package-release.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0; n=0
ok()  { n=$((n+1)); printf '  ✅ %s\n' "$1"; }
bad() { n=$((n+1)); printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }
chk() { # $1=说明 $2=期望 $3=实际
  if [ "$2" = "$3" ]; then ok "$1($3)"; else bad "$1:期望 [$2],实际 [$3]"; fi
}

[ -x "$PKG" ] || bad "脚本不可执行:$PKG(chmod +x)"
bash -n "$PKG" && ok "bash -n 语法通过" || bad "bash -n 语法错误"

# 打包器把临时目录建在 TMPDIR 下 ⇒ 给它一个专用 TMPDIR,事后断言被 trap 清空
export TMPDIR="$TMP/tmpdir"; mkdir -p "$TMPDIR"

echo "== ① 对 HEAD 打包:产物 / sha256 / 打印的文件数 =="
OUT1="$TMP/out1"
LOG1="$TMP/run1.log"
"$PKG" HEAD --out "$OUT1" >"$LOG1" 2>&1; rc=$?
chk "① 打包 HEAD 退出码" "0" "$rc"
[ "$rc" = 0 ] || { echo "---- 打包输出 ----"; cat "$LOG1"; }
AR="$OUT1/kingfisher-HEAD.tar.gz"
[ -s "$AR" ] && ok "① 产物存在:kingfisher-HEAD.tar.gz" || bad "① 产物不存在:$AR"
[ -s "$AR.sha256" ] && ok "① sha256 文件存在" || bad "① sha256 文件不存在"
( cd "$OUT1" && sha256sum -c --quiet kingfisher-HEAD.tar.gz.sha256 >/dev/null 2>&1 ) && ok "① sha256sum -c 核验通过" || bad "① sha256sum -c 核验失败"
SHA1="$(cut -d' ' -f1 "$AR.sha256" 2>/dev/null)"
case "$SHA1" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ok "① sha256 形态正确(${SHA1:0:12}…)";; *) bad "① sha256 形态不对:[$SHA1]";; esac
grep -q "sha256:$SHA1" "$LOG1" && ok "① 屏幕打印的 sha256 与文件一致" || bad "① 屏幕没打印 sha256 或与文件不一致"
PRINTED="$(sed -n 's/.*入包文件数 \([0-9]\+\).*/\1/p' "$LOG1" | head -1)"
[ -n "$PRINTED" ] && ok "① 屏幕打印了入包文件数($PRINTED)" || bad "① 屏幕没打印入包文件数"

echo "== ② 解包:顶层目录 / 被剔的不在 / 该在的都在 =="
X1="$TMP/x1"; mkdir -p "$X1"
tar -xzf "$AR" -C "$X1" 2>/dev/null && ok "② tar -xzf 解包成功" || bad "② 解包失败"
P="$X1/kingfisher-HEAD"
[ -d "$P" ] && ok "② 顶层目录 kingfisher-HEAD/" || bad "② 顶层目录不是 kingfisher-HEAD/:$(ls "$X1")"
ACTUAL="$(find "$P" -type f | wc -l | tr -d ' ')"
chk "② 解包文件数 = 屏幕打印的入包文件数" "$PRINTED" "$ACTUAL"

# 被剔的(抽样 ≥ 8 条,覆盖:__tests__ 目录 / infra/test / mr-gate / .github + 其它类别各一)
for rel in \
  platform/src/lib/exec-env/__tests__ \
  platform/src/lib/__tests__ \
  platform/vitest.config.ts \
  platform/scripts/mutation-check.mjs \
  infra/test \
  scripts/mr-gate.sh \
  scripts/kf_headless_lib.py \
  scripts/33-verify-regions-headless.py \
  scripts/35-rebuild-account.sh \
  infra/prod-only-layers.json \
  platform/scripts/naming-parity.mjs \
  .github \
  .githooks \
  .claude \
  .kiro \
  .editorconfig \
  .bandit \
  .gitleaks.toml \
  .semgrepignore \
  CLAUDE.md ; do
  if [ -e "$P/$rel" ]; then bad "② 被剔路径仍在包里:$rel"; else ok "② 不在:$rel"; fi
done
# 闭合式:整包里一个 __tests__ 目录、一个 *.test.ts 都不许有(不只抽样)
chk "② 整包 __tests__ 目录数" "0" "$(find "$P" -type d -name '__tests__' | wc -l | tr -d ' ')"
chk "② 整包 *.test.* 文件数" "0" "$(find "$P" -type f -name '*.test.*' | wc -l | tr -d ' ')"
chk "② 整包空目录数(git 不跟踪空目录,剔完也不该留)" "0" "$(find "$P" -mindepth 1 -type d -empty | wc -l | tr -d ' ')"

# 该在的(产品骨架 / 部署脚本 / 客户文档 / 版本与许可)
for rel in \
  platform/package.json \
  platform/package-lock.json \
  platform/Dockerfile \
  platform/.dockerignore \
  platform/next.config.js \
  platform/tsconfig.json \
  platform/src/app \
  platform/src/lib \
  docs/design/multi-region-execution.md \
  AGENTS.md \
  infra/bin/app.ts \
  infra/package.json \
  infra/cdk.json \
  infra/lib/platform-stack.ts \
  infra/lib/exec-env \
  infra/buildspec/exec-env-deploy.yml \
  infra/iam/platform-taskrole-calls.json \
  infra/lambda/exec-env-broker \
  infra/agent/genbi/Dockerfile \
  infra/scripts/exec-env-synth-gate.mjs \
  scripts/deploy-all.sh \
  scripts/redeploy-platform.sh \
  scripts/redeploy-agents.sh \
  scripts/01-preflight-account.sh \
  scripts/02-postdeploy-truth.sh \
  scripts/redline-scan.sh \
  scripts/iam-simulate-gate.py \
  scripts/lib/execution-regions.sh \
  scripts/lib/agentcore-agents.sh \
  scripts/lib/s3tables-catalog.sh \
  scripts/lib/flink-jars.sh \
  scripts/20-seed-data.sh \
  flink-sql-runner \
  docs/deployment.md \
  docs/operations.md \
  docs/features.md \
  docs/architecture.md \
  docs/security.md \
  docs/supported-versions.md \
  README.md CHANGELOG.md VERSION LICENSE ; do
  if [ -e "$P/$rel" ]; then ok "② 在:$rel"; else bad "② 该在的路径不在包里:$rel"; fi
done
# 构建事实文件:包根 BUILD-INFO.json = 被打包提交的事实(tag 集合 / 产品字节最后一笔提交 / 版本),不含本机时间
BI="$P/BUILD-INFO.json"
[ -s "$BI" ] && ok "② BUILD-INFO.json 在包根" || bad "② 包根没有 BUILD-INFO.json"
WANT_PC="$(git -C "$ROOT" log -1 --format=%h HEAD -- platform infra scripts)"
WANT_TAGS="$(git -C "$ROOT" tag --points-at HEAD | sort | tr '\n' ',')"
WANT_VER="$(git -C "$ROOT" show HEAD:VERSION | tr -d '[:space:]')"
GOT="$(python3 -I - "$BI" <<'PYBI'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(d) == {"ref", "commit", "tags", "productCommit", "productCommitAt", "version"}, sorted(d)
print(d["productCommit"] + "|" + ",".join(d["tags"]) + ("," if d["tags"] else "") + "|" + d["version"] + "|" + d["ref"])
PYBI
)" || bad "② BUILD-INFO.json 不是预期形态的 JSON"
chk "② BUILD-INFO.json 的 productCommit / tags / version / ref" "$WANT_PC|$WANT_TAGS|$WANT_VER|HEAD" "$GOT"

# 文件模式归一:脚本可执行、普通文件 644、目录 755(不受本机 umask 影响)
chk "② deploy-all.sh 模式" "755" "$(stat -c %a "$P/scripts/deploy-all.sh" 2>/dev/null)"
chk "② VERSION 模式" "644" "$(stat -c %a "$P/VERSION" 2>/dev/null)"
chk "② platform/src 目录模式" "755" "$(stat -c %a "$P/platform/src" 2>/dev/null)"
# 包内容 = git 该提交的内容(不是工作树):VERSION 逐字节等于 git show HEAD:VERSION
if cmp -s <(git -C "$ROOT" show HEAD:VERSION) "$P/VERSION"; then ok "② 包内 VERSION == git show HEAD:VERSION(取自提交,不是工作树)"; else bad "② 包内 VERSION 与 HEAD 提交不同"; fi

echo "== ③ 确定性:同一 ref 第二次打包 ⇒ sha256 逐字节相同;tar 头 owner 0/0、mtime = 提交时间 =="
OUT2="$TMP/out2"
"$PKG" HEAD --out "$OUT2" >"$TMP/run2.log" 2>&1; rc=$?
chk "③ 第二次打包退出码" "0" "$rc"
SHA2="$(cut -d' ' -f1 "$OUT2/kingfisher-HEAD.tar.gz.sha256" 2>/dev/null)"
chk "③ 两次 sha256 相同" "$SHA1" "$SHA2"
cmp -s "$AR" "$OUT2/kingfisher-HEAD.tar.gz" && ok "③ 两次 tar.gz 逐字节相同(cmp)" || bad "③ 两次 tar.gz 字节不同"
OWNERS="$(tar -tvzf "$AR" 2>/dev/null | awk '{print $2}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
chk "③ tar 头 owner/group 全是 0/0" "0/0" "$OWNERS"
EPOCH="$(git -C "$ROOT" log -1 --format=%ct HEAD)"
WANT_DAY="$(TZ=UTC date -u -d "@$EPOCH" +%Y-%m-%d)"
DAYS="$(TZ=UTC tar -tvzf "$AR" 2>/dev/null | awk '{print $4}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
chk "③ 全部条目 mtime 日期 = 提交日期(UTC)" "$WANT_DAY" "$DAYS"
GZNAME="$(python3 -I -c 'import sys; b=open(sys.argv[1],"rb").read(10); print("FNAME" if b[3]&0x08 else "nofname", "mtime0" if b[4:8]==b"\0\0\0\0" else "mtimeset")' "$AR")"
chk "③ gzip 头不含文件名、时间戳为 0(gzip -n)" "nofname mtime0" "$GZNAME"

echo "== ④ 拒绝:坏 ref / 非 git 目录 / 缺排除清单 / 不认识的参数 —— 一律非零且不写产物 =="
OUT3="$TMP/out3"
"$PKG" no-such-ref-for-package-test --out "$OUT3" >"$TMP/bad.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "④ 坏 ref 退出非零($rc)" || bad "④ 坏 ref 居然退 0"
grep -q "ref 解析不出来:no-such-ref-for-package-test" "$TMP/bad.log" && ok "④ 坏 ref 的报错点名了那个 ref" || bad "④ 坏 ref 报错没点名:$(cat "$TMP/bad.log")"
[ ! -e "$OUT3" ] && ok "④ 坏 ref 不创建输出目录、不写产物" || bad "④ 坏 ref 仍写了东西:$(ls "$OUT3")"

NOGIT="$TMP/nogit/scripts"; mkdir -p "$NOGIT"; cp "$PKG" "$NOGIT/"; cp "$ROOT/scripts/package-release.exclude" "$NOGIT/"
"$NOGIT/package-release.sh" HEAD --out "$TMP/out4" >"$TMP/nogit.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "④ 非 git 目录退出非零($rc)" || bad "④ 非 git 目录居然退 0"
grep -q "不是 git 仓库" "$TMP/nogit.log" && ok "④ 非 git 目录的报错说明了原因" || bad "④ 非 git 目录报错不对:$(cat "$TMP/nogit.log")"

"$PKG" HEAD --out "$TMP/out5" --exclude-file "$TMP/does-not-exist.exclude" >"$TMP/noexcl.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "④ 排除清单不存在 ⇒ 拒(不打「全量」包)" || bad "④ 排除清单不存在居然退 0"
[ ! -e "$TMP/out5" ] && ok "④ 排除清单不存在时不写产物" || bad "④ 排除清单不存在仍写了产物"

printf '# 只有注释\n\n' > "$TMP/empty.exclude"
"$PKG" HEAD --out "$TMP/out6" --exclude-file "$TMP/empty.exclude" >"$TMP/empty.log" 2>&1; rc=$?
[ "$rc" != 0 ] && ok "④ 排除清单全是注释 ⇒ 拒" || bad "④ 空清单居然退 0"

"$PKG" HEAD --bogus-flag >"$TMP/flag.log" 2>&1; rc=$?
[ "$rc" != 0 ] && grep -q "未知参数" "$TMP/flag.log" && ok "④ 未知参数 ⇒ 拒并点名" || bad "④ 未知参数没被拒:$(cat "$TMP/flag.log")"

"$PKG" >"$TMP/noref.log" 2>&1; rc=$?
[ "$rc" != 0 ] && grep -q "缺少 <tag-or-ref>" "$TMP/noref.log" && ok "④ 漏传 ref ⇒ 拒(位置参数不许静默缺省)" || bad "④ 漏传 ref 没被拒:$(cat "$TMP/noref.log")"

echo "== ⑤ 排除清单的 glob 语义(用合成目录真跑剔除:** 跨目录 / X/** 连目录 / * 不跨目录 / 注释与行内注释)=="
# 用一个一次性 git 仓库当 ref 来源:只验「清单 → 剔除结果」这段语义,不依赖本仓库文件布局
G="$TMP/glob-repo"; mkdir -p "$G"
( cd "$G" && git init -q && git config user.email t@example.invalid && git config user.name t \
  && mkdir -p platform/src/a/__tests__ platform/src/b infra/bin infra/test/x docs/sub keep/__tests__/deep \
  && echo p > platform/package.json && echo i > infra/bin/app.ts \
  && echo t > platform/src/a/__tests__/x.test.ts && echo h > platform/src/a/__tests__/helper.py \
  && echo t > platform/src/b/y.test.ts && echo k > platform/src/b/y.ts \
  && echo t > infra/test/x/t.sh && echo d > docs/sub/INTERNAL-NOTES-foo.md && echo d > docs/INTERNAL-NOTES-bar.md \
  && echo d > docs/DRAFT-BRIEF.md && echo k > docs/KEEP.md && echo z > keep/__tests__/deep/z.ts && echo k > keep/k.ts \
  && git add -A && git commit -q -m init ) >/dev/null 2>&1 || bad "⑤ 合成仓库建不出来"
cat > "$TMP/glob.exclude" <<'EX'
# 注释行
**/__tests__/**
**/*.test.ts        # 行内注释
infra/test/**
docs/INTERNAL-NOTES-*.md
docs/DRAFT*.md
EX
# 在合成仓库里跑打包器:把脚本连同清单拷进去(脚本按自己的位置找仓库根)
mkdir -p "$G/scripts"; cp "$PKG" "$G/scripts/"; cp "$TMP/glob.exclude" "$G/scripts/package-release.exclude"
"$G/scripts/package-release.sh" HEAD --out "$TMP/out7" >"$TMP/glob.log" 2>&1; rc=$?
chk "⑤ 合成仓库打包退出码" "0" "$rc"
[ "$rc" = 0 ] || cat "$TMP/glob.log"
X7="$TMP/x7"; mkdir -p "$X7"; tar -xzf "$TMP/out7/kingfisher-HEAD.tar.gz" -C "$X7" 2>/dev/null
Q="$X7/kingfisher-HEAD"
LISTED="$(cd "$Q" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
chk "⑤ 剔除后剩下的文件集合" "BUILD-INFO.json docs/KEEP.md docs/sub/INTERNAL-NOTES-foo.md infra/bin/app.ts keep/k.ts platform/package.json platform/src/b/y.ts" "$LISTED"
#   解释:**/__tests__/** 连 helper.py 与多级 deep/ 一起剔;**/*.test.ts 剔到 b/y.test.ts 而不动 y.ts;infra/test/** 连目录;
#        docs/INTERNAL-NOTES-*.md 的 * 不跨目录 ⇒ docs/sub/ 下同名保留;DRAFT* 前缀通配;行内注释被忽略
grep -q "剔除 .*  \*\*/__tests__/\*\*" "$TMP/glob.log" && ok "⑤ 逐条打印了每个模式的命中数" || bad "⑤ 没逐条打印命中数:$(cat "$TMP/glob.log")"

echo "== ⑤b 打了 tag 的 ref:BUILD-INFO.json 记全指向该提交的 tag(发版那一次就是这条路;以前 tag 清单经管道进 heredoc 喂的 python ⇒ 丢光 + SIGPIPE 退 141)=="
( cd "$G" && git tag -a vt1 -m "annotated" && git tag vt0 ) >/dev/null 2>&1 || bad "⑤b 合成仓库打不了 tag"
"$G/scripts/package-release.sh" vt1 --out "$TMP/out8" >"$TMP/tag.log" 2>&1; rc=$?
chk "⑤b 对带 tag 的 ref 打包退出码(141 = SIGPIPE 回归)" "0" "$rc"
[ "$rc" = 0 ] || cat "$TMP/tag.log"
[ -s "$TMP/out8/kingfisher-vt1.tar.gz" ] && ok "⑤b 产物按 ref 命名:kingfisher-vt1.tar.gz" || bad "⑤b 产物不存在:$(ls "$TMP/out8" 2>/dev/null)"
X8="$TMP/x8"; mkdir -p "$X8"; tar -xzf "$TMP/out8/kingfisher-vt1.tar.gz" -C "$X8" 2>/dev/null
chk "⑤b BUILD-INFO.json 的 tags 列全两个 tag(排序)且 ref = vt1" "vt0,vt1|vt1" "$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(",".join(d["tags"])+"|"+d["ref"])' "$X8/kingfisher-vt1/BUILD-INFO.json" 2>/dev/null)"
grep -q "tags=\[vt0 vt1 \]\|tags=\[vt1 vt0 \]" "$TMP/tag.log" && ok "⑤b 屏幕打印的 tags 与文件一致" || bad "⑤b 屏幕没打印 tags:$(grep BUILD-INFO "$TMP/tag.log")"

echo "== ⑥ 收口:打包器的临时目录由 trap 清掉(成功与失败两条路都清)=="
LEFT="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
chk "⑥ TMPDIR 下无残留临时目录" "0" "$LEFT"

echo
if [ "$fails" = 0 ]; then
  echo "✅ package-release 离线判据全过($n 条)"
  exit 0
else
  echo "❌ package-release 离线判据失败 $fails / $n 条"
  exit 1
fi
