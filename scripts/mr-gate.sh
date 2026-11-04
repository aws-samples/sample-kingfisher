#!/usr/bin/env bash
# 多 region 硬门 —— **一条命令走完:部署 → 无头验收全部多 region 功能 → 盖章**。
#
# 🔴 规矩(用户 2026-09-04 立):每完成一个功能,必须部署到指定 AWS 临时环境并**立刻**用无头浏览器
#    验收;**已上线的全部多 region 功能一起过**才算过关;不过关不许开下一刀。
#    本脚本就是那条规矩的可执行形态 —— 别再手工挑几个脚本跑然后说"验收通过"。
#
# 用法(2026-09-11 起 **profile 模式**:用户用 `aws configure --profile temp-account` 配长期凭证):
#   bash scripts/mr-gate.sh                # 部署 + 全量验收 + 盖章
#   🔴 不要再 source /tmp/kf-creds-new.env 取凭证 —— 环境变量会**盖掉** --profile;
#      那个文件现在的内容是「主动 unset 三个 AWS_* 变量」,专门用来防这件事。
#   bash scripts/mr-gate.sh --no-deploy    # 只验收(现网已是当前 HEAD 时用)
#
# 盖章文件 `.claude/mr-gate-stamp.json` 记 {sha, tree, result, at};Stop hook 读它判断能不能收工。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
STAMP="$REPO/.claude/mr-gate-stamp.json"
# 主账号 profile:缺省 temp-account;可用 KF_PROFILE 指到另一台**临时** demo 账号(验收入口 verify_mr_all / vlib 早就按
# KF_PROFILE 选账号,门自己写死主账号会让「主账号正被人用」时整条硬门挪不动;跨法域账号仍由 qa-game/verify/xjur-account.json 点名)。
PROFILE="${KF_PROFILE:-temp-account}"
REGION="us-east-1"
DEPLOY=1
[[ "${1:-}" == "--no-deploy" ]] && DEPLOY=0

say() { printf "\033[1;36m== %s ==\033[0m\n" "$*"; }
die() { printf "\033[1;31m✗ %s\033[0m\n" "$*"; exit 1; }

# ── 0) 账号安全断言(绝不碰本机默认账号)──
say "0) 账号安全断言(必须是 $PROFILE)"
ACCT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text 2>/dev/null) \
  || die "拿不到 $PROFILE 的身份 —— 凭证可能已过期。先 set -a; . /tmp/kf-creds-new.env; set +a"
# 🔴 **这里刻意不写任何账号号字面量**(redline-scan 会拦,而且它拦对了:真实账号号不得进受跟踪文件)。
# "绝不碰本机默认账号"这条由两处保证:① 全程只用 --profile "$PROFILE";
# ② 每个验收脚本开头都跑 `vlib.assert_safe_account(env)`(它按 /tmp 下的口令文件比对期望账号)。
# 需要额外本机保险时,把禁用账号放进环境变量 KF_FORBIDDEN_ACCOUNT(不进仓)。
if [[ -n "${KF_FORBIDDEN_ACCOUNT:-}" && "$ACCT" == "${KF_FORBIDDEN_ACCOUNT}" ]]; then
  die "🔴 当前账号命中 KF_FORBIDDEN_ACCOUNT,绝不允许在它上面部署/验收"
fi
echo "   account=$ACCT profile=$PROFILE"

# ── 1) HEAD 必须已 push(部署的必须是可追溯的提交)──
say "1) HEAD 已 push 断言"
BR=$(git rev-parse --abbrev-ref HEAD)
LOCAL=$(git rev-parse HEAD)
git fetch -q origin "$BR" || true
REMOTE=$(git rev-parse "origin/$BR" 2>/dev/null || echo "")
[[ "$LOCAL" == "$REMOTE" ]] || die "HEAD($LOCAL) 与 origin/$BR($REMOTE) 不一致 —— 先提交并 push 再部署"
DIRTY=$(git status --porcelain platform/src infra scripts | grep -v '^??' || true)
[[ -z "$DIRTY" ]] || die "产品代码有未提交改动 —— 部署与验收必须对应一个确定的提交:
$DIRTY"
echo "   $BR @ $LOCAL(与远端一致、工作树干净)"

