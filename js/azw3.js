/* Apo AZW3 / MOBI / AZW 解析（v3.105）
 * 格式依据：PalmDB 容器 + MOBI 头（KindleUnpack / mobi 的 mobi6_header 对照核实）。
 * 只读 MOBI7 正文（AZW3 里 KindleGen 同时保留的旧版全文），KF8 专属排版不解析——
 * 听书要的是正文，MOBI7 的 HTML 全文已足够。
 * 压缩：1=无压缩，2=PalmDOC（LZ77），0x4448=Huffman（暂不支持，给中文提示）。
 * 带 DRM（drm_offset != 0xFFFFFFFF）或 crypto_type != 0 的购书文件解不开，明确报错。 */
'use strict';

function _azw3_u16(dv, off){ return dv.getUint16(off, false); }
function _azw3_u32(dv, off){ return dv.getUint32(off, false); }

/* PalmDOC 解压（KindleUnpack mobi_uncompress.PalmdocReader 原样移植）：
 * 1..8：后面跟 c 个字面字节；<128：单字面字节；>=192：空格 + (c^128)；
 * 0x80..0xBF：两字节回指，距离=(v>>3)&0x7FF，长度=(v&7)+3。 */
function palmdocDecompress(data){
  const out = [];
  let p = 0;
  const n = data.length;
  while (p < n){
    const c = data[p++];
    if (c >= 1 && c <= 8){
      for (let k = 0; k < c && p < n; k++) out.push(data[p++]);
    } else if (c < 128){
      out.push(c);
    } else if (c >= 192){
      out.push(32, c ^ 128);
    } else {
      if (p >= n) break;
      const v = (c << 8) | data[p++];
      const m = (v >> 3) & 0x07FF;   /* 距离 */
      const len = (v & 7) + 3;        /* 长度 3..10 */
      if (m === 0 || m > out.length) break; /* 损坏的数据，停下不抛错 */
      for (let k = 0; k < len; k++) out.push(out[out.length - m]);
    }
  }
  return new Uint8Array(out);
}

/* 记录尾部杂项裁剪（KindleUnpack getText.trimTrailingDataEntries 原样移植） */
function _azw3_trimTrailing(data, trailers, multibyte){
  let end = data.length;
  for (let t = 0; t < trailers; t++){
    let num = 0;
    const start = Math.max(0, end - 4);
    for (let i = start; i < end; i++){
      const v = data[i];
      if (v & 0x80) num = 0;
      num = (num << 7) | (v & 0x7F);
    }
    end -= num;
    if (end < 0) end = 0;
  }
  if (multibyte && end > 0){
    const num = (data[end - 1] & 3) + 1;
    end -= num;
    if (end < 0) end = 0;
  }
  return data.subarray(0, end);
}

/* 解析 EXTH，取 503（Updated_Title）当书名。返回 Map(id -> string)。 */
function _azw3_parseExth(rec0, exthOff, codec){
  const out = new Map();
  try{
    if (exthOff + 12 > rec0.length) return out;
    const dv = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
    if (String.fromCharCode(rec0[exthOff], rec0[exthOff+1], rec0[exthOff+2], rec0[exthOff+3]) !== 'EXTH') return out;
    const totalLen = dv.getUint32(exthOff + 4, false);
    const count = dv.getUint32(exthOff + 8, false);
    let pos = exthOff + 12;
    const end = Math.min(rec0.length, exthOff + totalLen);
    for (let i = 0; i < count && pos + 8 <= end; i++){
      const id = dv.getUint32(pos, false);
      const size = dv.getUint32(pos + 4, false);
      if (size < 8 || pos + size > end) break;
      const bytes = rec0.subarray(pos + 8, pos + size);
      try{ out.set(id, new TextDecoder(codec, {fatal:false}).decode(bytes)); }catch(e){}
      pos += size;
    }
  }catch(e){}
  return out;
}

