/* Deepreading v1.0 — 本地优先的听书应用：PDF / EPUB / TXT → 语音朗读
   数据只存本机 IndexedDB；语音用系统 Web Speech API；无服务器、无上传。 */
'use strict';

/* ---------- 工具 ---------- */
/* $ 与 $$ 定义在 js/util.js（最先加载），此处不再重复定义 */
const toast = (msg, ms=2200) => {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.add('hidden'), ms);
};
const loading = (on, text) => {
  $('#loading').classList.toggle('hidden', !on);
  if (text) $('#loading-text').textContent = text;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const isCJK = ch => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch);
function detectLang(text){
  let cjk=0, lat=0;
  for (const ch of text.slice(0,2000)) { if (isCJK(ch)) cjk++; else if (/[a-zA-Z]/.test(ch)) lat++; }
  return cjk >= lat ? 'zh' : 'en';
}
/* 中文按 。！？；… 分句；英文按 .!? 分句（照顾常见缩写） */
/* 返回 {t, p}：p=1 表示该句是新段落开头（原文中空行分隔）。
   行内 span 的 offsetLeft 在多列里不可靠，段落信息必须随句对象保存，
   不能靠换行符事后推断。 */
function splitSentences(text){
  const out=[]; let buf='', paraNext=false;
  const push=()=>{ const t=buf.trim(); if(t) out.push({t, p:paraNext?1:0}); buf=''; paraNext=false; };
  for (let i=0;i<text.length;i++){
    const ch=text[i]; buf+=ch;
    if ('。！？；'.includes(ch)) push();
    else if (ch==='…' && text[i+1]!=='…') push();
    else if ((ch==='.'||ch==='!'||ch==='?') && /[a-zA-Z\u4e00-\u9fff]/.test(text[i-1]||'') && !/[a-zA-Z]/.test(text[i+1]||'') && !/(Mr|Mrs|Ms|Dr|St)\.$/.test(buf.slice(-4))) push();
    else if (ch==='\n'){ if(buf.trim()) push(); else paraNext=true; }
  }
  push();
  return out.filter(s=>s.t.length>1);
}
const CHAP_RE = /^(第[一二三四五六七八九十百千万零\d\s]+[章节回篇卷]|Chapter\s+\d+|CHAPTER\s+\d+|前言|序言|后记|引言|楔子|尾声|番外)/;
function splitChapters(fullText){
  const lines = fullText.split('\n');
  const chapters=[]; let cur={title:'正文', text:''};
  for (const ln of lines){
    const t=ln.trim();
    if (t && t.length<40 && CHAP_RE.test(t)){
      if (cur.text.trim()) chapters.push(cur);
      cur={title:t, text:''};
    } else cur.text += ln+'\n';
  }
  if (cur.text.trim()||!chapters.length) chapters.push(cur);
  return chapters;
}

/* ---------- IndexedDB ---------- */
const DB='deepreading', VS=7;
let db=null;
function openDB(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open(DB,VS);
    r.onupgradeneeded=()=>{
      const d=r.result;
      if(!d.objectStoreNames.contains('books')) d.createObjectStore('books',{keyPath:'id'});
      if(!d.objectStoreNames.contains('files')) d.createObjectStore('files',{keyPath:'id'});
      if(!d.objectStoreNames.contains('progress')) d.createObjectStore('progress',{keyPath:'bookId'});
      if(!d.objectStoreNames.contains('voices')) d.createObjectStore('voices',{keyPath:'id'});
      if(!d.objectStoreNames.contains('pagecache')) d.createObjectStore('pagecache',{keyPath:'key'});
      if(!d.objectStoreNames.contains('sys')) d.createObjectStore('sys',{keyPath:'key'});
      if(!d.objectStoreNames.contains('marks')) d.createObjectStore('marks',{keyPath:'id',autoIncrement:true});
      if(!d.objectStoreNames.contains('bookmarks')) d.createObjectStore('bookmarks',{keyPath:'id',autoIncrement:true});
      if(!d.objectStoreNames.contains('translations')) d.createObjectStore('translations',{keyPath:'bookId'});
    };
    r.onsuccess=()=>{db=r.result; db.onclose=()=>{db=null;}; db.onversionchange=()=>{db=null;}; res();}; r.onerror=()=>rej(r.error);
  });
}
const _tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
/* D3：首次导入偶发 "database connection is closing"——写操作包一层重试，
   遇关连接类错误就重开 DB 再试一次。 */
