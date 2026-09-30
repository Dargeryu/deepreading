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
const DB='deepreading', VS=3;
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
    };
    r.onsuccess=()=>{db=r.result;res();}; r.onerror=()=>rej(r.error);
  });
}
const _tx=(s,m='readonly')=>db.transaction(s,m).objectStore(s);
const idb={
  put:b=>new Promise((res,rej)=>{const t=_tx('books','readwrite').put(b);t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  all:()=>new Promise((res,rej)=>{const t=_tx('books').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  putFile:(id,data,name)=>new Promise((res,rej)=>{const t=_tx('files','readwrite').put({id,data,name});t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  getFile:id=>new Promise((res,rej)=>{const t=_tx('files').get(id);t.onsuccess=()=>res(t.result||null);t.onerror=()=>rej(t.error);}),
  putProgress:(id,idx)=>new Promise((res,rej)=>{const t=_tx('progress','readwrite').put({bookId:id,idx,updatedAt:Date.now()});t.onsuccess=res;t.onerror=()=>rej(t.error);}),
  allProgress:()=>new Promise((res,rej)=>{const t=_tx('progress').getAll();t.onsuccess=()=>res(t.result||[]);t.onerror=()=>rej(t.error);}),
  del:id=>Promise.all(['books','files','progress'].map(s=>new Promise((res,rej)=>{
    const t=db.transaction(s,'readwrite').objectStore(s).delete(id);
    t.onsuccess=()=>res();t.onerror=()=>rej(t.error);}))),
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
let shelfSort='recent'; // recent | title
async function renderShelf(){
  await loadBooks();
  const list=[...books];
  if(shelfSort==='title') list.sort((a,b)=>String(a.title).localeCompare(String(b.title),'zh'));
  $('#lib-count').textContent = books.length?`共 ${books.length} 本`:'我的书架';
  const shelf=$('#shelf'); shelf.innerHTML='';
  $('#shelf-empty').classList.toggle('hidden', books.length>0);
  list.forEach((b)=>{
    const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
    const el=document.createElement('div'); el.className='book-row';
    el.innerHTML=`<div class="cov-wrap">${coverHTML(b,'sm')}${pct?`<span class="pct-badge">${pct}%</span>`:''}</div>
      <div class="info"><div class="title">${esc(b.title)}</div>
      <div class="meta">${b.total}句 · 已读${pct}%</div>
      <span class="fmt">${esc((b.format||'').toUpperCase())}</span></div>
      <div class="ops">${b.hasFile?`<button class="dl icon-btn" title="下载原文件" style="font-size:18px">⏬</button>`:''}<button class="del icon-btn" title="删除" style="font-size:18px">🗑</button></div>`;
    el.onclick=e=>{ if(e.target.closest('.del,.dl'))return; openDetail(b.id); };
    el.querySelector('.del').onclick=async e=>{ e.stopPropagation();
      if(confirm(`删除《${b.title}》？`)){ await idb.del(b.id); if(cur&&cur.id===b.id){cur=null;stopSpeak();} renderShelf(); } };
    const dl=el.querySelector('.dl');
    if(dl) dl.onclick=e=>{ e.stopPropagation(); downloadBook(b); };
    shelf.appendChild(el);
  });
  updateMiniPlayer();
}
$('#btn-lib-search').onclick=()=>go('search');
$('#btn-lib-sort').onclick=()=>{ shelfSort=shelfSort==='recent'?'title':'recent';
  toast(shelfSort==='recent'?'按最近阅读排序':'按书名排序'); renderShelf(); };
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
const VIEWS=['splash','home','library','search','detail','reader','mine','voice'];
let curView='home', returnView='library';
function go(name){
  curView=name;
  VIEWS.forEach(v=>{ const el=$('#view-'+v); if(el) el.classList.toggle('hidden', v!==name); });
  document.body.classList.toggle('in-reader', name==='reader');
  document.body.classList.toggle('in-splash', name==='splash');
  document.querySelectorAll('#tabbar .tab').forEach(t=>t.classList.toggle('cur', t.dataset.v===name));
  if(name==='library'){ stopSpeak(); renderShelf(); }
  else if(name==='home'){ stopSpeak(); renderHome(); }
  else if(name==='voice'){ stopSpeak(); renderVoice(); }
  else if(name==='search'||name==='mine'){ stopSpeak(); }
  updateMiniPlayer();
  window.scrollTo(0,0);
}
function showView(name){ go(name); } // 兼容旧调用
async function openBook(id){
  cur=books.find(b=>b.id===id); if(!cur) return;
  $('#reader-title').textContent=cur.title;
  const c=$('#content'); c.innerHTML=''; sentEls=[];
  let ci=-1;
  cur.sentences.forEach((s,i)=>{
    if(s.c!==ci){ ci=s.c;
      const h=document.createElement('span'); h.className='ch-title';
      h.textContent=cur.chapters[ci]?cur.chapters[ci].title:`第${ci+1}章`; c.appendChild(h);
    }
    const sp=document.createElement('span'); sp.className='sent'; sp.textContent=s.t; sp.dataset.i=i;
    sp.onclick=()=>{ seekTo(i); };
    c.appendChild(sp); c.appendChild(document.createTextNode(' ')); sentEls.push(sp);
  });
  renderChapters(); go('reader'); updatePlayer(); scrollToActive(false);
  applyBookVoice(); updateMiniPlayer();
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
  const el=sentEls[cur.progress.idx];
  if(el) el.scrollIntoView({block:'center', behavior:smooth?'smooth':'auto'});
}
function markActive(){
  sentEls.forEach((el,i)=>el.classList.toggle('active', i===cur.progress.idx));
  updatePlayer();
}
async function saveProgress(){
  if(!cur) return;
  cur.progress.updatedAt=Date.now();
  try{ await idb.putProgress(cur.id, cur.progress.idx); }catch(e){}
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
function updatePlayer(){
  if(!cur) return;
  const pct=Math.round(100*cur.progress.idx/Math.max(1,cur.total));
  $('#player-pos').textContent=pct+'%';
  $('#seek').value=Math.round(1000*cur.progress.idx/Math.max(1,cur.total));
  const ch=cur.chapters[chapterOf(cur.progress.idx)];
  $('#player-chapter').textContent=ch?ch.title:'';
}
$('#seek').addEventListener('change',e=>{
  if(!cur) return;
  seekTo(Math.round(e.target.value/1000*(cur.total-1)));
});

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
function setPlayUI(){ $('#btn-play').textContent=wantPlay?'⏸':'▶'; playing=wantPlay;
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
$('#btn-play').onclick=()=>{ if(!cur)return; wantPlay?stopSpeak():(scrollToActive(),play()); };
$('#btn-prev').onclick=()=>{ if(cur) seekTo(cur.progress.idx-1); };
$('#btn-next').onclick=()=>{ if(cur) seekTo(cur.progress.idx+1); };
$('#btn-back').onclick=()=>go(returnView);
$('#btn-chapters').onclick=()=>{ renderChapters(); $('#chapter-drawer').classList.remove('hidden'); };
$('#btn-chapters-close').onclick=()=>$('#chapter-drawer').classList.add('hidden');
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
document.addEventListener('visibilitychange',()=>{ if(document.hidden) releaseWakeLock(); else if(wantPlay) ensureWakeLock(); });

/* ---------- 启动 ---------- */
(async()=>{
  if(!('speechSynthesis' in window)) toast('当前浏览器不支持语音朗读，换 Chrome / Edge / Safari 试试',4000);
  await openDB().catch(()=>toast('本地数据库不可用'));
  await migrateV1();
  try{ await loadBooks(); }catch(e){}
  if(store.get('splash_done')) go('home'); else go('splash');
})();

/* ================= v2：搜书 / 排版 / 背景音 / AI 助手 ================= */

/* ---------- 底部导航 ---------- */
document.querySelectorAll('#tabbar .tab').forEach(t=>{ t.onclick=()=>go(t.dataset.v); });
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
  ['import-sheet','url-sheet','text-sheet','clone-sheet','cast-sheet'].forEach(id=>{const el=$('#'+id); if(el) el.classList.add('hidden');});
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

/* ---------- 正版搜书 ---------- */
$('#btn-search').onclick=async()=>{
const q=$('#search-q').value.trim(); if(!q){toast('输入书名或作者');return;}
const src=$('#search-src').value, box=$('#search-results');
box.innerHTML='<p class="sub">搜索中…</p>';
try{
const rs = src==='ol'? await searchOL(q): await searchGB(q);
box.innerHTML='';
if(!rs.length) box.innerHTML='<p class="sub">没有找到，换个关键词试试</p>';
rs.forEach(r=>{
const d=document.createElement('div'); d.className='sr';
d.innerHTML=`<div class="t">${esc(r.title)}</div><div class="a">${esc(r.author)}${r.year?' · '+esc(r.year):''}</div><div class="ops"></div>`;
const ops=d.querySelector('.ops');
if(r.url){ const a=document.createElement('button'); a.className='btn-ghost'; a.textContent='去借阅/查看';
a.onclick=()=>window.open(r.url,'_blank'); ops.appendChild(a);}
if(r.dl){ const b=document.createElement('button'); b.className='btn-ghost'; b.textContent='下载 EPUB';
b.onclick=()=>window.open(r.dl,'_blank'); ops.appendChild(b);}
if(!r.url&&!r.dl) ops.innerHTML='<span class="sub">暂无可用链接</span>';
box.appendChild(d);
});
}catch(e){ box.innerHTML='<p class="sub">搜索失败：'+esc(e.message)+'</p>';}
};

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
}
$('#btn-type').onclick=()=>$('#typeset').classList.remove('hidden');
$('#btn-type-close').onclick=()=>$('#typeset').classList.add('hidden');
$('#ts-size').addEventListener('input',e=>{store.set('ts_size',e.target.value);applyType();});
$('#ts-lh').addEventListener('input',e=>{store.set('ts_lh',e.target.value);applyType();});
$('#ts-font').addEventListener('change',e=>{store.set('ts_font',e.target.value);applyType();});
$('#ts-theme').addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();});
$('#ts-theme2').addEventListener('change',e=>{store.set('ts_theme',e.target.value);applyType();});

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
$('#btn-ai').onclick=()=>$('#aisheet').classList.remove('hidden');
$('#btn-ai-close').onclick=()=>{ $('#aisheet').classList.add('hidden'); stopStory();};
const getSelText=()=>{ const s=window.getSelection(); return s?s.toString().trim():'';};
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

/* ================= v3：DeepRead 风格 UI ================= */

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
function spineHTML(cl){
  return `<div class="classic-item" data-q="${esc(cl.q)}">
    <div class="spine" style="background:linear-gradient(150deg,${cl.c[0]},${cl.c[1]})"><span>${esc(cl.title)}</span></div>
    <div class="t">${esc(cl.title)}</div></div>`;
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
    const pct=Math.round(100*b.progress.idx/Math.max(1,b.total));
    const d=document.createElement('div'); d.className='cont-item';
    d.innerHTML=`<div class="cov-wrap">${coverHTML(b,'sm')}<span class="pct-badge">${pct}%</span></div>
      <div class="t">${esc(b.title)}</div><div class="d">已读 ${pct}%</div>`;
    d.onclick=()=>{ returnView='home'; openDetail(b.id); };
    cl.appendChild(d);
  });
  // 经典必读
  const cll=$('#classic-list'); cll.innerHTML='';
  CLASSICS.forEach(c=>{ cll.insertAdjacentHTML('beforeend', spineHTML(c)); });
  cll.querySelectorAll('.classic-item').forEach(el=>{
    el.onclick=()=>{ go('search'); $('#search-q').value=el.dataset.q; $('#btn-search').click(); };
  });
  renderStats();
  updateMiniPlayer();
}
$('#home-search').onclick=()=>{ go('search'); setTimeout(()=>$('#search-q').focus(),80); };
$('#btn-mine').onclick=()=>go('mine');
$('#mine-back').onclick=()=>go('home');
$('#classic-more').onclick=()=>go('search');
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
function syncFullPlayer(){
  if(!cur||$('#player-full').classList.contains('hidden')) return;
  const pct=Math.round(1000*cur.progress.idx/Math.max(1,cur.total));
  $('#fp-seek').value=pct;
  $('#fp-play').textContent=wantPlay?'⏸':'▶';
  $('#fp-cur').textContent=`第 ${cur.progress.idx+1} 句`;
  $('#fp-total').textContent=`共 ${cur.total} 句`;
  $('#fp-speed').classList.toggle('on', (cur.rate/100)!==1);
  $('#fp-speed').querySelector('span').textContent=(cur.rate/100).toFixed(2).replace(/0+$/,'').replace(/\.$/,'')+'x';
  const t=$('#fp-timer');
  t.classList.toggle('on', sleepMin>0);
  t.querySelector('span').textContent=sleepMin>0?`定时${sleepMin}′`:'定时';
}
function openFullPlayer(){ if(!cur){toast('先选一本书');return;} renderFullPlayer(); $('#player-full').classList.remove('hidden'); updateMiniPlayer(); }
$('#fp-close').onclick=()=>{ $('#player-full').classList.add('hidden'); updateMiniPlayer(); };
$('#fp-play').onclick=()=>{ if(!cur)return; wantPlay?stopSpeak():play(); syncFullPlayer(); };
$('#fp-seek').addEventListener('change',e=>{ if(!cur)return; seekTo(Math.round(e.target.value/1000*(cur.total-1))); });
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
$('#fp-speed').onclick=()=>{
  if(!cur) return;
  const now=cur.rate/100;
  let ni=SPEEDS.findIndex(s=>s>now+0.01); if(ni<0) ni=0;
  cur.rate=Math.round(SPEEDS[ni]*100);
  $('#rng-rate').value=cur.rate; $('#rate-val').textContent=SPEEDS[ni].toFixed(2).replace(/0+$/,'').replace(/\.$/,'')+'x';
  saveBook(); if(wantPlay) speakCurrent(); syncFullPlayer();
};
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
$('#btn-search-mic').onclick=e=>voiceInput($('#search-q'), e.currentTarget);
