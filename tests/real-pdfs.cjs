// Opt-in integration test against user-supplied PDFs. PDFs and state stay local.
const {chromium}=require('../.deps/playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const [exam,solution,dataArg]=process.argv.slice(2);
if(!exam||!solution)throw Error('Usage: node tests/real-pdfs.cjs EXAM.pdf EXPLANATION.pdf [DATA_DIR]');
const root=path.resolve(__dirname,'..'),data=path.resolve(dataArg||path.join(root,'tmp',`real-${Date.now()}`));
let app,browser,page;const errors=[];let port=9450;
async function launch(first){
 port++;app=spawn(path.join(root,'dist/KoreanSeoJi.exe'),['--data-dir',data,...(first?['--pdf',path.resolve(exam),'--explanation',path.resolve(solution)]:[])],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});
 for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{}await new Promise(r=>setTimeout(r,200));}
 page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
}
async function rpc(action,args={}){return page.evaluate(({action,args})=>new Promise((resolve,reject)=>{const id='test-'+crypto.randomUUID();const handler=e=>{if(e.data.id!==id)return;chrome.webview.removeEventListener('message',handler);e.data.ok?resolve(e.data.result):reject(Error(e.data.error));};chrome.webview.addEventListener('message',handler);chrome.webview.postMessage({id,action,args});}),{action,args});}
async function close(){await page.evaluate(()=>{void window.requestClose();}).catch(()=>{});await new Promise((r,j)=>{if(app.exitCode!==null)return r();app.once('exit',r);setTimeout(()=>j(Error('close timeout')),15000).unref();});await browser.close();browser=null;}
(async()=>{
 await fs.mkdir(data,{recursive:true});await fs.mkdir(path.join(root,'tmp/real'),{recursive:true});const exists=await fs.access(path.join(data,'library.sqlite3')).then(()=>true,()=>false);await launch(!exists);
 if(exists){await page.locator('#reindex').waitFor();const before=(await rpc('load')).state.projects.at(-1).questions.map(q=>q.explanation);await page.locator('#reindex').click();await page.locator('#reindexConfirm').click();await page.locator('#busy').waitFor({state:'hidden',timeout:60000});assert.deepEqual((await rpc('load')).state.projects.at(-1).questions.map(q=>q.explanation),before);await page.locator('#reindexExplanation').click();}
 await page.locator('#analyzeExplanation').waitFor({timeout:60000});await page.locator('#analyzeExplanation').click();
 await page.locator('#busy').waitFor({state:'hidden',timeout:60000});await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('모든 변경 사항'));
 let loaded=await rpc('load');let p=loaded.state.projects.at(-1);
 const geometry=await page.evaluate(async p=>{
  const pdf=await import('./vendor/pdf.mjs'),parser=await import('./parser.mjs');const result={};
  for(const [key,source,columns]of [['exam',p.source,2],['solution',p.explanationSource,3]]){
   const doc=await pdf.getDocument({url:`https://pdf.seoji.local/${source.id}.pdf`,cMapUrl:new URL('./vendor/cmaps/',location.href).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',location.href).href}).promise;
   const pages=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),v=page.getViewport({scale:1}),content=await page.getTextContent();pages.push({width:v.width,height:v.height,lines:parser.textItemsToLines(content.items,v,pdf.Util.transform,columns)});}result[key]=pages;await doc.cleanup();
  }return result;
 },p);await fs.writeFile(path.join(root,'tmp/real/native-geometry.json'),JSON.stringify(geometry));
 assert.equal(p.questions.length,45);assert.equal(p.passages.length,11);
 assert.deepEqual(p.questions.map(q=>q.number),Array.from({length:45},(_,i)=>i+1));
 assert.equal(p.questions.filter(q=>q.explanation?.segments.length).length,45);
 assert.equal(p.questions.filter(q=>q.explanation?.answer).length,45);
 await page.locator('#renameProject').click();await page.locator('#textInput').fill('2026학년도 10월 고3 · 국어 화법과 작문');await page.locator('#textSave').click();
 // Exercise each real question and explanation through the actual embedded renderer.
 for(let n=1;n<=45;n++){
  await page.locator(`[data-q="${p.questions[n-1].id}"]`).click();
  await page.locator('#explanationBox summary').click();
  await page.waitForFunction(()=>document.querySelectorAll('#explanationPaper canvas').length>0);
  if([3,12,34,38,43,45].includes(n)){await page.screenshot({path:path.join(root,'tmp/real',`app-q${n}.png`)});}
 }
 await page.locator(`[data-q="${p.questions[0].id}"]`).click();
 await page.locator('#explanationBox summary').click();await page.locator('#editExplanation').click();await page.waitForFunction(()=>document.querySelector('#cropCanvas')?.height>100);assert.equal(await page.locator('.segment-item').count(),p.questions[0].explanation.segments.length);await page.locator('#cropSave').click();await page.locator('#dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('모든 변경 사항'));
 loaded=await rpc('load');p=loaded.state.projects.at(-1);
 await fs.writeFile(path.join(root,'tmp/real/native-state.json'),JSON.stringify(loaded.state,null,2));
 await close();await launch(false);
 await page.waitForFunction(()=>document.querySelectorAll('.question-tab').length===45);
 const reopened=await rpc('load');assert.deepEqual(reopened.state.projects.at(-1),p);
 await close();assert.deepEqual(errors,[]);
 console.log('PASS: real 16-page exam + 5-page explanation, 45 questions, 11 passages, 45 linked explanations/answers, all rendered, reopen persistence');console.log('Data:',data);
})().catch(async e=>{console.error(e);console.error(errors);if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-2000));if(app&&app.exitCode===null)app.kill();process.exitCode=1;});
