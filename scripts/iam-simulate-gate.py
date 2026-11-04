#!/usr/bin/env python3
# @kf-batch 50-WP15-airflow-serverless(T-8)
# IAM 模拟门:平台 ECS TaskRole × 「平台真实调用清单」(infra/iam/platform-taskrole-calls.json)⇒ IAM SimulatePrincipalPolicy 离线模拟。
#
# 为什么存在:WP-15 一刀之内同一类缺陷三次 —— 代码用了的动作角色没给(T-2 iam:GetRole / T-7 codebuild:ListBuildsForProject),
#   以及 T-8「动作给了但资源模式错」(CreateWorkflow 在创建时按 workflow/* 评估,名字限定 bgp* 永不匹配)。
#   单测里的动作名守卫只能抓前一类;后一类只有拿**真实 ARN 形态**去问 IAM 才抓得到。模拟是离线的(不真调服务、零副作用、秒级),
#   所以放在每次平台栈部署之后(scripts/redeploy-platform.sh 第 4 步)与 sls 段 S-0:任何一条不是 allowed 就红,不许带着它收工。
#
# 用法:
#   python3 scripts/iam-simulate-gate.py --profile temp-account --home-region us-east-1 --regions us-east-1,us-west-2 [--probe-region <区>|none] [--role-arn …] [--json]
#   退出码 0 = 全 allowed;1 = 有真红(平台缺权 / 我方策略自己拒 / 模拟失败);2 = 用法或环境错误;
#          4 = 无真红,但有若干行**在本账号里验不了**(被账号所在组织的 SCP 拦住 ⛔;或 `--probe-region none` ⇒ any-region 轴没有探测区 ⚠️)。
#   `--probe-region none`(B-114,2026-10-22):放行清单已覆盖本账号能挑出的每一个区时由 redeploy-platform.sh 传入 ——
#          any-region 轴的调用只在 home 模拟(权限本身仍验),「放行集之外也 allowed」这一半记成未验、单独计数(`anyRegionUnverified`)并退 4;
#          **不是过关**,换到还有未放行区的账号复验。
#
# 🔴🔴 **三态,不是两态**(2026-09-19 用户点名:「不能永久拒绝某一个区域,因为这只是在现有临时账号
#   受到限制,后续别人的真实账号还是没有限制的。所以这个要注意。」):
#   本门原来把「账号所在组织的 SCP 拦住」和「平台自己缺权」混成同一种红 ⇒ 结论就会长成
#   「某个区永久不可用」,而那是**这个临时账号的属性,不是那个区的属性,更不是平台的属性**。
#   一旦沉淀成「永久拒」,换到没有该 SCP 的真实账号时没人会回头复验(记忆
#   `stale-blockers-must-be-reprobed`:「无载体/做不到/卡在X」的结论会过期)。
#   ⇒ 判别**只认 API 回的「谁拒的」,一个区域名都不认**(不许有任何 region 特例):
#     · `EvalDecision=allowed`                                        ⇒ ✅ 过
#     · `explicitDeny` + `OrganizationsDecisionDetail.AllowedByOrganizations=false`
#        且**我方策略一条都没命中**(MatchedStatements 空)              ⇒ ⛔ 本账号验不了(不算过、不算红)
#     · 其余任何非 allowed(含 implicitDeny / 我方策略自己 Deny / 模拟失败)⇒ ❌ 真红
#   ⛔ **绝不等于过关**:它单独计数、单独打印、进 JSON 摘要(`blocked`),收官门可以断言
#   「在不受 SCP 限制的账号里 blocked 必须为 0」。同一段代码换账号即自动复验,零特例。
import argparse, json, os, shutil, subprocess, sys  # nosec B404 —— 只以 argv 列表调用本机 aws CLI,不经 shell

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MANIFEST = os.path.join(REPO, "infra", "iam", "platform-taskrole-calls.json")
AWS = os.path.expanduser("~/.local/bin/aws") if os.path.exists(os.path.expanduser("~/.local/bin/aws")) else (shutil.which("aws") or "aws")


def aws(args, profile, region=None):
    cmd = [AWS] + args + ["--profile", profile, "--output", "json"]
    if region:
        cmd += ["--region", region]
    r = subprocess.run(cmd, capture_output=True, text=True)  # nosec B603 —— argv 列表、shell=False;参数来自仓内 IAM 清单与命令行,不含用户输入
    if r.returncode != 0:
        raise RuntimeError(f"aws {' '.join(args[:3])} 失败:{r.stderr.strip()[:400]}")
    return json.loads(r.stdout) if r.stdout.strip() else {}


