#!/usr/bin/env bash
# scripts/lib/flink-jars.sh —— Flink 运行器 / 连接器模块 JAR 的**唯一作者**:清单 + 按需构建 + 按内容哈希幂等上传。
#
# 被 deploy-all.sh(安装,10.6 步)与 redeploy-platform.sh(升级,2e 步)source;两条路径只调 sync_flink_jars,不各自抄循环。
# 调用方须已定义:PROFILE REGION info()。只用 bash / sha256sum / find / aws / mvn(可选)。
#
# 🔴 为什么是「按内容哈希」而不是「桶里有就跳过」(2026-11-05 Flink 1.20.4 安全升级时抓到的升级路径缺口):
#   · 安装脚本原来对桶里**已存在**的 key 一律跳过,升级脚本根本不碰 JAR ⇒ 存量环境升到新版本后 MSAF 应用仍跑旧包,
#     仓库里升了依赖、现网一个字节没变(含 Flink 1.20.0 → 1.20.4 的 SQL 代码生成 RCE 修复)。
#   · 本地 target/ 里的旧 JAR 也会把新版本挡在外面:git checkout 新 tag 后 pom.xml / src 比旧 JAR 新 ⇒ 必须重建。
#   · 修法:上传时把 sha256 写进 S3 对象 metadata;下次比对本地 JAR 的 sha256,相同才跳过。老对象没有 metadata ⇒ 第一次升级
#     必重传一次,之后幂等。MSAF 应用在 CreateApplication / UpdateApplication(CodeContentUpdate)时取当前对象,
#     所以**运行中的流作业要在页面「停止 → 启动」一次才加载新包**(手册 §7ter 升级须知)。
#
# 诚实边界:缺 mvn 且本地没有 JAR 时只能 WARNING(保留桶里的旧对象,不删);上传失败同样 WARNING 不中止 —— 与安装脚本原口径一致,
#   因为 Flink 只是七类能力之一,不该让整条安装 / 升级为它中止;WARNING 行以 "WARNING: Flink" 开头便于 grep。

# 三个运行器:模块目录:桶内 key(与 infra/lib/platform-stack.ts 的 FLINK_CODE_KEY / FLINK_S3T_CODE_KEY / FLINK_S3T_KAFKA_CODE_KEY 同值)
FLINK_RUNNERS=(
  "flink-sql-runner:flink/flink-sql-runner.jar"
  "flink-sql-runner-s3t:flink/flink-sql-runner-s3t.jar"
  "flink-sql-runner-s3t-kafka:flink/flink-sql-runner-s3t-kafka.jar"
)
# 连接器模块目录(父 pom 下的子模块;每个子目录一个 flink-module-<id>.jar,上传到 flink/modules/)
FLINK_MODULES_DIR="flink-connector-modules"

flink_jar_sha256() { sha256sum "$1" | awk '{print $1}'; }

# 远端对象 metadata 里的 sha256:对象不存在 / 无权限 / 无 metadata 时输出空串(调用方一律按「需要上传」处理)。
flink_remote_sha256() {  # $1=bucket $2=key
  local v
  v=$(aws s3api head-object --bucket "$1" --key "$2" --profile "$PROFILE" --region "$REGION" \
        --query 'Metadata.sha256' --output text 2>/dev/null) || v=""
  [ "$v" = "None" ] && v=""
  printf '%s' "$v"
}

# 本地 JAR 是否过期:不存在,或 pom.xml / src 下任一文件比它新(git checkout 新版本后 pom 的 mtime 一定比旧产物新)。
flink_jar_stale() {  # $1=模块目录 $2=jar 路径 ⇒ 退出码 0 = 需要(重)构建
  [ -f "$2" ] || return 0
  [ -n "$(find "$1/pom.xml" "$1/src" -newer "$2" -print -quit 2>/dev/null)" ]
}

flink_build_if_stale() {  # $1=模块目录 $2=jar 路径
  flink_jar_stale "$1" "$2" || return 0
  if [ -f "$1/pom.xml" ] && command -v mvn >/dev/null 2>&1; then
    info "Flink jar missing or older than its sources — building $(basename "$1") via mvn (~2-5min)..."
    ( cd "$1" && mvn -q -B -DskipTests package ) \
      || info "WARNING: Flink mvn build failed ($(basename "$1")) — keeping whatever is in the bucket."
  fi
}

# 一个 JAR 的同步:本地缺 ⇒ WARNING;远端 sha256 == 本地 ⇒ unchanged;否则上传并写 metadata sha256。
flink_sync_one() {  # $1=本地 jar $2=bucket $3=key ⇒ 退出码 0 = 已一致或已上传
  local local_sha remote_sha
  if [ ! -f "$1" ]; then
    info "WARNING: Flink jar not found & not built ($1) — install Maven+JDK17 or Flink jobs using it will fail to start."
    return 1
  fi
  local_sha="$(flink_jar_sha256 "$1")"
  remote_sha="$(flink_remote_sha256 "$2" "$3")"
  if [ -n "$remote_sha" ] && [ "$remote_sha" = "$local_sha" ]; then
    info "Flink jar unchanged ($3, sha256 ${local_sha:0:12}…)."
    return 0
  fi
  if aws s3 cp "$1" "s3://$2/$3" --metadata "sha256=$local_sha" --profile "$PROFILE" --region "$REGION" >/dev/null; then
    info "Flink jar uploaded ($3, sha256 ${local_sha:0:12}…)."
  else
    info "WARNING: Flink jar upload failed ($3)."
    return 1
  fi
}

# 入口:三个运行器 + 全部连接器模块。$1=仓库根 $2=脚本桶名(bgp-glue-scripts-<account>)。
sync_flink_jars() {
  local root="$1" bucket="$2" pair mod key src mdir mid mjar
  for pair in "${FLINK_RUNNERS[@]}"; do
    mod="${pair%%:*}"; key="${pair##*:}"; src="$root/$mod/target/$(basename "$key")"
    flink_build_if_stale "$root/$mod" "$src"
    flink_sync_one "$src" "$bucket" "$key" || true
  done
  for mdir in "$root/$FLINK_MODULES_DIR"/*/; do
    [ -f "$mdir/pom.xml" ] || continue
    mid="$(basename "$mdir")"; mjar="flink-module-${mid}.jar"
    flink_build_if_stale "$mdir" "$mdir/target/$mjar"
    flink_sync_one "$mdir/target/$mjar" "$bucket" "flink/modules/$mjar" || true
  done
}