async function idbRetry(fn){
  try{ return await fn(); }
  catch(e){
    const m=(e&&e.message)||'', n=(e&&e.name)||'';
    if(!/closing|InvalidState|not active|UnknownError/i.test(m) && n!=='InvalidStateError') throw e;
    db=null; await openDB(); return await fn();
  }
}
const idbMarks={
  add:m=>new Promise((res,rej)=>{const t=_tx('marks','readwrite').add(m);t.onsuccess=()=>res(t.result);t.onerror=()=>rej(t.error);}),
  byBook:bid=>new Promise((res,rej)=>{const t=_tx('marks').getAll();t.onsuccess=()=>res((t.result||[]).filter(x=>x.bookId===bid));t.onerror=()=>rej(t.error);}),
  all:()=>new Promise((res,rej)=>{const t=_tx('marks').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  del:id=>new Promise((res,rej)=>{const t=_tx('marks','readwrite').delete(id);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
};
const idbBookmarks={
  add:m=>new Promise((res,rej)=>{const t=_tx('bookmarks','readwrite').add(m);t.onsuccess=()=>res(t.result);t.onerror=()=>rej(t.error);}),
  byBook:bid=>new Promise((res,rej)=>{const t=_tx('bookmarks').getAll();t.onsuccess=()=>res((t.result||[]).filter(x=>x.bookId===bid));t.onerror=()=>rej(t.error);}),
  del:id=>new Promise((res,rej)=>{const t=_tx('bookmarks','readwrite').delete(id);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
};
const idb={
  put:b=>new Promise((res,rej)=>{const t=_tx('books','readwrite').put(b);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  all:()=>new Promise((res,rej)=>{const t=_tx('books').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  putFile:(id,data,name)=>new Promise((res,rej)=>{const t=_tx('files','readwrite').put({id,data,name});t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  getFile:id=>new Promise((res,rej)=>{const t=_tx('files').get(id);t.onsuccess=()=>res(t.result||null);t.onerror=()=>rej(t.error);}),
  delFile:id=>new Promise((res,rej)=>{const t=_tx('files','readwrite').delete(id);t.onsuccess=()=>res();t.onerror=()=>rej(t.error);}),
  putProgress:(id,idx,page)=>new Promise((res,rej)=>{const t=_tx('progress','readwrite').put({bookId:id,idx,page:page==null?0:page,updatedAt:Date.now()});t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  getProgress:id=>new Promise((res,rej)=>{const t=_tx('progress').get(id);t.onsuccess=()=>res(t.result||null);t.onerror=()=>rej(t.error);}),
  getPageCache:key=>new Promise((res,rej)=>{const t=_tx('pagecache').get(key);t.onsuccess=()=>res(t.result||null);t.onerror=()=>rej(t.error);}),
  putPageCache:rec=>new Promise((res,rej)=>{const t=_tx('pagecache','readwrite').put(rec);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  delPageCacheByBook:bookId=>new Promise((res,rej)=>{
    const t=_tx('pagecache','readwrite'); const keys=[];
    const cur=t.openCursor();
    cur.onsuccess=()=>{ const c=cur.result; if(c){ if(c.value&&c.value.bookId===bookId) keys.push(c.primaryKey); c.continue(); }
      else { keys.forEach(k=>t.delete(k)); res(); } };
    cur.onerror=()=>rej(cur.error);
  }),
  allProgress:()=>new Promise((res,rej)=>{const t=_tx('progress').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  del:id=>Promise.all(['books','files','progress'].map(s=>new Promise((res,rej)=>{
    const t=db.transaction(s,'readwrite').objectStore(s).delete(id);
    t.onsuccess=()=>res();t.onerror=()=>rej(t.error);})).concat([idb.delPageCacheByBook(id).catch(()=>{})])),
  putVoice:v=>new Promise((res,rej)=>{const t=_tx('voices','readwrite').put(v);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  allVoices:()=>new Promise((res,rej)=>{const t=_tx('voices').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  delVoice:id=>new Promise((res,rej)=>{const t=_tx('voices','readwrite').delete(id);t.onsuccess=()=>res();t.onerror=()=>rej(t.error);}),
};
/* v1 → v2 迁移：原文件与进度拆到独立 store */
async function migrateV1(){
  try{
    const bs=await idb.all();
    for(const b of bs){
      let dirty=false;
      if(b.fileData){ await idb.putFile(b.id,b.fileData,b.fileName).catch(()=>{});
        delete b.fileData; delete b.fileName; b.hasFile=true; dirty=true; }
      if(b.progress){ await idb.putProgress(b.id,b.progress.idx||0).catch(()=>{});
        delete b.progress; dirty=true; }
      if(dirty) await idb.put(b).catch(()=>{});
    }
  }catch(e){ console.warn('migrate',e); }
}
const stripBook=b=>{ const c=Object.assign({},b); delete c.progress; return c; };

/* ---------- 解析器 ---------- */
/* v3.82：封面图压到 480 宽以内再存成 dataURL；任何一步失败都返回 ''，不拦导入 */
async function downscaleImage(blob, maxW, mime){
  try{
    if(!blob || blob.size<=120*1024){ const b=mime?new Blob([blob],{type:mime}):blob; return await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>res(''); r.readAsDataURL(b); }); }
    const bmp=await createImageBitmap(blob);
    const w=Math.min(bmp.width, maxW), h=Math.round(bmp.height*w/bmp.width);
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    c.getContext('2d').drawImage(bmp,0,0,w,h);
    bmp.close&&bmp.close();
    return c.toDataURL('image/jpeg', .8);
  }catch(e){ return ''; }
}
/* PDF：逐页取文本；启发式去掉重复页眉页脚与纯页码行 */
async function parsePDF(buf){
  const pdf = await pdfjsLib.getDocument({data:buf}).promise;
  const pageTexts=[];
  for (let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    let s='', prevY=null;
    for (const it of tc.items){
      if (it.str===undefined) continue;
      const y=Math.round(it.transform[5]);
      if (prevY!==null && Math.abs(y-prevY)>2) s+='\n';
      else if (s && !s.endsWith('\n')){
        const last=s[s.length-1];
        s += (isCJK(last)||isCJK(it.str[0])) ? '' : ' ';
      }
      s+=it.str; prevY=y;
    }
    pageTexts.push(s);
    if (p%10===0) loading(true,`解析 PDF ${p}/${pdf.numPages} 页…`);
  }
  // 找重复行（页眉页脚）：出现 3 页以上且短的非空行
  const cnt={};
  for (const t of pageTexts) for (const ln of new Set(t.split('\n').map(x=>x.trim()).filter(x=>x&&x.length<60))) cnt[ln]=(cnt[ln]||0)+1;
  const banned=new Set(Object.keys(cnt).filter(k=>cnt[k]>=3 && cnt[k]>=pdf.numPages*0.3));
  let cover='';
  try{
    const pg=await pdf.getPage(1);
    const vp=pg.getViewport({scale:1});
    const sc=Math.min(1, 360/vp.width);
    const v2=pg.getViewport({scale:sc});
    const c=document.createElement('canvas'); c.width=Math.round(v2.width); c.height=Math.round(v2.height);
    await pg.render({canvasContext:c.getContext('2d'), viewport:v2}).promise;
    cover=c.toDataURL('image/jpeg', .75);
  }catch(e){ cover=''; }
  const cleaned=pageTexts.map(t=>t.split('\n')
    .map(x=>x.trim())
    .filter(x=>x && !banned.has(x) && !/^\d{1,4}$/.test(x) && !/^第\s*\d+\s*页$/.test(x))
    .join('\n')).join('\n');
  return {title:'', text:cleaned, cover};
}
/* EPUB：解包 → OPF → spine 顺序取正文 */
async function parseEPUB(buf){
  const zip=await JSZip.loadAsync(buf);
  const containerTxt=await zip.file('META-INF/container.xml').async('text');
  const opfPath=(containerTxt.match(/full-path="([^"]+)"/)||[])[1];
  if(!opfPath) throw new Error('EPUB 结构异常');
  const base=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
  const opf=await zip.file(opfPath).async('text');
  const items={}; const itemTypes={};
  for (const m of opf.matchAll(/<item[^>]*>/g)){
    const tag=m[0];
    const id=(tag.match(/id="([^"]+)"/)||[])[1], href=(tag.match(/href="([^"]+)"/)||[])[1];
    if(id&&href){ items[id]=base+decodeURIComponent(href); itemTypes[id]=(tag.match(/media-type="([^"]+)"/)||[])[1]||''; }
  }
  const spineIds=[...opf.matchAll(/<itemref[^>]*idref="([^"]+)"/g)].map(m=>m[1]);
  let title=(opf.match(/<dc:title[^>]*>([^<]+)</)||[])[1]||'';
  const chapters=[];
  for (const id of spineIds){
    const f=zip.file(items[id]); if(!f) continue;
    const html=await f.async('text');
    const doc=new DOMParser().parseFromString(html,'text/html');
    doc.querySelectorAll('script,style').forEach(e=>e.remove());
    const h=doc.querySelector('h1,h2,h3');
    const cTitle=h?h.textContent.trim().slice(0,40):'';
    const text=(doc.body?doc.body.innerText:'').replace(/[ \t]+/g,' ').split('\n').map(x=>x.trim()).filter(x=>x).join('\n');
    if (text.length>20) chapters.push({title:cTitle||`第${chapters.length+1}节`, text});
  }
  if(!chapters.length) throw new Error('EPUB 没有可读正文');
  let cover='';
  try{
    let coverId=(opf.match(/<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/)||[])[1]
      || (opf.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']cover["']/)||[])[1];
    let coverHref='';
    if(coverId && items[coverId]) coverHref=items[coverId];
    if(!coverHref){
      for (const m of opf.matchAll(/<item[^>]*>/g)){
        const tag=m[0];
        if(/cover-image/.test(tag)){ const href=(tag.match(/href="([^"]+)"/)||[])[1]; if(href){ coverHref=base+decodeURIComponent(href); coverId=(tag.match(/id="([^"]+)"/)||[])[1]; break; } }
      }
    }
    if(coverHref){
      const f=zip.file(coverHref);
      if(f){ const blob=await f.async('blob'); cover=await downscaleImage(blob, 480, itemTypes[coverId]||''); }
    }
  }catch(e){ cover=''; }
  return {title:title.trim(), chapters, cover};
}
async function parseTXT(buf){
  let txt=new TextDecoder('utf-8',{fatal:false}).decode(buf);
  const bad=(txt.match(/�/g)||[]).length;
  if(txt.length>100 && bad>txt.length*0.01){
    try{ txt=new TextDecoder('gbk').decode(buf); }catch(e){}
  }
  return {title:'', text:txt.replace(/\r/g,'')};
}
async function parseDOCX(buf){
  const r=await mammoth.extractRawText({arrayBuffer:buf});
  return {title:'', text:r.value||''};
}
async function parseFB2(buf){
  const txt=new TextDecoder('utf-8').decode(buf);
  const doc=new DOMParser().parseFromString(txt,'text/xml');
  const title=(doc.querySelector('book-title')||{}).textContent||'';
  const text=[...doc.querySelectorAll('body')].map(b=>b.textContent)
    .join('\n').replace(/[ \t]+/g,' ').split('\n').map(x=>x.trim()).filter(x=>x).join('\n');
  return {title:title.trim(), text};
}
async function parseHTML(buf){
  const txt=new TextDecoder('utf-8').decode(buf);
  const doc=new DOMParser().parseFromString(txt,'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,iframe,.ad,.ads,.advertisement,.sidebar,.comment,.comments').forEach(e=>e.remove());
  // 小说站正文容器启发式：找最长的文本块
  let best=null, bestLen=0;
  const candidates=doc.querySelectorAll('article,#content,.content,#chapter,.chapter,#txt,.txt,.read-content,.novel-content,div');
  for(const el of candidates){
    const t=(el.innerText||'').trim();
    if(t.length>bestLen && t.length<500000){ bestLen=t.length; best=el; }
  }
  const root=best||doc.body;
  const text=(root.innerText||'').split('\n').map(x=>x.trim()).filter(x=>x).join('\n');
  return {title:(doc.title||'').trim(), text, doc};
}
/* 小说章节目录检测：找页面上的章节链接 */
function detectChapters(doc, baseUrl){
  const links=[];
  const seen=new Set();
  doc.querySelectorAll('a[href]').forEach(a=>{
    const href=a.getAttribute('href');
    const t=(a.textContent||'').trim();
    if(!href||!t||t.length>40||t.length<2) return;
    // 章节标题模式：第X章/节/回/卷，或纯数字标题
    if(!/第?[0-9一二三四五六七八九十百千万]+[章节回卷集]/.test(t) && !/^\d+[.、\s]/.test(t)) return;
    try{
      const u=new URL(href, baseUrl).href;
      if(seen.has(u)) return;
      seen.add(u);
      links.push({title:t, url:u});
    }catch(e){}
  });
  // 按 URL 排序（通常章节按顺序）
  return links.slice(0,200);
}
async function finalizeImport(title, format, chapters, fileData, fileName, cover){
  // 章节 → 句子
  const sentences=[]; const chIndex=[];
  chapters.forEach((c,ci)=>{
    chIndex.push({title:c.title||`第${ci+1}章`, start:sentences.length});
    for (const s of splitSentences(c.text)) sentences.push({t:s.t, p:s.p||0, c:ci});
  });
  if (!sentences.length) throw new Error('没有提取到正文');
  const sample=sentences.slice(0,30).map(s=>s.t).join(' ');
  const book={ id:uid(), title, format, addedAt:Date.now(), cover:cover||'',
    lang:detectLang(sample), total:sentences.length, sentences, chapters:chIndex,
    hasFile:!!fileData, fileName:fileName||'',
    progress:{idx:0, updatedAt:Date.now()}, voiceURI:'', voiceURI2:'', rate:100, dialogVoice:false };
  await idbRetry(()=>idb.put(stripBook(book)));
  if(fileData) await idbRetry(()=>idb.putFile(book.id,fileData,fileName)).catch(()=>{});
  await idbRetry(()=>idb.putProgress(book.id,0)).catch(()=>{});
  toast(`已导入《${title}》，共 ${sentences.length} 句`);
  return book;
}
async function importFile(file){
  loading(true,`解析 ${file.name}…`);
  try{
    const buf=await file.arrayBuffer();
    const fileData=buf.slice(0); // pdf.js 可能转移原 buffer，先复制一份存档
    const ext=file.name.split('.').pop().toLowerCase();
    // v3.76：MOBI/AZW 是二进制容器，此前被当纯文本硬解，只会产出乱码书——明确拒掉，不再假装支持
    if(ext==='mobi'||ext==='azw') throw new Error('暂不支持 MOBI / AZW，请先转成 EPUB 或 TXT 再导入');
    let title=file.name.replace(/\.[^.]+$/,''), chapters;
    let cover='';
    if (ext==='pdf'){ const r=await parsePDF(buf); chapters=splitChapters(r.text); cover=r.cover||''; }
    else if (ext==='epub'){ const r=await parseEPUB(buf); title=r.title||title; chapters=r.chapters; cover=r.cover||''; }
    else if (ext==='docx'){ const r=await parseDOCX(buf); chapters=splitChapters(r.text); }
    else if (ext==='fb2'){ const r=await parseFB2(buf); title=r.title||title; chapters=splitChapters(r.text); }
    else if (ext==='html'||ext==='htm'){ const r=await parseHTML(buf); title=r.title||title; chapters=splitChapters(r.text); }
    else { const r=await parseTXT(buf); chapters=splitChapters(r.text); }
    return await finalizeImport(title, ext, chapters, fileData, file.name, cover);
  } finally { loading(false); }
}
/* 从粘贴文本导入 */
async function importFromText(title, text){
  const t=(title||'').trim() || text.trim().split('\n')[0].slice(0,20) || '未命名';
  loading(true,'导入中…');
  try{
    const chapters=splitChapters(text);
    return await finalizeImport(t, 'txt', chapters, null, '');
  } finally { loading(false); }
}
/* 从网页 URL 导入 */
async function importFromURL(url){
  loading(true,'抓取网页…');
  try{
    const r=await fetch(url);
    if(!r.ok) throw new Error('抓取失败('+r.status+')');
    const html=await r.text();
    const buf=new TextEncoder().encode(html).buffer;
    const res=await parseHTML(buf);
    const title=(res.title||'网页文章').split(/[-_|]/)[0].trim()||'网页文章';
    // 小说目录检测
    let chapters=null;
    if(res.doc){
      const found=detectChapters(res.doc, url);
      if(found.length>=3){
        const go=confirm(`检测到 ${found.length} 个章节，是否批量导入全书？\n\n点"确定"批量抓取（可能需要几分钟），点"取消"只导入当前页。`);
        if(go){
          chapters=await importNovelChapters(found, title);
        }
      }
    }
    if(!chapters){
      chapters=splitChapters(res.text);
    }
    return await finalizeImport(title, 'html', chapters, null, '');
  }catch(e){
    throw new Error(/Failed to fetch|NetworkError|CORS/i.test(e.message)?'该网页不允许跨域抓取，试试复制正文用「粘贴文本」导入':e.message);
  }finally{ loading(false); }
}
/* 批量抓取小说章节 */
async function importNovelChapters(links, bookTitle){
  const chapters=[];
  const total=Math.min(links.length, 100); // 最多100章
  for(let i=0;i<total;i++){
    loading(true, `抓取章节 ${i+1}/${total}…`);
    try{
      const r=await fetch(links[i].url);
      if(!r.ok) continue;
      const html=await r.text();
      const buf=new TextEncoder().encode(html).buffer;
      const res=await parseHTML(buf);
      if(res.text.length>200){
        chapters.push({title:links[i].title, text:res.text});
      }
    }catch(e){ /* 跳过失败章节 */ }
    // 礼貌间隔
    await new Promise(r=>setTimeout(r, 500));
  }
  if(!chapters.length) throw new Error('章节抓取失败');
  return chapters;
}

/* ---------- 书架 ---------- */
const COVERS=[['#3b2f4a','#7a5fa0'],['#1f3a4d','#3f7fae'],['#4a2f2b','#a06a5f'],
  ['#2b4a35','#5fa07a'],['#4d4420','#ae9a3f'],['#333','#777']];
let books=[];
function coverBG(b){ const [c1,c2]=COVERS[(b.title||'').length%COVERS.length];
  return `linear-gradient(135deg,${c1},${c2})`; }
const coverHTML=(b,cls)=> b.cover
  ? `<div class="cover ${cls}"><img src="${b.cover}" alt=""></div>`
  : `<div class="cover ${cls}" style="background:${coverBG(b)}">${esc((b.title||'?').slice(0,12))}</div>`;
/* v3.82：卡片封面统一走这里——有真实封面用图，没有用渐变字 */
const coverInner=b=> b.cover
  ? `<img src="${b.cover}" alt="">`
  : `<div class="ct" style="background:${coverBG(b)}">${esc((b.title||'?').slice(0,10))}</div>`;
/* v3.82：详情/迷你条/全屏播放器的封面位统一走这里（有图用图，没有用渐变字） */
function setCoverEl(el, b, n){
  if(!el||!b) return;
  if(b.cover){ el.style.background=''; el.innerHTML=`<img src="${b.cover}" alt="">`; }
  else { el.style.background=coverBG(b); el.textContent=(b.title||'?').slice(0,n); }
}
async function loadBooks(){
  books=await idb.all();
  const pm={}; try{ (await idb.allProgress()).forEach(p=>pm[p.bookId]=p); }catch(e){}
  books.forEach(b=>{ b.progress = pm[b.id]
    ? {idx:pm[b.id].idx, updatedAt:pm[b.id].updatedAt}
    : {idx:0, updatedAt:b.addedAt}; });
  books.sort((a,b)=>b.progress.updatedAt-a.progress.updatedAt);
}
let shelfSort='recent', shelfFmt='all', shelfQuery='';
/* ---------- 书架分类 ---------- */
let shelfCat = '';
const getCats = () => { try{ return JSON.parse(localStorage.getItem('dr_cats')||'[]'); }catch(e){ return []; } };
const saveCats = c => { try{ localStorage.setItem('dr_cats', JSON.stringify(c)); }catch(e){} };
function renderCatBar(){
  const bar = $('#cat-bar');
  if(!bar) return;
  const cats = getCats();
  let h = `<button class="shelf-chip${!shelfCat?' active':''}" data-c="">全部</button>`;
  for(const c of cats) h += `<button class="shelf-chip${shelfCat===c?' active':''}" data-c="${esc(c)}">${esc(c)}</button>`;
  h += `<button class="shelf-chip add-chip" data-c="__new">＋ 新建分类</button>`;
  bar.innerHTML = h;
  bar.querySelectorAll('[data-c]').forEach(b => {
    b.onclick = () => {
      const c = b.dataset.c;
      if(c === '__new'){
        const n = prompt('新分类名称：', '');
        if(n && n.trim()){
          const cats = getCats();
          if(!cats.includes(n.trim())){ cats.push(n.trim()); saveCats(cats); }
          shelfCat = n.trim(); renderCatBar(); renderShelf();
        }
        return;
      }
      shelfCat = c; renderCatBar(); renderShelf();
    };
  });
}
async function renderShelf(){
  await loadBooks();
  renderCatBar();
  const has=books.length>0;
  $('#shelf-empty').classList.toggle('hidden',has);
  $('#shelf-has').classList.toggle('hidden',!has);
  $('#recent-section').classList.toggle('hidden',!has);
  if(!has){ updateMiniPlayer(); return; }

  const recent=[...books].sort((a,b)=>(b.progress?.updatedAt||0)-(a.progress?.updatedAt||0)).slice(0,8);
  const recentList=$('#recent-list');
  recentList.innerHTML=recent.map(b=>{
    const pct=Math.round(100*(b.progress?.idx||0)/Math.max(1,b.total||1));
    const done=(b.progress?.idx||0)>=((b.total||1)-1)&&(b.total||1)>1;
    return `<button class="recent-card" data-book-index="${recent.indexOf(b)}">
      <span class="recent-cover">${coverInner(b)}</span>
      <span class="recent-info"><strong>${esc(b.title||'未命名书籍')}</strong><small>${esc(b.author||'未知作者')}</small><span class="recent-progress">${done?'已读完':pct+'%'}</span></span>
    </button>`;
  }).join('');
  recentList.querySelectorAll('[data-book-index]').forEach(el=>el.onclick=async()=>{ returnView='library'; await openBook(recent[Number(el.dataset.bookIndex)].id); });
  $('#recent-count').textContent=recent.length?String(recent.length):'';

  const query=($('#shelf-filter')?.value||shelfQuery).trim().toLocaleLowerCase();
  shelfQuery=query;
  const format=$('#shelf-format')?.value||shelfFmt;
  shelfFmt=format;
  let filtered=shelfCat?books.filter(b=>(b.cat||'')===shelfCat):[...books];
  if(format&&format!=='all') filtered=filtered.filter(b=>String(b.format||'').toLowerCase().includes(format));
  if(query) filtered=filtered.filter(b=>String(b.title||'').toLocaleLowerCase().includes(query)||String(b.author||'').toLocaleLowerCase().includes(query));
  if(shelfSort==='title') filtered.sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),'zh'));
  else if(shelfSort==='added') filtered.sort((a,b)=>(b.addedAt||b.createdAt||b.progress?.updatedAt||0)-(a.addedAt||a.createdAt||a.progress?.updatedAt||0));
  else filtered.sort((a,b)=>(b.progress?.updatedAt||0)-(a.progress?.updatedAt||0));

  $('#shelf-count').textContent=`${filtered.length} 本`;
  $('#shelf-no-results').classList.toggle('hidden',filtered.length>0);
  const list=$('#shelf-list'); list.classList.toggle('hidden',filtered.length===0); list.innerHTML='';
  filtered.forEach(b=>{
    const pct=Math.round(100*(b.progress?.idx||0)/Math.max(1,b.total||1));
    const done=(b.progress?.idx||0)>=((b.total||1)-1)&&(b.total||1)>1;
    const el=document.createElement('button'); el.type='button'; el.className='bk-row';
    el.innerHTML=`<span class="cov">${coverInner(b)}
      ${pct?`<span class="pbdg${done?' done':''}">${done?'✓':pct+'%'}</span>`:''}</span>
      <span class="inf"><span class="t">${esc(b.title||'未命名书籍')}</span>
      <span class="a">${esc(b.author||'未知作者')}</span>
      <span class="fb">${esc((b.format||'').toUpperCase()||'BOOK')}</span></span>`;
    el.onclick=async()=>{ returnView='library'; await openBook(b.id); };
    el.oncontextmenu=e=>{e.preventDefault();openBookMenu(b);};
    list.appendChild(el);
  });
  updateMiniPlayer();
}
/* 书籍操作菜单 */
let menuBook=null;
function openBookMenu(b){
  menuBook=b;
  const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
  $('#bm-title').textContent=b.title;
  $('#bm-sub').textContent=`${b.total}句 · 已读${pct}%`;
  $('#bm-dl').classList.toggle('hidden', !b.hasFile);
  openSheet('book-menu');
}
$('#bm-open').onclick=async()=>{ closeSheets(); if(menuBook){ returnView='library'; await openBook(menuBook.id); } };
$('#bm-dl').onclick=()=>{ closeSheets(); if(menuBook) downloadBook(menuBook); };
$('#bm-cat').onclick=()=>{
  const b=menuBook; if(!b) return;
  const cats=getCats();
  const cur=(b.cat||'');
  let msg='选择分类（输入新名称可创建）：\n0. 无分类\n';
  cats.forEach((c,i)=>msg+=`${i+1}. ${c}${c===cur?'（当前）':''}\n`);
  const inp=prompt(msg+'\n输入序号或新名称：','');
  if(inp===null){ return; }
  const t=inp.trim();
  let nc='';
  if(t==='0') nc='';
  else if(/^\d+$/.test(t)&&+t>=1&&+t<=cats.length) nc=cats[+t-1];
  else if(t) { nc=t; if(!cats.includes(t)){cats.push(t);saveCats(cats);} }
  else return;
  b.cat=nc; idb.put(b).then(()=>{ closeSheets(); renderCatBar(); renderShelf(); toast(nc?`已移到「${nc}」`:'已移出分类'); });
};
$('#bm-del').onclick=async()=>{ const b=menuBook; closeSheets(); if(!b) return;
  if(confirm(`删除《${b.title}》？`)){ await idb.del(b.id); if(cur&&cur.id===b.id){cur=null;stopSpeak();} renderShelf(); } };
$('#shelf-filter').addEventListener('input',e=>{shelfQuery=e.currentTarget.value;renderShelf();});
$('#shelf-format').addEventListener('change',e=>{shelfFmt=e.currentTarget.value;renderShelf();});
$('#shelf-sort').addEventListener('change',e=>{shelfSort=e.currentTarget.value;renderShelf();});
$('#recent-next').onclick=()=>$('#recent-list').scrollBy({left:Math.max(260,$('#recent-list').clientWidth*.8),behavior:'smooth'});
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function downloadBook(b){
  const f=await idb.getFile(b.id).catch(()=>null);
  if(!f||!f.data){ toast('这本书没有保存原文件'); return; }
  const blob=new Blob([f.data]);
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=f.name||(b.title+'.'+b.format); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),8000); toast('开始下载');
}

/* ---------- 阅读器 ---------- */
let cur=null, sentEls=[];
let readerFindMatches=[], readerFindIndex=0, readerFindQuery='', readerMatchSet=new Set();
/* ---------- v3 导航 ---------- */
const VIEWS=['splash','home','library','reader','mine','notes','bookchat','bookmarks','stats','search','voice','badges'];
const CLASSICS=['红楼梦','西游记','三国演义','水浒传','聊斋志异','儒林外史','镜花缘','老残游记']; // v3.86：提前声明，启动 go('home') 在 CLASSICS 原位置之前，防 TDZ
let curView='home', returnView='library';
function go(name){
  if(!VIEWS.includes(name)) name='home';
  curView=name;
  VIEWS.forEach(v=>{ const el=$('#view-'+v); if(el) el.classList.toggle('hidden', v!==name); });
  document.body.classList.toggle('in-reader', name==='reader');
  document.body.classList.toggle('in-splash', name==='splash');
  document.querySelectorAll('#tabbar .tab').forEach(t=>t.classList.toggle('cur', t.dataset.v===name));
  document.querySelectorAll('#sidebar .sb-item').forEach(t=>t.classList.toggle('cur', t.dataset.v===name));
  // v3.76：渲染失败不得掐断导航尾巴（此前 renderStats 一抛错，updateMiniPlayer/scrollTo 全不执行）
  try{
    if(name==='library'){ stopSpeak(); renderShelf(); }
    else if(name==='home'){ stopSpeak(); renderHome(); }
    else if(name==='mine'){ stopSpeak(); }
    else if(name==='voice'){ stopSpeak(); if(typeof renderVoice==='function') renderVoice(); }
    else if(name==='notes'){ stopSpeak(); renderNotesList(); }
    else if(name==='bookchat'){ stopSpeak(); }
    else if(name==='bookmarks'){ stopSpeak(); renderBookmarksList(); }
    else if(name==='stats'){ stopSpeak(); renderStatsDetail('week'); }
    else if(name==='badges'){ stopSpeak(); renderBadges(); }
  }catch(e){ console.error('[Apo] 渲染失败：', name, e); }
  try{ updateMiniPlayer(); }catch(e){ console.error('[Apo] 迷你播放器刷新失败：', e); }
  window.scrollTo(0,0);
}
function showView(name){ go(name); } // 兼容旧调用
async function openBook(id){
  document.body.classList.remove('reader-immersive'); // v3.88：每次开书回到正常模式，点按一次再进沉浸
  cur=books.find(b=>b.id===id);
  if(!cur){
    const all=await idb.all().catch(()=>[]);
    const b=all.find(x=>x.id===id);
    if(b){
      // IDB 里书的 progress 被 stripBook 删了（进度存在 progress 表里），按 loadBooks 的办法补上，否则后面 cur.progress.idx 全炸
      const pr=await idb.getProgress(id).catch(()=>null);
      b.progress=pr?{idx:pr.idx||0, updatedAt:pr.updatedAt||Date.now()}:{idx:0, updatedAt:b.addedAt||Date.now()};
      books.unshift(b); cur=b;
    }
    else { toast('找不到这本书'); return; }
  }
  readerFindMatches=[]; readerFindIndex=0; readerFindQuery=''; readerMatchSet.clear();
  const rf=$('#cd-search-q'); if(rf) rf.value='';
  const drw=$('#chapter-drawer'); if(drw) drw.classList.add('hidden');
  const pdfBtn=$('#btn-reader-pdf'); if(pdfBtn) pdfBtn.classList.toggle('hidden', !(cur.format==='pdf' && cur.hasFile));
  document.title='Apo · '+cur.title;
  // 清空上本书的翻译缓存，加载这本的
  for(const k in trCache) delete trCache[k];
  trProgress = 0; trRunning = false; updateTrProgress();
  loadBookTranslations();
  go('reader'); renderWindow(cur.progress.idx);
  __lastW=pagesEl().clientWidth||0;
  renderChapters(); updatePlayer();
  requestAnimationFrame(()=>{ bootPagination(); });
  applyBookVoice(); updateMiniPlayer();
}
/* ---------- 分窗渲染（v3.19）：长书只渲染当前窗口句子，避免多列一次性排几千句卡死 ---------- */
const WIN_SIZE=500;
let winStart=0; // sentEls[i] 对应全局 idx = winStart+i
let pgVer=0, winVer=-1; // 分页版本号：starts 变化时窗口必须重渲染
function renderWindow(centerIdx){
  const c=$('#content'); if(!c||!cur) return;
  const total=cur.total, ci0=Math.max(0,Math.min(total-1,centerIdx));
  let s;
  if(PG.ready&&PG.starts.length){
    // 对齐到页边界：窗口内分列与全局分页完全一致，localPageOf 才精确
    s=sentenceOfPage(pageOfSentence(ci0));
    s=Math.max(0, s-120); // 向前预渲染一点
    s=sentenceOfPage(pageOfSentence(s));
  }else{
    s=Math.max(0, Math.floor(ci0/WIN_SIZE)*WIN_SIZE - WIN_SIZE);
  }
  const e=Math.min(total, s+WIN_SIZE*3);
  winStart=s; winVer=pgVer;
  c.innerHTML=''; sentEls=[];
  let ci=s>0?cur.sentences[s-1].c:-1; // 继承上一句章节，窗口开头不重复标题顶开内容
  for(let i=s;i<e;i++){
    const sn=cur.sentences[i];
    if(sn.c!==ci){ ci=sn.c;
      // v3.93：单章且标题是默认“正文”时不渲染标题（Readify 导入 TXT 直接出正文）
      if(!(cur.chapters.length===1 && cur.chapters[0] && cur.chapters[0].title==='正文')){
        const h=document.createElement('span'); h.className='ch-title';
        h.textContent=cur.chapters[ci]?cur.chapters[ci].title:`第${ci+1}章`; c.appendChild(h);
      }
    }
    if(sn.p){ const pb=document.createElement('span'); pb.className='para-break'; c.appendChild(pb); }
    const sp=document.createElement('span'); sp.className='sent'+(readerFindQuery&&readerMatchSet.has(i)?' find-hit':''); sp.textContent=sn.t; sp.dataset.g=i;
    sp.onclick=(()=>{ const g=i; return ()=>{ if(pageTouchMoved || window.getSelection().toString()) return; if(typeof Flip!=='undefined' && Flip.suppressSentClick){ Flip.suppressSentClick=false; return; } seekTo(g, true); }; })();
    c.appendChild(sp); c.appendChild(document.createTextNode(' ')); sentEls.push(sp);
  }
  layoutPages();
}
/* ---------- 独立分页 + 仿真翻页（v3.21） ----------
 * 每本书独立的页码体系（见 js/paginate.js），一列即一页；
 * 手势与翻页动画见 js/flip.js，本文件负责页状态与渲染窗口的衔接。 */
let pageTouchMoved=false;
const pagesEl=()=>$('#reader-pages');
function readerPadX(el){ const ps=getComputedStyle(el); return (parseFloat(ps.paddingLeft)||0)+(parseFloat(ps.paddingRight)||0); }
function layoutPages(){
  const el=pagesEl(); if(!el||!cur) return;
  const w=el.clientWidth||0;
  if(w<10) return; // 阅读器隐藏时不写，避免 200px 最小列宽污染后续排版
  el.style.columnWidth=Math.max(200, w-readerPadX(el))+'px'; // 多列直接建在滚动容器上（一列一页）
  el.style.columnGap=readerPadX(el)+'px'; // v3.88：列间距 = 总横向内边距，列进位(列宽+间距)恒等于容器宽，翻页不漂移
}
/* 全局页 -> 当前渲染窗口内的列号 */
function localPageOffset(){ return (PG.ready&&PG.starts.length)?pageOfSentence(winStart):0; }
function localPageOf(gp){ return gp-localPageOffset(); }
function ensureWindowForPage(gp){
  const s0=sentenceOfPage(gp);
  if(winVer!==pgVer||s0<winStart||s0>=winStart+sentEls.length) renderWindow(s0);
}
function showPageInstant(gp){
  if(!cur) return;
  gp=PG.ready?Math.max(0,Math.min(PG.total-1,gp)):0;
  const el=pagesEl(), W=el.clientWidth||1;
  if(W>10){ // 自愈：列宽若与当前视口不符先重算；清除橡皮筋残留位移
    const want=W-readerPadX(el), has=parseFloat(el.style.columnWidth||'0');
    if(Math.abs(has-want)>2) layoutPages();
    if(el.style.transform){ el.style.transition=''; el.style.transform=''; }
  }
  ensureWindowForPage(gp);
  el.scrollTo({left:localPageOf(gp)*W, behavior:'auto'});
  PG.page=gp; commitPageState();
  verifyPageAlignment(gp, W);
}
// 实测纠偏：目标页首句应在列首 x≈padding，偏差则直接纠正
// v3.86 修：先算首句实际在第几列——只有它确实在目标列时才纠（列进位 4px/页的累积漂移）；
// 若首句在别的列，说明分页与实际排版脱节，硬挪滚动只会造出「半页+半页」的错位，这时不动，等重排。
function verifyPageAlignment(gp, W){
  if(!PG.ready || !W || W<=10) return;
  requestAnimationFrame(()=>{
    if(!cur || PG.page!==gp || Flip.active) return;
    try{
      const el = pagesEl();
      // v3.91：滚动以页边界为准（localPageOf*W），不以首句位置为准。
      // 首句位置由分页算出，分页有误差时按首句纠会把滚动推到非页边界（两列之间）——
      // 末页就是这么错乱的（scrollLeft 573，应为 390）。页边界是 ground truth，每页恰好一容器宽。
      const target = localPageOf(gp) * W;
      const diff = el.scrollLeft - target;
      if(Math.abs(diff) > 3 && Math.abs(diff) < W/2){
        el.scrollTo({left: target, behavior:'auto'});
      }
    }catch(e){}
  });
}
function commitPage(gp){ PG.page=gp; commitPageState(); }
function commitPageState(){ updateCount(); saveProgress(); updatePlayer(); }
/* 对外翻页入口：相邻页走仿真翻页动画，跨页直接切换 */
function setPage(gp, opts){
  opts=opts||{};
  if(!cur||!PG.ready) return;
  gp=Math.max(0,Math.min(PG.total-1,gp));
  const rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(opts.animate!==false&&!rm&&Math.abs(gp-PG.page)===1) Flip.animateTo(gp);
  else showPageInstant(gp);
}
function updateCount(){
  const rc=$('#reader-count');
  if(rc) rc.textContent=(PG.ready&&PG.total>0)?('第'+(PG.page+1)+'页/共'+PG.total+'页'):'';
}
/* ---------- 分页启动 / 重排 ---------- */
let __lastW=0;
async function bootPagination(){
  applyType();
  const h=pageHash();
  PG.bookId=cur.id; PG.hash=h; PG.ready=false; PG.starts=[]; PG.total=1; PG.page=0;
  updateCount();
  layoutPages();
  let rec=null; try{ rec=await idb.getProgress(cur.id); }catch(e){}
  const hit=await idb.getPageCache(cur.id+'|'+h).catch(()=>null);
  if(hit&&hit.starts&&hit.starts.length){
    PG.starts=hit.starts; PG.total=hit.total; PG.ready=true; pgVer++;
    const p=(rec&&rec.page!=null)?Math.max(0,Math.min(PG.total-1,rec.page)):pageOfSentence(rec?rec.idx:0);
    showPageInstant(p);
  }else{
    positionNearSentence(rec?rec.idx:0);      // 缓存未命中：先就近显示，后台再算
    paginateInBackground(h, rec?rec.idx:0);
  }
}
/* 分页就绪前，把静态层定位到句子 gi 所在的窗口列（旧 pageOfEl 逻辑） */
function positionNearSentence(gi){
  gi=Math.max(0,Math.min(cur.total-1,gi));
  const el=sentEls[gi-winStart]; if(!el) return;
  const r=el.getBoundingClientRect(), cr=pagesEl().getBoundingClientRect(), W=pagesEl().clientWidth||1;
  const lp=Math.max(0,Math.round((r.left-cr.left+pagesEl().scrollLeft)/W));
  pagesEl().scrollTo({left:lp*W, behavior:'auto'});
}
async function paginateInBackground(h, idx, attempt){
  attempt=attempt||0;
  let res=null;
  try{ res=await paginateBook(cur, h); }catch(e){ res=null; }
  if(!res){
    // 测量异常/被打断：600ms 后重试一次（最多 2 次），不再静默丢弃——
    // 丢弃后 PG.ready 恒 false，页码指示会一直空白（D8）
    if(attempt<2) setTimeout(()=>{ if(cur&&curView==='reader'&&!PG.ready&&pageHash()===h) paginateInBackground(h, idx, attempt+1); },600);
    return;
  }
  if(!cur||PG.bookId!==cur.id||pageHash()!==h) return;    // 书已切换或排版已变
  PG.starts=res.starts; PG.total=res.total; PG.ready=true; pgVer++;
  try{ await idb.putPageCache({key:cur.id+'|'+h, bookId:cur.id, hash:h, starts:res.starts, total:res.total, updatedAt:Date.now()}); }catch(e){}
  const target=pageOfSentence(Math.max(0,Math.min(cur.total-1,idx||0)));
  if(target!==PG.page) showPageInstant(target);
  else { updateCount(); verifyPageAlignment(target, pagesEl().clientWidth||1); } // v3.86：即使页码相同，也要验一次粗定位（positionNearSentence）的滚动是否对齐
}
let _pgT=null;
function scheduleRepaginate(){ clearTimeout(_pgT); _pgT=setTimeout(()=>{ repaginate(); },300); }
async function repaginate(){
  if(!cur||curView!=='reader'||Flip.active){ if(cur&&curView==='reader'&&Flip.active) scheduleRepaginate(); return; }
  const h=pageHash();
  if(h===PG.hash&&PG.ready){ layoutPages(); showPageInstant(PG.page); return; }
  const keepIdx=cur.progress.idx;
  PG.hash=h; PG.ready=false; PG.starts=[]; PG.total=1; updateCount();
  layoutPages();
  const hit=await idb.getPageCache(cur.id+'|'+h).catch(()=>null);
  if(hit&&hit.starts&&hit.starts.length){
    PG.starts=hit.starts; PG.total=hit.total; PG.ready=true; pgVer++;
    showPageInstant(pageOfSentence(keepIdx));
  }else paginateInBackground(h, keepIdx);
}
/* 手势绑定（替代旧的 scroll-snap） */
function bindReaderGestures(){
  bindFlip();
  let rT=null;
  window.addEventListener('resize',()=>{ clearTimeout(rT); rT=setTimeout(()=>{
    if(Flip.active||curView!=='reader'||!cur||!PG.ready) return;
    const w=pagesEl().clientWidth||0;
    if(Math.abs(w-__lastW)<2) return; // 纯高度变化（安卓地址栏显隐）不重排，避免分页乱跳
    __lastW=w;
    repaginate(); // 宽度变了（旋转/折叠屏/分屏）才重算
  },280); });
  if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>{ scheduleRepaginate(); });
  // 桌面端：左右方向键翻页（移动端走触屏手势）
  window.addEventListener('keydown',e=>{
    if(curView!=='reader'||!cur||!PG.ready||Flip.active) return;
    const tag=(document.activeElement&&document.activeElement.tagName)||'';
    if(/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if(e.key==='ArrowRight'){ e.preventDefault(); setPage(PG.page+1,{animate:true}); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); setPage(PG.page-1,{animate:true}); }
  });
}
function renderChapters(){
  const l=$('#chapter-list'); l.innerHTML='';
  const curCh=cur?chapterOf(cur.progress.idx):-1;
  cur.chapters.forEach((c,i)=>{
    const d=document.createElement('div'); d.className='ch'+(i===curCh?' cur':''); d.textContent=c.title;
    d.onclick=()=>{ seekTo(c.start); $('#chapter-drawer').classList.add('hidden'); };
    l.appendChild(d);
  });
}
const chapterOf=i=>{ let r=0; cur.chapters.forEach((c,ci)=>{ if(c.start<=i) r=ci; }); return r; };
function scrollToActive(smooth=true){
  if(!cur||!PG.ready) return;
  setPage(pageOfSentence(cur.progress.idx), {animate:smooth});
}
function markActive(){
  if(!cur) return;
  let gi=cur.progress.idx-winStart;
  if(gi<0||gi>=sentEls.length){ renderWindow(cur.progress.idx); gi=cur.progress.idx-winStart; }
  sentEls.forEach((el,i)=>el.classList.toggle('active', i===gi));
  if(wantPlay&&PG.ready){ const gp=pageOfSentence(winStart+gi); if(gp!==PG.page) setPage(gp,{animate:true}); }
  updatePlayer();
}
async function saveProgress(){
  if(!cur) return;
  cur.progress.updatedAt=Date.now();
  try{ await idb.putProgress(cur.id, cur.progress.idx, PG.page); }catch(e){}
}
/* 书籍元信息（音色/语速/对白开关）变更时才写整本 */
async function saveBook(){
  if(!cur) return;
  try{ await idb.put(stripBook(cur)); }catch(e){}
}
function seekTo(i, autoplay){
  if(!cur) return;
  const wasPlaying=wantPlay;   // stopSpeak 会清 wantPlay，先记下来
  stopSpeak();
  cur.progress.idx=Math.max(0,Math.min(cur.total-1,i));
  cur._lastSpk=null; // 多角色说话人追踪重置
  markActive(); scrollToActive(); saveProgress();
  if(autoplay||wasPlaying) play();   // 目录跳转/进度条只在原本在播时续播
}
const fmtRate=sp=>{ let s=sp.toFixed(2).replace(/0+$/,''); if(s.endsWith('.')) s+='0'; return s+'x'; };
function updatePlayer(){
  if(!cur) return;
  // v3.92：进度按当前页算（阅读位置），不是按朗读 idx——翻页时线也要走；朗读时页会跟着走，线一样走
  const pct=(PG.ready&&PG.total>0)?100*sentenceOfPage(PG.page)/Math.max(1,cur.total):0;
  updateCount();
  const sk=$('#rp-seek'); if(sk){ sk.value=Math.round(pct*10); sk.style.setProperty('--p', pct+'%'); }
  const tm=estTimes();
  const el=$('#rp-elapsed'); if(el) el.textContent=fmtClock(tm.el);
  const rm=$('#rp-remaining'); if(rm) rm.textContent='-'+fmtClock(tm.total-tm.el);
  const ch=cur.chapters[chapterOf(cur.progress.idx)];
  const rh=$('#reader-chapter'); if(rh) rh.textContent=ch?ch.title:cur.title;
  const spt=$('#rp-speed-v');
  if(spt) spt.textContent=fmtRate(cur.rate/100);
  setCoverEl($('#rp-cover'), cur, 6);
}
/* v3.83：进度条已改成 #rp-seek 滑杆 + 时间显示 */

/* v3.83：智能重排——按章节重算分段（段落粘在一起的书重新分段），章节标题与数量不变 */
function reflowBook(){
  if(!cur) return;
  const newSentences=[]; const newCh=[];
  cur.chapters.forEach((c,ci)=>{
    const part=cur.sentences.filter(s=>s.c===ci);
    const text=part.map(s=>s.t).join('');
    newCh.push({title:c.title, start:newSentences.length});
    for(const s of splitSentences(text)) newSentences.push({t:s.t, p:s.p||0, c:ci});
  });
  if(!newSentences.length) return;
  cur.sentences=newSentences; cur.total=newSentences.length; cur.chapters=newCh;
  cur.progress.idx=Math.min(cur.progress.idx, cur.total-1);
  idb.put(stripBook(cur)).catch(()=>{});
  idb.delPageCacheByBook(cur.id).catch(()=>{});
  closeSheets();
  scheduleRepaginate();
  toast('已智能重排段落');
}
$('#btn-reflow').onclick=reflowBook;

/* ---------- 语音引擎（Web Speech API） ---------- */
const synth=window.speechSynthesis;
let voices=[], playing=false, wantPlay=false, resumeTimer=null, wakeLock=null, sysTtsErrs=0;
function refreshVoices(){
  voices=synth?synth.getVoices():[];
  const sel=$('#sel-voice'), sel2=$('#sel-voice2');
  const cur1=sel.value, cur2=sel2.value;
  sel.innerHTML=''; sel2.innerHTML='<option value="">（同上）</option>';
  const zh=voices.filter(v=>v.lang.toLowerCase().startsWith('zh'));
  const en=voices.filter(v=>v.lang.toLowerCase().startsWith('en'));
  const rest=voices.filter(v=>!zh.includes(v)&&!en.includes(v));
  const add=(v,parent)=>{ const o=document.createElement('option');
    o.value=v.voiceURI; o.textContent=`${v.name}（${v.lang}）`; parent.appendChild(o); };
  const grp=(label,list,parent)=>{ if(!list.length)return;
    const g=document.createElement('optgroup'); g.label=label; list.forEach(v=>add(v,g)); parent.appendChild(g); };
  grp('中文',zh,sel); grp('英文',en,sel); grp('其他',rest,sel);
  grp('中文',zh,sel2); grp('英文',en,sel2); grp('其他',rest,sel2);
  if(cur1) sel.value=cur1; if(cur2) sel2.value=cur2;
}
if(synth){ refreshVoices(); synth.onvoiceschanged=refreshVoices; }
function pickVoice(book){
  let v=voices.find(v=>v.voiceURI===book.voiceURI);
  if(!v){ // 广场选用的全局默认音色
    try{
      const d=JSON.parse(store.get('voice_default','null'));
      if(d&&d.voiceURI) v=voices.find(x=>x.voiceURI===d.voiceURI);
    }catch(e){}
  }
  if(!v){
    const pref=book.lang==='zh'?'zh':'en';
    v=voices.find(v=>v.lang.toLowerCase().startsWith(pref)&&v.localService)
      ||voices.find(v=>v.lang.toLowerCase().startsWith(pref))
      ||voices[0];
  }
  return v||null;
}
const isDialog=t=>/^\s*[“"『「]/.test(t);
function speakCurrent(){
  if(!cur) return;
  // v3.76：进度越界/空句时不再假装"正在播放"——直接停掉并复位播放键
  const s=cur.sentences[cur.progress.idx]; if(!s){ wantPlay=false; setPlayUI(); return; }
  // v3.6 多角色：按说话人选音色（启发式识别）
  const castT=(typeof castVoiceFor==='function')?castVoiceFor(s.t,cur):null;
  const _eng=store.get('tts_engine');
  if(_eng==='custom'||_eng==='elevenlabs'){ speakCustom(s, castT&&castT.kind==='custom'?castT.voiceId:null); return; }
  if(!synth){ toast('当前浏览器不支持语音朗读'); return; }
  if(!voices.length && !pickVoice(cur)){ wantPlay=false; setPlayUI(); toast('系统里没有可用的语音，请检查手机的语音设置'); return; }
  synth.cancel();
  const u=new SpeechSynthesisUtterance(s.t);
  let v, pr={rate:1,pitch:1};
  const prosodyOfName=n=>{ const e=VOICE_CATALOG.find(x=>x.name===n); return e?{rate:e.rate||1,pitch:e.pitch||1}:{rate:1,pitch:1}; };
  if(castT&&castT.kind==='system'&&castT.voice){ v=castT.voice; if(castT.entry) pr={rate:castT.entry.rate||1,pitch:castT.entry.pitch||1}; }
  else{
    v=pickVoice(cur);
    try{ const d=JSON.parse(store.get('voice_default','null')); if(d&&d.name) pr=prosodyOfName(d.name); }catch(e){}
    if(cur.dialogVoice && isDialog(s.t)){
      const v2=voices.find(v=>v.voiceURI===cur.voiceURI2);
      if(v2&&v2!==v) v=v2;
      else { const alt=voices.find(x=>x!==v&&x.lang===v.lang); if(alt) v=alt; }
    }
  }
  if(v) u.voice=v;
  u.rate=(cur.rate/100)*pr.rate; u.pitch=pr.pitch;
  if(store.get('tts_emotion','0')==='1'){
    const _t=(s.t||'').trim();
    if(/[？?]\s*$/.test(_t)){ u.pitch=Math.min(1.5,(pr.pitch||1)+0.15); u.rate=u.rate*1.05; }
    else if(/[！!]\s*$/.test(_t)){ u.pitch=Math.min(1.5,(pr.pitch||1)+0.2); u.rate=u.rate*1.1; }
    else if(/…\s*$/.test(_t)){ u.pitch=Math.max(0.5,(pr.pitch||1)-0.05); u.rate=u.rate*0.85; }
  }
  u.onend=()=>{ if(!wantPlay) return; sysTtsErrs=0;
    if(cur.progress.idx<cur.total-1){ cur.progress.idx++; markActive(); saveProgress(); speakCurrent(); }
    else { if(store.get('loop_play','0')==='1'){ cur.progress.idx=0; markActive(); saveProgress(); toast('循环播放：从头再读'); speakCurrent(); } else { wantPlay=false; setPlayUI(); saveProgress(); toast('本章播完'); } }
  };
  // v3.76：系统语音持续出错时最多重试 3 次，之后停掉并明说，不再每 600ms 无限重试
  u.onerror=e=>{ if(e.error!=='interrupted'&&wantPlay){ sysTtsErrs++;
    if(sysTtsErrs>=3){ wantPlay=false; setPlayUI(); toast('系统语音出错，已停止朗读：换个音色或重启 App 再试'); }
    else setTimeout(()=>{if(wantPlay)speakCurrent();},600); } };
  synth.speak(u);
  markActive();
  clearInterval(resumeTimer); // Chrome 长文本暂停 bug 兜底
  resumeTimer=setInterval(()=>{ if(wantPlay&&synth.paused) synth.resume(); },8000);
}
async function speakCustom(s, voiceId){
  if(synth) synth.cancel();
  markActive();
  try{
    if(store.get('tts_engine')==='elevenlabs') await ElevenTTS.speak(s.t, voiceId);
    else await CustomTTS.speak(s.t, voiceId);
  }
  catch(e){ if(!wantPlay) return; toast('自定义TTS失败：'+e.message); stopSpeak(); return; }
  if(!wantPlay) return;
  if(cur.progress.idx<cur.total-1){ cur.progress.idx++; markActive(); saveProgress(); speakCurrent(); }
  else { wantPlay=false; setPlayUI(); saveProgress(); toast('播完'); }
}
const PLAY_ICON='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 2v20l14-10z"/></svg>'; // Readify：高窄三角（14x20/44px），光学中心略偏右
const PAUSE_ICON='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2.5" y="3" width="6.5" height="18" rx="2"/><rect x="15" y="3" width="6.5" height="18" rx="2"/></svg>'; // Readify：两竖条各 7x18、间隔 6、圆角 2-3px
function setPlayUI(){ const b=$('#rp-play'); if(b) b.innerHTML=wantPlay?PAUSE_ICON:PLAY_ICON; playing=wantPlay;
  try{ updateMiniPlayer(); syncFullPlayer(); }catch(e){} }
async function ensureWakeLock(){
  try{
    if($('#chk-wakelock').checked && 'wakeLock' in navigator && wantPlay && !wakeLock)
      wakeLock=await navigator.wakeLock.request('screen');
  }catch(e){}
}
function releaseWakeLock(){ if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null;} }
function play(){
  if(!cur){ toast('先选一本书'); return; }
  wantPlay=true; sysTtsErrs=0; setPlayUI(); ensureWakeLock(); startAmbience(); speakCurrent(); scrollToActive();
}
function stopSpeak(){ wantPlay=false; setPlayUI(); clearInterval(resumeTimer); releaseWakeLock();
  Ambience.stop(); CustomTTS.stop();
  if(typeof ElevenTTS!=='undefined'){ try{ElevenTTS.stop();}catch(e){} }
  if(synth) synth.cancel(); }
function startAmbience(){
  const t=$('#sel-amb').value; if(!t) return;
  try{ Ambience.start(t,(+$('#rng-amb').value)/100*0.6); }catch(e){}
}
function applyBookVoice(){
  if(!cur) return;
  refreshVoices();
  if(cur.voiceURI) $('#sel-voice').value=cur.voiceURI;
  else { const v=pickVoice(cur); if(v) $('#sel-voice').value=v.voiceURI; }
  if(cur.voiceURI2) $('#sel-voice2').value=cur.voiceURI2;
  $('#rng-rate').value=cur.rate; $('#rate-val').textContent=(cur.rate/100).toFixed(1)+'x';
  $('#chk-dialog').checked=!!cur.dialogVoice;
}

/* ---------- 事件 ---------- */
function cycleSpeed(){
  if(!cur) return;
  const now=cur.rate/100;
  let ni=SPEEDS.findIndex(s=>s>now+0.01); if(ni<0) ni=0;
  cur.rate=Math.round(SPEEDS[ni]*100);
  $('#rng-rate').value=cur.rate; $('#rate-val').textContent=fmtRate(SPEEDS[ni]);
  saveBook(); if(wantPlay) speakCurrent(); syncFullPlayer(); updatePlayer();
}
$('#rp-play').onclick=()=>{ if(!cur)return; wantPlay?stopSpeak():play(); };
$('#rp-back').onclick=()=>skipSeconds(-15);
$('#rp-fwd').onclick=()=>skipSeconds(15);
$('#rp-speed').onclick=()=>{ syncPlaybackSheet(); $('#playback-sheet').classList.remove('hidden'); $('#scrim').classList.remove('hidden'); };
$('#rp-cover').onclick=()=>{ if(typeof renderVoiceSheet==='function') renderVoiceSheet(); $('#voice-sheet').classList.remove('hidden'); $('#scrim').classList.remove('hidden'); };
$('#rp-seek').addEventListener('change',e=>{ if(!cur)return; seekTo(Math.round(e.target.value/1000*(cur.total-1))); });
$('#btn-back').onclick=()=>go(returnView);
$('#reader-chapter').onclick=()=>{ renderChapters(); $('#chapter-drawer').classList.remove('hidden'); setDrawerTab('toc'); };
$('#btn-reader-toc').onclick=()=>$('#reader-chapter').click();
$('#btn-reader-more').onclick=()=>{ openReaderBookMenu(); };
/* ---------- v3.86：阅读器 ··· 书菜单 ---------- */
function syncEmotionSwitch(){
  const sw=$('#rbm-emotion'); if(!sw) return;
  sw.setAttribute('aria-checked', store.get('tts_emotion','0')==='1'?'true':'false');
}
function openReaderBookMenu(){
  if(!cur) return;
  $('#chapter-drawer').classList.add('hidden');
  setCoverEl($('#rbm-cover'), cur, 1);
  $('#rbm-title').textContent=cur.title;
  const fmt=(cur.format||'').toUpperCase();
  $('#rbm-sub').textContent=[fmt, cur.lang==='zh'?'中文':'英文', '共 '+(cur.total||cur.sentences.length)+' 句'].filter(Boolean).join(' · ');
  idbMarks.byBook(cur.id).then(ms=>{ const n=(ms||[]).filter(m=>m.note).length; const el=$('#rbm-notes-n'); if(el) el.textContent=n; }).catch(()=>{});
  syncEmotionSwitch();
  openSheet('reader-book-menu');
}
$('#rbm-search').onclick=()=>{ closeSheets(); $('#chapter-drawer').classList.remove('hidden'); setDrawerTab('search'); };
$('#rbm-bookmark').onclick=()=>{ closeSheets(); toggleBookmark(); };
$('#rbm-notes').onclick=()=>{ closeSheets(); returnView='reader'; go('notes'); };
$('#rbm-emotion').onclick=()=>{ const on=store.get('tts_emotion','0')!=='1'; store.set('tts_emotion', on?'1':'0'); syncEmotionSwitch(); toast(on?'情感增强已开启':'情感增强已关闭'); };
$('#rbm-tr').onclick=()=>{ closeSheets(); $('#chapter-drawer').classList.remove('hidden'); setDrawerTab('toc'); toast('双语 / 整书翻译在目录页'); };
$('#rbm-cast').onclick=()=>{ closeSheets(); if(cur) openCastSheet(cur.id); };
$('#rbm-typeset').onclick=()=>{ closeSheets(); if(cur) openTypesetSheet(cur.id); };
$('#rbm-rename').onclick=async()=>{ if(!cur) return; const n=prompt('重命名：', cur.title); if(n==null) return; const t=n.trim(); if(!t||t===cur.title) return; cur.title=t; try{ await idb.put(stripBook(cur)); }catch(e){} document.title='Apo · '+t; const rt=$('#rbm-title'); if(rt) rt.textContent=t; toast('已重命名'); };
$('#rbm-del').onclick=async()=>{ if(!cur) return; const b=cur; closeSheets(); if(confirm(`删除《${b.title}》？`)){ await idb.del(b.id); cur=null; stopSpeak(); go('library'); renderShelf(); } };
/* ---------- v3.86：PDF 原版视图 ---------- */
let pdfDoc=null, pdfPage=1;
async function openPdfView(){
  if(!cur||cur.format!=='pdf'){ toast('只有 PDF 书可以切到原版'); return; }
  const f=await idb.getFile(cur.id).catch(()=>null);
  if(!f||!f.data){ toast('这本书没有保存原文件，无法查看原版'); return; }
  try{
    pdfDoc=await pdfjsLib.getDocument({data:f.data}).promise;
    const frac=cur.total? Math.min(1, Math.max(0, (cur.progress.idx||0)/cur.total)) : 0;
    pdfPage=Math.max(1, Math.min(pdfDoc.numPages, Math.round(frac*pdfDoc.numPages)||1));
    const t=$('#pdf-title'); if(t) t.textContent=cur.title;
    $('#pdf-view').classList.remove('hidden');
    await renderPdfPage();
  }catch(e){ toast('打开 PDF 原版失败：'+(e&&e.message?e.message:e)); }
}
async function renderPdfPage(){
  if(!pdfDoc) return;
  const page=await pdfDoc.getPage(pdfPage);
  const stage=document.querySelector('.pdf-stage');
  const maxW=Math.max(200, Math.min((stage?stage.clientWidth:390)-16, 900));
  const vp1=page.getViewport({scale:1});
  const vp=page.getViewport({scale:maxW/vp1.width});
  const cv=$('#pdf-canvas');
  cv.width=Math.round(vp.width); cv.height=Math.round(vp.height);
  await page.render({canvasContext:cv.getContext('2d'), viewport:vp}).promise;
  const lab=$('#pdf-page-label'); if(lab) lab.textContent=`第 ${pdfPage} 页 / 共 ${pdfDoc.numPages} 页`;
}
function closePdfView(){ const v=$('#pdf-view'); if(v) v.classList.add('hidden'); if(pdfDoc){ try{pdfDoc.destroy();}catch(e){} pdfDoc=null; } }
$('#btn-reader-pdf').onclick=()=>{ openPdfView(); };
$('#pdf-back').onclick=closePdfView;
$('#pdf-to-text').onclick=closePdfView;
$('#pdf-prev').onclick=async()=>{ if(!pdfDoc||pdfPage<=1) return; pdfPage--; await renderPdfPage(); };
$('#pdf-next').onclick=async()=>{ if(!pdfDoc||pdfPage>=pdfDoc.numPages) return; pdfPage++; await renderPdfPage(); };
$('#btn-reader-typeset').onclick=()=>$('#typeset').classList.remove('hidden');

/* ---------- v3.96 更多设置 & 播放设置 ---------- */
function applyJustify(){ const c=$('#content'); if(c) c.style.textAlign = store.get('ts_justify','1')==='1' ? 'justify' : 'left'; }
function syncMoreSettings(){
  const setSw=(id,on)=>{ const b=$(id); if(!b) return; b.classList.toggle('on',on); b.setAttribute('aria-checked',on?'true':'false'); };
  setSw('#ms-justify', store.get('ts_justify','1')==='1');
  setSw('#ms-tapflip', store.get('tap_flip','1')==='1');
  setSw('#ms-onehand', store.get('one_hand','0')==='1');
  setSw('#ms-volkey', store.get('volkey_flip','0')==='1');
}
function openMoreSettings(){ closeSheets(); syncMoreSettings(); $('#more-settings-sheet').classList.remove('hidden'); $('#scrim').classList.remove('hidden'); }
function syncPlaybackSheet(){
  if(!cur) return;
  const r=cur.rate/100; const s=$('#pb-rate'); if(s) s.value=r;
  const v=$('#pb-rate-v'); if(v) v.textContent=r.toFixed(2).replace(/0$/,'')+'x';
  const lp=$('#pb-loop-sw'); if(lp){ const on=store.get('loop_play','0')==='1'; lp.classList.toggle('on',on); lp.setAttribute('aria-checked',on?'true':'false'); }
}
function setRateFromSlider(v){
  if(!cur) return; cur.rate=Math.round(v*100);
  const el=$('#rng-rate'); if(el) el.value=cur.rate;
  const rv=$('#rate-val'); if(rv) rv.textContent=fmtRate(v);
  saveBook(); if(wantPlay) speakCurrent(); syncFullPlayer(); updatePlayer(); syncPlaybackSheet();
}
(function initPanels396(){
  const bind=()=>{
    const tsMore=$('#ts-more-row'); if(tsMore) tsMore.onclick=()=>{ $('#typeset').classList.add('hidden'); openMoreSettings(); };
    const msBack=$('#ms-back'); if(msBack) msBack.onclick=()=>{ $('#more-settings-sheet').classList.add('hidden'); $('#typeset').classList.remove('hidden'); };
    const msClose=$('#btn-ms-close'); if(msClose) msClose.onclick=()=>{ closeSheets(); };
    const sw=(id,key,fn,def)=>{ const b=$(id); if(!b) return; b.onclick=()=>{ const on=store.get(key,def||'1')!=='1'; store.set(key,on?'1':'0'); b.classList.toggle('on',on); b.setAttribute('aria-checked',on?'true':'false'); if(fn) fn(on); }; };
    sw('#ms-justify','ts_justify',on=>{ applyJustify(); });
    sw('#ms-tapflip','tap_flip');
    sw('#ms-onehand','one_hand',null,'0');
    const vk=$('#ms-volkey'); if(vk) vk.onclick=()=>{ toast('网页版不支持音量键翻页'); };
    const md=$('#ms-display'); if(md) md.onclick=()=>{ $('#more-settings-sheet').classList.add('hidden'); $('#typeset').classList.remove('hidden'); };
    const ml=$('#ms-lock'); if(ml) ml.onclick=()=>{ toast('锁屏时间跟随系统设置'); };
    const pbClose=$('#btn-pb-close'); if(pbClose) pbClose.onclick=()=>{ closeSheets(); };
    const pbRate=$('#pb-rate'); if(pbRate) pbRate.addEventListener('input',e=>setRateFromSlider(parseFloat(e.target.value)));
    const qhi=$('#pb-q-hi'); if(qhi) qhi.onclick=()=>toast('高清音质暂未解锁');
    const sl=$('#pb-sleep'); if(sl) sl.onclick=()=>{ let ni=SLEEPS.indexOf(sleepMin)+1; if(ni>=SLEEPS.length) ni=0; setSleep(SLEEPS[ni]); toast(SLEEPS[ni]?`定时关闭：${SLEEPS[ni]} 分钟后暂停`:'定时关闭：已关闭'); };
    const lp=$('#pb-loop-sw'); const lpRow=$('#pb-loop');
    const toggleLoop=()=>{ const on=store.get('loop_play','0')!=='1'; store.set('loop_play',on?'1':'0'); if(lp){ lp.classList.toggle('on',on); lp.setAttribute('aria-checked',on?'true':'false'); } toast(on?'循环播放已开启':'循环播放已关闭'); };
    if(lp) lp.onclick=e=>{ e.stopPropagation(); toggleLoop(); };
    if(lpRow) lpRow.onclick=()=>toggleLoop();
    const am=$('#pb-amb'); if(am) am.onclick=()=>{ const opts=['','rain','cafe','white','forest']; const names={rain:'雨声',cafe:'咖啡馆',white:'白噪音',forest:'森林夜晚'}; const sel=$('#sel-amb'); if(!sel) return; let i=opts.indexOf(sel.value)+1; if(i>=opts.length) i=0; sel.value=opts[i]; sel.dispatchEvent(new Event('change')); toast(opts[i]?`背景音：${names[opts[i]]}`:'背景音已关闭'); };
    const pd=$('#pb-disp'); if(pd) pd.onclick=()=>{ closeSheets(); $('#typeset').classList.remove('hidden'); };
    applyJustify();
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
$('#btn-ai-typeset').onclick=()=>$('#typeset').classList.remove('hidden');
/* v3.86：目录抽屉三段切换（搜索/目录/书签） */
function setDrawerTab(tab){
  document.querySelectorAll('.cd-seg-btn').forEach(b=>b.classList.toggle('cur', b.dataset.tab===tab));
  const pS=$('#cd-pane-search'), pT=$('#cd-pane-toc'), pM=$('#cd-pane-marks');
  if(pS) pS.classList.toggle('hidden', tab!=='search');
  if(pT) pT.classList.toggle('hidden', tab!=='toc');
  if(pM) pM.classList.toggle('hidden', tab!=='marks');
  if(tab==='marks') renderDrawerMarks();
  if(tab==='search'){ const q=$('#cd-search-q'); if(q) setTimeout(()=>q.focus(),80); }
}
document.querySelectorAll('.cd-seg-btn').forEach(b=>b.onclick=()=>setDrawerTab(b.dataset.tab));
async function renderDrawerMarks(){
  const box=$('#cd-marks-list'); if(!box||!cur) return;
  const ms=await idbBookmarks.byBook(cur.id).catch(()=>[]);
  if(!ms.length){ box.innerHTML='<div class="cd-empty">还没有书签，在阅读器点 ··· → 添加书签。</div>'; return; }
  box.innerHTML=ms.map((m,i)=>`<button class="cd-mark" data-i="${i}"><span class="cd-mark-meta">第${(m.page||0)+1}页 · ${new Date(m.createdAt||Date.now()).toLocaleDateString()}</span>${esc(m.snippet||'')}</button>`).join('');
  box.querySelectorAll('.cd-mark').forEach(b=>b.onclick=()=>{ const m=ms[Number(b.dataset.i)]; $('#chapter-drawer').classList.add('hidden'); if(!m) return; stopSpeak(); cur.progress.idx=m.sentence; cur._lastSpk=null; markActive(); scrollToActive(); saveProgress(); });
}
$('#dr-notes').onclick=()=>{ returnView='reader'; go('notes'); };
function renderReaderFindResults(){
  const list=$('#cd-search-results'), count=$('#cd-search-count');
  if(!list||!count) return;
  count.textContent=readerFindQuery?`共 ${readerFindMatches.length} 条`:'输入关键词搜索整本书';
  list.innerHTML=readerFindMatches.slice(0,60).map((idx,n)=>{
    const s=cur.sentences[idx], chapter=cur.chapters[s.c]?.title||`第${s.c+1}章`;
    return `<button class="reader-find-row${n===readerFindIndex?' current':''}" data-match="${n}"><span class="reader-find-ch">${esc(chapter)} · 第${idx+1}句</span><span>${esc(s.t.slice(0,150))}</span></button>`;
  }).join('')+(readerFindMatches.length>60?'<div class="search-empty-source">仅显示前 60 条；上下按钮可浏览全部结果。</div>':'');
  list.querySelectorAll('[data-match]').forEach(b=>b.onclick=()=>jumpReaderFind(Number(b.dataset.match)));
}
function jumpReaderFind(n){
  if(!cur||!readerFindMatches.length) return;
  readerFindIndex=(n+readerFindMatches.length)%readerFindMatches.length;
  const idx=readerFindMatches[readerFindIndex];
  stopSpeak(); cur.progress.idx=idx; cur._lastSpk=null;
  markActive(); scrollToActive(); saveProgress(); renderReaderFindResults();
}
function runReaderFind(){
  if(!cur) return;
  readerFindQuery=$('#cd-search-q').value.trim().toLocaleLowerCase();
  readerFindMatches=[];
  if(readerFindQuery) cur.sentences.forEach((s,i)=>{ if(String(s.t||'').toLocaleLowerCase().includes(readerFindQuery)) readerFindMatches.push(i); });
  readerMatchSet=new Set(readerFindMatches);
  readerFindIndex=0;
  renderWindow(cur.progress.idx); markActive(); renderReaderFindResults();
}
const _cdq=$('#cd-search-q');
if(_cdq){ _cdq.addEventListener('input',runReaderFind);
  _cdq.addEventListener('keydown',e=>{
    if(e.key==='Enter'){ e.preventDefault(); jumpReaderFind(readerFindIndex+(e.shiftKey?-1:1)); }
    else if(e.key==='Escape'){ _cdq.blur(); }
  }); }
const _cdp=$('#cd-search-prev'); if(_cdp) _cdp.onclick=()=>jumpReaderFind(readerFindIndex-1);
const _cdn=$('#cd-search-next'); if(_cdn) _cdn.onclick=()=>jumpReaderFind(readerFindIndex+1);
$('#btn-chapters-close').onclick=()=>$('#chapter-drawer').classList.add('hidden');
$('#dr-ai').onclick=()=>{ $('#chapter-drawer').classList.add('hidden'); $('#aisheet').classList.remove('hidden'); };
$('#dr-type').onclick=()=>{ $('#chapter-drawer').classList.add('hidden'); $('#typeset').classList.remove('hidden'); };
$('#stop-fab').onclick=()=>{ stopSpeak(); toast('已停止朗读'); };
$('#fp-voice').onclick=()=>{ renderVoiceSheet(); $('#voice-sheet').classList.remove('hidden'); $('#scrim').classList.remove('hidden'); };
$('#voice-sheet-close').onclick=()=>{ $('#voice-sheet').classList.add('hidden'); $('#scrim').classList.add('hidden'); };
bindReaderGestures();
$('#sel-voice').onchange=e=>{ if(cur){cur.voiceURI=e.target.value;saveBook();} };
$('#sel-voice2').onchange=e=>{ if(cur){cur.voiceURI2=e.target.value;saveBook();} };
$('#rng-rate').oninput=e=>{ const r=+e.target.value;
  $('#rate-val').textContent=(r/100).toFixed(1)+'x';
  if(cur){cur.rate=r;saveBook(); if(wantPlay){speakCurrent();}} };
$('#chk-dialog').onchange=e=>{ if(cur){cur.dialogVoice=e.target.checked;saveBook();} };
const doImport=()=>$('#file-input').click();
$('#btn-import-empty').onclick=doImport;
$('#file-input').onchange=async e=>{
  const files=[...e.target.files]; e.target.value='';
  for(const f of files){
    const b=await importFile(f).catch(err=>{toast('导入失败：'+err.message);return null;});
    if(b){ books.unshift(b); }
  }
  if(cur) await openBook(cur.id); else renderShelf();
  showView('library');
};
document.addEventListener('visibilitychange',()=>{ if(document.hidden) releaseWakeLock(); else { if(wantPlay) ensureWakeLock(); scanDownloads(); } });

/* ---------- 外部文件打开/分享入库（下载后点文件→用 Apo 打开） ---------- */
async function importSharedFiles(files){
  let added=0;
  for(const f of files){
    const b=await importFile(f).catch(err=>{ toast('导入失败：'+err.message); return null; });
    if(b){ books.unshift(b); added++; }
  }
  if(added){ renderShelf(); go('library'); toast(`已加入书架 ${added} 本`); }
}
if('launchQueue' in window){
  launchQueue.setConsumer(async params=>{
    const fs=[];
    for(const h of (params.files||[])){ try{ fs.push(await h.getFile()); }catch(e){} }
    if(fs.length) importSharedFiles(fs);
  });
}
async function consumeShareTarget(){
  let qs='';
  try{ qs=new URLSearchParams(location.search).get('shared'); }catch(e){}
  if(!qs) return;
  try{
    history.replaceState(null,'','./index.html');
    const c=await caches.open('dr-share');
    const keys=await c.keys();
    const fs=[];
    for(const k of keys){
      const res=await c.match(k);
      if(!res) continue;
      const blob=await res.blob();
      const name=decodeURIComponent(k.url.split('/').pop()||'book.epub');
      fs.push(new File([blob], name, {type:res.headers.get('Content-Type')||'application/octet-stream'}));
      await c.delete(k);
    }
    if(fs.length) importSharedFiles(fs);
  }catch(e){}
}

/* ---------- 划线与笔记 ---------- */
function sentElOf(node){
  let el = node.nodeType===1 ? node : node.parentElement;
  while(el && !el.classList?.contains('sent')) el = el.parentElement;
  return el;
}
function captureSelection(){
  const sel = window.getSelection();
  if(!sel || sel.isCollapsed || !cur) return null;
  const r = sel.getRangeAt(0);
  const sEl = sentElOf(r.startContainer), eEl = sentElOf(r.endContainer);
  if(!sEl || !eEl) return null;
  const text = sel.toString().trim();
  if(text.length < 1) return null;
  return {
    bookId: cur.id,
    startG: +sEl.dataset.g, startOff: r.startOffset,
    endG: +eEl.dataset.g, endOff: r.endOffset,
    text: text.slice(0, 500),
    note: '', createdAt: Date.now(),
  };
}
async function saveMark(note){
  const m = captureSelection();
  if(!m){ toast('先选中一段文字'); return; }
  m.note = note || '';
  await idbMarks.add(m);
  applyMarks();
  window.getSelection().removeAllRanges();
  $('#sel-tip').classList.add('hidden');
  toast(m.note ? '笔记已保存' : '已划线');
}
function applyMarks(){
  if(!cur || !PG.ready) return;
  idbMarks.byBook(cur.id).then(marks => {
    if(!marks.length) return;
    const c = $('#content');
    for(const m of marks){
      try{
        const sEl = c.querySelector(`[data-g="${m.startG}"]`);
        const eEl = c.querySelector(`[data-g="${m.endG}"]`);
        if(!sEl || !eEl) continue;
        // 跳过已标记的（避免重复）
        if(sEl.querySelector('mark.hl')) continue;
        const r = document.createRange();
        const sNode = sEl.firstChild, eNode = eEl.firstChild;
        if(!sNode || !eNode) continue;
        r.setStart(sNode, Math.min(m.startOff, sNode.length || 0));
        r.setEnd(eNode, Math.min(m.endOff, eNode.length || 0));
        const mark = document.createElement('mark');
        mark.className = 'hl' + (m.note ? ' has-note' : '');
        mark.title = m.note || '';
        try{ r.surroundContents(mark); }
        catch(e){
          // 跨节点复杂情况：退化为整句标记
          const frag = r.extractContents();
          mark.appendChild(frag); r.insertNode(mark);
        }
      }catch(e){}
    }
  });
}
$('#btn-hl').onclick = () => saveMark('');
$('#btn-note').onclick = () => {
  const m = captureSelection();
  if(!m){ toast('先选中一段文字'); return; }
  const note = prompt('写下你的笔记：', '');
  if(note === null) return;
  m.note = note;
  idbMarks.add(m).then(() => {
    applyMarks();
    window.getSelection().removeAllRanges();
    $('#sel-tip').classList.add('hidden');
    toast('笔记已保存');
  });
};
// 渲染窗口后重打划线
const _renderWindow = renderWindow;
renderWindow = function(s){ _renderWindow(s); setTimeout(applyMarks, 50); };

/* ---------- 笔记汇总 ---------- */
async function renderNotesList(){
  const box = $('#notes-list');
  const marks = await idbMarks.all();
  if(!marks.length){ box.innerHTML = '<p class="sub" style="text-align:center;padding:40px 20px">还没有划线或笔记<br>在阅读时选中文字即可划线</p>'; return; }
  // 按书分组
  const byBook = {};
  for(const m of marks){ (byBook[m.bookId] = byBook[m.bookId] || []).push(m); }
  let h = '';
  for(const bid of Object.keys(byBook)){
    const b = books.find(x => x.id === bid);
    const title = b ? b.title : '未知书籍';
    h += `<div class="serif" style="padding:12px 20px 8px;font-size:15px">${esc(title)}（${byBook[bid].length}）</div>`;
    for(const m of byBook[bid].sort((a,b) => b.createdAt - a.createdAt)){
      h += `<div class="note-card" data-id="${m.id}"><div class="q">${esc(m.text)}</div>`;
      if(m.note) h += `<div class="n">${esc(m.note)}</div>`;
      h += `<div class="meta"><span>${new Date(m.createdAt).toLocaleDateString()}</span><button data-del="${m.id}">删除</button></div></div>`;
    }
  }
  box.innerHTML = h;
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async e => { e.stopPropagation(); await idbMarks.del(+btn.dataset.del); renderNotesList(); applyMarks(); };
  });
  // 点击卡片跳转到书中位置
  box.querySelectorAll('.note-card').forEach(card => {
    card.onclick = async () => {
      const id = +card.dataset.id;
      const all = await idbMarks.all();
      const m = all.find(x => x.id === id);
      if(!m) return;
      const b = books.find(x => x.id === m.bookId);
      if(!b){ toast('这本书已不在书架'); return; }
      await openBook(b.id);
      setPage(pageOfSentence(m.startG), {animate:false});
      setTimeout(applyMarks, 300);
    };
  });
}
$('#notes-back').onclick = () => go(returnView||'mine');

/* ---------- 书签 ---------- */
async function toggleBookmark(){
  if(!cur){ return; }
  const si = PG.ready ? sentenceOfPage(PG.page) : 0;
  const exist = (await idbBookmarks.byBook(cur.id).catch(()=>[])).find(b=>b.sentence===si);
  if(exist){ await idbBookmarks.del(exist.id).catch(()=>{}); toast('书签已取消'); return; }
  const snippet = (cur.sentences[si]?.t || '').slice(0, 60);
  await idbBookmarks.add({ bookId: cur.id, sentence: si, page: PG.page, snippet, createdAt: Date.now() });
  toast('书签已添加');
}
$('#dr-bookmark').onclick = toggleBookmark;
function openBookchat(){
  if(!cur){ toast('先打开一本书'); return; }
  renderBookchatSugg();
  go('bookchat');
}
$('#ai-fab').onclick = openBookchat;

/* ---------- AI书伴：基于整书内容的问答 ---------- */
const BOOKCHAT_SUGG = ['这本书讲了什么？', '作者的核心观点是什么？', '总结一下当前章节', '书中最重要的三个概念？'];
function bookContext(){
  if(!cur) return '';
  // 当前章节及前后文（最多约4000字）
  const si = PG.ready ? sentenceOfPage(PG.page) : 0;
  const from = Math.max(0, si - 30), to = Math.min(cur.sentences.length, si + 80);
  let txt = cur.sentences.slice(from, to).map(x => x.t).join('');
  if(txt.length > 4000) txt = txt.slice(0, 4000) + '…';
  return `书名：《${cur.title}》\n当前章节附近内容：\n${txt}`;
}
function renderBookchatSugg(){
  $('#bookchat-sugg').innerHTML = BOOKCHAT_SUGG.map(q => `<button class="chat-sugg">${esc(q)}</button>`).join('');
  $('#bookchat-sugg').querySelectorAll('.chat-sugg').forEach(b => {
    b.onclick = () => { $('#bookchat-input').value = b.textContent; $('#bookchat-send').click(); };
  });
}
function bookchatAdd(role, text){
  const d = document.createElement('div');
  d.className = 'chat-msg ' + role;
  d.textContent = text;
  $('#bookchat-list').appendChild(d);
  $('#bookchat-list').scrollTop = 1e9;
}
async function bookchatSend(){
  const q = $('#bookchat-input').value.trim();
  if(!q){ return; }
  if(!cur){ toast('先打开一本书'); return; }
  $('#bookchat-input').value = '';
  bookchatAdd('user', q);
  bookchatAdd('ai', '思考中…');
  const aiEl = $('#bookchat-list').lastChild;
  try{
    const ans = await geminiAsk(`你是一位博学的读书助手。用户正在读《${cur.title}》。\n${bookContext()}\n\n用户问题：${q}\n\n请基于书中内容简明回答（200字内），引用书中观点时注明。`);
    aiEl.textContent = ans;
  }catch(e){ aiEl.textContent = '失败：' + e.message; }
  $('#bookchat-list').scrollTop = 1e9;
}
$('#bookchat-send').onclick = bookchatSend;
$('#bookchat-input').addEventListener('keydown', e => { if(e.key === 'Enter') bookchatSend(); });
$('#bookchat-back').onclick = () => go('reader');

/* ---------- 书签列表 ---------- */
async function renderBookmarksList(){
  const box = $('#bookmarks-list');
  const all = await new Promise((res,rej)=>{const t=_tx('bookmarks').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);});
  if(!all.length){ box.innerHTML = '<p class="sub" style="text-align:center;padding:40px 20px">还没有书签<br>在阅读时点顶栏 🔖 添加</p>'; return; }
  const byBook = {};
  for(const m of all){ (byBook[m.bookId] = byBook[m.bookId] || []).push(m); }
  let h = '';
  for(const bid of Object.keys(byBook)){
    const b = books.find(x => x.id === bid);
    h += `<div class="serif" style="padding:12px 20px 8px;font-size:15px">${esc(b ? b.title : '未知书籍')}</div>`;
    for(const m of byBook[bid].sort((a,b) => b.createdAt - a.createdAt)){
      h += `<div class="note-card" data-bid="${m.bookId}" data-s="${m.sentence}"><div class="q">🔖 ${esc(m.snippet || '')}</div><div class="meta"><span>${new Date(m.createdAt).toLocaleDateString()}</span><button data-del="${m.id}">删除</button></div></div>`;
    }
  }
  box.innerHTML = h;
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async e => { e.stopPropagation(); await idbBookmarks.del(+btn.dataset.del); renderBookmarksList(); };
  });
  box.querySelectorAll('.note-card').forEach(card => {
    card.onclick = async () => {
      const b = books.find(x => x.id === card.dataset.bid);
      if(!b){ toast('这本书已不在书架'); return; }
      await openBook(b.id);
      setPage(pageOfSentence(+card.dataset.s), {animate:false});
    };
  });
}
$('#bookmarks-back').onclick = () => go('mine');
$('#mn-notes').onclick = () => { returnView='mine'; go('notes'); };
$('#mn-voice').onclick = () => go('voice');
$('#mn-badges').onclick = () => go('badges');
$('#badges-back').onclick = () => go('mine');
$('#btn-invite').onclick = () => shareApo();
$('#st-share').onclick = () => shareApo();
$('#st-bookmarks').onclick = () => go('bookmarks');
$('#st-settings').onclick = async () => { openSheet('settings-sheet'); const h=await sysGet('dlHandle').catch(()=>null); const el=$('#auto-import-state'); if(el) el.textContent=h?'已开启':''; };
$('#btn-auto-import').onclick = async () => { await enableAutoImport(); const h=await sysGet('dlHandle').catch(()=>null); const el=$('#auto-import-state'); if(el) el.textContent=h?'已开启':''; };
$('#btn-settings-close').onclick = () => closeSheets();
$('#st-about').onclick = () => { const v=document.querySelector('#about-ver'); if(v) v.textContent=document.querySelector('.sb-ver')?.textContent||''; openSheet('about-sheet'); };
$('#btn-about-close').onclick = () => closeSheets();

/* ---------- 翻译持久化 ---------- */
const idbTr = {
  get(bookId){ return new Promise((res,rej)=>{ const t=_tx('translations').get(bookId); t.onsuccess=()=>res(t.result?.map||{}); t.onerror=()=>rej(t.error); }); },
  save(bookId, map){ return new Promise((res,rej)=>{ const t=_tx('translations','readwrite').put({bookId, map, updatedAt:Date.now()}); t.onsuccess=()=>res(); t.onerror=()=>rej(t.error); }); },
  clear(bookId){ return new Promise((res,rej)=>{ const t=_tx('translations','readwrite').delete(bookId); t.onsuccess=()=>res(); t.onerror=()=>rej(t.error); }); },
};

/* ---------- 双语对照翻译 ---------- */
let bilingualOn = false;
const trCache = {}; // sentenceIdx -> translation
$('#dr-trbook').onclick = () => { $('#chapter-drawer').classList.add('hidden'); translateWholeBook(); };
$('#dr-bilingual').onclick = async () => {
  bilingualOn = !bilingualOn;
  $('#dr-bilingual').classList.toggle('btn-primary', bilingualOn);
  $('#chapter-drawer').classList.add('hidden');
  if(bilingualOn){ toast('双语模式开：正在翻译本页…'); await translatePage(); }
  else { document.querySelectorAll('.sent .tr').forEach(e => e.remove()); }
};
/* ---------- 整书翻译 ---------- */
let trRunning = false, trProgress = 0;
async function loadBookTranslations(){
  if(!cur) return;
  try{
    const saved = await idbTr.get(cur.id);
    Object.assign(trCache, saved);
  }catch(e){}
}
async function translateWholeBook(){
  if(!cur) return;
  if(trRunning){ toast('正在翻译中…'); return; }
  const key = ($('#gemini-key')?.value || '').trim();
  if(!key){ toast('请先在设置里填写 Gemini API Key'); go('mine'); return; }
  trRunning = true; trProgress = 0;
  const total = cur.total;
  const BATCH = 20;
  const bookId = cur.id;
  let done = 0, failed = 0, backoff = 0;
  toast('开始整书翻译，共'+total+'句，后台进行中…');
  updateTrProgress();
  for(let i = 0; i < total && trRunning; i += BATCH){
    if(!cur || cur.id !== bookId) break; // 换书则停
    const batch = [];
    for(let j = i; j < Math.min(i+BATCH, total); j++){
      if(trCache[j]){ done++; continue; }
      const t = cur.sentences[j]?.t || '';
      if(t.length < 2){ done++; continue; }
      batch.push([j, t]);
    }
    if(batch.length){
      try{
        const txt = batch.map(([k,t]) => `[${k}]${t}`).join('\\n');
        const r = await geminiAsk(`将以下句子翻译成中文（如果是中文则译成英文）。每行格式保持 [序号]译文，只输出译文行：\\n\\n${txt.slice(0,6000)}`);
        for(const line of r.split('\\n')){
          const m = line.match(/^\\[(\\d+)\\](.*)/);
          if(m && m[2].trim()){ trCache[+m[1]] = m[2].trim(); done++; }
        }
        backoff = 0;
      }catch(e){
        failed += batch.length;
        if(/429|rate|quota|limit/i.test(e.message)){ backoff = Math.min(backoff+1,4); await new Promise(r=>setTimeout(r, 2000*backoff)); }
      }
      scheduleTrSave();
    }
    trProgress = Math.round(done/total*100);
    updateTrProgress();
  }
  trRunning = false;
  updateTrProgress();
  toast(failed ? `翻译完成，${done}句成功，${failed}句失败` : `整书翻译完成，共${done}句`);
  applyTranslations();
}
function updateTrProgress(){
  const el = $('#tr-progress');
  if(el){
    el.style.display = (trRunning || trProgress > 0) ? 'block' : 'none';
    el.innerHTML = trRunning ? `翻译中… ${trProgress}% <button id="tr-stop" style="margin-left:8px;font-size:12px">停止</button>` : (trProgress >= 100 ? '翻译完成 ✓' : '');
    const stop = $('#tr-stop');
    if(stop) stop.onclick = () => { trRunning = false; toast('已停止翻译'); };
  }
}
let trPageSeq = 0; // 翻页翻译序号：丢弃过期请求
async function translatePage(){
  if(!cur || !PG.ready || !bilingualOn) return;
  const mySeq = ++trPageSeq;
  const bookId = cur.id;
  const pageAtReq = PG.page;
  const s0 = sentenceOfPage(PG.page), s1 = sentenceOfPage(Math.min(PG.total-1, PG.page+1));
  const batch = [];
  for(let i = s0; i < Math.min(s1, s0+12); i++){
    if(trCache[i]) continue;
    const t = cur.sentences[i]?.t || '';
    if(t.length < 2) continue;
    batch.push([i, t]);
  }
  if(!batch.length){ applyTranslations(); return; }
  try{
    const txt = batch.map(([i,t]) => `[${i}]${t}`).join('\\n');
    const r = await geminiAsk(`将以下句子翻译成中文（如果是中文则译成英文）。每行格式保持 [序号]译文，只输出译文行：\\n\\n${txt.slice(0,3000)}`);
    if(mySeq !== trPageSeq || !cur || cur.id !== bookId) return; // 已翻页/换书：丢弃
    let added = false;
    for(const line of r.split('\\n')){
      const m = line.match(/^\\[(\\d+)\\](.*)/);
      if(m && m[2].trim()){ trCache[+m[1]] = m[2].trim(); added = true; }
    }
    if(added) scheduleTrSave();
  }catch(e){ if(mySeq === trPageSeq) toast('翻译失败：'+e.message); }
  applyTranslations();
}
// 防抖保存翻译缓存（2秒），避免频繁全量写 IDB
let trSaveT = null;
function scheduleTrSave(){
  if(!cur) return;
  clearTimeout(trSaveT);
  trSaveT = setTimeout(()=>{ try{ idbTr.save(cur.id, {...trCache}); }catch(e){} }, 2000);
}
function applyTranslations(){
  if(!bilingualOn) return;
  document.querySelectorAll('#content .sent').forEach(sp => {
    const g = +sp.dataset.g;
    if(trCache[g] && !sp.querySelector('.tr')){
      const d = document.createElement('span');
      d.className = 'tr'; d.textContent = trCache[g];
      sp.appendChild(d);
    }
  });
}
// 翻页后自动翻译新页
const _showPageInstant = showPageInstant;
showPageInstant = function(gp){ _showPageInstant(gp); if(bilingualOn) setTimeout(translatePage, 400); };

/* ---------- OCR 拍照识字导入 ---------- */
$('#imp-aisearch').onclick=()=>{ closeSheets(); go('search'); setTimeout(()=>$('#search-q').focus(),80); };
$('#imp-ocr').onclick = () => { closeSheets(); $('#ocr-input').click(); };
$('#ocr-input').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if(!f) return;
  loading(true, '识别文字中…');
  try{
    const fd = new FormData();
    fd.append('file', f);
    fd.append('language', 'chs');
    fd.append('isOverlayRequired', 'false');
    fd.append('apikey', (store.get('ocr_key')||'').trim() || 'helloworld'); // v3.85 修：以前没传 apikey，ocr.space 直接拒掉；默认用公共演示 Key， heavy 用户去设置里填自己的免费 Key
    // ocr.space 免费接口
    const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
    if(!r.ok) throw new Error('OCR 请求失败 ' + r.status);
    const j = await r.json();
    const txt = (j.ParsedResults || []).map(x => x.ParsedText || '').join('\n').trim();
    if(!txt) throw new Error('没识别出文字，换张清晰点的照片试试');
    const title = '拍照识字 ' + new Date().toLocaleDateString();
    const b = await importFromText(title, txt);
    if(b){ books.unshift(b); renderShelf(); go('library'); toast('已导入书架'); }
  }catch(err){ toast('识别失败：' + err.message); }
  finally{ loading(false); }
};

/* ---------- 阅读统计详情 ---------- */
let statsPeriod = 'week';
function renderStatsDetail(p){
  statsPeriod = p || statsPeriod;
  document.querySelectorAll('#stats-tabs .chat-sugg').forEach(b => {
    const on = b.dataset.p === statsPeriod;
    b.style.background = on ? '#1890ff' : ''; b.style.color = on ? '#fff' : ''; b.style.borderColor = on ? '#1890ff' : '';
  });
  const s = getStat();
  const days = statsPeriod === 'week' ? 7 : 30;
  const chart = $('#stats-chart');
  let h = '', total = 0, maxV = 1;
  const vals = [];
  for(let i = days-1; i >= 0; i--){
    const d = new Date(Date.now() - i*864e5);
    const v = Math.round((s.days[statKey(d)] || 0) / 60);
    vals.push({d, v}); total += v; maxV = Math.max(maxV, v);
  }
  for(const {d, v} of vals){
    const hh = Math.max(4, Math.round(v/maxV*130));
    const isToday = statKey(d) === statKey(new Date());
    h += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
      <div style="font-size:10px;color:#999">${v>0?v:''}</div>
      <div style="width:100%;max-width:28px;height:${hh}px;background:${isToday?'#1890ff':'#d6e9ff'};border-radius:4px"></div>
      <div style="font-size:10px;color:#999;margin-top:4px">${d.getDate()}日</div></div>`;
  }
  chart.innerHTML = h;
  const avg = Math.round(total/days);
  $('#stats-summary').innerHTML = `<div style="display:flex;justify-content:space-around;text-align:center">
    <div><div class="serif" style="font-size:22px">${total}<small style="font-size:12px">分</small></div><div class="sub">累计阅读</div></div>
    <div><div class="serif" style="font-size:22px">${avg}<small style="font-size:12px">分</small></div><div class="sub">日均</div></div>
    <div><div class="serif" style="font-size:22px">${s.streak||0}<small style="font-size:12px">天</small></div><div class="sub">连续达标</div></div></div>`;
  $('#stats-goals').innerHTML = STAT_GOALS.map(g =>
    `<button class="chat-sugg" data-g="${g}" style="${s.target===g?'background:#1890ff;color:#fff;border-color:#1890ff':''}">${g}分钟</button>`).join('');
  $('#stats-goals').querySelectorAll('[data-g]').forEach(b => {
    b.onclick = () => { const st = getStat(); st.target = +b.dataset.g; setStat(st); renderStatsDetail(); };
  });
}
document.querySelectorAll('#stats-tabs .chat-sugg').forEach(b => { b.onclick = () => renderStatsDetail(b.dataset.p); });
$('#stats-back').onclick = () => go('home');
$('#home-stats-link').onclick = () => go('stats');

/* ---------- 下载自动上架：监听下载文件夹，新书自动入库 ---------- */
async function sysGet(k){
  try{ const r=await new Promise((res,rej)=>{ const t=_tx('sys').get(k); t.onsuccess=()=>res(t.result||null); t.onerror=()=>rej(t.error); }); return r?r.val:null; }
  catch(e){ return null; }
}
async function sysPut(k,v){
  try{ await new Promise((res,rej)=>{ const t=_tx('sys','readwrite').put({key:k,val:v}); t.onsuccess=res; t.onerror=()=>rej(t.error); }); }catch(e){}
}
async function enableAutoImport(){
  if(!window.showDirectoryPicker){ toast('当前浏览器不支持文件夹监听，用“导入已下载的文件”手动导入'); return; }
  try{
    const h=await window.showDirectoryPicker({mode:'read'});
    await sysPut('dlHandle', h);
    toast('已开启：以后下载的新书会自动上架');
    scanDownloads();
  }catch(e){ if(e && e.name!=='AbortError') toast('开启失败：'+(e.message||e)); }
}
async function scanDownloads(){
  const h=await sysGet('dlHandle');
  if(!h || !h.values) return 0;
  try{
    if(await h.queryPermission({mode:'read'})!=='granted'){
      if(await h.requestPermission({mode:'read'})!=='granted') return 0;
    }
  }catch(e){ return 0; }
  let seen=[];
  try{ seen=JSON.parse(localStorage.getItem('dr_auto_imported')||'[]'); }catch(e){}
  const seenSet=new Set(seen);
  let added=0;
  try{
    for await(const entry of h.values()){
      if(entry.kind!=='file') continue;
      const nm=entry.name||'';
      if(!/\.(epub|pdf|txt|fb2)$/i.test(nm)) continue;
      if(seenSet.has(nm)) continue;
      try{
        const f=await entry.getFile();
        if(!f.size) continue;
        const b=await importFile(f).catch(()=>null);
        if(b){ books.unshift(b); seenSet.add(nm); added++; }
      }catch(e){}
    }
  }catch(e){}
  if(added){
    try{ localStorage.setItem('dr_auto_imported', JSON.stringify([...seenSet].slice(-300))); }catch(e){}
    try{ renderShelf(); }catch(e){}
    toast(`自动上架 ${added} 本新书`);
  }
  return added;
}

/* ---------- 启动 ---------- */
(async()=>{
  if(!('speechSynthesis' in window)) toast('当前浏览器不支持语音朗读，换 Chrome / Edge / Safari 试试',4000);
  await openDB().catch(()=>toast('本地数据库不可用'));
  await migrateV1();
  try{ await loadBooks(); }catch(e){}
  await consumeShareTarget();
  scanDownloads();
  if(store.get('splash_done')) go('home'); else go('splash');
})();

/* ================= v2：搜书 / 排版 / 背景音 / AI 助手 ================= */

/* ---------- 底部导航 ---------- */
document.querySelectorAll('#tabbar .tab').forEach(t=>{ t.onclick=()=>go(t.dataset.v); });
document.querySelectorAll('#sidebar .sb-item').forEach(b=>{ b.onclick=()=>{ if(b.dataset.v==='notes') returnView=curView; go(b.dataset.v); }; });
$('#sb-add').onclick=()=>openImportSheet();
$('#tab-plus').onclick=()=>openImportSheet();
/* v3.80：书架顶栏三个图标都有实功能，不做摆设 */
$('#lib-search').onclick=()=>{ const t=$('#shelf-toolbar'); t.classList.toggle('hidden'); if(!t.classList.contains('hidden')) setTimeout(()=>$('#shelf-filter').focus(),80); };
$('#lib-sort').onclick=()=>{
  const sel=$('#shelf-sort'); const order=['recent','added','title'];
  const ni=(order.indexOf(sel.value)+1)%order.length; sel.value=order[ni];
  renderShelf(); toast('排序：'+sel.selectedOptions[0].text);
};
$('#lib-menu').onclick=()=>{
  const sel=$('#shelf-format'); const order=['all','pdf','epub','txt','docx'];
  const ni=(order.indexOf(sel.value)+1)%order.length; sel.value=order[ni];
  renderShelf(); toast('筛选：'+sel.selectedOptions[0].text);
};

/* ================= v3.5：阅读统计 ================= */
const STAT_GOALS=[15,30,60];
function statKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function getStat(){ try{ return JSON.parse(store.get('dr_stat','null'))||{days:{},streak:0,lastDone:'',target:30}; }catch(e){ return {days:{},streak:0,lastDone:'',target:30}; } }
function setStat(s){ store.set('dr_stat', JSON.stringify(s)); }
function addStatSecs(n){
  const s=getStat(), k=statKey(new Date());
  s.days[k]=(s.days[k]||0)+n;
  // 达标判断
  if(s.days[k]>=s.target*60 && s.lastDone!==k){
    const y=new Date(Date.now()-864e5);
    s.streak=(s.lastDone===statKey(y))?s.streak+1:1;
    s.lastDone=k;
    toast(`🎉 今日目标达成！连续${s.streak}天`);
  }
  // 只保留近 40 天
  const keys=Object.keys(s.days).sort();
  while(keys.length>40) delete s.days[keys.shift()];
  setStat(s);
  if(curView==='home') renderStats();
}
function fmtDur(sec){
  sec=Math.floor(sec);
  if(sec>=3600) return `${Math.floor(sec/3600)}:${String(Math.floor(sec%3600/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
  return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
}
function renderStats(){
  const s=getStat(), k=statKey(new Date());
  const today=s.days[k]||0, target=s.target*60;
  // v3.76：逐项判空——v3.69 删了 stat-streak 元素后这里每次必抛错，圆环永远 0%
  const tEl=$('#stat-time'); if(tEl) tEl.textContent=fmtDur(today);
  const gEl=$('#stat-target'); if(gEl) gEl.textContent=s.target+'分钟';
  const sEl=$('#stat-streak'); if(sEl) sEl.textContent=`🔥${s.streak}天`;
  const ring=$('#stat-ring-fg');
  if(ring){ const c=327, off=c*(1-Math.min(1,today/target)); ring.style.strokeDashoffset=off; }
}
$('#stat-goal').onclick=()=>{
  const s=getStat();
  const i=(STAT_GOALS.indexOf(s.target)+1)%STAT_GOALS.length;
  s.target=STAT_GOALS[i]; setStat(s); renderStats();
};
// 每 10 秒累计一次：在阅读器看书也算，不只播放时算；播放时不双计
setInterval(()=>{ if(document.hidden) return;
  if(typeof wantPlay!=='undefined' && wantPlay) addStatSecs(10);
  else if(curView==='reader' && cur) addStatSecs(10);
},10000);

/* ================= v3.5：导入弹窗 ================= */
function openSheet(id){ $('#scrim').classList.remove('hidden'); $('#'+id).classList.remove('hidden'); }
function closeSheets(){ $('#scrim').classList.add('hidden');
  ['import-sheet','url-sheet','text-sheet','clone-sheet','cast-sheet','voice-sheet','about-sheet','book-menu','typeset-sheet','settings-sheet','typeset','aisheet','reader-book-menu','more-settings-sheet','playback-sheet'].forEach(id=>{const el=$('#'+id); if(el) el.classList.add('hidden');});
  if(typeof stopRecord==='function'){ try{stopRecord();}catch(e){} }
  if(typeof discardCloneSource==='function'){ try{discardCloneSource();}catch(e){} } }
function openImportSheet(){ openSheet('import-sheet'); }
$('#scrim').onclick=closeSheets;
$('#imp-file').onclick=()=>{ closeSheets(); doImport(); };
$('#imp-url').onclick=()=>{ $('#import-sheet').classList.add('hidden'); openSheet('url-sheet'); setTimeout(()=>$('#url-input').focus(),100); };
$('#imp-text').onclick=()=>{ $('#import-sheet').classList.add('hidden'); openSheet('text-sheet'); setTimeout(()=>$('#text-input').focus(),100); };
$('#btn-url-do').onclick=async()=>{
  const url=$('#url-input').value.trim();
  if(!/^https?:\/\//i.test(url)){ toast('粘贴完整的网页链接（http开头）'); return; }
  closeSheets();
  const b=await importFromURL(url).catch(e=>{ toast('导入失败：'+e.message,3000); return null; });
  if(b){ books.unshift(b); go('library'); }
};
$('#btn-text-do').onclick=async()=>{
  const text=$('#text-input').value.trim();
  if(text.length<20){ toast('正文太短，多粘贴一点'); return; }
  const title=$('#text-title').value.trim();
  $('#text-input').value=''; $('#text-title').value='';
  closeSheets();
  const b=await importFromText(title,text).catch(e=>{ toast('导入失败：'+e.message); return null; });
  if(b){ books.unshift(b); go('library'); }
};

/* ---------- 书目搜索：Open Library + Project Gutenberg ---------- */
$('#btn-search').onclick=()=>runBookSearch();
$('#search-q').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); runBookSearch(); } });
renderBookSearchHistory();

function readSearchHistory(){
  try{ const h=JSON.parse(store.get('book_search_history','[]')); return Array.isArray(h)?h.filter(x=>typeof x==='string'):[]; }catch(e){ return []; }
}
function renderBookSearchHistory(){
  const el=$('#search-history'); if(!el) return;
  const history=readSearchHistory();
  el.innerHTML=history.length?'<span class="search-history-label">最近搜索</span>'+history.map(q=>`<button class="search-history-chip" data-q="${esc(q)}">${esc(q)}</button>`).join(''):'';
  el.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{ $('#search-q').value=b.dataset.q; runBookSearch(); });
}
function rememberBookSearch(q){
  const h=[q,...readSearchHistory().filter(x=>x!==q)].slice(0,6);
  store.set('book_search_history',JSON.stringify(h)); renderBookSearchHistory();
}
async function searchOpenLibrary(q){
  const url='https://openlibrary.org/search.json?q='+encodeURIComponent(q)+'&limit=8&fields=key,title,author_name,first_publish_year,edition_count,cover_i';
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),8000);
  let r; try{ r=await fetch(url,{headers:{'Accept':'application/json'},signal:ctl.signal}); }finally{ clearTimeout(to); }
  if(!r.ok) throw new Error('Open Library HTTP '+r.status);
  const j=await r.json(); return Array.isArray(j.docs)?j.docs:[];
}
async function searchGutenberg(q){
  const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(),8000);
  let r; try{ r=await fetch('https://gutendex.com/books/?search='+encodeURIComponent(q),{signal:ctl.signal}); }finally{ clearTimeout(to); }
  if(!r.ok) throw new Error('Gutenberg HTTP '+r.status);
  const j=await r.json(); return Array.isArray(j.results)?j.results:[];
}
function safeGutenbergEpub(formats){
  for(const [type,value] of Object.entries(formats||{})){
    if(!type.toLowerCase().startsWith('application/epub+zip')||typeof value!=='string') continue;
    try{ const u=new URL(value); if(u.protocol==='https:'&&['gutenberg.org','www.gutenberg.org'].includes(u.hostname)) return u.href; }catch(e){}
  }
  return '';
}
function openLibraryCard(b){
  const key=typeof b.key==='string'&&/^\/works\/OL\d+W$/.test(b.key)?b.key:'';
  const title=esc(b.title||'未命名');
  const authors=esc((b.author_name||[]).slice(0,3).join('、')||'作者信息暂无');
  const details=[b.first_publish_year||'',b.edition_count?b.edition_count+' 个版本':''].filter(Boolean).join(' · ');
  const cover=Number.isInteger(b.cover_i)&&b.cover_i>0?`<img class="search-cover" src="https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg" alt="" loading="lazy">`:'<div class="search-cover search-cover-empty">📖</div>';
  return `<article class="sr search-book-card">${cover}<div class="search-book-main"><div class="t">${title}</div><div class="a">${authors}</div><div class="search-book-meta">${esc(details)}</div><div class="ops"><a class="btn-ghost sm" href="https://openlibrary.org${key}" target="_blank" rel="noopener noreferrer">查看书目 / 借阅信息 ↗</a></div></div></article>`;
}
function gutenbergCard(b){
  const id=Number(b.id); if(!Number.isInteger(id)||id<1) return '';
  const title=esc(b.title||'未命名');
  const authors=esc((b.authors||[]).map(a=>a.name).slice(0,3).join('、')||'作者信息暂无');
  const epub=safeGutenbergEpub(b.formats);
  const page='https://www.gutenberg.org/ebooks/'+id;
  return `<article class="sr search-book-card"><div class="search-cover search-cover-empty">公版</div><div class="search-book-main"><div class="t">${title}</div><div class="a">${authors}</div><div class="search-book-meta">Project Gutenberg · 公版书目</div><div class="ops"><a class="btn-ghost sm" href="${page}" target="_blank" rel="noopener noreferrer">查看书目 ↗</a>${epub?`<a class="btn-primary sm" href="${esc(epub)}" target="_blank" rel="noopener noreferrer">下载 EPUB</a>`:''}</div></div></article>`;
}
async function runBookSearch(){
  // v3.76：点搜索先直达 Anna's Archive（用户原令），站内书目结果随后在下方继续出
  const q=$('#search-q').value.trim(); if(!q){toast('输入书名、作者或找书描述');return;}
  rememberBookSearch(q);
  searchAnnasArchive();
  await doAiSearch(q);
}
/* Anna's Archive 镜像 */
const AA_MIRRORS=['https://annas-archive.pk','https://annas-archive.gl','https://annas-archive.gd'];
function aaBase(){ return store.get('aa_mirror') || AA_MIRRORS[0]; }
/* AI 搜书：点搜索直接在 Anna's Archive 全网搜书 */
async function searchAnnasArchive(){
  const q=$('#search-q').value.trim();
  if(!q){ toast('输入书名、作者或找书描述'); return; }
  rememberBookSearch(q);
  let query=q;
  // AI 扩展检索词（勾选且有 Key 时）
  if($('#search-ai')?.checked && (store.get('gemini_key')||'').trim()){
    toast('AI 理解中…');
    try{
      const expanded=await expandBookSearchQuery(q);
      if(expanded.length) query=expanded[0];
    }catch(e){ toast('AI 扩展失败，已按原关键词搜索'); }
  }
  const url=aaBase()+'/search?q='+encodeURIComponent(query);
  try{ const a=document.createElement('a'); a.href=url; a.target='_blank'; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove(); }catch(e){ location.href=url; }
  // v3.76：弹窗拦截不会抛错，a.click 静默失败时用户只看到"点了没反应"——留一条手动打开的链接兜底
  const fb=$('#anna-fallback');
  if(fb){ fb.innerHTML=`没自动打开？<a href="${url}" target="_blank" rel="noopener" style="color:#111;text-decoration:underline">点这里手动打开 Anna's Archive ↗</a>`; fb.classList.remove('hidden'); }
  toast('正在打开 Anna\'s Archive…');
}
$('#btn-anna').onclick=searchAnnasArchive;
$('#search-back').onclick=()=>go('home');
$('#home-search').onclick=()=>{ go('search'); setTimeout(()=>$('#search-q').focus(),80); };
$('#home-search').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); go('search'); setTimeout(()=>$('#search-q').focus(),80); } });
/* v3.76：Anna 镜像切换（此前三镜像写在代码里，App 内无路可换，.pk 被墙即全死） */
function renderAaMirrors(){ document.querySelectorAll('#aa-mirrors button').forEach(b=>b.classList.toggle('cur', aaBase()===b.dataset.m)); }
document.querySelectorAll('#aa-mirrors button').forEach(b=>b.onclick=()=>{ store.set('aa_mirror', b.dataset.m); renderAaMirrors(); toast('已切换镜像：'+b.dataset.m.replace('https://annas-archive','')); });
renderAaMirrors();
async function doAiSearch(q){
  const box=$('#search-results'); box.innerHTML='<div class="search-loading">正在查找书目…</div>';
  const useAI=$('#search-ai')?.checked;
  let terms=[q], aiNote='';
  if(useAI){
    if(!(store.get('gemini_key')||'').trim()) aiNote='Gemini Key 未配置，已按原始关键词搜索。';
    else{
      try{
        const expanded=await expandBookSearchQuery(q);
        terms=[...new Set([q,...expanded])].slice(0,3);
        aiNote=expanded.length?'Gemini 已扩展检索词。':'Gemini 未生成额外检索词，已按原始关键词搜索。';
      }catch(e){ aiNote='AI 扩展暂不可用，已按原始关键词搜索。'; }
    }
  }
  const tasks=terms.flatMap(term=>[
    {source:'open',run:()=>searchOpenLibrary(term)},
    {source:'gutenberg',run:()=>searchGutenberg(term)}
  ]);
  const settled=await Promise.allSettled(tasks.map(t=>t.run()));
  const open=[], gutenberg=[], errors=[];
  settled.forEach((r,i)=>{
    if(r.status!=='fulfilled'){ errors.push(tasks[i].source); return; }
    (tasks[i].source==='open'?open:gutenberg).push(...r.value);
  });
  const openUnique=[...new Map(open.filter(b=>b&&b.key).map(b=>[b.key,b])).values()].slice(0,8);
  const gutUnique=[...new Map(gutenberg.filter(b=>b&&b.id).map(b=>[String(b.id),b])).values()].slice(0,8);
  let html=aiNote?`<div class="search-note search-ai-status">${esc(aiNote)}</div>`:'';
  if(openUnique.length) html+='<h3 class="search-source-heading">Open Library <small>书目与借阅信息</small></h3>'+openUnique.map(openLibraryCard).join('');
  else if(!errors.includes('open')) html+='<div class="search-empty-source">Open Library 暂无匹配书目。</div>';
  if(gutUnique.length) html+='<h3 class="search-source-heading">Project Gutenberg <small>公版图书</small></h3>'+gutUnique.map(gutenbergCard).join('');
  else if(!errors.includes('gutenberg')) html+='<div class="search-empty-source">Project Gutenberg 暂无匹配公版书。</div>';
  if(errors.length===tasks.length) html+='<div class="search-error">书目服务暂时无法连接。检查网络后重试。</div><div style="margin:10px 0"><button class="btn-ghost sm" onclick="doAiSearch(document.querySelector(\'#search-q\').value.trim())">重试搜索</button> <span style="color:#888;font-size:13px">或点上方黑色按钮去 Anna\'s Archive 找书</span></div>';
  else if(errors.length) html+='<div class="search-error">部分书目服务暂不可用；已显示其余来源结果。</div>';
  if(!openUnique.length&&!gutUnique.length&&!errors.length) html+='<div class="search-empty-source">没有找到匹配书目，试试更短的书名或作者名。</div>';
  box.innerHTML=html;
}
/* ---------- 排版 ---------- */
function applyType(){
if(!store.get('ts_theme_migrated_393') && store.get('ts_theme')==='sepia'){ store.set('ts_theme','day'); store.set('ts_theme_migrated_393','1'); }
const c=$('#content'); if(!c) return;
const size=store.get('ts_size','24'), lh=store.get('ts_lh','18'),
font=store.get('ts_font','serif'), theme=store.get('ts_theme','day');
// v3.93：默认主题由暖纸黄改成 Readify 白底；老用户已存的 sepia 一次性迁到 day（用户亲口嫌黄）
c.style.fontSize=size+'px'; c.style.lineHeight=(lh/10);
c.style.fontFamily=font==='serif'?'Georgia,"Songti SC","Noto Serif CJK SC",serif':'-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
c.dataset.theme=theme;
const _pe=pagesEl(); if(_pe) _pe.dataset.theme=theme; // v3.88：容器背景跟主题走，纸才铺满全屏
$('#ts-size').value=size; $('#ts-size-v').textContent=size;
$('#ts-lh').value=lh; $('#ts-lh-v').textContent=(lh/10).toFixed(1);
$('#ts-font').value=font; $('#ts-theme').value=theme;
const tf=$('#ts-flip'); if(tf) tf.value=store.get('ts_flip','curl');
const s2=$('#ts-size2'); if(s2){ s2.value=size; const v2=$('#ts-size2-v'); if(v2) v2.textContent=size; }
const l2=$('#ts-lh2'); if(l2){ l2.value=lh; const v3=$('#ts-lh2-v'); if(v3) v3.textContent=(lh/10).toFixed(1); }
const f2=$('#ts-flip2'); if(f2) f2.value=store.get('ts_flip','curl');
const t2=$('#ts-theme2'); if(t2) t2.value=theme;
const ink=store.get('ts_ink','');
c.style.color=ink||'';
syncTypesetUI();
}
/* v3.86：Readify 式排版控件同步（字体名/行距 pills/颜色/背景/翻页 pills） */
const TS_THEME_TEXT={day:'#1d1d1f',sepia:'#4a3f2c',yellow:'#5a4a1a',green:'#2e4a2e',blue:'#2c3e50',pink:'#4a2c35',gray:'#333333',ink:'#d7dce2',darkblue:'#d0dce8',night:'#e8e2f5'};
function syncTypesetUI(){
  const fn=$('#ts-font-name'); if(fn) fn.textContent=store.get('ts_font','serif')==='serif'?'宋体':'无衬线';
  const lh=String(store.get('ts_lh','18'));
  document.querySelectorAll('#ts-lh-pills button').forEach(b=>b.classList.toggle('cur', b.dataset.lh===lh));
  const ink=store.get('ts_ink','')||TS_THEME_TEXT[store.get('ts_theme','day')]||'';
  document.querySelectorAll('#ts-ink-sw button').forEach(b=>b.classList.toggle('cur', ink && b.dataset.ink.toLowerCase()===ink.toLowerCase()));
  const th=store.get('ts_theme','day');
  document.querySelectorAll('#ts-bg-sw button').forEach(b=>b.classList.toggle('cur', b.dataset.theme===th));
  const fl=store.get('ts_flip','curl');
  document.querySelectorAll('#ts-flip-pills button').forEach(b=>b.classList.toggle('cur', b.dataset.flip===fl));
}
/* 排版按钮已并入目录抽屉（#dr-type） */
$('#btn-type-close').onclick=()=>$('#typeset').classList.add('hidden');
$('#ts-size').addEventListener('input',e=>{store.set('ts_size',e.target.value);applyType();scheduleRepaginate();});
$('#ts-lh').addEventListener('input',e=>{store.set('ts_lh',e.target.value);applyType();scheduleRepaginate();});
$('#ts-font').addEventListener('change',e=>{store.set('ts_font',e.target.value);applyType();scheduleRepaginate();});
$('#ts-theme').addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();scheduleRepaginate();});
$('#ts-flip').addEventListener('change',e=>{store.set('ts_flip',e.target.value);applyFlipMode();toast(e.target.selectedOptions[0].text+'已生效');});
const _t2=$('#ts-theme2'); if(_t2) _t2.addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();scheduleRepaginate();});
const _s2=$('#ts-size2'); if(_s2) _s2.addEventListener('input',e=>{store.set('ts_size',e.target.value);applyType();scheduleRepaginate();});
const _l2=$('#ts-lh2'); if(_l2) _l2.addEventListener('input',e=>{store.set('ts_lh',e.target.value);applyType();scheduleRepaginate();});
const _f2=$('#ts-flip2'); if(_f2) _f2.addEventListener('change',e=>{store.set('ts_flip',e.target.value);applyFlipMode();toast(e.target.selectedOptions[0].text+'已生效');});
/* v3.86：Readify 式排版新控件 */
const _tfr=$('#ts-font-row');
if(_tfr) _tfr.onclick=()=>{ const f=store.get('ts_font','serif'); store.set('ts_font', f==='serif'?'sans':'serif'); applyType(); scheduleRepaginate(); };
document.querySelectorAll('#ts-lh-pills button').forEach(b=>b.onclick=()=>{ store.set('ts_lh', b.dataset.lh); applyType(); scheduleRepaginate(); });
document.querySelectorAll('#ts-ink-sw button').forEach(b=>b.onclick=()=>{ const cur=store.get('ts_ink',''); store.set('ts_ink', cur===b.dataset.ink?'':b.dataset.ink); applyType(); });
document.querySelectorAll('#ts-bg-sw button').forEach(b=>b.onclick=()=>{ store.set('ts_theme', b.dataset.theme); store.set('ts_ink',''); applyType(); scheduleRepaginate(); });
document.querySelectorAll('#ts-flip-pills button').forEach(b=>b.onclick=()=>{ store.set('ts_flip', b.dataset.flip); applyFlipMode(); syncTypesetUI(); toast(b.textContent+'已生效'); });

