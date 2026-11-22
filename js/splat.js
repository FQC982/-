/* 拾光泼溅 · 零依赖 WebGL 高斯泼溅引擎
   真高斯椭球（位置/双轴尺度/旋转/颜色/透明度）+ 深度排序 alpha 混合
   单图已知→推测补全 · 视频多视角视差融合 · .splat/.ply 导入 */

const VERT = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec2 aScale;
attribute float aRot;
attribute float aAlpha;
attribute vec3 aInfo;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uMorph;
uniform float uTime;
uniform float uSize;
uniform float uReveal;
uniform float uProjScale;
uniform float uKnown;
uniform float uConf;
uniform float uFlat;
varying vec3 vColor;
varying float vAlpha;
varying float vDist;
varying vec2 vAx;
varying vec2 vAy;
void main() {
  float seed = aInfo.z;
  float appear = smoothstep(seed - 0.10, seed + 0.02, uReveal);
  if (uKnown > 0.5 && uKnown < 1.5 && aInfo.x > 0.5) appear = 0.0;
  if (uKnown > 1.5 && aInfo.x < 0.5) appear = 0.0;
  vec3 planePos = mix(vec3(aPos.x, aPos.y, 0.0), aPos, uFlat);
  vec3 p = mix(planePos, aPos, uMorph);
  p += uMorph * 0.012 * vec3(
    sin(uTime * 0.55 + seed * 43.0),
    cos(uTime * 0.47 + seed * 61.0),
    sin(uTime * 0.38 + seed * 83.0));
  vec4 mv = uView * vec4(p, 1.0);
  gl_Position = uProj * mv;
  float dist = max(0.15, -mv.z);
  float c = cos(aRot), s = sin(aRot);
  vec3 axv = (uView * vec4(vec3(c, s, 0.0) * aScale.x, 0.0)).xyz;
  vec3 ayv = (uView * vec4(vec3(-s, c, 0.0) * aScale.y, 0.0)).xyz;
  float k = uSize * uProjScale / dist;
  vAx = axv.xy * k;
  vAy = ayv.xy * k;
  float ps = 2.0 * max(length(vAx), length(vAy));
  float cf = ps > 96.0 ? 96.0 / ps : 1.0;
  vAx *= cf; vAy *= cf;
  gl_PointSize = clamp(ps, 0.0, 96.0) * step(0.001, appear);
  vec3 confCol = mix(vec3(0.71, 0.55, 1.0), vec3(0.56, 0.84, 0.63), clamp(aInfo.y, 0.0, 1.0));
  vColor = mix(aColor, confCol, uConf * 0.85);
  vAlpha = aAlpha * appear;
  vDist = dist;
}`;

const FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vDist;
varying vec2 vAx;
varying vec2 vAy;
uniform float uMode;
uniform float uFog;
uniform float uExposure;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float a;
  if (uMode < 0.5) {
    float det = vAx.x * vAy.y - vAx.y * vAy.x;
    if (abs(det) < 1e-5) discard;
    float u = (p.x * vAy.y - p.y * vAy.x) / det;
    float v = (-p.x * vAx.y + p.y * vAx.x) / det;
    a = exp(-(u * u + v * v) * 2.0) * vAlpha;
  } else {
    a = smoothstep(0.55, 0.30, length(p)) * vAlpha;
  }
  if (a < 0.004) discard;
  float fog = clamp(exp(-max(vDist - 1.6, 0.0) * uFog), 0.0, 1.0);
  vec3 col = vColor * (0.35 + 0.65 * fog) * uExposure;
  gl_FragColor = vec4(col * a, a);
}`;

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ]);
}

const STRIDE = 13;

