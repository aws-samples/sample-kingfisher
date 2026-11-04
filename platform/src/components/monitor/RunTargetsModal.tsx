"use client";

// 「这次在哪些执行范围跑?」运行对话框 —— **单独一个文件**。
//
// 🔴 为什么从 `RunGroupPanel.tsx` 里搬出来(2026-09-15):把它和「多区联动运行」组行列表放在同一个文件里,
//    任何页面只要用这个弹窗,就在**读取级台账**里被算成「这一页读了 `/api/run-groups`」——
//    而 `/workflow` 页只是弹个对话框、压根不读那个接口。棘轮 `UNSCOPED_READ_LIMIT` 于是要为一个
//    **不存在的欠账**放宽(那正是棘轮最怕的事)。搬开之后依赖图与事实一致,棘轮不动。
//
// 🔴 护栏(与 INTERACTION §9 六条同源):
//   · **绝不静默切顶栏的执行范围** —— 这里只决定「这次在哪些区跑」,不动视角;
//   · **按钮复述**要跑几个区、跑哪几个(用户点下去之前必须知道会发生什么)。
import React, { useEffect, useState } from "react";
import { Alert, Checkbox, Modal, Space, Typography } from "antd";
import { useT } from "@/lib/i18n/useT";
import { useScope } from "@/components/scope/ScopeProvider";

const { Text } = Typography;

export function RunTargetsModal({
  open, bindings, onCancel, onRun, busy, verb,
}: {
  open: boolean;
  /** 该定义**绑定**的执行目标(全集)。 */
  bindings: string[];
  onCancel: () => void;
  onRun: (targets: string[]) => void;
  busy?: boolean;
  /** 「立即运行」/「试运行」等动词 —— 复述文案里要用。 */
  verb?: string;
}) {
  const t = useT();
  const { scope } = useScope();
  const [picked, setPicked] = useState<string[]>([]);

  // 🔴 **默认跟随视角**:target 视角只勾本区(前提是它在绑定里)、其余视角全勾。
  //    刻意每次打开都重算 —— 用户切了视角再点运行,默认值必须跟着变。
  useEffect(() => {
    if (!open) return;
    if (scope.kind === "target" && bindings.includes(scope.targetId)) setPicked([scope.targetId]);
    else if (scope.kind === "compare") {
      const inBinding = scope.targetIds.filter((x) => bindings.includes(x));
      setPicked(inBinding.length ? inBinding : bindings);
    } else setPicked(bindings);
  }, [open, scope, bindings]);

  const n = picked.length;
  const okText =
    n === 0
      ? t("请选择至少一个执行范围")
      : n === 1
      ? t("{verb} · {where}", { verb: verb || t("立即运行"), where: picked[0] })
      : t("{verb}({n} 个区各跑一次)", { verb: verb || t("立即运行"), n });

  return (
    <Modal open={open} onCancel={onCancel} onOk={() => onRun(picked)} okButtonProps={{ disabled: n === 0, loading: busy }}
           okText={okText} cancelText={t("取消")} data-testid="run-targets-modal" title={t("这次在哪些执行范围跑?")}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} data-testid="run-targets-scope-hint"
             message={scope.kind === "target"
               ? t("默认只跑当前执行范围({tid});勾选别的区**不会**改变顶栏的执行范围。", { tid: scope.kind === "target" ? scope.targetId : "" })
               : t("默认在该作业绑定的全部 {m} 个区各跑一次。", { m: bindings.length })} />
      <Checkbox.Group value={picked} onChange={(v) => setPicked(v as string[])} data-testid="run-targets-choices">
        <Space direction="vertical">
          {bindings.map((b) => (
            <Checkbox key={b} value={b} data-testid={`run-target-opt-${b}`}>{b}</Checkbox>
          ))}
        </Space>
      </Checkbox.Group>
      {n > 1 && (
        <Text type="secondary" style={{ display: "block", marginTop: 12, fontSize: 12 }} data-testid="run-targets-group-hint">
          {t("这 {n} 次运行会归到**同一个联动运行**里,可以整组查看、一键取消未完成、只重试失败的区。", { n })}
        </Text>
      )}
    </Modal>
  );
}

