import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

// (WS4b-1) — AWS WAF(CLOUDFRONT scope)。
//
// 在平台 CloudFront 前置 WebACL:AWS 托管规则集(常见攻击/已知坏输入/IP 信誉)+ 速率限制
// (单 IP 限速,缓解 CC/暴力扫描)。纯增量,只在边缘拦截恶意流量,不影响正常请求。
//
// 注意:CloudFront 关联的 WAF 必须建在 us-east-1(scope=CLOUDFRONT)。本平台即部署在
// us-east-1,故与其它栈同区。WebACL ARN 经 props 传给 PlatformStack 关联到分发。
/**
 * 请求体大小在边缘怎么管(2026-11-26 改;此前是「一切 >8KB 的请求体都拦,逐条登记放行」)。
 *
 * 【缺陷原形】托管通用规则集的 `SizeRestrictions_BODY` 拦掉一切 >8KB 的请求体,CloudFront 回的是一张 403 HTML 错误页,
 *   应用层一个字都说不上。放行靠下面这张清单逐条登记,而清单只会精确匹配路径 —— 带 id 的保存路由(离线作业脚本、
 *   编排画布、报表、同步任务……)一条都登记不进来:离线作业脚本约 160 行就保存不了(2026-11-26 真实客户反馈),
 *   页面提示的还是「请求过多」。「新增大请求体路由同笔登记」这条纪律只写在注释里,拦不住。
 * 【规则】大小那一条改成**只计数、只打标签**(其余托管规则照常拦);紧随其后的一条规则只对两类路径按这个标签拦:
 *   ① 不在 `/api/` 之下的(页面与静态资源 —— 它们没有理由带大请求体);
 *   ② 登录之前就能打到的接口与内部回环接口(`EDGE_SIZE_LIMITED_API_PREFIXES`)。
 *   其余 `/api/**` 要先过网关的登录校验,大小由应用层统一给上限并用人话报(platform 侧 `lib/http/body-limits.ts`)。
 * 【下面这张清单还管什么】清单里的路由整条放行(Allow 是终止动作,连托管规则的内容检查与限速也跳过):上传的是
 *   二进制文件 / 整段对话正文,内容检查没有意义。每行的 `maxBytes` 必须 **> 应用层自己的上限**
 *   (顺序反了用户拿不到应用层那句人话;有门禁钉住,见 platform 侧 `waf-large-body-guard`)。
 */
export const LARGE_BODY_ROUTES: ReadonlyArray<{
  name: string;
  uriPath: string;
  method: string;
  /** 放行上限(防滥用);超过它仍交由后续规则/默认动作处置。 */
  maxBytes: number;
  why: string;
}> = [
  {
    name: "AllowConnectorUpload",
    uriPath: "/api/flink/connectors",
    method: "POST",
    maxBytes: 300 * 1024 * 1024,
    why: "上传 Flink 连接器 JAR(可达数十 MB;后端另有 250MB 应用层校验)",
  },
  {
    name: "AllowGenbiCardSave",
    uriPath: "/api/genbi/cards",
    method: "POST",
    // 应用层上限是 20MB(`cards-store.MAX_BODY_BYTES`)⇒ 这里必须**更大**,
    // 才能让超限的用户看到应用层那句「超出多少 MB」而不是一张 CloudFront 403 HTML。
    maxBytes: 24 * 1024 * 1024,
    why: "保存问数会话卡片:正文含整段对话的全部结果行,轻易超过 8KB",
  },
];

/**
 * 大请求体放行规则的**优先级预留区** `[0, LARGE_BODY_PRIORITY_RESERVED)`。
 * 🔴 WAF 按 priority **升序**求值,而 Allow 是终止动作 ⇒ 放行规则必须排在托管规则**之前**
 *    (数字更小);同时 priority 在一个 WebACL 内**必须唯一** —— 改动前托管通用规则集占着 1,
 *    清单一加到第二条就与它撞号,CloudFormation 会直接拒(而不是运行期才发现)。
 * ⇒ 给放行块留出 0..19,固定规则一律 ≥ 20;加第 20 条放行时再抬这个数(有门禁钉住)。
 */