# 🔴🔴 **运行期指纹**(2026-09-04 补,本门自己的一个真洞):`redeploy-platform.sh` 的镜像是从
# **工作树**(整个 `platform/`)构建的,不是从 git 检出。上面那次干净检查只发生在**开工那一刻** ——
# 若在 docker build 或验收过程中改了产品代码,部署出去的就是**一个不对应任何提交的混合体**
# (实测吃过一次:镜像带了改动 A、没带改动 B,于是"验收结果"既不是 HEAD 也不是工作树)。
# ⇒ 记下运行期指纹,**部署前**与**盖章前**各核一次;变了就拒绝盖章。
runtime_fp() { git -c core.fileMode=false diff --no-ext-diff HEAD -- platform infra scripts | sha256sum | cut -c1-16; }
FP0=$(runtime_fp)

# ── 2) 本地门禁(快,先挡住明显问题,别把 10 分钟部署浪费在 tsc 报错上)──
say "2) 本地门禁(tsc / vitest / naming-parity / synth-gate)"
( cd platform && npx tsc --noEmit ) || die "platform tsc 未过"
( cd platform && npx vitest run ) || die "vitest 未过"
( cd platform && node scripts/naming-parity.mjs >/dev/null ) || die "naming-parity 未过"
( cd infra && npx tsc --noEmit ) || die "infra tsc 未过"
( cd infra && npm run synth-gate >/dev/null ) || die "synth-gate 未过"

# ── 2b) 🔴 **验收脚本自己也要过静态门**(2026-09-07 第二跑血的教训)──
# 那一跑里 **w3f 与 w5a 两整段没有任何结果**,不是产品坏了,是我写的夹具代码在真环境第一次执行时才炸:
#   ① `rc, _, err = aws(...)` 而那个 helper 回的是两元组 ⇒ ValueError;② 证据串里引用了一个没定义的 `errd` ⇒ NameError。
# 两段各跑了 2 分钟 / 16 分钟才崩,而 **ruff 3 秒就能报出第 ②**(F821 未定义名 / F811 重复定义 / F823 先用后赋)。
# 「门禁自己有盲区」的老病(见 qa-game 记忆 verify-script-quality-lesson):量具不受检,就会用坏量具去量产品。
RUFF="${RUFF:-$HOME/.local/bin/ruff}"
if [[ -d "$REPO/qa-game/verify" ]]; then
  say "2b) 验收脚本静态门(ruff F821/F811/F823 —— 未定义名一律拦)"
  [[ -x "$RUFF" ]] || die "找不到 ruff($RUFF)—— 缺什么装什么:pip install --user ruff(或设 RUFF=<路径>)"
  "$RUFF" check --select F821,F811,F823 --no-cache "$REPO/qa-game/verify" \
    || die "验收脚本静态门未过 —— 先修上面这些(它们会让**整段**验收无结果,而不是红一条)"
fi

# ── 2b-2) 🔴🔴 **验收脚本不许自造执行环境描述符**(2026-09-20,用户第 N 次点名)──
# 用户原话:「一个区域只能有一个执行区域,我说了 N 次了」。这条规矩早就做成**产品守卫**
# (`registerTarget` → 409 `region-already-has-environment`),可两个段**直写 DynamoDB 绕过了它**:
#   · `o1` 的:put-item 一条 `region=us-west-2` 的假描述符 —— 而那个区已有 `tgt_usw2_a`;
#   · `gbc` 的 GC-10④:把第二个区的描述符**整行复制**成 `tgt_gbcneg1`。
# ⇒ 跑到那两条判据时,页面上**真出现两个执行环境**。判据为了取证违反产品规则,绝对不许
#   (记忆 criteria-must-not-break-product-rules:同形第二次,第一次是 I-6 在同区注册到第 4 个)。
# 🔴 判的是**唯一允许的形态**,不是枚举违规写法:**执行环境描述符只能由产品创建** ⇒
#   验收脚本里对注册表的 `put-item`(整行写入 / 克隆)一律 **0 处**。
#   `update-item`(改已有那一行,例如把 probe 盖成过期来造负向)与 `delete-item`(清残留)**照旧允许** ——
#   它们不会让某个 region 多出一套环境。
if [[ -d "$REPO/qa-game/verify" ]]; then
  say "2b-2) 验收脚本不许自造执行环境描述符(一区一套是产品守卫,判据不许绕过它)"
  BAD_PUT=$(grep -rn "put-item" "$REPO/qa-game/verify" 2>/dev/null \
            | grep -E "bgp-execution-envs|ENVS_TABLE|REGISTRY_TABLE" || true)
  if [[ -n "$BAD_PUT" ]]; then
    echo "$BAD_PUT"
    die "🔴🔴 上面这些地方在**直写执行环境注册表**(put-item)⇒ 会在一个已有环境的 region 里造出第二套,
