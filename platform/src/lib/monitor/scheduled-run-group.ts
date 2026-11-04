// @kf-batch 50-WP5-rungroup
// 定时触发的**确定性**组键 `rgs_<sha256 前 24 hex>`(50 SPEC v3.44 §3.17.2)。
//
// 🔴 各区**各自算**、互不通信:同一个定义 + 同一个 cron 槽位 ⇒ 同一个 id ⇒ N 条 run 归一组。
// 🔴 输入里**刻意不含 `definitionVersion`**:它是 per-target 下发台账状态
//    (`deployments[targetId].version`),一个区发布失败后单独重发就会两区不同版本 ⇒
//    进键会把同一次触发**拆成两个单子组**。版本差要**在组里可见**(`accepted[t].definitionVersion`),
//    不该改变组的身份。
// 🔴 Python 孪生由本文件 `pythonScheduledRunGroupSource()` **唯一产出**;parity 单测真的跑一遍
//    python3 并逐字节比对两侧输出(与 `pythonStampFields` / 运行锁 parity 同款)。
import { createHash } from "node:crypto";
import { SCHEDULED_RUN_GROUP_PREFIX } from "./run-group";
import { cronSlotIso, CRON_SLOT_HORIZON_DAYS } from "./cron-slot";

/** 摘要取前多少个 hex —— 两侧同一个常量(改一侧就会 parity 红)。 */
export const SCHEDULED_RUN_GROUP_HEX = 24;
/** 规范串的分隔符:`\n` 不可能出现在 kind / id / iso 里,所以不需要转义。 */
export const SCHEDULED_RUN_GROUP_SEP = "\n";

/** 规范串(两侧逐字节一致) —— 单独导出是为了让 parity 单测能分段定位差异。 */
export function scheduledRunGroupCanonical(definitionKind: string, definitionId: string, slotIso: string): string {
  for (const [name, v] of [["definitionKind", definitionKind], ["definitionId", definitionId], ["slotIso", slotIso]] as const) {
    if (!v || v.includes(SCHEDULED_RUN_GROUP_SEP)) {
      throw new Error(`scheduledRunGroupCanonical:${name} 为空或含分隔符 ⇒ 拒绝生成键(${JSON.stringify(v)})`);
    }
  }
  return [definitionKind, definitionId, slotIso].join(SCHEDULED_RUN_GROUP_SEP);
}

export function scheduledRunGroupIdFromSlot(definitionKind: string, definitionId: string, slotIso: string): string {
  const hex = createHash("sha256").update(scheduledRunGroupCanonical(definitionKind, definitionId, slotIso), "utf8").digest("hex");
  return `${SCHEDULED_RUN_GROUP_PREFIX}${hex.slice(0, SCHEDULED_RUN_GROUP_HEX)}`;
}

/** 完整口径:cron + 触发时刻 ⇒ 组键。 */
export function scheduledRunGroupId(args: {
  definitionKind: string;
  definitionId: string;
  cron: string;
  at: Date;
}): string {
  return scheduledRunGroupIdFromSlot(args.definitionKind, args.definitionId, cronSlotIso(args.cron, args.at));
}

/**
 * 注入到生成式 DAG 里的 Python 孪生。**唯一作者 = 本函数**。
 *
 * 约定:生成侧把 `definitionKind` / `definitionId` / `cron` 作为常量注进 spec,
 * 运行期调 `_scheduled_run_group_id(kind, def_id, cron, time.time())`。
 * 🔴 算不出来就**抛**(不生成一个「没有组」的定时 run —— 那批 run 会永远归不了组)。
 */
