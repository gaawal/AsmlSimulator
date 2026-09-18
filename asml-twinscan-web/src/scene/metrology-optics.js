import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { StageMetrology } from './stage-metrology.js';

/**
 * 量测光学教学叠加层：掩模台光栅尺 + 工件台激光干涉仪 + 零位模块。
 *
 * 布局按真实双频激光干涉仪的安装方式组织（部件命名与 3D 模型部件提示词一致）：
 *   · 激光干涉仪本体（LaserInterferometerAssembly）—— 4 组深灰色长方体金属模块，
 *     固定在基座四周 / 两工位之间，绝不随台运动；测量光束水平射向台侧平面镜，
 *     本体上带透明光学窗口，多光束出口用于位移 + 角度测量。
 *   · 平面反射镜（PlaneMirror）—— 每台 2 条（X 向 + Y 向）长条高反镜面 + 铝合金镜座，
 *     在台体侧面呈 L 形（90° 夹角）布置，随台运动。
 *   · 角锥反射镜（CornerCubeReflector）—— 每台 3 个 30mm 级切角立方体，
 *     装在台体底面、50mm 等距一字排列，弦面（大圆端面）朝下，随台运动。
 *   · PSD 零位传感器（PSDZeroPositionSensor）—— 测量位 / 曝光位各 3 组固定在基座上，
 *     位于台体行程下方、感光窗朝上；零位标定时检测光自下而上打在台底角锥的弦面上，
 *     经三个互垂面反射后平行返回感光面——与干涉仪的水平测量光分工明确、互不干扰。
 *
 * 覆盖策略（对应"两个台子始终被连续盯住、不能有测量盲区"）：
 *   · X 轴全程无盲区：左岸本体 3 条光束沿 Z 排开（间隔 0.64m），盖住换台闪避的
 *     全深度；两工位之间的本体负责曝光位。任一时刻两个台子都有 X 光束锁定，
 *     且视线判定会滤掉被另一台体挡住的光路。
 *   · Z 轴在工位全覆盖：测量位 / 曝光位各一组本体（3 出口，覆盖工位 ±0.26m 的
 *     扫描行程）。高速换台滑移途中 Z 光束短暂脱锁——真实机器同样受平面镜长度
 *     限制做此权衡，回到工位立即重新锁定。
 *   · 光束只在真正命中镜面 / 角锥时才绘制：台子不在光路里就熄灭，绝无假反射。
 *
 * 几何按真实尺寸落在世界坐标里（1 单位 ≈ 1 m）；运动部件每帧按 snapshot 更新，
 * 同一 snapshot 更新多次得到同一姿态。
 */

/** 光栅尺：标尺固定在掩模桥上，读数头挂在掩模扫描滑台上随台一起扫。 */
const SCALE_HALF = 0.42;
const RULING_COUNT = 36;

/**
 * 台侧平面镜：厚 10mm、高 50mm 的长条镜面。
 * X 向镜条沿 Z 展开 0.80m——换台车道深度就有 0.65m，镜条必须比它长，
 * 左岸本体的固定光束才能全程咬住台体（规格 300~500mm 在此行程下不够）。
 * Y 向镜条（场景 Z 轴测量）沿 X 展开 0.55m，覆盖工位扫描行程。
 */
const MIRROR_GAP = 0.018;
const MIRROR_THICK = 0.012;
const MIRROR_HEIGHT = 0.052;
const MIRROR_HALF_Z = 0.40;
const MIRROR_HALF_X = 0.275;
const MIRROR_Y = 1.10;
const LASER_Y = 1.10;

/**
 * 4 组固定干涉仪本体（150×80×60mm 级长方体 + 光学窗口 + 多光束出口）。
 * exits 是各出口的世界坐标：光束从这里水平射向台侧镜面。
 * X_Left 的 3 条光束沿 Z 排开做接力；两工位之间的 X_Right 专管曝光位
 * （换台闪避先于滑移发生，所以它待在 z=车道基线的空档里绝不会被撞）。
 */
const IFM_ASSEMBLIES = [
  {
    id: 'X_Left', axis: 'x', origin: [-2.35, LASER_Y, 0.68],
    exits: [[-2.275, LASER_Y, 0.36], [-2.275, LASER_Y, 0.68], [-2.275, LASER_Y, 1.00]],
  },
  {
    id: 'X_Right', axis: 'x', origin: [-0.10, LASER_Y, 0.68],
    exits: [[-0.025, LASER_Y, 0.68]],
  },
  {
    id: 'Z_Measurement', axis: 'z', origin: [-0.82, LASER_Y, -1.065],
    exits: [[-0.98, LASER_Y, -0.99], [-0.82, LASER_Y, -0.99], [-0.66, LASER_Y, -0.99]],
  },
  {
    id: 'Z_Exposure', axis: 'z', origin: [1.25, LASER_Y, -1.065],
    exits: [[1.09, LASER_Y, -0.99], [1.25, LASER_Y, -0.99], [1.41, LASER_Y, -0.99]],
  },
];

