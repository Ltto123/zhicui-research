/** Reviewed, portable adaptations of the user's research skills. No arbitrary
 * local skill discovery, shell execution, or developer-machine paths at runtime. */
export const researchSkills = [
  {
    id: 'literature-review', name: '文献综述', sourceVersion: '1.11',
    description: '围绕研究问题找文献，先看摘要，再决定读哪些全文，最后比较不同研究的发现。',
    boundary: '按研究领域选择来源；记录实际检索、筛选和缺口，不把找到的篇数当作综述质量。',
    instructions: '【文献综述技能】需要文献时先明确问题与纳入条件，设计互补概念及同义词查询；按学科使用已接入来源。先依据题名与摘要记录相关性及是否需要全文，再获取所选原文。按议题比较研究对象、方法、发现与局限，不逐篇拼接摘要。区分独立研究和同一研究的多份报告。真实系统综述按协议报告筛选方法与结果；工作台自身的取证记录只留在用户侧折叠区。缺少支持时收窄或撤回具体论点，不把取证困难改写成学术局限。不能声称穷尽、人工双人审查或完成未执行的统计分析。',
  },
  {
    id: 'citation-management', name: '引用核对', sourceVersion: '2.3',
    description: '核对论文身份，合并重复结果，让正文引用与参考文献、原文对应起来。',
    boundary: '缺少的作者、期刊、年份、卷期页码保留待核对；不编造书目信息。',
    instructions: '【引用核对技能】引用必须来自当前已取得的证据。核对题名、作者、年份、期刊、DOI与版本身份；同名不一定是同一论文，有DOI不等于主张被支持。缺失的卷期页码不得猜填，未完成补全的字段留在书目核查记录。正文使用实际证据ID，由工作台按真实引用生成编号与书目。原文可打开、实际阅读范围、主张得到支持是三件分别核查的事。',
  },
  {
    id: 'arxiv', name: '理工科论文检索', sourceVersion: '1.0.0',
    description: '为计算机、人工智能、物理、数学等题目补充 arXiv 论文，保留摘要和原文位置。',
    boundary: 'arXiv 的预印本不自动等于已通过期刊评审；按实际读到的版本引用。',
    instructions: '【arXiv检索技能】适用计算机、人工智能、物理、数学及计算模拟题目时补充arXiv。查询由工作台按来源转换，不能把某库独有字段原样套到别的库。保留arXiv版本及发表信息，撤稿或撤回记录不能当正常支持证据；预印本与期刊版不能自动重复计数或混用结论。先读返回摘要，选中后再获取对应版本全文；不能仅有PDF地址就声称读过全文。',
  },
] as const;

export function researchSkillGuidance(): string {
  return '以下为工作台随程序提供的科研技能规则，仅在对应研究步骤使用；保留用户指定成果、学科方法、停止范围和后续补充。纯格式修改不因技能存在而启动检索。用户只需在开始写作前审校一次提纲；确认后，局部修正、程序引用核验、内部质量复查与交付自动完成，不再次请求成稿或修稿许可。同版有效审查直接复用；小修优先精确局部替换，再只核对改动与相关证据，不将整篇重写和全文复查作为默认动作。read_saved读取候选摘要不会改变筛选、正文或研读资格，只有宿主eligibleForWriting标记和写作门槛通过的来源才可引用。\n'
    + researchSkills.map(skill => skill.instructions).join('\n');
}

export function researchCapabilities() {
  return {
    version: '2026-11-09',
    execution: '文献检索和原文获取由工作台服务器完成；使用者无需单独配置代理。服务器自行直连或使用管理员配置的网络出口。',
    skills: researchSkills,
    sources: [
      { name: 'OpenAlex', scope: '跨学科论文、摘要及公开原文位置' },
      { name: 'Europe PMC', scope: '生命科学和医学论文，提供部分开放全文' },
      { name: 'Crossref', scope: '论文登记信息、DOI及部分摘要；不是全文库' },
      { name: 'arXiv', scope: '计算机、人工智能、数学、物理等论文与预印本' },
      { name: 'PubMed', scope: '医学与生命科学论文摘要；有开放版本时定位到PMC' },
      { name: 'ERIC', scope: '教育研究论文和报告，含摘要及部分公开 PDF 入口' },
      { name: 'DOAJ', scope: '开放获取期刊文章、摘要及出版方全文入口' },
      { name: 'OpenAIRE', scope: '跨学科开放科研索引与仓储入口；当前使用有每小时限额的匿名接口' },
    ],
    notConnected: [
      { name: 'Web of Science', reason: '尚未接入，需核实机构授权及可用访问方式。' },
      { name: 'Scopus', reason: '尚未接入，需核实机构授权及可用访问方式。' },
      { name: '知网、万方', reason: '尚未接入，不能把本机有相关说明当作已有数据库权限。' },
      { name: 'Semantic Scholar、Google Scholar', reason: '尚未接入自动检索，不计入本轮已覆盖来源。' },
    ],
    note: '已接入表示工作台具备调用能力，当前是否连得上需检查；某次实际查过哪些库，以该任务的检索记录为准。14类写作方法另行提供，不等于接入14个数据库。',
  };
}
