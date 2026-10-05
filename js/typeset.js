/* AI 排版：本地智能排版（确定性规则） + Gemini AI 校对
 * 入口：书籍详情页「AI 排版」按钮。处理前自动备份原文，可一键还原。
 * 依赖：app.js 的 store / toast / idb / splitSentences / openBook / books / cur，
 *       ai.js 的 geminiAsk。加载顺序：app.js 之后。
 */
'use strict';

/* ================= 本地智能排版 =================
 * 专业中文排版规则：
 * 1. 合并因 PDF/复制粘贴导致的断行（上一行非终止标点结尾则合并）
 * 2. 压缩多余空行
 * 3. CJK 语境下半角标点→全角（， 。 ！ ？ ： ； （ ））
 * 4. 去除 CJK 字符之间的空格
 * 5. 直引号→弯引号（按段落配对）
 * 6. 盘古空格：CJK 与字母数字之间加空格
 * 7. 去除重复标点、修正标点连用
 */
function typesetLocal(text){
  if(!text) return text;
  const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';
  const R = p => new RegExp(p, 'g');

  // ---- 1. 分段 & 合并断行 ----
  let t = String(text).replace(/\r\n?/g, '\n');
  const END_RE = /[。！？…」』”]$/; // 段落终止标点
  const paras = [];
  let buf = '';
  for(const raw of t.split('\n')){
    const ln = raw.replace(/[\t\u00a0\u3000]+/g, ' ').trim();
    if(!ln){ if(buf){ paras.push(buf); buf=''; } continue; }
    if(!buf) buf = ln;
    else if(END_RE.test(buf)) { paras.push(buf); buf = ln; }
    else buf += ln; // 上一段没说完：合并断行
  }
  if(buf) paras.push(buf);

  // ---- 2. 逐段清洗 ----
  const cleaned = paras.map(p=>{
    let s = p.trim();
    // CJK 间空格去除
    s = s.replace(R(`([${CJK}])[ \\t]+([${CJK}])`), '$1$2');
    // 标点规范化：用函数精确判断，避免误伤数字/英文
    const isDigit = c => c>='0' && c<='9';
    const isAZ = c => /[a-zA-Z]/.test(c||'');
    s = s.replace(/,/g, (m,off,str)=>{ // 逗号：数字间/英文内保留，否则全角
      const prev=str[off-1], next=str[off+1];
      if(isDigit(prev)&&isDigit(next)) return ',';
      if(isAZ(prev)&&(isAZ(next)||next===' ')) return ',';
      return '，';
    });
    s = s.replace(/\./g, (m,off,str)=>{ // 句点：小数/英文/省略号保留，否则句号
      const prev=str[off-1], next=str[off+1];
      if(isDigit(prev)&&isDigit(next)) return '.';
      if(isAZ(prev)||isAZ(next)) return '.';
      if(prev==='.'||next==='.') return '.';
      return '。';
    });
    s = s.replace(/\.{3,}/g, '…'); // 省略号
    s = s.replace(/!/g, (m,off,str)=> isAZ(str[off-1])?'!':'！')
         .replace(/\?/g, (m,off,str)=> isAZ(str[off-1])?'?':'？');
    s = s.replace(R(`([${CJK}]):`), '$1：').replace(R(`([${CJK}]);`), '$1；');
    s = s.replace(/\(/g, (m,off,str)=> isAZ(str[off-1])||isDigit(str[off-1]) ? '(' : '（');
    s = s.replace(/\)/g, (m,off,str)=> isAZ(str[off+1])||isDigit(str[off+1]) ? ')' : '）');
    // 直引号→弯引号（段内交替配对）
    let qi = 0;
    s = s.replace(/"/g, () => (qi++ % 2 === 0 ? '“' : '”'));
    // 重复标点去重
    s = s.replace(R(`([，。！？；：、])\\1+`), '$1');
    // 标点连用修正：，。→。 ，！→！
    s = s.replace(/，([。！？；])/g, '$1');
    // 盘古空格：CJK 与字母数字之间
    s = s.replace(R(`([${CJK}])([a-zA-Z0-9])`), '$1 $2')
         .replace(R(`([a-zA-Z0-9])([${CJK}])`), '$1 $2');
    // 多余空格压缩（保留盘古空格的单个空格）
    s = s.replace(/ {2,}/g, ' ');
    return s;
  });

  return cleaned.join('\n');
}

/* ================= AI 校对（Gemini） ================= */
const AI_PROOF_PROMPT = t =>
`你是资深中文出版校对编辑。请校对以下文本：
- 修正错别字、标点误用（统一为全角中文标点）、语病
- 只做最小必要修改，不改变原意、文风
- 不合并、不拆分段落，保持段落数量与顺序不变
- 直接输出校对后的文本，不要任何解释、前言、标记或代码块

文本：
${t}`;

function splitForAI(text, maxLen){
  maxLen = maxLen || 6000;
  if(text.length <= maxLen) return [text];
  // 按段落切分，尽量不切断段落
  const paras = text.split('\n'), chunks = [];
  let cur = '';
  for(const p of paras){
    if((cur + '\n' + p).length > maxLen && cur){
      chunks.push(cur); cur = p;
    }else cur = cur ? cur + '\n' + p : p;
  }
  if(cur) chunks.push(cur);
  return chunks;
}

let tsCancelled = false;

async function aiProofread(text, onProgress){
  const key = store.get('gemini_key');
  if(!key) throw new Error('NO_KEY');
  const chunks = splitForAI(text);
  const out = [];
  for(let i=0; i<chunks.length; i++){
    if(tsCancelled) throw new Error('CANCELLED');
    if(onProgress) onProgress(i+1, chunks.length);
    const res = await geminiAsk(AI_PROOF_PROMPT(chunks[i]));
    out.push(res.trim());
    if(i < chunks.length-1) await new Promise(r=>setTimeout(r, 600)); // 限流缓冲
  }
  return out.join('\n');
}

/* ================= 主流程 ================= */
function bookChapterTexts(book){
  return book.chapters.map((ch, i)=>{
    const end = book.chapters[i+1] ? book.chapters[i+1].start : book.sentences.length;
    return {
      title: ch.title,
      text: book.sentences.slice(ch.start, end).map(s=>s.t).join('\n')
    };
  });
}

async function backupBook(book){
  try{
    await idb.putFile('tsbak_'+book.id, {
      sentences: book.sentences,
      chapters: book.chapters,
      total: book.total,
      at: Date.now()
    }, '排版备份');
    return true;
  }catch(e){ return false; }
}

async function hasBackup(bookId){
  try{
    const f = await idb.getFile('tsbak_'+bookId);
    return !!(f && f.data && f.data.sentences);
  }catch(e){ return false; }
}

async function restoreBackup(bookId){
  const book = books.find(b=>b.id===bookId); if(!book) return false;
  const f = await idb.getFile('tsbak_'+bookId).catch(()=>null);
  if(!f || !f.data || !f.data.sentences){ toast('没有可还原的备份'); return false; }
  book.sentences = f.data.sentences;
  book.chapters = f.data.chapters;
  book.total = f.data.total;
  book.progress.idx = 0;
  delete book.typesetAt;
  await idb.put(stripBook(book));
  await idb.delPageCacheByBook(bookId).catch(()=>{});
  await idb.putProgress(bookId, 0).catch(()=>{});
  if(cur && cur.id===bookId) await openBook(bookId);
  if(typeof renderDetail==='function' && typeof detailId!=='undefined' && detailId===bookId) renderDetail();
  toast('已还原排版前的原文');
  return true;
}

async function runTypeset(bookId, opts, ui){
  // ui: {onStep(msg), onProgress(done,total), isCancelled()}
  const book = books.find(b=>b.id===bookId);
  if(!book){ toast('找不到这本书'); return; }
  tsCancelled = false;

  ui.onStep('正在备份原文…');
  await backupBook(book);

  const chapters = bookChapterTexts(book);
  const totalSteps = chapters.length;
  let done = 0;

  // 本地智能排版
  if(opts.local){
    ui.onStep('本地智能排版中…');
    for(const c of chapters){
      if(tsCancelled) throw new Error('CANCELLED');
      c.text = typesetLocal(c.text);
      done++;
      ui.onProgress(done, totalSteps, '智能排版');
    }
  }

  // AI 校对
  if(opts.ai){
    const key = store.get('gemini_key');
    if(!key) throw new Error('NO_KEY');
    done = 0;
    for(let i=0; i<chapters.length; i++){
      if(tsCancelled) throw new Error('CANCELLED');
      ui.onStep(`AI 校对：第 ${i+1}/${chapters.length} 章…`);
      const chunks = splitForAI(chapters[i].text);
      const out = [];
      for(let j=0; j<chunks.length; j++){
        if(tsCancelled) throw new Error('CANCELLED');
        out.push((await geminiAsk(AI_PROOF_PROMPT(chunks[j]))).trim());
        if(j < chunks.length-1) await new Promise(r=>setTimeout(r, 600));
      }
      chapters[i].text = out.join('\n');
      done++;
      ui.onProgress(done, totalSteps, 'AI 校对');
    }
  }

  // 重建句子与章节
  ui.onStep('正在重建排版…');
  const newSentences = [], newChapters = [];
  chapters.forEach((c, ci)=>{
    newChapters.push({title: c.title, start: newSentences.length});
    for(const s of splitSentences(c.text)) newSentences.push({t:s, c:ci});
  });
  if(!newSentences.length) throw new Error('排版后正文为空，已中止（原文已备份）');

  book.sentences = newSentences;
  book.chapters = newChapters;
  book.total = newSentences.length;
  book.progress.idx = 0;
  book.typesetAt = Date.now();
  try{ book.lang = detectLang(newSentences.slice(0,30).map(s=>s.t).join(' ')); }catch(e){}

  await idb.put(stripBook(book));
  await idb.delPageCacheByBook(bookId).catch(()=>{});
  await idb.putProgress(bookId, 0).catch(()=>{});
  if(cur && cur.id===bookId) await openBook(bookId);
  if(typeof renderDetail==='function' && typeof detailId!=='undefined' && detailId===bookId) renderDetail();
  toast(`排版完成，共 ${newSentences.length} 句`);
}

/* ================= UI ================= */
let tsBookId = null;

function openTypesetSheet(bookId){
  tsBookId = bookId;
  const hasKey = !!store.get('gemini_key');
  $('#ts-opt-local').checked = true;
  $('#ts-opt-ai').checked = hasKey;
  $('#ts-ai-hint').textContent = hasKey
    ? '将调用 Gemini 逐章校对错别字与语病'
    : '未填写 Gemini Key（去 设置 → AI 里填写后可用）';
  $('#ts-ai-hint').style.color = hasKey ? '' : '#c00';
  $('#ts-progress').classList.add('hidden');
  $('#ts-actions').classList.remove('hidden');
  $('#ts-cancel').classList.add('hidden');
  refreshTsRestore();
  openSheet('typeset-sheet');
}

async function refreshTsRestore(){
  const btn = $('#ts-restore');
  if(!btn || !tsBookId) return;
  const has = await hasBackup(tsBookId);
  btn.style.display = has ? '' : 'none';
}

function tsUI(){
  return {
    onStep(msg){ $('#ts-step').textContent = msg; },
    onProgress(done, total, label){
      const bar = $('#ts-progress');
      bar.classList.remove('hidden');
      $('#ts-bar-fill').style.width = Math.round(100*done/Math.max(1,total)) + '%';
      $('#ts-step').textContent = `${label} ${done}/${total}…`;
    }
  };
}

async function startTypeset(){
  const bookId = tsBookId;
  const opts = {
    local: $('#ts-opt-local').checked,
    ai: $('#ts-opt-ai').checked
  };
  if(!opts.local && !opts.ai){ toast('至少选一项'); return; }
  if(opts.ai && !store.get('gemini_key')){ toast('请先在 设置 → AI 里填写 Gemini Key'); return; }

  $('#ts-actions').classList.add('hidden');
  $('#ts-cancel').classList.remove('hidden');
  $('#ts-progress').classList.remove('hidden');
  const ui = tsUI();

  try{
    await runTypeset(bookId, opts, ui);
  }catch(e){
    if(e.message==='CANCELLED') toast('已取消');
    else if(e.message==='NO_KEY') toast('请先在 设置 → AI 里填写 Gemini Key');
    else toast('排版失败：' + e.message);
  }
  $('#ts-cancel').classList.add('hidden');
  $('#ts-actions').classList.remove('hidden');
  refreshTsRestore();
}

// 事件绑定（typeset.js 在 app.js 之后加载，直接绑定）
(function initTypeset(){
  const bind = ()=>{
    if($('#btn-typeset')) $('#btn-typeset').onclick = ()=>{ if(detailId) openTypesetSheet(detailId); };
    if($('#ts-do')) $('#ts-do').onclick = startTypeset;
    if($('#ts-cancel')) $('#ts-cancel').onclick = ()=>{ tsCancelled = true; };
    if($('#ts-restore')) $('#ts-restore').onclick = async ()=>{
      if(tsBookId && confirm('确定还原到排版前的原文吗？')){ await restoreBackup(tsBookId); refreshTsRestore(); }
    };
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