/** 光出口到镜面的最小安全间距：小于它说明光轴已经贴进台体，判为不可用。 */
const CLEARANCE = 0.42;
const POST_BOTTOM_OFFSET = 0.02;
const POST_XZ = 0.026;

/**
 * 零位模块：台底 3 个角锥（弦面朝下）+ 工位下方 3 组 PSD（感光窗朝上）。
 * 角锥 30mm 级（半边长 16mm），切角立方体；PSD 20mm 级黑色封装。
 */
const CUBE_S = 0.016;
const CUBE_PITCH = 0.05;
const CUBE_HANG = 0.02;
const CUBE_CHORD = 0.808 * CUBE_S; // 弦面到角锥中心的距离（切角平面 x+y+z=-1.4）
const PSD_STAND_H = 0.026;
const PSD_BODY = [0.026, 0.014, 0.026];
const PSD_TOL_X = 0.03;
const PSD_TOL_Z = 0.05;

/** 待机 / 校准时的激光强度。 */
const IDLE = 0.30;
const ACTIVE = 1;

const clamp01 = value => THREE.MathUtils.clamp(value, 0, 1);
const _scratchA = new THREE.Vector3();
const _scratchB = new THREE.Vector3();
const _scratchPoint = new THREE.Vector3();

export class MetrologyOptics {
  constructor(host) {
    // New Blender assets own all metrology hardware and IDs. Keep the legacy
    // overlay only for old assets, rather than drawing a second set of mirrors.
    if (host.manifest.education_metrology?.schema_version === 1) return new StageMetrology(host);
    this.host = host;
    this.group = new THREE.Group();
    this.group.name = 'MetrologyTeachingOverlay';
    host.scene.add(this.group);

    this.beams = [];
    this.heads = [];
    this.state = 'idle';
    this.level = IDLE;

    this._measureStations();
    this._buildMirrors();
    this._buildCornerCubes();
    this._buildInterferometers();
    this._buildZeroModule();
    this._buildEncoder();
    this.update({});
  }

  // ------------------------------------------------------------ 实测模型尺寸

  _measureStations() {
    const host = this.host;
    const box = id => host._bounds(id);
    const boxA = box('wafer_stage_x');
    const boxB = box('wafer_stage_dual_bed');
    const centerA = boxA.getCenter(new THREE.Vector3());
    const centerB = boxB.getCenter(new THREE.Vector3());
    const size = boxA.getSize(new THREE.Vector3());

    this.carriage = { halfX: size.x / 2, halfZ: size.z / 2, bottom: boxA.min.y, top: boxA.max.y };
    this.stations = { A: centerA, B: centerB };
    // 工件台只做平移，所以"包围盒中心 - 节点原点"是常量，可直接外推到任意时刻。
    this.centerOffset = {};
    for (const [letter, id] of [['A', 'wafer_stage_x'], ['B', 'wafer_stage_dual_bed']]) {
      const node = host.operations.get(id);
      node.updateWorldMatrix(true, false);
      this.centerOffset[letter] = this.stations[letter].clone().sub(node.getWorldPosition(new THREE.Vector3()));
    }
    // A 台的 Z 向微动走子节点 wafer_stage_y：记下它相对父节点的初始局部 Z，
    // 之后按"局部 Z 增量"修正台心（子节点的世界坐标已含父节点位移，不能直接用）。
    this.stageYNode = host.operations.get('wafer_stage_y') || host.nodes.get('wafer_stage_y') || null;
    this.stageYLocal0 = 0;
    if (this.stageYNode) {
      const restY = this.stationOf('wafer_stage_y');
      const restA = host.operations.get('wafer_stage_x');
      this.stageYLocal0 = restY.z - restA.getWorldPosition(new THREE.Vector3()).z;
    }
    // 基座顶面：PSD 支柱与干涉仪立柱都从它起身。
    const frameBox = box('frame_base');
    this.baseTop = Math.min(frameBox && !frameBox.isEmpty() ? frameBox.max.y : 0.535, 0.72);
    // 镜面相对台体中心的偏移（反射面朝外）。
    this.faceDX = this.carriage.halfX + MIRROR_GAP + MIRROR_THICK / 2;
    this.faceDZ = this.carriage.halfZ + MIRROR_GAP + MIRROR_THICK / 2;
    // 角锥弦面的世界高度（台底 - 悬挂 - 弦面偏移）。
    this.cubeChordY = this.carriage.bottom - CUBE_HANG - CUBE_CHORD;
    // 光栅尺
    this.reticleFixed = this.stationOf('reticle_grating_scale');
    this.reticleStage = this.stationOf('reticle_scan_stage');
    this.reticleReadhead = this.stationOf('reticle_grating_readhead');
  }

  stationOf(id) {
    const node = this.host.nodes.get(id);
    if (!node) return new THREE.Vector3();
    node.updateWorldMatrix(true, false);
    return node.getWorldPosition(new THREE.Vector3());
  }

