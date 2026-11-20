/* signin-v2: email first, then a six-digit code; a password is the way round.
   In this mockup the code 000000 is wrong and every other code is right. */
addEventListener('DOMContentLoaded',()=>{
  const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
  const q=location.search.includes('theme=light')?'?theme=light':'';
  const g=$('#sg3 g');if(g&&typeof pat==='string')g.innerHTML=pat; // seigaiha scales from dozo.js
  const digits=$$('.digit'),otp=$('#otp'),err=$('#err'),resend=$('#resend'),wait=$('#wait');
  let timer=0;
  const done=()=>{location.href='chat-v2.html'+q};
  function show(name){
    $$('.step').forEach(s=>{s.hidden=s.dataset.step!==name;s.classList.remove('enter')});
    const s=$(`.step[data-step="${name}"]`);void s.offsetWidth;s.classList.add('enter');
    if(name==='code'){digits.forEach(d=>d.value='');err.hidden=true;countdown();digits[0].focus()}
    else (name==='password'?($('#email2').value?$('#pw'):$('#email2')):$('#email')).focus();
  }
  function countdown(){
    clearInterval(timer);let n=30;resend.disabled=true;
    const tick=()=>{wait.textContent=n?`0:${String(n).padStart(2,'0')}`:'';resend.disabled=n>0;if(!n--)clearInterval(timer)};
    tick();timer=setInterval(tick,1000);
  }
  $$('[data-go]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.go==='password')$('#email2').value=$('#email').value;
    if(b.dataset.go==='email'&&$('#email2').value)$('#email').value=$('#email2').value;
    show(b.dataset.go);
  }));
  $('.step[data-step="email"]').addEventListener('submit',e=>{
    e.preventDefault();const f=$('#email');
    if(!f.checkValidity()){f.reportValidity();return}
    $('#addr').textContent=f.value.trim();show('code');
  });
  $('.step[data-step="password"]').addEventListener('submit',e=>{
    e.preventDefault();const bad=[$('#email2'),$('#pw')].find(f=>!f.checkValidity());
    if(bad){bad.reportValidity();return}done();
  });
  resend.addEventListener('click',()=>{countdown();digits[0].focus()});
  function fill(from,text){
    const nums=text.replace(/\D/g,'').split('');
    nums.forEach((n,i)=>{if(digits[from+i])digits[from+i].value=n});
    const next=Math.min(from+nums.length,5);digits[next].focus();check();
  }
  function check(){
    const code=digits.map(d=>d.value).join('');if(code.length<6)return;
    if(code!=='000000'){done();return}
    err.hidden=false;otp.classList.remove('shake');void otp.offsetWidth;otp.classList.add('shake');
    digits.forEach(d=>d.value='');digits[0].focus();
  }
  digits.forEach((d,i)=>{
    d.addEventListener('input',()=>{const v=d.value.replace(/\D/g,'');d.value='';err.hidden=true;if(v)fill(i,v)});
    d.addEventListener('paste',e=>{e.preventDefault();fill(i,e.clipboardData.getData('text'))});
    d.addEventListener('keydown',e=>{
      if(e.key==='Backspace'&&!d.value&&i){digits[i-1].value='';digits[i-1].focus();e.preventDefault()}
      else if(e.key==='ArrowLeft'&&i)digits[i-1].focus();else if(e.key==='ArrowRight'&&i<5)digits[i+1].focus();
    });
    d.addEventListener('focus',()=>d.select());
  });
  $('.step[data-step="code"]').addEventListener('submit',e=>e.preventDefault());
  otp.addEventListener('animationend',()=>otp.classList.remove('shake'));
});