违反用户反复拍板的「一个区域只能有一个执行环境」(产品侧 registerTarget 会回 409,直写 DDB 绕过了它)。
负向载体要用**真实存在且合法**的 target(注册表里「非 home 且不可承接」的那个);
一个都没有时,构造它的正道是**用产品向导在一个空闲 region 注册但先不部署**,不是直写表。"
  fi
  echo "   验收脚本零自造描述符"
fi

# ── 2c) 🔴🔴 **量具自己的离线判据**(2026-09-20 补:它们写了却从来没人跑)──
# `infra/test/<名>/test_*.py|sh` 这一层专门判「门禁/脚本自己的纯函数」:IAM 三态 `classify`、
# `redeploy-platform` 的三态退出码、夹具台账的 `reject_reason`、口令表与「能承接」口径……
# 四个目录都在,**而全量硬门里一处都没跑过** —— 又一例「写了但接不上」(记忆 unwired-code-is-unverified):
# 判据存在 ≠ 判据在判。它们全是离线纯函数,总共几秒钟,没有任何理由不每轮跑。
# 🔴 **按目录自发现,不枚举文件名**:下一个 harness 加进来就自动被跑,不需要记得回来改这里
#   (记忆 gate-enumerates-violations-not-legal-form:门禁写成枚举就一定漏掉第 N+1 个)。
if [[ -d "$REPO/infra/test" ]]; then
  say "2c) 量具自己的离线判据(infra/test/*/test_*)"
  _oc=0
  while IFS= read -r t; do
    _oc=$((_oc + 1))
    case "$t" in
      *.py) python3 "$t" >/dev/null || die "离线判据未过:$t(单独跑一次看明细:python3 $t)" ;;
      *.sh) bash "$t" >/dev/null || die "离线判据未过:$t(单独跑一次看明细:bash $t)" ;;
    esac
  done < <(find "$REPO/infra/test" -mindepth 2 -maxdepth 2 -name 'test_*.py' -o -mindepth 2 -maxdepth 2 -name 'test_*.sh' | sort)
  [[ "$_oc" -ge 4 ]] || die "只发现 $_oc 个离线判据(应 ≥4)—— 是不是目录被挪走了?量具无人看守就会拿坏量具量产品"
  echo "   离线判据 $_oc 个全绿"
fi
echo "   本地门禁全绿"

# ── 3) 部署到临时环境 ──
if [[ "$DEPLOY" == "1" ]]; then
  say "3) 部署平台栈到 $PROFILE / $REGION"
  # 🔴 镜像从工作树构建 ⇒ 构建前再核一次指纹(开工到这里之间隔着 tsc+vitest 好几分钟)
  [[ "$(runtime_fp)" == "$FP0" ]] || die "产品代码在门禁运行期间被改动了 —— 现在构建出的镜像不对应任何提交。
先提交(或撤销)改动,再重跑本门。"
  # 🔴🔴 **建表栈要先发**(2026-09-04 W3-e 补,与下面漏发 EMR 栈同一类洞):
  # `redeploy-platform.sh` 只发 `BgpPlatformStack`,而**新增的 DynamoDB 表在 `BgpDatabaseStack`**。
  # 不先发它,新表根本不存在 ⇒ 新功能在真环境一律 `ResourceNotFoundException`,
  # 而那个错看起来像"代码写错了",离根因(表没建)极远。
  # 放在平台栈**之前**:表必须先于用它的代码上线(反过来会有一段窗口期页面报 500)。
  ( cd infra && npx cdk deploy BgpDatabaseStack --require-approval never --profile "$PROFILE" ) \
    || die "BgpDatabaseStack 部署失败(新表没建出来,后面的验收一定报 ResourceNotFound)"
  # exec-env 部署机制栈(BgpExecEnvDeployStack)**由 redeploy-platform.sh §2b 统一发**(2026-09-06 单一作者:
  #   deploy-all 6.5 首装 / redeploy-platform 每次刷新源包 / 本脚本只调后者),这里不再第二处发。
  bash scripts/redeploy-platform.sh "$PROFILE" "$REGION" || die "部署失败"
  # 🔴🔴 **EMR 栈也要部署**(2026-09-04 实测踩到):`redeploy-platform.sh` 只发 `BgpPlatformStack`,
  # 而 EMR **作业执行角色**在独立的 `BgpEmrStack` 里。W3-g 把它的 S3 资源面从"home 两个桶的全名"
  # 放开到 per-target 桶 —— 不发这个栈,非 home 的 EMR job-run 会在拉 entryPoint 那一步 AccessDenied,
  # 而错误信息离根因极远(EMR 只报一个启动失败)。
  # 门控 flag 与 bin/app.ts 一致(`-c enable-emr=1`);栈不存在时不当失败(有些环境没装 EMR)。
  ( cd infra && npx cdk deploy BgpEmrStack -c enable-emr=1 --require-approval never --profile "$PROFILE" ) \
    || echo "   ⚠️ BgpEmrStack 部署未成功(若该环境没装 EMR 组件可忽略;装了就必须查)"
