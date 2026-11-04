export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";

const OM_INTERNAL_URL = process.env.OPENMETADATA_URL || "";
const OM_PUBLIC_URL = process.env.OPENMETADATA_PUBLIC_URL || "";

export async function GET() {
  if (!OM_INTERNAL_URL) return NextResponse.json({ error: "OPENMETADATA_URL 未配置" });

  try {
    const res = await fetch(`${OM_INTERNAL_URL}/api/v1/system/version`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const version = await res.json();
      return NextResponse.json({ url: OM_PUBLIC_URL || OM_INTERNAL_URL, version: version.version });
    }
    return NextResponse.json({ error: "OpenMetadata 服务未就绪" });
  } catch {
    return NextResponse.json({ error: "无法连接 OpenMetadata 服务" });
  }
}
