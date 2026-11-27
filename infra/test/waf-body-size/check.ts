// 平台边缘「请求体大小」规则的离线判据(CDK assertions,不碰 AWS):在合成出来的模板上判,不在源码文本上判。
//   ① 托管通用规则集里按大小拦的那一条被改成只计数(其余规则没有被动);
//   ② 新规则按「标签 + 路径」拦:页面 / 静态资源、登录前公开接口、内部回环接口带着大请求体 ⇒ 拦;登录后的应用接口 ⇒ 不拦;
//      没有标签(请求体没超 8KB)的请求一律不受这条规则影响 —— 用一个小求值器把模板里的语句树在样例请求上真算一遍;
//   ③ 优先级:整条放行的在最前,带标签拦的排在托管通用规则集之后(标签才看得到),全表不撞号;
//   ④ OpenMetadata 那张 ACL 没有被这次改动带上大小规则。
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  WafStack,
  LARGE_BODY_ROUTES,
  LARGE_BODY_PRIORITY_RESERVED,
  SIZE_RESTRICTION_BODY_RULE,
  OVERSIZE_BODY_LABEL,
  OVERSIZE_BODY_BLOCK_PRIORITY,
} from "../../lib/waf-stack";

const fails: string[] = [];
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`  ✗  ${name}: ${String((e as Error).message).split("\n")[0].slice(0, 400)}`);
  }
};
const must = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
/** 与键的先后无关的比较:模板里对象的键序由合成器定,不是要判的事实。 */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

const app = new cdk.App();
const waf = new WafStack(app, "Waf", { env: { account: "123456789012", region: "us-east-1" } });
const acls = Object.values(Template.fromStack(waf).findResources("AWS::WAFv2::WebACL")) as any[];
const platformAcl = acls.find((a) => a.Properties.Name === "bgp-platform-waf");
const omAcl = acls.find((a) => a.Properties.Name === "bgp-openmetadata-waf");
const rules: any[] = platformAcl?.Properties?.Rules ?? [];
const ruleOf = (name: string) => rules.find((r) => r.Name === name);

/** 模板里的语句树在一个样例请求上求值(只实现这条规则用到的四种语句;遇到别的直接报错,不许静默当假)。 */
function evalStatement(st: any, req: { path: string; labels: string[] }): boolean {
  if (st.AndStatement) return st.AndStatement.Statements.every((s: any) => evalStatement(s, req));
  if (st.OrStatement) return st.OrStatement.Statements.some((s: any) => evalStatement(s, req));
  if (st.NotStatement) return !evalStatement(st.NotStatement.Statement, req);
  if (st.LabelMatchStatement) {
    must(st.LabelMatchStatement.Scope === "LABEL", `标签匹配的 Scope=${st.LabelMatchStatement.Scope}`);
    return req.labels.includes(st.LabelMatchStatement.Key);
  }
  if (st.ByteMatchStatement) {
    const b = st.ByteMatchStatement;
    must(b.FieldToMatch?.UriPath !== undefined, `路径匹配看的不是 UriPath:${JSON.stringify(b.FieldToMatch)}`);
    must(same(b.TextTransformations, [{ Priority: 0, Type: "NONE" }]), "路径匹配带了文本变换");
    if (b.PositionalConstraint === "STARTS_WITH") return req.path.startsWith(b.SearchString);
    if (b.PositionalConstraint === "EXACTLY") return req.path === b.SearchString;
    throw new Error(`没实现的位置约束 ${b.PositionalConstraint}`);
  }
  throw new Error(`求值器不认识的语句:${Object.keys(st).join(",")}`);
}

check("⓪ 两张 ACL 都在", () => {
  must(platformAcl, "没有 bgp-platform-waf");
  must(omAcl, "没有 bgp-openmetadata-waf");
});

check("① 托管通用规则集:按大小拦的那一条改成只计数,且只动了这一条;规则组整体仍按它自己的动作执行", () => {
  const common = ruleOf("AWSManagedCommon");
  must(common, "没有 AWSManagedCommon");
  const g = common.Statement.ManagedRuleGroupStatement;
  must(g.VendorName === "AWS" && g.Name === "AWSManagedRulesCommonRuleSet", `规则组=${g.VendorName}/${g.Name}`);
  must(same(g.RuleActionOverrides, [{ Name: "SizeRestrictions_BODY", ActionToUse: { Count: {} } }]), `RuleActionOverrides=${JSON.stringify(g.RuleActionOverrides)}`);
  must(SIZE_RESTRICTION_BODY_RULE === "SizeRestrictions_BODY", "规则名常量写错");
  must(g.ExcludedRules === undefined, "不许用整条排除(排除后标签也不打了)");
  must(same(common.OverrideAction, { None: {} }), `OverrideAction=${JSON.stringify(common.OverrideAction)}`);
  for (const name of ["AWSManagedBadInputs", "AWSManagedIpReputation"]) {
    const r = ruleOf(name);
    must(r, `没有 ${name}`);
    must(r.Statement.ManagedRuleGroupStatement.RuleActionOverrides === undefined, `${name} 被加了动作覆盖`);
  }
});

