/* Athena controls. Design references: DesignBookmark Motion Studies
 * (https://designbookmark.com/motion): Command Button and Morph Tooltip.
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
 function tooltip(root){const ac=new AbortController(),signal=ac.signal;const tip=document.createElement('div'),tail=document.createElement('div'),hl=document.createElement('div');tip.className='ac-morph-tip';tip.id='ac-morph-tip';tip.setAttribute('role','tooltip');tip.setAttribute('aria-hidden','true');tail.className='ac-morph-tail';hl.className='ac-morph-highlight';tail.setAttribute('aria-hidden','true');hl.setAttribute('aria-hidden','true');root.append(hl,tail,tip);const labels=new Map(),all=[];const L=S(0,620,36),R=S(0,620,36),X=S(0,300,22),HL=S(0,620,36),HR=S(0,620,36),A=S(0,420,24),springs=[L,R,X,HL,HR,A];let current=null,hideTimer=0,top=0,toolY=0,toolH=30,tailTop=0,dead=false;const mq=reduceQuery();
  function info(el){if(labels.has(el)){const data=labels.get(el);data.label.textContent=el.dataset.morphTooltip;data.icon=el.querySelector('svg,[data-lucide]');return data;}const label=document.createElement('span');label.className='ac-morph-label';label.setAttribute('aria-hidden','true');label.textContent=el.dataset.morphTooltip;tip.appendChild(label);const value={el,label,o:S(0,420,32),p:S(1,520,16),dir:0,icon:el.querySelector('svg,[data-lucide]'),width:Math.max(60,label.offsetWidth)};labels.set(el,value);all.push(value);springs.push(value.o,value.p);return value;}
  function drawTooltip() {
   const progress = Math.min(1.15, Math.max(0, A.x));
   const gap = 1 - progress;
   const width = Math.max(R.x - L.x, 30);
   const origin = clamp(R.x - width, 8, Math.max(8, root.clientWidth - 8 - width));
   const tailX = clamp(X.x - origin, 12, width - 12) + origin - 5;
   const alpha = String(Math.min(1, progress));
   Object.assign(tip.style, { width: width + 'px', opacity: alpha, translate: origin + 'px ' + (top + gap * 6) + 'px', scale: String(1 - gap * .28) });
   Object.assign(tail.style, { opacity: alpha, translate: tailX + 'px ' + (tailTop + gap * 8) + 'px', rotate: '45deg', scale: String(progress) });
   Object.assign(hl.style, { opacity: alpha, width: Math.max(HR.x - HL.x, 20) + 'px', height: toolH + 'px', translate: HL.x + 'px ' + toolY + 'px' });
   for (const entry of all) {
    const opacity = clamp(entry.o.x, 0, 1);
    const offset = entry.dir * (1 - opacity) * 14;
    entry.label.style.opacity = String(opacity);
    entry.label.style.translate = 'calc(-50% + ' + offset + 'px)';
    entry.label.style.filter = opacity > .02 && opacity < .98 ? 'blur(' + (3 - opacity * 3) + 'px)' : 'none';
    if (entry.icon) entry.icon.style.transform = 'scale(' + entry.p.x + ')';
   }
   tip.setAttribute('aria-hidden', String(progress < .01));
  }
  const engine = scheduler(springs, drawTooltip, root);
  function point(el, selected = false) {
   if (dead || !el || el.disabled) return;
   if (el.closest('[hidden]')) { leave(); return; }
   clearTimeout(hideTimer);
   const data = info(el);
   const rootBox = root.getBoundingClientRect();
   const box = el.getBoundingClientRect();
   const x = box.left - rootBox.left;
   const y = box.top - rootBox.top;
   const center = x + box.width / 2;
   const width = Math.min(root.clientWidth - 16, Math.max(60, data.label.offsetWidth));
   const motionOff = prefersReduced(root, mq);
   const jump = motionOff || A.x < .3 || (current !== null && Math.abs(y - toolY) > 60);
   const travel = current ? Math.sign(center - X.t) : 0;
   const leadOnLeft = travel < 0;
   const targets = [center - width / 2, center + width / 2, center, x, box.right - rootBox.left];
   for (const [index, spring] of [L, R, X, HL, HR].entries()) {
    const end = targets[index];
    spring.t = end;
    if (jump) { spring.x = end; spring.v = 0; }
    else if (spring !== X) {
     const leading = (spring === L || spring === HL) === leadOnLeft;
     spring.k = leading ? 620 : 190;
     spring.c = leading ? 36 : 19;
    }
   }
   for (const entry of all) {
    const incoming = entry === data;
    if (jump) { entry.dir = 0; entry.o.v = 0; entry.o.x = Number(incoming); }
    else if (incoming || entry.o.t === 1) entry.dir = incoming ? travel : -travel;
    entry.o.t = Number(incoming);
   }
   if (current !== el) current?.removeAttribute('aria-describedby');
   current = el;
   el.setAttribute('aria-describedby', tip.id);
   tip.setAttribute('aria-label', el.dataset.morphTooltip);
   toolH = box.height;
   toolY = y;
   top = y + (y < 50 ? toolH + 11 : -46);
   tailTop = top + (y < 50 ? -4 : 29);
   if (selected && !motionOff) {
    const press = data.p;
    press.x = press.t - .22;
    if (A.x > .9) A.x = .9;
   }
   A.t = 1;
   engine.wake();
  }
  function leave(){clearTimeout(hideTimer);hideTimer=setTimeout(()=>{A.t=0;if(current)current.removeAttribute('aria-describedby');current=null;engine.wake()},140)}
  function target(e){return e.target.closest?.('[data-morph-tooltip]')}
  root.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=target(e);if(el&&!el.contains(e.relatedTarget))point(el)},{signal});root.addEventListener('pointerout',e=>{const el=target(e);if(el&&!el.contains(e.relatedTarget))leave()},{signal});root.addEventListener('focusin',e=>{const el=target(e);if(el)point(el)},{signal});root.addEventListener('focusout',e=>{if(target(e))leave()},{signal});root.addEventListener('click',e=>{const el=target(e);if(el)point(el,true)},{signal});root.addEventListener('keydown',e=>{if(e.key==='Escape'){clearTimeout(hideTimer);A.t=0;if(current)current.removeAttribute('aria-describedby');current=null;engine.wake()}},{signal});return{destroy(){dead=true;ac.abort();clearTimeout(hideTimer);engine.destroy();for(const i of all){i.el.removeAttribute('aria-describedby');if(i.icon)i.icon.style.transform=''}tip.remove();tail.remove();hl.remove()}};
 }
 window.AthenaControls={command,tooltip};
})();