export class SplatViewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    let gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    this.gl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) { this.dead = true; return; }
    this.gl = gl;
    this.uintOK = this.gl2 || !!gl.getExtension('OES_element_index_uint');
    this.count = 0;
    this.knownCount = 0; this.inferredCount = 0;
    this.isCloud = false;
    this.morph = 1; this.size = 1.5; this.fog = 0.55; this.mode = 0;
    this.known = 0; this.conf = 0;
    this.reveal = 0; this.revealTarget = 1.12;
    this.yaw = 0.0; this.pitch = 0.06; this.dist = 2.45;
    this.yawT = 0.0; this.pitchT = 0.06; this.distT = 2.45;
    this.autoRotate = opts.autoRotate !== false;
    this.speed = 0.12;
    this.autoBase = 0; this.autoPhase = 0;
    this.time = 0;
    this.running = false;
    this.pointers = new Map();
    this.pinchDist = 0;
    this._sortKey = ''; this._sortAt = 0;
    this._initGL();
    this._bindInput();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  _shader(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  _initGL() {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.loc = {};
    for (const n of ['aPos', 'aColor', 'aScale', 'aRot', 'aAlpha', 'aInfo']) this.loc[n] = gl.getAttribLocation(p, n);
    for (const n of ['uProj', 'uView', 'uMorph', 'uTime', 'uSize', 'uReveal', 'uProjScale', 'uMode', 'uFog', 'uExposure', 'uKnown', 'uConf', 'uFlat'])
      this.loc[n] = gl.getUniformLocation(p, n);
    this.buf = gl.createBuffer();
    this.ibuf = gl.createBuffer();
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    if (this.uintOK) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
  }

  _bindInput() {
    const c = this.canvas;
    this._onDown = (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      this.dragging = true;
    };
    this._onMove = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.yawT -= dx * 0.0052;
        this.pitchT = Math.max(-1.25, Math.min(1.25, this.pitchT + dy * 0.0042));
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.distT = Math.max(1.15, Math.min(6.5, this.distT * this.pinchDist / d));
        this.pinchDist = d;
      }
    };
    this._onUp = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        this.dragging = false;
        this.autoBase = this.yawT - Math.sin(this.autoPhase) * 0.42;
      }
      this.pinchDist = 0;
    };
    this._onWheel = (e) => {
      e.preventDefault();
      this.distT = Math.max(1.15, Math.min(6.5, this.distT * Math.exp(e.deltaY * 0.0011)));
    };
    c.addEventListener('pointerdown', this._onDown);
    c.addEventListener('pointermove', this._onMove);
    c.addEventListener('pointerup', this._onUp);
    c.addEventListener('pointercancel', this._onUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
  }

  resize() {
    if (this.dead) return;
    const c = this.canvas, parent = c.parentElement;
    const w = parent ? parent.clientWidth : c.clientWidth;
    const h = parent ? parent.clientHeight : c.clientHeight;
    if (!w || !h) return;
    const cap = window.__splatPixelCap || 2;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    c.style.width = w + 'px'; c.style.height = h + 'px';
    this.dpr = dpr;
    this.gl.viewport(0, 0, W, H);
    this._sortKey = '';
  }

  _upload(arr, knownCount, inferredCount) {
    const gl = this.gl;
    this.data = arr;
    this.count = arr.length / STRIDE;
    this.knownCount = knownCount;
    this.inferredCount = inferredCount;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    this.idx = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) this.idx[i] = i;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx, gl.DYNAMIC_DRAW);
    this._idxCount = this.count;
    this.depths = new Float32Array(this.count);
    this._sortKey = '';
    this._sortAt = 0;
    this.reveal = 0;
    this.start();
    return this.count;
  }

  /* 单图 / 融合帧 → 已知层 + 推测补全层 */
  buildFromSource(source, density = 0.55, fused = null) {
    if (this.dead) return 0;
    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (!sw || !sh) return 0;
    const gridW = Math.min(Math.round(150 + 300 * density), 460, sw);
    const gridH = Math.max(2, Math.round(gridW * sh / sw));
    const off = document.createElement('canvas');
    off.width = gridW; off.height = gridH;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, gridW, gridH);
    const data = ctx.getImageData(0, 0, gridW, gridH).data;
    const blurCv = document.createElement('canvas');
    blurCv.width = gridW; blurCv.height = gridH;
    const bctx = blurCv.getContext('2d', { willReadFrequently: true });
    bctx.filter = 'blur(2px)';
    bctx.drawImage(off, 0, 0);
    const blur = bctx.getImageData(0, 0, gridW, gridH).data;
    const pad = Math.max(4, Math.round(gridW * 0.3));
    const ew = gridW + pad * 2, eh = gridH + pad * 2;
    const ext = document.createElement('canvas');
    ext.width = ew; ext.height = eh;
    const ectx = ext.getContext('2d', { willReadFrequently: true });
    ectx.drawImage(off, pad, pad);
    ectx.save(); ectx.translate(pad, pad); ectx.scale(-1, 1);
    ectx.drawImage(off, 0, 0, pad, gridH, 0, 0, pad, gridH); ectx.restore();
    ectx.save(); ectx.translate(pad + gridW, pad); ectx.scale(-1, 1);
    ectx.drawImage(off, gridW - pad, 0, pad, gridH, 0, 0, pad, gridH); ectx.restore();
    ectx.save(); ectx.translate(pad, pad); ectx.scale(1, -1);
    ectx.drawImage(off, 0, 0, gridW, pad, 0, 0, gridW, pad); ectx.restore();
    ectx.save(); ectx.translate(pad, pad + gridH); ectx.scale(1, -1);
    ectx.drawImage(off, 0, gridH - pad, gridW, pad, 0, 0, gridW, pad); ectx.restore();
    ectx.filter = 'blur(3px)';
    ectx.drawImage(ext, 0, 0);
    const ed = ectx.getImageData(0, 0, ew, eh).data;
    const aspect = gridW / gridH;
    const planeH = 1.5, planeW = planeH * aspect;
    const spacing = planeH / gridH;
    const pts = [];
    let lumSum = 0, lumN = 0, known = 0, inferred = 0;
    let seedState = 1234567;
    const rand = () => (seedState = (seedState * 1664525 + 1013904223) >>> 0) / 4294967296;
    const push = (x, y, z, r, g, b, sx, sy, rot, alpha, id, conf) => {
      pts.push(x, y, z, r, g, b, sx, sy, rot, alpha, id, conf, rand());
      if (id > 0.5) inferred++; else known++;
    };
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const i = (y * gridW + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 0.05 && rand() < 0.8) continue;
        lumSum += lum; lumN++;
        const nx = x / gridW - 0.5, ny = 0.5 - y / gridH;
        const rad = Math.hypot(nx * 1.15, ny);
        const heur = -Math.pow(rad, 1.6) * 1.15 + (lum - 0.45) * 0.3 + (rand() - 0.5) * 0.12;
        let z = heur, conf = 1;
        if (fused) {
          const j = y * gridW + x;
          const t = fused.conf[j];
          z = heur * (1 - t) + fused.depth[j] * t;
          conf = 0.55 + 0.45 * Math.min(1, fused.views[j] / 4);
        }
        const sx = spacing * (2.2 + lum * 1.0 + rand() * 0.6);
        push(nx * planeW, ny * planeH, z, r, g, b, sx, sx * (0.72 + rand() * 0.55), rand() * Math.PI, Math.min(0.95, 0.25 + lum * 1.6), 0, conf);
        if (x % 2 === 0 && y % 2 === 0) {
          const bi = (y * gridW + x) * 4;
          const bl = (blur[bi] + blur[bi + 1] + blur[bi + 2]) / 765;
          push(
            nx * planeW + (rand() - 0.5) * spacing, ny * planeH + (rand() - 0.5) * spacing,
            z - 0.3 - rand() * 0.3,
            blur[bi] / 255 * 0.72, blur[bi + 1] / 255 * 0.72, blur[bi + 2] / 255 * 0.72,
            spacing * 3.0, spacing * 2.5, rand() * Math.PI, 0.04 + bl * 0.22, 1, 0.25 + rand() * 0.2
          );
        }
      }
    }
    for (let y = 0; y < eh; y += 4) {
      for (let x = 0; x < ew; x += 4) {
        const ox = x < pad ? pad - x : x >= pad + gridW ? x - (pad + gridW - 1) : 0;
        const oy = y < pad ? pad - y : y >= pad + gridH ? y - (pad + gridH - 1) : 0;
        const d = Math.max(ox, oy) / pad;
        if (d <= 0) continue;
        const i = (y * ew + x) * 4;
        const nx = (x - pad) / gridW - 0.5, ny = 0.5 - (y - pad) / gridH;
        const rad = Math.hypot(nx * 1.15, ny);
        const conf = Math.max(0.06, 0.45 * (1 - d));
        const el = (ed[i] + ed[i + 1] + ed[i + 2]) / 765;
        push(
          nx * planeW, ny * planeH,
          -Math.pow(rad, 1.6) * 1.15 - 0.45 - 0.5 * d,
          ed[i] / 255 * 0.35, ed[i + 1] / 255 * 0.35, ed[i + 2] / 255 * 0.35,
          spacing * 4.0, spacing * 3.4, rand() * Math.PI, (0.05 + el * 0.2) * (1 - d * 0.7), 1, conf
        );
      }
    }
    this.isCloud = false;
    this.exposure = Math.max(0.8, Math.min(1.5, 1.0 / (lumSum / Math.max(1, lumN))));
    return this._upload(new Float32Array(pts), known, inferred);
  }

  /* 视频多视角：块匹配视差 → 三角化深度 → 融合 */
  buildFromVideo(frames, density = 0.55) {
    if (this.dead || !frames || !frames.length) return 0;
    const src = frames[Math.floor(frames.length / 2)];
    const sw = src.width, sh = src.height;
    const gridW = Math.min(Math.round(150 + 300 * density), 460, sw);
    const gridH = Math.max(2, Math.round(gridW * sh / sw));
    const fused = fuseFrames(frames, gridW, gridH);
    return this.buildFromSource(src, density, fused);
  }

  /* 导入的真 3DGS 点云（.splat / .ply） */
  buildFromCloud(cloud) {
    if (this.dead) return 0;
    const n = cloud.count;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += cloud.pos[i * 3]; cy += cloud.pos[i * 3 + 1]; cz += cloud.pos[i * 3 + 2]; }
    cx /= n; cy /= n; cz /= n;
    let ext = 0.0001;
    for (let i = 0; i < n; i++) {
      ext = Math.max(ext, Math.abs(cloud.pos[i * 3] - cx), Math.abs(cloud.pos[i * 3 + 1] - cy), Math.abs(cloud.pos[i * 3 + 2] - cz));
    }
    const k = 0.85 / ext;
    const pts = new Float32Array(n * STRIDE);
    let seedState = 987654321;
    const rand = () => (seedState = (seedState * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      pts[o] = (cloud.pos[i * 3] - cx) * k;
      pts[o + 1] = (cloud.pos[i * 3 + 1] - cy) * k;
      pts[o + 2] = (cloud.pos[i * 3 + 2] - cz) * k - 0.4;
      pts[o + 3] = cloud.col[i * 3]; pts[o + 4] = cloud.col[i * 3 + 1]; pts[o + 5] = cloud.col[i * 3 + 2];
      pts[o + 6] = cloud.scale[i * 2] * k; pts[o + 7] = cloud.scale[i * 2 + 1] * k;
      pts[o + 8] = cloud.rot[i];
      pts[o + 9] = cloud.alpha[i];
      pts[o + 10] = 0; pts[o + 11] = 1; pts[o + 12] = rand();
    }
    this.isCloud = true;
    this.exposure = 1.05;
    return this._upload(pts, n, 0);
  }

  async loadImage(url, density) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return this.buildFromSource(img, density);
  }

  setMorph(v) { this.morph = v; }
  setSize(v) { this.size = v; }
  setFog(v) { this.fog = v; }
  setMode(m) { this.mode = m === 'point' ? 1 : 0; }
  setSpeed(v) { this.speed = v; }
  setAutoRotate(b) { this.autoRotate = b; }
  setKnown(v) { this.known = v === 'known' ? 1 : v === 'inferred' ? 2 : 0; }
  setConf(b) { this.conf = b ? 1 : 0; }
  resetView() { this.yawT = 0; this.pitchT = 0.06; this.distT = 2.45; this.autoBase = 0; this.autoPhase = 0; }
  randomView() {
    this.autoBase = (Math.random() - 0.5) * 1.6;
    this.yawT = this.autoBase;
    this.pitchT = (Math.random() - 0.5) * 0.7;
    this.distT = 1.7 + Math.random() * 1.6;
  }

  start() {
    if (this.dead || this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this.time += dt;
      if (this.autoRotate && !this.dragging) {
        this.autoPhase += dt * (0.25 + this.speed * 2.0);
        this.yawT = this.autoBase + Math.sin(this.autoPhase) * 0.42;
      }
      const k = 1 - Math.pow(0.0015, dt);
      this.yaw += (this.yawT - this.yaw) * k;
      this.pitch += (this.pitchT - this.pitch) * k;
      this.dist += (this.distT - this.dist) * k;
      this.reveal += (this.revealTarget - this.reveal) * Math.min(1, dt * 1.6);
      this._render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  /* 计数排序：远→近，保证 alpha 混合正确 */
  _sort(view) {
    const n = this.count, d = this.data, depths = this.depths;
    const m2 = view[2], m6 = view[6], m10 = view[10], m14 = view[14];
    const morph = this.isCloud ? 1 : this.morph;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const z = d[o + 2] * morph;
      const vz = m2 * d[o] + m6 * d[o + 1] + m10 * z + m14;
      const dep = -vz;
      depths[i] = dep;
      if (dep < min) min = dep;
      if (dep > max) max = dep;
    }
    const B = 512, span = Math.max(1e-6, max - min);
    const counts = new Uint32Array(B);
    for (let i = 0; i < n; i++) counts[Math.min(B - 1, ((depths[i] - min) / span * (B - 1)) | 0)]++;
    const starts = new Uint32Array(B);
    let acc = 0;
    for (let b = B - 1; b >= 0; b--) { starts[b] = acc; acc += counts[b]; }
    const idx = this.idx;
    for (let i = 0; i < n; i++) {
      const b = Math.min(B - 1, ((depths[i] - min) / span * (B - 1)) | 0);
      idx[starts[b]++] = i;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    this._idxCount = n;
  }

  _render() {
    const gl = this.gl, c = this.canvas;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.count) return;
    gl.useProgram(this.prog);
    const cp = Math.cos(this.pitch), eye = [
      Math.sin(this.yaw) * cp * this.dist,
      Math.sin(this.pitch) * this.dist,
      Math.cos(this.yaw) * cp * this.dist,
    ];
    const view = lookAt(eye, [0, 0, -0.55], [0, 1, 0]);
    gl.uniformMatrix4fv(this.loc.uProj, false, perspective(0.9, c.width / c.height, 0.1, 30));
    gl.uniformMatrix4fv(this.loc.uView, false, view);
    gl.uniform1f(this.loc.uMorph, this.morph);
    gl.uniform1f(this.loc.uTime, this.time);
    gl.uniform1f(this.loc.uSize, this.size);
    gl.uniform1f(this.loc.uReveal, this.reveal);
    gl.uniform1f(this.loc.uProjScale, c.height / (2 * Math.tan(0.45)));
    gl.uniform1f(this.loc.uMode, this.mode);
    gl.uniform1f(this.loc.uFog, this.fog);
    gl.uniform1f(this.loc.uExposure, this.exposure || 1);
    gl.uniform1f(this.loc.uKnown, this.known);
    gl.uniform1f(this.loc.uConf, this.conf);
    gl.uniform1f(this.loc.uFlat, this.isCloud ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = STRIDE * 4;
    const ptr = (name, size, off) => {
      gl.enableVertexAttribArray(this.loc[name]);
      gl.vertexAttribPointer(this.loc[name], size, gl.FLOAT, false, stride, off);
    };
    ptr('aPos', 3, 0); ptr('aColor', 3, 12); ptr('aScale', 2, 24);
    ptr('aRot', 1, 32); ptr('aAlpha', 1, 36); ptr('aInfo', 3, 40);
    if (this.uintOK) {
      const key = [this.yaw.toFixed(3), this.pitch.toFixed(3), this.dist.toFixed(3), this.morph.toFixed(2)].join('|');
      const now = performance.now();
      if (this._idxCount !== this.count || (key !== this._sortKey && now - this._sortAt > 90)) {
        this._sort(view);
        this._sortKey = key; this._sortAt = now;
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
      gl.drawElements(gl.POINTS, this.count, gl.UNSIGNED_INT, 0);
    } else {
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
  }

  snapshot() {
    if (this.dead) return null;
    this._render();
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    this.stop();
    if (this._ro) this._ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onDown);
    c.removeEventListener('pointermove', this._onMove);
    c.removeEventListener('pointerup', this._onUp);
    c.removeEventListener('pointercancel', this._onUp);
    c.removeEventListener('wheel', this._onWheel);
    if (!this.dead) {
      const gl = this.gl;
      gl.deleteBuffer(this.buf);
      gl.deleteBuffer(this.ibuf);
      gl.deleteProgram(this.prog);
    }
    this.dead = true;
  }
}

/* 块匹配视差 → 每格三角化深度 / 置信度 / 被见帧数 */
export function fuseFrames(frames, gridW, gridH) {
  const gw = 96, gh = 72, BS = 8;
  const bw = gw / BS, bh = gh / BS;
  const grays = frames.map((f) => {
    const cv = document.createElement('canvas');
    cv.width = gw; cv.height = gh;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(f, 0, 0, gw, gh);
    const d = cx.getImageData(0, 0, gw, gh).data;
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    return g;
  });
  const depthAcc = new Float32Array(bw * bh), confAcc = new Float32Array(bw * bh), viewAcc = new Float32Array(bw * bh);
  let pairs = 0;
  for (let f = 0; f + 1 < grays.length; f++) {
    const A = grays[f], B = grays[f + 1];
    pairs++;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let best = Infinity, bestD = 0, sum = 0, cnt = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            let sad = 0, n = 0;
            for (let y = 0; y < BS; y += 2) {
              const ay = by * BS + y, byy = ay + dy;
              if (byy < 0 || byy >= gh) continue;
              for (let x = 0; x < BS; x += 2) {
                const ax = bx * BS + x, bxx = ax + dx;
                if (bxx < 0 || bxx >= gw) continue;
                sad += Math.abs(A[ay * gw + ax] - B[byy * gw + bxx]); n++;
              }
            }
            if (!n) continue;
            sad /= n; sum += sad; cnt++;
            if (sad < best) { best = sad; bestD = Math.hypot(dx, dy); }
          }
        }
        if (!cnt) continue;
        const mean = sum / cnt;
        const conf = Math.max(0, Math.min(1, 1 - best / (mean + 1e-4)));
        const j = by * bw + bx;
        depthAcc[j] += 0.9 / (bestD + 0.6);
        confAcc[j] += conf;
        if (conf > 0.3) viewAcc[j]++;
      }
    }
  }
  const depth = new Float32Array(gridW * gridH), conf = new Float32Array(gridW * gridH), views = new Float32Array(gridW * gridH);
  let dMin = Infinity, dMax = -Infinity;
  for (let j = 0; j < bw * bh; j++) {
    const v = depthAcc[j] / Math.max(1, pairs);
    if (v < dMin) dMin = v;
    if (v > dMax) dMax = v;
  }
  const span = Math.max(1e-6, dMax - dMin);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const bx = Math.min(bw - 1, (x / gridW * bw) | 0), by = Math.min(bh - 1, (y / gridH * bh) | 0);
      const j = by * bw + bx, i = y * gridW + x;
      const t = (depthAcc[j] / Math.max(1, pairs) - dMin) / span;
      depth[i] = -0.62 + (t - 0.5) * 1.15;
      conf[i] = Math.max(0, Math.min(1, confAcc[j] / Math.max(1, pairs))) * 0.85;
      views[i] = viewAcc[j];
    }
  }
  return { depth, conf, views };
}

