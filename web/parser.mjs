// Normalized top-left PDF geometry; reading order is page, column, y.
export const uid = () => globalThis.crypto.randomUUID();
const RANGE = /[\[［【]\s*(\d{1,2})\s*[~～〜\-－–—]\s*(\d{1,2})\s*[\]］】]/;
const QUESTION = /^\s*(\d{1,2})\s*[.．]\s*(?!\d)/;

const columnFor=(x,columns)=>columns===1?0:columns===3?Math.max(0,Math.min(2,Math.floor((x-.09)/(.82/3)))):(x>=.50?1:0);
export function textItemsToLines(items, viewport, transform, columns=2) {
  const fragments = items.filter(i => i.str?.trim()).map(i => {
    const t = transform(viewport.transform, i.transform);
    const h = Math.max(Math.hypot(t[2], t[3]), 3);
    return { text: i.str, x: t[4]/viewport.width, y: (t[5]-h)/viewport.height,
      w: Math.abs(i.width*viewport.scale)/viewport.width, h: h/viewport.height };
  });
  return mergeFragments(fragments,columns);
}

export function mergeFragments(fragments, columns = 2) {
  const buckets = [];
  for (const item of [...fragments].sort((a,b) => a.y-b.y || a.x-b.x)) {
    const col = columnFor(item.x,columns);
    let line = buckets.find(l => l.column===col && Math.abs(l.y-item.y)<Math.max(.003,item.h*.45));
    if (!line) { line={column:col,y:item.y,h:item.h,parts:[]}; buckets.push(line); }
    line.parts.push(item); line.h=Math.max(line.h,item.h);
  }
  return buckets.map(l => {
    l.parts.sort((a,b)=>a.x-b.x);
    const x=Math.min(...l.parts.map(i=>i.x)), right=Math.max(...l.parts.map(i=>i.x+i.w));
    return {column:l.column,x,y:l.y,w:right-x,h:l.h,text:l.parts.map(i=>i.text).join(' ').replace(/\s+/g,' ').trim()};
  }).sort((a,b)=>a.column-b.column || a.y-b.y);
}

