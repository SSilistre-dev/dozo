/* settings-v2: the settings window. ?section=<id> opens a section; closing returns to chat-v2.
   The chat behind is the real chat-v2 page, inert, so its markup is not copied here. */
addEventListener('DOMContentLoaded',()=>{
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  const params=new URLSearchParams(location.search);
  $('#behind').src='chat-v2.html'+dozoQuery();
  const scrim=$('#scrim');requestAnimationFrame(()=>scrim.classList.add('open'));
  const DESC={models:'Which LLMs your bots use.',approvals:'When bots check with you before acting.',vault:'Logins and keys your bots can use.',
    wallet:'Where your bots pay from.',memory:'What your bots remember between chats.',voice:'Calls, dictation, and replies read aloud.',
    messaging:'Chat with your bots from other apps.',computer:'The computer your bots work on.'};
  const FULL=['general','approvals','usage'];
  function show(sec,animate){
    const row=$(`.nrow[data-sec="${sec}"]`)||$('.nrow');sec=row.dataset.sec;
    $$('.nrow').forEach(r=>r.toggleAttribute('aria-current',r===row)&&r.setAttribute('aria-current','page'));
    $('#st-title').textContent=row.textContent;
    const d=$('#st-desc');d.textContent=DESC[sec]||'';d.hidden=!DESC[sec];
    const key=FULL.includes(sec)?sec:'empty';
    $$('.pane').forEach(p=>{p.hidden=p.dataset.pane!==key;p.classList.remove('enter')});
    const p=$(`.pane[data-pane="${key}"]`);if(animate){void p.offsetWidth;p.classList.add('enter')}
    $('#sbody').scrollTop=0;
  }
  show(params.get('section')||'general',false);
  $$('.nrow').forEach(r=>r.addEventListener('click',()=>show(r.dataset.sec,true)));
  const close=()=>{scrim.classList.remove('open');setTimeout(()=>{location.href='chat-v2.html'+dozoQuery()},120)};
  $('#sx').addEventListener('click',close);
  scrim.addEventListener('pointerdown',e=>{if(e.target===scrim)close()});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&tmenu.hidden)close()});
  /* Appearance: the theme menu changes this page and the chat behind it live, and the next page keeps it */
  const tmenu=$('#tmenu'),tpick=$('#tpick');
  let theme=params.get('theme')||'dark',bubble=params.get('bubble')||'bot';
  const apply=()=>{
    const t=DOZO_THEMES.find(x=>x[0]===theme)||DOZO_THEMES[2];theme=t[0];
    dozoApplyTheme(theme,bubble);$('#behind').contentWindow?.dozoApplyTheme?.(theme,bubble);
    history.replaceState(null,'',location.pathname+dozoQuery({theme:theme==='dark'?null:theme,bubble:bubble==='neutral'?'neutral':null,section:$('.nrow[aria-current]').dataset.sec}));
    $('#tname').textContent=t[1];$('#tsw').dataset.t=theme;
    $$('#bubble button').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.v===bubble)));
  };
  $('#behind').addEventListener('load',apply);
  const TICK='<svg class="tick" viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
  const closeT=refocus=>{tmenu.classList.remove('open');tpick.setAttribute('aria-expanded','false');setTimeout(()=>{if(!tmenu.classList.contains('open'))tmenu.hidden=true},80);if(refocus)tpick.focus()};
  function openT(){
    tmenu.innerHTML=DOZO_THEMES.map((t,i)=>(i===3?'<div class="msep" role="separator"></div>':'')+
      `<button class="mi" role="menuitemradio" aria-checked="${t[0]===theme}" tabindex="-1" data-v="${t[0]}"><span class="swatch" data-t="${t[0]}"></span><span>${t[1]}</span>${t[0]===theme?TICK:''}</button>`).join('');
    tmenu.hidden=false;const r=tpick.getBoundingClientRect(),w=tmenu.offsetWidth,h=tmenu.offsetHeight;
    let y=r.bottom+6;if(y+h>innerHeight-8)y=r.top-h-6;
    tmenu.style.translate=`${Math.round(Math.min(r.right-w,innerWidth-8-w))}px ${Math.round(Math.max(8,y))}px`;tmenu.style.setProperty('--from','top right');
    requestAnimationFrame(()=>tmenu.classList.add('open'));tpick.setAttribute('aria-expanded','true');
    ($('.mi[aria-checked=true]',tmenu)||$('.mi',tmenu)).focus({preventScroll:true});
    $$('.mi',tmenu).forEach(b=>{b.addEventListener('click',()=>{theme=b.dataset.v;apply();closeT(true)});b.addEventListener('pointerenter',()=>b.focus({preventScroll:true}))});
  }
  tpick.addEventListener('click',()=>tmenu.hidden?openT():closeT(true));
  document.addEventListener('pointerdown',e=>{if(!tmenu.hidden&&!tmenu.contains(e.target)&&!tpick.contains(e.target))closeT(false)});
  tmenu.addEventListener('keydown',e=>{
    const it=$$('.mi',tmenu),i=it.indexOf(document.activeElement);
    if(e.key==='ArrowDown'){e.preventDefault();it[(i+1)%it.length].focus()}else if(e.key==='ArrowUp'){e.preventDefault();it[(i-1+it.length)%it.length].focus()}
    else if(e.key==='Home'){e.preventDefault();it[0].focus()}else if(e.key==='End'){e.preventDefault();it.at(-1).focus()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeT(true)}else if(e.key==='Tab')closeT(false);
  });
  $$('#bubble button').forEach(b=>b.addEventListener('click',()=>{bubble=b.dataset.v;apply()}));
  apply();
  $$('.seg:not(#bubble)').forEach(s=>$$('button',s).forEach(b=>b.addEventListener('click',()=>$$('button',s).forEach(x=>x.setAttribute('aria-checked',String(x===b))))));
  $$('.sw').forEach(s=>s.addEventListener('click',()=>s.setAttribute('aria-checked',String(s.getAttribute('aria-checked')!=='true'))));
  const read=$('#acct-read'),form=$('#acct-form'),edit=on=>{read.hidden=on;form.hidden=!on;(on?$('input',form):$('#acct-edit')).focus()};
  $('#acct-edit').addEventListener('click',()=>edit(true));
  $('#acct-cancel').addEventListener('click',()=>edit(false));
  $('#acct-save').addEventListener('click',()=>{$('b',read).textContent=$('input',form).value.trim()||'Maya Chen';edit(false)});
});
