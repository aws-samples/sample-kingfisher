#!/usr/bin/env bash
# 切发版(2026-11-01 用户拍板:tag 统一 `v<主>.<次>.<补丁>`,与 VERSION 文件、CHANGELOG 标题三者一致;发版分支 release/<版本号>;
#   热修 = 补丁号 +1,不再用 -b134 式后缀;上线日期只写 CHANGELOG)。
# 用法:bash scripts/cut-release.sh <版本号> [--yes] [--github-release] [--assets-dir <目录>]
#   缺省只演练(打印将做什么,什么都不改);--yes 才真改、真推。
#   --github-release(2026-11-04 起):推完 tag 之后在 GitHub 建同名 Release ——
#     标题 `Kingfisher v<版本号>`;正文 = CHANGELOG 里 `## [<版本号>]` 那一段**逐字**(不另写一份发版说明)+ 交付包 sha256 表;
#     附件 = `scripts/package-release.sh v<版本号>` 打出的 `kingfisher-v<版本号>.tar.gz` 与 `.sha256`(缺省写到 dist/,--assets-dir 可改;
#     正文另存 `kingfisher-v<版本号>.release-notes.md` 供重试)。要本机 GitHub CLI `gh` 已登录(`gh auth login`);没装 / 没登录 /
#     GitHub 上已有同名 Release ⇒ 开跑前就拒,不会出现「tag 推了、Release 没建」的半截状态。只在正式版 tag 上建 Release(首个 = v2.2.0)。
# 前置硬门(任一不过即退 1,什么都不做):
#   ⓪ --github-release 时:gh 在 PATH 且已登录、scripts/package-release.sh 可执行;
#   ① 在 main 分支、工作树干净、本地 main == origin/main;
#   ② 版本号形如 x.y.z,且 != 当前 VERSION、tag v<版本号> 本地 / 远端都不存在;--github-release 时 GitHub 上还没有 Release v<版本号>;
#   ③ 整轮硬门章 `.claude/mr-gate-stamp.json` result == pass,且章记的提交与 HEAD 的**产品字节**(platform / infra / scripts)零差
#      (docs 笔可以在章之后,产品字节不许动 —— 用户 2026-11-01:放行只认整轮无头真跑出的 pass 章);
#   ④ CHANGELOG 顶部有 `## [Unreleased]`,且这一段至少有一行内容(空的发版说明不许发)。
# 做的事:VERSION ← 版本号;CHANGELOG `## [Unreleased]…` ⇒ `## [版本号] - <AWS 日期>`,其上新开空 Unreleased;一笔 chore 提交;
#   切 release/<版本号> 分支;打注解 tag v<版本号>;推 main + release 分支 + tag;(--github-release)打交付包 + gh release create。
#   时间戳取 AWS Date 头(本机时钟不可信)。推送之后的任何一步失败都如实说「tag 已推、Release 未建」并给出可直接重试的命令。
set -euo pipefail
CALLER_PWD="$PWD"
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VER=""; YES=0; GHREL=0; ASSETS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes)            YES=1; shift;;
    --github-release) GHREL=1; shift;;
    --assets-dir)     [ $# -ge 2 ] || die "--assets-dir 需要一个目录参数"; ASSETS="$2"; shift 2;;
    --*)              die "未知参数:$1(只认 --yes / --github-release / --assets-dir <目录>)";;
    *)                [ -z "$VER" ] || die "只接受一个版本号,多给了:$1"; VER="$1"; shift;;
  esac
