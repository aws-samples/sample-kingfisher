// **MWAA Serverless 的 Code 包 = zip,模块在根**(50 SPEC v3.30 §3.15)。
//
// 🔴 为什么必须是 zip:`CreateWorkflow.Code.S3Location` 指的是**代码包**,服务把它解开后放到 worker 的 import 路径上。
//    给一个裸 `.py` 对象:CreateWorkflow **成功**、workflow **READY**、cron **照点触发** —— 然后每个 run 都在
//    「Filling up the DagBag」阶段死于 `ModuleNotFoundError: No module named 'bgp_runtime'`,run 秒失败。
//    这条事实 spike 阶段就已坐实并写进记忆(「PythonOperator 模块必须经 Code.S3Location(zip,模块在根)」),
//    而施工时写成了「官方接受单 .py,免 zip」这个**没验过的假设** ⇒ 真环境第四轮才炸出来。
//    ⇒ 打包收成本文件这一个作者,任何人都拿不到「裸 .py」那条路(publish 只认 BGP_RUNTIME_ZIP)。
//
// 🔴 为什么固定时间戳:workflowBucket 开了版本 + RETAIN。zip 头里默认写「当前时间」⇒ 同一份运行时每次发布都产出不同字节,
//    在版本桶里堆一串无意义版本。固定成一个常量时刻后:同内容 ⇒ 同字节 ⇒ 覆写即 no-op。
import AdmZip from "adm-zip";
import { BGP_RUNTIME_MODULE, BGP_RUNTIME_PY, BGP_RUNTIME_VERSION } from "./runtime-py";

/** 包内的模块文件名 —— 必须是 `<module>.py` 且在**根**(`python_callable: bgp_runtime.run_job` 靠它 import)。 */
export const BGP_RUNTIME_ZIP_ENTRY = `${BGP_RUNTIME_MODULE}.py`;

/** Code 包在该区 workflowBucket 里的 key(版本 = 运行时内容哈希 ⇒ 改运行时 = 新对象,老 workflow 不受影响)。 */
export const BGP_RUNTIME_S3_KEY = `code/${BGP_RUNTIME_MODULE}-${BGP_RUNTIME_VERSION}.zip`;

/** 固定时刻(2020-01-01T00:00:00Z):让同内容打出逐字节相同的 zip。 */
const FIXED_ENTRY_TIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

function buildZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile(BGP_RUNTIME_ZIP_ENTRY, Buffer.from(BGP_RUNTIME_PY, "utf8"));
  const e = zip.getEntry(BGP_RUNTIME_ZIP_ENTRY);
  if (!e) throw new Error(`Code 包组装失败:找不到条目 ${BGP_RUNTIME_ZIP_ENTRY}`);
  e.header.time = FIXED_ENTRY_TIME; // 见文件头:同内容 ⇒ 同字节
  return zip.toBuffer();
}

/** 运行时 Code 包(zip 字节;模块 `bgp_runtime.py` 在根)。 */
export const BGP_RUNTIME_ZIP: Buffer = buildZip();

export { BGP_RUNTIME_VERSION };
