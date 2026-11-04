// @kf-batch 50-WP4quater-reads(工单 SC-31)
/**
 * 钉住:数据源凭证的 Secrets Manager 客户端**按 secret ARN 的 region** 建,不是模块级主控区客户端。
 *
 * 🔴 为什么这条判据必须存在:改动前 `secrets.ts` 顶部是
 * `const sm = new SecretsManagerClient({ region: process.env.AWS_REGION })`。
 * 它让**每一个非主控区的数据源**都用不了 —— 凭证在那个区,读却永远打主控区,
 * `getSecret` 抛 ResourceNotFoundException,一路冒泡成界面上的「无法连接源数据库」。
 * 那句文案指向源库,于是排障会去查源库的网络与账号,而真因在我们这一侧打错了区。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { regionOfSecretArn } from "../secrets";

const SRC = resolve(__dirname, "../../..");
const secretsSrc = readFileSync(resolve(SRC, "lib/datasource-spi/secrets.ts"), "utf8");
/**
 * 🔴 负向文本断言**必须先剥注释**:本文件的合同注释里逐字写着上一版的根因
 * (`new SecretsManagerClient({ region: process.env.AWS_REGION })`),不剥注释就会把
 * 「文档记录了这条教训」误判成「违反了这条教训」—— 本仓累计踩过多次。
 */
const secretsCode = secretsSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("datasource-spi/secrets 的 region 派生", () => {
  it("从 secret ARN 里解出 region(多区 + 中国分区都要认)", () => {
    expect(regionOfSecretArn("arn:aws:secretsmanager:us-west-2:123456789012:secret:bgp/datasource/x-AbCdEf")).toBe("us-west-2");
    expect(regionOfSecretArn("arn:aws:secretsmanager:eu-west-1:123456789012:secret:bgp/datasource/y-Gh")).toBe("eu-west-1");
    expect(regionOfSecretArn("arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:z-Ij")).toBe("cn-north-1");
  });

  it("🔴 解析不出 region 必须**抛**,绝不回落主控区", () => {
    // 回落的后果不是「读不到」,而是「拿主控区的凭证去连另一个区的库」——
    // 要么报一个指向源库的错误文案,要么读到同名的另一份凭证(更坏)。
    for (const bad of ["", "not-an-arn", "arn:aws:secretsmanager::123:secret:x", "arn:aws:s3:::bucket"]) {
      expect(() => regionOfSecretArn(bad), `「${bad}」应当被拒`).toThrow(/解析不出 region/);
    }
  });

  it("🔴 文件里不许再出现模块级 SecretsManagerClient(那正是上一版的根因)", () => {
    expect(secretsCode).not.toMatch(/^\s*const\s+sm\s*=\s*new\s+SecretsManagerClient\(/m);
    expect(secretsCode).not.toMatch(/new\s+SecretsManagerClient\(/);
    expect(secretsSrc, "客户端必须走按区缓存的唯一出口").toContain("secretsClientFor(");
  });

  it("🔴 读/改/删都必须从 ARN 派生 region(只有「建」允许调用方给 region)", () => {
    for (const fn of ["getSecret", "updateSecret", "deleteSecret"]) {
      const body = secretsCode.slice(secretsCode.indexOf(`export async function ${fn}(`));
      expect(body.slice(0, 400), `${fn} 没走 smFor(ARN) ⇒ 又会打回主控区`).toContain("smFor(secretArn)");
    }
    expect(secretsCode).toMatch(/export async function createSecret\([^)]*region\?: string\)/);
  });
});
