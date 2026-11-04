// @kf-batch 50-WP31-place-first-class
// WP-31 序 4(L6)—— **PlaceWire v1 的 Python 读取函数**(形状见 platform/place-wire.schema.json)。
//
// 单一作者:这一段 Python 源被**原样**嵌进两个 Python 运行时 ——
//   ④ MWAA Serverless 调度运行时(lib/scheduler/serverless/runtime-py.ts 的 bgp_runtime.py)
//   ⑤ Spark 脚本(lib/sync/glue-script-generator.ts 生成的 Glue 同步脚本)
// JS 三个运行时(平台 / AgentCore 容器 / 技能 Lambda)读的是 lib/genbi/core/place-wire.ts。
// 契约测试(lib/place/__tests__/place-wire-contract.test.ts)把**同一组夹具**喂给 TS 与 Python(真跑 python3,
// 且 Python 源从两个运行时的**生成产物**里抠出来跑,不是从这里直接拿)⇒ 五者同夹具同结果。
//
// 与 JS 版逐条对齐的细节(都有夹具钉着):
//   · 校验顺序相同 ⇒ 第一处错误的 JSON 路径相同;
//   · `re.ASCII` + 有 `$` 的模式用 fullmatch:Python 的 `$` 会匹配结尾换行前、`\d` 默认认 Unicode 数字,JS 都不会;
//   · `v` 只认数值 1(1.0 也算,JS 的 JSON.parse 同样把 1.0 读成 1),布尔 true 不算(Python 里 True == 1)。
import {
  PLACE_WIRE_REGION_PATTERN,
  PLACE_WIRE_S3_LOCATION_PATTERN,
  PLACE_WIRE_SECRET_ARN_PATTERN,
  PLACE_WIRE_TARGET_ID_PATTERN,
} from "@/lib/genbi/core/place-wire";

/** Python 字面量里的正则(r"" 原样;本文件的四个模式都不含双引号)。 */
const py = (p: string) => `r"${p}"`;

export const PLACE_WIRE_PY = `
# ── PlaceWire v1 读取函数(WP-31 L6;单一作者 = platform/src/lib/place/wire-py.ts,勿手改)─────────
import json as _pw_json
import re as _pw_re


class BgpPlaceWireInvalid(Exception):
    def __init__(self, path, why):
        Exception.__init__(self, "PLACE_WIRE_INVALID " + path + " " + why)
        self.path = path


_PW_TARGET_ID = ${py(PLACE_WIRE_TARGET_ID_PATTERN)}
_PW_REGION = ${py(PLACE_WIRE_REGION_PATTERN)}
_PW_SECRET_ARN = ${py(PLACE_WIRE_SECRET_ARN_PATTERN)}
_PW_S3_LOCATION = ${py(PLACE_WIRE_S3_LOCATION_PATTERN)}


def _pw_test(pattern, s):
    if pattern.endswith("$"):
        return _pw_re.fullmatch(pattern[1:-1] if pattern.startswith("^") else pattern[:-1], s, _pw_re.ASCII) is not None
    return _pw_re.match(pattern, s, _pw_re.ASCII) is not None


def _pw_only(o, allowed, at):
    for k in o.keys():
        if k not in allowed:
            raise BgpPlaceWireInvalid(at + "." + k, "unknown")


def _pw_str(o, k, at, pattern=None, min_length=None):
    if k not in o:
        raise BgpPlaceWireInvalid(at + "." + k, "missing")
    v = o[k]
    if not isinstance(v, str):
        raise BgpPlaceWireInvalid(at + "." + k, "not-string")
    if min_length is not None and len(v) < min_length:
        raise BgpPlaceWireInvalid(at + "." + k, "empty")
    if pattern is not None and not _pw_test(pattern, v):
        raise BgpPlaceWireInvalid(at + "." + k, "pattern")
    return v


def bgp_read_place(raw):
    """读一个 PlaceWire(dict 或其 JSON 文本)⇒ 归一后的新 dict;不合法 ⇒ BgpPlaceWireInvalid(没有任何缺省值)。"""
    o = raw
    if isinstance(raw, str):
        try:
            o = _pw_json.loads(raw)
        except Exception:
            raise BgpPlaceWireInvalid("$", "json")
    if not isinstance(o, dict):
        raise BgpPlaceWireInvalid("$", "not-object")
    _pw_only(o, ("v", "targetId", "region", "redshift", "athena"), "$")
    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != 1:
        raise BgpPlaceWireInvalid("$.v", "not-1")
    out = {"v": 1}
    out["targetId"] = _pw_str(o, "targetId", "$", pattern=_PW_TARGET_ID)
    out["region"] = _pw_str(o, "region", "$", pattern=_PW_REGION)
    if "redshift" in o:
        r = o["redshift"]
        if not isinstance(r, dict):
            raise BgpPlaceWireInvalid("$.redshift", "not-object")
        _pw_only(r, ("workgroup", "database", "secretArn"), "$.redshift")
        leg = {
            "workgroup": _pw_str(r, "workgroup", "$.redshift", min_length=1),
            "database": _pw_str(r, "database", "$.redshift", min_length=1),
        }
        if "secretArn" in r:
            leg["secretArn"] = _pw_str(r, "secretArn", "$.redshift", pattern=_PW_SECRET_ARN)
        out["redshift"] = leg
    if "athena" in o:
        a = o["athena"]
        if not isinstance(a, dict):
            raise BgpPlaceWireInvalid("$.athena", "not-object")
        _pw_only(a, ("workgroup", "outputLocation", "catalogRef"), "$.athena")
        out["athena"] = {
            "workgroup": _pw_str(a, "workgroup", "$.athena", min_length=1),
            "outputLocation": _pw_str(a, "outputLocation", "$.athena", pattern=_PW_S3_LOCATION),
            "catalogRef": _pw_str(a, "catalogRef", "$.athena", min_length=1),
        }
    return out


def bgp_place_leg(place, leg):
    """取某条腿;落点里没有 ⇒ 拒(不回落)。"""
    v = place.get(leg)
    if not v:
        raise BgpPlaceWireInvalid("$." + leg, "missing-leg")
    return v
# ── PlaceWire v1 读取函数 结束 ─────────────────────────────────────────────────────────
`;

/** 契约测试从生成产物里抠函数时用的两条界线(产物里必须原样出现)。 */
export const PLACE_WIRE_PY_BEGIN = "# ── PlaceWire v1 读取函数(WP-31 L6;";
export const PLACE_WIRE_PY_END = "# ── PlaceWire v1 读取函数 结束";
