#!/usr/bin/env bash
###############################################################################
# om-secure-admin.sh —— 把 OpenMetadata 出厂管理员口令 admin/admin 换成 Secrets Manager 里的随机口令
#
#   ./scripts/om-secure-admin.sh <profile> [region]
#
# 🔴 为什么:OM 用 basic 认证、出厂口令 admin/admin,而 OM 经 CloudFront 对公网可达 ⇒ 任何人都能
#   登录客户的元数据目录。口令由 BgpOmServiceStack 生成(bgp/om/admin-password,RETAIN);平台 om-client
#   与问数技能 Lambda 从同一个密钥读(读不到就不登录,绝不回落 admin)。
# 幂等:新口令已经能登 ⇒ 什么都不做;否则用出厂口令登录、改口令,再**验证**:新口令能登 ∧ admin 不能登。
#   任一条不成立 ⇒ 退出非零(不许报成功)。口令只经环境变量交给内嵌 Python,不进命令行参数、不打印。
###############################################################################
set -euo pipefail
PROFILE="${1:?用法:om-secure-admin.sh <profile> [region]}"
REGION="${2:-us-east-1}"

OM_URL=$(aws cloudformation describe-stacks --stack-name BgpOmServiceStack --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='OpenMetadataCdnUrl'].OutputValue" --output text 2>/dev/null || true)
[ -n "$OM_URL" ] && [ "$OM_URL" != "None" ] || { echo "❌ 读不到 BgpOmServiceStack.OpenMetadataCdnUrl"; exit 1; }
OM_NEW_PW=$(aws secretsmanager get-secret-value --secret-id bgp/om/admin-password --profile "$PROFILE" --region "$REGION" \
  --query SecretString --output text 2>/dev/null || true)
[ -n "$OM_NEW_PW" ] && [ "$OM_NEW_PW" != "None" ] || { echo "❌ 读不到 Secrets Manager bgp/om/admin-password(BgpOmServiceStack 没部署到新版本?)"; exit 1; }

OM_URL="$OM_URL" OM_NEW_PW="$OM_NEW_PW" python3 - <<'PY'
import base64, json, os, sys, time, urllib.request, urllib.error
url = os.environ["OM_URL"].rstrip("/")
new_pw = os.environ["OM_NEW_PW"]
EMAIL = "admin@open-metadata.org"
FACTORY = "admin"

def call(method, path, body=None, token=None):
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            st, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {}
    # 🔴 OM 的 changePassword 回 200 + **非 JSON 正文**(2026-10-09 真环境实测:口令已改、脚本却在这里崩,
    #   后面的「新口令能登 ∧ 出厂口令不能登」验证一步没跑)⇒ 状态码才是结论,正文只是附带
    try:
        return st, json.loads(raw or b"{}")
    except ValueError:
        return st, {}

def login(pw):
    st, d = call("POST", "/api/v1/users/login", {"email": EMAIL, "password": base64.b64encode(pw.encode()).decode()})
    return d.get("accessToken") if st == 200 else None

# OM 刚起来时可能还在迁移,给它几分钟
for i in range(30):
    st, _ = call("GET", "/api/v1/system/version")
    if st == 200: break
    time.sleep(10)
else:
    print("❌ OM 在 5 分钟内都不可达(/api/v1/system/version)"); sys.exit(1)

if login(new_pw):
    print("✅ OM 管理员口令已是 Secrets Manager 里的那一个(无需更改)")
    sys.exit(0)

tok = login(FACTORY)
if not tok:
    print("❌ 新口令登不进去,出厂口令也登不进去 —— OM 管理员口令被别人改过?(不自动处置,请人工确认)")
    sys.exit(1)

st, _ = call("PUT", "/api/v1/users/changePassword",
             {"username": "admin", "oldPassword": FACTORY, "newPassword": new_pw, "confirmPassword": new_pw, "requestType": "SELF"},
             token=tok)
if st not in (200, 204):
    print(f"❌ 改口令请求失败 HTTP {st}"); sys.exit(1)

ok_new = bool(login(new_pw))
ok_factory = bool(login(FACTORY))
if ok_new and not ok_factory:
    print("✅ OM 管理员口令已从出厂 admin/admin 换成 Secrets Manager 里的随机口令(新口令能登 · 出厂口令不能登)")
    sys.exit(0)
print(f"❌ 改完验证不成立:新口令能登={ok_new} 出厂口令仍能登={ok_factory}"); sys.exit(1)
PY
