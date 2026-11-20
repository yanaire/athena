"""Hand-authored four-state Athena UI; Codex-like layout + supplied DESIGN.md palette.

No browser or Figma execution. Noto Sans CJK KR is the actual local typeface.
All research values, progress, and manuscripts are illustrative design content.
"""
from __future__ import annotations
import json, math
from pathlib import Path
from scene_helpers import Canvas, tw, BG, SIDE, PANEL, LINE, FG, MUTED

ACCENT='#c96442'; QUIET='#85837c'; FONT='"Noto Sans CJK KR", "Noto Sans KR", sans-serif'


class UI(Canvas):
    def button(self,x,y,w,label,primary=False,icon=None,h=34):
        fill='#30302e' if primary else '#ffffff'
        color='#ffffff' if primary else FG
        self.rect(x,y,w,h,fill,7,None if primary else '#d9d6cc')
        size=12.5;left=x+(w-tw(label,size,500)-(21 if icon else 0))/2
        if icon:self.icon(icon,left,y+(h-15)/2,15,color);left+=21
        self.text(left,y+(h-20.625)/2,label,size,color,500,line_height=20.625)

    def pill(self,x,y,label,fill='#eeede6',color=MUTED):
        w=tw(label,10.5,500)+16
        self.rect(x,y,w,22,fill,5)
        self.text(x+8,y+2.3,label,10.5,color,500,line_height=17.3)
        return w


def sidebar():
    c=UI();c.rect(0,0,240,960,SIDE);c.line(239.5,0,239.5,960,LINE)
    c.icon('asterisk',21,20,25,FG);c.text(55,19,'Athena',18,FG,500,line_height=26)
    c.icon('panel-left-close',204,23,17,MUTED)
    c.icon('square-pen',22,80,18,FG);c.text(53,76,'새 연구',14,FG,line_height=24);c.text(190,80,'⌘ N',10.5,QUIET)
    c.icon('search',22,121,18,MUTED);c.text(53,117,'검색',14,MUTED,line_height=24);c.text(190,121,'⌘ K',10.5,QUIET)
    c.text(22,188,'프로젝트',11,QUIET,500,line_height=19);c.icon('plus',205,191,14,QUIET)
    c.icon('chevron-down',19,229,13,QUIET);c.icon('folder',39,225,17,MUTED);c.text(64,221,'생체신호 회로 연구',12.5,FG,500,line_height=23)
    c.rect(13,261,214,37,'#dedcd2',7);c.text(43,269,'RC 저역통과 필터 검증',12.5,FG,line_height=21);c.icon('ellipsis',203,273,14,MUTED)
    c.text(43,310,'증폭 회로 비교',12.5,MUTED,line_height=22);c.text(43,350,'연구 계획',12.5,MUTED,line_height=22)
    c.icon('chevron-right',19,402,13,QUIET);c.icon('folder',39,398,17,MUTED);c.text(64,394,'센서 데이터 분석',12.5,MUTED,line_height=23)
    c.text(22,461,'최근 연구',11,QUIET,500,line_height=19)
    c.text(23,495,'EMG 전처리 방법 비교',12.5,MUTED,line_height=23)
    c.text(23,535,'전극 임피던스 문헌 정리',12.5,MUTED,line_height=23)
    c.text(23,575,'주간 연구 노트',12.5,MUTED,line_height=23)
    c.icon('plug-zap',22,828,17,MUTED);c.text(52,823,'프로그램 연결',12.5,MUTED,line_height=23)
    c.icon('settings-2',22,869,17,MUTED);c.text(52,864,'설정',12.5,MUTED,line_height=23)
    c.line(17,906,223,906,'#dcd9ce');c.rect(21,923,26,26,'#d8d4c7',13);c.text(27,926,'동민',9.5,FG,500,line_height=17)
    c.text(58,920,'동민',12,FG,500,line_height=20);c.text(58,939,'개인 연구 공간',9.5,QUIET,line_height=15)
    c.icon('chevron-down',207,929,13,QUIET)
    return c.elements


