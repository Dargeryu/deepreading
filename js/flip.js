/* DeepRead 仿真翻页 v3.21
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

function bindFlip(){
  const el = pagesEl();
  if(!el || el._flipBound) return;
  el._flipBound = true;
  el.addEventListener('pointerdown', onFlipDown);
  window.addEventListener('pointermove', onFlipMove, { passive: false });
  window.addEventListener('pointerup', onFlipUp, { passive: true });
  window.addEventListener('pointercancel', onFlipCancel, { passive: true });
}

function onFlipDown(e){
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
    if(selectionTakesOver()){ Flip.tracking = false; return; } // 让给系统文本选择
    const dir = dx < 0 ? 1 : -1;
    const to = PG.page + dir;
    Flip.dragging = true; pageTouchMoved = true;
    if(to < 0 || to >= PG.total){ Flip.edge = true; Flip.dir = dir; }
    else { Flip.edge = false; beginLeaf(dir); }
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

function onFlipUp(){
  if(!Flip.tracking) return;
  Flip.tracking = false;
  if(!Flip.dragging) return; // 轻触：交给句子的 click
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
  const W = Flip.W || 1;
  const raw = Math.min(1, Math.abs(dx) / (W * 0.82));
  const p = Math.pow(raw, 0.92);   // 纸张阻尼：起手稍沉
  Flip.progress = p;
  setAngle(Flip.dir === 1 ? -180 * p : 180 * p);
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

function endLeaf(){
  if(Flip.leaf) Flip.leaf.remove();
  if(Flip.spine) Flip.spine.remove();
  if(Flip.fx) Flip.fx.remove();
  if(Flip.hl) Flip.hl.remove();
  Flip.leaf = Flip.shade = Flip.spine = Flip.fx = Flip.hl = null;
  Flip.active = false; Flip.edge = false;
  cancelAnimationFrame(Flip.raf);
  clearStaleShift();
}

function completeFlip(){
  const target = Flip.dir === 1 ? -180 : 180;
  const cur = Flip.dir === 1 ? -180 * Flip.progress : 180 * Flip.progress;
  const dur = Math.max(120, Math.min(420, 230 * (1 - Flip.progress) / (0.35 + Math.abs(Flip.vel))));
  tween(cur, target, dur, () => {
    const tp = Flip.toPage;
    endLeaf();
    commitPage(tp);
    verifyPageAlignment(tp, pagesEl().clientWidth||1);
    drainQueue();
  });
}
function cancelFlip(){
  const cur = Flip.dir === 1 ? -180 * Flip.progress : 180 * Flip.progress;
  tween(cur, 0, 190, () => {
    const fp = Flip.fromPage;
    endLeaf();
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
  if(Flip.active){ Flip.queued = gp; return; }
  if(gp === PG.page || PG.total <= 1){ showPageInstant(gp); return; }
  const dir = gp > PG.page ? 1 : -1;
  if(Math.abs(gp - PG.page) !== 1){ showPageInstant(gp); return; }
  beginLeaf(dir);
  tween(0, dir === 1 ? -180 : 180, 300, () => {
    const tp = Flip.toPage;
    endLeaf();
    commitPage(tp);
    drainQueue();
  });
};
