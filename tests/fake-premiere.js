// Testler için sahte Premiere (ExtendScript DOM + QE DOM). host.jsx bunun içinde, Node'un vm modülüyle çalışır.
// Gerçek Premiere'in bilinmeyen/belirsiz davranışları ayarlanabilir:
//   timeMode     : overwriteClip'in zaman parametresini nasıl yorumladığı
//                  'string-ticks' → metin = tick, sayı = saniye (Adobe örneği + topluluk belgesi birlikte)
//                  'seconds'      → her şey saniye (metin "2540160000000" da saniye sayılır → klip çok uzağa düşer)
//                  'ticks'        → her şey tick (sayı 10 → 10 tick ≈ 0. saniye)
//   lockApi      : 'dom' (track.isLocked var) | 'qe' (yalnız QE'de var) | 'none'
//   lockEnforced : kilitli track'e overwrite yapılamasın mı
//   qeAddTracks  : QE addTracks var mı
//   brokenRemove : trackItem.remove çalışmasın mı
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TPS = 254016000000;
const HOST_JSX = path.join(__dirname, '..', 'extension', 'jsx', 'host.jsx');

class Time {
  constructor(ticks) {
    this.ticks = String(Math.round(ticks));
    this.seconds = ticks / TPS;
  }
}

function collection(arr, countName) {
  Object.defineProperty(arr, countName, { get: () => arr.length });
  return arr;
}

