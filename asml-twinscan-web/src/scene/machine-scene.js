import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RenderPipeline } from './render-pipeline.js';
import { LithographyMotion } from './lithography-motion.js';
import { MetrologyOptics } from './metrology-optics.js';

const v3 = a => new THREE.Vector3(...a);
// The projection pod is already an open cutaway: its rear cast plates frame
// the mirrors without obscuring the optical path, so keep those plates visible.
const GAME_CUTAWAY = ['enclosure', 'source_chamber', 'vacuum_exposure_chamber'];
const effectiveVisible = node => {
  for (let n = node; n; n = n.parent) if (!n.visible) return false;
  return true;
};

/** The imported machine is the source of geometry and stable identity. All
 * observation offsets live above authored nodes and operational offsets below
 * them, exactly as in the native viewer. This class never changes process data. */
export class MachineScene {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.parts = new Map();
    this.nodes = new Map();
    this.operations = new Map();
    this.observations = new Map();
    this.meshes = new Map();
    this.visibility = new Map();
    this.restWorld = new Map();
    this.mappingErrors = [];
    this.pickMeshes = [];
    this.mode = 'game';
    this.explodeAmount = 0;
    this.selectedId = null;
    this.follow = true;
    this.followKey = '';
    this.loaded = false;
    this.stats = { sourceMeshes: 0, renderMeshes: 0, mergedBatches: 0 };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#111f2b');
    this.scene.fog = new THREE.Fog('#172936', 25, 65);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.025, 100);
    this.camera.position.set(0, 5.0, 14);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    } catch (error) {
      throw new Error('此浏览器无法创建 WebGL 2 图形环境。请启用硬件加速，或使用新版 Chrome / Edge。' + (error?.message ? ` (${error.message})` : ''));
    }
    // 画质基线：像素比拉满到 2.0（高分屏下不再软化），ACES 色调映射保住高光滚降。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // three r186 已移除 PCFSoftShadowMap（设了会被静默降级并刷警告）。
    // 现在的 PCF 走 5 抽 Vogel 圆盘采样，柔化程度由 shadow.radius 控制，已是最高质量的那一档。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '可旋转、平移、缩放的 ASML 双台光刻机 3D 场景');
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.65, 0.3);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 38;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.zoomSpeed = 0.8;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('start', () => { this.cameraTween = null; this.manualCameraUntil = performance.now() + 7000; });
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._listeners = [];
    this._bindPointer();
    this._buildRoom();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = new RoomEnvironment();
    this.environmentTarget = pmrem.fromScene(environment, 0.045);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.62;
    environment.dispose();
    pmrem.dispose();
    // 原生高画质：多重采样 + 收紧的 bloom（只让高能量芯发光，不做大范围泛光）。
    this.pipeline = new RenderPipeline(this.renderer, this.scene, this.camera, {
      bloom: { strength: 0.16, radius: 0.24, threshold: 1.28 },
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  async load(modelUrl, manifestUrl) {
    const manifestResponse = await fetch(manifestUrl);
    if (!manifestResponse.ok) throw new Error(`部件清单加载失败 (${manifestResponse.status})`);
    this.manifest = await manifestResponse.json();
    if (!Array.isArray(this.manifest.parts)) throw new Error('部件清单缺少 parts 数组');
    if (this.manifest.coordinate_system !== 'godot_y_up') throw new Error('当前资产坐标系与 Y-up 运行时不一致');
    const gltf = await new GLTFLoader().loadAsync(modelUrl, event => {
      this.callbacks.onProgress?.(event.total ? event.loaded / event.total * 85 : 25);
    });
    this.model = gltf.scene;
    this.model.name = 'BlenderEUVTrainingMachine';
    this.scene.add(this.model);
    const indexed = new Map();
    this.model.traverse(node => {
      if (indexed.has(node.name) && node.name.startsWith('p__')) this.mappingErrors.push(`重复导入部件 ${node.name}`);
      indexed.set(node.name, node);
      if (node.isMesh) this.stats.sourceMeshes++;
    });
    for (const part of this.manifest.parts) {
      if (this.parts.has(part.part_id)) this.mappingErrors.push(`重复 part_id ${part.part_id}`);
      this.parts.set(part.part_id, part);
      this.visibility.set(part.part_id, true);
      const node = indexed.get(part.node_name);
      if (!node) { this.mappingErrors.push(`缺少节点 ${part.node_name}`); continue; }
      this.nodes.set(part.part_id, node);
      node.userData.part_id = part.part_id;
      const expected = part.rest_local_transform;
      if (expected && node.position.distanceTo(v3(expected.position)) > 0.0001) this.mappingErrors.push(`导入位移不一致 ${part.part_id}`);
      if (part.parent_id && node.parent?.name !== this.parts.get(part.parent_id)?.node_name) {
        // The parent may occur later in manifests generated by other versions.
        const parent = this.manifest.parts.find(row => row.part_id === part.parent_id);
        if (node.parent?.name !== parent?.node_name) this.mappingErrors.push(`父级不一致 ${part.part_id}`);
      }
    }
    for (const [id, node] of this.nodes) {
      const parent = node.parent;
      const offset = new THREE.Group();
      offset.name = `Observation__${id}`;
      parent.add(offset);
      offset.add(node); // add() retains authored local transforms.
      this.observations.set(id, offset);
    }
    for (const [id, node] of this.nodes) {
      const children = [...node.children];
      const operation = new THREE.Group();
      operation.name = `Operation__${id}`;
      node.add(operation);
      for (const child of children) operation.add(child);
      this.operations.set(id, operation);
    }
    this.scene.updateMatrixWorld(true);
    for (const [id, node] of this.nodes) this.restWorld.set(id, node.matrixWorld.clone());
    this._batchPartMeshes(indexed);
    this._addBranding();
    this.motion = new LithographyMotion(this);
    this.metrology = new MetrologyOptics(this);
    this.loaded = true;
    this.setMode(this.mode);
    this.setCamera('front');
    this.callbacks.onProgress?.(100);
    if (this.mappingErrors.length) throw new Error(`模型交互映射验证失败：${this.mappingErrors.slice(0, 6).join('；')}`);
    return this;
  }

  /**
   * MEASURE / EXPOSE 两块固定工位地标字的观感统一。
   * 模型里量测站文字用的是 cfv__ink（近黑 #161f26），曝光站文字是 cfv__white（#dde2e3）；
   * 同一台设备上两块地标字应当一致，这里在合批之前把量测站那块对齐到曝光站的材质。
   * 只换材质引用、不改共享材质本身，所以不会影响其它用到 cfv__ink 的部件。
   */
  _alignStationLabelMaterial(indexed) {
    const measure = indexed.get('m__wafer_station_measurement__station_label');
    const expose = indexed.get('m__wafer_station_exposure__station_label');
    if (!measure?.isMesh || !expose?.material) return;
    measure.material = expose.material;
  }

  _batchPartMeshes(indexed) {
    this._alignStationLabelMaterial(indexed);
    // Batch only the explicitly owned mesh names of one part. Child parts and
    // their pivots are never absorbed into a parent batch. Authored objects stay
    // in the tree (hidden) so source identity and reimport mapping remain intact.
    for (const [id, part] of this.parts) {
      const operation = this.operations.get(id);
      if (!operation) continue;
      const inverse = operation.matrixWorld.clone().invert();
      const buckets = new Map();
      const drawMeshes = [];
      for (const name of part.mesh_nodes || []) {
        const mesh = indexed.get(name);
        if (!mesh?.isMesh) { this.mappingErrors.push(`缺少网格 ${name}`); continue; }
        mesh.userData.part_id = id;
        const isActuator = id === 'vacuum_gate_valve' && name.includes('actuator');
        if (isActuator || Array.isArray(mesh.material)) {
          mesh.castShadow = mesh.receiveShadow = true;
          drawMeshes.push(mesh);
          this.pickMeshes.push(mesh);
          continue;
        }
        mesh.visible = false;
        // The author requested no fixed device callouts. Modelled physical
        // station labels stay part of the geometry; hover labels are DOM text.
        const key = mesh.material.uuid;
        if (!buckets.has(key)) buckets.set(key, { material: mesh.material, sources: [], geometry: [] });
        const bucket = buckets.get(key);
        let geo = mesh.geometry.clone();
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
        if (geo.index) { const nonIndexed = geo.toNonIndexed(); geo.dispose(); geo = nonIndexed; }
        for (const attr of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(attr)) geo.deleteAttribute(attr);
        if (!geo.getAttribute('normal')) geo.computeVertexNormals();
        if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
        geo.clearGroups();
        bucket.geometry.push(geo);
        bucket.sources.push(name);
      }
      for (const bucket of buckets.values()) {
        const geometry = bucket.geometry.length === 1 ? bucket.geometry[0] : mergeGeometries(bucket.geometry, false);
        if (!geometry) throw new Error(`部件 ${id} 网格合批失败`);
        if (bucket.geometry.length > 1) bucket.geometry.forEach(geo => geo.dispose());
        const material = bucket.material.clone();
        if (material.isMeshStandardMaterial) {
          material.roughness = Math.max(material.roughness, 0.24);
          material.envMapIntensity = material.metalness > 0.6 ? 0.95 : 0.45;
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `RenderBatch__${id}__${drawMeshes.length}`;
        mesh.userData = { part_id: id, source_meshes: bucket.sources, originalMaterial: material };
        mesh.castShadow = mesh.receiveShadow = true;
        operation.add(mesh);
        drawMeshes.push(mesh);
        this.pickMeshes.push(mesh);
        this.stats.mergedBatches++;
      }
      this.meshes.set(id, drawMeshes);
      this.stats.renderMeshes += drawMeshes.length;
    }
  }

  /**
   * ASML 名牌：直接用画布绘制蓝色字，不再使用 svg 图片贴图。
   * 透明底 + alphaTest，字号之外的区域完全不遮挡机壳本体。
   */
  _brandTexture() {
    if (this._brandTexCache) return this._brandTexCache;
    const canvas = document.createElement('canvas');
    canvas.width = 1064; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#3f9dff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'italic 700 236px Arial, Helvetica, sans-serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-18px';
    ctx.fillText('ASML', 532, 160);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    this._brandTexCache = texture;
    return texture;
  }

  _addBranding() {
    const texture = this._brandTexture();
    for (const [id, position, width, backing] of [
      ['enclosure_front_door_2', [-3.20, 0.78, 1.932], 1.24, false],
      ['frame_base', [-3.32, 0.28, 1.916], 0.78, true],
    ]) {
      const parent = this.operations.get(id);
      if (!parent) continue;
      const root = new THREE.Group();
      root.name = 'ASMLNameplate';
      parent.add(root);
      parent.updateWorldMatrix(true, false);
      root.position.copy(parent.worldToLocal(v3(position)));
      const h = width * 300 / 1064;
      if (backing) root.add(new THREE.Mesh(new THREE.BoxGeometry(width + 0.08, h + 0.04, 0.005), new THREE.MeshStandardMaterial({ color: '#eef2f7', roughness: 0.42, metalness: 0.25 })));
      const wordmark = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, toneMapped: false }));
      wordmark.position.z = 0.004;
      root.add(wordmark);
    }
  }

  _buildRoom() {
    this.room = new THREE.Group();
    this.room.name = 'CleanroomFacility';
    this.scene.add(this.room);
    const wall = new THREE.MeshStandardMaterial({ color: '#263944', roughness: 0.81, metalness: 0.06 });
    const panel = new THREE.MeshStandardMaterial({ color: '#344b58', roughness: 0.67, metalness: 0.12 });
    const trim = new THREE.MeshStandardMaterial({ color: '#647c88', roughness: 0.38, metalness: 0.5 });
    const floor = new THREE.MeshStandardMaterial({ color: '#233743', roughness: 0.5, metalness: 0.16 });
    const box = (name, at, size, material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.name = name;
      mesh.position.fromArray(at);
      mesh.receiveShadow = true;
      this.room.add(mesh);
      return mesh;
    };
    box('AntiStaticFloor', [0, -0.08, 0], [60, 0.08, 60], floor);
    box('CleanroomBackWall', [0, 2.7, -3.65], [15, 5.5, 0.15], wall);
    box('CleanroomLeftWall', [-7.45, 2.7, 0], [0.12, 5.5, 7.4], wall);
    box('CleanroomRightWall', [7.45, 2.7, 0], [0.12, 5.5, 7.4], wall);
    for (let x = -6.6; x <= 6.7; x += 1.65) {
      box('WallPressurePanel', [x, 2.7, -3.54], [1.5, 5.1, 0.045], panel);
      box('PanelSeam', [x + 0.8, 2.7, -3.50], [0.02, 5.1, 0.015], trim);
    }
    box('WallHorizontalRail', [0, 2.42, -3.495], [14.6, 0.03, 0.012], trim);
    for (let x = -7; x <= 7; x += 1) box('FloorTileSeam', [x, -0.034, 0], [0.012, 0.005, 12], trim);
    for (let z = -3.5; z < 5; z += 1) box('FloorTileSeam', [0, -0.034, z], [15, 0.005, 0.012], trim);
    const caution = new THREE.MeshStandardMaterial({ color: '#b89842', roughness: 0.66 });
    box('EquipmentServiceBoundary', [0, -0.026, 2.8], [11.6, 0.012, 0.055], caution);
    this.ledMaterial = new THREE.MeshStandardMaterial({ color: '#d6f4ff', emissive: '#b7e6ff', emissiveIntensity: 1.1, roughness: 0.3 });
    for (let x = -5.5; x <= 5.5; x += 2.2) {
      box('HEPAFilterHousing', [x, 5.15, -0.15], [1.7, 0.14, 2.9], panel);
      box('HEPALinearLED', [x - 0.7, 5.065, -0.15], [0.1, 0.028, 2.6], this.ledMaterial);
      box('HEPALinearLED', [x + 0.7, 5.065, -0.15], [0.1, 0.028, 2.6], this.ledMaterial);
      for (let z = -1.3; z < 1.2; z += 0.16) box('FilterGrille', [x, 5.06, z], [1.2, 0.015, 0.025], trim);
    }
    // 光照配比：主光拉强做出形体对比与硬朗的接触阴影，环境光压低避免"平"，
    // 蓝色轮廓光从机身后方勾边，配合环境贴图让金属件的反射有层次。
    this.ambient = new THREE.HemisphereLight('#c0e4f5', '#273949', 0.72);
    this.scene.add(this.ambient);
    this.key = new THREE.DirectionalLight('#fff6e6', 2.95);
    this.key.position.set(-3.5, 7, 5);
    this.key.target.position.set(0, 1.1, 0);
    this.key.castShadow = true;
    // 阴影贴图给到硬件上限（通常 4096/8192），视锥覆盖整间洁净室，靠分辨率而不是缩小视锥换锐度。
    this.key.shadow.mapSize.set(Math.min(4096, this.renderer.capabilities.maxTextureSize), Math.min(4096, this.renderer.capabilities.maxTextureSize));
    Object.assign(this.key.shadow.camera, { left: -6.5, right: 6.5, top: 5, bottom: -4.5, near: 0.1, far: 22 });
    this.key.shadow.bias = -0.00010;
    // 分辨率翻倍后单 texel 更小，normalBias 要同步收窄，否则阴影与物体接触处会脱开。
    this.key.shadow.normalBias = 0.012;
    // PCF 的采样圆盘按 shadowRadius 个 texel 展宽：给一点柔化，但保持接触阴影的锐度。
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);
    this.fill = new THREE.DirectionalLight('#9dcaff', 0.42);
    this.fill.position.set(4, 3.7, 1.5);
    this.scene.add(this.fill);
    this.rim = new THREE.DirectionalLight('#79c5fa', 1.15);
    this.rim.position.set(0, 5, -3.2);
    this.scene.add(this.rim);
    // Physical room signage is environmental context, not permanent device labels.
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 1024, 160);
    ctx.fillStyle = '#87cce4'; ctx.font = '500 52px sans-serif';
    ctx.fillText('LITHOGRAPHY LAB  /  EUV-01', 15, 65);
    ctx.fillStyle = '#738e9c'; ctx.font = '24px sans-serif';
    ctx.fillText('CONTROLLED ENVIRONMENT   ·   EDUCATIONAL SIMULATOR', 18, 112);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 0.69), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    sign.position.set(0, 4.6, -3.485);
    this.room.add(sign);
  }

  _bindPointer() {
    const element = this.renderer.domElement;
    const bind = (name, fn) => { element.addEventListener(name, fn); this._listeners.push([name, fn]); };
    bind('pointerdown', event => { this.pointerDown = [event.clientX, event.clientY, event.button]; });
    bind('pointermove', event => {
      this.lastPointer = [event.clientX, event.clientY];
      if (event.buttons) { this.callbacks.onHover?.(null, event.clientX, event.clientY); return; }
      if ((this.lastHoverTime || 0) + 45 > performance.now()) return;
      this.lastHoverTime = performance.now();
      const id = this.pick(event.clientX, event.clientY);
      this.callbacks.onHover?.(id, event.clientX, event.clientY);
      element.style.cursor = id ? 'pointer' : 'grab';
    });
    bind('pointerup', event => {
      if (!this.pointerDown || this.pointerDown[2] !== 0) return;
      if (Math.hypot(event.clientX - this.pointerDown[0], event.clientY - this.pointerDown[1]) > 5) return;
      const id = this.pick(event.clientX, event.clientY);
      if (id) { this.select(id); this.callbacks.onSelect?.(id); }
    });
    bind('dblclick', event => { const id = this.pick(event.clientX, event.clientY); if (id) this.focus(id); });
    bind('pointerleave', () => this.callbacks.onHover?.(null, 0, 0));
    bind('contextmenu', event => event.preventDefault());
  }

  pick(clientX, clientY) {
    if (!this.loaded) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes.filter(effectiveVisible), false);
    return hits[0]?.object.userData.part_id || null;
  }

  descendant(id, ancestor) {
    for (let current = id; current && this.parts.has(current); current = this.parts.get(current).parent_id) {
      if (current === ancestor) return true;
    }
    return false;
  }

  setVisible(id, visible) {
    if (!this.nodes.has(id)) return;
    this.visibility.set(id, Boolean(visible));
    this.nodes.get(id).visible = Boolean(visible);
  }

  select(id) {
    if (!this.parts.has(id)) return;
    this.selectedId = id;
    for (const [owner, meshes] of this.meshes) {
      const highlight = id !== 'machine' && this.descendant(owner, id);
      for (const mesh of meshes) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!material.emissive) continue;
          if (!material.userData.selectionRest) material.userData.selectionRest = { emissive: material.emissive.clone(), intensity: material.emissiveIntensity };
          material.emissive.copy(highlight ? new THREE.Color('#22add0') : material.userData.selectionRest.emissive);
          material.emissiveIntensity = highlight ? 0.45 : material.userData.selectionRest.intensity;
        }
      }
    }
  }

  isolate(id) {
    if (id == null) {
      if (this.isolationBackup) {
        for (const [key, visible] of this.isolationBackup) this.setVisible(key, visible);
        this.isolationBackup = null;
      }
      return;
    }
    if (!this.parts.has(id) || id === 'machine') return;
    if (!this.isolationBackup) this.isolationBackup = new Map(this.visibility);
    const subsystem = this.parts.get(id).subsystem || id;
    for (const key of this.parts.keys()) this.setVisible(key, this.descendant(key, subsystem) || this.descendant(subsystem, key));
    this.focus(subsystem);
  }

  showAll() {
    this.isolationBackup = null;
    for (const id of this.nodes.keys()) this.setVisible(id, true);
  }

  setExplode(amount) {
    this.explodeAmount = THREE.MathUtils.clamp(Number(amount) || 0, 0, 1);
    for (const [id, offset] of this.observations) offset.position.fromArray(this.parts.get(id).explode_vector || [0, 0, 0]).multiplyScalar(this.explodeAmount);
    this.scene.updateMatrixWorld(true);
  }

  restoreAssembly() { this.setExplode(0); this.focus('machine'); }

  setMode(mode) {
    const previous = this.mode;
    this.mode = mode === 'structure' ? 'structure' : 'game';
    if (!this.loaded) return;
    this.cameraTween = null;
    if (this.mode === 'game') {
      if (previous === 'structure') this.structureVisibility = new Map(this.visibility);
      this.setExplode(0);
      this.showAll();
      for (const id of GAME_CUTAWAY) this.setVisible(id, false);
      this.motion.effects.visible = true;
      if (this.lastSnapshot) this.motion.update(this.lastSnapshot);
    } else {
      this.motion.reset();
      this.motion.effects.visible = false;
      this.showAll();
      if (this.structureVisibility) for (const [id, value] of this.structureVisibility) this.setVisible(id, value);
    }
    this.select('machine');
    this.setCamera('front');
  }

  setLighting(yellow) {
    this.yellow = Boolean(yellow);
    // 注意这里的白模式取值必须与 _buildRoom() 里的初值保持一致，否则启动时会被覆盖回旧配色。
    this.key.color.set(yellow ? '#ffe2a2' : '#fff6e6');
    this.fill.color.set(yellow ? '#ffc45d' : '#9dcaff');
    this.rim.color.set(yellow ? '#e7b75a' : '#79c5fa');
    this.ambient.color.set(yellow ? '#d8b874' : '#c0e4f5');
    this.ledMaterial.color.set(yellow ? '#ffce72' : '#d6f4ff');
    this.ledMaterial.emissive.set(yellow ? '#ffad3e' : '#b7e6ff');
    this.scene.environmentIntensity = yellow ? 0.40 : 0.62;
  }

  setRenderQuality(preset) { this.pipeline?.setPreset(preset); }

  setFollow(enabled) { this.follow = Boolean(enabled); this.followKey = ''; this.manualCameraUntil = 0; }

  _bounds(id) {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const [owner, meshes] of this.meshes) {
      if (!this.descendant(owner, id)) continue;
      for (const mesh of meshes) {
        if (!effectiveVisible(mesh)) continue;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      }
    }
    return box;
  }

  focus(id) {
    if (!this.loaded) return;
    let box = this._bounds(id);
    if (box.isEmpty()) box = this._bounds('machine');
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = Math.max(size.y / (2 * Math.tan(vfov / 2)), size.x / (2 * Math.tan(vfov / 2) * this.camera.aspect)) + size.z * 0.55;
    this._moveCamera(center, direction, Math.max(0.55, distance * 1.14), true);
  }

  _moveCamera(target, direction, distance, animated = false) {
    const position = target.clone().addScaledVector(direction.normalize(), distance);
    if (animated) this.cameraTween = { from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), position, target: target.clone(), elapsed: 0 };
    else { this.camera.position.copy(position); this.controls.target.copy(target); this.controls.update(); this.cameraTween = null; }
  }

  setCamera(preset) {
    if (!this.loaded) return;
    let target, direction, distance;
    if (preset === 'metrology') {
      target = new THREE.Vector3(-.94, 1.08, .62); direction = new THREE.Vector3(.22, .45, 1); distance = 2.25;
    } else if (preset === 'optics') {
      target = new THREE.Vector3(1.30, 2.55, 0.0); direction = new THREE.Vector3(0.06, 0.10, 1); distance = 5.4;
    } else if (preset === 'stage') {
      target = new THREE.Vector3(0.23, 1.30, 0.66); direction = new THREE.Vector3(0.06, 0.57, 1); distance = 5.1;
    } else if (preset === 'fork') {
      const grip = this.motion?.forkGrip() || new THREE.Vector3(-2.6, 1.48, 1);
      target = grip.clone().add(new THREE.Vector3(1.25, 1.33, 0.68)).multiplyScalar(0.5);
      direction = new THREE.Vector3(0.28, 0.4, 1); distance = 5.5;
    } else {
      const box = this._bounds('machine');
      target = box.isEmpty() ? new THREE.Vector3(0, 1.7, 0.1) : box.getCenter(new THREE.Vector3());
      const size = box.isEmpty() ? new THREE.Vector3(9.5, 3.5, 3.7) : box.getSize(new THREE.Vector3());
      target.y -= 0.02;
      direction = preset === 'machine' ? new THREE.Vector3(0.1, 0.44, 1) : new THREE.Vector3(0, 0.22, 1);
      const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      distance = Math.max(size.x / (tan * this.camera.aspect * 2), size.y / (tan * 2)) * 1.08 + size.z * 0.35;
    }
    this._moveCamera(target, direction, distance, false);
    this.cameraPreset = preset;
  }

  _followSnapshot(snapshot) {
    if (!this.follow || performance.now() < (this.manualCameraUntil || 0)) return;
    const stages = Object.values(snapshot.stages || {});
    let key = 'front';
    if (snapshot.exchange?.active) key = 'stage';
    else if (stages.some(s => s.action === 'load' || s.action === 'unload')) key = 'fork';
    else if (stages.some(s => s.action === 'expose' || s.action === 'measure' || s.action === 'prealign')) key = 'stage';
    if (this.followKey === key) return;
    this.followKey = key;
    const from = this.camera.position.clone(), fromTarget = this.controls.target.clone();
    this.setCamera(key);
    this.cameraTween = { from, fromTarget, position: this.camera.position.clone(), target: this.controls.target.clone(), elapsed: 0 };
    this.camera.position.copy(from); this.controls.target.copy(fromTarget);
  }

  update(snapshot, delta = 0.016) {
    if (!this.loaded) return;
    this.lastSnapshot = snapshot;
    if (this.mode === 'game') { this.motion.update(snapshot); this._followSnapshot(snapshot); }
    // 量测叠加层（光栅尺 / 激光干涉仪）在流程与结构模式下都显示，便于观察布局；
    // 放在运动学更新之后，读到的就是本帧的世界位置。
    this.metrology?.update(snapshot);
    if (this.cameraTween) {
      const tween = this.cameraTween;
      tween.elapsed += Math.min(delta, 0.1);
      const t = THREE.MathUtils.smoothstep(tween.elapsed, 0, 0.85);
      this.camera.position.lerpVectors(tween.from, tween.position, t);
      this.controls.target.lerpVectors(tween.fromTarget, tween.target, t);
      if (t >= 1) this.cameraTween = null;
    }
    this.controls.update();
  }

  render() { this.pipeline.render(); }

  resize() {
    const width = Math.max(this.container.clientWidth, 1), height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.pipeline?.setSize();
  }

  debugState() {
    this.scene.updateMatrixWorld(true);
    let restError = 0;
    if (this.mode === 'structure' && this.explodeAmount === 0) for (const [id, node] of this.nodes) {
      const a = node.matrixWorld.elements, b = this.restWorld.get(id).elements;
      restError = Math.max(restError, ...a.map((x, i) => Math.abs(x - b[i])));
    }
    return {
      loaded: this.loaded, mode: this.mode, part_count: this.parts.size, mapped_count: this.nodes.size,
      mapping_errors: [...this.mappingErrors], explode: this.explodeAmount, rest_error: restError,
      selected_id: this.selectedId, yellow: Boolean(this.yellow), camera: this.cameraPreset,
      renderer: { ...this.stats, draw_calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles },
      render_pipeline: this.pipeline?.debugState() || null,
      motion: this.motion?.debugState(),
      metrology: this.metrology?.debugState() || null,
    };
  }

  dispose() {
    this.resizeObserver.disconnect();
    for (const [name, fn] of this._listeners) this.renderer.domElement.removeEventListener(name, fn);
    this.controls.dispose();
    this.metrology?.dispose();
    this.scene.traverse(node => {
      node.geometry?.dispose();
      for (const material of (Array.isArray(node.material) ? node.material : [node.material])) material?.dispose();
    });
    this.environmentTarget?.dispose();
    this.pipeline?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
