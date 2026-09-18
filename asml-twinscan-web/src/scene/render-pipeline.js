import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * 渲染管线（浏览器 WebGL 版本）。
 *
 * 默认走 **原生高画质** 路径（`off` 档）：场景以原生分辨率渲染进多重采样的 HDR 目标，
 * Bloom 原位叠加，最后做色调映射 + sRGB 输出。这条路径不引入任何时间累积，
 * 画面最锐利、也没有重影/抖动风险。
 *
 * 另保留一条 DLSS 风格的时间重建路径（`dlaa` / `quality` / `balanced` / `performance`）：
 *   1. 亚像素抖动（Halton 序列）后以缩放后的内部分辨率渲染场景；
 *   2. Bloom 作用于内部分辨率（更省、且被时间重建稳定）；
 *   3. 深度重投影 + 矩裁剪 + 深度一致性检验的时间重建（TAA/DLAA）；
 *   4. 双线性上采样回原生分辨率，再做对比度自适应的无光晕锐化；
 *   5. 色调映射 + sRGB 输出。
 * 这条路径**不在界面上暴露**，只作为内部诊断/压测入口（`?qa=1` 下由
 * `window.__twinscan.action('renderMode', ...)` 触发）。
 *
 * 稳定性要点（画面抖 / 糊的三个来源都在这条链上）：
 *   - **重投影必须用未抖动的视图投影矩阵**：亚像素抖动只能加在"当前帧渲染"的投影矩阵上。
 *     若把抖动后的矩阵也拿去做重投影，静止相机下历史帧采样位置每帧会偏最多半个像素，
 *     反馈回路一直在采样隔壁像素，静止画面也永远攒不起来 —— 表现为持续抖动 + 糊（已踩过）。
 *   - 历史帧权重必须够高，"相机是否移动"要用世界空间尺度阈值判定（不能用浮点级差值，
 *     否则每帧都判为运动 → 权重被压低 → 抖动残留）。
 *   - 历史帧裁剪用矩裁剪（均值 ± γσ）与邻域极值盒的交集；上采样用双线性 + 无光晕锐化，
 *     不能再用固定 3×3 的 tent 核（会把细节糊掉）。
 */
const PRESETS = {
  off: { label: '原生高画质', scale: 1.0, taa: false, samples: 8, sharpen: 0.0 },
  dlaa: { label: 'DLAA 抗锯齿', scale: 1.0, taa: true, samples: 0, sharpen: 0.16 },
  quality: { label: 'DLSS 质量', scale: 0.85, taa: true, samples: 0, sharpen: 0.26 },
  balanced: { label: 'DLSS 均衡', scale: 0.72, taa: true, samples: 0, sharpen: 0.34 },
  performance: { label: 'DLSS 性能', scale: 0.56, taa: true, samples: 0, sharpen: 0.44 },
};

/** 默认档：原生高画质。时间重建只留给内部诊断。 */
const DEFAULT_PRESET = 'off';


/** 相机静止/运动时的历史帧权重；静止时攒得越厚，抖动越干净（重投影正确时运动档也可以给高一些）。 */
const BLEND_STILL = 0.96;
const BLEND_MOTION = 0.82;
/** 认定相机"真的动了"的世界空间阈值：1.5mm 位移或 0.05° 旋转。 */
const MOVE_DISTANCE = 0.0015;
const MOVE_ANGLE = 0.0009;
/** 深度不一致（遮挡变化）判定：相对深度差超过 6% 就丢弃历史帧。 */
const DEPTH_REJECT = 0.06;

const halton = (index, base) => {
  let f = 1, r = 0;
  while (index > 0) { f /= base; r += f * (index % base); index = Math.floor(index / base); }
  return r;
};
const JITTERS = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

const baseVertex = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * 时间重建：深度重投影 → 邻域矩裁剪 → 深度一致性检验 → 指数混合。
 * 输出 alpha 通道写入当前帧深度，供下一帧做遮挡变化判定。
 */