export const LARGE_BODY_PRIORITY_RESERVED = 20;

/** 托管通用规则集里「请求体超过 8KB」那一条的名字,与它给请求打的标签(规则改成只计数之后标签照打)。 */
export const SIZE_RESTRICTION_BODY_RULE = "SizeRestrictions_BODY";
export const OVERSIZE_BODY_LABEL = "awswaf:managed:aws:core-rule-set:SizeRestrictions_Body";

/** 应用接口的路径前缀:它之下的请求先过网关的登录校验,请求体大小由应用层管。 */
export const APP_API_PREFIX = "/api/";

/**
 * `/api/` 之下**仍按 8KB 在边缘拦**的前缀:登录之前就能打到的公开接口,与只许平台内部回环调用的接口
 * (后者本来就不许经公网入口进来)。与 platform 侧网关 `middleware.ts` 里免登录的两个前缀逐字相同(有门禁钉住)。
 */
export const EDGE_SIZE_LIMITED_API_PREFIXES: readonly string[] = ["/api/public/", "/api/internal/"];

/** 固定规则的优先级(都 ≥ 放行预留区;带标签拦截的那一条必须排在托管通用规则集之后,标签才看得到)。 */
export const OVERSIZE_BODY_BLOCK_PRIORITY = 23;

function pathStartsWith(prefix: string) {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: "STARTS_WITH",
      searchString: prefix,
      textTransformations: [{ priority: 0, type: "NONE" }],
    },
  };
}

/** CLOUDFRONT scope 的 WebACL 只能建在这个区(AWS 规则,与主控区无关)。 */
export const CLOUDFRONT_WAF_REGION = "us-east-1";