check("② 带标签拦的规则:动作是拦;语句在样例请求上的求值符合「页面 / 登录前接口拦,登录后的应用接口不拦,没有标签不拦」", () => {
  const block = ruleOf("BlockOversizeBodyOutsideAppApi");
  must(block, "没有 BlockOversizeBodyOutsideAppApi");
  must(same(block.Action, { Block: {} }), `Action=${JSON.stringify(block.Action)}`);
  must(OVERSIZE_BODY_LABEL === "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body", "标签常量写错");
  const labelled = [OVERSIZE_BODY_LABEL];
  const blocked = (path: string, labels: string[]) => evalStatement(block.Statement, { path, labels });
  // 登录后的应用接口:带大请求体也不在边缘拦(交给应用层网关)
  for (const p of ["/api/etl-jobs/01JOB", "/api/workflow/wf-1", "/api/sync", "/api/bi/reports/r-1", "/api/etl-jobs/01JOB/deps", "/api/redshift/tasks", "/api/admin/users"]) {
    must(!blocked(p, labelled), `${p} 带大请求体被边缘拦了`);
  }
  // 登录前公开接口、内部回环接口:照旧拦
  for (const p of ["/api/public/config", "/api/public/version", "/api/internal/alerting/tick"]) {
    must(blocked(p, labelled), `${p} 带大请求体没有被边缘拦`);
  }
  // 页面与静态资源:照旧拦(含长得像但不在 /api/ 之下的路径)
  for (const p of ["/", "/login", "/etl-jobs", "/_next/static/chunks/main.js", "/api", "/apix/etl-jobs", "/API/etl-jobs"]) {
    must(blocked(p, labelled), `${p} 带大请求体没有被边缘拦`);
  }
  // 没有标签(请求体没超 8KB):这条规则对谁都不生效
  for (const p of ["/", "/login", "/api/public/config", "/api/internal/alerting/tick", "/api/etl-jobs/01JOB"]) {
    must(!blocked(p, []), `${p} 没有大请求体却被这条规则拦了`);
    must(!blocked(p, ["awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body"]), `${p} 带的是别的标签却被这条规则拦了`);
  }
});

check("③ 优先级:整条放行的占 0..n-1 且都在预留区内;带标签拦的排在托管通用规则集之后;全表不撞号", () => {
  const prios = rules.map((r) => r.Priority);
  must(new Set(prios).size === prios.length, `撞号:${JSON.stringify(prios)}`);
  LARGE_BODY_ROUTES.forEach((r, i) => {
    const rule = ruleOf(r.name);
    must(rule, `没有放行规则 ${r.name}`);
    must(rule.Priority === i && i < LARGE_BODY_PRIORITY_RESERVED, `${r.name} 的优先级 ${rule.Priority}`);
    must(same(rule.Action, { Allow: {} }), `${r.name} 的动作不是放行`);
  });
  const common = ruleOf("AWSManagedCommon").Priority;
  const block = ruleOf("BlockOversizeBodyOutsideAppApi").Priority;
  must(block === OVERSIZE_BODY_BLOCK_PRIORITY, `带标签拦的规则优先级 ${block}`);
  must(block > common, `带标签拦的规则(${block})排在托管通用规则集(${common})之前,标签还没打上`);
  for (const r of rules.filter((x) => !LARGE_BODY_ROUTES.some((l) => l.name === x.Name))) {
    must(r.Priority >= LARGE_BODY_PRIORITY_RESERVED, `${r.Name} 的优先级 ${r.Priority} 落进了放行预留区`);
  }
  must(same(platformAcl.Properties.DefaultAction, { Allow: {} }), "缺省动作变了");
});

check("④ OpenMetadata 那张 ACL 没有被带上大小规则", () => {
  const names = (omAcl.Properties.Rules as any[]).map((r) => r.Name).sort();
  must(same(names, ["AWSManagedBadInputs", "AWSManagedIpReputation"]), `规则=${JSON.stringify(names)}`);
});

if (fails.length) {
  console.log(`❌ 请求体大小规则判据红 ${fails.length} 条`);
  process.exit(1);
}
console.log("✅ 请求体大小规则判据全过");
