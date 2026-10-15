/* Apo 仿真翻页 v3.21
 * 真书触感：手指按住拖动时，书页跟着手指卷起
 * （3D rotateY + 透视 + 动态书页阴影/书脊阴影）；松手后按拖动距离与
 * 速度决定是翻过去还是弹回。朗读时的自动翻页走同样的翻页动画。
 * 与 app.js 协作：app.js 提供 pagesEl / localPageOf / ensureWindowForPage /
 * showPageInstant / commitPage / pageTouchMoved；本文件只负责手势与动画。
 */
const Flip = {
  active: false,    // 翻页动画或拖拽进行中
  tracking: false,  // pointer 已按下、正在观察是否为翻页手势
  dragging: false,  // 已确认为翻页拖拽
  edge: false,      // 在首/末页边缘的橡皮筋状态
  dir: 0,           // 1=下一页，-1=上一页
  fromPage: 0, toPage: 0, progress: 0,
  leaf: null, shade: null, spine: null,
  startX: 0, startY: 0, lastX: 0, lastT: 0, vel: 0, W: 0,
  queued: null,     // 翻页进行中时新到的目标页（朗读连续翻页）
  dragRaf: 0, pendingDx: 0, // 合并高频指针事件，最多每帧更新一次卷页
};

/* v3.67 翻页模式：slide=原生滑动（默认，对标 Readify），curl=3D仿真，none=无动画 */
function flipMode(){ return store.get('ts_flip', 'curl'); }
function bindFlip(){
  const el = pagesEl();
  if(!el) return;
  [['reader-prev',-1],['reader-next',1]].forEach(([id,dir])=>{
    const button=document.getElementById(id);
    if(button && !button._turnBound){
      button._turnBound=true;
      button.addEventListener('click',()=>{
        if(!PG.ready || Flip.active) return;
        Flip.animateTo(PG.page+dir);
      });
    }
  });
  applyFlipMode();
  if(el._flipBound) return;
  el._flipBound = true;
  el.addEventListener('pointerdown', onFlipDown);
  window.addEventListener('pointermove', onFlipMove, { passive: false });
  window.addEventListener('pointerup', onFlipUp, { passive: true });
  window.addEventListener('pointercancel', onFlipCancel, { passive: true });
  // 滑动模式：点按左右边缘翻页（兜底）
  el.addEventListener('click', (e)=>{
    if(flipMode() !== 'slide' || !PG.ready || PG.total <= 1) return;
    if(window.getSelection().toString()) return;
    if(e.target.closest('button, a, .sel-tip')) return;
    const W = el.clientWidth || 1;
    const rect = el.getBoundingClientRect();
    const rx = e.clientX - rect.left;
    if(rx < W * 0.22 && PG.page > 0){ Flip.animateTo(PG.page - 1); }
    else if(rx > W * 0.78 && PG.page < PG.total - 1){ Flip.animateTo(PG.page + 1); }
  });
  // 滑动模式：滚动时只做轻量防抖；分页窗口调整延后到手势停下后。
  let snapT = null;
  el.addEventListener('scroll', ()=>{
    if(flipMode() !== 'slide' || Flip.active) return;
    clearTimeout(snapT);
    snapT = setTimeout(snapToPage, 120);
  }, { passive: true });
}
function applyFlipMode(){
  // v3.67 一次性迁移：之前存了 slide 的老用户切到 curl（3D 卷页），之后用户手动改的优先
  try{
    if(!localStorage.getItem('ts_flip_migrated_367')){
      const cur = store.get('ts_flip', null);
      if(cur === 'slide'){ store.set('ts_flip', 'curl'); }
      localStorage.setItem('ts_flip_migrated_367', '1');
      const tf = document.getElementById('ts-flip');
      if(tf) tf.value = store.get('ts_flip', 'curl');
    }
  }catch(e){}
  const el = pagesEl(); if(!el) return;
  el.classList.toggle('slide-mode', flipMode() === 'slide');
}
function snapToPage(){
  if(flipMode() !== 'slide' || !PG.ready || PG.total <= 1) return;
  const el = pagesEl(), W = el.clientWidth || 1;
  const local = Math.round(el.scrollLeft / W);
  let gp = Math.max(0, Math.min(PG.total - 1, local + localPageOffset()));
  // 用力猛滑也只允许翻一页（Readify 式单页步进）
  if(gp > PG.page + 1) gp = PG.page + 1;
  if(gp < PG.page - 1) gp = PG.page - 1;
  // 接近渲染窗口边缘时，等滚动停止再扩展 DOM，避免在手指跟随期间重建上千个节点。
  const s0 = sentenceOfPage(gp);
  if(s0 < winStart + 100 || s0 >= winStart + sentEls.length - 100){
    const previousStart = winStart;
    ensureWindowForPage(gp);
    if(winStart !== previousStart){
      // renderWindow 会清空旧列；先把当前页恢复到原来的屏幕位置，再执行吸附动画。
      el.scrollTo({ left: localPageOf(PG.page) * W, behavior: 'auto' });
    }
  }
  const targetLocal = gp - localPageOffset();
  if(gp !== PG.page){
    el.scrollTo({ left: targetLocal * W, behavior: 'smooth' });
    PG.page = gp; commitPageState(); updateCount();
  } else {
    // 对齐到精确位置
    const target = targetLocal * W;
    if(Math.abs(el.scrollLeft - target) > 2) el.scrollTo({ left: target, behavior: 'smooth' });
  }
}

