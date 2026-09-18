import * as THREE from 'three';
import { segments_for, die_center } from '../simulation/designs.js';

const V = a => new THREE.Vector3(...a);
const clamp = value => THREE.MathUtils.clamp(value, 0, 1);
const ease = (p, a, b) => THREE.MathUtils.smoothstep(p, a, b);
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const PORT = V([-3.55, 1.49, 1.87]);
const PARK = V([-2.75, 1.48, 1.0]);
const GRIP = V([0, 0.0155, 0.24]);
const DISTANCE = 2.07;
const LANE = 0.65;
const DIE_PITCH = 0.052;
const WAFERS = { A: 'wafer_300mm', B: 'wafer_300mm_secondary' };

const glowMaterial = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false, toneMapped: false });

/** Snapshot-driven presentation only. No timers, counters, or process model are
 * advanced here. Repeated updates at the same snapshot produce the same pose. */
export class LithographyMotion {
  constructor(host) {
    this.host = host;
    this.nodes = host.nodes;
    this.ops = host.operations;
    this.effects = new THREE.Group();
    this.effects.name = 'LithographyTeachingEffects';
    host.scene.add(this.effects);
    this.measurement = V(host.manifest.education_stations?.measurement_world || [-0.82, 1.33, 0.68]);
    this.exposure = V(host.manifest.education_stations?.exposure_world || [1.25, 1.33, 0.68]);
    this.shoulderBase = this.world('handling_arm_shoulder');
    this.traceGroups = {};
    this.traceKeys = {};
    this.traceCounts = {};
    this.waferPositions = { A: this.measurement.clone(), B: this.exposure.clone() };
    this.anchors = [];
    this.tubes = [];
    this.halos = [];
    this.envelopes = [];
    this.spots = [];
    this.pulses = [];
    this.traceOffset = new THREE.Vector3();
    this.exchangeAmount = 0;
    this.forkError = 0;
    this.waferOnFork = false;
    this.carriedStage = '';
    this.actuators = [];
    for (const mesh of host.meshes.get('vacuum_gate_valve') || []) {
      if (mesh.name.includes('actuator')) this.actuators.push({ mesh, rest: mesh.position.clone() });
    }
    const rail = this.box('HandlingShoulderRail', [1, 0.05, 0.26], new THREE.MeshStandardMaterial({ color: '#263844', metalness: 0.7, roughness: 0.4 }));
    rail.position.set(-2.95, this.shoulderBase.y - 0.09, this.shoulderBase.z);
    this._buildOpticalEffects();
    this._buildAuxiliaryEffects();
  }

