"""bgp-cognito-bootstrap —— 受限账号里给平台建组建号的唯一出路。

# 为什么需要它(真实产品缺口,不是工程洁癖)

平台的 4 个 RBAC 组 + 5 个初始用户由 `scripts/10-bootstrap-cognito.sh` 直连 Cognito 建。
但临时/共用账号(`WSParticipantRole`、Event Engine 之类)常把 `cognito-idp:Admin*` 写权限
整片裁掉,而 pool 又关着自助注册(`AllowAdminCreateUserOnly=true`)⇒ **平台一个能登录的
用户都没有,等于装不上**。2026-08-29 在一个 workshop 账号实测栽在这。

**关键认识**:CloudFormation / CDK 用的是 bootstrap 时创建的执行角色(AdministratorAccess),
**不是操作者手上那个受限角色**。所以凡能表达成"由 AWS 服务代跑"的操作都不受操作者的角色限制。
本函数由 CDK 创建、**自带**所需的 Cognito 写权限;脚本直连被拒时改为 invoke 它。

# 路径B(invoke)与路径C(部署期自愈)—— 以及当年否掉 CFN 自定义资源的理由今天为什么不成立了

**路径B**(默认):口令由调用侧生成、只走 invoke payload ⇒ 不落 CFN 模板、不进 CloudWatch
(本函数**从不打印 payload**)、不落函数环境变量。它要求操作者有 `lambda:InvokeFunction`。

**路径C**(2026-09-17 新增):操作者连 `lambda:InvokeFunction` 都没有的账号里,**上面两条路都断**
(实测:某空账号的 IAM 用户 `cognito-idp:*` / `lambda:*` / `secretsmanager:*` / `codebuild:*` 全拒,
只剩 `cloudformation` / `s3` / `dynamodb` / `ssm`)⇒ 基础设施装得上、**一个能登录的用户都没有**,
和 2026-08-29 那次是同一个病:**把「建组建号」压在操作者的 IAM 权限上**。
⇒ 本函数同时能当 **CFN 自定义资源**:由 CloudFormation(部署角色 = 管理员)在部署时代跑。

当年文件头写着「不做成 CFN 自定义资源,因为口令得在部署时可得 ⇒ 会进模板/参数/事件」。
逐条重判(记忆 `stale-blockers-must-be-reprobed`:结论会过期,但**要说清哪个前提变了**):
· 「部署时可得」——**成立且无害**:deploy-all 本来就在这一刻手里有口令(它自己生成的);
· 「进模板」——**已避开**:模板里只有**参数名**,口令走 SSM 参数,自定义资源属性不带任何口令;
· 「进参数/事件」——**已避开**:不用 CfnParameter、不把口令放进 ResourceProperties;
· 新增的暴露面 = 口令在 SSM 里存在**一次部署的时长**(SecureString 加密),用完由本函数
  **自己删掉**(`ssm:DeleteParameter`),并把删除结果如实回报给 CFN。
⇒ 所以路径C 不是推翻当年的判断,是把当年那三条反对理由**逐条消掉**之后才补的。

# 🔴 提权面与三道收窄(这是本文件最该被 review 的部分)

一个"能设任意用户口令"的函数常驻账号里,对任何拿到 `lambda:InvokeFunction` 的人就是一条
**提权路径**(设掉 admin 口令 → 拿到平台超管)。故做三道收窄:

1. **名册在函数侧固定**(`ROSTER_JSON` 由 CDK 写死),payload 只能带口令、**不能带用户名→组的映射**。
   否则调用方可以给自己建一个 `attacker` 并塞进 `bgp-admin`。不在名册内的用户名一律拒绝。
2. **一次性**:用户状态已是 `CONFIRMED`(= 已引导完)时**拒绝改口令**。于是本函数只是个
   "首次引导工具",不是常驻的口令重置后门;正常环境引导完成后它就是惰性的。
3. **重置需 infra 级权限**:确实要重置时,须把函数环境变量 `BOOTSTRAP_ALLOW_RESET` 置 1
   —— 改环境变量意味着已有 CFN/CDK 权限(≈管理员),而不是只有 invoke 权限。

**如实登记残留**:在"用户尚未 CONFIRMED"的窗口内,拿到 invoke 权限的人可以设 admin 口令。
这个窗口就是"栈已建好、还没引导"那一小段。需要彻底消除的部署(生产)用
`-c cognitoBootstrapFn=0` 直接不创建本函数,回到纯直连路径。
"""