/* ---------- 设置持久化 ---------- */
function initSettings(){
const bind=(id,k)=>{ const el=$(id); if(!el) return; el.value=store.get(k,el.value);
el.addEventListener('change',()=>store.set(k,el.value));};
bind('#sel-engine','tts_engine'); bind('#tts-endpoint','tts_ep'); bind('#tts-key','tts_key');
bind('#tts-voice','tts_voice'); bind('#gemini-key','gemini_key'); bind('#gemini-model','gemini_model');
bind('#sel-clone-provider','clone_provider'); bind('#clone-key','clone_key');
bind('#eleven-key','eleven_key'); bind('#ocr-key','ocr_key');
bind('#clone-ep','clone_ep'); bind('#clone-field-name','clone_field_name');
bind('#clone-field-file','clone_field_file'); bind('#clone-id-path','clone_id_path');
/* v3.14 起：引擎参数分组常显，不再按引擎选择折叠，避免找不到 Key 输入框/测试按钮 */
const et11=$('#btn-eleven-test');
if(et11) et11.onclick=async()=>{
  const out=$('#eleven-test-out'); out.textContent='测试中…';
  try{ const d=await elevenDiag(); out.textContent=d.msg; }
  catch(e){ out.textContent='测试异常：'+e.message; }
};
const ctog=()=>$('#clone-custom').classList.toggle('hidden',$('#sel-clone-provider').value!=='custom');
$('#sel-clone-provider').addEventListener('change',()=>{ ctog();
  const n=$('#clone-provider-note'); if(n) n.textContent=(CLONE_PROVIDERS[$('#sel-clone-provider').value]||{}).hint||''; });
ctog();
const amb=$('#sel-amb'); amb.value=store.get('amb_type','');
amb.addEventListener('change',()=>{store.set('amb_type',amb.value); wantPlay?startAmbience():Ambience.stop();});
const amv=$('#rng-amb'); amv.value=store.get('amb_vol','30');
amv.addEventListener('input',()=>{store.set('amb_vol',amv.value);Ambience.setVolume((+amv.value)/100*0.6);});
}

