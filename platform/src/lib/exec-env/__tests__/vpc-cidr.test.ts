// @kf-batch 50-WP23-xregion-peering
// 执行环境 VPC 地址段(50 SPEC §3.14ter)的门禁。
//
// 【为什么这一批判据存在 —— 一个「前提被悄悄换掉」的真缺陷】
//   跨区私网通路定案成 peering,而 **peering 要求两侧 CIDR 不重叠**;真环境里
//   home VPC 与执行环境 VPC 都吃 CDK 默认 `10.0.0.0/16` ⇒ 那条路**物理上建不出来**。
//   2026-09-14 换选型时我只重勘了组织 SCP,没重勘 CIDR:一次性 probe 用的是两个 throwaway VPC
//   (10.90/10.91)⇒ probe 坐实的是「这条路通」,不是「我们的底座能走这条路」。
//   ⇒ 这里既钉**分配逻辑**,也钉**接线**(谁把段传到 CDK)、还钉**池子与 home 不相交**这个前提本身。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXEC_ENV_VPC_CIDR_POOL, EXEC_ENV_VPC_CIDR_FIRST_OCTET, EXEC_ENV_VPC_CIDR_SLOTS, EXEC_ENV_VPC_CIDR_RE,
  ExecEnvCidrPoolExhausted, allocateExecEnvVpcCidr, execEnvVpcCidrForSlot, execEnvVpcCidrSlotOf, isExecEnvVpcCidr,
} from "@/lib/exec-env/vpc-cidr";

const REPO = resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
/** 🔴 负向文本断言前必须剥注释 —— 本批的注释里就写着 `10.0.0.0/16`(讲的正是为什么不能用它)。 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1 ")
    .replace(/^\s*#.*$/gm, " ");

/** home VPC 的 CIDR:`infra/lib/vpc-stack.ts` 不给 `ipAddresses` ⇒ 就是 CDK 的默认值。 */
const HOME_VPC_CIDR = "10.0.0.0/16";

describe("🔴 地址池与 home 在**构造上**不相交(不是运行期查一下)", () => {
  it("池子拒收 home 那一段,也拒收任何 10.0.x", () => {
    expect(isExecEnvVpcCidr(HOME_VPC_CIDR), "池子必须收不下 home 的段").toBe(false);
    expect(isExecEnvVpcCidr("10.0.1.0/16")).toBe(false);
    expect(isExecEnvVpcCidr("10.127.0.0/16"), "池子下界之外").toBe(false);
    expect(isExecEnvVpcCidr("10.128.0.0/16"), "池子第一个").toBe(true);
    expect(isExecEnvVpcCidr("10.255.0.0/16"), "池子最后一个").toBe(true);
    expect(isExecEnvVpcCidr("11.128.0.0/16"), "第一段必须是 10").toBe(false);
  });

  it("🔴 只收 /16(换掩码宽度 ⇒ 所有子网 CidrBlock 变化 ⇒ 子网被替换,N0-10 禁止)", () => {
    expect(isExecEnvVpcCidr("10.128.0.0/20")).toBe(false);
    expect(isExecEnvVpcCidr("10.128.0.0/8")).toBe(false);
    expect(isExecEnvVpcCidr("10.128.1.0/16"), "第三/四段必须是 0(/16 的网络地址)").toBe(false);
  });

  it("🔴🔴 home VPC 必须**仍然**是 CDK 默认段 —— 谁给它显式换段就必须回来看这条", () => {
    const vs = strip(read("infra/lib/vpc-stack.ts"));
    // 给 BgpVpc 显式指定网段 = 前提变了:若换到 10.128–10.255 之间就会与池子重叠,
    // 而症状是「某个执行环境的 peering 建不出来 / 建出来路由撞车」,离这行改动极远。
    expect(vs, "vpc-stack.ts 出现 ipAddresses ⇒ home 的网段被显式指定了,必须复核它与地址池是否相交").not.toContain("ipAddresses");
    // 反向控制:确认我们**真的**在看那个 VPC(不是文件路径写错了在断一个空串)
    expect(vs).toContain('new ec2.Vpc(this, "BgpVpc"');
  });

  it("infra 侧登记的 home 存量段与这里的常量一致(它刻意在池外)", () => {
    const infra = read("infra/lib/exec-env/vpc-cidr.ts");
    expect(infra).toContain(`export const HOME_EXEC_ENV_VPC_CIDR = "${HOME_VPC_CIDR}";`);
    expect(EXEC_ENV_VPC_CIDR_RE.test(HOME_VPC_CIDR)).toBe(false);
  });
});

