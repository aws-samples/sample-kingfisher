/**
 * **MSAF(Flink)落点** —— 「这个流作业在哪个区跑、用哪个角色、代码从哪个桶取、产物写哪」的唯一出口。
 *
 * 用户 2026-09-10 原话:「一定要加这个维度,不然白干了,所有任务都在自己的区域跑,不然没有意义。」
 *
 * 🔴 为什么必须有这一层:`flink-service.ts` 原来在模块顶部建了 **6 个主控区客户端**
 * (kda / s3 / cwl / cw / sm / rds)并把 7 个部署时注入的 env 常量当成事实。那是本仓反复踩的元模式 ——
 * 「部署时快照」用在「运行期还会增长」的东西上:
 *   · 用主控区的 kda 去 `DescribeApplication` 另一个区的应用 ⇒ ResourceNotFound ⇒
 *     平台的状态对账把作业标成「已删除」(而它其实在那个区好好跑着);
 *   · 用主控区的角色去 `CreateApplication` ⇒ AccessDenied,界面上只显示「启动失败」;
 *   · 更坏的一种:**应用跑在那个区、产物写回主控区** —— 数据驻留承诺当场破,而一切看起来正常。
 *
 * 收尾:主控区也读描述符(见 `resolveFlinkPlace` 的注释:值逐项不变的依据)。
 */
import { FLINK } from "./flink-config";
// 落点唯一作者(主控区也读描述符)+ 资源唯一取法
import { resolvePlace, placeResource } from "@/lib/place/resolve";
import { PlaceUnavailable, type TargetRef } from "@/lib/place/types";
import {
  resolveTargetFlink,
  kdaClientFor,
  s3ClientFor,
  logsClientFor,
  cloudWatchClientFor,
  secretsClientFor,
} from "@/lib/exec-env/target-clients";

export interface FlinkPlace {
  targetId: string;
  region: string;
  account: string;
  /** MSAF 服务执行角色(描述符 `flinkRoleArn`:per-target 栈建的 `BgpExecEnv-<slug>-flink-role`;主控区 = `bgp-flink-role`) */
  roleArn: string;
  /** runner JAR 所在桶(= 该区的 Glue 脚本桶;键名与 home 相同) */
  codeBucket: string;
  /** 作业产物桶(描述符 `datalakeBucket`,主控区也一样) */
  outputBucket: string;
  /** S3 Tables 表桶(Iceberg sink) */
  s3tablesBucket: string;
  /** MSAF VPC 接入用的私有子网 / 安全组(该区 core 袋里的 `emrSubnetIds` / `emrSecurityGroupId`,主控区也一样) */
  subnetIds: string[];
  securityGroupIds: string[];
  home: boolean;
}

// 🔴 落点**必填**(原来 `targetId || HOME_TARGET_ID`),且决策**在分支之前**记账
//   原来主控区分支直接 return、一次决策都不记 ⇒ 一次列表请求里混着两个区的作业时,主控区那次 Describe 在观测器里
//   「无决策」,被拿去和别区的决策比对 ⇒ 误报越区(2026-10-03 09:20Z 实测:`kinesisanalytics DescribeApplication @ us-east-1`,
//   作业是 `targets=[tgt_home]` 的示范流作业,调用其实打对了区)。主控区与其他区同一条路记账(D11)。
//
// 收尾:🔴🔴 **主控区分支删掉,改走描述符**(L1:主控区也是一个 target)。
//   原来主控区直接回 `FLINK` 常量(部署期 env 快照),一次都不核描述符 ⇒ 两个后果:
//   ① 主控区「装没装 flink」从来不核(没装也照样往下走,CreateApplication 才炸);
//   ② 同一个作者里两套口径(主控区读 env、别的区读资源袋),改一边另一边不跟 —— 正是落点 bug 越修越多的那个形状。
//   现在**一条路**:`resolvePlace`(准入 + 必须装 flink)→ 资源一律 `placeResource` 取(缺一即 409,不回落)。
//   值不变的依据(主控区):描述符由 seed-home 按命名 SSOT 写入 —— `scriptsBucket` = `bgp-glue-scripts-<账号>`
//   (= 原 FLINK_CODE_BUCKET)、`datalakeBucket` = `bgp-datalake-<账号>`(= 原 FLINK_OUTPUT_BUCKET)、
//   `tableBucket` = `bgp-table-bucket`(= 原 FLINK_S3TABLES_BUCKET)、`flinkRoleArn` = IAM 真查 `bgp-flink-role`
//   (= 原 FLINK_RUNTIME_ROLE_ARN)、`emrSubnetIds` = `EMR_DEFAULT_SUBNET_IDS`(与原 FLINK_SUBNET_IDS 是 platform-stack
//   里**同一个表达式**)。`securityGroupIds` 主控区原来恒空、现在取 `emrSecurityGroupId` —— 该字段**没有任何读者**
//   (自定义 VPC 的 SG 只认用户填的),行为不变。
export async function resolveFlinkPlace(targetId: string): Promise<FlinkPlace> {
  // 🔴 不先 `targetRef()`:那会在**记账之前**就抛;直接交给 `resolvePlace`(它先记账、再验格式)。
  const ref: TargetRef = { kind: "target", targetId };
  const place = await resolvePlace(ref, { via: "resolveFlinkPlace", component: "flink" });
  let roleArn: string;
  try {
    roleArn = resolveTargetFlink(place).serviceRoleArn;
  } catch (e) {
    throw new PlaceUnavailable(place.targetId, String((e as Error)?.message ?? e));
  }
  // 🔴 网络事实取该区 core 袋的 `emrSubnetIds` / `emrSecurityGroupId`:它们就是**这个区的私有子网与
  //    安全组**(EMR 作业现在就用它们跑)。读不到 ⇒ 回空数组,由调用方在需要 VPC 接入时如实报错,
  //    **绝不回落主控区的子网** —— 那会把一个别区的子网 id 写进 MSAF VpcConfigurations,提交才炸。
  const res = place.resources;
  const subnetIds = Array.isArray(res.emrSubnetIds) ? res.emrSubnetIds.filter((x): x is string => typeof x === "string") : [];
  const sg = typeof res.emrSecurityGroupId === "string" && res.emrSecurityGroupId ? [res.emrSecurityGroupId] : [];
  return {
    targetId: place.targetId,
    region: place.region,
    account: place.accountId, // 单账号 × 多 region(生产形态):各区描述符的账号相同
    roleArn,
    codeBucket: placeResource(place, "scriptsBucket"),
    outputBucket: placeResource(place, "datalakeBucket"),
    s3tablesBucket: placeResource(place, "tableBucket"),
    subnetIds,
    securityGroupIds: sg,
    home: place.home,
  };
}

