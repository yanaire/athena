"""Hand-authored Athena UI vector scenes, based on the local HTML design.

This module does not launch a browser and is not a DOM or screenshot extraction.
The raw scene format is shared with export_ui.py for native SVG/Figma output.
All displayed research results and connection states are illustrative examples.
"""
from __future__ import annotations

import html
import json
import math
from functools import lru_cache
from pathlib import Path
from PIL import ImageFont

BG='#f5f4ed'; SIDE='#eeede5'; PANEL='#ffffff'; LINE='#e8e6dc'
FG='#141413'; MUTED='#5e5d59'; GOLD='#c96442'; PAPER='#ffffff'; INK='#141413'
FONT='"Noto Sans CJK KR", "Noto Sans KR", sans-serif'
ICON_PATH=Path(__file__).with_name('lucide-icons.json')
ICONS=json.loads(ICON_PATH.read_text(encoding='utf-8')) if ICON_PATH.exists() else {}


@lru_cache(maxsize=128)
def face(size=14,weight=400):
    name='NotoSansCJK-Bold.ttc' if int(weight)>=600 else 'NotoSansCJK-Regular.ttc'
    return ImageFont.truetype('/usr/share/fonts/opentype/noto/'+name,size=round(size*4),index=1)


def tw(text,size=14,weight=400):
    return face(size,weight).getlength(text)/4


def esc(s):return html.escape(str(s),quote=True)


class Canvas:
    """Absolute-coordinate vector records. Text y means line-box top."""
    def __init__(self):self.elements=[]

    def rect(self,x,y,w,h,fill,radius=0,stroke=None,stroke_width=1,name=None):
        r={'type':'rect','name':name or 'Surface','x':x,'y':y,'width':w,'height':h,
           'radius':radius,'fill':fill,'opacity':1}
        if stroke:r.update(stroke=stroke,strokeWidth=stroke_width)
        self.elements.append(r);return r

    def text(self,x,y,text,size=14,color=FG,weight=400,width=None,line_height=None,font=None,name=None):
        text=str(text);lh=line_height or size*1.65
        ascent,descent=face(size,weight).getmetrics();ascent/=4;descent/=4
        r={'type':'text','name':name or text,'text':text,'x':x,'y':y,
           'width':width or max(.1,tw(text,size,weight)),'height':lh,
           'baseline':y+(lh-ascent-descent)/2+ascent,'fontFamily':font or FONT,
           'fontSize':size,'fontWeight':str(weight),'fontStyle':'normal','letterSpacing':0,
           'lineHeight':lh,'decoration':'none','fill':color,'opacity':1}
        self.elements.append(r);return r

    def paragraph(self,x,y,text,width,size=12,line_height=None,color=FG,weight=400,font=None):
        lh=line_height or size*1.85
        for para in str(text).split('\n'):
            line=''
            for word in para.split(' '):
                candidate=(line+' '+word).strip()
                if line and tw(candidate,size,weight)>width:
                    self.text(x,y,line,size,color,weight,line_height=lh,font=font);y+=lh;line=word
                else:line=candidate
                if tw(line,size,weight)>width:
                    piece=''
                    for ch in line:
                        if piece and tw(piece+ch,size,weight)>width:
                            self.text(x,y,piece,size,color,weight,line_height=lh,font=font);y+=lh;piece=ch
                        else:piece+=ch
                    line=piece
            if line:self.text(x,y,line,size,color,weight,line_height=lh,font=font);y+=lh
            elif not para:y+=lh
        return y

    def svg(self,x,y,w,h,source,name='Vector'):
        r={'type':'svg','name':name,'x':x,'y':y,'width':w,'height':h,'source':source,'opacity':1}
        self.elements.append(r);return r

    def icon(self,name,x,y,size=18,color=MUTED):
        key=''.join(p[:1].upper()+p[1:] for p in name.split('-'))
        data=ICONS.get(key) or ICONS.get(key.replace('2','')) or ICONS.get('Circle', [['circle',{'cx':12,'cy':12,'r':9}]])
        body=''.join('<'+tag+' '+' '.join(f'{k}="{esc(v)}"' for k,v in at.items())+'/>' for tag,at in data)
        source=f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">{body}</svg>'
        return self.svg(x,y,size,size,source,'Icon / '+name)

    def line(self,x1,y1,x2,y2,color=LINE,width=1,dash=None):
        x=min(x1,x2);y=min(y1,y2);w=max(abs(x2-x1),.1);h=max(abs(y2-y1),.1)
        dash_attr=f' stroke-dasharray="{esc(" ".join(map(str,dash)))}"' if dash else ''
        source=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" overflow="visible"><path d="M{x1-x} {y1-y} L{x2-x} {y2-y}" stroke="{color}" stroke-width="{width}" fill="none"{dash_attr}/></svg>'
        return self.svg(x,y,w,h,source,'Rule')

    def button(self,x,y,w,label,primary=False,icon=None,h=36):
        self.rect(x,y,w,h,GOLD if primary else '#282d2e',7,GOLD if primary else '#41484a')
        color='#25261f' if primary else '#d5dcd6'
        size=12;gap=7;total=tw(label,size,600 if primary else 400)+(22 if icon else 0)
        left=x+(w-total)/2
        if icon:self.icon(icon,left,y+(h-15)/2,15,color);left+=22
        self.text(left,y+(h-size*1.65)/2,label,size,color,600 if primary else 400)

    def badge(self,x,y,label,variant='success',width=None):
        palettes={'success':('#293b32','#b6d3c1'),'running':('#273844','#b0c9dd'),
                  'attention':('#463b28','#ddc094'),'neutral':('#34393a','#bbc2c1'),
                  'paper':('#e6e5dc','#697168')}
        bg,fg=palettes.get(variant,palettes['neutral']);w=width or tw(label,10,500)+14
        self.rect(x,y,w,22,bg,4);self.text(x+7,y+2.75,label,10,fg,500)
        return w

    def group(self,name,x,y,w,h,children,component=True):
        r={'type':'group','name':name,'x':x,'y':y,'width':w,'height':h,'children':children}
        if component:r['componentName']=name
        self.elements.append(r);return r

