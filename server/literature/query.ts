export type LiteratureSource = 'OpenAlex' | 'arXiv' | 'PubMed' | 'ERIC';

/** Routing is a domain hint, never an assertion that results are relevant. The
 * abstract screening stage still decides relevance one paper at a time. */
export function selectLiteratureSources(input: { queries: readonly string[]; topic?: string; preferFullTextSources?: boolean }): { name: LiteratureSource; reason: string }[] {
  const value = [input.topic ?? '', ...input.queries].join(' ').normalize('NFKC');
  const sources: { name: LiteratureSource; reason: string }[] = [{ name: 'OpenAlex', reason: '跨学科书目与摘要检索' }];
  if (/\b(?:AI|artificial intelligence|machine learning|deep learning|neural networks?|ChatGPT|LLMs?|large language models?|computer science|computational|quantum|physics|mathematics|molecular (?:dynamics|simulation)|density functional|statistical mechanics|robotics|algorithms?)\b|人工智能|机器学习|深度学习|神经网络|大语言模型|计算机|物理|数学|量子|分子动力学|分子模拟|密度泛函|机器人/i.test(value)) sources.push({ name: 'arXiv', reason: '计算、AI、物理或数学相关主题，补充预印本摘要及公开正文入口' });
  if (/\b(?:biomedic\w*|medic(?:al|ine)|clinical|patients?|cancer|oncolog\w*|immun\w*|health(?:care)?|disease|drug(?:s)?|pharmac\w*|genom\w*|proteom\w*|biolog\w*|protein(?:s)?|neuroscien\w*)\b|生物医学|医学|临床|患者|癌症|肿瘤|免疫|疾病|药物|药理|基因组|蛋白|神经科学/i.test(value)) sources.push({ name: 'PubMed', reason: '生物医学相关主题，补充 NCBI PubMed 索引与摘要' });
  if (/\b(?:education(?:al)?|pedagog\w*|teachers?|teaching|curricul\w*|classrooms?|schools?|students?|lesson planning|lesson preparation|higher education)\b|教育|教学|教师|备课|课程|课堂|学生|学校|师范/i.test(value)) sources.push({ name: 'ERIC', reason: '教育或教学研究，补充 ERIC 的论文、研究报告及公开正文入口' });
  return sources;
}

/** Supports the intersection of the planner's Boolean language and arXiv's
 * documented fields. Refuse unsupported expressions rather than lose NOT. */
export function arxivQuery(input: string): string {
  const fail = (): never => { throw new Error('arXiv 查询语法不能安全转换：请保留带引号的短语、AND / OR / NOT 和成对括号。'); };
  const query = input.trim(); if (!query || query.length > 4000 || /[\r\n\x00-\x1f\[\]\\]/.test(query)) fail();
  const tokens: string[] = []; let offset = 0;
  while (offset < query.length) {
    if (/\s/.test(query[offset])) { offset++; continue; }
    if (query[offset] === '(' || query[offset] === ')') { tokens.push(query[offset++]); continue; }
    const match = /^(?:(all|ti|au|abs|co|jr|cat|rn):)?("[^"\r\n]+"|[^\s():"\[\]\\]+)/.exec(query.slice(offset));
    if (!match) fail(); const [raw, field, term] = match!; offset += raw.length;
    if (query[offset] === ':') fail();
    tokens.push(!field && /^(?:AND|OR|NOT|ANDNOT)$/.test(term) ? term : `${field ?? 'all'}:${term}`);
  }
  const output: string[] = []; let operand = true, depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    if (token === 'AND' && tokens[i + 1] === 'NOT') { token = 'ANDNOT'; i++; }
    if (token === 'NOT') { if (operand) fail(); token = 'ANDNOT'; }
    if (/^(?:AND|OR|ANDNOT)$/.test(token)) { if (operand) fail(); output.push(token); operand = true; continue; }
    if (token === ')') { if (operand || !depth) fail(); depth--; output.push(token); operand = false; continue; }
    if (!operand) output.push('AND');
    output.push(token); if (token === '(') { depth++; operand = true; } else operand = false;
  }
  if (operand || depth) fail();
  return output.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
}
