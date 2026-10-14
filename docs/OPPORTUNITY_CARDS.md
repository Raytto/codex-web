# Opportunity cards

机会卡片是可选账号功能，入口与项目看板并列。缺失或无效的 `opportunityCards` 标志默认为 false；旧客户端只更新 `paraBoard` 时保留新标志。显隐不删除内容，也不暂停已经由用户启用的原生周期任务。

## Execution and ownership

唯一执行链为服务器 `projects` → `recurring_tasks` → 普通 `conversations` / `jobs` → `codex_web_opportunities` → 主题批次与卡片。没有独立模型执行器、周期表或 Agent 循环。原生周期任务保存 prompt、模型、深度、日程和启停；主题保存目标摘要、约束、推荐上限、探索比例、项目内知识库相对入口及绑定 ID。配置自动发现先创建暂停的原生计划，用户在原编辑页启用；也可关联同一服务器项目已有计划。

可选宿主桥账号只接受自身 `local-host` 项目；普通账号只接受自身 `tenant-local` 项目。入口选择远程工程不改变主题路由。自动化 API 复用在运行 Job 的短期签名凭据，并核对真实会话账号、项目及执行器，不接受调用者指定的 user ID。既有网页 API 继续使用登录、CSRF 与同源校验。

新线程提供动态工具；旧线程可用相同受控接口的 `node "$CODEX_WEB_OPPORTUNITY_CLI" request.json`。CLI 从运行环境读取 Job 凭据，不将凭据放到参数或结果。远程 Worker 没有这条能力，服务端也拒绝远程项目的调用。

## Business states and idempotency

- 新候选先存 `opportunity_candidates` 原始内容及稳定 key，再进入独立 review 操作；初筛淘汰不形成用户负面反馈。
- `opportunity_ideas` 是账号内稳定想法身份。规范化结构指纹拦截完全重复；全结构概念归一、字符向量余弦召回相似项，再由正常 Agent 比较核心机制和实质差异。不是标题哈希，也不是开放语义绝对唯一保证。代表性中文同义/近似/实质不同案例见测试。
- 状态分为 pending、reserve、recommended、kept、later、dismissed、internal_rejected、expired、project、duplicate。备用项不是失败或负面偏好。
- 每轮必须复评所有尚未正式推荐、未人工处理且仍有效的备用与新候选；通过基本质量门槛但未入选的继续留库。发表至少要求质量 60/100、有来源、已完成相似项比较。数量可以小于上限或为零，必须说明原因。
- 每主题按关联计划时区的自然日只有一个批次；手动发现与原生调度共享此幂等边界。已经处理或仍在执行的同日调度记录为 skipped，不另建重复会话。计划频率小于一天时仍遵守每天一次正式精选。
- 正常会话创建时同步预留业务批次，Agent 尚未首次调用工具就失败/停止也可显示失败。失败保留候选；显式重试同日最多三次，每轮最多 60 个新候选。次数受持久行约束，无自动无限重试。
- 推荐只写一次 `first_recommended_at` 和 `recommended_batch_id`；从旧备用晋升保留首次生成批次、会话和时间。已推荐/人工处理项不能再变成新推荐。新证据保存到原卡版本，合并不自动恢复被淘汰项。
- 原生暂停/删除只停止未来触发，已建会话仍按原生命周期管理。归档主题暂停关联计划，恢复主题不自动恢复计划；删除主题软隐藏并删除关联计划，保留查重历史。未提供“彻底忘记”按钮。
- 历史会话/Job ID 是溯源，不是授权；正常会话 GC 不被卡片反向外键阻塞。已删除来源不能重新访问，稳定想法仍参与查重。转看板后删除看板项目会清除关联指针，保留卡片。

## Evidence corrections

正常主题服务器项目会话中的 `evidence` action 支持补充/更正旧卡来源、事实、假设、疑点、验证及成熟条件。先 detail 读取 revision；提交 requestKey、revision、reason 和有限 patch。sources 为完整替换列表，允许移除不相关引用。每次记录更正前完整内容、原因及会话；详情历史可以展开这些证据。无需新批次，不改稳定身份、首次推荐、状态、人工反馈或历史评分。仅运行Job凭据可用，同账号/主题/服务器项目与版本冲突校验保持。证据变化使未发布评审失效，复评后才能发布；幂等重试不重复生成版本。

