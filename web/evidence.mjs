// All coordinates use normalized, top-left PDF page space.
const clamp = value => Math.max(0,Math.min(1,Number(value)||0));

export function regionFromDrag(segment,start,end) {
  const x1=clamp(start.x),y1=clamp(start.y),x2=clamp(end.x),y2=clamp(end.y);
  const x=segment.x+Math.min(x1,x2)*segment.w;
  const y=segment.y+Math.min(y1,y2)*segment.h;
  const w=Math.abs(x2-x1)*segment.w,h=Math.abs(y2-y1)*segment.h;
  if(w<segment.w*.012||h<segment.h*.008)return null;
  return {page:segment.page,x,y,w,h};
}

export function evidenceOverlap(region,segment) {
  if(!region||region.page!==segment.page||segment.w<=0||segment.h<=0)return null;
  const x=Math.max(region.x,segment.x),y=Math.max(region.y,segment.y);
  const right=Math.min(region.x+region.w,segment.x+segment.w);
  const bottom=Math.min(region.y+region.h,segment.y+segment.h);
  if(right<=x||bottom<=y)return null;
  return {left:(x-segment.x)/segment.w*100,top:(y-segment.y)/segment.h*100,
    width:(right-x)/segment.w*100,height:(bottom-y)/segment.h*100};
}

export function segmentDisplayWidths(segments,pages=[]) {
  const widths=segments.map(s=>(pages[s.page-1]?.width||595)*s.w);
  const widest=Math.max(1,...widths);
  return widths.map(width=>width/widest*100);
}
