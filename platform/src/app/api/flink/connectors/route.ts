export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, getActiveEnv } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listConnectors, createConnector, uploadConnectorJar } from "@/lib/realtime/flink-connectors";

const MAX_BYTES = 250 * 1024 * 1024; // 单个连接器 JAR ≤250MB(MSAF 合并后 uber-jar ≤512MB)

// GET /api/flink/connectors — 列出当前项目+环境的自定义连接器。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const items = await listConnectors(ctx.projectId, getActiveEnv(req));
    return apiOk(items);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/flink/connectors — 上传连接器 JAR(multipart: file + name + connectorIdentifier)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  let form: FormData;
  try { form = await req.formData(); } catch { return apiError("请用 multipart/form-data 上传 JAR 文件", 400); }
  const file = form.get("file");
  const name = String(form.get("name") || "").trim();
  const connectorIdentifier = String(form.get("connectorIdentifier") || "").trim();
  if (!(file instanceof File)) return apiError("请选择要上传的连接器 JAR 文件(字段名 file)", 400);
  if (!connectorIdentifier || !/^[A-Za-z0-9_.-]+$/.test(connectorIdentifier)) {
    return apiError("请填写连接器标识(Flink SQL 中 'connector'='<标识>' 的值,如 opensearch-2)", 400);
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return apiError("文件为空", 400);
  if (buf.length > MAX_BYTES) return apiError("JAR 过大(≤250MB)", 400);
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return apiError("不是有效的 JAR/ZIP 文件", 400);

  // 解析 JAR 内的 Flink 工厂 SPI(best-effort),供 UI 展示该连接器提供的工厂类。
  let factories: string[] = [];
  try {
    const zip = new AdmZip(buf);
    const spi = zip.getEntry("META-INF/services/org.apache.flink.table.factories.Factory");
    if (spi) factories = spi.getData().toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  } catch { /* 非致命:仍允许上传 */ }

  try {
    const { s3Key, sizeBytes } = await uploadConnectorJar(buf, file.name);
    const c = await createConnector({
      name: name || file.name,
      connectorIdentifier,
      fileName: file.name,
      s3Key,
      sizeBytes,
      projectId: ctx.projectId,
      env: getActiveEnv(req),
      createdBy: ctx.identity.username,
      ...(factories.length ? { factories } as any : {}),
    } as any);
    recordAudit(req, "flink.connector.upload", { resourceType: "flink", resourceId: c.connectorId, detail: { name: c.name, connectorIdentifier, sizeBytes } }).catch(() => {});
    return apiOk(c, 201);
  } catch (e: any) {
    return apiError("上传失败: " + String(e?.message || e), 500);
  }
}