def header(opened):
    c=UI();c.rect(240,0,1200,56,BG);c.line(240,55.5,1440,55.5,LINE)
    c.text(266,16,'RC 저역통과 필터 검증',14,FG,500,line_height=24)
    c.icon('chevron-down',445,22,12,MUTED)
    c.text(1094,19,'프로젝트에 저장됨',11,QUIET,line_height=18)
    c.rect(1272,10,144,36,'#e8e6dc' if opened else '#eeede6',7)
    c.icon('panel-right',1287,20,17,FG);c.text(1312,16,'연구 패널',13,FG,500,line_height=23)
    return c.elements


def artifact(c,x,y,w,kind):
    if kind=='results':icon='file-chart-column';name='기준 회로의 주파수 응답';note='검토된 결과 · 원본 자료 3개'
    else:icon='file-text';name='RC 필터 검증 보고서';note='초안 v1 · 결과에 연결된 원고'
    c.rect(x,y,w,62,'#ffffff',9,'#dedbd1')
    c.icon(icon,x+14,y+19,21,MUTED);c.text(x+48,y+11,name,13,FG,500,line_height=22)
    c.text(x+48,y+34,note,10.5,QUIET,line_height=18)
    c.icon('arrow-up-right',x+w-29,y+23,14,MUTED)


def conversation(opened):
    c=UI();area=780 if opened else 1200;w=min(760,area-80);x=240+(area-w)/2
    c.text(x,95,'오늘 · 10:32',10.5,QUIET,line_height=18)
    userw=min(w-30,610);userx=x+w-userw
    c.rect(userx,129,userw,101,'#eae7de',13)
    c.paragraph(userx+18,144,'R = 1 kΩ, C = 100 nF인 RC 필터의 주파수 응답을 확인하고, 이론값과 비교해 줘. 부품값이 달라졌을 때의 변화도 보고 싶어.',userw-36,14,25,FG)
    c.icon('asterisk',x,269,24,ACCENT);c.text(x+37,269,'Athena',13,FG,500,line_height=24)
    c.text(x,315,'기준 회로의 주파수 응답을 확인했어요.',19,FG,500,line_height=31)
    y=c.paragraph(x,360,'차단 주파수는 1.592 kHz로, 이론값 1.5915 kHz와의 차이는 약 0.03%입니다. 설정한 허용 오차 1%를 만족했어요.',w,14.5,27,FG)
    artifact(c,x,y+18,min(w,416),'results')
    yy=y+105
    c.paragraph(x,yy,'이제 저항과 커패시터를 바꾼 12가지 조건을 비교하고 있어요.',w,14.5,27,FG)
    yy+=45
    c.icon('workflow',x+1,yy+6,18,MUTED);c.text(x+31,yy,'RC 민감도 분석',13,FG,500,line_height=22)
    c.text(x+139,yy+1,'8 / 12 조건 완료',11.5,MUTED,line_height=21)
    c.icon('chevron-right',x+279,yy+7,13,QUIET)
    c.text(x+31,yy+27,'마지막 확인 10:41 · 연구실 서버',11.5,QUIET,line_height=20)
    artifact(c,x,yy+74,min(w,416),'manuscript')
    c.text(x,yy+153,'부품 허용 오차와 실제 측정 조건은 별도 확인이 필요해요.',11.5,QUIET,line_height=20)
    for i,icon in enumerate(['copy','thumbs-up','thumbs-down','ellipsis']):c.icon(icon,x+i*31,yy+186,14,QUIET)
    cy=816;c.rect(x,cy,w,106,'#ffffff',14,'#d9d6cc')
    c.text(x+18,cy+14,'다음 연구를 지시하거나 질문하세요',14,MUTED,line_height=24)
    c.icon('plus',x+18,cy+70,18,MUTED);c.text(x+51,cy+65,'연구 모델',12,MUTED,line_height=22);c.icon('chevron-down',x+111,cy+72,12,MUTED)
    c.text(x+137,cy+67,'로컬',10.5,QUIET,line_height=18)
    c.rect(x+w-48,cy+59,32,32,ACCENT,9);c.icon('arrow-up',x+w-40,cy+67,16,'#ffffff')
    note='디자인 미리보기 · 연구 수치와 실행 상태는 예시입니다.'
    c.text(x+(w-tw(note,10))/2,934,note,10,QUIET,line_height=17)
    return c.elements,(x,w)


