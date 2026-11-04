// OpenMetadata REST client (server-side, used by the platform to push entities + lineage).
// Reaches OM via OPENMETADATA_URL (the OM CloudFront HTTPS URL injected into the platform
// container env). Auth: basic-auth admin login (token cached). All calls are best-effort;
// failures never throw to the caller (metadata push must not break the sync run).

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
const OM_URL = () => (process.env.OPENMETADATA_URL || "").replace(/\/$/, "");

let cachedToken: string | null = null;
let tokenExpiry = 0;
let cachedBot: string | null = null;
let botExpiry = 0;

// OM 中心件的两件密钥(bot token / 管理员口令)共用这一个读取口(一个客户端构造点,棘轮 L3/L4)。
async function readOmSecret(secretId: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const sm = sdkClient("central:openmetadata", SecretsManagerClient, { region: homeRegion() });
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return (SecretString || "").trim();
}

// Preferred auth: the long-lived ingestion-bot JWT stored in Secrets Manager. This is
// decoupled from the human admin password (so the admin password can be rotated freely),
// and the platform task role already has secretsmanager read access.
async function getBotToken(): Promise<string> {
  if (cachedBot && Date.now() < botExpiry) return cachedBot;
  try {
    cachedBot = await readOmSecret(process.env.OM_BOT_SECRET_ID || "bgp/om/ingestion-bot-token");
    botExpiry = Date.now() + 3600 * 1000; // re-read hourly in case the token is rotated
    return cachedBot;
  } catch {
    return "";
  }
}

// 🔴 生产上线批次 A:管理员口令从 Secrets Manager 读(bgp/om/admin-password,OM 栈生成、
//   scripts/om-secure-admin.sh 换进 OM),**不再缺省成出厂口令 admin**(OM 对公网可达,admin/admin = 任何人能登)。
//   读不到 ⇒ 空串 ⇒ 不登录(OM 相关功能如实报不可用),绝不拿出厂口令去试。环境变量 OM_ADMIN_PASSWORD 仍可覆盖(本机开发)。
let cachedAdminPw: string | null = null;
let adminPwExpiry = 0;
async function getAdminPassword(): Promise<string> {
  if (process.env.OM_ADMIN_PASSWORD) return process.env.OM_ADMIN_PASSWORD;
  if (cachedAdminPw !== null && Date.now() < adminPwExpiry) return cachedAdminPw;
  try {
    cachedAdminPw = await readOmSecret(process.env.OM_ADMIN_SECRET_ID || "bgp/om/admin-password");
  } catch {
    cachedAdminPw = "";
  }
  adminPwExpiry = Date.now() + 600 * 1000; // 口令轮换后 10 分钟内生效
  return cachedAdminPw;
}

async function getToken(): Promise<string> {
  // 1) Prefer the ingestion-bot JWT (no password dependency).
  const bot = await getBotToken();
  if (bot) return bot;
  // 2) Fallback: basic-auth admin login (legacy / local dev).
  if (cachedToken && Date.now() < tokenExpiry - 300000) return cachedToken;
  const url = OM_URL();
  if (!url) return "";
  const adminPw = await getAdminPassword();
  if (!adminPw) return "";
  try {
    const res = await fetch(`${url}/api/v1/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.OM_ADMIN_EMAIL || "admin@open-metadata.org",
        password: Buffer.from(adminPw).toString("base64"),
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    cachedToken = data.accessToken || "";
    tokenExpiry = Date.now() + (data.expiryDuration || 3600) * 1000;
    return cachedToken || "";
  } catch {
    return "";
  }
}

export async function omRequest(method: string, path: string, body?: any): Promise<any> {
  const url = OM_URL();
  if (!url) return null;
  let token = await getToken();
  if (!token) return null;
  const doFetch = (t: string) =>
    fetch(`${url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store", // never serve stale OM data from Next.js' fetch Data Cache
    });
  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      cachedToken = null;
      cachedBot = null;
      cachedAdminPw = null; // 口令可能刚被轮换
      botExpiry = 0;
      token = await getToken();
      if (!token) return null;
      res = await doFetch(token);
    }
    // 2xx = ok; 409 = already exists (treat as ok for createOrUpdate semantics)
    return res.ok || res.status === 409 ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

/**
 * 与 `omRequest` 同一条认证 / 重试路径,但**如实回状态**(不把失败压成 null)。
 *
 * 🔴 `omRequest` 对任何失败都回 null ⇒ 「列不出来」与「确实是空的」
 *   分不清。凡是要**据此删除**的调用方(目录对账)必须用本函数:读不清楚就一张都不删(fail-closed)。
 *   `status`:HTTP 状态;0 = 网络 / 解析失败;-1 = OM 没配置或拿不到 token。
 */
export async function omRequestStrict(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; body: any }> {
  const url = OM_URL();
  if (!url) return { ok: false, status: -1, body: null };
  let token = await getToken();
  if (!token) return { ok: false, status: -1, body: null };
  const doFetch = (t: string) =>
    fetch(`${url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      cachedToken = null;
      cachedBot = null;
      cachedAdminPw = null;
      botExpiry = 0;
      token = await getToken();
      if (!token) return { ok: false, status: -1, body: null };
      res = await doFetch(token);
    }
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export async function getEntityByName(entityType: string, fqn: string): Promise<any> {
  return omRequest("GET", `/api/v1/${entityType}/name/${encodeURIComponent(fqn)}`);
}

export function isOmConfigured(): boolean {
  return !!OM_URL();
}
