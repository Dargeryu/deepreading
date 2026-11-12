/* Apo 独立分页 v3.21
 * 每本书拥有独立的页码体系：第 X 页 / 共 Y 页。
 * 原理：用一个与真实页面盒模型完全一致的离屏测量器，把全书句子按列
 * （一列即一页）流式排一遍，记录每页起始句下标；结果按 (bookId,排版指纹)
 * 缓存进 IndexedDB，下次打开直接命中。
 * 与朗读/进度互不干扰：分页只影响"页"的概念，句子仍是最小单位。
 */
const PG = {
  bookId: null,   // 当前分页所属的书
  hash: '',       // 排版指纹（字号/行高/字体/页宽/页高）
  starts: [],     // starts[p] = 第 p 页第一个句子的全局下标
  total: 1,       // 全书总页数
  page: 0,        // 当前页（0-based，全书全局）
  ready: false,   // 分页结果是否可用
};

/* 影响分页的所有因素 */
function pageHash(){
  const el = $('#reader-pages');
  const w = el ? Math.round(el.clientWidth) : 0;
  const h = el ? Math.round(el.clientHeight) : 0;
  const ps = el ? getComputedStyle(el) : null;
  const pad = ps ? [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].join(',') : '';
  return [store.get('ts_size','18'), store.get('ts_lh','18'),
          store.get('ts_font','serif'), w, h, pad, 'pg4'].join('|'); // v3.85：padding 也进指纹，改 padding 不用再手动升版；pg3 缓存按旧 padding 算的页作废
}

/* 二分：句子 g 位于哪一页（0-based） */
function pageOfSentence(g){
  const s = PG.starts;
  if(!s.length) return 0;
  let lo = 0, hi = s.length - 1, ans = 0;
  while(lo <= hi){
    const m = (lo + hi) >> 1;
    if(s[m] <= g){ ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}
/* 第 p 页的第一个句子下标 */
function sentenceOfPage(p){
  const s = PG.starts;
  if(!s.length) return 0;
  p = Math.max(0, Math.min(s.length - 1, p));
  return s[p];
}

/* 建一个与 #reader-pages 像素一致的离屏测量器 */
function buildMeasurer(){
  const src = $('#reader-pages');
  const pageW = src.clientWidth, pageH = src.clientHeight;
  const c = $('#content');
  const cs = getComputedStyle(c);
  const ps = getComputedStyle(src);   // live padding/gap, not hardcoded guesses
  const padL = parseFloat(ps.paddingLeft)||22, padR = parseFloat(ps.paddingRight)||22;
  const gap = parseFloat(ps.columnGap)||44;
  const m = document.createElement('div');
  m.setAttribute('aria-hidden','true');
  m.style.cssText =
    'position:fixed;left:-100000px;top:0;width:'+pageW+'px;height:'+pageH+'px;' +
    'padding:'+ps.paddingTop+' '+ps.paddingRight+' '+ps.paddingBottom+' '+ps.paddingLeft+';box-sizing:border-box;overflow:hidden;visibility:hidden;pointer-events:none;' +
    'column-width:'+Math.max(200,pageW-padL-padR-gap)+'px;column-gap:'+gap+'px;column-fill:auto;';
  const art = document.createElement('div');
  art.style.cssText =
    'font-size:'+cs.fontSize+';line-height:'+cs.lineHeight+';font-family:'+cs.fontFamily+';' +
    'text-align:justify;orphans:3;widows:3;';
  m.appendChild(art);
  document.body.appendChild(m);
  return { m, art, pageW };
}
const CH_TITLE_CSS =
  'display:block;break-before:column;break-inside:avoid;text-align:center;' +
  "font-family:Georgia,'Songti SC','STSong',serif;" +
  'font-size:23px;font-weight:700;margin:0 0 1em;line-height:1.5;';

/* 分片测量全书，返回 {starts, total}；长书不会一次卡死 */
async function paginateBook(book, hash){
  const { m, art, pageW } = buildMeasurer();
  const starts = [];
  let lastPage = -1, ci = -1, baseLeft = null, measCols = 1;
  const N = book.total, SLICE = 400;
  try{
    for(let s = 0; s < N; s += SLICE){
      const e = Math.min(N, s + SLICE);
      const spans = [];
      for(let i = s; i < e; i++){
        const sn = book.sentences[i];
        if(sn.c !== ci){
          ci = sn.c;
          const h = document.createElement('span');
          h.style.cssText = CH_TITLE_CSS;
          h.textContent = book.chapters[ci] ? book.chapters[ci].title : ('第'+(ci+1)+'章');
          art.appendChild(h);
        }
        if(sn.p){ const pb = document.createElement('span');
          pb.style.cssText = 'display:block;height:.7em;'; art.appendChild(pb); }
        const sp = document.createElement('span');
        sp.textContent = sn.t;
        art.appendChild(sp);
        art.appendChild(document.createTextNode(' '));
        spans.push([sp, i]);
      }
      // 强制布局后读取本片各句所在的列。注意：行内 span 的 offsetLeft
      // 在多列容器里是无意义的（返回行内框的 x，不是列位置），必须用
      // getBoundingClientRect().left 相对首句 rect 换算列号。
      for(const [sp, gi] of spans){
        const r = sp.getBoundingClientRect();
        if(baseLeft === null) baseLeft = r.left; // v3.85 修：测量器在 left:-100000px，rect.left 全是负数，旧判据 <0 每句都重置 baseLeft，整书恒算 1 页
        const p = Math.max(0, Math.round((r.left - baseLeft) / pageW));
        if(p > lastPage){ starts.push(gi); lastPage = p; }
      }
      // 让出主线程，保持界面响应
      await new Promise(r => setTimeout(r, 0));
      // 中途书被切换或指纹变化就放弃
      if(!cur || cur.id !== book.id || pageHash() !== hash) return null;
    }
    // 测量器实际列数交叉校验：starts 再多也不能超过真实列数
    measCols = Math.max(1, Math.round(m.scrollWidth / pageW));
  }finally{
    m.remove();
  }
  if(!starts.length) starts.push(0);
  if(starts.length > measCols) starts.length = measCols;
  return { starts, total: starts.length };
}
