import { SplatViewer, extractFrames, loadSplatFile } from './splat.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const fmtSplats = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);

/* ================= 状态 ================= */
const settings = Object.assign({ quality: 'balanced', size: 1.5, density: 50, ambient: true, auto: true }, load('splatmem.settings', {}));
let users = load('splatmem.users', []);
let session = load('splatmem.session', null);
let memories = load('splatmem.memories.v1', null);
if (!memories) {
  memories = [
    { id: 'm1', title: '404宿舍 · 最后一个夏天', img: 'assets/dorm-hero.webp', date: '2026-06-12', splats: 1840000, status: 'done', sealed: true, device: 'iPhone 15 Pro', area: '18㎡', note: '灯串还亮着，床位已经空了。' },
    { id: 'm2', title: '熄灯后的悄悄话', img: 'assets/mem-night.webp', date: '2026-05-30', splats: 920000, status: 'done', sealed: false, device: 'Xiaomi 14', area: '6㎡', note: '两部手机的光，是那晚唯一的月亮。' },
    { id: 'm3', title: '窗边的黄昏', img: 'assets/mem-window.webp', date: '2026-11-20', splats: 0, status: 'run', progress: 58, sealed: false, device: 'HUAWEI Mate 60', area: '4㎡', note: '' },
    { id: 'm4', title: '考研自习位', img: 'assets/mem-study.webp', date: '2026-04-18', splats: 0, status: 'draft', sealed: false, device: 'iPhone 13', area: '2㎡', note: '占座的书还在，人已经上岸。' },
  ];
  save('splatmem.memories.v1', memories);
}
const saveSettings = () => save('splatmem.settings', settings);
const saveMemories = () => save('splatmem.memories.v1', memories);
const QUALITY_CAP = { smooth: 1, balanced: 1.75, ultra: 2 };
window.__splatPixelCap = QUALITY_CAP[settings.quality] || 1.75;

/* ================= 环境音 =================
   单一 master 总线；cancel+锚点+短 fade；静音 fade 后 suspend；
   statechange / visibilitychange / pageshow / 每次手势统一恢复 */
const Sound = {
  ctx: null, master: null, on: settings.ambient,
  coarse: window.matchMedia && window.matchMedia('(pointer: coarse)').matches,
  get level() { return this.coarse ? 0.5 : 0.9; },
  ensure() {
    if (this.ctx || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const master = this.master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.connect(master);
    const sweep = ctx.createOscillator(); sweep.frequency.value = 0.023;
    const sweepG = ctx.createGain(); sweepG.gain.value = 70;
    sweep.connect(sweepG); sweepG.connect(lp.frequency); sweep.start();
    for (const [f, g, df, dg] of [[82, 0.045, 0.05, 7], [82, 0.04, 0.037, 5], [164.8, 0.012, 0.031, 4]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const lfo = ctx.createOscillator(); lfo.frequency.value = df;
      const lg = ctx.createGain(); lg.gain.value = dg;
      lfo.connect(lg); lg.connect(o.detune); lfo.start();
      const gn = ctx.createGain(); gn.gain.value = g;
      o.connect(gn); gn.connect(lp); o.start();
    }
    const secs = 4, len = Math.floor(ctx.sampleRate * secs);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let lpn = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      lpn = lpn * 0.86 + w * 0.14;
      d[i] = lpn * 0.7 + w * 0.3;
    }
    const xf = Math.floor(ctx.sampleRate * 0.5);
    for (let i = 0; i < xf; i++) {
      const t = i / xf, a = Math.sqrt(1 - t), b = Math.sqrt(t);
      const head = d[i], tail = d[len - xf + i];
      d[i] = head * b + tail * a;
      d[len - xf + i] = tail * b + head * a;
    }
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 720; bp.Q.value = 0.7;
    const breath = ctx.createOscillator(); breath.frequency.value = 0.06;
    const bg = ctx.createGain(); bg.gain.value = 180;
    breath.connect(bg); bg.connect(bp.frequency); breath.start();
    const ng = ctx.createGain(); ng.gain.value = this.coarse ? 0.006 : 0.012;
    noise.connect(bp); bp.connect(ng); ng.connect(master); noise.start();
    ctx.onstatechange = () => {
      syncSoundBtn();
      if (ctx.state === 'running' && this.on && !document.hidden) this._fade(this.level);
    };
  },
  _fade(target) {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(target, t + 0.25);
  },
  setOn(b) {
    this.on = b;
    if (b) {
      this.ensure();
      if (!this.ctx) return;
      const go = () => { if (this.on) this._fade(this.level); syncSoundBtn(); };
      if (this.ctx.state === 'running') go();
      else this.ctx.resume().then(go).catch(() => syncSoundBtn());
    } else if (this.ctx) {
      this._fade(0);
      setTimeout(() => {
        if (!this.on && this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
        syncSoundBtn();
      }, 300);
    }
    syncSoundBtn();
  },
  recover() {
    if (!this.on || !this.ctx || document.hidden) return;
    if (this.ctx.state === 'running') { this._fade(this.level); syncSoundBtn(); return; }
    this.ctx.resume().then(() => { if (this.on) this._fade(this.level); syncSoundBtn(); }).catch(() => syncSoundBtn());
  },
  blip(freqs, dur, vol) {
    if (!this.on || !this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f[0], t + i * 0.09);
      o.frequency.exponentialRampToValueAtTime(f[1], t + i * 0.09 + dur * 0.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(vol, t + i * 0.09 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + dur);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + dur + 0.05);
    });
  },
  chime() { this.blip([[660, 990], [1320, 1760]], 0.9, 0.11); },
  thud() { this.blip([[150, 58]], 0.32, 0.16); },
  tick() { this.blip([[880, 880]], 0.12, 0.05); },
};
function syncSoundBtn() {
  const b = $('#soundBtn');
  if (!b) return;
  const live = !!Sound.ctx && Sound.ctx.state === 'running' && Sound.on;
  b.classList.toggle('on', Sound.on);
  b.classList.toggle('live', live);
  b.setAttribute('aria-pressed', String(Sound.on));
  $('#soundLabel').textContent = Sound.on ? 'AMBIENCE ON' : 'AMBIENCE OFF';
}
$('#soundBtn').addEventListener('click', () => {
  settings.ambient = !settings.ambient; saveSettings();
  Sound.setOn(settings.ambient);
});
for (const ev of ['pointerdown', 'click', 'keydown', 'touchend']) {
  window.addEventListener(ev, () => {
    if (!Sound.on) return;
    Sound.ensure();
    if (Sound.ctx && Sound.ctx.state !== 'running') Sound.recover();
  }, { passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (Sound.ctx && Sound.ctx.state === 'running') {
      Sound._fade(0);
      setTimeout(() => { if (document.hidden && Sound.ctx.state === 'running') Sound.ctx.suspend().catch(() => {}); }, 280);
    }
  } else Sound.recover();
});
window.addEventListener('pageshow', () => Sound.recover());
syncSoundBtn();

