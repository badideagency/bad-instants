/*
 * localFiles.js — indirilen sesi diske yazar (Node'un fs modülüyle). Siteye istek ATMAZ.
 * Panel yalnızca Windows'ta çalıştığı için Windows yolları kullanılır.
 *
 *  - Dosya adı ses adından türetilir: Windows'ta geçersiz karakterler temizlenir, Türkçe korunur.
 *  - Dosya zaten varsa tekrar indirilmez. Aynı adda FARKLI bir ses gelirse "Ad (2).mp3" olur;
 *    hangi dosyanın hangi sese ait olduğu klasördeki ".myinstants.json" kayıt dosyasında tutulur.
 *  - Yazma önce geçici dosyaya yapılır, bitince asıl adına taşınır (yarım dosya kalmaz).
 */
(function (root, factory) {
  var api = factory(root);
  if (root) root.LocalFiles = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const INDEX_NAME = '.myinstants.json';
  const MAX_NAME_CHARS = 100;
  const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'webm'];
  // Windows'ta dosya adı olarak kullanılamayan adlar (uzantılı hâlleri de: CON.mp3 geçersiz)
  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

  let fsOverride = null; // testler için

  function fileError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function fsp() {
    if (fsOverride) return fsOverride;
    const req = typeof root.require === 'function' ? root.require : typeof require === 'function' ? require : null;
    if (!req) throw fileError('nonode', 'Node.js kullanılamıyor');
    return req('fs').promises;
  }

  function classifyFsError(e, where) {
    const code = (e && e.code) || '';
    const extra = { code, where };
    if (code === 'EACCES' || code === 'EPERM') return fileError('noperm', e.message, extra);
    if (code === 'ENOSPC') return fileError('nospace', e.message, extra);
    return fileError('write', (e && e.message) || 'Yazma hatası', extra);
  }

  /* ------------------------------------------------------------------ adlar ve yollar */

  function safeFileName(name) {
    let s = String(name || '')
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '');
    const chars = Array.from(s); // emoji gibi çift parçalı karakterleri bölmeden kısalt
    if (chars.length > MAX_NAME_CHARS) s = chars.slice(0, MAX_NAME_CHARS).join('').replace(/[\s.]+$/g, '');
    if (!s) s = 'ses';
    if (RESERVED.test(s.split('.')[0])) s += '_';
    return s;
  }

  function extFromUrl(url) {
    let p = '';
    try {
      p = new URL(url).pathname;
    } catch (e) {
      p = String(url || '');
    }
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    const ext = m ? m[1].toLowerCase() : '';
    return '.' + (AUDIO_EXT.includes(ext) ? ext : 'mp3');
  }

  function joinPath(dir, name) {
    return String(dir).replace(/[\\/]+$/, '') + '\\' + name;
  }

  /* ------------------------------------------------------------------ dosya işlemleri */

  async function fileExists(full) {
    try {
      const st = await fsp().stat(full);
      return st.isFile() && st.size > 0;
    } catch (e) {
      return false;
    }
  }

  async function ensureDir(dir) {
    try {
      await fsp().mkdir(dir, { recursive: true });
    } catch (e) {
      throw classifyFsError(e, dir);
    }
  }

  async function writeFileAtomic(full, data) {
    const fs = fsp();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const tmp = full + '.part-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, full);
    } catch (e) {
      try {
        await fs.unlink(tmp);
      } catch (e2) {
        /* geçici dosya zaten yok */
      }
      throw classifyFsError(e, full);
    }
  }

  async function readFile(full) {
    const buf = await fsp().readFile(full);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  /* ------------------------------------------------------------------ kayıt dosyası (.myinstants.json) */

  async function readIndex(folder) {
    try {
      const text = new TextDecoder('utf-8').decode(await readFile(joinPath(folder, INDEX_NAME)));
      const data = JSON.parse(text);
      if (data && typeof data.files === 'object') return data;
    } catch (e) {
      /* yok ya da bozuk → boş başla */
    }
    return { version: 1, files: {} };
  }

  async function remember(folder, index, name, url) {
    index.files[name.toLowerCase()] = { name, url };
    try {
      await writeFileAtomic(joinPath(folder, INDEX_NAME), new TextEncoder().encode(JSON.stringify(index, null, 2)));
    } catch (e) {
      console.warn('[MyInstants] Kayıt dosyası yazılamadı:', e);
    }
  }

  // Sesin kaydedileceği dosyayı seçer → { name, path, exists, index }
  async function chooseTarget(folder, soundName, url) {
    const base = safeFileName(soundName);
    const ext = extFromUrl(url);
    const index = await readIndex(folder);
    for (let n = 1; n <= 99; n++) {
      const name = n === 1 ? base + ext : `${base} (${n})${ext}`;
      const full = joinPath(folder, name);
      const rec = index.files[name.toLowerCase()];
      if (rec && rec.url !== url) continue; // aynı adda farklı bir ses
      const exists = await fileExists(full);
      if (!rec && exists && n > 1) continue; // kaydı olmayan "Ad (2).mp3": dokunma
      // rec.url === url → bu sesin dosyası; kaydı yok ve n = 1 → dosya varsa aynı ses sayılır
      return { name, path: full, exists, index };
    }
    throw fileError('toomany', 'Bu adla çok fazla dosya var');
  }

  return {
    INDEX_NAME,
    safeFileName,
    extFromUrl,
    joinPath,
    fileExists,
    ensureDir,
    writeFileAtomic,
    readFile,
    readIndex,
    remember,
    chooseTarget,
    // yalnızca testler için
    _setFs(fs) {
      fsOverride = fs;
    },
  };
});
