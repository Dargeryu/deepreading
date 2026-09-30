/* DeepRead v3.6 — 声音中心：音色广场 / 声音克隆 / AI多角色配音
   数据只存本机；克隆走用户自己的服务商 API；角色解析走用户自备 Gemini Key。 */
'use strict';

/* ================= 音色目录 =================
   精品音色 = 高质量系统语音的精选映射（离线可用）。
   同一名字在同一设备上永远对应同一个系统语音，保证稳定。 */
const VOICE_CATALOG=[
  {name:'庭川', gender:'m', tags:['小说类','磁性'], desc:'低沉磁性，男频小说旁白首选'},
  {name:'子安', gender:'m', tags:['小说类','气声'], desc:'少年气声，温柔克制'},
  {name:'观禹', gender:'m', tags:['纪实类','气声'], desc:'纪录片质感，娓娓道来'},
  {name:'帛恒', gender:'m', tags:['纪实类','深厚'], desc:'新闻主播式沉稳，字正腔圆'},
  {name:'崇安', gender:'m', tags:['学术类','平稳'], desc:'论文讲座风，清晰理性'},
  {name:'沐尘', gender:'m', tags:['小说类','清透'], desc:'清透少年音，干净无杂质'},
  {name:'田叔', gender:'m', tags:['小说类','烟嗓'], desc:'沧桑烟嗓，江湖故事味'},
  {name:'砚秋', gender:'m', tags:['纪实类','沉稳'], desc:'中年学者音，娓娓有分量'},
  {name:'疏影', gender:'f', tags:['纪实类','英气'], desc:'飒爽女声，人物传记绝配'},
  {name:'惠然', gender:'f', tags:['小说类','英气'], desc:'侠女音，果断利落'},
  {name:'素安', gender:'f', tags:['纪实类','清透'], desc:'空灵清透，散文诗歌首选'},
  {name:'景柳', gender:'f', tags:['小说类','英气'], desc:'古风女声，温婉带韧劲'},
  {name:'书瑶', gender:'f', tags:['小说类','气声'], desc:'软糯气声，言情氛围感'},
  {name:'清禾', gender:'f', tags:['纪实类','气声'], desc:'知性气声，访谈播客风'},
  {name:'昕雨', gender:'f', tags:['纪实类','亲切'], desc:'邻家姐姐音，亲切自然'},
  {name:'晓柠', gender:'f', tags:['小说类','亲切'], desc:'元气少女音，青春感拉满'},
  {name:'澄澄', gender:'f', tags:['小说类','甜美'], desc:'甜美治愈，睡前故事机'},
  {name:'安稠', gender:'f', tags:['学术类','深厚'], desc:'女教授音，严谨有条理'},
  {name:'十七', gender:'f', tags:['新势力','英气'], desc:'Z世代女声，松弛洒脱'},
  {name:'王姐', gender:'f', tags:['新势力','磁性'], desc:'御姐音，气场两米八'},
  {name:'华祺', gender:'x', tags:['小说类','中性'], desc:'雌雄莫辨，悬疑旁白利器'},
  {name:'好多音', gender:'x', tags:['纪实类','松弛'], desc:'松弛播客风，像朋友聊天'},
  {name:'白衣', gender:'x', tags:['学术类','中性'], desc:'AI感中性音，论文速听'},
  {name:'远山', gender:'x', tags:['纪实类','苍远'], desc:'空旷苍远，历史地理类绝配'},
];
const hashStr=s=>{ let h=0; for(const c of s) h=(h*31+c.codePointAt(0))>>>0; return h; };
/* 同一目录音色 → 同一系统语音（稳定映射） */
function resolveCatalogVoice(entry){
  const all=(typeof voices!=='undefined'?voices:[]);
  const zh=all.filter(v=>v.lang&&v.lang.toLowerCase().startsWith('zh'));
  if(!zh.length) return null;
  const pool=zh.filter(v=>/local/i.test(v.name)||v.localService).length?zh.filter(v=>v.localService):zh;
  const sorted=[...pool].sort((a,b)=>a.name.localeCompare(b.name));
  return sorted[hashStr(entry.name)%sorted.length]||null;
}
const AVA_GRADS=[['#3b2f4a','#7a5fa0'],['#1f3a4d','#3f7fae'],['#4a2f2b','#a06a5f'],
  ['#2b4a35','#5fa07a'],['#4d4420','#ae9a3f'],['#5a2e28','#b5493a'],['#2e3a5a','#6b7fae']];
