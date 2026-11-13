import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTranscriptionContext, estimateTranscriptionTokens, selectTranscriptionKeywords } from '../server/transcription.js';
import { TRANSCRIPTION_FIXED_TERMS } from '../server/transcription-keywords.js';

test('ten chronological messages preserve latest user conclusions and exclude system/cross-context data',()=>{
 const messages=Array.from({length:12},(_,i)=>({role:i%2?'user' as const:'assistant' as const,content:`段落${i}开始 ${'背景'.repeat(400)} 段落${i}结论`}));
 const result=prepareTranscriptionContext({recentMessages:[{role:'system',content:'隐藏系统'},...messages],projectTitle:'新会话项目'},2000,false);
 assert.equal(result.recentMessages,10);assert.ok(result.estimatedTokens<=2000);
 assert.doesNotMatch(result.text,/段落0开始|段落1开始|隐藏系统|新会话项目/);
 assert.match(result.text,/用户：.*段落11结论/);assert.ok(result.text.indexOf('段落2结论')<result.text.indexOf('段落11结论'));
 assert.ok(result.allocations.recentUser>result.allocations.recentAssistant);
});
test('short draft and attachment return unused budget to long relevant conversation',()=>{
 const long='开头'+ '语音背景'.repeat(3000)+'最后的结论不要改为十二';
 const result=prepareTranscriptionContext({draftText:'好',attachmentNames:['a.md'],recentMessages:[{role:'user',content:long}]},2000,false);
 assert.ok(result.estimatedTokens>1950);assert.ok(result.estimatedTokens<=2000);
 assert.match(result.text,/最后的结论不要改为十二/);assert.equal(result.allocations.draft,estimateTranscriptionTokens('当前尚未发送的输入草稿：好'));
 const fresh=prepareTranscriptionContext({projectTitle:'本项目技术说明'},2000,false);assert.match(fresh.text,/本项目技术说明/);
});
test('canonical literal validation, disabled terms and dedup precede the count boundary',()=>{
 const result=selectTranscriptionKeywords([...TRANSCRIPTION_FIXED_TERMS,...Array(210).fill(' ＧｉｔＨｕｂ '),...Array.from({length:113},(_,i)=>'ProjectTerm'+i),'<invalid>','＜invalid＞'],1600,['GitHub']);
 assert.equal(result.values.length,132);assert.ok(result.values.includes('ProjectTerm112'));assert.ok(!result.values.includes('GitHub'));assert.equal(result.invalid,2);assert.equal(result.disabled,1);assert.equal(result.duplicates,210);
 assert.equal(result.limitDropped,0);assert.equal(result.budgetDropped,0);
});