const taaShader = {
  vertexShader: baseVertex,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tCurrent;
    uniform sampler2D tDepth;
    uniform sampler2D tHistory;
    uniform vec2 resolution;
    uniform mat4 invViewProjection;
    uniform mat4 prevViewProjection;
    uniform float blend;
    uniform float clipGamma;
    uniform float depthReject;
    uniform float reset;
    uniform float debug;
    varying vec2 vUv;

    vec3 rgbToYCoCg(vec3 c) {
      return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
    }
    vec3 yCoCgToRgb(vec3 y) {
      float t = y.x - y.z;
      return vec3(t + y.y, y.x + y.z, t - y.y);
    }
    float viewZ(float d) { return 1.0 / max(d, 1.0e-4); }

    void main() {
      vec2 texel = 1.0 / resolution;
      float depth = texture2D(tDepth, vUv).x;
      vec3 current = texture2D(tCurrent, vUv).rgb;

      // 3×3 邻域的均值/标准差（矩裁剪）与极值盒（拒绝运动离群值），两者取交集。
      vec3 mean = vec3(0.0), sq = vec3(0.0);
      vec3 boxLo = rgbToYCoCg(current), boxHi = boxLo;
      for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
        vec3 c = rgbToYCoCg(texture2D(tCurrent, clamp(vUv + vec2(float(x), float(y)) * texel, vec2(0.0), vec2(1.0))).rgb);
        mean += c; sq += c * c;
        boxLo = min(boxLo, c); boxHi = max(boxHi, c);
      }
      mean /= 9.0; sq /= 9.0;
      vec3 sigma = sqrt(max(sq - mean * mean, vec3(0.0)));
      vec3 lo = max(mean - clipGamma * sigma, boxLo);
      vec3 hi = min(mean + clipGamma * sigma, boxHi);

      // 用当前帧深度重建世界坐标，再投到上一帧的视口。
      vec4 world = invViewProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      world /= world.w;
      vec4 prevClip = prevViewProjection * vec4(world.xyz, 1.0);
      vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;

      vec4 history = texture2D(tHistory, clamp(prevUv, vec2(0.0), vec2(1.0)));
      float prevDepth = history.a;

      // 越界、遮挡变化、刚重置：直接采信当前帧。
      float inFront = step(1.0e-5, prevClip.w);
      float inside = inFront * step(0.0, prevUv.x) * step(prevUv.x, 1.0) * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
      float consistent = step(abs(viewZ(depth) - viewZ(prevDepth)), depthReject * viewZ(depth));

      vec3 clipped = clamp(rgbToYCoCg(history.rgb), lo, hi);
      float alpha = clamp(blend, 0.0, 0.97) * inside * consistent * (1.0 - clamp(reset, 0.0, 1.0));
      vec3 resolved = yCoCgToRgb(mix(clipped, rgbToYCoCg(current), 1.0 - alpha));

      // 诊断模式（默认关闭）：1 = 门控值，2 = 重投影坐标，3 = 深度。alpha 仍写深度以保持反馈正确。
      if (debug > 0.5) {
        vec3 probe = debug < 1.5 ? vec3(inside, consistent, alpha) : (debug < 2.5 ? vec3(prevUv, 0.0) : vec3(depth));
        gl_FragColor = vec4(probe, depth);
        return;
      }
      gl_FragColor = vec4(max(resolved, vec3(0.0)), depth);
    }`,
};

/**
 * 上采样 + 无光晕锐化。
 * 上采样交给纹理双线性（内部分辨率 → 输出分辨率），比固定 3×3 tent 核清晰得多；
 * 锐化用十字邻域反锐化掩模，并把结果夹回邻域极值，避免亮边光晕。
 * 锐化在平方根空间做（近似感知空间），暗部过冲更自然。
 */
const upscaleShader = {
  vertexShader: baseVertex,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tScene;
    uniform vec2 outTexel;
    uniform float sharpness;
    varying vec2 vUv;

    vec3 sampleScene(vec2 uv) { return texture2D(tScene, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }
    vec3 toPerceptual(vec3 c) { return sqrt(max(c, vec3(0.0))); }
    vec3 fromPerceptual(vec3 c) { return c * c; }

    void main() {
      vec3 color = sampleScene(vUv);
      if (sharpness > 0.001) {
        vec3 n = toPerceptual(sampleScene(vUv + vec2(0.0, -outTexel.y)));
        vec3 s = toPerceptual(sampleScene(vUv + vec2(0.0, outTexel.y)));
        vec3 e = toPerceptual(sampleScene(vUv + vec2(outTexel.x, 0.0)));
        vec3 w = toPerceptual(sampleScene(vUv + vec2(-outTexel.x, 0.0)));
        vec3 c = toPerceptual(color);
        vec3 mn = min(c, min(min(n, s), min(e, w)));
        vec3 mx = max(c, max(max(n, s), max(e, w)));
        vec3 blur = (n + s + e + w) * 0.25;
        color = fromPerceptual(clamp(c + (c - blur) * sharpness, mn, mx));
      }
      gl_FragColor = vec4(color, 1.0);
    }`,
};