else
  say "3) 跳过部署(--no-deploy)"
fi

# ── 4) 🔴 无头验收:**全部**多 region 功能 ──
say "4) 无头验收(累积:全部多 region 功能)"
VERIFY="$REPO/qa-game/verify/verify_mr_all.py"
[[ -f "$VERIFY" ]] || die "找不到累积回归入口 $VERIFY"
set +e
# 🔴 全量输出留档:盖章步要从里面抓「⚠️ <ID>」登记项(用户 2026-09-05 铁律:登记项不算过关,见判据 ⑤)。
VLOG="$REPO/qa-game/MR-VERIFY-ALL.log"
python3 "$VERIFY" 2>&1 | tee "$VLOG"
VR=${PIPESTATUS[0]}
set -e
# 🔴🔴 2026-10-12 第二十九至三十二轮**四轮同一个坑**:verify_mr_all 在第七道预检(契约锚点随产品重构失明)
#   几秒内退出 8 ⇒ 41 段一条没跑;而章只记一个光秃秃的 fail(notes 为空),本步输出只有 4 行埋在 VLOG 里,
#   后面 4b 又跑了一小时 90 条全绿 ⇒ 四轮都把「入口没起来」看成了「段内有红」。
#   「入口没跑起来 / 段内有红 / 段崩」必须三态分开(记忆 gate-must-separate-crash-from-fail):
#   这里当场把退出码与日志尾部打进主日志,盖章步再把它写进 notes(人看章就知道为什么 fail)。
if [[ "$VR" != "0" ]]; then
  echo "   🔴 验收入口 verify_mr_all.py 退出码 $VR(0 才是「段都跑了且全绿」;8 = 预检拦下 ⇒ 一段都没跑)—— 其日志尾部:"
  tail -n 12 "$VLOG" | sed 's/^/   │ /'
fi

# ── 4b) 🔴🔴 能力 × 区域 × 执行方式 三维矩阵(判据 ⑥ 的证据)──────────────────
# 用户 2026-09-18 原话:「下发执行,单独执行,各种操作都必须要验证到位。而且各种执行引擎都要执行到位,
#   不然功能和引擎就会有盲区。**这个要写进去 hook 里面,不然总是跳过**」。
# 🔴🔴 2026-09-19 夜发现:那道 hook 判据(gate.py ⑥)**从写下来就一直休眠** —— 它只从
#   `ruleVersion >= 3` 起判死,而本脚本盖的章一直写 `ruleVersion: 2`、也**从不写 capabilityCoverage**
#   ⇒ 判据 ⑥ 一次都没 judged 过任何东西(又一处「写了但接不上」)。⇒ 本相补上证据来源,
#   盖章步把它原样嵌进章并把 ruleVersion 升到 3。
# 🔴 证据必须由**无头浏览器脚本**产出(红线:只有页面级验证算数)—— hook 会核 `source` 字段。
say "4b) 能力 × 区域 × 执行方式 三维矩阵(无头浏览器产出;判据 ⑥ 吃它)"
CAPFILE="$REPO/qa-game/CAPABILITY-MATRIX.json"
set +e
python3 "$REPO/scripts/33-verify-regions-headless.py" --profile "$PROFILE" \
  --run-engines --run-dispatch --emit-matrix "$CAPFILE" --shots "$REPO/qa-game/shots-headless" 2>&1 \
  | tee "$REPO/qa-game/MR-CAPABILITY-MATRIX.log"
