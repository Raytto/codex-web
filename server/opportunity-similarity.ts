import crypto from 'node:crypto';
import type { OpportunityContent } from '../src/opportunity-types.js';
// Lightweight semantic recall: full structured content, normalized concepts and
// character n-grams. This is deliberately recall, not an absolute equivalence judge.
// The normal project Agent must compare material differences before approving.
const concepts: Array<[RegExp, string]> = [
  [/小朋友|幼儿|儿童|孩子|孩童|宝宝/g,'儿童'], [/绘制|涂鸦|手绘|绘画|画出|画画/g,'绘画'],
  [/游动|游泳|游起来|在水里动/g,'游泳'], [/小鱼|鱼儿|鱼类|鱼群/g,'鱼'],
  [/辨认|识别|认出|认识/g,'识别'], [/名字|名称|命名/g,'名称'],
  [/寻找|找出|发现|搜寻/g,'寻找'], [/侦探|破案|推理|断案/g,'推理'],
  [/痕迹|线索|踪迹/g,'线索'], [/喂食|喂养|投喂|喂鱼/g,'喂食'],
  [/发声|声音|音效|声响/g,'声音'], [/英语|英文|english/gi,'英语'],
  [/拖拽|拖动|拖放/g,'拖动'], [/触摸|点按|点击|轻点/g,'点击'],
  [/动画|动起来|活动起来|活起来/g,'动画'], [/节约时间|节省时间|省时/g,'省时'],
  [/分类|归类|分组/g,'分类'], [/影子|阴影|剪影/g,'影子'],
];
export function normalizedConcepts(value: string) {
  let text = value.normalize('NFKC').toLowerCase();
  for (const [re, concept] of concepts) text = text.replace(re,concept);
  return text.replace(/[\p{P}\p{Z}\p{S}\s]/gu,'');
}
export const identityText = (c: OpportunityContent) => [c.audience,c.problem,c.mechanism,c.value,c.interaction,c.loop].map(normalizedConcepts).join('|');
export const opportunityFingerprint = (c: OpportunityContent) => crypto.createHash('sha256').update(identityText(c)).digest('hex');
function vector(text: string) {
  const normalized = normalizedConcepts(text), counts = new Map<string,number>();
  for (let i=0;i<normalized.length-1;i++) { const k=normalized.slice(i,i+2); counts.set(k,(counts.get(k)??0)+1); }
  for (const [,concept] of concepts) if (normalized.includes(concept)) counts.set('concept:'+concept,4);
  return counts;
}
function cosine(a: Map<string,number>,b: Map<string,number>) {
  let dot=0,aa=0,bb=0; for(const [k,v] of a){dot+=v*(b.get(k)??0);aa+=v*v;}for(const v of b.values())bb+=v*v;
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
}
export function opportunitySimilarity(a: OpportunityContent,b: OpportunityContent) {
  const core=cosine(vector(a.mechanism+' '+a.problem),vector(b.mechanism+' '+b.problem));
  const other=cosine(vector(a.summary+' '+a.value+' '+a.keywords.join(' ')),vector(b.summary+' '+b.value+' '+b.keywords.join(' ')));
  return Math.round((core*.8+other*.2)*1000)/1000;
}
