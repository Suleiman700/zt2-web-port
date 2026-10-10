// Static file server for playing and developing locally. Usage: node tools/serve.mjs [port]
// Serves the project, plus the original game archives from <project root>/orgfiles/ under
// /orgfiles/ (read-only, with Range support, and a JSON listing at /orgfiles/) for
// GAME_FILES_MODE = 'local' in src/config.js.
// The game files are only ever served to this computer: the server listens on 127.0.0.1 and
// rejects /orgfiles/ requests from any non-loopback address. Production deployments host the
// static files elsewhere, without orgfiles/, with GAME_FILES_MODE = 'production'.
import { createServer } from 'node:http';
import { readFile, open, readdir } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8080);
const gameDir = join(root, 'orgfiles');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/' && url.searchParams.has('progress')) urlPath = '/progress.html';
  if (urlPath.startsWith('/orgfiles/')) { await serveGame(req, res, urlPath.slice(10)); return; }
  const file = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`ZT2 Web running at http://localhost:${port}`));

async function serveGame(req, res, name) {
  const remote = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) { res.writeHead(403).end(); return; }
  if (name === '') {
    let names = [];
    try { names = (await readdir(gameDir)).filter((n) => n.toLowerCase().endsWith('.z2f')); } catch { /* no orgfiles folder */ }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(names));
    return;
  }
  if (!/^[\w.-]+\.z2f$/i.test(name)) { res.writeHead(403).end(); return; }
  let fh;
  try {
    fh = await open(join(gameDir, name), 'r');
    const { size } = await fh.stat();
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (req.method === 'HEAD' || !m) {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' }).end();
      return;
    }
    const start = Number(m[1]), end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    const buf = Buffer.alloc(end - start + 1);
    await fh.read(buf, 0, buf.length, start);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end();
  } finally {
    await fh?.close();
  }
}
