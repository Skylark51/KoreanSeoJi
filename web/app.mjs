import * as pdfjs from './vendor/pdf.mjs';
import {uid,textItemsToLines,mergeFragments,indexDocument,indexExplanations,referencesFor,addReference} from './parser.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pending=new Map(); let rpcId=0;
window.chrome.webview.addEventListener('message',e=>{
  const r=e.data, item=pending.get(r.id); if(!item)return; pending.delete(r.id);
  r.ok?item.resolve(r.result):item.reject(new Error(r.error));
});
function rpc(action,args={}) {return new Promise((resolve,reject)=>{const id=++rpcId;pending.set(id,{resolve,reject});window.chrome.webview.postMessage({id,action,args});});}
let state,revision=0,projectId=null,questionId=null,dirty=false,saving=null,saveTimer=null,zoom=1,renderToken=0;
let analysis=null,ocrWorker=null,toastTimer=null,notesOpen=false,navHistory=[];
const documents=new Map();
const project=()=>state?.projects.find(p=>p.id===projectId);
const question=()=>project()?.questions.find(q=>q.id===questionId);
function findQuestion(id){for(const p of state.projects){const q=p.questions.find(q=>q.id===id);if(q)return {p,q};}return null;}
function toast(message,error=false){$('toast').textContent=message;$('toast').className='toast'+(error?' error':'');$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:4000);}
function status(text,kind=''){$('saveState').className='save-state '+kind;$('saveState').replaceChildren(Object.assign(document.createElement('i'),{}),document.createTextNode(text));}
function changed(){dirty=true;status('저장 중…','pending');clearTimeout(saveTimer);saveTimer=setTimeout(()=>persist().catch(report),180);}
async function persist(){
  if(saving)return saving;
  saving=(async()=>{
    while(dirty){
      const snapshot=structuredClone(state);dirty=false;
      try {const result=await rpc('save',{state:snapshot,revision});revision=result.revision;}
      catch(e){dirty=true;status('저장 실패 · 눌러서 재시도','error');throw e;}
    }
    status('모든 변경 사항이 저장됨');
  })();
  try{await saving;}finally{saving=null;}
}
async function flush(){clearTimeout(saveTimer);await persist();if(dirty)await persist();}
function report(error){console.error(error);toast(error.message||String(error),true);}
function on(id,event,handler){$(id).addEventListener(event,e=>Promise.resolve().then(()=>handler(e)).catch(report));}
function dialog(title,body,footer=''){
  if($('dialog').open)$('dialog').close();$('dialog').className='';
  $('dialogContent').innerHTML=`<div class="dialog-header"><h2>${escape(title)}</h2><button id="dialogClose" aria-label="닫기">×</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  $('dialogClose').onclick=()=>$('dialog').close();$('dialog').showModal();
}
function actionButton(label,id,primary=false){return `<button id="${id}"${primary?' class="primary"':''}>${label}</button>`;}
function askText(title,label,value,submit){
  dialog(title,`<form id="textForm"><label for="textInput">${escape(label)}</label><input id="textInput" value="${escape(value)}" maxlength="120" required autocomplete="off"></form>`,actionButton('취소','textCancel')+actionButton('저장','textSave',true));
  $('textCancel').onclick=()=>$('dialog').close();
  const save=async()=>{const v=$('textInput').value.trim();if(!v){$('textInput').focus();return;}try{await submit(v);$('dialog').close();}catch(e){report(e);}};
  $('textForm').onsubmit=e=>{e.preventDefault();save();};$('textSave').onclick=save;$('textInput').focus();$('textInput').select();
}
function newProject(){askText('새 기출 프로젝트','시험 이름','2026년 6월 모의평가',async title=>{
  await flush();const p={id:uid(),title,createdAt:new Date().toISOString(),source:null,questions:[],passages:[],pages:[],warnings:[]};
  state.projects.push(p);projectId=p.id;questionId=null;changed();await flush();render();
});}
function renderProjects(){
  $('projects').innerHTML=state.projects.length?state.projects.map(p=>`<button class="project-item ${p.id===projectId?'selected':''}" data-project="${escape(p.id)}"><span>▤</span><span><strong>${escape(p.title)}</strong><small>${p.questions.length}개 문제 · ${p.questions.filter(q=>q.notes?.thought||q.notes?.should||q.notes?.summary).length}개 사고 기록</small></span></button>`).join(''):'<p class="side-empty">첫 기출 프로젝트를 만들어<br>나의 공부를 시작해 보세요.</p>';
  $('projects').querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>navigate(b.dataset.project,null).catch(report));
}
async function navigate(pid,qid,push=false){
  if(push && projectId && questionId)navHistory.push({pid:projectId,qid:questionId});
  projectId=pid;const p=project();questionId=qid||p?.questions[0]?.id||null;
  if(state.settings.lastProject!==pid || state.settings.lastQuestion!==questionId){state.settings.lastProject=pid;state.settings.lastQuestion=questionId;changed();}
  render();
}
function render(){
  renderProjects();const p=project();$('welcome').hidden=!!p;$('workspace').hidden=!p;
  $('currentProject').textContent=p?.title||'시작하기';if(!p)return;
  $('importExplanation').hidden=!p.source;$('reindexExplanation').hidden=!p.explanationSource;
  $('importExplanation').textContent=p.explanationSource?'해설 PDF 교체':'＋ 해설 PDF';
  $('projectTitle').textContent=p.title;$('projectMeta').textContent=p.source?`${p.source.name} · ${p.pages?.length||p.source.pages||'?'}쪽`:'기출 프로젝트';
  $('projectEmpty').hidden=!!p.source;$('study').hidden=!p.source;
  $('importPdf').hidden=!!p.source;
  if(p.source){renderTabs();renderQuestion().catch(report);}
  else{$('notes').hidden=true;}
}
function renderTabs(){
  const p=project();$('questionTabs').innerHTML=p.questions.map(q=>`<button class="question-tab ${q.id===questionId?'active':''} ${q.notes?.thought||q.notes?.should||q.notes?.summary?'has-note':''}" data-q="${escape(q.id)}" title="${escape(q.title)}">${q.number}</button>`).join('');
  $('questionTabs').querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{questionId=b.dataset.q;state.settings.lastQuestion=questionId;changed();renderTabs();renderQuestion().catch(report);});
  const warnings=p.warnings||[];$('warning').hidden=!warnings.length;
  $('warning').textContent=warnings.join(' ');
  if(warnings.length){const b=document.createElement('button');b.textContent='확인 후 접기';b.onclick=()=>{p.warnings=[];changed();$('warning').hidden=true;};$('warning').append(b);}
}
async function getDocument(p){
  if(!p?.source)throw new Error('PDF를 먼저 가져와 주세요.');
  if(!documents.has(p.source.id)){
    const loading=pdfjs.getDocument({url:`https://pdf.seoji.local/${p.source.id}.pdf`,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,iccUrl:new URL('./vendor/iccs/',import.meta.url).href,isEvalSupported:false,enableXfa:false});
    loading.onPassword=()=>{loading.destroy();toast('암호가 걸린 PDF는 암호를 해제한 뒤 가져와 주세요.',true);};
    const promise=loading.promise.catch(e=>{documents.delete(p.source.id);throw new Error(`PDF를 열지 못했습니다. 원본 파일과 암호 여부를 확인해 주세요. (${e.message})`);});
    documents.set(p.source.id,promise);
    if(documents.size>3){const [id,old]=documents.entries().next().value;documents.delete(id);old.then(d=>d.loadingTask.destroy()).catch(()=>{});}
  }
  return documents.get(p.source.id);
}
async function renderSegments(container,segments,p,token){
  container.replaceChildren();if(!segments?.length){container.innerHTML='<div class="empty-message">아직 지정된 영역이 없습니다.<br>범위 수정에서 원본의 영역을 선택해 주세요.</div>';return;}
  const doc=await getDocument(p);
  for(let i=0;i<segments.length;i++){
    if(token!==renderToken)return;
    const s=segments[i];if(s.page<1||s.page>doc.numPages)continue;
    if(i && s.page!==segments[i-1].page){const next=document.createElement('div');next.className='continuation';next.textContent=`다음 페이지로 이어지는 내용 · ${s.page}쪽`;container.append(next);}
    const caption=document.createElement('div');caption.className='paper-caption';caption.innerHTML=`<span>원본 ${s.page}쪽${s.column!=null?' · '+(s.column===0?'왼쪽':'오른쪽')+' 단':''}</span><span>${i+1} / ${segments.length}</span>`;
    const paper=document.createElement('div');paper.className='paper-segment';paper.style.width=`${zoom*100}%`;const canvas=document.createElement('canvas');paper.append(canvas);container.append(caption,paper);
    const page=await doc.getPage(s.page),base=page.getViewport({scale:1});
    const scale=Math.min(4,Math.max(1.3,(container.clientWidth||500)*window.devicePixelRatio*zoom/(base.width*s.w)));
    const viewport=page.getViewport({scale});canvas.width=Math.ceil(viewport.width*s.w);canvas.height=Math.ceil(viewport.height*s.h);
    const task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[1,0,0,1,-s.x*viewport.width,-s.y*viewport.height],background:'rgb(255,255,255)'});
    await task.promise;
  }
}
async function renderQuestion(){
  const token=++renderToken,p=project(),q=question();
  $('notes').hidden=!notesOpen||!q;
  if(!q){$('passageLabel').textContent='지문';$('questionLabel').textContent='문제';$('referenceCount').textContent='0';$('questionPaper').innerHTML='<div class="empty-message">인식된 문제가 없습니다.<br>위의 ＋ 문제 버튼으로 직접 추가할 수 있습니다.</div>';$('passagePaper').replaceChildren();$('references').replaceChildren();return;}
  const passage=p.passages.find(x=>x.id===q.passageId);
  $('passageLabel').textContent=passage?.label||'공통 지문';
  const pages=[...new Set((passage?.segments||[]).map(s=>s.page))];$('passagePages').textContent=pages.length?`${pages.join(', ')}쪽`:'';
  $('questionLabel').textContent=`${q.number}번 문제`;$('questionStatus').value=q.status||'new';
  $('reviewBadge').textContent=q.reviewed?'확인 완료':'검토 필요';$('reviewBadge').className='badge'+(q.reviewed?' reviewed':'');
  $('reviewed').textContent=q.reviewed?'✓ 확인 완료 · 다시 검토':'✓ 인식 범위 확인 완료';
  $('prevQuestion').disabled=p.questions.indexOf(q)===0;$('nextQuestion').disabled=p.questions.indexOf(q)===p.questions.length-1;
  loadNotes(q);renderReferences();
  $('explanationBox').open=false;$('explanationPaper').replaceChildren();
  $('explanationBadge').textContent=q.explanation?.segments?.length?(q.explanation.reviewed?'· 확인 완료':'· 검토 필요'):'· 미연결';
  $('explanationMeta').textContent=p.explanationSource?`${q.explanation?.answer?'정답 '+q.explanation.answer+' · ':''}${p.explanationSource.name} · ${q.explanation?.segments?.length?'문항 번호로 연결한 해설입니다. 원본 범위를 확인해 주세요.':'이 문항의 해설을 찾지 못했습니다. 범위 수정으로 지정하세요.'}`:'프로젝트 위의 ＋ 해설 PDF 버튼으로 가져오세요.';
  await Promise.all([renderSegments($('passagePaper'),passage?.segments,p,token),renderSegments($('questionPaper'),q.segments,p,token)]);
}
function loadNotes(q){$('noteTitle').textContent=`${q.number}번 · 사고 기록`;$('noteThought').value=q.notes?.thought||'';$('noteShould').value=q.notes?.should||'';$('noteSummary').value=q.notes?.summary||'';$('noteTags').value=q.tags||'';}
function renderReferences(){
  const q=question();if(!q)return;const refs=referencesFor(state,q.id);$('referenceCount').textContent=refs.length;
  $('references').innerHTML=refs.length?refs.map(l=>{const target=findQuestion(l.target);if(!target)return '';return `<div class="reference-card"><button class="reference-jump" data-jump="${escape(l.target)}"><small>${escape(target.p.title)}</small><strong>${target.q.number}번 문제 <span>↗</span></strong>${l.label?`<p>${escape(l.label)}</p>`:''}</button><button class="reference-remove" data-remove="${escape(l.target)}" title="양쪽 문제에서 연결 해제">×</button></div>`;}).join(''):'<div class="reference-empty">비슷한 사고를 묻는 문제를 연결해 보세요.</div>';
  $('references').querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>{const t=findQuestion(b.dataset.jump);navigate(t.p.id,t.q.id,true).catch(report);toast('연결된 문제로 이동했습니다. Alt + ← 로 돌아갈 수 있습니다.');});
  $('references').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{const id=b.dataset.remove;state.links=state.links.filter(l=>!((l.a===q.id&&l.b===id)||(l.b===q.id&&l.a===id)));changed();renderReferences();});
}
function searchDialog(mode='search'){
  const current=question();if(mode==='reference'&&!current)return;
  dialog(mode==='reference'?'닮은 문제 연결하기':'문제와 사고 기록 검색',`<label for="searchInput">시험 이름, 문항 번호, 지문 내용, 메모, 키워드</label><input id="searchInput" placeholder="예: 6월, 12번, 조건 추론" autocomplete="off">${mode==='reference'?'<label for="referenceLabel">두 문제를 연결한 이유</label><input id="referenceLabel" placeholder="예: 필요조건과 충분조건을 구별하는 사고">':''}<div id="searchResults"></div>`);
  const update=()=>{
    const query=$('searchInput').value.trim().toLowerCase();const matches=[];
    for(const p of state.projects)for(const q of p.questions){
      if(mode==='reference' && (q.id===current.id || referencesFor(state,current.id).some(r=>r.target===q.id)))continue;
      const text=[p.title,`${q.number}번`,q.text,q.tags,...Object.values(q.notes||{})].join(' ').toLowerCase();
      if(!query||query.split(/\s+/).every(t=>text.includes(t)))matches.push({p,q});
    }
    $('searchResults').innerHTML=matches.length?matches.slice(0,100).map(({p,q})=>`<button class="search-result" data-result="${escape(q.id)}"><small>${escape(p.title)}</small><strong>${q.number}번 · ${escape(q.title||'직접 추가한 문제')}</strong><p>${escape(q.notes?.summary||q.notes?.thought||q.text||'아직 메모가 없습니다.')}</p></button>`).join(''):'<p>일치하는 문제가 없습니다.</p>';
    $('searchResults').querySelectorAll('[data-result]').forEach(b=>b.onclick=()=>{
      const target=findQuestion(b.dataset.result);
      if(mode==='reference'){addReference(state,current.id,target.q.id,$('referenceLabel').value.trim());changed();renderReferences();toast('두 문제에 참조를 함께 연결했습니다.');}
      else navigate(target.p.id,target.q.id,true).catch(report);
      $('dialog').close();
    });
  };$('searchInput').oninput=update;update();$('searchInput').focus();
}
function showBusy(title,detail,progress=0){$('busy').hidden=false;$('busyTitle').textContent=title;$('busyDetail').textContent=detail;$('busyProgress').value=progress;}
async function ensureOcr(){
  if(ocrWorker)return ocrWorker;
  ocrWorker=await window.Tesseract.createWorker(['kor','eng'],1,{
    workerPath:new URL('./vendor/worker.min.js',import.meta.url).href,
    corePath:new URL('./vendor/',import.meta.url).href,
    langPath:new URL('./vendor/',import.meta.url).href,gzip:false,workerBlobURL:false,cacheMethod:'none',
    logger:m=>{if(analysis && m.status==='recognizing text')$('busyDetail').textContent=`${analysis.page}쪽 · 한국어 OCR ${Math.round(m.progress*100)}% · 이 컴퓨터에서 처리 중`;},
  });
  await ocrWorker.setParameters({preserve_interword_spaces:'1'});return ocrWorker;
}
async function ocrPage(page,columns=2){
  const viewport=page.getViewport({scale:2.1}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
  const worker=await ensureOcr();
  const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
  const fragments=[];
  for(const block of data.blocks||[])for(const para of block.paragraphs||[])for(const line of para.lines||[])for(const word of line.words||[]){
    const b=word.bbox;fragments.push({text:word.text,x:b.x0/canvas.width,y:b.y0/canvas.height,w:(b.x1-b.x0)/canvas.width,h:(b.y1-b.y0)/canvas.height});
  }
  canvas.width=canvas.height=1;
  return mergeFragments(fragments,columns);
}
async function analyze(p,{columns=2,forceOcr=false,explanation=false}={}){
  if(analysis)throw new Error('다른 PDF를 인식 중입니다.');
  analysis={cancelled:false,page:1};const task=analysis;
  showBusy('지문과 문제를 정리하고 있습니다','원본의 문항 번호와 페이지 경계를 확인합니다.');
  try{
    const doc=await getDocument(explanation?{source:p.explanationSource}:p),pages=[];
    for(let n=1;n<=doc.numPages;n++){
      if(task.cancelled)throw new Error('인식을 중단했습니다. PDF는 보관되어 있으며 다시 인식하거나 수동으로 추가할 수 있습니다.');
      task.page=n;showBusy('지문과 문제를 정리하고 있습니다',`${n} / ${doc.numPages}쪽 · 글자 위치와 ${columns}단 읽기 순서를 분석 중`,(n-1)/doc.numPages*100);
      const page=await doc.getPage(n),viewport=page.getViewport({scale:1});
      const content=await page.getTextContent();let lines=textItemsToLines(content.items,viewport,pdfjs.Util.transform,columns),ocr=false;
      const text=lines.map(l=>l.text).join('');
      if(forceOcr || text.replace(/\s/g,'').length<35 || (text.match(/�/g)||[]).length>text.length*.15){
        showBusy('스캔 페이지를 인식하고 있습니다',`${n} / ${doc.numPages}쪽 · 한국어 OCR 준비 중 · 첫 인식은 시간이 걸릴 수 있습니다.`,(n-1)/doc.numPages*100);
        lines=await ocrPage(page,columns);ocr=true;
      }
      pages.push({width:viewport.width,height:viewport.height,lines,ocr});
      await new Promise(r=>setTimeout(r,0));
    }
    if(task.cancelled)throw new Error('인식을 중단했습니다.');
    if(explanation){
      const result=indexExplanations(pages,{columns});
      for(const q of p.questions){const found=result.entries.find(e=>e.number===q.number);if(found)q.explanation=found;}
      const missing=p.questions.filter(q=>!result.entries.some(e=>e.number===q.number));
      if(missing.length)result.warnings.push(`해설 미검출: ${missing.map(q=>q.number).join(', ')}번. 기존 해설이 없는 문항은 수동으로 지정해 주세요.`);
      p.explanationPages=result.pages;p.explanationWarnings=result.warnings;p.explanationOptions={columns,forceOcr};p.explanationSource.pages=doc.numPages;
      changed();await flush();render();toast(`${result.entries.length}개 해설을 찾았습니다. 누락된 기존 해설은 유지합니다.`);
      if(result.warnings.length)dialog('해설 인식 확인',`<p>${escape(result.warnings.join(' '))}</p>`);
      return;
    }
    const result=indexDocument(pages,{columns,trimWhitespace:true});
    // Stable IDs preserve notes and cross-project links when recognition is repeated.
    const oldByNumber=new Map(p.questions.map(q=>[q.number,q]));
    for(const q of result.questions){const old=oldByNumber.get(q.number);if(old){q.id=old.id;q.notes=old.notes;q.tags=old.tags;q.status=old.status;q.explanation=old.explanation;}}
    const recognized=new Set(result.questions.map(q=>q.number));
    const missingOld=p.questions.filter(q=>!recognized.has(q.number));
    if(missingOld.length){result.questions.push(...missingOld);result.questions.sort((a,b)=>a.number-b.number);result.passages.push(...p.passages.filter(old=>missingOld.some(q=>q.passageId===old.id)));result.warnings.push('다시 인식하지 못한 기존 문제는 메모와 참조 보호를 위해 유지했습니다. 범위를 검토해 주세요.');}
    Object.assign(p,result);p.source.pages=doc.numPages;p.analysisOptions={columns,forceOcr};p.analyzedAt=new Date().toISOString();
    questionId=p.questions[0]?.id||null;state.settings.lastProject=p.id;state.settings.lastQuestion=questionId;changed();await flush();render();
    toast(`${p.questions.length}개 문제와 ${p.passages.length}개 지문을 찾았습니다. 범위를 확인해 주세요.`);
  }finally{analysis=null;$('busy').hidden=true;if(ocrWorker){await ocrWorker.terminate().catch(()=>{});ocrWorker=null;}}
}
async function importExplanation(){
  const p=project();if(!p?.source)throw new Error('문제 PDF를 먼저 가져와 주세요.');
  if(p.explanationSource){dialog('해설 PDF 교체','<p>현재 해설은 저장 이력에 남습니다. 새 PDF에서 인식하지 못한 해설은 수동으로 연결해야 합니다.</p>',actionButton('교체할 PDF 선택','replaceExplanation',true));$('replaceExplanation').onclick=()=>{ $('dialog').close();selectExplanation().catch(report);};return;}
  await selectExplanation();
}
async function selectExplanation(){
  await flush();const file=await rpc('importExplanation');if(!file)return;
  const p=project();p.explanationSource=file;for(const q of p.questions)delete q.explanation;
  changed();await flush();render();reindexExplanationDialog();
}
function reindexExplanationDialog(){
  const p=project();if(!p?.explanationSource)return;
  dialog('해설 PDF 인식','<p>문항 번호와 [출제의도] 제목으로 해설을 연결합니다. 정답표와 지문 해제는 문항 해설에서 제외합니다.</p><label for="explanationColumns">원본 편집 방식</label><select id="explanationColumns"><option value="3">3단 · 교육청 정답 및 해설</option><option value="2">2단</option><option value="1">1단</option></select><label for="explanationOcr">문자 인식</label><select id="explanationOcr"><option value="auto">텍스트 우선 · 스캔 자동 OCR</option><option value="force">모든 페이지 OCR</option></select>',actionButton('해설 인식','analyzeExplanation',true));
  $('explanationColumns').value=p.explanationOptions?.columns||3;
  $('analyzeExplanation').onclick=()=>{const options={columns:+$('explanationColumns').value,forceOcr:$('explanationOcr').value==='force',explanation:true};$('dialog').close();analyze(p,options).catch(report);};
}
async function importPdf(){
  const p=project();if(!p)return;if(p.source)throw new Error('새 PDF는 새 프로젝트에 가져와 주세요.');
  await flush();const file=await rpc('importPdf');if(!file)return;p.source=file;changed();await flush();render();
  await analyze(p);
}
function reindexDialog(){
  const p=project();if(!p?.source)return;
  dialog('PDF 다시 인식',`<p>같은 번호의 문제 메모와 참조는 유지합니다. 자동 인식 범위는 새 결과로 바뀌며, 기존 저장 이력에도 남습니다.</p><label for="columnMode">원본 편집 방식</label><select id="columnMode"><option value="2">2단 · 일반적인 수능 / 모의평가</option><option value="1">1단 · 한 줄 전체 폭</option></select><label for="ocrMode">문자 인식</label><select id="ocrMode"><option value="auto">텍스트 우선 · 스캔 페이지는 자동 OCR</option><option value="force">모든 페이지를 한국어 OCR로 인식</option></select>`,actionButton('취소','reindexCancel')+actionButton('다시 인식','reindexConfirm',true));
  $('columnMode').value=p.analysisOptions?.columns||2;$('reindexCancel').onclick=()=>$('dialog').close();
  $('reindexConfirm').onclick=()=>{const options={columns:+$('columnMode').value,forceOcr:$('ocrMode').value==='force'};$('dialog').close();analyze(p,options).catch(report);};
}
function addQuestion(){
  const p=project();if(!p?.source)return;
  askText('문제 직접 추가','원본의 문항 번호',String(Math.max(0,...p.questions.map(q=>q.number))+1),async value=>{
    const number=Number(value);if(!Number.isInteger(number)||number<1||number>999)throw new Error('1~999 사이의 문항 번호를 입력해 주세요.');
    if(p.questions.some(q=>q.number===number))throw new Error('이 번호의 문제가 이미 있습니다. 기존 문제의 범위를 수정해 주세요.');
    const q={id:uid(),number,title:`${number}번 문제`,text:'',passageId:null,segments:[],notes:{thought:'',should:'',summary:''},tags:'',status:'new',reviewed:false};
    p.questions.push(q);p.questions.sort((a,b)=>a.number-b.number);questionId=q.id;changed();await flush();render();
    // The text dialog closes after this callback. Open the crop editor afterwards.
    setTimeout(()=>cropEditor('question').catch(report),0);
  });
}
async function cropEditor(kind='question',readOnly=false){
  const p=project(),q=question();if(!p?.source)return;if(!q&&!readOnly){toast('문제를 먼저 추가해 주세요.');return;}
  const passage=q&&p.passages.find(x=>x.id===q.passageId);
  const explanation=kind==='explanation';if(explanation&&!p.explanationSource)throw new Error('해설 PDF를 먼저 가져와 주세요.');
  let segments=structuredClone(kind==='passage'?passage?.segments||[]:explanation?q?.explanation?.segments||[]:q?.segments||[]);
  let pageNumber=segments[0]?.page||1,drag=null,currentSelection=null,pageGeneration=0,cropRender=null;
  const doc=await getDocument(explanation?{source:p.explanationSource}:p);
  dialog(readOnly?(explanation?'해설 원본 PDF':'원본 PDF'):`${kind==='passage'?'지문':explanation?'해설':'문제'} 범위 수정`,
    `<p class="tiny">${readOnly?'원본 페이지를 넘기며 확인할 수 있습니다.':'원본에서 드래그하여 영역을 선택하고 「선택 영역 추가」를 누르세요. 다음 페이지에서도 추가하면 하나로 이어집니다. 추가한 순서대로 표시됩니다.'}</p><div class="crop-page-controls"><button id="cropPrev">←</button><span id="cropPageLabel"></span><button id="cropNext">→</button></div><div class="crop-layout"><div class="crop-viewport" id="cropViewport"><canvas id="cropCanvas"></canvas><div class="crop-selection" id="cropSelection" hidden></div></div><aside class="crop-tools">${readOnly?'':`<button id="cropAdd" disabled>＋ 선택 영역 추가</button><button id="cropLeft">왼쪽 단 전체 추가</button><button id="cropRight">오른쪽 단 전체 추가</button><button id="cropFull">현재 페이지 전체 추가</button><p class="tiny">기존 영역은 ×로 지운 뒤 새 영역을 추가할 수 있습니다.</p><div id="cropSegments"></div>${kind==='passage'?`<label for="applyGroup">이 지문을 함께 볼 문제</label><input id="applyGroup" value="${escape(p.questions.filter(x=>passage&&x.passageId===passage.id).map(x=>x.number).join(', ')||q.number)}" placeholder="예: 4,5,6,7" style="width:100%;font-size:10px;padding:7px;margin-top:8px"><p class="tiny">쉼표로 번호를 구분합니다.</p>`:''}`}</aside></div>`,actionButton('닫기','cropCancel')+(readOnly?'':actionButton('범위 저장','cropSave',true)));
  $('dialog').className='crop-dialog';$('cropCancel').onclick=()=>$('dialog').close();
  function list(){if(readOnly)return;$('cropSegments').innerHTML=segments.map((s,i)=>`<div class="segment-item"><button data-segment="${i}" title="영역 제거">×</button>${i+1}. 원본 ${s.page}쪽<br><small>${Math.round(s.w*100)}% 폭 · ${Math.round(s.h*100)}% 높이</small></div>`).join('');$('cropSegments').querySelectorAll('button').forEach(b=>b.onclick=()=>{segments.splice(+b.dataset.segment,1);list();});}
  async function draw(){
    const generation=++pageGeneration;
    if(cropRender){cropRender.cancel();await cropRender.promise.catch(()=>{});}
    if(generation!==pageGeneration)return;
    $('cropPageLabel').textContent=`${pageNumber} / ${doc.numPages}쪽`;$('cropPrev').disabled=pageNumber===1;$('cropNext').disabled=pageNumber===doc.numPages;
    currentSelection=null;$('cropSelection').hidden=true;if(!readOnly)$('cropAdd').disabled=true;
    const page=await doc.getPage(pageNumber);if(generation!==pageGeneration)return;
    const viewport=page.getViewport({scale:1.3}),canvas=$('cropCanvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    cropRender=page.render({canvasContext:canvas.getContext('2d'),viewport});
    try{await cropRender.promise;}catch(e){if(e.name!=='RenderingCancelledException')throw e;}
  }
  $('cropPrev').onclick=()=>{pageNumber--;draw().catch(report);};$('cropNext').onclick=()=>{pageNumber++;draw().catch(report);};
  if(!readOnly){
    const view=$('cropViewport');
    const point=e=>{const r=view.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
    view.onpointerdown=e=>{if(e.button!==0)return;drag=point(e);view.setPointerCapture(e.pointerId);e.preventDefault();};
    view.onpointermove=e=>{if(!drag)return;const end=point(e);currentSelection={page:pageNumber,x:Math.min(drag.x,end.x),y:Math.min(drag.y,end.y),w:Math.abs(end.x-drag.x),h:Math.abs(end.y-drag.y)};const s=currentSelection,box=$('cropSelection');box.hidden=false;Object.assign(box.style,{left:s.x*100+'%',top:s.y*100+'%',width:s.w*100+'%',height:s.h*100+'%'});};
    view.onpointerup=()=>{drag=null;$('cropAdd').disabled=!currentSelection||currentSelection.w<.015||currentSelection.h<.01;};
    $('cropAdd').onclick=()=>{segments.push({...currentSelection});list();currentSelection=null;$('cropSelection').hidden=true;$('cropAdd').disabled=true;};
    $('cropLeft').onclick=()=>{segments.push({page:pageNumber,x:.025,y:.047,w:.468,h:.906,column:0});list();};
    $('cropRight').onclick=()=>{segments.push({page:pageNumber,x:.507,y:.047,w:.468,h:.906,column:1});list();};
    $('cropFull').onclick=()=>{segments.push({page:pageNumber,x:.02,y:.035,w:.96,h:.93});list();};
    $('cropSave').onclick=async()=>{
      try{
        if(!segments.length)throw new Error('최소 한 개의 영역을 추가해 주세요.');
        if(kind==='passage'){
          const nums=$('applyGroup').value.split(/[,，\s]+/).filter(Boolean).map(Number);
          if(!nums.length||nums.some(n=>!p.questions.some(x=>x.number===n)))throw new Error('실제로 존재하는 문제 번호를 쉼표로 구분하여 입력해 주세요.');
          let target=passage;
          if(!target){target={id:uid(),label:'직접 지정한 공통 지문',segments:[],text:''};p.passages.push(target);}
          target.segments=segments;target.reviewed=true;target.label=`${nums.join(', ')}번 공통 지문`;
          for(const item of p.questions){if(nums.includes(item.number))item.passageId=target.id;else if(item.passageId===target.id)item.passageId=null;}
        }else if(explanation){q.explanation={...q.explanation,number:q.number,segments,reviewed:true};}else{q.segments=segments;q.reviewed=true;}
        changed();await flush();$('dialog').close();renderQuestion().catch(report);toast('페이지를 잇는 영역을 저장했습니다.');
      }catch(e){report(e);}
    };
  }
  list();await draw();
}
async function historyDialog(){
  await flush();const entries=await rpc('history');
  dialog('최근 저장 이력',`<p>최근 100개 버전을 보관하며 아래에는 30개를 표시합니다.<br>복원 전 현재 데이터도 이력에 남습니다. 원본 PDF는 삭제되지 않습니다.</p><div id="historyList">${entries.length?entries.map(e=>`<div class="history-item"><span>${escape(new Date(e.created.replace(' ','T')+'Z').toLocaleString('ko-KR'))} · #${e.id}</span><button data-restore="${e.id}">이 버전 복원</button></div>`).join(''):'<p>아직 이전 저장 이력이 없습니다.</p>'}</div>`);
  $('historyList').querySelectorAll('button').forEach(b=>b.onclick=async()=>{try{const result=await rpc('restoreRevision',{id:+b.dataset.restore});state=result.state;changed();await flush();projectId=state.projects.some(p=>p.id===projectId)?projectId:state.projects[0]?.id;questionId=project()?.questions[0]?.id||null;$('dialog').close();render();toast('선택한 저장 이력을 복원했습니다.');}catch(e){report(e);}});
}

on('importExplanation','click',importExplanation);on('reindexExplanation','click',reindexExplanationDialog);
on('editExplanation','click',()=>cropEditor('explanation'));on('originalExplanation','click',()=>cropEditor('explanation',true));
on('explanationBox','toggle',()=>{if($('explanationBox').open){const p=project(),q=question();return renderSegments($('explanationPaper'),q?.explanation?.segments,{source:p.explanationSource},renderToken);}});
on('newProject','click',newProject);on('startProject','click',newProject);
on('renameProject','click',()=>{const p=project();if(p)askText('프로젝트 이름 수정','시험 이름',p.title,async title=>{p.title=title;changed();await flush();render();});});
on('importPdf','click',importPdf);on('importPdfEmpty','click',importPdf);on('reindex','click',reindexDialog);
on('addQuestion','click',addQuestion);on('original','click',()=>cropEditor('question',true));on('editQuestion','click',()=>cropEditor('question'));on('editPassage','click',()=>cropEditor('passage'));
on('prevQuestion','click',()=>{const p=project(),i=p?.questions.indexOf(question());if(i>0){questionId=p.questions[i-1].id;state.settings.lastQuestion=questionId;changed();renderTabs();return renderQuestion();}});
on('nextQuestion','click',()=>{const p=project(),i=p?.questions.indexOf(question());if(i>=0&&i<p.questions.length-1){questionId=p.questions[i+1].id;state.settings.lastQuestion=questionId;changed();renderTabs();return renderQuestion();}});
on('questionStatus','change',()=>{const q=question();if(q){q.status=$('questionStatus').value;changed();}});
on('reviewed','click',()=>{const q=question();if(q){q.reviewed=!q.reviewed;changed();return renderQuestion();}});
on('toggleNotes','click',()=>{if(!question())return;notesOpen=!notesOpen;$('notes').hidden=!notesOpen;});on('closeNotes','click',()=>{notesOpen=false;$('notes').hidden=true;});
for(const [id,key] of [['noteThought','thought'],['noteShould','should'],['noteSummary','summary']])on(id,'input',()=>{const q=question();if(q){q.notes??={thought:'',should:'',summary:''};q.notes[key]=$(id).value;changed();renderTabs();renderProjects();}});
on('noteTags','input',()=>{const q=question();if(q){q.tags=$('noteTags').value;changed();}});
on('addReference','click',()=>searchDialog('reference'));on('globalSearch','click',()=>searchDialog());
on('zoomIn','click',()=>{zoom=Math.min(2,zoom+.15);return renderQuestion();});on('zoomOut','click',()=>{zoom=Math.max(.6,zoom-.15);return renderQuestion();});
on('saveState','click',async()=>{await flush();toast('현재 내용이 로컬에 저장되었습니다.');});
on('openData','click',()=>rpc('openData'));on('backup','click',async()=>{await flush();const backup=await rpc('backup');if(backup)dialog('백업을 만들었습니다',`<p>메모, 상호 참조, 원본 PDF를 함께 복사했습니다.</p><p style="word-break:break-all">${escape(backup.path)}</p><p>다른 PC로 옮길 때는 실행 파일과 Data 폴더를 함께 옮기면 됩니다.</p>`);});
on('history','click',historyDialog);
on('cancelAnalysis','click',()=>{if(analysis){analysis.cancelled=true;$('busyDetail').textContent='현재 페이지 처리가 끝나면 중단합니다. 원본 PDF는 보관됩니다.';}});
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.key.toLowerCase()==='k'){e.preventDefault();searchDialog();}
  if(e.ctrlKey&&e.key.toLowerCase()==='s'){e.preventDefault();flush().then(()=>toast('저장했습니다.')).catch(report);}
  if(e.altKey&&e.key==='ArrowLeft'&&navHistory.length){e.preventDefault();const target=navHistory.pop();navigate(target.pid,target.qid).catch(report);}
});
window.requestClose=async()=>{
  try{if(analysis){analysis.cancelled=true;if(ocrWorker){await ocrWorker.terminate().catch(()=>{});ocrWorker=null;}}await flush();await rpc('close');}
  catch(e){report(e);dialog('저장하지 못한 내용이 있습니다',`<p>${escape(e.message)}</p><p>창을 열어 둔 상태에서 디스크 공간과 Data 폴더 쓰기 권한을 확인한 후 저장 표시를 눌러 다시 시도해 주세요.</p>`);}
};
window.addEventListener('unhandledrejection',e=>{e.preventDefault();report(e.reason);});
try{
  const loaded=await rpc('load');state=loaded.state;revision=loaded.revision;state.settings??={};
  projectId=state.settings.lastProject||state.projects[0]?.id||null;if(!state.projects.some(p=>p.id===projectId))projectId=state.projects[0]?.id||null;
  questionId=state.settings.lastQuestion||project()?.questions[0]?.id||null;if(!question())questionId=project()?.questions[0]?.id||null;
  status('모든 변경 사항이 저장됨');$('saveState').title=loaded.dataPath;render();
  if(loaded.pendingPdf){
    const p={id:uid(),title:loaded.pendingPdf,createdAt:new Date().toISOString(),source:null,questions:[],passages:[],pages:[],warnings:[]};
    state.projects.push(p);projectId=p.id;questionId=null;changed();await flush();render();await importPdf().catch(report);
  }
  if(loaded.pendingExplanation){if(project()?.source)await selectExplanation();else toast('문제 PDF가 있는 프로젝트를 먼저 만들어 주세요.',true);}
}catch(e){status('저장소를 열 수 없음','error');report(e);dialog('저장소를 열지 못했습니다',`<p>${escape(e.message)}</p><p>기존 Data 폴더를 보존한 상태로 프로그램을 다시 실행해 주세요.</p>`);}