const avaBG=name=>{ const [a,b]=AVA_GRADS[hashStr(name)%AVA_GRADS.length]; return `linear-gradient(135deg,${a},${b})`; };

/* ---------- 收藏 / 最近 ---------- */
const getFavs=()=>{ try{return JSON.parse(store.get('voice_favs','[]'));}catch(e){return[];} };
const setFavs=a=>store.set('voice_favs',JSON.stringify(a));
const toggleFav=name=>{
  let f=getFavs();
  f=f.includes(name)?f.filter(x=>x!==name):[name,...f];
  setFavs(f); renderPlaza();
};
const pushRecent=name=>{
  try{
    let r=JSON.parse(store.get('voice_recent','[]')).filter(x=>x!==name);
    r=[name,...r].slice(0,12); store.set('voice_recent',JSON.stringify(r));
  }catch(e){}
};

/* ---------- 试听 / 选用 ---------- */
function speakSample(text, voice){
  if(!synth){ toast('当前浏览器不支持语音'); return; }
  try{ synth.cancel(); }catch(e){}
  const u=new SpeechSynthesisUtterance(text);
  if(voice) u.voice=voice;
  u.rate=1; u.pitch=1;
  synth.speak(u);
}
function previewCatalog(entry){
  const v=resolveCatalogVoice(entry);
  if(!v){ toast('这台设备没有可用的中文语音'); return; }
  pushRecent(entry.name);
  speakSample(`大家好，我是${entry.name}。${entry.tags.join('、')}。接下来的故事，由我为你讲述。`, v);
}
function useCatalogVoice(entry){
  const v=resolveCatalogVoice(entry);
  if(!v){ toast('这台设备没有可用的中文语音'); return; }
  store.set('voice_default', JSON.stringify({kind:'system', name:entry.name, voiceURI:v.voiceURI}));
  if(typeof cur!=='undefined'&&cur){ cur.voiceURI=v.voiceURI; saveBook(); applyBookVoice(); }
  pushRecent(entry.name);
  toast(`已选用「${entry.name}」为朗读音色`);
  renderPlaza();
}
function currentDefaultName(){
  try{ const d=JSON.parse(store.get('voice_default','null')); return d&&d.name||''; }catch(e){ return ''; }
}

/* ---------- 广场渲染 ---------- */
let plazaFilter='全部';
const PLAZA_FILTERS=['全部','男声','女声','小说类','纪实类','学术类','收藏'];
function renderPlaza(){
  const chips=$('#plaza-chips'); if(!chips) return;
  chips.innerHTML='';
  PLAZA_FILTERS.forEach(f=>{
    const b=document.createElement('button');
    b.className='chip'+(f===plazaFilter?' cur':''); b.textContent=f;
    b.onclick=()=>{ plazaFilter=f; renderPlaza(); };
    chips.appendChild(b);
  });
  const favs=getFavs(), defName=currentDefaultName();
  const list=$('#plaza-list'); list.innerHTML='';
  const items=VOICE_CATALOG.filter(e=>{
    if(plazaFilter==='全部') return true;
    if(plazaFilter==='收藏') return favs.includes(e.name);
    if(plazaFilter==='男声') return e.gender==='m';
    if(plazaFilter==='女声') return e.gender==='f';
    return e.tags.includes(plazaFilter);
  });
  if(!items.length){ list.innerHTML='<p class="sub" style="padding:20px;text-align:center">这里空空如也，换个筛选试试</p>'; return; }
  items.forEach(e=>{
    const d=document.createElement('div'); d.className='v-card';
    const isDef=defName===e.name, isFav=favs.includes(e.name);
    d.innerHTML=`
      <div class="v-ava" style="background:${avaBG(e.name)}">${esc(e.name[0])}</div>
      <div class="v-info">
        <div class="v-name">${esc(e.name)}${isDef?'<span class="v-cur">使用中</span>':''}</div>
        <div class="v-tags">${e.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div>
        <div class="v-desc">${esc(e.desc)}</div>
      </div>
      <div class="v-ops">
        <button class="v-btn play" title="试听">▶</button>
        <button class="v-btn fav${isFav?' on':''}" title="收藏">${isFav?'♥':'♡'}</button>
        <button class="v-btn use">使用</button>
      </div>`;
    d.querySelector('.play').onclick=()=>previewCatalog(e);
    d.querySelector('.fav').onclick=()=>toggleFav(e.name);
    d.querySelector('.use').onclick=()=>useCatalogVoice(e);
    list.appendChild(d);
  });
}

