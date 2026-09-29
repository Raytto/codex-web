import { useId, useState } from "react";
import { SettingMenu } from "./conversation/SettingMenu";
import type { ParaStage } from "../server/para-types";

export const PARA_STAGES: Record<ParaStage, string> = {
  idea: "想法", incubating: "酝酿", active: "进行中", done: "已完成",
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
  const options = Object.entries(PARA_STAGES).map(([id, label]) => ({ id, label }));
  if (filter) options.unshift({ id: "all", label: "全部项目" });
  return <SettingMenu menuId={id} className={`para-stage-select stage-${value}${filter ? " para-stage-filter" : ""}`}
    label="阶段" ariaLabel={label} value={value} options={options} placeholder="选择阶段" title={label}
    floating disabled={disabled} open={open} onOpenChange={setOpen}
    onOpenIntent={() => undefined} onOpenIntentCancel={() => undefined} onChange={onChange} />;
}