CAPR=${PIPESTATUS[0]}
set -e
[[ "$CAPR" == "0" ]] || echo "   ⚠️ 三维矩阵脚本退出码 $CAPR —— 缺格 / 有红都会在盖章步判死"

# ── 5) 盖章 ──
# 🔴 盖章的判据是「**被验过的产品代码** == 现在的产品代码」,不是 commit sha ——
# 否则一次纯文档提交也会让章失效、白跑 15 分钟全量验收(这是本门自己的假阳性,已修)。
TREE="$(git rev-parse HEAD:platform/src 2>/dev/null || echo -)+$(git rev-parse HEAD:infra 2>/dev/null || echo -)"
FP1=$(runtime_fp)

# 🔴🔴 **引擎 × 区域 覆盖矩阵**(用户 2026-09-04 追加的硬要求,原话:
#   「多区域相关的功能、任务,都必须要在**多区域同时**验证跑成功,验收的标准是无头浏览器验证通过,
#     同时在多区域跑多种任务:glue pyspark / emrserverless spark / redshift,
#     都必须要在**多个区域**都跑任务,并且任务都必须**全部跑成功**」)。
# 证据由 `verify_w3_engines.py` 从**真实 run 记录 + 引擎原生状态**产出,落在 qa-game/ENGINE-COVERAGE.json;
# 这里**原样嵌进章**里 —— Stop hook 只信章,不信我嘴上说的。矩阵不满 ⇒ 章记 fail,不许盖 pass。
# 🔴🔴 **判据 ⑤:零登记项**(用户 2026-09-05 铁律,原话:
#   「后续所有的功能,必须按照生产环境真实使用的场景进行测试,无头浏览器完全覆盖到所有场景。
#     不能投机取巧绕过去,因为这是一个全球级别的生产级别的大型应用系统,必须要有最高的要求和标准」
#   + 对「按组件裁剪 n/a」的否决:「我要的是真实的检验方式,缺什么就使用这个系统装什么服务,
#     真实环境也是如此。不可能最终因为我们环境限制,测试都不做完整。必须走完所有测试!!!」)。
# 验收脚本里 `⚠️ <ID> …`(Reporter.add(passed=None))= 「环境构造不出、只由单测覆盖、如实登记」——
# 从现在起这类项**一律不算过关**:抓出来写进章 `registered`,非空 ⇒ 章记 fail。缺什么前提就用平台装出来。
REPO="$REPO" SHA="$LOCAL" BR="$BR" TREE="$TREE" VR="$VR" CAPR="$CAPR" DEPLOY="$DEPLOY" FP0="$FP0" FP1="$FP1" VLOG="$VLOG" \
python3 - <<'STAMP_PY'
import json, os, re, datetime

repo = os.environ["REPO"]
stamp = os.path.join(repo, ".claude", "mr-gate-stamp.json")
cov_file = os.path.join(repo, "qa-game", "ENGINE-COVERAGE.json")
vr = os.environ.get("VR", "1")
fp0, fp1 = os.environ.get("FP0", ""), os.environ.get("FP1", "")

result = "pass" if vr == "0" else "fail"
notes = []
# 🔴 fail 必须说出为什么(2026-10-12 四轮空 notes 的教训,见上面第 4 步的注释):
#   验收入口退出码 ≠ 0 时,把它与含义写进 notes;8 = 预检拦下 ⇒ **全量段一条没跑**,与「段内有红」是两回事。
capr = os.environ.get("CAPR", "")
if vr != "0":
    # verify_mr_all 的约定:1 = 有段红 / 崩;3–8 = 七道预检之一拦下(段登记 / 退出码纪律 / scope 单作者 / 汇总单作者 / dict 迭代 / 落点点名 / 请求体契约)
    meaning = ("预检拦下(验收脚本 / 量具自己的问题)⇒ 全量段一条没跑,这不是「产品有红」" if vr in ("3", "4", "5", "6", "7", "8")
               else "段内有红或段崩 —— 看 qa-game/MR-VERIFY-ALL.md 逐行")
    notes.append("验收入口 verify_mr_all.py 退出码 " + vr + ":" + meaning + ";尾部见 qa-game/MR-VERIFY-ALL.log")
if capr not in ("", "0"):
    notes.append("三维矩阵脚本 33-verify-regions-headless.py 退出码 " + capr + "(缺格 / 有红;明细见 qa-game/MR-CAPABILITY-MATRIX.log)")
