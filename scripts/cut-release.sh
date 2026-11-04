#!/usr/bin/env bash
# 切发版(2026-11-01 用户拍板:tag 统一 `v<主>.<次>.<补丁>`,与 VERSION 文件、CHANGELOG 标题三者一致;发版分支 release/<版本号>;
#   热修 = 补丁号 +1,不再用 -b134 式后缀;上线日期只写 CHANGELOG)。
# 用法:bash scripts/cut-release.sh <版本号> [--yes]     缺省只演练(打印将做什么,什么都不改);--yes 才真改、真推
# 前置硬门(任一不过即退 1,什么都不做):
#   ① 在 main 分支、工作树干净、本地 main == origin/main;
#   ② 版本号形如 x.y.z,且 != 当前 VERSION、tag v<版本号> 不存在;
#   ③ 整轮硬门章 `.claude/mr-gate-stamp.json` result == pass,且章记的提交与 HEAD 的**产品字节**(platform / infra / scripts)零差
#      (docs 笔可以在章之后,产品字节不许动 —— 用户 2026-11-01:放行只认整轮无头真跑出的 pass 章);
#   ④ CHANGELOG 顶部有 `## [Unreleased]`。
# 做的事:VERSION ← 版本号;CHANGELOG `## [Unreleased]…` ⇒ `## [版本号] - <AWS 日期>`,其上新开空 Unreleased;一笔 chore 提交;
#   切 release/<版本号> 分支;打注解 tag v<版本号>;推 main + release 分支 + tag。时间戳取 AWS Date 头(本机时钟不可信)。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
VER="${1:-}"; YES="${2:-}"
say(){ printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "用法:bash scripts/cut-release.sh <x.y.z> [--yes];收到 '$VER'"
[[ -z "$YES" || "$YES" == "--yes" ]] || die "第二个参数只认 --yes"

say "① 分支 / 工作树 / 与远端一致"
BR="$(git rev-parse --abbrev-ref HEAD)"; [[ "$BR" == "main" ]] || die "必须在 main 上切版本(当前 $BR);main 是主干(用户 2026-11-01 拍板 A)"
[[ -z "$(git status --porcelain)" ]] || die "工作树不干净,先提交或清理"
git fetch -q origin main --tags
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "本地 main 与 origin/main 不一致,先 pull / push"

say "② 版本号"
CUR="$(tr -d '\n' < VERSION)"; [[ "$VER" != "$CUR" ]] || die "VERSION 已是 $VER"
git rev-parse -q --verify "refs/tags/v$VER" >/dev/null && die "tag v$VER 已存在"
git ls-remote --exit-code --tags origin "refs/tags/v$VER" >/dev/null 2>&1 && die "远端已有 tag v$VER"

say "③ 整轮硬门章"
STAMP=".claude/mr-gate-stamp.json"; [[ -f "$STAMP" ]] || die "没有硬门章 $STAMP(只能在跑过整轮硬门的开发机上切版本)"
RES="$(python3 -c "import json;print(json.load(open('$STAMP')).get('result',''))")"; [[ "$RES" == "pass" ]] || die "硬门章 result=$RES,不是 pass ⇒ 不许切版本"
SSHA="$(python3 -c "import json;print(json.load(open('$STAMP')).get('sha',''))")"; [[ -n "$SSHA" ]] || die "硬门章缺 sha"
git cat-file -e "$SSHA^{commit}" 2>/dev/null || die "硬门章的提交 $SSHA 本地不存在"
git diff --quiet "$SSHA" HEAD -- platform infra scripts || die "HEAD 的产品字节与硬门章提交 ${SSHA:0:7} 有差 ⇒ 章不覆盖当前字节,先重跑整轮硬门"
echo "   章 pass @ ${SSHA:0:7}(产品字节与 HEAD 零差)"

say "④ CHANGELOG"
grep -q '^## \[Unreleased\]' CHANGELOG.md || die "CHANGELOG 顶部没有 ## [Unreleased]"
DATE="$(curl -sI --max-time 15 https://sts.amazonaws.com/ | awk 'tolower($1)=="date:"{$1="";print}' | xargs -I{} date -u -d "{}" +%F 2>/dev/null || true)"; [[ -n "$DATE" ]] || die "取不到 AWS Date 头(本机时钟不可信,不回落)"
echo "   发版日期(AWS)= $DATE"

say "计划"
cat <<PLAN
   VERSION           $CUR → $VER
   CHANGELOG         ## [Unreleased]… → ## [$VER] - $DATE(其上新开空 ## [Unreleased])
   提交              chore(release): VERSION $VER + CHANGELOG(main 上一笔)
   分支 / tag        release/$VER · v$VER(注解 tag)
   推送              origin main · origin release/$VER · origin v$VER
PLAN
[[ "$YES" == "--yes" ]] || { echo; echo "演练结束,没有改任何东西。确认后加 --yes 执行。"; exit 0; }

say "执行"
printf '%s\n' "$VER" > VERSION
python3 - "$VER" "$DATE" <<'EOF2'
import re, sys, pathlib
ver, date = sys.argv[1], sys.argv[2]
p = pathlib.Path("CHANGELOG.md"); s = p.read_text()
s2, n = re.subn(r'^## \[Unreleased\]', f"## [Unreleased]\n\n## [{ver}] - {date}", s, count=1, flags=re.M)
assert n == 1
p.write_text(s2)
EOF2
git add VERSION CHANGELOG.md
git commit -q -m "chore(release): VERSION $VER + CHANGELOG [$VER] - $DATE(tag v$VER;硬门章 pass @ ${SSHA:0:7},产品字节零差)"
git branch "release/$VER"
git tag -a "v$VER" -m "Kingfisher $VER($DATE);整轮硬门章 pass @ ${SSHA:0:7};产品字节 = $(git log -1 --format=%h -- platform infra scripts)"
git push origin main "release/$VER" "v$VER"
say "完成"
echo "   main $(git rev-parse --short HEAD) · release/$VER · v$VER 已推;客户取码:git clone --branch v$VER <repo>"
