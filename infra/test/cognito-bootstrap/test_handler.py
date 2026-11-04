"""bgp-cognito-bootstrap 的**离线真跑**替身(prod-only-layers 的 harness)。

🔴 为什么必须有它:路径C(CFN 自定义资源)是一层「只有真部署才会执行的代码」——
它一旦不回响应,CloudFormation 会**挂满一小时**才失败;一旦静默成功,就变成「栈全绿而没有用户」。
这两种坏法 tsc / synth / 任何 TS 单测都看不见。所以这里用假 boto3 + 假 urlopen,把每条出口真跑一遍。

🔴 放在 `infra/test/` 而不是函数目录里:函数目录是 `lambda.Code.fromAsset` 的打包源,
   测试代码不该被打进上线产物。

跑法:`python3 -m unittest discover -s infra/test/cognito-bootstrap -p 'test_*.py'`
(平台侧 vitest `cognito-bootstrap-cfn.test.ts` 会把它接进常规门禁,免得它自己变成没人跑的一层)
"""
import importlib
import io
import json
import os
import sys
import types
import unittest
from contextlib import redirect_stdout

# 别在被测函数目录里留 __pycache__(那个目录是 lambda 的打包源)
sys.dont_write_bytecode = True

FN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lambda", "cognito-bootstrap")

ROSTER = {
    "admin": "bgp-admin",
    "pm-tester": "bgp-manager",
    "rbac-tester": "bgp-developer",
    "ops-analyst": "bgp-analyst",
    "biz-tester": "",
}
FULL_PW = {u: f"Pw-{u}-9!aA" for u in ROSTER}
SECRET_MARK = "Pw-admin-9!aA"


class _UserNotFound(Exception):
    pass


class _GroupExists(Exception):
    pass


class FakeIdp:
    def __init__(self):
        self.calls = []
        self.users = {}
        self.groups = set()
        self.exceptions = types.SimpleNamespace(
            UserNotFoundException=_UserNotFound, GroupExistsException=_GroupExists
        )
        self.fail_on_set_password = False

    def create_group(self, **kw):
        self.calls.append(("create_group", kw["GroupName"]))
        if kw["GroupName"] in self.groups:
            raise _GroupExists()
        self.groups.add(kw["GroupName"])

    def admin_get_user(self, **kw):
        self.calls.append(("admin_get_user", kw["Username"]))
        if kw["Username"] not in self.users:
            raise _UserNotFound()
        return {"UserStatus": self.users[kw["Username"]]}

    def admin_create_user(self, **kw):
        self.calls.append(("admin_create_user", kw["Username"]))
        self.users[kw["Username"]] = "FORCE_CHANGE_PASSWORD"

    def admin_set_user_password(self, **kw):
        self.calls.append(("admin_set_user_password", kw["Username"]))
        if self.fail_on_set_password:
            raise RuntimeError("boom from cognito")
        self.users[kw["Username"]] = "CONFIRMED"

    def admin_add_user_to_group(self, **kw):
        self.calls.append(("admin_add_user_to_group", kw["Username"], kw["GroupName"]))


class FakeSsm:
    def __init__(self, value=None, raise_on_get=False):
        self.value = value
        self.raise_on_get = raise_on_get
        self.calls = []

    def get_parameter(self, **kw):
        self.calls.append(("get_parameter", kw["Name"], kw.get("WithDecryption")))
        if self.raise_on_get:
            raise RuntimeError("ParameterNotFound")
        return {"Parameter": {"Value": self.value}}

    def delete_parameter(self, **kw):
        self.calls.append(("delete_parameter", kw["Name"]))


def load_module(idp, ssm, sent):
    """装好假 boto3 / 假 urlopen 之后**重新导入**被测模块(它在导入期就建客户端)。"""
    fake_boto3 = types.ModuleType("boto3")

    def client(name, *_a, **_k):
        return {"cognito-idp": idp, "ssm": ssm}[name]

    fake_boto3.client = client
    sys.modules["boto3"] = fake_boto3
    os.environ["USER_POOL_ID"] = "pool-test"
    os.environ["ROSTER_JSON"] = json.dumps(ROSTER)
    os.environ["BOOTSTRAP_ALLOW_RESET"] = "0"
    if FN_DIR not in sys.path:
        sys.path.insert(0, FN_DIR)
    sys.modules.pop("index", None)
    mod = importlib.import_module("index")

    class FakeResp:
        def read(self):
            return b""

    def fake_urlopen(req, timeout=None):
        sent.append({"url": req.full_url, "body": json.loads(req.data.decode("utf-8"))})
        return FakeResp()

    mod.urllib.request.urlopen = fake_urlopen
    return mod


def cfn_event(request_type="Create", param="/bgp/bootstrap-passwords"):
    return {
        "RequestType": request_type,
        "ResponseURL": "https://cfn.example/resp",
        "StackId": "stack/abc",
        "RequestId": "req-1",
        "LogicalResourceId": "CognitoBootstrapRun",
        "ResourceProperties": {"PasswordsSsmParameter": param, "RosterVersion": json.dumps(ROSTER)},
    }


