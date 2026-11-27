// 「读到完为止」的 Scan / Query —— 唯一作者。
//
// 缺陷原形(2026-11-27 读代码,随后在测试账号页面上量到):存储服务的 Scan / Query 一次最多读 1MB,读不完时在应答里给一个
//   LastEvaluatedKey,要拿它再读下一页。平台里一批「列出全部」的读取只读了第一页:离线作业、EMR 作业、编排、数仓查询任务、
//   同步任务、Flink 作业、数据源、报表的列表,「发布到环境」找目标环境那一份,审批单清单,版本历史……
//   表里的内容加起来超过 1MB 之后,后面的那部分被无声丢掉 —— 列表里看不到新建的对象;找不到目标环境那一份就再建一份。
//   单个作业原来最多约 8KB(更大的保存不了),要一百多个才撞到;长脚本能保存之后,几份大脚本就够了。
//
// 规则:凡是要「全部」的读取都经这里;不许在别处手写单次 Scan(判据钉住:直接 new ScanCommand 的文件只减不增,
//   留下的每一处写明它为什么不用读完 —— 有意只取有限条,或者自己在翻页)。
// 过滤条件(FilterExpression)是读完一页之后才筛的 ⇒ 一页筛完可能一条不剩而后面还有,所以只看「还有没有下一页」,不看这一页有几条。
import { QueryCommand, ScanCommand, type QueryCommandInput, type ScanCommandInput } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";

type Row = Record<string, any>;

/** 把一张表(或它的一个索引)读完:逐页跟 LastEvaluatedKey,直到没有下一页。不要传 Limit(它限的是每页读几条,不是总共要几条)。 */
export async function scanAll<T = Row>(input: ScanCommandInput): Promise<T[]> {
  const items: T[] = [];
  let startKey: Row | undefined;
  do {
    const page = await docClient.send(new ScanCommand({ ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    items.push(...((page.Items ?? []) as T[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** 把一个分区键下的行读完(顺序由 ScanIndexForward 决定,跨页保持)。只要「最新 N 条」的读取不要用它,自己带 Limit。 */
export async function queryAll<T = Row>(input: QueryCommandInput): Promise<T[]> {
  const items: T[] = [];
  let startKey: Row | undefined;
  do {
    const page = await docClient.send(new QueryCommand({ ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    items.push(...((page.Items ?? []) as T[]));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}
