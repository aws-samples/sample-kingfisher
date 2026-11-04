// 🔴 「代码用了的调用,清单必须有;清单有的动作,栈必须给」—— 跨构建边界钉死三层一致:
//   ① 代码 import 的每个 `XxxCommand`(client-mwaa-serverless / client-codebuild)⇒ infra/iam/platform-taskrole-calls.json 有 `<service>:Xxx`;
//   ② 清单里的每个动作 ⇒ infra/lib/platform-stack.ts 出现该字面(TaskRole 授权的源码);
//   ③ CreateWorkflow 的清单条目资源必须是 `workflow/*`(服务在创建时按 workflow/* 评估,名字限定永不匹配)。
// 真环境:一刀内 IAM 类缺陷三次(动作缺、资源模式错)。动作名守卫只能抓前两类;第三类交给
//   scripts/iam-simulate-gate.py 在部署后拿清单对 TaskRole 做 SimulatePrincipalPolicy —— 本测试保证清单不落后于代码。
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../../..");
const MANIFEST = resolve(REPO, "infra/iam/platform-taskrole-calls.json");
const PLATFORM_STACK = resolve(REPO, "infra/lib/platform-stack.ts");

interface Call { action: string; axis?: string; resource: string; context?: Record<string, string>; source?: string; why?: string }

function commandsImportedFrom(file: string, pkg: string): string[] {
  const src = readFileSync(resolve(REPO, file), "utf8");
  const re = new RegExp(`import \\{([^}]*)\\} from "${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}";`);
  const block = src.match(re);
  expect(block, `${file} 找不到 ${pkg} 的 import`).toBeTruthy();
  return Array.from((block as RegExpMatchArray)[1].matchAll(/(\w+)Command\b/g)).map((m) => m[1]);
}

