/* chat-v2: page behaviour on top of dozo.js (which draws and animates the avatars).
   ?panel=closed opens the page with the bot panel closed. */
addEventListener('DOMContentLoaded',()=>{
  const app=document.getElementById('app'),pill=document.getElementById('pill');
  const g=document.querySelector('#sg2 g');
  if(g&&typeof pat==='string')g.innerHTML=pat; // seigaiha scales from dozo.js
  const set=closed=>{app.classList.toggle('closed',closed);pill.setAttribute('aria-expanded',String(!closed))};
  if(new URLSearchParams(location.search).get('panel')==='closed'){ // no slide on load
    app.classList.add('still');set(true);requestAnimationFrame(()=>requestAnimationFrame(()=>app.classList.remove('still')));
  }
  pill.addEventListener('click',()=>set(!app.classList.contains('closed')));
  document.getElementById('close').addEventListener('click',()=>set(true));
  // the slot changes width for 340ms: let dozo.js re-measure the avatars it tracks
  document.getElementById('slot').addEventListener('transitionend',()=>dispatchEvent(new Event('resize')));
  const ask=document.getElementById('ask');
  ask.querySelectorAll('.opts button').forEach(b=>b.addEventListener('click',()=>{
    b.setAttribute('aria-pressed','true');ask.classList.add('done');
  }));
  document.querySelectorAll('.sw').forEach(s=>s.addEventListener('click',()=>
    s.setAttribute('aria-checked',String(s.getAttribute('aria-checked')!=='true'))));
});