async function parseAZW3(buf){
  const bytes = new Uint8Array(buf);
  if (bytes.length < 78) throw new Error('文件太小，不是有效的 MOBI / AZW3 文件');
  const dv = new DataView(buf);
  const numRecords = _azw3_u16(dv, 76);
  if (!numRecords) throw new Error('不是有效的 MOBI / AZW3 文件（没有记录）');
  /* 记录偏移表 */
  const offsets = [];
  for (let i = 0; i < numRecords; i++){
    offsets.push(_azw3_u32(dv, 78 + i * 8));
  }
  offsets.push(bytes.length);
  const record = (i) => {
    if (i < 0 || i >= numRecords) return null;
    const s = offsets[i], e = offsets[i + 1];
    if (s >= e || s >= bytes.length) return null;
    return bytes.subarray(s, Math.min(e, bytes.length));
  };
  const rec0 = record(0);
  if (!rec0 || rec0.length < 0xF4) throw new Error('不是有效的 MOBI / AZW3 文件（头损坏）');
  const dv0 = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
  /* PalmDOC 头 */
  const compression = _azw3_u16(dv0, 0x00);
  const textRecords = _azw3_u16(dv0, 0x08);
  const cryptoType = _azw3_u16(dv0, 0x0C);
  if (cryptoType !== 0) throw new Error('本书带加密保护，无法在阿波里打开（请用无 DRM 的版本）');
  /* MOBI 头在记录 0 偏移 16 处 */
  const magic = String.fromCharCode(rec0[0x10], rec0[0x11], rec0[0x12], rec0[0x13]);
  if (magic !== 'MOBI') throw new Error('不是有效的 MOBI / AZW3 文件（缺少 MOBI 标记）');
  const headerLen = _azw3_u32(dv0, 0x14);
  const codepage = _azw3_u32(dv0, 0x1C);
  const codec = codepage === 65001 ? 'utf-8' : 'windows-1252';
  const titleOff = _azw3_u32(dv0, 0x54);
  const titleLen = _azw3_u32(dv0, 0x58);
  const exthFlags = _azw3_u32(dv0, 0x80);
  const drmOffset = _azw3_u32(dv0, 0xA8);
  if (drmOffset !== 0xFFFFFFFF) throw new Error('本书带 DRM 保护（Kindle 购书文件），无法解开，请用无 DRM 的版本');
  const firstContent = _azw3_u16(dv0, 0xC0);
  const lastContent = _azw3_u16(dv0, 0xC2);
  /* 书名：优先 EXTH 503，再用 MOBI 头里的全名 */
  let title = '';
  if (exthFlags & 0x40){
    const exth = _azw3_parseExth(rec0, 16 + headerLen, codec);
    if (exth.get(503)) title = exth.get(503).trim();
  }
  if (!title && titleLen > 0){
    try{
      const t0 = 16 + titleOff, t1 = Math.min(rec0.length, t0 + titleLen);
      if (t0 < rec0.length && t1 > t0)
        title = new TextDecoder(codec, {fatal:false}).decode(rec0.subarray(t0, t1)).trim();
    }catch(e){}
  }
  /* 压缩类型 */
  if (compression === 0x4448) throw new Error('本书用了 Huffman 压缩，暂不支持，请先转成 EPUB 或 TXT 再导入');
  if (compression !== 1 && compression !== 2) throw new Error('不支持的压缩类型（' + compression + '），请先转成 EPUB 或 TXT 再导入');
  /* 记录尾部裁剪（仅 MOBI 头够长且版本够新时，照 KindleUnpack 的条件） */
  let trailers = 0, multibyte = 0;
  const mobiVer = _azw3_u32(dv0, 0x68);
  if (headerLen >= 0xE4 && mobiVer >= 5){
    let flags = _azw3_u16(dv0, 0xF2);
    multibyte = flags & 1;
    while (flags > 1){ if (flags & 2) trailers++; flags = flags >> 1; }
  }
  /* 正文记录：从 1 到 textRecords（KindleUnpack 用 text_records 计数；first/last_content 仅作交叉核对） */
  const count = textRecords > 0 ? textRecords : (lastContent >= firstContent && firstContent >= 1 ? (lastContent - firstContent + 1) : 0);
  if (!count) throw new Error('本书没有正文记录，无法导入');
  const parts = [];
  for (let i = 1; i <= count; i++){
    let rec = record(i);
    if (!rec) continue;
    if (trailers || multibyte) rec = _azw3_trimTrailing(rec, trailers, multibyte);
    if (compression === 1) parts.push(rec);
    else parts.push(palmdocDecompress(rec));
  }
  const totalLen = parts.reduce((a, p) => a + p.length, 0);
  const raw = new Uint8Array(totalLen);
  let w = 0;
  for (const p of parts){ raw.set(p, w); w += p.length; }
  if (!totalLen) throw new Error('本书正文为空，无法导入');
  const html = new TextDecoder(codec, {fatal:false}).decode(raw);
  /* MOBI HTML → 纯文本（走 EPUB 同款路子），再用 splitChapters 切章 */
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style').forEach(e => e.remove());
  const text = (doc.body ? doc.body.innerText : '').replace(/[ \t]+/g, ' ').split('\n').map(x => x.trim()).filter(x => x).join('\n');
  if (text.length <= 20) throw new Error('没有提取到正文（可能是图片版或格式异常）');
  const chapters = splitChapters(text);
  /* 封面：第一张资源图（best-effort，失败就不要） */
  let cover = '';
  try{
    const firstResc = _azw3_u32(dv0, 0x6C);
    if (firstResc > 0 && firstResc < numRecords){
      const img = record(firstResc);
      if (img && img.length > 100){
        const isJpeg = img[0] === 0xFF && img[1] === 0xD8;
        const isPng = img[0] === 0x89 && img[1] === 0x50 && img[2] === 0x4E && img[3] === 0x47;
        if (isJpeg || isPng){
          const blob = new Blob([img.slice(0).buffer], {type: isJpeg ? 'image/jpeg' : 'image/png'});
          cover = await downscaleImage(blob, 480, isJpeg ? 'image/jpeg' : 'image/png');
        }
      }
    }
  }catch(e){ cover = ''; }
  return {title: title.trim(), chapters, cover};
}
