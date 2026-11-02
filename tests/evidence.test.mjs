import test from 'node:test';
import assert from 'node:assert/strict';
import {regionFromDrag,evidenceOverlap,segmentDisplayWidths,underlineFromDrag,underlineOverlap} from '../web/evidence.mjs';

test('단별 크롭의 텍스트가 같은 원본 배율과 왼쪽 기준선으로 렌더링된다',()=>{
  const segments=[{page:1,x:.025,y:.1,w:.468,h:.5},{page:1,x:.507,y:.1,w:.468,h:.5},{page:2,x:.025,y:.1,w:.234,h:.2}];
  assert.deepEqual(segmentDisplayWidths(segments,[{width:600},{width:600}]),[100,100,50]);
});

test('드래그 영역을 크롭이 아닌 원본 PDF 좌표에 저장한다',()=>{
  const segment={page:2,x:.507,y:.2,w:.468,h:.4};
  const r=regionFromDrag(segment,{x:.1,y:.15},{x:.6,y:.3});
  assert.equal(r.page,2);assert.ok(Math.abs(r.x-.5538)<1e-9);
  assert.ok(Math.abs(r.y-.26)<1e-9);assert.ok(Math.abs(r.w-.234)<1e-9);
  assert.ok(Math.abs(r.h-.06)<1e-9);
  assert.equal(regionFromDrag(segment,{x:.1,y:.1},{x:.101,y:.1}),null);
});

test('범위를 다시 크롭해도 하이라이터가 원본 위치에 남는다',()=>{
  const region={page:2,x:.6,y:.26,w:.1,h:.05};
  const segment={page:2,x:.507,y:.2,w:.468,h:.4};
  const r=evidenceOverlap(region,segment);
  assert.ok(Math.abs(r.left-(.6-.507)/.468*100)<1e-9);
  assert.ok(Math.abs(r.top-15)<1e-9);
  assert.equal(evidenceOverlap(region,{...segment,page:1}),null);
  const partial=evidenceOverlap(region,{page:2,x:.65,y:.25,w:.1,h:.1});
  assert.ok(Math.abs(partial.left)<1e-9);
  assert.ok(Math.abs(partial.top-10)<1e-9);
  assert.ok(Math.abs(partial.width-50)<1e-9);
  assert.ok(Math.abs(partial.height-50)<1e-9);
});

test('드래그 방향에 관계없이 수평 밑줄을 PDF 원본 좌표로 만든다',()=>{
  const segment={page:2,x:.507,y:.2,w:.468,h:.4};
  const line=underlineFromDrag(segment,{x:.1,y:.3},{x:.6,y:.31});
  assert.equal(line.page,2);assert.ok(Math.abs(line.x-.5538)<1e-9);
  assert.ok(Math.abs(line.y-.322)<1e-9);assert.ok(Math.abs(line.w-.234)<1e-9);
  assert.equal(underlineFromDrag(segment,{x:.1,y:.3},{x:.105,y:.3}),null);
  assert.deepEqual(underlineFromDrag(segment,{x:.6,y:.31},{x:.1,y:.3}),line);
});

test('크롭을 수정해도 저장된 밑줄의 화면 위치가 유지된다',()=>{
  const line={page:2,x:.6,y:.32,w:.2},segment={page:2,x:.507,y:.2,w:.468,h:.4};
  const overlap=underlineOverlap(line,segment);
  assert.ok(Math.abs(overlap.left-(.6-.507)/.468*100)<1e-9);
  assert.ok(Math.abs(overlap.top-30)<1e-9);
  assert.equal(underlineOverlap(line,{...segment,page:3}),null);
  assert.equal(underlineOverlap(line,{...segment,y:.4}),null);
  assert.ok(Math.abs(underlineOverlap(line,{page:2,x:.7,y:.25,w:.1,h:.2}).width-100)<1e-9);
});
