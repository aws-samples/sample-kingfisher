// OpenMetadata 加固的离线判据(CDK assertions,不碰 AWS):
//   ① OM 的 CloudFront 挂 WAF(OM 专用 ACL,不是平台那张)且回源带校验头;
//   ② ALB 监听器默认 403,只有带对回源头的规则才转发;
//   ③ 管理员口令 / 回源校验值两件密钥都 RETAIN;
//   ④ OM 专用 ACL 不含平台那张的体积限制 / 限速(否则会拦掉平台推给 OM 的大请求体与批量推送)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import { Template, Match } from "aws-cdk-lib/assertions";
import { WafStack } from "../../lib/waf-stack";
import { OmDatabaseStack } from "../../lib/om-database-stack";
import { OmServiceStack } from "../../lib/om-service-stack";

const fails: string[] = [];
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { fails.push(name); console.log(`  ✗  ${name}: ${String((e as Error).message).split("\n")[0].slice(0, 300)}`); } };

const app = new cdk.App();
const env = { account: "123456789012", region: "us-east-1" };
const base = new cdk.Stack(app, "Base", { env });
const vpc = new ec2.Vpc(base, "Vpc", { availabilityZones: ["us-east-1a", "us-east-1b"], natGateways: 1 });
const key = new kms.Key(base, "Key");
const waf = new WafStack(app, "Waf", { env });
const db = new OmDatabaseStack(app, "OmDb", { env, vpc, dataKey: key });
const om = new OmServiceStack(app, "Om", { env, vpc, db: db.db, searchEndpoint: "search.example", webAclArn: waf.omWebAclArn });
const t = Template.fromStack(om);
const w = Template.fromStack(waf);

check("① CloudFront 挂 WAF 且回源带校验头", () => {
  t.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      WebACLId: Match.anyValue(),
      Origins: Match.arrayWith([Match.objectLike({ OriginCustomHeaders: Match.arrayWith([Match.objectLike({ HeaderName: "X-Bgp-Origin-Verify" })]) })]),
    }),
  });
});
check("② ALB 监听器默认 403", () => {
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    DefaultActions: [Match.objectLike({ Type: "fixed-response", FixedResponseConfig: Match.objectLike({ StatusCode: "403" }) })],
  });
});
check("② 只有带对回源头的规则才转发", () => {
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
    Conditions: Match.arrayWith([Match.objectLike({ Field: "http-header", HttpHeaderConfig: Match.objectLike({ HttpHeaderName: "X-Bgp-Origin-Verify" }) })]),
    Actions: Match.arrayWith([Match.objectLike({ Type: "forward" })]),
  });
});
check("③ 两件密钥都 RETAIN(管理员口令 + 回源校验值)", () => {
  const secrets = t.findResources("AWS::SecretsManager::Secret");
  const byName = Object.values(secrets).map((r: any) => [r.Properties?.Name, r.DeletionPolicy, r.UpdateReplacePolicy]);
  for (const n of ["bgp/om/admin-password", "bgp/om/origin-verify"]) {
    const hit = byName.find((x) => x[0] === n);
    if (!hit) throw new Error(`没有密钥 ${n}`);
    if (hit[1] !== "Retain" || hit[2] !== "Retain") throw new Error(`${n} 不是 Retain(${hit[1]}/${hit[2]})`);
  }
});
check("④ OM 专用 ACL:只有 IP 信誉 + 已知恶意输入,无体积限制 / 限速", () => {
  const acls = Object.values(w.findResources("AWS::WAFv2::WebACL")) as any[];
  const omAcl = acls.find((a) => a.Properties.Name === "bgp-openmetadata-waf");
  if (!omAcl) throw new Error("没有 bgp-openmetadata-waf");
  const rules = omAcl.Properties.Rules.map((r: any) => r.Statement?.ManagedRuleGroupStatement?.Name || (r.Statement?.RateBasedStatement ? "RATE" : "?"));
  const want = ["AWSManagedRulesAmazonIpReputationList", "AWSManagedRulesKnownBadInputsRuleSet"];
  if (JSON.stringify(rules.sort()) !== JSON.stringify(want.sort())) throw new Error(`规则=${JSON.stringify(rules)}`);
});
// OM 库引擎 MySQL 8.4(RDS 标准支持,消掉 8.0 的扩展支持费)+ 允许大版本原地升级(没有它 CloudFormation 拒绝版本变更、整栈回滚)。
//   钉 "8.4" 这个字面:它是「只钉大版本、小版本由 RDS 选」的口径;谁把它改回 8.0 或钉死某个小版本都要在这里显式改。
check("⑤:OM 库引擎 MySQL 8.4 且 AllowMajorVersionUpgrade(存量 8.0 实例原地升上来)", () => {
  Template.fromStack(db).hasResourceProperties("AWS::RDS::DBInstance", {
    Engine: "mysql",
    EngineVersion: "8.4",
    AllowMajorVersionUpgrade: true,
    MultiAZ: true,
    DBInstanceIdentifier: "bgp-openmetadata-db",
  });
});

if (fails.length) { console.log(`❌ OM 加固判据红 ${fails.length} 条`); process.exit(1); }
console.log("✅ OM 加固判据全过");
