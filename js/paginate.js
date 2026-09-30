/* DeepRead 独立分页 v3.21
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
  return [store.get('ts_size','18'), store.get('ts_lh','20'),
          store.get('ts_font','serif'), w, h].join('|');
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
  const m = document.createElement('div');
  m.setAttribute('aria-hidden','true');
  m.style.cssText =
    'position:fixed;left:-100000px;top:0;width:'+pageW+'px;height:'+pageH+'px;' +
    'padding:22px;box-sizing:border-box;overflow:hidden;visibility:hidden;pointer-events:none;' +
    'column-width:'+Math.max(200,pageW-44)+'px;column-gap:44px;column-fill:auto;';
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
  let lastPage = -1, ci = -1, base = -1;
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
        const sp = document.createElement('span');
        sp.textContent = sn.t;
        art.appendChild(sp);
        art.appendChild(document.createTextNode(' '));
        spans.push([sp, i]);
      }
      // 强制布局后读取本片各句所在的列
      for(const [sp, gi] of spans){
        if(base < 0) base = sp.offsetLeft;
        const p = Math.max(0, Math.round((sp.offsetLeft - base) / pageW));
        if(p > lastPage){ starts.push(gi); lastPage = p; }
      }
      // 让出主线程，保持界面响应
      await new Promise(r => setTimeout(r, 0));
      // 中途书被切换或指纹变化就放弃
      if(!cur || cur.id !== book.id || pageHash() !== hash) return null;
    }
  }finally{
    m.remove();
  }
  if(!starts.length) starts.push(0);
  return { starts, total: starts.length };
}