/** 该落点的一组客户端(全部按区缓存,来自 `target-clients` 的唯一工厂)。 */
export async function flinkClients(p: FlinkPlace) {
  const [kda, s3, cwl, cw, sm] = await Promise.all([
    kdaClientFor(p.region),
    s3ClientFor(p.region),
    logsClientFor(p.region),
    cloudWatchClientFor(p.region),
    secretsClientFor(p.region),
  ]);
  return { kda, s3, cwl, cw, sm };
}

/**
 * 确保 runner JAR 在**该落点的代码桶**里存在;不在就从主控区的桶跨区复制一份。
 *
 * 🔴 为什么在运行期做而不是加进 exec-env 部署流水线:那条链是 broker Lambda + CodeBuild + 源包 asset,
 * 改它的爆炸半径远大于本刀(而且每加一个制品都要动一次流水线)。跨区 `CopyObject` 在同账号内是
 * 一次服务端复制,幂等、无出网、与既有 `ensureLogGroup` 是同一种「ensure」模式。
 *
 * 🔴 复制失败**必须抛**:静默跳过的后果是 MSAF 在 CreateApplication 时报「取不到 fileKey」,
 * 而那条报错完全指不到「JAR 没送到这个区」这件事上(本仓第 4 条就是这个形状
 * 部署漏传模块 jar ⇒ 启动即 error / key not exist)。
 */
export async function ensureRunnerJar(p: FlinkPlace, codeKey: string): Promise<void> {
  // 原来 `if (p.home) return`(按身份分支)。真正的条件是「本区代码桶**就是** JAR 的源桶」
  //   (deploy-all.sh 只往那一只桶传):按事实判,不按「是不是主控区」判 —— 主控区的描述符 scriptsBucket 与源桶同名 ⇒ 行为不变。
  if (FLINK.codeBucket && p.codeBucket === FLINK.codeBucket) return;
  const { s3 } = await flinkClients(p);
  const { HeadObjectCommand, CopyObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await s3.send(new HeadObjectCommand({ Bucket: p.codeBucket, Key: codeKey }));
    return; // 已经有了
  } catch {
    /* 不存在 ⇒ 往下复制 */
  }
  const homeBucket = FLINK.codeBucket;
  if (!homeBucket) {
    throw new Error(
      `无法把 Flink runner 送到 ${p.region}:主控区代码桶未配置(FLINK_CODE_BUCKET 为空)。` +
        `🔴 刻意不让作业在缺 JAR 的情况下启动 —— MSAF 那时只会报「取不到 fileKey」,指不到真因`
    );
  }
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: p.codeBucket,
        Key: codeKey,
        CopySource: `${homeBucket}/${codeKey}`,
      })
    );
  } catch (e) {
    throw new Error(
      `把 Flink runner 复制到 ${p.region} 失败(${homeBucket}/${codeKey} → ${p.codeBucket}/${codeKey}):` +
        `${(e as Error)?.message}`
    );
  }
}
