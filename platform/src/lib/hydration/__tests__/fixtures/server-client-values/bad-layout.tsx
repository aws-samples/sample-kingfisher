// 夹具:服务端组件从客户端模块取值(直接取一个、经普通模块转手取两个)—— 三处都该被抓到;组件当标签用不算。
import ClientComp, { clientValue } from "./client-module";
import { renamedValue } from "./barrel";
import { clientValue as viaStar } from "./star-barrel";

export default function BadLayout() {
  return <ClientComp label={clientValue + renamedValue + viaStar} />;
}
