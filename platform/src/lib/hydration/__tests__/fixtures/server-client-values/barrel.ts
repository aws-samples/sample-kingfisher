// 夹具:普通模块把客户端模块的值转手再导出(具名 / 别名),同时整体再导出一个普通模块。
export { clientValue, clientValue as renamedValue } from "./client-module";
export * from "./plain-module";
