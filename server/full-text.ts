import { DOMParser } from '@xmldom/xmldom';

const MAX_BODY_CHARACTERS = 100_000;
const OMIT = new Set(['abstract', 'trans-abstract', 'kwd-group', 'ref-list', 'permissions', 'license', 'ack', 'supplementary-material', 'sub-article', 'graphic', 'inline-graphic', 'media']);
const BLOCK = new Set(['body', 'sec', 'title', 'p', 'list', 'list-item', 'table', 'tr', 'td', 'th', 'caption', 'disp-formula']);
const nameOf = (node: Node): string => (node.nodeType === 1 ? (node as Element).localName || node.nodeName : node.nodeName).toLowerCase();

/** Reads the JATS main body only. Never resolves a DTD, follows a link, loads an
 * image, or counts the front abstract/back references as the article body. */
export function extractEpmcBody(xml: string): string {
  const fail = (): never => { throw new Error('正文校验失败：XML 无效或正文结构不完整。'); };
  // External DTD declarations in ordinary JATS are inert in xmldom. Internal
  // subsets/entities are unnecessary for this text-only reader and rejected.
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) fail();
  const document = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (!root || nameOf(root) !== 'article') fail();
  const bodies: Element[] = [];
  for (let node = root.firstChild; node; node = node.nextSibling) if (node.nodeType === 1 && nameOf(node) === 'body') bodies.push(node as Element);
  if (bodies.length !== 1) fail();
  const chunks: string[] = [];
  const stack: (Node | string)[] = [bodies[0]];
  let visited = 0, characters = 0;
  while (stack.length) {
    if (++visited > 100_000) throw new Error('正文校验失败：XML 结构超过读取上限。');
    const node = stack.pop()!;
    if (typeof node === 'string') { chunks.push(node); continue; }
    if (node.nodeType === 3 || node.nodeType === 4) {
      const value = node.nodeValue || '';
      characters += value.length;
      if (characters > MAX_BODY_CHARACTERS) throw new Error('全文超过本轮正文长度限制，未截断后标为全文。');
      chunks.push(value); continue;
    }
    if (node.nodeType !== 1) continue;
    const name = nameOf(node), element = node as Element;
    if (OMIT.has(name) || (name === 'sec' && /^(?:abstract|references|acknowledgments?|supplementary-material)$/i.test(element.getAttribute('sec-type') || ''))) continue;
    if (name === 'sec') {
      let heading = '';
      for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1 && nameOf(child) === 'title') { heading = (child.textContent || '').trim(); break; }
      if (/^(?:abstract|摘要|references|acknowledgments?|permissions|supplementary material)$/i.test(heading)) continue;
    }
    if (BLOCK.has(name)) { chunks.push('\n'); stack.push('\n'); }
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  const text = chunks.join('').replace(/\r\n?/g, '\n').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 100) throw new Error('正文校验失败：主文为空或过短，不能把摘要、链接或杂项标为全文。');
  if (text.length > MAX_BODY_CHARACTERS) throw new Error('全文超过本轮正文长度限制，未截断后标为全文。');
  return text;
}
