/*
 * host.jsx — MyInstants panelinin Premiere tarafı (ExtendScript).
 * Panel bu fonksiyonları evalScript ile çağırır; hepsi JSON metni döndürür.
 *
 * ExtendScript eski bir JavaScript'tir (ES3): let/const, ok fonksiyon, JSON, Array.indexOf,
 * String.trim, Date.now YOK. Bu dosyada yalnızca ES3 kullanılır (testler bunu denetler).
 *
 * Kurgu güvenliği:
 *  - Timeline'a yalnızca overwriteClip ile konur, insert ASLA kullanılmaz.
 *  - Yalnızca [playhead, playhead + süre] aralığı tamamen boş olan track'e konur.
 *  - Koymadan önce ve sonra bütün ses track'lerinin klip listesi karşılaştırılır:
 *      * yeni klip playhead'de değilse → kendi klibimizi silip (ripple yok) diğer zaman birimiyle bir kez daha denenir;
 *      * mevcut bir klip değişmişse → durulur ve kullanıcıya Ctrl+Z söylenir.
 */

var MI_TICKS_PER_SECOND = 254016000000;
var MI_BIN_NAME = 'MyInstants';

/* ------------------------------------------------------------------ yardımcılar */

function mi_json(v) {
    var i, parts, k;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') {
        return '"' + v.replace(/[\\"\x00-\x1f]/g, function (c) {
            if (c === '\\') return '\\\\';
            if (c === '"') return '\\"';
            if (c === '\n') return '\\n';
            if (c === '\r') return '\\r';
            if (c === '\t') return '\\t';
            var h = c.charCodeAt(0).toString(16);
            return '\\u' + '0000'.substr(h.length) + h;
        }) + '"';
    }
    if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i++) parts.push(mi_json(v[i]));
        return '[' + parts.join(',') + ']';
    }
    parts = [];
    for (k in v) {
        if (v.hasOwnProperty(k)) parts.push(mi_json(String(k)) + ':' + mi_json(v[k]));
    }
    return '{' + parts.join(',') + '}';
}

function mi_ticks(t) {
    if (!t) return NaN;
    return parseFloat(t.ticks);
}

function mi_normPath(p) {
    return String(p || '').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').toLowerCase();
}

function mi_isBin(item) {
    var binType = (typeof ProjectItemType !== 'undefined' && ProjectItemType.BIN !== undefined) ? ProjectItemType.BIN : 2;
    return item && (item.type === binType || item.type === 'BIN');
}

function mi_version() {
    try {
        return String(app.version);
    } catch (e) {
        return '';
    }
}

/* ------------------------------------------------------------------ bağlantı testi */

// Panel ile Premiere arasındaki bağlantıyı test eder. "ok|<Premiere sürümü>" döner.
function mi_ping() {
    try {
        return "ok|" + app.version;
    } catch (e) {
        return "err|" + e;
    }
}

/* ------------------------------------------------------------------ indirme klasörü */

// Açık projenin yanındaki MyInstants klasörü; proje kaydedilmemişse Belgeler\MyInstants.
function mi_context() {
    try {
        var project = app.project;
        if (!project) return mi_json({ ok: false, code: 'noproject' });
        var seq = project.activeSequence;
        if (!seq) return mi_json({ ok: false, code: 'nosequence' });

        var projPath = String(project.path || '').replace(/^\\\\\?\\/, '');
        var folder = '';
        var saved = false;
        if (projPath && /\.prproj$/i.test(projPath)) {
            var f = new File(projPath);
            if (f.exists) {
                folder = f.parent.fsName + '\\' + MI_BIN_NAME;
                saved = true;
            }
        }
        if (!folder) folder = Folder.myDocuments.fsName + '\\' + MI_BIN_NAME;
        return mi_json({ ok: true, folder: folder, projectSaved: saved, sequence: String(seq.name), version: mi_version() });
    } catch (e) {
        return mi_json({ ok: false, code: 'exception', message: String(e) });
    }
}

/* ------------------------------------------------------------------ proje öğesi (import) */

function mi_findBin(parent, name) {
    var kids = parent.children;
    for (var i = 0; i < kids.numItems; i++) {
        if (mi_isBin(kids[i]) && kids[i].name === name) return kids[i];
    }
    return null;
}

