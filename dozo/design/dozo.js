/* Dozo shared script. Load in <head> (sync) so the theme is set before first paint:
   <link rel="stylesheet" href="dozo.css"><script src="dozo.js"></script>
   Theme:   add ?theme=light to the page URL (default is dark). Sidebar links keep the query.
   Sidebar: <aside class="side" data-active="sora"></aside> is filled in by this script;
            data-active = bot name to highlight (omit or empty on pages that are not a bot).
   Avatars: <span class="bot av [hd|xl]" data-bot="sora|kumo|hana|taro|yuki|mochi"
            data-state="working|waiting|idle"><svg viewBox="0 0 64 64"></svg></span>
            The symbols (#a-NAME) are injected here; the script stamps them into the svg so
            eyes track the pointer, blink, bob and react to hover. Idle bots sleep until hovered. */
const theme=new URLSearchParams(location.search).get('theme');
if(theme==='light')document.documentElement.dataset.theme='light';
const q=theme==='light'?'?theme=light':'';

const BOTS=[['sora','Sora','working'],['kumo','Kumo','working'],['hana','Hana','waiting'],['taro','Taro','idle'],['yuki','Yuki','idle'],['mochi','Mochi','idle']];
const DOT={working:'',waiting:' wait',idle:' idle'};
const pat=[[20,-10],[0,0],[40,0],[20,10],[0,20],[40,20],[20,30]].map(([x,y])=>`<g transform="translate(${x} ${y})"><circle r="20"/><circle r="14"/><circle r="8"/></g>`).join('');
const sidebar=on=>`<svg class="wag" aria-hidden="true"><defs><pattern id="sg" width="40" height="20" patternUnits="userSpaceOnUse"><g fill="var(--side)" stroke="var(--pattern)" stroke-width="1">${pat}</g></pattern></defs><rect width="100%" height="100%" fill="url(#sg)"/></svg>`
 +`<a class="word" href="bots.html${q}"><i class="seal"></i>dozo<span class="kana">どうぞ</span></a>`
 +BOTS.map(([n,l,s])=>`<a class="row${n===on?' on':''}" href="chat.html${q}" style="--c:var(--${n})"><span class="bot av" data-bot="${n}" data-state="${s}"><svg viewBox="0 0 64 64" aria-hidden="true"></svg></span>${l}<span class="dot${DOT[s]}"></span></a>`).join('')
 +`<a class="row new"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>New bot</a><div class="label">Groups</div><div class="row">Finance</div><div class="row">Outreach</div><div class="row">Research</div><div class="acct">Maya Chen</div>`;

const SYMBOLS=`<symbol id="a-sora" viewBox="0 0 64 64"><rect class="t1" width="64" height="64" rx="18"/><g class="head"><rect x="30.5" y="9" width="3" height="10" rx="1.5" fill="#eef0f4"/><g class="feature"><circle cx="32" cy="9" r="3.5" fill="#bfe0ff"/></g><circle cx="32" cy="36" r="18" fill="#eef0f4"/><rect x="20" y="30" width="24" height="13" rx="6.5" fill="#14161c"/><g class="eyes"><circle cx="27" cy="36.5" r="2.6" fill="#bfe0ff"/><circle cx="37" cy="36.5" r="2.6" fill="#bfe0ff"/></g></g></symbol>
  <symbol id="a-kumo" viewBox="0 0 64 64"><rect class="t2" width="64" height="64" rx="18"/><g class="head"><g class="feature"><rect x="22" y="11" width="3" height="10" rx="1.5" fill="#eef0f4"/><rect x="39" y="11" width="3" height="10" rx="1.5" fill="#eef0f4"/></g><rect x="15" y="20" width="34" height="30" rx="9" fill="#eef0f4"/><rect x="20" y="28" width="24" height="14" rx="5" fill="#14161c"/><g class="eyes"><rect x="23.5" y="34.5" width="6" height="3" rx="1.5" fill="#e2d6ff"/><rect x="34.5" y="34.5" width="6" height="3" rx="1.5" fill="#e2d6ff"/></g></g></symbol>
  <symbol id="a-hana" viewBox="0 0 64 64"><rect class="t3" width="64" height="64" rx="18"/><g class="head"><rect x="30" y="17" width="4" height="8" rx="0" fill="#eef0f4"/><g class="feature"><circle cx="32" cy="15" r="3.5" fill="#c4f2d9"/></g><rect x="10" y="24" width="44" height="26" rx="13" fill="#eef0f4"/><rect x="16" y="30" width="32" height="14" rx="7" fill="#14161c"/><g class="eyes"><rect x="21" y="35.2" width="22" height="3.6" rx="1.8" fill="#c4f2d9"/></g></g></symbol>
  <symbol id="a-taro" viewBox="0 0 64 64"><rect class="t4" width="64" height="64" rx="18"/><g class="head"><rect x="18" y="12" width="28" height="42" rx="13" fill="#eef0f4"/><g class="feature"><rect x="18" y="26" width="28" height="4" rx="0" fill="var(--taro)"/></g><rect x="22" y="33" width="20" height="15" rx="7" fill="#14161c"/><g class="eyes"><ellipse cx="28" cy="40.5" rx="2.3" ry="3.3" fill="#ffe2ae"/><ellipse cx="36" cy="40.5" rx="2.3" ry="3.3" fill="#ffe2ae"/></g></g></symbol>
  <symbol id="a-yuki" viewBox="0 0 64 64"><rect class="t5" width="64" height="64" rx="18"/><g class="head"><g class="feature"><circle cx="12" cy="35" r="4.5" fill="#eef0f4"/><circle cx="52" cy="35" r="4.5" fill="#eef0f4"/></g><rect x="14" y="18" width="36" height="34" rx="16" fill="#eef0f4"/><rect x="19" y="27" width="26" height="15" rx="7.5" fill="#14161c"/><g class="eyes"><circle cx="27" cy="34.5" r="2.7" fill="#ffd0c6"/><path d="M33.5 35q3.5-3.4 7 0" fill="none" stroke="#ffd0c6" stroke-width="2.6" stroke-linecap="round"/></g></g></symbol>
  <symbol id="a-mochi" viewBox="0 0 64 64"><rect class="t6" width="64" height="64" rx="18"/><g class="head"><g class="feature"><ellipse cx="41" cy="13" rx="3" ry="8.5" transform="rotate(28 41 13)" fill="#b8f0f0"/></g><rect x="15" y="21" width="34" height="30" rx="11" fill="#eef0f4"/><rect x="20" y="29" width="24" height="14" rx="7" fill="#14161c"/><g class="eyes"><path d="M24 38q3-5 6 0M34 38q3-5 6 0" fill="none" stroke="#b8f0f0" stroke-width="2.6" stroke-linecap="round"/></g></g></symbol>`;

