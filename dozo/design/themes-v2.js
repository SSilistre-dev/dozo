/* themes-v2: load in <head> after dozo.js so the theme is set before first paint.
   ?theme=dark|light|system|<named> and ?bubble=neutral; links between the v2 pages keep both. */
const DOZO_THEMES=[['system','System'],['light','Light'],['dark','Dark'],['sumi','Sumi','dark'],['yoru','Yoru','dark'],['hoji','Hoji','dark'],['washi','Washi','light'],['matcha','Matcha','light'],['kasumi','Kasumi','light']];
function dozoApplyTheme(name,bubble){
  const r=document.documentElement,t=DOZO_THEMES.find(x=>x[0]===name)||DOZO_THEMES[2];
  const tone=t[0]==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):(t[2]||t[0]);
  if(tone==='light')r.dataset.theme='light';else delete r.dataset.theme;
  if(t[2])r.dataset.skin=t[0];else delete r.dataset.skin;
  if(bubble==='neutral')r.dataset.bubble='neutral';else delete r.dataset.bubble;
}
function dozoQuery(extra){ // the theme and bubble choice, as a query for the next page
  const p=new URLSearchParams(location.search),o=new URLSearchParams();
  for(const k of ['theme','bubble'])if(p.get(k))o.set(k,p.get(k));
  for(const [k,v] of Object.entries(extra||{}))v==null?o.delete(k):o.set(k,v);
  const s=o.toString();return s?'?'+s:'';
}
{const p=new URLSearchParams(location.search);dozoApplyTheme(p.get('theme')||'dark',p.get('bubble'))}