/* ---------- AI 助手 ---------- */
let aiMode='explain', storyTimer=null;
document.querySelectorAll('.ai-tab').forEach(t=>t.onclick=()=>{
document.querySelectorAll('.ai-tab').forEach(x=>x.classList.remove('cur'));
t.classList.add('cur'); aiMode=t.dataset.m;
$('#btn-ai-story').classList.add('hidden'); $('#btn-ai-story').textContent='▶ 播放分镜';
});
/* AI 助手按钮已并入目录抽屉（#dr-ai），选中文字仍可用 #btn-ai-ask */
$('#btn-ai-close').onclick=()=>{ $('#aisheet').classList.add('hidden'); stopStory();};
const getSelText=()=>{ const s=window.getSelection(); return s?s.toString().trim():'';};
$('#btn-tr').onclick=async()=>{
  const t=getSelText(); if(!t){ toast('先选中文字'); return; }
  const tip=$('#sel-tip'); tip.classList.add('hidden');
  toast('翻译中…');
  try{
    const r=await geminiAsk(`请翻译以下文字。如果是英文译成简体中文，如果是中文译成英文。只给出译文，不要解释：\n\n${t.slice(0,500)}`);
    // 用 AI 弹窗显示
    $('#ai-input').value='翻译：'+t.slice(0,80);
    renderAI('原文：'+t.slice(0,200)+'\n\n译文：'+r);
    $('#aisheet').classList.remove('hidden');
  }catch(e){ toast('翻译失败：'+e.message); }
  window.getSelection().removeAllRanges();
};
$('#btn-ai-ask').onclick=()=>{ const t=getSelText(); if(t) $('#ai-input').value=t;
$('#sel-tip').classList.add('hidden'); $('#aisheet').classList.remove('hidden');};
$('#btn-ai-go').onclick=async()=>{
const t=$('#ai-input').value.trim(); if(!t){toast('先输入或选中一段文字');return;}
const out=$('#ai-out');
out.innerHTML='<p class="sub">AI 思考中…</p>'; $('#ai-foot').classList.add('hidden');
$('#btn-ai-story').classList.add('hidden');
try{ renderAI(await geminiAsk(PROMPTS[aiMode](t)));}
catch(e){ out.innerHTML='<p class="sub">失败：'+esc(e.message)+'</p>';}
};
function renderAI(txt){
const out=$('#ai-out'); out.innerHTML=''; out._raw=txt;
if(aiMode==='analogy'){
const cards=[...txt.matchAll(/【画面】([^（\n；]+)[；;]?\s*[（(]解说[）)]\s*(.+)/g)];
if(cards.length){
cards.forEach((m,i)=>{
const d=document.createElement('div'); d.className='card';
d.innerHTML=`<h4>分镜 ${i+1} / ${cards.length}</h4><p>🎬 ${esc(m[1].trim())}</p><p>🎙 ${esc(m[2].trim())}</p>`;
out.appendChild(d);
});
$('#btn-ai-story').classList.remove('hidden');
} else out.textContent=txt;
} else out.textContent=txt;
$('#ai-foot').classList.remove('hidden');
}
$('#btn-ai-speak').onclick=()=>{
const txt=$('#ai-out')._raw||''; if(!txt){toast('没有可朗读的内容');return;}
stopSpeak(); wantPlay=false;
if(!synth){toast('当前浏览器不支持语音');return;}
const u=new SpeechSynthesisUtterance(txt.slice(0,2500));
const v=pickVoice({lang:detectLang(txt),voiceURI:''}); if(v)u.voice=v;
u.rate=(cur?cur.rate:100)/100; synth.cancel(); synth.speak(u); toast('正在朗读讲解');
};
$('#btn-ai-story').onclick=()=>{
const cards=[...document.querySelectorAll('#ai-out .card')]; if(!cards.length)return;
if(storyTimer){ stopStory(); return;}
let i=0;
const step=()=>{
cards.forEach(c=>c.classList.remove('playing'));
if(i>=cards.length){ stopStory(); return;}
const c=cards[i]; c.classList.add('playing'); c.scrollIntoView({block:'center',behavior:'smooth'});
if(synth){ try{synth.cancel(); const u=new SpeechSynthesisUtterance(c.innerText);
const v=pickVoice({lang:'zh',voiceURI:''}); if(v)u.voice=v; synth.speak(u);}catch(e){}}
i++; storyTimer=setTimeout(step,7000);
};
$('#btn-ai-story').textContent='⏹ 停止'; step();
};
function stopStory(){ clearTimeout(storyTimer); storyTimer=null; if(synth){try{synth.cancel();}catch(e){}}
document.querySelectorAll('#ai-out .card').forEach(c=>c.classList.remove('playing'));
const b=$('#btn-ai-story'); if(b) b.textContent='▶ 播放分镜';}
function handleSel(e){
const tip=$('#sel-tip');
if(!$('#view-reader').classList.contains('hidden') && e.target.closest('#content')){
const t=getSelText(); tip.classList.toggle('hidden',!(t&&t.length>1));
} else if(!e.target.closest('#sel-tip')) tip.classList.add('hidden');
}
document.addEventListener('mouseup',handleSel);
document.addEventListener('touchend',handleSel);

