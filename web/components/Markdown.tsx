import { createElement, type ReactNode } from 'react';
import { marked } from 'marked';
import {sourceHref,type EvidenceLinkSource} from '../lib/source-links';

type Token = {
  type: string; raw?: string; text?: string; tokens?: Token[]; depth?: number;
  href?: string; title?: string; lang?: string; ordered?: boolean; start?: number;
  items?: { tokens: Token[]; task?: boolean; checked?: boolean }[];
  header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][];
};

export function safeLink(href = ''): string | undefined {
  if (/^https?:\/\//i.test(href) || /^\/api\/artifacts\//.test(href)) return href;
  return undefined;
}

function render(tokens: Token[] = [], prefix = '',sources:EvidenceLinkSource[]=[],preferredRunId?:string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}${index}`;
    const content = token.tokens ? render(token.tokens, `${key}.`,sources,preferredRunId) : token.text;
    switch (token.type) {
      case 'space': return null;
      case 'heading': return createElement(`h${Math.min(6, Math.max(1, token.depth ?? 2))}`, { key }, content);
      case 'paragraph': return <p key={key}>{content}</p>;
      case 'text': case 'escape': return <span key={key}>{content}</span>;
      case 'strong': return <strong key={key}>{content}</strong>;
      case 'em': return <em key={key}>{content}</em>;
      case 'del': return <del key={key}>{content}</del>;
      case 'codespan': return <code key={key}>{token.text}</code>;
      case 'code': return <pre key={key}><code>{token.text}</code></pre>;
      case 'br': return <br key={key} />;
      case 'hr': return <hr key={key} />;
      case 'blockquote': return <blockquote key={key}>{content}</blockquote>;
      case 'link': {
        const href = safeLink(token.href);
        return href ? <a key={key} href={sourceHref(href,sources,preferredRunId)} target="_blank" rel="noopener noreferrer">{content}</a> : <span key={key}>{content}</span>;
      }
      case 'image': return <span key={key} className="image-reference">[图片：{token.text || '图表'}]</span>;
      case 'html': return <span key={key}>{token.text ?? token.raw}</span>;
      case 'list': {
        const items = (token.items ?? []).map((item, i) => <li key={i}>
          {item.task && <input type="checkbox" checked={Boolean(item.checked)} readOnly tabIndex={-1} aria-label="任务状态" />}
          {render(item.tokens, `${key}.${i}.`,sources,preferredRunId)}
        </li>);
        return token.ordered ? <ol start={token.start} key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
      case 'table': return <div className="table-scroll" key={key}><table>
        <thead><tr>{(token.header ?? []).map((cell, i) => <th key={i}>{render(cell.tokens, `${key}.h${i}.`,sources,preferredRunId)}</th>)}</tr></thead>
        <tbody>{(token.rows ?? []).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{render(cell.tokens, `${key}.${i}.${j}.`,sources,preferredRunId)}</td>)}</tr>)}</tbody>
      </table></div>;
      default: return <span key={key}>{token.text ?? token.raw ?? ''}</span>;
    }
  });
}

export function Markdown({ text, className = '',sources=[],preferredRunId }: { text: string; className?: string;sources?:EvidenceLinkSource[];preferredRunId?:string }) {
  return <div className={`markdown ${className}`}>{render(marked.lexer(text, { gfm: true }) as unknown as Token[],'',sources,preferredRunId)}</div>;
}
