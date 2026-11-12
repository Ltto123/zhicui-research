import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MethodSelection } from '../shared/types';
const dir=fileURLToPath(new URL('../methods/',import.meta.url));
export const WRITING_PRINCIPLE='写文章必须有理有据。先交代事实、证据与推理的适用条件，再形成判断；不要轻易使用“因此”“不是……而是……”等总结或强调句。使用“因此”必须存在足以支持该推论的前提；使用对比句必须有真实、必要的比较依据，不能以语气代替论证。';
export const GENRE_WRITING_RULE='根据最新交付目标和预期读者，确定各节应回答的问题、论证次序及所需证据。遇到陌生体裁，优先从用户所选范文或已有同类文章的已读部分提炼章法。不为寻找模板强制另行检索，不照抄内容、借用结论或虚构目标期刊的规定。缺少范例时，按明确的交付要求组织。';
export const MANUSCRIPT_SCOPE_RULE=`正式正文围绕研究问题、证据和推理。工作台自身的 HTTP 错误、获取失败、候选上限、全文与摘要的获取数量或比例、预算、工具能力、运行范围和复查进度，只留在用户侧折叠记录，不写入正文、脚注、附言或“研究局限”。证据不足时，依据可定位原文收窄或撤回相应主张。不要用笼统免责声明代替修正，也不要把取不到的资料说成论文未报告或领域缺乏证据。
保留原研究的样本、测量、偏倚等科学局限。真实系统综述应按体裁报告实际执行的协议、检索日期与策略、纳排标准和研究筛选结果。研究对象本身若是软件失败或网络可用性，依据该项研究的实际观测报告其结果。判断一段话说明的是研究对象还是工作台自身，不能按关键词删文。`;
const truth=`真实性与来源诚实始终生效：不编造数据、引用、实验、全文读取或人工核验。阅读范围与语义支持判断分别记录。相关关系不能写成因果。未验证的证明保留状态；未获得原始数据不得声称复算。仅交付用户指定的成果。方法和格式分开。${WRITING_PRINCIPLE}\n${GENRE_WRITING_RULE}\n${MANUSCRIPT_SCOPE_RULE}`;
export function listMethods() {return fs.readdirSync(dir).filter(f=>/^\d\d-/.test(f)&&!f.startsWith('00')).sort().map(f=>({id:f.slice(0,2),title:f.slice(3,-3),content:fs.readFileSync(path.join(dir,f),'utf8')}));}
export function educationReviewProfile(){return fs.readFileSync(path.join(dir,'00-共同原则与用户方法.md'),'utf8').split('## 用户的综述方法：指定教育综述配置')[1].split('## 项目默认底稿')[0].trim();}
export function effectiveMethods(selection:MethodSelection) {
  const cards=listMethods(); const selected=selection.mode==='replace'?[]:cards.filter(c=>selection.cardIds.includes(c.id));
  const text=selected.map(c=>c.content.split(/\n(?:样本观察|方法依据|这是智萃)/)[0]).join('\n\n');
  return `${truth}\n本次方法模式：${selection.mode==='replace'?'用户方法替换所选默认方法；停用原默认结构和检查':'内置方法与用户补充共同生效'}。\n${text}\n用户方法：${selection.instructions||'没有额外用户方法'}${selection.profileId==='education-review'?'\n本次明确启用的指定教育综述配置：\n'+educationReviewProfile():''}\n格式要求（不改变事实）：${selection.formatInstructions||'A4，中文宋体，外文数字 Times New Roman，正文10.5磅，1.5倍行距'}\n生成、审查、修订必须使用这一份实际生效规则。`;
}
