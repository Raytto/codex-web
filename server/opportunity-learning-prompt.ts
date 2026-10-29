// Appended at execution time so existing/custom recurring prompts also learn feedback.
export function opportunityLearningPrompt(topicId: string, knowledgePath = '') {
  return `机会主题：${topicId}。${knowledgePath ? `先读取本项目知识库 ${knowledgePath}，按索引获取最新要求、偏好及信息源。` : ''}使用 codex_web_opportunities context 读取当前协议及 capacity；待审核总上限优先于每日新增目标，满额继续研究储备并 publish 零新增完成，不补满、不因限额 fail；有空位最多推荐 min(日上限,空位)，退回的旧卡须复评且不算首次新增。先经 feedback_inbox / learn_feedback 归纳未处理反馈，再据最新知识搜索、独立评审与推荐。每张精选默认先用 image_gen 生成中文说明图（游戏给玩法示例，应用给界面/流程示例，可多张），放本会话 CWW_OUTPUTS_DIR，按 context 的 images 协议关联后再 publish。不要只写配图建议。只发现机会，实施需用户另行指示。`;
}
