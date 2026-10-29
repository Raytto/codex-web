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

“深入研究”默认选择主题工程，也可选择本人其他未归档服务器工程；点击后只在所选工程创建正常会话及持久输入框草稿，不创建待发送项、消息或 Job。用户可补充、刷新或切换会话，手动发送后才执行研究。草稿包含卡片、当前已保存评分/备注、按时间排序的本卡反馈历史（含撤销），并要求逐项验证用户的具体思路；当前表单有未保存修改时单列为本次补充，不自动覆盖卡片反馈。相同 requestKey 重试复用会话且不覆盖已编辑草稿。“发现一次”及原生周期发现仍按原流程执行。

跨工程研究会话通过真实关联授权：可读取本主题 context 和本卡 detail、以 research_result 写回本卡，不能发现、入库、评审、学习偏好或修改其他卡片。来源知识库使用原主题工程的绝对路径；详情和工作总览从实际研究会话解析目标工程，删除会话后禁用链接。重复 requestKey 换工程会冲突，避免误用旧会话。

研究结果回写 validated / invalidated / inconclusive，感兴趣不等于验证有效；未写回结果时统一显示“待研究”，可从工作总览继续。转项目复用现有 `para_projects` 想法池、brief 和会话关联，不把其 ID 当作执行工程 ID。项目看板关闭时先明确开启；没有看板时可命名创建。不会自动交易、购买、联系第三方、开发或发布。

## UI and validation

从机会卡片打开会话或周期任务时直接进入目标页面，不附加“返回机会卡片”栏，也不保留跨会话的返回状态。机会主题仍可通过侧栏打开。

侧栏在“扩展功能”下统一收纳“机会卡片”和“项目看板”两个可折叠分类。默认收起；分类展开及顺序按账号保存在本浏览器，搜索时临时展开。分类可拖动/键盘排序，顶层三点提供功能选择与全部展开/收起；独立功能开关保持原有跨设备同步，两者关闭时隐藏整个扩展区。看板条目只打开看板，不再展开内部项目，文件夹工程不变。分类与条目的三点菜单保留新建/改名/归档等入口。点击主题直接进入其专属卡片页，名称筛选沿用全局侧栏搜索；主题名称后以括号显示待审批数量（含0），与默认未反馈候选使用同一筛选条件，涵盖旧日及分页外候选，不计备用、已反馈或进入工作的卡片；长名称截断时数量保持可见。主题新增、改名、归档、恢复和删除，以及卡片反馈/撤销/研究/转看板成功后刷新列表。`GET /api/opportunities/topics` 仅返回本人未删除主题，含归档标记与聚合的 pending_count，不返回卡片/批次正文；切换主题的过期响应不能覆盖新选择。全部主题视图仍可从分区底部进入。

反馈备注复用看板文字框与会话录音控制，录音上限 10 分钟。停止录音后将音频交给页面级独立上传队列，按账号、卡片和录音 UUID 保存，支持同卡或多卡并行上传。此后保留、暂放、淘汰、关闭详情及导航均不等待上传；处理动作成功会收起详情。队列显示上传、识别、已保存及失败重试，服务器确认音频持久保存后才清理浏览器草稿，丢失响应按同一录音 ID 重试不会重复反馈。未确认上传的录音在本机保留最多 24 小时，刷新后列出全部待重试项；浏览器存储不可用时明确提示不要关闭网页。收起弹窗不会中断上传，不承诺浏览器被关闭或操作系统挂起后仍持续联网。

录音携带录制时的卡片 revision，迁移 2026102901 仅增加可空 base_revision，旧队列保持兼容。后到音频按原 revision 合并其间的自动语音追加，不能用过期输入覆盖前一段识别内容；人工改动继续优先保留。服务器识别完成后追加反馈，保留用户所选卡片状态；仍沿用备注 6000 字上限、失败录音保留和手工编辑冲突保护。录音进行中及短暂本地交接仍锁定处理动作，已交接的上传/识别/失败不会锁住下一条录音。