describe("分配:最小空闲槽位 + 池外值忽略 + 耗尽要说人话", () => {
  it("空清单 ⇒ 池子第一个", () => {
    expect(allocateExecEnvVpcCidr([])).toBe("10.128.0.0/16");
  });

  it("已用的跳过(乱序也行),取**最小**空闲槽位", () => {
    expect(allocateExecEnvVpcCidr(["10.129.0.0/16", "10.128.0.0/16"])).toBe("10.130.0.0/16");
    // 中间有洞 ⇒ 填洞(不是一直往后长:删掉环境后地址要能被回收)
    expect(allocateExecEnvVpcCidr(["10.128.0.0/16", "10.130.0.0/16"])).toBe("10.129.0.0/16");
  });

  it("池外/畸形/缺失值一律忽略(存量描述符没有这个字段,home 也没有)", () => {
    expect(allocateExecEnvVpcCidr([undefined, null, "", "10.0.0.0/16", "nonsense", 42, { a: 1 }])).toBe("10.128.0.0/16");
  });

  it("🔴 用满 ⇒ ExecEnvCidrPoolExhausted,且**不许**引导去重试(确定性耗尽)", () => {
    const all = Array.from({ length: EXEC_ENV_VPC_CIDR_SLOTS }, (_, i) => execEnvVpcCidrForSlot(i));
    let err: unknown;
    try {
      allocateExecEnvVpcCidr(all);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExecEnvCidrPoolExhausted);
    const msg = (err as Error).message;
    expect(msg).toContain(EXEC_ENV_VPC_CIDR_POOL);
    expect(msg).toMatch(/删除/);
    expect(msg, "确定性耗尽绝不能说「稍后重试」").not.toMatch(/稍后重试/);
    // 判别力:少一个就不该抛(否则上面那条用任何清单都能通过)
    expect(() => allocateExecEnvVpcCidr(all.slice(1))).not.toThrow();
  });

  it("槽位 ↔ CIDR 往返;越界即抛", () => {
    expect(execEnvVpcCidrForSlot(0)).toBe(`10.${EXEC_ENV_VPC_CIDR_FIRST_OCTET}.0.0/16`);
    for (const slot of [0, 1, 63, EXEC_ENV_VPC_CIDR_SLOTS - 1]) {
      expect(execEnvVpcCidrSlotOf(execEnvVpcCidrForSlot(slot))).toBe(slot);
    }
    expect(() => execEnvVpcCidrForSlot(EXEC_ENV_VPC_CIDR_SLOTS)).toThrow(/越界/);
    expect(() => execEnvVpcCidrForSlot(-1)).toThrow(/越界/);
    expect(execEnvVpcCidrSlotOf("10.0.0.0/16"), "池外 ⇒ null,不抛").toBeNull();
  });
});

describe("🔴 两侧 parity(平台跨不过构建边界 import infra ⇒ 只能两份 + 门禁)", () => {
  const infra = read("infra/lib/exec-env/vpc-cidr.ts");
  it("池子 / 首段 / 槽位数 / 正则四项逐字一致", () => {
    expect(infra).toContain(`export const EXEC_ENV_VPC_CIDR_POOL = "${EXEC_ENV_VPC_CIDR_POOL}";`);
    expect(infra).toContain(`export const EXEC_ENV_VPC_CIDR_FIRST_OCTET = ${EXEC_ENV_VPC_CIDR_FIRST_OCTET};`);
    expect(infra).toContain(`export const EXEC_ENV_VPC_CIDR_SLOTS = ${EXEC_ENV_VPC_CIDR_SLOTS};`);
    const m = /export const EXEC_ENV_VPC_CIDR_RE = (\/.*\/);/.exec(infra);
    expect(m, "infra 侧找不到正则 ⇒ 形状变了").not.toBeNull();
    expect(m![1]).toBe(String(EXEC_ENV_VPC_CIDR_RE));
  });
  it("infra 侧的正则**真的**判得动(不是抄了个字符串)", () => {
    const m = /export const EXEC_ENV_VPC_CIDR_RE = (\/.*\/);/.exec(infra)!;
    // eslint-disable-next-line security/detect-non-literal-regexp
    const re = new RegExp(m![1].slice(1, -1));
    expect(re.test("10.128.0.0/16")).toBe(true);
    expect(re.test(HOME_VPC_CIDR)).toBe(false);
  });
});