function mi_walkFind(parent, wanted, depth) {
    if (depth > 30) return null;
    var kids = parent.children;
    if (!kids) return null;
    for (var i = 0; i < kids.numItems; i++) {
        var it = kids[i];
        if (mi_isBin(it)) {
            var found = mi_walkFind(it, wanted, depth + 1);
            if (found) return found;
        } else {
            try {
                if (mi_normPath(it.getMediaPath()) === wanted) return it;
            } catch (e) { /* medyası olmayan öğe */ }
        }
    }
    return null;
}

// Aynı dosya projede zaten varsa onu döndürür (proje genelinde, yol eşleşmesi).
function mi_findItem(mediaPath) {
    var root = app.project.rootItem;
    try {
        var list = root.findItemsMatchingMediaPath(mediaPath, 1);
        if (list && list.length) {
            for (var i = 0; i < list.length; i++) {
                if (list[i] && !mi_isBin(list[i])) return list[i];
            }
        }
    } catch (e) { /* aşağıda elle ara */ }
    return mi_walkFind(root, mi_normPath(mediaPath), 0);
}

/* ------------------------------------------------------------------ track'ler */

// QE sequence nesnesi yalnızca tek bir çağrı boyunca saklanır (kullanıcı sequence değiştirebilir).
var mi_qeSeq = null;

function mi_qe() {
    if (mi_qeSeq) return mi_qeSeq;
    try {
        app.enableQE();
        mi_qeSeq = qe.project.getActiveSequence();
    } catch (e) {
        mi_qeSeq = null;
    }
    return mi_qeSeq;
}

// true / false; kilit bilgisi okunamıyorsa null
function mi_isLocked(track, index) {
    try {
        if (typeof track.isLocked === 'function') return track.isLocked() ? true : false;
    } catch (e) { /* QE ile dene */ }
    try {
        var q = mi_qe();
        if (q) {
            var qt = q.getAudioTrackAt(index);
            if (qt && typeof qt.isLocked === 'function') return qt.isLocked() ? true : false;
        }
    } catch (e2) { /* bilinmiyor */ }
    return null;
}

function mi_isFree(track, start, end) {
    var i, c, lists = [track.clips, track.transitions];
    for (var l = 0; l < lists.length; l++) {
        c = lists[l];
        if (!c) continue;
        for (i = 0; i < c.numItems; i++) {
            if (mi_ticks(c[i].start) < end && mi_ticks(c[i].end) > start) return false;
        }
    }
    return true;
}

// Bütün ses track'lerinin klip listesi: [[{s, e, n}, ...], ...]
function mi_snapshot(seq) {
    var shot = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var clips = seq.audioTracks[t].clips;
        var list = [];
        for (var i = 0; i < clips.numItems; i++) {
            list.push({ s: mi_ticks(clips[i].start), e: mi_ticks(clips[i].end), n: String(clips[i].name) });
        }
        shot.push(list);
    }
    return shot;
}

// Önce/sonra karşılaştırması → { changed: mevcut klip değişti mi, added: [{t, s, e, n}] }
function mi_diff(before, after) {
    var res = { changed: false, added: [] };
    var t, i, j, used;
    for (t = 0; t < after.length; t++) {
        var b = t < before.length ? before[t] : [];
        var a = after[t];
        used = [];
        for (i = 0; i < b.length; i++) {
            var ok = false;
            for (j = 0; j < a.length; j++) {
                if (!used[j] && a[j].s === b[i].s && a[j].e === b[i].e && a[j].n === b[i].n) {
                    used[j] = true;
                    ok = true;
                    break;
                }
            }
            if (!ok) res.changed = true;
        }
        for (j = 0; j < a.length; j++) {
            if (!used[j]) res.added.push({ t: t, s: a[j].s, e: a[j].e, n: a[j].n });
        }
    }
    if (after.length < before.length) res.changed = true;
    return res;
}

// Bizim eklediğimiz klipleri siler (ripple yok).
function mi_removeAdded(seq, added) {
    for (var k = 0; k < added.length; k++) {
        var clips = seq.audioTracks[added[k].t].clips;
        for (var i = clips.numItems - 1; i >= 0; i--) {
            var c = clips[i];
            if (mi_ticks(c.start) === added[k].s && mi_ticks(c.end) === added[k].e) {
                c.remove(false, false);
                break;
            }
        }
    }
}