export class WafStack extends cdk.Stack {
  public readonly webAclArn: string;
  public readonly omWebAclArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webAcl = new wafv2.CfnWebACL(this, "BgpWebAcl", {
      name: "bgp-platform-waf",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "bgp-platform-waf",
        sampledRequestsEnabled: true,
      },
      rules: [
        // 0..n) 整条放行(**按 LARGE_BODY_ROUTES 生成,不再一条条手写**)。
        //    Allow 是终止动作 ⇒ 命中即跳过后续所有规则(托管规则的内容检查与限速都不再看)。
        //    🔴 priority 从 0 起连续占用 LARGE_BODY_ROUTES.length 个,托管规则从其后开始。
        ...LARGE_BODY_ROUTES.map((r, idx) => ({
          name: r.name,
          priority: idx,
          action: { allow: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: "EXACTLY",
                    searchString: r.uriPath,
                    textTransformations: [{ priority: 0, type: "NONE" }],
                  },
                },
                {
                  byteMatchStatement: {
                    fieldToMatch: { method: {} },
                    positionalConstraint: "EXACTLY",
                    searchString: r.method,
                    textTransformations: [{ priority: 0, type: "NONE" }],
                  },
                },
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { body: { oversizeHandling: "MATCH" } },
                    comparisonOperator: "LE",
                    size: r.maxBytes,
                    textTransformations: [{ priority: 0, type: "NONE" }],
                  },
                },
              ],
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: r.name, sampledRequestsEnabled: true },
        })),
        // 20) AWS 托管:通用规则集(OWASP 常见攻击)。放行块占 0..19,固定规则一律 ≥ 20。
        //     其中「请求体超过 8KB」那一条改成只计数(标签照打),拦不拦由下面优先级 23 的规则按路径决定;其余规则照常拦。
        {
          name: "AWSManagedCommon",
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              ruleActionOverrides: [{ name: SIZE_RESTRICTION_BODY_RULE, actionToUse: { count: {} } }],
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "AWSManagedCommon", sampledRequestsEnabled: true },
        },
        // 2) AWS 托管:已知坏输入。
        {
          name: "AWSManagedBadInputs",
          priority: 21,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "AWSManagedBadInputs", sampledRequestsEnabled: true },
        },
        // 3) AWS 托管:IP 信誉(已知恶意来源)。
        {
          name: "AWSManagedIpReputation",
          priority: 22,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "AWSManagedIpReputation", sampledRequestsEnabled: true },
        },
        // 23) 请求体超过 8KB(带着上面打的标签)且路径属于「仍在边缘拦」的两类 ⇒ 拦:
        //     不在 /api/ 之下(页面 / 静态资源),或在登录前公开接口 / 内部回环接口之下。其余 /api/** 放给应用层。
        {
          name: "BlockOversizeBodyOutsideAppApi",
          priority: OVERSIZE_BODY_BLOCK_PRIORITY,
          action: { block: {} },
          statement: {
            andStatement: {
              statements: [
                { labelMatchStatement: { scope: "LABEL", key: OVERSIZE_BODY_LABEL } },
                {
                  orStatement: {
                    statements: [
                      { notStatement: { statement: pathStartsWith(APP_API_PREFIX) } },
                      ...EDGE_SIZE_LIMITED_API_PREFIXES.map(pathStartsWith),
                    ],
                  },
                },
              ],
            },
          },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "BlockOversizeBodyOutsideAppApi", sampledRequestsEnabled: true },
        },
        // 4) 速率限制:单 IP 5 分钟内超 4000 请求即拦截(缓解 CC / 暴力扫描)。
        //    (用户 2026-10-20 定值 2000 → 4000):规则作用于整个 CloudFront 分发(含 _next/static 静态资源),
        //    同一出口 IP 后的多客户端并发会被 CloudFront 直接回 403 拦截页;2000 在真环境硬门里撞到过。
        {
          name: "RateLimit",
          priority: 30,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 4000, aggregateKeyType: "IP" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "RateLimit", sampledRequestsEnabled: true },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;
    new cdk.CfnOutput(this, "WebAclArn", { value: webAcl.attrArn });

    // 🔴 生产上线批次 A:OpenMetadata 的 CloudFront 原来**没有任何 WAF**(且默认口令 admin/admin 对公网)。
    //   单独一张 WebACL,**不复用**平台那张 —— 平台那张的通用规则集会拦掉一切 >8KB 的请求体(平台靠
    //   白名单路由放行),而平台推 schema / 血缘到 OM、OM 自己的 UI 都常带大请求体;OM 的描述字段又是
    //   markdown / HTML,XSS 正文规则会误杀。也**不加按 IP 限速**:平台与采集任务都从固定的 NAT 出口经
    //   CloudFront 访问 OM,批量推送时会被当成一个 IP 限掉。⇒ 只放两条低误杀的:IP 信誉 + 已知恶意输入。
    //   主防线是 OM 管理员口令(om-service-stack 生成随机口令,scripts/om-secure-admin.sh 换掉 admin/admin)。
    const omAcl = new wafv2.CfnWebACL(this, "OmWebAcl", {
      name: "bgp-openmetadata-waf",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "bgp-openmetadata-waf", sampledRequestsEnabled: true },
      rules: [
        {
          name: "AWSManagedIpReputation",
          priority: 22, // 与平台那张同名规则同号(优先级只在本 ACL 内有意义;判据按名字查号)
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesAmazonIpReputationList" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "OmIpReputation", sampledRequestsEnabled: true },
        },
        {
          name: "AWSManagedBadInputs",
          priority: 21,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: "OmBadInputs", sampledRequestsEnabled: true },
        },
      ],
    });
    this.omWebAclArn = omAcl.attrArn;
    new cdk.CfnOutput(this, "OmWebAclArn", { value: omAcl.attrArn });
  }
}