export function indexDocument(pages, {columns = 2, makeId = uid, trimWhitespace = false} = {}) {
  const units=[], candidates=[];
  for (let p=0; p<pages.length; p++) {
    const sourceLines=columns===1 ? mergeFragments(pages[p].lines.map(l=>({...l})),1) : pages[p].lines;
    const headers=sourceLines.filter(l=>l.y<.16&&/국어\s*영역/.test(l.text));
    const headerBottom=trimWhitespace&&headers.length?Math.max(...headers.map(l=>l.y+l.h))+.012:0;
    const lines=sourceLines.filter(l=>l.y>headerBottom);
    for(let col=0; col<columns; col++) {
      const unit={page:p+1,column:col,lines:lines.filter(l=>(columns===1 || l.column===col) && l.y>.035 && l.y<.965)};
      const unitIndex=units.length; units.push(unit);
      for (const line of unit.lines) {
        const range=line.text.match(RANGE), question=line.text.match(QUESTION);
        if (range && +range[1]>0 && +range[2]>=+range[1] && +range[2]<=60) {
          candidates.push({type:'group',unit:unitIndex,y:Math.max(.035,line.y-.005),line,start:+range[1],end:+range[2]});
        } else if(question && +question[1]>0 && +question[1]<=60) {
          // Numbered paragraphs inside passages are usually inset. Keep ambiguous
          // margin anchors visible for review rather than silently discarding them.
          const margin=columns===1 ? .04 : col===0 ? .035 : .515;
          if(line.x<margin+.10) candidates.push({type:'question',unit:unitIndex,y:Math.max(.035,line.y-.005),line,number:+question[1]});
        }
      }
    }
  }
  candidates.sort((a,b)=>a.unit-b.unit || a.y-b.y);
  // Longest increasing sequence favors consecutive exam numbers and rejects
  // repeated "1." examples in prose. Groups are retained independently.
  const raw=candidates.filter(c=>c.type==='question');
  const score=raw.map(()=>1), previous=raw.map(()=>-1);
  for(let i=0;i<raw.length;i++) for(let j=0;j<i;j++) {
    const delta=raw[i].number-raw[j].number;
    if(delta>0 && delta<=15) {
      const next=score[j]+(delta===1?3:1);
      if(next>score[i]) {score[i]=next;previous[i]=j;}
    }
  }
  const keep=new Set();
  if(raw.length) {
    let i=score.indexOf(Math.max(...score));
    while(i>=0) {keep.add(raw[i]);i=previous[i];}
  }
  const events=candidates.filter(c=>c.type==='group' || keep.has(c));
  const questions=[], passages=[];
  function segmentsBetween(start,end) {
    const segments=[];
    const last=end?.unit ?? units.length-1;
    for(let i=start.unit;i<=last;i++) {
      const u=units[i], y=i===start.unit?start.y:.047;
      const bottom=i===end?.unit?end.y:.953;
      if(bottom-y<.009) continue;
      const x=columns===1?.025:u.column===0?.025:.507;
      const right=columns===1?.975:u.column===0?.493:.975;
      if(trimWhitespace){
        const lines=u.lines.filter(l=>l.y>=y-.002&&l.y<bottom&&!((l.y<.13&&/국어\s*영역|고\s*3/.test(l.text))||(l.y>.90&&/^[\d\s]+$/.test(l.text))));
        const stop=lines.find(l=>/확인 사항/.test(l.text));
        const content=stop?lines.filter(l=>l.y<stop.y):lines;
        if(!content.length)continue;
        const top=Math.max(y,Math.min(...content.map(l=>l.y))-.008);
        const b=Math.min(bottom,Math.max(...content.map(l=>l.y+l.h))+.008);
        segments.push({page:u.page,x,y:top,w:right-x,h:b-top,column:u.column});
      }else segments.push({page:u.page,x,y,w:right-x,h:bottom-y,column:u.column});
    }
    return segments;
  }
  function extractText(segments) {
    return segments.flatMap(s=>units.find(u=>u.page===s.page && u.column===s.column)?.lines.filter(l=>l.y>=s.y-.003 && l.y<s.y+s.h).map(l=>l.text)||[]).join('\n');
  }
  let active=null;
  for(let i=0;i<events.length;i++) {
    const e=events[i], end=events[i+1];
    if(e.type==='group') {
      active={id:makeId(),label:`${e.start}–${e.end}번 공통 지문`,start:e.start,end:e.end,
        segments:segmentsBetween(e,end),reviewed:false};
      active.text=extractText(active.segments); passages.push(active);
    } else {
      const segments=segmentsBetween(e,end);
      const passage=active && e.number>=active.start && e.number<=active.end ? active : null;
      questions.push({id:makeId(),number:e.number,title:e.line.text.slice(0,110),text:extractText(segments),
        passageId:passage?.id||null,segments,notes:{thought:'',should:'',summary:''},tags:'',status:'new',reviewed:false,
        confidence:segments.length>3?'low':'normal'});
    }
  }
  const numbers=new Set(questions.map(q=>q.number));
  const missing=[];
  const max=questions.length?Math.max(...numbers):0;
  for(let n=1;n<=max;n++) if(!numbers.has(n)) missing.push(n);
  const warnings=[];
  if(!questions.length) warnings.push('문항 번호를 찾지 못했습니다. 원본을 보고 수동으로 문제를 추가해 주세요.');
  if(missing.length) warnings.push(`번호 누락 가능성: ${missing.join(', ')}번. 원본에서 확인해 주세요.`);
  for(const p of passages) if(p.segments.length>3) warnings.push(`${p.label}: 긴 지문 범위를 확인해 주세요.`);
  if(pages.some(p=>p.ocr)) warnings.push('OCR로 인식한 페이지가 있습니다. 숫자와 지문 경계를 반드시 확인해 주세요.');
  return {questions,passages,warnings,pages:pages.map(p=>({width:p.width,height:p.height,ocr:!!p.ocr}))};
}