/* ================= Toast ================= */
function toast(msg, { type = 'ok', action = null, duration = 4200 } = {}) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'ok' ? '' : ' ' + type);
  el.innerHTML = `<span class="t-dot"></span><span>${esc(msg)}</span>`;
  let timer;
  const dismiss = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => { action.fn(); dismiss(); });
    el.appendChild(b);
  }
  wrap.appendChild(el);
  timer = setTimeout(dismiss, duration);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  return dismiss;
}

/* ================= 示例数据 ================= */
const SAMPLES = [
  { id: 's1', title: '404宿舍 · 深夜灯串', img: 'assets/dorm-hero.webp', cat: 'dorm', splats: 1840000, area: '18㎡', device: 'iPhone 15 Pro', date: '2026-06-12', tags: [['宿舍', 'amber'], ['夜景', 'ice']], note: '毕业前夜环绕拍摄 2 分 40 秒。灯串的暖光在高斯椭球里保留了完整的辉光，窗外地平线的城市灯点是整场重建中最远的泼溅。' },
  { id: 's2', title: '熄灯后的悄悄话', img: 'assets/mem-night.webp', cat: 'dorm', splats: 920000, area: '6㎡', device: 'Xiaomi 14', date: '2026-05-30', tags: [['宿舍', 'amber'], ['低光', 'violet']], note: '极低照度下的重建实验：两部手机屏幕作为主光源，被褥的褶皱被还原成柔软的高斯曲面。' },
  { id: 's3', title: '窗边的黄昏', img: 'assets/mem-window.webp', cat: 'dorm', splats: 1120000, area: '4㎡', device: 'HUAWEI Mate 60', date: '2026-09-02', tags: [['宿舍', 'amber'], ['黄昏', 'rose']], note: '逆光场景。窗外天空的渐变被泼溅成一层半透明的光幕，是本次策展中最温柔的一件。' },
  { id: 's4', title: '考研自习位', img: 'assets/mem-study.webp', cat: 'campus', splats: 760000, area: '2㎡', device: 'iPhone 13', date: '2026-04-18', tags: [['校园', 'ice'], ['静物', 'green']], note: '一平米的书桌宇宙：台灯、笔筒、叠到第 7 层的真题卷。位姿估计在这件小场景上只用了 41 秒。' },
  { id: 's5', title: '社团活动室 · 生日夜', img: 'assets/mem-birthday.webp', cat: 'campus', splats: 1310000, area: '26㎡', device: 'OPPO Find X7', date: '2026-03-21', tags: [['校园', 'ice'], ['人群', 'rose']], note: '有人走动的动态场景：训练时剔除了移动人物的帧，留下空椅子与没吃完的蛋糕。' },
  { id: 's6', title: '搬空的那天 · 巷口', img: 'assets/mem-move.webp', cat: 'city', splats: 2050000, area: '120㎡', device: 'iPhone 15 Pro', date: '2026-06-28', tags: [['城市', 'violet'], ['街巷', 'amber']], note: '从宿舍楼下一直拍到巷口。纸箱的棱角在锐利点阵模式下格外清楚，像一封没寄出的信。' },
  { id: 's7', title: '巷口食光', img: 'assets/mem-food.webp', cat: 'city', splats: 680000, area: '8㎡', device: 'vivo X100', date: '2026-07-15', tags: [['城市', 'violet'], ['食物', 'green']], note: '一碗粉的热气无法被重建，但碗沿的油光可以。建议开启景深雾观看。' },
  { id: 's8', title: '雪国小屋 · 寒假', img: 'assets/ambient-bg.webp', cat: 'nature', splats: 2460000, area: '400㎡', device: 'DJI Pocket 3', date: '2026-01-26', tags: [['自然', 'green'], ['雪景', 'ice']], note: '户外大场景：雪地的低纹理区域靠环绕路径补足了视差，日落色温被完整保留在泼溅颜色里。' },
];
let sampleFilter = 'all', sampleSort = 'default';

function renderSamples() {
  let list = SAMPLES.filter((s) => sampleFilter === 'all' || s.cat === sampleFilter);
  if (sampleSort === 'splats') list = [...list].sort((a, b) => b.splats - a.splats);
  if (sampleSort === 'date') list = [...list].sort((a, b) => b.date.localeCompare(a.date));
  $('#sampleGrid').innerHTML = list.map((s, i) => `
    <article class="sample-card panel" data-id="${s.id}" style="animation:screenIn .5s var(--ease) both;animation-delay:${i * 55}ms" tabindex="0" role="button" aria-label="打开示例 ${esc(s.title)}">
      <div class="sc-img">
        <img src="${s.img}" alt="${esc(s.title)}" loading="lazy">
        <span class="sc-splats">${fmtSplats(s.splats)} SPLATS</span>
        <span class="sc-open">进入空间 →</span>
      </div>
      <div class="sc-body">
        <h4>${esc(s.title)}</h4>
        <div class="sc-meta"><span>${s.area}</span><span>${esc(s.device)}</span><span>${s.date}</span></div>
        <div class="sc-tags">${s.tags.map(([t, c]) => `<span class="tag ${c}">${t}</span>`).join('')}</div>
      </div>
    </article>`).join('') || '<p style="color:var(--muted);grid-column:1/-1;padding:30px 0">该分类下暂无示例。</p>';
}
$$('.filter-row .chip').forEach((c) => c.addEventListener('click', () => {
  $$('.filter-row .chip').forEach((x) => x.classList.remove('active'));
  c.classList.add('active');
  sampleFilter = c.dataset.cat;
  renderSamples();
}));
$('#sampleSort').addEventListener('change', (e) => { sampleSort = e.target.value; renderSamples(); });
$('#sampleGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.sample-card');
  if (card) openSample(card.dataset.id);
});
$('#sampleGrid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const card = e.target.closest('.sample-card'); if (card) openSample(card.dataset.id); }
});