describe("IAM 调用清单三层一致(代码 ⇒ 清单 ⇒ 栈授权)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { calls: Call[] };
  const actions = new Set(manifest.calls.map((c) => c.action));
  const plat = readFileSync(PLATFORM_STACK, "utf8");

  // +`any-region` —— 必须在放行集**之外**也 allowed 的调用(EIP 预检)
  it("清单本体:非空、每条有 action / resource、axis ∈ {execution, home, any-region}、source 指向存在的文件", () => {
    expect(manifest.calls.length).toBeGreaterThanOrEqual(20);
    for (const c of manifest.calls) {
      expect(c.action, JSON.stringify(c)).toMatch(/^[a-z0-9-]+:[A-Za-z]+$/);
      expect(typeof c.resource).toBe("string");
      expect(["execution", "home", "any-region", undefined]).toContain(c.axis);
      if (c.source) expect(existsSync(resolve(REPO, c.source)), `source 不存在:${c.source}`).toBe(true);
    }
  });

  it("① workflow-client.ts 的每个 client-mwaa-serverless Command ⇒ 清单有 airflow-serverless:<动作>", () => {
    const cmds = commandsImportedFrom("platform/src/lib/scheduler/serverless/workflow-client.ts", "@aws-sdk/client-mwaa-serverless");
    expect(cmds.length).toBeGreaterThanOrEqual(10);
    for (const c of cmds) {
      expect(actions.has(`airflow-serverless:${c}`), `清单缺 airflow-serverless:${c}(workflow-client.ts 在用 ${c}Command)`).toBe(true);
    }
  });

  it("① deploy-control.ts 的每个 client-codebuild Command ⇒ 清单有 codebuild:<动作>", () => {
    const cmds = commandsImportedFrom("platform/src/lib/exec-env/deploy-control.ts", "@aws-sdk/client-codebuild");
    expect(cmds.length).toBeGreaterThanOrEqual(3);
    for (const c of cmds) {
      expect(actions.has(`codebuild:${c}`), `清单缺 codebuild:${c}(deploy-control.ts 在用 ${c}Command)`).toBe(true);
    }
  });

  it("② 清单里的每个动作都以字面出现在 platform-stack.ts(TaskRole 授权源码)", () => {
    for (const a of actions) {
      expect(plat, `platform-stack.ts 没给 ${a},而清单说平台会调它`).toContain(`"${a}"`);
    }
  });

  it("③:CreateWorkflow 不支持资源级权限 ⇒ 清单资源 = *,栈里它单独一条 Resource * 且不与 bgp* 名字限定同条", () => {
    const create = manifest.calls.filter((c) => c.action === "airflow-serverless:CreateWorkflow");
    expect(create.length).toBeGreaterThanOrEqual(1);
    for (const c of create) expect(c.resource, "CreateWorkflow 只能 Resource *(服务报 workflow/*;模拟器对任何 ARN 都 deny)").toBe("*");
    const idx = plat.indexOf(`"airflow-serverless:CreateWorkflow"`);
    expect(idx).toBeGreaterThan(0);
    const stmt = plat.slice(idx, plat.indexOf("})", idx));
    expect(stmt).toContain(`resources: () => ["*"]`);
    expect(stmt).not.toContain("workflow/bgp*");
    expect(stmt).not.toContain("workflow/*");
  });

  it("④:服务代调用者做的 FAS 调用(CreateWorkflow 代建日志组)在清单里,且栈给了 logs:CreateLogGroup", () => {
    const fas = manifest.calls.filter((c) => c.action === "logs:CreateLogGroup");
    expect(fas.length, "清单缺 logs:CreateLogGroup(CloudTrail 坐实:CreateWorkflow 以调用者身份代建 /aws/mwaa-serverless/<workflow>/)").toBeGreaterThanOrEqual(1);
    // 🔴 原来这里断言**每一条** logs:CreateLogGroup 都指向
    //   `/aws/mwaa-serverless/`。那是「当时清单里只有这一条」的巧合,不是判据(与下面 PassRole
    //   那条踩过的坑同形)。本批补进 Flink 的日志组(`/aws/kinesis-analytics/bgp-flink-*`)时它当场判红。
    //   ⇒ 判据改成钉**那条 FAS 条目确实在**(至少一条、带 FAS 理由),而不是钉「只有这一种」。
    const fasMwaa = fas.filter((c) => c.resource.includes("log-group:/aws/mwaa-serverless/"));
    expect(fasMwaa.length, "清单里 logs:CreateLogGroup 没有一条指向 /aws/mwaa-serverless/(FAS 代建那条丢了)").toBeGreaterThanOrEqual(1);
    for (const c of fasMwaa) expect(c.why ?? "").toMatch(/FAS|invokedBy/);
    expect(plat).toContain(`"logs:CreateLogGroup"`);
    // FAS 全集的第二条 —— CreateServiceLinkedRole(SLR 已存在也每次照调);精确到该 SLR + 服务名条件
    const slr = manifest.calls.filter((c) => c.action === "iam:CreateServiceLinkedRole");
    expect(slr.length, "清单缺 iam:CreateServiceLinkedRole(CloudTrail 坐实:CreateWorkflow 每次以调用者身份调它)").toBe(1);
    expect(slr[0].resource).toContain("role/aws-service-role/airflow-serverless.amazonaws.com/AWSServiceRoleForAmazonMWAAServerless");
    expect(slr[0].context?.["iam:AWSServiceName"]).toBe("airflow-serverless.amazonaws.com");
    expect(plat).toContain("aws-service-role/airflow-serverless.amazonaws.com/AWSServiceRoleForAmazonMWAAServerless");
  });

  it("清单的 PassRole 条目带 iam:PassedToService 上下文(栈里该条件是硬门)", () => {
    // 🔴 原来这里把值**写死**成 airflow-serverless:
    // 那是「当时清单里只有这一种 PassRole」的巧合,不是判据。补进 Flink 的 PassRole(MSAF 建应用要
    // 把该 target 的 flink 角色传给 kinesisanalytics)时它当场判红 —— 判据必须钉「每条都声明了
    // 消费服务、且在封闭集合里」,而不是钉某一个服务名。
    const CONSUMERS = new Set([
      "airflow-serverless.amazonaws.com",   // MWAA Serverless CreateWorkflow(RoleArn)
      "kinesisanalytics.amazonaws.com",     // MSAF CreateApplication(ServiceExecutionRole)
      // 任务执行角色可选 —— 用户自建角色传给 Glue / EMR Serverless(role/* + PassedToService 锁服务)
      "glue.amazonaws.com",                 // Glue CreateJob / UpdateJob(Role)
      "emr-serverless.amazonaws.com",       // EMR Serverless StartJobRun(executionRoleArn)
    ]);
    const passRole = manifest.calls.filter((x) => x.action === "iam:PassRole");
    expect(passRole.length, "清单里一条 PassRole 都没有 ⇒ 这条判据在空转").toBeGreaterThanOrEqual(3);
    for (const c of passRole) {
      const svc = c.context?.["iam:PassedToService"];
      expect(svc, `${c.resource} 的 PassRole 没声明消费服务 ⇒ 模拟出来的 allowed 不代表真实调用`).toBeTruthy();
      expect(CONSUMERS.has(String(svc)), `${c.resource} 的消费服务 ${svc} 不在封闭集合里`).toBe(true);
    }
    // 🔴 判别性:两种消费服务都必须真的出现(只有一种时上面的封闭集合等于没起作用)
    const svcs = new Set(passRole.map((c) => String(c.context?.["iam:PassedToService"])));
    expect(svcs.has("kinesisanalytics.amazonaws.com"), "Flink 的 PassRole 不在清单里 ⇒ 模拟门挡不住 A3-1 那个 500").toBe(true);
    expect(svcs.has("airflow-serverless.amazonaws.com"), "MWAA Serverless 的 PassRole 从清单里丢了").toBe(true);
    expect(svcs.has("glue.amazonaws.com") && svcs.has("emr-serverless.amazonaws.com"), "自建角色 PassRole(glue / emr-serverless)从清单里丢了 ⇒ 模拟门挡不住绑定回归").toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴🔴 **清单的覆盖面本身要有机械下限**(记忆 manifest-gate-coverage-is-the-criterion 第 N 次)。
  //
  // 上面的规则 ① 只对**两个手挑的文件**生效(workflow-client.ts / deploy-control.ts)。于是
  // 「新增 AWS 调用必须同笔登记进清单」这条纪律一直是**靠自觉**的 —— 2026-09-19 实证代价:
  // 实时计算那一族(kinesis 10 个动作 + MSAF 14 个 + Flink 日志组 6 个)**从来没进过清单**,
  // IAM 模拟门于是报「67/67 allowed」而它探过的只是 TaskRole 被授动作的 8%;
  // 而那一族的资源 ARN 恰好又钉死在部署区 ⇒ 第二个区的实时计算从第一步就废,没有任何门看得见。
  //
  // ⇒ 把「授了权但从没探过」变成一个**只减不增的数**:
  //   · 授权面从 `platform-stack.ts` 里 `taskRole.addToPolicy(...)` 的 `actions: [...]` 机械抽取(结构,不是名单);
  //   · 清单探过的动作 = `calls[].action`;
  //   · 差集的大小 ≤ UNPROBED_LIMIT。**加新权限不登记 ⇒ 差集变大 ⇒ 当场红。**
  // 🔴 这条判据刻意**不要求**差集归零:183 条一次登记完会让模拟门跑成分钟级,且很多动作要先查清
  //   「服务自己报出的 ARN 形态」(形态写错会假红)。它要求的是**只能变小**。
  // ══════════════════════════════════════════════════════════════════════════
  describe("覆盖面棘轮:授给 TaskRole 却从没被模拟门探过的动作,只能变少", () => {
    /**
     * TaskRole 的**全部**授权面:`taskRole.addToPolicy(...)` 以及 `new iam.ManagedPolicy(…, {roles:[taskRole]})`
     * 两种构造里 `actions: [...]` 的动作字面(剥行注释;别的角色一概不碰)。
     *
     * 🔴 为什么必须两种都抽:本批把实时计算那一族从内联策略搬进独立 ManagedPolicy
     *   (内联已 10110/10240 字节、被 CDK 拆出 Overflow 策略)。要是只抽 `addToPolicy`,
     *   本棘轮当场就对「搬出去的权限」瞎掉 —— 那和它要消灭的那个病一模一样(手挑的覆盖面)。
     *   仓内已有 12 个具名 ManagedPolicy 挂在 taskRole 上,它们全都要算进来。
     */
    function grantedTaskRoleActions(src: string): Set<string> {
      const out = new Set<string>();
      const balanced = (s: string, from: number, open: string, close: string) => {
        let d = 1;
        let i = from;
        while (i < s.length && d > 0) {
          if (s[i] === open) d += 1;
          else if (s[i] === close) d -= 1;
          i += 1;
        }
        return i;
      };
      const harvest = (block: string) => {
        const clean = block.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
        for (const m of clean.matchAll(/actions:\s*\[/g)) {
          const arr = clean.slice(m.index! + m[0].length, balanced(clean, m.index! + m[0].length, "[", "]"));
          for (const a of arr.matchAll(/"([a-z0-9-]+:[A-Z][A-Za-z0-9]*)"/g)) out.add(a[1]);
        }
      };
      for (const marker of ["taskRole.addToPolicy(", "new iam.ManagedPolicy("]) {
        for (let at = src.indexOf(marker); at >= 0; at = src.indexOf(marker, at + 1)) {
          const start = at + marker.length;
          const block = src.slice(start, balanced(src, start, "(", ")"));
          // ManagedPolicy 只算挂在 taskRole 上的那些(如 JobRolePermissionsBoundary 是给作业角色的边界,不是 TaskRole 的权)
          if (marker.startsWith("new iam.ManagedPolicy") && !/roles:\s*\[\s*taskRole\s*[,\]]/.test(block)) continue;
          harvest(block);
        }
      }
      return out;
    }

    const granted = grantedTaskRoleActions(plat);
    const unprobed = [...granted].filter((a) => !actions.has(a)).sort();
    // 2026-09-19 实测基线 = **203**。这个数字的来历要写清,否则它看起来像「上限被放宽了」:
    //   · 只抽内联 `taskRole.addToPolicy` 时:授权面 196、未探 151;
    //   · 抽取面补上 12 个挂在 taskRole 上的具名 ManagedPolicy 之后:未探 **203**。
    //   🔴 数字变大是因为**量具看见了更多**(此前那 52 个动作一直在授权面里、只是没人数过),
    //     不是权限变多了。往后只减不增:新增 AWS 权限必须同笔登记进清单,否则这条当场红。
    const UNPROBED_LIMIT = 203;

    it("抽取本身没失效(授权面是三位数,不是 0 或个位数)", () => {
      expect(granted.size, "抽不到 taskRole 的动作 ⇒ 这组判据在空转(platform-stack.ts 结构变了?)").toBeGreaterThanOrEqual(150);
      // 正向控制:随便挑两个一定在的
      expect(granted.has("kinesis:CreateStream")).toBe(true);
      expect(granted.has("kinesisanalytics:StartApplication")).toBe(true);
      // 负向控制:条件键不是动作,不许混进来
      expect(granted.has("aws:RequestedRegion" as string)).toBe(false);
    });

    it(`未探过的动作数 ≤ ${UNPROBED_LIMIT}(新增 AWS 权限必须同笔登记进清单)`, () => {
      expect(
        unprobed.length,
        `授给 TaskRole 却从没被 IAM 模拟门探过的动作有 ${unprobed.length} 个(上限 ${UNPROBED_LIMIT})。` +
          `新增的那些是:${unprobed.slice(0, 20).join(", ")}${unprobed.length > 20 ? " …" : ""}。` +
          `⇒ 把它们登记进 infra/iam/platform-taskrole-calls.json(资源形态只写服务自己报出的那种),` +
          `或者说明为什么它不该被探。`
      ).toBeLessThanOrEqual(UNPROBED_LIMIT);
    });

    it("🔴 实时计算那一族必须在清单里(本批补的,不许再退回去)", () => {
      // 三段各挑代表:建流 / 造数 / MSAF 启动 / 日志组 —— 缺任何一段,第二个区的实时计算就是哑的
      for (const a of [
        "kinesis:CreateStream", "kinesis:PutRecords", "kinesis:GetRecords",
        "kinesisanalytics:CreateApplication", "kinesisanalytics:StartApplication",
      ]) {
        expect(actions.has(a), `清单缺 ${a} ⇒ 模拟门探不到它,第二个区静默无权时没人知道`).toBe(true);
      }
      // MSAF 的 CreateApplication 与 CreateWorkflow 同形:创建时不支持资源级权限 ⇒ 资源只能 *
      const create = manifest.calls.filter((c) => c.action === "kinesisanalytics:CreateApplication");
      expect(create.length).toBeGreaterThanOrEqual(1);
      for (const c of create) {
        expect(c.resource, "CreateApplication 只能 Resource *(2026-09-19 实测:给 application/* 或具体名都 implicitDeny)").toBe("*");
      }
      // Flink 的日志组必须**单独一条**(原来只有 mwaa-serverless 那条,于是 Flink 日志组从没被探过)
      const flinkLg = manifest.calls.filter(
        (c) => c.action === "logs:CreateLogGroup" && c.resource.includes("/aws/kinesis-analytics/")
      );
      expect(flinkLg.length, "清单里 logs:CreateLogGroup 只有 mwaa-serverless 那条 ⇒ Flink 日志组的区域轴没人验").toBeGreaterThanOrEqual(1);
      for (const c of flinkLg) expect(c.axis).toBe("execution");
      // 🔴 这一族必须是 execution 轴:home 轴等于「只在主控区验」= 原来那个洞
      for (const c of manifest.calls.filter((x) => x.action.startsWith("kinesis"))) {
        expect(c.axis, `${c.action} 的轴是 ${c.axis},应为 execution(流与应用都在各自的执行区)`).toBe("execution");
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // IAM 侧(2026-10-21)—— …9435 observe 第四十四轮 `place.creds.denied` 量出的四族缺口,清单里必须有对应条目
  //   (否则模拟门探不到它们,enforce 一开就是静默 500):
  //   ① bgp/datasource/* 的写三动作(建源 / 改口令 / 删源,execution 轴,secret 建在源所属区);
  //   ② bgp/dms/redshift-target 的 CreateSecret / PutSecretValue(实时链给 DMS 写完整字段密钥,home 轴);
  //   ③ secretsmanager:ListSecrets(RDS 发现按区列托管密钥,execution 轴,动作不支持资源级 ⇒ *);
  //   ④ s3:ListAllMyBuckets(系统设置服务状态数桶,home 轴,控制面调用);⑤ 读账号自有 RDS 主密钥(建源复制账密,home 轴)。
  // ══════════════════════════════════════════════════════════════════════════
  describe("IAM 侧:observe 量出的数据面密钥 / 桶清单缺口都在清单里", () => {
    const find = (action: string, resourceHas: string) => manifest.calls.filter((c) => c.action === action && c.resource.includes(resourceHas));
    it("① bgp/datasource/* 的 CreateSecret / UpdateSecret / DeleteSecret 各至少一条,且是 execution 轴(读那一半早就在)", () => {
      for (const a of ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:DeleteSecret", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]) {
        const rows = find(a, "secret:bgp/datasource/");
        expect(rows.length, `清单缺 ${a} on bgp/datasource/*`).toBeGreaterThanOrEqual(1);
        for (const c of rows) expect(c.axis, `${a} on bgp/datasource 的轴应为 execution(secret 建在源所属区)`).toBe("execution");
      }
    });
    it("② bgp/dms/redshift-target 的 CreateSecret 与 PutSecretValue 在清单里(home 轴)", () => {
      for (const a of ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]) {
        const rows = find(a, "secret:bgp/dms/redshift-target");
        expect(rows.length, `清单缺 ${a} on bgp/dms/redshift-target`).toBeGreaterThanOrEqual(1);
        for (const c of rows) expect(c.axis).toBe("home");
      }
    });
    it("③ secretsmanager:ListSecrets(资源 *,execution 轴)与 ④ s3:ListAllMyBuckets(资源 *,home 轴)在清单里", () => {
      const ls = manifest.calls.filter((c) => c.action === "secretsmanager:ListSecrets");
      expect(ls.length).toBeGreaterThanOrEqual(1);
      for (const c of ls) { expect(c.resource).toBe("*"); expect(c.axis).toBe("execution"); }
      const lb = manifest.calls.filter((c) => c.action === "s3:ListAllMyBuckets");
      expect(lb.length).toBeGreaterThanOrEqual(1);
      for (const c of lb) { expect(c.resource).toBe("*"); expect(c.axis).toBe("home"); }
    });
    it("⑤ 读账号自有 RDS 主密钥(rds!…)的 GetSecretValue 在清单里,home 轴,source 指向建源路由", () => {
      const rows = find("secretsmanager:GetSecretValue", "secret:rds!");
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const c of rows) { expect(c.axis).toBe("home"); expect(c.source).toBe("platform/src/app/api/datasources/route.ts"); }
    });
  });
});
