// 多 region 直查的**接线门禁**(50 INTERACTION §4septies)。
//
// 提交层的行为已由 `multi-region-query.test.ts` 真跑覆盖;这里防的是另一类事:
// **接线被顺手改回单区而全绿**。三处最危险:
//   ① 取结果/取消用了 **home 的客户端** ⇒ 非 home 的 statementId 永远查不到、sheet 卡在「执行中」;
//   ② 取消的 region 由**客户端**指定 ⇒ 拿 home 客户端 cancel 非 home 的语句会静默无效
//      (界面显示"已取消"、那个区还在跑还在计费,比报错更坏);
//   ③ 前端退回**一个全局 loading** ⇒ 又变成"等所有区都回来才展示",正是用户明确否掉的形态。
//
// 🔴 **先剥注释**(同一教训第 9 次):本批注释里就写着被禁的标识符
// (如「拿 home 的客户端去 Describe」),不剥会咬自己的注释。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

const stripComments = (raw: string) =>
  raw
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*|#)/.test(l))
    .join("\n");

const read = (rel: string) => stripComments(readFileSync(resolve(SRC, rel), "utf8"));

describe("🔴 提交端点:只经唯一作者扇出,自己不建客户端", () => {
  const REL = "app/api/redshift/execute/route.ts";
  it("走 submitToTargets;且**自己不 new RedshiftDataClient**(那样所有区都会打到 home)", () => {
    const src = read(REL);
    expect(src).toContain("submitToTargets(");
    expect(src, "端点自己建了客户端 ⇒ region 固定成 home,多区形同虚设").not.toContain("new RedshiftDataClient");
    expect(src, "没归一 targets ⇒ 存量调用方(不传 targets)行为会变").toContain("normalizeQueryTargets(");
  });

  it("🔴 多区时**不把界面填的 workgroup/database 传下去**(否则非 home 全被判落点冲突)", () => {
    const src = read(REL);
    expect(src).toMatch(/workgroupOverride:\s*targets\.length === 1 && targets\[0\] === "tgt_home"/);
    expect(src).toMatch(/databaseOverride:\s*targets\.length === 1 && targets\[0\] === "tgt_home"/);
  });

  it("仍保留顶层 statementId/handleId(存量前端读的就是这两个字段)", () => {
    const src = read(REL);
    expect(src).toMatch(/statementId:\s*first\?\.statementId/);
    expect(src).toMatch(/handleId:\s*first\?\.handleId/);
  });
});