/* ================= 声音克隆 =================
   真克隆发生在服务商云端：本应用负责 采集/提取/试听 → 调用克隆接口 → 存为"我的音色"。
   - ElevenLabs：内置对接（POST /v1/voices/add）
   - 自定义接口：URL + 字段名 + 返回解析路径可配，适配 MiniMax / FishAudio / 火山等 */
const CLONE_PROVIDERS={
  elevenlabs:{label:'ElevenLabs', hint:'国际主流克隆服务，效果好。去 elevenlabs.io 获取 API Key。'},
  custom:{label:'自定义接口', hint:'按你的服务商文档填写克隆接口地址与字段（如 MiniMax / FishAudio / 火山引擎）。'},
};

/* ---------- 我的音色（IndexedDB voices store） ---------- */
async function renderCloneList(){
  const box=$('#clone-list'); if(!box) return;
  box.innerHTML='';
  let vs=[];
  try{ vs=await idb.allVoices(); }catch(e){}
  vs.sort((a,b)=>b.createdAt-a.createdAt);
  $('#clone-count').textContent=`我的音色 ${vs.length}`;
  if(!vs.length){
    box.innerHTML=`<div class="empty" style="padding:36px 20px">
      <div class="empty-icon">🎙</div><p class="serif">还没有克隆音色</p>
      <p class="sub">录一段你的声音，或上传音频/视频，<br>克隆成专属的读书音色</p></div>`;
    return;
  }
  vs.forEach(v=>{
    const d=document.createElement('div'); d.className='v-card';
    d.innerHTML=`
      <div class="v-ava" style="background:${avaBG(v.name)}">${esc(v.name[0])}</div>
      <div class="v-info">
        <div class="v-name">${esc(v.name)}<span class="v-src">${esc(CLoneLabel(v.provider))}</span></div>
        <div class="v-tags"><span>克隆音色</span><span>${new Date(v.createdAt).toLocaleDateString()}</span></div>
      </div>
      <div class="v-ops">
        <button class="v-btn play" title="试听">▶</button>
        <button class="v-btn use">使用</button>
        <button class="v-btn del" title="删除">🗑</button>
      </div>`;
    d.querySelector('.play').onclick=()=>previewCloned(v);
    d.querySelector('.use').onclick=()=>useCloned(v);
    d.querySelector('.del').onclick=async()=>{
      if(!confirm(`删除克隆音色「${v.name}」？`)) return;
      await idb.delVoice(v.id).catch(()=>{});
      renderCloneList(); toast('已删除');
    };
    box.appendChild(d);
  });
}
function CLoneLabel(p){ return (CLONE_PROVIDERS[p]||{}).label||p||''; }
async function previewCloned(v){
  if(store.get('tts_engine')!=='custom'||!store.get('tts_ep')){
    toast('克隆音色走自定义 TTS 引擎：先在「我的」里配好 API 地址'); return;
  }
  loading(true,'试听合成中…');
  try{ await CustomTTS.speakWith(`大家好，我是${v.name}。这是我的克隆音色试听。`, v.voiceId); }
  catch(e){ toast('试听失败：'+e.message, 3000); }
  finally{ loading(false); }
}
function useCloned(v){
  if(!store.get('tts_ep')){ toast('先在「我的 → 朗读引擎」里填写自定义 TTS API 地址'); go('mine'); return; }
  store.set('tts_engine','custom'); store.set('tts_voice',v.voiceId);
  try{ $('#sel-engine').value='custom'; }catch(e){}
  toast(`已选用克隆音色「${v.name}」朗读`);
}

/* ---------- 克隆流程 ---------- */
let cloneBlob=null, cloneBlobName='';
function openCloneSheet(){
  cloneBlob=null; cloneBlobName='';
  $('#clone-step1').classList.remove('hidden');
  $('#clone-step2').classList.add('hidden');
  $('#clone-name').value='';
  $('#clone-provider-note').textContent=(CLONE_PROVIDERS[store.get('clone_provider','elevenlabs')]||{}).hint||'';
  openSheet('clone-sheet');
}
$('#btn-clone-new').onclick=openCloneSheet;
$('#btn-clone-close').onclick=()=>{ closeSheets(); stopRecord(); };

