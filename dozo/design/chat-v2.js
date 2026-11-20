/* chat-v2: page behaviour on top of dozo.js (which draws and animates the avatars).
   ?panel=closed opens the page with the bot panel closed. Menus share one surface (#menu0,
   with #menu1 for a submenu): one open at a time, arrow keys, Home/End, Esc, click outside. */
addEventListener('DOMContentLoaded',()=>{
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  const app=$('#app'),pill=$('#pill'),q=dozoQuery();
  const g=$('#sg2 g');
  if(g&&typeof pat==='string')g.innerHTML=pat; // seigaiha scales from dozo.js
  const remeasure=()=>dispatchEvent(new Event('resize')); // dozo.js tracks avatar positions

  $('#apps').href='apps-v2.html'+q;
  /* bot panel */
  const set=closed=>{app.classList.toggle('closed',closed);pill.setAttribute('aria-expanded',String(!closed))};
  if(new URLSearchParams(location.search).get('panel')==='closed'){ // no slide on load
    app.classList.add('still');set(true);requestAnimationFrame(()=>requestAnimationFrame(()=>app.classList.remove('still')));
  }
  pill.addEventListener('click',()=>set(!app.classList.contains('closed')));
  $('#close').addEventListener('click',()=>set(true));
  $('#slot').addEventListener('transitionend',remeasure);
  const ask=$('#ask');
  $$('.opts button',ask).forEach(b=>b.addEventListener('click',()=>{b.setAttribute('aria-pressed','true');ask.classList.add('done')}));
  $$('.sw').forEach(s=>s.addEventListener('click',()=>s.setAttribute('aria-checked',String(s.getAttribute('aria-checked')!=='true'))));

  /* dialogs */
  let lastFocus=null;
  const openDlg=(id,name)=>{
    closeMenus();const d=$('#'+id);lastFocus=document.activeElement;
    if(name)$$('[data-bot-name]',d).forEach(e=>e.textContent=name);
    d.hidden=false;requestAnimationFrame(()=>{d.classList.add('open');remeasure()});
    ($('input',d)||$('.btn:last-child',d)).focus();
  };
  const closeDlg=d=>{d.classList.remove('open');setTimeout(()=>{d.hidden=true},120);lastFocus?.focus?.()};
  $$('.scrim').forEach(d=>{
    d.addEventListener('pointerdown',e=>{if(e.target===d)closeDlg(d)});
    $$('[data-close]',d).forEach(b=>b.addEventListener('click',e=>{e.preventDefault();closeDlg(d)}));
  });
  $$('.looks button').forEach(b=>b.addEventListener('click',()=>{
    $$('.looks button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    $$('.preview .bot').forEach(a=>a.hidden=a.dataset.bot!==b.dataset.look);remeasure();
  }));
  $$('.choice').forEach(c=>c.addEventListener('click',()=>$$('.choice',c.parentNode).forEach(x=>x.setAttribute('aria-checked',String(x===c)))));

  /* menu content: [label, {danger, meta, sub, act, tick, bot}] or '-' for a separator */
  const ICON={go:'<svg class="go-r" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',tick:'<svg class="tick" viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'};
  const av=n=>{const s=$(`.list .bot[data-bot="${n}"] svg`);return `<span class="bot" data-bot="${n}"><svg viewBox="0 0 64 64" aria-hidden="true">${s?s.innerHTML:''}</svg></span>`};
  const BOTS=$$('.list .row').map(r=>({name:$('.txt b',r).textContent,id:$('.bot',r).dataset.bot,row:r}));
  const nav=u=>()=>{location.href=u};
  const MENUS={
    account:()=>[{head:['Maya Chen','maya@example.com']},['Usage',{meta:'24% used',act:nav('settings-v2.html'+dozoQuery({section:'usage'}))}],['Settings',{act:nav('settings-v2.html'+q)}],['Skills'],['Artifacts'],'-',['Invite friends'],'-',['Log out']],
    row:b=>[['Pin'],['Move to',{sub:()=>[['Unassigned',{tick:1}],'-',['New section']]}],[b.row.classList.contains('unread')?'Mark as Read':'Mark as Unread'],
      ['Snooze',{sub:()=>[['1 hour'],['3 hours'],['Tomorrow',{meta:'09:00'}],['Next week',{meta:'Mon 09:00'}]]}],'-',['Edit Profile'],['Duplicate'],'-',['Clear conversation'],['Archive'],['Delete',{danger:1,act:()=>openDlg('dlg-del',b.name)}]],
    create:()=>[{search:['To:','Search']},['New bot',{act:()=>openDlg('dlg-new'),keep:'new bot'}],['New group chat'],['New private space',{title:'Private workspace with its own bots and groups.'}],'-',...BOTS.map(b=>[b.name,{bot:b.id}])],
    panel:()=>[['Get an email address'],['Export'],'-',['Clear conversation',{danger:1}]],
    message:()=>[['Reply'],['Mark as unread'],['Copy']],
    model:()=>{const cur=$('#model-val').textContent,pick=n=>[n,{tick:n===cur,act:()=>{$('#model-val').textContent=n}}];
      return [{search:[null,'Search models']},pick('Space default'),{label:'On this computer'},pick('Compact'),[...pick('Compact Mini')].map((x,i)=>i?{...x,meta:"Can't read images"}:x),{label:'Hosted'},pick('Balanced'),pick('Swift'),pick('Deep')]},
    react:()=>['👍','👎','❤️','😂','🎉','😮'].map(e=>[e,{emoji:1}])
  };
  const m0=$('#menu0'),m1=$('#menu1');let cur=null; // {trigger, el}
  const esc=t=>t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  function render(el,items,ctx){
    el.innerHTML='';el.classList.toggle('emoji',items.some(i=>i[1]?.emoji));
    for(const it of items){
      if(it==='-'){el.insertAdjacentHTML('beforeend','<div class="msep" role="separator"></div>');continue}
      if(it.head){el.insertAdjacentHTML('beforeend',`<div class="mhead"><b>${esc(it.head[0])}</b><span>${esc(it.head[1])}</span></div>`);continue}
      if(it.label){el.insertAdjacentHTML('beforeend',`<div class="mlab" role="presentation">${esc(it.label)}</div>`);continue}
      if(it.search){
        el.insertAdjacentHTML('beforeend',`<label class="mfind">${it.search[0]?`<span>${it.search[0]}</span>`:''}<input aria-label="${it.search[1]}" placeholder="${it.search[1]}"></label>`);
        const inp=el.lastElementChild.querySelector('input');
        inp.addEventListener('input',()=>{const v=inp.value.trim().toLowerCase();let n=0;
          $$('.mi',el).forEach(b=>{const ok=!v||(b.dataset.keep||b.textContent).toLowerCase().includes(v);b.hidden=!ok;n+=ok});
          $('.mempty',el)?.remove();if(!n)el.insertAdjacentHTML('beforeend','<div class="mempty">'+(ctx==='model'?'No matching models':'No bots match')+'</div>')});
        continue;
      }
      const [label,o={}]=it,b=document.createElement('button');
      b.className='mi'+(o.danger?' danger':'');b.setAttribute('role',o.emoji?'menuitem':'menuitem');b.tabIndex=-1;
      if(o.keep)b.dataset.keep=o.keep;if(o.title)b.title=o.title;if(o.emoji)b.setAttribute('aria-label','React '+label);
      b.innerHTML=(o.bot?av(o.bot):'')+`<span>${esc(label)}</span>`+(o.meta?`<span class="meta">${esc(o.meta)}</span>`:'')+(o.sub?ICON.go:'')+(o.tick?ICON.tick:'');
      if(o.sub){b.setAttribute('aria-haspopup','menu');b._sub=o.sub;b.addEventListener('click',()=>openSub(b));b.addEventListener('pointerenter',()=>{clearTimeout(b._t);b._t=setTimeout(()=>openSub(b),80)});b.addEventListener('pointerleave',()=>clearTimeout(b._t))}
      else b.addEventListener('click',()=>{const t=cur?.trigger;closeMenus(!o.act);o.act?.();if(o.emoji)react(t,label)});
      b.addEventListener('pointerenter',()=>{if(document.activeElement?.tagName!=='INPUT')b.focus({preventScroll:true})}); // pointer and keys share one highlight; typing keeps the field
      if(el===m0&&!o.sub)b.addEventListener('pointerenter',()=>{if(!m1.hidden)closeSub()});
      el.appendChild(b);
    }
  }
  function place(el,r,side){ // keep 8px inside the window, flip when there is no room
    const W=innerWidth,H=innerHeight,w=el.offsetWidth,h=el.offsetHeight;let x,y,from;
    if(side==='right'){x=r.right+4;y=r.top-6;if(x+w>W-8)x=r.left-w-4;from=x>r.left?'top left':'top right'}
    else if(side==='point'){x=r.left;y=r.top;if(x+w>W-8)x=x-w;if(y+h>H-8)y=y-h;from='top left'}
    else{x=side==='center'?r.left+r.width/2-w/2:r.left;y=r.bottom+6;from='top center';if(y+h>H-8){y=r.top-h-6;from='bottom center'}if(side==='end')x=r.right-w}
    x=Math.max(8,Math.min(x,W-8-w));y=Math.max(8,Math.min(y,H-8-h));
    el.style.translate=`${Math.round(x)}px ${Math.round(y)}px`;el.style.setProperty('--from',from);
  }
  function show(el){el.hidden=false;requestAnimationFrame(()=>el.classList.add('open'))}
  function hide(el){if(el.hidden)return;el.classList.remove('open');clearTimeout(el._t);el._t=setTimeout(()=>{if(!el.classList.contains('open'))el.hidden=true},80)}
  function openMenu(name,trigger,side,arg,point){
    if(cur&&cur.trigger===trigger&&!point){closeMenus();return}
    closeMenus(false);clearTimeout(m0._t);m0.hidden=false;m0.classList.remove('open');
    render(m0,MENUS[name](arg),name);m0.setAttribute('aria-label',trigger.getAttribute('aria-label')||name);
    place(m0,point||trigger.getBoundingClientRect(),point?'point':side);show(m0);
    cur={trigger};trigger.setAttribute('aria-expanded','true');
    const f=$('input',m0);(f||m0).focus({preventScroll:true});
  }
  function openSub(b){
    if(b.classList.contains('sub-open'))return;
    $$('.mi.sub-open',m0).forEach(x=>x.classList.remove('sub-open'));
    clearTimeout(m1._t);m1.hidden=false;m1.classList.remove('open');render(m1,b._sub());m1._parent=b;b.classList.add('sub-open');
    place(m1,b.getBoundingClientRect(),'right');show(m1);
  }
  function closeSub(){hide(m1);m1._parent?.classList.remove('sub-open')}
  function closeMenus(refocus=true){
    if(!cur)return;closeSub();hide(m0);cur.trigger.setAttribute('aria-expanded','false');
    if(refocus)cur.trigger.focus({preventScroll:true});cur=null;
  }
  function react(trigger,emoji){
    const msg=trigger?.closest('.msg');if(!msg)return;
    let r=$('.reacts',msg);if(!r){r=document.createElement('div');r.className='reacts';msg.appendChild(r)}
    r.innerHTML=`<span>${emoji} 1</span>`;
  }
  document.addEventListener('pointerdown',e=>{if(cur&&!m0.contains(e.target)&&!m1.contains(e.target)&&!cur.trigger.contains(e.target))closeMenus(false)});
  document.addEventListener('keydown',e=>{
    const dlg=$('.scrim.open');
    if(e.key==='Escape'){if(cur){e.preventDefault();if(!m1.hidden&&m1.contains(document.activeElement)){closeSub();m1._parent.focus()}else closeMenus()}else if(dlg)closeDlg(dlg);return}
    if(!cur)return;
    const inSub=!m1.hidden&&m1.contains(document.activeElement),el=inSub?m1:m0,items=$$('.mi:not([hidden])',el),i=items.indexOf(document.activeElement);
    const k=e.key,flat=el.classList.contains('emoji');
    if(k==='ArrowDown'||(flat&&k==='ArrowRight')){e.preventDefault();items[(i+1)%items.length]?.focus()}
    else if(k==='ArrowUp'||(flat&&k==='ArrowLeft')){e.preventDefault();items[(i-1+items.length)%items.length]?.focus()}
    else if(k==='Home'){e.preventDefault();items[0]?.focus()}else if(k==='End'){e.preventDefault();items.at(-1)?.focus()}
    else if(k==='ArrowRight'&&!inSub&&document.activeElement?._sub){e.preventDefault();openSub(document.activeElement);$('.mi',m1)?.focus()}
    else if(k==='ArrowLeft'&&inSub){e.preventDefault();closeSub();m1._parent.focus()}
    else if(k==='Tab')closeMenus(false);
  });

  /* triggers */
  $('#me').addEventListener('click',e=>openMenu('account',e.currentTarget,'above'));
  $('#new').addEventListener('click',e=>openMenu('create',e.currentTarget,'start'));
  $('#pmore').addEventListener('click',e=>openMenu('panel',e.currentTarget,'end'));
  $('#model').addEventListener('click',e=>openMenu('model',e.currentTarget,'end'));
  for(const b of BOTS){
    $('.more',b.row).addEventListener('click',e=>{e.stopPropagation();openMenu('row',e.currentTarget,'start',b)});
    b.row.addEventListener('contextmenu',e=>{e.preventDefault();openMenu('row',$('.more',b.row),'point',b,{left:e.clientX,top:e.clientY})});
  }
  $$('.acts2 [data-act]').forEach(btn=>btn.addEventListener('click',()=>{
    if(btn.dataset.act==='react')openMenu('react',btn,'start');else if(btn.dataset.act==='more')openMenu('message',btn,'start');
  }));
});