  /** 运动台当前的世界中心（A = 测量位台体，B = 曝光位台体），含 A 台子节点的 Z 微动。 */
  stageCenter(letter) {
    const node = this.host.operations.get(letter === 'A' ? 'wafer_stage_x' : 'wafer_stage_dual_bed');
    if (!node) return this.stations[letter].clone();
    node.updateWorldMatrix(true, false);
    const nodePos = node.getWorldPosition(new THREE.Vector3());
    const center = nodePos.clone().add(this.centerOffset[letter]);
    if (letter === 'A' && this.stageYNode) {
      this.stageYNode.updateWorldMatrix(true, false);
      const childLocalZ = this.stageYNode.getWorldPosition(_scratchA).z - nodePos.z;
      center.z += childLocalZ - this.stageYLocal0;
    }
    return center;
  }

  // ------------------------------------------------------------ 材质与基础构件

  materials() {
    if (!this._materials) {
      this._materials = {
        mirror: new THREE.MeshStandardMaterial({ color: '#f2f7fc', metalness: 1, roughness: 0.045, emissive: '#1b2c38', emissiveIntensity: 0.5 }),
        housing: new THREE.MeshStandardMaterial({ color: '#39424c', metalness: 0.62, roughness: 0.44 }),
        trim: new THREE.MeshStandardMaterial({ color: '#8ba2b2', metalness: 0.8, roughness: 0.26 }),
        glass: new THREE.MeshStandardMaterial({ color: '#a8d4ef', metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.4 }),
        prism: new THREE.MeshStandardMaterial({ color: '#e8f1f8', metalness: 1, roughness: 0.06, emissive: '#16242e', emissiveIntensity: 0.55 }),
        psd: new THREE.MeshStandardMaterial({ color: '#20282e', metalness: 0.35, roughness: 0.6, emissive: '#1c0e00', emissiveIntensity: 0.6 }),
      };
    }
    return this._materials;
  }

  _box(name, size, material, parent = this.group) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  /** 静态构件先攒几何再合批：几十个小零件也不会变成几十个 draw call。 */
  _static(bucket, size, position, rotation) {
    const geometry = new THREE.BoxGeometry(...size);
    if (rotation) geometry.rotateY(rotation);
    geometry.translate(position.x, position.y, position.z);
    bucket.push(geometry);
  }