addEventListener('DOMContentLoaded',()=>{
document.body.insertAdjacentHTML('afterbegin',`<svg style="position:absolute;width:0;height:0" aria-hidden="true"><defs>${SYMBOLS}</defs></svg>`);
const side=document.querySelector('.side');
if(side)side.innerHTML=sidebar(side.dataset.active);
const LIM={sora:[3.2,2.6],kumo:[2.5,3],hana:[3.5,2],taro:[2.7,3],yuki:[3.5,3],mochi:[2,2.5]}; // max eye shift (svg units) inside the visor
const GAIN={working:.8,waiting:1,idle:.8}, SLEEP={open:.3,gain:.15};
const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
const RATE=reduce?3:10, BLINK=reduce?220:120, R=240, rnd=(a,b)=>a+Math.random()*(b-a);
let px=null,py=null,last=0;
const bots=[...document.querySelectorAll('.bot')].map(el=>{
  const name=el.dataset.bot,svg=el.querySelector('svg'),sym=document.getElementById('a-'+name);
  if(!svg||!sym||!LIM[name])return null;
  svg.replaceChildren(...[...sym.children].map(c=>c.cloneNode(true)));
  const b={el,svg,eyes:svg.querySelector('.eyes'),state:el.dataset.state||'idle',lim:LIM[name],x:0,y:0,awake:false,cx:0,cy:0,bs:-1e9,next:rnd(800,4000),str:''};
  b.open=b.state==='idle'?SLEEP.open:1;
  svg.querySelector('.head').style.animationDelay=-rnd(0,3)+'s';
  const host=el.closest('.tile,.li,.row')||el;
  host.addEventListener('pointerenter',()=>{b.awake=true;clearTimeout(b.tm);el.classList.add('hop')});
  host.addEventListener('pointerleave',()=>{b.tm=setTimeout(()=>b.awake=false,900)});
  svg.addEventListener('animationend',e=>{if(e.target===svg)el.classList.remove('hop')});
  return b;
}).filter(Boolean);
const measure=()=>bots.forEach(b=>{const r=b.el.getBoundingClientRect();b.cx=r.left+r.width/2;b.cy=r.top+r.height/2});
const away=()=>px=null;
addEventListener('pointermove',e=>{px=e.clientX;py=e.clientY},{passive:true});
document.documentElement.addEventListener('pointerleave',away);document.documentElement.addEventListener('mouseleave',away);addEventListener('blur',away);
addEventListener('resize',measure);addEventListener('scroll',measure,true);
const clamp=(v,m)=>Math.max(-m,Math.min(m,v));
function tick(t){
  const dt=Math.min((t-last)/1000,.05);last=t;const k=1-Math.exp(-dt*RATE);
  for(const b of bots){
    const sleep=b.state==='idle'&&!b.awake, g=sleep?SLEEP.gain:GAIN[b.state]||.8;
    const tx=px==null?0:clamp((px-b.cx)/R,1)*b.lim[0]*g, ty=px==null?0:clamp((py-b.cy)/R,1)*b.lim[1]*g;
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
