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
function splitSentences(text){
  const out=[]; let buf='';
  const push=()=>{ const t=buf.trim(); if(t) out.push(t); buf=''; };
  for (let i=0;i<text.length;i++){
    const ch=text[i]; buf+=ch;
    if ('。！？；'.includes(ch)) push();
    else if (ch==='…' && text[i+1]!=='…') push();
    else if ((ch==='.'||ch==='!'||ch==='?') && /[a-zA-Z\u4e00-\u9fff]/.test(text[i-1]||'') && !/[a-zA-Z]/.test(text[i+1]||'') && !/(Mr|Mrs|Ms|Dr|St)\.$/.test(buf.slice(-4))) push();
    else if (ch==='\n'){ if(buf.trim()) push(); }
  }
  push();
  return out.filter(s=>s.length>1);
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
    r.onsuccess=()=>{db=r.result;res();}; r.onerror=()=>rej(r.error);
  });
}
const _tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
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
    t.onsuccess=()=>res();t.onerror=()=>rej(t.error);}))).concat([idb.delPageCacheByBook(id).catch(()=>{})]),
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
  const cleaned=pageTexts.map(t=>t.split('\n')
    .map(x=>x.trim())
    .filter(x=>x && !banned.has(x) && !/^\d{1,4}$/.test(x) && !/^第\s*\d+\s*页$/.test(x))
    .join('\n')).join('\n');
  return {title:'', text:cleaned};
}
/* EPUB：解包 → OPF → spine 顺序取正文 */
async function parseEPUB(buf){
  const zip=await JSZip.loadAsync(buf);
  const containerTxt=await zip.file('META-INF/container.xml').async('text');
  const opfPath=(containerTxt.match(/full-path="([^"]+)"/)||[])[1];
  if(!opfPath) throw new Error('EPUB 结构异常');
  const base=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
  const opf=await zip.file(opfPath).async('text');
  const items={};
  for (const m of opf.matchAll(/<item[^>]*>/g)){
    const tag=m[0];
    const id=(tag.match(/id="([^"]+)"/)||[])[1], href=(tag.match(/href="([^"]+)"/)||[])[1];
    if(id&&href) items[id]=base+decodeURIComponent(href);
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
  return {title:title.trim(), chapters};
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
  doc.querySelectorAll('script,style,nav,header,footer').forEach(e=>e.remove());
  const text=(doc.body?doc.body.innerText:'').split('\n').map(x=>x.trim()).filter(x=>x).join('\n');
  return {title:(doc.title||'').trim(), text};
}
async function finalizeImport(title, format, chapters, fileData, fileName){
  // 章节 → 句子
  const sentences=[]; const chIndex=[];
  chapters.forEach((c,ci)=>{
    chIndex.push({title:c.title||`第${ci+1}章`, start:sentences.length});
    for (const s of splitSentences(c.text)) sentences.push({t:s, c:ci});
  });
  if (!sentences.length) throw new Error('没有提取到正文');
  const sample=sentences.slice(0,30).map(s=>s.t).join(' ');
  const book={ id:uid(), title, format, addedAt:Date.now(),
    lang:detectLang(sample), total:sentences.length, sentences, chapters:chIndex,
    hasFile:!!fileData, fileName:fileName||'',
    progress:{idx:0, updatedAt:Date.now()}, voiceURI:'', voiceURI2:'', rate:100, dialogVoice:false };
  await idb.put(stripBook(book));
  if(fileData) await idb.putFile(book.id,fileData,fileName).catch(()=>{});
  await idb.putProgress(book.id,0).catch(()=>{});
  toast(`已导入《${title}》，共 ${sentences.length} 句`);
  return book;
}
async function importFile(file){
  loading(true,`解析 ${file.name}…`);
  try{
    const buf=await file.arrayBuffer();
    const fileData=buf.slice(0); // pdf.js 可能转移原 buffer，先复制一份存档
    const ext=file.name.split('.').pop().toLowerCase();
    let title=file.name.replace(/\.[^.]+$/,''), chapters;
    if (ext==='pdf'){ const r=await parsePDF(buf); chapters=splitChapters(r.text); }
    else if (ext==='epub'){ const r=await parseEPUB(buf); title=r.title||title; chapters=r.chapters; }
    else if (ext==='docx'){ const r=await parseDOCX(buf); chapters=splitChapters(r.text); }
    else if (ext==='fb2'){ const r=await parseFB2(buf); title=r.title||title; chapters=splitChapters(r.text); }
    else if (ext==='html'||ext==='htm'){ const r=await parseHTML(buf); title=r.title||title; chapters=splitChapters(r.text); }
    else { const r=await parseTXT(buf); chapters=splitChapters(r.text); }
    return await finalizeImport(title, ext, chapters, fileData, file.name);
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
    const title=res.title||'网页文章';
    const chapters=splitChapters(res.text);
    return await finalizeImport(title, 'html', chapters, null, '');
  }catch(e){
    throw new Error(/Failed to fetch|NetworkError|CORS/i.test(e.message)?'该网页不允许跨域抓取，试试复制正文用「粘贴文本」导入':e.message);
  }finally{ loading(false); }
}

/* ---------- 书架 ---------- */
const COVERS=[['#3b2f4a','#7a5fa0'],['#1f3a4d','#3f7fae'],['#4a2f2b','#a06a5f'],
  ['#2b4a35','#5fa07a'],['#4d4420','#ae9a3f'],['#333','#777']];
let books=[];
function coverBG(b){ const [c1,c2]=COVERS[(b.title||'').length%COVERS.length];
  return `linear-gradient(135deg,${c1},${c2})`; }
const coverHTML=(b,cls)=>`<div class="cover ${cls}" style="background:${coverBG(b)}">${esc((b.title||'?').slice(0,12))}</div>`;
async function loadBooks(){
  books=await idb.all();
  const pm={}; try{ (await idb.allProgress()).forEach(p=>pm[p.bookId]=p); }catch(e){}
  books.forEach(b=>{ b.progress = pm[b.id]
    ? {idx:pm[b.id].idx, updatedAt:pm[b.id].updatedAt}
    : {idx:0, updatedAt:b.addedAt}; });
  books.sort((a,b)=>b.progress.updatedAt-a.progress.updatedAt);
}
let shelfSort='recent', shelfFmt='';
/* ---------- 书架分类 ---------- */
let shelfCat = '';
const getCats = () => { try{ return JSON.parse(localStorage.getItem('dr_cats')||'[]'); }catch(e){ return []; } };
const saveCats = c => { try{ localStorage.setItem('dr_cats', JSON.stringify(c)); }catch(e){} };
function renderCatBar(){
  const bar = $('#cat-bar');
  if(!bar) return;
  const cats = getCats();
  let h = `<button class="chat-sugg${!shelfCat?'':' '}" data-c="" style="${!shelfCat?'background:#1890ff;color:#fff;border-color:#1890ff':''}">全部</button>`;
  for(const c of cats) h += `<button class="chat-sugg" data-c="${esc(c)}" style="${shelfCat===c?'background:#1890ff;color:#fff;border-color:#1890ff':''}">${esc(c)}</button>`;
  h += `<button class="chat-sugg" data-c="__new" style="border-style:dashed">＋新建</button>`;
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
  $('#shelf-empty').classList.toggle('hidden', has);
  $('#shelf-has').classList.toggle('hidden', !has);
  if(!has){ updateMiniPlayer(); return; }
  const filtered = shelfCat ? books.filter(b => (b.cat||'')===shelfCat) : books;
  const sorted=[...filtered];
  if(shelfSort==='title') sorted.sort((a,b)=>String(a.title).localeCompare(String(b.title),'zh'));
  else sorted.sort((a,b)=>b.progress.updatedAt-a.progress.updatedAt);
  const list=$('#shelf-list'); list.innerHTML='';
  sorted.forEach(b=>{
    const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
    const done=b.progress.idx>=b.total-1&&b.total>1;
    const el=document.createElement('div'); el.className='bk-row';
    el.innerHTML=`<div class="cov"><div class="ct" style="background:${coverBG(b)}">${esc((b.title||'?').slice(0,10))}</div>
      ${pct?`<span class="pbdg${done?' done':''}">${done?'✓':pct+'%'}</span>`:''}</div>
      <div class="inf"><div class="t">${esc(b.title)}</div>
      <div class="a">${esc(b.author||'未知作者')}</div>
      <span class="fb">${esc((b.format||'').toUpperCase()||'BOOK')}</span></div>`;
    el.onclick=()=>openDetail(b.id);
    el.oncontextmenu=e=>{ e.preventDefault(); openBookMenu(b); };
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
$('#bm-open').onclick=()=>{ closeSheets(); if(menuBook) openDetail(menuBook.id); };
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
$('#btn-lib-search').onclick=()=>go('search');
$('#btn-lib-sort').onclick=()=>{ shelfSort=shelfSort==='title'?'recent':'title'; toast(shelfSort==='title'?'按书名排序':'按最近阅读排序'); renderShelf(); };
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
/* ---------- v3 导航 ---------- */
const VIEWS=['splash','home','library','search','detail','reader','mine','voice','notes','bookchat','bookmarks','stats'];
let curView='home', returnView='library';
function go(name){
  curView=name;
  VIEWS.forEach(v=>{ const el=$('#view-'+v); if(el) el.classList.toggle('hidden', v!==name); });
  document.body.classList.toggle('in-reader', name==='reader');
  document.body.classList.toggle('in-splash', name==='splash');
  document.querySelectorAll('#tabbar .tab').forEach(t=>t.classList.toggle('cur', t.dataset.v===name));
  document.querySelectorAll('#sidebar .sb-item').forEach(t=>t.classList.toggle('cur', t.dataset.v===name));
  if(name==='library'){ stopSpeak(); renderShelf(); }
  else if(name==='home'){ stopSpeak(); renderHome(); }
  else if(name==='voice'){ stopSpeak(); renderVoice(); }
  else if(name==='search'){ stopSpeak(); $('#search-results').innerHTML=''; }
  else if(name==='mine'){ stopSpeak(); }
  else if(name==='notes'){ stopSpeak(); renderNotesList(); }
  else if(name==='bookchat'){ stopSpeak(); }
  else if(name==='bookmarks'){ stopSpeak(); renderBookmarksList(); }
  else if(name==='stats'){ stopSpeak(); renderStatsDetail('week'); }
  updateMiniPlayer();
  window.scrollTo(0,0);
}
function showView(name){ go(name); } // 兼容旧调用
async function openBook(id){
  cur=books.find(b=>b.id===id); if(!cur) return;
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
      const h=document.createElement('span'); h.className='ch-title';
      h.textContent=cur.chapters[ci]?cur.chapters[ci].title:`第${ci+1}章`; c.appendChild(h);
    }
    const sp=document.createElement('span'); sp.className='sent'; sp.textContent=sn.t; sp.dataset.g=i;
    sp.onclick=(()=>{ const g=i; return ()=>{ if(pageTouchMoved) return; seekTo(g); }; })();
    c.appendChild(sp); c.appendChild(document.createTextNode(' ')); sentEls.push(sp);
  }
  layoutPages();
}
/* ---------- 独立分页 + 仿真翻页（v3.21） ----------
 * 每本书独立的页码体系（见 js/paginate.js），一列即一页；
 * 手势与翻页动画见 js/flip.js，本文件负责页状态与渲染窗口的衔接。 */
let pageTouchMoved=false;
const pagesEl=()=>$('#reader-pages');
function layoutPages(){
  const el=pagesEl(); if(!el||!cur) return;
  const w=el.clientWidth||0;
  if(w<10) return; // 阅读器隐藏时不写，避免 200px 最小列宽污染后续排版
  el.style.columnWidth=Math.max(200, w-44)+'px'; // 多列直接建在滚动容器上（一列一页）
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
    const want=W-44, has=parseFloat(el.style.columnWidth||'0');
    if(Math.abs(has-want)>2) layoutPages();
    if(el.style.transform){ el.style.transition=''; el.style.transform=''; }
  }
  ensureWindowForPage(gp);
  el.scrollTo({left:localPageOf(gp)*W, behavior:'auto'});
  PG.page=gp; commitPageState();
  verifyPageAlignment(gp, W);
}
// 实测纠偏：目标页首句应在列首 x≈22（padding），偏差则直接纠正
function verifyPageAlignment(gp, W){
  if(!PG.ready || !W || W<=10) return;
  requestAnimationFrame(()=>{
    if(!cur || PG.page!==gp || Flip.active) return;
    try{
      const si = sentenceOfPage(gp) - winStart;
      const node = sentEls[si];
      if(!node) return;
      const el = pagesEl();
      const r = node.getBoundingClientRect(), cr = el.getBoundingClientRect();
      if(r.width < 1) return; // 未布局完成，跳过
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
      const err = (r.left - cr.left) - pad;
      if(Math.abs(err) > 3 && Math.abs(err) < W/2){
        el.scrollTo({left: el.scrollLeft + err, behavior:'auto'});
      }
    }catch(e){}
  });
}
function commitPage(gp){ PG.page=gp; commitPageState(); }
function commitPageState(){ updateCount(); saveProgress(); }
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
  if(rc) rc.textContent=(PG.ready&&PG.total>0)?('第 '+(PG.page+1)+' 页 / 共 '+PG.total+' 页'):'';
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
async function paginateInBackground(h, idx){
  let res=null;
  try{ res=await paginateBook(cur, h); }catch(e){ res=null; }
  if(!res) return;                                        // 中途已失效
  if(!cur||PG.bookId!==cur.id||pageHash()!==h) return;    // 书已切换或排版已变
  PG.starts=res.starts; PG.total=res.total; PG.ready=true; pgVer++;
  try{ await idb.putPageCache({key:cur.id+'|'+h, bookId:cur.id, hash:h, starts:res.starts, total:res.total, updatedAt:Date.now()}); }catch(e){}
  const target=pageOfSentence(Math.max(0,Math.min(cur.total-1,idx||0)));
  if(target!==PG.page) showPageInstant(target); else updateCount();
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
    if(e.key==='ArrowRight') setPage(PG.page+1,{animate:true});
    else if(e.key==='ArrowLeft') setPage(PG.page-1,{animate:true});
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
function seekTo(i){
  stopSpeak();
  cur.progress.idx=Math.max(0,Math.min(cur.total-1,i));
  cur._lastSpk=null; // 多角色说话人追踪重置
  markActive(); scrollToActive(); saveProgress(); play();
}
const fmtRate=sp=>{ let s=sp.toFixed(2).replace(/0+$/,''); if(s.endsWith('.')) s+='0'; return s+'x'; };
function updatePlayer(){
  if(!cur) return;
  const pct=100*cur.progress.idx/Math.max(1,cur.total);
  updateCount();
  const fill=$('#rp-fill'); if(fill) fill.style.width=pct+'%';
  const ch=cur.chapters[chapterOf(cur.progress.idx)];
  const rh=$('#reader-chapter'); if(rh) rh.textContent=ch?ch.title:cur.title;
  const spt=$('#rp-speed');
  if(spt) spt.textContent=fmtRate(cur.rate/100);
  const cv=$('#rp-cover'); if(cv) cv.style.background=coverBG(cur);
}
/* 进度条已并入 #rp-progress（点击跳转），旧 #seek 已移除 */

/* ---------- 语音引擎（Web Speech API） ---------- */
const synth=window.speechSynthesis;
let voices=[], playing=false, wantPlay=false, resumeTimer=null, wakeLock=null;
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
  const s=cur.sentences[cur.progress.idx]; if(!s){return;}
  // v3.6 多角色：按说话人选音色（启发式识别）
  const castT=(typeof castVoiceFor==='function')?castVoiceFor(s.t,cur):null;
  const _eng=store.get('tts_engine');
  if(_eng==='custom'||_eng==='elevenlabs'){ speakCustom(s, castT&&castT.kind==='custom'?castT.voiceId:null); return; }
  if(!synth){ toast('当前浏览器不支持语音朗读'); return; }
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
  u.onend=()=>{ if(!wantPlay) return;
    if(cur.progress.idx<cur.total-1){ cur.progress.idx++; markActive(); saveProgress(); speakCurrent(); }
    else { wantPlay=false; setPlayUI(); saveProgress(); toast('本章播完'); }
  };
  u.onerror=e=>{ if(e.error!=='interrupted'&&wantPlay){ setTimeout(()=>{if(wantPlay)speakCurrent();},600); } };
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
function setPlayUI(){ const t=wantPlay?'⏸':'▶'; const b=$('#rp-play'); if(b) b.textContent=t; playing=wantPlay;
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
  wantPlay=true; setPlayUI(); ensureWakeLock(); startAmbience(); speakCurrent(); scrollToActive();
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
$('#rp-speed').onclick=cycleSpeed;
$('#rp-full').onclick=()=>openFullPlayer();
$('#rp-cover').onclick=()=>openFullPlayer();
$('#rp-close').onclick=()=>go(returnView);
$('#rp-progress').addEventListener('click',e=>{
  if(!cur) return;
  const r=e.currentTarget.getBoundingClientRect();
  const p=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
  seekTo(Math.round(p*(cur.total-1)));
});
$('#btn-back').onclick=()=>go(returnView);
$('#reader-chapter').onclick=()=>{ renderChapters(); $('#chapter-drawer').classList.remove('hidden'); };
$('#btn-chapters-close').onclick=()=>$('#chapter-drawer').classList.add('hidden');
$('#dr-ai').onclick=()=>{ $('#chapter-drawer').classList.add('hidden'); $('#aisheet').classList.remove('hidden'); };
$('#dr-type').onclick=()=>{ $('#chapter-drawer').classList.add('hidden'); $('#typeset').classList.remove('hidden'); };
$('#voice-fab').onclick=()=>{ renderVoiceSheet(); $('#voice-sheet').classList.remove('hidden'); $('#scrim').classList.remove('hidden'); };
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
$('#notes-back').onclick = () => go('mine');

/* ---------- 书签 ---------- */
$('#btn-bookmark').onclick = async () => {
  if(!cur){ return; }
  const si = PG.ready ? sentenceOfPage(PG.page) : 0;
  const snippet = (cur.sentences[si]?.t || '').slice(0, 60);
  await idbBookmarks.add({ bookId: cur.id, sentence: si, page: PG.page, snippet, createdAt: Date.now() });
  toast('书签已添加');
};
$('#btn-bookchat').onclick = () => {
  if(!cur){ toast('先打开一本书'); return; }
  renderBookchatSugg();
  go('bookchat');
};

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
$('#mine-notes').onclick = () => go('notes');
$('#mine-bookmarks').onclick = () => go('bookmarks');

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
  const BATCH = 8;
  let done = 0, failed = 0;
  toast('开始整书翻译，共'+total+'句，后台进行中…');
  updateTrProgress();
  for(let i = 0; i < total && trRunning; i += BATCH){
    const batch = [];
    for(let j = i; j < Math.min(i+BATCH, total); j++){
      if(trCache[j]){ done++; continue; }
      const t = cur.sentences[j]?.t || '';
      if(t.length < 2){ done++; continue; }
      batch.push([j, t]);
    }
    if(batch.length){
      try{
        const txt = batch.map(([k,t]) => `[${k}]${t}`).join('\n');
        const r = await geminiAsk(`将以下句子翻译成中文（如果是中文则译成英文）。每行格式保持 [序号]译文，只输出译文行：\n\n${txt.slice(0,3000)}`);
        for(const line of r.split('\n')){
          const m = line.match(/^\[(\d+)\](.*)/);
          if(m){ trCache[+m[1]] = m[2].trim(); done++; }
        }
      }catch(e){ failed += batch.length; }
      // 每批保存一次
      try{ await idbTr.save(cur.id, {...trCache}); }catch(e){}
    }
    trProgress = Math.round(done/total*100);
    updateTrProgress();
    // 礼貌间隔，避免触发限流
    await new Promise(r => setTimeout(r, 800));
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
async function translatePage(){
  if(!cur || !PG.ready) return;
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
    const txt = batch.map(([i,t]) => `[${i}]${t}`).join('\n');
    const r = await geminiAsk(`将以下句子翻译成中文（如果是中文则译成英文）。每行格式保持 [序号]译文，只输出译文行：\n\n${txt.slice(0,3000)}`);
    for(const line of r.split('\n')){
      const m = line.match(/^\[(\d+)\](.*)/);
      if(m) trCache[+m[1]] = m[2].trim();
    }
  }catch(e){ toast('翻译失败：'+e.message); }
  applyTranslations();
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
      if(!/\.(epub|pdf|txt|mobi|azw|fb2)$/i.test(nm)) continue;
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
document.querySelectorAll('#sidebar .sb-item').forEach(b=>{ b.onclick=()=>go(b.dataset.v); });
$('#sb-add').onclick=()=>openImportSheet();
$('#tab-add').onclick=()=>openImportSheet();

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
  $('#stat-time').textContent=fmtDur(today);
  $('#stat-target').textContent=s.target+'分钟';
  $('#stat-streak').textContent=`🔥${s.streak}天`;
  const c=327, off=c*(1-Math.min(1,today/target));
  $('#stat-ring-fg').style.strokeDashoffset=off;
}
$('#stat-goal').onclick=()=>{
  const s=getStat();
  const i=(STAT_GOALS.indexOf(s.target)+1)%STAT_GOALS.length;
  s.target=STAT_GOALS[i]; setStat(s); renderStats();
};
// 播放时每 10 秒累计一次
setInterval(()=>{ if(typeof wantPlay!=='undefined' && wantPlay && !document.hidden) addStatSecs(10); },10000);

/* ================= v3.5：导入弹窗 ================= */
function openSheet(id){ $('#scrim').classList.remove('hidden'); $('#'+id).classList.remove('hidden'); }
function closeSheets(){ $('#scrim').classList.add('hidden');
  ['import-sheet','url-sheet','text-sheet','clone-sheet','cast-sheet','voice-sheet'].forEach(id=>{const el=$('#'+id); if(el) el.classList.add('hidden');});
  if(typeof stopRecord==='function'){ try{stopRecord();}catch(e){} } }
function openImportSheet(){ openSheet('import-sheet'); }
$('#scrim').onclick=closeSheets;
$('#imp-ai').onclick=()=>{ closeSheets(); go('search'); };
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

/* ---------- 搜书：直接 AI 搜书（Anna's Archive） ---------- */
$('#btn-search').onclick=()=>{
const q=$('#search-q').value.trim(); if(!q){toast('输入书名或作者');return;}
doAiSearch(q);
};
/* AI搜索：点搜索直接跳 Anna's Archive（按钮合一），无 Gutenberg */
function doAiSearch(q){
const box=$('#search-results');
const cur=aaBase();
const mirrors=AA_MIRRORS.map(m=>`<button class="btn-ghost sm${m===cur?' btn-primary':''}" data-m="${m}">${m.replace('https://','')}</button>`).join('');
box.innerHTML=`<div class="sr"><div class="t">已在 Anna's Archive 搜索「${esc(q)}」</div>
<div class="a">下载 EPUB/PDF 后，点击文件选择"用 Apo 打开"，自动加入书架。</div>
<div class="ops"><button class="btn-ghost sm" id="aa-import">导入已下载的文件</button><button class="btn-ghost sm" id="aa-auto">开启下载自动上架</button></div>
<div class="sub" style="margin-top:10px">打不开？换个镜像：</div><div class="ops" id="aa-mirrors">${mirrors}</div></div>`;
$('#aa-import').onclick=()=>$('#file-input').click();
const _aaAuto=$('#aa-auto');
if(_aaAuto){ if(!window.showDirectoryPicker) _aaAuto.style.display='none'; else _aaAuto.onclick=()=>enableAutoImport(); }
box.querySelectorAll('#aa-mirrors button').forEach(b=>{ b.onclick=()=>{ aaSet(b.dataset.m); window.open(aaSearchURL(q),'_blank'); doAiSearch(q); }; });
// 点搜索即跳转（按钮合一）
window.open(aaSearchURL(q),'_blank');
}
/* ---------- 排版 ---------- */
function applyType(){
const c=$('#content'); if(!c) return;
const size=store.get('ts_size','18'), lh=store.get('ts_lh','20'),
font=store.get('ts_font','serif'), theme=store.get('ts_theme','day');
c.style.fontSize=size+'px'; c.style.lineHeight=(lh/10);
c.style.fontFamily=font==='serif'?'Georgia,"Songti SC","Noto Serif CJK SC",serif':'-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
c.dataset.theme=theme;
$('#ts-size').value=size; $('#ts-size-v').textContent=size;
$('#ts-lh').value=lh; $('#ts-lh-v').textContent=(lh/10).toFixed(1);
$('#ts-font').value=font; $('#ts-theme').value=theme;
const tf=$('#ts-flip'); if(tf) tf.value=store.get('ts_flip','slide');
}
/* 排版按钮已并入目录抽屉（#dr-type） */
$('#btn-type-close').onclick=()=>$('#typeset').classList.add('hidden');
$('#ts-size').addEventListener('input',e=>{store.set('ts_size',e.target.value);applyType();scheduleRepaginate();});
$('#ts-lh').addEventListener('input',e=>{store.set('ts_lh',e.target.value);applyType();scheduleRepaginate();});
$('#ts-font').addEventListener('change',e=>{store.set('ts_font',e.target.value);applyType();scheduleRepaginate();});
$('#ts-theme').addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();scheduleRepaginate();});
$('#ts-flip').addEventListener('change',e=>{store.set('ts_flip',e.target.value);applyFlipMode();toast(e.target.selectedOptions[0].text+'已生效');});
$('#ts-theme2').addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();scheduleRepaginate();});