def panel_shell(active):
    c=UI();c.rect(1020,56,420,904,'#ffffff');c.line(1020.5,56,1020.5,960,LINE)
    positions=[('workflow','워크플로우',1044,88),('results','결과',1148,52),('manuscript','원고',1218,52)]
    for key,label,x,width in positions:
        color=FG if key==active else MUTED;c.text(x,77,label,13.5,color,500 if key==active else 400,line_height=23)
        if key==active:c.rect(x,111,width,2,ACCENT)
    c.line(1044,112.5,1416,112.5,LINE)
    return c


def chart(c,x,y,w,h,small=False):
    W=w;H=h;L=35;R=12;T=24;B=31;pw=W-L-R;ph=H-T-B
    X=lambda f:L+(math.log10(f)-1)/4*pw
    Y=lambda g:T-g/40*ph
    parts=[];fs=8.5 if small else 9
    for g in [0,-10,-20,-30,-40]:
        yy=Y(g);parts.append(f'<path d="M{L} {yy} H{W-R}" stroke="#eeece5" stroke-width="1"/><text x="{L-9}" y="{yy+3}" font-size="{fs}" text-anchor="end" fill="#85837c">{g}</text>')
    for f,label in [(10,'10'),(100,'100'),(1000,'1k'),(10000,'10k'),(100000,'100k')]:
        xx=X(f);parts.append(f'<text x="{xx}" y="{H-14}" font-size="{fs}" text-anchor="middle" fill="#85837c">{label}</text>')
    fc=1/(2*math.pi*1000*100e-9)
    for freq,color,width,opacity in [(fc,'#9a9a91',4,.35),(1592,ACCENT,1.8,1)]:
        data=[]
        for i in range(161):
            f=10**(1+i/40);g=-10*math.log10(1+(f/freq)**2);data.append(('M' if i==0 else 'L')+f'{X(f):.3f} {Y(g):.3f}')
        parts.append(f'<path d="{" ".join(data)}" fill="none" stroke="{color}" stroke-width="{width}" opacity="{opacity}"/>')
    xx=X(1592);yy=Y(-3.0103)
    parts.append(f'<path d="M{xx} {T} V{H-B}" fill="none" stroke="#c5c0b4" stroke-dasharray="3 4"/><circle cx="{xx}" cy="{yy}" r="3.5" fill="{ACCENT}" stroke="#ffffff" stroke-width="1.5"/>')
    parts.append(f'<text x="5" y="11" font-size="{fs}" fill="#85837c">Gain (dB)</text><text x="{W-R}" y="{H-1}" text-anchor="end" font-size="{fs}" fill="#85837c">Hz</text>')
    if not small:parts.append(f'<text x="{xx+9}" y="{yy+20}" font-size="9" fill="#71685e">1.592 kHz</text>')
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Arial, sans-serif" fill="none">'+''.join(parts)+'</svg>'
    c.svg(x,y,w,h,svg,'Example chart / RC response')


