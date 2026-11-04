// 通道共用的出站 HTTP 小工具。3s 超时 + 统一投递结果结构,供钉钉/企微/通用 webhook 复用。
// 出站走平台 ECS 私有子网 NAT(已存在),符合「仅 web 对外、计算私有」红线(主动出站,非暴露端口)。

export interface SendOutcome {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

// POST JSON,3s 超时。onBody 可选:解析响应体做业务级判定(如钉钉/企微的 errcode)。
export async function postJson(
  url: string,
  body: unknown,
  onBody?: (text: string) => string | null // 返回错误说明=业务失败;返回 null=成功
): Promise<SendOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { ok: false, httpStatus: res.status, error: text.slice(0, 300) };
    if (onBody) {
      const bizErr = onBody(text);
      if (bizErr) return { ok: false, httpStatus: res.status, error: bizErr.slice(0, 300) };
    }
    return { ok: true, httpStatus: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "请求超时(3s)" : String(e?.message || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
