/* Reconstructs the shared octree as a route-local virtual file. */
const CHUNK_SIZE = 90 * 1024 * 1024;
const OCTREE_SIZE = 477506366;
const OCTREE_URL = new URL('assets/cloud/octree.bin', self.registration.scope);
const SOURCE_BASE = new URL('/assets/cloud/terrain-case-01/octree.bin', self.registration.scope).href;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function sourceUrl(index){return `${SOURCE_BASE}.${String(index).padStart(3,'0')}`}
function parseRange(value){
  if(!value)return {start:0,end:OCTREE_SIZE-1,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if(!match||(!match[1]&&!match[2]))return null;
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isFinite(suffix)||suffix<=0)return null;start=Math.max(0,OCTREE_SIZE-suffix);end=OCTREE_SIZE-1}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):OCTREE_SIZE-1}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=OCTREE_SIZE||end<start)return null;
  return {start,end:Math.min(end,OCTREE_SIZE-1),partial:true};
}
async function slice(index,from,to){
  const response=await fetch(sourceUrl(index),{headers:{Range:`bytes=${from}-${to}`},cache:'force-cache'});
  if(!response.ok)throw new Error(`Chunk ${index}: HTTP ${response.status}`);
  const bytes=await response.arrayBuffer();
  return response.status===206?new Uint8Array(bytes):new Uint8Array(bytes.slice(from,to+1));
}
async function read(start,end){
  const parts=[];let length=0;
  for(let index=Math.floor(start/CHUNK_SIZE);index<=Math.floor(end/CHUNK_SIZE);index+=1){
    const base=index*CHUNK_SIZE;const part=await slice(index,Math.max(start,base)-base,Math.min(end,base+CHUNK_SIZE-1)-base);
    parts.push(part);length+=part.byteLength;
  }
  const output=new Uint8Array(length);let offset=0;for(const part of parts){output.set(part,offset);offset+=part.byteLength}return output;
}
self.addEventListener('fetch',event=>{
  if(new URL(event.request.url).href!==OCTREE_URL.href)return;
  event.respondWith((async()=>{
    const range=parseRange(event.request.headers.get('range'));
    if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${OCTREE_SIZE}`}});
    const body=await read(range.start,range.end);
    const headers={'Accept-Ranges':'bytes','Cache-Control':'public,max-age=31536000,immutable','Content-Length':String(body.byteLength),'Content-Type':'application/octet-stream'};
    if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${OCTREE_SIZE}`;
    return new Response(body,{status:range.partial?206:200,headers});
  })());
});
