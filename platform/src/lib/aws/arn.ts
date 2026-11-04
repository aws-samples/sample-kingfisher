// @kf-batch 56-B128-channel-reconcile
/**
 * ARN 的位置属性读取 —— **唯一作者**。
 *
 * 🔴 为什么要单独一个文件:「region 是 ARN 的第 4 段」这件事此前在 `datasource-spi/secrets.ts`(secret ARN)
 * 与 `scheduler/serverless/task-logs.ts`(workflow ARN)各写了一遍(一份带分区 / 服务名校验、一份只看第 4 段);
 * B-128 要给 DMS 复制任务 ARN 再加一处时就是第三份 —— 三份各自漂移正是 SSOT 纪律要挡的。
 * 本文件只做「切段 + 形态校验」,回 `null` 表示读不出;**抛不抛、文案写什么由调用方定**(文案是它们的合同,各自的单测钉着)。
 */
import { REGION_RE } from "@/lib/aws/clients";

/** 分区形态:`aws` / `aws-cn` / `aws-us-gov`(与 secrets.ts 迁移前的 `aws[a-z-]*` 逐字等价)。 */
const PARTITION_RE = /^aws[a-z-]*$/;

/**
 * `arn:<partition>:<service>:<region>:<account>:<rest…>` ⇒ region。
 * 读不出合法 region(不是 ARN / 段数不足 / 分区非 aws* / 给了 `service` 而第 3 段对不上 / 第 4 段不是 region 形态)⇒ `null`。
 * 🔴 刻意**不回落主控区**:回落等于拿主控区的客户端去问另一个区的资源 —— 症状是「永远查不到」,离根因极远。
 */
export function regionOfArn(arn: unknown, service?: string): string | null {
  const parts = String(arn ?? "").split(":");
  if (parts.length < 6 || parts[0] !== "arn" || !PARTITION_RE.test(parts[1] ?? "")) return null;
  if (service && parts[2] !== service) return null;
  const region = parts[3] ?? "";
  return REGION_RE.test(region) ? region : null;
}
