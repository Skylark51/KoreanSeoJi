const {chromium}=require('../.deps/playwright');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
  const data=path.join(root,'tmp','ocr-'+Date.now());await fs.mkdir(data,{recursive:true});
  const app=spawn(path.join(root,'dist','KoreanSeoJi.exe'),['--data-dir',data,'--pdf',path.join(root,'tmp','sample-scan.pdf')],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9232'},stdio:'ignore'});
  let browser,page;
  try{
    for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:9232/json/version')).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
    browser=await chromium.connectOverCDP('http://127.0.0.1:9232');page=browser.contexts()[0].pages()[0];
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.waitForFunction(()=>document.querySelector('#warning')?.textContent.includes('OCR'),{},{timeout:120000});
    const result=await page.evaluate(()=>new Promise(resolve=>{
      chrome.webview.addEventListener('message',function h(e){if(e.data.id===99991){chrome.webview.removeEventListener('message',h);resolve(e.data.result);}});
      chrome.webview.postMessage({id:99991,action:'load'});
    }));
    const p=result.state.projects.at(-1);assert.equal(p.pages[0].ocr,true);assert.ok(p.questions.length>=1);assert.ok(p.questions.some(q=>q.number===2));assert.deepEqual(errors,[]);
    console.log('PASS: offline Korean OCR, scanned PDF geometry, question 2 detected. Questions:',p.questions.map(q=>q.number));
    await page.evaluate(()=>{void window.requestClose();}).catch(()=>{});await browser.close().catch(()=>{});
  }catch(e){if(page)console.error((await page.locator('body').innerText()).slice(-2500));throw e;}
  finally{if(app.exitCode===null)app.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
