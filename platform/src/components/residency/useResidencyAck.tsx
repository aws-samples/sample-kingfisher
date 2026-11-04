"use client";
// @kf-batch 50-W5-seg2-WP10a
// 「409 residency-ack-required ⇒ 弹窗 ⇒ 同意留存 ⇒ 重试」的可复用 hook(直查 / 建模落地 / 作业运行 / 历史原文 都用它,只此一份)。
//
//   const { residencyModal, resolveAckRequired } = useResidencyAck();
//   const { res, body, cancelled } = await fetchWithResidencyAck(url, init, resolveAckRequired);
//   ... 在 JSX 里渲染 {residencyModal}
import React, { useCallback, useRef, useState } from "react";
import DisclaimerModal from "@/components/residency/DisclaimerModal";
import { postResidencyAck, type AckRequiredDetail, type AckResolution } from "@/lib/residency/client";

export function useResidencyAck() {
  const [detail, setDetail] = useState<AckRequiredDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((v: AckResolution) => void) | null>(null);

  const resolveAckRequired = useCallback((d: AckRequiredDetail): Promise<AckResolution> => {
    setError(null);
    setDetail(d);
    return new Promise<AckResolution>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (v: AckResolution) => {
    const r = resolver.current;
    resolver.current = null;
    setDetail(null);
    setBusy(false);
    r?.(v);
  };

  const onAgree = async () => {
    if (!detail) return;
    setBusy(true);
    const r = await postResidencyAck(detail);
    if (!r.ok) {
      // 留存失败 ⇒ 不重试原请求(否则服务端照样 409),把原因显示在弹窗里让用户再点一次
      setBusy(false);
      setError(r.message || "同意记录写入失败");
      return;
    }
    finish("retry");
  };

  const residencyModal = <DisclaimerModal detail={detail} busy={busy} error={error} onAgree={onAgree} onCancel={() => finish("cancel")} />;

  return { residencyModal, resolveAckRequired };
}
