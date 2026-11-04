// 极简 MCP(Streamable HTTP)客户端 + SigV4(service=bedrock-agentcore)。
// 用于 Agent(Runtime)→ Gateway(AWS_IAM 入站)调用 MCP 工具。
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { fetch } from "undici";

export class MCPClient {
  constructor(gatewayUrl, region) {
    this.url = new URL(gatewayUrl);
    this.region = region;
    this.sessionId = null;
    this.nextId = 1;
    this.signer = new SignatureV4({
      service: "bedrock-agentcore",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  async _post(body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    const headers = {
      host: this.url.host,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...extraHeaders,
    };
    const req = new HttpRequest({
      method: "POST",
      protocol: this.url.protocol,
      hostname: this.url.hostname,
      path: this.url.pathname,
      headers,
      body: payload,
    });
    const signed = await this.signer.sign(req);
    const res = await fetch(this.url.toString(), {
      method: "POST",
      headers: signed.headers,
      body: payload,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok && !text) throw new Error(`MCP HTTP ${res.status}`);
    return this._parse(text, res.status);
  }

  _parse(text, status) {
    if (!text) return null;
    // SSE: 取最后一个 data: 行的 JSON
    if (text.includes("data:")) {
      const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      for (let i = datas.length - 1; i >= 0; i--) {
        try { return JSON.parse(datas[i]); } catch {}
      }
    }
    try { return JSON.parse(text); } catch { 
      throw new Error(`MCP 响应解析失败(status ${status}): ${text.slice(0, 200)}`);
    }
  }

  async init() {
    const r = await this._post({
      jsonrpc: "2.0", id: this.nextId++, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bgp-genbi-agent", version: "1.0.0" } },
    });
    if (r && r.error) throw new Error(`MCP initialize 失败: ${JSON.stringify(r.error).slice(0,200)}`);
    // 通知 initialized（无 id，无需结果）
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    return r;
  }

  async listTools() {
    const r = await this._post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} });
    return (r && r.result && r.result.tools) || [];
  }

  // 调用工具，返回解析后的工具结果对象（我们的 Lambda 返回 JSON）。
  async callTool(name, args) {
    const r = await this._post({
      jsonrpc: "2.0", id: this.nextId++, method: "tools/call",
      params: { name, arguments: args || {} },
    });
    if (r && r.error) return { success: false, error: JSON.stringify(r.error).slice(0, 300) };
    const result = r && r.result;
    if (!result) return { success: false, error: "工具无返回" };
    // 优先 structuredContent；否则取 text 内容解析 JSON。
    if (result.structuredContent) return result.structuredContent;
    const content = result.content || [];
    for (const c of content) {
      if (c && (c.type === "text" || typeof c.text === "string")) {
        try { return JSON.parse(c.text); } catch { return { success: true, text: c.text }; }
      }
      if (c && c.type === "json" && c.json) return c.json;
    }
    return { success: false, error: "工具结果为空", raw: result };
  }
}
