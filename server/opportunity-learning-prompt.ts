// Appended at execution time so existing/custom recurring prompts also learn feedback.
export function opportunityLearningPrompt(topicId: string, knowledgePath = '') {
  return `机会主题：${topicId}。${knowledgePath ? `先读取本项目知识库 ${knowledgePath}，按索引获取最新要求、偏好及信息源。` : ''}使用 codex_web_opportunities context 读取当前协议；先经 feedback_inbox / learn_feedback 归纳未处理反馈，再据最新知识搜索、独立评审与推荐。只发现机会，实施需用户另行指示。`;
}
