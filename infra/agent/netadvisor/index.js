// AgentCore Runtime 容器入口：实现契约 /invocations(POST) + /ping(GET)，端口 8080。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md §3 契约 1。
// 【模块47 L3】容器转 ESM(package.json type:module,配合 Strands/agent-runner);require→import。
import http from "node:http";
import { runAgent } from "./agent.js";

const PORT = 8080;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ping") {
    return send(res, 200, { status: "healthy" });
  }
  if (req.method === "POST" && req.url === "/invocations") {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on("end", async () => {
      let payload = {};
      try { payload = data ? JSON.parse(data) : {}; } catch { return send(res, 400, { error: "invalid JSON" }); }
      // 兼容 {input:{...}} 或直接 {...}
      const input = payload.input && typeof payload.input === "object" ? payload.input : payload;
      // 网络顾问入参：request(ConnectivityRequest) 必需 + 可选多轮 history。
      const request = input.request && typeof input.request === "object" ? input.request : null;
      if (!request || !request.computeKind || !Array.isArray(request.targets)) {
        return send(res, 400, { error: "缺少 request(需含 computeKind + targets)" });
      }
      try {
        const out = await runAgent({
          request,
          history: Array.isArray(input.history) ? input.history : [],
          // @kf-batch 50-W5-seg2-WP8 — 模块 51:平台按运行时配置透传的模型(顶层 payload.modelId,兼容 input.modelId)。
          modelId: typeof payload.modelId === "string" ? payload.modelId : (typeof input.modelId === "string" ? input.modelId : undefined),
        });
        return send(res, 200, { output: out });
      } catch (e) {
        return send(res, 500, { error: e && e.message ? e.message : String(e) });
      }
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`netadvisor-agent listening on :${PORT}`));