def discover_task_role(profile, home_region, cluster):
    svcs = aws(["ecs", "list-services", "--cluster", cluster], profile, home_region).get("serviceArns") or []
    if not svcs:
        raise RuntimeError(f"ECS 集群 {cluster} 下没有服务(平台栈没部署?)")
    d = aws(["ecs", "describe-services", "--cluster", cluster, "--services", svcs[0]], profile, home_region)
    td = d["services"][0]["taskDefinition"]
    t = aws(["ecs", "describe-task-definition", "--task-definition", td], profile, home_region)
    role = t["taskDefinition"].get("taskRoleArn")
    if not role:
        raise RuntimeError(f"任务定义 {td} 没有 taskRoleArn")
    return role, td


def simulate(profile, role_arn, action, resource, context):
    args = ["iam", "simulate-principal-policy", "--policy-source-arn", role_arn, "--action-names", action, "--resource-arns", resource]
    entries = [f"ContextKeyName={k},ContextKeyValues={v},ContextKeyType=string" for k, v in context.items()]
    if entries:
        args += ["--context-entries"] + entries
    d = aws(args, profile, None)
    res = (d.get("EvaluationResults") or [{}])[0]
    decision = res.get("EvalDecision", "?")
    matched = [m.get("SourcePolicyId") for m in (res.get("MatchedStatements") or [])]
    missing = [str(m) for m in (res.get("MissingContextValues") or [])]  # 该字段是字符串列表(context key 名),不是对象
    return decision, matched, missing, org_blocked_of(res)


def org_blocked_of(res):
    """`SimulatePrincipalPolicy` 的**组织 SCP 裁决**(它确实会评估 SCP,结论单独放这个字段)。

    实测形状:`{"OrganizationsDecisionDetail": {"AllowedByOrganizations": false}}`,
    同时 `MatchedStatements` 为空 —— 也就是「我方策略一条都没参与裁决」。
    🔴 只认**显式的 False**:字段缺失 / null / 非字典一律回 False(不知道 ≠ 被组织拦)。
    """
    org = res.get("OrganizationsDecisionDetail")
    if not isinstance(org, dict):
        return False
    return org.get("AllowedByOrganizations") is False


def classify(decision, matched, org_blocked, err):
    """把一行的裁决分成三态:`ok` / `blocked`(本账号验不了)/ `red`。

    🔴 fail-closed 的三道收窄(防「⛔ 退化成万能免检」):
      ① 必须是 `explicitDeny` —— `implicitDeny`(我们没给权)不许借 SCP 遮掉;
      ② `AllowedByOrganizations` 必须**显式为 False** —— 字段缺失 / None 都算红(不知道 ≠ 被组织拦);
      ③ 我方策略**一条都不许命中** —— 一旦命中就说不清是谁拒的,按红处理。
      ④ 模拟本身失败(err)永远是红:不知道 ≠ 允许。
    """
    if err:
        return "red"
    if decision == "allowed":
        return "ok"
    if decision == "explicitDeny" and org_blocked and not matched:
        return "blocked"
    return "red"


PROBE_NONE = "none"  # `--probe-region none`:any-region 轴本次没有探测区可用(B-114)


def sim_regions_for(axis, probe_region, home_region, regions):
    """一条调用要在哪些 region 上模拟 ⇒ (region 列表, any-region 轴是否「未验」)。纯函数,离线判据直接打。

    · any-region(K-7,2026-09-08):必须在**放行集之外**也 allowed ⇒ [探测区, home];探测区 = none ⇒ 只打 home,
      「放行集之外」这一半标未验(调用方据此退 4,不许当成绿);
    · execution ⇒ 放行集每个区;其余(home 轴)⇒ 只 home。
    """
    if axis == "any-region":
        if probe_region == PROBE_NONE:
            return [home_region], True
        return [probe_region, home_region], False
    if axis == "execution":
        return list(regions), False
    return [home_region], False