/* ================= 控制台绑定 ================= */
function bindControls(ids, viewer, rebuild) {
  const el = (k) => $('#' + ids[k]);
  let densityTimer = null;
  const sync = () => {
    el('outMorph').textContent = el('morph').value + '%';
    el('outDensity').textContent = el('density').value + '%';
    el('outSize').textContent = (el('size').value / 100).toFixed(2);
    el('outSpeed').textContent = (el('speed').value / 100).toFixed(2);
    el('outFog').textContent = (el('fog').value / 100).toFixed(2);
  };
  el('morph').addEventListener('input', () => { viewer.setMorph(el('morph').value / 100); sync(); });
  el('density').addEventListener('input', () => {
    sync();
    clearTimeout(densityTimer);
    densityTimer = setTimeout(() => rebuild(el('density').value / 100), 260);
  });
  el('size').addEventListener('input', () => { viewer.setSize(el('size').value / 100); sync(); });
  el('speed').addEventListener('input', () => { viewer.setSpeed(el('speed').value / 100); sync(); });
  el('fog').addEventListener('input', () => { viewer.setFog(el('fog').value / 100); sync(); });
  el('mode').addEventListener('change', () => {
    viewer.setMode(el('mode').value);
    const hud = $('#hudMode'); if (hud && ids.prefix === 'hero') hud.textContent = el('mode').value === 'point' ? 'POINT' : 'SPLAT';
  });
  el('auto').addEventListener('change', () => viewer.setAutoRotate(el('auto').checked));
  el('known').addEventListener('change', () => viewer.setKnown(el('known').value));
  el('conf').addEventListener('change', () => viewer.setConf(el('conf').checked));
  el('reset').addEventListener('click', () => { viewer.resetView(); Sound.tick(); });
  el('random').addEventListener('click', () => { viewer.randomView(); Sound.tick(); });
  el('shot').addEventListener('click', () => {
    const url = viewer.snapshot();
    if (!url) { toast('当前环境不支持 WebGL 快照', { type: 'err' }); return; }
    const a = document.createElement('a');
    a.href = url; a.download = `splat-memory-${Date.now()}.png`; a.click();
    toast('快照已导出为 PNG');
  });
  const applyDefaults = () => {
    el('size').value = Math.round(settings.size * 100);
    el('density').value = settings.density;
    el('auto').checked = settings.auto;
    viewer.setSize(settings.size);
    viewer.setAutoRotate(settings.auto);
    sync();
  };
  return { sync, applyDefaults, el };
}

function tweenMorph(viewer, slider, out, ms = 2100) {
  const t0 = performance.now();
  viewer.setMorph(0); slider.value = 0; out.textContent = '0%';
  const step = (now) => {
    if (viewer.dead || viewer._morphTween !== t0) return;
    const t = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - t, 3);
    viewer.setMorph(e);
    slider.value = Math.round(e * 100);
    out.textContent = Math.round(e * 100) + '%';
    if (t < 1) requestAnimationFrame(step);
  };
  viewer._morphTween = t0;
  requestAnimationFrame(step);
}

/* ================= 主页 hero ================= */
let heroViewer = null, heroImg = null, heroCtl = null, heroReady = false;
function initHero() {
  heroViewer = new SplatViewer($('#heroCanvas'));
  if (heroViewer.dead) { heroFallback(); return; }
  heroCtl = bindControls({
    prefix: 'hero', morph: 'ctlMorph', outMorph: 'outMorph', density: 'ctlDensity', outDensity: 'outDensity',
    size: 'ctlSize', outSize: 'outSize', speed: 'ctlSpeed', outSpeed: 'outSpeed', fog: 'ctlFog', outFog: 'outFog',
    mode: 'ctlMode', auto: 'ctlAuto', known: 'ctlKnown', conf: 'ctlConf', reset: 'heroReset', random: 'heroRandom', shot: 'heroShot',
  }, heroViewer, (d) => {
    if (!heroImg) return;
    const n = heroViewer.buildFromSource(heroImg, d);
    $('#hudSplats').textContent = fmtSplats(n);
  });
  heroCtl.applyDefaults();
  heroImg = new Image();
  heroImg.onload = () => {
    const n = heroViewer.buildFromSource(heroImg, settings.density / 100);
    $('#hudSplats').textContent = fmtSplats(n);
    heroReady = true;
    setTimeout(() => { if (!heroViewer.dead) tweenMorph(heroViewer, $('#ctlMorph'), $('#outMorph')); }, 600);
  };
  heroImg.onerror = () => heroFallback();
  heroImg.src = 'assets/dorm-hero.webp';
}
function heroFallback() {
  const stage = $('#heroStage');
  stage.innerHTML = '<img src="assets/dorm-hero.webp" alt="404宿舍深夜" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.85"><div class="hero-veil"></div>' + stage.querySelector('.hero-copy').outerHTML + stage.querySelector('.hero-hud').outerHTML;
  $('#hudSplats').textContent = 'PREVIEW';
  const rail = $('.hero-rail'); if (rail) rail.hidden = true;
}

