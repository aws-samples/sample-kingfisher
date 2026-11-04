// exec-env 控制面 route 的**守卫覆盖**断言(纵深防御第二道,SPEC §2.1)。
//
// 【为什么是文本级】route 是 Next.js 薄层,仓内没有单测 Next route 的先例(要构造 NextRequest /
// app-router 上下文),真实鉴权行为归切片 g 的 E2E(403 断言)。但"**某个 route 忘了加守卫**"
// 这一类可以在文本层机械钉住:每个 route.ts 必须 ① 调 requireExecEnvAdmin ② 处理其 NextResponse
// 返回。middleware 网关是第一道,这里是"第二道不许静默缺席"的门禁。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "../../../app/api/admin/exec-envs");

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routeFiles(p, acc);
    else if (e === "route.ts") acc.push(p);
  }
  return acc;
}

describe("🔴 /api/admin/exec-envs 下每个 route 都必须过路由内守卫(纵深第二道)", () => {
  const files = routeFiles(API_DIR);

  it("route 文件数与已交付切片一致(少了 = 有 route 没被本门禁覆盖到)", () => {
    // 切片 c 交付 5(list/register/get/deploy/build-status)+ 切片 e 交付 2(probe/enable)。
    // +seed-home+add-components+recover(2b)+preview(3 P0-E)
    // +intent(4 排空/回服务)
    // +credential-state(§3.9b 唯一写通道的生产调用方)
    //                            +provision-credentials(供给层的生产调用方 —— 没它供给层就是"从未验证过的代码")
    // +acks(GET .../[targetId]/acks 同意留存回查,SPEC v3.23 §2.1)
    //                            +statements(GET .../[targetId]/statements?auditId= 关联回查,SPEC v3.25 §2.1)
    // +preflight(GET 只读 EIP 配额预检)+network-profile(POST 改网络规模期望)
    // +scheduler-preference(POST 改调度器偏好;两者都装时走哪个)
    // +retire-components(POST 摘掉一个已经不在现网的组件
    //   平台原本只有「补充部署」没有反向动作,于是组件被真的删掉之后描述符永久声称它、target 卡 degraded,
    //   而 adoptHomeComponents(要 active)与 reconcileTarget(要 ready=false)都拒 ⇒ 唯一出路是手改 DDB(红线))
    // +candidate-regions(GET 只读 —— 新建向导的候选 region
    //   从**账号真值**派生:`ec2:DescribeRegions` + 注册表占位。原来界面用的是**写死的 7 个区**候选表
    //   + 默认值 `us-west-2` ⇒ 真实账号开第 8 个区在页面上选不到,而后端本来就 N 区自动。
    //   用户 2026-09-20:「不能硬编码两个,应该是多区域自动的」。)
    // +discard(POST 弃置一个从没装出来的环境 ——;
    //   之前平台里没有任何合法出口清掉卡在 provisioning 的空壳,判据只能直改 DDB)
    // +canary(permission canary 入队 / 读最新结果 / revoke-public-create)
    //   +provisioning-deadline(§3.9b 延期专用操作)+jobs(作业清单)+jobs/[jobId](单条 + 立即推进)
    // +drain / delete-preview / delete-request / destroy-retry / destroy-observe(下线销毁)
    expect(files.length).toBe(32); // +access(项目白名单) · 合并 integ/seq35:+4 与 +5 合计 23 → 32
  });

  for (const f of routeFiles(API_DIR)) {
    const rel = f.slice(f.indexOf("app/api"));
    it(`${rel}:调用 requireExecEnvAdmin 且处理其拒绝返回`, () => {
      const src = readFileSync(f, "utf8");
      expect(src, "缺守卫调用").toContain("await requireExecEnvAdmin(req)");
      expect(src, "没处理守卫的拒绝返回(instanceof NextResponse)").toContain("instanceof NextResponse");
      // 动态路由的 targetId 是外部输入:必须先过格式校验再进库
      if (f.includes("[targetId]")) {
        expect(src, "targetId 未过 isValidTargetId 就用了").toContain("isValidTargetId(params.targetId)");
      }
    });
  }

  it("🔴 finalize/完成序在 reconcile.ts(SSOT:人点与周期同一份)+ 携 exact fence + 稳态回写 health;probe 路由退化为薄封装,bug#11 现场已删", () => {
    // 【为什么这条必须钉】① 旧实现只查 core 六项 ⇒ 补充部署后 finalize 永不触发(跨端点接缝);
    // ② bug#11 现场 = route 自行 `if(!ready) markTargetTested`,补充部署后该分支永不进 ⇒ 回不到 active;
    // 🔴 **2a**:完成序抽到 `reconcile.ts#reconcileOneTarget`(SSOT —— probe 路由与周期 reconciler 同一份)。
    //    本条把"回写没断 + 决策由 lifecycle 纯判定 + fail-open 反转禁令(稳态回写 health)+ bug#11 现场不复活"
    //    钉在 reconcile.ts,并断路由只做委托(不再自己 finalize / markTargetTested)。
    // 🔴 **先剥注释**(第 5 次同一教训:解释性注释里就写着被禁标识符,不剥的话负向断言会咬自己的注释而假红)。
    const stripComments = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

    // (a) SSOT = reconcile.ts:仍调 finalizeTargetResources 携 exact fence + deploymentNeedsFinalize 统一判 + reconcileAfterProbe。
    const rec = stripComments(readFileSync(resolve(HERE, "../reconcile.ts"), "utf8"));
    expect(rec, "reconcile.ts 不再调 finalizeTargetResources = 回写断了").toContain("finalizeTargetResources(");
    expect(rec, "finalize 未携 exact fence(§21.1.1)").toMatch(/finalizeTargetResources\(targetId,\s*\{\s*fence/);
    expect(rec, "finalize 前置又按资源齐不齐判了 —— 补充部署的新组件会落不了地").not.toMatch(/resourcesIncomplete/);
    expect(rec, "finalize 决策应由 deploymentNeedsFinalize 统一判").toContain("deploymentNeedsFinalize(");
    expect(rec, "剥注释把代码也剥掉了").toContain("reconcileAfterProbe(");
    // 🔴 2a fail-open 反转禁令:稳态(evidence=none)用**本次** probe 回写 health,不只刷 probe.at。
    expect(rec, "稳态未回写 health(fail-open 反转禁令未落地)").toContain("reconcileTelemetry(");
    expect(rec, "bug#11 现场(markTargetTested)在 SSOT 复活了").not.toContain("markTargetTested");

    // (b) probe 路由 = 薄封装:委托 reconcileOneTarget,自己不再 finalize / markTargetTested(否则又是第二份实现)。
    const route = stripComments(readFileSync(resolve(API_DIR, "[targetId]/probe/route.ts"), "utf8"));
    expect(route, "probe 路由未委托 reconcileOneTarget(SSOT 没接上)").toContain("reconcileOneTarget(");
    expect(route, "probe 路由仍自己 finalize = 没走 SSOT").not.toContain("finalizeTargetResources(");
    expect(route, "probe route 仍自行 markTargetTested = bug#11 未闭合").not.toContain("markTargetTested");
  });

  // 🔴 **反转**:原「每个触发部署的 route 都必须有跨法域前置闸(403)」已作废
  //    (DESIGN §18 决策 6quinquies:平台不设法务门)。现在断的是**相反**的事:部署入口不许再按 jurisdiction 判;
  //    跨法域的唯一技术前置(装 residency-api + per-target 角色)在准入内核 residencyPrerequisite 里(有自己的单测)。
  it("🔴 触发部署的 route **不许**按 jurisdiction 设门(不设法务门);operationId 仍服务端生成", () => {
    const deployRoutes = ["[targetId]/deploy/route.ts", "[targetId]/add-components/route.ts", "[targetId]/preview/route.ts"];
    for (const rel of deployRoutes) {
      const src = readFileSync(resolve(API_DIR, rel), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      expect(src, `${rel} 仍在按 jurisdiction 判 ⇒ 跨法域 target 又被当成「本就不该有」`).not.toMatch(/jurisdiction\s*!==\s*"home"/);
      expect(src, `${rel} 仍给 RBAC_DENIED 403(法务门残留)`).not.toContain('"RBAC_DENIED"');
      expect(src, `${rel} 的 operationId 不是服务端生成`).toMatch(/randomBytes\(8\)\.toString\("hex"\)/);
    }
  });

  it("写类 route(register/deploy/probe/enable/seed-home/add-components)必须留审计", () => {
    // 🔴 判据取 API_DIR 之后的**相对路径**再匹配 —— 第一版拿绝对路径 includes("deploy"),
    //    被仓库目录名 `kf-deploy-from-github` 命中,把只读的 build-status 也当成写类 route(基线红)。
    //    与 naming-coverage 的教训同款:门禁判据的匹配面要收到最小。
    const writeRoutes = files.filter((x) => {
      const rel = x.slice(API_DIR.length);
      return ["register", "deploy", "probe", "enable", "seed-home", "add-components", "recover", "network-profile", "scheduler-preference", "discard"].some((w) => rel.includes(w));
    });
    // register + deploy + probe + enable + seed-home + add-components + recover + network-profile(K-5)+ scheduler-preference+ discard;数量断言防 filter 失效变恒绿
    expect(writeRoutes.length).toBe(10);
    for (const f of writeRoutes) {
      expect(readFileSync(f, "utf8"), `${f} 缺 recordAudit`).toContain("recordAudit(");
    }
  });

  it("🔴 2b recover 路由 = 薄封装:判定/执行在 lib,且必须显式确认 + 点名会话", () => {
    // 【为什么钉这条】恢复端点是**唯一**能在非成功结局下清 operation/锁的入口(SPEC §3.5b)。
    // 判定一旦回流进路由就不可测(仓内不单测 Next route),且 GET/POST 会各持一份判据 ⇒
    // 出现"页面说能恢复、接口却拒"。故:路由只许委托 lib,自己不许碰 DDB / 不许自己转 phase。
    const stripComments = (raw: string) => raw.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    const route = stripComments(readFileSync(resolve(API_DIR, "[targetId]/recover/route.ts"), "utf8"));

    expect(route, "GET 未委托 describeRecoveryStatus(页面判据没接上 lib)").toContain("describeRecoveryStatus(");
    expect(route, "POST 未委托 recoverFailedSession").toContain("recoverFailedSession(");
    expect(route, "路由自己转 phase = 绕过唯一写入方").not.toContain("transitionPhase(");
    expect(route, "路由自己发 DDB 写 = 绕过唯一失败写入方").not.toMatch(/UpdateCommand|docClient/);
    expect(route, "缺显式确认(confirm=true)⇒ 变成静默自动恢复,违审核 §19.8 ⑤").toMatch(/confirm\s*!==\s*true/);
    expect(route, "未要求 expectedOperationId(点名会话)⇒ 可能误清期间新开的会话").toContain("expectedOperationId");
    expect(route, "恢复未留审计").toContain("recordAudit(");

    // lib 侧:必须先过 CFN 稳定闸再调唯一失败写入方(顺序即安全论证)。
    const lib = stripComments(readFileSync(resolve(HERE, "../recovery.ts"), "utf8"));
    expect(lib, "恢复未查 CFN 处置").toContain("describeStackDisposition(");
    expect(lib, "恢复未在 CFN 不稳定时拒").toMatch(/disposition\.stable[\s\S]{0,400}?RecoveryRefusedError/);
    expect(lib, "未调唯一失败写入方").toContain("recordOperationFailure(");
    // 恢复端点不得自己下"完成"结论(那是 finalize 的活)。
    expect(lib, "恢复端点混进了 finalize = 变成绕过完成 fence 的后门").not.toContain("finalizeTargetResources");
  });

  it("🔴 2b 负向门禁:`deployLockExpiresAt` 不得与任何时钟比较(锁过期绝不驱动自动释放)", () => {
    // 【为什么这是承重】审核 §19.5 让删的 `OR deployLockExpiresAt < :now` 就是 fail-open:
    // 租约过期**不证明 build 已终止**,据它接管 = 放第二次部署去撞还在跑的 CloudFormation。
    // 该字段今天是**诊断性预期完成时限**(= startedAt + LOCK_LEASE_MS),陈锁只能走恢复端点处置。
    // 本门禁把"不许把它当过期判据"钉死,防后人"顺手"加回来(SPEC §3.5b / DESIGN §20.25)。
    // 允许的用法只有**有效性**校验(`> 0` / `<= 0`,即"必须是正整数")。
    const stripComments = (raw: string) =>
      raw
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    const CLOCKISH = new RegExp(
      // ① 字段在左:`deployLockExpiresAt < :now` / `< Date.now()` / `< now`(排除 `<= 0`/`> 0` 的有效性校验)
      "deployLockExpiresAt\\s*[<>]=?\\s*(?!0\\b)[A-Za-z_:$(]" +
        // ② 字段在右:`:now > ...deployLockExpiresAt` / `Date.now() >= x.deployLockExpiresAt`
        "|(?::now|Date\\.now\\(\\)|nowMs|\\bnow\\b)\\s*[<>]=?\\s*[A-Za-z_.$]*deployLockExpiresAt"
    );

    // 🔴 门禁自检(防"死门禁恒绿"):正样本必须被咬,负样本(有效性校验)必须放过。
    for (const bad of [
      'ConditionExpression: "attribute_not_exists(deployLockToken) OR deployLockExpiresAt < :now"',
      "if (Date.now() > target.deployLockExpiresAt) takeover();",
      "const expired = item.deployLockExpiresAt <= nowMs;",
      "if (t.deployLockExpiresAt < now) release();",
    ]) {
      expect(CLOCKISH.test(bad), `门禁漏放了违规样本:${bad}`).toBe(true);
    }
    for (const ok of [
      "if (!Number.isInteger(item.deployLockExpiresAt) || item.deployLockExpiresAt <= 0) throw x;",
      "typeof target.deployLockExpiresAt !== \"number\" || target.deployLockExpiresAt > 0",
      "current.deployLockExpiresAt === undefined && current.deployLockToken === undefined",
      'guards.push({ path: "deployLockExpiresAt", absent: true });',
    ]) {
      expect(CLOCKISH.test(ok), `门禁误咬了合法用法(有效性校验/存在性判定):${ok}`).toBe(false);
    }

    const roots = [
      resolve(HERE, "../../.."), // platform/src
      resolve(HERE, "../../../../../infra/lambda/exec-env-broker"), // broker(跨构建边界的另一半)
    ];
    const scan = (dir: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "__tests__" || e === ".next") continue;
        const p = join(dir, e);
        if (statSync(p).isDirectory()) scan(p, acc);
        else if (/\.(ts|tsx|mjs)$/.test(e)) acc.push(p);
      }
      return acc;
    };
    const offenders: string[] = [];
    let sawField = 0;
    for (const root of roots) {
      for (const f of scan(root)) {
        const src = stripComments(readFileSync(f, "utf8"));
        if (!src.includes("deployLockExpiresAt")) continue;
        sawField++;
        if (CLOCKISH.test(src)) offenders.push(f.slice(f.indexOf("platform/") >= 0 ? f.indexOf("platform/") : f.indexOf("infra/")));
      }
    }
    // 数量断言防"扫描面失效变恒绿"(该字段现有 registry/lifecycle/reconcile/recovery/broker 等多处引用)。
    expect(sawField, "扫描面失效:一个引用 deployLockExpiresAt 的生产文件都没扫到").toBeGreaterThanOrEqual(4);
    expect(offenders, "有生产代码把 deployLockExpiresAt 当过期判据(fail-open:锁过期 ≠ build 已终止)").toEqual([]);
  });

  it("🔴 credential-state:两条前进边 / 无逆向 / 逐字确认串 / unverifiable 非空即拒 / 审计 fail-closed", () => {
    // 【为什么必须钉在文本层】这四条都是**很容易被"简化"掉**的门:
    //  · 逐字确认串一删,切稳态就变成"顺手点一下";
    //  · `unverifiable` 分支一删,"查不到"就被当成"没问题"(§3.9b 的反面);
    //  · 审计的 try/catch 一改成 `.catch(()=>{})`,权限边界变更就可能没有记录;
    //  · 加一个 `toState: "legacy-seeded"` 分支,单调不可逆当场失效。
    // 真实行为归本批的无头验收(A/B/C);这里防的是"闸被顺手删掉而全绿"。
    const src = readFileSync(join(API_DIR, "[targetId]", "credential-state", "route.ts"), "utf8");
    expect(src, "逐字确认串没了 ⇒ 进 isolated 变成顺手一点").toContain("我已完成 canary 与跨项目负测");
    // 逐项目凭证核验连同 canary / 产物扫描 / 回落指标一起收进 `evaluateIsolationPrereqs`
    //   (单一作者;行为判据见 isolation-prereqs.test.ts)。这里钉:路由**调了它**、且不满足就 409 拒。
    expect(src, "进 isolated 前没跑服务端前置判据").toContain("evaluateIsolationPrereqs(");
    expect(src, "前置不满足却没有拒").toMatch(/if \(!prereq\.ok\)\s*\{[\s\S]{0,600}return apiError\([\s\S]{0,200}409/);
    const pre = readFileSync(join(HERE, "..", "isolation-prereqs.ts"), "utf8");
    expect(pre, "进 isolated 前没校验逐个项目的凭证").toContain("verifyProjectCredentials(");
    expect(pre, "unverifiable 非空却没有拒(查不到 ≠ 没问题)").toMatch(/unverifiable\.length\s*>\s*0/);
    expect(pre, "missing 非空却没有拒").toMatch(/missing\.length\s*>\s*0/);
    expect(src, "没走 §3.9b 的唯一写通道").toContain("advanceCredentialIsolationState(");
    // 🔴 负向:不许出现任何回退方向的 toState
    expect(src, "出现了逆向迁移 ⇒ 单调不可逆失效(§3.9b:不实现逆向 API)").not.toMatch(
      /toState\s*[=:]\s*["']legacy-seeded["']/
    );
    // 审计必须是"写不进去就拒",不是 best-effort:意图审计那一段必须 return 一个错误响应
    const intentBlock = src.slice(src.indexOf("credential-state.intent"));
    expect(intentBlock.slice(0, 800), "意图审计失败没有拒绝迁移(fail-closed-on-audit)").toMatch(
      /catch[\s\S]{0,200}return apiError/
    );
  });

  it("🔴 provision-credentials:只造凭证、**不**推进状态(两个决定不许合成一个按钮)", () => {
    // 🔴 **先剥注释**(同一教训第 7 次):路由里的解释性注释就写着被禁标识符
    //    (「不是 systemActor」),不剥的话负向断言会咬自己的注释而假红。
    const stripComments = (raw: string) =>
      raw
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    const raw = readFileSync(join(API_DIR, "[targetId]", "provision-credentials", "route.ts"), "utf8");
    const src = stripComments(raw);
    // 改成 202 + 作业:生产调用方 = 入队;回读核验成了作业的最后一步(verify)
    expect(src, "供给层没有生产调用方 = 从未验证过的代码").toContain("enqueueSupplyJob(");
    expect(src, "供给端点没回 202(跨区同步跑会撞 504)").toMatch(/\b202\b/);
    const supply = readFileSync(join(HERE, "..", "project-cred-supply.ts"), "utf8");
    expect(supply, "供给作业的最后一步不是回读核验(写得进去 ≠ 是对的)").toMatch(/\{ step: "verify", kind: "verify"[^}]*\},\s*\] as const/);
    expect(supply, "verify 步没有真调 verifyProjectCredentials").toContain("await verifyProjectCredentials(job.targetId, [projectId])");
    // 🔴 负向:本端点绝不推进状态机
    expect(src, "供给端点顺手推进了状态机 ⇒ 「造好了」与「宣布进稳态」被合成一个决定").not.toContain(
      "advanceCredentialIsolationState"
    );
    // actor 必须是真人(运维点的):审计要能归因到人
    expect(src, "用了系统 actor ⇒ 审计里看不出是谁点的").not.toContain("systemActor");
    expect(src).toContain("actorFromIdentity(identity)");
  });

  it("🔴 4:两个读 route 的可服务性必须**委托** describeServiceability,不许自己再算一遍", () => {
    // 【为什么这条承重】页面写「不承接:<原因>」那句话,必须逐字是数据面拒绝时的同一句。
    // route 里只要出现一次"自己拿 probe.at 减一下时间"或"自己拼一段拒因",就长出第二套判定 ——
    // 而 §20.26c 的教训是:**parity 门禁只证两侧一致、不证判得对**,这里连一致都保不住。
    // ⇒ 结构上只留一条路:route 只允许 import 并调用内核的只读出口。
    const stripComments = (raw: string) =>
      raw
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    const readRoutes = [join(API_DIR, "route.ts"), join(API_DIR, "[targetId]", "route.ts")];
    for (const f of readRoutes) {
      const src = stripComments(readFileSync(f, "utf8"));
      const rel = f.slice(f.indexOf("app/api"));
      expect(src, `${rel} 未委托 describeServiceability(页面判据没接上内核)`).toContain("describeServiceability(");
      // 🔴 负向:route 里不许出现新鲜度原料与拒因拼装 —— 那些只允许住在 registry 内核里。
      for (const forbidden of ["descriptorAgeMs", "TARGET_FRESHNESS_MAX_AGE_MS", "unusableReason", "descriptorViolation"]) {
        expect(src, `${rel} 自己碰了 ${forbidden} ⇒ 第二套判定,必然与数据面分叉`).not.toContain(forbidden);
      }
    }
  });
});
