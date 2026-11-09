#!/usr/bin/env node
// (v2 @ 50--control-api:+--fast、+§10 broker)
// 执行环境栈组 **synth 门禁**(50 DESIGN §4.1a-5「编译级验收先行」+ ACCEPTANCE〔兜 P0-7〕synth 级验收)。
// 跑法:`npm run synth-gate`(在 infra 下)。
// ⚡ 迭代提速:`npm run synth-gate -- --fast` —— 跳过 §7(负向组件 synth)与 §9(控制面 synth,最慢
//   的一节,1-2 分钟);其余节(含 §10 的 broker,秒级)照跑。
//   🔴 **--fast 只用于开发迭代;提交前必须跑一次全量**(--fast 的绿不作为提交依据)。
//
// 【为什么这道门禁必须存在、且必须离线】
//   §4.1a 的结论是"现有栈根本不能直接跨 region 复用"(吃控制面活构造)。这类错**部署时才炸**,
//   而一次失败部署要花几十分钟 + 可能留下半截资源。所以第一道关必须是编译级的:
//   synth 出来就能判"栈名空间对不对 / 有没有引用 home 构造 / 数据桶保不保 / 名字是否出自 SSOT"。
//
// 🔴 **零凭证**:整个门禁在 `AWS_*` 全清空、凭证文件指向 /dev/null 的环境里跑。
//   两个作用:① CI 里没有目标账号凭证也能跑;② 结构性保证 synth **不碰本机 AWS 身份**
//   —— 实测过:`ec2.Vpc({maxAzs})` 会去 AssumeRole,报错里直接带出本机账号号(已根治,见 exec-env-stack.ts)。
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, writeFileSync, readdirSync, statSync, mkdirSync, chmodSync, mkdtempSync, copyFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

/** ⚡ fast 模式:跳过 §7/§9(两处最慢的 synth)。提交前必跑全量。 */
const FAST = process.argv.includes("--fast");

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(HERE, "..");
const REPO = resolve(INFRA, "..");

const TARGET = "tgt_usw2_a";
const SLUG = "tgt-usw2-a";
const REGION = "us-west-2";
const ACCOUNT = "123456789012"; // 门禁用的假账号:模板里出现真账号号会污染证据(红线)
// 🔴 输出写到**仓外**(tmpdir):源包 asset 打的是仓根,输出留在仓内会被自己打进去、路径无限加深(实测过)。
const OUT = resolve(tmpdir(), "bgp-synth-gate-ee");
/** `cdk ls`(负向/正向构造用例)的输出目录:与 OUT 分开,免得互相清掉对方的产物。 */
const LS_OUT = resolve(tmpdir(), "bgp-synth-gate-ee-ls");

const problems = [];
const fail = (m) => problems.push(m);

// §11f 的有状态 aws 替身(源码以字符串内嵌:门禁自带夹具,不依赖仓外文件)
const DESTROY_AWS_STUB = "\n// §11f 的**有状态** aws 替身(只答销毁脚本会问的问题;没见过的调用一律 exit 99)。\n// 状态在 STUB_STATE(JSON 文件)里,每次调用读 → 改 → 写回;每次调用原样记进 STUB_LOG(断言的就是这份调用序列)。\nconst fs = require(\"fs\");\nconst [svc, op, ...rest] = process.argv.slice(2);\nfs.appendFileSync(process.env.STUB_LOG, [svc, op, ...rest].join(\" \") + \"\\n\");\nconst st = JSON.parse(fs.readFileSync(process.env.STUB_STATE, \"utf8\"));\nconst opt = {};\nfor (let i = 0; i < rest.length; i++) {\n  if (!rest[i].startsWith(\"--\")) continue;\n  const k = rest[i].slice(2);\n  const v = rest[i + 1] !== undefined && !rest[i + 1].startsWith(\"--\") ? rest[++i] : true;\n  opt[k] = v;\n}\nconst q = String(opt.query || \"\");\nconst save = () => fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(st));\nconst out = (v) => { process.stdout.write(v === undefined || v === null || v === \"\" ? \"\" : String(v) + \"\\n\"); save(); process.exit(0); };\nconst nf = (what) => { save(); process.stderr.write(`An error occurred (ResourceNotFoundException): ${what} not found\\n`); process.exit(254); };\nconst k = `${svc} ${op}`;\nswitch (k) {\n  case \"ec2 describe-vpcs\": {\n    if (q.startsWith(\"Vpcs[0]\")) out(st.vpc || \"None\");\n    out(st.vpc || \"\");\n  }\n  case \"ec2 describe-subnets\": out(st.vpc ? st.subnets.join(\"\\t\") : \"\");\n  case \"kinesisanalyticsv2 list-applications\": out(Object.keys(st.flink).join(\"\\t\"));\n  case \"kinesisanalyticsv2 describe-application\": {\n    const a = st.flink[opt[\"application-name\"]];\n    if (!a) nf(\"application\");\n    if (q.endsWith(\"ApplicationStatus\")) out(a.status);\n    out(`${a.role}\\t${a.status}\\t2026-10-01T00:00:00+00:00`);\n  }\n  case \"kinesisanalyticsv2 stop-application\": { st.flink[opt[\"application-name\"]].status = \"READY\"; out(\"\"); }\n  case \"kinesisanalyticsv2 delete-application\": { delete st.flink[opt[\"application-name\"]]; out(\"\"); }\n  case \"mwaa-serverless list-workflows\": out(Object.keys(st.workflows).join(\"\\t\"));\n  case \"mwaa-serverless get-workflow\": {\n    const r = st.workflows[opt[\"workflow-arn\"]];\n    if (!r) nf(\"workflow\");\n    out(q === \"RoleArn\" ? r : opt[\"workflow-arn\"]);\n  }\n  case \"mwaa-serverless delete-workflow\": { delete st.workflows[opt[\"workflow-arn\"]]; out(\"\"); }\n  case \"glue get-jobs\": out(Object.entries(st.glueJobs).map(([n, r]) => `${n}\\t${r}`).join(\"\\n\"));\n  case \"glue delete-job\": { delete st.glueJobs[opt[\"job-name\"]]; out(\"\"); }\n  case \"glue get-connections\": out(Object.entries(st.glueConns).map(([n, s]) => `${n}\\t${s}`).join(\"\\n\"));\n  case \"glue delete-connection\": { delete st.glueConns[opt[\"connection-name\"]]; out(\"\"); }\n  case \"emr-serverless list-applications\": out(Object.entries(st.emr).filter(([, a]) => a.state !== \"TERMINATED\").map(([id]) => id).join(\"\\t\"));\n  case \"emr-serverless get-application\": {\n    const a = st.emr[opt[\"application-id\"]];\n    if (!a) nf(\"application\");\n    out(q.endsWith(\"subnetIds\") ? a.subnets.join(\"\\t\") : a.state);\n  }\n  case \"emr-serverless stop-application\": { st.emr[opt[\"application-id\"]].state = \"STOPPED\"; out(\"\"); }\n  case \"emr-serverless delete-application\": { st.emr[opt[\"application-id\"]].state = \"TERMINATED\"; out(\"\"); }\n  case \"dms describe-replication-instances\": {\n    if (opt.filters) {\n      const arn = String(opt.filters).split(\"Values=\")[1];\n      if (!st.dms[arn]) { save(); process.stderr.write(\"An error occurred (ResourceNotFoundFault): No Replication Instance found\\n\"); process.exit(254); }\n      out(arn);\n    }\n    const m = q.match(/ReplicationSubnetGroupIdentifier=='([^']+)'/);\n    out(Object.entries(st.dms).filter(([, x]) => x.subnetGroup === (m && m[1])).map(([a]) => a).join(\"\\t\"));\n  }\n  case \"dms describe-replication-tasks\": {\n    const f = String(opt.filters || \"\");\n    const v = f.split(\"Values=\")[1];\n    if (f.startsWith(\"Name=replication-instance-arn\")) {\n      const inst = st.dms[v];\n      const rows = inst ? Object.entries(inst.tasks).map(([a, s]) => `${a}\\t${s}`) : [];\n      if (!rows.length) { save(); process.stderr.write(\"An error occurred (ResourceNotFoundFault): No Tasks found\\n\"); process.exit(254); }\n      out(rows.join(\"\\n\"));\n    }\n    for (const inst of Object.values(st.dms)) if (inst.tasks[v] !== undefined) out(q.endsWith(\"Status\") ? inst.tasks[v] : v);\n    save(); process.stderr.write(\"An error occurred (ResourceNotFoundFault): No Tasks found\\n\"); process.exit(254);\n  }\n  case \"dms stop-replication-task\": { for (const inst of Object.values(st.dms)) if (inst.tasks[opt[\"replication-task-arn\"]]) inst.tasks[opt[\"replication-task-arn\"]] = \"stopped\"; out(\"\"); }\n  case \"dms delete-replication-task\": { for (const inst of Object.values(st.dms)) delete inst.tasks[opt[\"replication-task-arn\"]]; out(\"\"); }\n  case \"dms delete-replication-instance\": { delete st.dms[opt[\"replication-instance-arn\"]]; out(\"\"); }\n  case \"mwaa get-environment\": { const s = st.mwaa[opt.name]; if (!s) nf(\"environment\"); out(s); }\n  case \"mwaa delete-environment\": { delete st.mwaa[opt.name]; out(\"\"); }\n  case \"redshift-serverless get-workgroup\": { const s = st.workgroups[opt[\"workgroup-name\"]]; if (!s) nf(\"workgroup\"); out(s); }\n  case \"redshift-serverless delete-workgroup\": { delete st.workgroups[opt[\"workgroup-name\"]]; out(\"\"); }\n  case \"redshift-serverless get-namespace\": { const s = st.namespaces[opt[\"namespace-name\"]]; if (!s) nf(\"namespace\"); out(s); }\n  case \"redshift-serverless delete-namespace\": {\n    if (Object.keys(st.workgroups).length) { save(); process.stderr.write(\"An error occurred (ConflictException): namespace has a workgroup\\n\"); process.exit(254); }\n    if (opt[\"final-snapshot-name\"] && st.snapshots[opt[\"final-snapshot-name\"]]) { save(); process.stderr.write(\"An error occurred (ConflictException): snapshot already exists\\n\"); process.exit(254); }\n    if (opt[\"final-snapshot-name\"] && !st.noFinalSnapshot) st.snapshots[opt[\"final-snapshot-name\"]] = \"AVAILABLE\";\n    delete st.namespaces[opt[\"namespace-name\"]];\n    out(\"\");\n  }\n  case \"redshift-serverless get-snapshot\": { const s = st.snapshots[opt[\"snapshot-name\"]]; if (!s) nf(\"snapshot\"); out(s); }\n  case \"cloudformation describe-stacks\": {\n    const s = st.stacks[opt[\"stack-name\"]];\n    if (!s) { save(); process.stderr.write(`An error occurred (ValidationError): Stack with id ${opt[\"stack-name\"]} does not exist\\n`); process.exit(254); }\n    out(s);\n  }\n  case \"cloudformation delete-stack\": {\n    const n = opt[\"stack-name\"];\n    if (st.stackFail[n]) st.stacks[n] = \"DELETE_FAILED\";\n    else { delete st.stacks[n]; if (n.endsWith(\"-base\")) st.vpc = \"\"; }\n    out(\"\");\n  }\n  case \"cloudformation describe-stack-events\": out(st.stackFail[opt[\"stack-name\"]] || \"\");\n  case \"s3api head-bucket\": { if (st.buckets.includes(opt.bucket)) out(\"\"); save(); process.stderr.write(\"An error occurred (404) when calling the HeadBucket operation: Not Found\\n\"); process.exit(254); }\n  case \"s3tables list-table-buckets\": { const m = q.match(/name=='([^']+)'/); out((m && st.tableBuckets[m[1]]) || \"None\"); }\n  case \"dynamodb describe-table\": { if (st.tables.includes(opt[\"table-name\"])) out(\"{}\"); nf(\"table\"); }\n  case \"kms list-aliases\": { const m = q.match(/AliasName=='([^']+)'/); out((m && st.aliases[m[1]]) || \"None\"); }\n  default:\n    save();\n    process.stderr.write(`stub: 未预期的 aws 调用: ${k}\\n`);\n    process.exit(99);\n}\n";

/** 零凭证环境:任何 context 查找都会失败 ⇒ 门禁立刻红。 */
const NO_CRED_ENV = {
  ...process.env,
  AWS_PROFILE: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_EC2_METADATA_DISABLED: "1",
  BGP_SKIP_WIRING_HEAL: "1",
  // 放行清单的第二条通道(部署脚本导出)。门禁进程若从本机 shell 继承了它,§9f 的「缺省零数组化」会假红 / §9c-env 会假绿 ⇒ 这里剥掉。
  BGP_EXECUTION_REGIONS: undefined,
};
for (const k of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "BGP_EXECUTION_REGIONS"]) {
  delete NO_CRED_ENV[k];
}

function synth(ctxArgs, { expectFail = false } = {}) {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  const args = ["cdk", "synth", "--all", "--quiet", "-o", OUT, ...ctxArgs.flatMap((a) => ["-c", a])];
  try {
    const stdout = execFileSync("npx", args, {
      cwd: INFRA,
      env: NO_CRED_ENV,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || "") };
  }
}

/**
 * 只**构造 app**、不产模板(`cdk ls`)。
 * 负向用例(勾未实现组件必须报错)只关心"app 构造期是否抛、抛的原因对不对" ——
 * `ls` 与 `synth` 在这一点上信号完全相同,但实测快 2.5 倍(~10s vs ~25s+),
 * 而负向用例有 4 条(逐组件各一条),省下的时间很实在。
 */
function listApp(ctxArgs, { env = NO_CRED_ENV, select = [] } = {}) {
  // 🔴 必须给 `-o` 到**仓外**独立目录:不给的话 CDK 用仓内默认 `cdk.out`,两个后果都真踩过 ——
  //    ① 与其它 CDK 进程抢 `cdk.out` 锁("Other CLIs are currently reading from cdk.out")⇒ 门禁假红;
  //    ② 源包 asset 打的是仓根,仓内产物会被打进源包、路径无限加深。
  // `env` / `select`(§1c 用):控制面用例要换 CDK_DEFAULT_REGION 等进程变量,并只选中离线能构造的栈
  //   (理由同 §9:BgpVpcStack 的 maxAzs 会请求 AZ 查找,不选中它就不会去拿凭证)。
  const args = ["cdk", "ls", ...select, "-o", LS_OUT, ...ctxArgs.flatMap((a) => ["-c", a])];
  try {
    const stdout = execFileSync("npx", args, {
      cwd: INFRA,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || "") };
  }
}

function readManifest() {
  return JSON.parse(readFileSync(resolve(OUT, "manifest.json"), "utf8"));
}
function template(stackName) {
  return JSON.parse(readFileSync(resolve(OUT, `${stackName}.template.json`), "utf8"));
}

/**
 * 🔴 资源文案字段一律 ASCII(切片 g 第 5 个真跑事故的根治;§5b 与 §7b 共用这一份)。
 * 【实测证据,两条都是"synth 全绿、真部署 400"】
 *   · `AWS::IAM::Role` 的 `Description`:只收 **Latin-1**(中文 400);
 *   · `AWS::EC2::SecurityGroup` 的 `GroupDescription`:只收 **ASCII**
 *     ("Character sets beyond ASCII are not supported",core 栈因此整栈 ROLLBACK)。
 * 其余资源(CMK/CodeBuild/Lambda/CFN Stack description)实测**允许**中文,但既然限制是逐服务的、
 * 且只有真部署才暴露 ⇒ **新代码(exec-env 栈组)的资源文案一律英文**,中文放注释。
 * 断的是 **synth 产物**而不是源码写法:换成变量/模板串/拼接都逃不掉。
 * @returns 扫到的文案字段个数(调用方用它做"计数下限"防假绿)
 */
const DESC_FIELDS = ["Description", "GroupDescription"];
const NON_ASCII = /[^\x00-\x7F]/;
function assertAsciiDescriptions(tpl, stackName) {
  let n = 0;
  if (tpl.Description && NON_ASCII.test(String(tpl.Description))) {
    fail(`栈 ${stackName} 的模板 Description 含非 ASCII —— 资源文案一律英文(§5b:IAM/EC2 SG 等字段有硬字符集限制,真部署才炸)`);
  }
  for (const [lid, res] of Object.entries(tpl.Resources || {})) {
    for (const f of DESC_FIELDS) {
      const v = res.Properties?.[f];
      if (typeof v !== "string") continue;
      n++;
      if (NON_ASCII.test(v)) {
        fail(`${stackName}/${lid}(${res.Type})的 ${f} 含非 ASCII:「${v.slice(0, 60)}」—— ` +
          `EC2 SG 只收 ASCII、IAM 只收 Latin-1,synth 不校验、真部署 400(切片 g 实测整栈 ROLLBACK)`);
      }
    }
    // 🔴 (台账 N-2):**SG 规则**的 Description 是**另一层**,
    //   而且字符集比 GroupDescription 更窄(只收 a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*)。
    //   2026-09-08 真环境:中文规则描述 ⇒ `Invalid rule description` 400 ⇒ base 栈整栈回滚。
    //   原扫描只看资源顶层的 Description/GroupDescription ⇒ 这一层是盲区,补上。
    const RULE_DESC_OK = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/;
    const ruleLists = [];
    if (res.Type === "AWS::EC2::SecurityGroup") {
      for (const k of ["SecurityGroupIngress", "SecurityGroupEgress"]) {
        if (Array.isArray(res.Properties?.[k])) ruleLists.push([k, res.Properties[k]]);
      }
    } else if (res.Type === "AWS::EC2::SecurityGroupIngress" || res.Type === "AWS::EC2::SecurityGroupEgress") {
      ruleLists.push(["(自身)", [res.Properties || {}]]);
    }
    for (const [k, rules] of ruleLists) {
      for (const r of rules) {
        const d = r?.Description;
        if (typeof d !== "string") continue;
        n++;
        if (!RULE_DESC_OK.test(d)) {
          fail(`${stackName}/${lid} 的 ${k} 规则描述含非法字符:「${d.slice(0, 60)}」—— ` +
            `SG **规则**描述的合法集只有 a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*(比 GroupDescription 还窄),` +
            `synth 不校验、真部署 400 Invalid rule description 并整栈回滚(真部署实测)`);
        }
      }
    }
  }
  return n;
}

// ── 从 platform 侧命名 SSOT 取期望名(门禁不自己拼名字,否则它和栈组一起漂也发现不了)──────
const naming = JSON.parse(readFileSync(resolve(REPO, "platform", "naming.json"), "utf8"));
function expectName(kind) {
  const rule = naming.kinds[kind];
  if (!rule) throw new Error(`naming.json 无 kind=${kind}`);
  return rule.target.split("{slug}").join(SLUG).split("{account}").join(ACCOUNT);
}

// ──:per-target 执行角色的模板读法(SPEC v3.21 §6.1 段二)────────────────────
/** Output 值若是 `Fn::GetAtt [lid, Arn]` ⇒ 回该 Role 资源的 RoleName;否则回 JSON 文本(旧写法是拼串)。 */
function roleNameOfOutput(tpl, value) {
  const ga = value && typeof value === "object" ? value["Fn::GetAtt"] : undefined;
  if (Array.isArray(ga) && ga[1] === "Arn") {
    const r = tpl.Resources?.[ga[0]];
    return r?.Type === "AWS::IAM::Role" ? r.Properties?.RoleName ?? null : null;
  }
  return JSON.stringify(value ?? "");
}
/** 某 Role 的全部策略语句(内联 Policies + 引用它的 AWS::IAM::Policy)。 */
function roleStatements(tpl, roleLid) {
  const out = [];
  const role = tpl.Resources?.[roleLid];
  for (const p of role?.Properties?.Policies || []) out.push(...(p.PolicyDocument?.Statement || []));
  for (const r of Object.values(tpl.Resources || {})) {
    if (r.Type !== "AWS::IAM::Policy") continue;
    const roles = JSON.stringify(r.Properties?.Roles || []);
    if (roles.includes(`"${roleLid}"`)) out.push(...(r.Properties?.PolicyDocument?.Statement || []));
  }
  return out;
}
function roleLidByName(tpl, roleName) {
  const hit = Object.entries(tpl.Resources || {}).find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === roleName);
  return hit ? hit[0] : null;
}
/** CloudFormation 内建函数 ⇒ 字面(只认模板里 ARN 会遇到的三种 Ref;其余形态按原 JSON 文本返回让调用方的正则判红)。§7b / §9.8 共用。 */
function arnText(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    if (v.Ref === "AWS::Partition") return "aws";
    if (v.Ref === "AWS::Region") return REGION;
    if (v.Ref === "AWS::AccountId") return ACCOUNT;
    if (Array.isArray(v["Fn::Join"])) {
      const [sep, parts] = v["Fn::Join"];
      return (parts || []).map(arnText).join(sep);
    }
    if (Array.isArray(v["Fn::Sub"]) || typeof v["Fn::Sub"] === "string") {
      const str = typeof v["Fn::Sub"] === "string" ? v["Fn::Sub"] : v["Fn::Sub"][0];
      return String(str).replace(/\$\{AWS::Partition\}/g, "aws").replace(/\$\{AWS::Region\}/g, REGION).replace(/\$\{AWS::AccountId\}/g, ACCOUNT);
    }
  }
  return JSON.stringify(v);
}
/** 某 Role 里含 s3tables: 动作的 Allow 语句(§7b / §9.8 共用)。 */
function s3tablesStatements(tpl, roleLid) {
  return roleStatements(tpl, roleLid).filter((st) => st.Effect !== "Deny" && [].concat(st.Action || []).some((a) => String(a).startsWith("s3tables:")));
}
/**
 * 🔴 三层绑定逐条打:① 名出自 SSOT;② 信任带 aws:SourceAccount(全部语句);③ 凡 Resource 含 "*" 的语句必带
 * aws:RequestedRegion=目标 region;④ 资源里不出现 home 桶名 / 不出现 `-*` 通配;⑤ 不挂任何 AWS 托管策略。
 */
function assertPerTargetRole(tpl, stackLabel, kind, opts = {}) {
  const want = expectName(kind);
  const lid = roleLidByName(tpl, want);
  if (!lid) {
    fail(`${stackLabel} 里没有 RoleName=${want} 的 AWS::IAM::Role(SSOT per-target 名;kind=${kind})`);
    return null;
  }
  const role = tpl.Resources[lid];
  if (want === naming.kinds[kind].home) fail(`${stackLabel}/${lid} 用了 home 名 ${want} —— IAM 全局,第二 region 必 AlreadyExists`);
  if (!want.includes(SLUG)) fail(`${stackLabel}/${lid} 角色名 ${want} 不含 slug ⇒ 多 target 撞名`);
  if ((role.Properties?.ManagedPolicyArns || []).length > 0) {
    fail(`${stackLabel}/${lid} 挂了 AWS 托管策略 ${JSON.stringify(role.Properties.ManagedPolicyArns)} —— per-target 角色只许逐条内联绑区(AWSGlueServiceRole 带 s3:ListBucket on *)`);
  }
  // ② 信任
  const trust = role.Properties?.AssumeRolePolicyDocument?.Statement || [];
  if (trust.length === 0) fail(`${stackLabel}/${lid} 没有信任语句`);
  for (const st of trust) {
    const acct = st.Condition?.StringEquals?.["aws:SourceAccount"];
    if (acct !== ACCOUNT) fail(`${stackLabel}/${lid} 信任语句缺 aws:SourceAccount=${ACCOUNT}(防混淆代理):${JSON.stringify(st).slice(0, 200)}`);
    for (const svc of opts.trustServices || []) {
      // 由调用方逐个断哪些服务主体必须在(见下)
      void svc;
    }
  }
  const trustText = JSON.stringify(trust);
  for (const svc of opts.trustServices || []) {
    if (!trustText.includes(`"${svc}"`)) fail(`${stackLabel}/${lid} 信任里缺服务主体 ${svc}`);
  }
  if (opts.sourceArnIncludes && !trustText.includes(opts.sourceArnIncludes)) {
    fail(`${stackLabel}/${lid} 信任缺 aws:SourceArn 钉到本 region(期望含 ${opts.sourceArnIncludes})`);
  }
  // ③ 区域条件 + ④ 资源面
  const stmts = roleStatements(tpl, lid);
  if (stmts.length < 3) fail(`${stackLabel}/${lid} 只抽到 ${stmts.length} 条策略语句(期望 ≥3)—— 策略挂载读法可能失效`);
  let wildN = 0;
  for (const st of stmts) {
    const res = [].concat(st.Resource ?? []);
    const text = JSON.stringify(res);
    if (res.some((r) => r === "*")) {
      wildN++;
      const cond = st.Condition?.StringEquals?.["aws:RequestedRegion"];
      if (cond !== REGION) {
        fail(`${stackLabel}/${lid} 有 Resource:"*" 的语句没挂 aws:RequestedRegion=${REGION}(Action=${JSON.stringify(st.Action).slice(0, 120)})—— 这就是横移`);
      }
    }
    if (/-\*(\/\*)?"/.test(text) && text.includes(":s3:::")) fail(`${stackLabel}/${lid} S3 资源用了 -* 通配:${text.slice(0, 160)}`);
    for (const bk of ["datalakeBucket", "scriptsBucket", "tableBucket"]) {
      const homeName = naming.kinds[bk].home.split("{account}").join(ACCOUNT);
      if (new RegExp(`${homeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"])`).test(text)) {
        fail(`${stackLabel}/${lid} 策略里出现 home 的 ${bk}(${homeName})—— 本 target 的角色不许碰 home 的数据`);
      }
    }
  }
  if (opts.expectWild !== false && wildN === 0) fail(`${stackLabel}/${lid} 没有任何 Resource:"*" 语句 —— glue/logs/redshift-data 这类动作本应在(读法失效?)`);
  return lid;
}

// ── IAM 假动作名扫描(§13;§9 对控制面模板也调它 —— CP_OUT 在 §9 末尾就删了)────────────────────
// 【为什么要有】IAM 对不存在的动作名**不报错**:synth 绿、部署绿、策略里那一条就是死字 ⇒ 运行期 AccessDenied,
//   而错误离根因很远(2026-09-05 W5a-12:探活红 → 会话收不了口 → target 卡 upgrading)。这类假名有固定谱系
//   (S3 一堆 API 名与 IAM 动作名不同),钉成表,扫**全部** synth 产物,命中即红并给出正名。
//   🔴 IAM 动作名匹配大小写不敏感 ⇒ 表里只放「拼法不同」的,不放大小写变体;
//   表里几条「本来就对」的(GetBucketTagging / GetRecords / GetCallerIdentity)是自检哨兵:正名 == 键名时不算命中。
const IAM_MISNAMED = {
  "s3:getbucketreplication": "s3:GetReplicationConfiguration",
  "s3:putbucketreplication": "s3:PutReplicationConfiguration",
  "s3:deletebucketreplication": "s3:PutReplicationConfiguration",
  "s3:headbucket": "s3:ListBucket",
  "s3:headobject": "s3:GetObject",
  "s3:getbucketencryption": "s3:GetEncryptionConfiguration",
  "s3:putbucketencryption": "s3:PutEncryptionConfiguration",
  "s3:getbucketlifecycle": "s3:GetLifecycleConfiguration",
  "s3:getbucketlifecycleconfiguration": "s3:GetLifecycleConfiguration",
  "s3:putbucketlifecycle": "s3:PutLifecycleConfiguration",
  "s3:putbucketlifecycleconfiguration": "s3:PutLifecycleConfiguration",
  "s3:getbucketaccelerateconfiguration": "s3:GetAccelerateConfiguration",
  "s3:putbucketaccelerateconfiguration": "s3:PutAccelerateConfiguration",
  "s3:getbucketinventoryconfiguration": "s3:GetInventoryConfiguration",
  "s3:getbucketanalyticsconfiguration": "s3:GetAnalyticsConfiguration",
  "s3:getbucketmetricsconfiguration": "s3:GetMetricsConfiguration",
  "s3:getbucketnotificationconfiguration": "s3:GetBucketNotification",
  "s3:putbucketnotificationconfiguration": "s3:PutBucketNotification",
  "s3:listobjects": "s3:ListBucket",
  "s3:listobjectsv2": "s3:ListBucket",
  "s3:copyobject": "s3:GetObject + s3:PutObject",
  "s3:uploadpart": "s3:PutObject",
  "s3:createmultipartupload": "s3:PutObject",
  "s3:completemultipartupload": "s3:PutObject",
  "s3:getbuckettagging": "s3:GetBucketTagging",
  "s3:listbuckets": "s3:ListAllMyBuckets",
  "dynamodb:getrecords": "dynamodb:GetRecords",
  "sts:getcalleridentity": "sts:GetCallerIdentity",
};
const IAM_POLICY_TYPES = new Set(["AWS::IAM::Policy", "AWS::IAM::Role", "AWS::IAM::ManagedPolicy", "AWS::S3::BucketPolicy", "AWS::KMS::Key"]);
globalThis.__iamMisnameScan = { statements: 0, hits: 0, dirs: [] };
function scanIamMisnames(dir, label) {
  if (!existsSync(dir)) return fail(`§13 ${label}:目录不存在 ${dir} ⇒ 扫描没生效`);
  let scanned = 0;
  const hits = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".template.json"))) {
    const tpl = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
    for (const [lid, r] of Object.entries(tpl.Resources || {})) {
      if (!IAM_POLICY_TYPES.has(r.Type)) continue;
      const docs = [];
      if (r.Type === "AWS::IAM::Role") {
        for (const p of r.Properties?.Policies || []) docs.push(p.PolicyDocument);
        docs.push(r.Properties?.AssumeRolePolicyDocument);
      } else if (r.Type === "AWS::KMS::Key") docs.push(r.Properties?.KeyPolicy);
      else docs.push(r.Properties?.PolicyDocument);
      for (const doc of docs) {
        for (const st of doc?.Statement || []) {
          scanned++;
          for (const a of [].concat(st.Action || [], st.NotAction || [])) {
            if (typeof a !== "string") continue;
            const want = IAM_MISNAMED[a.toLowerCase()];
            if (want && want.toLowerCase() !== a.toLowerCase()) hits.push(`${f}:${lid}:${a} ⇒ 应为 ${want}`);
          }
        }
      }
    }
  }
  if (scanned < 10) fail(`§13 ${label}:只扫到 ${scanned} 条 IAM 语句 ⇒ 扫描没生效(${dir})`);
  for (const h of hits) fail(`§13 IAM 假动作名(${label};API 名 ≠ IAM 动作名,synth 绿运行期必拒):${h}`);
  globalThis.__iamMisnameScan.statements += scanned;
  globalThis.__iamMisnameScan.hits += hits.length;
  globalThis.__iamMisnameScan.dirs.push(label);
}

