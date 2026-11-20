/* Athena adapters for DesignBookmark's Command Button (MIT) and Morph Tooltip.
 * Source values retained: Command press 520/34/mass .6; width 300/28 (bounce 30);
 * swap .18s [0.23,1,0.32,1]. Tooltip lead620/36 trail190/19 tail300/22,
 * visibility420/24 label420/32 icon520/16 and 140ms leave delay.
 * Product palette, radius, labels, dimensions, scope and cleanup are Athena's.
 */
(()=>{'use strict';
 const reduceQuery=()=>window.matchMedia('(prefers-reduced-motion: reduce)');
 const S=(x,k,c,m=1)=>({x,t:x,v:0,k,c,m});
 const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 function prefersReduced(root, media) { return Boolean((media || reduceQuery()).matches || root?.dataset.reducedMotion === 'true'); }
 function scheduler(springs, draw, root) {
  let raf=0,last=0,dead=false; const mq=reduceQuery();
  function snap(){for(const s of springs){s.x=s.t;s.v=0}draw()}
  function tick(now){raf=0;if(dead)return;const dt=Math.min((now-(last||now))/1000,1/30);last=now;let moving=false;for(let j=0;j<4;j++)for(const s of springs){if(prefersReduced(root,mq)){s.x=s.t;s.v=0}else{s.v+=(-s.k*(s.x-s.t)-s.c*s.v)/s.m*(dt/4);s.x+=s.v*(dt/4)}if(Math.abs(s.x-s.t)>.001||Math.abs(s.v)>.001)moving=true;}draw();if(moving)raf=requestAnimationFrame(tick);else last=0;}
  function onPreference(){if(dead)return;if(prefersReduced(root,mq)){cancelAnimationFrame(raf);raf=0;last=0;snap()}}
  root?.addEventListener('ac:settings-change',onPreference);
  if(mq.addEventListener)mq.addEventListener('change',onPreference);else mq.addListener(onPreference);
  return{wake(){if(!dead&&!raf)raf=requestAnimationFrame(tick)},destroy(){dead=true;cancelAnimationFrame(raf);root?.removeEventListener('ac:settings-change',onPreference);if(mq.removeEventListener)mq.removeEventListener('change',onPreference);else mq.removeListener(onPreference)},snap};
 }
 function icons(){if(window.lucide)window.lucide.createIcons({attrs:{'aria-hidden':'true'}})}
 function command(slot,{onSearch=()=>{}}={}) {
  if(!slot)return null;
  const controller=new AbortController(),signal=controller.signal;
  const app=slot.closest('#athena-codex')||slot,mac=/Mac|iPhone|iPad|iPod/i.test(navigator.platform||'');
  const shortcut=mac?'⌘K':'Ctrl+K';
  slot.innerHTML='<div class="ac-command"><button type="button" class="ac-command-button cursor-interaction" aria-label="Search project" aria-expanded="false" data-morph-tooltip="Search project ('+shortcut+')"><i data-lucide="search" aria-hidden="true"></i></button><div class="ac-command-field" hidden><i data-lucide="search" aria-hidden="true"></i><input type="search" aria-label="Search project files and results" placeholder="Search this project…"><button class="ac-command-close cursor-interaction" type="button" aria-label="Close search" data-morph-tooltip="Close search (Esc)"><i data-lucide="x" aria-hidden="true"></i></button></div></div>';
  const host=slot.firstElementChild,button=host.querySelector('.ac-command-button'),field=host.querySelector('.ac-command-field'),input=host.querySelector('input'),closeBtn=host.querySelector('.ac-command-close');
  let open=false,disposed=false,swap=[];
  const baseWidth=window.matchMedia('(pointer: coarse)').matches?40:32,width=S(baseWidth,300,28),press=S(1,520,34,.6);
  host.style.width=baseWidth+'px';
  const engine=scheduler([width,press],()=>{host.style.width=Math.max(baseWidth,width.x).toFixed(2)+'px';host.style.transform='scale('+press.x.toFixed(5)+')'},app);
  const listen=(el,type,fn)=>el.addEventListener(type,fn,{signal});
  const available=()=>{const row=slot.parentElement;let space=row.clientWidth;for(const child of row.children)if(child!==slot)space-=child.getBoundingClientRect().width;const gap=parseFloat(getComputedStyle(row).columnGap)||0;space-=gap*Math.max(0,row.children.length-1);return Math.max(baseWidth,Math.min(300,space||300))};
  function change(next,focus=true){if(disposed||next===open)return;open=next;for(const a of swap)a.cancel();swap=[];button.setAttribute('aria-expanded',String(open));host.classList.toggle('is-open',open);if(open){field.hidden=false;button.hidden=true;width.t=available();}else{button.hidden=false;field.hidden=true;width.t=baseWidth;input.value='';}const shown=open?field:button;if(shown.animate&&!prefersReduced(app)){swap.push(shown.animate([{opacity:0,filter:'blur(4px)'},{opacity:1,filter:'blur(0px)'}],{duration:180,delay:60,easing:'cubic-bezier(0.23,1,0.32,1)',fill:'both'}));}else{shown.style.opacity='1';shown.style.filter='none'}engine.wake();if(focus)(open?input:button).focus({preventScroll:true});}
  button.setAttribute('aria-keyshortcuts',(mac?'Meta':'Control')+'+K');
  listen(button,'click',()=>change(true));
  listen(host,'pointerdown',()=>{if(!open){press.t=.97;engine.wake()}});
  for(const evt of ['pointerup','pointerleave','pointercancel'])listen(host,evt,()=>{press.t=1;engine.wake()});
  listen(closeBtn,'click',()=>change(false));
  listen(input,'keydown',e=>{if(e.isComposing||e.keyCode===229)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();change(false)}else if(e.key==='Enter'&&input.value.trim()){e.preventDefault();onSearch(input.value.trim());change(false,false)}});
  listen(input,'blur',()=>{if(!input.value.trim()&&open)change(false,false)});
  listen(app,'keydown',e=>{if(e.isComposing||e.keyCode===229||host.closest('[inert]')||host.closest('.ac-conversation')?.inert)return;const mod=mac?e.metaKey:e.ctrlKey,letter=e.key.toLowerCase()==='k'||e.code==='KeyK';if(mod&&letter&&!e.repeat){e.preventDefault();press.t=.97;engine.wake();change(true)}});
  listen(app,'keyup',()=>{press.t=1;engine.wake()});
  listen(document,'pointerdown',e=>{if(open&&!host.contains(e.target))change(false,false)});
  listen(window,'blur',()=>{press.t=1;engine.wake()});
  listen(app,'ac:settings-change',()=>{if(prefersReduced(app)){for(const a of swap)a.cancel();swap=[];for(const el of [button,field]){el.style.opacity='1';el.style.filter='none'}engine.snap()}});
  icons();return{open:()=>change(true),close:(focus=true)=>change(false,focus),destroy(){disposed=true;controller.abort();swap.forEach(a=>a.cancel());engine.destroy();slot.replaceChildren()}};
 }
 function tooltip(root){const ac=new AbortController(),signal=ac.signal;const tip=document.createElement('div'),tail=document.createElement('div'),hl=document.createElement('div');tip.className='ac-morph-tip';tip.id='ac-morph-tip';tip.setAttribute('role','tooltip');tip.setAttribute('aria-hidden','true');tail.className='ac-morph-tail';hl.className='ac-morph-highlight';tail.setAttribute('aria-hidden','true');hl.setAttribute('aria-hidden','true');root.append(hl,tail,tip);const labels=new Map(),all=[];const L=S(0,620,36),R=S(0,620,36),X=S(0,300,22),HL=S(0,620,36),HR=S(0,620,36),A=S(0,420,24),springs=[L,R,X,HL,HR,A];let current=null,hideTimer=0,top=0,toolY=0,toolH=30,tailTop=0,below=false,dead=false;const mq=reduceQuery();
  function info(el){if(labels.has(el)){const data=labels.get(el);data.label.textContent=el.dataset.morphTooltip;data.icon=el.querySelector('svg,[data-lucide]');return data;}const label=document.createElement('span');label.className='ac-morph-label';label.setAttribute('aria-hidden','true');label.textContent=el.dataset.morphTooltip;tip.appendChild(label);const value={el,label,o:S(0,420,32),p:S(1,520,16),dir:0,icon:el.querySelector('svg,[data-lucide]'),width:Math.max(60,label.offsetWidth)};labels.set(el,value);all.push(value);springs.push(value.o,value.p);return value;}
  const engine=scheduler(springs,()=>{const a=clamp(A.x,0,1.15),opacity=clamp(A.x,0,1);const left0=Math.min(L.x,R.x-30),w=Math.max(30,R.x-left0),left=clamp(left0,8,Math.max(8,root.clientWidth-w-8));tip.style.width=w+'px';tip.style.opacity=String(opacity);tip.style.transform='translate('+left+'px,'+(top+(1-a)*6)+'px) scale('+(.72+.28*a)+')';tail.style.opacity=String(opacity);tail.style.transform='translate('+(clamp(X.x,left+12,left+w-12)-5)+'px,'+(tailTop+(1-a)*8)+'px) rotate(45deg) scale('+a+')';hl.style.opacity=String(opacity);hl.style.width=Math.max(20,HR.x-HL.x)+'px';hl.style.height=toolH+'px';hl.style.transform='translate('+HL.x+'px,'+toolY+'px)';for(const i of all){const o=clamp(i.o.x,0,1);i.label.style.opacity=String(o);i.label.style.transform='translateX(calc(-50% + '+(i.dir*(1-o)*14)+'px))';i.label.style.filter=o>.02&&o<.98?'blur('+((1-o)*3)+'px)':'none';if(i.icon)i.icon.style.transform='scale('+i.p.x+')';}tip.setAttribute('aria-hidden',String(opacity<.01));},root);
  function point(el,selected=false){if(dead||!el||el.disabled)return;if(el.closest('[hidden]')){leave();return;}clearTimeout(hideTimer);const data=info(el),rr=root.getBoundingClientRect(),br=el.getBoundingClientRect(),c=br.left-rr.left+br.width/2,ny=br.top-rr.top;const changedRow=current&&Math.abs(ny-toolY)>60;below=ny<50;top=below?ny+br.height+11:ny-46;tailTop=below?top-4:top+29;toolY=ny;toolH=br.height;data.width=Math.min(root.clientWidth-16,Math.max(60,data.label.offsetWidth));const left=c-data.width/2,right=c+data.width/2,dir=current?Math.sign(c-X.t):0;const snap=A.x<.3||changedRow||prefersReduced(root,mq);
   if(current&&current!==el)current.removeAttribute('aria-describedby');current=el;tip.setAttribute('aria-label',el.dataset.morphTooltip);el.setAttribute('aria-describedby','ac-morph-tip');if(snap){[[L,left],[R,right],[X,c],[HL,br.left-rr.left],[HR,br.right-rr.left]].forEach(([s,v])=>{s.x=s.t=v;s.v=0});for(const i of all){i.o.x=i.o.t=i===data?1:0;i.o.v=0;i.dir=0}}else{const rightward=dir>=0;[R,HR].forEach(s=>{s.k=rightward?620:190;s.c=rightward?36:19});[L,HL].forEach(s=>{s.k=rightward?190:620;s.c=rightward?19:36});L.t=left;R.t=right;X.t=c;HL.t=br.left-rr.left;HR.t=br.right-rr.left;for(const i of all){if(i===data){i.dir=dir;i.o.t=1}else if(i.o.t===1){i.dir=-dir;i.o.t=0}}}A.t=1;if(selected&&!prefersReduced(root,mq)){data.p.x=.78;A.x=Math.min(A.x,.9)}engine.wake();}
  function leave(){clearTimeout(hideTimer);hideTimer=setTimeout(()=>{A.t=0;if(current)current.removeAttribute('aria-describedby');current=null;engine.wake()},140)}
  function target(e){return e.target.closest?.('[data-morph-tooltip]')}
  root.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=target(e);if(el&&!el.contains(e.relatedTarget))point(el)},{signal});root.addEventListener('pointerout',e=>{const el=target(e);if(el&&!el.contains(e.relatedTarget))leave()},{signal});root.addEventListener('focusin',e=>{const el=target(e);if(el)point(el)},{signal});root.addEventListener('focusout',e=>{if(target(e))leave()},{signal});root.addEventListener('click',e=>{const el=target(e);if(el)point(el,true)},{signal});root.addEventListener('keydown',e=>{if(e.key==='Escape'){clearTimeout(hideTimer);A.t=0;if(current)current.removeAttribute('aria-describedby');current=null;engine.wake()}},{signal});return{destroy(){dead=true;ac.abort();clearTimeout(hideTimer);engine.destroy();for(const i of all){i.el.removeAttribute('aria-describedby');if(i.icon)i.icon.style.transform=''}tip.remove();tail.remove();hl.remove()}};
 }
 window.AthenaControls={command,tooltip};
})();