describe("🔴🔴 取结果 / 取消:必须用**提交时那个 region** 的客户端", () => {
  it("取结果:句柄优先解析 region,并用 redshiftDataClientFor", () => {
    const src = read("app/api/redshift/result/[id]/route.ts");
    expect(src).toContain("redshiftDataClientFor(");
    expect(src).toContain("regionOfTarget(");
    // 🔴 句柄优先(不可被客户端操纵);显式参数只是状态轮询的回落
    expect(src, "没把句柄放在显式参数之前 ⇒ region 可被客户端操纵").toMatch(
      /const fromHandle = await peekHandleTargetId\([\s\S]{0,200}?const targetId = fromHandle \|\| requestedTargetId\(req\.nextUrl\.searchParams\.get\("targetId"\)/
    );
    // 🔴 负向:两样都没有 / 目标不存在时**不许回落主控区客户端**
    expect(src, "仍回落主控区客户端 ⇒ 漏传时到主控区去查别的区的语句").not.toMatch(/homeRegion\(/);
    // 🔴 负向:Describe 不许用模块级(home)客户端
    expect(src, "仍用模块级 home 客户端 Describe ⇒ 非 home 的 statementId 永远查不到、sheet 卡住").not.toMatch(
      /^const client = new RedshiftDataClient/m
    );
    // 🔴 **Describe 真的用的是那个按 region 解出来的客户端**(只断"helper 存在"挡不住
    //    有人把 Describe 改回 home 客户端 —— helper 还在、门禁却全绿)。
    expect(src, "Describe 没用按 region 解出来的客户端").toMatch(
      /client = await clientForStatement\(req\);[\s\S]{0,400}?DescribeStatementCommand/
    );
    // 归类由服务端做(前端只显示)
    expect(src).toContain("classifyEngineError(");
  });

  it("取消:region 取自**句柄**里的 targetId,不取请求体/查询串", () => {
    const src = read("app/api/redshift/cancel/route.ts");
    expect(src).toMatch(/regionOfTarget\(chk\.handle\?\.targetId/);
    expect(src, "仍用模块级 home 客户端 cancel ⇒ 取消非 home 的语句会静默无效(界面说已取消、那边还在跑)").not.toMatch(
      /^const client = new RedshiftDataClient/m
    );
    // 🔴 负向:region/targetId 不许来自客户端输入
    expect(src, "region 来自客户端输入 ⇒ 可被指定成 home 从而让取消静默失效").not.toMatch(
      /regionOfTarget\(\s*(body|req\.nextUrl|searchParams)/
    );
    // 🔴 「语句已结束」不是平台故障,必须 409 不是 500
    // (与 W3a-9 同一类错误分类;真环境验收 W3c1-9 抓到过 500)。
    expect(src, "取消一条已结束的语句报 500 ⇒ 把人引去查平台健康,而真相是它已经跑完了").toContain(
      "该语句已结束"
    );
    expect(src, "判据靠匹配 AWS 错误文案 ⇒ SDK 一改措辞就静默错分类;必须再 Describe 一次取权威状态").toContain(
      "new DescribeStatementCommand"
    );
  });
});

describe("🔴🔴 前端:每个 sheet 独立生命周期(用户明确否掉「等所有区再展示」)", () => {
  const REL = "components/redshift/MultiRegionResults.tsx";
  it("逐 sheet 各自轮询,没有跨 sheet 的全局 loading 闸", () => {
    const src = read(REL);
    // 判据拆成三条,不依赖"两个 token 隔多远"(窗口太紧会假红,这条第一版就是这么红的)
    expect(src, "没有按 submissions 逐个建轮询链 ⇒ 退回「等所有区」").toMatch(/for \(const s of submissions\)/);
    expect(src, "轮询函数不在循环体内 ⇒ 只有一条链").toMatch(/const poll = async \(\) => \{/);
    expect(src, "建了轮询函数却没启动").toMatch(/^\s*poll\(\);\s*$/m);
    // 提交阶段就失败的 sheet 不进入轮询
    expect(src).toMatch(/if \(!s\.statementId\) continue/);
  });

  it("🔴 焦点只抢一次(否则慢区回来会把用户正在读的表切走)", () => {
    const src = read(REL);
    expect(src).toContain("focusTakenRef");
    expect(src, "抢焦点没有一次性开关 ⇒ 每个区回来都抢一次").toMatch(
      /if \(!focusTakenRef\.current\)[\s\S]{0,120}?focusTakenRef\.current = true/
    );
  });

  it("🔴 超时是独立态,不并进失败(写成失败会让人以为 SQL 有问题)", () => {
    const src = read(REL);
    expect(src).toMatch(/phase: "timeout"/);
    expect(src, "超时没给〔继续等〕⇒ 用户只能重跑(再花一次钱)").toContain("继续等");
    expect(src, "超时没给〔取消该区〕⇒ 只能整页放弃").toContain("取消该区");
  });

  it("🔴 列签名不一致**只在全部终态后**判(中途判必误报)", () => {
    const src = read(REL);
    expect(src).toMatch(/if \(!allTerminal\) return new Set<string>\(\)/);
  });

  it("🔴 合并按钮:只在全部终态且列签名一致时可用;**不再**按法域禁用(不设法务门,合并对跨法域可用)", () => {
    const src = read(REL);
    expect(src).toMatch(/disabled=\{!allTerminal \|\| signatureMismatch\.size > 0\}/);
    expect(src, "合并按钮又按法域禁用了 ⇒ 法务门残留").not.toMatch(/crossJur/);
    // 🔴 负向:绝不许出现"自动合并"(不点按钮就把各区结果拼起来)
    expect(src, "在渲染路径上自动合并了各区结果 ⇒ 跨法域时就是数据出境").not.toMatch(
      /useMemo\([\s\S]{0,200}?submissions\.flatMap\(/
    );
  });

  it("错误就地三段:原文 + 归类建议 + 该区落点(且落点只给身份形态)", () => {
    const src = read(REL);
    expect(src, "没展示原始错误").toMatch(/\{st\.error\}/);
    expect(src, "没展示归类建议").toMatch(/\{st\.errorHint\}/);
    expect(src, "没展示该区落点 ⇒ 多区域排障第一个问题「我到底打到哪了」答不了").toMatch(
      /\{s\.region\}[\s\S]{0,200}?\{s\.workgroup\}[\s\S]{0,200}?\{s\.database\}/
    );
    expect(src, "把凭证标识渲染到界面上了").not.toMatch(/secretArn/);
  });
});

describe("🔴 直查页:多选可见 + 多区时落点置灰 + 按钮写清区数", () => {
  const REL = "app/redshift/page.tsx";
  it("执行区域是**多选**,且有可见标签与「全选当前活跃区」", () => {
    const src = read(REL);
    expect(src).toContain('mode="multiple"');
    expect(src, "多选没有可见标签 ⇒ 只勾一个值时长得跟单选一样(离线计算页刚被这条咬过)").toContain("执行区域(可多选)");
    expect(src).toContain("全选当前活跃区");
  });

  it("🔴 多区时 workgroup/database 置灰(落点只能来自各目标描述符)", () => {
    const src = read(REL);
    expect(src).toMatch(/disabled=\{multiRegion\}/);
    expect(src).toMatch(/const multiRegion = targets\.length > 1 \|\| targets\.some\(/);
  });

  it("🔴 按钮写清会打几个区(N 个区 = N 份扫描与计费)", () => {
    const src = read(REL);
    expect(src).toMatch(/targets\.length > 1 \? t\("执行\(\{n\} 个区\)"/);
  });

  it("结果区交给多 sheet 组件,页面自己不再拼单份结果表", () => {
    const src = read(REL);
    expect(src).toContain("<MultiRegionResults");
    // 🔴 负向:旧的单份结果渲染必须删干净(留着会与组件并存、显示两套结果)
    expect(src, "还留着旧的单份结果表 ⇒ 与多 sheet 并存,用户看到两套结果").not.toMatch(/result\.columns\?\./);
    expect(src, "还留着 dead 的 result 状态").not.toMatch(/setResult\(/);
  });

  it("执行历史带「执行区域」列(一条 SQL 打多区会有多条历史)", () => {
    const src = read(REL);
    expect(src).toMatch(/dataIndex: "targetId"/);
  });
});