/* .splat / .ply 解析 → 真高斯椭球点云 */
export async function loadSplatFile(file) {
  const name = (file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.ksplat')) {
    throw new Error('.ksplat 为压缩格式：请在 Scaniverse 或 SuperSplat 中导出为 .splat / .ply 后导入');
  }
  if (name.endsWith('.splat')) return parseSplat(buf);
  if (name.endsWith('.ply')) return parsePly(buf);
  throw new Error('仅支持 .splat / .ply 场景文件');
}

function quatYaw(w, x, y, z) {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

function parseSplat(buf) {
  const n = Math.floor(buf.byteLength / 32);
  if (!n) throw new Error('.splat 文件为空');
  const dv = new DataView(buf);
  const step = n > 400000 ? Math.ceil(n / 400000) : 1;
  const m = Math.floor(n / step);
  const pos = new Float32Array(m * 3), col = new Float32Array(m * 3), scale = new Float32Array(m * 2), rot = new Float32Array(m), alpha = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const o = i * step * 32;
    pos[i * 3] = dv.getFloat32(o, true); pos[i * 3 + 1] = dv.getFloat32(o + 4, true); pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
    scale[i * 2] = dv.getFloat32(o + 12, true); scale[i * 2 + 1] = dv.getFloat32(o + 16, true);
    col[i * 3] = dv.getUint8(o + 24) / 255; col[i * 3 + 1] = dv.getUint8(o + 25) / 255; col[i * 3 + 2] = dv.getUint8(o + 26) / 255;
    alpha[i] = Math.max(0.05, dv.getUint8(o + 27) / 255);
    const qw = dv.getUint8(o + 28) / 128 - 1, qx = dv.getUint8(o + 29) / 128 - 1, qy = dv.getUint8(o + 30) / 128 - 1, qz = dv.getUint8(o + 31) / 128 - 1;
    rot[i] = quatYaw(qw, qx, qy, qz);
  }
  return { count: m, pos, col, scale, rot, alpha };
}