/* ---------- 启动（v2） ---------- */
(async()=>{
try{ initSettings(); applyType();}catch(e){}
})();

/* ================= v3：Apo 风格 UI ================= */

/* ---------- 启动页 ---------- */
$('#btn-start').onclick=()=>{ try{store.set('splash_done','1');}catch(e){} go('home'); };

/* ---------- 首页 ---------- */
/* ================= v3.5：Readify 式首页 ================= */
function rdCardHTML(b){
  const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
  const done=b.progress.idx>=b.total-1&&b.total>1;
  return `<div class="cov">${coverInner(b)}
    ${pct?`<span class="pbdg${done?' done':''}">${done?'✓':pct+'%'}</span>`:''}</div>
    <div class="nm">${esc(b.title)}</div>`;
}
async function renderHome(){
  if(!books.length){ try{ await loadBooks(); }catch(e){} }
  const has=books.length>0;
  $('#home-empty').classList.toggle('hidden', has);
  // 继续阅读：有进度的书横向排；没有进度书时回退显示最近加入的一本，别让首页变空壳
  let cont=books.filter(b=>b.progress.idx>0 && b.progress.idx<b.total-1)
    .sort((a,b)=>b.progress.updatedAt-a.progress.updatedAt).slice(0,8);
  let contTitle='继续阅读';
  if(!cont.length && books.length){ cont=[...books].sort((a,b)=>b.addedAt-a.addedAt).slice(0,1); contTitle='最近加入'; }
  const ct=$('#continue-wrap .rd-sec h3'); if(ct) ct.textContent=contTitle;
  $('#continue-wrap').classList.toggle('hidden', !cont.length);
  const cl=$('#cont-list'); cl.innerHTML='';
  cont.forEach(b=>{
    const d=document.createElement('div'); d.className='rd-bcard';
    d.innerHTML=rdCardHTML(b);
    d.onclick=async()=>{ returnView='home'; await openBook(b.id); };
    cl.appendChild(d);
  });
  renderStats();
  renderClassics();
  renderBanner();
  updateMiniPlayer();
}
/* v3.80：经典必读——公版书，点一本直接去搜书页查 Open Library / Gutenberg */
function renderClassics(){
  const list=$('#classics-list'); if(!list) return;
  if(list.children.length) return; // 静态列表，只渲染一次
  CLASSICS.forEach(t=>{
    const d=document.createElement('div'); d.className='rd-bcard';
    d.innerHTML=`<div class="cov"><div class="ct" style="background:${coverBG({title:t})}">${esc(t)}</div></div><div class="nm">${esc(t)}</div>`;
    d.onclick=()=>{ go('search'); const q=$('#search-q'); if(q){ q.value=t; } doAiSearch(t); };
    list.appendChild(d);
  });
}
/* v3.80：打卡横幅——今日目标与连续天数是真实数据，不是装饰 */
function renderBanner(){
  const b=$('#banner'); if(!b) return;
  try{ if(localStorage.getItem('apo_banner_hide')===statKey(new Date())){ b.classList.add('hidden'); return; } }catch(e){}
  b.classList.remove('hidden');
  const st=getStat(), k=statKey(new Date());
  const todayMin=Math.floor((st.days[k]||0)/60), done=todayMin>=st.target;
  const sub=$('#banner-sub'), btn=$('#banner-btn');
  if(sub) sub.textContent=done?`今日目标已达成 · 已连续阅读 ${st.streak} 天，明天继续。`:`已连续阅读 ${st.streak} 天 · 今日已读 ${todayMin} 分钟 / 目标 ${st.target} 分钟。`;
  if(btn) btn.textContent=done?'查看统计 ›':'去阅读 ›';
}
$('#btn-mine').onclick=()=>go('mine');
$('#btn-home-settings').onclick=()=>go('mine');
$('#mine-back').onclick=()=>go('home');
$('#banner-btn').onclick=async()=>{
  const cont=books.filter(b=>b.progress.idx>0 && b.progress.idx<b.total-1);
  if(cont.length){ returnView='home'; await openBook(cont[0].id); }
  else if(books.length){ returnView='home'; await openBook(books[0].id); }
  else openImportSheet();
};
$('#banner-x').onclick=e=>{ e.stopPropagation(); try{ localStorage.setItem('apo_banner_hide', statKey(new Date())); }catch(err){} $('#banner').classList.add('hidden'); };
/* v3.82：横幅双 slide 轮播（原图横幅带圆点）——打卡 + 克隆音色，6 秒自动轮换，可点圆点/左右滑切换 */
let bannerSlide=0, bannerTimer=null;
function showBannerSlide(i){
  const slides=document.querySelectorAll('#banner .rb-slide'); if(!slides.length) return;
  bannerSlide=((i%slides.length)+slides.length)%slides.length;
  slides.forEach((el,j)=>el.classList.toggle('cur', j===bannerSlide));
  document.querySelectorAll('#banner-dots i').forEach((el,j)=>el.classList.toggle('cur', j===bannerSlide));
}
function startBannerTimer(){
  if(bannerTimer) clearInterval(bannerTimer);
  bannerTimer=setInterval(()=>{ if(curView==='home' && !document.hidden && !$('#banner').classList.contains('hidden')) showBannerSlide(bannerSlide+1); }, 6000);
}
$('#banner-btn2').onclick=()=>{ go('voice'); setTimeout(()=>{ document.querySelector('.vt[data-t="clone"]')?.click(); }, 300); };
document.querySelectorAll('#banner-dots i').forEach(d=>d.onclick=e=>{ e.stopPropagation(); showBannerSlide(Number(d.dataset.s)); });
let _bx=null;
$('#banner').addEventListener('touchstart', e=>{ _bx=e.touches[0].clientX; }, {passive:true});
$('#banner').addEventListener('touchend', e=>{ if(_bx===null) return; const dx=e.changedTouches[0].clientX-_bx; if(Math.abs(dx)>40) showBannerSlide(bannerSlide+(dx<0?1:-1)); _bx=null; }, {passive:true});
startBannerTimer();
$('#classics-more').onclick=()=>go('search');
/* v3.80：首页搜索框占位提示轮换（示例书名，点进去就是搜书页） */
const SEARCH_HINTS=['三体','红楼梦','认知天性','成为乔布斯','百年孤独'];
let _shi=0;
setInterval(()=>{ const el=document.querySelector('#home-search .hs-t'); if(el&&curView==='home') el.textContent='搜“'+SEARCH_HINTS[_shi++%SEARCH_HINTS.length]+'”试试'; },4000);