// Tek bir track'e koymayı dener.
// Döner: { placed: true, unit } | { skip: true } (hiçbir şey olmadı) | { error: kod }
function mi_tryPlace(seq, trackIndex, item, start, frame, unitHint) {
    var units = unitHint === 'seconds' ? ['seconds'] : (unitHint === 'ticks' ? ['ticks'] : ['ticks', 'seconds']);
    var tolerance = frame > 0 ? frame / 2 : 1;
    var landedElsewhere = false;
    for (var u = 0; u < units.length; u++) {
        var before = mi_snapshot(seq);
        var arg = units[u] === 'ticks' ? String(Math.round(start)) : start / MI_TICKS_PER_SECOND;
        seq.audioTracks[trackIndex].overwriteClip(item, arg);
        var after = mi_snapshot(seq);
        var d = mi_diff(before, after);
        if (d.changed) return { error: 'damaged', unit: units[u] };

        // Yeni klip hedef track'te playhead'de mi? (Stereo ses iki track'e bölünerek konmuş olabilir;
        // mevcut hiçbir klip değişmediği sürece bütün yeni parçalar playhead'deyse kabul.)
        var hit = false;
        var allAtPlayhead = d.added.length > 0;
        for (var k = 0; k < d.added.length; k++) {
            var atPlayhead = Math.abs(d.added[k].s - start) <= tolerance;
            if (atPlayhead && d.added[k].t === trackIndex) hit = true;
            if (!atPlayhead) allAtPlayhead = false;
        }
        if (hit && allAtPlayhead) return { placed: true, unit: units[u], parts: d.added.length };

        if (d.added.length) {
            // Yeni klip yanlış yere düştü: yalnızca kendi klibimizi sil, sonra diğer birimi dene.
            landedElsewhere = true;
            mi_removeAdded(seq, d.added);
            var check = mi_diff(before, mi_snapshot(seq));
            if (check.changed || check.added.length) return { error: 'cleanupfailed', unit: units[u] };
        }
        // Hiçbir şey olmadıysa (ör. track türü uymuyor / kilitli) birim değiştirmek anlamsız.
        // Ama önceki birim klibi yanlış yere koyduysa sorun zaman birimidir.
        if (!d.added.length) return landedElsewhere ? { error: 'unitfailed' } : { skip: true };
    }
    return landedElsewhere ? { error: 'unitfailed' } : { skip: true };
}

// QE DOM ile en alta yeni bir stereo ses track'i ekler; yeni track'in sırasını döndürür (yoksa -1).
function mi_addAudioTrack(seq) {
    try {
        var q = mi_qe();
        if (!q || typeof q.addTracks !== 'function') return -1;
        var ids = {};
        var n = seq.audioTracks.numTracks;
        for (var i = 0; i < n; i++) ids[String(seq.audioTracks[i].id)] = true;
        // addTracks(video sayısı, video sonrası, ses sayısı, ses türü (1 = stereo), ses sonrası, submix sayısı, submix türü)
        q.addTracks(0, 0, 1, 1, n, 0, 0);
        var fresh = app.project.activeSequence;
        if (fresh.audioTracks.numTracks !== n + 1) return -1;
        for (var j = 0; j < fresh.audioTracks.numTracks; j++) {
            if (!ids[String(fresh.audioTracks[j].id)]) return j;
        }
    } catch (e) { /* eklenemedi */ }
    return -1;
}

function mi_itemDurationTicks(item) {
    var inT, outT;
    try {
        outT = mi_ticks(item.getOutPoint(2));
    } catch (e) {
        outT = NaN;
    }
    if (!(outT > 0)) {
        try {
            outT = mi_ticks(item.getOutPoint());
        } catch (e2) {
            outT = NaN;
        }
    }
    try {
        inT = mi_ticks(item.getInPoint(2));
    } catch (e3) {
        inT = NaN;
    }
    if (isNaN(inT)) {
        try {
            inT = mi_ticks(item.getInPoint());
        } catch (e4) {
            inT = 0;
        }
    }
    if (isNaN(inT)) inT = 0;
    var d = outT - inT;
    return d > 0 ? d : 0;
}

/* ------------------------------------------------------------------ ana iş: import + timeline */

