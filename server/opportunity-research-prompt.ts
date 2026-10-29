import path from 'node:path';
import type { OpportunityFeedback, OpportunityIdea, OpportunityTopic } from '../src/opportunity-types.js';

export type OpportunityResearchFeedback = { rating: number | null; note: string };

export function opportunityResearchPrompt(
  topic: OpportunityTopic,
  idea: OpportunityIdea,
  feedback: OpportunityFeedback[],
  draftFeedback?: OpportunityResearchFeedback,
  sourceProjectRoot?: string,
) {
  const actions: Record<string, string> = { rate: '评分/备注', kept: '保留', later: '暂放', dismissed: '淘汰', undo: '撤销上次', expired: '已失效' };
  const reasons: Record<string, string> = { no_time: '现在没时间', vague: '太空泛', evidence: '证据不足', duplicate: '重复', direction: '不喜欢该方向', outdated: '已过时', other: '其他' };
  const rating = (value: number | null) => value === null ? '暂未评分' : `${value} 星`;
  return [
    `深入研究机会卡片 ${idea.id}，主题 ${topic.id}。`,
    topic.knowledge_path ? `先读取${sourceProjectRoot?'原主题工程':'本项目'}知识库 ${sourceProjectRoot?path.resolve(sourceProjectRoot,topic.knowledge_path):topic.knowledge_path}。` : '',
    sourceProjectRoot ? '本次研究在你选择的另一服务器工程下进行。机会工具只允许读取本主题 context、关联卡片 detail 并 research_result 写回本卡；不执行反馈学习或发现发布流程。' : '',
    '先用 codex_web_opportunities context/detail 读取最新目标、证据、疑点和反馈。结合下面我的评价、备注与具体做法展开研究：把其中的思路列为优先验证的问题和方案，逐项回应可行性、证据、限制与下一步；不要只复述原卡片，也不要把我的设想当成已验证事实。历史反馈用于理解思路演变，已撤销或被后续修改的评价不作为当前要求；如与当前反馈冲突，以最新明确意见为准。',
    '检索权威资料，执行不涉及购买/交易/发布的最小可行验证。区分已验证、被证伪及待验证；完成后 research_result 写回本卡，result 提供证据和结论。不自动宣称项目完成。',
    '## 我的已保存评价与备注',
    `评分：${rating(idea.rating)}\n备注：${idea.note || '未填写'}`,
    ...(draftFeedback ? ['## 本次填写的评价与备注（尚未保存到卡片）', `评分：${rating(draftFeedback.rating)}\n备注：${draftFeedback.note || '未填写'}`, '这是本次研究补充；不自动覆盖卡片中已保存的反馈。'] : []),
    '## 本卡片反馈历史（从早到晚，含撤销记录）',
    feedback.length ? feedback.map(f => `${f.created_at} · ${actions[f.action] ?? f.action} · ${rating(f.rating)}${f.reason ? ` · ${reasons[f.reason] ?? f.reason}` : ''}\n${f.note || '（无备注）'}`).join('\n\n') : '暂无历史反馈。',
    '## 机会卡片内容',
    JSON.stringify(idea.content, null, 2),
    ...(idea.images?.length ? ['## 卡片配图（需登录查看）', ...idea.images.map(image => `${image.alt}\n${image.caption}\n${image.url}`)] : []),
  ].filter(Boolean).join('\n\n');
}
