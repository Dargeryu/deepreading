/* 背景音：Web Audio 合成，无需音频文件 */
'use strict';
const Ambience = (()=>{
  let ctx=null, nodes=null, cur='', master=null;
  function noiseBuffer(sec=3){
    const b=ctx.createBuffer(1, ctx.sampleRate*sec, ctx.sampleRate);
    const d=b.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    return b;
  }
  function start(type, vol){
    stop();
    ctx = ctx || new (window.AudioContext||window.webkitAudioContext)();
    if(ctx.state==='suspended') ctx.resume();
    const g=ctx.createGain(); g.gain.value=vol; g.connect(ctx.destination);
    const src=ctx.createBufferSource(); src.buffer=noiseBuffer(); src.loop=true;
    const f=ctx.createBiquadFilter();
    if(type==='rain'){ f.type='lowpass'; f.frequency.value=900;
      // 雨滴随机滴答
      const lfo=ctx.createOscillator(), lg=ctx.createGain();
      lfo.frequency.value=0.4; lg.gain.value=300; lfo.connect(lg); lg.connect(f.frequency); lfo.start();
      nodes=[src,f,g,lfo,lg];
    } else if(type==='cafe'){ f.type='bandpass'; f.frequency.value=500; f.Q.value=0.6;
      const lfo=ctx.createOscillator(), lg=ctx.createGain();
      lfo.frequency.value=0.13; lg.gain.value=0.35; lfo.connect(lg); lg.connect(g.gain); lfo.start();
      nodes=[src,f,g,lfo,lg];
    } else if(type==='white'){ f.type='lowpass'; f.frequency.value=6000; nodes=[src,f,g];
    } else if(type==='forest'){ f.type='highpass'; f.frequency.value=2500;
      const lfo=ctx.createOscillator(), lg=ctx.createGain();
      lfo.frequency.value=0.07; lg.gain.value=0.5; lfo.connect(lg); lg.connect(g.gain); lfo.start();
      nodes=[src,f,g,lfo,lg];
    }
    src.connect(f); f.connect(g); src.start();
    master=g; cur=type;
  }
  function stop(){
    if(nodes){ nodes.forEach(n=>{try{n.stop&&n.stop()}catch(e){} try{n.disconnect()}catch(e){}}); nodes=null; }
    master=null; cur='';
  }
  function setVolume(v){ if(master) master.gain.value=v; }
  return { start, stop, setVolume, get cur(){return cur;} };
})();