def result_panel():
    c=panel_shell('results');x=1044;w=372
    c.text(x,137,'기준 회로의 주파수 응답',20,FG,500,line_height=32)
    c.text(x,177,'기준 실행 v1 · 예시 데이터',11.5,QUIET,line_height=20)
    c.icon('circle-check',1316,181,13,MUTED);c.text(1335,177,'검토 완료',11.5,MUTED,line_height=20)
    c.rect(x,219,w,227,'#f9f8f4',9,'#ece9e0');chart(c,x+9,233,w-18,180)
    c.rect(x+15,428,13,2,ACCENT);c.text(x+35,420,'시뮬레이션 예시',9.5,QUIET,line_height=17)
    c.rect(x+165,428,13,2,'#9a9a91');c.text(x+185,420,'이론 응답',9.5,QUIET,line_height=17)
    c.text(x,470,'차단 주파수',11.5,MUTED,line_height=20);c.text(x,495,'1.592',26,FG,500,line_height=37);c.text(x+81,510,'kHz',11.5,MUTED,line_height=20)
    c.text(x+194,470,'이론 대비 오차',11.5,MUTED,line_height=20);c.text(x+194,495,'0.03',26,FG,500,line_height=37);c.text(x+266,510,'%',11.5,MUTED,line_height=20)
    c.text(x,538,'허용 오차 1% 이내 · 이상적인 RC 모델',11,MUTED,line_height=19);c.line(x,574,x+w,574,LINE)
    c.text(x,592,'실행 조건',13,FG,500,line_height=22)
    for yy,label,value in [(627,'프로그램','ngspice · 이 컴퓨터'),(655,'입력값','R 1 kΩ · C 100 nF'),(683,'해석 범위','10 Hz – 100 kHz')]:
        c.text(x,yy,label,11.5,QUIET,line_height=20);c.text(x+w-tw(value,11.5),yy,value,11.5,MUTED,line_height=20)
    c.line(x,720,x+w,720,LINE);c.text(x,737,'원본 근거',13,FG,500,line_height=22)
    for i,(icon,label) in enumerate([('file-code-2','baseline.cir'),('file-spreadsheet','ac_response.csv'),('file-text','simulation.log')]):
        yy=773+i*31;c.icon(icon,x,yy+3,15,MUTED);c.text(x+25,yy,label,12,MUTED,line_height=21);c.icon('arrow-up-right',1399,yy+4,13,QUIET)
    c.button(x,890,w,'원고에 추가',False,'file-plus-2',36);c.text(x,939,'기준 결과와 원본 파일을 함께 보관합니다.',10,QUIET,line_height=17)
    return c.elements


def manuscript_panel():
    c=panel_shell('manuscript');x=1044;w=372
    c.pill(x,138,'초안 v1');c.icon('ellipsis',1398,142,16,QUIET)
    c.text(x,178,'RC 저역통과 필터의',20,FG,500,line_height=31);c.text(x,209,'주파수 응답 검증',20,FG,500,line_height=31)
    c.text(x,254,'생체신호 회로 연구 · 동민',11,QUIET,line_height=19);c.line(x,292,x+w,292,LINE)
    c.text(x,311,'01 연구 목적',13,FG,600,line_height=23)
    c.paragraph(x,345,'RC 회로의 주파수 응답을 확인하고, 시뮬레이션에서 얻은 차단 주파수를 이론값과 비교한다.',w,12.5,23,MUTED)
    c.text(x,412,'02 방법',13,FG,600,line_height=23)
    c.paragraph(x,446,'저항 1 kΩ과 커패시터 100 nF를 사용하였다. 10 Hz부터 100 kHz까지 AC 응답을 분석하였다.',w,12.5,23,MUTED)
    c.text(x,512,'03 결과',13,FG,600,line_height=23)
    c.rect(x-4,547,w+8,74,'#f6eee8',6)
    c.paragraph(x+7,554,'차단 주파수는 1.592 kHz로 나타났으며, 이론값 1.5915 kHz 대비 상대 오차는 약 0.03%였다.',w-14,12.5,23,FG)
    c.icon('link-2',x,635,13,MUTED);c.text(x+21,631,'기준 실행 v1 · 근거 열기',11.5,MUTED,line_height=21);c.icon('arrow-up-right',x+174,635,13,MUTED)
    chart(c,x,673,w,115,True);c.text(x,799,'그림 1. 기준 RC 회로의 주파수 응답 · 예시 데이터',9.5,QUIET,line_height=17)
    c.text(x,832,'적용 범위',11.5,FG,500,line_height=20);c.text(x+65,832,'실제 부품과 측정 장비는 포함하지 않았다.',10.5,MUTED,line_height=20)
    c.button(x,890,w,'원고 내보내기',False,'download',36);c.text(x,939,'원고의 수치와 인용은 원본 근거에 연결됩니다.',10,QUIET,line_height=17)
    return c.elements


