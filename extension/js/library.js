/*
 * library.js — Favoriler ve Son kullanılanlar kaydı + favorilerin yerel ses arşivi.
 *
 * Kayıt localStorage'da DEĞİL: CEP'in depolaması %TEMP%\cep_cache altında ve Premiere sürümüne bağlı;
 * Premiere güncellemesi ya da Temp temizliği silebilir. Bu yüzden Node ile:
 *   %APPDATA%\BadIdea\MyInstants\library.json      ← kayıt (geçici dosya + yeniden adlandırma; yarım yazma olmaz)
 *   %APPDATA%\BadIdea\MyInstants\library\*.mp3      ← favorilerin yerel kopyası (site sesi silse de çalışır)
 * Dosya bozuksa panel çökmez: bozuk dosya library.json.bak olarak kenara alınır, boş listeyle devam edilir.
 * Son kullanılanlar için ses kopyası tutulmaz, yalnızca kayıt.
 */
(function (root, factory) {
  var api = factory(root);
  if (root) root.Library = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const RECENT_MAX = 50;
  const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'webm'];
  const deps = { fs: null, appData: null };

  let data = empty();
  let loaded = false;
  let writing = Promise.resolve(); // yazmalar sırayla

  function empty() {
    return { version: 1, favorites: [], recent: [] };
  }

  function configure(d) {
    Object.assign(deps, d);
  }

  function libError(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    if (extra) Object.assign(e, extra);
    return e;
  }

  function nodeRequire(name) {
    const req = typeof root.require === 'function' ? root.require : typeof require === 'function' ? require : null;
    if (!req) throw libError('nonode', 'Node.js kullanılamıyor');
    return req(name);
  }

  function fsp() {
    return deps.fs || nodeRequire('fs').promises;
  }

  // Aynı ayırıcıyla birleştirir: Windows yolu (\) ise \, değilse /
  function pj(base, ...parts) {
    const sep = /\\/.test(base) ? '\\' : '/';
    let out = String(base).replace(/[\\/]+$/, '');
    for (const p of parts) {
      const clean = String(p).replace(/[\\/]+/g, sep).replace(/^[\\/]+|[\\/]+$/g, '');
      if (clean) out += sep + clean;
    }
    return out;
  }

  function appData() {
    if (deps.appData) return deps.appData;
    const proc = root.process || (typeof process !== 'undefined' ? process : null);
    if (proc && proc.env && proc.env.APPDATA) return proc.env.APPDATA;
    return pj(nodeRequire('os').homedir(), 'AppData', 'Roaming');
  }

  function paths() {
    const dir = pj(appData(), 'BadIdea', 'MyInstants');
    return { dir, file: pj(dir, 'library.json'), audioDir: pj(dir, 'library') };
  }

  /* ------------------------------------------------------------------ dosya işlemleri */

  async function exists(p) {
    try {
      await fsp().stat(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function writeAtomic(full, bytes) {
    const fs = fsp();
    await fs.mkdir(full.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    const tmp = full + '.tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, full);
    } catch (e) {
      try {
        await fs.unlink(tmp);
      } catch (e2) {
        /* yok */
      }
      throw libError('write', (e && e.message) || 'Yazılamadı', { code: e && e.code, where: full });
    }
  }

  const decode = (b) => new TextDecoder('utf-8').decode(b);
  const encode = (t) => new TextEncoder().encode(t);

  /* ------------------------------------------------------------------ kayıt */

  function validEntry(e) {
    return e && typeof e === 'object' && typeof e.id === 'string' && e.id && typeof e.mp3 === 'string' && e.mp3;
  }

  function valid(d) {
    return (
      d &&
      typeof d === 'object' &&
      !Array.isArray(d) &&
      Array.isArray(d.favorites) &&
      Array.isArray(d.recent) &&
      d.favorites.every(validEntry) &&
      d.recent.every(validEntry)
    );
  }

  // → { corrupt, backup, favorites, recent }
  async function load() {
    const { file } = paths();
    let raw = null;
    let text = null;
    try {
      raw = await fsp().readFile(file);
      text = decode(raw);
    } catch (e) {
      if (e && e.kind === 'nonode') throw e;
      data = empty(); // dosya yok: ilk açılış
      loaded = true;
      return { corrupt: false, backup: null, favorites: 0, recent: 0 };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }
    if (!valid(parsed)) {
      // Bozuk: kenara al, boş listeyle devam et
      let backup = file + '.bak';
      if (await exists(backup)) backup = file + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
      try {
        await fsp().rename(file, backup);
      } catch (e) {
        // Taşınamadıysa (ör. dosya kilitli) kopyası alınır: ilk kayıt bozuk dosyanın üstüne yazsa da içerik kaybolmaz
        try {
          await writeAtomic(backup, raw instanceof Uint8Array ? raw : new Uint8Array(raw));
        } catch (e2) {
          backup = null;
        }
      }
      data = empty();
      loaded = true;
      return { corrupt: true, backup, favorites: 0, recent: 0 };
    }
    data = { version: 1, favorites: parsed.favorites, recent: parsed.recent.slice(0, RECENT_MAX) };
    loaded = true;
    return { corrupt: false, backup: null, favorites: data.favorites.length, recent: data.recent.length };
  }

  function save() {
    const snapshot = JSON.stringify(data, null, 2);
    const job = writing.then(() => writeAtomic(paths().file, encode(snapshot)));
    writing = job.catch(() => {}); // bir hata sonraki yazmaları durdurmasın
    return job;
  }

  function ensureLoaded() {
    if (!loaded) throw libError('notloaded', 'Kitaplık yüklenmedi');
  }

  const pick = (item) => ({ id: String(item.id), name: String(item.name || ''), mp3: String(item.mp3), page: String(item.page || '') });

  function isFavorite(id) {
    return loaded && data.favorites.some((f) => f.id === id);
  }

  function favorites() {
    return data.favorites.map((f) => Object.assign({}, f));
  }

  function recent() {
    return data.recent.map((r) => Object.assign({}, r));
  }

  // Kaydedilemezse bellekteki değişiklik de geri alınır (ekrandaki ile diskteki aynı kalsın)
  async function addFavorite(item) {
    ensureLoaded();
    if (isFavorite(item.id)) return;
    const entry = Object.assign(pick(item), { addedAt: new Date().toISOString() });
    data.favorites.unshift(entry); // son eklenen üstte
    try {
      await save();
    } catch (e) {
      data.favorites = data.favorites.filter((x) => x !== entry);
      throw e;
    }
  }

  async function removeFavorite(id) {
    ensureLoaded();
    const index = data.favorites.findIndex((x) => x.id === id);
    if (index < 0) return;
    const f = data.favorites[index];
    data.favorites = data.favorites.filter((x) => x.id !== id);
    try {
      await save();
    } catch (e) {
      if (!isFavorite(id)) data.favorites.splice(Math.min(index, data.favorites.length), 0, f);
      throw e;
    }
    if (f.file) {
      try {
        await fsp().unlink(pj(paths().audioDir, f.file));
      } catch (e) {
        /* zaten yok */
      }
    }
  }

  async function addRecent(item) {
    ensureLoaded();
    data.recent = [Object.assign(pick(item), { usedAt: new Date().toISOString() })]
      .concat(data.recent.filter((r) => r.id !== String(item.id)))
      .slice(0, RECENT_MAX);
    await save();
  }

  /* ------------------------------------------------------------------ yerel ses arşivi (yalnız favoriler) */

  // FNV-1a (32 bit): aynı adlı farklı sesler çakışmasın
  function hash8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function archiveName(id, mp3) {
    const safe =
      String(id)
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 80) || 'ses';
    let ext = 'mp3';
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(mp3).pathname);
      if (m && AUDIO_EXT.includes(m[1].toLowerCase())) ext = m[1].toLowerCase();
    } catch (e) {
      /* varsayılan */
    }
    return `${safe}-${hash8(mp3)}.${ext}`;
  }

  function localPath(id) {
    const f = loaded && data.favorites.find((x) => x.id === id);
    return f && f.file ? pj(paths().audioDir, f.file) : null;
  }

  async function readLocal(id) {
    const p = localPath(id);
    if (!p) return null;
    try {
      const buf = await fsp().readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
      return null; // kopya silinmiş: siteden denenir
    }
  }

  // Favorinin sesini yerel arşive yazar (hâlâ favoriyse)
  async function storeLocal(id, bytes) {
    ensureLoaded();
    const f = data.favorites.find((x) => x.id === id);
    if (!f) return false; // bu arada yıldızı kaldırılmış
    const name = archiveName(f.id, f.mp3);
    await writeAtomic(pj(paths().audioDir, name), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const cur = data.favorites.find((x) => x.id === id); // yazarken kaldırılmış / yeniden eklenmiş olabilir
    if (!cur) {
      try {
        await fsp().unlink(pj(paths().audioDir, name));
      } catch (e) {
        /* yok */
      }
      return false;
    }
    cur.file = name;
    await save();
    return true;
  }

  // Yerel kopyası olmayan (ya da kopyası silinmiş) favoriler
  async function missingLocal() {
    const out = [];
    for (const f of data.favorites) {
      if (!f.file || !(await exists(pj(paths().audioDir, f.file)))) out.push(Object.assign({}, f));
    }
    return out;
  }

  return {
    RECENT_MAX,
    configure,
    paths,
    load,
    save,
    isLoaded: () => loaded,
    isFavorite,
    favorites,
    recent,
    addFavorite,
    removeFavorite,
    addRecent,
    archiveName,
    localPath,
    readLocal,
    storeLocal,
    missingLocal,
    _reset() {
      data = empty();
      loaded = false;
      writing = Promise.resolve();
    },
  };
});