/* ---------- 设置持久化 ---------- */
function initSettings(){
const bind=(id,k)=>{ const el=$(id); el.value=store.get(k,el.value);
el.addEventListener('change',()=>store.set(k,el.value));};
bind('#sel-engine','tts_engine'); bind('#tts-endpoint','tts_ep'); bind('#tts-key','tts_key');
bind('#tts-voice','tts_voice'); bind('#gemini-key','gemini_key'); bind('#gemini-model','gemini_model');
bind('#sel-clone-provider','clone_provider'); bind('#clone-key','clone_key');
bind('#eleven-key','eleven_key');
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
function greetWord(){
  const h=new Date().getHours();
  if(h<6) return '夜深了，';
  if(h<12) return '早上好，';
  if(h<14) return '中午好，';
  if(h<18) return '下午好，';
  return '晚上好，';
}
/* ================= v3.5：Readify 式首页 ================= */
const CLASSICS=[
  {title:'红楼梦', q:'红楼梦 曹雪芹', c:['#5a2e28','#8a4a3a']},
  {title:'三国演义', q:'三国演义 罗贯中', c:['#2e3a5a','#4a5a8a']},
  {title:'论语', q:'论语 孔子', c:['#3a3a2e','#6a6a4a']},
  {title:'道德经', q:'道德经 老子', c:['#2e4a3e','#4a7a5e']},
  {title:'唐诗三百首', q:'唐诗三百首', c:['#4a2e4a','#7a4a7a']},
  {title:'孙子兵法', q:'孙子兵法', c:['#5a4a2e','#8a7a4a']},
];
function rdCardHTML(b){
  const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
  const done=b.progress.idx>=b.total-1&&b.total>1;
  return `<div class="cov"><div class="ct" style="background:${coverBG(b)}">${esc((b.title||'?').slice(0,10))}</div>
    ${pct?`<span class="pbdg${done?' done':''}">${done?'✓':pct+'%'}</span>`:''}</div>
    <div class="nm">${esc(b.title)}</div>`;
}
async function renderHome(){
  if(!books.length){ try{ await loadBooks(); }catch(e){} }
  const has=books.length>0;
  $('#home-empty').classList.toggle('hidden', has);
  // 继续阅读：有进度的书横向排
  const cont=books.filter(b=>b.progress.idx>0 && b.progress.idx<b.total-1)
    .sort((a,b)=>b.progress.updatedAt-a.progress.updatedAt).slice(0,8);
  $('#continue-wrap').classList.toggle('hidden', !cont.length);
  const cl=$('#cont-list'); cl.innerHTML='';
  cont.forEach(b=>{
    const d=document.createElement('div'); d.className='rd-bcard';
    d.innerHTML=rdCardHTML(b);
    d.onclick=()=>{ returnView='home'; openDetail(b.id); };
    cl.appendChild(d);
  });
  // 经典必读
  const cll=$('#classic-list'); cll.innerHTML='';
  CLASSICS.forEach(c=>{
    const d=document.createElement('div'); d.className='rd-bcard'; d.dataset.q=c.q;
    d.innerHTML=`<div class="cov"><div class="ct" style="background:linear-gradient(150deg,${c.c[0]},${c.c[1]})">${esc(c.title)}</div></div><div class="nm">${esc(c.title)}</div>`;
    d.onclick=()=>{ go('search'); $('#search-q').value=c.q; $('#btn-search').click(); };
    cll.appendChild(d);
  });
  renderStats();
  updateMiniPlayer();
}
$('#home-search').onclick=()=>{ go('search'); setTimeout(()=>$('#search-q').focus(),80); };
$('#btn-mine').onclick=()=>go('mine');
$('#btn-voice').onclick=()=>go('voice');
$('#mine-back').onclick=()=>go('home');
$('#banner-btn').onclick=()=>{ go('library'); setTimeout(()=>openImportSheet(),300); };
/* 横幅轮播 */
let bannerIdx=0;
function bannerGo(i){
  const n=$('#banner-slides').children.length;
  bannerIdx=(i+n)%n;
  $('#banner-slides').style.transform=`translateX(-${bannerIdx*100}%)`;
  $('#banner-dots').querySelectorAll('i').forEach((d,k)=>d.classList.toggle('on',k===bannerIdx));
}
setInterval(()=>{ if(curView==='home') bannerGo(bannerIdx+1); },5000);
$('#banner').onclick=()=>{
  if(bannerIdx===1){ toast('打开一本书后，点播放条上的 ✦ 使用 AI 助手'); }
  else openImportSheet();
};

/* ---------- 书籍详情 ---------- */
let detailId=null;
function openDetail(id){ detailId=id; renderDetail(); go('detail'); }
function renderDetail(){
  const b=books.find(x=>x.id===detailId); if(!b){ go('library'); return; }
  $('#dt-cover').style.background=coverBG(b);
  $('#dt-cover').textContent=b.title.slice(0,12);
  $('#dt-title').textContent=b.title;
  const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
  $('#dt-sub').textContent=`${b.format?b.format.toUpperCase()+' · ':''}${b.total} 句${pct?` · 已读 ${pct}%`:''}`;
  $('#dt-tags').innerHTML=[b.format?b.format.toUpperCase():null, b.lang==='zh'?'中文':'英文', b.hasFile?'原文件已保存':null]
    .filter(Boolean).map(t=>`<span>${esc(t)}</span>`).join('');
  $('#dt-desc').textContent=(b.sentences.slice(0,2).map(s=>s.t).join('')).slice(0,160)+'…';
  $('#dt-toc-count').textContent=`共 ${b.chapters.length} 章`;
  const toc=$('#dt-toc'); toc.innerHTML='';
  b.chapters.forEach((c,i)=>{
    const next=b.chapters[i+1];
    const n=(next?next.start:b.total)-c.start;
    const d=document.createElement('div'); d.className='toc-item';
    d.innerHTML=`<span class="n">${i+1}</span><span class="t">${esc(c.title)}</span><span class="c">${n}句</span><span class="go">›</span>`;
    d.onclick=async()=>{ returnView='detail'; await openBook(b.id); seekTo(c.start); };
    toc.appendChild(d);
  });
}
$('#dt-back').onclick=()=>go('library');
$('#btn-read-now').onclick=async()=>{ returnView='detail'; await openBook(detailId); };
$('#btn-listen-now').onclick=async()=>{ returnView='detail'; await openBook(detailId); play(); };
$('#btn-cast').onclick=()=>{ const b=books.find(x=>x.id===detailId); if(b) openCastSheet(b.id); };

/* ---------- 迷你播放器 ---------- */
function updateMiniPlayer(){
  const mp=$('#mini-player'); if(!mp) return;
  const fullOpen=!$('#player-full').classList.contains('hidden');
  const show=!!(cur && curView!=='reader' && curView!=='splash' && !fullOpen);
  mp.classList.toggle('hidden', !show);
  if(!show) return;
  $('#mp-cover').style.background=coverBG(cur);
  $('#mp-cover').textContent=(cur.title||'?').slice(0,6);
  $('#mp-title').textContent=cur.title;
  $('#mp-pos').textContent=Math.round(100*cur.progress.idx/Math.max(1,cur.total))+'%';
  $('#mp-play').textContent=wantPlay?'⏸':'▶';
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
  $('#fp-cover').style.background=coverBG(cur);
  $('#fp-cover').textContent=(cur.title||'?').slice(0,12);
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
  const pct=Math.round(1000*cur.progress.idx/Math.max(1,cur.total));
  $('#fp-seek').value=pct;
  $('#fp-play').textContent=wantPlay?'⏸':'▶';
  $('#fp-cur').textContent=`第 ${cur.progress.idx+1} 句`;
  $('#fp-total').textContent=`共 ${cur.total} 句`;
  $('#fp-speed').classList.toggle('on', (cur.rate/100)!==1);
  $('#fp-speed').querySelector('span').textContent=fmtRate(cur.rate/100);
  const t=$('#fp-timer');
  t.classList.toggle('on', sleepMin>0);
  t.querySelector('span').textContent=sleepMin>0?`定时${sleepMin}′`:'定时';
}
function openFullPlayer(){ if(!cur){toast('先选一本书');return;} renderFullPlayer(); $('#player-full').classList.remove('hidden'); updateMiniPlayer(); }
$('#fp-close').onclick=()=>{ $('#player-full').classList.add('hidden'); updateMiniPlayer(); };
$('#fp-play').onclick=()=>{ if(!cur)return; wantPlay?stopSpeak():play(); syncFullPlayer(); };
$('#fp-seek').addEventListener('change',e=>{ if(!cur)return; seekTo(Math.round(e.target.value/1000*(cur.total-1))); });
$('#fp-wave').onclick=e=>{ if(!cur)return; const r=e.currentTarget.getBoundingClientRect();
  seekTo(Math.round((e.clientX-r.left)/r.width*(cur.total-1))); };
$('#fp-back15').onclick=()=>skipSeconds(-15);
$('#fp-fwd15').onclick=()=>skipSeconds(15);
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
$('#fp-chapters').onclick=()=>{ $('#player-full').classList.add('hidden'); if(cur){ returnView=curView==='detail'?'detail':'library'; go('reader'); } };

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
