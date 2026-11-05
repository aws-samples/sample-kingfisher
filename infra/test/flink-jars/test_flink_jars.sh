#!/usr/bin/env bash
# scripts/lib/flink-jars.sh(Flink 运行器 / 连接器模块 JAR 的构建 + 按内容哈希幂等上传)的离线真跑判据。
#
#     bash infra/test/flink-jars/test_flink_jars.sh      # 退出码 0 = 全过
#
# 🔴 为什么必须有它:JAR 同步只在安装 / 升级时跑一次,跑错的后果是「仓库里升了 Flink、现网 MSAF 还跑旧包」(2026-11-05 Flink 1.20.4
#   安全升级时抓到:安装脚本「桶里有就跳过」、升级脚本根本不碰 JAR)。真桶上没法反复排练,这里用**假 aws**(目录当桶、文件当对象、
#   .meta 当 metadata)和**假 mvn**(记录调用、产出可控内容的 jar)把函数真跑一遍,钉的是事实(传了什么、带什么 sha、什么时候不传、
#   缺工具时说了什么、继续没继续),不钉脚本写法。只用 bash / sha256sum / find / awk。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$ROOT/scripts/lib/flink-jars.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0; n=0
ok()  { n=$((n+1)); printf '  ✅ %s\n' "$1"; }
bad() { n=$((n+1)); printf '  ❌ %s\n' "$1"; fails=$((fails+1)); }
chk() { if [ "$2" = "$3" ]; then ok "$1($3)"; else bad "$1:期望 [$2],实际 [$3]"; fi; }
has() { if grep -q -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1 —— 输出里没有「$2」:$(tail -c 400 "$3" 2>/dev/null | tr '\n' ' ')"; fi; }
lacks() { if grep -q -- "$2" "$3" 2>/dev/null; then bad "$1 —— 输出里不该有「$2」"; else ok "$1"; fi; }

bash -n "$LIB" && ok "bash -n 语法通过" || bad "bash -n 语法错误"

# ── 假 aws:$FAKE_BUCKET_DIR 当桶;对象 = 文件,metadata sha256 = 同名 .meta 文件;FAKE_CP_FAIL=1 ⇒ 上传失败 ─────────────
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/aws" <<'SH'
#!/usr/bin/env bash
B="${FAKE_BUCKET_DIR:?}"; LOG="${FAKE_AWS_LOG:?}"
printf '%s\n' "$*" >> "$LOG"
case "$1 $2" in
  "s3api head-object")
    key=""; while [ $# -gt 0 ]; do [ "$1" = "--key" ] && key="$2"; shift; done
    [ -f "$B/$key" ] || { echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254; }
    if [ -f "$B/$key.meta" ]; then cat "$B/$key.meta"; else echo "None"; fi; echo;;
  "s3 cp")
    [ "${FAKE_CP_FAIL:-0}" = 1 ] && { echo "upload failed: An error occurred (AccessDenied)" >&2; exit 1; }
    src="$3"; dst="${4#s3://}"; dst="${dst#*/}"; meta=""
    while [ $# -gt 0 ]; do [ "$1" = "--metadata" ] && meta="$2"; shift; done
    mkdir -p "$(dirname "$B/$dst")"; cp "$src" "$B/$dst"; printf '%s' "${meta#sha256=}" > "$B/$dst.meta";;
  *) echo "fake aws: unexpected: $*" >&2; exit 97;;
esac
SH
# 假 mvn:在 $PWD(模块目录)产出 target/<jar>,内容 = FAKE_MVN_CONTENT(缺省 built-<模块名>);记录调用
cat > "$SHIM/mvn" <<'SH'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$PWD")" "$*" >> "${FAKE_MVN_LOG:?}"
mkdir -p target
mod="$(basename "$PWD")"
case "$mod" in
  flink-sql-runner*) jar="target/$mod.jar";;
  *) jar="target/flink-module-$mod.jar";;
esac
printf '%s' "${FAKE_MVN_CONTENT:-built-$mod}" > "$jar"
SH
chmod +x "$SHIM/aws" "$SHIM/mvn"
NOMVN="$TMP/nomvn"; mkdir -p "$NOMVN"; ln -s "$SHIM/aws" "$NOMVN/aws"

