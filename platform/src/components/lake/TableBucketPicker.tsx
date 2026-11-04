"use client";
// (客户 2026-10-16 待改进项)—— S3 Tables 表桶下拉,唯一作者
//   同步任务「S3 Tables 数据湖配置 → Table Bucket」与系统设置「数据湖外部表桶 → 登记」共用。
//   清单来自 GET /api/admin/lake-buckets/candidates?targetId=(只读 ListTableBuckets,lib/lake/table-bucket-candidates)。
//   用 AutoComplete 而不是 Select:清单拉不到(SCP 拒 / 区不可达)时仍能手填,不把用户堵死;选项上标出「该区平台表桶」「已登记」。
//   🔴 落点必须显式给(targetId 空 = 还不知道在哪个区,不拉、不猜主控区)。
// 写意图(同步向导)下:既不是平台表桶也没登记的桶打「未登记」标;选中 / 手填了这样的桶
//   就在输入框下方给出可点提示(非主控区:保存 / 启动会被拒,去登记;主控区:能写但直查 / 治理 / 问数看不到,建议登记)。
//   改动前用户要到「完成」/「启动」被 409 才知道,文案还只说「与执行环境的表桶不一致 ⇒ 拒绝」,没有下一步(客户 2026-10-27 反馈)。
import React, { useEffect, useMemo, useState } from "react";
import { AutoComplete, Tag, Typography } from "antd";
import { useT } from "@/lib/i18n/useT";
import type { TableBucketCandidate, TableBucketCandidates } from "@/lib/lake/table-bucket-candidates";

export interface TableBucketPickerProps {
  /** 列哪个执行环境所在区的表桶(空串 = 还不知道,不拉) */
  targetId: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  /** 不列该区平台表桶(登记外部表桶时它本来就在表树里,登记会被 409) */
  excludePlatform?: boolean;
  /** 不列已登记的外部表桶(再登记一次会被 409) */
  excludeRegistered?: boolean;
  /** 变了就重拉(登记 / 撤销之后让清单跟上) */
  reloadToken?: unknown;
  /**
   * 选中的桶是要**写**的(同步任务 Table Bucket):未登记的桶打「未登记」标,选中 / 手填后出提示与去登记的链接。
   * 系统设置的登记入口不传(它列的本来就都是未登记的)。
   */
  writeIntent?: boolean;
  /** 🔴 Form.Item 经 cloneElement 注入的字段 id(如 `s3Config_tableBucket`)—— 必须原样落到输入框上:
   *  标签 htmlFor 靠它聚焦、校验提示的 aria 关联靠它,换成本组件之前那个 Input 也一直带着它(首版漏传 ⇒ `#s3Config_tableBucket` 消失)*/
  id?: string;
  "data-testid"?: string;
}

type LoadState = { status: "idle" | "loading" | "ok" | "error"; data?: TableBucketCandidates; error?: string };

/** 系统设置页上登记外部表桶那张卡的锚点(app/settings/page.tsx 的 Card id 同值)。 */
export const LAKE_EXT_BUCKETS_ANCHOR = "/settings#lake-ext-buckets";

export interface UnregisteredBucketHint {
  /** exec-env = 非主控区(保存 / 启动会被拒);home = 主控区(能写,但三处读面看不到) */
  kind: "exec-env" | "home";
  targetId: string;
  bucket: string;
}

/**
 * 写意图下,选中 / 手填的桶既不是平台表桶也没登记 ⇒ 要提示(纯函数,判据直接钉)。
 * 清单没拉到(idle / loading / error)⇒ 判不了 ⇒ 不提示(不拿「不知道」吓人);平台表桶按名比(清单里没列到也认)。
 * 主控区还是执行区由清单接口说(`data.home`),页面不按 targetId 字面猜。
 */
export function unregisteredBucketHint(args: {
  writeIntent?: boolean;
  targetId: string;
  value?: string;
  status: LoadState["status"];
  data?: TableBucketCandidates;
}): UnregisteredBucketHint | null {
  const bucket = (args.value ?? "").trim();
  if (!args.writeIntent || !args.targetId || !bucket || args.status !== "ok" || !args.data) return null;
  if (bucket === args.data.platformBucket) return null;
  const hit = args.data.buckets.find((b) => b.name === bucket);
  if (hit?.platform || hit?.registered) return null;
  return { kind: args.data.home ? "home" : "exec-env", targetId: args.targetId, bucket };
}