页面复用现有 CSS token 和 `ui-dialog`。每次进入主题默认只显示尚未反馈候选（包括旧日未读），顶部提供待反馈、备用、已保留与已完成分类；下方也有带数量的已保留、已完成、工作总览、暂放/已反馈、已淘汰和初筛记录入口。已保留专列当前 kept 卡片；工作总览还包含已启动研究与看板项目。选择全部主题后可跨主题分页查看。研究/已转项目/已保留不进入候选；研究总览保留可用会话链接，已删来源不可访问。列表和详情均为标题、完整配图、正文和资料；随后为仅评分与文字/语音的“我的反馈”、底部全部操作（淘汰最后）。目标和投入边界为两个独立折叠块，无内部文本裁切。侧栏与项目共用38px行高及2px间隔，六点鼠标/触摸/键盘排序持久化，选中/悬停三点菜单支持改名、归档和恢复。

自动化涵盖迁移、旧设置保留、真实认证路由/CSRF、跨账号与远程执行拒绝、10→3+7/17→3+14 库存结转、稳定身份、重试、中文改写/跨主题/新证据、反馈撤销/复评/过时、原生调度归属与 prompt、来源 GC、研究/看板关联。运行 `npm test` 和 Docker test stage。

上线还必须完成真实短期登录、正式浏览器及正常 Agent/原生调度验收，不能以此文档或合成内容代表模型采集通过。部署者应记录自己的验收版本、测试范围及设备限制；默认没有主题、卡片、自动计划或业务记录。

## Topic navigation and feedback learning

The sidebar lists each topic, supports search, drag ordering and rename/archive/restore actions, and keeps the pending count visible beside long names. Counts cover all unprocessed recommended cards, including older days and later pages; reserve, feedback and work items do not count. A stale topic response cannot replace the current selection. Feedback can be recorded by typing or optional voice input; recording and retry state stay with the feedback field. Voice remains unavailable without the operator's own provider configuration.

Each normal discovery run drains `feedback_inbox` in pages of 30 and confirms `learn_feedback` before ingest, review or publish. The service checks cursor, feedback revision, ownership and idempotency. Revoked/updated feedback must be interpreted using the current card state. With no knowledge entry, reusable principles are saved transactionally in the topic database. With a project-relative Markdown entry such as `knowledge/README.md`, that knowledge tree is authoritative: the normal project agent writes condensed principles and feedback references, then acknowledges the affected Markdown paths. No second page-level principles copy is injected. File writing and the database acknowledgment are separate operations; after acknowledgment failure the agent must check references before retrying. Paths are validated syntactically; the acknowledgment does not independently prove file contents or quality.

No new provider, environment variable or background model runner is introduced. The feature is off by default; no real topics, knowledge files, learned principles or schedules are bundled. Operators create their own project knowledge and explicitly enable schedules.

## Upgrade and migration

Back up the operator's own database and state before upgrading. Startup migrations `2026101403`, `2026101404` and `2026101405` add per-user topic order, feedback-learning progress/history and optional project-knowledge paths; existing topics and feedback remain, and old feedback initially awaits learning. Run the existing build/deploy workflow and verify SQLite integrity plus owner isolation after upgrade. Do not overwrite state with source or sample data. The environment template and Compose defaults need no new keys for this increment. A rollback of code does not restore the database; retain the pre-upgrade backup for an intentional data restore.

## Feedback and research

After a recording is durably uploaded, transcription continues in the background and appends feedback to the original card. Retained failed audio can be retried; revision checks expose concurrent edits. Research opens an editable draft and starts only when you send it. Images may reference archived conversation assets within the same account and authorized project.

## Retained and completed work

Kept and completed cards have separate collections, with complete/reopen actions and all-topic aggregation. Voice recognition stays visible through refresh. Card previews are bounded rather than expanding the entire navigation surface. Existing feedback learning and publication history remain server-persistent.
