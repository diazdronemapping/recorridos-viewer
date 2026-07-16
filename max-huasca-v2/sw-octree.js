/*
 * Max · Huasca V2
 * Reconstruye el octree.bin virtual desde bloques menores a 100 MiB.
 * El scope es deliberadamente local a /max-huasca-v2/ para no intervenir
 * los recorridos 360 ni otros visores publicados en este dominio.
 */
const CHUNK_SIZE = 90 * 1024 * 1024;
const OCTREE_SIZE = 477506366;
const OCTREE_URL = new URL(
  'assets/cloud/max-huasca-v2/octree.bin',
  self.registration.scope
);

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function chunkUrl(index) {
  return `${OCTREE_URL.href}.${String(index).padStart(3, '0')}`;
}

function parseRange(value, total) {
  if (!value) return { start: 0, end: total - 1, partial: false };

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= total ||
    end < start
  ) return null;

  return { start, end: Math.min(end, total - 1), partial: true };
}

async function fetchChunkSlice(index, from, to) {
  const response = await fetch(chunkUrl(index), {
    headers: { Range: `bytes=${from}-${to}` },
    cache: 'force-cache'
  });

  if (!response.ok) {
    throw new Error(`No fue posible leer el bloque ${index}: HTTP ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  if (response.status === 206) return new Uint8Array(bytes);

  // Respaldo para hosts que ignoran Range y devuelven el bloque completo.
  return new Uint8Array(bytes.slice(from, to + 1));
}

async function readOctreeRange(start, end) {
  const first = Math.floor(start / CHUNK_SIZE);
  const last = Math.floor(end / CHUNK_SIZE);
  const parts = [];
  let totalLength = 0;

  for (let index = first; index <= last; index += 1) {
    const base = index * CHUNK_SIZE;
    const from = Math.max(start, base) - base;
    const to = Math.min(end, base + CHUNK_SIZE - 1) - base;
    const part = await fetchChunkSlice(index, from, to);
    parts.push(part);
    totalLength += part.byteLength;
  }

  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.href !== OCTREE_URL.href) return;

  event.respondWith((async () => {
    const range = parseRange(event.request.headers.get('range'), OCTREE_SIZE);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${OCTREE_SIZE}` }
      });
    }

    const body = await readOctreeRange(range.start, range.end);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(body.byteLength),
      'Content-Type': 'application/octet-stream'
    };

    if (range.partial) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${OCTREE_SIZE}`;
    }

    return new Response(body, {
      status: range.partial ? 206 : 200,
      headers
    });
  })());
});