  _flushStatic(bucket, material, name, parent = this.group) {
    if (!bucket.length) return null;
    const geometry = bucket.length === 1 ? bucket[0] : mergeGeometries(bucket, false);
    if (bucket.length > 1) bucket.forEach(item => item.dispose());
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** 径向衰减贴图，供读数脉冲使用。 */
  _radialTexture() {
    if (this._radialCache) return this._radialCache;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    this._radialCache = new THREE.CanvasTexture(canvas);
    return this._radialCache;
  }

  /** PSD 感光窗贴图：四个象限检测分区 + 中央盲区。 */
  _psdWindowTexture() {
    if (this._psdTexCache) return this._psdTexCache;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0f13';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#27404d';
    ctx.fillRect(3, 3, 27, 27);
    ctx.fillRect(34, 3, 27, 27);
    ctx.fillRect(3, 34, 27, 27);
    ctx.fillRect(34, 34, 27, 27);
    ctx.strokeStyle = '#5fd9ff';
    ctx.lineWidth = 1.5;
    for (const rect of [[3, 3, 27, 27], [34, 3, 27, 27], [3, 34, 27, 27], [34, 34, 27, 27]]) ctx.strokeRect(...rect);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(26, 26, 12, 12); // 中央盲区
    this._psdTexCache = new THREE.CanvasTexture(canvas);
    this._psdTexCache.colorSpace = THREE.SRGBColorSpace;
    return this._psdTexCache;
  }

  /** 一段可拉伸的光束：记录 from→to 与基准不透明度，每帧 _stretch 一次。 */
  _beam(color, radius, opacity, name = 'MetrologyLaserBeam') {
    const geometry = this._beamGeometry || (this._beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true));
    const entry = {
      from: new THREE.Vector3(), to: new THREE.Vector3(), radius, base: opacity, on: false,
      material: new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      }),
      mesh: new THREE.Mesh(geometry, null),
    };
    entry.mesh.material = entry.material;
    entry.mesh.name = name;
    entry.mesh.frustumCulled = false;
    entry.mesh.renderOrder = 8;
    entry.mesh.visible = false;
    this.group.add(entry.mesh);
    this.beams.push(entry);
    return entry;
  }

  _stretch(entry, from, to) {
    entry.from.copy(from);
    entry.to.copy(to);
    const direction = to.clone().sub(from);
    const length = direction.length();
    if (length < 1e-5) { entry.mesh.visible = false; entry.on = false; return 0; }
    entry.mesh.visible = true;
    entry.mesh.position.copy(from).addScaledVector(direction, 0.5);
    entry.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    entry.mesh.scale.set(entry.radius, length, entry.radius);
    return length;
  }

  /** 沿光束往返运动的读数脉冲。 */
  _pulse(color) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._radialTexture(), color: new THREE.Color(color),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    sprite.name = 'MetrologyReadoutPulse';
    sprite.renderOrder = 9;
    sprite.visible = false;
    this.group.add(sprite);
    return sprite;
  }

  // ------------------------------------------------------------ 工件台侧面：L 型平面反射镜

  _buildMirrors() {
    const { mirror, housing } = this.materials();
    this.mirrors = {};
    for (const letter of ['A', 'B']) {
      const group = new THREE.Group();
      group.name = `WaferStagePlaneMirrors_${letter}`;
      this.group.add(group);
      // X 向镜条：法线朝 -X，长边沿 Z 展开，镜座背贴台侧。
      const xMirror = this._box(`PlaneMirror_Stage${letter}_X`, [MIRROR_THICK, MIRROR_HEIGHT, MIRROR_HALF_Z * 2], mirror, group);
      xMirror.position.set(-this.faceDX, 0, 0);
      const xMount = this._box(`PlaneMirrorMount_Stage${letter}_X`, [0.03, MIRROR_HEIGHT + 0.02, MIRROR_HALF_Z * 2], housing, group);
      xMount.position.set(-this.faceDX - MIRROR_THICK / 2 - 0.015, 0, 0);
      // Y 向镜条（场景 Z 轴测量）：法线朝 -Z，长边沿 X 展开。
      const zMirror = this._box(`PlaneMirror_Stage${letter}_Y`, [MIRROR_HALF_X * 2, MIRROR_HEIGHT, MIRROR_THICK], mirror, group);
      zMirror.position.set(0, 0, -this.faceDZ);
      const zMount = this._box(`PlaneMirrorMount_Stage${letter}_Y`, [MIRROR_HALF_X * 2, MIRROR_HEIGHT + 0.02, 0.03], housing, group);
      zMount.position.set(0, 0, -this.faceDZ - MIRROR_THICK / 2 - 0.015);
      // L 形交角收边块。
      const corner = this._box(`PlaneMirrorCorner_Stage${letter}`, [0.05, MIRROR_HEIGHT + 0.02, 0.05], housing, group);
      corner.position.set(-this.faceDX + 0.012, 0, -this.faceDZ + 0.012);
      this.mirrors[letter] = group;
    }
  }

  // ------------------------------------------------------------ 工件台底面：角锥反射镜

  /** 切角立方体角锥：三个互垂反射面 + 弦面，旋转到弦面朝 -Y（朝向下方 PSD）。 */
  _retroGeometry() {
    if (this._retroCache) return this._retroCache;
    const s = CUBE_S;
    const points = [
      [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1],
      [0.6, -1, -1], [-1, 0.6, -1], [-1, -1, 0.6], // 弦面（切掉 (-1,-1,-1) 角）
    ].map(p => new THREE.Vector3(p[0] * s, p[1] * s, p[2] * s));
    const geometry = new ConvexGeometry(points);
    const quaternion = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(-1, -1, -1).normalize(), new THREE.Vector3(0, -1, 0));
    geometry.applyQuaternion(quaternion);
    this._retroCache = geometry;
    return geometry;
  }

  _buildCornerCubes() {
    const { prism } = this.materials();
    const geometry = this._retroGeometry();
    this.cornerCubes = {};
    for (const letter of ['A', 'B']) {
      const group = new THREE.Group();
      group.name = `CornerCubeReflectors_Stage${letter}`;
      this.group.add(group);
      for (let i = -1; i <= 1; i++) {
        const cube = new THREE.Mesh(geometry, prism);
        cube.name = `CornerCubeReflector_Stage${letter}_${i + 2}`;
        cube.castShadow = true;
        cube.position.set(i * CUBE_PITCH, this.carriage.bottom - CUBE_HANG, 0);
        group.add(cube);
      }
      this.cornerCubes[letter] = group;
    }
  }

  // ------------------------------------------------------------ 基座：激光干涉仪本体

  _buildInterferometers() {
    const { housing, trim, glass } = this.materials();
    this.assemblyInfo = [];
    for (const def of IFM_ASSEMBLIES) {
      const group = new THREE.Group();
      group.name = `LaserInterferometerAssembly_${def.id}`;
      this.group.add(group);
      const origin = new THREE.Vector3(...def.origin);
      const alongX = def.axis === 'x';
      const housingBucket = [], trimBucket = [];
      // 本体：长方体金属外壳（长边沿测量轴）， casts a modest shadow.
      const bodySize = alongX ? [0.15, 0.08, 0.06] : [0.06, 0.08, 0.15];
      this._static(housingBucket, bodySize, origin);
      // 光学窗口（本体朝向镜面的透明面板，单独用玻璃材质渲染）。
      const windowSize = alongX ? [0.006, 0.05, 0.05] : [0.05, 0.05, 0.006];
      const windowAt = origin.clone().add(alongX ? new THREE.Vector3(0.078, 0, 0) : new THREE.Vector3(0, 0, 0.078));
      // 卫星出口（转向小塔）+ 镜筒 + 输出透镜：只要超出本体端面的出口都算卫星。
      const spread = [];
      for (const exit of def.exits) {
        const at = new THREE.Vector3(...exit);
        const offset = alongX ? Math.abs(at.z - origin.z) : Math.abs(at.x - origin.x);
        if (offset > 0.05) spread.push(at);
      }
      const postBottom = this.baseTop + POST_BOTTOM_OFFSET;
      const postTop = LASER_Y - 0.045;
      if (spread.length) {
        const min = alongX ? Math.min(...spread.map(p => p.z)) : Math.min(...spread.map(p => p.x));
        const max = alongX ? Math.max(...spread.map(p => p.z)) : Math.max(...spread.map(p => p.x));
        const yokeSize = alongX ? [0.02, 0.02, max - min + 0.06] : [max - min + 0.06, 0.02, 0.02];
        const yokeAt = origin.clone();
        if (alongX) yokeAt.z = (min + max) / 2; else yokeAt.x = (min + max) / 2;
        this._static(housingBucket, yokeSize, yokeAt);
        for (const at of spread) {
          const turretCenter = at.clone().add(alongX ? new THREE.Vector3(-0.025, 0, 0) : new THREE.Vector3(0, 0, -0.025));
          this._static(housingBucket, [0.05, 0.062, 0.05], turretCenter);
          this._static(trimBucket, [0.012, 0.02, 0.02], at.clone().add(alongX ? new THREE.Vector3(0.006, 0, 0) : new THREE.Vector3(0, 0, 0.006)));
          this._static(housingBucket, [0.014, postTop - postBottom, 0.014], turretCenter.clone().setY((postBottom + postTop) / 2));
        }
      }
      // 本体主出口的输出透镜 + 立柱 + 底座。
      this._static(trimBucket, [0.012, 0.02, 0.02], windowAt.clone().add(alongX ? new THREE.Vector3(0.008, 0, 0) : new THREE.Vector3(0, 0, 0.008)));
      this._static(housingBucket, [POST_XZ, postTop - postBottom, POST_XZ], new THREE.Vector3(origin.x, (postBottom + postTop) / 2, origin.z));
      this._static(trimBucket, [0.085, 0.018, 0.085], new THREE.Vector3(origin.x, postBottom - 0.009, origin.z));
      const housingMesh = this._flushStatic(housingBucket, housing, `LaserInterferometerAssembly_${def.id}_Housing`, group);
      if (housingMesh) housingMesh.castShadow = true;
      this._flushStatic(trimBucket, trim, `LaserInterferometerAssembly_${def.id}_Lens`, group);
      // 玻璃窗口单独一个 mesh（透明材质不合批）。
      const windowMesh = new THREE.Mesh(new THREE.BoxGeometry(...windowSize), glass);
      windowMesh.name = `LaserInterferometerWindow_${def.id}`;
      windowMesh.position.copy(windowAt);
      group.add(windowMesh);
      // 登记出口：每个出口都是一束候选测量光。
      for (const exit of def.exits) {
        this.heads.push({
          id: `${def.id}_${exit.map(v => v.toFixed(2)).join('_')}`,
          assembly: def.id, axis: def.axis,
          position: new THREE.Vector3(...exit),
        });
      }
      this.assemblyInfo.push({ id: def.id, axis: def.axis, origin: origin.toArray().map(v => +v.toFixed(3)), exits: def.exits.map(e => e.map(v => +v.toFixed(3))) });
    }
  }

  /**
   * 视线判定：固定出口的光轴与运动镜条的求交。
   * 镜条是有限尺寸的矩形，三个条件同时成立才算"打到了"：
   *   · 轴向：出口必须在镜面正前方，且留出安全间距；
   *   · 横向：出口的横向坐标必须落在镜条长度范围内；
   *   · 遮挡：光路不能被另一个台体挡住（射线与台体包围盒求交）。
   * 任一不成立就返回 null —— 此时该出口不出光。
   */
  _lineOfSight(head, center, letter) {
    let hit = null;
    if (head.axis === 'x') {
      const faceX = center.x - this.faceDX;
      if (head.position.x > faceX - CLEARANCE) return null;
      if (Math.abs(head.position.z - center.z) > MIRROR_HALF_Z - MIRROR_THICK) return null;
      hit = new THREE.Vector3(faceX, head.position.y, head.position.z);
    } else {
      const faceZ = center.z - this.faceDZ;
      if (head.position.z > faceZ - CLEARANCE) return null;
      if (Math.abs(head.position.x - center.x) > MIRROR_HALF_X - MIRROR_THICK) return null;
      hit = new THREE.Vector3(head.position.x, head.position.y, faceZ);
    }
    if (this._segmentBlocked(head.position, hit, letter)) return null;
    return hit;
  }

  /** 光路段是否被"另一个台体"的包围盒挡住。 */
  _segmentBlocked(from, to, targetLetter) {
    const other = targetLetter === 'A' ? 'B' : 'A';
    const center = this.centers[other];
    if (!center) return false;
    const box = new THREE.Box3(
      new THREE.Vector3(center.x - this.carriage.halfX, this.carriage.bottom, center.z - this.carriage.halfZ),
      new THREE.Vector3(center.x + this.carriage.halfX, this.carriage.top, center.z + this.carriage.halfZ),
    );
    const direction = _scratchA.copy(to).sub(from);
    const length = direction.length();
    if (length < 1e-4) return false;
    const ray = new THREE.Ray(from, direction.normalize());
    const point = ray.intersectBox(box, _scratchPoint);
    return Boolean(point) && point.distanceTo(from) < length - 0.02;
  }

  // ------------------------------------------------------------ 基座：PSD 零位传感器

  _buildZeroModule() {
    const { psd, housing } = this.materials();
    this.psdHeads = [];
    const housingBucket = [];
    const windowGeometries = [];
    const stationDefs = [['measurement', this.stations.A], ['exposure', this.stations.B]];
    for (const [station, point] of stationDefs) {
      // 公共安装梁 + 3 组 PSD（20mm 级黑封装，感光窗朝上）。
      this._static(housingBucket, [0.19, 0.01, 0.052], new THREE.Vector3(point.x, this.baseTop + 0.005, point.z));
      for (let i = -1; i <= 1; i++) {
        const x = point.x + i * CUBE_PITCH;
        this._static(housingBucket, [0.01, PSD_STAND_H, 0.01], new THREE.Vector3(x, this.baseTop + 0.01 + PSD_STAND_H / 2, point.z));
        this._static(housingBucket, PSD_BODY, new THREE.Vector3(x, this.baseTop + 0.01 + PSD_STAND_H + PSD_BODY[1] / 2, point.z));
        const window = new THREE.PlaneGeometry(0.014, 0.014).rotateX(-Math.PI / 2);
        window.translate(x, this.baseTop + 0.01 + PSD_STAND_H + PSD_BODY[1] + 0.0006, point.z);
        windowGeometries.push(window);
        this.psdHeads.push({
          id: `PSDZeroPositionSensor_${station}_${i + 2}`,
          station, index: i,
          position: new THREE.Vector3(x, this.baseTop + 0.01 + PSD_STAND_H + PSD_BODY[1], point.z),
        });
      }
    }
    const housingMesh = this._flushStatic(housingBucket, psd, 'PSDZeroPositionSensorAssembly');
    if (housingMesh) housingMesh.castShadow = false;
    const windowMesh = new THREE.Mesh(mergeGeometries(windowGeometries, false), new THREE.MeshBasicMaterial({ map: this._psdWindowTexture(), toneMapped: false }));
    windowMesh.name = 'PSDSensorWindow';
    this.group.add(windowMesh);
  }

  /**
   * 角锥是否在某组 PSD 的正上方：X/Z 两个方向都要对准（各容差 ~30/50mm）。
   * 台体只有停到零位（工位中心）时，台底角锥才会逐一落入 PSD 的检测光——
   * 离开工位光束自然熄灭，这正是零位开关的语义。
   */
  _psdLineOfSight(head, center) {
    const cubeX = center.x + head.index * CUBE_PITCH;
    if (Math.abs(cubeX - head.position.x) > PSD_TOL_X) return null;
    if (Math.abs(center.z - head.position.z) > PSD_TOL_Z) return null;
    return new THREE.Vector3(cubeX, this.cubeChordY, center.z);
  }

  // ------------------------------------------------------------ 掩模台：光栅尺

  _buildEncoder() {
    const { scaleBody, housing, trim } = this.materials();
    const scale = this.reticleFixed;
    const grating = this._box('ReticleGratingScale', [SCALE_HALF * 2, 0.032, 0.012], scaleBody);
    grating.position.copy(scale).add(new THREE.Vector3(0, 0, 0.008));
    const rail = this._box('ReticleScaleRail', [SCALE_HALF * 2 + 0.09, 0.016, 0.05], housing);
    rail.position.copy(scale).add(new THREE.Vector3(0, -0.024, 0.026));
    // 刻线用细条阵列示意栅距（比贴图更清晰，也不吃采样）。
    for (let i = 0; i < RULING_COUNT; i++) {
      const line = this._box('GratingRuling', [0.0026, 0.022, 0.013], trim, grating);
      line.position.set(-SCALE_HALF + 0.02 + (SCALE_HALF * 2 - 0.04) * i / (RULING_COUNT - 1), 0.005, 0.002);
    }
    const readhead = new THREE.Group();
    readhead.name = 'ReticleGratingReadhead';
    this.group.add(readhead);
    this._box('ReadheadBody', [0.08, 0.052, 0.05], housing, readhead);
    const lens = this._box('ReadheadLens', [0.032, 0.024, 0.016], trim, readhead);
    lens.position.z = -0.031;
    this.readheadGroup = readhead;
    this.encoderBeam = this._beam('#8ce8ff', 0.0032, 0.85, 'ReticleEncoderBeam');
    this.encoderPulse = this._pulse('#dff6ff');
    /** 读数头相对滑台原点的固定偏移（滑台自身只沿 X 平移）。 */
    this.readheadLocal = this.reticleReadhead.clone().sub(this.reticleStage);
    this.scaleFace = scale.clone().add(new THREE.Vector3(0, 0, 0.014));
  }

  // ------------------------------------------------------------ 每帧更新

  /** 与 LithographyMotion 使用同一份快照：只读，不推进任何流程状态。 */
  update(snapshot = {}) {
    const elapsed = Number(snapshot.elapsed_s) || 0;
    const homing = snapshot.machine_phase === 'homing' || Boolean(snapshot.homing?.active);
    // 归零校准与换台（高速运动，必须持续被量测网盯住）时点亮激光；抽真空阶段工件台静止，
    // 激光只留待机余辉——真实机器也要等真空到位后才做归零。
    const calibrating = homing
      || snapshot.machine_phase === 'exchange'
      || ['A', 'B'].some(letter => ['prealign', 'measure', 'load'].includes(snapshot.stages?.[letter]?.action));
    this.state = calibrating ? 'calibrating' : 'idle';
    const level = calibrating ? ACTIVE : IDLE;
    this.level = level;
    this.homing = homing;

    this.centers = { A: this.stageCenter('A'), B: this.stageCenter('B') };
    this._updateStageParts();
    this._updateInterferometers(elapsed, level);
    this._updateZeroModule(elapsed, level);
    this._updateEncoder(elapsed, level);
  }

  _updateStageParts() {
    for (const letter of ['A', 'B']) {
      const center = this.centers[letter];
      this.mirrors[letter].position.set(center.x, MIRROR_Y, center.z);
      this.cornerCubes[letter].position.set(center.x, 0, center.z);
    }
  }

  /**
   * 每个轴、每个台体只点亮一个出口：从所有"确实看得到镜面"的出口里选视距最短的。
   * 优先给两台分到不同出口；实在没有空闲出口时允许共用，保证测量连续。
   */
  _updateInterferometers(elapsed, level) {
    const chosen = { A: {}, B: {} };
    const claimed = new Set();
    for (const letter of ['A', 'B']) {
      const center = this.centers[letter];
      for (const axis of ['x', 'z']) {
        const candidates = [];
        for (const head of this.heads) {
          if (head.axis !== axis) continue;
          const hit = this._lineOfSight(head, center, letter);
          if (!hit) continue;
          candidates.push({ head, hit, distance: head.position.distanceTo(hit), shared: claimed.has(head) });
        }
        candidates.sort((a, b) => (a.shared - b.shared) || (a.distance - b.distance));
        const best = candidates[0] || null;
        if (best) claimed.add(best.head);
        chosen[letter][axis] = best;
      }
    }
    this.activeHeads = [];
    this.lastBeams = [];
    let slot = 0;
    for (const letter of ['A', 'B']) {
      for (const axis of ['x', 'z']) {
        const pick = chosen[letter][axis];
        const beam = this._beamSlot(slot++);
        const pulse = this.pulseSlots[slot - 1];
        if (!pick) {
          beam.mesh.visible = false;
          pulse.visible = false;
          this.lastBeams.push({ stage: letter, axis, hit: false, length_m: 0 });
          continue;
        }
        beam.material.color.set(axis === 'x' ? '#ff5a45' : '#ff8a3d');
        this._stretch(beam, pick.head.position, pick.hit);
        beam.material.opacity = 0.85 * level;
        pulse.material.color.set(axis === 'x' ? '#ffd2b0' : '#ffe0bb');
        this.activeHeads.push(pick.head);
        const phase = (elapsed * 0.9 + (letter === 'A' ? 0 : 0.5) + (axis === 'z' ? 0.25 : 0)) % 1;
        const envelope = Math.sin(phase * Math.PI);
        pulse.visible = true;
        pulse.position.copy(beam.from).lerp(beam.to, phase);
        pulse.material.opacity = (0.30 + 0.70 * envelope) * level;
        pulse.scale.setScalar((0.030 + 0.020 * envelope) * (level > 0.5 ? 1.8 : 1.1));
        this.lastBeams.push({
          stage: letter, axis, hit: true, head: pick.head.id, assembly: pick.head.assembly,
          from: pick.head.position.toArray().map(v => +v.toFixed(3)),
          to: pick.hit.toArray().map(v => +v.toFixed(3)),
          length_m: +pick.distance.toFixed(3),
        });
      }
    }
  }

  /** 光束与脉冲用固定池，避免每帧新建材质。 */
  _beamSlot(index) {
    if (!this.beamPool) {
      this.beamPool = [];
      this.pulseSlots = [];
      for (let i = 0; i < 4; i++) {
        this.beamPool.push(this._beam('#ff5a45', 0.0045, 0.8, 'InterferometerMeasurementBeam'));
        this.pulseSlots.push(this._pulse('#ffd2b0'));
      }
    }
    return this.beamPool[index];
  }

  /**
   * 零位模块：只在归零标定时出光。PSD 的检测光自下而上射向台底角锥的弦面，
   * 角锥经三次反射平行返回——回程光与出射光沿 Z 微微错开以示可分辨。
   * 台体不在零位（X/Z 超出容差）时整组熄灭。
   */
  _updateZeroModule(elapsed, level) {
    if (!this.zeroPool) {
      this.zeroPool = [];
      for (let i = 0; i < 6; i++) {
        this.zeroPool.push({
          out: this._beam('#66d9ff', 0.0030, 0.9, 'ZeroPositionDetectionBeam'),
          back: this._beam('#9be9ff', 0.0022, 0.7, 'ZeroPositionReturnBeam'),
          pulse: this._pulse('#dffaff'),
        });
      }
    }
    this.zeroBeams = [];
    let slot = 0;
    for (const head of this.psdHeads) {
      const entry = this.zeroPool[slot++];
      let hit = null, owner = null;
      if (this.homing) {
        for (const letter of ['A', 'B']) {
          const candidate = this._psdLineOfSight(head, this.centers[letter]);
          if (candidate) { hit = candidate; owner = letter; break; }
        }
      }
      if (!hit) {
        entry.out.mesh.visible = false;
        entry.back.mesh.visible = false;
        entry.pulse.visible = false;
        this.zeroBeams.push({ id: head.id, hit: false });
        continue;
      }
      const outFrom = _scratchA.copy(head.position).setZ(hit.z + 0.005);
      const outTo = _scratchB.copy(hit).setZ(hit.z + 0.005);
      this._stretch(entry.out, outFrom, outTo);
      entry.out.material.opacity = 0.9;
      const backFrom = hit.clone().setZ(hit.z - 0.005);
      const backTo = head.position.clone().setZ(hit.z - 0.005);
      this._stretch(entry.back, backFrom, backTo);
      entry.back.material.opacity = 0.7;
      const phase = (elapsed * 2.4) % 1;
      const envelope = Math.sin(phase * Math.PI);
      entry.pulse.visible = true;
      entry.pulse.position.copy(entry.out.from).lerp(entry.out.to, phase < 0.5 ? phase : 1 - phase);
      entry.pulse.material.opacity = (0.35 + 0.65 * envelope);
      entry.pulse.scale.setScalar(0.024 + 0.012 * envelope);
      this.zeroBeams.push({ id: head.id, station: head.station, stage: owner, hit: true, length_m: +head.position.distanceTo(hit).toFixed(4) });
    }
  }

  _updateEncoder(elapsed, level) {
    const node = this.host.operations.get('reticle_scan_stage');
    if (!node || !this.readheadGroup) return;
    node.updateWorldMatrix(true, false);
    const readhead = node.localToWorld(this.readheadLocal.clone());
    this.readheadGroup.position.copy(readhead);
    // 读数头沿 +Z 的固定光轴读标尺；滑台只在 X 上平移，标尺足够长，读数始终落在尺面上。
    const from = new THREE.Vector3(readhead.x, readhead.y, readhead.z - 0.026);
    const to = new THREE.Vector3(readhead.x, readhead.y, this.scaleFace.z + 0.006);
    const onScale = Math.abs(readhead.x - this.scaleFace.x) <= SCALE_HALF;
    this.encoderOnScale = onScale;
    if (!onScale) {
      this.encoderBeam.mesh.visible = false;
      this.encoderPulse.visible = false;
      return;
    }
    this._stretch(this.encoderBeam, from, to);
    this.encoderBeam.material.opacity = 0.85 * level;
    const phase = (elapsed * 1.7) % 1;
    const envelope = Math.sin(phase * Math.PI);
    this.encoderPulse.visible = true;
    this.encoderPulse.position.copy(this.encoderBeam.from).lerp(this.encoderBeam.to, phase);
    this.encoderPulse.material.opacity = (0.35 + 0.65 * envelope) * level;
    this.encoderPulse.scale.setScalar((0.026 + 0.016 * envelope) * (level > 0.5 ? 1.8 : 1.2));
  }

  debugState() {
    return {
      state: this.state, homing: Boolean(this.homing), level: Number((this.level ?? IDLE).toFixed(2)),
      carriage: { half_x: +this.carriage.halfX.toFixed(3), half_z: +this.carriage.halfZ.toFixed(3), bottom: +this.carriage.bottom.toFixed(3) },
      stations: { A: this.stations.A.toArray().map(v => +v.toFixed(3)), B: this.stations.B.toArray().map(v => +v.toFixed(3)) },
      base_top: +this.baseTop.toFixed(3),
      cube_chord_y: +this.cubeChordY.toFixed(3),
      assemblies: this.assemblyInfo,
      exit_count: this.heads.length,
      interferometer: this.lastBeams || [],
      zero_module: this.zeroBeams || [],
      encoder: { on_scale: Boolean(this.encoderOnScale), gap_m: +this.encoderBeam.from.distanceTo(this.encoderBeam.to).toFixed(4) },
      readhead_world: this.readheadGroup ? this.readheadGroup.position.toArray().map(v => +v.toFixed(3)) : null,
    };
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse(object => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material?.dispose?.();
    });
  }
}