def verdict_code(denied, blocked, unverified):
    """门的退出码:有真红 ⇒ 1;无真红但有行**本账号验不了**(SCP ⛔ 或 any-region 轴无探测区 ⚠️)⇒ 4;否则 0。

    🔴 「少验了几行」与「全验过」必须分开退(记忆 gate-must-separate-crash-from-fail):any-region 轴未验绝不许退 0。
    """
    if denied:
        return 1
    return 4 if (blocked or unverified) else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="temp-account")
    ap.add_argument("--home-region", default="us-east-1")
    ap.add_argument("--regions", default="us-east-1", help="执行 region 列表(含 home),逗号分隔")
    ap.add_argument("--probe-region", default="eu-central-1",
                    help="axis=any-region 用的探测 region:**故意不在 --regions 里**,用来证明那条权限没被区域条件挡住(K-7);"
                         "`none` = 本账号挑不出放行集之外的区(B-114)⇒ any-region 轴只在 home 验、单独记未验并退 4")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--role-arn", default=None)
    ap.add_argument("--json", action="store_true", help="末行输出 JSON 摘要(供验收脚本解析)")
    a = ap.parse_args()

    manifest = json.load(open(a.manifest))
    regions = [r for r in dict.fromkeys(x.strip() for x in a.regions.split(",")) if r]
    if a.home_region not in regions:
        regions.insert(0, a.home_region)
    acct = aws(["sts", "get-caller-identity"], a.profile)["Account"]
    # 🔴 探测 region 必须**在放行集之外**,否则 any-region 那几条等于没验(又一个「门禁自己有盲区」)
    if a.probe_region != PROBE_NONE and a.probe_region in regions:
        print(f"[iam-gate] ✗ --probe-region {a.probe_region} 落在 --regions 里 ⇒ any-region 轴等于没验;换一个不上线的 region", file=sys.stderr)
        return 1
    if a.probe_region == PROBE_NONE:
        print("[iam-gate] ⚠️ --probe-region none:any-region 轴本次没有放行集之外的探测区,这几条只在 home 验、「放行集之外也 allowed」记为未验(B-114)", file=sys.stderr)
    role_arn, td = (a.role_arn, "(given)") if a.role_arn else discover_task_role(a.profile, a.home_region, (manifest.get("principal") or {}).get("cluster", "bgp-cluster"))
    print(f"[iam-gate] TaskRole = …/{role_arn.rsplit('/', 1)[-1]}  任务定义 = {td.rsplit('/', 1)[-1]}  regions = {','.join(regions)}", file=sys.stderr)

    rows = []
    any_region_unverified = []  # B-114:探测区 = none 时 any-region 轴「放行集之外也 allowed」这一半没验的调用
    for c in manifest["calls"]:
        axis = c.get("axis", "execution")
        # 🆕 axis=any-region(K-7,2026-09-08):必须在**放行集之外**也 allowed ⇒ 用探测 region 打,
        #   否则「只在新区失效」的权限洞(EIP 预检)永远要等真用户在向导里撞到。
        sim_regions, unverified = sim_regions_for(axis, a.probe_region, a.home_region, regions)
        if unverified:
            any_region_unverified.append(c["action"])
            print(f"  ⚠️ {c['action']:<45} {'(any-region)':<10} 未验            放行集之外的探测区本账号挑不出(B-114)", file=sys.stderr)
        for region in sim_regions:
            resource = c["resource"].replace("{acct}", acct).replace("{region}", region).replace("{home}", a.home_region)
            ctx = {"aws:RequestedRegion": region}
            ctx.update(c.get("context") or {})
            try:
                decision, matched, missing, org_blocked = simulate(a.profile, role_arn, c["action"], resource, ctx)
                err = ""
            except Exception as e:  # 模拟本身失败也算红:不知道 ≠ 允许
                decision, matched, missing, org_blocked, err = "simulate-error", [], [], False, str(e)[:300]
            state = classify(decision, matched, org_blocked, err)
            rows.append({"action": c["action"], "region": region, "resource": resource, "decision": decision,
                         "matched": matched, "missing": missing, "error": err, "state": state,
                         "ok": state == "ok", "orgBlocked": org_blocked, "why": c.get("why", "")})
            mark = {"ok": "✅", "blocked": "⛔", "red": "❌"}[state]
            tail = "  ⟵ 账号所在组织的 SCP 拦住(本账号验不了,不是平台缺权)" if state == "blocked" else (("  ⟵ " + err) if err else "")
            print(f"  {mark} {c['action']:<45} {region:<10} {decision:<16} {resource[:110]}{tail}", file=sys.stderr)

    bad = [r for r in rows if r["state"] == "red"]
    blocked = [r for r in rows if r["state"] == "blocked"]
    # 🔴 「这条调用在**每一个**区都只拿到 ⛔」= 它整条从来没被验成过 —— 必须单独说,
    #    否则一条权限可以靠「在 home 绿、在别处 ⛔」看起来被覆盖了,而真正要验的正是别处。
    per_action = {}
    for r in rows:
        per_action.setdefault(r["action"], []).append(r["state"])
    never = sorted(k for k, v in per_action.items() if "ok" not in v and "blocked" in v)
    summary = {"roleArn": role_arn, "regions": regions, "probeRegion": a.probe_region, "total": len(rows), "denied": len(bad),
               "blocked": len(blocked), "neverVerified": never, "anyRegionUnverified": any_region_unverified, "bad": bad, "blockedRows": blocked}
    print(f"[iam-gate] {len(rows) - len(bad) - len(blocked)}/{len(rows)} allowed;"
          f"{len(bad)} 条真红;{len(blocked)} 条本账号验不了(组织 SCP);{len(any_region_unverified)} 条 any-region 轴未验(无探测区)", file=sys.stderr)
    if any_region_unverified:
        print(f"[iam-gate] ⚠️ any-region 轴 {len(any_region_unverified)} 条调用只在 home 验过、「放行集之外也 allowed」这一半本账号没验成:{any_region_unverified}"
              f" —— 🔴 不等于过关;放行清单已覆盖本账号能挑出的每一个区(B-114),换到还有未放行区的账号重跑本门复验", file=sys.stderr)
    if blocked:
        regs = sorted({r["region"] for r in blocked})
        # ══════════════════════════════════════════════════════════════════════
        # 🔴🔴 **绝不许把它说成「这个 region 验不了」。**(2026-09-21 用户追问「你在逃避什么」
        #   之后用**真实调用**实测坐实,原来那句措辞是错的。)
        #
        # 铁证(真实 API 调用,不是模拟器;三条互为对照):
        #   ① `kinesis:GetShardIterator` @eu-west-1 ⇒ AccessDeniedException
        #      「... **with an explicit deny in a service control policy**: .../p-20cbg4vo」
        #      ⇒ 确实是**组织层 SCP**,不是平台缺权(这一半原来说对了);
        #   ② `logs:DescribeLogStreams` @eu-west-1 ⇒ **ResourceNotFoundException**
        #      ⇒ **权限是通的**,只是资源不存在 —— 同一个区、同一个服务;
        #   ③ `logs:FilterLogEvents` @eu-west-1 ⇒ AccessDeniedException(同样是 SCP)。
        #
        # ⇒ SCP 是**按 action 白名单**放行的,**不是把某个区整块封掉**。
        #   写成「region 验不了」会让下一个人以为那个区不能用,而事实是「那个区的这 N 个
        #   action 不能用」—— 这两句话对「第三个区能不能上」给出**完全相反**的结论。
        #   (记忆 `one-denied-action-is-not-a-blocked-path`:逐个 action 量,常常只有一个被拦。)
        #
        # ⇒ 摘要必须**按服务打出同区 allowed/denied 对照**:那个对照本身就是判别证据 ——
        #   有放行的行 = 不是整区被封;`0 放行` = 这个**服务**在该区真的整块不可用(这才是决策要的)。
        # ══════════════════════════════════════════════════════════════════════
        for reg in regs:
            svc_ok: dict[str, int] = {}
            svc_no: dict[str, int] = {}
            for r in rows:
                if r["region"] != reg:
                    continue
                svc = r["action"].split(":")[0]
                if r["state"] == "blocked":
                    svc_no[svc] = svc_no.get(svc, 0) + 1
                elif r["state"] == "ok":
                    svc_ok[svc] = svc_ok.get(svc, 0) + 1
            print(f"[iam-gate] ⛔ {reg}:被**组织 SCP**拦住 {sum(svc_no.values())} 个 action"
                  f"(同区放行 {sum(svc_ok.values())} 个)。🔴 这**不是**「{reg} 不可用」——"
                  f"SCP 是按 action 白名单,逐服务对照如下:", file=sys.stderr)
            for svc in sorted(svc_no):
                ok_n = svc_ok.get(svc, 0)
                flag = "  ⟵ 🔴 **这个服务在该区整块不可用**" if ok_n == 0 else ""
                print(f"           · {svc:<20} 放行 {ok_n:>2} / 被拦 {svc_no[svc]:>2}{flag}", file=sys.stderr)
        print(f"[iam-gate] 🔴 换到没有该 SCP 的账号必须复验(⛔ 不等于过关);"
              f"判「某个区能不能上线」要看**被拦的那些 action 里有哪些是必需的**,不是看这个区有没有 ⛔",
              file=sys.stderr)
        if never:
            print(f"[iam-gate] ⛔ 其中 {len(never)} 条调用在**所有**模拟 region 上都没验成:{never}", file=sys.stderr)
    if a.json:
        print(json.dumps(summary, ensure_ascii=False))
    return verdict_code(bool(bad), bool(blocked), bool(any_region_unverified))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as e:
        print(f"[iam-gate] 环境错误:{e}", file=sys.stderr)
        sys.exit(2)