  box(name, size, material, parent = this.effects) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name; parent.add(mesh); return mesh;
  }

  sphere(name, radius, material, parent = this.effects) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 9), material);
    mesh.name = name; parent.add(mesh); return mesh;
  }

  world(id, operation = false) {
    return (operation ? this.ops : this.nodes).get(id)?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
  }

  position(id, x, y = 0, z = 0) { this.ops.get(id)?.position.set(x, y, z); }

  reset() {
    for (const operation of this.ops.values()) {
      operation.position.set(0, 0, 0);
      operation.quaternion.identity();
      operation.scale.set(1, 1, 1);
    }
    for (const { mesh, rest } of this.actuators) mesh.position.copy(rest);
    for (const id of Object.values(WAFERS)) for (const mesh of this.host.meshes.get(id) || []) mesh.visible = true;
  }

  update(snapshot = {}) {
    this.snapshot = snapshot;
    this.reset();
    this.traceOffset.set(0, 0, 0);
    this.currentDie = -1;
    this.forkError = 0;
    this.waferOnFork = false;
    this.carriedStage = '';
    const stages = snapshot.stages || {};
    const active = ['running', 'paused'].includes(snapshot.state);
    const base = stages.A?.station === 'exposure' ? 1 : 0;
    this.exchangeAmount = snapshot.exchange?.active ? mix(base, 1 - base, clamp(snapshot.exchange.progress)) : base;
    this._exchange(this.exchangeAmount);
    const measuring = stages.A?.station === 'measurement' ? 'A' : 'B';
    let transfer = '';
    let micro = new THREE.Vector3();
    for (const letter of ['A', 'B']) {
      const stage = stages[letter] || {};
      const p = clamp(Number(stage.progress) || 0);
      switch (stage.action) {
        case 'homing': this._homing(p); break;
        case 'measure': if (letter === measuring) micro = this._measurement(letter, p); break;
        case 'expose': this._scan(letter, p, snapshot); break;
        case 'load':
        case 'unload':
          if (letter === measuring) { transfer = letter; this._transfer(letter, stage.action, p); }
          break;
      }
    }
    for (const letter of ['A', 'B']) {
      const visible = (stages[letter]?.wafer_id || 0) > 0;
      for (const mesh of this.host.meshes.get(WAFERS[letter]) || []) mesh.visible = visible;
      if (letter !== transfer) this._placeWafer(letter, stages[letter] || {}, letter === measuring ? micro : new THREE.Vector3(), snapshot);
    }
    if (!transfer) this._armTo(PARK);
    this.carriedStage = transfer;
    this.host.scene.updateMatrixWorld(true);
    for (const letter of ['A', 'B']) this.waferPositions[letter].copy(this.world(WAFERS[letter], true));
    this._updateTraces(snapshot);
    this._updateAuxiliary(snapshot, measuring);
    this.beams.visible = Boolean(snapshot.exposing_stage) && active;
    if (this.beams.visible) this._updateBeams(Number(snapshot.elapsed_s) || 0);
  }

  _exchange(amount) {
    const lane = ease(amount, 0, 0.25) * (1 - ease(amount, 0.75, 1));
    const slide = ease(amount, 0.25, 0.75);
    this.position('wafer_stage_x', DISTANCE * slide, 0, -LANE * lane);
    this.position('wafer_stage_dual_bed', -DISTANCE * slide, 0, LANE * lane);
  }

  _homing(p) {
    const restore = 1 - ease(p, 0.58, 1);
    const x = mix(0.12, -0.075, ease(p, 0, 0.58)) * restore;
    const z = mix(0.08, -0.065, ease(p, 0, 0.58)) * restore;
    this.position('wafer_stage_x', x);
    this.position('wafer_stage_y', 0, 0, z);
    this.position('wafer_stage_dual_bed', -x, 0, -z);
    this.position('reticle_scan_stage', mix(-0.18, 0.24, ease(p, 0, 0.62)) * (1 - ease(p, 0.62, 1)));
  }

  _measurement(letter, p) {
    const sweep = Math.sin(p * TAU * 2) * 0.08;
    const lift = 0.012 * Math.sin(p * Math.PI);
    const offset = new THREE.Vector3(sweep, 0, sweep * 0.5);
    if (letter === 'A') {
      this.position('wafer_stage_x', offset.x);
      this.position('wafer_stage_y', 0, 0, offset.z);
      this.position('wafer_chuck', 0, lift);
      offset.y = lift;
    } else this.position('wafer_stage_dual_bed', -DISTANCE + offset.x, 0, offset.z);
    return offset;
  }

  _scan(letter, p, snapshot) {
    const data = snapshot.exposure_progress || {};
    if (!data.active) return;
    const key = JSON.stringify(snapshot.design || {});
    if (this.scanDesignKey !== key) { this.scanDesignKey = key; this.scanSegments = segments_for(snapshot.design || {}); }
    const segments = this.scanSegments || [];
    if (!segments.length) return;
    const die = THREE.MathUtils.clamp(data.die_index || 0, 0, 24);
    const index = THREE.MathUtils.clamp(data.segment_index || 0, 0, segments.length - 1);
    const total = data.total_segments || segments.length * 25;
    const fraction = (p * total) % 1;
    const segment = segments[index];
    const center = die_center(die);
    this.traceOffset.set((center[0] + mix(segment.a[0], segment.b[0], fraction)) * DIE_PITCH, 0, (center[1] + mix(segment.a[1], segment.b[1], fraction)) * DIE_PITCH);
    this.currentDie = die;
    if (letter === 'B') this.position('wafer_stage_dual_bed', -this.traceOffset.x, 0, -this.traceOffset.z);
    else {
      this.position('wafer_stage_x', DISTANCE - this.traceOffset.x);
      this.position('wafer_stage_y', 0, 0, -this.traceOffset.z);
    }
    this.position('reticle_scan_stage', -this.traceOffset.x * 1.2);
  }

  _moveWafer(letter, world) {
    const node = this.nodes.get(WAFERS[letter]);
    node.updateWorldMatrix(true, false);
    this.ops.get(WAFERS[letter]).position.copy(node.worldToLocal(world.clone()));
  }

  _placeWafer(letter, stage, micro, snapshot) {
    let point;
    if (snapshot.exchange?.active) {
      const slide = ease(this.exchangeAmount, 0.25, 0.75);
      const lane = ease(this.exchangeAmount, 0, 0.25) * (1 - ease(this.exchangeAmount, 0.75, 1));
      point = letter === 'A'
        ? new THREE.Vector3(mix(this.measurement.x, this.exposure.x, slide), 1.33, 0.68 - LANE * lane)
        : new THREE.Vector3(mix(this.exposure.x, this.measurement.x, slide), 1.33, 0.68 + LANE * lane);
    } else if (stage.station === 'measurement') point = this.measurement.clone().add(micro);
    else point = this.exposure.clone().sub(stage.action === 'expose' ? this.traceOffset : new THREE.Vector3());
    this._moveWafer(letter, point);
  }

  _transfer(letter, task, p) {
    // The carrier stays at its exchange-arrival position throughout unload and
    // reload. Only the robot, fork and physical wafer move between port/station.
    const home = task === 'load' ? PORT : this.measurement;
    const place = task === 'load' ? this.measurement : PORT;
    const homeLift = task === 'load' ? 0.18 : 0.30;
    const placeLift = task === 'load' ? 0.30 : 0.18;
    let target;
    if (p < 0.10) target = PARK.clone().lerp(home, ease(p, 0, 0.1));
    else if (p < 0.22) target = home.clone().add(new THREE.Vector3(0, homeLift * ease(p, 0.1, 0.22), 0));
    else if (p < 0.72) target = home.clone().add(new THREE.Vector3(0, homeLift, 0)).lerp(place.clone().add(new THREE.Vector3(0, placeLift, 0)), ease(p, 0.22, 0.72));
    else if (p < 0.86) target = place.clone().add(new THREE.Vector3(0, placeLift * (1 - ease(p, 0.72, 0.86)), 0));
    else target = place.clone().lerp(PARK, ease(p, 0.86, 1));
    this._armTo(target);
    const grip = this.forkGrip();
    // These contact phases are deterministic even when playback skips frames.
    // At either boundary the fork itself is at the pickup/drop position.
    const onFork = p >= 0.10 && p <= 0.86;
    const wafer = onFork ? grip : (p < 0.10 ? home : place);
    this._moveWafer(letter, wafer);
    this.waferOnFork = onFork;
    this.forkError = onFork ? grip.distanceTo(wafer) : 0;
  }

  forkGrip() {
    const fork = this.ops.get('handling_wafer_fork');
    if (!fork) return PARK.clone();
    fork.updateWorldMatrix(true, false);
    return fork.localToWorld(GRIP.clone());
  }

  _armTo(waferPoint) {
    const desired = waferPoint.clone();
    for (let iteration = 0; iteration < 5; iteration++) {
      this._solveArm(desired);
      const residual = waferPoint.clone().sub(this.forkGrip());
      if (residual.length() < 0.0015) break;
      desired.add(residual);
    }
  }

  _solveArm(point) {
    const shoulder = this.ops.get('handling_arm_shoulder');
    if (!shoulder) return;
    const railX = THREE.MathUtils.clamp(point.x + 1.60, -3.30, -2.60);
    shoulder.position.x = railX - this.shoulderBase.x;
    shoulder.position.y = point.y - 1.4125;
    const origin = this.world('handling_arm_shoulder');
    const first = new THREE.Vector2(0.80, -0.31), second = new THREE.Vector2(0.87, 0.47);
    const target = new THREE.Vector2(point.x - 0.12 - origin.x, point.z - 0.34 - origin.z);
    const l1 = first.length(), l2 = second.length();
    const reach = THREE.MathUtils.clamp(target.length(), Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001);
    const elbow = Math.acos(THREE.MathUtils.clamp((reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1));
    const heading = Math.atan2(target.y, target.x) - Math.atan2(l2 * Math.sin(elbow), l1 + l2 * Math.cos(elbow));
    const shoulderAngle = Math.atan2(first.y, first.x) - heading;
    const elbowAngle = Math.atan2(second.y, second.x) - Math.atan2(first.y, first.x) - elbow;
    shoulder.rotation.y = shoulderAngle;
    this.ops.get('handling_arm_forearm').rotation.y = elbowAngle;
    this.ops.get('handling_arm_wrist').rotation.y = -shoulderAngle - elbowAngle;
  }

  _buildOpticalEffects() {
    this.beams = new THREE.Group();
    this.beams.name = 'InvisibleEUV_PurpleTeachingOverlay';
    this.effects.add(this.beams);
    this.beams.visible = false;
    for (const row of this.host.manifest.education_optics?.ray_points || []) {
      if (row.part_id.startsWith('wafer_') || !this.nodes.has(row.part_id)) continue;
      const node = this.nodes.get(row.part_id);
      node.updateWorldMatrix(true, false);
      const inverseQ = node.getWorldQuaternion(new THREE.Quaternion()).invert();
      this.anchors.push({ id: row.part_id, local: node.worldToLocal(V(row.point)), normal: V(row.normal || [0, 0, 1]).applyQuaternion(inverseQ), width: row.beam_width_m || 0.3 });
    }
    // 三层同轴光束：高能细芯（近白饱和）+ 紫色柔光 + 大范围散射。
    this.beamMaterial = this._beamMaterial({ opacity: 0.40, energy: 1.95, falloff: 1.35, tint: [0.60, 0.20, 1.0], core: 0.55, flow: 6.0 });
    this.haloMaterial = this._beamMaterial({ opacity: 0.13, energy: 1.00, falloff: 1.9, tint: [0.40, 0.09, 0.92], core: 0.10, flow: 4.0 });
    this.envelopeMaterial = this._beamMaterial({ opacity: 0.040, energy: 0.68, falloff: 2.4, tint: [0.26, 0.05, 0.62], flow: 2.6 });
    const bright = glowMaterial(new THREE.Color(1.8, 0.75, 3.1));
    for (let i = 0; i < this.anchors.length; i++) {
      const tube = new THREE.Mesh(this._beamGeometry(), this.beamMaterial);
      tube.name = `ReflectedEUVVolume_${i}`; tube.frustumCulled = false; tube.renderOrder = 5;
      this.beams.add(tube); this.tubes.push(tube);
      const halo = new THREE.Mesh(this._beamGeometry(), this.haloMaterial);
      halo.name = `EUVSoftEnvelope_${i}`; halo.frustumCulled = false; halo.renderOrder = 4;
      this.beams.add(halo); this.halos.push(halo);
      const envelope = new THREE.Mesh(this._beamGeometry(), this.envelopeMaterial);
      envelope.name = `EUVAmbientScatter_${i}`; envelope.frustumCulled = false; envelope.renderOrder = 3;
      this.beams.add(envelope); this.envelopes.push(envelope);
      this.spots.push(this._spot());
    }
    // 波前包络：少量大颗粒，负责"能量在光路里推进"的观感。
    for (let i = 0; i < 8; i++) this.pulses.push(this.sphere(`LightPacket_${i}`, 0.006, bright, this.beams));
    // 锡等离子体只有微米级：小核心 + 径向衰减的贴地辉光，避免一大团泛光。
    this.sourceGlow = this.sphere('TinPlasma_TeachingGlow', 0.014, bright, this.beams);
    this.sourceHalo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._radialTexture(), color: new THREE.Color(1.35, 0.55, 2.2),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.sourceHalo.name = 'TinPlasma_SoftHalo';
    this.sourceHalo.scale.setScalar(0.085);
    this.beams.add(this.sourceHalo);
    this.slit = this.box('ExposureSlit', [0.006, 0.005, 0.034], bright, this.beams);
    this._buildParticleStream();
    this._buildImpactEffects(bright);
  }

  /**
   * 持续发射的粒子流：粒子从光源出发沿整条光路推进，越接近晶圆越亮，
   * 打到晶圆上时由 _updateImpact 迸出闪光——这就是"看得见粒子打在晶圆上"。
   */
  _buildParticleStream() {
    const count = 150;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const glow = new Float32Array(count);
    const phase = new Float32Array(count);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      phase[i] = i / count;
      // 确定性的错速：避免整排粒子齐步走，看起来像一串珠子。
      speed[i] = 0.86 + (i % 7) * 0.052;
      sizes[i] = 0.0095 + (i % 5) * 0.0032;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage));
    this.streamGeometry = geometry;
    this.streamGlow = glow;
    this.streamPhase = phase;
    this.streamSpeed = speed;
    this.streamCount = count;
    this.streamMaterial = new THREE.ShaderMaterial({
      // uScale 每帧按"画面高度 / 2 / tan(fov/2)"刷新，粒子尺寸才是真实的世界尺度。
      uniforms: { uTint: { value: new THREE.Color(0.72, 0.36, 1.0) }, uScale: { value: 1600.0 } },
      vertexShader: `attribute float aSize; attribute float aGlow;
        uniform float uScale;
        varying float vGlow;
        void main(){ vGlow = aGlow;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.05), 1.0, 64.0);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uTint; varying float vGlow;
        void main(){ float d = length(gl_PointCoord - 0.5) * 2.0;
          float alpha = pow(clamp(1.0 - d, 0.0, 1.0), 2.4);
          // 粒子核心同样向白饱和，和光束的高能芯一致。
          vec3 color = mix(uTint, vec3(1.0), clamp(vGlow - 0.65, 0.0, 1.0));
          gl_FragColor = vec4(color * vGlow * 1.9, alpha * vGlow); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false,
    });
    this.stream = new THREE.Points(geometry, this.streamMaterial);
    this.stream.name = 'EUVIncidentParticleStream';
    this.stream.frustumCulled = false;
    this.stream.renderOrder = 7;
    this.beams.add(this.stream);
  }

  /** 粒子命中晶圆的落点反馈：闪光 + 一圈向外扩散的溅射环。 */
  _buildImpactEffects(bright) {
    this.impactFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._radialTexture(), color: new THREE.Color(1.5, 0.85, 2.6),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.impactFlash.name = 'WaferImpactFlash';
    this.impactFlash.renderOrder = 8;
    this.beams.add(this.impactFlash);
    this.impactSplash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { uTint: { value: new THREE.Color(0.95, 0.55, 2.4) }, uFade: { value: 1 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform vec3 uTint; uniform float uFade; varying vec2 vUv;
        void main(){ float d = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.42, 0.78, d) * (1.0 - smoothstep(0.78, 1.0, d));
          gl_FragColor = vec4(uTint * ring * uFade, ring * uFade * 0.8); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.impactSplash.name = 'WaferImpactSplash';
    this.impactSplash.renderOrder = 7;
    this.beams.add(this.impactSplash);
    this.splashPhase = 0;
  }

  /** 反射光斑：平面 + 径向衰减，中心亮边缘消失，代替实心发光球。 */
  _spot() {
    if (!this._spotGeometry) this._spotGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(this._spotGeometry, this._footprintMaterial());
    mesh.name = 'MirrorReflectionFootprint';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    this.beams.add(mesh);
    return mesh;
  }

  _footprintMaterial() {
    if (!this._footprintMaterialCache) {
      this._footprintMaterialCache = new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(1.05, 0.24, 1.85) } },
        vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 tint; varying vec2 vUv;
          void main(){ float d=length(vUv-0.5)*2.0;
            float falloff=pow(clamp(1.0-d,0.0,1.0),2.4);
            gl_FragColor=vec4(tint*falloff,falloff*0.55); }`,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
    }
    return this._footprintMaterialCache;
  }

  /** 径向衰减辉光贴图（供精灵与光斑共用）。 */
  _radialTexture() {
    if (this._radialTextureCache) return this._radialTextureCache;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.10)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    this._radialTextureCache = new THREE.CanvasTexture(canvas);
    return this._radialTextureCache;
  }

  /**
   * 体积光束材质。
   *
   * 截面亮度取自圆柱壳的法向-视线夹角：正对相机处弦长最长、亮度最高，
   * 到轮廓边缘收干净——这才是真实光束的"中间浓、边上薄"，而不是一根发光的塑料管。
   * 再叠两级动画湍流（低频脉动 + 高频细纹）表达流动的能量，
   * 以及一层高能芯向白饱和（真实光刻光在极亮处会打到白）。
   */
  _beamMaterial({ opacity, energy, falloff, tint, core = 0.0, flow = 5.0 }) {
    return new THREE.ShaderMaterial({
      uniforms: {
        phaseTime: { value: 0 }, opacity: { value: opacity }, energy: { value: energy },
        falloff: { value: falloff }, tint: { value: new THREE.Color(...tint) },
        core: { value: core }, flow: { value: flow },
      },
      vertexShader: `varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.0); vNormal=normalize(normalMatrix*normal); vView=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform float phaseTime; uniform float opacity; uniform float energy; uniform float falloff;
        uniform vec3 tint; uniform float core; uniform float flow;
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main(){
          float facing=abs(dot(normalize(vNormal),normalize(vView)));
          float body=pow(facing,falloff);
          float endFade=smoothstep(0.0,0.045,vUv.y)*smoothstep(0.0,0.045,1.0-vUv.y);
          float slow=0.5+0.5*sin(vUv.x*9.0+vUv.y*3.2-phaseTime*flow*0.55);
          float fast=0.5+0.5*sin(vUv.x*47.0-vUv.y*6.0-phaseTime*flow*2.3);
          float turbulence=0.80+0.28*slow*slow+0.10*fast*fast*fast;
          vec3 color=tint*energy*turbulence;
          color+=vec3(1.0)*core*energy*pow(facing,3.2)*(0.75+0.25*fast);
          gl_FragColor=vec4(color,opacity*body*endFade); }`,
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    });
  }

  _beamGeometry() {
    const sides = 18;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((sides + 1) * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array((sides + 1) * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const uv = [], indices = [];
    for (let end = 0; end < 2; end++) for (let i = 0; i <= sides; i++) uv.push(i / sides, end);
    for (let i = 0; i < sides; i++) {
      indices.push(i, i + sides + 1, i + 1, i + 1, i + sides + 1, i + sides + 2);
    }
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  _loft(mesh, a, b, normalA, normalB, widthA, widthB) {
    const axis = new THREE.Vector3(0, 0, -1), up = new THREE.Vector3(0, 1, 0);
    const basis = normal => {
      let u = normal.clone().cross(axis).normalize();
      if (u.lengthSq() < 0.1) u = normal.clone().cross(up).normalize();
      return [u, normal.clone().cross(u).normalize()];
    };
    const [uA, vA] = basis(normalA), [uB, vB] = basis(normalB);
    if (uA.dot(uB) < 0) uB.negate();
    if (vA.dot(vB) < 0) vB.negate();
    const positions = mesh.geometry.getAttribute('position'), normals = mesh.geometry.getAttribute('normal');
    for (let end = 0; end < 2; end++) {
      const center = end ? b : a, u = end ? uB : uA, v = end ? vB : vA, radius = (end ? widthB : widthA) * 0.5;
      for (let side = 0; side <= 18; side++) {
        const angle = TAU * side / 18;
        const radial = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle) * 0.56);
        const point = center.clone().addScaledVector(radial, radius);
        const index = end * 19 + side;
        positions.setXYZ(index, point.x, point.y, point.z);
        radial.normalize(); normals.setXYZ(index, radial.x, radial.y, radial.z);
      }
    }
    positions.needsUpdate = normals.needsUpdate = true;
  }

  _updateBeams(elapsed) {
    const points = [], normals = [], widths = [];
    for (const anchor of this.anchors) {
      const node = this.ops.get(anchor.id);
      node.updateWorldMatrix(true, false);
      points.push(node.localToWorld(anchor.local.clone()));
      normals.push(anchor.normal.clone().applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())).normalize());
      widths.push(anchor.width);
    }
    points.push(this.exposure.clone().add(new THREE.Vector3(0, 0.012, 0)));
    normals.push(new THREE.Vector3(0, 1, 0)); widths.push(0.018);
    this.slit.position.copy(points.at(-1));
    this.sourceGlow.position.copy(points[0]);
    this.sourceHalo.position.copy(points[0]);
    this.sourceGlow.scale.setScalar(1 + 0.14 * Math.sin(elapsed * 12));
    this.beamMaterial.uniforms.phaseTime.value = elapsed;
    this.haloMaterial.uniforms.phaseTime.value = elapsed;
    this.envelopeMaterial.uniforms.phaseTime.value = elapsed;
    const lengths = [];
    for (let i = 0; i < this.tubes.length; i++) {
      // 细亮核心 + 收敛的柔光壳，代替原来与光束同宽的粗 halo。
      this._loft(this.tubes[i], points[i], points[i + 1], normals[i], normals[i + 1], widths[i] * 0.36, widths[i + 1] * 0.36);
      this._loft(this.halos[i], points[i], points[i + 1], normals[i], normals[i + 1], widths[i] * 0.62, widths[i + 1] * 0.62);
      this._loft(this.envelopes[i], points[i], points[i + 1], normals[i], normals[i + 1], widths[i], widths[i + 1]);
      this.spots[i].position.copy(points[i]).addScaledVector(normals[i], 0.004);
      this.spots[i].quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normals[i]);
      this.spots[i].scale.set(widths[i] * 0.34, 1, widths[i] * 0.21);
      lengths.push(points[i].distanceTo(points[i + 1]));
    }
    const fullLength = lengths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < this.pulses.length; i++) {
      let along = (elapsed * 3.6 + i * fullLength / this.pulses.length) % fullLength;
      for (let segment = 0; segment < lengths.length; segment++) {
        if (along <= lengths[segment] || segment === lengths.length - 1) {
          this.pulses[i].position.copy(points[segment]).lerp(points[segment + 1], clamp(along / Math.max(lengths[segment], 0.0001))); break;
        }
        along -= lengths[segment];
      }
    }
    this._updateParticleStream(elapsed, points, lengths, fullLength);
    this._updateImpact(elapsed, points.at(-1));
  }

  /** 折线光路上按归一化弧长 s 取样一个点。 */
  _pointAlong(points, lengths, total, s, out) {
    let along = s * total;
    for (let i = 0; i < lengths.length; i++) {
      if (along <= lengths[i] || i === lengths.length - 1) {
        return out.copy(points[i]).lerp(points[i + 1], clamp(along / Math.max(lengths[i], 0.0001)));
      }
      along -= lengths[i];
    }
    return out.copy(points[points.length - 1]);
  }

  /** 粒子流：相位均匀铺开 => 光源在连续不断发射，越靠近晶圆越亮。 */
  _updateParticleStream(elapsed, points, lengths, total) {
    const position = this.streamGeometry.getAttribute('position');
    const glow = this.streamGlow;
    const cursor = this._particleCursor || (this._particleCursor = new THREE.Vector3());
    for (let i = 0; i < this.streamCount; i++) {
      const s = (elapsed * 0.40 * this.streamSpeed[i] + this.streamPhase[i]) % 1;
      this._pointAlong(points, lengths, total, s, cursor);
      position.setXYZ(i, cursor.x, cursor.y, cursor.z);
      glow[i] = 0.28 + 0.72 * Math.pow(s, 1.7);
    }
    position.needsUpdate = true;
    this.streamGeometry.getAttribute('aGlow').needsUpdate = true;
    // 点尺寸按真实投影关系换算，换分辨率也不会变成一团糊。
    const buffer = this.host.renderer?.getDrawingBufferSize(new THREE.Vector2());
    const camera = this.host.camera;
    if (buffer && camera) {
      const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) || 0.315;
      this.streamMaterial.uniforms.uScale.value = (buffer.y / 2) / tan;
    }
  }

  /** 命中晶圆的落点反馈：高频闪光 + 一圈向外扩散并淡出的溅射环。 */
  _updateImpact(elapsed, waferPoint) {
    const burst = Math.pow(0.5 + 0.5 * Math.sin(elapsed * 19.0), 3.0);
    this.impactFlash.position.copy(waferPoint);
    this.impactFlash.scale.setScalar(0.050 + 0.032 * burst);
    this.impactFlash.material.opacity = 0.40 + 0.60 * burst;
    // 溅射环用独立的慢周期，避免和粒子同频显得像在闪同一盏灯。
    const phase = (elapsed * 1.8) % 1;
    const radius = 0.02 + 0.11 * phase;
    this.impactSplash.position.copy(waferPoint).add(new THREE.Vector3(0, 0.0015, 0));
    this.impactSplash.scale.set(radius, 1, radius);
    this.impactSplash.material.uniforms.uFade.value = (1 - phase) * (1 - phase) * 0.85;
  }

  _updateTraces(snapshot) {
    const design = snapshot.design || {};
    for (const letter of ['A', 'B']) {
      const stage = snapshot.stages?.[letter] || {};
      const count = Math.max(stage.exposed_segments || 0, 0);
      if (!stage.wafer_id || count <= 0) {
        if (this.traceGroups[letter]) { this.traceGroups[letter].visible = false; this.traceGroups[letter].count = 0; }
        continue;
      }
      const key = `${design.id}|${snapshot.seed_value || 0}|${stage.wafer_id}`;
      if (this.traceKeys[letter] !== key) { this._buildTraces(letter, design, stage.wafer_dies || []); this.traceKeys[letter] = key; }
      const mesh = this.traceGroups[letter];
      mesh.position.copy(this.waferPositions[letter]);
      mesh.count = Math.min(count, this.traceCounts[letter]);
      mesh.visible = mesh.count > 0;
    }
  }

  _buildTraces(letter, design, dieResults) {
    if (this.traceGroups[letter]) {
      const old = this.traceGroups[letter]; old.removeFromParent(); old.geometry.dispose(); old.material.dispose(); old.dispose();
    }
    const segments = segments_for(design);
    const capacity = 25 * segments.length;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 'white', toneMapped: false }), capacity);
    mesh.name = `EtchedCircuitTraces_${letter}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), scale = new THREE.Vector3(), point = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const accent = design.accent || [0.55, 0.86, 0.98];
    for (let die = 0; die < 25; die++) {
      const result = dieResults[die] || {};
      const center = die_center(die);
      const shift = result.shift || [0, 0];
      const color = result.passed === false ? new THREE.Color(1, 0.57, 0.30) : new THREE.Color(...accent.slice(0, 3));
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const a = [(center[0] + (shift[0] || 0) + segment.a[0]) * DIE_PITCH, (center[1] + (shift[1] || 0) + segment.a[1]) * DIE_PITCH];
        const b = [(center[0] + (shift[0] || 0) + segment.b[0]) * DIE_PITCH, (center[1] + (shift[1] || 0) + segment.b[1]) * DIE_PITCH];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        point.set((a[0] + b[0]) / 2, 0.010, (a[1] + b[1]) / 2);
        q.setFromAxisAngle(up, -Math.atan2(dz, dx));
        const broken = (result.broken || []).includes(i);
        scale.set(broken ? 0 : Math.max(Math.hypot(dx, dz), 0.00001), 0.0008, Math.max(segment.w * DIE_PITCH * 2.2, 0.002) * (result.width_scale || 1));
        matrix.compose(point, q, scale);
        mesh.setMatrixAt(die * segments.length + i, matrix);
        mesh.setColorAt(die * segments.length + i, color);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.effects.add(mesh);
    this.traceGroups[letter] = mesh;
    this.traceCounts[letter] = capacity;
  }

  _buildAuxiliaryEffects() {
    this.alignment = new THREE.Group(); this.effects.add(this.alignment);
    for (const side of [-1, 1]) {
      for (const size of [[0.06, 0.003, 0.007], [0.007, 0.003, 0.06]]) {
        const cross = this.box('AlignmentCross', size, glowMaterial('#40f0cf'), this.alignment);
        cross.position.set(side * 0.09, 0.013, 0);
      }
    }
    this.vacuum = new THREE.Group(); this.vacuum.name = 'VacuumEvacuationTeachingOverlay'; this.effects.add(this.vacuum);
    this.vacuumRing = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.012, 8, 48), glowMaterial('#ffbd59'));
    this.vacuum.add(this.vacuumRing);
    this.gas = [];
    for (let i = 0; i < 12; i++) this.gas.push(this.sphere('EvacuationPacket', 0.026, glowMaterial('#36e5c3', 0.78), this.vacuum));
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    this.vacuumCanvas = canvas;
    this.vacuumTexture = new THREE.CanvasTexture(canvas);
    this.vacuumTexture.colorSpace = THREE.SRGBColorSpace;
    this.vacuumText = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.vacuumTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.vacuumText.scale.set(1.65, 0.31, 1); this.vacuumText.renderOrder = 20;
    this.vacuum.add(this.vacuumText);
  }

  _updateAuxiliary(snapshot, measuring) {
    const action = snapshot.stages?.[measuring]?.action;
    this.alignment.visible = ['prealign', 'measure'].includes(action);
    this.alignment.position.copy(this.waferPositions[measuring] || this.measurement);
    const p = clamp(snapshot.pump?.progress || 0);
    const pumping = Boolean(snapshot.pump?.active);
    const opening = pumping ? 1 - p : snapshot.arm?.task ? 1 : 0;
    for (const { mesh, rest } of this.actuators) mesh.position.copy(rest).add(new THREE.Vector3(-0.1 * opening, 0, 0));
    this.vacuum.visible = pumping;
    if (!pumping) return;
    const anchor = this.world('vacuum_gate_valve').add(new THREE.Vector3(0, 0, 0.20));
    const pump = this.world('vacuum_turbo_pump').add(new THREE.Vector3(0, 0.24, 0.16));
    this.vacuumRing.position.copy(anchor);
    this.vacuumRing.material.color.set('#ffb33e').lerp(new THREE.Color('#17bda4'), p);
    this.vacuumText.position.copy(anchor).add(new THREE.Vector3(0, 0.55, 0.95));
    const percent = Math.round(p * 100);
    if (this.pumpPercent !== percent) {
      this.pumpPercent = percent;
      const ctx = this.vacuumCanvas.getContext('2d');
      ctx.clearRect(0, 0, 512, 96);
      ctx.font = '600 38px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
      ctx.lineWidth = 6; ctx.strokeStyle = '#11212a'; ctx.strokeText(`抽气 ${percent}% · 教学示意`, 256, 60);
      ctx.fillStyle = '#e3fff8'; ctx.fillText(`抽气 ${percent}% · 教学示意`, 256, 60);
      this.vacuumTexture.needsUpdate = true;
    }
    for (let i = 0; i < this.gas.length; i++) {
      const along = ((snapshot.elapsed_s || 0) * 0.64 + i / this.gas.length) % 1;
      this.gas[i].position.copy(anchor).lerp(pump, along).add(new THREE.Vector3(Math.sin(along * Math.PI) * 0.12, 0, 0));
      this.gas[i].scale.setScalar(mix(1, 0.35, p));
    }
  }

  debugState() {
    const traces = {};
    let traceGap = 0;
    for (const letter of ['A', 'B']) {
      const mesh = this.traceGroups[letter];
      const visible = mesh?.visible ? mesh.count : 0;
      traces[letter] = { visible_segments: visible || 0, capacity: this.traceCounts[letter] || 0, anchor: mesh?.position.toArray() || [], wafer: this.waferPositions[letter].toArray() };
      if (visible) traceGap = Math.max(traceGap, mesh.position.distanceTo(this.waferPositions[letter]));
    }
    return {
      initialized: true, beam_count: this.tubes.length, visible_beam_count: this.beams.visible ? this.tubes.length : 0,
      purple_path_is_educational: true, reflection_footprints: this.spots.length,
      particle_stream: (() => {
        const position = this.streamGeometry?.getAttribute('position');
        if (!position) return null;
        const head = this._particleCursor ? [position.getX(0), position.getY(0), position.getZ(0)] : null;
        let minGlow = Infinity, maxGlow = 0;
        for (let i = 0; i < this.streamCount; i++) { minGlow = Math.min(minGlow, this.streamGlow[i]); maxGlow = Math.max(maxGlow, this.streamGlow[i]); }
        return {
          count: this.streamCount, active: this.beams.visible, point_size_scale: +this.streamMaterial.uniforms.uScale.value.toFixed(1),
          glow_range: [+minGlow.toFixed(3), +maxGlow.toFixed(3)], head: head?.map(v => +v.toFixed(3)) || null,
          impact_opacity: +this.impactFlash.material.opacity.toFixed(3),
        };
      })(),
      stage_operation_position: this.ops.get('wafer_stage_x').position.toArray(),
      secondary_stage_position: this.ops.get('wafer_stage_dual_bed').position.toArray(),
      wafer_world_position: this.waferPositions.A.toArray(), secondary_wafer_world_position: this.waferPositions.B.toArray(),
      exchange_amount: this.exchangeAmount, wafer_on_fork: this.waferOnFork, carrying_stage: this.carriedStage,
      fork_contact_error_m: this.forkError, fork_grip_world: this.forkGrip().toArray(),
      latent_wafer_gap_m: traceGap, circuit_traces: traces, current_field: this.currentDie,
    };
  }
}
