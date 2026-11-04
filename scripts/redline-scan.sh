#!/usr/bin/env bash
# 红线扫描 (模块 27 / WS0) — 阻断敏感信息进入受跟踪文件。
#
# 红线②:绝不允许把真实账号号 / ARN / 资源 ID / 口令 / 密钥写进受跟踪文件(公开仓库)。
# 真实值只放 *.local.md(已 gitignored)。本脚本在 CI 与本地 pre-commit 中作为硬门禁。
#
# 退出码:0=干净;1=发现疑似敏感信息(打印命中行,需人工处理后才能提交/合并)。
#
# 用法:
#   scripts/redline-scan.sh            # 扫描 git 跟踪的全部文件
#   scripts/redline-scan.sh --staged   # 仅扫描已 staged 的改动(pre-commit 用)
#
# 设计要点:
#   - 只扫 **git 跟踪/将提交** 的文件(node_modules、构建产物、*.local.md、本脚本本身均不在内);
#   - 占位符(如 <ACCOUNT>、123456789012 这类示例)不算命中——通过白名单豁免;
#   - 宁可误报也不漏报:命中即失败,由人确认是真值还是示例。

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-tracked}"

# 待扫描文件列表(NUL 分隔以兼容空格路径)。
#
# ══════════════════════════════════════════════════════════════════════════════
# 🔴🔴 `--addable` = 「这一刀**可能**把什么放进仓里」= 已跟踪 ∪ 已暂存 ∪ **未跟踪且未被 gitignore**
#
# 2026-09-22 真踩,这道门最难看的一次失效。那一刀是:
#     git add -A .claude/ docs/ scripts/ && git commit … && git push …
# 三件事写在**同一条 bash 命令**里,而 commit 门是 **PreToolUse** 钩子 —— 它跑在 `git add` **之前**。
# 此刻 `.claude/settings.local.json.bak` / `.bak2`(共 **110 处**命中:62 + 43 处真实口令、
# 5 处 12 位账号号)既**不在索引里**、也**不在暂存区里** ⇒ `tracked` 与 `--staged` 两种范围
# **都看不见它们** ⇒ 扫描绿 ⇒ commit 放行、直接 push 上了 GitHub。
# 从下一刀起它们已被跟踪 ⇒ 之后每一次 commit 都被拦 ——
# **fail-open 恰好落在唯一要紧的那个时刻,fail-closed 落在之后所有无关的时刻。**
#
# ⇒ 唯一正确的范围是「**在 add 之前就能看见**」的那个:再并上「未跟踪且未被 gitignore」。
#   `--exclude-standard` 让**已经正确 gitignore 的本机文件不算**(所以正解是把本机秘密 gitignore 掉,
#   而不是指望自己每次都写准 `git add` 的路径)。
# 同族教训:「清单驱动的门禁,覆盖面就是判据本身」「矩阵里没有的那一类 = 默认豁免」。
# ══════════════════════════════════════════════════════════════════════════════
case "$MODE" in
  --staged)
    mapfile -d '' FILES < <(git diff --cached --name-only -z --diff-filter=ACM) ;;
  --addable)
    mapfile -d '' FILES < <({ git ls-files -z
                              git diff --cached --name-only -z --diff-filter=ACM
                              git ls-files -z --others --exclude-standard; } | sort -zu) ;;
  *)
    mapfile -d '' FILES < <(git ls-files -z) ;;
esac

# 从扫描中排除的路径(本就允许含真实值 / 二进制 / 本脚本自身的正则会自命中)。
is_excluded() {
  case "$1" in
    *.local.md) return 0 ;;                       # gitignored 真值文件(双保险)
    scripts/redline-scan.sh) return 0 ;;          # 本脚本含正则,会自命中
    *.png|*.jpg|*.jpeg|*.gif|*.pdf|*.pptx|*.ico|*.woff*|*.lock|package-lock.json) return 0 ;;
    docs/design/27-production-hardening/DESIGN.md) return 0 ;; # 本模块设计文档解释扫描规则
    *) return 1 ;;
  esac
}

