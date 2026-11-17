/* Dozo landing script. Theme: ?theme=light (default dark) plus the header toggle.
   ?still shows every scene in its final state (also the prefers-reduced-motion behaviour).
   Avatars: same symbols and eye-tracking as design/d/dozo.js, plus an idle life. */
const root=document.documentElement;
const qs=new URLSearchParams(location.search);
if(qs.get('theme')==='light')root.dataset.theme='light';
const SYMBOLS=`<symbol id="a-sora" viewBox="0 0 64 64"><rect class="t1" width="64" height="64" rx="18"/><g class="head"><rect x="30.5" y="9" width="3" height="10" rx="1.5" fill="#eef0f4"/><g class="feature"><circle cx="32" cy="9" r="3.5" fill="#bfe0ff"/></g><circle cx="32" cy="36" r="18" fill="#eef0f4"/><rect x="20" y="30" width="24" height="13" rx="6.5" fill="#14161c"/><g class="eyes"><circle cx="27" cy="36.5" r="2.6" fill="#bfe0ff"/><circle cx="37" cy="36.5" r="2.6" fill="#bfe0ff"/></g></g></symbol>
  <symbol id="a-kumo" viewBox="0 0 64 64"><rect class="t2" width="64" height="64" rx="18"/><g class="head"><g class="feature"><rect x="22" y="11" width="3" height="10" rx="1.5" fill="#eef0f4"/><rect x="39" y="11" width="3" height="10" rx="1.5" fill="#eef0f4"/></g><rect x="15" y="20" width="34" height="30" rx="9" fill="#eef0f4"/><rect x="20" y="28" width="24" height="14" rx="5" fill="#14161c"/><g class="eyes"><rect x="23.5" y="34.5" width="6" height="3" rx="1.5" fill="#e2d6ff"/><rect x="34.5" y="34.5" width="6" height="3" rx="1.5" fill="#e2d6ff"/></g></g></symbol>
  <symbol id="a-hana" viewBox="0 0 64 64"><rect class="t3" width="64" height="64" rx="18"/><g class="head"><rect x="30" y="17" width="4" height="8" rx="0" fill="#eef0f4"/><g class="feature"><circle cx="32" cy="15" r="3.5" fill="#c4f2d9"/></g><rect x="10" y="24" width="44" height="26" rx="13" fill="#eef0f4"/><rect x="16" y="30" width="32" height="14" rx="7" fill="#14161c"/><g class="eyes"><rect x="21" y="35.2" width="22" height="3.6" rx="1.8" fill="#c4f2d9"/></g></g></symbol>
  <symbol id="a-taro" viewBox="0 0 64 64"><rect class="t4" width="64" height="64" rx="18"/><g class="head"><rect x="18" y="12" width="28" height="42" rx="13" fill="#eef0f4"/><g class="feature"><rect x="18" y="26" width="28" height="4" rx="0" fill="var(--taro)"/></g><rect x="22" y="33" width="20" height="15" rx="7" fill="#14161c"/><g class="eyes"><ellipse cx="28" cy="40.5" rx="2.3" ry="3.3" fill="#ffe2ae"/><ellipse cx="36" cy="40.5" rx="2.3" ry="3.3" fill="#ffe2ae"/></g></g></symbol>
  <symbol id="a-yuki" viewBox="0 0 64 64"><rect class="t5" width="64" height="64" rx="18"/><g class="head"><g class="feature"><circle cx="12" cy="35" r="4.5" fill="#eef0f4"/><circle cx="52" cy="35" r="4.5" fill="#eef0f4"/></g><rect x="14" y="18" width="36" height="34" rx="16" fill="#eef0f4"/><rect x="19" y="27" width="26" height="15" rx="7.5" fill="#14161c"/><g class="eyes"><circle cx="27" cy="34.5" r="2.7" fill="#ffd0c6"/><path d="M33.5 35q3.5-3.4 7 0" fill="none" stroke="#ffd0c6" stroke-width="2.6" stroke-linecap="round"/></g></g></symbol>
  <symbol id="a-mochi" viewBox="0 0 64 64"><rect class="t6" width="64" height="64" rx="18"/><g class="head"><g class="feature"><ellipse cx="41" cy="13" rx="3" ry="8.5" transform="rotate(28 41 13)" fill="#b8f0f0"/></g><rect x="15" y="21" width="34" height="30" rx="11" fill="#eef0f4"/><rect x="20" y="29" width="24" height="14" rx="7" fill="#14161c"/><g class="eyes"><path d="M24 38q3-5 6 0M34 38q3-5 6 0" fill="none" stroke="#b8f0f0" stroke-width="2.6" stroke-linecap="round"/></g></g></symbol>`;
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const still=qs.has('still')||reduce;
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),rnd=(a,b)=>a+Math.random()*(b-a);
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

