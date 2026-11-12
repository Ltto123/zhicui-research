import type {ReviewIssue} from '../shared/types';

// These are recognizable descriptions of the current production process.
// The semantic review also checks paraphrases. Methodological counts and a
// paper's own experimental limitations do not imply a workbench disclosure.
const auditSignatures = [
  /(?:本轮|本次检索|本工作台|本报告的检索).{0,40}\d+\s*次(?:成功|失败)(?:的)?(?:检索|全文下载|数据库)请求/u,
  /\d+\s*次(?:成功|失败)检索请求.{0,60}(?:失败集中于.{0,15}接口|各来源原始返回|候选上限)/u,
  /(?:检索|召回|候选|结果)(?:达到|触及|受|池达到|达到候选|达到结果|命中).{0,8}(?:候选|结果|数量|处理)?上限/u,
  /(?:未取得|未获取|未读到)(?:全文|正文)的?\s*\d+\s*(?:条|篇)(?:文献|研究).{0,18}(?:可能|或许|不能排除)|\d+\s*(?:条|篇)(?:申请|请求)(?:的)?(?:全文|正文)(?:缺失|失败|未取得)/u,
  /(?:最终|当前|本轮)可(?:用于写作|引用)(?:的)?(?:证据|文献)\s*\d+\s*(?:条|篇).{0,50}(?:全文|摘要)\s*\d+/u,
  /(?:本轮|本次任务|工作台)(?:已)?(?:取得|获取|筛得)\s*\d+\s*(?:条|篇)(?:可引用|可用于写作)(?:证据|文献)/u,
  /(?:所选摘要|摘要未载).{0,65}全文(?:研读)?笔记.{0,12}(?:依据|支持|核验)/u,
  /(?:本轮|本次|此次)(?:检索|研读|下载).{0,120}(?:仅取得|仅获取|未能取得|未取得|无法读取|仅能读到|仅依据摘要)/u,
  /(?:本报告|本稿|本文|本综述).{0,35}(?:限于|受限于|基于|依赖).{0,18}(?:已取得|可获得|本轮取得|已获取)(?:全文|正文|的全文|的摘要|原文|或摘要)/u,
  /(?:工作台|智萃科研|本轮检索|本次检索|本次成稿|代理额度|模型预算).{0,45}(?:无法|未能|失败|超时|耗尽|受限|仅能|上限|缺失)/u,
  /(?:本轮|本次|当前|此次).{0,12}(?:仅能|只能|仅可).{0,12}(?:读取|获取|访问|取得|查阅|依据).{0,12}(?:全文|正文|摘要)/u,
  /(?:our|this)\s+(?:search|workbench|retrieval|agent).{0,80}(?:candidate cap|download budget|retrieval limit|failed requests|request failures)/i,
  /(?:workbench|retrieval agent|current run).{0,60}(?:budget was exhausted|timed out|could only access|failed to download|unable to retrieve)/i,
];
const attributedResearch = /另一项.{0,20}(?:研究|实验)|(?:作者|该研究|原研究|既有研究|文献\[[^\]]+\])(?:明确|也|还|的实验|在实验中)?(?:报告|测得|观察|评估)|(?:the authors|a previous study) reported/i;
const ownExecution = /本工作台|本轮检索|本报告.{0,20}判断|本次检索执行|(?:但|而|由于|然而)(?:当前)?工作台|our workbench|our search/i;
const empiricalSubject = /(?:以|评估|测量|研究)(?:检索服务|检索工具|数据库接口|访问控制).{0,20}(?:研究对象|可靠性|性能|准确率|响应率)|(?:实验|基准测试).{0,18}(?:固定数据集|重试策略|测试服务器)/u;

function auditExcerpt(line:string):string|undefined {
  for(const sentence of line.match(/[^。！？\n]+[。！？]?/gu)??[]){
    if((attributedResearch.test(sentence)||empiricalSubject.test(sentence))&&!ownExecution.test(sentence))continue;
    const match=auditSignatures.map(pattern=>pattern.exec(sentence)).find(Boolean);
    if(match){
      const start=Math.max(0,(match.index??0)-42);
      return sentence.slice(start,start+220).trim();
    }
  }
}

export function manuscriptBoundaryIssues(draft:string):ReviewIssue[] {
  const issues:ReviewIssue[]=[];
  let section='正文';
  for(const [index,line] of draft.split(/\r?\n/).entries()){
    const heading=/^\s{0,3}#{1,6}\s+(.+)/.exec(line);
    if(heading)section=heading[1].trim();
    const excerpt=auditExcerpt(line);
    if(excerpt)issues.push({
      severity:'error',location:section+'（第'+(index+1)+'行）',
      issue:'正文含工作台执行记录：“'+excerpt+'”',
      suggestion:'只修正这处段落。工作台限制留在用户工作记录。核对保留的主张和引文，按原文支持范围收窄或撤回判断，保留真正的研究方法与科学局限。',
    });
  }
  return issues;
}