// ── 控制面栈 id 清单:直接从 bin/app.ts 里抽,避免手抄一份会漂的名单 ─────────────────────
function controlPlaneStackIds() {
  const app = readFileSync(resolve(INFRA, "bin/app.ts"), "utf8");
  const ids = new Set();
  for (const m of app.matchAll(/new\s+\w+\s*\(\s*app\s*,\s*"([^"]+)"/g)) ids.add(m[1]);
  return [...ids];
}

// ══════════════════════════════════════════════════════════════════════════════
// 1) 正向:零凭证 synth 成功 + 零 context 查找
// ══════════════════════════════════════════════════════════════════════════════
// 控制面 region(mwaa 组件回写 home 运行台账要它;其余组件忽略)—— 与 buildspec 传 $AWS_REGION 同位
const HOME_REGION = "us-east-1";
// 非 home 的 VPC 段(池内第一个;真部署由 broker 从描述符透传)
const VPC_CIDR = "10.128.0.0/16";
// 主控区那一侧的三件事实(真部署由 buildspec 从 BgpVpcStack 的 Outputs 读)
const HOME_VPC_ID = "vpc-0123456789abcdef0";
const HOME_VPC_CIDR = "10.0.0.0/16";
const HOME_DDB_ENDPOINT_ID = "vpce-0123456789abcdef0";
const baseCtx = [
  `exec-env-target=${TARGET}`,
  `exec-env-region=${REGION}`,
  `exec-env-account=${ACCOUNT}`,
  `exec-env-home-region=${HOME_REGION}`,
  "exec-env-components=core",
  `exec-env-vpc-cidr=${VPC_CIDR}`,
  `exec-env-home-vpc-id=${HOME_VPC_ID}`,
  `exec-env-home-vpc-cidr=${HOME_VPC_CIDR}`,
  `exec-env-home-ddb-endpoint-id=${HOME_DDB_ENDPOINT_ID}`,
];
// 零出网静态门 —— 取代  K-5「NAT 数量链路」检查。
//    K-5 那条链(注册表 networkProfile → broker env → buildspec / p0e-gate `-c exec-env-nat-gateways` → context.ts)
//    **整条退役**:执行环境不再有 NAT / EIP。这里反过来钉「链路必须已拆干净」+「不许再长出来」。
{
  const bs = readFileSync(resolve(REPO, "infra", "buildspec", "exec-env-deploy.yml"), "utf8");
  const pg = readFileSync(resolve(HERE, "p0e-gate.mjs"), "utf8");
  const br = readFileSync(resolve(REPO, "infra", "lambda", "exec-env-broker", "index.mjs"), "utf8");
  // ① 退役链路不许残留(留着 = 部署仍会传参 ⇒ context.ts 直接抛 ⇒ 每次部署都炸在第一步)
  for (const [name, txt] of [["buildspec", bs], ["p0e-gate", pg], ["broker", br]]) {
    if (/exec-env-nat-gateways/.test(txt)) fail(`${name} 仍在传 -c exec-env-nat-gateways —— 该入参已退役(SPEC §3.16),context.ts 收到就抛`);
  }
  if (/EXEC_ENV_NAT_GATEWAYS/.test(bs) || /name: "EXEC_ENV_NAT_GATEWAYS"/.test(br)) {
    fail("buildspec / broker 仍在注入 EXEC_ENV_NAT_GATEWAYS —— 零出网之后这个变量没有消费方");
  }
  // ② 执行环境栈组里不许再出现 PRIVATE_WITH_EGRESS(带 NAT 出网的子网类型)
  //    🔴 为什么要扫:`selectSubnets` 选不中时**返回空集不报错** ⇒ 漏改一处的症状是
  //    「Output 空串 / subnetIds 传空数组」,报错点离根因极远(施工时 core 栈真炸过一次)。
  const eeDir = resolve(REPO, "infra", "lib", "exec-env");
  for (const f of readdirSync(eeDir).filter((x) => x.endsWith(".ts"))) {
    // 🔴 先剥注释行(本仓第四次同一教训:注释里的措辞会骗出假阳性 —— 本节自己的注释就写了
    //    PRIVATE_WITH_EGRESS 这个词)。
    const txt = readFileSync(resolve(eeDir, f), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    if (/PRIVATE_WITH_EGRESS/.test(txt)) {
      fail(`infra/lib/exec-env/${f} 里出现 PRIVATE_WITH_EGRESS —— 执行环境私有子网的唯一真值是 private-subnets.ts 的 EXEC_ENV_PRIVATE_SUBNET_TYPE(= PRIVATE_ISOLATED)`);
    }
  }
}
/**
 * 🔴 **按 key 改 context,不按下标切**。
 * 教训(施工时被自己坑到):原来用 `baseCtx.slice(0, 4)` 表示「不传 home-region」——
 * 一旦 baseCtx 新增入参(vpc-cidr / home-link 三件事实),下标 4 之后的东西被**一起丢掉**,
 * 于是那几条负向用例改成因「缺 vpc-cidr」而抛 ⇒ 它们要验的东西根本没被验到(判据因错误的原因通过)。
 * 位置耦合在本仓已经犯过多次(组件清单是集合不是序列、DDB 键序…);这里一次性改成显式语义。
 * @param drop 要去掉的 context key(不带 `-c` 前缀)
 * @param add  追加/覆盖的 `key=value`
 */
function ctxWith({ drop = [], add = [] } = {}) {
  const kept = baseCtx.filter((kv) => !drop.some((k) => kv.startsWith(`${k}=`)));
  const addedKeys = add.map((kv) => kv.split("=")[0]);
  return [...kept.filter((kv) => !addedKeys.includes(kv.split("=")[0])), ...add];
}

let r = synth(baseCtx);
if (!r.ok) fail(`零凭证 synth 失败(§4.1a-5 要求编译级验收能离线跑):\n${r.out.slice(-1500)}`);

let manifest = null;
if (r.ok) {
  manifest = readManifest();
  const missing = manifest.missing || [];
  if (missing.length > 0) {
    fail(
      `synth 请求了 context provider ${missing.map((m) => m.provider).join(", ")} —— ` +
        `栈组必须零查找(否则 CI 跑不了、且会拿本机凭证去 AssumeRole)`
    );
  }
}

// §1c / §1d 共用(单一作者):非美主控区样本,与控制面「默认大模型地理守卫」的原话
const NON_US_HOME = "ap-southeast-1";
const GUARD_RE = /默认大模型 \S+ 是「us\.」地理推理配置,主控区 ap-southeast-1 调不通/;

// ══════════════════════════════════════════════════════════════════════════════
// 1c):非美主控区下,执行环境栈组不许被控制面的「默认大模型地理守卫」误伤;守卫本身必须仍在
// ══════════════════════════════════════════════════════════════════════════════
// 【为什么有这一节(2026-10-19 客户现网真撞)】页面「新建执行环境」触发的 CodeBuild 在主控区跑 `cdk bootstrap` /
//   `cdk deploy BgpExecEnv-*`,进程里 CDK_DEFAULT_REGION = 主控区、没有 BEDROCK_MODEL_ID。bin/app.ts 原来把两道控制面
//   守卫写在分叉之前 ⇒ 主控区不在美国(出厂默认模型是 `us.*`)时执行环境栈组一个都建不出来。三个测试账号主控区都是
//   us-east-1,所以 §1 的正向用例从来覆盖不到这条路。本节把「非美主控区」这个输入钉进离线门禁:
//   ① 执行环境栈组:同 CodeBuild 的进程环境(非美主控区 + 无 BEDROCK_MODEL_ID)下必须能构造;
//   ② 控制面:同样环境下必须**仍**以守卫原话被拒(防止修法变成「把守卫整个删掉」—— 那会让非美主控区裸部署时 AI 全哑火);
//   ③ 控制面:给了与主控区地理匹配的模型 id 就必须能构造(防止守卫变成「一律拒」)。
{
  // 🔴 CDK CLI 给 app 进程设 CDK_DEFAULT_REGION 时以 AWS_REGION / AWS_DEFAULT_REGION 为准(记忆 cdk-aws-region-overrides-home):
  //   只改 CDK_DEFAULT_REGION 而留着本机 shell 的 AWS_REGION=us-east-1,三个用例都会在 us-east-1 上跑 ⇒ 负向例假绿、正向例假红(首跑实撞)。
  const guardEnv = {
    ...NO_CRED_ENV,
    CDK_DEFAULT_ACCOUNT: ACCOUNT,
    CDK_DEFAULT_REGION: NON_US_HOME,
    AWS_REGION: NON_US_HOME,
    AWS_DEFAULT_REGION: NON_US_HOME,
  };
  delete guardEnv.BEDROCK_MODEL_ID; // 与 CodeBuild 一样:没有显式模型 id ⇒ resolveModelId() 退回出厂 us.* 默认
  delete guardEnv.KF_HOME_REGION;   // 执行环境 CodeBuild 也没有它(那是部署脚本导出的)

  const ee = listApp(baseCtx, { env: guardEnv });
  if (!ee.ok) {
    fail(
      `§1c 控制面守卫误伤复发:主控区 ${NON_US_HOME} + 无 BEDROCK_MODEL_ID 时执行环境栈组构造失败 —— 控制面守卫又跑到了 exec-env 分叉之前` +
        `(页面新建执行区的 CodeBuild 会在 bootstrap 就炸):\n${ee.out.slice(-600)}`
    );
  } else if (GUARD_RE.test(ee.out)) {
    fail("§1c 执行环境栈组构造成功却打印了默认大模型地理守卫的话 —— 守卫仍在 exec-env 路径上被调用");
  }

  // 只选中离线能构造的栈(同 §9 的选法);守卫在 app 构造期就抛,与选中哪个栈无关
  const cp = listApp([], { env: guardEnv, select: ["BgpPlatformStack"] });
  if (cp.ok) {
    fail(`§1c 控制面在主控区 ${NON_US_HOME} + 出厂 us.* 默认模型下居然构造成功 ⇒ 「默认大模型地理守卫」被整个删掉了(非美主控区裸部署会让 AI 全哑火)`);
  } else if (!GUARD_RE.test(cp.out)) {
    fail(`§1c 控制面在非美主控区被拒了,但不是守卫原话(判据因错误的原因通过):\n${cp.out.slice(-600)}`);
  }

  const cpMatched = listApp([], { env: { ...guardEnv, BEDROCK_MODEL_ID: "apac.anthropic.claude-opus-4-5-20251101-v1:0" }, select: ["BgpPlatformStack"] });
  if (!cpMatched.ok) {
    fail(`§1c 控制面在主控区 ${NON_US_HOME} + 匹配的 apac.* 模型下构造失败 —— 守卫变成了「一律拒」或别处又多了对主控区的硬假设:\n${cpMatched.out.slice(-600)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1d):buildspec 的 `cdk bootstrap` 不许执行 app(否则非美主控区 + CodeBuild 无 BEDROCK_MODEL_ID 必撞控制面守卫)
// ══════════════════════════════════════════════════════════════════════════════
// 【为什么有这一节(2026-10-29 客户现网真撞,该缺陷复发)】§1c 钉的是「带 -c exec-env-target 的 synth 不过守卫」,
//   但 buildspec 第 3 步 `npx cdk bootstrap aws://…` **不带任何 -c**,而 CDK CLI(2.11xx)在显式环境下仍会执行 cdk.json 的 app
//   ⇒ app 走控制面分支 ⇒ 守卫抛 ⇒ 页面「新建 / 重新部署执行环境」在 bootstrap 一步就炸。三个测试账号主控区都在美国,
//   §1c 的全绿与三次 production 再演练全是假阴性 —— 判据没有锚定到它要判的那条命令。
//   本节**真跑 buildspec 里那一行**(从文件里取,不另写第二份命令):非美主控区 + 零凭证 ⇒ 必须因 NoCredentials 停
//   (说明已越过 app、进到了 bootstrap 本身),绝不出现守卫原话;负向对照:同一行去掉 `--app ''` 必须撞守卫
//   (证明判据有判别力、且 CLI 仍会加载 app;若哪天 CLI 不再加载,这里只提示重勘,不判红)。
{
  const bs = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8");
  const bootLines = bs.split("\n").map((l) => l.trim()).filter((l) => /^npx cdk bootstrap\b/.test(l));
  if (bootLines.length !== 1) {
    fail(`§1d buildspec 里应恰有 1 行 \`npx cdk bootstrap …\`(现 ${bootLines.length} 行):${JSON.stringify(bootLines)}`);
  } else {
    const line = bootLines[0];
    if (!/\s--app ''\s/.test(line)) {
      fail(`§1d buildspec 的 bootstrap 没带 --app ''(CLI 会执行 app 走控制面分支 ⇒ 非美主控区撞守卫):${line}`);
    }
    const guardEnv = {
      ...NO_CRED_ENV,
      CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: NON_US_HOME, AWS_REGION: NON_US_HOME, AWS_DEFAULT_REGION: NON_US_HOME,
      EXEC_ENV_ACCOUNT: ACCOUNT, EXEC_ENV_REGION: "eu-central-1", CDK_DISABLE_VERSION_CHECK: "1",
    };
    delete guardEnv.BEDROCK_MODEL_ID; // 与 CodeBuild 一样没有显式模型 id
    delete guardEnv.KF_HOME_REGION;
    const runLine = (cmd) => {
      try {
        const out = execFileSync("bash", ["-c", cmd], { cwd: INFRA, env: guardEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
        return { ok: true, out };
      } catch (e) {
        return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || "") };
      }
    };
    const CRED_RE = /NoCredentials|no credentials have been configured|Need to perform AWS calls|Unable to resolve AWS account/i;
    const real = runLine(line);
    if (real.ok) {
      fail("§1d 零凭证下 buildspec 的 bootstrap 居然成功 ⇒ 判据前提失效(应因 NoCredentials 停)");
    } else if (GUARD_RE.test(real.out)) {
      fail(`§1d bootstrap 守卫复发:buildspec 的 bootstrap 仍执行了 app 并撞控制面守卫(页面新建 / 重新部署执行环境会在 bootstrap 就炸):\n${real.out.slice(-600)}`);
    } else if (!CRED_RE.test(real.out)) {
      fail(`§1d buildspec 的 bootstrap 停在了预期之外的地方(既非守卫原话也非凭证):\n${real.out.slice(-600)}`);
    }
    const naive = runLine(line.replace(/\s--app ''(?=\s)/, ""));
    if (!GUARD_RE.test(naive.out)) {
      console.warn(`[synth-gate §1d] 对照:去掉 --app '' 的 bootstrap 没有撞守卫(CDK CLI 行为变了?)—— 正向判据仍成立,--app '' 的必要性需重勘:\n${naive.out.slice(-300)}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 2) 栈名空间:全部 BgpExecEnv-<slug>-*,且与控制面栈 id **零相交**
// ══════════════════════════════════════════════════════════════════════════════
let stackNames = [];
if (manifest) {
  stackNames = Object.entries(manifest.artifacts)
    .filter(([, a]) => a.type === "aws:cloudformation:stack")
    .map(([id]) => id);

  const prefix = `BgpExecEnv-${SLUG}-`;
  for (const n of stackNames) {
    if (!n.startsWith(prefix)) fail(`栈名 ${n} 不以 ${prefix} 开头 ⇒ 无法用通配精准锁定、可能误动控制面`);
  }
  const cp = new Set(controlPlaneStackIds());
  const overlap = stackNames.filter((n) => cp.has(n));
  if (overlap.length > 0) fail(`栈名与控制面相交:${overlap.join(", ")}(§4.1a-1 要求名字空间不相交)`);
  if (cp.size < 15) fail(`从 bin/app.ts 只抽到 ${cp.size} 个控制面栈 id —— 抽取正则可能坏了(相交检查会变成假绿)`);

  // 组件条件装配:core-only 时**只有** base + core 两个栈
  const expected = [`${prefix}base`, `${prefix}core`];
  if (JSON.stringify([...stackNames].sort()) !== JSON.stringify(expected.sort())) {
    fail(`core-only 应只产出 ${expected.join(", ")},实际:${stackNames.join(", ")}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 3) region / account:每个栈的 environment 必须是目标 region(不是 home)
// ══════════════════════════════════════════════════════════════════════════════
if (manifest) {
  for (const n of stackNames) {
    const envUri = manifest.artifacts[n]?.environment;
    const want = `aws://${ACCOUNT}/${REGION}`;
    if (envUri !== want) fail(`栈 ${n} 的 environment=${envUri},应为 ${want}(资源建错 region 是本模块的头号事故)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IAM 侧(2026-10-21)—— 平台数据面角色(主控区那一个在平台栈、其余每区一个在 base 栈,同一作者
//   `lib/shared/platform-data-role.ts`)的密钥授权必须**成对**:…9435 observe 第四十四轮量到「bgp/datasource/* 能读不能建 / 改 / 删」
//   「bgp/dms/* 写不了」「RDS 发现的 ListSecrets 没给」三族 denied。这里对**合成后的模板**钉事实(不是钉源码字面):
//   该角色的策略里要有一条含 CreateSecret / UpdateSecret / PutSecretValue / DeleteSecret 且资源面同时覆盖 `secret:bgp/datasource/*` 与 `secret:bgp/dms/*`,
//   并有一条带区域条件的语句含 `secretsmanager:ListSecrets`。两处角色共用本函数 ⇒ 主控区与其他区同一把尺。
function assertDataRoleSecretGrants(tpl, roleLid, label) {
  const stmts = [];
  for (const v of Object.values(tpl.Resources || {})) {
    if (!JSON.stringify(v?.Properties?.Roles ?? []).includes(`"${roleLid}"`)) continue;
    const docs = v?.Properties?.PolicyDocument ? [v.Properties.PolicyDocument] : (v?.Properties?.Policies || []).map((x) => x.PolicyDocument);
    for (const doc of docs) for (const st of doc?.Statement || []) stmts.push(st);
  }
  if (stmts.length === 0) { fail(`${label}:找不到挂在数据面角色 ${roleLid} 上的任何策略语句 —— 归属扫描失效`); return; }
  const acts = (st) => (Array.isArray(st.Action) ? st.Action : [st.Action]).filter(Boolean);
  const write = stmts.find((st) => ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"].every((a) => acts(st).includes(a)));
  if (!write) fail(`${label}:数据面角色没有同时含 CreateSecret / UpdateSecret / PutSecretValue / DeleteSecret 的密钥写语句`);
  else {
    const res = JSON.stringify(write.Resource);
    for (const face of ["secret:bgp/datasource/*", "secret:bgp/dms/*", "secret:bgp/shared-writer/*"]) {
      if (!res.includes(face)) fail(`${label}:数据面角色的密钥写语句资源面缺 ${face}(enforce 下建源 / 改口令 / 删源或实时 DMS 目标密钥会被拒)`);
    }
  }
  const list = stmts.find((st) => acts(st).includes("secretsmanager:ListSecrets"));
  if (!list) fail(`${label}:数据面角色没有 secretsmanager:ListSecrets(RDS 发现按区列托管密钥会被拒)`);
  else if (list.Condition?.StringEquals?.["aws:RequestedRegion"] === undefined) fail(`${label}:ListSecrets 必须挂在带 aws:RequestedRegion 条件的区域语句上(动作不支持资源级权限,只能靠区域条件关在本区)`);
}

// 4) 零控制面构造引用:模板里不许出现任何控制面栈名 / 其 export
// ══════════════════════════════════════════════════════════════════════════════
if (manifest) {
  const cp = controlPlaneStackIds();
  // 🔴 **唯一**例外:平台数据面角色的信任条件要点名「平台任务角色」
  //   (`aws:PrincipalArn` 钉到 `BgpPlatformStack-TaskRole*`)。那是**身份名模式**,不是构造引用(没有 export / import,
  //   控制面栈删了重建也照样对得上)。例外是闭合的:只摘掉那一个角色的那一条信任语句,且逐字核它的形态;
  //   模板里任何别处再出现控制面栈名照样红。
  const PDR_NAME = `BgpExecEnv-${SLUG}-platform-data-role`;
  const PDR_TRUST = `arn:aws:iam::${ACCOUNT}:role/BgpPlatformStack-TaskRole*`;
  let pdrSeen = 0;
  for (const n of stackNames) {
    const tpl = JSON.parse(readFileSync(resolve(OUT, `${n}.template.json`), "utf8"));
    for (const [lid, r] of Object.entries(tpl.Resources || {})) {
      if (r.Type !== "AWS::IAM::Role" || r.Properties?.RoleName !== PDR_NAME) continue;
      pdrSeen++;
      assertDataRoleSecretGrants(tpl, lid, `§4 执行环境 ${n} 数据面角色`);
      const sts = r.Properties.AssumeRolePolicyDocument?.Statement || [];
      // `Fn::Join` + `Ref AWS::Partition` 是 CDK 对 `this.partition` 的标准产物 ⇒ 按 aws 分区展开后逐字比
      const flat = (v) => (v && v["Fn::Join"]) ? v["Fn::Join"][1].map((x) => (x && x.Ref === "AWS::Partition" ? "aws" : x)).join(v["Fn::Join"][0]) : v;
      const ok = sts.length === 1 && sts[0].Effect === "Allow" && sts[0].Action === "sts:AssumeRole"
        && flat(sts[0].Condition?.ArnLike?.["aws:PrincipalArn"]) === PDR_TRUST && Object.keys(sts[0].Condition || {}).length === 1;
      if (!ok) fail(`栈 ${n}/${lid} 平台数据面角色的信任语句形态不对(应恰好 1 条:Allow sts:AssumeRole + ArnLike aws:PrincipalArn=${PDR_TRUST}):${JSON.stringify(sts).slice(0, 300)}`);
      delete r.Properties.AssumeRolePolicyDocument; // 只为下面的文本扫描摘掉这一条
    }
    const text = JSON.stringify(tpl);
    for (const id of cp) {
      if (text.includes(id)) fail(`栈 ${n} 的模板里出现控制面栈名 ${id} ⇒ 引用了 home 构造(§4.1a-2 禁)`);
    }
    // 跨栈 ImportValue 只允许在**组内**(BgpExecEnv-<slug>-*)之间
    for (const m of Array.from(text.matchAll(/"Fn::ImportValue"\s*:\s*"([^"]+)"/g))) {
      if (!m[1].startsWith(`BgpExecEnv-${SLUG}-`)) fail(`栈 ${n} 从组外导入 ${m[1]}(只允许组内跨栈引用)`);
    }
  }
  if (pdrSeen !== 1) fail(`§4 平台数据面角色 ${PDR_NAME} 应恰好出现 1 次(base 栈),实际 ${pdrSeen} —— 例外条款在空转或角色建重了`);
}

// 端点清单**只有一个作者**(`lib/exec-env/endpoints.ts`)。
//   门禁绝不自己再写一份清单(那就正好是它要防的漂移),而是用 ts-node 驱动去读那个唯一真值。
let _endpointsSsot = null;
function endpointsSsot() {
  if (_endpointsSsot) return _endpointsSsot;
  const driver = resolve(INFRA, "_exec_env_endpoints_driver.ts");
  const body = [
    'const m = require(' + JSON.stringify(resolve(INFRA, "lib/exec-env/endpoints.ts")) + ');',
    'const plan = m.endpointPlanFor({ components: ["core"], region: ' + JSON.stringify(REGION) + ', homeRegion: ' + JSON.stringify(HOME_REGION) + ' });',
    'const planFull = m.endpointPlanFor({ components: ["core","mwaa","airflow-serverless"], region: ' + JSON.stringify(REGION) + ', homeRegion: ' + JSON.stringify(HOME_REGION) + ' });',
    'const planSameRegion = m.endpointPlanFor({ components: ["core"], region: ' + JSON.stringify(HOME_REGION) + ', homeRegion: ' + JSON.stringify(HOME_REGION) + ' });',
    'process.stdout.write(JSON.stringify({ plan, planFull, planSameRegion, runtime: m.RUNTIME_BOTO3_SERVICES }));',
  ].join("\n");
  try {
    writeFileSync(driver, body, "utf8");
    const out = execFileSync(resolve(INFRA, "node_modules/.bin/ts-node"), ["--transpile-only", "-P", resolve(INFRA, "tsconfig.json"), driver], {
      cwd: INFRA,
      env: NO_CRED_ENV,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    _endpointsSsot = JSON.parse(out);
  } catch (e) {
    fail(`端点清单 SSOT 读不出来(endpoints.ts 改坏了?):${String(e?.stderr || e?.message).slice(-400)}`);
    _endpointsSsot = { plan: { gateway: [], iface: [], crossRegion: [] }, planFull: null, planSameRegion: null, runtime: [] };
  } finally {
    try {
      rmSync(driver, { force: true });
    } catch {
      /* 已不在就算了 */
    }
  }
  return _endpointsSsot;
}
const execEnvEndpointPlan = () => endpointsSsot().plan;

// 删栈顺序的唯一作者是 lib/exec-env/destroy-order.ts;门禁用 ts-node 读它,绝不自己再写一份
let _destroyOrder = null;
function destroyOrderSsot() {
  if (_destroyOrder) return _destroyOrder;
  const driver = resolve(INFRA, "_exec_env_destroy_order_driver.ts");
  try {
    writeFileSync(driver, 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(resolve(INFRA, "lib/exec-env/destroy-order.ts")) + ').execEnvDestroyStackSuffixes()));', "utf8");
    const out = execFileSync(resolve(INFRA, "node_modules/.bin/ts-node"), ["--transpile-only", "-P", resolve(INFRA, "tsconfig.json"), driver], {
      cwd: INFRA, env: NO_CRED_ENV, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    _destroyOrder = JSON.parse(out);
  } catch (e) {
    fail(`删栈顺序 SSOT 读不出来(destroy-order.ts 改坏了?):${String(e?.stderr || e?.message).slice(-400)}`);
    _destroyOrder = [];
  } finally {
    try { rmSync(driver, { force: true }); } catch { /* 已不在就算了 */ }
  }
  return _destroyOrder;
}
const execEnvRuntimeBoto3Services = () => endpointsSsot().runtime;

// ══════════════════════════════════════════════════════════════════════════════
// 4b) 🔴 **零出网不变量**(SPEC §3.16-A;ACCEPTANCE N0-1/N0-2/N0-3)
//     这一节是本包的承重:每一条都对应一个「synth 全绿、真环境静默失败」的形状。
// ══════════════════════════════════════════════════════════════════════════════
if (manifest) {
  const baseName = `BgpExecEnv-${SLUG}-base`;
  const base = template(baseName);
  const res = Object.entries(base.Resources || {});
  const countOf = (ty) => res.filter(([, v]) => v.Type === ty).length;

  // ① 三条不变量:无 NAT / 无 EIP / 无 IGW
  for (const ty of ["AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::InternetGateway"]) {
    const n = countOf(ty);
    if (n !== 0) fail(`base 模板里有 ${n} 个 ${ty} —— 零出网要求恒为 0(SPEC §3.16-A)`);
  }
  // ② 私有路由表不许有默认路由(这一条比「无 NAT」更根本:别的出口也不许有)
  for (const [lid, v] of res) {
    if (v.Type !== "AWS::EC2::Route") continue;
    const d = v.Properties?.DestinationCidrBlock;
    if (d === "0.0.0.0/0" || d === "::/0") fail(`base 模板的 ${lid} 是默认路由 ${d} —— 零出网禁止任何默认出口`);
  }
  // ③ 🔴 私有子网 CIDR 与逻辑 ID 必须**冻结**
  //    为什么:CDK 按 subnetConfiguration 顺序切 CIDR。把 Public 那层直接删掉(而不是 reserved:true)
  //    会让私有子网从 10.0.2/3.0/24 挪到 10.0.0/1.0/24 ⇒ CidrBlock 变更 = **子网被替换**
  //    ⇒ 连带 MWAA 环境 / Redshift 子网组 / EMR 网络配置全部重建(ACCEPTANCE N0-10 明令禁止)。
  // 🔴🔴 冻结的是**偏移**,不是绝对地址。
  //    非 home 的 VPC 从地址池取 /16(与主控区不重叠,否则跨区 peering 建不出来)
  //    ⇒ 绝对值 10.0.2.0/24 会随 `-c exec-env-vpc-cidr` 变。而这条判据真正承重的性质是
  //    「私有子网仍是 VPC 的第 3、4 个 /24」—— 那才是 `reserved: true` 保住的东西
  //    (删掉 Public 层会让它们挪到第 1、2 个 /24 ⇒ 子网被替换)。
  //    🔴 期望前缀从**入参** VPC_CIDR 派生,不从模板读:从模板读就成了「自己证明自己」的空断言。
  const cidrPrefix = VPC_CIDR.split(".").slice(0, 2).join(".");
  const FROZEN_PRIVATE_SUBNETS = {
    ExecEnvVpcPrivateSubnet1Subnet0C4019DF: `${cidrPrefix}.2.0/24`,
    ExecEnvVpcPrivateSubnet2Subnet95905B6F: `${cidrPrefix}.3.0/24`,
  };
  // 段必须**真的**生效在 VPC 上(少这一条,「静默回落 CDK 默认」会让上面两条一起变成空断言:
  // 若哪天 ipAddresses 被漏掉,子网会是 10.0.2/3.0/24,而期望值也来自入参 ⇒ 这里能一眼看出不符)
  {
    const vpcRes = res.find(([, v]) => v.Type === "AWS::EC2::VPC");
    if (!vpcRes) fail("base 模板里找不到 AWS::EC2::VPC —— 形状变了,请同步本门禁");
    else if (vpcRes[1].Properties?.CidrBlock !== VPC_CIDR) {
      fail(`base 模板的 VPC CidrBlock 是 ${vpcRes[1].Properties?.CidrBlock},入参给的是 ${VPC_CIDR} —— ` +
        ``+`段没接上(会回落 CDK 默认 10.0.0.0/16,与主控区逐位相同 ⇒ 跨区 peering 建不出来)`);
    }
  }
  const subnets = res.filter(([, v]) => v.Type === "AWS::EC2::Subnet");
  if (subnets.length !== 2) fail(`base 模板有 ${subnets.length} 个子网(期望恰好 2 个私有子网;公有层必须是 reserved:true 不建子网)`);
  for (const [lid, cidr] of Object.entries(FROZEN_PRIVATE_SUBNETS)) {
    const hit = base.Resources?.[lid];
    if (!hit) fail(`私有子网逻辑 ID ${lid} 不见了 —— 改动会让存量子网被替换(N0-10 禁);要动这条先改合同`);
    else if (hit.Properties?.CidrBlock !== cidr) {
      fail(`私有子网 ${lid} 的 CIDR 变成 ${hit.Properties?.CidrBlock}(冻结值 ${cidr})—— CidrBlock 变更 = 子网替换`);
    }
  }

  // ③b 🔴 **存量资源的逻辑 id 冻结**(2026-09-08 真环境撞过,台账 N-1)
  //    S3 网关端点在此前就存在(构造 id `S3Gw` ⇒ 逻辑 id `ExecEnvVpcS3Gw93394E80`)。
  //    把构造 id 改成 `GwS3` 会让 CFN 当成**新资源**:一边建新的、老的还挂在同一张路由表上占着
  //    S3 前缀列表 ⇒ `already has a route with destination-prefix-list-id pl-…` ⇒ 整个 base 栈回滚。
  //    逻辑 id 就是资源身份;这一条把它钉死。
  const FROZEN_LOGICAL_IDS = {
    ExecEnvVpcS3Gw93394E80: "AWS::EC2::VPCEndpoint", // S3 网关端点(此前就有)
    ExecEnvVpc280E74AE: "AWS::EC2::VPC",
  };
  for (const [lid, ty] of Object.entries(FROZEN_LOGICAL_IDS)) {
    const hit = base.Resources?.[lid];
    if (!hit) fail(`冻结的逻辑 id ${lid}(${ty})不见了 —— 换 id = 删了重建;网关端点这种「路由表里唯一」的资源会直接冲突并让整栈回滚(真环境撞过)`);
    else if (hit.Type !== ty) fail(`逻辑 id ${lid} 的类型变成 ${hit.Type}(冻结为 ${ty})`);
  }

  // ④ 端点集合必须**恰好等于**清单唯一作者算出来的期望集
  const eps = res.filter(([, v]) => v.Type === "AWS::EC2::VPCEndpoint").map(([lid, v]) => ({ lid, p: v.Properties || {} }));
  const iface = eps.filter((e) => e.p.VpcEndpointType === "Interface");
  const gw = eps.filter((e) => e.p.VpcEndpointType !== "Interface");
  const plan = execEnvEndpointPlan();
  if (gw.length !== plan.gateway.length) fail(`网关端点 ${gw.length} 个,清单期望 ${plan.gateway.length} 个`);
  const sameRegionNames = iface.filter((e) => !e.p.ServiceRegion).map((e) => String(e.p.ServiceName)).sort();
  const wantSameRegion = plan.iface.map((svc) => `com.amazonaws.${REGION}.${svc}`).sort();
  if (JSON.stringify(sameRegionNames) !== JSON.stringify(wantSameRegion)) {
    fail(`同区接口端点与清单不一致:\n  模板 ${JSON.stringify(sameRegionNames)}\n  清单 ${JSON.stringify(wantSameRegion)}`);
  }
  // ⑤ 🔴🔴 **跨区 VPC 端点这个形态必须消失**(负向)。
  //    它被组织 SCP 拦死(`vpce:AllowMultiRegion` 的 AllowedByOrganizations=False,账号内放不开)⇒
  //    模板里再出现一个,真部署就会在创建端点那一步 403、整栈回滚。这一条从「必须有」改判成「必须没有」。
  const xr = iface.filter((e) => e.p.ServiceRegion);
  if (xr.length !== 0) {
    fail(`模板里还有 ${xr.length} 个**跨区** VPC 端点(${xr.map((e) => e.lid).join(", ")})—— ` +
      `那个形态被组织 SCP 拦死(SPEC §3.14ter),真部署必 403;跨区通路已改成 peering + 主控区同区端点 + 私有托管域`);
  }
  // ⑤b 跨区通路三件套:peering(PeerRegion=home)+ 本区两条回程路由 + 私有托管域,少一件就是「静默不通」
  const plan2 = plan;
  const pcxs = res.filter(([, v]) => v.Type === "AWS::EC2::VPCPeeringConnection");
  if (pcxs.length !== (plan2.homeLink.length > 0 ? 1 : 0)) {
    fail(`peering ${pcxs.length} 条,清单期望 ${plan2.homeLink.length > 0 ? 1 : 0} 条(homeLink=${JSON.stringify(plan2.homeLink)})`);
  }
  if (plan2.homeLink.length > 0) {
    const [pcxLid, pcx] = pcxs[0];
    if (pcx.Properties?.PeerRegion !== HOME_REGION) fail(`peering ${pcxLid} 的 PeerRegion=${pcx.Properties?.PeerRegion},期望 ${HOME_REGION}`);
    if (pcx.Properties?.PeerVpcId !== HOME_VPC_ID) fail(`peering ${pcxLid} 的 PeerVpcId=${JSON.stringify(pcx.Properties?.PeerVpcId)},期望入参给的 ${HOME_VPC_ID}`);
    // 本区回程路由:每张私有子网路由表一条,目的地 = **主控区网段**(不是 0.0.0.0/0,那条上面已禁)
    const homeRoutes = res.filter(([, v]) => v.Type === "AWS::EC2::Route" && v.Properties?.DestinationCidrBlock === HOME_VPC_CIDR);
    if (homeRoutes.length !== 2) {
      fail(`指向主控区网段 ${HOME_VPC_CIDR} 的路由有 ${homeRoutes.length} 条,期望 2 条(两个私有子网各一张路由表)—— ` +
        `少一条 ⇒ 那个 AZ 的任务回写不了台账,而另一个 AZ 正常 ⇒ **间歇性**失败,最难查的一类`);
    }
    for (const [lid, r] of homeRoutes) {
      if (!r.Properties?.VpcPeeringConnectionId) fail(`路由 ${lid} 没有指向 peering(下一跳缺失)`);
      // 🔴 必须**等 accept 完成**再建:pending-acceptance 的 peering 加路由会被拒 ⇒ 依赖自定义资源
      const deps = [].concat(r.DependsOn ?? []);
      if (deps.length === 0) fail(`路由 ${lid} 没有 DependsOn —— 它必须等主控区那边 accept 完成(否则 CreateRoute 撞 pending-acceptance)`);
    }
    // 主控区那一侧的接线(accept + 回程路由 + 读回端点 ENI IP)必须由**自定义资源**做
    const customs = res.filter(([, v]) => String(v.Type).startsWith("Custom::") || v.Type === "AWS::CloudFormation::CustomResource");
    if (customs.length === 0) {
      fail("模板里没有自定义资源 —— 主控区那一侧的 accept / 回程路由 / ENI IP 三件事没人做" +
        "(放 buildspec 里做的话删环境时回程路由会留成 blackhole,下一个环境分到同段就撞 RouteAlreadyExists)");
    }
    // ⑥ 私有托管域 + A 记录(缺了 = 默认域名仍解析公网 ⇒ 台账回写静默超时)
    const zones = res.filter(([, v]) => v.Type === "AWS::Route53::HostedZone");
    const records = res.filter(([, v]) => v.Type === "AWS::Route53::RecordSet");
    if (zones.length !== plan2.homeLink.length) fail(`homeLink 有 ${plan2.homeLink.length} 个服务却有 ${zones.length} 个私有托管域 —— 缺一个就意味着那个服务名仍解析公网`);
    for (const [lid, v] of zones) {
      if (!v.Properties?.VPCs?.length) fail(`私有托管域 ${lid} 没有关联 VPC(不关联 = 对任务不生效)`);
      if (v.Properties?.Name !== `dynamodb.${HOME_REGION}.amazonaws.com.`) {
        fail(`私有托管域 ${lid} 的域名是 ${v.Properties?.Name},期望 dynamodb.${HOME_REGION}.amazonaws.com.`);
      }
    }
    if (records.length !== plan2.homeLink.length) fail(`私有托管域有 ${zones.length} 个,A 记录只有 ${records.length} 条`);
    for (const [lid, v] of records) {
      if (v.Properties?.Type !== "A") fail(`记录 ${lid} 的类型是 ${v.Properties?.Type},期望 A`);
      // 🔴 A 记录的值必须来自**自定义资源**(端点 ENI 的私有 IP 部署期读回);写死 IP 就是下一次的定时炸弹
      const rr = JSON.stringify(v.Properties?.ResourceRecords ?? null);
      if (!v.Properties?.ResourceRecords) fail(`记录 ${lid} 没有 ResourceRecords —— 主控区端点在另一个 region 的另一个栈里,这边拿不到 DnsEntries 做 ALIAS`);
      else if (!/Fn::GetAtt|Fn::Split/.test(rr)) fail(`记录 ${lid} 的 ResourceRecords 是字面量 ${rr.slice(0, 80)} —— ENI IP 必须部署期读回,不许写死`);
    }
    // ⑦ 🔴 授权锚点**反向**:`vpce:AllowMultiRegion` 那条特殊授权必须已从源码里删掉。
    //    留着一条组织层永远拒的授权,会让下一个人以为「权限给了、是别处的问题」——
    //    它正是让挂了三天的原因(ROADMAP §2octies.58)。
    const psText = readFileSync(resolve(INFRA, "lib/platform-stack.ts"), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (/vpce:AllowMultiRegion/.test(psText)) {
      fail("platform-stack.ts 里仍有 vpce:AllowMultiRegion 的授权(注释除外)—— 那个动作被组织 SCP 拦死、授了也没用," +
        "留着只会让人以为权限已经给了(SPEC §3.14ter 已改选型)");
    }
  }

  // ⑧ 🔴 清单 ⊇ 运行时真实 boto3 服务集(ACCEPTANCE N0-2 第二层)
  //    只比「模板 == 清单」等于自己跟自己对账;这一层才是防「漏项」复发的门(spike 漏了两个)。
  const covered = new Set([...plan.iface, ...plan.gateway]);
  for (const svc of execEnvRuntimeBoto3Services()) {
    if (!covered.has(svc)) {
      fail(`运行时会调 ${svc},而端点清单里没有它 —— 零出网下该调用会静默超时 10 秒后失败(endpoints.ts 要补)`);
    }
  }
  // ⑨ RUNTIME_BOTO3_SERVICES 自身不许与真实代码脱节:扫运行时与三个 DAG 生成器里的 boto3 调用
  {
    const files = [
      "platform/src/lib/scheduler/serverless/runtime-py.ts",
      "platform/src/lib/etl/dag-generator.ts",
      "platform/src/lib/engines/emr/dag-generator.ts",
      "platform/src/lib/sync/glue-script-generator.ts",
    ];
    const found = new Set();
    for (const f of files) {
      const txt = readFileSync(resolve(REPO, f), "utf8");
      for (const m of txt.matchAll(/boto3\.(?:client|resource)\(\s*["']([a-z0-9-]+)["']/g)) found.add(m[1]);
    }
    const declared = new Set(execEnvRuntimeBoto3Services());
    const missing = [...found].filter((x) => !declared.has(x)).sort();
    if (missing.length) {
      fail(`运行时新增了 boto3 服务 ${JSON.stringify(missing)} 而 endpoints.ts 的 RUNTIME_BOTO3_SERVICES 没登记 —— 这正是早期 spike 漏掉 s3tables / redshift-serverless 的形状`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5) 🔴 数据保护(§12 P0-A;风险表唯一"客户数据永久丢失"项)
//    数据桶 / 表桶 / CMK 必须 Retain,且**整组模板里不许有 S3 自动清空的 Custom Resource**
// ══════════════════════════════════════════════════════════════════════════════
// 别名也必须 Retain:钥匙留下而别名随栈删掉 ⇒ 删除预览承诺保留的
//   `alias/bgp-data-<slug>` 找不到(2026-10-11 第二账号真销毁实测)。
const RETAIN_TYPES = ["AWS::S3::Bucket", "AWS::S3Tables::TableBucket", "AWS::KMS::Key", "AWS::KMS::Alias"];
if (manifest) {
  let checked = 0;
  for (const n of stackNames) {
    const tpl = template(n);
    const text = readFileSync(resolve(OUT, `${n}.template.json`), "utf8");
    if (/S3AutoDeleteObjects|autoDeleteObjects/i.test(text)) {
      fail(`栈 ${n} 出现 S3 自动清空(AutoDeleteObjects)⇒ cdk destroy 会删客户数据,§12 P0-A 明令禁止`);
    }
    for (const [lid, res] of Object.entries(tpl.Resources || {})) {
      if (!RETAIN_TYPES.includes(res.Type)) continue;
      checked++;
      if (res.DeletionPolicy !== "Retain") fail(`${n}/${lid}(${res.Type})DeletionPolicy=${res.DeletionPolicy},必须 Retain`);
      if (res.UpdateReplacePolicy !== "Retain") {
        fail(`${n}/${lid}(${res.Type})UpdateReplacePolicy=${res.UpdateReplacePolicy},必须 Retain(替换也不许删数据)`);
      }
    }
  }
  // 防假绿:一个都没查到说明类型名写错了
  if (checked < 5) fail(`只检查到 ${checked} 个数据类资源(期望 ≥5:2 桶 + 表桶 + CMK + CMK 别名)—— 类型名可能写错了`);

  // ── §5b 🔴 资源文案字段一律 ASCII(判据与理由见 assertAsciiDescriptions)────────
  let descChecked = 0;
  for (const n of stackNames) descChecked += assertAsciiDescriptions(template(n), n);
  if (descChecked < 3) fail(`§5b 只扫到 ${descChecked} 个文案字段(期望 ≥3:SG + Athena WG + CMK)—— 字段名可能写错了`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 6) 🔴 名字必须出自命名 SSOT(而不是栈里拼的)
// ══════════════════════════════════════════════════════════════════════════════
if (manifest) {
  const core = template(`BgpExecEnv-${SLUG}-core`);
  const base = template(`BgpExecEnv-${SLUG}-base`);
  const outs = (t) => Object.fromEntries(Object.entries(t.Outputs || {}).map(([k, v]) => [k, v.Value]));
  const coreOuts = outs(core);

  const expectations = {
    datalakeBucket: expectName("datalakeBucket"),
    scriptsBucket: expectName("scriptsBucket"),
    tableBucket: expectName("tableBucket"),
    athenaWorkgroup: expectName("athenaWorkgroup"),
  };
  for (const [key, want] of Object.entries(expectations)) {
    if (coreOuts[key] !== want) fail(`core 输出 ${key}=${JSON.stringify(coreOuts[key])},SSOT 期望 ${want}`);
  }

  // 🔴 **只断 Outputs 不够** —— 变异实测:把 `bucketName` 硬编码成 `bgp-datalake-hardcoded`、
  //    而 Output 仍写 SSOT 变量,门禁**全绿通过**。那正是最危险的一种:描述符里的名字与真实资源名不一致
  //    ⇒ 平台按描述符去读一个**不存在的桶**,报 404 而不是报"名字错了"。
  //    ⇒ 必须断**资源属性本身**,并断"属性与 Output 一致"。
  const propNames = {
    "AWS::S3::Bucket": "BucketName",
    "AWS::S3Tables::TableBucket": "TableBucketName",
    "AWS::Athena::WorkGroup": "Name",
    "AWS::EC2::SecurityGroup": "GroupName",
  };
  const actualNames = [];
  for (const [lid, res] of Object.entries(core.Resources)) {
    const prop = propNames[res.Type];
    if (!prop) continue;
    const v = res.Properties?.[prop];
    if (typeof v !== "string") {
      fail(`core/${lid}(${res.Type})的 ${prop} 不是定值字符串:${JSON.stringify(v)} —— 实名必须在 synth 期就定下来`);
      continue;
    }
    actualNames.push(v);
    // 每个真实资源名都必须是 SSOT 对某个 kind 的产物
    const fromSsot = Object.keys(naming.kinds).some((k) => {
      try {
        return expectName(k) === v;
      } catch {
        return false;
      }
    });
    if (!fromSsot) fail(`core/${lid} 的 ${prop}="${v}" 不是命名 SSOT 任何 kind 的产物 ⇒ 名字在栈里拼的`);
  }
  // 资源属性与 Output 必须一一对上(防"输出写 SSOT、资源用别的名")
  for (const want of Object.values(expectations)) {
    if (!actualNames.includes(want)) fail(`SSOT 期望的名字 ${want} 在 core 的**资源属性**里找不到(只出现在 Output 里 = 假一致)`);
  }
  if (actualNames.length < 4) fail(`只抽到 ${actualNames.length} 个资源实名(期望 ≥4)—— 属性名映射表可能写错了`);
  // SG 名与 KMS 别名在资源属性里(不是输出)。
  // 🔴 门禁第一版读的是 Tags 里的 Name —— 错的:CDK 的 `securityGroupName` 落在 **GroupName** 属性上。
  //    这类"断言看错字段"会让门禁恒红(这次)或恒绿(更糟),所以判据要对着真模板核过一次。
  const sg = Object.values(core.Resources).find((r) => r.Type === "AWS::EC2::SecurityGroup");
  const sgName = sg?.Properties?.GroupName;
  if (sgName !== expectName("emrSecurityGroup")) {
    fail(`EMR SG 的 Name 标签=${JSON.stringify(sgName)},SSOT 期望 ${expectName("emrSecurityGroup")}`);
  }
  const alias = Object.values(base.Resources).find((r) => r.Type === "AWS::KMS::Alias");
  if (alias?.Properties?.AliasName !== expectName("dataKeyAlias")) {
    fail(`KMS 别名=${JSON.stringify(alias?.Properties?.AliasName)},SSOT 期望 ${expectName("dataKeyAlias")}`);
  }
  // ──:🔴 **反转**(SPEC v3.21 §6.1 段二)—— 原「glueRoleArn 必须指向 home 角色、出现 slug 即 fail」
  //    是段一的过渡定案;跨法域 target 上线前的硬门 = 每个 target 用**绑死本 target** 的角色。
  //    ⇒ glueRoleArn 必须是本 target 的 SSOT 名、**不许**是 home 名;core 还必须吐 emrExecutionRoleArn。
  const glueName = roleNameOfOutput(core, coreOuts.glueRoleArn);
  if (glueName !== expectName("glueRole")) {
    fail(`glueRoleArn 不是本 target 的角色(SSOT 期望 ${expectName("glueRole")},实为 ${glueName})—— 共享角色只剩 home`);
  }
  if (typeof glueName === "string" && glueName === naming.kinds.glueRole.home) {
    fail(`glueRoleArn 仍指向 home 的 ${glueName} —— 那是早期过渡形态,SPEC v3.21 已作废`);
  }
  const emrName = roleNameOfOutput(core, coreOuts.emrExecutionRoleArn);
  if (emrName !== expectName("emrServerlessRole")) {
    fail(`core 缺 emrExecutionRoleArn 输出或它不是本 target 的角色(SSOT 期望 ${expectName("emrServerlessRole")},实为 ${emrName})`);
  }
  // 两个角色的三层绑定逐条打(名 / 信任 / 区域条件 / 资源面)
  assertPerTargetRole(core, "core", "glueRole", { trustServices: ["glue.amazonaws.com"] });
  assertPerTargetRole(core, "core", "emrServerlessRole", {
    trustServices: ["emr-serverless.amazonaws.com"],
    sourceArnIncludes: `emr-serverless:${REGION}:${ACCOUNT}:/applications/*`,
  });
  const coreRoles = Object.values(core.Resources).filter((r) => r.Type === "AWS::IAM::Role");
  if (coreRoles.length !== 2) fail(`core 栈应恰好 2 个 IAM 角色(glue + emr),实际 ${coreRoles.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 7) 负向:未实现的组件必须**报错**,不许静默少装(⚡ --fast 跳过:多一次完整 synth)
// ══════════════════════════════════════════════════════════════════════════════
// 🔴 起 redshift/dms/flink 已实现 ⇒ 负向清单收缩到"仍未实现"的四个。
//    这份名单必须与 stack-group.ts 的 IMPLEMENTED_COMPONENTS **互补**:门禁从源码抽那个常量来核对,
//    免得"代码实现了组件、门禁还在期待它报错"(或反过来:组件被摘掉而门禁仍当它可用)。
// residency-api 片 1 已实现 ⇒ 名单收缩到三个
// mwaa 已实现(每个 target 自己的 Airflow)⇒ 名单收缩到两个
// 🔴🔴 名单是**三分**的,不是二分 —— 多了 `EXTERNAL_COMPONENTS`
//    (由平台自己的栈部署,栈组**跳过**它:既不建栈也不报错)。这里原来把 `agentcore` 留在
//    「未实现」里,于是本节期待它 synth 报错;而让它变成静默跳过 ⇒ 本节从那天起就是红的
//    (收官时只跑了 `--fast`,而这一节 `--fast` 会跳过 ⇒ **红了没人看见**)。
//    ⇒ external 从源码读(单一作者 = stack-group.ts),闭合式改成三段;并给 external 补正向判据。
const NOT_YET_COMPONENTS = ["kafka"];
const EXTERNAL_COMPONENTS_FROM_SOURCE = (() => {
  const sgSrc = readFileSync(resolve(INFRA, "lib/exec-env/stack-group.ts"), "utf8");
  const m = sgSrc.match(/EXTERNAL_COMPONENTS\s*=\s*\[([^\]]+)\]/);
  if (!m) {
    fail("stack-group.ts 里找不到 EXTERNAL_COMPONENTS —— 第三类(外部组件)名单没了?门禁的组件模型会与源码脱节");
    return [];
  }
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
})();
{
  const sgSrc = readFileSync(resolve(INFRA, "lib/exec-env/stack-group.ts"), "utf8");
  const m = sgSrc.match(/IMPLEMENTED_COMPONENTS\s*=\s*\[([^\]]+)\]/);
  if (!m) fail("stack-group.ts 里找不到 IMPLEMENTED_COMPONENTS —— 门禁的组件名单无法与源码对齐(改了名字就得改这里)");
  else {
    const impl = Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
    const all = allComponentsFromSource();
    const union = [...impl, ...NOT_YET_COMPONENTS, ...EXTERNAL_COMPONENTS_FROM_SOURCE].sort();
    if (JSON.stringify(union) !== JSON.stringify([...all].sort())) {
      fail(
        `组件名单不闭合:已实现 [${impl.join(",")}] + 未实现 [${NOT_YET_COMPONENTS.join(",")}] ` +
          `+ 外部 [${EXTERNAL_COMPONENTS_FROM_SOURCE.join(",")}] ≠ 枚举全集 [${all.join(",")}] —— ` +
          `有组件三类都不在(门禁会漏测它),或同时在两类里(名单必须两两不相交)`
      );
    }
    for (const c of EXTERNAL_COMPONENTS_FROM_SOURCE) {
      if (impl.includes(c) || NOT_YET_COMPONENTS.includes(c)) fail(`组件 ${c} 同时出现在 external 与另一类名单里 —— 三份名单必须两两不相交`);
    }
  }
}
// ── 7c):broker 的组件全集必须**派生自** context.ts,不许自持名单 ──
//   真环境撞到:平台 / 栈组已认 airflow-serverless,broker validate.mjs 还是旧的八项 ⇒ 页面「+ 补充部署」被拒「未知组件」。
{
  const validateSrc = readFileSync(resolve(INFRA, "lambda/exec-env-broker/validate.mjs"), "utf8");
  if (/export const COMPONENTS\s*=\s*\[/.test(validateSrc)) fail("validate.mjs 又出现字面组件名单 `export const COMPONENTS = [...]` —— 组件全集只许从 EXEC_ENV_COMPONENT_ENUM 派生(context.ts 唯一真源)");
  if (!/parseComponentEnum\(process\.env\.EXEC_ENV_COMPONENT_ENUM\)/.test(validateSrc)) fail("validate.mjs 没有 `parseComponentEnum(process.env.EXEC_ENV_COMPONENT_ENUM)` —— broker 组件全集与 context.ts 断链");
  const depSrc = readFileSync(resolve(INFRA, "lib/exec-env/deploy-stack.ts"), "utf8");
  // ②:完整组件集注入 broker(validate.mjs 判「下发集 ⊇ 它」)
  if (!/EXEC_ENV_REQUIRED_COMPONENTS:\s*EXEC_ENV_REQUIRED_BASE_COMPONENTS\.join\(","\)/.test(depSrc)) fail("deploy-stack.ts 没把 EXEC_ENV_REQUIRED_BASE_COMPONENTS 注入 broker env EXEC_ENV_REQUIRED_COMPONENTS(broker 判不了精简形态)");
  if (!/EXEC_ENV_COMPONENT_ENUM:\s*EXEC_ENV_COMPONENTS\.join\(","\)/.test(depSrc)) fail("deploy-stack.ts 没把 EXEC_ENV_COMPONENTS.join(\",\") 注入 broker env EXEC_ENV_COMPONENT_ENUM(broker 加载即抛)");
}

/** 组件枚举全集:从 context.ts 抽,不手抄(手抄的名单会和枚举一起漂)。 */
function allComponentsFromSource() {
  const src = readFileSync(resolve(INFRA, "lib/exec-env/context.ts"), "utf8");
  const m = src.match(/EXEC_ENV_COMPONENTS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) {
    fail("context.ts 里抽不到 EXEC_ENV_COMPONENTS —— 组件全集未知");
    return [];
  }
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

if (!FAST) {
  // 🔴 **逐个**组件各来一条(不是把四个一起勾):一起勾的话,只要其中一个仍未实现就会抛,
  //    于是"某个组件被悄悄放行"这件事会被别人的报错掩盖成假绿。
  for (const c of NOT_YET_COMPONENTS) {
    const neg = listApp(ctxWith({ add: [`exec-env-components=core,${c}`] }));
    if (neg.ok) {
      fail(`勾选 core,${c} 竟然构造成功 —— 未实现的组件必须显式报错(静默少装 = 描述符声称装了、实际没有)`);
    } else if (!neg.out.includes(c) || !/未实现的组件/.test(neg.out) || !/已实现/.test(neg.out)) {
      fail(`勾选未实现组件 ${c} 时报错信息不对(应指名 ${c}、说明"未实现的组件"并列出"已实现"清单):${neg.out.slice(-400)}`);
    }
  }
  // mwaa 缺 -c exec-env-home-region 必须 synth 抛(不知道控制面在哪就不许建回写策略;猜错 = 定时 run 静默写不进台账)
  {
    const noHome = listApp(ctxWith({ drop: ["exec-env-home-region"], add: ["exec-env-components=core,mwaa"] }));
    if (noHome.ok) fail("勾 mwaa 却没传 exec-env-home-region 竟然构造成功 —— context.ts 的 fail-closed 失效");
    else if (!/exec-env-home-region/.test(noHome.out)) fail(`mwaa 缺 home-region 时报错未指名 exec-env-home-region:${noHome.out.slice(-300)}`);
    // 同理(该区 workflow 回写 home 台账)
    const noHomeSls = listApp(ctxWith({ drop: ["exec-env-home-region"], add: ["exec-env-components=core,airflow-serverless"] }));
    if (noHomeSls.ok) fail("勾 airflow-serverless 却没传 exec-env-home-region 竟然构造成功 —— context.ts 的 fail-closed 失效");
    else if (!/exec-env-home-region/.test(noHomeSls.out)) fail(`airflow-serverless 缺 home-region 时报错未指名 exec-env-home-region:${noHomeSls.out.slice(-300)}`);
  }
  // external 组件(agentcore)= **跳过**语义 —— synth 必须成功,且**不为它建栈**。
  //   两条都要:只断「不报错」的话,「悄悄给它建一个空栈」也能过;只断「没有栈」的话,报错也算没栈。
  for (const c of EXTERNAL_COMPONENTS_FROM_SOURCE) {
    const ext = listApp(ctxWith({ add: [`exec-env-components=core,${c}`] }));
    if (!ext.ok) {
      fail(`勾选 core,${c}(external:由平台自己的栈部署)竟然构造失败 —— 栈组该**跳过**它而不是报错` +
        `(留在「未实现」里会让装了它的 home 永远补装不了任何组件):${ext.out.slice(-300)}`);
    } else {
      const stacks = ext.out.split("\n").map((x) => x.trim()).filter(Boolean);
      const forExt = stacks.filter((n) => n.endsWith(`-${c}`));
      if (forExt.length) fail(`栈组为 external 组件 ${c} 建了栈 ${forExt.join(",")} —— 它由平台自己的栈部署,组内不该有它`);
      if (!stacks.some((n) => n.endsWith("-base")) || !stacks.some((n) => n.endsWith("-core"))) {
        fail(`勾 core,${c} 时连 base/core 都没列出来(${stacks.join(",")})—— 判据看的不是同一个东西了`);
      }
    }
  }
  // 反向防假绿:**已实现**的组件绝不许落到这条报错上(否则"未实现"名单写宽了也不会红)
  for (const c of ["redshift", "dms", "flink", "mwaa", "airflow-serverless"]) {
    const pos = listApp(ctxWith({ add: [`exec-env-components=core,${c}`] }));
    if (!pos.ok) fail(`已实现的组件 ${c} 竟然构造失败 —— 组件栈没接上(或被误列进"未实现"名单):${pos.out.slice(-400)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 7b) 🔴 正向:已实现的组件栈(redshift / dms / flink)必须真装出来且合同对得上
//
// 【为什么必须单独一节】§1-6 只 synth 了 core-only ⇒ 组件栈的 Output 键、RETAIN、per-target 角色名
//   一条都没被看过。这一节带 `exec-env-components=core,redshift,dms,flink` 再 synth 一次,逐条打:
//     · 栈数与栈名(条件装配对不对);
//     · **OutputKey = 描述符字段名**(平台侧 finalize 按 key 取值,漏一个 = 描述符缺字段被 §3.1a 拒);
//     · Output 值出自命名 SSOT(不是在栈里拼的);
//     · Redshift namespace/workgroup **RETAIN**(§12 P0-A:删环境不许删仓库数据);
//     · flink 角色名 **per-target**(§12 P0-D:IAM 全局,用 home 名第二 region 必 AlreadyExists);
//     · secret 名的**派生不变量**(`redshift!<namespace>-admin`)—— 断的是"两个 kind 保持派生关系",
//       它是平台侧"按名 DescribeSecret 换真 ARN"能成立的前提;
//     · 文案 ASCII(复用 §5b 同一份判据)。
// ⚡ --fast 跳过(多一次完整 synth);提交前必跑全量。
// ══════════════════════════════════════════════════════════════════════════════
if (!FAST) {
  const allCtx = ctxWith({ add: ["exec-env-components=core,redshift,dms,flink,residency-api,mwaa,airflow-serverless"] });
  const r2 = synth(allCtx);
  if (!r2.ok) {
    fail(`带 redshift/dms/flink 的 synth 失败(组件栈装不出来):\n${r2.out.slice(-1500)}`);
  } else {
    const mf = readManifest();
    if ((mf.missing || []).length > 0) {
      fail(`组件栈 synth 请求了 context provider ${(mf.missing || []).map((m) => m.provider).join(", ")} —— 必须零查找`);
    }
    const names = Object.entries(mf.artifacts)
      .filter(([, a]) => a.type === "aws:cloudformation:stack")
      .map(([id]) => id);
    const prefix = `BgpExecEnv-${SLUG}-`;
    const wantStacks = ["base", "core", "redshift", "dms", "flink", "residency-api", "mwaa", "airflow-serverless"].map((s) => prefix + s).sort();
    if (JSON.stringify([...names].sort()) !== JSON.stringify(wantStacks)) {
      fail(`勾 core,redshift,dms,flink,residency-api,mwaa,airflow-serverless 应产出 ${wantStacks.join(", ")},实际:${names.join(", ")}`);
    }

    // 🔴 删栈顺序 vs 真实依赖图:一个栈被删的时候,依赖它的栈必须**都已经删完**
    //   (否则 CFN 报 Export 正被引用 ⇒ 整条删除链停住)。顺序的唯一作者 = destroy-order.ts;这里只核对,不另写一份。
    {
      const order = destroyOrderSsot();
      const want = order.map((sfx) => prefix + sfx);
      if (JSON.stringify([...want].sort()) !== JSON.stringify([...names].sort())) {
        fail(`§7d 删栈顺序覆盖的栈(${want.join(", ")})≠ 全组件 synth 产出的栈(${names.join(", ")})—— 加了组件没进删除顺序`);
      }
      let depEdges = 0;
      for (const n of names) {
        // 只看**栈**之间的依赖(manifest 里还有 `<栈>.assets` 这类资产清单产物,它们不是要删的栈)
        const deps = (mf.artifacts[n]?.dependencies || []).filter((d) => names.includes(d));
        for (const d of deps) {
          depEdges++;
          if (want.indexOf(d) < want.indexOf(n)) {
            fail(`§7d 删栈顺序错:${d} 排在 ${n} 之前删,而 ${n} 依赖 ${d}(先删被依赖者 ⇒ Export 被引用、删除链停住)`);
          }
        }
      }
      // 正控制:组件栈都显式依赖 base(+ 多数依赖 core)⇒ 栈间依赖边至少 7 条;抽不到 = 上面的核对在空转
      if (depEdges < 7) fail(`§7d 只从 manifest 抽到 ${depEdges} 条栈间依赖(<7)—— 依赖图没读到,删栈顺序核对在空转`);
      if (want[want.length - 1] !== prefix + "base" || want[want.length - 2] !== prefix + "core") {
        fail(`§7d 删栈顺序的最后两个必须是 core → base,实际:${want.slice(-2).join(" → ")}`);
      }
      globalThis.__destroyOrder = want.length;
    }

    // 每个栈都必须落在目标 region(与 §3 同一判据,组件栈也不例外)
    for (const n of names) {
      const envUri = mf.artifacts[n]?.environment;
      if (envUri !== `aws://${ACCOUNT}/${REGION}`) fail(`组件栈 ${n} 的 environment=${envUri},应为 aws://${ACCOUNT}/${REGION}`);
    }

    // 文案 ASCII(组件栈是本批新代码,正是最需要这条的地方)
    let descN = 0;
    for (const n of names) descN += assertAsciiDescriptions(template(n), n);
    if (descN < 5) fail(`§7b 只扫到 ${descN} 个文案字段(期望 ≥5:两个 SG + Athena WG + CMK + IAM 角色)—— 字段名或栈装配可能坏了`);

    const outsOf = (n) => Object.fromEntries(Object.entries(template(n).Outputs || {}).map(([k, v]) => [k, v.Value]));

    // ① redshift 栈
    const rs = template(prefix + "redshift");
    const rsOuts = outsOf(prefix + "redshift");
    const wantRsOuts = {
      redshiftWorkgroup: expectName("redshiftWorkgroup"),
      redshiftDatabase: expectName("redshiftDatabase"),
      redshiftSecretName: expectName("redshiftAdminSecretName"),
      redshiftNamespace: expectName("redshiftNamespace"),
    };
    for (const [k, want] of Object.entries(wantRsOuts)) {
      if (rsOuts[k] !== want) fail(`redshift 栈的 Output ${k}=${JSON.stringify(rsOuts[k])},SSOT 期望 ${want}`);
    }
    // 🔴 secret 名不是 ARN ⇒ **绝不许**出现名为 redshiftSecretArn 的 Output(那会让平台把名字当 ARN
    //    塞进描述符,被 §3.1a 的 ARN 校验拒 = 部署完却永远 finalize 不了)。
    if ("redshiftSecretArn" in rsOuts) {
      fail(
        `redshift 栈吐了 redshiftSecretArn —— 托管 secret 的 ARN 带服务生成随机后缀、模板里拼不出来,` +
          `本栈只吐 redshiftSecretName(名字),平台侧须 DescribeSecret 换真 ARN`
      );
    }
    // 派生不变量:预测名 === "redshift!" + namespace + "-admin"(改一个另一个必须跟)
    const predicted = `redshift!${expectName("redshiftNamespace")}-admin`;
    if (expectName("redshiftAdminSecretName") !== predicted) {
      fail(`命名 SSOT 的 redshiftAdminSecretName(${expectName("redshiftAdminSecretName")})≠ redshift!<namespace>-admin(${predicted})—— 平台按名 describe 会 404`);
    }
    // 资源属性本身(不只看 Output):namespace/workgroup 实名 + adminUsername + RETAIN
    const ns = Object.entries(rs.Resources).find(([, x]) => x.Type === "AWS::RedshiftServerless::Namespace");
    const wg = Object.entries(rs.Resources).find(([, x]) => x.Type === "AWS::RedshiftServerless::Workgroup");
    if (!ns || !wg) fail(`redshift 栈缺 Namespace 或 Workgroup(实际类型:${Object.values(rs.Resources).map((x) => x.Type).join(", ")})`);
    else {
      if (ns[1].Properties?.NamespaceName !== expectName("redshiftNamespace")) {
        fail(`Namespace 的 NamespaceName=${JSON.stringify(ns[1].Properties?.NamespaceName)},SSOT 期望 ${expectName("redshiftNamespace")}`);
      }
      if (ns[1].Properties?.DbName !== expectName("redshiftDatabase")) {
        fail(`Namespace 的 DbName=${JSON.stringify(ns[1].Properties?.DbName)},SSOT 期望 ${expectName("redshiftDatabase")}`);
      }
      // 🔴 adminUsername 必须是 admin:它是 `redshift!<ns>-admin` 这条预测的另一半
      if (ns[1].Properties?.AdminUsername !== "admin") {
        fail(`Namespace 的 AdminUsername=${JSON.stringify(ns[1].Properties?.AdminUsername)},必须是 "admin" —— 否则托管 secret 名的预测(${predicted})就错了`);
      }
      if (ns[1].Properties?.ManageAdminPassword !== true) {
        fail(`Namespace 未开 ManageAdminPassword —— 口令必须由服务托管(自建 secret 会与 home 口径分叉)`);
      }
      if (wg[1].Properties?.WorkgroupName !== expectName("redshiftWorkgroup")) {
        fail(`Workgroup 的 WorkgroupName=${JSON.stringify(wg[1].Properties?.WorkgroupName)},SSOT 期望 ${expectName("redshiftWorkgroup")}`);
      }
      if (wg[1].Properties?.PubliclyAccessible !== false) {
        fail(`Workgroup 的 PubliclyAccessible=${JSON.stringify(wg[1].Properties?.PubliclyAccessible)},必须 false(仓库不许暴露公网)`);
      }
      for (const [lid, res] of [ns, wg]) {
        if (res.DeletionPolicy !== "Retain" || res.UpdateReplacePolicy !== "Retain") {
          fail(`redshift/${lid}(${res.Type})的 Deletion/UpdateReplace 策略=${res.DeletionPolicy}/${res.UpdateReplacePolicy},必须都 Retain(§12 P0-A:删环境不许删仓库数据)`);
        }
      }
    }

    // ①b:per-target COPY 角色挂在 namespace 上(非 home 的 `COPY … IAM_ROLE default` 从此成立)
    const copyLid = assertPerTargetRole(rs, "redshift", "redshiftCopyRole", { trustServices: ["redshift.amazonaws.com"] });
    if (copyLid && ns) {
      const iamRoles = JSON.stringify(ns[1].Properties?.IamRoles ?? "");
      const def = JSON.stringify(ns[1].Properties?.DefaultIamRoleArn ?? "");
      if (!iamRoles.includes(`"${copyLid}"`)) fail(`redshift Namespace 的 IamRoles 没挂本 target 的 COPY 角色(${copyLid}):${iamRoles}`);
      if (!def.includes(`"${copyLid}"`)) fail(`redshift Namespace 的 DefaultIamRoleArn 不是本 target 的 COPY 角色:${def}`);
    }
    if (roleNameOfOutput(rs, rsOuts.redshiftCopyRoleArn) !== expectName("redshiftCopyRole")) {
      fail(`redshift 栈缺 redshiftCopyRoleArn 输出或它不是本 target 的角色`);
    }

    // ② dms 栈
    const dmsOuts = outsOf(prefix + "dms");
    if (dmsOuts.dmsSubnetGroup !== expectName("dmsSubnetGroup")) {
      fail(`dms 栈的 Output dmsSubnetGroup=${JSON.stringify(dmsOuts.dmsSubnetGroup)},SSOT 期望 ${expectName("dmsSubnetGroup")}`);
    }
    const dmsTpl = template(prefix + "dms");
    const sng = Object.values(dmsTpl.Resources).find((x) => x.Type === "AWS::DMS::ReplicationSubnetGroup");
    if (!sng) fail("dms 栈里没有 AWS::DMS::ReplicationSubnetGroup");
    else {
      if (sng.Properties?.ReplicationSubnetGroupIdentifier !== expectName("dmsSubnetGroup")) {
        fail(`DMS 子网组的 Identifier=${JSON.stringify(sng.Properties?.ReplicationSubnetGroupIdentifier)},SSOT 期望 ${expectName("dmsSubnetGroup")}`);
      }
      const subnets = sng.Properties?.SubnetIds;
      if (!Array.isArray(subnets) || subnets.length < 2) {
        fail(`DMS 子网组只给了 ${JSON.stringify(subnets)} —— DMS 要求覆盖 ≥2 个 AZ 的子网`);
      }
    }

    // ②b:per-target DMS 角色(信任含区域化 dms.<region>;消费方接线)
    assertPerTargetRole(dmsTpl, "dms", "dmsKinesisRole", {
      trustServices: ["dms.amazonaws.com", `dms.${REGION}.amazonaws.com`, "redshift.amazonaws.com"],
    });
    if (roleNameOfOutput(dmsTpl, dmsOuts.dmsKinesisRoleArn) !== expectName("dmsKinesisRole")) {
      fail(`dms 栈缺 dmsKinesisRoleArn 输出或它不是本 target 的角色`);
    }

    // ③ flink 栈
    const flinkTpl = template(prefix + "flink");
    const flinkOuts = outsOf(prefix + "flink");
    if (!flinkOuts.flinkRoleArn) fail("flink 栈没有 flinkRoleArn 输出(描述符的 flink 组件必备字段)");
    const role = Object.values(flinkTpl.Resources).find((x) => x.Type === "AWS::IAM::Role");
    if (!role) fail("flink 栈里没有 AWS::IAM::Role");
    else {
      const rn = role.Properties?.RoleName;
      if (rn !== expectName("flinkRole")) fail(`flink 角色名=${JSON.stringify(rn)},SSOT 期望 per-target 名 ${expectName("flinkRole")}`);
      // 🔴 P0-D:绝不许用 home 的角色名(IAM 全局 ⇒ 第二 region 建同名必 AlreadyExists)
      if (rn === naming.kinds.flinkRole.home) {
        fail(`flink 角色用了 home 名 ${rn} —— IAM 是全局资源,第二 region 建同名必 AlreadyExists(§12 P0-D)`);
      }
      if (typeof rn === "string" && !rn.includes(SLUG)) fail(`flink 角色名 ${rn} 里没有 slug ⇒ 多 target 会撞名`);
    }
    // 策略里的桶必须是 **本 target 的**(指回 home 桶 = 数据出境 / 跨 region 读写)。
    //   datalake / scripts 桶仍是单桶字面;表桶自数据湖表桶路由(设计稿 §6.7)起是「本区任意表桶」bucket/*(形态由 §9.8 断),
    //   这里钉的事实改为「每条 s3tables 资源的 region / account 段 == 本 target」—— 不再找桶名字面(找字面 = 钉形态,与 §9.8 矛盾)。
    const flinkText = JSON.stringify(flinkTpl);
    for (const kind of ["datalakeBucket", "scriptsBucket"]) {
      if (!flinkText.includes(expectName(kind))) fail(`flink 角色策略里找不到本 target 的 ${kind}(${expectName(kind)})—— 作业读写会指到别处`);
    }
    {
      const flinkRoleLid = Object.entries(flinkTpl.Resources || {}).find(([, r]) => r.Type === "AWS::IAM::Role")?.[0] ?? null;
      const s3t = flinkRoleLid ? s3tablesStatements(flinkTpl, flinkRoleLid) : [];
      const wantArn = `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/*`;
      if (!s3t.length) fail("flink 角色策略里没有 s3tables 语句 —— 本 target 的表桶 sink 没放行");
      for (const st of s3t) {
        for (const r of [].concat(st.Resource ?? [])) {
          const text = arnText(r);
          if (text !== wantArn) fail(`flink 角色 s3tables 资源 ${text} 不是本 target 的「本区任意表桶」${wantArn} —— 作业读写会指到别处`);
        }
      }
    }
    for (const kind of ["datalakeBucket", "scriptsBucket", "tableBucket"]) {
      const homeName = naming.kinds[kind].home.split("{account}").join(ACCOUNT);
      // home 名是 per-target 名的前缀(如 bgp-table-bucket vs bgp-table-bucket-tgt-usw2-a),
      // 故必须用**带引号/边界**的比对,不能裸 includes(裸比对恒真 = 假红)。
      if (new RegExp(`${homeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/"])`).test(flinkText)) {
        fail(`flink 角色策略里出现 home 的 ${kind}(${homeName})—— 第二 region 的作业不许读写 home 的数据`);
      }
    }
    // ④:residency-api 片 1(区域审计表 / 结果表 / 结果桶;SPEC v3.22 §1.3a S4)
    const resTpl = template(prefix + "residency-api");
    const resOuts = outsOf(prefix + "residency-api");
    const wantResOuts = {
      residencyAuditTable: expectName("residencyAuditTable"),
      residencyResultsTable: expectName("residencyResultsTable"),
      residencyBucket: expectName("residencyBucket"),
    };
    for (const [k, want] of Object.entries(wantResOuts)) {
      if (resOuts[k] !== want) fail(`residency-api 栈的 Output ${k}=${JSON.stringify(resOuts[k])},SSOT 期望 ${want}`);
    }
    const resTables = Object.entries(resTpl.Resources).filter(([, x]) => x.Type === "AWS::DynamoDB::Table");
    if (resTables.length !== 2) fail(`residency-api 栈应恰好 2 张 DDB 表,实际 ${resTables.length}`);
    for (const [lid, r] of resTables) {
      if (r.DeletionPolicy !== "Retain" || r.UpdateReplacePolicy !== "Retain") fail(`residency-api/${lid} 表未 Retain(审计 / 结果是客户数据,删环境不许删)`);
      if (r.Properties?.SSESpecification?.SSEEnabled !== true || !r.Properties?.SSESpecification?.KMSMasterKeyId) fail(`residency-api/${lid} 表未用底座 CMK 加密`);
      if (r.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !== true) fail(`residency-api/${lid} 表未开 PITR`);
      const names = [r.Properties?.TableName].map(String);
      if (!names.some((n) => n === expectName("residencyAuditTable") || n === expectName("residencyResultsTable"))) fail(`residency-api/${lid} 表名不出自 SSOT:${names}`);
    }
    const resBucket = Object.entries(resTpl.Resources).find(([, x]) => x.Type === "AWS::S3::Bucket");
    if (!resBucket) fail("residency-api 栈里没有 AWS::S3::Bucket(区域结果桶)");
    else {
      const [lid, b] = resBucket;
      if (b.Properties?.BucketName !== expectName("residencyBucket")) fail(`residency-api 桶名=${JSON.stringify(b.Properties?.BucketName)},SSOT 期望 ${expectName("residencyBucket")}`);
      if (b.DeletionPolicy !== "Retain") fail(`residency-api/${lid} 桶未 Retain`);
      const sse = JSON.stringify(b.Properties?.BucketEncryption ?? "");
      if (!sse.includes("aws:kms")) fail(`residency-api/${lid} 桶未用 KMS 加密:${sse.slice(0, 120)}`);
      const pol = Object.values(resTpl.Resources).find((x) => x.Type === "AWS::S3::BucketPolicy");
      const polText = JSON.stringify(pol?.Properties?.PolicyDocument ?? {});
      for (const a of ["s3:ReplicateObject", "s3:PutReplicationConfiguration"]) {
        if (!polText.includes(a)) fail(`residency-api 桶策略缺 deny ${a}(结果留区)`);
      }
      if (!/"Effect":"Deny"/.test(polText)) fail("residency-api 桶策略没有 Deny 语句");
    }
    // 栈里不许有任何 API / Lambda(片 2 ;混进来就是把「区域数据面」偷跑进片 1)
    for (const [lid, x] of Object.entries(resTpl.Resources)) {
      if (/^AWS::(ApiGateway|ApiGatewayV2|Lambda)::/.test(x.Type)) fail(`residency-api 片 1 不该有 ${x.Type}(${lid})—— 区域 API 不在片 1`);
    }

    // ⑥:airflow-serverless 栈(MWAA Serverless 入口;SPEC v3.27 §3.15)
    {
      const slTpl = template(prefix + "airflow-serverless");
      const slOuts = outsOf(prefix + "airflow-serverless");
      if (slOuts.workflowBucket !== expectName("workflowBucket")) fail(`airflow-serverless 栈的 Output workflowBucket=${JSON.stringify(slOuts.workflowBucket)},SSOT 期望 ${expectName("workflowBucket")}`);
      for (const k of ["airflowServerlessRoleArn", "airflowServerlessSgId"]) if (slOuts[k] === undefined) fail(`airflow-serverless 栈缺 Output ${k}(§1.1 组件↔资源配套)`);
      const slBucket = Object.entries(slTpl.Resources).find(([, x]) => x.Type === "AWS::S3::Bucket");
      if (!slBucket) fail("airflow-serverless 栈里没有 AWS::S3::Bucket(定义 / 代码包桶)");
      else {
        const [lid, b] = slBucket;
        if (b.Properties?.BucketName !== expectName("workflowBucket")) fail(`airflow-serverless 桶名=${JSON.stringify(b.Properties?.BucketName)},SSOT 期望 ${expectName("workflowBucket")}`);
        if (b.Properties?.VersioningConfiguration?.Status !== "Enabled") fail(`airflow-serverless/${lid} 桶未开版本控制 —— 服务按 VersionId 快照定义与代码包`);
        if (b.DeletionPolicy !== "Retain") fail(`airflow-serverless/${lid} 桶未 Retain(exec-env 纪律)`);
      }
      if (Object.values(slTpl.Resources).some((x) => x.Type === "AWS::MWAAServerless::Workflow")) fail("airflow-serverless 栈里不该建 workflow(一个作业一个 workflow,由平台在发布时建)");
      const sgRes = Object.entries(slTpl.Resources).find(([, x]) => x.Type === "AWS::EC2::SecurityGroup");
      if (!sgRes) fail("airflow-serverless 栈里没有工作 SG");
      else if (sgRes[1].Properties?.GroupName !== expectName("airflowServerlessSg")) fail(`airflow-serverless 工作 SG 名=${JSON.stringify(sgRes[1].Properties?.GroupName)},SSOT 期望 ${expectName("airflowServerlessSg")}(seed-home / 探活按名查 id)`);
      const ingress = Object.values(slTpl.Resources).find((x) => x.Type === "AWS::EC2::SecurityGroupIngress");
      if (!ingress || ingress.Properties?.IpProtocol !== "-1") fail("airflow-serverless 工作 SG 缺自引用 inbound all(官方要求)");
      const want = expectName("airflowServerlessRole");
      const rlid = roleLidByName(slTpl, want);
      if (!rlid) fail(`airflow-serverless 栈里没有 RoleName=${want} 的 AWS::IAM::Role(SSOT kind airflowServerlessRole)`);
      else {
        const role = slTpl.Resources[rlid];
        if ((role.Properties?.ManagedPolicyArns || []).length > 0) fail(`airflow-serverless/${rlid} 挂了 AWS 托管策略`);
        if (!JSON.stringify(role.Properties?.AssumeRolePolicyDocument?.Statement || []).includes('"airflow-serverless.amazonaws.com"')) fail(`airflow-serverless/${rlid} 信任缺 airflow-serverless.amazonaws.com`);
        const stmts = roleStatements(slTpl, rlid);
        const text = JSON.stringify(stmts);
        if (!/glue:CreateJob/.test(text)) fail("airflow-serverless 角色缺 glue:CreateJob(GlueJobOperator 走幂等 CreateJob,spike 真撞 AccessDenied)");
        if (!/table\/bgp-\*/.test(text) || !new RegExp(`dynamodb:${HOME_REGION}:`).test(text.replace(/[{}"\s]/g, "")) && !text.includes(`dynamodb:${HOME_REGION}:`)) fail("airflow-serverless 角色缺控制面回写语句(home bgp-* 表)");
        const ledger = stmts.find((x) => x.Sid === "ControlPlaneRunLedgerKms");
        if (!ledger || ledger.Condition?.StringEquals?.["aws:RequestedRegion"] !== HOME_REGION) fail("airflow-serverless 角色的回写 KMS 语句缺 aws:RequestedRegion=home");
        const passRoles = stmts.filter((x) => JSON.stringify(x.Action).includes("iam:PassRole"));
        if (passRoles.length < 2) fail("airflow-serverless 角色 PassRole 须覆盖本 target 的 EMR 与 Glue 两个执行角色");
      }
    }
    // ⑤:mwaa 栈(每个 target 自己的 Airflow;SPEC v3.26 §3.14)
    {
      const mwTpl = template(prefix + "mwaa");
      const mwOuts = outsOf(prefix + "mwaa");
      for (const [k, kind] of [["dagBucket", "dagBucket"], ["mwaaEnvName", "mwaaEnvName"]]) {
        if (mwOuts[k] !== expectName(kind)) fail(`mwaa 栈的 Output ${k}=${JSON.stringify(mwOuts[k])},SSOT 期望 ${expectName(kind)}`);
      }
      const mwBucket = Object.entries(mwTpl.Resources).find(([, x]) => x.Type === "AWS::S3::Bucket");
      if (!mwBucket) fail("mwaa 栈里没有 AWS::S3::Bucket(DAG 桶)");
      else {
        const [lid, b] = mwBucket;
        if (b.Properties?.BucketName !== expectName("dagBucket")) fail(`mwaa DAG 桶名=${JSON.stringify(b.Properties?.BucketName)},SSOT 期望 ${expectName("dagBucket")}`);
        if (b.Properties?.VersioningConfiguration?.Status !== "Enabled") fail(`mwaa/${lid} DAG 桶未开版本控制 —— MWAA CreateEnvironment 会 400`);
        if (b.DeletionPolicy !== "Retain") fail(`mwaa/${lid} DAG 桶未 Retain(exec-env 纪律:删环境不顺手删桶)`);
      }
      const mwEnv = Object.entries(mwTpl.Resources).find(([, x]) => x.Type === "AWS::MWAA::Environment");
      if (!mwEnv) fail("mwaa 栈里没有 AWS::MWAA::Environment");
      else {
        const [lid, e] = mwEnv;
        if (e.Properties?.Name !== expectName("mwaaEnvName")) fail(`MWAA 环境名=${JSON.stringify(e.Properties?.Name)},SSOT 期望 ${expectName("mwaaEnvName")}`);
        if (e.DeletionPolicy !== "Retain" || e.UpdateReplacePolicy !== "Retain") fail(`mwaa/${lid} 环境未 Retain(有状态托管环境,P0-E)`);
        const subnets = e.Properties?.NetworkConfiguration?.SubnetIds;
        if (!Array.isArray(subnets) || subnets.length !== 2) fail(`MWAA 环境须恰好 2 个私有子网,实际 ${JSON.stringify(subnets)}`);
        if (e.Properties?.DagS3Path !== "dags/") fail(`MWAA DagS3Path=${JSON.stringify(e.Properties?.DagS3Path)},平台下发口径是 dags/`);
      }
      // 角色:名出自 SSOT / 信任 SourceAccount / 不挂托管策略 / `*` 语句区域条件 —— 🔴 唯一例外 = 控制面回写 KMS(RequestedRegion=home)
      const want = expectName("mwaaRole");
      const rlid = roleLidByName(mwTpl, want);
      if (!rlid) fail(`mwaa 栈里没有 RoleName=${want} 的 AWS::IAM::Role(SSOT kind mwaaRole)`);
      else {
        const role = mwTpl.Resources[rlid];
        if ((role.Properties?.ManagedPolicyArns || []).length > 0) fail(`mwaa/${rlid} 挂了 AWS 托管策略`);
        const trust = role.Properties?.AssumeRolePolicyDocument?.Statement || [];
        const trustText = JSON.stringify(trust);
        for (const svc of ["airflow.amazonaws.com", "airflow-env.amazonaws.com"]) if (!trustText.includes(`"${svc}"`)) fail(`mwaa/${rlid} 信任缺 ${svc}`);
        for (const st of trust) if (st.Condition?.StringEquals?.["aws:SourceAccount"] !== ACCOUNT) fail(`mwaa/${rlid} 信任语句缺 aws:SourceAccount=${ACCOUNT}`);
        const stmts = roleStatements(mwTpl, rlid);
        if (stmts.length < 8) fail(`mwaa/${rlid} 只抽到 ${stmts.length} 条策略语句(期望 ≥8)`);
        let homeKms = 0, ddbHome = 0;
        for (const st of stmts) {
          const res = [].concat(st.Resource ?? []);
          const acts = [].concat(st.Action ?? []);
          const text = JSON.stringify(st);
          if (res.some((r) => r === "*")) {
            const cond = st.Condition?.StringEquals?.["aws:RequestedRegion"];
            const viaHomeDdb = st.Condition?.StringEquals?.["kms:ViaService"] === `dynamodb.${HOME_REGION}.amazonaws.com`;
            if (viaHomeDdb) {
              homeKms++;
              if (cond !== HOME_REGION) fail(`mwaa/${rlid} 控制面回写 KMS 语句的 aws:RequestedRegion=${cond},应为 home ${HOME_REGION}`);
              if (!/kms:ResourceAliases/.test(text)) fail(`mwaa/${rlid} 控制面回写 KMS 语句缺 kms:ResourceAliases 条件(应只对 home 数据域 CMK)`);
            } else if (cond !== REGION) {
              fail(`mwaa/${rlid} 有 Resource:"*" 的语句没挂 aws:RequestedRegion=${REGION}(Action=${JSON.stringify(acts).slice(0, 100)})—— 横移`);
            }
          }
          if (acts.some((a) => String(a).startsWith("dynamodb:"))) {
            ddbHome++;
            // ARN 含 partition 伪参数 ⇒ 模板里是 Fn::Join 数组,按 JSON 文本判(与 §7b 其它判据同法)
            if (!res.every((r) => JSON.stringify(r).includes(`:dynamodb:${HOME_REGION}:`))) fail(`mwaa/${rlid} DDB 语句的 ARN 不在 home region ${HOME_REGION}:${JSON.stringify(res)}(控制面单份,回写只许写 home)`);
          }
          if (acts.includes("iam:PassRole") && !text.includes(expectName("emrServerlessRole"))) fail(`mwaa/${rlid} PassRole 未指向本 target 的 EMR 角色 ${expectName("emrServerlessRole")}`);
          if (/bgp-mwaa"/.test(text) && !text.includes(expectName("mwaaEnvName"))) fail(`mwaa/${rlid} 策略里出现 home 的环境名 bgp-mwaa`);
        }
        if (homeKms !== 1) fail(`mwaa/${rlid} 控制面回写 KMS 语句应恰好 1 条(via dynamodb.${HOME_REGION}),实际 ${homeKms}`);
        if (ddbHome < 1) fail(`mwaa/${rlid} 没有任何 DDB 回写语句 —— 定时 run 写不进 home 台账`);
      }
      const mwStacksAutoDelete = Object.values(mwTpl.Resources).some((x) => String(x.Type).includes("AutoDeleteObjects"));
      if (mwStacksAutoDelete) fail("mwaa 栈里有 S3 自动清空 Custom Resource(exec-env 纪律禁)");
    }    globalThis.__componentStacks = names.length;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// 8) context 解析的正负向用例(经 infra 自己的 ts-node 跑一个 driver,一次进程跑完所有用例)
//
// 为什么不放 vitest:`lib/shared/naming.ts` 用 `__dirname` + readFileSync(照 model.ts 先例),
// 在 vitest 的 ESM 管道里 `__dirname` 未定义 ⇒ 根本 import 不进来。用 ts-node(CJS)最直接。
// 🔴 头号承重:**不传 `-c exec-env-target` 时必须返回 null** —— 那是"控制面行为零变化"的支点。
// ══════════════════════════════════════════════════════════════════════════════
const CTX_DRIVER = `
const { readExecEnvContext, parseComponents, parseAzs } = require(${JSON.stringify(resolve(INFRA, "lib/exec-env/context.ts"))});
// 组件集不再缺省成 core ⇒ 夹具默认带完整组件集(显式写 undefined 才是「不传」)
const FULL_COMPONENTS = "core,redshift,dms,flink,airflow-serverless";
const mk = (o) => (k) => (k === "exec-env-components" && !("exec-env-components" in o) ? FULL_COMPONENTS : o[k]);
const cases = [];
const t = (name, fn) => { try { cases.push({ name, ok: true, value: fn() }); } catch (e) { cases.push({ name, ok: false, err: String(e.message || e) }); } };

t("不传 target ⇒ null(控制面零变化的支点)", () => readExecEnvContext(mk({}), "123456789012"));
const HL = { "exec-env-home-vpc-id": "vpc-0123456789abcdef0", "exec-env-home-vpc-cidr": "10.0.0.0/16", "exec-env-home-ddb-endpoint-id": "vpce-0123456789abcdef0" };
t("正常", () => readExecEnvContext(mk({ "exec-env-target": "tgt_usw2_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", ...HL }), "123456789012"));
t("home target", () => readExecEnvContext(mk({ "exec-env-target": "tgt_home", "exec-env-region": "us-east-1" }), "123456789012"));
for (const bad of ["tgt-usw2-a", "TGT_A", "tgt_a_", "usw2", "tgt_" + "a".repeat(17)]) {
  t("非法 targetId " + bad, () => readExecEnvContext(mk({ "exec-env-target": bad, "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1" }), "123456789012"));
}
t("缺 region", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a" }), "123456789012"));
t("非法 region", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west", "exec-env-home-region": "us-east-1" }), "123456789012"));
t("非法 account", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1" }), "123"));
t("未知组件", () => parseComponents("core,corex"));
t("不传组件(不再缺省成 core)", () => parseComponents(undefined));
t("context 显式不传组件 ⇒ 抛", () => readExecEnvContext(mk({ "exec-env-target": "tgt_usw2_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", ...HL, "exec-env-components": undefined }), "123456789012"));
t("缺 core", () => parseComponents("redshift"));
t("空串组件", () => parseComponents(""));
t("组件顺序归一", () => parseComponents("redshift,core"));
// 入参 exec-env-nat-gateways 已退役 ⇒ 传任何值都必须抛
//   (不是「1..3 合法、其余非法」,而是整个入参消失;静默忽略会让运维以为自己调了档)。
//   🔴 本块在 CTX_DRIVER 模板字面量内 —— 注释里不许出现反引号,否则提前结束模板串。
for (const any of ["0", "1", "2", "3", "4", "x"]) {
  t("nat=" + any + "(已退役,传了就该抛)", () =>
    readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-nat-gateways": any }), "123456789012"));
}
// 非 home target 缺 home-region ⇒ 必抛(零出网之后跨区回写那条路建不出来)
t("非 home 缺 home-region", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2" }), "123456789012"));
// home target 不需要 home-region(不能被上一条误伤)
t("home 不需要 home-region", () => readExecEnvContext(mk({ "exec-env-target": "tgt_home", "exec-env-region": "us-east-1" }), "123456789012"));
// VPC 地址段(非 home 必填;池子与主控区 10.0.0.0/16 构造上不相交)
t("非 home 缺 vpc-cidr", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", ...HL }), "123456789012"));
t("非法 cidr 与主控区重叠", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.0.0.0/16" }), "123456789012"));
t("非法 cidr 掩码不是 16", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/20" }), "123456789012"));
t("home 不需要 vpc-cidr", () => readExecEnvContext(mk({ "exec-env-target": "tgt_home", "exec-env-region": "us-east-1" }), "123456789012"));
// 主控区那三件事实(非 home 三个都必需;少一个就是「peering 有、回程路由没有」)
t("非 home 缺 home-vpc-id", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", "exec-env-home-vpc-cidr": "10.0.0.0/16", "exec-env-home-ddb-endpoint-id": "vpce-0123456789abcdef0" }), "123456789012"));
t("非 home 缺 home-ddb-endpoint", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", "exec-env-home-vpc-id": "vpc-0123456789abcdef0", "exec-env-home-vpc-cidr": "10.0.0.0/16" }), "123456789012"));
t("非法 home-vpc-id 形态", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", ...HL, "exec-env-home-vpc-id": "not-a-vpc" }), "123456789012"));
// 🔴 主控区网段落进地址池 ⇒ 任何执行环境都建不出通路 ⇒ 必须部署期一句话拦住(不是等回写神秘超时)
t("非法 home 网段与池相交", () => readExecEnvContext(mk({ "exec-env-target": "tgt_a", "exec-env-region": "us-west-2", "exec-env-home-region": "us-east-1", "exec-env-vpc-cidr": "10.128.0.0/16", ...HL, "exec-env-home-vpc-cidr": "10.130.0.0/16" }), "123456789012"));
t("azs 缺省", () => parseAzs(undefined, "us-west-2"));
t("azs 跨 region", () => parseAzs("us-east-1a,us-west-2b", "us-west-2"));
t("azs 只给一个", () => parseAzs("us-west-2a", "us-west-2"));
t("azs 重复", () => parseAzs("us-west-2a,us-west-2a", "us-west-2"));
process.stdout.write(JSON.stringify(cases));
`;

const ctxDriverPath = resolve(INFRA, "_exec_env_ctx_driver.ts");
let ctxCases = [];
try {
  writeFileSync(ctxDriverPath, CTX_DRIVER, "utf8");
  const out = execFileSync(resolve(INFRA, "node_modules/.bin/ts-node"), ["--transpile-only", "-P", resolve(INFRA, "tsconfig.json"), ctxDriverPath], {
    cwd: INFRA,
    env: NO_CRED_ENV,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ctxCases = JSON.parse(out);
} catch (e) {
  fail(`context 用例 driver 跑不起来:${String(e?.stderr || e?.message).slice(-400)}`);
} finally {
  try {
    rmSync(ctxDriverPath, { force: true });
  } catch {
    /* 已不在就算了 */
  }
}

const byName = Object.fromEntries(ctxCases.map((c) => [c.name, c]));
const mustThrow = ctxCases.filter((c) => /非法|缺 region|缺 core|未知组件|空串|nat=|跨 region|只给一个|重复|非法 account|缺 home-region|缺 vpc-cidr|缺 home-vpc-id|缺 home-ddb-endpoint|不传组件|显式不传组件/.test(c.name));
for (const c of mustThrow) {
  if (c.ok) fail(`context 用例「${c.name}」应当抛错,却通过了(值 ${JSON.stringify(c.value)})`);
}
// ②:不传组件必须**因为这个原因**抛(只断「抛了」会让换个原因抛的缺陷存活)
for (const n of ["不传组件(不再缺省成 core)", "context 显式不传组件 ⇒ 抛"]) {
  const c = byName[n];
  if (!c || c.ok || !/必须显式给/.test(c.err || "")) fail(`context 用例「${n}」应以「必须显式给」拒绝,实际 ${JSON.stringify(c)}`);
}
if (mustThrow.length < 24) fail(`只收集到 ${mustThrow.length} 条负向用例(期望 ≥24)—— driver 或筛选正则坏了`);

const nullCase = byName["不传 target ⇒ null(控制面零变化的支点)"];
if (!nullCase?.ok || nullCase.value !== null) {
  fail(`🔴 不传 exec-env-target 时应返回 null,实际 ${JSON.stringify(nullCase)} —— 这条一破,控制面就会被 exec-env 模式误伤`);
}
const okCase = byName["正常"];
if (!okCase?.ok || okCase.value?.region !== "us-west-2" || okCase.value?.isHome !== false) {
  fail(`正常用例解析结果不对:${JSON.stringify(okCase)}`);
}
const homeCase = byName["home target"];
if (!homeCase?.ok || homeCase.value?.isHome !== true) fail(`home target 的 isHome 应为 true:${JSON.stringify(homeCase)}`);
// 正控制 —— 「非 home 缺 home-region 必抛」这条不许把 home 一起误伤
const homeNoHr = byName["home 不需要 home-region"];
if (!homeNoHr?.ok) fail(`home target 不该被 home-region 校验拦住:${JSON.stringify(homeNoHr)}`);
// 段必须**真的**进到 context 里(少这一处,栈组拿到 undefined 而 tsc 照样绿)
if (okCase?.value?.vpcCidr !== "10.128.0.0/16") {
  fail(`context 没把 exec-env-vpc-cidr 解析进返回值:${JSON.stringify(okCase?.value?.vpcCidr)} —— ` +
    `base 栈会回落 CDK 默认 10.0.0.0/16,与主控区逐位相同 ⇒ 跨区 peering 建不出来`);
}
// 🔴🔴 负向用例必须断**拒因**,不能只断「抛了」。
//    实测教训(本批变异 M3):我把「非 home 缺 vpc-cidr」写成同时也缺 home-link 三件事实 ⇒
//    它是因为**缺 home-link** 抛的;于是「给 vpcCidr 留一个静默默认值」这个变异**存活**
//    (那条用例照样红着,而红因跟被测的东西无关)。这是本会话第 N 次「用例因错误的原因通过」。
for (const [name, re] of [
  ["非 home 缺 vpc-cidr", /exec-env-vpc-cidr/],
  ["非 home 缺 home-vpc-id", /exec-env-home-vpc-id/],
  ["非 home 缺 home-ddb-endpoint", /exec-env-home-ddb-endpoint-id/],
  ["非法 cidr 与主控区重叠", /地址池/],
  ["非法 home 网段与池相交", /相交/],
]) {
  const c = byName[name];
  if (!c) fail(`context 用例「${name}」不见了 —— driver 被改了?`);
  else if (c.ok) fail(`context 用例「${name}」应当抛错,却通过了(值 ${JSON.stringify(c.value)})`);
  else if (!re.test(String(c.err))) {
    fail(`context 用例「${name}」抛了但**拒因不对**:${String(c.err).slice(0, 200)} —— ` +
      `期望匹配 ${re}。只断「抛了」的判据会让「换个原因抛」的缺陷存活(变异 M3 实测)`);
  }
}

// 三件事实必须**成组**进 context(捆成一个对象 = 「只有两个」不可表达)
if (!okCase?.value?.homeLink || okCase.value.homeLink.vpcId !== "vpc-0123456789abcdef0" ||
    okCase.value.homeLink.vpcCidr !== "10.0.0.0/16" || okCase.value.homeLink.ddbEndpointId !== "vpce-0123456789abcdef0") {
  fail(`context 的 homeLink 不对:${JSON.stringify(okCase?.value?.homeLink)} —— 少一件就是「peering 建了、回程路由没加」`);
}
if (byName["home target"]?.value?.homeLink !== undefined) {
  fail("home 的 context 不该有 homeLink(它就是主控区,不与自己 peering)");
}
const homeNoCidr = byName["home 不需要 vpc-cidr"];
if (!homeNoCidr?.ok || homeNoCidr.value?.vpcCidr !== "10.0.0.0/16") {
  fail(`home 应沿用存量段 10.0.0.0/16(对 home 行为逐字节不变):${JSON.stringify(homeNoCidr)}`);
}
// 退役入参:正常用例里不该出现 natGateways 字段(留着 = 类型没真删)
if (okCase?.value && "natGateways" in okCase.value) {
  fail("context 返回值里仍有 natGateways —— 该字段应已从类型里删除(A4:让非法状态无法表达)");
}
const orderCase = byName["组件顺序归一"];
if (JSON.stringify(orderCase?.value) !== JSON.stringify(["core", "redshift"])) {
  fail(`组件顺序未归一(synth 不可复现):${JSON.stringify(orderCase)}`);
}
const azDefault = byName["azs 缺省"];
if (JSON.stringify(azDefault?.value) !== JSON.stringify(["us-west-2a", "us-west-2b"])) {
  fail(`azs 缺省不对:${JSON.stringify(azDefault)}`);
}


// ══════════════════════════════════════════════════════════════════════════════
// 9) 🔴 部署权隔离(切片 b;DESIGN §12.0)—— 需要 synth **控制面**(慢一点,但这是安全基石)
//
// 断的是"IAM 的形状",不是"我记得我写对了":
//   · 平台 ECS 角色**不许**有 codebuild:StartBuild(有它 = 能 inline 恶意 buildspec 借强权角色部署)
//   · 平台 ECS 角色**不许**有 codebuild:UpdateProject(改项目定义 = 变相提权)
//   · broker 角色的 StartBuild **必须**限定到那一个项目,不许 "*"
//   · buildspec **必须**来自源包里的文件(不是项目里 inline 的可改字符串)
//   · 源包**体积有上限** + 关键文件在位 + 禁忌目录不在(实测踩过:排除清单只写 `dir/**` 不剪枝,
//     staged asset 曾是 509MB,把 node_modules/docs/qa-game 全打进去了)
// ══════════════════════════════════════════════════════════════════════════════
// ⚡ --fast 跳过整个 §9(控制面 synth 是全门禁最慢的一节);提交前必跑全量让它执行。
if (!FAST) {
const CP_OUT = resolve(tmpdir(), "bgp-synth-gate-cp"); // 同上:必须在仓外
if (existsSync(CP_OUT)) rmSync(CP_OUT, { recursive: true, force: true });
let cpOk = true;
try {
  // 🔴 只 synth 本节要断的**两个**栈,不用 `--all`。
  //    原因:控制面既有的 `BgpVpcStack` 用 `maxAzs` ⇒ 会请求 availability-zones provider(要凭证)。
  //    那是既有代码、本批不动;而 CDK 只对**被选中的栈**报 annotation error ⇒ 选中这两个即可全离线。
  //    (试过用 `-c` 直接喂 AZ context:不行 —— context key 本身含 `=`,`-c k=v` 按**第一个** `=` 切,
  //     key 会被截成 `availability-zones:account`。这条弯路记下来,免得下一个人再试。)
  // 多 synth 一个 `BgpEmrStack`(-c enable-emr=1)—— 9.7 要断 home EMR 角色的 S3 面已收回。
  // 再多 synth 一个 `BgpFlinkStack`(-c enable-flink=1)—— §9.8 要断主控区 Flink 角色的 s3tables 面是「本区任意表桶」形态。
  execFileSync("npx", ["cdk", "synth", "BgpExecEnvDeployStack", "BgpPlatformStack", "BgpEmrStack", "BgpFlinkStack", "-c", "enable-emr=1", "-c", "enable-flink=1", "--quiet", "-o", CP_OUT], {
    cwd: INFRA,
    env: { ...NO_CRED_ENV, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: "us-east-1" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 900_000,
  });
} catch (e) {
  cpOk = false;
  fail(`控制面 synth 失败(部署权隔离一节无法判定):${String(e?.stdout || e?.stderr || "").slice(-800)}`);
}

if (cpOk) {
  const cpTpl = (n) => JSON.parse(readFileSync(resolve(CP_OUT, `${n}.template.json`), "utf8"));

  // ── §9r 🔴🔴 **主控区**数据类资源必须 Retain(§5 只管执行区)──
  //    原来主控区数据湖 / 脚本 / DAG 桶 = DESTROY + 自动清空、表桶 / Athena 工作组 = DESTROY、
  //    数仓命名空间不设(CFN 默认 Delete)⇒ 一次误删栈 = 客户数据湖整片消失。闭合式:按**类型**列全,
  //    不按逻辑 ID 点名(新加一个桶也自动进来);下限防「类型名写错 ⇒ 一个都没查到」的假绿。
  {
    const HOME_DATA_TYPES = ["AWS::S3::Bucket", "AWS::S3Tables::TableBucket", "AWS::Athena::WorkGroup", "AWS::RedshiftServerless::Namespace"];
    const seen = Object.fromEntries(HOME_DATA_TYPES.map((t) => [t, 0]));
    for (const n of ["BgpPlatformStack", "BgpRedshiftStack"]) {
      const p = resolve(CP_OUT, `${n}.template.json`);
      if (!existsSync(p)) { fail(`§9r 控制面 synth 产物里没有 ${n}.template.json ⇒ 主控区数据保护无从判定`); continue; }
      const text = readFileSync(p, "utf8");
      if (/Custom::S3AutoDeleteObjects/.test(text)) fail(`§9r ${n} 出现 S3 自动清空(Custom::S3AutoDeleteObjects)⇒ 删栈会清空主控区客户数据`);
      for (const [lid, res] of Object.entries(JSON.parse(text).Resources || {})) {
        if (!HOME_DATA_TYPES.includes(res.Type)) continue;
        seen[res.Type]++;
        if (res.DeletionPolicy !== "Retain" || res.UpdateReplacePolicy !== "Retain") {
          fail(`§9r ${n}/${lid}(${res.Type})Deletion/UpdateReplace=${res.DeletionPolicy}/${res.UpdateReplacePolicy},主控区数据类资源必须都 Retain`);
        }
        if (res.Type === "AWS::Athena::WorkGroup" && res.Properties?.RecursiveDeleteOption === true) {
          fail(`§9r ${n}/${lid} RecursiveDeleteOption=true ⇒ 删工作组会连同查询历史一起删`);
        }
      }
    }
    // 下限:3 个数据桶 + 表桶 + Athena 工作组 + 数仓命名空间
    if (seen["AWS::S3::Bucket"] < 3) fail(`§9r 主控区只查到 ${seen["AWS::S3::Bucket"]} 个 S3 桶(期望 ≥3:datalake / glue-scripts / mwaa-dags)—— 类型名或栈名写错了`);
    for (const t of HOME_DATA_TYPES.slice(1)) if (seen[t] < 1) fail(`§9r 主控区没查到 ${t} —— 类型名或栈名写错了(判据不许假绿)`);
  }

  // ── §9m 🔴🔴 **部署模式**(唯一作者 lib/shared/deploy-mode.ts)──
  //    production(也是缺省)⇒ app 里**没有**演示源库 BgpRdsStack、初始用户名单**只有 admin**;
  //    demo ⇒ 两样都有(正控制)。各 synth 一次 BgpAuthStack(离线、秒级),读 manifest 与引导 Lambda 的 ROSTER_JSON。
  {
    const modeSynth = (mode) => {
      const dir = resolve(tmpdir(), `bgp-synth-gate-mode-${mode || "default"}`);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      const args = ["cdk", "synth", "BgpAuthStack", "--quiet", "-o", dir, ...(mode ? ["-c", `deploy-mode=${mode}`] : [])];
      try {
        execFileSync("npx", args, { cwd: INFRA, env: { ...NO_CRED_ENV, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: "us-east-1", BGP_DEPLOY_MODE: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        fail(`§9m deploy-mode=${mode || "(缺省)"} 的 synth 失败:${String(e?.stdout || e?.stderr || "").slice(-400)}`);
        return null;
      }
      const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
      const tpl = JSON.parse(readFileSync(resolve(dir, "BgpAuthStack.template.json"), "utf8"));
      const rosters = Object.values(tpl.Resources || {})
        .map((r) => r?.Properties?.Environment?.Variables?.ROSTER_JSON)
        .filter((v) => typeof v === "string");
      rmSync(dir, { recursive: true, force: true });
      return { stacks: Object.keys(manifest.artifacts || {}), rosters };
    };
    for (const [mode, wantRds, wantUsers] of [[null, false, ["admin"]], ["production", false, ["admin"]], ["demo", true, ["admin", "biz-tester", "ops-analyst", "pm-tester", "rbac-tester"]]]) {
      const r = modeSynth(mode);
      if (!r) continue;
      const label = mode || "(缺省)";
      if (r.stacks.includes("BgpRdsStack") !== wantRds) fail(`§9m deploy-mode=${label}:BgpRdsStack 在 app 里=${!wantRds},应为 ${wantRds}(演示源库只许 demo 模式部署)`);
      if (r.rosters.length !== 1) { fail(`§9m deploy-mode=${label}:找到 ${r.rosters.length} 个 ROSTER_JSON(应恰好 1 个,判据不许假绿)`); continue; }
      const users = Object.keys(JSON.parse(r.rosters[0])).sort();
      if (JSON.stringify(users) !== JSON.stringify(wantUsers)) fail(`§9m deploy-mode=${label}:初始用户名单=${JSON.stringify(users)},应为 ${JSON.stringify(wantUsers)}`);
    }
  }

  // ── §9z 🔴🔴 **主控区那一侧**的跨区落点(ACCEPTANCE N0-13 的静态半边)──
  //    非 home 的私网通路全靠这一个端点。三条都要:是**接口**端点 · `PrivateDnsEnabled` **必须 false**
  //    (开着会把 home 本区的 DynamoDB 流量劫到计费路径上 —— 症状是账单不是报错)· SG 只放行**整池**。
  {
    const vpcTplPath = resolve(CP_OUT, "BgpVpcStack.template.json");
    if (!existsSync(vpcTplPath)) {
      // BgpVpcStack 不在本节的 synth 目标里时不硬红(它是 BgpPlatformStack 的依赖,通常会被一起 synth 出来)
      console.log("  §9z 跳过:CP_OUT 里没有 BgpVpcStack.template.json");
    } else {
      const vt = JSON.parse(readFileSync(vpcTplPath, "utf8"));
      const res9 = Object.entries(vt.Resources || {});
      const xr = res9.filter(([, v]) => v.Type === "AWS::EC2::VPCEndpoint" && v.Properties?.VpcEndpointType === "Interface");
      const ddb = xr.filter(([, v]) => JSON.stringify(v.Properties?.ServiceName ?? "").includes(".dynamodb"));
      if (ddb.length !== 1) {
        fail(`§9z 主控区 VPC 里的 DynamoDB **接口**端点有 ${ddb.length} 个(期望恰好 1)—— 非 home 的私网通路全靠它(SPEC §3.14ter)`);
      } else {
        const [lid, v] = ddb[0];
        if (v.Properties?.PrivateDnsEnabled !== false) {
          fail(`§9z ${lid} 的 PrivateDnsEnabled=${JSON.stringify(v.Properties?.PrivateDnsEnabled)},必须显式 false —— ` +
            `开着会把 home 本区的 DynamoDB 流量从公共路径劫到**按 GB 计费**的接口端点上(症状是账单不是报错)`);
        }
        const sgRefs = JSON.stringify(v.Properties?.SecurityGroupIds ?? []);
        const sgs = res9.filter(([slid, sv]) => sv.Type === "AWS::EC2::SecurityGroup" && sgRefs.includes(slid));
        if (sgs.length !== 1) fail(`§9z 该端点挂了 ${sgs.length} 个安全组(期望恰好 1 个专用组)`);
        else {
          const ing = sgs[0][1].Properties?.SecurityGroupIngress ?? [];
          const pool = ing.filter((r) => r.CidrIp === "10.128.0.0/9" && r.FromPort === 443);
          if (pool.length !== 1) fail(`§9z 端点安全组没有「整池 443」那条放行规则(实际 ${JSON.stringify(ing)})`);
          if (ing.length !== 1) {
            fail(`§9z 端点安全组有 ${ing.length} 条入站规则(期望恰好 1 条 = 整池)—— ` +
              `CDK 的 \`open\` 默认 true 会**再加一条**「本 VPC CIDR 443」;这个端点只为跨区而存在,别放宽`);
          }
        }
      }
    }
  }

  // 9.1 部署机制栈必须存在
  if (!existsSync(resolve(CP_OUT, "BgpExecEnvDeployStack.template.json"))) {
    fail("控制面缺 BgpExecEnvDeployStack —— exec-env 的 CodeBuild 项目与 broker 没被部署");
  } else {
    const dep = cpTpl("BgpExecEnvDeployStack");
    const resources = Object.entries(dep.Resources || {});

    // 9.2 broker 的 StartBuild 必须限定到项目,不许 "*"
    // 🔴 只数 **Allow**:修法①(9.2c)刻意加了 5 条 Deny 语句也带 StartBuild —— 不分 Effect 的话
    //    "恰好 1 条"会被自家纵深措施判红(门禁自查时实测)。授权面看 Allow,纵深看 9.2c。
    const startStmts = [];
    for (const [, r] of resources) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      for (const st of r.Properties?.PolicyDocument?.Statement || []) {
        const acts = [].concat(st.Action || []);
        if (acts.includes("codebuild:StartBuild") && st.Effect !== "Deny") startStmts.push(st);
      }
    }
    if (startStmts.length !== 1) fail(`部署栈里 codebuild:StartBuild 的 Allow 语句应恰好 1 条(broker),实际 ${startStmts.length} 条`);
    // 9.1b broker Lambda 的 EXEC_ENV_COMPONENT_ENUM(模板真值)必须 == context.ts 枚举
    {
      const fns = resources.filter(([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties?.FunctionName === "bgp-exec-env-broker");
      if (fns.length !== 1) fail(`部署栈里应恰好 1 个 bgp-exec-env-broker Lambda,实际 ${fns.length}`);
      else {
        const v = fns[0][1].Properties?.Environment?.Variables?.EXEC_ENV_COMPONENT_ENUM;
        const want = allComponentsFromSource().join(",");
        if (v !== want) fail(`broker Lambda 的 EXEC_ENV_COMPONENT_ENUM=${JSON.stringify(v)} ≠ context.ts 枚举 ${JSON.stringify(want)}(broker 组件全集与栈组不同源)`);
      }
    }
    for (const st of startStmts) {
      const res = JSON.stringify(st.Resource ?? "");
      if (res.includes('"*"') || res === '"*"') fail(`broker 的 StartBuild 资源是 "*" —— 必须限定到 exec-env 那一个项目`);
      if (!res.includes("ExecEnvDeployProject") && !res.includes("bgp-exec-env-deploy")) {
        fail(`broker 的 StartBuild 资源看不出指向 exec-env 项目:${res.slice(0, 200)}`);
      }
    }

    // 9.2b 🔴 broker 必须持有数据键 kms:Decrypt(切片 g 真部署撞出的坑,钉死防回退):
    //    bgp-* DDB 表全是数据域 CMK(alias/bgp-data)CUSTOMER_MANAGED 加密,而 DDB 对客户管理键
    //    的解密拿**调用方凭证**做(FAS)—— 缺这条时 synth/单测全绿,broker 的 readTarget 直接
    //    KMS AccessDenied,上面 9.2 核过的 DDB 授权形同虚设。真 KMS 行为无法 synth 验,但 grant
    //    的**在场**可以。
    const brokerKmsStmts = [];
    for (const [, r] of resources) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      for (const st of r.Properties?.PolicyDocument?.Statement || []) {
        const acts = [].concat(st.Action || []);
        if (acts.includes("kms:Decrypt")) brokerKmsStmts.push(st);
      }
    }
    if (brokerKmsStmts.length === 0) {
      fail("部署栈里 broker 没有 kms:Decrypt —— bgp-execution-envs/bgp-audit 是 CMK 加密表(DDB 以调用方凭证解密),缺它 readTarget 必 AccessDenied(切片 g 实测)");
    }

    // 9.2c 🔴 §12.0 修法①:broker 角色必须带 5 条「危险 override 即 Deny」语句(Null:false 语义)。
    //    键名 2026-09-01 按 AWS 权威数据核实;逐键独立语句(同一块多键是 AND = 形同虚设)。
    //    environment.environmentVariables 刻意不在清单里(broker 的合法参数通道,拦了直接断腿)。
    const EXPECTED_DENY_KEYS = [
      "codebuild:source.buildspec",
      "codebuild:source.location",
      "codebuild:serviceRole",
      "codebuild:environment.image",
      "codebuild:environment.privilegedMode",
    ];
    const denyKeys = new Set();
    for (const [, r] of resources) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      for (const st of r.Properties?.PolicyDocument?.Statement || []) {
        if (st.Effect !== "Deny") continue;
        const acts = [].concat(st.Action || []);
        if (!acts.includes("codebuild:StartBuild")) continue;
        for (const k of Object.keys(st.Condition?.Null || {})) denyKeys.add(k);
        if (Object.keys(st.Condition?.Null || {}).length > 1) {
          fail(`修法① 的 Deny 语句一条里塞了多个 Null 键(AND 语义 = 全带才拒,形同虚设):${JSON.stringify(st.Condition)}`);
        }
      }
    }
    for (const k of EXPECTED_DENY_KEYS) {
      if (!denyKeys.has(k)) fail(`§12.0 修法① 缺 Deny 键 ${k} —— 危险 override 的 IAM 纵深不完整`);
    }
    if (denyKeys.has("codebuild:environment.environmentVariables")) {
      fail("修法① 把 environment.environmentVariables 也 Deny 了 —— 那是 broker 注入 EXEC_ENV_* 的合法通道,拦了 StartBuild 必挂");
    }

    // 9.3 buildspec 必须是源包里的文件路径,不是 inline 字符串
    const proj = resources.find(([, r]) => r.Type === "AWS::CodeBuild::Project")?.[1];
    if (!proj) fail("部署栈里没有 AWS::CodeBuild::Project");
    else {
      const spec = proj.Properties?.Source?.BuildSpec;
      if (spec !== "infra/buildspec/exec-env-deploy.yml") {
        fail(`CodeBuild 的 BuildSpec 应是源包里的文件路径 infra/buildspec/exec-env-deploy.yml,实际 ${JSON.stringify(spec)?.slice(0, 200)}`);
      }
      if (proj.Properties?.Source?.Type !== "S3") fail(`CodeBuild source 类型应为 S3(源包 asset),实际 ${proj.Properties?.Source?.Type}`);
      if (proj.Properties?.Environment?.PrivilegedMode === true) fail("CodeBuild 开了 privileged 模式 —— 栈组不建镜像,不该要 docker-in-docker");
    }
  }

  // 9.4 🔴 平台 ECS 角色不许有 StartBuild / UpdateProject
  const plat = cpTpl("BgpPlatformStack");
  const forbidden = ["codebuild:StartBuild", "codebuild:UpdateProject", "codebuild:UpdateProjectVisibility"];
  let sawInvoke = false;
  let sawBatchGet = false;
  for (const [lid, r] of Object.entries(plat.Resources || {})) {
    // 🔴 §9f 修:三条 exec-env 语句已移进 **ManagedPolicy**(防 CDK 10KB 溢出拆分),
    //    本节原来只扫 Policy/Role 内联 ⇒ sawInvoke/sawBatchGet 变假阴性(门禁自己先红了才发现)。
    if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::Role" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
    const docs = r.Type === "AWS::IAM::Role"
      ? (r.Properties?.Policies || []).map((p) => p.PolicyDocument)
      : [r.Properties?.PolicyDocument];
    for (const doc of docs) {
      for (const st of doc?.Statement || []) {
        const acts = [].concat(st.Action || []);
        for (const f of forbidden) {
          if (acts.includes(f)) fail(`🔴 平台栈 ${lid} 给了 ${f} —— §12.0 明令平台只能经 broker,且不得改项目定义`);
        }
        if (acts.includes("lambda:InvokeFunction") && JSON.stringify(st.Resource).includes("bgp-exec-env-broker")) sawInvoke = true;
        if (acts.includes("codebuild:BatchGetBuilds")) sawBatchGet = true;
      }
    }
  }
  if (!sawInvoke) fail("平台栈没有对 broker 的 lambda:InvokeFunction —— 那平台根本触发不了部署(§12.0)");
  if (!sawBatchGet) fail("平台栈没有 codebuild:BatchGetBuilds —— 进度回读拿不到 build 整体状态(§12.4)");

  // ── 9.4b TaskRole 的 iam:PassRole 必含四类 per-target 模式、**不含** flink(仍登记)────
  {
    const passRes = [];
    for (const [, r] of Object.entries(plat.Resources || {})) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::Role" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      const docs = r.Type === "AWS::IAM::Role" ? (r.Properties?.Policies || []).map((p) => p.PolicyDocument) : [r.Properties?.PolicyDocument];
      for (const doc of docs) {
        for (const st of doc?.Statement || []) {
          if ([].concat(st.Action || []).includes("iam:PassRole") && st.Effect !== "Deny") passRes.push(JSON.stringify(st.Resource ?? ""));
        }
      }
    }
    const passText = passRes.join("\n");
    // 🔴 flink 从「必须不在」反转成「必须在」:
    //此前已把 MSAF 落点参数化并在真环境跑,缺这条 PassRole 时启动恒 500(实测)。
    for (const kind of ["glue", "emr", "redshift-copy", "dms-kinesis", "flink"]) {
      if (!passText.includes(`role/BgpExecEnv-*-${kind}-role`)) {
        fail(`平台 TaskRole 的 iam:PassRole 缺 per-target 模式 role/BgpExecEnv-*-${kind}-role —— 非 home 的 Glue CreateJob / EMR StartJobRun 会 PassRole 拒`);
      }
    }
    // 四个 home 固定名照旧在(功能守恒)
    for (const homeRole of ["bgp-glue-role", "bgp-emr-serverless-role", "bgp-redshift-copy-role", "bgp-dms-kinesis-role"]) {
      if (!passText.includes(`role/${homeRole}`)) fail(`平台 TaskRole 的 iam:PassRole 丢了 home 固定名 ${homeRole}`);
    }
  }

  // ── 9.4d TaskRole 必有「role/* 的 iam:PassRole 且带 iam:PassedToService 条件」,服务集合恰为
  //    glue / emr-serverless / kinesisanalytics(任务执行角色可选 —— 客户自建角色也能传给这三个服务);
  //    🔴 任何 role/* 的 PassRole 语句都**不许没有**服务条件(那等于把账号里任意角色的提权面交给平台)────
  {
    const WANT = ["emr-serverless.amazonaws.com", "glue.amazonaws.com", "kinesisanalytics.amazonaws.com"];
    const wild = [];
    for (const [, r] of Object.entries(plat.Resources || {})) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::Role" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      const docs = r.Type === "AWS::IAM::Role" ? (r.Properties?.Policies || []).map((p) => p.PolicyDocument) : [r.Properties?.PolicyDocument];
      for (const doc of docs) {
        for (const st of doc?.Statement || []) {
          if (![].concat(st.Action || []).includes("iam:PassRole") || st.Effect === "Deny") continue;
          const resText = JSON.stringify(st.Resource ?? "");
          if (!resText.includes(':role/*"')) continue;
          const svc = st.Condition?.StringEquals?.["iam:PassedToService"];
          wild.push({ svc: svc === undefined ? null : [].concat(svc).slice().sort() });
        }
      }
    }
    if (!wild.length) fail("平台 TaskRole 没有 role/* 的 iam:PassRole(带 iam:PassedToService 条件)—— 客户自建执行角色绑不上(客户自建角色绑定回归)");
    for (const w of wild) {
      if (!w.svc) fail("平台 TaskRole 有一条 role/* 的 iam:PassRole **没有** iam:PassedToService 条件 —— 任意角色提权面,拒");
      else if (JSON.stringify(w.svc) !== JSON.stringify(WANT)) fail(`role/* 的 iam:PassRole 服务集合 ${JSON.stringify(w.svc)} ≠ 约定 ${JSON.stringify(WANT)}(dms 不许进;少一个 = 该引擎自建角色绑不上)`);
    }
  }

  // ── 9.4c TaskRole 的审计防篡改 Deny(三动作 × 三表)+ 区域审计 / 结果表的写(execution 轴)────
  {
    const denyRes = []; // 三动作齐的 Deny 语句资源面**合并**看(中央两表走 home 轴、区域表走 * region,是两条语句)
    let regionalWriteOk = false;
    for (const [, r] of Object.entries(plat.Resources || {})) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::Role" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      const docs = r.Type === "AWS::IAM::Role" ? (r.Properties?.Policies || []).map((p) => p.PolicyDocument) : [r.Properties?.PolicyDocument];
      for (const doc of docs) {
        for (const st of doc?.Statement || []) {
          const acts = [].concat(st.Action || []);
          const res = JSON.stringify(st.Resource ?? "");
          if (st.Effect === "Deny" && ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"].every((a) => acts.includes(a))) denyRes.push(res);
          if (st.Effect !== "Deny" && acts.includes("dynamodb:PutItem") && res.includes("table/bgp-region-audit-*") && res.includes("table/bgp-region-results-*")
              && st.Condition?.StringEquals?.["aws:RequestedRegion"]) regionalWriteOk = true;
        }
      }
    }
    const denyText = denyRes.join("\n");
    const denyOk = ["table/bgp-audit", "table/bgp-region-audit-*", "table/bgp-residency-acks"].every((t) => denyText.includes(t));
    if (!denyOk) fail("平台 TaskRole 缺审计防篡改 Deny(UpdateItem / DeleteItem / BatchWriteItem × bgp-audit / bgp-region-audit-* / bgp-residency-acks)—— 审计完整性");
    if (!regionalWriteOk) fail("平台 TaskRole 缺区域审计 / 结果表的 PutItem(execution 轴,带 aws:RequestedRegion)—— 跨法域 residencyAudit 写不成即拒会把所有跨法域操作拒掉");
    // 2026-09-05 真环境抓到:结果桶探活要 GetBucketReplication **API**,对应 IAM 动作是 `s3:GetReplicationConfiguration`(不同名)。
    //   写成 API 名 ⇒ synth 绿、真探活 AccessDenied ⇒ 补充部署会话收不了口。正名必须在,假名必须不在(§13 再扫全部模板)。
    let bucketRwOk = false;
    for (const [, r] of Object.entries(plat.Resources || {})) {
      if (r.Type !== "AWS::IAM::ManagedPolicy" && r.Type !== "AWS::IAM::Policy") continue;
      for (const st of r.Properties?.PolicyDocument?.Statement || []) {
        const acts = [].concat(st.Action || []);
        if (st.Effect === "Allow" && JSON.stringify(st.Resource ?? "").includes("bgp-region-results-") && acts.includes("s3:GetReplicationConfiguration") && acts.includes("s3:ListBucket")) bucketRwOk = true;
      }
    }
    if (!bucketRwOk) fail("平台 TaskRole 对 bgp-region-results-* 桶缺 s3:GetReplicationConfiguration(+ ListBucket)—— residency-api:bucket 探活会被拒,补充部署永远收不了口");
  }

  // ── 9.7 home EMR 角色的 S3 面**收回**到 home 两桶全名(ACCEPTANCE;W3-g 放宽撤销)──
  if (!existsSync(resolve(CP_OUT, "BgpEmrStack.template.json"))) {
    fail("控制面 synth 没产出 BgpEmrStack(-c enable-emr=1)—— 9.7 无法判定 home EMR 角色的 S3 面");
  } else {
    const emrTpl = cpTpl("BgpEmrStack");
    const homeEmrLid = roleLidByName(emrTpl, "bgp-emr-serverless-role");
    if (!homeEmrLid) fail("BgpEmrStack 里没有 RoleName=bgp-emr-serverless-role");
    else {
      const s3Res = [];
      for (const st of roleStatements(emrTpl, homeEmrLid)) {
        for (const r of [].concat(st.Resource ?? [])) {
          const t = JSON.stringify(r);
          if (t.includes(":s3:::")) s3Res.push(t);
        }
      }
      if (s3Res.length < 4) fail(`home EMR 角色只抽到 ${s3Res.length} 条 S3 资源(期望 ≥4:两桶 × {桶, 桶/*})`);
      for (const t of s3Res) {
        if (/-\*(\/\*)?"/.test(t)) fail(`home EMR 角色的 S3 面仍带 -* 通配(W3-g 放宽未撤销):${t}`);
        if (!t.includes(`bgp-glue-scripts-${ACCOUNT}`) && !t.includes(`bgp-datalake-${ACCOUNT}`)) fail(`home EMR 角色的 S3 资源不是 home 两桶之一:${t}`);
      }
    }
  }

  // ── 9.8 数据湖表桶路由(设计稿 §6.7):三份角色的 s3tables 资源面必须是「本区**任意**表桶」形态 ──────────────────────
  //    主控区 EMR 角色(BgpEmrStack / bgp-emr-serverless-role)、主控区 Flink 角色(BgpFlinkStack / bgp-flink-role)、
  //    执行区 Flink 角色(BgpExecEnv-<slug>-flink,§7b 全组件 synth 的产物)—— 每条含 s3tables: 动作的 Allow 语句,
  //    其 **每个** Resource 经 token 解析后都必须匹配 ^arn:aws:s3tables:[^:]+:[^:]+:bucket/\*$,且不出现任何桶名字面;
  //    语句**必须存在**(缺 = 红,不是绿)。变异:把任一栈改回单桶形态(bucket/bgp-table-bucket)⇒ 这里红。
  {
    const S3T_ANY = /^arn:aws:s3tables:[^:]+:[^:]+:bucket\/\*$/;
    const assertAnyBucket = (label, tpl, roleLid) => {
      if (!roleLid) { fail(`§9.8 ${label}:找不到角色`); return; }
      const stmts = s3tablesStatements(tpl, roleLid);
      if (!stmts.length) { fail(`§9.8 ${label}:角色里没有任何 s3tables 语句(缺 = 红,不是绿;数据湖表桶路由要求放到本区任意表桶)`); return; }
      for (const st of stmts) {
        const res = [].concat(st.Resource ?? []);
        if (!res.length) { fail(`§9.8 ${label}:s3tables 语句没有 Resource`); continue; }
        for (const r of res) {
          const text = arnText(r);
          if (!S3T_ANY.test(text)) fail(`§9.8 ${label}:s3tables 资源 ${text} 不是「本区任意表桶」形态 arn:aws:s3tables:<region>:<account>:bucket/*(单桶形态 = 2026-11-03 客户缺陷复发)`);
          if (/bgp-table-bucket|bucket\/[a-z0-9][a-z0-9-]*[a-z0-9](\/|"|$)/.test(text)) fail(`§9.8 ${label}:s3tables 资源 ${text} 里出现了桶名字面`);
        }
      }
    };
    if (!existsSync(resolve(CP_OUT, "BgpEmrStack.template.json"))) fail("§9.8 控制面 synth 没产出 BgpEmrStack —— 无法判定主控区 EMR 角色的 s3tables 面");
    else { const tpl = cpTpl("BgpEmrStack"); assertAnyBucket("BgpEmrStack / bgp-emr-serverless-role", tpl, roleLidByName(tpl, "bgp-emr-serverless-role")); }
    if (!existsSync(resolve(CP_OUT, "BgpFlinkStack.template.json"))) fail("§9.8 控制面 synth 没产出 BgpFlinkStack(-c enable-flink=1)—— 无法判定主控区 Flink 角色的 s3tables 面");
    else { const tpl = cpTpl("BgpFlinkStack"); assertAnyBucket("BgpFlinkStack / bgp-flink-role", tpl, roleLidByName(tpl, "bgp-flink-role")); }
    const eeFlink = resolve(OUT, `BgpExecEnv-${SLUG}-flink.template.json`);
    if (!existsSync(eeFlink)) fail(`§9.8 执行区 synth 产物里没有 BgpExecEnv-${SLUG}-flink.template.json(§7b 全组件 synth 该产出它)—— 无法判定执行区 Flink 角色的 s3tables 面`);
    else {
      const tpl = JSON.parse(readFileSync(eeFlink, "utf8"));
      const lid = Object.entries(tpl.Resources || {}).find(([, r]) => r.Type === "AWS::IAM::Role")?.[0] ?? null;
      assertAnyBucket(`BgpExecEnv-${SLUG}-flink / ${expectName("flinkRole")}`, tpl, lid);
    }
  }

  // 9.5 源包 asset:体积上限 + 关键文件在位 + 禁忌目录不在
  const assetDirs = readdirSync(CP_OUT).filter((d) => d.startsWith("asset.") && statSync(resolve(CP_OUT, d)).isDirectory());
  const bundle = assetDirs
    .map((d) => resolve(CP_OUT, d))
    .find((d) => existsSync(resolve(d, "infra/bin/app.ts")));
  if (!bundle) {
    fail("找不到源包 asset(里面应有 infra/bin/app.ts)—— 源获取机制(§12.5 P0-H)没生效");
  } else {
    for (const f of ["infra/bin/app.ts", "infra/buildspec/exec-env-deploy.yml", "platform/naming.json", "platform/ai-model.json", "infra/package-lock.json"]) {
      if (!existsSync(resolve(bundle, f))) fail(`源包缺 ${f} —— exec-env build 起步就会炸`);
    }
    for (const d of [".git", "node_modules", "infra/node_modules", "docs", "qa-game", "audit-results", "cdk.out", "infra/cdk.out"]) {
      if (existsSync(resolve(bundle, d))) fail(`源包含禁忌目录 ${d} —— 排除清单要写**裸目录名**才剪枝(实测漏写时 asset 达 509MB)`);
    }
    // 任何 cdk.out* 变体都不许在源包里(否则 asset 自己套自己)
    const stray = readdirSync(bundle).filter((d) => d.startsWith("cdk.out"));
    const strayInfra = existsSync(resolve(bundle, "infra")) ? readdirSync(resolve(bundle, "infra")).filter((d) => d.startsWith("cdk.out")) : [];
    if (stray.length || strayInfra.length) {
      fail(`源包里有 cdk 输出目录 ${[...stray, ...strayInfra.map((d) => "infra/" + d)].join(", ")} —— 排除清单须用 \`cdk.out*\` 通配`);
    }
    const mb = Number(execFileSync("du", ["-sm", bundle], { encoding: "utf8" }).split(/\s+/)[0]);
    if (!(mb > 0) || mb > 25) fail(`源包 ${mb}MB 超上限 25MB —— 每次控制面 synth 都要 stage 一次,不许无声膨胀`);
  }

  // 9.6 buildspec 内容承重
  // 🔴 **先剥注释再扫**(第三次同一教训:cross-module cast 门禁、反向覆盖门禁都栽过)。
  //    实测:不剥的话,buildspec 注释里"永不 `npm install`""不做半成品 update-item""`cdk deploy` 要假定…"
  //    会分别触发三条假阳性 —— 其中一条还会把"bootstrap 在 deploy 之前"判成顺序反了。
  const bs = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // 🔴 shell 必须显式 bash(切片 g 真跑撞出:CodeBuild 缺省 sh/dash,`set -o pipefail`/`${!v}` 间接展开
  //    在 PRE_BUILD 首行即炸;synth 与都测不出 —— 这是"命令由哪个 shell 执行"的运行期属性)。
  //    `shell: bash` 是 env 配置行不是注释,剥注释后的 bs 里仍在,可以直接在 bs 上断言。
  if (!/^\s*shell:\s*bash\s*$/m.test(bs)) {
    fail("buildspec 缺 `env.shell: bash` —— CodeBuild 缺省 dash,bash 语法(pipefail/${!v})会在 PRE_BUILD 首行炸(切片 g 实测)");
  }
  if (!/describe-availability-zones/.test(bs)) fail("buildspec 缺 AZ preflight —— 切片 a 把 AZ 名写死了,配套校验必须在部署前跑(§4.1a-6)");
  if (!/npm ci/.test(bs)) fail("buildspec 缺 npm ci(§12.5 P0-G)");
  if (/npm install/.test(bs)) fail("buildspec 出现 npm install —— 必须只用 npm ci(caret 依赖会拉到新 CDK,对存量栈 synth 出意外 changeset)");
  if (!/cdk bootstrap/.test(bs) || !/cdk deploy/.test(bs)) fail("buildspec 缺 bootstrap 或 deploy(§12.3 顺序钉死)");
  if (bs.indexOf("cdk bootstrap") > bs.indexOf("cdk deploy")) fail("buildspec 里 bootstrap 必须在 deploy 之前(§12.3)");
  if (!/BgpExecEnv-\$SLUG-\*|BgpExecEnv-\$\{SLUG\}-\*|"BgpExecEnv-\$SLUG-\*"/.test(bs)) {
    fail("buildspec 的 cdk deploy 没用 BgpExecEnv-<slug>-* 通配 —— 必须精准锁定,绝不能 --all(会碰控制面)");
  }
  if (/--all/.test(bs)) fail("buildspec 里出现 cdk --all —— 那会连控制面 23 栈一起部署");
  if (/dynamodb update-item|update-item/.test(bs)) {
    fail("buildspec 里出现 update-item —— 描述符回写归切片 e;半份描述符写进注册表比不写更糟(§20.11-N2)");
  }

  // ── 9.6b 🔴 P0-E 闸(SPEC §3.5c;-3)────────────────────────────────────
  // 【为什么钉在这里】P0-E 是"唯一能毁数据的洞":补组件在源漂移下可能 REPLACE Redshift namespace /
  //   MWAA env / S3 桶。真正能毁数据的那一步在 **本 buildspec** 里执行(部署强权焊在 CodeBuild 服务角色上),
  //   而平台侧那道闸可能被绕(拿到平台角色即可直接 invoke broker)⇒ **build 侧这一关是最后一道**,
  //   它被顺手删掉/绕过时必须在门禁上立刻红。
  if (!/node scripts\/p0e-gate\.mjs/.test(bs)) {
    fail("buildspec 缺 P0-E 闸(node scripts/p0e-gate.mjs)—— 少了它,补组件可能无人值守地 REPLACE 有状态资源(§3.5c)");
  }
  if (bs.indexOf("p0e-gate.mjs") > bs.indexOf("cdk deploy")) {
    fail("buildspec 里 P0-E 闸必须在真 cdk deploy **之前**(顺序反了 = 先毁数据再审批)");
  }
  if (!/EXEC_ENV_MODE/.test(bs)) {
    fail("buildspec 缺 EXEC_ENV_MODE 判断 —— preview 模式必须只出裁决、不执行部署(§3.5c 两阶段)");
  }
  const gatePath = resolve(INFRA, "scripts/p0e-gate.mjs");
  if (!existsSync(gatePath)) fail("找不到 infra/scripts/p0e-gate.mjs —— buildspec 引了它,缺文件 = build 必炸");
  const gate = readFileSync(gatePath, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  if (!/--no-execute/.test(gate)) fail("p0e-gate 没用 --no-execute —— 预演必须【只创建不执行】,否则它自己就把变更做了");
  if (!/delete-change-set/.test(gate)) {
    fail("p0e-gate 不删预演 change set —— 留着会让 2b 恢复闸永久判「存在未执行 change set ⇒ 不稳定」");
  }
  if (!/REVIEW_IN_PROGRESS/.test(gate) || !/delete-stack/.test(gate)) {
    fail("p0e-gate 不清理 --no-execute 给新栈留下的 REVIEW_IN_PROGRESS 空壳栈 —— 同样会把恢复闸永久卡死");
  }
  if (!/EXEC_ENV_APPROVED_PLAN_HASH/.test(gate) || !/requiresApproval/.test(gate)) {
    fail("p0e-gate 没有审批闸(需 requiresApproval + EXEC_ENV_APPROVED_PLAN_HASH 比对)—— 等于没有 P0-E");
  }
  if (!/from "\.\/deploy-impact\.mjs"/.test(gate)) {
    fail("p0e-gate 没有 import ./deploy-impact.mjs —— 判据必须单一来源(两侧同源由 platform 的 840 格 parity 门禁钉住)");
  }
  // 🔴 负向:闸里不许**再抄一份**有状态资源集/判据(抄一份 = 三处实现,parity 门禁管不到第三份)
  if (/AWS::RedshiftServerless::Namespace/.test(gate)) {
    fail("p0e-gate 里出现有状态资源类型字面量 —— 判据必须只在 deploy-impact.mjs 一处,不许在闸里抄第二份");
  }
  const impactPath = resolve(INFRA, "scripts/deploy-impact.mjs");
  if (!existsSync(impactPath)) fail("找不到 infra/scripts/deploy-impact.mjs(P0-E 判据的 build 侧那一份)");

  // ── 9.6c 🔴 P0-E ④ 基线/波次的**输入管线**(SPEC §3.5c v3.6 订正后的机制)────────────
  // 【订正背景】原合同写"用 baselineRef **重放**旧源(buildspec checkout)"——**做不到也不许做**:
  //   source 是按内容哈希不可变的 CDK asset(源包排除清单第一条就是 `.git`,build 里没有仓库),
  //   而唯一能换源的 `sourceLocationOverride` 已被 §12.0 修法① 的 IAM Deny 禁死(换源包 = 借
  //   CodeBuild 的 `cloudformation:*`+`iam:PassRole` 跑任意代码)。⇒ 改成"漂移可见 + 显式波次"。
  // 【这里钉什么】判定属共享判据(与平台侧同批落地),但**输入的可信来源**是 CDK/broker 的事,
  //   必须现在就钉死,否则第四步接判定时会建在一个可被调用方左右的输入上:
  //   ① `EXEC_ENV_SOURCE_REF` 来自**项目定义**(平台角色没有 UpdateProject ⇒ 同级保护),
  //      且它的值必须**就是项目实际取源的那个对象键**(否则"我用的是哪份源"是假的);
  //   ② 另两个只能由 broker 从**注册表描述符**读;
  //   ③ 🔴 负向:客户端入参白名单里**永远不许**出现它们 —— 调用方若能自称"baseline == 当前源",
  //      漂移闸就被一句谎话关掉了(这是本机制唯一的软肋,必须由门禁而不是自觉守住)。
  {
    // 🔴 `resources`(9.1)在 9.1 的 else 块里,这里不在作用域 —— 重新取模板,别靠"看起来能用"。
    const depTpl = cpTpl("BgpExecEnvDeployStack");
    const projects = Object.entries(depTpl.Resources || {}).filter(([, r]) => r.Type === "AWS::CodeBuild::Project");
    if (projects.length !== 1) fail(`部署栈里 CodeBuild 项目应恰好 1 个,实际 ${projects.length} 个`);
    const [, proj] = projects[0];
    const envVars = proj.Properties?.Environment?.EnvironmentVariables || [];
    const srcRefVar = envVars.find((v) => v?.Name === "EXEC_ENV_SOURCE_REF");
    if (!srcRefVar) {
      fail("CodeBuild 项目定义缺 EXEC_ENV_SOURCE_REF 环境变量 —— 基线判定就没有可信的「本次源身份」输入(§3.5c ④)");
    } else {
      const val = String(srcRefVar.Value ?? "");
      if (!val) fail("EXEC_ENV_SOURCE_REF 的值为空 —— 源身份必须是 asset 对象键");
      const loc = JSON.stringify(proj.Properties?.Source?.Location ?? "");
      if (!loc.includes(val)) {
        fail(
          `EXEC_ENV_SOURCE_REF=${val.slice(0, 24)}… 不在项目 Source.Location(${loc.slice(0, 120)})里 —— ` +
            "声称的源身份与真正取源的对象不是同一个,基线判定会建在假事实上"
        );
      }
    }
    // ② broker 侧:值只能来自描述符(剥注释后 grep,同既有风格)
    const brokerSrc = readFileSync(resolve(INFRA, "lambda/exec-env-broker/index.mjs"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    if (!/EXEC_ENV_BASELINE_REF/.test(brokerSrc) || !/observed\?\.baselineRef/.test(brokerSrc)) {
      fail("broker 没把 observed.baselineRef 透传成 EXEC_ENV_BASELINE_REF —— 闸拿不到基线,漂移判定无输入");
    }
    if (!/EXEC_ENV_DESIRED_TEMPLATE_VERSION/.test(brokerSrc) || !/spec\?\.desiredTemplateVersion/.test(brokerSrc)) {
      fail("broker 没把 spec.desiredTemplateVersion 透传成 EXEC_ENV_DESIRED_TEMPLATE_VERSION —— 波次授权无从生效");
    }
    // ③ 🔴 负向:这三个名字绝不许出现在客户端入参白名单里
    const validateSrc = readFileSync(resolve(INFRA, "lambda/exec-env-broker/validate.mjs"), "utf8");
    const allowedLine = validateSrc.split("\n").find((l) => /const allowed = \[/.test(l)) || "";
    for (const forbidden of ["baselineRef", "desiredTemplateVersion", "sourceRef"]) {
      if (allowedLine.includes(forbidden)) {
        fail(
          `客户端入参白名单里出现 ${forbidden} —— 基线/波次只能来自注册表与项目定义;` +
            "调用方能自称基线 = 一句谎话就关掉整个漂移闸(§3.5c ④)"
        );
      }
    }
    // ④ buildspec:三个变量要有占位声明,但**不许**进 fail-fast 必填清单(全新 env 首装时基线天然为空)
    for (const v of ["EXEC_ENV_SOURCE_REF", "EXEC_ENV_BASELINE_REF", "EXEC_ENV_DESIRED_TEMPLATE_VERSION"]) {
      if (!bs.includes(v)) fail(`buildspec 缺 ${v} 的占位声明(§3.5c ④ 的三件套)`);
    }
    const requiredLoop = bs.split("\n").find((l) => /for v in EXEC_ENV_TARGET/.test(l)) || "";
    for (const v of ["EXEC_ENV_BASELINE_REF", "EXEC_ENV_SOURCE_REF", "EXEC_ENV_DESIRED_TEMPLATE_VERSION"]) {
      if (requiredLoop.includes(v)) {
        fail(`${v} 被放进 buildspec 的 fail-fast 必填清单 —— 全新 env 首装时它天然为空,会把首装挡死(§3.5c ④ 判定 1)`);
      }
    }
  }

  // ── §9f(切片 f):aws:RequestedRegion 列表机制 + DescribeStacks 收窄 + 无策略溢出 ──
  //
  // 三条承重:
  //   a) **缺省零行为变化**:不传 execution-regions 时,全部 RequestedRegion 条件是**裸 string**
  //      (数组化 [x] 与 "x" IAM 语义等价但模板不同 ⇒ 存量重部署会出无谓 diff);
  //   b) **ExecEnvControl 独立 ManagedPolicy**:三条 sid 在、DescribeStacks 已收窄到 stack/BgpExecEnv-*、
  //      且平台栈**没有** CDK 自动拆分出的 OverflowPolicy —— 实测:收窄 ARN 比 `*` 长几十字节,恰好把
  //      TaskRole 内联 DefaultPolicy 推过 CDK 的 10KB 拆分线,**别的既有语句**被重排进 OverflowPolicy
  //      (行为等价但语句落点漂移、审计噪声大)。独立 MP 是仓内既有惯例(DataSourceReadOnly 先例)。
  //   c) **带 -c execution-regions 时全部条件数组化**且含每个 region(漏一处 = 平台对新 region 的
  //      运行时调用被既有单 region 条件静默拒掉,报错发生在很远的下游)。
  const platDefault = cpTpl("BgpPlatformStack");
  {
    let bare = 0, arrays = 0;
    for (const v of Object.values(platDefault.Resources || {})) {
      const docs = v?.Properties?.PolicyDocument ? [v.Properties.PolicyDocument] : (v?.Properties?.Policies || []).map((x) => x.PolicyDocument);
      for (const doc of docs) for (const st of doc?.Statement || []) {
        const c = st?.Condition?.StringEquals?.["aws:RequestedRegion"];
        if (c === undefined) continue;
        if (Array.isArray(c)) arrays++; else bare++;
      }
    }
    if (arrays > 0) fail(`缺省(无 execution-regions)有 ${arrays} 处 RequestedRegion 被数组化 —— 破坏「缺省模板零 diff」`);
    if (bare < 10) fail(`缺省 RequestedRegion 裸条件只有 ${bare} 处(平台栈应 ≥15)—— helper 可能没接上`);

    // ── §9g:**per-target 资源的既有 IAM 覆盖面**——同族坑连撞三次(#7/#8/#10)后钉整类 ──
    // 【坑的形状】既有 IAM 的资源 ARN 有两个**隐含前提**,而多 region 把两个都打破了:
    //   ① region 段写死成 home ⇒ 新 region 的同类资源一律 AccessDenied(bug #7 表桶、#8 Redshift secret);
    //   ② 资源名按 `bgp-*` 命名约定写死 ⇒ per-target 资源叫 `BgpExecEnv-<slug>-*`,不在白名单里(bug #10 flink 角色)。
    // 【为什么必须机械钉】这三个都是"链路每一环都对、只有 IAM 静默拒",而且每次都要一整轮真部署才发现。
    // 这里断的是"**该在的窄语句在不在**",不试图判定 26 处 ARN 各自该不该放开(那要逐个看语义,
    // 数据面下推时的逐一过审;门禁只保证已知的三处不回退)。
    {
      const wantStatements = [
        ["ExecEnvRedshiftManagedSecretRead", /secretsmanager:\*:\d+:secret:redshift!\*|secretsmanager:\*:\$\{[^}]*\}:secret:redshift!\*/, "bug #8:执行环境的 Redshift 托管 secret 在目标 region,原语句 region 段写死成 home"],
        ["ExecEnvPerTargetRoleRead", /role\/BgpExecEnv-\*/, "bug #10:per-target 角色叫 BgpExecEnv-*,不在 bgp-* 白名单里"],
      ];
      const allStatements = [];
      for (const v of Object.values(platDefault.Resources || {})) {
        const docs = v?.Properties?.PolicyDocument ? [v.Properties.PolicyDocument] : (v?.Properties?.Policies || []).map((x) => x.PolicyDocument);
        for (const doc of docs) for (const st of doc?.Statement || []) allStatements.push(st);
      }
      if (allStatements.length < 20) fail(`§9g 只收集到 ${allStatements.length} 条 IAM 语句(平台栈应远多于此)—— 收集逻辑坏了会让本节假绿`);
      for (const [sid, resRe, why] of wantStatements) {
        const st = allStatements.find((x) => x.Sid === sid);
        if (!st) { fail(`§9g 平台栈缺 sid=${sid} 的语句 —— ${why}`); continue; }
        const res = JSON.stringify(st.Resource ?? "");
        if (!resRe.test(res)) fail(`§9g ${sid} 的资源模式不对(${res.slice(0, 160)})—— ${why}`);
      }
      // 🔴 IAM 是全局服务:给它的语句加 aws:RequestedRegion 条件会**反而拦掉**调用(全局服务的
      //    RequestedRegion 不是调用方以为的那个值)。这条断言防"顺手照抄别处的条件写法"。
      const roleRead = allStatements.find((x) => x.Sid === "ExecEnvPerTargetRoleRead");
      if (roleRead?.Condition?.StringEquals?.["aws:RequestedRegion"]) {
        fail("§9g ExecEnvPerTargetRoleRead 加了 aws:RequestedRegion 条件 —— IAM 是全局服务,加了会拦掉调用");
      }
    }

    const over = Object.keys(platDefault.Resources || {}).filter((k) => /OverflowPolicy/i.test(k));
    if (over.length > 0) fail(`平台栈出现 CDK 策略溢出拆分 ${over.join(", ")} —— 内联 DefaultPolicy 超 10KB,新权限应独立 ManagedPolicy(仓内惯例)`);

    const mp = Object.entries(platDefault.Resources || {}).find(([k, v]) => k.startsWith("ExecEnvControl") && v.Type === "AWS::IAM::ManagedPolicy");
    if (!mp) fail("平台栈缺 ExecEnvControl ManagedPolicy(切片 b/f 的三条 exec-env 语句应收在这里)");
    else {
      const stmts = mp[1].Properties?.PolicyDocument?.Statement || [];
      const sids = stmts.map((x) => x.Sid);
      for (const want of ["ExecEnvDeployViaBrokerOnly", "ExecEnvDeployProgressReadOnly", "ExecEnvStackProgressReadOnly"]) {
        if (!sids.includes(want)) fail(`ExecEnvControl 缺语句 ${want}`);
      }
      const ds = stmts.find((x) => x.Sid === "ExecEnvStackProgressReadOnly");
      const res = JSON.stringify(ds?.Resource ?? "");
      if (res.includes('"*"')) fail("DescribeStacks 的 Resource 回退成 * —— 切片 f 的收窄被撤");
      if (!res.includes("stack/BgpExecEnv-")) fail(`DescribeStacks 的 Resource 未收窄到 stack/BgpExecEnv-*:${res.slice(0, 120)}`);
    }
  }

  // c) 带 execution-regions 的第二次平台 synth(只 synth 平台栈,~40s;--fast 已跳过整个 §9)
  const CP_OUT2 = resolve(tmpdir(), "bgp-synth-gate-cp-multi");
  if (existsSync(CP_OUT2)) rmSync(CP_OUT2, { recursive: true, force: true });
  try {
    execFileSync("npx", ["cdk", "synth", "BgpPlatformStack", "--quiet", "-o", CP_OUT2, "-c", "execution-regions=us-east-1,us-west-2"], {
      cwd: INFRA,
      env: { ...NO_CRED_ENV, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: "us-east-1" },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 900_000,
    });
    const multi = JSON.parse(readFileSync(resolve(CP_OUT2, "BgpPlatformStack.template.json"), "utf8"));
    let tot = 0, ok = 0;
    // 主控区**平台数据面角色**是 per-target 角色(只属主控区这一个 target):
    //   它的区域条件**必须**只有主控区一个区(放进别的区 = 主控区凭证能碰别区数据,正是 L5 要堵的横移)⇒ 反向判,不计入上面的「数组化」。
    const pdrLid = Object.entries(multi.Resources || {}).find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties?.RoleName === "bgp-platform-data-role")?.[0];
    if (!pdrLid) fail("平台栈里没有 RoleName=bgp-platform-data-role 的角色(主控区平台数据面角色)");
    let pdrStatements = 0;
    for (const v of Object.values(multi.Resources || {})) {
      const docs = v?.Properties?.PolicyDocument ? [v.Properties.PolicyDocument] : (v?.Properties?.Policies || []).map((x) => x.PolicyDocument);
      const ofPdr = JSON.stringify(v?.Properties?.Roles ?? []).includes(`"${pdrLid}"`);
      for (const doc of docs) for (const st of doc?.Statement || []) {
        const c = st?.Condition?.StringEquals?.["aws:RequestedRegion"];
        if (c === undefined) continue;
        if (ofPdr) {
          pdrStatements++;
          if (c !== "us-east-1") fail(`主控区平台数据面角色的区域条件=${JSON.stringify(c)},必须只有主控区 us-east-1(per-target 角色不许跨区)`);
          continue;
        }
        tot++;
        if (Array.isArray(c) && c.includes("us-east-1") && c.includes("us-west-2")) ok++;
      }
    }
    if (pdrLid && pdrStatements < 2) fail(`主控区平台数据面角色只扫到 ${pdrStatements} 条带区域条件的语句(期望 ≥2)—— 归属判定可能扫错了`);
    if (pdrLid) assertDataRoleSecretGrants(multi, pdrLid, "主控区平台数据面角色(平台栈)");
    if (tot < 10) fail(`multi-region synth 只见 ${tot} 处 RequestedRegion 条件 —— 断言可能扫错了地方`);
    if (ok !== tot) fail(`带 execution-regions 时 ${tot} 处条件只有 ${ok} 处数组化并含两 region —— 漏改的那处会把平台对新 region 的调用静默拒掉`);

    // ── §9c-env:放行清单的第二条通道 = 进程变量 BGP_EXECUTION_REGIONS(部署脚本导出,给三个智能体栈 / EMR 栈 / 连带部署的
    //   依赖栈用)。必须与 `-c execution-regions` **逐字节同模板**:两通道在 requestedRegionCondition 里是同一处解析,这里钉住它不分叉。
    //   同时钉「-c 优先」:两者都给且不同时,模板随 -c。
    const CP_OUT3 = resolve(tmpdir(), "bgp-synth-gate-cp-multi-env");
    if (existsSync(CP_OUT3)) rmSync(CP_OUT3, { recursive: true, force: true });
    try {
      execFileSync("npx", ["cdk", "synth", "BgpPlatformStack", "--quiet", "-o", CP_OUT3], {
        cwd: INFRA,
        env: { ...NO_CRED_ENV, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: "us-east-1", BGP_EXECUTION_REGIONS: "us-east-1,us-west-2" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 900_000,
      });
      const viaCtx = readFileSync(resolve(CP_OUT2, "BgpPlatformStack.template.json"), "utf8");
      const viaEnv = readFileSync(resolve(CP_OUT3, "BgpPlatformStack.template.json"), "utf8");
      if (viaCtx !== viaEnv) fail("§9c-env 经 BGP_EXECUTION_REGIONS 与经 -c execution-regions 合成的平台栈模板不同 —— 两条通道分叉了(requestedRegionCondition 必须同一处解析)");
      rmSync(CP_OUT3, { recursive: true, force: true });
      // -c 优先:env 给 us-west-2、-c 只给 home ⇒ 模板必须等于缺省模板(全裸 string)
      execFileSync("npx", ["cdk", "synth", "BgpPlatformStack", "--quiet", "-o", CP_OUT3, "-c", "execution-regions=us-east-1"], {
        cwd: INFRA,
        env: { ...NO_CRED_ENV, CDK_DEFAULT_ACCOUNT: ACCOUNT, CDK_DEFAULT_REGION: "us-east-1", BGP_EXECUTION_REGIONS: "us-east-1,us-west-2" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 900_000,
      });
      const ctxWins = JSON.parse(readFileSync(resolve(CP_OUT3, "BgpPlatformStack.template.json"), "utf8"));
      let arraysWhenCtxHome = 0;
      for (const v of Object.values(ctxWins.Resources || {})) {
        const docs = v?.Properties?.PolicyDocument ? [v.Properties.PolicyDocument] : (v?.Properties?.Policies || []).map((x) => x.PolicyDocument);
        for (const doc of docs) for (const st of doc?.Statement || []) {
          const c = st?.Condition?.StringEquals?.["aws:RequestedRegion"];
          if (Array.isArray(c)) arraysWhenCtxHome++;
        }
      }
      if (arraysWhenCtxHome > 0) fail(`§9c-env -c execution-regions=home 时仍有 ${arraysWhenCtxHome} 处数组化 ⇒ env 盖过了 -c(优先级反了)`);
    } finally {
      if (existsSync(CP_OUT3)) rmSync(CP_OUT3, { recursive: true, force: true });
    }
  } catch (e) {
    fail(`multi-region 平台 synth 失败:${String(e?.stdout || e?.stderr || e?.message).slice(-500)}`);
  } finally {
    if (existsSync(CP_OUT2)) rmSync(CP_OUT2, { recursive: true, force: true });
  }

}
scanIamMisnames(CP_OUT, "控制面"); // §13:控制面模板在这里扫(CP_OUT 下一行就删)
if (existsSync(CP_OUT)) rmSync(CP_OUT, { recursive: true, force: true });
} // end !FAST(§9)

// ══════════════════════════════════════════════════════════════════════════════
// 10) 🔴 broker 入参 fail-closed(ACCEPTANCE,切片 b 如实登记未做、本节补上)
//
// 【为什么能无头】broker 的全部"不碰 AWS 的判定"已拆到 `lambda/exec-env-broker/validate.mjs`
// (零依赖纯函数)—— 本节用 node **原生 import** 真执行它(秒级、零凭证、--fast 也照跑)。
// 【为什么还要文本锚点】只测 validate.mjs 挡不住"拆了但没接"(index.mjs 内联一份放宽的副本、
// 或干脆不再调用)—— 锚点断 index.mjs 必须 import 且调用这三个函数、判定消息不许有第二份。
// ══════════════════════════════════════════════════════════════════════════════
{
  const cases = [];
  const t = (name, fn) => {
    try {
      cases.push({ name, ok: true, value: fn() });
    } catch (e) {
      cases.push({ name, ok: false, code: e?.code, msg: String(e?.message || e) });
    }
  };
  try {
    // validate.mjs 的组件全集来自 env(部署期由 deploy-stack.ts 从 context.ts 注入);
    //   这里用同一真源灌入 —— 不设 = 模块加载即抛(fail-closed 就该如此)
    process.env.EXEC_ENV_COMPONENT_ENUM = allComponentsFromSource().join(",");
    // ②:完整组件集同样由部署期注入(deploy-stack.ts ← context.ts)
    process.env.EXEC_ENV_REQUIRED_COMPONENTS = "core,redshift,dms,flink,airflow-serverless";
    const v = await import(pathToFileURL(resolve(INFRA, "lambda/exec-env-broker/validate.mjs")).href);
    const okInput = { targetId: "tgt_usw2_a", components: ["core"], operationId: "op_abcdef12" };
    // 正向:枚举里每个组件 broker 都认(真环境撞到 airflow-serverless 被 broker 判「未知组件」)
    for (const c of allComponentsFromSource()) {
      if (c === "core") continue;
      t(`合法组件 ${c}(枚举同源)`, () => v.validateInput({ ...okInput, components: ["core", c] }));
    }
    t("parseComponentEnum 缺 core ⇒ 拒", () => v.parseComponentEnum("redshift,dms"));
    t("parseComponentEnum 空串 ⇒ 拒", () => v.parseComponentEnum(""));

    // —— validateInput:白名单 / 正则 / 组件 ——
    t("多余字段拒(override 攻击面)", () => v.validateInput({ ...okInput, buildspecOverride: "x" }));
    t("targetId 非法 tgt-usw2-a", () => v.validateInput({ ...okInput, targetId: "tgt-usw2-a" }));
    t("targetId 非法 TGT_A", () => v.validateInput({ ...okInput, targetId: "TGT_A" }));
    t("targetId 非法 tgt_a_", () => v.validateInput({ ...okInput, targetId: "tgt_a_" }));
    t("targetId 空串", () => v.validateInput({ ...okInput, targetId: "" }));
    t("targetId 超长", () => v.validateInput({ ...okInput, targetId: "tgt_" + "a".repeat(17) }));
    t("operationId 非法", () => v.validateInput({ ...okInput, operationId: "deploy-1" }));
    t("components 非数组", () => v.validateInput({ ...okInput, components: "core" }));
    t("components 空数组", () => v.validateInput({ ...okInput, components: [] }));
    t("components 未知组件", () => v.validateInput({ ...okInput, components: ["core", "corex"] }));
    t("components 缺 core", () => v.validateInput({ ...okInput, components: ["redshift"] }));
    t("组件顺序归一", () => v.validateInput({ ...okInput, components: ["redshift", "core"] }));
    t("合法基线", () => v.validateInput(okInput));

    // 🔴 P0-E(3):两个**可选**入参 mode / approvedPlanHash
    // 命名遵既有约定:要被拒的用例名里带"拒/非法",好让下面的 mustReject 通吃;正向用例另有具名核对。
    const PLAN_H = "a".repeat(64);
    t("P0-E:mode 缺省为 deploy(向后兼容,老三参照旧行为)", () => v.validateInput(okInput).mode);
    t("P0-E:mode=preview 被接受", () => v.validateInput({ ...okInput, mode: "preview" }).mode);
    t("P0-E:合法 approvedPlanHash 被接受", () => v.validateInput({ ...okInput, approvedPlanHash: PLAN_H }).approvedPlanHash);
    t("P0-E:mode 非法词拒", () => v.validateInput({ ...okInput, mode: "teardown" }));
    // destroy 只接 targetId / operationId / mode;销毁范围与快照名只从注册表读
    const dInput = { targetId: "tgt_usw2_a", operationId: "op_abcdef12", mode: "destroy" };
    t("destroy 带 components 拒(销毁范围只从注册表读)", () => v.validateInput({ ...dInput, components: ["core"] }));
    t("destroy 带 approvedPlanHash 拒", () => v.validateInput({ ...dInput, approvedPlanHash: PLAN_H }));
    t("destroy 对 tgt_home 拒 bad-status", () => v.validateInput({ ...dInput, targetId: "tgt_home" }));
    t("destroy 带多余字段拒", () => v.validateInput({ ...dInput, finalSnapshotName: "bgp-final-x" }));
    t("destroy 三参被接受", () => v.validateInput(dInput).mode);
    t("P0-E:mode=null 非法拒(不许当缺省)", () => v.validateInput({ ...okInput, mode: null }));
    t("P0-E:approvedPlanHash 非 64hex 拒", () => v.validateInput({ ...okInput, approvedPlanHash: "deadbeef" }));
    t("P0-E:approvedPlanHash 大写 hex 非法拒(canonical 只认小写)", () => v.validateInput({ ...okInput, approvedPlanHash: "A".repeat(64) }));
    t("P0-E:preview 带 approvedPlanHash 拒(预演不执行变更,审批无对象)", () => v.validateInput({ ...okInput, mode: "preview", approvedPlanHash: PLAN_H }));

    // —— assessTarget:不可部署状态 / 缺 region·accountId ——
    const okItem = { targetId: "tgt_usw2_a", status: "registered", region: "us-west-2", accountId: "123456789012" };
    t("item 不存在 ⇒ not-registered", () => v.assessTarget(null, "tgt_usw2_a"));
    for (const s of ["draining", "decommissioning", "deleted"]) {
      t(`status=${s} 拒 ⇒ bad-status`, () => v.assessTarget({ ...okItem, status: s }, "tgt_usw2_a"));
    }
    t("缺 region ⇒ bad-descriptor", () => v.assessTarget({ ...okItem, region: "" }, "tgt_usw2_a"));
    t("缺 accountId ⇒ bad-descriptor", () => v.assessTarget({ ...okItem, accountId: undefined }, "tgt_usw2_a"));
    t("合法 item 通过", () => v.assessTarget(okItem, "tgt_usw2_a"));

    // —— translateLockError:锁冲突翻译 ——
    t("ConditionalCheckFailed ⇒ locked", () => {
      const rej = v.translateLockError({ name: "ConditionalCheckFailedException" }, { targetId: "tgt_usw2_a", deployLockOperationId: "op_other000" });
      if (!rej || rej.code !== "locked" || !/正在部署中/.test(rej.message)) throw new Error(`翻译结果不对:${JSON.stringify(rej?.message)}`);
      return "locked";
    });
    t("其它错误 ⇒ null(原样上抛)", () => {
      const rej = v.translateLockError({ name: "ProvisionedThroughputExceededException" }, { targetId: "tgt_usw2_a" });
      if (rej !== null) throw new Error("非锁冲突不该被翻译成 locked");
      return "null";
    });

    // staleLockCandidate / isTerminalBuildStatus:陈锁接管的判定——
    // 🔴 命名刻意避开 mustReject 的筛选词(拒/非法/空串/超长/不存在/"缺 ")—— 这些是"返回 null",
    //    不是"抛拒绝";混进去会让下面的负向断言判错对象。每条都有下方的**具名**正向核对(否则
    //    断言抛错只会被记成 ok:false 而静默放过 = 门禁假阴性)。
    const lockedItem = {
      targetId: "tgt_usw2_a",
      deployLockOperationId: "op_prev0001",
      lastOperationId: "op_prev0001",
      lastBuildId: "bgp-exec-env-deploy:abc-123",
      lockEpoch: 3,
    };
    t("陈锁候选:持锁者与 lastOperationId 一致 ⇒ 给出可核查的 build", () => {
      const c = v.staleLockCandidate(lockedItem);
      if (!c || c.buildId !== lockedItem.lastBuildId || c.prevOperationId !== "op_prev0001" || c.prevEpoch !== 3) {
        throw new Error(`候选不对:${JSON.stringify(c)}`);
      }
      return "candidate";
    });
    t("陈锁候选:锁没人持 ⇒ null", () => {
      if (v.staleLockCandidate({ ...lockedItem, deployLockOperationId: undefined }) !== null) throw new Error("锁空却给了候选");
      return "null";
    });
    t("陈锁候选:lastOperationId 与持锁者不同 ⇒ null(那 build 不是持锁者的)", () => {
      if (v.staleLockCandidate({ ...lockedItem, lastOperationId: "op_someone9" }) !== null) throw new Error("拿了别人的 build 当判据");
      return "null";
    });
    t("陈锁候选:lastBuildId 为空 ⇒ null", () => {
      if (v.staleLockCandidate({ ...lockedItem, lastBuildId: "" }) !== null) throw new Error("没 build 也敢接管");
      return "null";
    });
    t("陈锁候选:lockEpoch 非数 ⇒ null(fencing 绑不上)", () => {
      if (v.staleLockCandidate({ ...lockedItem, lockEpoch: "x" }) !== null) throw new Error("epoch 不可用却给了候选");
      return "null";
    });
    t("build 终态判定:IN_PROGRESS 不算终态,五个终态都算", () => {
      if (v.isTerminalBuildStatus("IN_PROGRESS")) throw new Error("IN_PROGRESS 被当成终态 —— 会抢正在跑的部署的锁!");
      if (v.isTerminalBuildStatus(undefined)) throw new Error("undefined 被当成终态");
      for (const s of ["SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"]) {
        if (!v.isTerminalBuildStatus(s)) throw new Error(`${s} 应算终态`);
      }
      return "terminal-ok";
    });

    // —— planDeployOpen 行为向量(v2 审核 §18.3 / 拍板 C):原生 import 真执行,不只 source includes ——
    //    ≥10 向量,覆盖 registered/provisioning/verifying/ready/legacy-E99/testing/partial/drain/摘组件/已有op。
    {
      const now = "2026-09-01T00:00:00.000Z";
      const pReq = { targetId: "tgt_usw2_a", components: ["core", "dms"], operationId: "op_abcdef12" };
      const pBase = { targetId: "tgt_usw2_a", version: 7, status: "active", ready: true, components: ["core"], spec: { intent: "serve", desiredComponents: ["core"] }, observed: { phase: "ready", health: "healthy", components: ["core"] } };
      const pv = (fn, code, label) => {
        try { fn(); } catch (e) { if (e?.code === code) return; fail(`planDeployOpen 向量「${label}」应拒 ${code},实际 ${String(e?.code ?? e)}`); return; }
        fail(`planDeployOpen 向量「${label}」应拒 ${code},实际却成功`);
      };
      let pvOk = 0;
      // ② —— 「下发集 ⊇ 完整组件集」(纵深锁)先用真值单独验三向
      {
        const FULLC = ["core", "redshift", "dms", "flink", "airflow-serverless"];
        const item0 = { targetId: "tgt_usw2_a", version: 1, status: "registered", components: FULLC };
        pv(() => v.planDeployOpen(item0, { ...pReq, components: ["core"] }, 2, now), "bad-components", "精简形态(只 core)");
        pv(() => v.planDeployOpen({ ...item0, jurisdiction: "eu-sim" }, { ...pReq, components: FULLC }, 2, now), "bad-components", "跨法域缺 residency-api");
        try { v.planDeployOpen(item0, { ...pReq, components: FULLC }, 2, now); pvOk++; } catch (e) { fail(`planDeployOpen:完整组件集应放行,实际 ${String(e?.code ?? e)}`); }
        const saved = process.env.EXEC_ENV_REQUIRED_COMPONENTS;
        delete process.env.EXEC_ENV_REQUIRED_COMPONENTS;
        pv(() => v.planDeployOpen(item0, { ...pReq, components: FULLC }, 2, now), "bad-components", "未注入完整组件集 ⇒ fail-closed");
        process.env.EXEC_ENV_REQUIRED_COMPONENTS = saved;
        pvOk += 3;
      }
      // 🔴 以下既有向量验的是**别的**拒因 / 状态机(锁、状态、相位、序不敏感…),夹具是 core 级的小形状 ⇒
      //    这一段把注入的完整组件集收窄成 core,让它们各自的拒因照旧可达(完整集那条锁上面已单独验过)。
      process.env.EXEC_ENV_REQUIRED_COMPONENTS = "core";
      // ① ready 补组件:phase 仍 ready、投影 upgrading、operation 带 epoch + 64hex openSnapshotHash + disruptive
      const rdy = v.planDeployOpen(pBase, pReq, 4, now);
      if (rdy.post.observed.phase !== "ready" || rdy.projection.status !== "upgrading" || rdy.projection.ready !== true) fail("planDeployOpen: ready 补组件应停 ready/投影 upgrading");
      if (rdy.post.observed.operation.lockEpoch !== 4 || !/^[a-f0-9]{64}$/.test(rdy.post.observed.operation.openSnapshotHash) || rdy.post.observed.operation.disruptive !== true) fail("planDeployOpen: operation 缺 epoch/canonical hash/disruptive");
      if (rdy.post.spec.desiredComponents.join(",") !== "core,dms") fail("planDeployOpen: desiredComponents 应=请求全集"); pvOk++;
      // ② registered 初装 → provisioning/initializing
      const reg = v.planDeployOpen({ targetId: "tgt_usw2_a", version: 1, status: "registered", components: ["core"] }, { ...pReq, components: ["core"] }, 2, now);
      if (reg.post.observed.phase !== "provisioning" || reg.projection.status !== "initializing") fail("planDeployOpen: registered 初装应 provisioning/initializing"); pvOk++;
      // ③ modern verifying 重部 → provisioning
      const ver = v.planDeployOpen({ targetId: "tgt_usw2_a", version: 4, status: "testing", ready: false, components: ["core"], spec: { intent: "serve", desiredComponents: ["core"] }, observed: { phase: "verifying", health: "unknown", components: ["core"] } }, { ...pReq, components: ["core"] }, 2, now);
      if (ver.post.observed.phase !== "provisioning") fail("planDeployOpen: verifying 重部应回 provisioning"); pvOk++;
      // ④ modern provisioning 重试(带 lastError=failed 投影)→ provisioning、清 lastError
      const retry = v.planDeployOpen({ targetId: "tgt_usw2_a", version: 4, status: "failed", ready: false, components: ["core"], spec: { intent: "serve", desiredComponents: ["core"] }, observed: { phase: "provisioning", health: "unknown", components: ["core"], lastError: "boom" } }, { ...pReq, components: ["core"] }, 2, now);
      if (retry.post.observed.phase !== "provisioning" || retry.post.observed.lastError !== undefined) fail("planDeployOpen: provisioning 重试应留 provisioning 并清 lastError"); pvOk++;
      // ⑤ legacy testing 不跳 enable → provisioning
      const tst = v.planDeployOpen({ targetId: "tgt_usw2_a", version: 3, status: "testing", ready: false, components: ["core"], probe: { at: "2026-08-31T23:59:00.000Z", ok: true, items: [{ name: "core", ok: true }] } }, { ...pReq, components: ["core"] }, 2, now);
      if (tst.post.observed.phase !== "provisioning" || tst.ifAbsent !== true) fail("planDeployOpen: legacy testing 不得跳过 enable"); pvOk++;
      // ⑥ 🔴 legacy initializing∧ready∧stored-probe→ needs-fresh-probe(拒绝清单 #12)
      pv(() => v.planDeployOpen({ targetId: "tgt_usw2_a", version: 5, status: "initializing", ready: true, components: ["core"], probe: { at: "2026-09-01T16:00:00.000Z", ok: true, items: [{ name: "core", ok: true }] } }, { ...pReq, components: ["core"] }, 2, now), "needs-fresh-probe", "stuck-after-ready"); pvOk++;
      // ⑦ partial spec/observed → bad-descriptor(不回落 legacy)
      pv(() => v.planDeployOpen({ ...pBase, observed: undefined }, pReq, 4, now), "bad-descriptor", "partial-axes"); pvOk++;
      // ⑧ drain 意图 → bad-status
      pv(() => v.planDeployOpen({ targetId: "tgt_usw2_a", version: 4, status: "draining", ready: true, components: ["core"], spec: { intent: "drain", desiredComponents: ["core"] }, observed: { phase: "draining", health: "healthy", components: ["core"] } }, { ...pReq, components: ["core"] }, 2, now), "bad-status", "drain-intent"); pvOk++;
      // ⑨ 摘既有组件 → bad-components(broker 不做借重部署摘组件的旁路)
      pv(() => v.planDeployOpen({ ...pBase, components: ["core", "dms"], spec: { intent: "serve", desiredComponents: ["core", "dms"] }, observed: { phase: "ready", health: "healthy", components: ["core", "dms"] } }, { ...pReq, components: ["core"] }, 4, now), "bad-components", "drop-component"); pvOk++;
      // ⑩ legacy 残留部署锁 → locked
      pv(() => v.planDeployOpen({ targetId: "tgt_usw2_a", version: 2, status: "active", ready: true, components: ["core"], deployLockToken: "op_x" }, { ...pReq, components: ["core"] }, 2, now), "locked", "legacy-residual-lock"); pvOk++;
      // ⑪:顶层 components 与 observed.components **同集合不同序** ⇒ 不许判 bad-descriptor
      //    (真环境:平台 finalize 按 IMPLEMENTED 序写顶层,broker 按枚举序归一 observed,逐字节比 ⇒ 补装被拒)
      try {
        const oo = v.planDeployOpen({ targetId: "tgt_usw2_a", version: 9, status: "active", ready: true, components: ["core", "dms", "mwaa"], spec: { intent: "serve", desiredComponents: ["core", "mwaa", "dms"] }, observed: { phase: "ready", health: "healthy", components: ["core", "dms", "mwaa"] } }, { ...pReq, components: ["core", "mwaa", "dms", "flink"] }, 5, now);
        if (oo.post.observed.phase !== "ready") fail("planDeployOpen ⑪:同集合不同序的 active item 应正常开 deploy");
      } catch (e) {
        fail(`planDeployOpen ⑪:顶层 components 与 observed.components 同集合不同序被判 ${String(e?.code ?? e)} —— 跨来源比较没 canonical`);
      }
      pvOk++;
      // ⑫:开会话快照哈希对 components **序不敏感**(开会话 Update 会重排顶层 components;
      //    序敏感 ⇒ post-image 哈希必不等 ⇒ 「无法取得 exact post-image」保留 operation ⇒ 卡 2h15m。真环境撞到)
      {
        const a = { targetId: "tgt_usw2_a", region: "us-west-2", accountId: "123456789012", partition: "aws", version: 9, components: ["core", "redshift", "dms", "flink", "mwaa"], resources: { vpcId: "vpc-1" } };
        const b = { ...a, components: ["core", "redshift", "mwaa", "dms", "flink"] };
        if (v.deployOpenSnapshotHash(a) !== v.deployOpenSnapshotHash(b)) fail("deployOpenSnapshotHash 对同集合不同序的 components 给出不同哈希 —— 开会话 post-image 必判不匹配(真环境卡锁根因)");
        const c = { ...a, components: ["core", "redshift", "dms", "flink"] };
        if (v.deployOpenSnapshotHash(a) === v.deployOpenSnapshotHash(c)) fail("deployOpenSnapshotHash 对不同集合给出相同哈希 —— 快照失去区分力");
      }
      pvOk++;
      if (pvOk < 12) fail(`planDeployOpen 行为向量只跑了 ${pvOk} 条(<12)—— 向量集被削了`);
      globalThis.__planDeployOpenVectors = pvOk;
    }

    // planDestroyOpen 行为向量(原生 import 真执行)——
    {
      const now = "2026-10-11T00:00:00.000Z";
      const dReq = v.validateInput({ targetId: "tgt_usw2_a", operationId: "op_abcdef12", mode: "destroy" });
      const plan0 = { approvalId: "01JABCDEF", finalSnapshotName: "bgp-final-tgt-usw2-a-20261011-0000" };
      const dBase = {
        targetId: "tgt_usw2_a", version: 11, isHome: false, status: "draining", ready: true,
        components: ["core", "redshift"],
        spec: { intent: "delete", desiredComponents: ["core", "redshift"] },
        observed: { phase: "draining", health: "healthy", components: ["core", "redshift"], lastError: "上一轮卡住" },
        decommission: plan0,
      };
      const dv = (fn, code, label) => {
        try { fn(); } catch (e) { if (e?.code === code) return; fail(`planDestroyOpen 向量「${label}」应拒 ${code},实际 ${String(e?.code ?? e)}`); return; }
        fail(`planDestroyOpen 向量「${label}」应拒 ${code},实际却成功`);
      };
      let dvOk = 0;
      // ① 正向:draining + intent=delete + 删除计划 ⇒ phase decommissioning、投影 decommissioning、destroy op 带 epoch、清 lastError
      const d1 = v.planDestroyOpen(dBase, dReq, 5, now);
      if (d1.post.observed.phase !== "decommissioning" || d1.projection.status !== "decommissioning") fail("planDestroyOpen ①:应进 decommissioning / 投影 decommissioning");
      if (d1.post.observed.operation?.kind !== "destroy" || d1.post.observed.operation.lockEpoch !== 5 || d1.post.observed.operation.disruptive !== true) fail("planDestroyOpen ①:destroy operation 缺 kind/epoch/disruptive");
      if (d1.post.observed.operation.openSnapshotHash !== undefined) fail("planDestroyOpen ①:destroy operation 不许带 openSnapshotHash(那是部署基线的指纹)");
      if (d1.post.observed.lastError !== undefined) fail("planDestroyOpen ①:新一轮销毁应清掉上一轮的 lastError");
      if (d1.post.spec.intent !== "delete") fail("planDestroyOpen ①:spec 不许被 broker 改");
      if (d1.finalSnapshotName !== plan0.finalSnapshotName || d1.approvalId !== plan0.approvalId) fail("planDestroyOpen ①:快照名 / 审批单必须照抄注册表的删除计划");
      if (d1.components.join(",") !== "core,redshift") fail(`planDestroyOpen ①:销毁组件应 = desired ∪ observed(实际 ${d1.components.join(",")})`);
      dvOk++;
      // ② 重试:上一轮卡住(decommissioning、无 operation)⇒ 可以再开
      const d2 = v.planDestroyOpen({ ...dBase, status: "decommissioning", observed: { ...dBase.observed, phase: "decommissioning", health: "unknown" } }, dReq, 6, now);
      if (d2.post.observed.phase !== "decommissioning") fail("planDestroyOpen ②:卡住后的重试应能再开"); dvOk++;
      // ③ 装了一半(provisioning + 有栈)⇒ 也走销毁
      const d3 = v.planDestroyOpen({ ...dBase, ready: false, status: "draining", components: ["core"], observed: { phase: "provisioning", health: "unknown", components: ["core"], lastError: "boom" } }, dReq, 2, now);
      if (d3.post.observed.phase !== "decommissioning") fail("planDestroyOpen ③:provisioning(装了一半)应能进销毁"); dvOk++;
      // ④ intent≠delete(没审批)⇒ bad-status
      dv(() => v.planDestroyOpen({ ...dBase, spec: { ...dBase.spec, intent: "drain" } }, dReq, 5, now), "bad-status", "intent=drain(未经审批)"); dvOk++;
      // ⑤ 没有删除计划 ⇒ bad-descriptor
      dv(() => v.planDestroyOpen({ ...dBase, decommission: undefined }, dReq, 5, now), "bad-descriptor", "缺删除计划"); dvOk++;
      // ⑥ 快照名非法 ⇒ bad-descriptor
      dv(() => v.planDestroyOpen({ ...dBase, decommission: { ...plan0, finalSnapshotName: "final;rm -rf" } }, dReq, 5, now), "bad-descriptor", "快照名非法"); dvOk++;
      // ⑦ home ⇒ bad-status(描述符 isHome 再拦一道)
      dv(() => v.planDestroyOpen({ ...dBase, isHome: true }, dReq, 5, now), "bad-status", "isHome"); dvOk++;
      // ⑧ registered(从没部署过)⇒ bad-status(走弃置)
      dv(() => v.planDestroyOpen({ ...dBase, ready: false, status: "draining", components: [], observed: { phase: "registered", health: "unknown", components: [] } }, dReq, 5, now), "bad-status", "registered"); dvOk++;
      // ⑨ 已有 operation ⇒ locked
      dv(() => v.planDestroyOpen({ ...dBase, status: "decommissioning", lockEpoch: 4, deployLockToken: "op_prev0001", deployLockOperationId: "op_prev0001", deployLockExpiresAt: 1, observed: { ...dBase.observed, phase: "decommissioning", health: "unknown", lastError: undefined, operation: { kind: "destroy", operationId: "op_prev0001", lockEpoch: 4, startedAt: now, disruptive: true } } }, dReq, 5, now), "locked", "已有 destroy operation"); dvOk++;
      // ⑩ legacy(无双轴)⇒ needs-fresh-probe
      dv(() => v.planDestroyOpen({ targetId: "tgt_usw2_a", version: 3, status: "draining", ready: true, components: ["core"], decommission: plan0 }, dReq, 2, now), "needs-fresh-probe", "legacy"); dvOk++;
      // ⑪ deploy 模式的请求不许拿来开销毁
      dv(() => v.planDestroyOpen(dBase, { targetId: "tgt_usw2_a", operationId: "op_abcdef12", mode: "deploy", components: ["core"] }, 5, now), "rejected", "mode=deploy"); dvOk++;
      // ⑫ gone ⇒ bad-status
      dv(() => v.planDestroyOpen({ ...dBase, status: "deleted", ready: false, components: ["core"], observed: { phase: "gone", health: "unknown", components: ["core"] } }, dReq, 5, now), "bad-status", "gone"); dvOk++;
      if (dvOk < 12) fail(`planDestroyOpen 行为向量只跑了 ${dvOk} 条(<12)`);
      globalThis.__planDestroyOpenVectors = dvOk;
    }

    // —— 判定(带防假绿护栏)——
    if (cases.length < 18) fail(`broker 入参用例只有 ${cases.length} 条(<18)—— 矩阵没跑全,别当绿`);
    const mustReject = cases.filter((c) => /拒|非法|空串|超长|不存在|缺 /.test(c.name));
    // 🔴 下限随用例增长上调(P0-E 加了 5 条负向):数量断言是防"筛选正则坏了导致全静默放过"
    if (mustReject.length < 19) fail(`broker 入参负向用例只筛出 ${mustReject.length} 条(<19)—— 筛选正则可能坏了`);
    for (const c of mustReject) {
      if (c.ok) fail(`broker 入参用例「${c.name}」应当被拒,却通过了(值 ${JSON.stringify(c.value).slice(0, 120)})`);
    }
    // 正向 —— 枚举里的每个组件 broker 都必须认(第三份名单漂移就在这里红)
    for (const c of cases.filter((x) => /^合法组件 /.test(x.name))) {
      if (!c.ok) fail(`broker 入参用例「${c.name}」应当通过,却被拒:${c.msg}(broker 组件全集与 context.ts 枚举不同源)`);
    }
    const expectCode = { "item 不存在 ⇒ not-registered": "not-registered", "缺 region ⇒ bad-descriptor": "bad-descriptor", "缺 accountId ⇒ bad-descriptor": "bad-descriptor" };
    for (const [name, code] of Object.entries(expectCode)) {
      const c = cases.find((x) => x.name === name);
      if (c && c.code !== code) fail(`broker 入参校验「${name}」的 code=${c.code},应为 ${code}(平台侧按它映射 HTTP 状态)`);
    }
    for (const c of cases.filter((x) => /bad-status/.test(x.name))) {
      if (c.code !== "bad-status") fail(`broker 入参校验「${c.name}」的 code=${c.code},应为 bad-status`);
    }
    // 🔴 P0-E 正向具名核对(只靠 mustReject 会漏掉"接受路径静默变形")
    const p0eOk = {
      "destroy 三参被接受": "destroy",
      "P0-E:mode 缺省为 deploy(向后兼容,老三参照旧行为)": "deploy",
      "P0-E:mode=preview 被接受": "preview",
      "P0-E:合法 approvedPlanHash 被接受": "a".repeat(64),
    };
    for (const [name, want] of Object.entries(p0eOk)) {
      const c = cases.find((x) => x.name === name);
      if (!c) fail(`broker 入参校验少了 P0-E 用例「${name}」—— 用例被删掉 = 门禁失效`);
      if (!c.ok) fail(`broker 入参校验「${name}」应当通过,却被拒:${c.msg}`);
      if (c.value !== want) fail(`broker 入参校验「${name}」返回 ${JSON.stringify(c.value)},应为 ${JSON.stringify(want)}`);
    }

    const base = cases.find((c) => c.name === "合法基线");
    if (!base?.ok || base.value?.targetId !== "tgt_usw2_a" || JSON.stringify(base.value?.components) !== '["core"]') {
      fail(`broker 入参校验合法基线没通过(合法请求被拒 = 门禁把功能判死):${JSON.stringify(base)}`);
    }
    const order = cases.find((c) => c.name === "组件顺序归一");
    if (JSON.stringify(order?.value?.components) !== '["core","redshift"]') {
      fail(`broker 入参校验组件顺序未归一(同一勾选应产生同一 build 入参):${JSON.stringify(order?.value?.components)}`);
    }
    const pass = cases.find((c) => c.name === "合法 item 通过");
    if (!pass?.ok) fail(`broker 入参校验合法 item 被 assessTarget 拒了:${JSON.stringify(pass)}`);
    // 🔴 陈锁那 6 条是"内部断言式"用例:必须**具名**核对 ok,否则断言抛错只被记成 ok:false 而静默通过。
    const lockCases = cases.filter((c) => /^陈锁候选|^build 终态判定/.test(c.name));
    if (lockCases.length !== 6) fail(`陈锁用例应 6 条,实际 ${lockCases.length} 条(改了名字就得改这里)`);
    for (const c of lockCases) {
      if (!c.ok) fail(`陈锁用例「${c.name}」不成立:${c.msg}`);
    }
  } catch (e) {
    fail(`broker 入参校验:validate.mjs 加载失败(纯函数拆分被破坏?):${String(e?.message || e).slice(0, 300)}`);
  }

  // —— 文本锚点:index.mjs 必须真的在用 validate.mjs(防"拆了但没接")——
  // 先剥注释行(行首 // 与 JSDoc 续行 *)—— 三次教训:注释里的反面措辞会骗出假阳性/假阴性。
  const idx = readFileSync(resolve(INFRA, "lambda/exec-env-broker/index.mjs"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  if (!/import\s*\{[^}]*validateInput[^}]*\}\s*from\s*"\.\/validate\.mjs"/s.test(idx)) {
    fail("index.mjs 没有从 ./validate.mjs import validateInput —— 纯函数拆分被绕开(门禁测的就不是生产逻辑了)");
  }
  if (!/import\s*\{[^}]*planDeployOpen[^}]*\}\s*from\s*"\.\/validate\.mjs"/s.test(idx)) {
    fail("index.mjs 没有 import planDeployOpen —— 写序 planner 没接线(v2 审核 §19)");
  }
  for (const fn of ["validateInput(", "validateTargetDescriptor(", "planDeployOpen(", "deployOpenSnapshotHash(", "translateLockError(", "staleLockCandidate(", "isTerminalBuildStatus("]) {
    if (!idx.includes(fn)) fail(`index.mjs 不再调用 ${fn.slice(0, -1)} —— 拆了但没接`);
  }
  // 🔴 写序(v2 审核 §4.2/§19):operation 必须**先于** StartBuild 落库。
  //
  // 【为什么不是一句 `openIdx < startBuildIdx`】原版就是那样写的,而 P0-E 的 **preview 只读旁路**
  //   (刻意不开 operation、不上锁、不涨 epoch)在文本上排在前面 ⇒ 原断言当场误红。
  //   把断言"挪一挪让它过"是缝补;这里改成**逐调用点判定**,顺带把它变严:
  //   原版只要求"第一个 startBuild 在开会话之后",于是**任何**再加的 StartBuild 只要写在后面就放过;
  //   现在每个调用点都必须落进两类之一,且**数量固定**——多出一条路径立刻红。
  const openIdx = idx.indexOf("openDeploySessionWithRecovery(");
  if (openIdx < 0) fail("index.mjs 没有 openDeploySessionWithRecovery —— 开 operation 的写序缺失(§19)");
  const sbCalls = [...idx.matchAll(/await\s+startBuild\(([^)]*)\)/g)];
  if (sbCalls.length === 0) fail("index.mjs 没有 await startBuild( —— StartBuild 调用缺失");
  // 🔴 数量断言:3 = 真部署 1 条 + preview 1 条 + 下线销毁 1 条。
  //    变了就必须回来重新推演写序,不许静默通过。
  if (sbCalls.length !== 3) {
    fail(
      `index.mjs 的 await startBuild( 调用点应恰好 3 个(真部署 + preview 旁路 + 下线销毁),实际 ${sbCalls.length} 个 —— ` +
        "新增 StartBuild 路径必须显式过写序推演(operation 先落库 / 或明确是只读预演)"
    );
  }
  // 销毁调用点:必须在 openDestroySession(之后、带 epoch、带最终快照名(第 4 参)
  const destroyOpenIdx = idx.indexOf("await openDestroySession(");
  const destroyGuardIdx = idx.indexOf('req.mode === "destroy"');
  if (destroyOpenIdx < 0 || destroyGuardIdx < 0) fail("index.mjs 缺 destroy 分流(req.mode === \"destroy\")或 openDestroySession —— 销毁写序缺失");
  const previewGuardIdx = idx.indexOf('req.mode === "preview"');
  const previewBlockIdx = idx.indexOf("previewBlockedReason(");
  if (previewGuardIdx < 0 || previewBlockIdx < 0) {
    fail("index.mjs 缺 preview 守卫(req.mode === \"preview\" / previewBlockedReason)—— 只读旁路必须显式判模式并拒与在途会话并跑");
  }
  for (const m of sbCalls) {
    const at = m.index ?? -1;
    const args = m[1];
    const isPreviewCall = /,\s*undefined\s*$/.test(args.trim());
    const isDestroyCall = /finalSnapshotName\s*$/.test(args.trim());
    if (isDestroyCall) {
      if (!(at > destroyOpenIdx)) fail("index.mjs 的销毁 startBuild 不在 openDestroySession 之后 —— destroy operation 未先于 StartBuild 落库");
      if (!/\bepoch\b/.test(args)) fail(`index.mjs 的销毁 startBuild 没传 epoch(实参:${args.trim()})`);
      continue;
    }
    if (isPreviewCall) {
      // preview 调用点:必须在两个守卫之后(先判模式、先拒在途会话),且在到达开会话之前**已 return**。
      if (!(at > previewGuardIdx && at > previewBlockIdx)) {
        fail("index.mjs 的 preview startBuild 不在 mode 守卫与 previewBlockedReason 之后 —— 无守卫的 session-less StartBuild");
      }
      if (!idx.slice(at, openIdx > at ? openIdx : idx.length).includes("return")) {
        fail("index.mjs 的 preview 分支在 startBuild 后没有 return —— 会穿进真部署路径(既没开 operation 又去部署)");
      }
    } else {
      // 真部署调用点:必须在开会话之后,且**带 epoch**(fence 参数);否则就是"未先落 operation 就 StartBuild"。
      if (!(at > openIdx)) {
        fail("index.mjs 的真部署 startBuild 不在 openDeploySessionWithRecovery 之后 —— operation 未先于 StartBuild 落库(§4.2 反模式)");
      }
      if (!/\bepoch\b/.test(args)) {
        fail(`index.mjs 的真部署 startBuild 没传 epoch(实参:${args.trim()})—— 少了 fence,旧会话的 build 会被当成新的`);
      }
    }
  }
  // 🔴 open 必须**同一次条件写**写 operation(observed)+ 锁 + 投影(无「锁已抢/operation 未开」的崩溃中间态)。
  if (!/deployLockToken = :token[\s\S]*#o = :obs/.test(idx)) {
    fail("index.mjs 的 open 条件写没在同一次 SET 里写 deployLockToken 与 observed —— 违背单次原子开会话(§19.2)");
  }
  // 🔴 attach 必须绑 exact fence(旧 operation 附不到新会话)。
  if (!/attribute_not_exists\(#o\.#operation\.#buildId\)/.test(idx)) {
    fail("index.mjs 的 attachBuildId 没绑 attribute_not_exists(operation.buildId)—— 旧 operation 可覆盖新会话 buildId(§19.5)");
  }
  // 🔴 StartBuild 不确定/失败**不得自动清锁**:全文件不许出现 REMOVE deployLockToken(旧 releaseLock/takeover 清锁写法已删)。
  if (/REMOVE\s+deployLockToken/.test(idx)) {
    fail("index.mjs 出现 REMOVE deployLockToken —— StartBuild 不确定不许自动清锁(§19.6);陈锁恢复走 §19.8 恢复端点");
  }
  if (!/startUncertain/.test(idx)) fail("index.mjs 没有 startUncertain 处理 —— StartBuild 抛错的不确定态未记录(§19.6)");
  // 🔴 旧写序必须已删:markInitializing 的 legacy status 直写 / 旧的直接换锁 takeover。
  if (/SET #s = :init/.test(idx)) fail("index.mjs 仍有 markInitializing 的 SET #s = :init —— 旧写序未删(状态应由 planDeployOpen 投影派生)");
  if (/deployLockOperationId = :prevOp/.test(idx)) fail("index.mjs 仍有旧的直接换锁 takeover(:prevOp)—— 必须删,陈锁走 §19.7 分类恢复");
  // 判定消息只许存在于 validate.mjs 一份(index 里再冒出来 = 有人内联了第二份副本)
  if (idx.includes("入参含未允许字段")) fail("index.mjs 出现入参白名单的判定消息 —— 判定逻辑被内联了第二份(改这份不改那份就是下一个漂移)");
  // 🔴 audit 键回归:bgp-audit 的排序键叫 ts(database-stack.ts:37);切片 b 写成 sk ⇒ 审计静默丢失
  const auditLine = idx.split("\n").find((l) => l.includes("#broker"));
  if (!auditLine) fail("index.mjs 找不到 audit 排序键那一行(#broker)—— audit 写入被删了?");
  else {
    if (!/\bts:/.test(auditLine)) fail(`audit 键没用 ts(bgp-audit 排序键叫 ts):${auditLine.trim().slice(0, 120)}`);
    if (/\bsk:/.test(auditLine)) fail(`audit 键仍在写 sk —— 那是切片 b 的 bug(ValidationException 被吞 = 审计静默丢失):${auditLine.trim().slice(0, 120)}`);
  }
  globalThis.__e49Count = cases.length;
}

// 11) 🔴 buildspec 的 pre_build **真执行**(两个真跑事故的根治性钉法)
//
// 【为什么必须真跑】切片 g 的 4 个 bug 里**两个**出在 buildspec 的 shell 逻辑,而它们的共同点是
//   "只有让那段 shell 真的跑一遍才会露":
//     · dash vs bash(`set -o pipefail` / `${!v}` 间接展开)—— 文本扫描看不出;
//     · `--output text` 是 **TAB** 分隔,而 `case " $AZS "` 按**空格**做词边界 ⇒ AZ 明明可用却判不可用。
//   ⇒ 把 pre_build 的命令块**原样抽出来**(不复写、不改写 = 不产生第二份定义),用 `bash` 跑,
//     把 `aws` 换成 PATH 上的 stub(零凭证、毫秒级)。这与 §10 用 node 原生 import 真跑
//     validate.mjs 是同一手法。
{
  const raw = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8").split("\n");
  // 抽 phases.pre_build.commands 下的 `- |` 字面块(只认这一种写法;换写法就让它红,别静默漏测)
  const start = raw.findIndex((l) => /^\s{2}pre_build:\s*$/.test(l));
  if (start < 0) fail("buildspec 找不到 pre_build 段 —— §11 真执行无法进行(格式变了就得改这里,不许静默跳过)");
  let end = raw.findIndex((l, i) => i > start && /^\s{2}\S/.test(l));
  if (end < 0) end = raw.length;
  const body = raw.slice(start, end);
  const blocks = [];
  for (let i = 0; i < body.length; i++) {
    if (!/^\s*-\s*\|\s*$/.test(body[i])) continue;
    const indent = body[i].search(/\S/) + 2;
    const lines = [];
    for (let j = i + 1; j < body.length && (body[j].trim() === "" || body[j].search(/\S/) >= indent); j++) {
      lines.push(body[j].slice(indent));
      i = j;
    }
    blocks.push(lines.join("\n"));
  }
  if (blocks.length < 2) fail(`buildspec pre_build 只抽出 ${blocks.length} 个命令块(<2)—— 抽取逻辑坏了,别当绿`);
  const script = blocks.join("\n");
  if (!/describe-availability-zones/.test(script) || !/get-caller-identity/.test(script)) {
    fail("§11 抽出的 pre_build 里没有 AZ preflight 或账号护栏 —— 抽错了段");
  }

  const dir = mkdtempSync(resolve(tmpdir(), "exec-env-prebuild-"));
  const bin = resolve(dir, "bin");
  mkdirSync(bin);
  writeFileSync(resolve(dir, "pre_build.sh"), script);
  /**
   * aws stub:只答本段会问的问题;`STUB_AZS` 用 **TAB** 分隔 —— 真 CLI 的 `--output text` 就是这样。
   * 扩:孤儿表桶清理(bug #6)要问 CFN 与 S3Tables ⇒ 用 `STUB_*` 变量模拟四种世界状态,
   * 并把**真的发出 delete** 记到 `$STUB_DELETE_LOG`(否则"删没删"只能靠读输出猜)。
   */
  const stub = `#!/bin/bash
case "$1" in
  sts) printf '%s\\n' "\${STUB_ACCOUNT}"; exit 0;;
  ec2)
    # 第二层 AZ preflight 要问端点服务与子网 ⇒ 按子命令分派
    case "$2" in
      describe-availability-zones)   printf '%s\\n' "\${STUB_AZS}"; exit 0;;
      describe-vpc-endpoint-services) printf '%s\\n' "\${STUB_EP_AZS-\${STUB_AZS}}"; exit 0;;
      describe-subnets)              printf '%s\\n' "\${STUB_SUBNET_AZS:-}"; exit 0;;
      # 存量守卫要读现网 VPC 的 CidrBlock
      describe-vpcs)                 printf '%s\\n' "\${STUB_VPC_CIDR:-10.128.0.0/16}"; exit 0;;
      *) printf '%s\\n' "\${STUB_AZS}"; exit 0;;
    esac;;
  cloudformation)
    # 主控区那三件事实从 BgpVpcStack 的 Outputs 读
    #   ⇒ 按 --query 里问的 OutputKey 分派(顺序要紧:XregionDdbEndpointId / VpcCidr 都含子串,先长后短)
    case "$*" in
      *BgpVpcStack*XregionDdbEndpointId*) printf '%s\\n' "\${STUB_HOME_DDB_EP-vpce-0123456789abcdef0}"; exit 0;;
      *BgpVpcStack*VpcCidr*)              printf '%s\\n' "\${STUB_HOME_VPC_CIDR-10.0.0.0/16}"; exit 0;;
      *BgpVpcStack*VpcId*)                printf '%s\\n' "\${STUB_HOME_VPC_ID-vpc-0123456789abcdef0}"; exit 0;;
    esac
    case "$2" in
      describe-stack-resources) printf '%s\\n' "\${STUB_VPC_ID:-None}"; exit 0;;
      *) [ "\${STUB_CORE_STACK_EXISTS}" = "1" ] && exit 0 || { echo "does not exist" >&2; exit 254; };;
    esac;;
  s3tables)
    case "$2" in
      list-table-buckets) printf '%s\\n' "\${STUB_TB_ARN:-None}"; exit 0;;
      list-namespaces)    printf '%s\\n' "\${STUB_NS_COUNT:-0}"; exit 0;;
      list-tables)        printf '%s\\n' "\${STUB_TABLE_COUNT:-0}"; exit 0;;
      delete-table-bucket) echo "DELETED $*" >> "\${STUB_DELETE_LOG}"; exit 0;;
    esac;;
esac
echo "stub: 未预期的 aws 调用: $*" >&2; exit 99
`;
  writeFileSync(resolve(bin, "aws"), stub);
  chmodSync(resolve(bin, "aws"), 0o755);

  const okEnv = {
    EXEC_ENV_TARGET: "tgt_usw2_a",
    EXEC_ENV_REGION: "us-west-2",
    EXEC_ENV_ACCOUNT: "123456789012",
    EXEC_ENV_COMPONENTS: "core",
    EXEC_ENV_OPERATION_ID: "op_abcdef12",
    EXEC_ENV_LOCK_EPOCH: "2",
    // 非 home 必须带段(缺了 pre_build 第 0 步就 fail-fast)
    EXEC_ENV_VPC_CIDR: "10.128.0.0/16",
    // 主控区 region(真环境由 CodeBuild 注入;第 1e 步用它判「是否跨区」并读 BgpVpcStack 的输出)
    AWS_REGION: HOME_REGION,
    STUB_ACCOUNT: "123456789012",
    // 🔴 TAB 分隔(\t):这正是 bug #4 的形态 —— 归一化没做的话本用例必红。
    STUB_AZS: "us-west-2a\tus-west-2b\tus-west-2c\tus-west-2d",
    // 孤儿清理的缺省世界:core 栈存在(= 活资源,不许碰任何桶)
    STUB_CORE_STACK_EXISTS: "1",
    STUB_DELETE_LOG: resolve(dir, "deletes.log"),
    // CodeBuild 注入的源根:真环境由服务给,门禁里指**仓根**(孤儿清理要读 platform/naming.json,
    // 也顺带验证了"buildspec 只从 SSOT 现算桶名、不写第二处字面量")
    CODEBUILD_SRC_DIR: REPO,
  };
  const run = (over) => {
    try {
      execFileSync("bash", [resolve(dir, "pre_build.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...okEnv, ...over },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // 🔴 60s 不是随手写的:孤儿清理成功路径里有 `sleep 20`(等 S3Tables 删除传播),
        //    20s 上限会把"删成功"误判成失败(实测踩到)。
        timeout: 60000,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || ""), status: e?.status };
    }
  };

  // 正向:AZ 表是 TAB 分隔也必须通过(bug #4 的回归)
  const good = run({});
  if (!good.ok) {
    fail(`§11 pre_build 正向用例失败(TAB 分隔的 AZ 表必须能匹配上;bug #4 回归):status=${good.status} ${String(good.out).slice(-400)}`);
  }
  // 正向:该 region **没有 b**(ap-northeast-1 形态:只有 a/c/d)⇒ 必须通过,且第 1d 层挑出 a,c
  {
    const azFile = resolve(REPO, ".exec-env-azs");
    const noB = run({ STUB_AZS: "us-west-2a\tus-west-2c\tus-west-2d" });
    if (!noB.ok) fail(`§11 pre_build「region 没有 b」竟然被拒(回归:不许假设任何区一定有 a/b):${String(noB.out).slice(-300)}`);
    else {
      const chosen = existsSync(azFile) ? readFileSync(azFile, "utf8").trim() : "";
      if (chosen !== "us-west-2a,us-west-2c") fail(`§11 pre_build「region 没有 b」挑出的 AZ 不对:${chosen || "(没写 .exec-env-azs)"}(应为 us-west-2a,us-west-2c)`);
    }
    globalThis.__preBuildCases = (globalThis.__preBuildCases ?? 0) + 1;
  }
  // 负向三条:缺入参 / 账号不符 / 该 region 可用 AZ 不足 2 个
  const negatives = [
    ["缺 EXEC_ENV_REGION", { EXEC_ENV_REGION: "" }, /缺环境变量/],
    // 🔴 stub 值刻意**不写成 12 位数字**:红线扫描按"12 位数字串"判账号号,连假值也会被咬
    //    (记忆里的旧坑复发一次)。账号护栏只做字符串比较,任何不相等的值都能验到同一条分支。
    ["目标账号与 build 身份不同", { STUB_ACCOUNT: "some-other-account" }, /不支持跨账号/],
    // 🔴 原来这条是「region 缺 a/b ⇒ 必须拒」:把写成了门禁的期望(c/d 明明是两个可用 AZ)。
    //   真约束是「可用 AZ ≥ 2」⇒ 负向改成只有 1 个可用 AZ;「没有 b」改成下面的**正向**用例。
    ["region 可用 AZ 不足 2 个", { STUB_AZS: "us-west-2c" }, /可用的 AZ 不足 2 个/],
    // 主控区读不到跨区端点(典型 = 主控区跑在**导入的现有 VPC** 上)
    //   ⇒ 必须停在这里,并把真正的原因说出来。带着不确定继续 = 建出一个回写不了台账的环境。
    ["主控区没有跨区端点输出", { STUB_HOME_DDB_EP: "None" }, /导入的现有 VPC/],
    ["主控区没有 VPC 网段输出", { STUB_HOME_VPC_CIDR: "None" }, /BgpVpcStack 没有输出 VpcCidr/],
  ];
  for (const [name, over, re] of negatives) {
    const r = run(over);
    if (r.ok) fail(`§11 pre_build 负向用例「${name}」竟然通过了 —— fail-fast 被削掉了`);
    else if (!re.test(r.out)) fail(`§11 pre_build 负向用例「${name}」拒了但原因不对:${String(r.out).slice(-300)}`);
  }

  // ── §11b:**第二层** AZ preflight(端点服务 × AZ 交集)──
  // 起因(2026-09-11 全新账号首装真环境):`us-east-1a` 账号级可用 ⇒ 第一层放行,而
  //   `com.amazonaws.us-east-1.redshift-serverless` 在该账号只支持 1b/1c/1d
  //   ⇒ base 栈建端点时 400 `does not support the availability zone of the subnet` ⇒ **整栈回滚,首装失败**。
  // 🔴 判据必须是「**选出来的 AZ 落在交集里**」,不是「跑通了没报错」:后者在「照旧挑 a、b」的实现下同样绿。
  {
    const azFile = resolve(REPO, ".exec-env-azs");
    const readChosen = () => (existsSync(azFile) ? readFileSync(azFile, "utf8").trim() : "");
    // 正向:交集排掉了 a ⇒ 必须挑 b、c(字典序前两个),而**不是**默认的 a、b
    rmSync(azFile, { force: true });
    const pick = run({ STUB_EP_AZS: "us-west-2b\tus-west-2c\tus-west-2d" });
    if (!pick.ok) {
      fail(`§11b 正向用例失败(交集排掉 a 时应挑 b、c):${String(pick.out).slice(-400)}`);
    } else if (readChosen() !== "us-west-2b,us-west-2c") {
      fail(`§11b 选出的 AZ 是 ${JSON.stringify(readChosen())},应为 "us-west-2b,us-west-2c" —— ` +
        `交集算错 / 或压根没按交集挑(那就等于第二层没生效,首装照样炸)`);
    }
    // 负向 ①:交集只剩 1 个 AZ ⇒ 必须 fail-fast(私有子网要跨 AZ)
    rmSync(azFile, { force: true });
    const one = run({ STUB_EP_AZS: "us-west-2c" });
    if (one.ok) fail("§11b 交集只有 1 个 AZ 竟然通过 —— 私有子网必须跨 AZ,这里要 fail-fast");
    else if (!/不足 2 个/.test(one.out)) fail(`§11b 交集不足 2 个时拒因不对:${String(one.out).slice(-300)}`);
    // 负向 ②:某服务在该 region 查不到支持 AZ ⇒ 必须 fail-fast(不许当成"无限制"放过)
    rmSync(azFile, { force: true });
    const none = run({ STUB_EP_AZS: " " });
    if (none.ok) fail("§11b 端点服务查不到 AZ 竟然通过 —— 那会把 400 留到 CFN 里炸");
    else if (!/查不到支持的 AZ/.test(none.out)) fail(`§11b 服务无 AZ 时拒因不对:${String(none.out).slice(-300)}`);
    // 负向 ③:**存量 VPC 的 AZ 不许被静默换掉**(换了会替换子网,N0 判据禁止)
    rmSync(azFile, { force: true });
    const moved = run({
      STUB_VPC_ID: "vpc-0abc", STUB_SUBNET_AZS: "us-west-2a\tus-west-2b",
      STUB_EP_AZS: "us-west-2b\tus-west-2c\tus-west-2d",
    });
    if (moved.ok) fail("§11b 存量 VPC 的 AZ 已不被端点服务支持时竟然继续 —— 那会静默替换子网/VPC");
    else if (!/已不被全部端点服务支持/.test(moved.out)) fail(`§11b 存量 AZ 守卫拒因不对:${String(moved.out).slice(-300)}`);
    // 负向 ④:**存量 VPC 的网段不许被换掉**
    //   (换网段 ⇒ 所有子网 CidrBlock 变化 ⇒ 子网被替换,与负向 ③ 同一条 N0-10 红线)
    rmSync(azFile, { force: true });
    const recidr = run({
      STUB_VPC_ID: "vpc-0abc", STUB_SUBNET_AZS: "us-west-2a\tus-west-2b",
      STUB_VPC_CIDR: "10.200.0.0/16",
    });
    if (recidr.ok) fail("§11b 存量 VPC 的 CIDR 与描述符不一致时竟然继续 —— 那会静默替换全部子网(N0-10 禁)");
    else if (!/与描述符里的 vpcCidr/.test(recidr.out)) fail(`§11b 存量 CIDR 守卫拒因不对:${String(recidr.out).slice(-300)}`);
    // 正控制:一致时不许被这条误伤(否则「守卫」变成「谁都过不去」)
    rmSync(azFile, { force: true });
    const same = run({
      STUB_VPC_ID: "vpc-0abc", STUB_SUBNET_AZS: "us-west-2a\tus-west-2b",
      STUB_VPC_CIDR: "10.128.0.0/16",
    });
    if (!same.ok) fail(`§11b 存量 CIDR 与描述符一致却被拦:${String(same.out).slice(-300)}`);
    rmSync(azFile, { force: true });
    globalThis.__azPreflight2 = { cases: 6 };
  }

  // ── §11d:buildspec 里**每个 aws 调用都必须有授权** ──
  // 血的教训(2026-09-11 同日第二次犯同一类错):第二层 AZ preflight 加了
  //   `aws ec2 describe-vpc-endpoint-services` 却**没在同一笔提交里授权** ⇒ build 以
  //   `exit status 254`(CLI 服务错)中止,而报错离「preflight 逻辑」很远,看起来像交集算错。
  // 🔴 这条判据把「代码用了的动作、角色没给」这一整类挡在部署前(与 IAM 模拟门同一个思路:
  //    量具的覆盖面就是判据本身)。授权面读**单一作者** deploy-stack.ts 的源码字面量。
  {
    // buildspec **与它调用的销毁脚本**一起扫(脚本里的 aws 调用同样跑在 build 角色下;
    //   只扫 buildspec = 把销毁那一整段的授权面放进盲区)。脚本先剥注释行(注释里的措辞会骗出假需求)。
    const stripSh = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const bs =
      readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8") +
      "\n" +
      stripSh(readFileSync(resolve(INFRA, "scripts/exec-env-destroy.sh"), "utf8"));
    const roleSrc = readFileSync(resolve(INFRA, "lib/exec-env/deploy-stack.ts"), "utf8");
    const granted = new Set([...roleSrc.matchAll(/"([a-z0-9-]+):([A-Za-z0-9*]+)"/g)].map((m) => `${m[1]}:${m[2]}`));
    const pascal = (op) => op.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    // CLI 服务名 ≠ IAM 动作前缀的那几个(闭合表:没登记的 CLI 名按原样当前缀 —— 写错会在下面判缺权,而不是静默放过)
    const IAM_PREFIX = { s3api: "s3", kinesisanalyticsv2: "kinesisanalytics", "mwaa-serverless": "airflow-serverless", mwaa: "airflow" };
    // CLI 操作名 ≠ IAM 动作名的那几个(head-bucket 的 IAM 动作是 s3:ListBucket;s3:* 已覆盖,这里如实映射)
    const IAM_OP = { "s3api:head-bucket": "ListBucket" };
    const needed = new Set();
    for (const m of bs.matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)) {
      const svc = m[1];
      // `aws --version` 这类非服务调用不算;cdk 走 npx 不走 aws
      if (svc.startsWith("-")) continue;
      needed.add(`${IAM_PREFIX[svc] ?? svc}:${IAM_OP[`${svc}:${m[2]}`] ?? pascal(m[2])}`);
    }
    // 正向控制:销毁那一段的代表性动作必须真的被抽到(抽不到 = 脚本没被扫进来)
    for (const a of ["kinesisanalytics:DeleteApplication", "airflow-serverless:DeleteWorkflow", "redshift-serverless:DeleteNamespace", "cloudformation:DeleteStack"]) {
      if (!needed.has(a)) fail(`§11d 没从销毁脚本里抽到 ${a} —— 扫描面漏了 scripts/exec-env-destroy.sh`);
    }
    if (needed.size < 4) fail(`§11d 从 buildspec 里只抽出 ${needed.size} 个 aws 调用 —— 抽取正则坏了,别当绿`);
    const covered = (action) => {
      if (granted.has(action)) return true;
      const [svc, op] = action.split(":");
      if (granted.has(`${svc}:*`)) return true;
      for (const g of granted) {
        if (!g.startsWith(`${svc}:`)) continue;
        const gop = g.split(":")[1];
        if (gop.endsWith("*") && op.startsWith(gop.slice(0, -1))) return true;
      }
      return false;
    };
    const missing = [...needed].filter((a) => !covered(a)).sort();
    if (missing.length) {
      fail(`§11d buildspec 用了这些动作但 build 角色没授权:${missing.join(", ")} ` +
        `—— 会让 build 以 exit 254 中止,而报错离真因很远(2026-09-11 实测踩到)`);
    }
    globalThis.__buildspecActions = { needed: needed.size };
  }

  // ── §11e 🔴🔴 **build 段的 shell 也要真跑一遍**(2026-09-15 真环境死在这里)──
  //
  // 【为什么补这一节】§11 只把 **pre_build** 抽出来真跑,build 段一行都没执行过。
  //   真环境第一次建 us-west-2:`read -r a b c < file` 在文件**没有行尾换行**时返回非 0
  //   (变量其实已赋好值),`set -euo pipefail` 当场杀掉整个 build ——
  //   而 CodeBuild 日志里只有**命令原文**,看不出是哪一行、更看不出是 read 的返回值。
  //   synth 门禁全绿、单测全绿:因为**没有任何东西执行过这段 shell**。
  // 🔴 判据形状:stub 掉 `npx`(把 argv 落盘)后真跑最后一个命令块,并且
  //   ① 两种文件形态都要过(**带换行 / 不带换行**);② argv 里必须**真的**带上四个 `-c` 入参
  //   —— 后者比「文本里出现 exec-env-vpc-cidr」强得多:数组拼错、引号写错、变量空了都能被抓到。
  {
    const bsRaw = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8").split("\n");
    const bStart = bsRaw.findIndex((l) => /^\s{2}build:\s*$/.test(l));
    if (bStart < 0) fail("§11e buildspec 找不到 build 段(格式变了就得改这里,不许静默跳过)");
    let bEnd = bsRaw.findIndex((l, i) => i > bStart && /^\s{2}\S/.test(l));
    if (bEnd < 0) bEnd = bsRaw.length;
    const bBody = bsRaw.slice(bStart, bEnd);
    const bBlocks = [];
    for (let i = 0; i < bBody.length; i++) {
      if (!/^\s*-\s*\|\s*$/.test(bBody[i])) continue;
      const indent = bBody[i].search(/\S/) + 2;
      const lines = [];
      for (let j = i + 1; j < bBody.length && (bBody[j].trim() === "" || bBody[j].search(/\S/) >= indent); j++) {
        lines.push(bBody[j].slice(indent));
        i = j;
      }
      bBlocks.push(lines.join("\n"));
    }
    const deployBlock = bBlocks.filter((b) => /cdk deploy/.test(b)).pop();
    if (!deployBlock) fail("§11e build 段里抽不到含 `cdk deploy` 的命令块 —— 抽取逻辑坏了,别当绿");
    else {
      const bdir = mkdtempSync(resolve(tmpdir(), "exec-env-build-"));
      const bbin = resolve(bdir, "bin");
      mkdirSync(bbin);
      // 命令块第一行是 `cd "$CODEBUILD_SRC_DIR/infra"` ⇒ 沙箱里要有这个目录
      // (不把 CODEBUILD_SRC_DIR 指向仓根:那会把 .exec-env-* 写进工作区)
      mkdirSync(resolve(bdir, "infra"));
      const npxLog = resolve(bdir, "npx.argv");
      // npx / node / aws 全部 stub:本节只验 **shell 层**,不真部署
      for (const name of ["npx", "node", "aws"]) {
        writeFileSync(resolve(bbin, name), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${npxLog}"\nexit 0\n`);
        chmodSync(resolve(bbin, name), 0o755);
      }
      writeFileSync(resolve(bdir, "deploy.sh"), deployBlock);
      writeFileSync(resolve(bdir, ".exec-env-azs"), "us-west-2a,us-west-2b");
      const runDeploy = (homelinkContent) => {
        rmSync(npxLog, { force: true });
        const hl = resolve(bdir, ".exec-env-homelink");
        if (homelinkContent === null) rmSync(hl, { force: true });
        else writeFileSync(hl, homelinkContent);
        try {
          execFileSync("bash", [resolve(bdir, "deploy.sh")], {
            env: {
              ...process.env,
              PATH: `${bbin}:${process.env.PATH}`,
              CODEBUILD_SRC_DIR: bdir,
              EXEC_ENV_TARGET: "tgt_usw2_a",
              EXEC_ENV_REGION: "us-west-2",
              EXEC_ENV_ACCOUNT: "123456789012",
              EXEC_ENV_COMPONENTS: "core",
              EXEC_ENV_VPC_CIDR: VPC_CIDR,
              AWS_REGION: HOME_REGION,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60000,
          });
          return { ok: true, argv: existsSync(npxLog) ? readFileSync(npxLog, "utf8") : "" };
        } catch (e) {
          return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || ""), argv: existsSync(npxLog) ? readFileSync(npxLog, "utf8") : "" };
        }
      };
      const wantCtx = [
        `exec-env-vpc-cidr=${VPC_CIDR}`,
        `exec-env-home-vpc-id=${HOME_VPC_ID}`,
        `exec-env-home-vpc-cidr=${HOME_VPC_CIDR}`,
        `exec-env-home-ddb-endpoint-id=${HOME_DDB_ENDPOINT_ID}`,
      ];
      const line = `${HOME_VPC_ID} ${HOME_VPC_CIDR} ${HOME_DDB_ENDPOINT_ID}`;
      for (const [label, content] of [
        ["带行尾换行", `${line}\n`],
        // 🔴 **真环境撞到的那一种**:`printf '%s %s %s'` 不带换行 ⇒ read 返回非 0 ⇒ set -e 杀掉整个 build
        ["不带行尾换行", line],
      ]) {
        const r = runDeploy(content);
        if (!r.ok) {
          fail(`§11e build 段的 cdk deploy 块在「${label}」的 .exec-env-homelink 上**跑不通**:${String(r.out).slice(-300)} ` +
            `—— 真环境会是 phase BUILD FAILED 而日志只有命令原文(2026-09-15 实测)`);
        } else {
          const missing = wantCtx.filter((c) => !r.argv.includes(c));
          if (missing.length) {
            fail(`§11e (${label})cdk deploy 的 argv 里缺 ${missing.join(" / ")} —— ` +
              `实际:${r.argv.slice(0, 400)};缺入参 ⇒ 非 home 在 synth 当场抛,或(更糟)静默建在错的网段上`);
          }
        }
      }
      // 空文件(home / 同区)⇒ 只带 vpc-cidr,不许带 home-link 三件事实
      const rEmpty = runDeploy("");
      if (!rEmpty.ok) fail(`§11e homelink 为空(home / 同区)时 build 段跑不通:${String(rEmpty.out).slice(-300)}`);
      else if (/exec-env-home-vpc-id/.test(rEmpty.argv)) {
        fail(`§11e homelink 为空时竟然还传了 home-link 入参:${rEmpty.argv.slice(0, 300)}`);
      }
      // 内容不完整(只有两段)⇒ 必须 fail-fast,不许带半套入参部署
      const rHalf = runDeploy(`${HOME_VPC_ID} ${HOME_VPC_CIDR}\n`);
      if (rHalf.ok) fail("§11e homelink 只有两段(内容不完整)竟然通过 —— 半套入参会建出「peering 有、回程路由没有」的形态");
      globalThis.__buildPhaseShell = { cases: 4 };
    }
  }

  // ── §11f 🔴🔴 **销毁分支的 shell 真跑**(离线判据)──
  //
  // 【为什么必须真跑】销毁是全平台最危险的动作,而它的承重全在 shell 的**顺序**与**认对象**上:
  //   托管服务没先走 ⇒ base 删 VPC 卡死(N-5);认错对象 ⇒ 删了同区别人的 Flink / Glue;
  //   快照没留住 ⇒ 数仓数据永久丢失;重试时重复建 / 删快照。这些文本判据一条都看不出来(§11e 的教训)。
  // 🔴 判据形状:`aws` 换成**有状态的替身**(node 脚本:按场景回答 + 逐条记账),真跑 scripts/exec-env-destroy.sh,
  //   断言调用序列本身 ——「每一个托管服务删除都在第一次 delete-stack 之前」「delete-stack 的顺序 = destroy-order.ts」
  //   「别人的资源一个都没碰」「从不发删数据 / 删快照的调用」「卡住时点名资源 + 真因且不往下删」「重试不重复建快照」。
  {
    const order = destroyOrderSsot();
    if (order.length < 3) fail(`§11f 删栈顺序只读到 ${order.length} 个后缀 —— destroy-order.ts 读不出来,本节无从判起`);
    const dsrc = readFileSync(resolve(INFRA, "scripts/exec-env-destroy.sh"), "utf8");
    const dcode = dsrc.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    // (0) 负向文本:绝不删数据类资源 / 任何快照(剥注释后查)
    for (const [re, what] of [
      [/delete-snapshot/, "删快照"],
      [/\bs3\s+rb\b/, "删桶(s3 rb)"],
      [/\bs3\s+rm\b/, "删对象(s3 rm)"],
      [/delete-bucket\b/, "删桶"],
      [/delete-objects?\b/, "删对象"],
      [/delete-table-bucket/, "删表桶"],
      [/dynamodb\s+delete-table/, "删 DynamoDB 表"],
      [/schedule-key-deletion|disable-key\b/, "删 / 停 KMS 钥匙"],
      [/update-item|put-item/, "写注册表(buildspec 只许打印报告)"],
    ]) {
      if (re.test(dcode)) fail(`§11f 销毁脚本里出现了「${what}」的调用 —— 数据类资源 RETAIN、快照永不删、注册表只由平台写`);
    }

    // (1) buildspec 的 destroy 块:真跑一遍(npx / 销毁脚本都换成记账替身),钉「顺序从 destroy-order.ts 算出来再传给脚本」
    {
      const raw = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8").split("\n");
      const bStart = raw.findIndex((l) => /^\s{2}build:\s*$/.test(l));
      let bEnd = raw.findIndex((l, i) => i > bStart && /^\s{2}\S/.test(l));
      if (bEnd < 0) bEnd = raw.length;
      const body = raw.slice(bStart, bEnd);
      const blocks = [];
      for (let i = 0; i < body.length; i++) {
        if (!/^\s*-\s*\|\s*$/.test(body[i])) continue;
        const indent = body[i].search(/\S/) + 2;
        const lines = [];
        for (let j = i + 1; j < body.length && (body[j].trim() === "" || body[j].search(/\S/) >= indent); j++) {
          lines.push(body[j].slice(indent));
          i = j;
        }
        blocks.push(lines.join("\n"));
      }
      const di = blocks.findIndex((b) => /exec-env-destroy\.sh/.test(b));
      const deployIdx = blocks.findIndex((b) => /cdk deploy/.test(b));
      if (di < 0) fail("§11f build 段里没有调用 scripts/exec-env-destroy.sh 的命令块 —— destroy 分支没接上");
      else if (!(deployIdx > di)) fail("§11f 销毁块必须排在 cdk deploy 块之前(destroy 跑完 deploy 块才按模式退出)");
      else {
        const sdir = mkdtempSync(resolve(tmpdir(), "exec-env-destroy-bs-"));
        mkdirSync(resolve(sdir, "bin"));
        mkdirSync(resolve(sdir, "infra/scripts"), { recursive: true });
        const log = resolve(sdir, "calls.log");
        writeFileSync(resolve(sdir, "bin/npx"), `#!/bin/bash\nprintf 'npx %s\\n' "$*" >> "${log}"\nif [[ "$*" == *destroy-order* ]]; then printf '%s' "${order.join(" ")}"; fi\nexit 0\n`);
        chmodSync(resolve(sdir, "bin/npx"), 0o755);
        writeFileSync(resolve(sdir, "infra/scripts/exec-env-destroy.sh"), `printf 'destroy-script suffixes=[%s]\\n' "$EXEC_ENV_DESTROY_SUFFIXES" >> "${log}"\n`);
        writeFileSync(resolve(sdir, "block.sh"), blocks[di]);
        writeFileSync(resolve(sdir, "deploy.sh"), blocks[deployIdx]);
        const runBlock = (file, mode) => {
          rmSync(log, { force: true });
          try {
            execFileSync("bash", [resolve(sdir, file)], {
              env: { ...NO_CRED_ENV, PATH: `${resolve(sdir, "bin")}:${process.env.PATH}`, CODEBUILD_SRC_DIR: sdir, EXEC_ENV_MODE: mode, EXEC_ENV_TARGET: "tgt_usw2_a", EXEC_ENV_REGION: "us-west-2", EXEC_ENV_ACCOUNT: "123456789012", EXEC_ENV_COMPONENTS: "core", AWS_REGION: HOME_REGION },
              encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
            });
            return { ok: true, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
          } catch (e) {
            return { ok: false, out: String(e?.stdout || "") + String(e?.stderr || ""), log: existsSync(log) ? readFileSync(log, "utf8") : "" };
          }
        };
        const rd = runBlock("block.sh", "destroy");
        if (!rd.ok) fail(`§11f buildspec 销毁块在 mode=destroy 下跑不通:${String(rd.out).slice(-300)}`);
        else if (!rd.log.includes(`destroy-script suffixes=[${order.join(" ")}]`)) {
          fail(`§11f buildspec 销毁块没把 destroy-order.ts 的顺序原样传给脚本:${rd.log.slice(0, 300)}`);
        }
        const rdep = runBlock("block.sh", "deploy");
        if (!rdep.ok || /destroy-script/.test(rdep.log)) fail("§11f mode=deploy 时销毁块竟然调用了销毁脚本 —— 部署会顺手把环境删了");
        const rdd = runBlock("deploy.sh", "destroy");
        if (!rdd.ok) fail(`§11f deploy 块在 mode=destroy 下没有干净退出:${String(rdd.out).slice(-300)}`);
        else if (/cdk deploy/.test(rdd.log)) fail("§11f mode=destroy 时 deploy 块仍然执行了 cdk deploy —— 刚删完又装回去");
      }
    }

    // (2) 销毁脚本本体:有状态 aws 替身 × 五个场景
    const ddir = mkdtempSync(resolve(tmpdir(), "exec-env-destroy-"));
    mkdirSync(resolve(ddir, "bin"));
    mkdirSync(resolve(ddir, "platform"), { recursive: true });
    copyFileSync(resolve(REPO, "platform/naming.json"), resolve(ddir, "platform/naming.json"));
    const stateFile = resolve(ddir, "state.json");
    const callLog = resolve(ddir, "aws.log");
    writeFileSync(resolve(ddir, "bin/aws"), "#!/usr/bin/env node\n" + DESTROY_AWS_STUB);
    chmodSync(resolve(ddir, "bin/aws"), 0o755);
    const SLUGX = "tgt-usw2-a";
    const STK = (sfx) => `BgpExecEnv-${SLUGX}-${sfx}`;
    const SNAPX = "bgp-final-tgt-usw2-a-20261011-0000";
    const mineRole = (k) => `arn:aws:iam::123456789012:role/BgpExecEnv-${SLUGX}-${k}`;
    const fullState = () => ({
      vpc: "vpc-mine", subnets: ["subnet-a", "subnet-b"],
      flink: { "app-mine": { role: mineRole("flink-role"), status: "RUNNING" }, "app-other": { role: "arn:aws:iam::123456789012:role/someone-else", status: "RUNNING" } },
      workflows: { "arn:aws:airflow-serverless:us-west-2:123456789012:workflow/mine-AbCdEfGhIj": mineRole("airflow-sls-role"), "arn:aws:airflow-serverless:us-west-2:123456789012:workflow/other-AbCdEfGhIj": "arn:aws:iam::123456789012:role/other" },
      glueJobs: { "job-mine": mineRole("glue-role"), "job-other": "arn:aws:iam::123456789012:role/other" },
      glueConns: { "conn-mine": "subnet-a", "conn-other": "subnet-zzz" },
      emr: { "00mine": { subnets: ["subnet-b"], state: "STARTED" }, "00other": { subnets: ["subnet-zzz"], state: "STARTED" } },
      dms: { "arn:aws:dms:us-west-2:123456789012:rep:MINE": { subnetGroup: `bgp-dms-subnet-group-${SLUGX}`, tasks: { "arn:aws:dms:us-west-2:123456789012:task:T1": "running" } }, "arn:aws:dms:us-west-2:123456789012:rep:OTHER": { subnetGroup: "someone-else", tasks: {} } },
      mwaa: { [`bgp-mwaa-${SLUGX}`]: "AVAILABLE" },
      workgroups: { [`bgp-workgroup-${SLUGX}`]: "AVAILABLE" },
      namespaces: { [`bgp-namespace-${SLUGX}`]: "AVAILABLE" },
      snapshots: {},
      stacks: Object.fromEntries(["base", "core", "redshift", "dms", "flink", "airflow-serverless"].map((x) => [STK(x), "CREATE_COMPLETE"])),
      stackFail: {},
      buckets: [`bgp-datalake-123456789012-${SLUGX}`, `bgp-glue-scripts-123456789012-${SLUGX}`],
      tableBuckets: { [`bgp-table-bucket-${SLUGX}`]: "arn:aws:s3tables:us-west-2:123456789012:bucket/x" },
      tables: [], aliases: { [`alias/bgp-data-${SLUGX}`]: "key-1" },
      noFinalSnapshot: false,
    });
    const runDestroy = (state, extraEnv = {}) => {
      writeFileSync(stateFile, JSON.stringify(state));
      rmSync(callLog, { force: true });
      rmSync(resolve(ddir, "exec-env-outputs.json"), { force: true });
      let ok = true;
      let out = "";
      try {
        out = execFileSync("bash", [resolve(INFRA, "scripts/exec-env-destroy.sh")], {
          env: {
            ...NO_CRED_ENV, PATH: `${resolve(ddir, "bin")}:${process.env.PATH}`, CODEBUILD_SRC_DIR: ddir,
            STUB_STATE: stateFile, STUB_LOG: callLog,
            EXEC_ENV_TARGET: "tgt_usw2_a", EXEC_ENV_REGION: "us-west-2", EXEC_ENV_ACCOUNT: "123456789012",
            EXEC_ENV_FINAL_SNAPSHOT: SNAPX, EXEC_ENV_DESTROY_SUFFIXES: order.join(" "),
            EXEC_ENV_DESTROY_POLL_SECONDS: "0", EXEC_ENV_DESTROY_MAX_POLLS: "6",
            ...extraEnv,
          },
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
        });
      } catch (e) {
        ok = false;
        out = String(e?.stdout || "") + String(e?.stderr || "");
      }
      const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").split("\n").filter(Boolean) : [];
      const line = out.split("\n").find((l) => l.startsWith("EXEC_ENV_DESTROY_REPORT "));
      let report = null;
      try { report = line ? JSON.parse(line.slice("EXEC_ENV_DESTROY_REPORT ".length)) : null; } catch { report = null; }
      const after = JSON.parse(readFileSync(stateFile, "utf8"));
      return { ok, out, calls, report, after };
    };
    const idxOf = (calls, re) => calls.findIndex((c) => re.test(c));
    const forbidden = /delete-snapshot|\bs3\s+rb\b|delete-bucket|delete-table-bucket|dynamodb delete-table|schedule-key-deletion/;
    let cases = 0;

    // 场景 A:全量 —— 顺序 / 认对象 / 最终快照 / 保留清单
    {
      const r = runDestroy(fullState());
      cases++;
      if (!r.ok) fail(`§11f 场景 A(全量销毁)失败:${r.out.slice(-500)}`);
      else {
        const firstDel = idxOf(r.calls, /^cloudformation delete-stack/);
        if (firstDel < 0) fail("§11f 场景 A 一次 delete-stack 都没发 —— 栈没删");
        const managed = [
          [/^kinesisanalyticsv2 delete-application .*app-mine/, "Flink 应用"],
          [/^mwaa-serverless delete-workflow .*workflow\/mine-/, "MWAA Serverless 工作流"],
          [/^glue delete-job .*job-mine/, "Glue 作业"],
          [/^glue delete-connection .*conn-mine/, "Glue 连接"],
          [/^emr-serverless delete-application .*00mine/, "EMR Serverless 应用"],
          [/^dms delete-replication-task /, "DMS 复制任务"],
          [/^dms delete-replication-instance .*rep:MINE/, "DMS 复制实例"],
          [/^mwaa delete-environment /, "经典 MWAA 环境"],
          [/^redshift-serverless delete-workgroup /, "Redshift 工作组"],
          [/^redshift-serverless delete-namespace /, "Redshift 命名空间"],
        ];
        for (const [re, what] of managed) {
          const at = idxOf(r.calls, re);
          if (at < 0) fail(`§11f 场景 A 没删 ${what}(本 target 的)`);
          else if (firstDel >= 0 && at > firstDel) fail(`§11f 场景 A:${what} 在第一次 delete-stack 之后才删 —— 托管服务必须先走(N-5)`);
        }
        if (idxOf(r.calls, /^kinesisanalyticsv2 stop-application .*app-mine.*--force/) < 0) fail("§11f 场景 A:Flink 应用删之前没有 force 停");
        if (idxOf(r.calls, /^redshift-serverless delete-workgroup/) > idxOf(r.calls, /^redshift-serverless delete-namespace/)) fail("§11f 场景 A:命名空间必须在工作组之后删");
        const nsDel = r.calls.find((c) => /^redshift-serverless delete-namespace/.test(c)) || "";
        if (!nsDel.includes(`--final-snapshot-name ${SNAPX}`)) fail(`§11f 场景 A:删命名空间没带最终快照(实际:${nsDel})—— 数仓数据会丢`);
        // 认对象:别人的同区资源一个都不碰
        for (const re of [/app-other/, /workflow\/other-/, /job-other/, /conn-other/, /00other/, /rep:OTHER/]) {
          const hit = r.calls.find((c) => /\b(delete|stop)-/.test(c) && re.test(c));
          if (hit) fail(`§11f 场景 A:动了别人的资源:${hit}`);
        }
        // delete-stack 的顺序 = destroy-order.ts(过滤到真实存在的栈)
        const delSeq = r.calls.filter((c) => /^cloudformation delete-stack/.test(c)).map((c) => (c.match(/--stack-name (\S+)/) || [])[1]);
        const wantSeq = order.map(STK).filter((n) => fullState().stacks[n]);
        if (JSON.stringify(delSeq) !== JSON.stringify(wantSeq)) fail(`§11f 场景 A:删栈顺序 ${delSeq.join(" → ")} ≠ destroy-order.ts 的 ${wantSeq.join(" → ")}`);
        const bad = r.calls.find((c) => forbidden.test(c));
        if (bad) fail(`§11f 场景 A 发了删数据 / 删快照的调用:${bad}`);
        if (Object.keys(r.after.stacks).length) fail(`§11f 场景 A 收尾仍有栈:${Object.keys(r.after.stacks).join(", ")}`);
        if (!r.report?.ok) fail(`§11f 场景 A 的报告不是 ok:${JSON.stringify(r.report)?.slice(0, 300)}`);
        const retained = (r.report?.steps || []).filter((x) => x.status === "retained").map((x) => x.resource);
        for (const want of [`redshift-snapshot:${SNAPX}`, `s3:bgp-datalake-123456789012-${SLUGX}`, `s3tables:bgp-table-bucket-${SLUGX}`, `kms:alias/bgp-data-${SLUGX}`]) {
          if (!retained.includes(want)) fail(`§11f 场景 A 的报告没把 ${want} 列为「已保留」(实际:${retained.join(", ")})`);
        }
        if (!existsSync(resolve(ddir, "exec-env-outputs.json"))) fail("§11f 场景 A 没落 exec-env-outputs.json(post_build 打印它)");
      }
    }
    // 场景 B:重试 —— 最终快照已在 ⇒ 删命名空间不再要求新快照;二次全空跑 ⇒ 一条删除都不发
    {
      const st = fullState();
      st.snapshots[SNAPX] = "AVAILABLE";
      const r = runDestroy(st);
      cases++;
      if (!r.ok) fail(`§11f 场景 B(重试)失败:${r.out.slice(-400)}`);
      const nsDel = r.calls.find((c) => /^redshift-serverless delete-namespace/.test(c)) || "";
      if (/--final-snapshot-name/.test(nsDel)) fail(`§11f 场景 B:快照已存在仍要求再拍一份(${nsDel})—— 重试会撞「快照已存在」卡死`);
      const again = runDestroy(r.after);
      cases++;
      if (!again.ok) fail(`§11f 场景 B':全部已删后再跑一次失败(不幂等):${again.out.slice(-300)}`);
      const del = again.calls.filter((c) => /\b(delete|stop)-/.test(c));
      if (del.length) fail(`§11f 场景 B':全部已删后再跑仍发了删除:${del.slice(0, 3).join(" | ")}`);
    }
    // 场景 C:core 栈 DELETE_FAILED ⇒ 退出非 0、报告点名「哪个栈 + 哪个资源 + 真因」、base 不再删
    {
      const st = fullState();
      st.stackFail[STK("core")] = "EmrSg AWS::EC2::SecurityGroup resource sg-123 has a dependent object";
      const r = runDestroy(st);
      cases++;
      if (r.ok) fail("§11f 场景 C:core 删栈失败竟然整体成功 —— 假装删完");
      if (r.report?.stuck?.resource !== `stack:${STK("core")}` || !/dependent object/.test(r.report?.stuck?.detail || "")) {
        fail(`§11f 场景 C:报告没点名卡住的栈与真因:${JSON.stringify(r.report?.stuck)}`);
      }
      if (idxOf(r.calls, new RegExp(`^cloudformation delete-stack .*${STK("base")}`)) >= 0) fail("§11f 场景 C:core 卡住后仍去删 base —— 必须停在第一个卡住的地方");
    }
    // 场景 D:命名空间删了却没留住快照 ⇒ 卡住,且一个栈都不删(数仓数据去向不明时不许往下拆)
    {
      const st = fullState();
      st.noFinalSnapshot = true;
      const r = runDestroy(st);
      cases++;
      if (r.ok) fail("§11f 场景 D:最终快照没留住竟然继续成功 —— 数仓数据丢了也报绿");
      if (!/redshift-snapshot:/.test(r.report?.stuck?.resource || "")) fail(`§11f 场景 D:应卡在最终快照,实际 ${JSON.stringify(r.report?.stuck)}`);
      if (idxOf(r.calls, /^cloudformation delete-stack/) >= 0) fail("§11f 场景 D:快照去向不明时仍在删栈");
    }
    // 场景 E:home 永不可删 —— 一个 aws 调用都不许发
    {
      const r = runDestroy(fullState(), { EXEC_ENV_TARGET: "tgt_home" });
      cases++;
      if (r.ok || r.calls.length) fail(`§11f 场景 E:tgt_home 的销毁没有在第一个 aws 调用之前被拒(调用 ${r.calls.length} 次)`);
    }
    globalThis.__destroyShellCases = cases;
  }

  // ── §11c 两处 synth 的 AZ 入参必须**同源**(不同 ⇒ 预演与部署模板不同 ⇒ 计划指纹必失配)──
  {
    const bs = readFileSync(resolve(INFRA, "buildspec/exec-env-deploy.yml"), "utf8");
    const p0e = readFileSync(resolve(INFRA, "scripts/p0e-gate.mjs"), "utf8");
    if (!/-c "exec-env-azs=/.test(bs)) fail("§11c buildspec 的 cdk deploy 没传 exec-env-azs —— 第二层选的 AZ 白算了");
    if (!/exec-env-azs=\$\{req\("EXEC_ENV_AZS"\)\}|exec-env-azs=\$\{.*EXEC_ENV_AZS/.test(p0e)) {
      fail("§11c p0e-gate 的预演没传 exec-env-azs —— 预演与真部署 synth 出的子网不同,计划指纹必失配");
    }
    if (!/export EXEC_ENV_AZS/.test(bs)) fail("§11c buildspec 没把 EXEC_ENV_AZS export 给 p0e-gate");
    // 段决定 VPC 与所有子网的 CidrBlock ⇒ 两处 synth 必须同口径
    if (!/exec-env-vpc-cidr=\$EXEC_ENV_VPC_CIDR/.test(bs)) {
      fail("§11c buildspec 的 cdk deploy 没传 exec-env-vpc-cidr —— 非 home 会在 synth 抛,或(若哪天默认值回来)静默建在 10.0.0.0/16 上");
    }
    if (!/exec-env-vpc-cidr=\$\{VPC_CIDR\}/.test(p0e)) {
      fail("§11c p0e-gate 的预演没传 exec-env-vpc-cidr —— 预演与真部署 synth 出的 VPC/子网网段不同,计划指纹必失配");
    }
    if (!/EXEC_ENV_VPC_CIDR/.test(bs)) fail("§11c buildspec 没声明 EXEC_ENV_VPC_CIDR(broker 透传的入参必须有占位声明)");
  }

  // ── 孤儿表桶清理(bug #6)的三条件守卫:**必须真跑**,这正是"看起来对、其实删错东西"的高危逻辑 ──
  const deletes = () => (existsSync(okEnv.STUB_DELETE_LOG) ? readFileSync(okEnv.STUB_DELETE_LOG, "utf8") : "");
  const runClean = (over) => {
    if (existsSync(okEnv.STUB_DELETE_LOG)) rmSync(okEnv.STUB_DELETE_LOG, { force: true });
    return { r: run(over), del: deletes() };
  };
  const cleanCases = [
    // ① core 栈在 ⇒ 桶是活资源,**一个 delete 都不许发**(哪怕桶是空的)
    ["core 栈存在时绝不清理", { STUB_CORE_STACK_EXISTS: "1", STUB_TB_ARN: "arn:aws:s3tables:us-west-2:123456789012:bucket/x", STUB_NS_COUNT: "0", STUB_TABLE_COUNT: "0" },
      (c) => c.r.ok && c.del === "" ? null : `应通过且零删除,实际 ok=${c.r.ok} del=${JSON.stringify(c.del)}`],
    // ② 栈不在 + 桶不在 ⇒ 正常放行、零删除
    ["无遗留桶时正常放行", { STUB_CORE_STACK_EXISTS: "0", STUB_TB_ARN: "None" },
      (c) => c.r.ok && c.del === "" ? null : `应通过且零删除,实际 ok=${c.r.ok} del=${JSON.stringify(c.del)}`],
    // ③ 栈不在 + 桶在 + 0 namespace 0 表 ⇒ **删**(这是本功能的正例)
    ["空孤儿桶被清理", { STUB_CORE_STACK_EXISTS: "0", STUB_TB_ARN: "arn:aws:s3tables:us-west-2:123456789012:bucket/x", STUB_NS_COUNT: "0", STUB_TABLE_COUNT: "0" },
      (c) => c.r.ok && /DELETED/.test(c.del) ? null : `应删除并通过,实际 ok=${c.r.ok} del=${JSON.stringify(c.del)}`],
    // ④ 桶里有表 ⇒ **绝不删**且 fail-fast(§12 P0-A:有数据一律不动)
    ["桶里有表 ⇒ 拒且零删除", { STUB_CORE_STACK_EXISTS: "0", STUB_TB_ARN: "arn:aws:s3tables:us-west-2:123456789012:bucket/x", STUB_NS_COUNT: "1", STUB_TABLE_COUNT: "3" },
      (c) => !c.r.ok && c.del === "" && /绝不自动删/.test(c.r.out) ? null : `应拒绝且零删除,实际 ok=${c.r.ok} del=${JSON.stringify(c.del)} out=${String(c.r.out).slice(-200)}`],
    // ⑤ 数量查不到(权限/瞬态)⇒ **绝不删**(不知道有没有数据时,宁可停下)
    ["数量查不到 ⇒ 拒且零删除", { STUB_CORE_STACK_EXISTS: "0", STUB_TB_ARN: "arn:aws:s3tables:us-west-2:123456789012:bucket/x", STUB_NS_COUNT: "unknown", STUB_TABLE_COUNT: "unknown" },
      (c) => !c.r.ok && c.del === "" ? null : `应拒绝且零删除,实际 ok=${c.r.ok} del=${JSON.stringify(c.del)}`],
  ];
  for (const [name, over, judge] of cleanCases) {
    const problem = judge(runClean(over));
    if (problem) fail(`§11 孤儿清理用例「${name}」不成立:${problem}`);
  }

  rmSync(dir, { recursive: true, force: true });
  globalThis.__preBuildCases = (globalThis.__preBuildCases ?? 0) + 1 + negatives.length + cleanCases.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// 12) —— **资源 ARN 的 region 轴**门禁(50 DESIGN §12 bug #7/#8/#10 那一类)
//
// 为什么要这一节:那一类 bug 已经犯过三次,共同形状是「链路每一环都对、只有 IAM 静默拒」,
// 且每次都要一整轮真部署才发现。根治手法是把 region 段收成唯一出口 `regionalStatement()`,
// 并**强制每条语句声明轴 + 写下理由**。本节把这件事变成机械可查:
//   (a) 可执行:真的调 `regionalStatement`,断言两轴产物形状 + 4 条 fail-closed 守卫真的抛;
//   (b) 文本扫描:全 infra/lib 不许再有裸 region 段;每个调用点都有 reason;
//   (c) 🔴 **execution 轴调用点冻结成名单** —— 防"顺手放开一片"(DESIGN §20:现在给 = 授未用之权)。
// ══════════════════════════════════════════════════════════════════════════════
{
  // ── (a) 可执行:两轴产物 + fail-closed 守卫 ──
  // 🔴 driver 里**一个反引号都不许有**:它嵌在本文件的 JS 模板串里,写反引号会当场把模板截断
  //    (本仓已为这个坑炸过多次)。所有 ARN 用字符串拼接。
  const AXIS_DRIVER = [
    'const cdk = require("aws-cdk-lib");',
    'const iam = require("aws-cdk-lib/aws-iam");',
    'const { regionalStatement } = require(' + JSON.stringify(resolve(INFRA, "lib/shared/execution-regions.ts")) + ');',
    'const cases = [];',
    'const t = (name, fn) => { try { cases.push({ name, ok: true, value: fn() }); } catch (e) { cases.push({ name, ok: false, err: String(e.message || e) }); } };',
    'const mkStack = (ctx) => { const app = new cdk.App({ context: ctx || {} }); return new cdk.Stack(app, "S", { env: { account: "123456789012", region: "us-east-1" } }); };',
    'const RES = (r) => ["arn:aws:dynamodb:" + r + ":123456789012:table/bgp-x"];',
    't("home 轴", () => regionalStatement(mkStack(), { axis: "home", reason: "控制面单份,门禁用例", actions: ["dynamodb:GetItem"], resources: RES }).toStatementJson());',
    't("execution 轴(未传 execution-regions)", () => regionalStatement(mkStack(), { axis: "execution", reason: "跨 region 供给,门禁用例", actions: ["dynamodb:GetItem"], resources: RES }).toStatementJson());',
    't("execution 轴(传两个 region)", () => regionalStatement(mkStack({ "execution-regions": "us-west-2" }), { axis: "execution", reason: "跨 region 供给,门禁用例", actions: ["dynamodb:GetItem"], resources: RES }).toStatementJson());',
    't("reason 空", () => regionalStatement(mkStack(), { axis: "home", reason: "", actions: ["a:b"], resources: RES }));',
    't("reason 太短", () => regionalStatement(mkStack(), { axis: "home", reason: "太短", actions: ["a:b"], resources: RES }));',
    't("reason=TODO", () => regionalStatement(mkStack(), { axis: "home", reason: "  TODO  ", actions: ["a:b"], resources: RES }));',
    't("自带 RequestedRegion 条件", () => regionalStatement(mkStack(), { axis: "execution", reason: "跨 region 供给,门禁用例", actions: ["a:b"], resources: RES, conditions: { StringEquals: { "aws:RequestedRegion": "us-east-1" } } }));',
    't("execution 轴 + Deny", () => regionalStatement(mkStack(), { axis: "execution", reason: "跨 region 供给,门禁用例", effect: iam.Effect.DENY, actions: ["a:b"], resources: RES }));',
    't("home 轴 + Deny(允许)", () => regionalStatement(mkStack(), { axis: "home", reason: "硬上限,门禁用例", effect: iam.Effect.DENY, actions: ["a:b"], resources: RES }).toStatementJson());',
    'process.stdout.write(JSON.stringify(cases));',
  ].join("\n");

  const axisDriverPath = resolve(INFRA, "_region_axis_driver.ts");
  let axisCases = [];
  try {
    writeFileSync(axisDriverPath, AXIS_DRIVER, "utf8");
    const out = execFileSync(resolve(INFRA, "node_modules/.bin/ts-node"), ["--transpile-only", "-P", resolve(INFRA, "tsconfig.json"), axisDriverPath], {
      cwd: INFRA, env: NO_CRED_ENV, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    axisCases = JSON.parse(out);
  } catch (e) {
    fail(`§12 region 轴 driver 跑不起来:${String(e?.stderr || e?.message).slice(-400)}`);
  } finally {
    try { rmSync(axisDriverPath, { force: true }); } catch { /* 已不在就算了 */ }
  }
  const byName = Object.fromEntries(axisCases.map((c) => [c.name, c]));
  const expectThrow = ["reason 空", "reason 太短", "reason=TODO", "自带 RequestedRegion 条件", "execution 轴 + Deny"];
  for (const n of expectThrow) {
    const c = byName[n];
    if (!c) fail(`§12 用例「${n}」没跑到`);
    else if (c.ok) fail(`§12 fail-closed 失效:「${n}」应当抛错,实际通过了`);
  }
  const home = byName["home 轴"];
  if (!home?.ok) fail(`§12 home 轴产不出语句:${home?.err}`);
  else {
    if (!JSON.stringify(home.value.Resource).includes("us-east-1")) fail("§12 home 轴的 ARN region 段应是本栈 region");
    if (home.value.Condition) fail("§12 home 轴不许挂区域条件(会与「不跨 region」的声明自相矛盾)");
  }
  const ex1 = byName["execution 轴(未传 execution-regions)"];
  if (!ex1?.ok) fail(`§12 execution 轴产不出语句:${ex1?.err}`);
  else {
    if (!JSON.stringify(ex1.value.Resource).includes(":*:")) fail("§12 execution 轴的 ARN region 段应是 *");
    if (ex1.value.Condition?.StringEquals?.["aws:RequestedRegion"] !== "us-east-1") {
      fail(`§12 execution 轴必须自动挂区域条件(单 region 时为裸串):${JSON.stringify(ex1.value.Condition)}`);
    }
  }
  const ex2 = byName["execution 轴(传两个 region)"];
  if (!ex2?.ok) fail(`§12 execution 轴(多 region)产不出语句:${ex2?.err}`);
  else {
    const got = ex2.value.Condition?.StringEquals?.["aws:RequestedRegion"];
    if (JSON.stringify(got) !== JSON.stringify(["us-east-1", "us-west-2"])) {
      fail(`§12 多 region 时条件应是去重排序后的数组:${JSON.stringify(got)}`);
    }
  }
  const dh = byName["home 轴 + Deny(允许)"];
  if (!dh?.ok) fail(`§12 home 轴的 Deny 语句不该被拒:${dh?.err}`);

  // ── (b)(c) 文本扫描:裸 region 段归零 / 每个调用点有 reason / execution 名单冻结 ──
  const OWNER = "lib/shared/execution-regions.ts";
  // 🔴🔴 **从「枚举拼法」改成「结构判定」**。
  //   旧版把违规写成一张拼法名单:`${region}` / `${this.region}` / `${cdk.Aws.REGION}` / `${props…region}`。
  //   于是同一件事的**第五种拼法** `${cdk.Stack.of(this).region}` 整整 12 处**从来没被门禁看见过**
  //   (flink-stack 7 + platform-stack 5),其中两条正是「条件多区、ARN 单区」的分叉:实时计算的
  //   Kinesis 流与 Flink 日志组在第二个区静默无权(2026-09-19 用 SimulatePrincipalPolicy 坐实)。
  //   这就是记忆 `manifest-gate-coverage-is-the-criterion`:**清单驱动的门禁,覆盖面就是判据本身**。
  //   ⇒ 改成:ARN 的 region 段**只允许**是 `regionalStatement` 的回调参数 `r`;其它任何表达式都算违规,
  //     不管它长什么样。想例外只有一条路:在同一行写 `region-axis-exempt: <理由>`,且**豁免总数冻结**。
  const ARN_REGION_SEG = /arn:aws[\w-]*:[a-z0-9-]+:\$\{([^}]*)\}/g;
  const EXEMPT_MARK = /region-axis-exempt:\s*(\S.*)$/;
  // 冻结:目前只有 1 处豁免 = `EMR_S3TABLES_WAREHOUSE_ARN` 环境变量的缺省值(不是 IAM 语句)。
  const EXEMPT_EXPECTED = 1;
  let exemptSites = [];
  const walkTs = (dir, acc = []) => {
    for (const e of readdirSync(dir)) {
      if (e === "cdk.out" || e === "node_modules" || e === "dist") continue;
      const fp = resolve(dir, e);
      if (statSync(fp).isDirectory()) walkTs(fp, acc);
      else if (e.endsWith(".ts")) acc.push(fp);
    }
    return acc;
  };
  const files = walkTs(resolve(INFRA, "lib"));
  if (files.length < 15) fail(`§12 只扫到 ${files.length} 个 infra/lib 源文件 ⇒ 路径错了,这节等于没跑`);
  let execAxisSites = [];
  let callSites = 0;
  for (const fp of files) {
    const rel = fp.slice(resolve(INFRA).length + 1);
    const lines = readFileSync(fp, "utf8").split("\n");
    lines.forEach((ln, i) => {
      // 只判"活代码":注释行里出现被禁形状是正当的(说明文字),不剥就会把说明当违规
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(ln);
      if (!isComment && rel !== OWNER) {
        ARN_REGION_SEG.lastIndex = 0;
        let m;
        while ((m = ARN_REGION_SEG.exec(ln)) !== null) {
          const expr = (m[1] || "").trim();
          if (expr === "r") continue;                     // regionalStatement 的回调参数 —— 唯一合法形态
          const ex = EXEMPT_MARK.exec(ln);
          if (ex && ex[1].trim().length >= 8) { exemptSites.push(`${rel}:${i + 1}`); continue; }
          fail(
            `§12 ${rel}:${i + 1} 在 ARN 的 region 段手拼了 \`\${${expr}}\` ⇒ 必须走 regionalStatement(轴 + 理由都要写);` +
              `确实不是 IAM 语句时,在同一行写 \`region-axis-exempt: <≥8 字理由>\` 并改 EXEMPT_EXPECTED:${ln.trim().slice(0, 90)}`
          );
        }
      }
      // OWNER 里出现的是**函数定义**,不是调用点(第一版没排除,门禁当场咬到自己)
      if (!isComment && rel !== OWNER && /\bregionalStatement\s*\(/.test(ln)) {
        callSites += 1;
        // 窗口只到**下一个调用点之前**(上限 14 行):固定 14 行会在两条语句之间的注释变短时探进邻居的 axis,
        // 把一条 home 轴语句误计成 execution 轴(2026-11-04 注释清理时真撞)。
        const ahead = lines.slice(i, i + 14);
        const nextCall = ahead.findIndex((l, k) => k > 0 && !/^\s*(\/\/|\*|\/\*)/.test(l) && /\bregionalStatement\s*\(/.test(l));
        const win = (nextCall > 0 ? ahead.slice(0, nextCall) : ahead).join("\n");
        if (!/\breason\s*:/.test(win)) fail(`§12 ${rel}:${i + 1} 的 regionalStatement 调用没写 reason`);
        if (!/\baxis\s*:/.test(win)) fail(`§12 ${rel}:${i + 1} 的 regionalStatement 调用没写 axis`);
        if (/axis\s*:\s*"execution"/.test(win)) execAxisSites.push(`${rel}:${i + 1}`);
      }
    });
  }
  if (callSites < 20) fail(`§12 只扫到 ${callSites} 个 regionalStatement 调用点(预期 ≥20)⇒ 迁移不完整或扫描失效`);
  // 🔴 豁免也要冻结:否则「在那一行加个 region-axis-exempt」就成了绕过本门禁的万能钥匙。
  if (exemptSites.length !== EXEMPT_EXPECTED) {
    fail(
      `§12 region-axis-exempt 豁免点数从 ${EXEMPT_EXPECTED} 变成 ${exemptSites.length}(${exemptSites.join(", ") || "无"})。` +
        `豁免只给**不是 IAM 语句**的地方(如环境变量缺省值);新增必须是显式决定:改本门禁的期望值 + 写清理由。`
    );
  }
  // 🔴 冻结名单:放开一条就必须改这里 + 说明理由,防"顺手放开一片"。
  // 1 → **2**。放开的第二条是 per-project secret 的**读**
  // (`DescribeSecret` / `GetSecretValue`,资源面只有 `bgp/project/*` —— 比第一条的 `bgp/*` 还窄)。
  // 为什么必须放:片① 只放开了写,于是"能给非 home 建 secret、但读不回来"。而读不回来会被
  // `lookupProjectSecretArn` 解释成"没有凭证" ⇒ 过渡窗口内**静默回落共享 admin**(比报错更坏)。
  // 🔴 两条都在 platform-stack、都只针对 per-project 凭证、都没放宽资源面。再加第三条请照此写清理由。
  // 2 → **3**。放开的第三条是**Glue 作业的建/跑/查**
  // (CreateJob/UpdateJob/StartJobRun/GetJobRun/... 资源面仍是 `job/bgp-*`、`connection/bgp-*`,一个字没放宽)。
  // 为什么必须放:用户 2026-09-04 明确要求「三种任务类型(redshift / glue pyspark / emr serverless spark)
  // 都必须在**多个区域**都跑任务、并且全部跑成功」。Glue 作业是 **region 作用域**资源 ——
  // 要在 us-west-2 跑,平台就必须能在 us-west-2 里 CreateJob/StartJobRun;只放 home 的话
  // 非 home 的 Glue 下推在第一步就 AccessDenied(而且那是"绑得上、跑不了"的最难查形态)。
  // 🔴 EMR Serverless 那批**不在这里**:它用的是更早的 `requestedRegionCondition`(条件里已含执行 region)。
  // 3 → **4**。放开的第四条是 **residency-api 片 1 的区域审计 / 结果表写**
  // (PutItem / GetItem / Query / DescribeTable,资源面只有 `bgp-region-audit-*` 与 `bgp-region-results-*`)。
  // 为什么必须放:跨法域 target 的审计全量**必须留在该 target 所在 region**(DESIGN §18 决策 6quinquies ③ / SPEC §3.3);
  // 只放 home 的话 residencyAudit 对每个跨法域操作都写不成 ⇒ 按「写不成即拒」全部拒掉 = 跨法域 target 名存实亡。
  // 4 → **5**。放开的第五条是 **per-target MWAA 的 airflow 动作**(CreateCliToken / CreateWebLoginToken /
  // GetEnvironment / InvokeRestApi,资源面只有 `environment/bgp-mwaa-*` 与 `role/bgp-mwaa-*/Admin`,SSOT kind mwaaEnvName 的 target 模板)。
  // 为什么必须放:用户拍板「每个区域的定时任务都是自己区域的 MWAA 执行的」(DESIGN §18 决策 6sexies)⇒ 解挂 / 下线 / 探活都要在
  // 该 target 所在 region 拿 CLI token;只放 home 的话非 home 的 DAG 永远 paused、探活 `mwaa:environment` 必红 = 组件装了也用不了。
  // +1 = EIP 配额预检(ec2:DescribeAddresses + servicequotas:GetServiceQuota,只读,execution 轴;
//    显式决定:预检必须在**目标 region** 读用量与配额,否则向导只能在部署回滚后才知道配额撞了)
// +3 = MWAA Serverless 控制(workflow 动作 / ListWorkflows / 任务日志读,均 execution 轴;显式决定:workflow 与 run 都建在各执行 region)
// +1 = airflow-serverless:CreateWorkflow **单独一条** on workflow/*(execution 轴)。
//    显式决定:服务在创建时按 workflow/* 评估(名字尚不存在),与其余动作的 bgp* 名字限定不能同条;不放开则两区三引擎的发布全倒在第一步。
//    资源面只有 workflow/*,动作只有 CreateWorkflow;其余动作仍限 workflow/bgp*。配 scripts/iam-simulate-gate.py 部署后离线模拟钉死。
// **−1 = EIP 配额预检移出 execution 轴**(10 → 9)。
//    显式决定:预检的两个只读动作(ec2:DescribeAddresses / servicequotas:GetServiceQuota)必须能打**尚未放行**的 region,
//    否则「部署前先看配额够不够」在唯一需要它的场景(新区首次上线)里恒被自己的区域条件拒(真环境 I-0b 坐实)。
//    它改为无区域条件的普通语句,并由 iam-simulate-gate 的 axis:"any-region" 用**放行集外**的探测 region 钉住。
// 9 → 10。新增的那条 = 零出网探活的 ec2:Describe{RouteTables,NatGateways,VpcEndpoints}
//   (SPEC §3.16-F:路由表 / NAT / 跨区端点都在**执行 region**,只读)。K-7 那条 EIP 预检语句本来不挂条件、不计入本数,
//   已随 EIP 预检一起下线。
// 10 → **11**。新增的那条 = `DataSourceSecretRead`
//   (secretsmanager:DescribeSecret / GetSecretValue,资源面只到 `bgp/datasource/*`)。
//   显式决定的理由:建源的**写**那一半早就是 execution 轴(secret 建在该 target 的 region),
//   而读那一半只有 home 轴的宽只读 + `bgp/project/*` 的窄读 ⇒ 非 home 建源「建得出、读不回」,
//   真环境实测 HTTP 500 `not authorized ... GetSecretValue on ...:us-west-2:...secret:bgp/datasource/<id>`,
//   并在那个区留下一个半截 secret。「能建就必须能读」是这类语句的成对不变式。
// 11 → **13**。新增的两条都是**实时计算在非主控区**必需的,
//   而它们此前是「条件多区、ARN 单区」的分叉 —— 语句上挂着多区派生的 `aws:RequestedRegion`,ARN 的
//   region 段却钉在部署区,于是第二个区静默无权(2026-09-19 SimulatePrincipalPolicy 坐实 us-west-2
//   `kinesis:CreateStream` / `PutRecords` / `logs:CreateLogGroup` 全 implicitDeny,而 us-east-1 allowed):
//   ⑫ **Kinesis 流**(PutRecord(s) / GetRecords / DescribeStream* / ListShards / GetShardIterator /
//      CreateStream / AddTagsToStream on `stream/*`)—— 源流由「数据源」页 provision **按需新建**
//      (平台刻意不建固定流),只放 home ⇒ 第二个区连一条能消费的流都造不出来,实时计算从第一步就废;
//   ⑬ **MSAF 应用日志组**(logs:CreateLogGroup / CreateLogStream / DeleteLogGroup / PutRetentionPolicy /
//      DescribeLogStreams / FilterLogEvents on `/aws/kinesis-analytics/bgp-flink-*`)—— 日志组是**应用所在
//      那个区**的资源;只放 home ⇒ 非 home 的流作业「起来了但看不到日志」,而崩溃循环/位点过期只在日志里。
//   🔴 两条的资源面一个字都没放宽(仍是 stream/* 与 /aws/kinesis-analytics/bgp-flink-*)。
//   🔴 为什么直到今天才发现:**实时计算根本不在「能力 × 区域 × 执行方式」矩阵里** ——
//      矩阵里没有的那一类 = 默认豁免,hook 判据 ⑥ 再严也拦不住清单里没写的东西(立包理由)。
//   🔴 同批还把这一族**整组搬进独立 ManagedPolicy `RealtimeComputeControl`**(TaskRole 内联策略实测
//     10110/10240 字节,已被 CDK 拆出 `TaskRoleOverflowPolicy` —— 那条红在**线上已部署的栈里就存在**,
//     一直没人看见,正是「只跑 --fast 收官」的代价)。搬的同时把原来两条**已带区域条件但没声明轴**的
//     语句(kinesisanalytics 族 / kinesis:ListStreams)也收进 `regionalStatement` ⇒ 13 → **15**。
//     这两条产物与改动前等价(资源都是 `*`、条件同一个派生值),收益是「轴 + 理由」进了代码、可审计。
// ③ 2026-10-10 15 → **16**:`SharedWriterSecretRead` —— 非 home 建模落地的窄权写者 secret
//     建在该 target 所在 region,按名 DescribeSecret 换 ARN + Data API 用 SecretArn 执行要 GetSecretValue;
//     资源面只到 `bgp/shared-writer/*`(比同轴的写语句 `bgp/*` 更窄),region 仍由 requestedRegionCondition 收在已登记执行区内。
// 16 → **17**:`DataSourceReadOnly` 里 S3 外部表的 Glue 目录语句
//   (glue:CreateDatabase / CreateTable / DeleteTable / Get* on catalog · database/bgp_s3_ext · table/bgp_s3_ext/*)从 home 轴改 execution 轴。
//   显式决定的理由:外部表现在建在**数据源所在区**的 Glue 目录(此前一律落主控区目录,主控区 Athena 跨区读桶);
//   只放 home ⇒ 第二区的 S3 源「建外部表」必 AccessDenied。资源面一个字没放宽(仍只限 bgp_s3_ext 库),region 由 requestedRegionCondition 收在已登记执行区内。
const EXEC_AXIS_EXPECTED = 17;
  if (execAxisSites.length !== EXEC_AXIS_EXPECTED) {
    fail(
      `§12 execution 轴调用点数从 ${EXEC_AXIS_EXPECTED} 变成 ${execAxisSites.length}(${execAxisSites.join(", ")})。` +
        `放开跨 region 权限必须是**显式决定**:改本门禁的期望值,并在语句的 reason 里写清哪一批功能需要它。`
    );
  }
  if (!execAxisSites.every((x) => x.startsWith("lib/platform-stack.ts:"))) {
    fail(`§12 execution 轴语句应全在 lib/platform-stack.ts(per-project secret 读/写),实际:${execAxisSites.join(", ")}`);
  }
  globalThis.__regionAxis = { cases: axisCases.length, callSites, exec: execAxisSites.length };
}

// ── §13 IAM 假动作名门禁(exec-env 栈组产物;控制面产物已在 §9 末尾扫过)──────────────────────
scanIamMisnames(OUT, "exec-env 栈组");
if (!FAST && !globalThis.__iamMisnameScan.dirs.includes("控制面")) fail("§13 控制面模板没有被扫到(§9 末尾的调用丢了)");

// ── 收尾 ──────────────────────────────────────────────────────────────────────
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
if (existsSync(LS_OUT)) rmSync(LS_OUT, { recursive: true, force: true });

// ── §:CloudFront origin-facing 前缀列表的**单一作者** ──
// 起因(2026-09-11 全新账号,主控区换区能力检验时抓到):这张「region → pl-xxxx」映射表原来**抄了两份**
//   (`platform-stack.ts` 与 `om-service-stack.ts`),而且两处**失败语义不同**:
//   platform 查不到就 throw(对);om-service 是 `if (id) { addIngressRule }` —— 查不到**静默跳过**
//   ⇒ OM 的 ALB 少一条 CloudFront 入站规则,部署一路绿灯而 OM 页面从 CloudFront 打不开。
// 🔴 判据钉三件:① `pl-` 字面量只许出现在单一作者文件里;② 两个调用点都走那个函数;
//   ③ 不许再出现「取不到就跳过」的形态。
{
  const AUTHOR = "lib/shared/cloudfront-prefix-list.ts";
  const author = readFileSync(resolve(INFRA, AUTHOR), "utf8");
  // 🔴 h(2026-10-09):表已删,改为部署期按名查 ⇒ 单一作者里**不许**再有 pl- 字面量(有 = 又退回写死几个区),
  //   且必须按名字查(describeManagedPrefixLists + 名字过滤)。
  const authorCode = author.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (/pl-[0-9a-f]{8}/.test(authorCode)) fail(`§14 单一作者 ${AUTHOR} 里又出现了 pl- 字面量 —— 写死几个区的表回来了(客户主控区自选会当场炸)`);
  if (!/describeManagedPrefixLists/.test(authorCode) || !/com\.amazonaws\.global\.cloudfront\.origin-facing/.test(authorCode)) {
    fail(`§14 单一作者 ${AUTHOR} 不再按名字在部署期查前缀列表 —— 本区真值从哪来?`);
  }
  for (const f of ["lib/platform-stack.ts", "lib/om-service-stack.ts"]) {
    const src = readFileSync(resolve(INFRA, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    if (/pl-[0-9a-f]{8}/.test(code)) {
      fail(`§14 ${f} 里又出现了 pl- 字面量 —— 前缀列表映射必须只有 ${AUTHOR} 一个作者(两份副本必然漂移)`);
    }
    if (!/cloudfrontOriginFacingPrefixList\(/.test(code)) {
      fail(`§14 ${f} 没有调用 cloudfrontOriginFacingPrefixList() —— 它要么自己又写了一份,要么根本没加入站规则`);
    }
    if (/if\s*\(\s*\w*[Pp]refixList\w*\s*\)/.test(code)) {
      fail(`§14 ${f} 还有「取不到前缀列表就跳过」的形态 —— 那会静默少一条 CloudFront 入站规则(部署绿灯、页面打不开)`);
    }
  }
  // 正向:合成后的 OM 安全组真带那条入站规则(只在全量模式跑,FAST 不 synth OM 栈)
  globalThis.__cfPrefixList = { author: AUTHOR, callSites: 2 };
}

console.log(
  `exec-env synth-gate:context 用例 ${ctxCases.length} 条、broker 入参用例 ${globalThis.__e49Count ?? 0} 条、` +
    `buildspec pre_build 真执行 ${globalThis.__preBuildCases ?? 0} 条(含端点服务×AZ 交集 ${globalThis.__azPreflight2?.cases ?? 0} 条)、` +
    `region 轴用例 ${globalThis.__regionAxis?.cases ?? 0} 条/调用点 ${globalThis.__regionAxis?.callSites ?? 0} 个(execution 轴 ${globalThis.__regionAxis?.exec ?? 0} 条)、` +
    (FAST ? "" : `组件栈正向 ${globalThis.__componentStacks ?? 0} 个、`) +
    `栈 ${stackNames.length} 个(${stackNames.join(", ")})、零凭证、零 context 查找、` +
    `数据类资源全 Retain、名字出自命名 SSOT${FAST ? "" : "、未实现组件已封堵"}、` +
    `IAM 假动作名扫描 ${globalThis.__iamMisnameScan?.statements ?? 0} 条语句 / 命中 ${globalThis.__iamMisnameScan?.hits ?? 0}、` +
    `CloudFront 前缀列表单一作者 ${globalThis.__cfPrefixList?.callSites ?? 0} 个调用点、` +
    `buildspec aws 调用授权覆盖 ${globalThis.__buildspecActions?.needed ?? 0} 个、build 段 shell 真跑 ${globalThis.__buildPhaseShell?.cases ?? 0} 例、` +
    `销毁分支 shell 真跑 ${globalThis.__destroyShellCases ?? 0} 例、planDestroyOpen 向量 ${globalThis.__planDestroyOpenVectors ?? 0} 条` +
    (FAST ? "" : `、删栈顺序核对 ${globalThis.__destroyOrder ?? 0} 个栈`)
);
// 🔴 「本节没跑」不许当绿(段中断 ≠ 判据过,记忆 gate-must-separate-crash-from-fail)
if ((globalThis.__destroyShellCases ?? 0) < 6) fail(`§11f 销毁分支 shell 只真跑了 ${globalThis.__destroyShellCases ?? 0} 例(<6)—— 那一节没跑完`);
if (!FAST && (globalThis.__destroyOrder ?? 0) < 8) fail(`§7d 删栈顺序只核对了 ${globalThis.__destroyOrder ?? 0} 个栈(<8)—— 全组件 synth 那一节没跑到`);
if (FAST) console.log("⚡ fast 模式:已跳过 §7(负向组件 synth)与 §9(控制面/部署权隔离)—— 提交前必须跑一次全量!");
if (problems.length > 0) {
  console.error(`\n❌ synth-gate FAIL —— ${problems.length} 处:\n` + problems.map((p) => "  - " + p).join("\n"));
  process.exit(1);
}
console.log("✅ 全部通过");
