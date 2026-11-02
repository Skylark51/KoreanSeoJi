"""Synthetic Korean exam: no third-party exam material or personal notes."""
from pathlib import Path
import pymupdf as fitz
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'tmp'
OUT.mkdir(exist_ok=True)
doc=fitz.open()
def page():
    p=doc.new_page(width=600,height=850)
    p.insert_font(fontname='korean',fontfile='C:/Windows/Fonts/malgun.ttf')
    p.insert_text((235,27),'국어 영역 · 검증용',fontname='korean',fontsize=10)
    return p
def text(p,x,y,value,size=10):p.insert_text((x,y),value,fontname='korean',fontsize=size)
p=page()
text(p,30,90,'[1~2] 다음 글을 읽고 물음에 답하시오.',11)
paragraphs=[
 '우리가 글을 읽는 일은 정보를 확인하는 과정이다.',
 '그러나 정보의 나열만으로 이해가 완성되지는 않는다.',
 '문장 사이의 관계를 파악해야 글의 구조가 드러난다.',
 '조건과 결과를 구분하는 일은 추론의 출발점이다.',
 '이를테면 충분조건은 결과를 보장하는 조건이다.',
 '필요조건은 결과가 성립하려면 갖추어야 한다.',
 '두 조건은 서로 다르므로 바꾸어 생각하면 안 된다.',
 '독자는 글에서 근거를 찾아 판단을 검토해야 한다.',
]
for i in range(25):text(p,30,122+i*25,paragraphs[i%len(paragraphs)])
for i in range(27):text(p,318,90+i*25,paragraphs[(i+3)%len(paragraphs)])
p=page()
for i in range(6):text(p,30,90+i*24,paragraphs[i])
text(p,30,275,'이는 앞 페이지에서 이어진 지문의 마지막 문장이다.')
text(p,30,325,'1. 윗글을 이해한 내용으로 적절한 것은?',11)
for i in range(5):text(p,40,360+i*35,f'{"①②③④⑤"[i]} 조건과 결과의 관계를 구별한다.')
text(p,318,90,'2. 글의 출제 의도에 대한 설명으로 적절한 것은?',11)
for i in range(5):text(p,328,130+i*35,f'{"①②③④⑤"[i]} 문장 사이의 논리 관계를 추론한다.')
text(p,318,420,'[3~4] 다음 글을 읽고 물음에 답하시오.',11)
for i in range(12):text(p,318,455+i*23,paragraphs[i%len(paragraphs)])
p=page()
for i in range(8):text(p,30,90+i*22,paragraphs[(i+2)%len(paragraphs)])
text(p,30,320,'3. 윗글의 내용과 일치하지 않는 것은?',11)
for i in range(5):text(p,40,360+i*35,f'{"①②③④⑤"[i]} 조건을 살펴보고 근거를 확인한다.')
text(p,318,90,'4. 보기의 상황에 적용한 내용으로 적절한 것은?',11)
for i in range(5):text(p,328,130+i*35,f'{"①②③④⑤"[i]} 사례의 조건을 본문의 내용과 비교한다.')
doc.save(OUT/'sample-exam.pdf',deflate=True)
scan=fitz.open()
source=fitz.open(OUT/'sample-exam.pdf')
pix=source[1].get_pixmap(matrix=fitz.Matrix(1.8,1.8))
sp=scan.new_page(width=600,height=850);sp.insert_image(sp.rect,stream=pix.tobytes('png'))
scan.save(OUT/'sample-scan.pdf',deflate=True)
print('Generated synthetic fixtures:',OUT)
