# PP Dot task routing / 任务选型

PP Dot can preview a proposed task before creating it. The coordinator refreshes the target node's actual model catalogue, checks availability, then records the selected model/depth and reason with the task. It never moves the task to another node to hide a failure. Explicit user choices take precedence; invalid model/depth combinations fail without silent downgrade. Existing tasks use their original thread and selection when steered.

公开默认使用目标节点当前默认选择，不内置个人的模型排序、研究引擎或最高思考偏好。任务类型和难度只作为可配置选型依据，不构成“模型已读取视频”的证据。

Optionally set `CODEX_WEB_DOT_ROUTING_POLICY` in the private app `.env` to JSON. Keys may be `general`, `youtube`, `web_research`, `gemini_specialist`, or one of those followed by `:simple`, `:standard`, `:complex`. Specific difficulty keys override the type-wide entry. Values contain exactly `model` and `reasoningEffort`, copied from that target node's authenticated catalogue. No additional key or paid account is needed beyond the selected model's own authorization and billing.

```dotenv
CODEX_WEB_DOT_ROUTING_POLICY='{"web_research":{"model":"<model-id-from-node-catalogue>","reasoningEffort":"<supported-effort>"}}'
```

The example is a placeholder and cannot execute as-is. Recreate app after configuring. Ask PP Dot to call `task_preview` for a small proposal, check returned project/node/selection and `dispatched:false`, then create the task and compare its persisted routing evidence. If a configured model is absent on that node, execution is blocked; remove or correct that rule. Set `{}` and recreate app to restore node-default behavior. Changing policy does not recreate or retarget existing tasks.

安装步骤：从账号管理/目标节点的真实目录取得模型 ID 与支持的深度，填上述私有配置，重新创建 app；先核对只读预览，再做一个小任务。移除策略即关闭自动覆盖；已有任务和台账保留。Gemini 专项仍须提供实际能力依据。视频研究必须说明拿到的是画面、音轨、字幕还是仅网页资料；选中模型不等于看过视频。