export function pythonScheduledRunGroupSource(): string {
  return `# --- 由 lib/monitor/scheduled-run-group.ts 唯一产出,请勿手改 ---
# 定时触发的确定性组键(50 SPEC v3.44 §3.17.2)。各区各自算、互不通信。
# 🔴 刻意不用 Airflow 的 run_id / logical_date:MWAA Serverless 下它退化成常量,
#    拿它当分组时间会把所有历次定时归进同一个组(而且那个组永不终态)。
_CRON_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
_CRON_SLOT_HORIZON_DAYS = ${CRON_SLOT_HORIZON_DAYS}
_RGS_HEX = ${SCHEDULED_RUN_GROUP_HEX}


def _cron_field(raw, idx, expr):
    lo, hi = _CRON_RANGES[idx]
    vals = set()
    for part in raw.split(","):
        bits = part.split("/")
        spec = bits[0]
        if len(bits) > 2:
            raise Exception("cron 表达式非法(字段非法 %s):%s" % (part, expr))
        step = 1
        if len(bits) == 2:
            if not bits[1].isdigit():
                raise Exception("cron 表达式非法(步长非法 %s):%s" % (part, expr))
            step = int(bits[1])
        if step < 1:
            raise Exception("cron 表达式非法(步长必须 >=1 %s):%s" % (part, expr))
        if spec == "*":
            frm, to = lo, hi
        elif spec.isdigit():
            frm = int(spec)
            to = frm if len(bits) == 1 else hi
        else:
            seg = spec.split("-")
            if len(seg) != 2 or not seg[0].isdigit() or not seg[1].isdigit():
                raise Exception("cron 表达式非法(字段非法 %s):%s" % (part, expr))
            frm, to = int(seg[0]), int(seg[1])
        if idx == 4:
            if frm == 7:
                frm = 0
            if to == 7:
                to = 0
        if frm < lo or to > hi or frm > to:
            raise Exception("cron 表达式非法(越界或反向 %s):%s" % (part, expr))
        v = frm
        while v <= to:
            vals.add(v)
            v += step
    if not vals:
        raise Exception("cron 表达式非法(字段解析出空集 %s):%s" % (raw, expr))
    return vals, raw == "*"


def _cron_parse(expr):
    parts = [p for p in str(expr or "").strip().split() if p]
    if len(parts) != 5:
        raise Exception("cron 表达式非法(必须是 5 段,收到 %d 段):%s" % (len(parts), expr))
    return [_cron_field(p, i, expr) for i, p in enumerate(parts)]


def _cron_matches(fields, tm):
    (mins, _), (hours, _), (doms, dom_any), (mons, _), (dows, dow_any) = fields
    if tm.tm_min not in mins:
        return False
    if tm.tm_hour not in hours:
        return False
    if tm.tm_mon not in mons:
        return False
    # time.gmtime 的 tm_wday:周一=0…周日=6;cron 的周:周日=0 ⇒ 换算
    wday = (tm.tm_wday + 1) % 7
    dom_hit = tm.tm_mday in doms
    dow_hit = wday in dows
    if dom_any and dow_any:
        return True
    if dom_any:
        return dow_hit
    if dow_any:
        return dom_hit
    # 🔴 日 / 周两个字段是「或」(Vixie cron 既定语义),必须与 TS 侧逐字一致
    return dom_hit or dow_hit


def _cron_slot_iso(expr, at_epoch):
    fields = _cron_parse(expr)
    ts = int(at_epoch // 60) * 60
    for _ in range(_CRON_SLOT_HORIZON_DAYS * 24 * 60 + 1):
        tm = time.gmtime(ts)
        if _cron_matches(fields, tm):
            return time.strftime("%Y-%m-%dT%H:%M:%SZ", tm)
        ts -= 60
    raise Exception("往回 %d 天都没有匹配 %s 的触发点 ⇒ 拒绝猜一个时间" % (_CRON_SLOT_HORIZON_DAYS, expr))


def _scheduled_run_group_id(definition_kind, definition_id, cron, at_epoch):
    slot = _cron_slot_iso(cron, at_epoch)
    for name, v in (("definitionKind", definition_kind), ("definitionId", definition_id), ("slotIso", slot)):
        if not v or "\\n" in v:
            raise Exception("确定性组键:%s 为空或含分隔符 ⇒ 拒绝生成(%r)" % (name, v))
    canonical = "\\n".join([definition_kind, definition_id, slot])
    return "${SCHEDULED_RUN_GROUP_PREFIX}" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:_RGS_HEX]
# --- end ---`;
}
