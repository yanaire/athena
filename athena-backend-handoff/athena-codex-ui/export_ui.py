#!/usr/bin/env python3
"""Export the Athena HTML design to true vector SVG and a native Figma import kit.

This is a local design-file exporter. It never calls Figma or any network API.
The optional import script is run by the user inside a Figma development plugin.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright


VIEWS = [
    ("conversation", "01-conversation-collapsed", "대화 · 연구 패널 닫힘"),
    ("results", "02-results-sidebar-open", "결과 사이드바"),
    ("manuscript", "03-manuscript-sidebar-open", "원고 사이드바"),
    ("workflow", "04-workflow-sidebar-open", "워크플로우 사이드바"),
]


EXTRACT_JS = r"""
({rootSelector, view, title}) => {
  const root = document.querySelector(rootSelector);
  if (!root) throw new Error('Missing root ' + rootSelector);
  const rr = root.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const warnings = [];
  let serial = 0;
  const R = n => Math.round(n * 1000) / 1000;
  const toBox = r => ({x:R(r.x-rr.x), y:R(r.y-rr.y), width:R(r.width), height:R(r.height)});
  const intersection = (a,b) => {
    const x=Math.max(a.x,b.x), y=Math.max(a.y,b.y);
    const right=Math.min(a.x+a.width,b.x+b.width), bottom=Math.min(a.y+a.height,b.y+b.height);
    return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
  };
  const visibleIntersection=(b,c)=>intersection(b,c).width>.15 && intersection(b,c).height>.15;
  const isPaint = c => c && c!=='transparent' && c!=='none' && !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(c);
  const makeName = el => el.getAttribute('data-figma-name') || el.getAttribute('aria-label') ||
    (el.tagName.toLowerCase() + (typeof el.className==='string' && el.className.trim() ? '/' + el.className.trim().split(/\s+/).slice(0,2).join('.') : ''));
  const withClip = (rec,clip) => {
    if (rec.x < clip.x-.05 || rec.y < clip.y-.05 || rec.x+rec.width > clip.x+clip.width+.05 || rec.y+rec.height > clip.y+clip.height+.05)
      rec.clip={x:R(clip.x),y:R(clip.y),width:R(clip.width),height:R(clip.height)};
    return rec;
  };
  const textRecord = (text,b,s,opacity,clip,name) => {
    if (!text || !visibleIntersection(b,clip)) return null;
    const size=parseFloat(s.fontSize)||14;
    ctx.font=`${s.fontStyle} ${s.fontWeight} ${size}px ${s.fontFamily}`;
    const mt=ctx.measureText('Hg한');
    const ascent=mt.fontBoundingBoxAscent || mt.actualBoundingBoxAscent || size*.9;
    const descent=mt.fontBoundingBoxDescent || mt.actualBoundingBoxDescent || size*.25;
    const baseline=b.y+(b.height-(ascent+descent))/2+ascent;
    let rendered=text;
    if(s.textTransform==='uppercase') rendered=text.toUpperCase();
    if(s.textTransform==='lowercase') rendered=text.toLowerCase();
    return withClip({type:'text',name:name||rendered.slice(0,64),text:rendered,...b,
      baseline:R(baseline),fontFamily:s.fontFamily,fontSize:size,fontWeight:s.fontWeight,
      fontStyle:s.fontStyle,letterSpacing:parseFloat(s.letterSpacing)||0,
      lineHeight:parseFloat(s.lineHeight)||size*1.5,
      decoration:s.textDecorationLine,fill:s.color,opacity:R(opacity)},clip);
  };
  function textLines(node,out,s,opacity,clip) {
    const original=node.nodeValue||'';
    if(!original.trim()) return;
    const range=document.createRange();
    let offset=0, line=null;
    for(const char of Array.from(original)) {
      const next=offset+char.length;
      range.setStart(node,offset);range.setEnd(node,next);offset=next;
      const rect=range.getBoundingClientRect();
      if(rect.width<.01 || rect.height<.01) continue;
      const b=toBox(rect);
      if(!line || Math.abs(line.y-b.y)>1.5 || b.x < line.lastX-2) {
        if(line) {
          const rec=textRecord(line.text,{x:line.x,y:line.y,width:line.right-line.x,height:line.height},s,opacity,clip);
          if(rec) out.push(rec);
        }
        line={text:char,x:b.x,y:b.y,right:b.x+b.width,height:b.height,lastX:b.x};
      } else {
        line.text+=char;line.right=Math.max(line.right,b.x+b.width);line.height=Math.max(line.height,b.height);line.lastX=b.x;
      }
    }
    if(line) {
      const rec=textRecord(line.text,{x:line.x,y:line.y,width:line.right-line.x,height:line.height},s,opacity,clip);
      if(rec)out.push(rec);
    }
    range.detach();
  }
  function addControlText(el,out,s,opacity,clip,b) {
    const isSelect=el.tagName==='SELECT';
    const text=isSelect ? (el.selectedOptions[0]?.textContent||'') : (el.value||el.getAttribute('placeholder')||'');
    if(!text) return;
    const placeholder=!isSelect&&!el.value;
    const ps=placeholder?getComputedStyle(el,'::placeholder'):s;
    const style={fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,fontStyle:s.fontStyle,
      letterSpacing:s.letterSpacing,lineHeight:s.lineHeight,textTransform:s.textTransform,textDecorationLine:s.textDecorationLine,color:ps.color};
    const size=parseFloat(s.fontSize)||14, lh=parseFloat(s.lineHeight)||size*1.5;
    ctx.font=`${s.fontStyle} ${s.fontWeight} ${size}px ${s.fontFamily}`;
    const left=(parseFloat(s.paddingLeft)||0)+(parseFloat(s.borderLeftWidth)||0);
    const right=(parseFloat(s.paddingRight)||0)+(parseFloat(s.borderRightWidth)||0);
    const top=(parseFloat(s.paddingTop)||0)+(parseFloat(s.borderTopWidth)||0);
    const max=Math.max(1,b.width-left-right);
    const lines=[];
    for(const para of text.split('\n')) {
      let line='';
      for(const ch of Array.from(para)) {
        if(el.tagName==='TEXTAREA' && line && ctx.measureText(line+ch).width>max) {lines.push(line);line=ch;}
        else line+=ch;
      }
      lines.push(line);
    }
    lines.forEach((line,i)=>{
      const w=Math.min(max,ctx.measureText(line).width);
      let x=b.x+left;
      if(s.textAlign==='center')x=b.x+(b.width-w)/2;
      if(s.textAlign==='right'||s.textAlign==='end')x=b.x+b.width-right-w;
      const y=el.tagName==='TEXTAREA'?b.y+top+i*lh:b.y+(b.height-lh)/2;
      const rec=textRecord(line,{x:R(x),y:R(y),width:R(w),height:R(lh)},style,opacity,clip,placeholder?'Input placeholder':'Input value');
      if(rec)out.push(rec);
    });
  }
  function svgSource(el,b) {
    const clone=el.cloneNode(true);
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
    clone.setAttribute('width',String(b.width));clone.setAttribute('height',String(b.height));
    if(!clone.getAttribute('viewBox'))clone.setAttribute('viewBox',`0 0 ${b.width} ${b.height}`);
    const src=[el,...el.querySelectorAll('*')], dest=[clone,...clone.querySelectorAll('*')];
    const paintProps=['fill','fill-opacity','fill-rule','stroke','stroke-opacity','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','opacity','font-family','font-size','font-weight','font-style','letter-spacing','text-anchor','dominant-baseline','visibility'];
    for(let i=0;i<src.length;i++) {
      const c=getComputedStyle(src[i]), d=dest[i];
      d.removeAttribute('class');d.removeAttribute('style');
      for(const p of paintProps){const val=c.getPropertyValue(p);if(val)d.setAttribute(p,val);}
      const color=c.color;
      for(const a of ['fill','stroke'])if(d.getAttribute(a)==='currentColor')d.setAttribute(a,color);
      // Inline SVG charts may use CSS variables in presentation attributes.
      for(const at of Array.from(d.attributes))if(/var\(/.test(at.value))d.removeAttribute(at.name);
    }
    // The outer element opacity is already represented by the scene record.
    clone.setAttribute('opacity','1');
    return new XMLSerializer().serializeToString(clone);
  }
  const interactions=[];
  function walk(el,out,clip,opacity,insideComponent) {
    if(el.nodeType!==1)return;
    const s=getComputedStyle(el);
    if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse')return;
    const op=opacity*(parseFloat(s.opacity)||0);
    if(op<=0.001)return;
    const b=toBox(el.getBoundingClientRect());
    if(!b.width || !b.height || !visibleIntersection(b,clip))return;
    const name=makeName(el);
    const componentName=el.getAttribute('data-figma-component') ||
      (el.classList.contains('windowbar')?'Titlebar':el.classList.contains('sidebar')?'Sidebar':el.classList.contains('statusbar')?'Statusbar':null);
    if(componentName && !insideComponent){
      const g={type:'group',name:componentName,componentName,...b,children:[]};out.push(g);
      walk(el,g.children,clip,opacity,true);return;
    }
    const target=el.getAttribute('data-view')||el.getAttribute('data-tab')||el.getAttribute('data-screen');
    if(target)interactions.push({...b,target,label:el.textContent.trim().slice(0,80)});
    if(el.tagName.toLowerCase()==='svg') {
      out.push(withClip({type:'svg',name,...b,source:svgSource(el,b),opacity:R(op)},clip));return;
    }
    const bg=s.backgroundColor;
    const rad=Math.min(parseFloat(s.borderTopLeftRadius)||0,b.width/2,b.height/2);
    if(isPaint(bg))out.push(withClip({type:'rect',name:name+' / background',...b,radius:R(rad),fill:bg,opacity:R(op)},clip));
    if(s.backgroundImage && s.backgroundImage!=='none')warnings.push('Background image/gradient not exported: '+name);
    const sides=['Top','Right','Bottom','Left'];
    const bw=sides.map(q=>parseFloat(s['border'+q+'Width'])||0);
    const bc=sides.map(q=>s['border'+q+'Color']);
    const bs=sides.map(q=>s['border'+q+'Style']);
    if(bw[0]>0 && bw.every(v=>v===bw[0]) && bc.every(v=>v===bc[0]) && bs.every(v=>v===bs[0]) && isPaint(bc[0]) && bs[0]!=='none'){
      const stroke=bw[0];
      out.push(withClip({type:'rect',name:name+' / border',x:R(b.x+stroke/2),y:R(b.y+stroke/2),width:R(Math.max(.1,b.width-stroke)),height:R(Math.max(.1,b.height-stroke)),radius:R(Math.max(0,rad-stroke/2)),fill:'none',stroke:bc[0],strokeWidth:stroke,dash:bs[0]==='dashed'?[stroke*4,stroke*3]:bs[0]==='dotted'?[stroke,stroke*2]:[],opacity:R(op)},clip));
    } else {
      for(let i=0;i<4;i++)if(bw[i]>0&&isPaint(bc[i])&&bs[i]!=='none'){
        const t=bw[i];let x=b.x,y=b.y,w=b.width,h=t;
        if(i===1){x=b.x+b.width-t;w=t;h=b.height;}
        if(i===2)y=b.y+b.height-t;
        if(i===3){w=t;h=b.height;}
        out.push(withClip({type:'rect',name:name+' / '+sides[i].toLowerCase()+' border',x:R(x),y:R(y),width:R(w),height:R(h),radius:0,fill:bc[i],opacity:R(op)},clip));
      }
    }
    let childClip=clip;
    if(['hidden','clip','auto','scroll'].includes(s.overflowX)||['hidden','clip','auto','scroll'].includes(s.overflowY))childClip=intersection(clip,b);
    if(['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
      addControlText(el,out,s,op,childClip,b);return;
    }
    for(const child of el.childNodes) {
      if(child.nodeType===3)textLines(child,out,s,op,childClip);
      else if(child.nodeType===1)walk(child,out,childClip,op,insideComponent);
    }
  }
  const elements=[];
  walk(root,elements,{x:0,y:0,width:rr.width,height:rr.height},1,false);
  return {version:1,view,title,width:R(rr.width),height:R(rr.height),elements,interactions,warnings:[...new Set(warnings)]};
}
"""


def f(num: float) -> str:
    return f"{num:.3f}".rstrip("0").rstrip(".")


def attrs(**values) -> str:
    return " ".join(f'{k.replace("_", "-")}="{html.escape(str(v), quote=True)}"' for k, v in values.items() if v is not None)


def scene_to_svg(scene: dict) -> str:
    definitions: list[str] = []
    counter = [0]

    def draw(rec: dict) -> str:
        typ = rec["type"]
        opacity = rec.get("opacity", 1)
        if typ == "group":
            content = "\n".join(draw(x) for x in rec["children"])
            return f'<g id="group-{counter[0]}" aria-label="{html.escape(rec["name"], quote=True)}">{content}</g>'
        counter[0] += 1
        if typ == "rect":
            content = "<rect " + attrs(
                x=f(rec["x"]), y=f(rec["y"]), width=f(rec["width"]), height=f(rec["height"]),
                rx=f(rec.get("radius", 0)), fill=rec.get("fill", "none"),
                stroke=rec.get("stroke"), stroke_width=rec.get("strokeWidth"),
                stroke_dasharray=" ".join(map(str, rec["dash"])) if rec.get("dash") else None,
                opacity=f(opacity),
            ) + "/>"
        elif typ == "text":
            content = "<text " + attrs(
                x=f(rec["x"]), y=f(rec["baseline"]), fill=rec["fill"], opacity=f(opacity),
                font_family=rec["fontFamily"], font_size=f(rec["fontSize"]),
                font_weight=rec["fontWeight"], font_style=rec.get("fontStyle", "normal"),
                letter_spacing=f(rec.get("letterSpacing", 0)) if rec.get("letterSpacing") else None,
                text_decoration=rec.get("decoration") if rec.get("decoration") not in (None, "none") else None,
            ) + ' xml:space="preserve">' + html.escape(rec["text"]) + "</text>"
        elif typ == "svg":
            source = rec["source"]
            prefix = f'v{counter[0]}-'
            ids = re.findall(r'\bid="([^"]+)"', source)
            for old in ids:
                source = source.replace(f'id="{old}"', f'id="{prefix}{old}"')
                source = source.replace(f'url(#{old})', f'url(#{prefix}{old})')
                source = source.replace(f'href="#{old}"', f'href="#{prefix}{old}"')
            source = re.sub(r'<svg\b', '<svg '+attrs(x=f(rec["x"]), y=f(rec["y"])), source, count=1)
            content = f'<g opacity="{f(opacity)}">{source}</g>'
        else:
            raise ValueError(f"Unsupported SVG record type {typ}")
        if rec.get("clip"):
            c=rec["clip"]; clip_id=f'clip-{counter[0]}'
            definitions.append('<clipPath id="'+clip_id+'"><rect '+attrs(x=f(c["x"]),y=f(c["y"]),width=f(c["width"]),height=f(c["height"]))+'/></clipPath>')
            content=f'<g clip-path="url(#{clip_id})">{content}</g>'
        return content

    body = "\n".join(draw(rec) for rec in scene["elements"])
    result = '<?xml version="1.0" encoding="UTF-8"?>\n<svg ' + attrs(
        xmlns="http://www.w3.org/2000/svg", width=f(scene["width"]), height=f(scene["height"]),
        viewBox=f'0 0 {f(scene["width"])} {f(scene["height"])}', role="img", aria_label=f'Athena · {scene["title"]} · UI design example',
    ) + '>\n<title>'+html.escape('Athena · '+scene['title'])+'</title>\n<desc>편집 가능한 텍스트와 벡터 도형으로 구성한 앱 UI 시안. 연구 결과와 연결 상태는 예시입니다.</desc>\n<defs>'+"\n".join(definitions)+'</defs>\n'+body+'\n</svg>\n'
    ET.fromstring(result)
    return result


def normalize_group(rec: dict) -> dict:
    origin_x, origin_y = rec["x"], rec["y"]
    def normalize(r: dict) -> dict:
        r = copy.deepcopy(r)
        if "x" in r: r["x"] = round(r["x"] - origin_x, 3)
        if "y" in r: r["y"] = round(r["y"] - origin_y, 3)
        if "baseline" in r: r["baseline"] = round(r["baseline"] - origin_y, 3)
        if "clip" in r:
            r["clip"]["x"] = round(r["clip"]["x"] - origin_x, 3)
            r["clip"]["y"] = round(r["clip"]["y"] - origin_y, 3)
        if "children" in r: r["children"] = [normalize(x) for x in r["children"]]
        return r
    return normalize(rec)


def componentize(scenes: list[dict]) -> dict:
    result = copy.deepcopy(scenes)
    components: dict[str, dict] = {}
    for scene in result:
        updated = []
        for rec in scene["elements"]:
            if rec["type"] == "group" and rec.get("componentName"):
                normalized = normalize_group(rec)
                raw = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                key = hashlib.sha256(raw.encode()).hexdigest()[:16]
                components.setdefault(key, normalized)
                updated.append({"type":"instance", "name":rec["name"], "componentKey":key,
                                "x":rec["x"],"y":rec["y"],"width":rec["width"],"height":rec["height"]})
            else:
                updated.append(rec)
        scene["elements"] = updated
    return {"format":"athena-native-ui-v1", "exampleData":True, "components":components,"screens":result}


IMPORTER_JS = r"""
// Athena UI importer — local standard Figma Plugin API, no network requests.
// Create a development plugin in Figma, then replace its code.js with this file.
const DESIGN = __DESIGN_JSON__;

(async () => {
  const allFonts = (await figma.listAvailableFontsAsync()).map(x => x.fontName);
  const koreanFamilies = ['Noto Sans KR','Noto Sans CJK KR','Pretendard','Apple SD Gothic Neo','Malgun Gothic'];
  const koreanFamily = koreanFamilies.find(f => allFonts.some(x => x.family === f));
  if (!koreanFamily) throw new Error('한글 글꼴이 필요합니다. Noto Sans KR을 사용할 수 있게 한 뒤 다시 실행해 주세요.');
  const fontCache = new Map();
  const loaded = new Set();
  const hasKorean = rec => /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(rec.text || '');
  const fontKey = rec => JSON.stringify([rec.fontFamily,rec.fontWeight,rec.fontStyle,hasKorean(rec)]);
  function chooseFont(rec) {
    const raw = rec.fontFamily || '';
    const mono = /mono/i.test(raw);
    const serif = /serif/i.test(raw) && !/sans/i.test(raw);
    const declared = raw.split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(s=>!['sans-serif','serif','monospace','system-ui'].includes(s));
    const safeDeclared=hasKorean(rec)?declared.filter(s=>/Noto.*KR|Pretendard|Apple SD Gothic Neo|Malgun Gothic/i.test(s)):declared;
    const fallback = serif ? ['Noto Serif KR','Noto Serif CJK KR',koreanFamily] : mono ? hasKorean(rec)?['Noto Sans Mono CJK KR',koreanFamily]:['IBM Plex Mono','Roboto Mono','Noto Sans Mono CJK KR','Inter',koreanFamily] : hasKorean(rec)?['Noto Sans KR','Noto Sans CJK KR',koreanFamily]:['Inter','Noto Sans KR','Noto Sans CJK KR',koreanFamily];
    const prefs = [...safeDeclared,...fallback];
    const family = prefs.find(f=>allFonts.some(x=>x.family===f)) || koreanFamily;
    const weight = Number(rec.fontWeight) || 400;
    const weightPrefs = weight >= 650 ? ['Bold','SemiBold','Semi Bold','Medium','Regular'] : weight >= 500 ? ['Medium','SemiBold','Semi Bold','Regular','Bold'] : ['Regular','Normal','Book','Medium'];
    const stylePrefs = rec.fontStyle==='italic' ? [...weightPrefs.map(s=>s==='Regular'?'Italic':s+' Italic'),'Italic',...weightPrefs] : weightPrefs;
    const available=allFonts.filter(x=>x.family===family);
    const chosen=stylePrefs.map(st=>available.find(x=>x.style===st)).find(Boolean)||available[0];
    return chosen;
  }
  function walkRecords(records,cb){for(const r of records){cb(r);if(r.children)walkRecords(r.children,cb);}}
  const textRecs=[];
  Object.values(DESIGN.components).forEach(c=>walkRecords(c.children,r=>{if(r.type==='text')textRecs.push(r);}));
  DESIGN.screens.forEach(s=>walkRecords(s.elements,r=>{if(r.type==='text')textRecs.push(r);}));
  for(const r of textRecs){const f=chooseFont(r);fontCache.set(fontKey(r),f);loaded.add(JSON.stringify(f));}
  await Promise.all([...loaded].map(s=>figma.loadFontAsync(JSON.parse(s))));

  // Font preflight completes before adding any canvas content.
  const page=figma.createPage();page.name='Athena · Conversation UI';
  await figma.setCurrentPageAsync(page);
  const collection=figma.variables.createVariableCollection('Athena / UI colors');
  const colorVars=new Map();
  const labels={'#eeede5':'surface/sidebar','#f5f4ed':'surface/chat','#ffffff':'surface/research-panel','#e8e6dc':'border/default','#141413':'text/primary','#5e5d59':'text/secondary','#c96442':'accent/terracotta','#30302e':'surface/dark','#f0eee6':'border/hairline'};
  function rgba(value) {
    if(!value||value==='none'||value==='transparent')return null;
    const v=value.trim();
    if(v[0]==='#'){
      let h=v.slice(1);if(h.length===3)h=h.split('').map(c=>c+c).join('');
      return {r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255,a:h.length>=8?parseInt(h.slice(6,8),16)/255:1};
    }
    const m=v.match(/rgba?\(([^)]+)\)/);if(!m)return {r:0,g:0,b:0,a:1};
    const p=m[1].replace(/\//g,',').split(/[ ,]+/).filter(Boolean).map(Number);
    return {r:p[0]/255,g:p[1]/255,b:p[2]/255,a:p.length>3?p[3]:1};
  }
  function paints(value) {
    const c=rgba(value);if(!c||c.a<=0)return [];
    const key='#'+[c.r,c.g,c.b].map(n=>Math.round(n*255).toString(16).padStart(2,'0')).join('');
    let variable=colorVars.get(key);
    if(!variable){variable=figma.variables.createVariable(labels[key]||'palette/'+key.slice(1),collection,'COLOR');variable.scopes=['FRAME_FILL','SHAPE_FILL','TEXT_FILL','STROKE_COLOR'];variable.setValueForMode(collection.defaultModeId,{r:c.r,g:c.g,b:c.b,a:1});colorVars.set(key,variable);}
    return [figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:c.r,g:c.g,b:c.b},opacity:c.a},'color',variable)];
  }
  const masters=new Map();
  let count=0;
  function appendRecord(rec,parent,ox=0,oy=0) {
    if(rec.type==='instance'){
      const master=masters.get(rec.componentKey);if(!master)throw new Error('Missing component '+rec.componentKey);
      const n=master.createInstance();n.name=rec.name;parent.appendChild(n);n.x=rec.x-ox;n.y=rec.y-oy;count++;return n;
    }
    if(rec.type==='group'){
      const n=figma.createFrame();n.name=rec.name;n.fills=[];n.clipsContent=false;n.resize(Math.max(.1,rec.width),Math.max(.1,rec.height));parent.appendChild(n);n.x=rec.x-ox;n.y=rec.y-oy;
      for(const child of rec.children)appendRecord(child,n,rec.x,rec.y);count++;return n;
    }
    let container=parent, dx=ox,dy=oy;
    if(rec.clip){
      const c=rec.clip;
      const clip=figma.createFrame();clip.name='Clip / '+rec.name;clip.fills=[];clip.clipsContent=true;clip.resize(Math.max(.1,c.width),Math.max(.1,c.height));parent.appendChild(clip);clip.x=c.x-ox;clip.y=c.y-oy;container=clip;dx=c.x;dy=c.y;
    }
    let n;
    if(rec.type==='rect'){
      n=figma.createRectangle();n.resize(Math.max(.1,rec.width),Math.max(.1,rec.height));n.cornerRadius=Math.min(rec.radius||0,rec.width/2,rec.height/2);n.fills=paints(rec.fill);n.strokes=paints(rec.stroke);if(rec.stroke){n.strokeWeight=rec.strokeWidth||1;n.strokeAlign='CENTER';if(rec.dash?.length)n.dashPattern=rec.dash;}
    } else if(rec.type==='text'){
      n=figma.createText();n.fontName=fontCache.get(fontKey(rec))||chooseFont(rec);n.fontSize=rec.fontSize;n.characters=rec.text;n.fills=paints(rec.fill);n.textAutoResize='WIDTH_AND_HEIGHT';n.lineHeight={unit:'PIXELS',value:rec.lineHeight||rec.fontSize*1.5};if(rec.letterSpacing)n.letterSpacing={unit:'PIXELS',value:rec.letterSpacing};if(rec.decoration?.includes('underline'))n.textDecoration='UNDERLINE';
    } else if(rec.type==='svg') {
      n=figma.createNodeFromSvg(rec.source);n.resize(Math.max(.1,rec.width),Math.max(.1,rec.height));
    } else throw new Error('Unknown design record '+rec.type);
    container.appendChild(n);n.name=rec.name;n.x=rec.x-dx;
    n.y=rec.type==='text'?rec.y-dy+(rec.height-n.height)/2:rec.y-dy;
    if(rec.opacity!==undefined)n.opacity=rec.opacity;
    count++;return n;
  }
  let componentY=0;
  for(const [key,rec] of Object.entries(DESIGN.components)){
    const comp=figma.createComponent();comp.name='Athena / '+rec.name+' / '+key.slice(0,4);comp.fills=[];comp.clipsContent=false;comp.resize(rec.width,rec.height);page.appendChild(comp);comp.x=3220;comp.y=componentY;
    for(const r of rec.children)appendRecord(r,comp,0,0);
    masters.set(key,comp);componentY+=rec.height+64;
  }
  const frames=[];
  DESIGN.screens.forEach((screen,i)=>{
    const frame=figma.createFrame();frame.name=String(i+1).padStart(2,'0')+' · '+screen.title;frame.resize(screen.width,screen.height);frame.fills=[];frame.clipsContent=true;page.appendChild(frame);frame.x=(i%2)*1540;frame.y=Math.floor(i/2)*1070;
    for(const r of screen.elements)appendRecord(r,frame,0,0);
    frames.push(frame);
  });
  figma.viewport.scrollAndZoomIntoView([frames[0]]);
  figma.currentPage.selection=[frames[0]];
  figma.closePlugin('Athena '+frames.length+'개 화면을 가져왔습니다. 텍스트·도형·색상 변수와 반복 탐색 컴포넌트를 편집할 수 있습니다.');
})().catch(error=>{figma.closePlugin('Athena 가져오기 오류: '+error.message);});
"""


README = '# Athena — 대화 중심 데스크톱 UI\n\nCodex처럼 대화를 중심에 두고, 연구 결과·워크플로우·원고를 오른쪽에서 접고 펼치는 Athena UI 시안입니다. 첨부 DESIGN.md의 따뜻한 아이보리·화이트·테라코타 색상 참고를 앱 밀도에 맞게 적용했습니다. 실제 사용 글꼴은 Noto Sans CJK KR과 시스템 폴백이며, Anthropic 전용 글꼴을 사용한 것으로 표시하지 않습니다.\n\n## 화면\n\n- `01-conversation-collapsed.svg`: 연구 패널을 닫은 기본 대화.\n- `02-results-sidebar-open.svg`: 결과와 원본 근거를 여는 오른쪽 패널.\n- `03-manuscript-sidebar-open.svg`: 원고를 여는 오른쪽 패널.\n- `04-workflow-sidebar-open.svg`: 연구 진행과 실행 상태를 여는 오른쪽 패널.\n\n모든 화면은 1440 × 960입니다. 왼쪽 프로젝트·스레드 탐색은 240px, 열린 오른쪽 패널은 420px입니다. 중앙 대화는 최대 760px이며 연구 패널을 닫으면 대화 공간이 넓어집니다. 중앙의 상단 탭은 없고, 오른쪽 패널 안에만 `워크플로우 | 결과 | 원고` 탭이 있습니다.\n\n연구 수치·진행 상태·프로그램 연결·원고는 디자인을 설명하는 예시입니다. 실제 계산 결과가 아닙니다.\n\n## 파일 확인\n\n- `athena-codex-preview.html`: 브라우저에서 여는 HTML 프로토타입.\n- `svg/`: 텍스트와 도형으로 직접 작성한 벡터 UI.\n- `athena-design.json`: 편집용 화면·색상·텍스트·벡터 데이터.\n- `figma-import/`: 네이티브 Figma 레이어 생성용 개발 플러그인 코드.\n\nHTML과 벡터는 별도 산출물입니다. 벡터를 브라우저 DOM이나 스크린샷에서 자동 추출한 것은 아니며, 동일한 디자인 방향과 콘텐츠로 직접 작성했습니다. 세부 간격은 다를 수 있습니다.\n\n## Figma로 가져오기\n\n가장 빠른 방법은 `svg/`의 화면을 Figma Design 캔버스로 끌어오는 것입니다. SVG 원본은 실제 텍스트와 벡터를 포함하지만, Figma가 글꼴을 대체하거나 글자를 윤곽선으로 변환할 수 있습니다.\n\n별도 텍스트 레이어를 유지하려면 다음 개발 플러그인 방법을 사용할 수 있습니다.\n\n1. Figma 데스크톱 앱에서 새 개발 플러그인을 만듭니다.\n2. Figma가 발급한 ID가 있는 `manifest.json`을 유지합니다.\n3. 생성된 `code.js`를 이 키트의 `figma-import/code.js`로 교체합니다.\n4. `manifest.settings.json`의 `main`, `api`, `editorType`, `documentAccess`, `networkAccess` 설정을 반영합니다. 이 파일은 Figma ID가 빠진 설정 참고 파일이며 단독 완성 manifest가 아닙니다.\n5. 원하는 Design 파일에서 실행합니다.\n\n플러그인은 새 `Athena · Conversation UI` 페이지를 추가하고 기존 페이지는 유지합니다. 네트워크 요청을 하지 않습니다. 실제 Figma 내부 실행은 현재 세션에서 검증하지 못했습니다.\n\nNoto Sans KR, Noto Sans CJK KR 등 한글 글꼴을 사전 확인하며, 한글 글꼴이 없으면 캔버스를 바꾸기 전에 중단합니다. 원본 글꼴 우선, 영문 대체 후보 Inter를 사용합니다. 사용 가능한 글꼴에 따라 세부 폭이나 줄 간격을 조정할 수 있습니다.\n\nFigma로 가져온 화면은 고정 배치의 편집 가능한 디자인이며, HTML에서 구현한 패널 열기·닫기 동작이 자동으로 Figma 프로토타입에 연결되지는 않습니다.\n\n## 검증 범위\n\nSVG XML, 벡터·텍스트 구성, 파일 크기, 코드 구문을 검사하고 Inkscape로 PNG를 생성해 확인했습니다. 브라우저 실행 및 Figma 내부 가져오기 성공을 주장하지 않습니다.\n\nLucide 아이콘을 사용했으며 동봉된 라이선스를 함께 보존해 주세요.\n'


def stats(records: list[dict]) -> dict:
    counts: dict[str,int]={}
    def visit(rs):
        for r in rs:
            counts[r["type"]]=counts.get(r["type"],0)+1
            if r.get("children"):visit(r["children"])
    visit(records)
    return counts


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input",nargs="?",default=str(Path(__file__).parent/"athena-codex-preview.html"))
    parser.add_argument("--out",default=str(Path(__file__).parent/"export"))
    parser.add_argument("--screenshots",action="store_true",help="Capture internal QA PNGs under qa/, not part of the vector import kit")
    parser.add_argument("--views",default="conversation,results,manuscript,workflow")
    parser.add_argument("--scene-data",help="Read existing scene JSON; never launches a browser in this mode")
    args=parser.parse_args()
    source=Path(args.input).resolve();out=Path(args.out).resolve()
    if not args.scene_data and not source.is_file():raise SystemExit(f"Input not ready: {source}")
    (out/"svg").mkdir(parents=True,exist_ok=True)
    scenes=[]
    selected=set(args.views.split(','))
    errors=[]
    if args.scene_data:
        supplied=json.loads(Path(args.scene_data).read_text(encoding="utf-8"))
        if isinstance(supplied,list):scenes=supplied
        elif "scenes" in supplied:scenes=supplied["scenes"]
        elif "elements" in supplied:scenes=[supplied]
        else:raise SystemExit("Scene JSON must contain an array of raw scenes or a 'scenes' list")
        scenes=[s for s in scenes if s["view"] in selected]
    else:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path="/usr/bin/chromium",headless=True,args=["--no-sandbox"])
            page=browser.new_page(viewport={"width":1440,"height":960},device_scale_factor=1)
            page.on("pageerror",lambda e:errors.append(str(e)))
            page.goto(source.as_uri(),wait_until="load")
            page.evaluate("document.fonts.ready")
            for view,filename,title in VIEWS:
                if view not in selected:continue
                page.evaluate("v => window.athenaShowView(v)",view)
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                scene=page.evaluate(EXTRACT_JS,{"rootSelector":"#athena-app","view":view,"title":title})
                scene["filename"]=filename
                if args.screenshots:
                    qa=out/"qa";qa.mkdir(exist_ok=True)
                    page.locator("#athena-app").screenshot(path=str(qa/(filename+".png")))
                scenes.append(scene)
            browser.close()
    if errors:raise RuntimeError("Prototype runtime errors: "+json.dumps(errors,ensure_ascii=False))
    names={view:filename for view,filename,_ in VIEWS}
    for scene in scenes:
        filename=scene.get("filename",names[scene["view"]]);scene["filename"]=filename
        if abs(scene["width"]-1440)>2 or abs(scene["height"]-960)>2:
            scene["warnings"].append(f"Root bounds {scene['width']}×{scene['height']} differ from target 1440×960")
        svg=scene_to_svg(scene)
        (out/"svg"/(filename+".svg")).write_text(svg,encoding="utf-8")
        (out/(filename+".scene.json")).write_text(json.dumps(scene,ensure_ascii=False,indent=2),encoding="utf-8")
    design=componentize(scenes)
    (out/"athena-design.json").write_text(json.dumps(design,ensure_ascii=False,indent=2),encoding="utf-8")
    plugin=out/"figma-import";plugin.mkdir(exist_ok=True)
    code=IMPORTER_JS.replace("__DESIGN_JSON__",json.dumps(design,ensure_ascii=False,separators=(",",":")))
    (plugin/"code.js").write_text(code,encoding="utf-8")
    settings={"name":"Athena UI — Native Import","api":"1.0.0","main":"code.js","editorType":["figma"],"documentAccess":"dynamic-page","networkAccess":{"allowedDomains":["none"]}}
    (plugin/"manifest.settings.json").write_text(json.dumps(settings,ensure_ascii=False,indent=2),encoding="utf-8")
    (out/"README-ko.md").write_text(README,encoding="utf-8")
    method=('hand-authored-vector-scenes' if isinstance(supplied,dict) and supplied.get('format')=='athena-authored-vector-scenes-v1' else 'supplied-dom-scenes') if args.scene_data else 'local-browser-dom'
    report={"input":str(source),"output":str(out),"extraction":method,"screens":[{"view":s["view"],"width":s["width"],"height":s["height"],"counts":stats(s["elements"]),"warnings":s["warnings"]} for s in scenes],"nativeComponentDefinitions":len(design["components"]),"runtimeErrors":None if args.scene_data else errors,"browserExecution":"not-run" if args.scene_data else 'completed',"nativeFigmaExecution":"not-tested-quota-blocked"}
    (out/"export-report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=="__main__":
    main()