describe("🔴🔴 接线:谁把段传到 CDK(「写了 ≠ 接上了」的高发处)", () => {
  it("context.ts:`vpcCidr` **必填**,非 home 缺就抛,home 走存量常量", () => {
    const ctx = read("infra/lib/exec-env/context.ts");
    expect(ctx, "必填(不是 vpcCidr?:)").toMatch(/\n  vpcCidr: string;/);
    expect(ctx).toContain('parseExecEnvVpcCidr(rawVpcCidr, "-c exec-env-vpc-cidr")');
    expect(ctx).toContain("HOME_EXEC_ENV_VPC_CIDR");
    // 🔴 返回值里必须真的带上它 —— 少这一处,栈组拿到的是 undefined 而 tsc 照样绿(interface 是结构类型)
    expect(strip(ctx)).toMatch(/return \{[^}]*vpcCidr,/);
  });

  it("base-stack.ts:VPC 用 `ctx.vpcCidr` 建,且不再有「不给 ipAddresses」的写法", () => {
    const base = read("infra/lib/exec-env/base-stack.ts");
    expect(base).toContain("ipAddresses: ec2.IpAddresses.cidr(ctx.vpcCidr)");
    // 反向:同一个 Vpc 构造块里必须有 ipAddresses(漏了就静默回到 10.0.0.0/16)
    const i = base.indexOf('new ec2.Vpc(this, "ExecEnvVpc"');
    expect(i, "找不到 ExecEnvVpc ⇒ 形状变了,请同步本门禁").toBeGreaterThan(-1);
    const block = base.slice(i, base.indexOf("});", i));
    expect(block).toContain("ipAddresses");
    // 段本身要能被看见(描述符 / 探活 / 判据都读它)
    expect(base).toContain('new cdk.CfnOutput(this, "vpcCidr"');
  });

  it("broker:透传 EXEC_ENV_VPC_CIDR,且缺段的存量描述符**起 build 之前**就拒", () => {
    const idx = read("infra/lambda/exec-env-broker/index.mjs");
    expect(idx).toContain('{ name: "EXEC_ENV_VPC_CIDR", value: target.vpcCidr ?? "", type: "PLAINTEXT" }');
    expect(idx).toContain("vpcCidrRejection(target)");
    // 🔴 必须拦在 startBuild **之前**(拦在后面 = 资源已经开始建了)
    const iCheck = idx.indexOf("vpcCidrRejection(target)");
    const iBuild = idx.indexOf("await startBuild(");
    expect(iCheck).toBeGreaterThan(-1);
    expect(iBuild).toBeGreaterThan(iCheck);
    // 🔴 值**只从描述符读**,不接客户端入参(白名单里没有它)
    expect(idx, "不许从 req 取段").not.toContain("req.vpcCidr");
  });

  it("buildspec:声明 + 非 home fail-fast + 存量 VPC 的 CIDR 不许被换 + 传 -c", () => {
    const bs = read("infra/buildspec/exec-env-deploy.yml");
    expect(bs).toContain("EXEC_ENV_VPC_CIDR:");
    expect(bs).toContain('if [ "$EXEC_ENV_TARGET" != "tgt_home" ] && [ -z "${EXEC_ENV_VPC_CIDR:-}" ]; then');
    expect(bs).toContain('exec-env-vpc-cidr=$EXEC_ENV_VPC_CIDR');
    // 存量守卫:读现网 VPC 的 CidrBlock 并比对(不一致就停,不自动改)
    expect(bs).toContain("aws ec2 describe-vpcs");
    expect(bs).toMatch(/CUR_CIDR[\s\S]{0,400}!= "\$EXEC_ENV_VPC_CIDR"/);
  });

  it("🔴 p0e 预演与真部署必须同口径(段不同 ⇒ synth 出的子网不同 ⇒ 计划指纹必失配)", () => {
    const gate = read("infra/scripts/p0e-gate.mjs");
    expect(gate).toContain("EXEC_ENV_VPC_CIDR");
    expect(gate).toContain("exec-env-vpc-cidr=${VPC_CIDR}");
  });
});