/* ================= 查看器模态 ================= */
let vmViewer = null, vmCtl = null, vmState = null;
function openViewer(meta, source) {
  vmState = { meta, source };
  $('#vmTitle').textContent = meta.title;
  $('#vmMeta').textContent = `${meta.catLabel || 'MEMORY'} · ${meta.date || today()} · ${meta.device || '—'}`;
  $('#vmDevice').textContent = meta.device || '—';
  $('#vmBuilt').textContent = meta.date || today();
  $('#vmSource').textContent = meta.sourceLabel || 'PHOTO';
  $('#vmNote').textContent = meta.note || '暂无批注。';
  $('#vmSave').hidden = !meta.allowSave;
  $('#viewerModal').hidden = false;
  document.body.style.overflow = 'hidden';
  if (vmViewer) { vmViewer.dispose(); vmViewer = null; }
  try { vmViewer = new SplatViewer($('#vmCanvas')); } catch (err) { console.warn('查看器 WebGL 失败', err); vmViewer = null; }
  if (!vmViewer || vmViewer.dead) {
    const fbSrc = meta.img || (source instanceof HTMLCanvasElement ? source.toDataURL('image/webp', 0.8) : '');
    $('#vmStage').insertAdjacentHTML('beforeend', '<img src="' + fbSrc + '" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.8">');
    $('#vmSplats').textContent = 'N/A';
  } else {
    vmCtl = bindControls({
      prefix: 'vm', morph: 'vmMorph', outMorph: 'vmOutMorph', density: 'vmDensity', outDensity: 'vmOutDensity',
      size: 'vmSize', outSize: 'vmOutSize', speed: 'vmSpeed', outSpeed: 'vmOutSpeed', fog: 'vmFog', outFog: 'vmOutFog',
      mode: 'vmMode', auto: 'vmAuto', known: 'vmKnown', conf: 'vmConf', reset: 'vmReset', random: 'vmRandom', shot: 'vmShot',
    }, vmViewer, (d) => rebuild(d));
    const rebuild = (d) => {
      const s = vmState.source;
      let n = 0;
      if (s && s.cloud) n = vmViewer.buildFromCloud(s.cloud);
      else if (s && s.frames) n = vmViewer.buildFromVideo(s.frames, d);
      else if (s instanceof HTMLImageElement || s instanceof HTMLCanvasElement) n = vmViewer.buildFromSource(s, d);
      $('#vmSplats').textContent = fmtSplats(n);
      $('#vmIdentity').textContent = `${fmtSplats(vmViewer.knownCount)} / ${fmtSplats(vmViewer.inferredCount)}`;
      return n;
    };
    vmCtl.applyDefaults();
    const isCloud = !!(source && source.cloud);
    $('#vmMorph').disabled = isCloud;
    $('#vmKnown').disabled = isCloud;
    $('#vmConf').disabled = isCloud;
    let n = rebuild(settings.density / 100);
    if (!n && meta.img) {
      vmViewer.loadImage(meta.img, settings.density / 100).then((c) => {
        $('#vmSplats').textContent = fmtSplats(c);
        $('#vmIdentity').textContent = `${fmtSplats(vmViewer.knownCount)} / ${fmtSplats(vmViewer.inferredCount)}`;
        const im = new Image(); im.onload = () => { vmState.source = im; }; im.src = meta.img;
        tweenMorph(vmViewer, $('#vmMorph'), $('#vmOutMorph'));
      });
    } else if (!isCloud) {
      tweenMorph(vmViewer, $('#vmMorph'), $('#vmOutMorph'));
    } else {
      $('#vmMorph').value = 100; $('#vmOutMorph').textContent = '100%';
    }
  }
}
function closeViewer() {
  if (vmViewer) { vmViewer.dispose(); vmViewer = null; }
  $$('#vmStage img').forEach((i) => i.remove());
  $('#viewerModal').hidden = true;
  document.body.style.overflow = '';
  vmState = null;
}
$('#vmClose').addEventListener('click', closeViewer);
$('#vmSave').addEventListener('click', () => {
  if (!vmState) return;
  const src = vmState.source;
  let thumb = vmState.meta.img;
  const drawable = src instanceof HTMLCanvasElement || src instanceof HTMLImageElement
    ? src : (src && src.frames ? src.frames[Math.floor(src.frames.length / 2)] : null);
  if (drawable) {
    const cv = document.createElement('canvas');
    const w = 360, h = Math.round(w * ((drawable.naturalHeight || drawable.height) / (drawable.naturalWidth || drawable.width)));
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(drawable, 0, 0, w, h);
    thumb = cv.toDataURL('image/webp', 0.72);
  } else if (src && src.cloud && vmViewer) {
    vmViewer.snapshot();
    const cv = document.createElement('canvas');
    const w = 360, h = Math.round(w * (vmViewer.canvas.height / vmViewer.canvas.width));
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(vmViewer.canvas, 0, 0, w, h);
    thumb = cv.toDataURL('image/webp', 0.72);
  }
  const mem = {
    id: uid(), title: vmState.meta.title, img: thumb, date: today(),
    splats: vmViewer ? vmViewer.count : 0, status: 'done', sealed: false,
    device: vmState.meta.device || '本机上传', area: vmState.meta.area || '—', note: '',
  };
  memories.unshift(mem); saveMemories();
  $('#vmSave').hidden = true;
  renderMemory(); updateBadge(); renderMe();
  Sound.chime();
  toast('已存入个人记忆体', { action: { label: '查看', fn: () => { closeViewer(); switchTab('memory'); } } });
});
function openSample(id) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return;
  openViewer({
    title: s.title, img: s.img, date: s.date, device: s.device, note: s.note,
    catLabel: 'GALLERY', sourceLabel: 'PHOTO', area: s.area, allowSave: true,
  }, null);
}