if fp0 != fp1:
    result = "invalid"
    notes.append("产品代码在门禁运行期间被改动(" + fp0 + " -> " + fp1 + ")=> 本次验收不算数")

# ⑤ 登记项。🔴🔴 2026-09-20 抓到这里**两个方向都在说谎**:
#   ① **假阳性**:原来抓「行首 ⚠️ + 一个词」⇒ 任何一行带 ⚠️ 的**普通日志**都会变成登记项。
#      实测:段 `guide` 自己 29/29 全绿,而它的 `click_soft` 打了一行「⚠️ 点不到 .ant-tour-next-btn」
#      (那次点击后面的判据已经断过真实结果),于是章上多出一条 id=`点不到` 的登记项 ——
#      判据 ⑤ 因此**永远关不掉**,而且关的是一个不存在的欠账。本脚本自己第 126/158 行的
#      「⚠️ BgpEmrStack…」「⚠️ 三维矩阵退出码…」同样会被抓成登记项。
#   ② **假阴性(更要紧)**:登记项其实有**两本台账** —— 验收段的 `Reporter.add(passed=None)`
#      与三维矩阵脚本的 `Rep.add(gap=True)`。而这里只读验收日志 ⇒ 矩阵那 9 个 `gap` 格子的登记
#      **结构上进不了章**,于是判据 ⑥ 里「gap 必须有登记」那半条无从成立(它当时还在用子串匹配,
#      `sync` 命中了另一条登记里的文件路径就放行了)。
# ⇒ 根治:登记项只认**机器标记** `[REG] <id> :: <text>`(两个台账的单一作者都打它),
#   并且**两本日志都读**。再加一道 fail-closed 握手:段自报「登记 K 项」而一条 `[REG]` 都没有
#   ⇒ 说明格式约定断了,当场记成一条登记项判死(绝不静默报 0 —— 那正是上一轮的假绿形态)。
REG_LINE = re.compile(r"^\s*\[REG\]\s+(\S+)\s*::\s*(.*)$")
CLAIM_LINE = re.compile(r"合计\s+\d+\s+项.*?(?:登记\s+(\d+)\s+项)")
registered = []
logs = [p for p in (os.environ.get("VLOG", ""),
                    os.path.join(repo, "qa-game", "MR-CAPABILITY-MATRIX.log")) if p]
seen, claimed, read_fail = set(), 0, []
for lg in logs:
    try:
        with open(lg, encoding="utf-8", errors="replace") as f:
            for line in f:
                m = REG_LINE.match(line.rstrip("\n"))
                if m:
                    rid = m.group(1)
                    if rid not in seen:
                        seen.add(rid)
                        registered.append({"id": rid, "text": (m.group(2) or "").strip()[:300]})
                    continue
                c = CLAIM_LINE.search(line)
                if c:
                    claimed = max(claimed, int(c.group(1)))
    except Exception as e:
        read_fail.append(lg + "(" + str(e) + ")")
if read_fail:
    registered.append({"id": "(读不到日志)", "text": " / ".join(read_fail)})
if claimed > 0 and not seen:
    registered.append({"id": "(登记台账格式握手断了)",
                       "text": "段自报『登记 " + str(claimed) + " 项』而全日志里没有一条 [REG] 机器标记 ⇒ "
                               "Reporter / Rep 的登记输出格式与本抓取器对不上。判死而不是报 0:"
                               "静默报 0 就是上一轮那种假绿。"})
if registered and result == "pass":
    result = "fail"
if registered:
    notes.append("登记项(⚠️)非零 = 有场景没在真环境走完:" + " | ".join(r["id"] for r in registered))

cov = {}
try:
    with open(cov_file, encoding="utf-8") as f:
        cov = json.load(f)
except Exception as e:
    notes.append("读不到引擎覆盖矩阵 " + cov_file + "(" + str(e) + ")")

REQUIRED_ENGINES = ["redshift", "glue", "emr-serverless"]
req_targets = list(cov.get("requiredTargets") or [])
matrix = cov.get("matrix") or {}
gaps = []
if len(req_targets) < 2:
    gaps.append("requiredTargets=" + repr(req_targets) + " 少于 2 个 —— 「多区域」至少要两个执行目标")
for eng in REQUIRED_ENGINES:
    for tgt in req_targets:
        got = str((matrix.get(eng) or {}).get(tgt) or "(没跑)")
        if got != "succeeded":
            gaps.append(eng + " x " + tgt + " = " + got)
