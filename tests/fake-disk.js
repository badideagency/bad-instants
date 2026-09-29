// Testler için bellekte Windows yollu sahte disk. Panelin require('fs').promises çağrıları
// Playwright köprüsüyle (exposeFunction) buraya gelir; Windows gibi büyük/küçük harf ayırmaz.
//   const disk = createDisk();
//   await attachDisk(page, disk, { appData: 'C:\\Users\\Test\\AppData\\Roaming' });
'use strict';

function createDisk() {
  const map = new Map(); // küçük harfli yol → { name, data: Buffer }
  const key = (p) => String(p).toLowerCase();
  return {
    ctl: { failWrite: null, readDelay: null }, // readDelay: { path, ms } → o dosyanın okunması gecikir
    key,
    has: (p) => map.has(key(p)),
    get: (p) => (map.get(key(p)) || {}).data,
    text: (p) => (map.has(key(p)) ? map.get(key(p)).data.toString('utf8') : null),
    set: (p, data) => map.set(key(p), { name: p, data: Buffer.from(data) }),
    delete: (p) => map.delete(key(p)),
    files: () => [...map.values()].map((f) => f.name).sort(),
    // exposeFunction ile panele açılan işlemler
    op(op, p, b64, p2) {
      const err = (code) => ({ error: code });
      switch (op) {
        case 'stat':
          return map.has(key(p)) ? { size: map.get(key(p)).data.length } : err('ENOENT');
        case 'mkdir':
          return {};
        case 'writeFile':
          if (this.ctl.failWrite) return err(this.ctl.failWrite);
          map.set(key(p), { name: p, data: Buffer.from(b64, 'base64') });
          return {};
        case 'rename': {
          const f = map.get(key(p));
          if (!f) return err('ENOENT');
          map.delete(key(p));
          map.set(key(p2), { name: p2, data: f.data });
          return {};
        }
        case 'unlink':
          if (!map.has(key(p))) return err('ENOENT');
          map.delete(key(p));
          return {};
        case 'readFile': {
          const read = () => (map.has(key(p)) ? { b64: map.get(key(p)).data.toString('base64') } : err('ENOENT'));
          const d = this.ctl.readDelay;
          if (d && key(d.path) === key(p)) return new Promise((r) => setTimeout(() => r(read()), d.ms));
          return read();
        }
      }
      return err('EINVAL');
    },
  };
}

// Panelde window.require('fs') → sahte disk; appData verilirse window.process.env.APPDATA
async function attachDisk(page, disk, opts = {}) {
  await page.exposeFunction('__miFs', (op, p, b64, p2) => disk.op(op, p, b64, p2));
  await page.addInitScript((appData) => {
    const toB64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    };
    const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const call = async (...args) => {
      const r = await window.__miFs(...args);
      if (r && r.error) throw Object.assign(new Error(r.error), { code: r.error });
      return r;
    };
    const promises = {
      stat: async (p) => {
        const r = await call('stat', p);
        return { isFile: () => true, size: r.size };
      },
      mkdir: (p) => call('mkdir', p),
      writeFile: (p, bytes) => call('writeFile', p, toB64(bytes)),
      rename: (a, b) => call('rename', a, null, b),
      unlink: (p) => call('unlink', p),
      readFile: async (p) => fromB64((await call('readFile', p)).b64), // Buffer benzeri: buffer / byteOffset / byteLength
    };
    window.require = (name) => (name === 'fs' ? { promises } : undefined);
    if (appData) window.process = { env: { APPDATA: appData } };
  }, opts.appData || '');
}

module.exports = { createDisk, attachDisk };