/* ================= 上传重建管线 ================= */
const pipe = { busy: false };
function setStage(i, state) {
  const el = $(`.pipe-stage[data-stage="${i}"]`);
  el.classList.remove('run', 'done');
  if (state !== 'wait') el.classList.add(state);
  el.querySelector('.ps-state').textContent = state === 'run' ? '进行中' : state === 'done' ? '完成' : '等待';
}
function resetPipe() {
  for (let i = 0; i < 4; i++) setStage(i, 'wait');
  $('#pipeBar').style.width = '0%';
  $('#pipeFrames').innerHTML = '';
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleFile(file) {
  if (pipe.busy) return;
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  if (!isVideo && !isImage) { toast('仅支持视频或图片文件', { type: 'err' }); return; }
  if (file.size > 200 * 1024 * 1024) { toast('文件超过 200MB 限制', { type: 'err' }); return; }
  pipe.busy = true;
  resetPipe();
  $('#pipeOverlay').hidden = false;
  $('#pipeTitle').textContent = '正在重建你的空间';
  $('#pipeSub').textContent = `SOURCE ${file.name} · ${(file.size / 1048576).toFixed(1)}MB`;
  $('#pipeNote').textContent = isVideo ? '端侧抽帧预览 · 完整 SfM / 3DGS 训练由云端队列完成' : '单照片端侧预览 · 多视角完整重建需环绕视频';
  let source = null, frames = [];
  try {
    setStage(0, 'run'); $('#pipeBar').style.width = '8%';
    if (isImage) {
      const url = URL.createObjectURL(file);
      source = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('图片解码失败'));
        im.src = url;
      });
      await wait(650);
    } else {
      const r = await extractFrames(file, 6);
      source = r.best; frames = r.frames;
    }
    setStage(0, 'done'); $('#pipeBar').style.width = '26%';
    setStage(1, 'run');
    if (frames.length) {
      for (const f of frames) {
        const cv = document.createElement('canvas');
        cv.width = 76; cv.height = 46;
        cv.getContext('2d').drawImage(f, 0, 0, 76, 46);
        $('#pipeFrames').appendChild(cv);
        await wait(160);
      }
    } else {
      await wait(1100);
    }
    $('#pipeBar').style.width = '52%';
    setStage(1, 'done'); setStage(2, 'run');
    await wait(1500);
    $('#pipeBar').style.width = '82%';
    setStage(2, 'done'); setStage(3, 'run');
    await wait(600);
    $('#pipeBar').style.width = '100%';
    setStage(3, 'done');
    await wait(350);
    $('#pipeOverlay').hidden = true;
    Sound.chime();
    const title = file.name.replace(/\.[^.]+$/, '') || '未命名空间';
    openViewer({
      title, img: null, date: today(), device: '本机上传',
      note: isVideo ? `从 ${frames.length} 个关键帧做块匹配视差融合：被多帧看见的点置信度更高，单帧区域由推测层补全。上传完整视频至云端队列可获得 SfM + 3DGS 完整重建。` : '单照片生成：前景为已知层，桌后与画外由镜像纹理补全为推测层。控制台可切换已知/推测与置信度着色。',
      catLabel: 'NEW SCAN', sourceLabel: isVideo ? 'VIDEO · MULTI-VIEW' : 'PHOTO', allowSave: true,
    }, isVideo ? { frames } : source);
  } catch (err) {
    $('#pipeOverlay').hidden = true;
    toast(err.message || '重建失败，请更换素材重试', { type: 'err' });
  } finally {
    pipe.busy = false;
    $('#fileInput').value = '';
  }
}
const zone = $('#uploadZone');
zone.addEventListener('click', () => $('#fileInput').click());
zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
zone.addEventListener('drop', (e) => {
  e.preventDefault(); zone.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(splat|ply|ksplat)$/i.test(f.name)) importSplat(f);
  else handleFile(f);
});
$('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

/* ================= .splat / .ply 导入 ================= */
async function importSplat(file) {
  if (pipe.busy) return;
  if (file.size > 200 * 1024 * 1024) { toast('文件超过 200MB 限制', { type: 'err' }); return; }
  pipe.busy = true;
  const dismiss = toast(`正在解析 ${file.name} …`, { duration: 60000 });
  try {
    const cloud = await loadSplatFile(file);
    dismiss();
    Sound.chime();
    openViewer({
      title: file.name.replace(/\.[^.]+$/, '') || '导入场景',
      img: null, date: today(), device: 'SPLAT 导入',
      note: `导入的真 3DGS 高斯椭球场景：${fmtSplats(cloud.count)} 个椭球，含位置 / 双轴尺度 / 旋转 / 颜色 / 透明度。拖拽环视即可走进这段被完整记录的空间。`,
      catLabel: 'IMPORTED SCAN', sourceLabel: 'SPLAT FILE', allowSave: true,
    }, { cloud });
  } catch (err) {
    dismiss();
    toast(err.message || '场景文件解析失败', { type: 'err', duration: 6000 });
  } finally {
    pipe.busy = false;
    $('#splatInput').value = '';
  }
}
$('#importBtn').addEventListener('click', () => $('#splatInput').click());
$('#splatInput').addEventListener('change', (e) => { if (e.target.files[0]) importSplat(e.target.files[0]); });

/* ================= 个人记忆体 ================= */
let memQuery = '';
const STATUS = { done: ['ok', '已重建'], run: ['run', '重建中'], draft: ['draft', '草稿'] };
function renderMemory() {
  const q = memQuery.trim().toLowerCase();
  const list = memories.filter((m) => !q || m.title.toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q));
  $('#memEmpty').hidden = memories.length > 0;
  $('#memList').innerHTML = list.map((m, i) => {
    const [dot, label] = STATUS[m.status];
    return `
    <article class="mem-card panel" data-id="${m.id}" style="animation:screenIn .45s var(--ease) both;animation-delay:${i * 45}ms">
      <div class="mc-img">
        <img src="${m.img}" alt="${esc(m.title)}" loading="lazy">
        ${m.sealed ? '<img class="mc-seal" src="assets/wax-seal-nobg.webp" alt="已火漆封存">' : ''}
      </div>
      <div class="mc-body">
        <h4><span class="status-dot ${dot}"></span>${esc(m.title)}</h4>
        <div class="mc-meta"><span>${label}</span><span>${m.splats ? fmtSplats(m.splats) + ' SPLATS' : '—'}</span><span>${m.date}</span><span>${esc(m.device)}</span></div>
        ${m.note ? `<div class="mc-note">${esc(m.note)}</div>` : ''}
      </div>
      <div class="mc-actions">
        <button class="btn ice sm" data-act="open" ${m.status !== 'done' ? 'disabled' : ''}>重访</button>
        <button class="btn ghost sm" data-act="detail">详情</button>
        <button class="btn ghost sm" data-act="seal">${m.sealed ? '解封' : '封存'}</button>
        <button class="btn danger sm" data-act="del">删除</button>
      </div>
      ${m.status === 'run' ? `<div class="mc-progress"><div class="pipe-bar"><span style="width:${m.progress || 0}%"></span></div></div>` : ''}
    </article>`;
  }).join('') || (memories.length ? '<p style="color:var(--muted);padding:24px 0">没有匹配的记忆体。</p>' : '');
  $('#memLoginBanner').hidden = !!session;
}
$('#memSearch').addEventListener('input', (e) => { memQuery = e.target.value; renderMemory(); });
$('#memNewBtn').addEventListener('click', () => { switchTab('home'); setTimeout(() => $('#uploadZone').scrollIntoView({ behavior: 'smooth', block: 'center' }), 120); });
$('#memEmptyBtn').addEventListener('click', () => { switchTab('home'); setTimeout(() => $('#uploadZone').scrollIntoView({ behavior: 'smooth', block: 'center' }), 120); });
$('#memLoginBtn').addEventListener('click', () => switchTab('me'));