function parsePly(buf) {
  const bytes = new Uint8Array(buf);
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    head += String.fromCharCode(bytes[i]);
    if (head.endsWith('end_header\n')) break;
  }
  const end = head.indexOf('end_header\n');
  if (end < 0) throw new Error('.ply 头解析失败');
  const header = head.slice(0, end);
  if (!/format binary_little_endian/.test(header)) throw new Error('仅支持 binary_little_endian 的 .ply');
  const vertexMatch = header.match(/element vertex (\d+)/);
  if (!vertexMatch) throw new Error('.ply 缺少 vertex 元素');
  const total = +vertexMatch[1];
  const props = [];
  let inVertex = false;
  for (const line of header.split('\n')) {
    if (line.startsWith('element vertex')) { inVertex = true; continue; }
    if (line.startsWith('element ') && inVertex) break;
    if (inVertex && line.startsWith('property ')) {
      const [, type, pname] = line.trim().split(/\s+/);
      props.push({ type, name: pname });
    }
  }
  const sizes = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
  const offsets = {};
  let stride = 0;
  for (const p of props) { offsets[p.name] = stride; stride += sizes[p.type] || 4; }
  const need = ['x', 'y', 'z'];
  for (const k of need) if (!(k in offsets)) throw new Error('.ply 缺少坐标属性');
  const dataStart = end + 'end_header\n'.length;
  const dv = new DataView(buf, dataStart);
  const step = total > 400000 ? Math.ceil(total / 400000) : 1;
  const m = Math.floor(total / step);
  const pos = new Float32Array(m * 3), col = new Float32Array(m * 3), scale = new Float32Array(m * 2), rot = new Float32Array(m), alpha = new Float32Array(m);
  const read = (o, name, def) => {
    if (!(name in offsets)) return def;
    const p = props.find((x) => x.name === name);
    const at = o + offsets[name];
    switch (p.type) {
      case 'float': return dv.getFloat32(at, true);
      case 'double': return dv.getFloat64(at, true);
      case 'uchar': return dv.getUint8(at);
      case 'char': return dv.getInt8(at);
      case 'short': return dv.getInt16(at, true);
      case 'ushort': return dv.getUint16(at, true);
      case 'int': return dv.getInt32(at, true);
      case 'uint': return dv.getUint32(at, true);
      default: return def;
    }
  };
  const SH = 0.28209479177387814;
  for (let i = 0; i < m; i++) {
    const o = i * step * stride;
    pos[i * 3] = read(o, 'x', 0); pos[i * 3 + 1] = read(o, 'y', 0); pos[i * 3 + 2] = read(o, 'z', 0);
    const r = read(o, 'f_dc_0', null);
    if (r === null) {
      col[i * 3] = read(o, 'red', 128) / 255; col[i * 3 + 1] = read(o, 'green', 128) / 255; col[i * 3 + 2] = read(o, 'blue', 128) / 255;
    } else {
      col[i * 3] = Math.max(0, Math.min(1, 0.5 + SH * r));
      col[i * 3 + 1] = Math.max(0, Math.min(1, 0.5 + SH * read(o, 'f_dc_1', 0)));
      col[i * 3 + 2] = Math.max(0, Math.min(1, 0.5 + SH * read(o, 'f_dc_2', 0)));
    }
    const op = read(o, 'opacity', null);
    alpha[i] = op === null ? 0.9 : Math.max(0.05, 1 / (1 + Math.exp(-op)));
    const s0 = read(o, 'scale_0', null);
    if (s0 === null) { scale[i * 2] = 0.012; scale[i * 2 + 1] = 0.012; }
    else {
      scale[i * 2] = Math.exp(s0);
      scale[i * 2 + 1] = Math.exp(read(o, 'scale_1', s0));
    }
    rot[i] = quatYaw(read(o, 'rot_0', 1), read(o, 'rot_1', 0), read(o, 'rot_2', 0), read(o, 'rot_3', 0));
  }
  return { count: m, pos, col, scale, rot, alpha };
}

/* 视频抽帧：返回 { frames: [canvas...], best: canvas } */
export async function extractFrames(file, n = 6) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('视频无法解码'));
      setTimeout(() => rej(new Error('视频加载超时')), 15000);
    });
    const dur = Math.min(video.duration || 1, 60);
    const w = 320, h = Math.max(2, Math.round(w * (video.videoHeight || 9) / (video.videoWidth || 16)));
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = dur * (0.08 + 0.84 * i / (n - 1));
      await new Promise((res, rej) => {
        video.onseeked = res;
        video.onerror = () => rej(new Error('抽帧失败'));
        video.currentTime = t;
        setTimeout(res, 2500);
      });
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(video, 0, 0, w, h);
      frames.push(cv);
    }
    let best = frames[0], bestScore = -1;
    for (const f of frames) {
      const d = f.getContext('2d').getImageData(0, 0, f.width, f.height).data;
      let score = 0;
      for (let i = 0; i < d.length; i += 16) score += d[i] + d[i + 1] + d[i + 2];
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return { frames, best, duration: dur };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}