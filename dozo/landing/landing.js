/* Dozo landing script. Theme: ?theme=light (default dark) plus the header toggle.
   ?still shows every scene in its final state (also the prefers-reduced-motion behaviour).
   Avatars: same symbols and eye-tracking as design/d/dozo.js, plus an idle life. */
const root=document.documentElement;
const qs=new URLSearchParams(location.search);
if(qs.get('theme')==='light')root.dataset.theme='light';
const SYMBOLS=`<symbol id="a-sora" viewBox="0 0 64 64"><g class="head"><path class="b" d="M32 24L43 24C50.04 24 54 27.96 54 35L54 38C54 52.08 46.08 60 32 60L21 60C13.96 60 10 56.04 10 49L10 46C10 31.92 17.92 24 32 24ZM21.76 38.71L40.66 36.39A5.98 5.98 0 0 1 47.32 41.59L47.45 42.63A5.98 5.98 0 0 1 42.24 49.29L23.34 51.61A5.98 5.98 0 0 1 16.68 46.41L16.55 45.37A5.98 5.98 0 0 1 21.76 38.71Z"/><g class="feature"><path class="t1" d="M29.57 7.26Q32 5.5 34.43 7.26L58.57 24.74Q61 26.5 58 26.5L6 26.5Q3 26.5 5.43 24.74Z" transform="rotate(-6 32 24)"/></g><g class="eyes"><circle class="b" cx="26.64" cy="44.66" r="2.9"/><circle class="b" cx="37.36" cy="43.34" r="2.9"/></g></g></symbol>
  <symbol id="a-kumo" viewBox="0 0 64 64"><g class="head"><g class="feature"><path class="b" d="M12.9 36.34Q10.4 38 10.55 35L11.85 9.5Q12 6.5 14.23 8.5L29.27 22Q31.5 24 29 25.66Z"/><path class="b" d="M51.1 36.34Q53.6 38 53.45 35L52.15 9.5Q52 6.5 49.77 8.5L34.73 22Q32.5 24 35 25.66Z"/><path class="t2" d="M16.08 24.38Q14.6 25 14.68 23.4L15.12 15.1Q15.2 13.5 16.32 14.65L21.88 20.35Q23 21.5 21.52 22.12Z"/><path class="t2" d="M47.92 24.38Q49.4 25 49.32 23.4L48.88 15.1Q48.8 13.5 47.68 14.65L42.12 20.35Q41 21.5 42.48 22.12Z"/></g><path class="b" d="M22 21L42 21C49.68 21 54 25.32 54 33L54 37C54 51.08 46.08 59 32 59L26 59C15.76 59 10 53.24 10 43L10 33C10 25.32 14.32 21 22 21ZM21.76 36.21L40.66 33.89A5.98 5.98 0 0 1 47.32 39.09L47.45 40.13A5.98 5.98 0 0 1 42.24 46.79L23.34 49.11A5.98 5.98 0 0 1 16.68 43.91L16.55 42.87A5.98 5.98 0 0 1 21.76 36.21Z"/><g class="eyes"><ellipse class="b" cx="26.64" cy="42.16" rx="2.4" ry="3.4" transform="rotate(-7 26.64 42.16)"/><ellipse class="b" cx="37.36" cy="40.84" rx="2.4" ry="3.4" transform="rotate(-7 37.36 40.84)"/></g></g></symbol>
  <symbol id="a-hana" viewBox="0 0 64 64"><g class="head"><rect class="t3" x="38" y="15.6" width="21" height="2.8" rx="1.4" transform="rotate(-38 38 17)"/><g class="feature"><circle class="t3" cx="55" cy="3" r="2.5"/><circle class="t3" cx="58.04" cy="5.21" r="2.5"/><circle class="t3" cx="56.88" cy="8.79" r="2.5"/><circle class="t3" cx="53.12" cy="8.79" r="2.5"/><circle class="t3" cx="51.96" cy="5.21" r="2.5"/><circle class="b" cx="55" cy="6.2" r="1.5"/></g><circle class="b" cx="41.5" cy="16.5" r="7.6"/><path class="b" d="M31 21L35 21C45.88 21 52 27.12 52 38L52 37C52 51.72 43.72 60 29 60L25 60C14.12 60 8 53.88 8 43L8 44C8 29.28 16.28 21 31 21ZM19.76 36.21L38.66 33.89A5.98 5.98 0 0 1 45.32 39.09L45.45 40.13A5.98 5.98 0 0 1 40.24 46.79L21.34 49.11A5.98 5.98 0 0 1 14.68 43.91L14.55 42.87A5.98 5.98 0 0 1 19.76 36.21Z"/><g class="eyes"><circle class="b" cx="24.64" cy="42.16" r="2.9"/><circle class="b" cx="35.36" cy="40.84" r="2.9"/></g></g></symbol>
  <symbol id="a-taro" viewBox="0 0 64 64"><g class="head"><path class="b" d="M26 10L38 10C46.32 10 51 14.68 51 23L51 38C51 50.16 44.16 57 32 57L24 57C14.4 57 9 51.6 9 42L9 27C9 16.12 15.12 10 26 10ZM20.75 32.59L37.66 30.51A5.98 5.98 0 0 1 44.33 35.72L44.46 36.75A5.98 5.98 0 0 1 39.25 43.41L22.34 45.49A5.98 5.98 0 0 1 15.67 40.28L15.54 39.25A5.98 5.98 0 0 1 20.75 32.59Z"/><rect class="t4" x="8" y="20.8" width="44" height="4.6" rx="1.4" transform="rotate(-7 30 23.1)"/><g class="feature"><path class="t4" d="M0 -0.3Q0 -1.1 0.79 -1.19L12.21 -2.51Q13 -2.6 12.58 -1.92L11.82 -0.68Q11.4 0 11.82 0.68L12.58 1.92Q13 2.6 12.21 2.51L0.79 1.19Q0 1.1 0 0.3Z" transform="translate(51.6 20.6) rotate(-46)"/><path class="t4" d="M0 -0.3Q0 -1.1 0.79 -1.2L11.21 -2.5Q12 -2.6 11.58 -1.92L10.82 -0.68Q10.4 0 10.82 0.68L11.58 1.92Q12 2.6 11.21 2.5L0.79 1.2Q0 1.1 0 0.3Z" transform="translate(51.6 20.6) rotate(8)"/><rect class="t4" x="48.2" y="17.2" width="6.8" height="6.8" rx="2.2" transform="rotate(-7 51.6 20.6)"/></g><g class="eyes"><circle class="b" cx="24.64" cy="38.66" r="2.9"/><circle class="b" cx="35.36" cy="37.34" r="2.9"/></g></g></symbol>
  <symbol id="a-yuki" viewBox="0 0 64 64"><g class="head"><g class="feature"><ellipse class="b" cx="25" cy="16" rx="4.6" ry="12" transform="rotate(-9 25 26)"/><ellipse class="t5" cx="25" cy="16" rx="1.9" ry="7.2" transform="rotate(-9 25 26)"/><ellipse class="b" cx="40" cy="16" rx="4.6" ry="12" transform="rotate(56 40 26)"/><ellipse class="t5" cx="40" cy="16" rx="1.9" ry="7.2" transform="rotate(56 40 26)"/></g><path class="b" d="M31 22L38 22C48.88 22 55 28.12 55 39L55 37C55 51.08 47.08 59 33 59L26 59C15.12 59 9 52.88 9 42L9 44C9 29.92 16.92 22 31 22ZM21.46 35.99L40.89 33.61A6.21 6.21 0 0 1 47.81 39.01L47.95 40.09A6.21 6.21 0 0 1 42.54 47.01L23.11 49.39A6.21 6.21 0 0 1 16.19 43.99L16.05 42.91A6.21 6.21 0 0 1 21.46 35.99Z"/><g class="eyes"><circle class="b" cx="26.64" cy="42.16" r="2.9"/><path class="l" d="M34.31 42.22Q37.07 38.46 40.66 41.44"/></g></g></symbol>
  <symbol id="a-mochi" viewBox="0 0 64 64"><g class="head"><g class="feature"><path class="t6" d="M0 0C6.2-4.6 6.2-13.4 0-20C-6.2-13.4-6.2-4.6 0 0Z" transform="translate(33 30) rotate(26)"/></g><path class="b" d="M27 26L42 26C51.6 26 57 31.4 57 41L57 44C57 53.6 51.6 59 42 59L18 59C10.96 59 7 55.04 7 48L7 46C7 33.2 14.2 26 27 26ZM20.57 38.61L41.91 35.99A5.75 5.75 0 0 1 48.32 40.99L48.44 41.99A5.75 5.75 0 0 1 43.43 48.39L22.09 51.01A5.75 5.75 0 0 1 15.68 46.01L15.56 45.01A5.75 5.75 0 0 1 20.57 38.61Z"/><g class="eyes"><path class="l" d="M23.86 46.11Q26.27 41.18 29.81 45.38"/><path class="l" d="M34.58 44.8Q36.99 39.86 40.53 44.06"/></g></g></symbol>`;
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
const LIM={sora:[3.2,2.4],kumo:[3.2,2],hana:[3.2,2.4],taro:[2.8,2.4],yuki:[3.4,2.6],mochi:[3.4,2]};
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