describe("🔴 数据源安全组放行段:不许再写死主控区网段", () => {
  const ds = read("platform/src/lib/aws/datasource-service.ts");
  it("放行段不许是**字面量**(拒因文案里出现 10.0.0.0/16 是允许的 —— 它在解释为什么不能用)", () => {
    const code = strip(ds);
    // 反向控制:确认剥注释没把整段代码剥掉(否则这条恒真)
    expect(code).toContain("AuthorizeSecurityGroupIngressCommand");
    // 🔴 判据钉的是**性质**:`CidrIp` 后面不许直接跟字符串字面量。
    //    第一版写成「全文不许出现 10.0.0.0/16」⇒ 被我自己**拒因文案里的那一处**判红:
    //    那不是缺陷(正是在讲为什么不能回落),说明那条判据在断错的东西。
    expect(code, "写死网段 ⇒ 在别的区一条也放行不到(建得出来、浏览表 0 张)").not.toMatch(/CidrIp:\s*["'`]/);
  });
  it("改成读**该 VPC 自己的** CIDR,读不到就抛(不回落)", () => {
    expect(ds).toContain("DescribeVpcsCommand");
    expect(ds).toMatch(/IpRanges: \[\{ CidrIp: vpcCidr \}\]/);
    expect(ds).toMatch(/if \(!vpcCidr\) \{[\s\S]{0,400}throw new Error\(/);
  });
  it("新增的 AWS 调用进了 IAM 清单(清单驱动的门禁,覆盖面就是判据本身)", () => {
    const manifest = JSON.parse(read("infra/iam/platform-taskrole-calls.json")) as {
      calls: Array<{ action: string; axis: string; source: string }>;
    };
    const hit = manifest.calls.find((c) => c.action === "ec2:DescribeVpcs");
    expect(hit, "ec2:DescribeVpcs 没进清单 ⇒ 非 home 建源会 AccessDenied").toBeTruthy();
    expect(hit!.axis, "资源在执行 region").toBe("execution");
    expect(hit!.source).toContain("datasource-service.ts");
  });
});

describe("🔴 broker 的拒绝是**行为**级的(不是读文本)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  async function loadValidate() {
    // validate.mjs 加载即校验组件枚举(它刻意不接受手抄名单)⇒ 先注入,再 import
    process.env.EXEC_ENV_COMPONENT_ENUM = "core,redshift,kafka,mwaa,dms,flink,agentcore,residency-api,airflow-serverless";
    return (await import(resolve(REPO, "infra/lambda/exec-env-broker/validate.mjs"))) as {
      vpcCidrRejection: (t: unknown) => string | null;
    };
  }

  it("非 home 缺段 ⇒ 拒,且拒因说清「重新注册」而不是「重试」", async () => {
    const { vpcCidrRejection } = await loadValidate();
    const msg = vpcCidrRejection({ targetId: "tgt_usw2_a" });
    expect(msg).toBeTruthy();
    expect(msg!).toContain("tgt_usw2_a");
    expect(msg!).toMatch(/重新注册/);
    expect(msg!, "这不是瞬态失败").toMatch(/不要重试/);
  });

  it("有段 ⇒ 放行;home ⇒ 放行(它不与自己 peering)", async () => {
    const { vpcCidrRejection } = await loadValidate();
    expect(vpcCidrRejection({ targetId: "tgt_usw2_a", vpcCidr: "10.128.0.0/16" })).toBeNull();
    expect(vpcCidrRejection({ targetId: "tgt_home", isHome: true })).toBeNull();
  });

  it("🔴 fail-closed 方向:缺 isHome 标记的非 home 照样要求有段", async () => {
    const { vpcCidrRejection } = await loadValidate();
    expect(vpcCidrRejection({ targetId: "tgt_use1_b" })).toBeTruthy();
    expect(vpcCidrRejection({ targetId: "tgt_use1_b", isHome: false })).toBeTruthy();
    // 空串 / 空白不算有
    expect(vpcCidrRejection({ targetId: "tgt_use1_b", vpcCidr: "" })).toBeTruthy();
    expect(vpcCidrRejection({ targetId: "tgt_use1_b", vpcCidr: "   " })).toBeTruthy();
  });
});
