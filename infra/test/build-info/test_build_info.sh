#!/usr/bin/env bash
# 序 39 第二刀 —— 平台镜像构建信息(infra/lib/shared/build-info.ts,唯一作者)的离线判据,在本仓库真跑:
#   ① git 克隆里:四个键都在、产品提交是短哈希、提交时间是 ISO、VERSION 非空(release tag 可空 = 未发版构建,合法);
#   ② 非 git 目录里:四个值全空且**不抛**(synth 不能因版本标签失败,页面侧如实显示「构建信息不可用」);
#   ④ 非 git 目录 + 产品包的 BUILD-INFO.json:事实读自文件、tag 按同一规则选;坏文件当没有。
#     bash infra/test/build-info/test_build_info.sh      # 退出码 0 = 全过
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/../.." && pwd)"
cd "$INFRA"

run_ts() {
  npx ts-node --prefer-ts-exts -e "import { platformImageBuildArgs } from \"./lib/shared/build-info\"; console.log(JSON.stringify(platformImageBuildArgs($1)))" 2>/dev/null
}

OUT_GIT="$(run_ts "")"
python3 - "$OUT_GIT" <<'EOF'
import json, re, sys
args = json.loads(sys.argv[1])
keys = ["BGP_BUILD_RELEASE_TAG", "BGP_BUILD_PRODUCT_COMMIT", "BGP_BUILD_PRODUCT_COMMIT_AT", "BGP_BUILD_VERSION"]
assert sorted(args) == sorted(keys), args
assert re.fullmatch(r"[0-9a-f]{7,40}", args["BGP_BUILD_PRODUCT_COMMIT"]), args
assert re.match(r"\d{4}-\d{2}-\d{2}T", args["BGP_BUILD_PRODUCT_COMMIT_AT"]), args
assert args["BGP_BUILD_VERSION"], args
assert args["BGP_BUILD_RELEASE_TAG"] == "" or args["BGP_BUILD_RELEASE_TAG"].startswith(("v", "release-")), args
print("   ok git 克隆:", json.dumps(args, ensure_ascii=False))
EOF

# ③ 选取规则 pickReleaseTag(2026-11-01 起 tag 统一 v<semver>;历史 release-* 回落):纯函数真跑五例
PICK="$(npx ts-node --prefer-ts-exts -e "import { pickReleaseTag as p } from \"./lib/shared/build-info\"; console.log(JSON.stringify([p([\"release-2026-10-29\",\"v2.1.2\"]), p([\"v2.1.2\",\"v2.1.10\",\"v2.2.0\"]), p([\"release-2026-10-13\",\"release-2026-10-13-b103\"]), p([\"v1.44.1-stable\",\"release-2026-10-12\"]), p([])]))" 2>/dev/null)"
python3 - "$PICK" <<'EOF2'
import json, sys
got = json.loads(sys.argv[1])
want = ["v2.1.2", "v2.2.0", "release-2026-10-13-b103", "v1.44.1-stable", ""]
assert got == want, (got, want)
print("   ok pickReleaseTag:v<semver> 优先且按数值取最高;无 v ⇒ release-* 字典序末;空 ⇒ 空")
EOF2

TMP="$(mktemp -d)"
OUT_NOGIT="$(run_ts "\"$TMP\"")"
rmdir "$TMP"
python3 - "$OUT_NOGIT" <<'EOF'
import json, sys
args = json.loads(sys.argv[1])
assert len(args) == 4 and all(v == "" for v in args.values()), args
print("   ok 非 git 目录:四个值全空、不抛")
EOF
# ④ 产品包(非 git 目录 + BUILD-INFO.json):tag 按同一规则选(v<semver> 优先;非发版 tag 被 glob 过滤),产品提交 / 时间 / 版本来自文件;
#    文件形态不对 ⇒ 当没有(四个值空、不抛)
TMP="$(mktemp -d)"
cat > "$TMP/BUILD-INFO.json" <<'JSON'
{ "ref": "v2.1.2", "commit": "0123456789abcdef0123456789abcdef01234567",
  "tags": ["archive/docs-2026-11-04", "release-2026-10-29", "v2.1.2"],
  "productCommit": "abc1234", "productCommitAt": "2026-10-28T09:00:00+00:00", "version": "2.1.2" }
JSON
OUT_PKG="$(run_ts "\"$TMP\"")"
printf 'garbage' > "$TMP/BUILD-INFO.json"
OUT_BAD="$(run_ts "\"$TMP\"")"
rm -rf "$TMP"
python3 - "$OUT_PKG" "$OUT_BAD" <<'PYCHK'
import json, sys
pkg, bad = json.loads(sys.argv[1]), json.loads(sys.argv[2])
assert pkg == {"BGP_BUILD_RELEASE_TAG": "v2.1.2", "BGP_BUILD_PRODUCT_COMMIT": "abc1234",
               "BGP_BUILD_PRODUCT_COMMIT_AT": "2026-10-28T09:00:00+00:00", "BGP_BUILD_VERSION": "2.1.2"}, pkg
assert len(bad) == 4 and all(v == "" for v in bad.values()), bad
print("   ok 产品包:BUILD-INFO.json 的事实被读到且 tag 按规则选;坏文件 ⇒ 全空不抛")
PYCHK
echo "build-info 判据全过"
