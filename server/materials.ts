import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_EXPANDED = 24 * 1024 * 1024;

function checkedText(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new Error('材料正文为空，或没有可提取的文本；扫描件请先完成 OCR。');
  if (normalized.length > MAX_TEXT) throw new Error('材料文本超过 200000 字符，请按章节拆分上传。');
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(normalized)) throw new Error('材料包含二进制控制字符，请上传可读文本。');
  return normalized;
}

function decodeText(buffer: Buffer): string {
  try {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', {fatal:true}).decode(buffer);
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', {fatal:true}).decode(buffer);
    return new TextDecoder('utf-8', {fatal:true}).decode(buffer);
  } catch { throw new Error('文本编码无法读取，请保存为 UTF-8 后上传。'); }
}

/** Check the ZIP directory and actual expanded XML before handing OOXML to a parser. */
function validateDocx(buffer: Buffer): void {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('DOCX ZIP 文件结构无效。');
  const entries = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || entries > 1024 || !entries || offset + centralSize > end) throw new Error('DOCX ZIP 目录超出允许范围。');
  let total = 0; let hasDocument = false;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('DOCX ZIP 目录损坏。');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const expanded = buffer.readUInt32LE(offset + 24);
    const nameSize = buffer.readUInt16LE(offset + 28);
    const extraSize = buffer.readUInt16LE(offset + 30);
    const commentSize = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    total += expanded;
    if ((flags & 1) || ![0, 8].includes(method) || total > MAX_EXPANDED || expanded > 12 * 1024 * 1024 || (expanded > 1024 * 1024 && expanded / Math.max(1, compressed) > 200)) throw new Error('DOCX 含加密、异常压缩或过大的解压内容。');
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('DOCX ZIP 条目无效。');
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > offset || dataStart + compressed > buffer.length) throw new Error('DOCX ZIP 条目越界。');
    if (/\.(?:xml|rels)$/i.test(name)) {
      const raw = buffer.subarray(dataStart, dataStart + compressed);
      let decoded: Buffer;
      try { decoded = method === 0 ? raw : inflateRawSync(raw, {maxOutputLength: Math.min(MAX_EXPANDED, expanded + 1)}); }
      catch { throw new Error('DOCX XML 解压失败或超过允许大小。'); }
      if (decoded.length !== expanded || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(decoded.toString('utf8'))) throw new Error('DOCX 含不允许的 XML 实体或不一致的压缩大小。');
    }
    if (name === 'word/document.xml') hasDocument = true;
    offset += 46 + nameSize + extraSize + commentSize;
  }
  if (!hasDocument) throw new Error('DOCX 缺少正文。');
}

export async function extractMaterial(buffer: Buffer, name: string): Promise<{text:string;mime:string;extraction:string}> {
  if (buffer.byteLength > MAX_BYTES) throw new Error('单个材料最大 5 MB。');
  if (buffer.length === 0) throw new Error('材料为空。');
  const extension = path.extname(name).toLowerCase();
  const textTypes: Record<string, string> = {'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.tsv':'text/tab-separated-values','.json':'application/json'};
  if (extension in textTypes) {
    const text = checkedText(decodeText(buffer));
    if (extension === '.json') { try { JSON.parse(text); } catch { throw new Error('JSON 格式无效，原文件未被修改。'); } }
    return {text,mime:textTypes[extension],extraction:'完整文本读取；保留原始数值与单位'};
  }
  if (extension === '.docx') {
    validateDocx(buffer);
    // Raw-text extraction only traverses OOXML text. It never invokes image readers or follows hyperlinks.
    const result = await mammoth.extractRawText({buffer});
    const text = checkedText(result.value);
    return {text,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',extraction:'DOCX 正文与表格文本；图像、Word 数学公式（OMML）、批注和版面位置未提取，未执行 OCR'};
  }
  if (extension === '.pdf') {
    if (!buffer.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 文件头无效。');
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,maxImageSize:1,stopAtErrors:true});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { void task.destroy(); reject(new Error('PDF 读取超过 30 秒，请拆分材料。')); },30000); });
      return await Promise.race([(async () => {
        const pdf = await task.promise;
        if (pdf.numPages > 200) throw new Error('PDF 超过 200 页，请按章节拆分。');
        const pages: string[] = []; let length = 0;
        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
          const page = await pdf.getPage(pageNo);
          const content = await page.getTextContent();
          const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
          length += text.length;
          if (length > MAX_TEXT) throw new Error('PDF 文本超过 200000 字符，请拆分上传。');
          pages.push(`[第 ${pageNo} 页]\n${text || '（本页无可提取文本，未执行 OCR）'}`);
          page.cleanup();
        }
        if (length < 10) throw new Error('PDF 没有足够的可提取正文，可能是扫描件；请先完成 OCR。');
        return {text:checkedText(pages.join('\n\n')),mime:'application/pdf',extraction:`PDF 文本层 ${pdf.numPages} 页，按页定位；图像与公式视觉内容未核验，未执行 OCR`};
      })(),deadline]);
    } finally { if(timer) clearTimeout(timer); await task.destroy().catch(() => {}); }
  }
  throw new Error('暂不支持此材料格式。请上传 TXT、Markdown、CSV、TSV、JSON、DOCX 或有文本层的 PDF；图片需先完成 OCR。');
}