def workflow_panel():
    c=panel_shell('workflow');x=1044;w=372
    c.text(x,137,'연구 진행',20,FG,500,line_height=32);c.text(x,177,'RC 저역통과 필터 검증 · 계획 v1',11.5,QUIET,line_height=20)
    c.text(x,219,'3개 완료',12,FG,500,line_height=22);c.text(x+80,219,'·  1개 확인 필요  ·  1개 대기',12,MUTED,line_height=22)
    rows=[('계획 확인','목표·허용 오차·실행 범위 확정','완료','check'),('기준 회로 실행','ngspice · 이 컴퓨터','완료','check'),('결과 검토','이론 대비 오차 0.03%','완료','check'),('RC 민감도 분석','8 / 12 조건 · 연구실 서버','확인 필요','refresh-cw'),('원고 정리','검토한 결과로 초안 구성','대기','file-text')]
    for i,(title,sub,status,icon) in enumerate(rows):
        yy=270+i*79
        if i==3:c.rect(x-8,yy-8,w+16,73,'#f4f2eb',8,'#e5dfd3')
        if i<4:c.line(x+12,yy+26,x+12,yy+74,'#e1ddd2')
        c.rect(x,yy,25,25,'#efeee6',13);c.icon(icon,x+6,yy+6,13,MUTED)
        c.text(x+39,yy-3,title,13,FG,500,line_height=23);c.text(x+39,yy+25,sub,11,QUIET,line_height=19)
        c.text(x+w-tw(status,10.5),yy+1,status,10.5,MUTED,line_height=18)
    c.line(x,678,x+w,678,LINE)
    c.icon('unplug',x,702,17,MUTED);c.text(x+29,697,'기존 실행 상태를 확인해야 해요',13,FG,500,line_height=24)
    c.paragraph(x,737,'연결이 끊겨도 계산이 계속될 수 있어요. 새 계산을 제출하기 전에 기존 상태를 확인합니다.',w,12,22,MUTED)
    c.button(x,807,w,'상태 다시 확인',False,'refresh-cw',36)
    c.button(x,854,w,'새 작업 배정 중지',False,'pause',36)
    c.text(x,911,'승인 범위 · ngspice / 연구실 서버 / 최대 12조건',10.5,QUIET,line_height=19)
    c.text(x,939,'진행 기록과 실행 상태는 디자인 예시입니다.',10,QUIET,line_height=17)
    return c.elements


def make_scene(view):
    opened=view!='conversation';c=UI();c.rect(0,0,1440,960,BG)
    c.group('Projects sidebar',0,0,240,960,sidebar())
    c.group('Header / expanded' if opened else 'Header / collapsed',240,0,1200,56,header(opened))
    body,(x,w)=conversation(opened);c.group('Conversation / compact' if opened else 'Conversation / expanded',x,56,w,904,body)
    titles={'conversation':'대화 · 연구 패널 닫힘','results':'결과 사이드바','manuscript':'원고 사이드바','workflow':'워크플로우 사이드바'}
    if opened:
        contents={'results':result_panel,'manuscript':manuscript_panel,'workflow':workflow_panel}[view]()
        c.group('Research panel / '+view,1020,56,420,904,contents,False)
    return {'version':1,'view':view,'title':titles[view],'width':1440,'height':960,'elements':c.elements,
            'interactions':[{'x':1272,'y':10,'width':144,'height':36,'target':'toggle-panel','label':'연구 패널'}],
            'warnings':[],'provenance':'hand-authored vector scene; Codex-like structure and supplied DESIGN.md palette; not DOM extraction'}


def build_all_scenes():return [make_scene(v) for v in ['conversation','results','manuscript','workflow']]


if __name__=='__main__':
    path=Path(__file__).with_name('athena-authored-scenes.json')
    path.write_text(json.dumps({'format':'athena-authored-vector-scenes-v1','scenes':build_all_scenes()},ensure_ascii=False,indent=2),encoding='utf-8')
    print(path)
