#!/usr/bin/env bash
# 一次性(但入仓留痕):把 2026-09-22 误提交的两份本机配置备份从 **git 历史** 里抹掉。
#
# 🔴 背景见 docs/BUG-LEDGER.md §8.12 / ROADMAP §2octies.95:
#   提交 `16ba619` 用 `git add -A .claude/` 把 `.claude/settings.local.json.bak` / `.bak2`
#   (含 Cognito admin 口令字面量与真实 12 位账号号)加进仓并 push 上了 GitHub。
#   HEAD 里已经清掉(`57df82e`),但历史里那一个提交还在 ⇒ 用户 2026-09-22 拍板:改写历史 + force-push。
#
# 🔴 为什么只改写 `16ba619~1..<branch>` 这个**区间**而不是全历史:
#   那两份文件只在 `16ba619` 及其后代里存在,`16ba619` 之前的提交树一个字节都不变 ⇒ 它们的 SHA 不变
#   ⇒ `main` / GPT 的 `feature/multi-region_GPT` **完全不受影响**(实测:只有本分支含 16ba619),
#   而且硬门章里记的 `sha=6b4657f`(16ba619 的祖先)**仍然有效**。
#
# 🔴 收口判据(不是「我执行过」,而是**最终状态**):
#   ① 本分支提交条数不变;② 提交标题序列逐字不变;
#   ③ **新旧 HEAD 的树逐字节相同**(HEAD 本来就已经没有那两份文件 ⇒ 内容不该有任何变化);
#   ④ 分支可达对象里**再也找不到**那两个路径/blob;⑤ 红线门 `--addable` 绿。
#   任一条不成立 ⇒ 立刻退出并保留备份 ref,不许 force-push。
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="design/50-data-residency"
FROM="16ba619"
P1=".claude/settings.local.json.bak"
P2=".claude/settings.local.json.bak2"
BK="pre-secret-scrub-20260922"

OLD_HEAD="$(git rev-parse HEAD)"
OLD_TREE="$(git rev-parse 'HEAD^{tree}')"
OLD_N="$(git rev-list HEAD --count)"
OLD_SUBJ="$(git log --format=%s "$FROM~1..HEAD")"

echo "① 现状:HEAD=$OLD_HEAD 树=$OLD_TREE 提交数=$OLD_N"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] || { echo "🔴 不在 $BRANCH 上"; exit 1; }
[[ -z "$(git status --porcelain | grep -v '^??' || true)" ]] || { echo "🔴 有未提交改动,先收干净"; exit 1; }

echo "② 备份 ref(改写失败/判据不过时靠它原样回去):$BK"
git tag -f "$BK" HEAD >/dev/null
echo "   备份 = $(git rev-parse "$BK")"

echo "③ 改写区间 $FROM~1..$BRANCH —— 把两个路径从每个提交的索引里删掉"
export FILTER_BRANCH_SQUELCH_WARNING=1
rm -rf .git/refs/original
git filter-branch -f --index-filter \
  "git rm -q --cached --ignore-unmatch '$P1' '$P2'" \
  --prune-empty -- "$FROM~1..$BRANCH"

NEW_HEAD="$(git rev-parse HEAD)"
NEW_TREE="$(git rev-parse 'HEAD^{tree}')"
NEW_N="$(git rev-list HEAD --count)"
NEW_SUBJ="$(git log --format=%s "$FROM~1..HEAD" 2>/dev/null || echo '(范围失效)')"

echo
echo "④ 收口判据"
bad=0
chk() { if [[ "$2" == "$3" ]]; then echo "   ✅ $1"; else echo "   🔴 $1:期待 [$3] 实得 [$2]"; bad=1; fi; }
chk "提交条数不变" "$NEW_N" "$OLD_N"
chk "HEAD 的树逐字节相同(内容零变化)" "$NEW_TREE" "$OLD_TREE"
# 标题序列:改写后旧的 $FROM 已不存在,所以拿**新** HEAD 往回数同样多条来比
NEW_SUBJ2="$(git log --format=%s -n "$(echo "$OLD_SUBJ" | wc -l)" HEAD)"
chk "提交标题序列逐字不变" "$NEW_SUBJ2" "$OLD_SUBJ"
left="$(git rev-list --objects "$BRANCH" | grep -cE "settings\.local\.json\.bak" || true)"
chk "分支可达对象里再也没有那两个路径" "$left" "0"
if bash scripts/redline-scan.sh --addable >/dev/null 2>&1; then echo "   ✅ 红线门 --addable 绿"; else echo "   🔴 红线门 --addable 仍红"; bad=1; fi

echo
if [[ "$bad" != 0 ]]; then
  echo "🔴 判据没全过 —— **不 force-push**。回去的办法:git reset --hard $BK"
  exit 1
fi
echo "✅ 判据全过。新 HEAD=$NEW_HEAD(旧 $OLD_HEAD)"
echo "   下一步(需要显式再跑一次):"
echo "     git push --force-with-lease origin $BRANCH"
echo "     git tag -d $BK && rm -rf .git/refs/original && git reflog expire --expire=now --all && git gc --prune=now --aggressive"