# 已知的安全占位符 / 示例值白名单(命中这些的行不算泄露)。
# 含大量正常代码模式:变量引用 / 环境变量 / 表单字段 / 关键字参数 / 注释。
# 🔴 `[0-9]\{12\}` 里「12 位全是同一个数字」**不可能是真账号**(真账号没有这种形态)⇒ 闭合式豁免。
#   2026-09-22 由 `--addable` 范围抓出来:`suggestions/v2/*.md` 里的代码样例用了 `111111111111`
#   / `999999999999` 当夹具 —— 原白名单只写了 `000000000000` 这一个,于是同类的另外九个全是假红。
#   (枚举十个而不是写 `([0-9])\1{11}`:后者依赖 GNU grep 的反向引用扩展,不同机器上会静默失效。)
WHITELIST_REGEX='(<ACCOUNT>|<ACCOUNT_ID>|123456789012|0{12}|1{12}|2{12}|3{12}|4{12}|5{12}|6{12}|7{12}|8{12}|9{12}|YOUR_|EXAMPLE|<om-cloudfront>|us-east-1_XXXX|placeholder|PLACEHOLDER|xxxxxxxx)'
# 口令模式专用的"正常代码"豁免:env 读取、变量引用、表单/类型声明、Python 关键字参数等。
PWD_BENIGN='(os\.environ|process\.env|getenv|\.password|password:|password\?|password\)|password,|password;|password\.|name="password"|"password"|getSecret|createSecret|updateSecret|: *string|=> *Promise|required:|min:|rules=|Form\.Item|password=[a-z_]|password=db_|//|#)'

# 敏感模式(命中即疑似泄露)。每条:label|regex
PATTERNS=(
  'AWS_ACCESS_KEY|AKIA[0-9A-Z]{16}'
  'AWS_SECRET_KEY|aws_secret_access_key["'\'' :=]+[A-Za-z0-9/+]{40}'
  'PRIVATE_KEY|-----BEGIN[A-Z ]*PRIVATE KEY-----'
  'AWS_ACCOUNT_12_DIGIT|\b[0-9]{12}\b'
  'BEARER_TOKEN|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'
  # 仅匹配「赋给引号字符串字面量」的硬编码口令;变量/env/字段声明由 PWD_BENIGN 豁免。
  # 排除集含 \ :占位符如 '\${MYSQL_PASSWORD}'(JS 模板转义写法)不算硬编码(启动时才注入真实值)。
  'HARDCODED_PASSWORD|(password|passwd|pwd)["'\'' ]*[:=]+ *["'\''][^"'\''$<{\\][^"'\'']{4,}["'\'']'
)

hits=0
for f in "${FILES[@]}"; do
  [[ -z "$f" ]] && continue
  [[ ! -f "$f" ]] && continue
  is_excluded "$f" && continue
  for entry in "${PATTERNS[@]}"; do
    label="${entry%%|*}"
    regex="${entry#*|}"
    # 口令/密钥关键字大小写无关(dbPassword / DB_PASSWORD 等);账号号/AKIA 保持大小写敏感。
    ci=""
    [[ "$label" == "HARDCODED_PASSWORD" || "$label" == "AWS_SECRET_KEY" ]] && ci="i"
    # 命中行(去掉白名单豁免后的)。-I 跳过二进制。
    while IFS= read -r line; do
      # 去掉命中通用白名单占位符的行
      if echo "$line" | grep -qiE "$WHITELIST_REGEX"; then continue; fi
      # 口令模式额外豁免正常代码写法(变量/env/字段声明/注释)
      if [[ "$label" == "HARDCODED_PASSWORD" ]] && echo "$line" | grep -qiE "$PWD_BENIGN"; then continue; fi
      echo "🚨 [$label] $f: $line"
      hits=$((hits + 1))
    done < <(grep -InI${ci}E "$regex" "$f" 2>/dev/null || true)
  done
done

if [[ "$hits" -gt 0 ]]; then
  echo ""
  echo "❌ 红线扫描发现 $hits 处疑似敏感信息。真实账号号/ARN/密钥/口令不得进入受跟踪文件;"
  echo "   请改用占位符,真实值只放 *.local.md(已 gitignored)。"
  exit 1
fi

echo "✅ 红线扫描通过:未发现敏感信息。"