$('#memList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  const card = e.target.closest('.mem-card');
  if (!card) return;
  const m = memories.find((x) => x.id === card.dataset.id);
  if (!m) return;
  if (!btn) { if (m.status === 'done') openMemory(m); return; }
  const act = btn.dataset.act;
  if (act === 'open') openMemory(m);
  if (act === 'detail') openDrawer(m.id);
  if (act === 'seal') {
    m.sealed = !m.sealed; saveMemories(); renderMemory();
    Sound.thud();
    toast(m.sealed ? `「${m.title}」已火漆封存` : `「${m.title}」已解封`, { type: 'warn' });
  }
  if (act === 'del') deleteMemory(m.id);
});
function openMemory(m) {
  openViewer({
    title: m.title, img: m.img, date: m.date, device: m.device, area: m.area,
    note: m.note || '暂无批注。在详情抽屉里为这个空间写一句话。',
    catLabel: m.sealed ? 'SEALED CAPSULE' : 'CAPSULE', sourceLabel: 'PHOTO', allowSave: false,
  }, null);
}
function deleteMemory(id) {
  const idx = memories.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const [removed] = memories.splice(idx, 1);
  saveMemories(); renderMemory(); updateBadge(); renderMe();
  toast(`已删除「${removed.title}」`, {
    type: 'warn', duration: 6000,
    action: { label: '撤销', fn: () => { memories.splice(Math.min(idx, memories.length), 0, removed); saveMemories(); renderMemory(); updateBadge(); renderMe(); toast('已恢复'); } },
  });
}

/* 抽屉 */
let drawerId = null;
function openDrawer(id) {
  const m = memories.find((x) => x.id === id);
  if (!m) return;
  drawerId = id;
  const [dot, label] = STATUS[m.status];
  $('#drawer').innerHTML = `
    <div class="eyebrow">Capsule Detail</div>
    <div class="dw-img"><img src="${m.img}" alt="${esc(m.title)}">${m.sealed ? '<img class="mc-seal" src="assets/wax-seal-nobg.webp" alt="" style="position:absolute;right:6px;bottom:-6px;width:56px;height:56px;transform:rotate(-12deg)">' : ''}</div>
    <h2>${esc(m.title)}</h2>
    <div style="display:flex;gap:8px;align-items:center"><span class="status-dot ${dot}"></span><span style="font-family:var(--mono);font-size:10px;letter-spacing:.18em;color:var(--muted)">${label}${m.sealed ? ' · SEALED' : ''}</span></div>
    <dl class="dw-meta">
      <div><dt>重建日期</dt><dd>${m.date}</dd></div>
      <div><dt>泼溅点数</dt><dd>${m.splats ? fmtSplats(m.splats) : '—'}</dd></div>
      <div><dt>采集设备</dt><dd>${esc(m.device)}</dd></div>
      <div><dt>空间面积</dt><dd>${esc(m.area || '—')}</dd></div>
    </dl>
    <div class="field" style="margin:0">
      <label for="dwNote">策展批注</label>
      <textarea id="dwNote" rows="3" placeholder="为这个空间写一句话…">${esc(m.note)}</textarea>
    </div>
    <button class="btn sm" id="dwSaveNote">保存批注</button>
    <div class="dw-actions">
      <button class="btn ice sm" id="dwOpen" ${m.status !== 'done' ? 'disabled' : ''}>重访空间</button>
      <button class="btn ghost sm" id="dwSeal">${m.sealed ? '解封' : '火漆封存'}</button>
      <button class="btn danger sm" id="dwDel">删除</button>
      <button class="btn ghost sm" id="dwClose" style="margin-left:auto">关闭</button>
    </div>`;
  $('#drawer').hidden = false;
  $('#drawerScrim').hidden = false;
  $('#dwSaveNote').addEventListener('click', () => {
    m.note = $('#dwNote').value.trim(); saveMemories(); renderMemory();
    toast('批注已保存');
  });
  $('#dwOpen').addEventListener('click', () => { closeDrawer(); openMemory(m); });
  $('#dwSeal').addEventListener('click', () => {
    m.sealed = !m.sealed; saveMemories(); renderMemory(); Sound.thud();
    toast(m.sealed ? '已火漆封存' : '已解封', { type: 'warn' });
    openDrawer(id);
  });
  $('#dwDel').addEventListener('click', () => { closeDrawer(); deleteMemory(id); });
  $('#dwClose').addEventListener('click', closeDrawer);
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerScrim').hidden = true; drawerId = null; }
$('#drawerScrim').addEventListener('click', closeDrawer);

function updateBadge() {
  const n = memories.filter((m) => m.status === 'run').length;
  const b = $('#memBadge');
  b.hidden = n === 0;
  b.textContent = n;
}

/* 重建中的记忆体：进度推进直至完成 */
function tickRunning() {
  let changed = false;
  for (const m of memories) {
    if (m.status !== 'run') continue;
    m.progress = Math.min(100, (m.progress || 0) + 1 + Math.random() * 2.4);
    changed = true;
    if (m.progress >= 100) {
      m.status = 'done'; m.splats = 900000 + Math.round(Math.random() * 500000);
      Sound.chime();
      toast(`「${m.title}」重建完成，可以重访了`, { action: { label: '重访', fn: () => { switchTab('memory'); openMemory(m); } } });
    }
  }
  if (changed) {
    saveMemories(); updateBadge();
    if ($('#screen-memory').classList.contains('active')) renderMemory();
  }
}
setInterval(tickRunning, 900);

/* ================= 我的 / 认证 ================= */
async function hashPass(pass) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('splat·' + pass));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 5381;
    for (const c of 'splat·' + pass) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return 'fnv' + h.toString(16);
  }
}
const validPhone = (p) => /^1[3-9]\d{9}$/.test(p);
const currentUser = () => session ? users.find((u) => u.phone === session.phone) : null;