class CfnPathTests(unittest.TestCase):
    def run_cfn(self, *, ssm, event=None, fail_password=False):
        idp = FakeIdp()
        idp.fail_on_set_password = fail_password
        sent = []
        mod = load_module(idp, ssm, sent)
        buf = io.StringIO()
        raised = None
        with redirect_stdout(buf):
            try:
                mod.handler(event or cfn_event(), None)
            except Exception as e:  # noqa: BLE001
                raised = e
        return idp, ssm, sent, buf.getvalue(), raised

    def test_create_ok_and_param_deleted(self):
        idp, ssm, sent, out, raised = self.run_cfn(ssm=FakeSsm(json.dumps(FULL_PW)))
        self.assertIsNone(raised)
        self.assertEqual(len(sent), 1, "必须恰好回一次响应")
        self.assertEqual(sent[0]["body"]["Status"], "SUCCESS", sent[0]["body"]["Reason"])
        self.assertEqual(sorted(idp.users), sorted(ROSTER))
        self.assertEqual(idp.groups, {g for g in ROSTER.values() if g})
        self.assertIn(("delete_parameter", "/bgp/bootstrap-passwords"), ssm.calls)
        self.assertEqual(sent[0]["body"]["Data"]["passwordParamDeleted"], "yes")
        # 🔴 口令绝不出现在任何输出里(日志 / 响应)
        self.assertNotIn(SECRET_MARK, out)
        self.assertNotIn(SECRET_MARK, json.dumps(sent[0]["body"]))

    def test_param_missing_is_loud_failure_and_touches_nothing(self):
        idp, _ssm, sent, _out, raised = self.run_cfn(ssm=FakeSsm(raise_on_get=True))
        self.assertIsNone(raised)
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")
        self.assertIn("/bgp/bootstrap-passwords", sent[0]["body"]["Reason"])
        self.assertEqual(idp.calls, [], "取不到口令时一个 cognito 调用都不许发")

    def test_partial_roster_refused(self):
        idp, _ssm, sent, _out, _r = self.run_cfn(ssm=FakeSsm(json.dumps({"admin": FULL_PW["admin"]})))
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")
        self.assertIn("pm-tester", sent[0]["body"]["Reason"])
        self.assertEqual(idp.calls, [], "名册不全时不许先建一半")

    def test_empty_json_is_failure_not_vacuous_success(self):
        idp, _ssm, sent, _out, _r = self.run_cfn(ssm=FakeSsm("{}"))
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")
        self.assertEqual(idp.calls, [])

    def test_delete_is_noop_success(self):
        idp, ssm, sent, _out, _r = self.run_cfn(ssm=FakeSsm(json.dumps(FULL_PW)), event=cfn_event("Delete"))
        self.assertEqual(sent[0]["body"]["Status"], "SUCCESS")
        self.assertEqual(idp.calls, [], "删栈不许删用户")
        self.assertEqual(ssm.calls, [], "删栈不许去读口令")

    def test_unexpected_exception_still_responds(self):
        _idp, _ssm, sent, _out, raised = self.run_cfn(ssm=FakeSsm(json.dumps(FULL_PW)), fail_password=True)
        self.assertIsNotNone(raised, "异常要继续抛出去(留 CloudWatch 栈)")
        self.assertEqual(len(sent), 1, "但 FAILED 必须已经送出:不回响应 = CFN 挂一小时")
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")

    def test_missing_property_is_failure(self):
        ev = cfn_event()
        ev["ResourceProperties"] = {}
        idp, _ssm, sent, _out, _r = self.run_cfn(ssm=FakeSsm(json.dumps(FULL_PW)), event=ev)
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")
        self.assertEqual(idp.calls, [])

    def test_cfn_refuses_out_of_roster_user(self):
        idp, _ssm, sent, _out, _r = self.run_cfn(
            ssm=FakeSsm(json.dumps({**FULL_PW, "attacker": "Pw!12345678"}))
        )
        self.assertEqual(sent[0]["body"]["Status"], "FAILED")
        self.assertIn("attacker", sent[0]["body"]["Reason"])
        self.assertNotIn("attacker", idp.users)


class DirectInvokePathUnchangedTests(unittest.TestCase):
    """路径B(直连 invoke)必须**逐字不变** —— 加路径C 不许动它。"""

    def test_direct_invoke_still_bootstraps(self):
        idp, ssm, sent = FakeIdp(), FakeSsm(), []
        mod = load_module(idp, ssm, sent)
        out = mod.handler({"passwords": FULL_PW}, None)
        self.assertTrue(out["ok"])
        self.assertEqual(sorted(idp.users), sorted(ROSTER))
        self.assertEqual(sent, [], "直连路径不该回 CFN 响应")
        self.assertEqual(ssm.calls, [], "直连路径不该碰 ssm")

    def test_direct_invoke_rejects_unknown_user(self):
        idp, ssm, sent = FakeIdp(), FakeSsm(), []
        mod = load_module(idp, ssm, sent)
        out = mod.handler({"passwords": {"attacker": "Pw!12345678"}}, None)
        self.assertIn("refused", out["users"]["attacker"])
        self.assertEqual(idp.users, {})

    def test_direct_invoke_empty_payload_is_refused(self):
        idp, ssm, sent = FakeIdp(), FakeSsm(), []
        mod = load_module(idp, ssm, sent)
        out = mod.handler({"passwords": {}}, None)
        self.assertFalse(out["ok"])
        self.assertEqual(idp.calls, [], "空 payload 不许「成功地什么都不做」")


if __name__ == "__main__":
    unittest.main()
