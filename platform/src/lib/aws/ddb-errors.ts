// 2026-11-04 —— DynamoDB 条件写「条件不满足」的唯一判法。
//
// 【为什么单独一个小模块】`@/lib/aws/dynamodb` 在几乎每条单测里都被整模块 vi.mock 成 `{ TABLES, docClient }`,
//   往那里加导出 = 那些 mock 里它是 undefined ⇒ 一调就炸。放在旁边这个零依赖的文件里,谁都能真 import。
// 【语义】条件写不满足 **不是故障,是一个答案**(行不存在 / 别人持锁 / 状态已被改走)。调用方按自己的语义处理:
//   回写已删作业行 ⇒ 吞掉(绝不 upsert 出幽灵行);抢锁 ⇒ 当作抢不到;其余异常一律照抛。

export function isConditionalCheckFailed(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === "ConditionalCheckFailedException";
}