# ── 合成仓库根:三个运行器目录 + 两个连接器模块(各有 pom.xml 与 src/)──────────────────────────────────────────
mk_root() {  # $1=目录
  local R="$1" m
  for m in flink-sql-runner flink-sql-runner-s3t flink-sql-runner-s3t-kafka; do mkdir -p "$R/$m/src"; echo "<project/>" > "$R/$m/pom.xml"; echo "x" > "$R/$m/src/Main.java"; done
  for m in base kafka; do mkdir -p "$R/flink-connector-modules/$m/src"; echo "<project/>" > "$R/flink-connector-modules/$m/pom.xml"; echo "y" > "$R/flink-connector-modules/$m/src/M.java"; done
  echo "<project/>" > "$R/flink-connector-modules/pom.xml"   # 父 pom(不是模块目录,不许被当成模块)
}
# 跑一次 sync_flink_jars,输出落 $1,退出码落 $2;PATH 取 $3
run_sync() {  # $1=根 $2=输出文件 $3=PATH 前缀 ⇒ 打印退出码
  ( export PATH="$3:/usr/bin:/bin"; PROFILE=p REGION=us-east-1; info() { printf '   %s\n' "$*"; }
    # shellcheck source=/dev/null
    source "$LIB"; sync_flink_jars "$1" "bucket-x" ) > "$2" 2>&1; echo $?
}
sha_of() { sha256sum "$1" | awk '{print $1}'; }
count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

echo "① 首装:本地无 jar、桶空 ⇒ 五个模块都 mvn 构建、都上传、都带 sha256 metadata"
R1="$TMP/r1"; mk_root "$R1"; B1="$TMP/b1"; mkdir -p "$B1"
export FAKE_BUCKET_DIR="$B1" FAKE_AWS_LOG="$TMP/aws1.log" FAKE_MVN_LOG="$TMP/mvn1.log"; : > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"
rc=$(run_sync "$R1" "$TMP/out1" "$SHIM")
chk "① 退出码" 0 "$rc"
chk "① mvn 调用次数" 5 "$(wc -l < "$FAKE_MVN_LOG")"
chk "① 上传次数" 5 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
chk "① 「uploaded」行数" 5 "$(count 'Flink jar uploaded' "$TMP/out1")"
has "① runner key = flink/flink-sql-runner.jar" "s3://bucket-x/flink/flink-sql-runner.jar" "$FAKE_AWS_LOG"
has "① s3t key" "s3://bucket-x/flink/flink-sql-runner-s3t.jar" "$FAKE_AWS_LOG"
has "① kafka 组合包 key" "s3://bucket-x/flink/flink-sql-runner-s3t-kafka.jar" "$FAKE_AWS_LOG"
has "① 模块 key 在 flink/modules/" "s3://bucket-x/flink/modules/flink-module-kafka.jar" "$FAKE_AWS_LOG"
lacks "① 父 pom 目录不被当成模块" "flink-module-flink-connector-modules" "$FAKE_AWS_LOG"
chk "① metadata sha256 = 本地 jar 的 sha256" "$(sha_of "$R1/flink-sql-runner/target/flink-sql-runner.jar")" "$(cat "$B1/flink/flink-sql-runner.jar.meta")"

echo "② 再跑一次:本地 jar 新于源、远端 sha 相同 ⇒ 零构建、零上传、五个 unchanged"
: > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"
rc=$(run_sync "$R1" "$TMP/out2" "$SHIM")
chk "② 退出码" 0 "$rc"
chk "② mvn 调用次数" 0 "$(wc -l < "$FAKE_MVN_LOG")"
chk "② 上传次数" 0 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
chk "② 「unchanged」行数" 5 "$(count 'Flink jar unchanged' "$TMP/out2")"

echo "③ 老对象(有对象、无 metadata)⇒ 必重传那一个,其余不动"
rm -f "$B1/flink/flink-sql-runner-s3t.jar.meta"; : > "$FAKE_AWS_LOG"
rc=$(run_sync "$R1" "$TMP/out3" "$SHIM")
chk "③ 上传次数" 1 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
has "③ 重传的是无 metadata 的那个" "s3://bucket-x/flink/flink-sql-runner-s3t.jar" "$FAKE_AWS_LOG"
chk "③ 重传后 metadata 补上" "$(sha_of "$R1/flink-sql-runner-s3t/target/flink-sql-runner-s3t.jar")" "$(cat "$B1/flink/flink-sql-runner-s3t.jar.meta")"

echo "④ 远端 sha 与本地不同(别处传过别的版本)⇒ 重传"
printf 'deadbeef' > "$B1/flink/modules/flink-module-base.jar.meta"; : > "$FAKE_AWS_LOG"
rc=$(run_sync "$R1" "$TMP/out4" "$SHIM")
chk "④ 上传次数" 1 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
has "④ 重传的是 sha 不同的那个" "flink/modules/flink-module-base.jar" "$FAKE_AWS_LOG"