function createPremiere(opts = {}) {
  const o = Object.assign(
    {
      version: '26.5.1',
      projectPath: 'C:\\Projeler\\Test\\test.prproj',
      savedFiles: ['C:\\Projeler\\Test\\test.prproj'],
      documents: 'C:\\Users\\Test\\Documents',
      timeMode: 'string-ticks',
      lockApi: 'dom',
      lockEnforced: true,
      qeAddTracks: true,
      brokenRemove: false,
      frameTicks: TPS / 25, // 25 fps
      audioTracks: 3,
      mediaDurations: {}, // yol → saniye
      defaultDuration: 1.5,
      reportDuration: true, // getOutPoint gerçek süreyi versin mi
    },
    opts
  );
  const log = []; // yapılan işlemler (undo adımı sayımı için)
  let nextId = 1;

  /* ---------------- proje öğeleri ---------------- */
  function makeBin(name) {
    const bin = {
      type: 2,
      name,
      children: collection([], 'numItems'),
      createBin(n) {
        const b = makeBin(n);
        bin.children.push(b);
        log.push('createBin');
        return b;
      },
      findItemsMatchingMediaPath(p) {
        const out = [];
        (function walk(b) {
          for (const c of b.children) {
            if (c.type === 2) walk(c);
            else if (c.getMediaPath() === p) out.push(c);
          }
        })(bin);
        return out.length ? out : 0;
      },
    };
    return bin;
  }

  function makeClipItem(mediaPath) {
    const secs = o.mediaDurations[mediaPath] ?? o.defaultDuration;
    const name = mediaPath.split('\\').pop();
    return {
      type: 1,
      name,
      nodeId: String(nextId++),
      durationTicks: Math.round(secs * TPS),
      getMediaPath: () => mediaPath,
      getInPoint: () => new Time(0),
      getOutPoint: () => new Time(o.reportDuration ? Math.round(secs * TPS) : 0),
    };
  }

  const rootItem = makeBin('root');
  rootItem.type = 3;

  /* ---------------- sequence / track'ler ---------------- */
  function makeTrack(index, extra) {
    const t = Object.assign({ id: nextId++, name: 'Audio ' + (index + 1), _locked: false, _channel: 'stereo' }, extra);
    t.clips = collection([], 'numItems');
    t.transitions = collection([], 'numItems');
    if (o.lockApi === 'dom') t.isLocked = () => t._locked;
    t.overwriteClip = (item, time) => {
      log.push('overwriteClip');
      let startTicks;
      if (o.timeMode === 'string-ticks') startTicks = typeof time === 'string' ? Number(time) : time * TPS;
      else if (o.timeMode === 'seconds') startTicks = Number(time) * TPS;
      else startTicks = Number(time); // 'ticks'
      if ((t._locked && o.lockEnforced) || t._channel === '5.1') return true; // hiçbir şey olmaz
      overwrite(t, item, startTicks, startTicks + item.durationTicks);
      return true;
    };
    return t;
  }

  function makeClip(track, item, s, e) {
    const c = {
      name: item.name,
      projectItem: item,
      start: new Time(s),
      end: new Time(e),
      remove(ripple, align) {
        log.push('remove(' + ripple + ',' + align + ')');
        if (o.brokenRemove) return 1;
        const i = track.clips.indexOf(c);
        if (i >= 0) track.clips.splice(i, 1);
        return 0;
      },
    };
    return c;
  }

  // Premiere'in overwrite davranışı: aralıktaki klipleri keser / böler / siler, yenisini koyar.
  function overwrite(track, item, s, e) {
    const keep = [];
    for (const c of track.clips) {
      const cs = Number(c.start.ticks);
      const ce = Number(c.end.ticks);
      if (ce <= s || cs >= e) keep.push(c);
      else {
        if (cs < s) keep.push(makeClip(track, c.projectItem, cs, s));
        if (ce > e) keep.push(makeClip(track, c.projectItem, e, ce));
      }
    }
    keep.push(makeClip(track, item, s, e));
    keep.sort((a, b) => Number(a.start.ticks) - Number(b.start.ticks));
    track.clips.length = 0;
    track.clips.push(...keep);
  }

  const audioTracks = collection([], 'numTracks');
  for (let i = 0; i < o.audioTracks; i++) audioTracks.push(makeTrack(i));

  let playhead = 10 * TPS;
  const seq = {
    name: 'Sequence 01',
    timebase: String(o.frameTicks),
    audioTracks,
    videoTracks: collection([], 'numTracks'),
    getPlayerPosition: () => new Time(playhead),
  };

  const project = {
    path: o.projectPath,
    rootItem,
    activeSequence: seq,
    importFiles(paths, suppressUI, bin) {
      log.push('importFiles');
      for (const p of paths) {
        if (!o.onDisk || o.onDisk(p)) bin.children.push(makeClipItem(p));
      }
      return true;
    },
  };

  /* ---------------- QE ---------------- */
  const qe = {
    project: {
      getActiveSequence: () => {
        if (!project.activeSequence) return null;
        const q = {
          getAudioTrackAt: (i) => {
            const t = project.activeSequence.audioTracks[i];
            return o.lockApi === 'qe' ? { isLocked: () => (t._locked ? true : false) } : {};
          },
        };
        if (o.qeAddTracks) {
          q.addTracks = (nv, va, na, atype, aafter) => {
            log.push('addTracks');
            for (let k = 0; k < na; k++) audioTracks.splice(aafter, 0, makeTrack(audioTracks.length));
          };
        }
        return q;
      },
    },
  };

  /* ---------------- ExtendScript ortamı ---------------- */
  const saved = new Set(o.savedFiles);
  function File(p) {
    this.fsName = p;
    this.exists = saved.has(p);
    this.parent = { fsName: p.replace(/\\[^\\]*$/, '') };
  }
  const context = vm.createContext({
    app: {
      version: o.version,
      project,
      enableQE() {
        context.qe = qe;
      },
    },
    File,
    Folder: { myDocuments: { fsName: o.documents } },
    ProjectItemType: { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 },
  });
  vm.runInContext(fs.readFileSync(HOST_JSX, 'utf8'), context, { filename: 'host.jsx' });

  return {
    TPS,
    context,
    project,
    seq,
    log,
    options: o,
    call(script) {
      return String(vm.runInContext(script, context));
    },
    place(mediaPath, panelSeconds = 0, unitHint = '') {
      return JSON.parse(
        this.call(`mi_place(${JSON.stringify(mediaPath)}, ${Number(panelSeconds)}, ${JSON.stringify(unitHint)})`)
      );
    },
    setPlayhead(seconds) {
      playhead = Math.round(seconds * TPS);
    },
    // Test için track'e hazır klip koy (saniye cinsinden)
    addClip(trackIndex, startSec, endSec, name = 'Mevcut klip') {
      const t = audioTracks[trackIndex];
      const item = { name, getMediaPath: () => 'C:\\Medya\\' + name + '.wav' };
      t.clips.push(makeClip(t, item, Math.round(startSec * TPS), Math.round(endSec * TPS)));
      t.clips.sort((a, b) => Number(a.start.ticks) - Number(b.start.ticks));
    },
    clips(trackIndex) {
      return audioTracks[trackIndex].clips.map((c) => [
        +(Number(c.start.ticks) / TPS).toFixed(3),
        +(Number(c.end.ticks) / TPS).toFixed(3),
        c.name,
      ]);
    },
    bins() {
      return rootItem.children.filter((c) => c.type === 2).map((b) => [b.name, b.children.map((c) => c.name)]);
    },
  };
}

module.exports = { createPremiere, TPS };