import json
import os
import urllib.request

import boto3

idp = boto3.client("cognito-idp")
_ssm_client = None


def _ssm():
    """懒加载:路径A/B 不需要 ssm,别在冷启动就建客户端。"""
    global _ssm_client
    if _ssm_client is None:
        _ssm_client = boto3.client("ssm")
    return _ssm_client

POOL_ID = os.environ["USER_POOL_ID"]
# {"<用户名>": "<组名或空串>"}。空串 = 不入任何组(业务 viewer)。
ROSTER = json.loads(os.environ["ROSTER_JSON"])
ALLOW_RESET = os.environ.get("BOOTSTRAP_ALLOW_RESET", "0") == "1"

GROUPS = sorted({g for g in ROSTER.values() if g})


def _user_status(username: str):
    """返回 UserStatus;用户不存在返回 None。"""
    try:
        return idp.admin_get_user(UserPoolId=POOL_ID, Username=username)["UserStatus"]
    except idp.exceptions.UserNotFoundException:
        return None


def _bootstrap(passwords):
    """建组 + 建号 + 设口令 + 入组。**唯一作者** —— 直连 invoke 与 CFN 自定义资源都走它。"""
    groups_out = {}
    for g in GROUPS:
        try:
            idp.create_group(UserPoolId=POOL_ID, GroupName=g)
            groups_out[g] = "created"
        except idp.exceptions.GroupExistsException:
            groups_out[g] = "exists"

    users_out = {}
    for username, pw in passwords.items():
        # 收窄①:名册固定
        if username not in ROSTER:
            users_out[username] = "refused: 不在固定名册内(见本函数文件头 收窄①)"
            continue
        if not isinstance(pw, str) or not pw:
            users_out[username] = "refused: 口令为空"
            continue

        status = _user_status(username)
        # 收窄②③:已引导完不再改口令,除非 infra 级开了 BOOTSTRAP_ALLOW_RESET
        if status == "CONFIRMED" and not ALLOW_RESET:
            users_out[username] = "skipped: 已引导(CONFIRMED),本函数不当口令重置后门"
            continue

        if status is None:
            idp.admin_create_user(
                UserPoolId=POOL_ID, Username=username, MessageAction="SUPPRESS"
            )
        idp.admin_set_user_password(
            UserPoolId=POOL_ID, Username=username, Password=pw, Permanent=True
        )
        grp = ROSTER[username]
        if grp:
            idp.admin_add_user_to_group(
                UserPoolId=POOL_ID, Username=username, GroupName=grp
            )
        users_out[username] = "ready" + (f" (group {grp})" if grp else " (无组)")

    return {"ok": True, "groups": groups_out, "users": users_out}


# ── 路径C:CFN 自定义资源 ────────────────────────────────────────────────────────
def _cfn_send(event, status, reason, data=None):
    """回响应给 CloudFormation。**不回就是让部署挂满一小时**,所以每条出口都必须走到这里。"""
    body = json.dumps(
        {
            "Status": status,
            "Reason": (reason or "")[:1000],
            "PhysicalResourceId": event.get("PhysicalResourceId") or "bgp-cognito-bootstrap-run",
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "NoEcho": False,
            "Data": data or {},
        }
    ).encode("utf-8")
    # ProtoShield:回执地址只接受 CloudFormation 事件里的 https 预签名 URL(自定义资源协议),拒绝其它 scheme。
    if not str(event.get("ResponseURL", "")).startswith("https://"):
        raise ValueError("ResponseURL 不是 https 地址,拒绝回执")
    req = urllib.request.Request(
        event["ResponseURL"],
        data=body,
        method="PUT",
        headers={"content-type": "", "content-length": str(len(body))},
    )
    urllib.request.urlopen(req, timeout=20).read()  # nosec B310 # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected —— 上面已钉 https,且 URL 来自 CFN 事件而非用户
    print(f"[cfn] responded {status}")  # 原因只回给 CloudFormation 事件,不进日志(与口令同源的内容一律不落日志)


