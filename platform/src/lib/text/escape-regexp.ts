/** 把任意文本转成可放进 RegExp 源码的字面量(全部元字符与反斜杠都转义)。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
