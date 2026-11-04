// 数据源凭证的 Secrets Manager 封装(独立底层,断循环依赖)。
//
// 【为什么独立】原实现挤在 lib/aws/datasource-service.ts,与 JDBC_URL 表同文件。但凭证读写
// 与「数据源类型」无关(纯 Secrets Manager 操作),不该困在那里。抽出后:
//   · jdbc-base 依赖本文件读凭证(不再依赖 datasource-service),打破 registry→provider→
//     jdbc-base→datasource-service→registry 的循环依赖;
//   · datasource-service.ts 的 createSecret/getSecret/... 改为 re-export 本文件(其他消费方零改动)。
// 内容形态由各 provider 的 buildSecretPayload 决定(JDBC=userpass;后续 iam-role 无 secret)。

import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, UpdateSecretCommand, DeleteSecretCommand } from "@aws-sdk/client-secrets-manager";
import { sdkClient } from "@/lib/aws/clients";
// 🔴 这里原来是一个**模块级主控区客户端**(`new SecretsManagerClient({ region: process.env.AWS_REGION })`),
// 它是「非主控区的数据源全都用不了」的单一根因:凭证存在那个区,读却永远打主控区 ⇒
// `getSecret` 抛 ResourceNotFoundException ⇒ 浏览表 / 测连接 / 同步一律失败,而错误文案是
// 「无法连接源数据库」—— 看起来像源库的问题,实际上是我们打错了区。
//
// 单一真值源 = **secret ARN 自己就带 region**(`arn:aws:secretsmanager:<region>:<acct>:secret:...`)。
// 读 / 改 / 删一律从 ARN 派生,不需要调用方多传一个参数(多传一个参数就多一个传错的机会);
// 只有**建**的时候 ARN 还不存在 ⇒ 由调用方给出落点 region(缺省主控区,与改动前逐字节等价)。
import { secretsClientFor, homeRegion } from "@/lib/exec-env/target-clients";
// ARN 切段 + 形态校验的唯一作者(分区 / 服务名校验与迁移前的正则逐字等价)
import { regionOfArn } from "@/lib/aws/arn";

/**
 * 从 secret ARN 里取 region。
 * 🔴 解析不出来就**抛**,不回落主控区:回落等于「拿主控区的凭证去连别的区的库」,
 * 要么读不到(报错文案指向源库,误导排障),要么读到同名的另一份凭证(更坏)。
 */
export function regionOfSecretArn(secretArn: string): string {
  const region = regionOfArn(secretArn, "secretsmanager");
  if (!region) {
    throw new Error(
      `secret ARN 里解析不出 region:${JSON.stringify(secretArn)}。` +
        `🔴 刻意不回落主控区 —— 那会用主控区的凭证去连另一个区的库`
    );
  }
  return region;
}

const smFor = (secretArn: string) => secretsClientFor(regionOfSecretArn(secretArn));

// userpass 凭证结构(JDBC 四兄弟)。后续范式(mtls 等)可扩联合类型。
export interface UserPassSecret {
  username: string;
  password: string;
}

/**
 * 建凭证。`region` = 这个数据源**归属的执行区**(它的 `ownerTargetId` 对应的 region)。
 * 不传 = 主控区(与改动前逐字节等价,是回滚点)。
 */
export async function createSecret(datasourceId: string, username: string, password: string, region?: string): Promise<string> {
  const sm = await secretsClientFor(region || homeRegion());
  const { ARN } = await sm.send(new CreateSecretCommand({
    Name: `bgp/datasource/${datasourceId}`,
    SecretString: JSON.stringify({ username, password }),
  }));
  return ARN!;
}

/**
 * 取 secret 的**原始 JSON**(region 同样从 ARN 派生)。
 *
 * 🔴 为什么不复用 `getSecret`:那个函数的返回类型是 `UserPassSecret`(只有 username / password),
 * 而有些消费方要读别的键(MySQL CDC 兼容 `sec.user` 这个别名、OpenSearch 用自己的键名)。
 * 用 `getSecret` 会把那些键**静默丢掉**,而丢掉的后果是连接时报「认证失败」——指向凭证本身,
 * 排障会去改密码,而真因是我们把字段吃了。
 */
export async function getSecretJson(secretArn: string): Promise<Record<string, any>> {
  const sm = await smFor(secretArn);
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  try {
    return JSON.parse(SecretString || "{}");
  } catch {
    return {};
  }
}

export async function getSecret(secretArn: string): Promise<UserPassSecret> {
  const sm = await smFor(secretArn);
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return JSON.parse(SecretString!);
}

/**
 * IAM 侧(2026-10-21):读**账号自有、不归平台管**的密钥 —— 目前唯一用途 = 「从 RDS 发现建源」时把实例的
 * 托管主密钥(`rds!db-…` 或 CDK 演示库 `BgpRdsStack…`)里的账密**复制**进平台自己的 `bgp/datasource/<id>`。
 *
 * 🔴 为什么走控制面轴而不是 `getSecret`:数据面角色的读语句只认平台实名密钥(`bgp/*` / `redshift!*`,SPEC L5 per-target 收窄),
 *   不该为「读一次账号任意密钥」放宽成 `secret:*`;而这一步本来就是建源时的一次性控制面动作 —— 复制完成后,所有数据面读
 *   (Glue 连接 / 浏览表 / 同步作业)都只碰 `bgp/datasource/<id>`。…9435 observe 第四十四轮量到主控区数据面角色被拒
 *   `GetSecretValue on …BgpRdsStackBgpSourceMysqlSe-…` 3 次,就是这一步。
 *   region 仍从 ARN 派生(不回落主控区,同 `regionOfSecretArn` 的理由)。
 */
export async function getAccountSecretViaControlPlane(secretArn: string): Promise<UserPassSecret> {
  const sm = sdkClient("control-plane", SecretsManagerClient, { region: regionOfSecretArn(secretArn) });
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return JSON.parse(SecretString!);
}

export async function updateSecret(secretArn: string, username: string, password: string) {
  const sm = await smFor(secretArn);
  await sm.send(new UpdateSecretCommand({
    SecretId: secretArn,
    SecretString: JSON.stringify({ username, password }),
  }));
}

export async function deleteSecret(secretArn: string) {
  try {
    const sm = await smFor(secretArn);
    await sm.send(new DeleteSecretCommand({ SecretId: secretArn, ForceDeleteWithoutRecovery: true }));
  } catch {}
}