def _handle_cfn(event):
    rt = event.get("RequestType")
    if rt == "Delete":
        # 🔴 删栈**绝不删用户/组**:user pool 本身就是 RETAIN,人不能随栈消失。
        _cfn_send(event, "SUCCESS", "Delete = no-op(引导资源从不删用户与组)")
        return

    props = event.get("ResourceProperties") or {}
    name = str(props.get("PasswordsSsmParameter") or "")
    if not name:
        _cfn_send(event, "FAILED", "自定义资源缺 PasswordsSsmParameter 属性(模板拼错了)")
        return

    try:
        raw = _ssm().get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    except Exception as e:  # noqa: BLE001 —— 任何取不到都必须响亮失败,不许「静默跳过建用户」
        _cfn_send(
            event,
            "FAILED",
            f"读不到初始口令参数 {name}({type(e).__name__})。部署前先写它:"
            f'aws ssm put-parameter --name {name} --type SecureString --value \'{{"admin":"..."}}\'',
        )
        return

    try:
        passwords = json.loads(raw)
    except Exception:  # noqa: BLE001
        passwords = None
    if not isinstance(passwords, dict) or not passwords:
        _cfn_send(event, "FAILED", f"{name} 的内容不是「用户名 → 口令」的 JSON 对象")
        return

    # 🔴 空转即成功是禁止的:名册里少一个人就等于「装完了但那个角色登不进去」⇒ 响亮失败。
    missing = sorted(set(ROSTER) - set(passwords))
    if missing:
        _cfn_send(event, "FAILED", f"初始口令参数少了这些名册用户:{missing}")
        return

    out = _bootstrap(passwords)
    refused = {u: v for u, v in (out.get("users") or {}).items() if str(v).startswith("refused")}

    # 用完即删:口令不许在账号里多留一分钟(删不掉要如实说,不许悄悄留着)
    deleted = "yes"
    try:
        _ssm().delete_parameter(Name=name)
    except Exception as e:  # noqa: BLE001
        deleted = f"no({type(e).__name__})"

    data = {
        "users": json.dumps(out.get("users") or {}, ensure_ascii=False),
        "groups": json.dumps(out.get("groups") or {}, ensure_ascii=False),
        "passwordParamDeleted": deleted,
    }
    if refused:
        _cfn_send(event, "FAILED", f"有用户被拒:{refused}", data)
        return
    _cfn_send(event, "SUCCESS", f"引导完成(口令参数已删={deleted})", data)


def handler(event, _context):
    # 🔴 绝不 print(event):它带口令。只按用户名维度回报结果。
    if isinstance(event, dict) and event.get("RequestType") and event.get("ResponseURL"):
        try:
            _handle_cfn(event)
        except Exception as e:  # noqa: BLE001
            # 不回响应 = CFN 挂到超时(1h);所以异常也必须先把 FAILED 送出去。
            try:
                _cfn_send(event, "FAILED", f"引导自定义资源异常:{type(e).__name__}: {e}")
            except Exception as send_err:  # noqa: BLE001
                # 回执 FAILED 本身也失败:只记异常类型(不记内容 —— 内容可能带预签名 ResponseURL),然后把原异常抛出去
                print(f"[cfn] FAILED 回执发送失败:{type(send_err).__name__}")
            raise
        return None

    passwords = (event or {}).get("passwords")
    if not isinstance(passwords, dict) or not passwords:
        return {"ok": False, "error": 'payload 需形如 {"passwords": {"<用户名>": "<口令>"}}'}
    return _bootstrap(passwords)