/* --- 来源1：录制 --- */
let recStream=null, recer=null, recChunks=[], recTimer=null, recSecs=0;
async function startRecord(){
  try{
    recStream=await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){ toast('麦克风不可用：'+e.message, 3000); return; }
  recChunks=[]; recSecs=0;
  recer=new MediaRecorder(recStream);
  recer.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
  recer.onstop=()=>{
    const blob=new Blob(recChunks,{type:recer.mimeType||'audio/webm'});
    recStream.getTracks().forEach(t=>t.stop()); recStream=null;
    if(blob.size<2000){ toast('录音太短，重录一次'); return; }
    setCloneSource(blob,'录音样本');
  };
  recer.start();
  $('#btn-rec').classList.add('recording'); $('#btn-rec').textContent='⏹ 停止（已录 0s）';
  recTimer=setInterval(()=>{
    recSecs++;
    $('#btn-rec').textContent=`⏹ 停止（已录 ${recSecs}s）`;
    if(recSecs>=90) stopRecord();
  },1000);
  toast('正在录音，请朗读 20 秒以上');
}
function stopRecord(){
  clearInterval(recTimer); recTimer=null;
  $('#btn-rec').classList.remove('recording'); $('#btn-rec').textContent='🎤 开始录制';
  if(recer&&recer.state!=='inactive'){ try{recer.stop();}catch(e){} }
  if(recStream){ recStream.getTracks().forEach(t=>t.stop()); recStream=null; }
}
$('#btn-rec').onclick=()=>{ (recer&&recer.state==='recording')?stopRecord():startRecord(); };
$('#btn-clone-pick-audio').onclick=()=>$('#clone-file-audio').click();
$('#btn-clone-pick-video').onclick=()=>$('#clone-file-video').click();

/* --- 来源2/3：上传音频 / 上传视频（提取音频） --- */
$('#clone-file-audio').onchange=e=>{
  const f=e.target.files[0]; e.target.value='';
  if(!f) return;
  if(f.size>60*1024*1024){ toast('音频太大（限60MB内）'); return; }
  setCloneSource(f, f.name);
};
$('#clone-file-video').onchange=async e=>{
  const f=e.target.files[0]; e.target.value='';
  if(!f) return;
  loading(true,'正在从视频提取音频（取前60秒）…');
  try{
    const blob=await extractAudioFromVideo(f);
    setCloneSource(blob, f.name.replace(/\.[^.]+$/,'')+'（音频）');
  }catch(err){ toast('提取失败：'+err.message+'，可改传纯音频', 3000); }
  finally{ loading(false); }
};
/* 从视频文件提取音频：静音播放 → captureStream → 录制 */
function extractAudioFromVideo(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const video=document.createElement('video');
    video.src=url; video.muted=true; video.playsInline=true; video.preload='auto';
    const cleanup=()=>{ URL.revokeObjectURL(url); video.remove(); };
    video.onloadedmetadata=async()=>{
      try{
        const dur=Math.min(60, video.duration||60);
        const stream=video.captureStream?video.captureStream():video.mozCaptureStream();
        if(!stream||!stream.getAudioTracks().length){ cleanup(); reject(new Error('这个视频没有音轨')); return; }
        const rec=new MediaRecorder(stream);
        const chunks=[];
        rec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
        rec.onstop=()=>{
          cleanup();
          const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});
          if(blob.size<2000){ reject(new Error('提取到的音频太短')); return; }
          resolve(blob);
        };
        rec.start();
        try{ await video.play(); }catch(e){ /* 自动播放被拦则直接录 */ }
        setTimeout(()=>{ try{rec.stop();}catch(e){} try{video.pause();}catch(e){} }, Math.max(8000,dur*1000));
      }catch(e){ cleanup(); reject(e); }
    };
    video.onerror=()=>{ cleanup(); reject(new Error('视频解码失败')); };
    setTimeout(()=>{ cleanup(); reject(new Error('超时')); }, 90000);
  });
}
function setCloneSource(blob, name){
  cloneBlob=blob; cloneBlobName=name;
  $('#clone-file-url').src=URL.createObjectURL(blob);
  $('#clone-src-name').textContent=name;
  $('#clone-step1').classList.add('hidden');
  $('#clone-step2').classList.remove('hidden');
  if(!$('#clone-name').value) $('#clone-name').value='我的音色';
}