function onFlipDown(e){
  if(flipMode() !== 'curl' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return; // 无动画偏好下用阅读器按钮翻页
  if(e.target.closest('button, a, input, textarea, select, .reader-find')) return;
  if(Flip.active || !PG.ready || PG.total <= 1) return;
  clearStaleShift();
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  Flip.tracking = true; Flip.dragging = false; Flip.edge = false;
  Flip.startX = e.clientX; Flip.startY = e.clientY;
  Flip.lastX = e.clientX; Flip.lastT = performance.now(); Flip.vel = 0;
  Flip.downT = performance.now();
  Flip.W = pagesEl().clientWidth || 1;
  pageTouchMoved = false;
}

/* 文本选择优先：已有选中内容，或按住超过 0.5s 才拖（长按选词），都不翻页 */
function selectionTakesOver(){
  const s = window.getSelection();
  if(s && !s.isCollapsed && s.toString().length > 0) return true;
  if(performance.now() - (Flip.downT || 0) > 500) return true;
  return false;
}

function onFlipMove(e){
  // 手指拖拽中（dragging）允许持续移动；只有非拖拽的程序化动画才拦截
  if(!Flip.tracking || (Flip.active && !Flip.dragging)) return;
  const dx = e.clientX - Flip.startX, dy = e.clientY - Flip.startY;
  if(!Flip.dragging){
    if(Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && sel.toString().length > 0;
    const longPress = performance.now() - (Flip.downT || 0) > 500;
    if(hasSel && !longPress){
      // 有旧选中但这是快速横滑：清掉选中直接翻页（用户想翻页，不是想调选中）
      try{ sel.removeAllRanges(); }catch(_){}
    } else if(selectionTakesOver()){ Flip.tracking = false; return; } // 长按让给系统文本选择
    const dir = dx < 0 ? 1 : -1;
    const to = PG.page + dir;
    Flip.dragging = true; pageTouchMoved = true;
    try{ document.getElementById('content').style.userSelect='none'; }catch(_){} // 拖拽中禁选中，防蓝色高亮
    if(to < 0 || to >= PG.total){ Flip.edge = true; Flip.dir = dir; }
    else { Flip.edge = false; beginCurl(dir); }
    try{ pagesEl().setPointerCapture(e.pointerId); }catch(_){}
    if(e.cancelable) e.preventDefault();
    return;
  }
  const now = performance.now();
  const dt = Math.max(1, now - Flip.lastT);
  Flip.vel = 0.75 * Flip.vel + 0.25 * ((e.clientX - Flip.lastX) / dt); // px/ms
  Flip.lastX = e.clientX; Flip.lastT = now;
  if(Flip.edge){ edgeDrag(e.clientX - Flip.startX); }
  else dragTo(e.clientX - Flip.startX);
  if(e.cancelable) e.preventDefault();
}

function onFlipUp(e){
  if(!Flip.tracking) return;
  Flip.tracking = false;
  if(!Flip.dragging){
    // 轻触：左右边缘 1/4 区域点按翻页（滑动失灵时的兜底）
    if(e && e.clientX != null && PG.ready && PG.total > 1 && !window.getSelection().toString()){
      const W = (pagesEl().clientWidth || 1);
      const x = e.clientX;
      const rect = pagesEl().getBoundingClientRect();
      const rx = x - rect.left;
      if(rx < W * 0.25 && PG.page > 0){ setPage(PG.page - 1); return; }
      if(rx > W * 0.75 && PG.page < PG.total - 1){ setPage(PG.page + 1); return; }
    }
    return; // 轻触：交给句子的 click
  }
  if(Flip.edge){ Flip.dragging = false; edgeRelease(); Flip.edge = false; return; }
  flushDrag();
  Flip.dragging = false;
  const quick = Math.abs(Flip.vel) > 0.45 && Flip.progress > 0.04;
  if(Flip.progress > 0.24 || quick) completeFlip();
  else cancelFlip();
}
function onFlipCancel(){
  if(!Flip.tracking) return;
  Flip.tracking = false;
  if(Flip.dragging){ Flip.dragging = false;
    if(Flip.edge){ edgeRelease(); Flip.edge = false; } else cancelFlip(); }
}

/* ============ v3.70 跟手卷页：按视口自适应分段，减少小屏重绘 ============ */
function curlSliceCount(width){ return Math.max(10, Math.min(16, Math.round(width / 42))); }
function paperColor(){
  try{ return getComputedStyle(document.getElementById('content')).backgroundColor || '#fff'; }
  catch(_){ return '#fff'; }
}
/* 开始一次翻页：静层先切到目标页，卷叶盖住显示当前页 */
function beginCurl(dir){
  try{
  const el = pagesEl();
  const W = el.clientWidth || 1, H = el.clientHeight || 1;
  Flip.W = W;
  Flip.dir = dir; Flip.fromPage = PG.page; Flip.toPage = PG.page + dir; Flip.progress = 0;
  ensureWindowForPage(Flip.toPage);
  el.scrollTo({ left: localPageOf(Flip.toPage) * W, behavior: 'auto' });
  const src = document.getElementById('content');
  const bg = paperColor();
  // 卷叶容器
  const curl = document.createElement('div');
  curl.className = 'flip-curl';
  curl.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;z-index:20;pointer-events:none;overflow:hidden;`;
  // 切片：每条显示页面对应竖条，背面为纸色
  const sliceCount = curlSliceCount(W);
  const stripW = W / sliceCount;
  Flip.strips = [];
  // 模板：只快照当前页句子，不复制整本书或整个虚拟窗口。
  const tpl = document.createElement('div');
  tpl.style.cssText = `width:${W}px;height:${H}px;overflow:hidden;box-sizing:border-box;`;
  const pageWrap = document.createElement('div');
  pageWrap.className = 'flip-curl-page';
  pageWrap.setAttribute('aria-hidden','true');
  const srcStyle = getComputedStyle(src), pageStyle = getComputedStyle(el);
  const padTop = parseFloat(pageStyle.paddingTop) || 0;
  const padRight = parseFloat(pageStyle.paddingRight) || 0;
  const padBottom = parseFloat(pageStyle.paddingBottom) || 0;
  const padLeft = parseFloat(pageStyle.paddingLeft) || 0;
  pageWrap.style.cssText = 'box-sizing:border-box;width:'+W+'px;height:'+H+'px;padding:'+padTop+'px '+padRight+'px '+padBottom+'px '+padLeft+'px;overflow:hidden;margin:0;font-size:'+srcStyle.fontSize+';line-height:'+srcStyle.lineHeight+';font-family:'+srcStyle.fontFamily+';font-weight:'+srcStyle.fontWeight+';font-style:'+srcStyle.fontStyle+';letter-spacing:'+srcStyle.letterSpacing+';word-spacing:'+srcStyle.wordSpacing+';color:'+srcStyle.color+';text-align:'+srcStyle.textAlign+';background:'+bg+';';
  pageWrap.setAttribute('data-theme', src.dataset.theme || 'day');
  try{
    const s0 = (PG.starts && PG.starts[Flip.fromPage] != null) ? PG.starts[Flip.fromPage] : 0;
    const s1 = (PG.starts && PG.starts[Flip.fromPage+1] != null) ? PG.starts[Flip.fromPage+1] : cur.total;
    const headingRef = src.querySelector('.ch-title');
    const headingStyle = headingRef ? getComputedStyle(headingRef) : null;
    let chapter = s0 > 0 && cur.sentences[s0-1] ? cur.sentences[s0-1].c : -1;
    for(let gi=s0;gi<s1 && gi<cur.total;gi++){
      const sentence = cur.sentences[gi];
      if(!sentence) continue;
      if(sentence.c !== chapter){
        chapter = sentence.c;
        const title = document.createElement('span');
        title.className = 'ch-title';
        title.textContent = cur.chapters[chapter] ? cur.chapters[chapter].title : `第${chapter+1}章`;
        if(headingStyle) title.style.cssText = 'display:block;text-align:'+headingStyle.textAlign+';font-family:'+headingStyle.fontFamily+';font-size:'+headingStyle.fontSize+';font-weight:'+headingStyle.fontWeight+';margin:'+headingStyle.margin+';line-height:'+headingStyle.lineHeight+';';
        pageWrap.appendChild(title);
      }
      const orig = sentEls[gi - winStart];
      const sentenceEl = orig ? orig.cloneNode(true) : document.createElement('span');
      if(!orig){ sentenceEl.className='sent'; sentenceEl.textContent=sentence.t; sentenceEl.dataset.g=gi; }
      sentenceEl.classList.remove('active');
      pageWrap.appendChild(sentenceEl);
      pageWrap.appendChild(document.createTextNode(' '));
    }
  }catch(e){}
  tpl.appendChild(pageWrap);
  for(let i=0;i<sliceCount;i++){
    const strip = document.createElement('div');
    strip.style.cssText = `position:absolute;left:${(i*stripW).toFixed(1)}px;top:0;width:${(stripW+1).toFixed(1)}px;height:100%;overflow:hidden;background:${bg};transform-origin:${dir===1?'left':'right'} center;will-change:transform;`;
    const inner = document.createElement('div');
    inner.style.cssText = `width:${W}px;height:100%;margin-left:${(-i*stripW).toFixed(1)}px;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden;transform:translateZ(.25px);`;
    inner.appendChild(i===0 ? tpl : tpl.cloneNode(true));
    strip.appendChild(inner);
    const back = document.createElement('div');
    back.className = 'flip-curl-back';
    back.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;transform:rotateY(180deg) translateZ(.4px);backface-visibility:hidden;-webkit-backface-visibility:hidden;';
    strip.appendChild(back);
    curl.appendChild(strip);
    Flip.strips.push({el:strip, x:(i+0.5)*stripW, front:inner, back});
  }
  // 卷页阴影（跟随卷曲前锋）
  const shadow = document.createElement('div');
  shadow.className = 'flip-curl-shadow';
  shadow.style.cssText = `position:absolute;top:0;bottom:0;width:90px;pointer-events:none;opacity:0;will-change:transform,opacity;background:linear-gradient(${dir===1?'90deg':'270deg'},rgba(0,0,0,0),rgba(20,12,6,.28),rgba(0,0,0,0));`;
  curl.appendChild(shadow);
  el.appendChild(curl);
  Flip.curl = curl; Flip.curlShadow = shadow;
  Flip.active = true; Flip._activeSince = Date.now();
  setCurl(0);
  }catch(e){
    // 卷页构建失败时降级：直接切页，保证不卡死
    try{ endCurl(); }catch(_){}
    Flip.active = false; Flip.tracking = false; Flip.dragging = false;
    showPageInstant(Flip.toPage != null ? Flip.toPage : PG.page);
  }
}
/* 卷曲进度 p∈[0,1] → 每条切片的弯曲角度（圆柱模型近似） */
function setCurl(p){
  const W = Flip.W || 1, dir = Flip.dir || 1;
  const strips = Flip.strips || [];
  // 卷曲前锋位置：从右边缘（p=0）移到左边缘（p=1）
  const front = dir === 1 ? W * (1 - p) : W * p;
  const curlW = Math.max(60, W * 0.30); // 弯曲区宽度
  for(const {el:strip, x, front:frontFace, back:backFace} of strips){
    let angle = 0;
    if(dir === 1){
      const d = x - front; // 前锋右侧为已卷起区
      if(d > 0) angle = Math.min(180, (d / curlW) * 165);
    }else{
      const d = front - x;
      if(d > 0) angle = Math.min(180, (d / curlW) * 165);
    }
    // 用 smoothstep 让弯曲更圆润
    const t = Math.min(1, angle / 165);
    const smooth = t * t * (3 - 2 * t);
    const deg = smooth * 165 * (angle >= 165 ? 180/165 : 1);
    const finalDeg = p >= 0.999 || angle >= 165 ? 180 : deg;
    const turned = finalDeg >= 90;
    if(frontFace) frontFace.style.visibility = turned ? 'hidden' : 'visible';
    if(backFace) backFace.style.visibility = turned ? 'visible' : 'hidden';
    strip.style.transform = `rotateY(${(dir===1?-finalDeg:finalDeg).toFixed(2)}deg)`;
  }
  if(Flip.curlShadow){
    const sx = dir === 1 ? front - 45 : front - 45;
    Flip.curlShadow.style.transform = `translateX(${sx.toFixed(1)}px)`;
    Flip.curlShadow.style.opacity = (Math.sin(Math.min(1,p)*Math.PI)*0.85).toFixed(3);
  }
  Flip.progress = p;
}
function curlDragTo(dx){
  const W = Flip.W || 1;
  const p = Math.min(1, Math.max(0, Math.abs(dx) / (W * 0.9)));
  setCurl(p);
}
function endCurl(){
  if(Flip.dragRaf){ cancelAnimationFrame(Flip.dragRaf); Flip.dragRaf=0; }
  if(Flip.curl) Flip.curl.remove();
  if(Flip.strips) Flip.strips.length = 0;
  Flip.curl = Flip.curlShadow = null; Flip.strips = null;
  Flip.active = false; Flip.edge = false; Flip._activeSince = 0;
  cancelAnimationFrame(Flip.raf);
  try{ document.getElementById('content').style.userSelect=''; }catch(_){}
  clearStaleShift();
}
function tweenCurl(from, to, dur, done){
  const t0 = performance.now();
  cancelAnimationFrame(Flip.raf);
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    setCurl(from + (to - from) * e);
    if(t < 1) Flip.raf = requestAnimationFrame(step);
    else done();
  };
  Flip.raf = requestAnimationFrame(step);
}
/* 开始一次翻页：静层先切到目标页，叶子盖住显示当前页 */
function beginLeaf(dir){
  const el = pagesEl();
  Flip.W = el.clientWidth || Flip.W || 1;
  const W = Flip.W;
  Flip.dir = dir; Flip.fromPage = PG.page; Flip.toPage = PG.page + dir; Flip.progress = 0;
  ensureWindowForPage(Flip.toPage);                       // 目标页句子必须已渲染
  el.scrollTo({ left: localPageOf(Flip.toPage) * W, behavior: 'auto' }); // 静层=目标页
  const src = el.cloneNode(true);                          // 叶子=当前页
  src.removeAttribute('id'); src.className = 'flip-src';
  src.style.transform = ''; src.style.transition = '';       // 清掉可能残留的边缘橡皮筋位移
  const leaf = document.createElement('div');
  leaf.className = 'flip-leaf';
  leaf.style.transformOrigin = dir === 1 ? 'left center' : 'right center';
  leaf.appendChild(src);
  try{ // 叶子背面 = 纸色，转过 90° 后不再看到镜像文字
    leaf.style.background = getComputedStyle(document.getElementById('content')).backgroundColor || '#fff';
  }catch(_){}
  const shade = document.createElement('div');
  shade.className = 'flip-shade';
  if(dir === -1) shade.style.transform = 'scaleX(-1)';
  leaf.appendChild(shade);
  el.appendChild(leaf);
  src.scrollLeft = localPageOf(Flip.fromPage) * W;          // 插入后定位才生效
  const spine = document.createElement('div');
  spine.className = 'flip-spine ' + (dir === 1 ? 'l' : 'r');
  el.appendChild(spine);
  const fx = document.createElement('div'); fx.className = 'flip-fx'; el.appendChild(fx);
  const hl = document.createElement('div'); hl.className = 'flip-hl'; el.appendChild(hl);
  Flip.leaf = leaf; Flip.shade = shade; Flip.spine = spine;
  Flip.fx = fx; Flip.hl = hl;
  Flip.active = true;
  Flip._activeSince = Date.now();
  setAngle(0);
}

function setAngle(deg){
  if(!Flip.leaf) return;
  // 只写 transform/opacity（GPU 合成），不碰 left 等布局属性
  Flip.leaf.style.transform = 'rotateY(' + deg + 'deg)';
  const p = Math.min(1, Math.abs(deg) / 180);
  const s = Math.sin(p * Math.PI);
  if(Flip.shade) Flip.shade.style.opacity = (s * 0.6).toFixed(3);
  if(Flip.spine) Flip.spine.style.opacity = (s * 0.85).toFixed(3);
  // 卷曲前锋的投影位置：自由边投影 x = W*cos(θ)
  const W = Flip.W || 1, proj = Flip.dir === 1 ? W * Math.cos(p * Math.PI) : W - W * Math.cos(p * Math.PI);
  if(Flip.fx){ Flip.fx.style.transform = 'translateX(' + (proj - 55).toFixed(1) + 'px)'; Flip.fx.style.opacity = (s * 0.5).toFixed(3); }
  if(Flip.hl){ Flip.hl.style.transform = 'translateX(' + (Flip.dir === 1 ? proj - 70 : proj).toFixed(1) + 'px)'; Flip.hl.style.opacity = (s * 0.65).toFixed(3); }
}

function edgeDrag(dx){
  const el = pagesEl(), W = Flip.W || 1;
  const x = Math.max(-1, Math.min(1, dx / (W * 0.6)));
  el.style.transition = 'none';
  el.style.transform = 'translateX(' + (x * W * 0.16).toFixed(1) + 'px)';
}
function edgeRelease(){
  const el = pagesEl();
  el.style.transition = 'transform .28s cubic-bezier(.2,.8,.3,1)';
  el.style.transform = '';
  setTimeout(()=>{ if(el.style.transform === '') el.style.transition = ''; }, 320);
}
// 防御：清除 #reader-pages 上残留的位移（多指/异常手势可能导致橡皮筋卡住）
function clearStaleShift(){
  const el = pagesEl(); if(!el) return;
  if(el.style.transform){ el.style.transition=''; el.style.transform=''; }
}
function dragTo(dx){
  Flip.pendingDx = dx;
  if(Flip.dragRaf) return;
  Flip.dragRaf = requestAnimationFrame(()=>{
    Flip.dragRaf = 0;
    if(Flip.active && Flip.dragging && !Flip.edge) curlDragTo(Flip.pendingDx);
  });
}
function flushDrag(){
  if(!Flip.dragRaf) return;
  cancelAnimationFrame(Flip.dragRaf); Flip.dragRaf = 0;
  if(Flip.active && Flip.dragging && !Flip.edge) curlDragTo(Flip.pendingDx);
}

function tween(from, to, dur, done){
  const t0 = performance.now();
  cancelAnimationFrame(Flip.raf);
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);                      // easeOutCubic
    setAngle(from + (to - from) * e);
    if(t < 1) Flip.raf = requestAnimationFrame(step);
    else done();
  };
  Flip.raf = requestAnimationFrame(step);
}

/* 看门狗：翻页动画卡住超过 3 秒强制重置，防止滑动彻底失灵 */
setInterval(()=>{
  if(Flip.active && Flip._activeSince && Date.now() - Flip._activeSince > 3000){
    try{ if(Flip.curl) endCurl(); else endLeaf(); }catch(e){}
    Flip.active = false; Flip.tracking = false; Flip.dragging = false;
  }
}, 1000);

function endLeaf(){
  Flip._activeSince = 0;
  if(Flip.leaf) Flip.leaf.remove();
  if(Flip.spine) Flip.spine.remove();
  if(Flip.fx) Flip.fx.remove();
  if(Flip.hl) Flip.hl.remove();
  Flip.leaf = Flip.shade = Flip.spine = Flip.fx = Flip.hl = null;
  Flip.active = false; Flip.edge = false;
  cancelAnimationFrame(Flip.raf);
  try{ document.getElementById('content').style.userSelect=''; }catch(_){} // 恢复文本选择
  clearStaleShift();
}

function completeFlip(){
  const cur = Flip.progress;
  const dur = Math.max(120, Math.min(420, 230 * (1 - Flip.progress) / (0.35 + Math.abs(Flip.vel))));
  tweenCurl(cur, 1, dur, () => {
    const tp = Flip.toPage;
    endCurl();
    commitPage(tp);
    verifyPageAlignment(tp, pagesEl().clientWidth||1);
    drainQueue();
  });
}
function cancelFlip(){
  const cur = Flip.progress;
  tweenCurl(cur, 0, 190, () => {
    const fp = Flip.fromPage;
    endCurl();
    showPageInstant(fp);   // 静层曾切到目标页，弹回时复原
  });
}
function drainQueue(){
  if(Flip.queued != null){
    const q = Flip.queued; Flip.queued = null;
    if(q !== PG.page) Flip.animateTo(q);
  }
}

/* 程序化翻页（朗读自动翻页等）：相邻页走动画，跨页直接切 */
Flip.animateTo = function(gp){
  if(!PG.ready) return;
  gp = Math.max(0, Math.min(PG.total - 1, gp));
  const mode = flipMode();
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(mode === 'none' || reduceMotion){ showPageInstant(gp); return; }
  if(mode === 'slide'){
    // 原生平滑滚动（浏览器合成器线程，60fps）
    const el = pagesEl(), W = el.clientWidth || 1;
    ensureWindowForPage(gp);
    el.scrollTo({ left: localPageOf(gp) * W, behavior: 'smooth' });
    PG.page = gp; commitPageState(); updateCount();
    return;
  }
  if(Flip.active){ Flip.queued = gp; return; }
  if(gp === PG.page || PG.total <= 1){ showPageInstant(gp); return; }
  const dir = gp > PG.page ? 1 : -1;
  if(Math.abs(gp - PG.page) !== 1){ showPageInstant(gp); return; }
  beginCurl(dir);
  tweenCurl(0, 1, 300, () => {
    const tp = Flip.toPage;
    endCurl();
    commitPage(tp);
    verifyPageAlignment(tp, pagesEl().clientWidth||1);
    drainQueue();
  });
};
