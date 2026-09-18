import './style.css';
import { DualStagePipeline } from './simulation/pipeline.js';
import { catalogue } from './simulation/designs.js';
import { MachineScene } from './scene/machine-scene.js';
import { OperatorUI } from './ui/operator-ui.js';

const params = new URLSearchParams(location.search);
const qa = params.has('qa');
const base = import.meta.env.BASE_URL;
const pipeline = new DualStagePipeline();
let machine;
let mode = 'game';
let speed = 1;
let batch = 6;
let lighting = false;
let renderMode = 'off';
let follow = true;
let selected = null;
let singleStep = false;
let loaded = false;
let catalogueSeed = Date.now() >>> 0;
let previousTime = 0;
let hudTime = 0;
let elapsedFrames = 0;
let fpsTime = 0;
let lastFps = 0;
const errors = [];

const ui = new OperatorUI(document.querySelector('#app'), { onAction: action });

function present(delta = 0) {
  const snapshot = pipeline.snapshot();
  snapshot.single_step = singleStep;
  snapshot.speed_multiplier = speed;
  machine?.update(snapshot, delta);
  snapshot.web = { mode, lighting, follow, fps: lastFps, render: machine?.pipeline?.debugState() || null, metrology: machine?.metrology?.debugState() || null };
  ui.update(snapshot);
  return snapshot;
}

function picker() {
  present();
  ui.showDesignPicker(catalogue(catalogueSeed++, 16));
}

function action(name, payload) {
  if (!loaded) return;
  switch (name) {
    case 'toggle':
      if (mode !== 'game') return;
      // 刷新后直接进光刻机界面；只有在"准备开始光刻"这一刻才弹出芯片设计选择。
      if (pipeline.state === 'running') pipeline.pause();
      else if (pipeline.state === 'paused') pipeline.resume();
      else if (pipeline.state === 'done') { action('reset'); picker(); }
      else picker();
      break;
    case 'reset':
      pipeline.reset();
      pipeline.set_batch_count(batch);
      pipeline.set_single_step(singleStep);
      machine.restoreAssembly();
      machine.setCamera('front');
      break;
    case 'batch':
      batch = Math.max(1, Math.min(12, Math.round(Number(payload) || 1)));
      pipeline.set_batch_count(batch);
      break;
    case 'speed': speed = Math.max(0.5, Math.min(4, Number(payload) || 1)); break;
    case 'singleStep':
      singleStep = !!payload;
      pipeline.set_single_step(singleStep);
      break;
    case 'step': singleStep = true; pipeline.step(); break;
    case 'design':
      if (pipeline.state !== 'ready' && pipeline.state !== 'done') return;
      pipeline.reset();
      pipeline.set_batch_count(batch);
      pipeline.set_single_step(singleStep);
      if (!pipeline.set_design(payload)) throw new Error('芯片设计数据无效');
      pipeline.start();
      break;
    case 'designs': case 'refreshDesigns': picker(); break;
    case 'results': ui.showResults(pipeline.snapshot()); break;
    case 'lighting': lighting = !!payload; machine.setLighting(lighting); break;
    case 'renderMode':
      // 画质档位不再暴露在界面上：默认走原生高画质。这里只服务于 ?qa=1 诊断工具链。
      if (!['off', 'dlaa', 'quality', 'balanced', 'performance'].includes(payload)) return;
      renderMode = payload;
      machine.setRenderQuality(renderMode);
      break;
    case 'follow': follow = !!payload; machine.setFollow(follow); break;
    case 'camera': machine.setCamera(payload === 'home' ? 'front' : payload); break;
    case 'mode':
      mode = payload === 'structure' ? 'structure' : 'game';
      if (mode === 'structure' && pipeline.state === 'running') pipeline.pause();
      machine.setMode(mode);
      ui.setMode(mode);
      break;
    case 'select':
      selected = payload;
      machine.select(payload);
      ui.setSelection(payload);
      break;
    case 'visible':
      machine.setVisible(payload.id, payload.visible);
      ui.setPartVisible?.(payload.id, payload.visible);
      break;
    case 'focus': machine.focus(payload || selected || 'machine'); break;
    case 'isolate': machine.isolate(payload); break;
    case 'showAll': machine.showAll(); ui.resetVisibility?.(); break;
    case 'explode': machine.setExplode(Number(payload)); break;
    case 'restore': machine.restoreAssembly(); break;
    default: console.warn('Unknown operator action', name); return;
  }
  present();
}

function frame(now) {
  const delta = previousTime ? Math.min((now - previousTime) / 1000, 0.1) : 0;
  previousTime = now;
  if (loaded) {
    if (mode === 'game' && !document.hidden) pipeline.tick(delta * speed);
    const snapshot = pipeline.snapshot();
    machine.update(snapshot, delta);
    hudTime += delta;
    fpsTime += delta;
    elapsedFrames++;
    if (fpsTime >= 1) { lastFps = Math.round(elapsedFrames / fpsTime); elapsedFrames = 0; fpsTime = 0; }
    if (hudTime >= 0.1) {
      snapshot.single_step = singleStep;
      snapshot.speed_multiplier = speed;
      snapshot.web = { mode, lighting, follow, fps: lastFps, render: machine?.pipeline?.debugState() || null, metrology: machine?.metrology?.debugState() || null };
      ui.update(snapshot);
      hudTime = 0;
    }
    machine.render();
  }
  requestAnimationFrame(frame);
}

function fail(error) {
  console.error(error);
  errors.push(String(error?.stack || error));
  ui.showError(error?.message || String(error));
}

window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
window.addEventListener('resize', () => machine?.resize());
document.addEventListener('visibilitychange', () => { previousTime = 0; });

async function start() {
  ui.setLoading(0, '加载 Blender 设备模型');
  machine = new MachineScene(ui.viewportElement, {
    onProgress: percent => ui.setLoading(percent, '加载 Blender 设备模型'),
    onHover: (id, x, y) => ui.setHover(id, x, y),
    onSelect: id => {
      action('select', id);
      if (mode === 'game' && ['handling_load_port_1', 'handling_load_port_2', 'handling_load_lock'].includes(id)) action('results');
    },
  });
  await machine.load(`${base}assets/models/euv_training_machine.glb`, `${base}assets/models/parts_manifest.json`);
  machine.setMode('game');
  machine.setCamera('front');
  machine.setFollow(follow);
  machine.setLighting(lighting);
  machine.setRenderQuality(renderMode);
  loaded = true;
  ui.ready(machine.manifest);
  ui.setMode(mode);
  present();
  requestAnimationFrame(frame);
}

// Deterministic QA hooks are opt-in. Production UI has no timeline shortcuts.
if (qa) {
  window.__twinscan = {
    get ready() { return loaded; },
    get pipeline() { return pipeline; },
    get machine() { return machine; },
    get ui() { return ui; },
    get errors() { return [...errors]; },
    snapshot: () => pipeline.snapshot(),
    scene: () => machine?.debugState(),
    action,
    advance(seconds) {
      const wasPaused = pipeline.state === 'paused';
      if (wasPaused) pipeline.resume();
      pipeline.tick(seconds);
      if (pipeline.state === 'running') pipeline.pause();
      present();
      machine.render();
      return pipeline.snapshot();
    },
    present,
  };
}

start().catch(fail);
