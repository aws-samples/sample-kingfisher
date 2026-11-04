"use client";

import React, { useState, useEffect } from "react";
import { Radio, InputNumber, Select, Space, Tag } from "antd";
import { useT } from "@/lib/i18n/useT";

interface Props { value?: string; onChange?: (cron: string) => void; }

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export default function CronEditor({ value, onChange }: Props) {
  const t = useT();
  const [type, setType] = useState<"minute" | "hourly" | "daily" | "weekly" | "monthly" | "custom">("daily");
  const [minute, setMinute] = useState(0);
  const [hour, setHour] = useState(2);
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  const [interval, setInterval] = useState(5);
  const [customCron, setCustomCron] = useState(value || "0 2 * * *");

  useEffect(() => {
    if (!value) return;
    // Parse existing cron to set UI state
    const parts = value.split(" ");
    if (parts.length === 5) {
      const [m, h, dom, , dow] = parts;
      if (m.includes("/")) { setType("minute"); setInterval(parseInt(m.split("/")[1]) || 5); }
      else if (dow !== "*" && dom === "*") { setType("weekly"); setWeekday(parseInt(dow)); setHour(parseInt(h)); setMinute(parseInt(m)); }
      else if (dom !== "*") { setType("monthly"); setMonthday(parseInt(dom)); setHour(parseInt(h)); setMinute(parseInt(m)); }
      else if (h !== "*") { setType("daily"); setHour(parseInt(h)); setMinute(parseInt(m)); }
      else if (m !== "*") { setType("hourly"); setMinute(parseInt(m)); }
    }
  }, []);

  const buildCron = (ty: string, m: number, h: number, wd: number, md: number, iv: number) => {
    switch (ty) {
      case "minute": return `*/${iv} * * * *`;
      case "hourly": return `${m} * * * *`;
      case "daily": return `${m} ${h} * * *`;
      case "weekly": return `${m} ${h} * * ${wd}`;
      case "monthly": return `${m} ${h} ${md} * *`;
      default: return customCron;
    }
  };

  const update = (ty: string, m: number, h: number, wd: number, md: number, iv: number) => {
    const cron = buildCron(ty, m, h, wd, md, iv);
    onChange?.(cron);
  };

  const getNextRuns = (cron: string, count = 5): string[] => {
    // Simple next run calculation for common patterns
    const now = new Date();
    const results: string[] = [];
    const parts = cron.split(" ");
    if (parts.length !== 5) return [];
    const [cm, ch, cdom] = parts;
    const dow = parts[4];

    for (let d = 0; d < 30 && results.length < count; d++) {
      const date = new Date(now.getTime() + d * 86400000);
      const h = ch === "*" ? 0 : parseInt(ch);
      const m = cm.includes("/") ? 0 : (cm === "*" ? 0 : parseInt(cm));
      date.setHours(h, m, 0, 0);

      if (date <= now) continue;
      if (dow !== "*" && date.getDay() !== parseInt(dow)) continue;
      if (cdom !== "*" && date.getDate() !== parseInt(cdom)) continue;

      results.push(date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" }));
    }
    return results;
  };

  const currentCron = buildCron(type, minute, hour, weekday, monthday, interval);
  const nextRuns = getNextRuns(currentCron);

  return (
    <div style={{ border: "1px solid #1d4254", borderRadius: 8, padding: 16 }}>
      <Radio.Group value={type} onChange={(e) => { setType(e.target.value); update(e.target.value, minute, hour, weekday, monthday, interval); }} style={{ marginBottom: 12 }}>
        <Radio.Button value="minute">{t("每N分钟")}</Radio.Button>
        <Radio.Button value="hourly">{t("每小时")}</Radio.Button>
        <Radio.Button value="daily">{t("每天")}</Radio.Button>
        <Radio.Button value="weekly">{t("每周")}</Radio.Button>
        <Radio.Button value="monthly">{t("每月")}</Radio.Button>
        <Radio.Button value="custom">{t("自定义")}</Radio.Button>
      </Radio.Group>

      <div style={{ marginBottom: 12 }}>
        {type === "minute" && (
          <Space>{t("每")} <InputNumber min={1} max={59} value={interval} onChange={(v) => { setInterval(v || 5); update(type, minute, hour, weekday, monthday, v || 5); }} /> {t("分钟执行一次")}</Space>
        )}
        {type === "hourly" && (
          <Space>{t("每小时的第")} <InputNumber min={0} max={59} value={minute} onChange={(v) => { setMinute(v || 0); update(type, v || 0, hour, weekday, monthday, interval); }} /> {t("分钟")}</Space>
        )}
        {type === "daily" && (
          <Space>{t("每天")} <InputNumber min={0} max={23} value={hour} onChange={(v) => { setHour(v || 0); update(type, minute, v || 0, weekday, monthday, interval); }} /> {t("时")} <InputNumber min={0} max={59} value={minute} onChange={(v) => { setMinute(v || 0); update(type, v || 0, hour, weekday, monthday, interval); }} /> {t("分")}</Space>
        )}
        {type === "weekly" && (
          <Space>{t("每")} <Select value={weekday} onChange={(v) => { setWeekday(v); update(type, minute, hour, v, monthday, interval); }} style={{ width: 80 }} options={WEEKDAYS.map((d, i) => ({ label: t(d), value: i }))} /> <InputNumber min={0} max={23} value={hour} onChange={(v) => { setHour(v || 0); update(type, minute, v || 0, weekday, monthday, interval); }} /> {t("时")} <InputNumber min={0} max={59} value={minute} onChange={(v) => { setMinute(v || 0); update(type, v || 0, hour, weekday, monthday, interval); }} /> {t("分")}</Space>
        )}
        {type === "monthly" && (
          <Space>{t("每月")} <InputNumber min={1} max={28} value={monthday} onChange={(v) => { setMonthday(v || 1); update(type, minute, hour, weekday, v || 1, interval); }} /> {t("日")} <InputNumber min={0} max={23} value={hour} onChange={(v) => { setHour(v || 0); update(type, minute, v || 0, weekday, monthday, interval); }} /> {t("时")} <InputNumber min={0} max={59} value={minute} onChange={(v) => { setMinute(v || 0); update(type, v || 0, hour, weekday, monthday, interval); }} /> {t("分")}</Space>
        )}
        {type === "custom" && (
          <Space>Cron: <input value={customCron} onChange={(e) => { setCustomCron(e.target.value); onChange?.(e.target.value); }} style={{ width: 200, padding: "4px 8px", background: "#0c1c28", color: "#cfe6f0", border: "1px solid #1d4254", borderRadius: 4 }} /></Space>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <Tag color="blue" style={{ fontSize: 13 }}>Cron: {currentCron}</Tag>
        {nextRuns.length > 0 && (
          <div style={{ fontSize: 12, color: "#888" }}>
            <div style={{ fontWeight: 500, marginBottom: 4 }}>{t("下次执行:")}</div>
            {nextRuns.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