addEventListener('DOMContentLoaded',()=>{
$('#theme').addEventListener('click',()=>{if(root.dataset.theme==='light')delete root.dataset.theme;else root.dataset.theme='light'});
$('#sym').innerHTML=SYMBOLS;
// logo: eyes glance toward the pointer on hover; one gesture on load and on tap for touch
$$('.lock').forEach(l=>{
  const eyes=$('.eyes',l),play=()=>{l.classList.add('play');setTimeout(()=>l.classList.remove('play'),950)};
  l.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;const r=eyes.getBoundingClientRect();
    l.style.setProperty('--ex',(Math.max(-1,Math.min(1,(e.clientX-r.left-r.width/2)/60))*3).toFixed(2)+'px');
    l.style.setProperty('--ey',(Math.max(-1,Math.min(1,(e.clientY-r.top-r.height/2)/40))*2).toFixed(2)+'px')});
  l.addEventListener('pointerleave',()=>{l.style.removeProperty('--ex');l.style.removeProperty('--ey')});
  l.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')play()});
  if(qs.get('logo')==='hover')l.classList.add('play');
});
if(!reduce&&!qs.has('logo'))setTimeout(()=>$('.top .lock').classList.add('play'),1400),setTimeout(()=>$('.top .lock').classList.remove('play'),2400);
document.addEventListener('visibilitychange',()=>root.classList.toggle('paused',document.hidden));

// ---- scenes: run only while on screen and the tab is visible; calm pauses between loops
const on=el=>{if(document.hidden)return false;const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}; // on screen, tab visible
const until=async el=>{while(!on(el))await sleep(100)};
const wait=el=>async ms=>{let t=0,last=performance.now();while(t<ms){await sleep(Math.min(100,ms-t));const n=performance.now();if(on(el))t+=n-last;last=n}};
function scene(el,run,loop=true){
  if(still)return;
  el.classList.add('anim');
  (async()=>{do{await until(el);await run(el,wait(el))}while(loop)})();
}
const flip=(el,cls,on=true)=>el.classList.toggle(cls,on);
async function fadeReset(el,w,reset){ // fade out, reset without transitions, no layout jump
  flip(el,'out');await w(700);flip(el,'nt');reset();el.offsetWidth;flip(el,'out',false);flip(el,'nt',false);
}

// 1. hero chat
const hero=$('#hero'),body=$('#body',hero),full=body.dataset.full;
const blank=()=>body.innerHTML='<span class="rest">'+esc(full)+'</span>';
const status=(t,c)=>{$('#ht').textContent=t;$('#hd').className='dot'+(c?' '+c:'')};
if(!still)blank();
scene(hero,async(el,w)=>{
  const show=(s,v=true)=>$$(s,el).forEach(e=>flip(e,'show',v));
  await w(500);show('.user');
  await w(900);show('.think');
  await w(1700);show('.think',false);show('.slot > p');
  await w(500);for(const li of $$('.plan li',el)){li.classList.add('show');await w(450)}
  await w(300);show('.draft');await w(600);
  for(let i=0;i<=full.length;i+=2){body.innerHTML=esc(full.slice(0,i))+'<span class="rest">'+esc(full.slice(i))+'</span>';await w(40)}
  await w(600);show('.ask');status('Waiting for you','wait');
  await w(2400);const ap=$('.ask .w',el);flip(ap,'press');await w(250);flip(ap,'press',false);
  show('.ask',false);show('.sent');status('Done');
  await w(3400);
  await fadeReset($('.conv',el),w,()=>{show('.s',false);show('.sent',false);show('.think',false);blank();status('Working')});
  await w(900);
});