export default function TableBucketPicker(props: TableBucketPickerProps) {
  const t = useT();
  const { targetId, value, onChange, placeholder, style, disabled, excludePlatform, excludeRegistered, reloadToken, writeIntent } = props;
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // 用户在另一个页签登记完回来点「重新检查」⇒ 重拉清单(登记表变了,服务端早就放行;这里只是让提示跟上,不把人堵在旧提示上)
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    if (!targetId) { setState({ status: "idle" }); return; }
    let alive = true;
    setState({ status: "loading" });
    fetch(`/api/admin/lake-buckets/candidates?targetId=${encodeURIComponent(targetId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.success) throw new Error(d?.error?.message || `HTTP ${r.status}`);
        return d.data as TableBucketCandidates;
      })
      .then((data) => { if (alive) setState({ status: "ok", data }); })
      .catch((e: unknown) => { if (alive) setState({ status: "error", error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [targetId, reloadToken, recheck]);

  const options = useMemo(() => {
    const list = (state.data?.buckets ?? []).filter((b) => !(excludePlatform && b.platform) && !(excludeRegistered && b.registered));
    return list.map((b) => ({ value: b.name, label: <OptionLabel b={b} writeIntent={!!writeIntent} /> }));
  }, [state.data, excludePlatform, excludeRegistered, writeIntent]);

  const notFound = state.status === "loading" ? t("正在列出该区的 S3 Tables 表桶…")
    : state.status === "error" ? t("列不出表桶({e});可直接手填表桶名", { e: state.error || "" })
    : state.status === "ok" && options.length === 0 ? t("该区没有可选的 S3 Tables 表桶;可直接手填")
    : undefined;

  const hint = unregisteredBucketHint({ writeIntent, targetId, value, status: state.status, data: state.data });

  return (
    <>
      <AutoComplete
        id={props.id}
        value={value}
        onChange={(v) => onChange?.(v ? String(v) : undefined)}
        options={options}
        allowClear
        disabled={disabled}
        style={style}
        placeholder={placeholder}
        filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(String(input).toLowerCase())}
        notFoundContent={notFound ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{notFound}</Typography.Text> : null}
        data-testid={props["data-testid"]}
        data-bucket-list-status={state.status}
        data-bucket-list-count={options.length}
      />
      {hint && (
        <div data-testid="table-bucket-unregistered-hint" data-hint-kind={hint.kind} data-bucket={hint.bucket} style={{ marginTop: 4, maxWidth: 420, fontSize: 12, lineHeight: 1.6 }}>
          <Typography.Text type={hint.kind === "exec-env" ? "danger" : "warning"}>
            {hint.kind === "exec-env"
              ? t("表桶 {b} 还没有为执行环境 {tid} 登记:保存 / 启动都会被拒。先去「系统设置 → 数据湖外部表桶」登记(登记一次 = 同步可写入、直查 / 治理目录 / 问数可见),或清空改用平台表桶。", { b: hint.bucket, tid: hint.targetId })
              : t("表桶 {b} 还没有登记:主控区的同步可以写入它,但直查表树 / 治理目录 / 问数看不到里面的表;建议去「系统设置 → 数据湖外部表桶」登记。", { b: hint.bucket })}
          </Typography.Text>{" "}
          <a href={LAKE_EXT_BUCKETS_ANCHOR} target="_blank" rel="noreferrer" data-testid="table-bucket-register-link">{t("去登记 →")}</a>
          {" · "}
          <a onClick={(e) => { e.preventDefault(); setRecheck((n) => n + 1); }} href="#" data-testid="table-bucket-recheck">{t("已登记?重新检查")}</a>
        </div>
      )}
    </>
  );
}

function OptionLabel({ b, writeIntent }: { b: TableBucketCandidate; writeIntent: boolean }) {
  const t = useT();
  const unregistered = writeIntent && !b.platform && !b.registered;
  return (
    <span data-testid="table-bucket-option" data-bucket={b.name} data-platform={b.platform ? "1" : "0"} data-registered={b.registered ? "1" : "0"} data-unregistered={unregistered ? "1" : "0"}>
      <code>{b.name}</code>
      {b.platform && <Tag color="blue" style={{ marginLeft: 8 }}>{t("该区平台表桶")}</Tag>}
      {b.registered && <Tag color="purple" style={{ marginLeft: 8 }}>{t("已登记")}</Tag>}
      {unregistered && <Tag color="orange" style={{ marginLeft: 8 }}>{t("未登记")}</Tag>}
    </span>
  );
}
