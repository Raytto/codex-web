import { useId, useState } from "react";
import { SettingMenu, type SettingMenuOption } from "./conversation/SettingMenu";
import type { ParaStage } from "../server/para-types";

export const PARA_STAGES: Record<ParaStage, string> = {
  idea: "想法池", incubating: "准备中", active: "进行中", review: "待验收", done: "已完成", stopped: "已终止",
};

export function ParaStageMenu({ value, onChange, disabled = false, label, filter = false }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  filter?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const options: SettingMenuOption[] = Object.entries(PARA_STAGES).map(([id, label]) => ({
    id, label, indicator: <span className={`para-stage-dot stage-${id}`} aria-hidden="true" />,
  }));
  if (filter) options.unshift({ id: "all", label: "全部项目" });
  return <SettingMenu menuId={id} className={`para-stage-select stage-${value}${filter ? " para-stage-filter" : " para-stage-badge"}`}
    label="" ariaLabel={label} value={value} options={options} placeholder="选择阶段" title={label}
    floating disabled={disabled} open={open} onOpenChange={setOpen}
    onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onChange={onChange} />;
}
