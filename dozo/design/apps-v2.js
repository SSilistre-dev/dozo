/* apps-v2: the Integrations window. Closing returns to chat-v2; search and category chips filter. */
addEventListener('DOMContentLoaded',()=>{
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  $('#behind').src='chat-v2.html'+dozoQuery();
  const scrim=$('#scrim');requestAnimationFrame(()=>scrim.classList.add('open'));
  const close=()=>{scrim.classList.remove('open');setTimeout(()=>{location.href='chat-v2.html'+dozoQuery()},120)};
  $('#sx').addEventListener('click',close);
  scrim.addEventListener('pointerdown',e=>{if(e.target===scrim)close()});
  addEventListener('keydown',e=>{if(e.key==='Escape')close()});
  let cat='all';
  const filter=()=>{
    const v=$('#q').value.trim().toLowerCase();let shown=0;
    $$('.app').forEach(a=>{const ok=(cat==='all'||a.dataset.cat===cat)&&(!v||a.dataset.name.includes(v));a.hidden=!ok;if(ok&&!a.closest('#sec-connected'))shown++});
    $('#sec-connected').hidden=!$$('#sec-connected .app').some(a=>!a.hidden);$('#anone').hidden=shown>0;
  };
  $('#q').addEventListener('input',filter);
  $$('.chips button').forEach(b=>b.addEventListener('click',()=>{cat=b.dataset.cat;$$('.chips button').forEach(x=>x.setAttribute('aria-checked',String(x===b)));filter()}));
});
