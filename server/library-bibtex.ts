import { createHash } from 'node:crypto';
import type { LibraryItem } from '../shared/library.ts';

const TEX_LITERAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\textbraceleft{}',
  '}': '\\textbraceright{}',
  '$': '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  '_': '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

function plainText(value: string | undefined): string {
  // Preserve Unicode text, but remove control/bidi characters and fold line breaks.
  return (value ?? '').replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function bibtexText(value: string): string {
  // One pass prevents escaping our own replacements. Named brace glyphs keep
  // field delimiters balanced even for readers that count escaped literal braces.
  return value.replace(/[\\{}$&#%_~^]/g, character => TEX_LITERAL[character]);
}

function bibtexIdentifier(value: string): string {
  // Bibliography readers treat DOI/URL as verbatim identifiers. TeX-escaping
  // underscores, ampersands, or percent signs would corrupt the actual link.
  // Percent-encode only characters that could alter BibTeX/TeX structure.
  return value.replace(/[\\{}]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Export public bibliographic metadata only; never serializes personal curation. */
export function libraryBibtex(items: LibraryItem[]): string {
  const usedKeys = new Set<string>();
  const entries = items.map(item => {
    // Derive keys from identity, not mutable titles or unsafe source text.
    const baseKey = `zhicui_${createHash('sha256').update(item.id).digest('hex').slice(0, 24)}`;
    let key = baseKey;
    for (let suffix = 2; usedKeys.has(key); suffix += 1) key = `${baseKey}_${suffix}`;
    usedKeys.add(key);

    const fields: string[] = [];
    const add = (name: string, value: string | undefined, encode = bibtexText) => {
      const text = plainText(value);
      if (text) fields.push(`  ${name} = {${encode(text)}}`);
    };
    add('title', item.title);
    add('year', item.year);
    add('doi', item.doi, bibtexIdentifier);
    add('url', item.url, bibtexIdentifier);
    add('journal', item.journal);
    add('abstract', item.abstract);
    const authors = plainText(item.authors);
    if (authors) add('note', `Authors as supplied: ${authors}`);

    // A display author string cannot reliably distinguish people, institutions,
    // truncation, or separators. Do not invent structured authors or entry types.
    return `@misc{${key},\n${fields.join(',\n')}\n}`;
  });

  return [
    '% Exported locally from known public bibliography metadata (UTF-8).',
    '% Missing metadata is not inferred; verify records before formal citation.',
    '% Entry types use misc. Unparsed source author text is preserved in note.',
    '% Personal notes, tags, reading status, and project history are excluded.',
    '',
    ...entries.flatMap(entry => [entry, '']),
  ].join('\n');
}