// mediaPath: indirilen dosyanın tam yolu
// panelSeconds: panelin ölçtüğü süre (Premiere süreyi okuyamazsa ya da daha kısa verirse kullanılır)
// unitHint: 'ticks' | 'seconds' | '' — bu Premiere sürümünde daha önce çalışan zaman birimi
function mi_place(mediaPath, panelSeconds, unitHint) {
    var r = { ok: false, version: mi_version() };
    mi_qeSeq = null;
    try {
        var project = app.project;
        if (!project) { r.code = 'noproject'; return mi_json(r); }
        var seq = project.activeSequence;
        if (!seq) { r.code = 'nosequence'; return mi_json(r); }

        // 1) Proje öğesi: varsa kullan, yoksa MyInstants bin'ine import et
        var item = mi_findItem(mediaPath);
        r.imported = false;
        r.binCreated = false;
        if (!item) {
            var bin = mi_findBin(project.rootItem, MI_BIN_NAME);
            if (!bin) {
                bin = project.rootItem.createBin(MI_BIN_NAME);
                if (!bin) bin = mi_findBin(project.rootItem, MI_BIN_NAME);
                r.binCreated = !!bin;
            }
            if (!bin) { r.code = 'nobin'; return mi_json(r); }
            project.importFiles([mediaPath], true, bin, false);
            item = mi_findItem(mediaPath);
            if (!item) { r.code = 'importfailed'; return mi_json(r); }
            r.imported = true;
        }

        // 2) Süre (tick) — sequence'in kare süresine yukarı yuvarlanır
        var frame = parseFloat(seq.timebase) || 0;
        var dur = mi_itemDurationTicks(item);
        var panelTicks = (panelSeconds > 0) ? Math.ceil(panelSeconds * MI_TICKS_PER_SECOND) : 0;
        if (panelTicks > dur) dur = panelTicks;
        if (!(dur > 0)) { r.code = 'noduration'; return mi_json(r); }
        if (frame > 0) dur = Math.ceil(dur / frame) * frame;

        var start = mi_ticks(seq.getPlayerPosition());
        if (isNaN(start)) { r.code = 'noplayhead'; return mi_json(r); }
        var end = start + dur;
        r.lockInfo = 'unknown';

        // 3) A1'den başlayarak: kilitsiz ve aralığı tamamen boş ilk track
        var n = seq.audioTracks.numTracks;
        for (var i = 0; i < n; i++) {
            var track = seq.audioTracks[i];
            var locked = mi_isLocked(track, i);
            if (locked !== null) r.lockInfo = 'known';
            if (locked === true) continue;
            if (!mi_isFree(track, start, end)) continue;
            var res = mi_tryPlace(seq, i, item, start, frame, unitHint);
            if (res.placed) {
                r.ok = true;
                r.track = i + 1;
                r.unit = res.unit;
                return mi_json(r);
            }
            if (res.error) { r.code = res.error; r.track = i + 1; return mi_json(r); }
        }

        // 4) Boş track yok → yeni ses track'i ekle ve oraya koy
        var idx = mi_addAudioTrack(seq);
        if (idx < 0) { r.code = 'notrack'; return mi_json(r); }
        r.addedTrack = true;
        seq = app.project.activeSequence;
        var res2 = mi_tryPlace(seq, idx, item, start, frame, unitHint);
        if (res2.placed) {
            r.ok = true;
            r.track = idx + 1;
            r.unit = res2.unit;
            return mi_json(r);
        }
        r.code = res2.error || 'placefailed';
        r.track = idx + 1;
        return mi_json(r);
    } catch (e) {
        r.code = 'exception';
        r.message = String(e);
        return mi_json(r);
    }
}

/* ------------------------------------------------------------------ teşhis */

// Bu Premiere'de hangi yolların çalıştığını raporlar (zaman birimini panel ekler).
function mi_diag() {
    var d = { version: mi_version() };
    mi_qeSeq = null;
    try {
        var seq = app.project ? app.project.activeSequence : null;
        d.hasSequence = !!seq;
        if (seq) {
            d.sequence = String(seq.name);
            d.audioTracks = seq.audioTracks.numTracks;
            d.timebase = String(seq.timebase);
            var t0 = seq.audioTracks.numTracks ? seq.audioTracks[0] : null;
            d.domIsLocked = !!(t0 && typeof t0.isLocked === 'function');
            var q = mi_qe();
            d.qe = !!q;
            d.qeIsLocked = false;
            d.qeAddTracks = !!(q && typeof q.addTracks === 'function');
            try {
                var qt = q && seq.audioTracks.numTracks ? q.getAudioTrackAt(0) : null;
                d.qeIsLocked = !!(qt && typeof qt.isLocked === 'function');
            } catch (e1) { /* yok */ }
            d.findByPath = typeof app.project.rootItem.findItemsMatchingMediaPath === 'function';
        }
    } catch (e) {
        d.error = String(e);
    }
    return mi_json(d);
}