export function referencesFor(state, id) {
  return state.links.filter(l=>l.a===id || l.b===id).map(l=>({...l,target:l.a===id?l.b:l.a}));
}
export function addReference(state,a,b,label='') {
  if(a===b) throw new Error('같은 문제를 참조할 수 없습니다.');
  if(state.links.some(l=>(l.a===a&&l.b===b)||(l.a===b&&l.b===a))) return false;
  state.links.push({a:a<b?a:b,b:a<b?b:a,label}); return true;
}

// Explanation headings, rather than the answer table, define each question.
// Range headings terminate an explanation before the next passage commentary.
export function indexExplanations(pages,{columns=3}={}) {
  const units=[],events=[];
  const all=pages.flatMap(p=>p.lines).filter(l=>l.y>.035&&l.y<.91&&l.w<.85);
  const bounds=Array.from({length:columns},(_,col)=>{
    const lines=all.filter(l=>columnFor(l.x,columns)===col);
    const x=lines.length?Math.max(.015,Math.min(...lines.map(l=>l.x))-.006):col/columns+.02;
    const right=lines.length?Math.min(.985,Math.min(columns===3?[.363,.637,.985][col]:(col+1)/columns-.008,Math.max(...lines.map(l=>l.x+l.w))+.006)):(col+1)/columns-.02;
    return {x,right};
  });
  for(let p=0;p<pages.length;p++)for(let col=0;col<columns;col++){
    const lines=pages[p].lines.filter(l=>columnFor(l.x,columns)===col&&l.y>.035&&l.y<.91&&!/^\s*\d+\s*$/.test(l.text)).sort((a,b)=>a.y-b.y);
    const unit=units.length;units.push({page:p+1,col,lines});
    for(const l of lines){
      const q=l.text.match(/^\s*(\d{1,2})\s*[.．]\s*\[/);
      if(q)events.push({unit,y:l.y-.003,number:+q[1],line:l});
      else if(RANGE.test(l.text)||/^\s*[［\[]\s*(화법|언어)/.test(l.text))events.push({unit,y:l.y-.003,stop:true});
    }
  }
  const answers=new Map();
  for(const p of pages)for(const l of p.lines){const pairs=[...l.text.matchAll(/(\d{1,2})\s*([①②③④⑤])/g)];if(pairs.length>=2||/^\s*(?:\d{1,2}\s*[①②③④⑤]\s*)+$/.test(l.text))for(const m of pairs)answers.set(+m[1],m[2]);}
  const entries=[],warnings=[];
  for(let i=0;i<events.length;i++){
    const e=events[i];if(e.stop)continue;
    if(entries.some(x=>x.number===e.number)){warnings.push(`${e.number}번 중복 해설: 첫 번째 영역을 유지했습니다.`);continue;}
    const end=events[i+1],segments=[],text=[];
    for(let u=e.unit;u<=(end?.unit??units.length-1);u++){
      const unit=units[u],top=u===e.unit?e.y:.035,bottom=u===end?.unit?end.y:.91;
      const lines=unit.lines.filter(l=>l.y>=top-.001&&l.y<bottom);
      if(!lines.length)continue;
      const y=u===e.unit?top:Math.max(top,Math.min(...lines.map(l=>l.y))-.003);
      const b=Math.min(bottom,Math.max(...lines.map(l=>l.y+l.h))+.004);
      if(b<=y)continue;
      const {x,right}=bounds[unit.col];segments.push({page:unit.page,column:unit.col,x,y,w:right-x,h:b-y});text.push(...lines.map(l=>l.text));
    }
    entries.push({number:e.number,answer:answers.get(e.number)||null,title:e.line.text,text:text.join('\n'),segments,reviewed:false});
  }
  if(!entries.length)warnings.push('문항 해설 제목을 찾지 못했습니다. 단 수를 확인하거나 수동으로 범위를 지정해 주세요.');
  return {entries,warnings,pages:pages.map(p=>({width:p.width,height:p.height,ocr:!!p.ocr}))};
}
