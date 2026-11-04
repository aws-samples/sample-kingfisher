// **免责告知文案**的唯一作者(50 SPEC v3.22 §1.1 `residencyAck` / §1.3a S13;INTERACTION v2.17 §4bis.4;DESIGN §18 决策 6quinquies ④)。
//
// 用户 2026-09-05 原话:「可以弹窗告知担责说明。这个是有必要的。而且这种弹窗等用户同意之后,可以保留用户的选择,避免扯皮。」
// 「告知我们不承担任何法律相关的风险,需要用户自行根据当地政府法律法规去做数据合规相关约束和管控。」
//
// 🔴 三条纪律:
//   ① 文案**只在这里**定义(页面不得自己拼;ACCEPTANCE  A1 门禁扫全仓);
//   ② 文案**不得**出现「由你担责 / 数据出境 / 法务备案」之类平台替客户下的法律定性 —— 平台只说自己不承担、客户自管;
//   ③ **版本 + 文本哈希一起留存**:同意记录绑的是「这一版这段字」,文案一改版本号必须跟着改(单测钉 hash)。
//
// 🔴 本文件必须**客户端可 import**(向导 / 弹窗要显示文案)⇒ 不用 node:crypto;hash 预计算成常量,由单测重算核对。

export const DISCLAIMER_VERSION = "v1";

export const DISCLAIMER_TEXT =
  "本平台不承担任何与数据跨境、数据合规相关的法律风险。您需要自行依据当地政府法律法规,对数据合规做出约束与管控。点击〔同意并继续〕表示您已知悉并同意。";

/** sha256(DISCLAIMER_TEXT) 的十六进制;单测 `disclaimer.test.ts` 用 node:crypto 重算并断言相等(改文案不改 hash ⇒ 红)。 */
export const DISCLAIMER_TEXT_HASH = "2e60158ba89866a2ad6f58fb8ead3ed38f6e263cb509015672e45403c8fd0e9f";

/** 注册 / 同意请求里客户端要回传的 ack 形状(服务端逐字核对,不信客户端说的版本)。 */
export interface DisclaimerAck {
  version: string;
  textHash: string;
}

export function currentDisclaimerAck(): DisclaimerAck {
  return { version: DISCLAIMER_VERSION, textHash: DISCLAIMER_TEXT_HASH };
}

/** 客户端回传的 ack 是否**逐字**等于当前版本(版本与哈希都要对;任一不对 = 用户看到的不是这一版)。 */
export function isCurrentDisclaimerAck(raw: unknown): raw is DisclaimerAck {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as { version?: unknown; textHash?: unknown };
  return r.version === DISCLAIMER_VERSION && r.textHash === DISCLAIMER_TEXT_HASH;
}
