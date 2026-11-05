// 2026-11-04(2026-11-04)—— 页面读「错误信封里的可读文案」的**唯一作者**(零服务端 import;浏览器与判据共用)。
//
// 【缺陷原形(2026-11-04 两区测试环境页面驱动,补数中心「预览实例」)】页面写的是 `message.error(d?.error || t("预览失败"))`,
//   而服务端标准信封是 `{ success:false, error:{ message, code } }`(lib/api-response.ts#apiError;非 JSON 错误页的全局拦截器把非 JSON 错误页
//   也整形成同形)⇒ `d.error` 是**对象**不是字串 ⇒ antd message 收到一个对象当子节点 ⇒ React error #31(页面驱动判据抓到 pageerror)
//   ⇒ **零提示**:用户只看到按钮按了没反应、预览块不出现、「确认创建」一直灰着,完全不知道服务端拒绝的原因。
//   同形共 8 处:补数页 3(预览 / 创建 / 控制)· FinOps 3(预算保存 / 异常检测 / 采集)· 告警 SLA 2(保存 / 学习)。
// 【根治】一个读法、永远返回字串:对象信封取 `error.message`;Next 老路由形态 `{ error: "字串" }` 取字串;都没有 ⇒ 调用方给的兜底文案。
//   `deleteJson`(「删除不看响应」修复)原先内联的同一段判断改为 import 这里 ⇒ 全仓只剩一个作者;守卫(error-envelope.test)钉住
//   「`message.xxx(<信封>.error || …)` 这种把对象递给 antd 的写法」零命中,新页面再写一处就红。

type ErrorEnvelopeLike = { error?: { message?: unknown; code?: unknown } | string | null; [k: string]: unknown };

/** 信封里的可读文案;没有可读文案 ⇒ `fallback`。永远返回字串(可以直接递给 antd message / Alert)。 */
export function errorMessageOf(body: unknown, fallback: string): string {
  const err = body && typeof body === "object" ? (body as ErrorEnvelopeLike).error : undefined;
  const msg = err && typeof err === "object" ? err.message : typeof err === "string" ? err : undefined;
  return msg ? String(msg) : fallback;
}

/** 信封里的机器可读错误码(`error.code`);老形态 / 缺失 ⇒ `undefined`。 */
export function errorCodeOf(body: unknown): string | undefined {
  const err = body && typeof body === "object" ? (body as ErrorEnvelopeLike).error : undefined;
  const code = err && typeof err === "object" ? err.code : undefined;
  return typeof code === "string" && code ? code : undefined;
}
