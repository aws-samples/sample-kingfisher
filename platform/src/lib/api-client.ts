import { message } from "antd";

export async function apiFetch(url: string, options?: RequestInit): Promise<any> {
  let retries = 0;
  while (retries < 3) {
    try {
      const res = await fetch(url, options);
      const data = await res.json();

      if (!res.ok && !data.success) {
        const errMsg = data.error?.message || `请求失败 (${res.status})`;
        if (res.status !== 401) message.error(errMsg);
        return { success: false, error: { message: errMsg } };
      }

      return data;
    } catch (e: any) {
      retries++;
      if (retries >= 3) {
        message.error("网络异常，请检查连接");
        return { success: false, error: { message: e.message } };
      }
      await new Promise((r) => setTimeout(r, 1000 * retries));
    }
  }
}