echo "⑤ git checkout 新版本:pom.xml 比本地 jar 新 ⇒ 重建(内容变)⇒ 重传"
# 模拟 git checkout 新版本:pom 的 mtime(checkout 时刻)比本地旧产物新 ⇒ 把旧 jar 的 mtime 拨回一小时前(不把 pom 拨到将来,否则重建产物永远「过期」)
touch -d '-1 hour' "$R1/flink-sql-runner-s3t-kafka/target/flink-sql-runner-s3t-kafka.jar"
: > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"
rc=$(FAKE_MVN_CONTENT="rebuilt-1.20.4" run_sync "$R1" "$TMP/out5" "$SHIM")
chk "⑤ mvn 只重建过期的那一个" 1 "$(wc -l < "$FAKE_MVN_LOG")"
has "⑤ 重建的是 kafka 组合包" "flink-sql-runner-s3t-kafka" "$FAKE_MVN_LOG"
chk "⑤ 上传次数" 1 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
chk "⑤ 桶里是新内容" "rebuilt-1.20.4" "$(cat "$B1/flink/flink-sql-runner-s3t-kafka.jar")"
: > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"; rc=$(run_sync "$R1" "$TMP/out5b" "$SHIM")
chk "⑤ 再跑零上传(mtime 已新于 pom)" 0 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"

echo "⑥ 缺 mvn 且本地没 jar ⇒ 只 WARNING、不上传、不删桶里对象、继续处理其余"
R2="$TMP/r2"; mk_root "$R2"; B2="$TMP/b2"; mkdir -p "$B2/flink"; printf 'old' > "$B2/flink/flink-sql-runner.jar"
export FAKE_BUCKET_DIR="$B2" FAKE_AWS_LOG="$TMP/aws6.log" FAKE_MVN_LOG="$TMP/mvn6.log"; : > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"
mkdir -p "$R2/flink-connector-modules/base/target"; printf 'prebuilt' > "$R2/flink-connector-modules/base/target/flink-module-base.jar"
touch -d '-1 hour' "$R2/flink-connector-modules/base/pom.xml" "$R2/flink-connector-modules/base/src/M.java" 2>/dev/null || true
rc=$(run_sync "$R2" "$TMP/out6" "$NOMVN")
chk "⑥ 退出码仍为 0(不中止安装)" 0 "$rc"
chk "⑥ WARNING 行数 = 缺 jar 的 4 个" 4 "$(count 'WARNING: Flink jar not found & not built' "$TMP/out6")"
chk "⑥ 桶里的旧对象还在" "old" "$(cat "$B2/flink/flink-sql-runner.jar")"
chk "⑥ 有现成 jar 的模块照常上传" 1 "$(count '^s3 cp ' "$FAKE_AWS_LOG")"
has "⑥ 上传的是现成的 base 模块" "flink/modules/flink-module-base.jar" "$FAKE_AWS_LOG"

echo "⑦ 上传失败 ⇒ WARNING 且继续(不 die)"
R3="$TMP/r3"; mk_root "$R3"; B3="$TMP/b3"; mkdir -p "$B3"
export FAKE_BUCKET_DIR="$B3" FAKE_AWS_LOG="$TMP/aws7.log" FAKE_MVN_LOG="$TMP/mvn7.log"; : > "$FAKE_AWS_LOG"; : > "$FAKE_MVN_LOG"
rc=$(FAKE_CP_FAIL=1 run_sync "$R3" "$TMP/out7" "$SHIM")
chk "⑦ 退出码" 0 "$rc"
chk "⑦ 「upload failed」行数 = 5(每个都试了,都继续)" 5 "$(count 'WARNING: Flink jar upload failed' "$TMP/out7")"

echo "⑧ 接线:两条脚本都 source 本作者并调 sync_flink_jars;安装脚本不再有自己的「桶里有就跳过」循环"
has "⑧ deploy-all source" 'source "$HERE/lib/flink-jars.sh"' "$ROOT/scripts/deploy-all.sh"
has "⑧ deploy-all 调用" 'sync_flink_jars "$ROOT" "$SCRIPTS_BUCKET"' "$ROOT/scripts/deploy-all.sh"
lacks "⑧ deploy-all 旧跳过循环已删" "Flink jar already present" "$ROOT/scripts/deploy-all.sh"
has "⑧ redeploy-platform source" 'source "$HERE/lib/flink-jars.sh"' "$ROOT/scripts/redeploy-platform.sh"
has "⑧ redeploy-platform 调用" 'sync_flink_jars "$ROOT" "bgp-glue-scripts-$JARS_ACCOUNT"' "$ROOT/scripts/redeploy-platform.sh"

echo "⑨ 单一事实源:清单里的 key 与 platform-stack 的 FLINK_*_CODE_KEY 同值"
for k in flink/flink-sql-runner.jar flink/flink-sql-runner-s3t.jar flink/flink-sql-runner-s3t-kafka.jar; do
  has "⑨ platform-stack 有 $k" "\"$k\"" "$ROOT/infra/lib/platform-stack.ts"
  has "⑨ 清单有 $k" ":$k\"" "$LIB"
done

echo
if [ "$fails" -eq 0 ]; then echo "✅ flink-jars 离线判据全过($n 条)"; exit 0; else echo "❌ flink-jars 离线判据 $fails / $n 条失败"; exit 1; fi
