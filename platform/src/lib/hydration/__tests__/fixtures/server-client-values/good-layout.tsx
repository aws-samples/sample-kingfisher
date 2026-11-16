// 夹具:服务端组件只把客户端组件当标签用,值取自普通模块(含经转手再导出的普通值)—— 不该被抓。
import ClientComp from "./client-module";
import { plainValue } from "./barrel";

export default function GoodLayout() {
  return <ClientComp label={plainValue} />;
}
