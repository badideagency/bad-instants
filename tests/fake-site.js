// Testler için sahte "www.myinstants.com" (HTTPS). Cloudflare benzeri davranır:
//  mode 'open'      → sayfalar normal açılır
//  mode 'challenge' → geçerli cf_clearance çerezi yoksa 403 "Just a moment..." doğrulama sayfası
//                     (sayfadaki tuşa basınca çerez verilir; X-Frame-Options: SAMEORIGIN)
//  mode 'block'     → her istek 403 "Sorry, you have been blocked"
//  mode 'slow'      → cevaplar 3 sn gecikir
// Tarayıcı bu siteye --host-resolver-rules ile yönlendirilir; panel gerçek adresle konuşur.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

function makeCert(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(cert)) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', key, '-out', cert,
      '-subj', '/CN=www.myinstants.com', '-addext', 'subjectAltName=DNS:www.myinstants.com',
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function silentWav(seconds = 0.4, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}

const CHALLENGE = (returnTo) => `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
<h1>www.myinstants.com</h1><p>Verify you are human by completing the action below.</p>
<form method="POST" action="/__cf_verify?return=${encodeURIComponent(returnTo)}">
  <button id="cf-verify" type="submit">Verify you are human</button>
</form>
<script>window._cf_chl_opt = { cType: 'managed' };</script>
</body></html>`;

// Liste sayfası: adların başına bölge etiketi eklenir ([TR] / [US] / [-]) ki bölge testi görünsün.
function listPage(url) {
  const m = /\/(tr|us)\/(?:\?|$)/.exec(url.pathname + (url.search ? url.search : ''));
  const label = m ? m[1].toUpperCase() : '-';
  let html = fixture('list-page.html')
    .replace(/class="instant-link link-secondary">\s*/g, `class="instant-link link-secondary">[${label}] `)
    // Cloudflare'in normal sayfalara eklediği betik: doğrulama sanılmamalı
    .replace('</body>', '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body>');
  if (url.searchParams.get('page') === '2') {
    html = html
      .replace(/\/media\/sounds\//g, '/media/sounds/p2-')
      .replace(/\/en\/instant\//g, '/en/instant/p2-')
      .replace(/\] /g, '] Sayfa2 ')
      .replace('Page 1 of 50', 'Page 2 of 2')
      .replace(/<div class="pagination">[\s\S]*?<\/div>/, '');
  }
  return html;
}

async function startFakeSite({ certDir }) {
  const state = { mode: 'open', cookieMode: 'persistent', tokens: new Set(), requests: [] };
  const wav = silentWav();

  const server = https.createServer(makeCert(certDir), (req, res) => {
    const url = new URL(req.url, 'https://www.myinstants.com');
    const cookie = req.headers.cookie || '';
    const token = (/(?:^|;\s*)cf_clearance=([^;]+)/.exec(cookie) || [])[1];
    state.requests.push({
      method: req.method,
      path: url.pathname + url.search,
      cookie,
      hasClearance: !!(token && state.tokens.has(token)),
      secFetchMode: req.headers['sec-fetch-mode'] || '',
      secFetchDest: req.headers['sec-fetch-dest'] || '',
    });

    const send = (status, type, body, headers) => {
      res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, headers));
      res.end(body);
    };

    if (req.method === 'POST' && url.pathname === '/__cf_verify') {
      const t = crypto.randomBytes(8).toString('hex');
      state.tokens.add(t);
      const life = state.cookieMode === 'persistent' ? '; Max-Age=31536000' : '';
      res.writeHead(302, {
        'Set-Cookie': `cf_clearance=${t}; Path=/; Secure; HttpOnly; SameSite=None${life}`,
        Location: url.searchParams.get('return') || '/',
      });
      return res.end();
    }

    if (state.mode === 'block') {
      return send(403, 'text/html; charset=utf-8', fixture('cloudflare-block.html'), {
        Server: 'cloudflare',
        'X-Frame-Options': 'SAMEORIGIN',
      });
    }
    if (state.mode === 'challenge' && !(token && state.tokens.has(token))) {
      return send(403, 'text/html; charset=utf-8', CHALLENGE(url.pathname + url.search), {
        Server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'X-Frame-Options': 'SAMEORIGIN',
      });
    }

    const respond = () => {
      if (url.pathname.startsWith('/media/sounds/')) return send(200, 'audio/wav', wav);
      if (url.pathname === '/en/categories/') return send(200, 'text/html; charset=utf-8', fixture('categories.html'));
      if (
        url.pathname === '/' ||
        /^\/en\/(trending|best_of_all_time)\/(tr|us)\/$/.test(url.pathname) ||
        url.pathname === '/en/recent/' ||
        /^\/en\/categories\/[^/]+\/(tr|us)\/$/.test(url.pathname) ||
        url.pathname === '/en/search/'
      ) {
        return send(200, 'text/html; charset=utf-8', listPage(url));
      }
      return send(404, 'text/html', '<title>Page not found</title>');
    };
    if (state.mode === 'slow') setTimeout(respond, 3000);
    else respond();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state,
    last: (re) => [...state.requests].reverse().find((q) => re.test(q.path)),
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

module.exports = { startFakeSite };