export class RenderPipeline {
  constructor(renderer, scene, camera, { bloom = {} } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.presetName = DEFAULT_PRESET;
    this.frameIndex = 0;
    this.historyIndex = 0;
    this.resetHistory = 1;
    this.framesSinceReset = 0;
    this.lastBlend = BLEND_STILL;
    this._drawingSize = new THREE.Vector2();
    this._cameraRest = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this._invViewProjection = new THREE.Matrix4();
    this._prevViewProjection = new THREE.Matrix4();
    this._viewProjection = new THREE.Matrix4();
    this._bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), bloom.strength ?? 0.16, bloom.radius ?? 0.24, bloom.threshold ?? 1.32);
    this._output = new OutputPass();
    this._taaMaterial = new THREE.ShaderMaterial({
      ...taaShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tCurrent: { value: null },
        tDepth: { value: null },
        tHistory: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        invViewProjection: { value: new THREE.Matrix4() },
        prevViewProjection: { value: new THREE.Matrix4() },
        blend: { value: BLEND_STILL },
        clipGamma: { value: 1.6 },
        depthReject: { value: DEPTH_REJECT },
        reset: { value: 1 },
        debug: { value: 0 },
      },
    });
    this._upscaleMaterial = new THREE.ShaderMaterial({
      ...upscaleShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        outTexel: { value: new THREE.Vector2(1, 1) },
        sharpness: { value: 0 },
      },
    });
    this._taaQuad = new FullScreenQuad(this._taaMaterial);
    this._upscaleQuad = new FullScreenQuad(this._upscaleMaterial);
    this.internalSize = [0, 0];
    this.outputSize = [0, 0];
    this.rebuildTargets();
  }

  get preset() { return PRESETS[this.presetName] || PRESETS[DEFAULT_PRESET]; }

  /** 多重采样数：取档位要求与硬件上限的较小值（WebGL2 的 MAX_SAMPLES 常见为 4 / 8）。 */
  get samples() {
    const want = this.preset.samples || 0;
    if (!want) return 0;
    const max = this.renderer.capabilities?.maxSamples || 4;
    return Math.max(1, Math.min(want, max));
  }

  setPreset(name) {
    if (!PRESETS[name] || name === this.presetName) return;
    this.presetName = name;
    this.rebuildTargets();
  }

  setBloom({ strength, radius, threshold } = {}) {
    if (strength !== undefined) this._bloom.strength = strength;
    if (radius !== undefined) this._bloom.radius = radius;
    if (threshold !== undefined) this._bloom.threshold = threshold;
  }

  /** 诊断输出：0 关闭，1 门控值（RGBA=inside/consistent/alpha），2 重投影坐标，3 深度。 */
  setDebug(mode) { this._taaMaterial.uniforms.debug.value = Number(mode) || 0; }

  rebuildTargets() {
    this.renderer.getDrawingBufferSize(this._drawingSize);
    const outWidth = Math.max(Math.round(this._drawingSize.x), 8);
    const outHeight = Math.max(Math.round(this._drawingSize.y), 8);
    const width = Math.max(Math.round(outWidth * this.preset.scale), 8);
    const height = Math.max(Math.round(outHeight * this.preset.scale), 8);
    const temporal = Boolean(this.preset.taa);
    const samples = this.samples;
    // 尺寸、采样数、时间重建需求都没变时不做任何事，避免历史帧被反复清空（那会让画面一直抖）。
    if (this.internalSize[0] === width && this.internalSize[1] === height && this._samples === samples
      && this.sceneTarget && this.displayTarget && Boolean(this.history) === temporal) return;
    this.disposeTargets();
    this._samples = samples;
    this.internalSize = [width, height];
    this.outputSize = [outWidth, outHeight];
    this.sceneTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
    });
    if (temporal) {
      const depth = new THREE.DepthTexture(width, height);
      depth.format = THREE.DepthFormat;
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      this.sceneTarget.depthTexture = depth;
      this.history = [0, 1].map(() => new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false }));
    }
    this.displayTarget = new THREE.WebGLRenderTarget(outWidth, outHeight, { type: THREE.HalfFloatType, depthBuffer: false });
    this.resetHistory = 1;
    this.framesSinceReset = 0;
    this._taaMaterial.uniforms.resolution.value.set(width, height);
    this._upscaleMaterial.uniforms.outTexel.value.set(1 / outWidth, 1 / outHeight);
    this._bloom.setSize(width, height);
  }

  disposeTargets() {
    if (this.sceneTarget) {
      this.sceneTarget.depthTexture?.dispose();
      this.sceneTarget.dispose();
      this.sceneTarget = null;
    }
    this.history?.forEach(target => target.dispose());
    this.history = null;
    this.displayTarget?.dispose();
    this.displayTarget = null;
  }

  /**
   * 亚像素抖动：只加到"当前帧渲染"用的投影矩阵上。
   * 时间重建的重投影必须用未抖动的矩阵（见 render()），否则静止相机下历史帧
   * 也会被动偏移最多半个像素，采样到的永远是隔壁像素，画面就会一直抖且糊。
   */
  _applyJitter() {
    if (!this.preset.taa) return;
    const camera = this.camera;
    const [jx, jy] = JITTERS[this.frameIndex % JITTERS.length];
    const elements = camera.projectionMatrix.elements;
    elements[8] += 2 * jx / this.internalSize[0];
    elements[9] += 2 * jy / this.internalSize[1];
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  _cameraMoved() {
    const rest = this._cameraRest;
    return rest.position.distanceTo(this.camera.position) > MOVE_DISTANCE
      || rest.quaternion.angleTo(this.camera.quaternion) > MOVE_ANGLE;
  }

  render() {
    const renderer = this.renderer;
    const camera = this.camera;
    this.frameIndex++;
    // 先用干净的投影矩阵算出本帧的视图投影矩阵：时间重建的重投影必须基于它。
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this._viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._invViewProjection.copy(this._viewProjection).invert();
    this._applyJitter();

    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(this.scene, camera);

    // Bloom 在内部分辨率上原位叠加。
    this._bloom.render(renderer, null, this.sceneTarget, 0, false);

    if (this.preset.taa) {
      const moved = this._cameraMoved();
      this.lastBlend = moved ? BLEND_MOTION : BLEND_STILL;
      const rest = this._cameraRest;
      rest.position.copy(camera.position);
      rest.quaternion.copy(camera.quaternion);

      const write = 1 - this.historyIndex;
      const uniforms = this._taaMaterial.uniforms;
      uniforms.tCurrent.value = this.sceneTarget.texture;
      uniforms.tDepth.value = this.sceneTarget.depthTexture;
      uniforms.tHistory.value = this.history[this.historyIndex].texture;
      uniforms.invViewProjection.value.copy(this._invViewProjection);
      uniforms.prevViewProjection.value.copy(this._prevViewProjection);
      uniforms.blend.value = this.lastBlend;
      uniforms.clipGamma.value = moved ? 1.15 : 1.6;
      uniforms.reset.value = this.resetHistory;
      this._prevViewProjection.copy(this._viewProjection);
      renderer.setRenderTarget(this.history[write]);
      this._taaQuad.render(renderer);
      this.historyIndex = write;

      const upscale = this._upscaleMaterial.uniforms;
      upscale.tScene.value = this.history[write].texture;
      upscale.sharpness.value = this.preset.sharpen;
      renderer.setRenderTarget(this.displayTarget);
      this._upscaleQuad.render(renderer);

      this.resetHistory = 0;
      this.framesSinceReset++;
      this._output.render(renderer, null, this.displayTarget);
    } else {
      this._output.render(renderer, null, this.sceneTarget);
    }
    renderer.setRenderTarget(null);
  }

  /** 容器尺寸变化后调用（renderer 尺寸已更新）。尺寸没变则不做任何事，避免历史帧被反复清空。 */
  setSize() { this.rebuildTargets(); }

  debugState() {
    return {
      preset: this.presetName,
      label: this.preset.label,
      internal: [...this.internalSize],
      output: [...this.outputSize],
      temporal: Boolean(this.preset.taa),
      sharpen: this.preset.sharpen,
      blend: Number(this.lastBlend.toFixed(3)),
      frames_since_reset: this.framesSinceReset,
      samples: this.samples,
      bloom: { strength: this._bloom.strength, radius: this._bloom.radius, threshold: this._bloom.threshold },
    };
  }

  dispose() {
    this.disposeTargets();
    this._bloom.dispose();
    this._output.dispose();
    this._taaQuad.dispose();
    this._upscaleQuad.dispose();
    this._taaMaterial.dispose();
    this._upscaleMaterial.dispose();
  }
}

export const RENDER_PRESETS = PRESETS;
