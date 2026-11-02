// Runs the actual Win32 executable and its embedded UI, against disposable data.
// Test dependency: playwright-core 1.56.1 in .deps/playwright (no browser download).
const {chromium}=require('../.deps/playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const data=path.join(root,'tmp',`e2e-${Date.now()}`);
const exe=path.join(root,'dist','KoreanSeoJi.exe');
let port=9310;
let app,browser,page;
const errors=[];
async function connect(){
  for(let i=0;i<80;i++){
    try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  if(!browser?.isConnected())throw Error('Test WebView2 debug endpoint did not become ready');
  page=browser.contexts()[0].pages()[0];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
}
function launch(pdf){
  port++;
  app=spawn(exe,['--data-dir',data,...(pdf?['--pdf',path.join(root,'tmp',pdf)]:[])],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});
}
async function close(){
  await page.evaluate(()=>{void window.requestClose();}).catch(e=>{if(!String(e).includes('has been closed'))throw e;});
  await new Promise((resolve,reject)=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(()=>reject(Error('Native app did not close')),10000).unref();});
  await browser.close().catch(()=>{});
}
async function saved(){await page.waitForFunction(()=>document.querySelector('#saveState').textContent.includes('모든 변경 사항'),{},{timeout:20000});}
(async()=>{
  await fs.mkdir(data,{recursive:true});
  launch('sample-exam.pdf');await connect();
  await page.waitForFunction(()=>document.querySelectorAll('.question-tab').length===4,{},{timeout:30000});
  await saved();
  assert.match(await page.locator('#passagePages').innerText(),/1, 2/);
  assert.equal(await page.locator('#passagePaper canvas').count(),3);
  await page.locator('#renameProject').click();await page.locator('#textInput').fill('검증용 2026년 6월');await page.locator('#textSave').click();
  await page.locator('#toggleNotes').click();
  await page.locator('#noteThought').fill('선지의 조건을 충분조건으로 오해했다. 재실행 검증.');
  await page.locator('#noteShould').fill('필요조건과 충분조건의 방향을 구별한다.');
  await page.locator('#noteSummary').fill('조건 관계를 읽고 새 사례에 적용하는 출제 의도.');
  await page.locator('#noteTags').fill('조건 추론, 논리 관계');
  await saved();
  // The note editor opens the direct underline mode and closes to expose the PDF.
  await page.locator('#noteUnderline').click();
  assert.equal(await page.locator('#notes').isVisible(),false);
  await page.locator('#questionPaper .evidence-hit-layer').first().waitFor();
  const hit=await page.locator('#questionPaper .evidence-hit-layer').first().boundingBox();
  assert.ok(hit?.width>80);
  await page.mouse.move(hit.x+hit.width*.15,hit.y+hit.height*.35);
  await page.mouse.down();
  await page.mouse.move(hit.x+hit.width*.65,hit.y+hit.height*.35,{steps:8});
  await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#underlineCount')?.textContent==='1');
  assert.equal(await page.locator('#questionPaper .underline-mark').count(),1);
  await page.locator('[data-underline-note]').fill('선지의 판단 근거에 밑줄');
  await saved();
  await page.locator('#underlineEvidence').click();
  await page.locator('#addReference').click();
  await page.locator('#referenceLabel').fill('같은 조건 추론을 요구함');
  await page.locator('.search-result').first().click();
  assert.equal(await page.locator('#referenceCount').innerText(),'1');
  await page.locator('.reference-jump').click();
  assert.equal(await page.locator('#questionLabel').innerText(),'2번 문제');
  assert.match(await page.locator('.reference-jump').innerText(),/1번 문제/);
  await page.locator('.reference-jump').click();
  assert.equal(await page.locator('#questionLabel').innerText(),'1번 문제');
  // Manual range correction can join multiple pages and assign one shared passage.
  await page.locator('#editPassage').click();
  assert.equal(await page.locator('.segment-item').count(),3);
  await page.waitForFunction(()=>document.querySelector('#cropCanvas')?.height>100);
  const cropBox=await page.locator('#cropCanvas').boundingBox();
  await page.mouse.move(cropBox.x+cropBox.width*.07,cropBox.y+cropBox.height*.1);await page.mouse.down();
  await page.mouse.move(cropBox.x+cropBox.width*.44,cropBox.y+cropBox.height*.25,{steps:8});await page.mouse.up();
  await page.locator('#cropAdd').click();assert.equal(await page.locator('.segment-item').count(),4);
  await page.locator('.segment-item button').last().click();assert.equal(await page.locator('.segment-item').count(),3);
  await page.locator('#cropSave').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  // Search indexes note text as well as original question text.
  await page.locator('#globalSearch').click();await page.locator('#searchInput').fill('再実行しない日本語');
  assert.equal(await page.locator('.search-result').count(),0);
  await page.locator('#searchInput').fill('재실행 검증');assert.equal(await page.locator('.search-result').count(),1);
  await page.locator('.search-result').click();
  await page.locator('#toggleNotes').click();
  await page.evaluate(()=>document.querySelector('#toast').hidden=true);
  await page.screenshot({path:path.join(root,'tmp','study-preview.png')});
  await saved();await close();
  // Reopen the same SQLite database and copied PDF in a new native process.
  launch();await connect();await page.waitForFunction(()=>document.querySelectorAll('.question-tab').length===4);
  await page.locator('#toggleNotes').click();
  assert.equal(await page.locator('#noteThought').inputValue(),'선지의 조건을 충분조건으로 오해했다. 재실행 검증.');
  assert.equal(await page.locator('#noteShould').inputValue(),'필요조건과 충분조건의 방향을 구별한다.');
  assert.equal(await page.locator('#noteTags').inputValue(),'조건 추론, 논리 관계');
  assert.equal(await page.locator('#underlineCount').innerText(),'1');
  assert.equal(await page.locator('[data-underline-note]').inputValue(),'선지의 판단 근거에 밑줄');
  assert.equal(await page.locator('#referenceCount').innerText(),'1');
  await page.locator('#closeNotes').click();
  // Re-index must keep note IDs and symmetric cross-references intact.
  await page.locator('#reindex').click();await page.locator('#reindexConfirm').click();
  await page.locator('#busy').waitFor({state:'hidden',timeout:30000});await saved();
  await page.locator('#toggleNotes').click();assert.match(await page.locator('#noteThought').inputValue(),/재실행 검증/);
  assert.equal(await page.locator('#referenceCount').innerText(),'1');
  // Closing immediately after input must flush the pending autosave.
  await page.locator('#noteShould').fill('종료 직전 입력도 보존한다.');
  await close();
  launch();await connect();await page.waitForFunction(()=>document.querySelectorAll('.question-tab').length===4);
  await page.locator('#toggleNotes').click();assert.equal(await page.locator('#noteShould').inputValue(),'종료 직전 입력도 보존한다.');
  await close();
  // A second PDF project can link to, and return from, the first project.
  launch('sample-exam.pdf');await connect();
  await page.waitForFunction(()=>document.querySelector('#projectTitle')?.textContent==='sample-exam'&&document.querySelectorAll('.question-tab').length===4);
  await saved();await page.locator('#addReference').click();await page.locator('#searchInput').fill('검증용');
  await page.locator('#referenceLabel').fill('다른 시험에서 같은 사고를 요구함');await page.locator('.search-result').first().click();
  await page.locator('.reference-jump').click();assert.equal(await page.locator('#projectTitle').innerText(),'검증용 2026년 6월');
  assert.equal(await page.locator('#referenceCount').innerText(),'2');
  await page.locator('.reference-jump').filter({hasText:'sample-exam'}).click();assert.equal(await page.locator('#projectTitle').innerText(),'sample-exam');
  await close();
  assert.deepEqual(errors,[]);
  console.log('PASS: native PDF import, 3-segment passage, notes, symmetric links within and across projects, manual crop save, search, reopen, reindex preserves notes, immediate-close flush');
  console.log('Test data:',data);
})().catch(async e=>{console.error(e);console.error('Browser errors:',errors);if(page){console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-3500));console.error('Dialog:',await page.locator('#dialogContent').textContent().catch(()=>''));}if(app&&app.exitCode===null)app.kill();process.exitCode=1;});
