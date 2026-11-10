// AgentCore Runtime 容器入口:实现契约 /invocations(POST) + /ping(GET),端口 8080。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md §3 契约 1。
// 容器转 ESM(package.json type:module,配合 Strands/agent-runner);require→import。
import http from "node:http";
import { runAgent } from "./agent.js";

const PORT = 8080;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// 只回异常的 message(不回整个异常对象 / 堆栈);非 Error 的抛出物给固定文案,细节只进容器日志。
function errorMessage(e) {
  return e && typeof e.message === "string" && e.message ? e.message : "internal error";
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
      // 参数顾问入参:request(ParamAdviceRequest) 必需 + 可选多轮 history。
      const request = input.request && typeof input.request === "object" ? input.request : null;
      if (!request || !request.channel) {
        return send(res, 400, { error: "缺少 request(需含 channel)" });
      }
      try {
        const out = await runAgent({
          request,
          history: Array.isArray(input.history) ? input.history : [],
          // 平台按运行时配置透传的模型(顶层 payload.modelId,兼容 input.modelId)。
          modelId: typeof payload.modelId === "string" ? payload.modelId : (typeof input.modelId === "string" ? input.modelId : undefined),
        });
        return send(res, 200, { output: out });
      } catch (e) {
        console.error("[invocations] failed:", e);
        return send(res, 500, { error: errorMessage(e) });
      }
    });
    return;
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`paramadvisor-agent listening on :${PORT}`));
