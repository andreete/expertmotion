// Minimal media server for the slice: /media/<grant>/<assetId>/<variant> with HTTP Range (Chrome seeks video with Range).
// Same URL shape and grant rule as API_SPECIFICATION §2.2 / SEC-010; loopback only.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
export function startMediaServer(files, port = 4113) {
  const grant = crypto.randomBytes(32).toString('base64url');
  const types = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/media\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]+)\/(playable|proxy)$/);
    const file = m && m[1] === grant ? files[m[2]] : undefined;
    if (!file) { res.writeHead(404); return res.end(); }
    const size = fs.statSync(file).size; const type = types[path.extname(file)] ?? 'application/octet-stream';
    const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (r) {
      const start = r[1] ? Number(r[1]) : 0, end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Access-Control-Allow-Origin': '*' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: (id) => `http://127.0.0.1:${port}/media/${grant}/${id}/playable` })));
}