/* ---------- 我的徽章（v3.81：全部按真实阅读数据算，不造假） ---------- */
function badgeStats(){
  const s=getStat();
  const totalMin=Math.round(Object.values(s.days||{}).reduce((a,b)=>a+b,0)/60);
  const todayMin=Math.floor((s.days[statKey(new Date())]||0)/60);
  const finished=books.filter(b=>(b.total||1)>1 && (b.progress?.idx||0)>=(b.total||1)-1).length;
  return {streak:s.streak||0, totalMin, todayMin, target:s.target||30, finished, count:books.length};
}
const BADGES=[
  {icon:'📖', name:'初试啼声', desc:'导入第一本书', test:x=>x.count>=1},
  {icon:'🔥', name:'三日不辍', desc:'连续阅读 3 天', test:x=>x.streak>=3},
  {icon:'🔥', name:'七日不辍', desc:'连续阅读 7 天', test:x=>x.streak>=7},
  {icon:'👑', name:'月满则盈', desc:'连续阅读 30 天', test:x=>x.streak>=30},
  {icon:'🎯', name:'今日达标', desc:'今日阅读达到目标时长', test:x=>x.todayMin>=x.target},
  {icon:'✅', name:'读完一本', desc:'读完任意一本书', test:x=>x.finished>=1},
  {icon:'⏱', name:'累计 10 小时', desc:'累计阅读满 10 小时', test:x=>x.totalMin>=600},
  {icon:'📚', name:'博览群书', desc:'书架满 10 本书', test:x=>x.count>=10},
];
async function renderBadges(){
  if(!books.length){ try{ await loadBooks(); }catch(e){} }
  const x=badgeStats();
  const got=BADGES.filter(b=>b.test(x)).length;
  const sum=$('#badges-summary'); if(sum) sum.textContent=`已获得 ${got} / ${BADGES.length} 枚 · 连续阅读 ${x.streak} 天 · 累计 ${x.totalMin} 分钟 · 读完 ${x.finished} 本`;
  const list=$('#badges-list'); if(!list) return;
  list.innerHTML=BADGES.map(b=>{
    const ok=b.test(x);
    return `<div class="badge-row${ok?' got':''}"><span class="bd-ic">${b.icon}</span><span class="bd-t"><b>${b.name}</b><i>${b.desc}</i></span><span class="bd-st">${ok?'已获得':'未获得'}</span></div>`;
  }).join('');
}
/* v3.81：系统分享（横幅与分享行共用）；用户取消分享不弹复制提示 */
async function shareApo(){
  const url='https://dargeryu.github.io/deepreading/';
  try{
    if(navigator.share){ await navigator.share({title:'Apo', text:'Apo：把书听成故事', url}); return; }
    throw new Error('no-share');
  }catch(e){
    if(e && e.name==='AbortError') return;
    try{ await navigator.clipboard.writeText(url); toast('链接已复制，发给朋友就能一起听书'); }
    catch(err){ prompt('复制下面的链接发给朋友：', url); }
  }
}