if gaps and result == "pass":
    result = "fail"
if gaps:
    notes.append("引擎 x 区域 覆盖矩阵未满:" + " | ".join(gaps))

# 🔴🔴 判据 ⑥ 的证据:能力 × 区域 × 执行方式(9 × N × 2)。
#   2026-09-20 根治「**同一条判据有两个作者**」:这里原来自己算一遍缺格(弱口径:只看是不是 ok/gap),
#   而 Stop hook `gate.py` 算的是强口径(还要求每个 `gap` **逐格点名**自己那条登记)。
#   于是章上写着 `capabilityCoverageGaps=0`、而本门其实会拦 —— 人看章就以为过了(实测差 9 格)。
#   ⇒ 盖章不再自己判,只**调 hook 那份实现**;判死与放行永远同一个作者。
capcov = {}
capgaps = []
cap_file = os.path.join(repo, "qa-game", "CAPABILITY-MATRIX.json")
try:
    with open(cap_file, encoding="utf-8") as f:
        capcov = json.load(f)
except Exception as e:
    capgaps.append("读不到三维矩阵 " + cap_file + "(" + str(e) + ")")
if capcov:
    if not str(capcov.get("source") or "").endswith(".py"):
        capgaps.append("capabilityCoverage 的 source 不是无头脚本:" + repr(capcov.get("source")))
    try:
        import importlib.util
        gp = os.path.join(repo, ".claude", "skills", "multi-region-gate", "gate.py")
        spec = importlib.util.spec_from_file_location("mr_gate_hook", gp)
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        capgaps += hook.cap_gaps_of({"ruleVersion": 3, "capabilityCoverage": capcov}, registered)
    except Exception as e:
        capgaps.append("调不到 hook 的 cap_gaps_of(" + str(e) + ")⇒ 判死:判据 ⑥ 没人判等于没有判据 ⑥")
if capgaps and result == "pass":
    result = "fail"
if capgaps:
    notes.append("能力 x 区域 x 执行方式 矩阵未满:" + " | ".join(capgaps[:20]))

out = {
    "sha": os.environ.get("SHA", ""),
    "branch": os.environ.get("BR", ""),
    "srcTree": os.environ.get("TREE", ""),
    "result": result,
    "deployed": os.environ.get("DEPLOY") == "1",
    "at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "report": "qa-game/MR-VERIFY-ALL.md",
    "engineCoverage": cov,
    "engineCoverageGaps": gaps,
    "capabilityCoverage": capcov,
    "capabilityCoverageGaps": capgaps,
    "registered": registered,
    # 每一步自己的退出码也进章:人看章就能分清「入口没起来」与「段内有红」(两个都 ≠ 0 才是真有红)。
    "verifyExit": vr,
    "capabilityExit": capr,
    # 🔴 3 = 带上「能力 × 区域 × 执行方式」这一维(hook 判据 ⑥ 从 v3 起判死)。
    #   升到 3 之前判据 ⑥ 一直是休眠的 —— 章不带这两个字段,它就什么都判不了。
    "ruleVersion": 3,
    "notes": notes,
}
os.makedirs(os.path.dirname(stamp), exist_ok=True)
with open(stamp, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("RESULT=" + result)
STAMP_PY

STAMPED=$(python3 -c "import json;print(json.load(open('$STAMP'))['result'])" 2>/dev/null || echo fail)
if [[ "$STAMPED" == "pass" ]]; then
  printf "\033[1;32m✅ 多 region 硬门通过(已盖章 %s)\033[0m\n" "$STAMP"
  exit 0
fi
printf "\033[1;31m❌ 多 region 硬门未过(章 result=%s)—— 不许开下一刀。见 qa-game/MR-VERIFY-ALL.md\033[0m\n" "$STAMPED"
REPO="$REPO" python3 - <<'SHOW_PY' || true
import json, os
st = json.load(open(os.path.join(os.environ.get("REPO", "."), ".claude", "mr-gate-stamp.json")))
for n in st.get("notes") or []:
    print("   ·", n)
for g in st.get("engineCoverageGaps") or []:
    print("   🔴 覆盖缺口:", g)
for r in st.get("registered") or []:
    print("   🔴 登记项(不算过关,要把前提装出来真跑):", r.get("id"), (r.get("text") or "")[:120])
SHOW_PY
exit 1
