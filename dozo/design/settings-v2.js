/* settings-v2: the settings window. ?section=<id> opens a section; closing returns to chat-v2.
   The chat behind is the real chat-v2 page, inert, so its markup is not copied here. */
addEventListener('DOMContentLoaded',()=>{
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  const params=new URLSearchParams(location.search),q=params.get('theme')==='light'?'?theme=light':'';
  $('#behind').src='chat-v2.html'+q;
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
  const close=()=>{scrim.classList.remove('open');setTimeout(()=>{location.href='chat-v2.html'+q},120)};
  $('#sx').addEventListener('click',close);
  scrim.addEventListener('pointerdown',e=>{if(e.target===scrim)close()});
  addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  $$('.seg').forEach(s=>$$('button',s).forEach(b=>b.addEventListener('click',()=>$$('button',s).forEach(x=>x.setAttribute('aria-checked',String(x===b))))));
  $$('.sw').forEach(s=>s.addEventListener('click',()=>s.setAttribute('aria-checked',String(s.getAttribute('aria-checked')!=='true'))));
  const read=$('#acct-read'),form=$('#acct-form'),edit=on=>{read.hidden=on;form.hidden=!on;(on?$('input',form):$('#acct-edit')).focus()};
  $('#acct-edit').addEventListener('click',()=>edit(true));
  $('#acct-cancel').addEventListener('click',()=>edit(false));
  $('#acct-save').addEventListener('click',()=>{$('b',read).textContent=$('input',form).value.trim()||'Maya Chen';edit(false)});
});