function renderMe() {
  const u = currentUser();
  $('#userChip').hidden = !u;
  if (u) {
    $('#userChipAva').textContent = u.nickname[0] || '馆';
    $('#userChipName').textContent = u.nickname;
  }
  const wrap = $('#meWrap');
  if (!u) {
    wrap.innerHTML = `
      <div class="sec-head" style="margin-top:6px">
        <div class="eyebrow">Curator · 馆长席位</div>
        <h2 class="sec-title">登录你的记忆馆</h2>
        <p class="sec-sub">手机号 + 密码即可注册，无需验证码。登录后记忆体同步到云端保管柜。</p>
      </div>
      <div class="auth-card panel">
        <div class="seg" id="authSeg">
          <button class="active" data-mode="login">登录</button>
          <button data-mode="register">注册</button>
        </div>
        <div class="field" id="fPhone">
          <label for="authPhone">手机号</label>
          <input id="authPhone" type="tel" inputmode="numeric" maxlength="11" placeholder="11 位手机号" autocomplete="tel">
          <span class="err"></span>
        </div>
        <div class="field" id="fPass">
          <label for="authPass">密码</label>
          <input id="authPass" type="password" placeholder="至少 6 位" autocomplete="current-password">
          <span class="err"></span>
        </div>
        <div class="field" id="fConfirm" hidden>
          <label for="authConfirm">确认密码</label>
          <input id="authConfirm" type="password" placeholder="再输入一次" autocomplete="new-password">
          <span class="err"></span>
        </div>
        <button class="btn block" id="authSubmit">进入记忆馆</button>
        <p class="auth-hint">演示环境：账号与密码哈希仅保存在本机浏览器，不发送短信验证码，也不会上传任何服务器。</p>
      </div>`;
    let mode = 'login';
    const seg = $('#authSeg');
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      mode = b.dataset.mode;
      $$('#authSeg button').forEach((x) => x.classList.toggle('active', x === b));
      $('#fConfirm').hidden = mode !== 'register';
      $('#authSubmit').textContent = mode === 'login' ? '进入记忆馆' : '注册并开馆';
      $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      clearAuthErr();
    });
    const setErr = (id, msg) => { const f = $('#' + id); f.classList.toggle('invalid', !!msg); f.querySelector('.err').textContent = msg || ''; };
    const clearAuthErr = () => ['fPhone', 'fPass', 'fConfirm'].forEach((i) => setErr(i, ''));
    $('#authSubmit').addEventListener('click', async () => {
      clearAuthErr();
      const phone = $('#authPhone').value.trim(), pass = $('#authPass').value;
      let ok = true;
      if (!validPhone(phone)) { setErr('fPhone', '请输入有效的 11 位手机号'); ok = false; }
      if (pass.length < 6) { setErr('fPass', '密码至少 6 位'); ok = false; }
      if (mode === 'register' && $('#authConfirm').value !== pass) { setErr('fConfirm', '两次密码不一致'); ok = false; }
      if (!ok) return;
      const btn = $('#authSubmit'); btn.disabled = true;
      const hash = await hashPass(pass);
      if (mode === 'register') {
        if (users.some((x) => x.phone === phone)) { setErr('fPhone', '该手机号已注册，请直接登录'); btn.disabled = false; return; }
        const user = { phone, hash, nickname: '馆长_' + phone.slice(-4), createdAt: today() };
        users.push(user); save('splatmem.users', users);
        session = { phone }; save('splatmem.session', session);
        Sound.chime();
        toast(`开馆成功，欢迎你，${user.nickname}`);
      } else {
        const user = users.find((x) => x.phone === phone);
        if (!user || user.hash !== hash) { setErr('fPass', '手机号或密码不正确'); btn.disabled = false; return; }
        session = { phone }; save('splatmem.session', session);
        Sound.chime();
        toast(`欢迎回来，${user.nickname}`);
      }
      renderMe(); renderMemory();
    });
    $('#authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#authSubmit').click(); });
    return;
  }
  const usedMB = memories.length * 186;
  const quotaMB = 2048;
  wrap.innerHTML = `
    <div class="sec-head" style="margin-top:6px">
      <div class="eyebrow">Curator · 馆长席位</div>
      <h2 class="sec-title">我的记忆馆</h2>
    </div>
    <div class="profile-head panel">
      <span class="ava">${esc(u.nickname[0] || '馆')}</span>
      <div style="min-width:0">
        <h2><button id="nickBtn" style="background:none;border:0;cursor:pointer;font:inherit;color:inherit;border-bottom:1px dashed var(--line-strong)" title="点击修改昵称">${esc(u.nickname)}</button></h2>
        <div class="ph-phone">${u.phone.slice(0, 3)} **** ${u.phone.slice(7)} · 开馆于 ${u.createdAt}</div>
      </div>
      <span class="tag amber">馆长</span>
    </div>
    <div class="storage-card panel">
      <div class="st-head"><span>云端保管柜</span><span><b>${usedMB}MB</b> / ${quotaMB}MB</span></div>
      <div class="storage-bar"><span style="width:${Math.min(100, usedMB / quotaMB * 100).toFixed(1)}%"></span></div>
      <p style="font-size:11px;color:var(--faint);margin-top:9px;font-family:var(--mono);letter-spacing:.06em">${memories.length} 个记忆体 · 每个约 186MB 泼溅数据</p>
    </div>
    <div class="settings-group panel">
      <h3><span>01</span> 渲染偏好</h3>
      <div class="row field" style="margin:0">
        <label for="setQuality">渲染画质</label>
        <select id="setQuality">
          <option value="smooth">流畅 · 省电</option>
          <option value="balanced">均衡 · 推荐</option>
          <option value="ultra">极致 · 全像素</option>
        </select>
      </div>
      <div class="row ctl">
        <div class="ctl-head"><span>默认泼溅尺寸</span><output id="setOutSize">${settings.size.toFixed(2)}</output></div>
        <input type="range" id="setSize" min="40" max="320" value="${Math.round(settings.size * 100)}">
      </div>
      <div class="row ctl">
        <div class="ctl-head"><span>默认泼溅密度</span><output id="setOutDensity">${settings.density}%</output></div>
        <input type="range" id="setDensity" min="15" max="100" value="${settings.density}">
      </div>
      <div class="row"><label class="sw"><span>环境音（馆内氛围）</span><input type="checkbox" id="setAmbient" ${settings.ambient ? 'checked' : ''}><span class="track"><span class="thumb"></span></span></label></div>
      <div class="row"><label class="sw"><span>新场景自动环绕</span><input type="checkbox" id="setAuto" ${settings.auto ? 'checked' : ''}><span class="track"><span class="thumb"></span></span></label></div>
    </div>
    <div class="settings-group panel">
      <h3><span>02</span> 账号安全</h3>
      <div class="row"><button class="btn ghost sm block" id="pwToggle">修改密码</button></div>
      <div class="row" id="pwForm" hidden>
        <div class="field"><label for="pwOld">原密码</label><input id="pwOld" type="password"><span class="err"></span></div>
        <div class="field"><label for="pwNew">新密码</label><input id="pwNew" type="password" placeholder="至少 6 位"><span class="err"></span></div>
        <div class="field"><label for="pwConfirm">确认新密码</label><input id="pwConfirm" type="password"><span class="err"></span></div>
        <button class="btn sm block" id="pwSubmit">确认修改</button>
      </div>
    </div>
    <div class="me-danger">
      <button class="btn danger" id="logoutBtn">退出登录</button>
    </div>`;
  $('#setQuality').value = settings.quality;
  $('#setQuality').addEventListener('change', (e) => {
    settings.quality = e.target.value; saveSettings();
    window.__splatPixelCap = QUALITY_CAP[settings.quality];
    heroViewer?.resize(); vmViewer?.resize();
    toast('渲染画质已切换为 ' + e.target.selectedOptions[0].textContent);
  });
  $('#setSize').addEventListener('input', (e) => {
    settings.size = e.target.value / 100; saveSettings();
    $('#setOutSize').textContent = settings.size.toFixed(2);
    heroViewer?.setSize(settings.size); vmViewer?.setSize(settings.size);
  });
  $('#setDensity').addEventListener('input', (e) => {
    settings.density = +e.target.value; saveSettings();
    $('#setOutDensity').textContent = settings.density + '%';
  });
  $('#setAmbient').addEventListener('change', (e) => {
    settings.ambient = e.target.checked; saveSettings();
    Sound.setOn(settings.ambient); syncSoundBtn();
  });
  $('#setAuto').addEventListener('change', (e) => {
    settings.auto = e.target.checked; saveSettings();
    heroViewer?.setAutoRotate(settings.auto); vmViewer?.setAutoRotate(settings.auto);
  });
  $('#nickBtn').addEventListener('click', () => {
    const name = prompt('修改馆长昵称', u.nickname);
    if (name && name.trim()) { u.nickname = name.trim().slice(0, 12); save('splatmem.users', users); renderMe(); toast('昵称已更新'); }
  });
  $('#pwToggle').addEventListener('click', () => { $('#pwForm').hidden = !$('#pwForm').hidden; });
  $('#pwSubmit').addEventListener('click', async () => {
    const setErr = (id, msg) => { const f = $('#' + id).closest('.field'); f.classList.toggle('invalid', !!msg); f.querySelector('.err').textContent = msg || ''; };
    setErr('pwOld', ''); setErr('pwNew', ''); setErr('pwConfirm', '');
    const old = $('#pwOld').value, nw = $('#pwNew').value, cf = $('#pwConfirm').value;
    let ok = true;
    if (await hashPass(old) !== u.hash) { setErr('pwOld', '原密码不正确'); ok = false; }
    if (nw.length < 6) { setErr('pwNew', '新密码至少 6 位'); ok = false; }
    if (nw !== cf) { setErr('pwConfirm', '两次密码不一致'); ok = false; }
    if (!ok) return;
    u.hash = await hashPass(nw); save('splatmem.users', users);
    $('#pwForm').hidden = true;
    toast('密码已修改');
  });
  $('#logoutBtn').addEventListener('click', () => {
    session = null; save('splatmem.session', null);
    renderMe(); renderMemory();
    toast('已退出登录', { type: 'warn' });
  });
}
$('#userChip').addEventListener('click', () => switchTab('me'));