done
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "用法:bash scripts/cut-release.sh <x.y.z> [--yes] [--github-release] [--assets-dir <目录>];收到版本号 '${VER:-<空>}'"
if [ -n "$ASSETS" ] && [ "$GHREL" = 0 ]; then die "--assets-dir 只与 --github-release 一起用"; fi
if [ "$GHREL" = 1 ]; then
  [ -n "$ASSETS" ] || ASSETS="$REPO/dist"
  case "$ASSETS" in /*) ;; *) ASSETS="$CALLER_PWD/$ASSETS";; esac
fi
TARBALL="$ASSETS/kingfisher-v$VER.tar.gz"; SUMFILE="$TARBALL.sha256"; NOTES="$ASSETS/kingfisher-v$VER.release-notes.md"
RETRY_PKG="bash scripts/package-release.sh v$VER --out '$ASSETS'"
RETRY_GH="gh release create v$VER '$TARBALL' '$SUMFILE' --title 'Kingfisher v$VER' --notes-file '$NOTES' --verify-tag"

if [ "$GHREL" = 1 ]; then
  say "⓪ GitHub Release 工具"
  command -v gh >/dev/null 2>&1 || die "--github-release 需要 GitHub CLI gh(https://cli.github.com/),本机 PATH 里没有"
  gh auth status >/dev/null 2>&1 || die "gh 未登录 ⇒ 先 gh auth login(凭证只放在 gh 自己的存储里,不进本脚本)"
  PKG="$REPO/scripts/package-release.sh"; [ -x "$PKG" ] || die "找不到可执行的 $PKG(Release 附件靠它打)"
  echo "   gh $(gh --version | head -1 | awk '{print $3}') 已登录;附件目录 $ASSETS"
fi

say "① 分支 / 工作树 / 与远端一致"
BR="$(git rev-parse --abbrev-ref HEAD)"; [[ "$BR" == "main" ]] || die "必须在 main 上切版本(当前 $BR);main 是主干(用户 2026-11-01 拍板 A)"
[[ -z "$(git status --porcelain)" ]] || die "工作树不干净,先提交或清理"
git fetch -q origin main --tags
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "本地 main 与 origin/main 不一致,先 pull / push"

say "② 版本号"
CUR="$(tr -d '\n' < VERSION)"; [[ "$VER" != "$CUR" ]] || die "VERSION 已是 $VER"
git rev-parse -q --verify "refs/tags/v$VER" >/dev/null && die "tag v$VER 已存在"
git ls-remote --exit-code --tags origin "refs/tags/v$VER" >/dev/null 2>&1 && die "远端已有 tag v$VER"
if [ "$GHREL" = 1 ]; then
  gh release view "v$VER" >/dev/null 2>&1 && die "GitHub 上已有 Release v$VER(同一个版本号不许发两次)"
fi

say "③ 整轮硬门章"
STAMP=".claude/mr-gate-stamp.json"; [[ -f "$STAMP" ]] || die "没有硬门章 $STAMP(只能在跑过整轮硬门的开发机上切版本)"
RES="$(python3 -c "import json;print(json.load(open('$STAMP')).get('result',''))")"; [[ "$RES" == "pass" ]] || die "硬门章 result=$RES,不是 pass ⇒ 不许切版本"
SSHA="$(python3 -c "import json;print(json.load(open('$STAMP')).get('sha',''))")"; [[ -n "$SSHA" ]] || die "硬门章缺 sha"
git cat-file -e "$SSHA^{commit}" 2>/dev/null || die "硬门章的提交 $SSHA 本地不存在"
git diff --quiet "$SSHA" HEAD -- platform infra scripts || die "HEAD 的产品字节与硬门章提交 ${SSHA:0:7} 有差 ⇒ 章不覆盖当前字节,先重跑整轮硬门"
echo "   章 pass @ ${SSHA:0:7}(产品字节与 HEAD 零差)"

say "④ CHANGELOG"
grep -q '^## \[Unreleased\]' CHANGELOG.md || die "CHANGELOG 顶部没有 ## [Unreleased]"
UNREL_LINES="$(awk '/^## \[Unreleased\]/{f=1;next} f&&/^## \[/{exit} f&&NF{n++} END{print n+0}' CHANGELOG.md)"
[ "$UNREL_LINES" -gt 0 ] || die "CHANGELOG 的 [Unreleased] 段是空的 ⇒ 没有发版说明,不许切(先把这一版改了什么写进 CHANGELOG)"
DATE="$(curl -sI --max-time 15 https://sts.amazonaws.com/ | awk 'tolower($1)=="date:"{$1="";print}' | xargs -I{} date -u -d "{}" +%F 2>/dev/null || true)"; [[ -n "$DATE" ]] || die "取不到 AWS Date 头(本机时钟不可信,不回落)"
echo "   发版日期(AWS)= $DATE;[Unreleased] 段 $UNREL_LINES 行内容"

say "计划"
cat <<PLAN
   VERSION           $CUR → $VER
   CHANGELOG         ## [Unreleased]… → ## [$VER] - $DATE(其上新开空 ## [Unreleased])
   提交              chore(release): VERSION $VER + CHANGELOG(main 上一笔)
   分支 / tag        release/$VER · v$VER(注解 tag)
   推送              origin main · origin release/$VER · origin v$VER
PLAN
if [ "$GHREL" = 1 ]; then
  cat <<PLAN2
   交付包            scripts/package-release.sh v$VER --out $ASSETS ⇒ kingfisher-v$VER.tar.gz + .sha256
   GitHub Release    gh release create v$VER(标题 Kingfisher v$VER;正文 = CHANGELOG [$VER] 段 + 交付包 sha256 表;附件 = 上面两个文件)
PLAN2
else
  echo "   GitHub Release    不建(要建加 --github-release)"
fi
[[ "$YES" = 1 ]] || { echo; echo "演练结束,没有改任何东西。确认后加 --yes 执行。"; exit 0; }

say "执行"
printf '%s\n' "$VER" > VERSION
python3 - "$VER" "$DATE" <<'EOF2'
import re, sys, pathlib
ver, date = sys.argv[1], sys.argv[2]
p = pathlib.Path("CHANGELOG.md"); s = p.read_text(encoding="utf-8")
s2, n = re.subn(r'^## \[Unreleased\]', f"## [Unreleased]\n\n## [{ver}] - {date}", s, count=1, flags=re.M)
assert n == 1
p.write_text(s2, encoding="utf-8")
EOF2
git add VERSION CHANGELOG.md
git commit -q -m "chore(release): VERSION $VER + CHANGELOG [$VER] - $DATE(tag v$VER;硬门章 pass @ ${SSHA:0:7},产品字节零差)"
git branch "release/$VER"
git tag -a "v$VER" -m "Kingfisher $VER($DATE);整轮硬门章 pass @ ${SSHA:0:7};产品字节 = $(git log -1 --format=%h -- platform infra scripts)"
git push origin main "release/$VER" "v$VER"
echo "   main $(git rev-parse --short HEAD) · release/$VER · v$VER 已推"

if [ "$GHREL" = 1 ]; then
  say "⑤ 交付包 + GitHub Release"
  mkdir -p "$ASSETS"
  "$PKG" "v$VER" --out "$ASSETS" || die "打交付包失败。tag v$VER 已推,Release 未建;修好后重试:$RETRY_PKG && $RETRY_GH"
  [ -s "$TARBALL" ] && [ -s "$SUMFILE" ] || die "打包器没写出 $TARBALL / $SUMFILE。tag v$VER 已推,Release 未建;重试:$RETRY_PKG && $RETRY_GH"
  # 正文 = CHANGELOG 刚闭合的那一段(逐字;不含标题行、不含下一版)+ 交付包 sha256 表
  python3 - "$VER" "$(cut -d' ' -f1 "$SUMFILE")" "$(basename "$TARBALL")" "$NOTES" <<'EOF3'
import re, sys, pathlib
ver, sha, name, out = sys.argv[1:5]
s = pathlib.Path("CHANGELOG.md").read_text(encoding="utf-8")
m = re.search(rf'^## \[{re.escape(ver)}\][^\n]*\n(.*?)(?=^## \[|\Z)', s, flags=re.M | re.S)
assert m, f"CHANGELOG 里找不到 ## [{ver}] 段"
body = m.group(1).strip("\n")
assert body.strip(), f"CHANGELOG [{ver}] 段为空"
footer = ("### Delivery archive\n\n| File | SHA-256 |\n|---|---|\n"
          f"| `{name}` | `{sha}` |\n\n"
          f"Verify with `sha256sum -c {name}.sha256`. The archive root carries `BUILD-INFO.json` with the tag and product commit.\n")
pathlib.Path(out).write_text(body + "\n\n" + footer, encoding="utf-8")
EOF3
  URL="$(gh release create "v$VER" "$TARBALL" "$SUMFILE" --title "Kingfisher v$VER" --notes-file "$NOTES" --verify-tag)" \
    || die "gh release create 失败。tag v$VER 已推、附件与正文在 $ASSETS;重试:$RETRY_GH"
  echo "   Release 已建:$URL"
  echo "   附件 $(basename "$TARBALL")(sha256 $(cut -c1-12 "$SUMFILE")…)· 正文 $(basename "$NOTES")"
fi

say "完成"
echo "   main $(git rev-parse --short HEAD) · release/$VER · v$VER 已推;客户取码:git clone --branch v$VER <repo>"
[ "$GHREL" = 1 ] && echo "   或交付 $ASSETS 下的 $(basename "$TARBALL") + .sha256(客户 sha256sum -c 核验后解包)"
exit 0
