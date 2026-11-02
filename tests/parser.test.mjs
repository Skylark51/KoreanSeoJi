import test from 'node:test';
import assert from 'node:assert/strict';
import {indexDocument,mergeFragments,addReference,referencesFor} from '../web/parser.mjs';
const line=(text,y,column=0)=>({text,y,column,x:column?.53:.05,w:.4,h:.012});
const page=lines=>({width:600,height:850,lines});
const ids=()=>{let n=0;return()=>`test-${++n}`;};

test('지문이 단 경계와 페이지 경계를 넘어도 모든 영역을 연결한다',()=>{
  const result=indexDocument([
    page([line('[1~2] 다음 글을 읽고 물음에 답하시오.',.1),line('왼쪽 단의 지문 시작',.15),line('오른쪽 단에서도 계속되는 지문',.1,1)]),
    page([line('다음 페이지에 이어지는 지문의 마지막 문장',.1),line('1. 윗글을 이해한 내용으로 적절한 것은?',.30),line('① 첫 번째 선지',.35),line('2. 윗글의 조건에 대한 설명으로 적절한 것은?',.12,1),line('① 두 번째 문제 선지',.2,1)])
  ],{makeId:ids()});
  assert.equal(result.passages.length,1);assert.equal(result.questions.length,2);
  assert.deepEqual(result.passages[0].segments.map(s=>[s.page,s.column]),[[1,0],[1,1],[2,0]]);
  assert.ok(Math.abs(result.passages[0].segments.at(-1).y+result.passages[0].segments.at(-1).h-.295)<.001);
  assert.equal(result.questions[0].passageId,result.questions[1].passageId);
  assert.deepEqual(result.questions[0].segments.map(s=>[s.page,s.column]),[[2,0],[2,1]]);
  assert.match(result.passages[0].text,/마지막 문장/);
  assert.doesNotMatch(result.passages[0].text,/첫 번째 선지/);
});
test('다음 지문이 시작될 때 이전 문제 영역을 멈춘다',()=>{
  const result=indexDocument([page([line('[1~2] 다음 글을 읽으시오.',.1),line('지문 A',.15),line('1. 적절한 것은?',.3),line('2. 적절하지 않은 것은?',.5),line('[3~4] 다음 글을 읽으시오.',.1,1),line('지문 B',.2,1),line('3. 설명으로 적절한 것은?',.4,1),line('4. 반응으로 적절한 것은?',.7,1)])],{makeId:ids()});
  assert.equal(result.passages.length,2);assert.equal(result.questions.length,4);
  assert.notEqual(result.questions[1].passageId,result.questions[2].passageId);
  assert.doesNotMatch(result.questions[1].text,/지문 B/);
});
test('반복된 문단 번호를 버리고 번호 누락을 알린다',()=>{
  const result=indexDocument([page([line('1. 내용으로 적절한 것은?',.1),line('1. 문단 속 반복 숫자',.2),line('2. 추론으로 적절한 것은?',.3),line('4. 반응으로 적절한 것은?',.5)])],{makeId:ids()});
  assert.deepEqual(result.questions.map(q=>q.number),[1,2,4]);assert.match(result.warnings.join(),/3번/);
});
test('스캔 OCR과 문항 미검출은 검토 경고를 남긴다',()=>{
  const result=indexDocument([{...page([line('깨진 번호',.1)]),ocr:true}],{makeId:ids()});
  assert.equal(result.questions.length,0);assert.match(result.warnings.join(),/OCR/);assert.match(result.warnings.join(),/수동/);
});
test('OCR 단어를 양쪽 단의 독립된 줄로 묶는다',()=>{
  const result=mergeFragments([{text:'1.',x:.05,y:.1,w:.02,h:.015},{text:'문제',x:.08,y:.101,w:.05,h:.015},{text:'2.',x:.53,y:.1,w:.02,h:.015},{text:'다른 문제',x:.56,y:.1,w:.1,h:.015}]);
  assert.equal(result.length,2);assert.equal(result[0].text,'1. 문제');assert.equal(result[1].text,'2. 다른 문제');
});
test('참조 하나가 양쪽에서 보이며 역방향 중복 연결을 막는다',()=>{
  const state={links:[]};assert.equal(addReference(state,'q1','q2','조건 추론'),true);assert.equal(addReference(state,'q2','q1'),false);
  assert.equal(state.links.length,1);assert.equal(referencesFor(state,'q1')[0].target,'q2');assert.equal(referencesFor(state,'q2')[0].target,'q1');assert.throws(()=>addReference(state,'q1','q1'));
});