/* ================= 路由 ================= */
let currentTab = 'home';
function switchTab(name) {
  if (currentTab === name) return;
  currentTab = name;
  $$('.tab-item').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
  window.scrollTo({ top: 0 });
  if (name === 'home') { if (heroReady && heroViewer && !heroViewer.dead) heroViewer.start(); }
  else if (heroViewer && !heroViewer.dead) heroViewer.stop();
  if (name === 'memory') renderMemory();
  if (name === 'me') renderMe();
  if (name === 'samples') renderSamples();
  observeReveals();
}
$$('.tab-item').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
$('#brandBtn').addEventListener('click', () => switchTab('home'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#viewerModal').hidden) closeViewer();
    else if (!$('#drawer').hidden) closeDrawer();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { heroViewer?.stop(); vmViewer?.stop(); }
  else {
    if (currentTab === 'home' && heroReady) heroViewer?.start();
    if (!$('#viewerModal').hidden) vmViewer?.start();
  }
});

/* ================= 揭示 & 计数 ================= */
let io = null;
function observeReveals() {
  if (!io) {
    io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  }
  $$('.reveal:not(.in)').forEach((el) => io.observe(el));
}
let countersDone = false;
function runCounters() {
  if (countersDone) return;
  countersDone = true;
  $$('[data-count]').forEach((el) => {
    const target = parseFloat(el.dataset.count), dec = +(el.dataset.dec || 0);
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 1400);
      el.textContent = (target * (1 - Math.pow(1 - t, 3))).toFixed(dec);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* ================= 启动 ================= */
renderSamples();
renderMemory();
renderMe();
updateBadge();
observeReveals();
runCounters();
try {
  initHero();
} catch (err) {
  console.warn('WebGL 初始化失败，使用海报降级', err);
  heroFallback();
}