/* ---------- 书籍详情 ---------- */

/* ---------- 迷你播放器 ---------- */
function updateMiniPlayer(){
  const mp=$('#mini-player'); if(!mp) return;
  const fullOpen=!$('#player-full').classList.contains('hidden');
  const show=!!(cur && curView!=='reader' && curView!=='splash' && !fullOpen);
  mp.classList.toggle('hidden', !show);
  if(!show) return;
  setCoverEl($('#mp-cover'), cur, 6);
  $('#mp-title').textContent=cur.title;
  $('#mp-pos').textContent=Math.round(100*cur.progress.idx/Math.max(1,cur.total))+'%';
  $('#mp-play').innerHTML=wantPlay?PAUSE_ICON:PLAY_ICON;
  const mf=$('#mp-fill');
  if(mf) mf.style.width=Math.round(100*cur.progress.idx/Math.max(1,cur.total))+'%';
  paintWave();
}
$('#mini-player').onclick=e=>{
  if(e.target.closest('#mp-play')){ if(!cur)return; wantPlay?stopSpeak():play(); return; }
  openFullPlayer();
};

/* ---------- 完整播放器 ---------- */
const SPEEDS=[1.0,1.25,1.5,1.75,2.0,0.5,0.75];
const SLEEPS=[0,15,30,60];
let sleepTimer=null, sleepMin=0, sleepEnd=0;
function renderFullPlayer(){
  if(!cur) return;
  setCoverEl($('#fp-cover'), cur, 12);
  $('#fp-title').textContent=cur.title;
  const ch=cur.chapters[chapterOf(cur.progress.idx)];
  $('#fp-sub').textContent=ch?ch.title:'';
  syncFullPlayer();
}
(function initWave(){
  const w=$('#fp-wave'); if(!w||w.children.length) return;
  for(let i=0;i<56;i++){ const b=document.createElement('i');
    b.style.height=(5+Math.round(24*Math.abs(Math.sin(i*1.93)+0.4*Math.sin(i*0.7))))+'px';
    b.style.animationDelay=(i%9*0.13).toFixed(2)+'s'; w.appendChild(b); }
})();
function paintWave(){
  document.body.classList.toggle('playing', typeof wantPlay!=='undefined'&&!!wantPlay);
  const w=$('#fp-wave'); if(!w||!cur||!w.children.length) return;
  const on=Math.round(w.children.length*cur.progress.idx/Math.max(1,cur.total));
  for(let i=0;i<w.children.length;i++) w.children[i].classList.toggle('on', i<on);
}
function syncFullPlayer(){
  if(!cur||$('#player-full').classList.contains('hidden')) return;
  const fs=$('#fp-state'); if(fs) fs.textContent=wantPlay?'正在播放':'已暂停';
  const pct=Math.round(1000*cur.progress.idx/Math.max(1,cur.total));
  $('#fp-seek').value=pct;
  $('#fp-play').innerHTML=wantPlay?PAUSE_ICON:PLAY_ICON;
  const _tm=estTimes();
  $('#fp-cur').textContent=fmtClock(_tm.el);
  $('#fp-total').textContent=fmtClock(_tm.total);
  $('#fp-speed').classList.toggle('on', (cur.rate/100)!==1);
  $('#fp-speed').querySelector('span').textContent=fmtRate(cur.rate/100);
  const t=$('#fp-timer');
  t.classList.toggle('on', sleepMin>0);
  t.querySelector('span').textContent=sleepMin>0?`定时${sleepMin}′`:'定时';
}
function openFullPlayer(){ if(!cur){toast('先选一本书');return;} renderFullPlayer(); $('#player-full').classList.remove('hidden'); syncFullPlayer(); updateMiniPlayer(); }
$('#fp-close').onclick=()=>{ $('#player-full').classList.add('hidden'); updateMiniPlayer(); };
$('#fp-play').onclick=()=>{ if(!cur)return; wantPlay?stopSpeak():play(); syncFullPlayer(); };
$('#fp-seek').addEventListener('change',e=>{ if(!cur)return; seekTo(Math.round(e.target.value/1000*(cur.total-1))); });
$('#fp-wave').onclick=e=>{ if(!cur)return; const r=e.currentTarget.getBoundingClientRect();
  seekTo(Math.round((e.clientX-r.left)/r.width*(cur.total-1))); };
