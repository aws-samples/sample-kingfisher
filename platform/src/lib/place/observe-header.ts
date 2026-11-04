// @kf-batch 50-WP31-place-first-class
// 观测头的名字(零依赖:edge middleware 与 node 侧观测器共用这一处)。
// 🔴 只给观测器读 —— 任何业务代码都不许拿它决定在哪儿执行(scope 只来自 URL,SPEC §2.6.2 规矩 ①;门禁钉住)。
export const OBSERVE_URL_HEADER = "x-bgp-observe-url";
