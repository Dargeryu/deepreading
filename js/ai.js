/* AI 能力：Gemini 辅助阅读 / 正版搜书 / 自定义 TTS API
Key 只存本机 localStorage，不经过任何服务器。 */
'use strict';
const store = {
get:(k,d='')=>{ try{return localStorage.getItem('dr_'+k)??d;}catch(e){return d;}},
set:(k,v)=>{ try{localStorage.setItem('dr_'+k,v);}catch(e){}},
};

/* ---------- Gemini ---------- */
async function geminiAsk(prompt){
const key=store.get('gemini_key');
if(!key) throw new Error('请先在设置里填写 Gemini API Key（Google AI Studio 获取）');
const model=store.get('gemini_model','gemini-3.8-flash')||'gemini-3.8-flash';
const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{
method:'POST', headers:{'Content-Type':'application/json'},
body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})});
if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error('Gemini 请求失败 '+r.status+' '+t.slice(0,120));}
const j=await r.json();
const txt=j.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
if(!txt) throw new Error('Gemini 无返回');
return txt;
}
const PROMPTS={
explain:t=>`你是一位耐心博学的阅读助手。请讲解下面这段文字：讲清它的意思、背景和关键点，语言简洁。\n\n${t}`,
feynman:t=>`你是一位费曼学习法教练。请用最简单的大白话重新讲一遍下面这段文字，就像讲给一个12岁的孩子听：多打比方，不用术语。结构：先一句话说核心，再分3点讲透，最后出1道自测题。\n\n${t}`,
analogy:t=>`请把下面这个概念用一个生动的日常类比讲清楚，并输出恰好4格分镜。每格格式：一句话描述画面；（解说）一句话解说。类比要贴切，语言生动。\n\n概念：${t}`,
};

/* ---------- 正版搜书 ---------- */
async function searchOL(q){
const r=await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=12&fields=key,title,author_name,first_publish_year`);
const j=await r.json();
return (j.docs||[]).map(d=>({title:d.title, author:(d.author_name||[]).join(', '),
year:d.first_publish_year||'', url:`https://openlibrary.org${d.key}`, dl:''}));
}
async function searchGB(q){
const r=await fetch(`https://gutendex.com/books?search=${encodeURIComponent(q)}`);
const j=await r.json();
return (j.results||[]).slice(0,12).map(b=>({title:b.title,
author:(b.authors||[]).map(a=>a.name).join(', '), year:'',
url:'', dl:(b.formats||{})['application/epub+zip']||''}));
}

/* ---------- 自定义 TTS API（含克隆音色） ---------- */
const CustomTTS=(()=>{
let audio=null, stopped=false;
function cfg(){ return {ep:store.get('tts_ep'), key:store.get('tts_key'), voice:store.get('tts_voice')};}
async function speak(text, voiceId){
const {ep,key,voice}=cfg();
if(!ep) throw new Error('请先在设置里填写自定义 TTS API 地址');
stopped=false;
const r=await fetch(ep,{method:'POST',
headers:{'Content-Type':'application/json',...(key?{'Authorization':'Bearer '+key,'xi-api-key':key}:{})},
body:JSON.stringify({text, voice_id:voiceId||voice})});
if(!r.ok) throw new Error('TTS API 失败 '+r.status);
const blob=await r.blob();
const url=URL.createObjectURL(blob);
await new Promise((res,rej)=>{
audio=new Audio(url);
audio.onended=()=>{URL.revokeObjectURL(url);res();};
audio.onerror=()=>rej(new Error('音频播放失败'));
if(stopped){URL.revokeObjectURL(url);res();} else audio.play().catch(rej);
});
}
async function speakWith(text, voiceId){ return speak(text, voiceId); }
function stop(){ stopped=true; if(audio){audio.pause();audio=null;}}
return {speak, speakWith, stop};
})();
