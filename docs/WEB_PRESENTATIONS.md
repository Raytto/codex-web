# HTML 展示类型与附件分享

文件卡片的预览/打开、分享、下载是独立操作。Markdown 主体仍打开原文；阅读文档的预览进入原阅读器，交互网页另开标签页。报告阅读器保留标题、目录、选区、标注和主题设置，分享移到卡片。个人设置的公开分享管理使用同一个面板，并保留已关闭、已到期及冷存储记录。打开面板只读取元数据，不公开文件、不读取正文、不刷新会话活跃时间。

## 受管交付

`files.presentation_mode` 是权威字段，值为 `reader|web`，与 `kind=upload|output` 独立。迁移 `2026101702/file-presentation-versions` 将全部旧文件设为 reader，不改变文件 ID、分享地址、开关或期限。展示字段和版本关系不可原地修改；类型纠正通过所属账号的 `POST /api/files/:id/presentation-version` 新建默认私有成品，`previous_file_id` 指向原版本。旧内容/链接不变。外部上传本身永远不授予执行权限。

Agent 要交付交互页，向 `CWW_OUTPUTS_DIR` 同时写入 `demo.html` 和 `demo.html.pp-agent.json`：

```json
{"presentation_mode":"web","sha256":"最终 demo.html 的完整小写 SHA-256"}
```

声明也支持 reader；缺少声明仍是 reader。声明文件不显示为用户附件。HTML 可用 `<meta name="pp-agent-view" content="web">` 携带意图，但不能单独升级执行。重复/无效声明、冲突提示、错误类型、声明哈希不符或不支持的网页内容只拒绝该成品的交互展示：原始字节按 reader 普通附件保留，最终消息附带文件名、原因及重新交付提示；其余文件和模型回答照常原子登记。提示与最终回复一同写入恢复日志，重连/重启不会丢失。实际回传大小/哈希不符、读取或落盘失败仍作为完整性/存储错误终止提交，不能伪装成展示降级。服务端在原子复制和完整回传哈希校验后才写入 `presentation_manifest`。本机、宿主和 Remote Worker 的自动结果回传共用此流程；手动取回的历史远端文件保守保留 reader，可由本人重新交付。

首版只支持 UTF-8、5 MiB 以内的自包含 HTML。脚本、CSS、图片、字体和数据必须内嵌；单个不可变成员的完整 SHA-256 覆盖整包，manifest 记录策略版本、标题、成员字节数、哈希及内嵌资源类别。外链脚本/样式、相对资源、iframe、自动跳转、表单远端提交等拒绝登记；JS 发起的网络请求由 CSP 拒绝。音视频使用内嵌 data URL；a/area href 仅允许 # 页内锚点，引用来源外链放在聊天回复中，独立 MP3 等通过附件卡片下载。无后端、账号登录、外部 API、实时协作或浏览器持久存储。

## 执行边界

私有/公开预览先读取相同的持久类型。web 分支只显示全视口 iframe，正常运行时没有平台顶栏、侧栏、目录、选区层或管理按钮，标签显示作品标题。

HTTP 运行响应由独立的 `/api/web-runtime/:ticket` 路由提供，执行上下文是 `sandbox allow-scripts` 产生的独立不透明来源（opaque origin），并非把作者脚本放进主站 DOM。响应级 CSP sandbox 与 iframe sandbox 双重约束；不用 srcdoc，不放宽主站 `script-src 'self'`。运行响应仅允许内联脚本/样式及内嵌资源，拒绝 connect、外框、worker、插件、表单、同源权限、弹窗和顶层导航。Cookie、父 DOM 与 localStorage 不可由作者脚本访问。正常浏览器直接导航运行票据地址被拒绝；缺少 Fetch Metadata 的请求也继续受响应 sandbox 保护。

票据在每次 GET/HEAD 时重新核对文件哈希、归属、会话或有效分享、分享 revision 和用户状态；私有票据绑定具体登录会话，公开票据绑定分享代次。关闭/到期立即拒绝新读取，关闭后重开不复活旧票据。正常续期保留当前代次。打开的可信外壳每分钟及恢复焦点时复查，失效即卸载 iframe。短期票据随进程重启失效，重新打开即可获取；成品和公开地址不依赖 Agent Job 或远端设备持续运行。

需要导出时，在实际点击中调用 `window.ppAgent.exportFile('结果.json', JSON.stringify(data))`。可信父页只接受当前 iframe、null origin 和当前 channel 的请求，限定 1 MiB、json/csv/txt 文件名；用户再确认下载。默认仅内存状态，没有自动保存。此能力不允许原型指定服务器路径或调用主站 API。

## 分享与冷存储

沿用 [30 天公开分享](PUBLIC_FILE_SHARING.md)。GET `/api/files/:id/share` 和管理列表不读取正文、不触发恢复。恢复是用户显式操作：卡片/管理面板的恢复、重开或重新交付会恢复来源会话；打开冷网页也等待恢复。匿名失效链接不调用恢复入口。

有效分享保护单成员完整版本；关闭/到期后恢复现有归档资格。类型、归属、版本、资源清单、哈希与分享元数据保存在本机 SQLite。归档前额外核对 web manifest/文件 SHA-256，恢复后在标记 local 之前再次核对。沿用 age、阿里云盘回下载 SHA-256、7 天隔离、会话锁、generation/revision 和原子恢复。已 cold 会话的残留分享走已有合并归档路径；归档/恢复中的开启、续期或重新交付返回冲突，不绕过锁。没有新建搬运调度，远端执行器等既有会话门禁不变。

## 验证入口

- `tests/web-presentation.test.ts`：声明/完整传输、类型边界、权限、票据、版本、冷状态读取与并发状态门禁。
- `tests/conversation-cold-storage.test.ts`：整包归档、旧代次合并、失败重试和原子恢复回归。
- `scripts/check-web-presentation.mjs`：真实隔离应用和 Chromium 的卡片、320/390/1440px、运行隔离、交互、导出、匿名关闭/到期/重开与管理面板。
- `scripts/web-presentation-scenario.mjs`：生产维护登录包装器复用，只写新建专属验收会话，并清理测试文件/分享记录。没有模拟业务 API 或运行模型任务。

生产发布编号、真实阿里云盘往返和 iOS 真机边界记录在知识库交互网页专题。手机视口不等于 iOS Safari 真机。

## Managed remote delivery and explicit conversion

Worker output collection scans the current job's `CWW_OUTPUTS_DIR`; it transfers HTML and its adjacent `.html.pp-agent.json` declaration together. The declaration supplies the final SHA-256 and `presentation_mode: "web"`. Full bytes are verified before registration; missing declarations retain reader behavior. Declaration files are hidden from ordinary attachments. Shared limits count both members. Reader settings can explicitly convert an existing HTML presentation after validation; ordinary MIME labels cannot bypass active-content checks. Source links resolve the newest registered presentation version under `/codex-web`.