## Feedback and research

原始人工反馈逐次入账，可评分、备注、保留、暂放、淘汰、失效和撤销。原因分别记录 no_time、vague、evidence、duplicate、direction、outdated、other；未读和无备注淘汰仅弱信号。当前反馈、目标及偏好组成版本签名；评审期间被修改则提交精选冲突，要求读取最新内容复评。

提炼偏好保存 explicit/inferred、来源、时间和作用域。Agent 提炼只能作用于主题；用户可在 UI 明确扩大至本项目或本人全部主题，也可修正/撤销。已撤销反馈不应继续被当作有效负面证据。授权 `read_recent` 后按本账号消息水位增量读取最近 30 天相关用户消息，排除内部/定时指令；只把相关偏好写回，不复制无关私人内容。首次之外不会反复全量扫描。每次最多 120 条扫描，提示最多十页，水位在成功发表时保存。

研究必须经用户点击或明确对话要求，创建主题服务器项目中的正常会话。研究结果回写 validated / invalidated / inconclusive，感兴趣不等于验证有效。转项目复用现有 `para_projects` 想法池、brief 和会话关联，不把其 ID 当作执行工程 ID。项目看板关闭时先明确开启；没有看板时可命名创建。不会自动交易、购买、联系第三方、开发或发布。

## UI and validation

页面复用现有 CSS token、紧凑周期页、侧栏功能区和 `ui-dialog`。默认展示全部未反馈候选，备用单列；工作总览、暂放/已反馈、已淘汰及初筛记录分别展示，不把已研究或转项目的卡片混入待反馈列表。完整依据、事实/假设、最强疑点、最小验证及来源在卡片详情。移动端折叠目标，保留明显的计划编辑、来源及返回路径。

自动化涵盖迁移、旧设置保留、真实认证路由/CSRF、跨账号与远程执行拒绝、10→3+7/17→3+14 库存结转、稳定身份、重试、中文改写/跨主题/新证据、反馈撤销/复评/过时、原生调度归属与 prompt、来源 GC、研究/看板关联。运行 `npm test` 和 Docker test stage。

上线还必须完成真实短期登录、正式浏览器及正常 Agent/原生调度验收，不能以此文档或合成内容代表模型采集通过。部署者应记录自己的验收版本、测试范围及设备限制；默认没有主题、卡片、自动计划或业务记录。

## Topic navigation and feedback learning

The sidebar lists each topic, supports search, drag ordering and rename/archive/restore actions, and keeps the pending count visible beside long names. Counts cover all unprocessed recommended cards, including older days and later pages; reserve, feedback and work items do not count. A stale topic response cannot replace the current selection. Feedback can be recorded by typing or optional voice input; recording and retry state stay with the feedback field. Voice remains unavailable without the operator's own provider configuration.

Each normal discovery run drains `feedback_inbox` in pages of 30 and confirms `learn_feedback` before ingest, review or publish. The service checks cursor, feedback revision, ownership and idempotency. Revoked/updated feedback must be interpreted using the current card state. With no knowledge entry, reusable principles are saved transactionally in the topic database. With a project-relative Markdown entry such as `knowledge/README.md`, that knowledge tree is authoritative: the normal project agent writes condensed principles and feedback references, then acknowledges the affected Markdown paths. No second page-level principles copy is injected. File writing and the database acknowledgment are separate operations; after acknowledgment failure the agent must check references before retrying. Paths are validated syntactically; the acknowledgment does not independently prove file contents or quality.

No new provider, environment variable or background model runner is introduced. The feature is off by default; no real topics, knowledge files, learned principles or schedules are bundled. Operators create their own project knowledge and explicitly enable schedules.

## Upgrade and migration

Back up the operator's own database and state before upgrading. Startup migrations `2026101403`, `2026101404` and `2026101405` add per-user topic order, feedback-learning progress/history and optional project-knowledge paths; existing topics and feedback remain, and old feedback initially awaits learning. Run the existing build/deploy workflow and verify SQLite integrity plus owner isolation after upgrade. Do not overwrite state with source or sample data. The environment template and Compose defaults need no new keys for this increment. A rollback of code does not restore the database; retain the pre-upgrade backup for an intentional data restore.