/* --- 执行克隆 --- */
$('#btn-clone-do').onclick=async()=>{
  if(!cloneBlob){ toast('先准备参考音频'); return; }
  const provider=store.get('clone_provider','elevenlabs');
  const key=store.get('clone_key');
  if(!key){ toast('先在「我的 → 声音克隆服务」里填写 API Key'); return; }
  const name=$('#clone-name').value.trim()||'我的音色';
  loading(true,'正在云端克隆音色…');
  try{
    let voiceId='';
    if(provider==='elevenlabs'){
      const fd=new FormData();
      fd.append('name', name);
      fd.append('files', cloneBlob, 'sample.webm');
      const r=await fetch('https://api.elevenlabs.com/v1/voices/add',{
        method:'POST', headers:{'xi-api-key':key}, body:fd});
      if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error('ElevenLabs '+r.status+' '+t.slice(0,100)); }
      voiceId=(await r.json()).voice_id;
    }else{
      const ep=store.get('clone_ep');
      if(!ep) throw new Error('请先填写自定义克隆接口地址');
      const fd=new FormData();
      fd.append(store.get('clone_field_name','name')||'name', name);
      fd.append(store.get('clone_field_file','file')||'file', cloneBlob, 'sample.webm');
      const r=await fetch(ep,{method:'POST',
        headers:{...(key?{'Authorization':'Bearer '+key}:{})}, body:fd});
      if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error('接口 '+r.status+' '+t.slice(0,100)); }
      const j=await r.json().catch(()=>({}));
      const path=store.get('clone_id_path','voice_id')||'voice_id';
      voiceId=path.split('.').reduce((o,k)=>(o&&o[k]!==undefined)?o[k]:undefined, j);
    }
    if(!voiceId) throw new Error('接口返回中没有找到 voice id（检查「返回解析路径」设置）');
    const v={id:uid(), name, provider, voiceId:String(voiceId), createdAt:Date.now()};
    await idb.putVoice(v);
    try{ await idb.putFile('voice-'+v.id, await cloneBlob.arrayBuffer(), cloneBlobName||'sample'); }catch(e){}
    closeSheets();
    toast(`克隆成功：「${name}」已加入我的音色`);
    renderCloneList();
  }catch(e){
    toast('克隆失败：'+e.message, 3500);
  }finally{
    loading(false);
  }
};
$('#btn-clone-back').onclick=()=>{
  $('#clone-step2').classList.add('hidden');
  $('#clone-step1').classList.remove('hidden');
};

/* ================= AI多角色配音 =================
   流程：选书 → Gemini 解析全书角色 → 逐角色分配音色 → 朗读时按说话人自动切换。
   说话人识别是启发式（引号+说字/人名），旁白用默认音色。 */
let castBookId=null;