// 2. computer
scene($('#comp'),async(el,w)=>{
  const scr=$('.p-screen',el),term=$('.p-term',el),cur=$('.cur',el),bar=$('.hlbar',el),tabs=$$('.tabs span',el),lines=$$('div',term);
  const pg=$('.pg',el),row=$$('tr',el)[2],pr=pg.getBoundingClientRect(),rr=row.getBoundingClientRect();
  const to=(x,y)=>cur.style.transform=`translate(${x}px,${y}px)`;
  const home=()=>{cur.style.transition='none';to(pr.width-40,pr.height-30);cur.offsetWidth;cur.style.transition=''};
  const tab=i=>tabs.forEach((t,j)=>flip(t,'on',i===j));
  home();await w(900);cur.style.opacity=1;
  to(pr.width*.38,rr.top-pr.top+rr.height/2-4);
  await w(1300);bar.style.transform=`translateY(${rr.top-pr.top}px)`;bar.style.opacity=1;
  await w(400);flip(cur,'click');await w(160);flip(cur,'click',false);
  await w(1200);tab(2);flip(scr,'off');flip(term,'on');
  for(const l of lines){await w(650);flip(l,'show')}
  await w(1800);tab(0);flip(term,'on',false);flip(scr,'off',false);lines.forEach(l=>flip(l,'show',false));
  bar.style.opacity=0;cur.style.opacity=0;await w(1000);home();await w(1800);
});

// 3. requests arrive, one gets approved
scene($('#asks'),async(el,w)=>{
  const list=$('.list',el),rs=$$('.li',el),b=$('.pill',rs[0]);
  await w(700);for(const r of rs){flip(r,'show');await w(1100)}
  await w(900);flip(b,'press');await w(250);flip(b,'press',false);b.textContent='Approved';flip(b,'ok');flip(rs[0],'done');
  await w(2800);
  await fadeReset(list,w,()=>{rs.forEach(r=>{flip(r,'show',false);flip(r,'done',false)});b.textContent='Review';flip(b,'ok',false)});
  await w(900);
});

// 4. run on this computer: detect, then rows, then a live readout
const panel=$('#panel'),hw=$('#hw'),mem=$('#mem'),list=$('#mods');
const K={laptop:90,air:240,max:600,tower:520}; // example tokens/s x GB, illustration only
const M=[['Tiny model 1B',1.2],['Small model 4B',3],['Medium model 12B',8],['Large model 27B',17]];
let chosen=null;
function rows(){const gb=+mem.value,k=K[hw.value];return M.filter(([,s])=>s*1.3<=gb&&k/s>=25).slice(-3).reverse().map(([n,s])=>[n,s,Math.round(k/s)])}
function render(){
  list.innerHTML=rows().map(([n,s,t],i)=>`<li${still?' class="in"':''}><div class="n"><b>${n}</b><span>${s} GB</span></div><span class="t" data-b="${t}">${t} tokens/s</span><button class="pill${i?'':' w'}" type="button" aria-pressed="${chosen===n}" data-m="${n}">${chosen===n?'Connected':'Connect'}</button></li>`).join('')||'<li><div class="n"><span>No model fits this memory.</span></div></li>';
}
const reveal=()=>$$('li',list).forEach((li,i)=>setTimeout(()=>li.classList.add('in'),i*160));
let tok=0;
async function detect(ms){const me=++tok;flip(panel,'scan');render();await sleep(ms);if(me!==tok)return;flip(panel,'scan',false);reveal()}
list.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;chosen=chosen===b.dataset.m?null:b.dataset.m;render();$$('li',list).forEach(li=>li.classList.add('in'))});
if(still){render()}
else{
  panel.classList.add('anim','scan');render();
  const sel=()=>detect(500);
  hw.addEventListener('change',sel);mem.addEventListener('change',sel);
  (async()=>{await until(panel);await sleep(300);await detect(1500)})();
  setInterval(()=>{if(!on(panel)||panel.classList.contains('scan'))return;
    $$('.t',list).forEach(t=>t.textContent=Math.max(25,+t.dataset.b+Math.round(rnd(-1.4,1.4)))+' tokens/s')},1100);
}

