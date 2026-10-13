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
};

/* v3.53 翻页模式：slide=原生滑动（默认，对标 Readify），curl=3D仿真，none=无动画 */
function flipMode(){ return store.get('ts_flip', 'slide'); }
function bindFlip(){
  const el = pagesEl();
  if(!el) return;
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
  // 滑动模式：滚动结束吸附到最近页面；滑出预渲染窗口时自动扩展
  let snapT = null;
  el.addEventListener('scroll', ()=>{
    if(flipMode() !== 'slide' || Flip.active) return;
    // 预渲染窗口保护：接近边缘时扩展窗口
    try{
      const W = el.clientWidth || 1;
      const local = Math.round(el.scrollLeft / W);
      const gp = local + localPageOffset();
      if(PG.ready && gp >= 0 && gp < PG.total){
        const s0 = sentenceOfPage(gp);
        if(s0 < winStart + 100 || s0 >= winStart + sentEls.length - 100){
          ensureWindowForPage(gp);
          // 窗口重渲染后重新对齐滚动位置
          const nl = localPageOf(gp);
          if(Math.abs(el.scrollLeft - nl * W) > W * 0.5) el.scrollTo({ left: nl * W, behavior: 'auto' });
        }
      }
    }catch(e){}
    clearTimeout(snapT);
    snapT = setTimeout(snapToPage, 120);
  }, { passive: true });
}
function applyFlipMode(){
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
  if(flipMode() !== 'curl') return; // 滑动/无动画模式不拦截，走原生
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
  Flip.dragging = false;
  if(Flip.edge){ edgeRelease(); Flip.edge = false; return; }
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

/* ============ v3.53 真卷页：分段圆柱弯曲（对标 Readify） ============ */
const CURL_N = 16; // 切片数
function paperColor(){
  try{ return getComputedStyle(document.getElementById('content')).backgroundColor || '#fff'; }
  catch(_){ return '#fff'; }
}
/* 开始一次翻页：静层先切到目标页，卷叶盖住显示当前页 */
function beginCurl(dir){
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
  curl.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;z-index:20;pointer-events:none;`;
  // 切片：每条显示页面对应竖条，背面为纸色
  const stripW = W / CURL_N;
  Flip.strips = [];
  // 只克隆一次作为模板
  const tpl = src.cloneNode(true);
  tpl.removeAttribute('id');
  tpl.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  for(let i=0;i<CURL_N;i++){
    const strip = document.createElement('div');
    strip.style.cssText = `position:absolute;left:${(i*stripW).toFixed(1)}px;top:0;width:${(stripW+1).toFixed(1)}px;height:100%;overflow:hidden;background:${bg};transform-origin:${dir===1?'left':'right'} center;will-change:transform;`;
    const inner = document.createElement('div');
    inner.style.cssText = `width:${W}px;height:100%;margin-left:${(-i*stripW).toFixed(1)}px;backface-visibility:hidden;-webkit-backface-visibility:hidden;`;
    inner.appendChild(i===0 ? tpl : tpl.cloneNode(true));
    // 定位到当前页
    inner.scrollLeft = 0;
    strip.appendChild(inner);
    curl.appendChild(strip);
    Flip.strips.push({el:strip, x:(i+0.5)*stripW});
  }
  // 卷页阴影（跟随卷曲前锋）
  const shadow = document.createElement('div');
  shadow.className = 'flip-curl-shadow';
  shadow.style.cssText = `position:absolute;top:0;bottom:0;width:90px;pointer-events:none;opacity:0;will-change:transform,opacity;background:linear-gradient(${dir===1?'90deg':'270deg'},rgba(0,0,0,0),rgba(20,12,6,.28),rgba(0,0,0,0));`;
  curl.appendChild(shadow);
  el.appendChild(curl);
  // 把每条 inner 滚动到当前页位置
  const pageScroll = localPageOf(Flip.fromPage) * W;
  Flip.strips.forEach(({el:strip})=>{
    const inner = strip.firstChild;
    inner.style.transform = `translateX(${-pageScroll}px)`;
  });
  Flip.curl = curl; Flip.curlShadow = shadow;
  Flip.active = true; Flip._activeSince = Date.now();
  setCurl(0);
}
/* 卷曲进度 p∈[0,1] → 每条切片的弯曲角度（圆柱模型近似） */
function setCurl(p){
  const W = Flip.W || 1, dir = Flip.dir || 1;
  const strips = Flip.strips || [];
  // 卷曲前锋位置：从右边缘（p=0）移到左边缘（p=1）
  const front = dir === 1 ? W * (1 - p) : W * p;
  const curlW = Math.max(60, W * 0.30); // 弯曲区宽度
  for(const {el:strip, x} of strips){
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
    const finalDeg = angle >= 165 ? 180 : deg;
    strip.style.transform = `rotateY(${(dir===1?-finalDeg:finalDeg).toFixed(2)}deg)`;
    // 弯曲区压暗，增强立体感
    const shade = Math.sin(Math.min(1, finalDeg/180) * Math.PI);
    strip.style.filter = shade > 0.02 ? `brightness(${(1 - shade*0.22).toFixed(3)})` : '';
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
  curlDragTo(dx); // 分段真卷页跟手
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
  if(mode === 'none'){ showPageInstant(gp); return; }
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
    drainQueue();
  });
};