function extractJSONArray(raw){
  const a=raw.indexOf('['), b=raw.lastIndexOf(']');
  if(a<0||b<=a) throw new Error('AI 返回格式异常，换本书或重试');
  return JSON.parse(raw.slice(a,b+1));
}
function sampleForCast(book){
  const all=book.sentences.map(s=>s.t).join('\n');
  const head=all.slice(0,5000);
  let best='', bestQ=-1;
  for(let i=0;i<all.length&&i<120000;i+=4000){
    const seg=all.slice(i,i+6000);
    const q=(seg.match(/[“"]/g)||[]).length;
    if(q>bestQ){ bestQ=q; best=seg; }
  }
  const mid=(best&&best!==head)?best.slice(0,5000):'';
  return (head+'\n……\n'+mid).slice(0,10000);
}
async function analyzeCast(book){
  const sample=sampleForCast(book);
  const prompt=`你是小说人物分析师。请分析下面这本书的文本，提取主要人物角色（最多8个）。
只输出 JSON 数组，不要任何其他文字，不要 markdown 代码块。每项格式：
{"name":"人物名","gender":"男/女/未知","age":"青年/中年/老年/未知","traits":"性格特征，一句话","voice":"建议的音色风格，如：磁性大叔音/温柔少女音/沉稳旁白"}
文本节选：
${sample}`;
  const raw=await geminiAsk(prompt);
  const arr=extractJSONArray(raw);
  return arr.filter(c=>c&&c.name).slice(0,8);
}
/* 按性别+特征关键词，从广场自动匹配音色 */
function suggestVoiceFor(ch){
  const wantM=ch.gender==='男', wantF=ch.gender==='女';
  const pool=VOICE_CATALOG.filter(e=>wantM?e.gender==='m':wantF?e.gender==='f':true);
  const t=((ch.traits||'')+' '+(ch.voice||'')).toLowerCase();
  const kw={ '磁性':['磁性'], '温柔':['气声','亲切','甜美'], '甜美':['甜美','亲切'], '少年':['气声','清透'],
    '大叔':['磁性','烟嗓','深厚'], '御姐':['英气','磁性'], '沉稳':['沉稳','深厚','平稳'], '学者':['学术类','平稳'],
    '江湖':['烟嗓','磁性'], '播客':['松弛'], '悬疑':['中性'] };
  let best=null, bestS=-1;
  for(const e of pool){
    let s=0;
    for(const k in kw){ if(t.includes(k)) s+=e.tags.filter(tag=>kw[k].includes(tag)).length*2; }
    if(/老/.test(ch.age||'')) s+=e.tags.includes('深厚')?1:0;
    if(/青年/.test(ch.age||'')) s+=e.tags.includes('气声')?1:0;
    if(s>bestS){ bestS=s; best=e; }
  }
  return (best||pool[0]||VOICE_CATALOG[0]).name;
}

/* ---------- 角色编辑器 ---------- */
async function openCastSheet(bookId){
  const book=books.find(b=>b.id===bookId);
  if(!book){ toast('找不到这本书'); return; }
  castBookId=bookId;
  $('#cast-sheet').classList.remove('hidden');
  if(book.cast&&Object.keys(book.cast).length) renderCastEditor(book);
  else renderCastStart(book);
}
$('#btn-cast-close').onclick=()=>{ $('#cast-sheet').classList.add('hidden'); castBookId=null; };
function renderCastStart(book){
  $('#cast-body').innerHTML=`
    <div class="cast-start">
      <div class="empty-icon">🎭</div>
      <p class="serif" style="font-size:17px">《${esc(book.title)}》</p>
      <p class="sub">AI 将通读全书，解析出主要人物角色，<br>并为每个角色匹配合适的音色。<br>需要用到你在「我的」里填写的 Gemini Key。</p>
      <button class="btn-primary" id="btn-cast-go" style="width:100%;margin-top:14px">开始 AI 解析角色</button>
      <p class="hint" style="padding:12px 0 0">约需 1–3 分钟 · 只分析文本，不上传整本书</p>
    </div>`;
  $('#btn-cast-go').onclick=()=>runCastAnalysis(book);
}
async function runCastAnalysis(book){
  const body=$('#cast-body');
  const stages=['正在采样全书文本…','AI 正在解析人物角色…','正在为角色匹配音色…'];
  body.innerHTML=`<div class="cast-progress">
      <div class="spin"></div>
      <p class="serif" id="cast-stage">正在解析全书角色…</p>
      <p class="sub">大约需要 1–3 分钟，您可以稍后查看</p>
      <div class="pbar"><i id="cast-bar"></i></div></div>`;
  let si=0;
  const timer=setInterval(()=>{
    si=Math.min(si+1, stages.length-1);
    const el=$('#cast-stage'); if(el) el.textContent=stages[si];
    const bar=$('#cast-bar'); if(bar) bar.style.width=((si+1)/stages.length*100)+'%';
  }, 20000);
  try{
    const chars=await analyzeCast(book);
    if(!chars.length) throw new Error('没有识别出人物角色');
    book.castMeta=chars;
    book.cast={};
    chars.forEach(c=>{
      const vName=suggestVoiceFor(c);
      book.cast[c.name]={kind:'sys', ref:vName, label:vName};
    });
    book.cast['旁白']={kind:'default', ref:'', label:'跟随默认音色'};
    clearInterval(timer);
    renderCastEditor(book);
    toast('角色解析完成，为每个角色配好了音色');
  }catch(e){
    clearInterval(timer);
    body.innerHTML=`<div class="empty" style="padding:30px 20px">
      <p class="serif">解析失败</p><p class="sub">${esc(e.message)}</p>
      <button class="btn-ghost" id="btn-cast-retry" style="margin-top:10px">重试</button></div>`;
    $('#btn-cast-retry').onclick=()=>runCastAnalysis(book);
  }
}
async function voiceOptionsHTML(selected){
  // selected: "sys:名" | "clone:id" | "default"
  let opts=`<option value="default">跟随默认音色</option>`;
  opts+=`<optgroup label="广场音色">`+VOICE_CATALOG.map(e=>
    `<option value="sys:${esc(e.name)}">${esc(e.name)} · ${esc(e.tags.join('/'))}</option>`).join('')+`</optgroup>`;
  try{
    const vs=await idb.allVoices();
    if(vs.length) opts+=`<optgroup label="我的克隆">`+vs.map(v=>
      `<option value="clone:${v.id}">${esc(v.name)}</option>`).join('')+`</optgroup>`;
  }catch(e){}
  return opts;
}
async function renderCastEditor(book){
  const body=$('#cast-body');
  const chars=book.castMeta||Object.keys(book.cast||{}).filter(k=>k!=='旁白')
    .map(n=>({name:n, gender:'未知', traits:''}));
  body.innerHTML=`<p class="sub" style="margin:4px 0 12px">共 ${chars.length} 个角色 · 点试听可预览该角色音色</p><div id="cast-chars"></div>
    <div class="cast-narr"><span>🎙 旁白</span><span class="sub">使用默认朗读音色</span></div>
    <button class="btn-primary" id="btn-cast-save" style="width:100%;margin-top:14px">保存多角色配置</button>
    <button class="btn-ghost" id="btn-cast-clear" style="width:100%;margin-top:10px">清除多角色配置</button>`;
  const wrap=$('#cast-chars');
  const optsHTML=await voiceOptionsHTML();
  chars.forEach(c=>{
    const curSel=book.cast&&book.cast[c.name]
      ?(book.cast[c.name].kind==='sys'?'sys:'+book.cast[c.name].ref
        :book.cast[c.name].kind==='clone'?'clone:'+book.cast[c.name].ref:'default')
      :'sys:'+suggestVoiceFor(c);
    const d=document.createElement('div'); d.className='cast-char';
    d.innerHTML=`
      <div class="v-ava" style="background:${avaBG(c.name)}">${esc(c.name[0])}</div>
      <div class="v-info"><div class="v-name">${esc(c.name)}</div>
        <div class="v-desc">${esc([c.gender,c.age,c.traits].filter(Boolean).join(' · '))}</div></div>
      <div class="cast-sel">
        <select data-char="${esc(c.name)}">${optsHTML}</select>
        <button class="v-btn play" title="试听">▶</button>
      </div>`;
    const sel=d.querySelector('select'); sel.value=curSel;
    d.querySelector('.play').onclick=()=>{
      const v=sel.value;
      if(v.startsWith('sys:')){
        const e=VOICE_CATALOG.find(x=>x.name===v.slice(4));
        if(e) previewCatalog(e);
      }else if(v.startsWith('clone:')){
        idb.allVoices().then(vs=>{ const vc=vs.find(x=>x.id===v.slice(6)); if(vc) previewCloned(vc); });
      }else toast('旁白使用默认音色');
    };
    wrap.appendChild(d);
  });
  $('#btn-cast-save').onclick=async()=>{
    book.cast=book.cast||{};
    book.castMeta=chars;
    wrap.querySelectorAll('select').forEach(sel=>{
      const cn=sel.dataset.char, v=sel.value;
      if(v.startsWith('sys:')) book.cast[cn]={kind:'sys', ref:v.slice(4), label:v.slice(4)};
      else if(v.startsWith('clone:')) book.cast[cn]={kind:'clone', ref:v.slice(6), label:'克隆音色'};
      else book.cast[cn]={kind:'default', ref:'', label:'默认'};
    });
    book.cast['旁白']={kind:'default', ref:'', label:'默认'};
    await saveBook(); book._lastSpk=null;
    toast('多角色配置已保存，播放时自动切换');
    $('#cast-sheet').classList.add('hidden');
    renderCastBooks();
  };
  $('#btn-cast-clear').onclick=async()=>{
    if(!confirm('清除这本书的多角色配置？')) return;
    delete book.cast; delete book.castMeta; book._lastSpk=null;
    await saveBook();
    $('#cast-sheet').classList.add('hidden'); renderCastBooks(); toast('已清除');
  };
}

/* ---------- 说话人识别（启发式） ---------- */
const SAY_WORDS='说|道|问|笑|喊|叫|答|叹|喃喃|低语|大声|冷笑|苦笑';
function detectSpeaker(text, book){
  const cast=book.cast||{};
  const names=Object.keys(cast).filter(k=>k!=='旁白');
  if(!names.length) return null;
  // “……”X说 / X说：“……”
  let m=text.match(/[”"』」]\s*([^，。！？；：“”"『』「」\s]{1,6}?)(说|道|问|笑|喊|叫|答|叹)/);
  if(!m) m=text.match(/^\s*([^，。！？；：“”"『』「」\s]{1,6}?)(说|道|问|笑|喊|叫|答|叹)[：:]/);
  if(m){
    if(cast[m[1]]){ book._lastSpk=m[1]; return m[1]; }
    // 明确出现了说话人，但不是配置里的人物 → 用旁白，不沿用上一说话人
    book._lastSpk=null;
    return '旁白';
  }
  // 纯对话：沿用上一说话人
  if(/^\s*[“"『「]/.test(text)){
    if(book._lastSpk&&cast[book._lastSpk]) return book._lastSpk;
    for(const n of names){ if(text.includes(n)){ book._lastSpk=n; return n; } }
  }
  book._lastSpk=null;
  return '旁白';
}
/* 给定一句，返回该用的音色目标；null = 走默认 */
function castVoiceFor(text, book){
  if(!book.cast||!Object.keys(book.cast).length) return null;
  const key=detectSpeaker(text, book);
  const cfg=book.cast[key];
  if(!cfg||cfg.kind==='default') return null;
  if(cfg.kind==='sys'){
    const e=VOICE_CATALOG.find(x=>x.name===cfg.ref);
    const v=e?resolveCatalogVoice(e):null;
    return v?{kind:'system', voice:v}:null;
  }
  if(cfg.kind==='clone') return {kind:'custom', voiceId:cfg.ref};
  return null;
}

/* ---------- 多角色 tab：书列表 ---------- */
async function renderCastBooks(){
  const box=$('#cast-books'); if(!box) return;
  box.innerHTML='';
  try{ await loadBooks(); }catch(e){}
  const withCast=books.filter(b=>b.cast&&Object.keys(b.cast).length);
  const head=document.createElement('div');
  head.innerHTML=`<p class="sub" style="margin:4px 0 12px">AI 通读全书 → 解析人物 → 分角色朗读<br>已有配置 ${withCast.length} 本</p>`;
  box.appendChild(head);
  if(withCast.length){
    withCast.forEach(b=>{
      const n=Object.keys(b.cast).filter(k=>k!=='旁白').length;
      const d=document.createElement('div'); d.className='book-row';
      d.innerHTML=`<div class="cov-wrap">${coverHTML(b,'sm')}</div>
        <div class="info"><div class="title">${esc(b.title)}</div>
        <div class="meta">${n} 个角色 · 已配置多角色</div></div>
        <button class="btn-ghost sm">管理</button>`;
      d.querySelector('button').onclick=e=>{ e.stopPropagation(); openCastSheet(b.id); };
      d.onclick=()=>openDetail(b.id);
      box.appendChild(d);
    });
  }
  const div=document.createElement('div');
  div.innerHTML=`<div class="sec" style="font-size:13px;color:var(--sub);font-weight:700;margin:18px 0 8px">为其他书配置</div><div id="cast-all"></div>`;
  box.appendChild(div);
  const all=$('#cast-all');
  books.filter(b=>!(b.cast&&Object.keys(b.cast).length)).slice(0,20).forEach(b=>{
    const d=document.createElement('div'); d.className='book-row';
    d.innerHTML=`<div class="cov-wrap">${coverHTML(b,'sm')}</div>
      <div class="info"><div class="title">${esc(b.title)}</div>
      <div class="meta">${b.total} 句</div></div>
      <button class="btn-ghost sm">🎭 解析</button>`;
    d.querySelector('button').onclick=e=>{ e.stopPropagation(); openCastSheet(b.id); };
    d.onclick=()=>openDetail(b.id);
    all.appendChild(d);
  });
  if(!books.length) box.innerHTML='<div class="empty"><div class="empty-icon">📚</div><p class="sub">先去导入一本书</p></div>';
}

/* ---------- 声音视图 ---------- */
function renderVoice(){
  document.querySelectorAll('.vt').forEach(t=>{
    const on=t.classList.contains('cur');
    $('#vt-'+t.dataset.t).classList.toggle('hidden', !on);
  });
  renderPlaza(); renderCloneList(); renderCastBooks();
}
document.querySelectorAll('.vt').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.vt').forEach(x=>x.classList.remove('cur'));
  t.classList.add('cur'); renderVoice();
});