// ---- bots: eyes follow the pointer; blink, bob, tilt and glance when it is away
const LIM={sora:[3.2,2.6],kumo:[2.5,3],hana:[3.5,2],taro:[2.7,3],yuki:[3.5,3],mochi:[2,2.5]};
const GAIN={working:.8,waiting:1,idle:.8},SLEEP={open:.3,gain:.15};
const RATE=reduce?3:10,BLINK=reduce?220:120,R=240;
let px=null,py=null,last=0,moved=-1e9;
const bots=$$('.bot').map(el=>{
  const name=el.dataset.bot,svg=el.querySelector('svg'),sym=document.getElementById('a-'+name);
  if(!svg||!sym||!LIM[name])return null;
  svg.replaceChildren(...[...sym.children].map(c=>c.cloneNode(true)));
  const b={el,svg,eyes:svg.querySelector('.eyes'),state:el.dataset.state||'idle',lim:LIM[name],x:0,y:0,awake:false,cx:0,cy:0,bs:-1e9,next:rnd(800,4000),str:'',gx:0,gy:0,gnext:rnd(1500,5000),gend:0,tnext:rnd(3000,9000)};
  b.open=b.state==='idle'?SLEEP.open:1;
  svg.querySelector('.head').style.animationDelay=-rnd(0,3)+'s';
  el.addEventListener('pointerenter',()=>{b.awake=true;clearTimeout(b.tm);el.classList.add('hop')});
  el.addEventListener('pointerleave',()=>{b.tm=setTimeout(()=>b.awake=false,900)});
  svg.addEventListener('animationend',e=>{if(e.target===svg)el.classList.remove('hop','tilt')});
  return b;
}).filter(Boolean);
const measure=()=>bots.forEach(b=>{const r=b.el.getBoundingClientRect();b.cx=r.left+r.width/2;b.cy=r.top+r.height/2});
const away=()=>px=null;
addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;px=e.clientX;py=e.clientY;moved=performance.now()},{passive:true});
root.addEventListener('pointerleave',away);root.addEventListener('mouseleave',away);addEventListener('blur',away);
addEventListener('resize',measure);addEventListener('scroll',measure,{passive:true});
const clamp=(v,m)=>Math.max(-m,Math.min(m,v));
function glance(b){ // look toward a neighbour in the same row, else somewhere calm
  const near=bots.filter(o=>o!==b&&Math.abs(o.cy-b.cy)<30).sort((p,q)=>Math.abs(p.cx-b.cx)-Math.abs(q.cx-b.cx))[0];
  const d=near?Math.sign(near.cx-b.cx):Math.random()<.5?-1:1;
  b.gx=d*b.lim[0]*rnd(.7,1);b.gy=rnd(-.3,.3)*b.lim[1];
}
function tick(t){
  const dt=Math.min((t-last)/1000,.05);last=t;const k=1-Math.exp(-dt*RATE);
  const idle=px==null||t-moved>3500;
  for(const b of bots){
    const sleep=b.state==='idle'&&!b.awake,g=sleep?SLEEP.gain:GAIN[b.state]||.8;
    if(!reduce){
      if(t>=b.gnext){glance(b);b.gend=t+rnd(900,1500);b.gnext=t+rnd(3500,8000)}
      if(b.gend&&t>=b.gend){b.gx=b.gy=0;b.gend=0}
      if(t>=b.tnext){b.el.classList.add('tilt');b.tnext=t+rnd(5000,11000)}
    }
    const tx=idle?b.gx*g:clamp((px-b.cx)/R,1)*b.lim[0]*g,ty=idle?b.gy*g:clamp((py-b.cy)/R,1)*b.lim[1]*g;
    b.x+=(tx-b.x)*k;b.y+=(ty-b.y)*k;b.open+=((sleep?SLEEP.open:1)-b.open)*(1-Math.exp(-dt*5));
    let bl=1;
    if(t>=b.next){b.bs=t;b.next=t+(Math.random()<.2?260:rnd(2500,6000))}
    const p=(t-b.bs)/BLINK;if(p<1&&!sleep)bl=1-.9*Math.sin(Math.PI*p);
    const s=`translate(${b.x.toFixed(2)}px,${b.y.toFixed(2)}px) scaleY(${(b.open*bl).toFixed(3)})`;
    if(s!==b.str){b.eyes.style.transform=s;b.str=s}
  }
  requestAnimationFrame(tick);
}
measure();requestAnimationFrame(tick);
});