$('#fp-back15').onclick=()=>skipSeconds(-15);
$('#fp-fwd15').onclick=()=>skipSeconds(15);
/* v3.83：按字数估算已播/总时长（与 skipSeconds 同一套 4.2 字/秒口径），供播放器时间显示 */
function estTimes(){
  if(!cur) return {el:0, total:0};
  const cps=4.2*(cur.rate/100);
  let el=0, total=0;
  cur.sentences.forEach((s,i)=>{ const d=s.t.length/cps; total+=d; if(i<cur.progress.idx) el+=d; });
  return {el, total};
}
function fmtClock(sec){ sec=Math.max(0,Math.round(sec)); const p=n=>String(n).padStart(2,'0'); return `${p(Math.floor(sec/3600))}:${p(Math.floor(sec%3600/60))}:${p(sec%60)}`; }
function skipSeconds(sec){
  if(!cur) return;
  const cps=4.2*(cur.rate/100); // 每秒约读字数
  let chars=Math.abs(sec)*cps, i=cur.progress.idx;
  if(sec>0){ while(chars>0&&i<cur.total-1){ chars-=cur.sentences[i].t.length; i++; } }
  else { while(chars>0&&i>0){ i--; chars-=cur.sentences[i].t.length; } }
  seekTo(i); toast(sec>0?'快进 15 秒':'快退 15 秒');
}
$('#fp-speed').onclick=()=>{ cycleSpeed(); };
$('#fp-timer').onclick=()=>{
  let ni=SLEEPS.indexOf(sleepMin)+1; if(ni>=SLEEPS.length) ni=0;
  setSleep(SLEEPS[ni]);
};
function setSleep(min){
  clearTimeout(sleepTimer); sleepTimer=null; sleepMin=min;
  if(min>0){
    sleepEnd=Date.now()+min*60000;
    sleepTimer=setTimeout(()=>{ sleepMin=0; stopSpeak(); syncFullPlayer(); toast('定时到了，已暂停'); }, min*60000);
    toast(`将在 ${min} 分钟后停止播放`);
  } else toast('已取消定时');
  syncFullPlayer();
}
$('#fp-chapters').onclick=()=>{ $('#player-full').classList.add('hidden'); if(cur){ returnView='library'; go('reader'); } };

/* 同步迷你/完整播放器状态 */
const _markActive=markActive;
markActive=function(){ _markActive(); updateMiniPlayer(); syncFullPlayer(); };

/* ===== 语音输入（SpeechRecognition）===== */
let _rec=null, _recTarget=null, _recBase='';
function voiceInput(target, btn){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ toast('当前浏览器不支持语音输入'); return; }
  if(_rec){ _rec.stop(); return; } // 再次点击停止
  const r=new SR();
  r.lang='zh-CN'; r.interimResults=true; r.maxAlternatives=1;
  _rec=r; _recTarget=target; _recBase=target.value?target.value+'\n':'';
  btn.classList.add('recording'); btn.textContent='⏹ 点击停止';
  toast('请说话…');
  r.onresult=e=>{
    let fin='', tmp='';
    for(const res of e.results){ (res.isFinal?fin+=res[0].transcript:tmp+=res[0].transcript); }
    target.value=_recBase+fin+tmp;
  };
  const done=()=>{ btn.classList.remove('recording'); btn.innerHTML=btn.id==='btn-ai-mic'?'🎤 语音输入':'🎤'; _rec=null; };
  r.onend=done;
  r.onerror=e=>{
    done();
    const m={'not-allowed':'麦克风被拒绝，请在浏览器设置中允许','network':'网络问题，语音识别需要联网','aborted':'已取消'}[e.error]||('识别失败：'+e.error);
    toast(m);
  };
  try{ r.start(); }catch(e){ done(); toast('启动失败：'+e.message); }
}
$('#btn-ai-mic').onclick=e=>voiceInput($('#ai-input'), e.currentTarget);
