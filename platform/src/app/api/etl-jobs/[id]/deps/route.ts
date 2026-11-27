export const dynamic = "force-dynamic";

// ETL 作业依赖上传:JAR / Python 文件(.py/.whl/.zip/.egg)传到脚本桶 glue-deps/<jobId>/ 下,
// 返回 S3 URI 供表单填入 --extra-jars / --extra-py-files(对齐 Glue console 的依赖库配置)。
//
// 改动前只传**主控区**脚本桶(读主控区的脚本桶 env),不看作业落点 ⇒ 非主控区作业用它上传的依赖,
//   该区的 Glue 角色读不到(仍是 403),文案却说「上传后自动填 S3 URI」。现在按作业**绑定的每个落点**各传一份(同 key,
//   `resolveGlueBinding(targetId).scriptsBucket`,与脚本上传同一作者),返回第一个绑定区(home 优先)的 URI 回填表单;
//   提交到别的区时 `localizePlatformDepUris` 把平台脚本桶形态的依赖 URI 换成该区的桶(lib/execution-role/s3-uris.ts)。
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { bindingTargets, resolveGlueBinding, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { placeErrorResponse } from "@/lib/place/route";
import { PLATFORM_DEP_KEY_PREFIX } from "@/lib/execution-role/s3-uris";
import { PAGE_UPLOAD_MAX_FILE_BYTES, PAYLOAD_TOO_LARGE_CODE, etlDepTooLargeMessage } from "@/lib/http/body-limits";

const USER_ID = "default-user";

const MAX_BYTES = PAGE_UPLOAD_MAX_FILE_BYTES; // 经平台进程上传的单个文件的上限(更大的先放进 S3 再填地址);数值、文案与网关的请求体上限同一处定义
const ALLOWED_EXT = /\.(jar|py|whl|zip|egg)$/i;

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;

  let form: FormData;
  try { form = await req.formData(); } catch { return apiError("请用 multipart/form-data 上传文件(字段名 file)", 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return apiError("请选择要上传的依赖文件(字段名 file)", 400);
  if (!ALLOWED_EXT.test(file.name)) return apiError("仅支持 .jar / .py / .whl / .zip / .egg", 400);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return apiError("文件为空", 400);
  if (buf.length > MAX_BYTES) return apiError(etlDepTooLargeMessage(buf.length), 413, { code: PAYLOAD_TOO_LARGE_CODE });
  // jar/whl/zip/egg 都是 zip 容器,校验魔数;.py 纯文本跳过。
  if (!/\.py$/i.test(file.name) && !(buf[0] === 0x50 && buf[1] === 0x4b)) return apiError("不是有效的 JAR/ZIP 文件", 400);

  const safeName = file.name.replace(/[^A-Za-z0-9_.-]/g, "_");
  const key = `${PLATFORM_DEP_KEY_PREFIX}${params.id}/${safeName}`;
  // 作业绑定的每个落点各传一份(`bindingTargets` 三级回落:targets → targetId → home,恒 ≥ 1;home 排最前)
  const targets = bindingTargets(Item as { targets?: unknown; targetId?: unknown });
  const uploaded: Record<string, string> = {};
  try {
    for (const targetId of targets) {
      const landing = await resolveGlueBinding({ targetId });
      const s3 = await s3ClientFor(landing.region);
      await s3.send(new PutObjectCommand({ Bucket: landing.scriptsBucket, Key: key, Body: buf, ContentType: "application/octet-stream" }));
      uploaded[targetId] = `s3://${landing.scriptsBucket}/${key}`;
    }
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError("上传失败: " + String(e?.message || e), 500);
  }
  const s3Uri = uploaded[targets[0]];
  recordAudit(req, "etl-job.dep.upload", {
    resourceType: "etl-job", resourceId: params.id,
    detail: { fileName: file.name, sizeBytes: buf.length, s3Uri, uploaded },
  }).catch(() => {});
  return apiOk({ s3Uri, fileName: file.name, sizeBytes: buf.length, uploaded }, 201);
}
