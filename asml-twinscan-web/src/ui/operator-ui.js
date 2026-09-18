import { segments_for, die_center, DEFECT_LABELS } from '../simulation/designs.js';

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(n) || 0));
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vec = (p) => Array.isArray(p) ? p : [p?.x || 0, p?.y || 0];
const rgb = (v = [.48, .84, .96]) => `rgb(${v.map(n => Math.round(n * 255)).join(',')})`;
const stationLabel = (station) => station === 'measurement' ? '量测端' : '曝光端';
const ACTIONS = { idle: '空台待机', pump: '腔体抽真空', homing: '双台归零', load: '上片', unload: '下片', prealign: '预对准', measure: '精对准 · 调平', expose: '扫描曝光', wait: '等待交换', exchange: '双台交换', done: '任务完成' };
const STATE = { ready: '等待启动', running: '运行中', paused: '已暂停', done: '批次完成' };
const FLOW_MEASURE = [['unload', '下片'], ['load', '上片'], ['prealign', '预对准'], ['measure', '精对准 · 调平'], ['wait', '等待交换']];
const FLOW_EXPOSE = [['expose', '扫描曝光'], ['wait', '等待交换']];

const icon = (name) => {
  const paths = {
    play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M8 5v14M16 5v14"/>', reset: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
    layers: '<path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
    focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>', refresh: '<path d="M20 8A8 8 0 0 0 6 5L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    arrow: '<path d="M4 8h15l-4-4m5 12H5l4 4"/>', chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.focus}</svg>`;
};

/** DOM and canvas presentation only. Simulation state remains outside this class. */
export class OperatorUI {
  constructor(root, { onAction = () => {} } = {}) {
    this.root = root;
    this.onAction = onAction;
    this.parts = new Map();
    this.visibility = new Map();
    this.selectedId = 'machine';
    this.mode = 'game';
    this.snapshot = {};
    this.lastEventKey = '';
    this.resultWafer = -1;
    this.resultDie = 0;
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <a class="brand" href="#" aria-label="ASML TwinScan Lab 主页"><span class="brand-mark">ASML</span><span class="brand-name">TwinScan <b>Lab</b><small>INTERACTIVE LITHOGRAPHY SIMULATOR</small></span></a>
          <nav class="mode-tabs" aria-label="工作模式"><button class="active" data-mode="game">${icon('chip')}流水演示</button><button data-mode="structure">${icon('layers')}设备结构</button></nav>
          <div class="edition"><i></i><span>WEB EDITION</span><span class="edition-divider">/</span><span>EUV · 01</span></div>
        </header>
        <main class="workspace">
          <section class="scene-panel" aria-label="光刻机三维交互场景">
            <div class="viewport"></div>
            <div class="scene-topline"><div class="scene-name"><span class="live-dot"></span><span>洁净室 <b>01</b></span><span class="hairline"></span><span class="scene-state">双台并行光刻</span></div><div class="scene-toggles" role="group" aria-label="环境与视图开关"><button class="pill-toggle light-toggle" data-toggle="lighting" aria-pressed="false" title="切换白光 / 黄光洁净室照明">${icon('sun')}<span>白光环境</span></button><button class="pill-toggle" data-toggle="follow" aria-pressed="true" title="相机自动跟随当前工序">${icon('focus')}跟随特写</button></div></div>
            <div class="scene-caption"><span class="eyebrow">EUV LITHOGRAPHY SYSTEM</span><strong>双台协同 · 连续生产</strong><span>量测与曝光并行，交换连接每一片晶圆。</span></div>
            <div class="scene-selection" hidden><span class="selection-kicker">SELECTED COMPONENT</span><strong></strong><button data-action="focus-selection">${icon('focus')}聚焦</button></div>
            <div class="scene-camera-tools" aria-label="相机预设"><button data-camera="front" class="active" title="整机正视">整机</button><button data-camera="stage" title="双工件台特写">双台</button><button data-camera="optics" title="投影光学特写">光学</button><button data-camera="fork" title="搬运机械手特写">搬运</button><button data-camera="metrology" title="位置测量部件特写">测量</button><span></span><button data-camera="home" title="恢复相机">${icon('focus')}</button></div>
            <div class="scene-help"><span><b>拖动</b>旋转</span><span><b>右键</b>平移</span><span><b>滚轮</b>缩放</span><span><b>双击</b>聚焦</span></div>
            <div class="load-screen"><div class="load-orbit"></div><span class="eyebrow">LOADING DIGITAL TWIN</span><strong>正在载入光刻机</strong><p class="load-message">准备三维资产与工艺数据…</p><div class="load-track"><i></i></div><span class="load-percent">0%</span></div>
          </section>
          <aside class="operator-panel" aria-label="流水线操作台">
            <div class="panel-heading"><div><span class="eyebrow">OPERATOR CONSOLE</span><h1>双台流水线</h1></div><span class="state-pill" data-state="ready"><i></i><span>等待启动</span></span></div>
            <div class="operator-scroll">
              <div class="design-summary"><span>${icon('chip')}</span><div><strong class="design-name">选择本批芯片设计</strong><small class="design-meta">5 × 5 芯片阵列 · 双台并行</small></div><span class="design-badge">LOT 01</span></div>
              <div class="lot-progress"><div><span>批次进度</span><strong><span class="completed-count">0</span><small> / <span class="batch-count">6</span> 片</small></strong></div><div class="lot-track"><i></i></div></div>
              <div class="stage-pair">${this._stageHTML('A')}${this._stageHTML('B')}</div>
              <div class="sync-line">${icon('arrow')}<span>选择设计后自动启动全流程</span></div>
              <section class="wafer-section"><div class="section-title"><span>晶圆曝光监视</span><span class="wafer-owner">等待曝光</span></div><div class="wafer-display"><canvas class="wafer-canvas" aria-label="当前晶圆逐芯片走线曝光图"></canvas><div class="wafer-readout"><span class="eyebrow">DIE PROGRESS</span><strong class="die-count">00<small> / 25</small></strong><span class="trace-count">走线 0 / 0</span><div class="wafer-legend"><span><i class="violet"></i>正在曝光</span><span><i class="mint"></i>图形在窗</span><span><i class="orange"></i>教学缺陷</span></div></div></div></section>
              <div class="metrics"><div><span>模拟时间</span><strong class="metric-time">0.0<small>s</small></strong></div><div><span>稳态节拍</span><strong class="metric-cycle">—<small>s / 片</small></strong></div><div><span>晶圆交换</span><strong class="metric-exchanges">0<small>次</small></strong></div></div>
              <details class="metrology-lesson"><summary>台子怎样知道自己的位置？<span>位置测量</span></summary>
                <p>固定的光学头发光，台侧的镜子把光送回来，往返路程的变化就是台子的位移。</p>
                <div class="metrology-readings"></div>
                <div class="zero-readings"></div>
                <p class="metrology-note">三枚角锥随台移动；固定照明器照亮它们，PSD 接收返回光斑。三个光斑都靠近标定中心，才提示找到零位。</p>
              </details>
              <section class="event-section"><div class="section-title"><span>设备事件</span><span class="event-live"><i></i>LIVE LOG</span></div><ol class="event-log"><li class="empty-event">系统就绪，等待晶圆批次。</li></ol></section>
              <p class="education-note">教学示意 · EUV 实际不可见，紫色表示光路；电路图形与良率用于演示，不代表成品或真实产能。</p>
            </div>
            <div class="operator-controls">
              <div class="batch-controls"><label>晶圆数量 <input name="batch" type="number" min="1" max="12" value="6" aria-label="批次晶圆数量"><span>片</span></label><label>速度<select name="speed" aria-label="播放速度"><option value="0.5">0.5 ×</option><option value="1" selected>1 ×</option><option value="2">2 ×</option><option value="4">4 ×</option></select></label><button class="icon-button" data-action="reset" title="重新选择设计并开始">${icon('reset')}</button></div>
              <div class="run-row"><button class="primary-button" data-action="toggle">${icon('play')}<span>启动流水线</span></button><button class="pill-toggle step-toggle" data-toggle="singleStep" aria-pressed="false" title="在每个动作边界暂停，便于逐步观察">单步</button><button class="step-button" data-action="step" title="运行至下一步边界" hidden>下一步 →</button><button class="results-button" data-action="results" title="查看晶圆与芯片结果">${icon('chip')}芯片盘<span class="results-count">0</span></button></div>
            </div>
          </aside>
          <aside class="structure-panel" aria-label="设备结构观察工具" hidden>
            <div class="panel-heading"><div><span class="eyebrow">ASSEMBLY EXPLORER</span><h1>设备结构</h1></div><span class="part-total">— 部件</span></div>
            <div class="structure-actions"><button data-action="hide-enclosure">${icon('layers')}隐藏外壳</button><button data-action="showAll">${icon('eye')}全部显示</button></div>
            <label class="tree-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" placeholder="搜索部件名称 / part_id" aria-label="搜索部件"></label>
            <div class="parts-tree" role="tree" aria-label="中文部件树"></div>
            <div class="selected-part"><span class="eyebrow">CURRENT SELECTION</span><h2>整机</h2><code>machine</code><div><button data-action="focus-selection">${icon('focus')}聚焦部件</button><button data-action="isolate-selection">${icon('layers')}隔离观察</button></div></div>
            <div class="explode-control"><div><label for="explode-slider">爆炸展开</label><output>0%</output></div><input id="explode-slider" type="range" min="0" max="100" value="0" aria-label="爆炸展开百分比"><div class="explode-labels"><span>装配状态</span><span>完全展开</span></div><button data-action="restore">${icon('reset')}恢复装配</button></div>
          </aside>
        </main>
        <footer class="app-footer"><span><i></i>本地数字教学实验室</span><span>Blender asset · Three.js renderer</span><span>SPACE 暂停 / 继续<span class="footer-divider">│</span>F 聚焦</span></footer>
      </div><div class="part-tooltip" hidden></div><div class="modal-host" hidden></div><div class="toast" role="status" hidden></div>`;
    this.viewportElement = this.root.querySelector('.viewport');
    this.$ = (selector) => this.root.querySelector(selector);
    this._bind();
    this._resizeObserver = new ResizeObserver(() => this._drawWafer());
    this._resizeObserver.observe(this.$('.wafer-canvas'));
  }

  _stageHTML(letter) {
    return `<article class="stage-card stage-${letter}" data-stage="${letter}"><div class="stage-top"><span class="stage-letter">${letter}</span><span class="stage-station">${letter === 'A' ? '量测端' : '曝光端'}</span><span class="stage-wafer">空台</span></div><div class="stage-action">空台待机</div><div class="stage-progress"><i></i></div><div class="stage-progress-caption"><span>等待任务</span><b>0%</b></div><ol class="stage-flow"></ol></article>`;
  }

  /**
   * 环境 / 视图开关（黄光环境、跟随特写、单步）：按钮状态与快照保持同步，
   * 真正的动作通过 onAction 交给外部，UI 自身不持有仿真状态。
   */
  _reflectToggle(name, checked) {
    const button = this.root.querySelector(`[data-toggle=${name}]`);
    if (!button || button.dataset.state === String(checked)) return;
    button.dataset.state = String(checked);
    button.setAttribute('aria-pressed', String(checked));
    button.classList.toggle('on', checked);
    if (name === 'lighting') {
      button.querySelector('span').textContent = checked ? '黄光环境' : '白光环境';
      this.root.classList.toggle('yellow-mode', checked);
    }
    if (name === 'singleStep') { const step = this.$('.step-button'); if (step) step.hidden = !checked; }
  }

  _setToggle(name, checked) {
    this._reflectToggle(name, checked);
    this.onAction(name, checked);
  }

  _bind() {
    this.root.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-toggle]');
      if (toggle && !toggle.disabled) { this._setToggle(toggle.dataset.toggle, toggle.getAttribute('aria-pressed') !== 'true'); return; }
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.dataset.mode) { this.setMode(button.dataset.mode); this.onAction('mode', button.dataset.mode); }
      if (button.dataset.camera) {
        this.root.querySelectorAll('[data-camera]').forEach(el => el.classList.toggle('active', el === button));
        this.onAction('camera', button.dataset.camera);
      }
      const action = button.dataset.action;
      if (!action) return;
      if (action === 'focus-selection') this.onAction('focus', this.selectedId);
      else if (action === 'isolate-selection') this.onAction('isolate', this.selectedId);
      else if (action === 'hide-enclosure') { this.setPartVisible('enclosure', false); this.onAction('visible', { id: 'enclosure', visible: false }); }
      else if (action === 'showAll') { this.visibility.forEach((_, id) => this.visibility.set(id, true)); this._renderTree(); this.onAction(action); }
      else if (action === 'restore') { this.$('#explode-slider').value = 0; this.$('.explode-control output').textContent = '0%'; this.onAction(action); }
      else if (action === 'close-modal') this.closeModal();
      else this.onAction(action);
    });
    this.$('.brand').addEventListener('click', event => event.preventDefault());
    this.$('[name=batch]').addEventListener('change', event => { const n = Math.round(clamp(event.target.value, 1, 12)); event.target.value = n; this.onAction('batch', n); });
    this.$('[name=speed]').addEventListener('change', event => this.onAction('speed', Number(event.target.value)));
    this.$('.tree-search input').addEventListener('input', () => this._renderTree());
    this.$('#explode-slider').addEventListener('input', event => { const n = Number(event.target.value); this.$('.explode-control output').textContent = `${n}%`; this.onAction('explode', n / 100); });
    this.$('.parts-tree').addEventListener('click', event => {
      const row = event.target.closest('[data-part]');
      if (!row || event.target.closest('input,summary')) return;
      this.setSelection(row.dataset.part);
      this.onAction('select', row.dataset.part);
    });
    this.$('.parts-tree').addEventListener('change', event => {
      const id = event.target.dataset.visibility;
      if (id) { this.setPartVisible(id, event.target.checked); this.onAction('visible', { id, visible: event.target.checked }); }
    });
    this.$('.parts-tree').addEventListener('dblclick', event => {
      const row = event.target.closest('[data-part]');
      if (row) this.onAction('focus', row.dataset.part);
    });
    this.$('.modal-host').addEventListener('click', event => { if (event.target === this.$('.modal-host')) this.closeModal(); });
    this._keyHandler = event => {
      if (event.key === 'Escape') this.closeModal();
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || !this.$('.modal-host').hidden) return;
      if (event.code === 'Space') { event.preventDefault(); this.onAction('toggle'); }
      if (event.key.toLowerCase() === 'f') this.onAction('focus', this.selectedId);
    };
    window.addEventListener('keydown', this._keyHandler);
  }

  setLoading(percent, message = '正在载入三维模型…') {
    const value = percent <= 1 ? percent * 100 : percent;
    this.$('.load-screen').hidden = false;
    this.$('.load-track i').style.width = `${clamp(value, 0, 100)}%`;
    this.$('.load-percent').textContent = `${Math.round(clamp(value, 0, 100))}%`;
    this.$('.load-message').textContent = message;
  }

  ready(manifest = {}) {
    const parts = Array.isArray(manifest) ? manifest : Array.isArray(manifest.parts) ? manifest.parts : Object.values(manifest.parts || {});
    parts.forEach(part => { this.parts.set(part.part_id || part.id, part); this.visibility.set(part.part_id || part.id, true); });
    this.$('.part-total').textContent = `${parts.length} 部件`;
    this.$('.load-screen').hidden = true;
    this._renderTree();
    this.setSelection(this.selectedId);
  }

  update(snapshot = {}) {
    this.snapshot = snapshot;
    const state = snapshot.state || 'ready';
    const design = snapshot.design || {};
    const pill = this.$('.state-pill');
    pill.dataset.state = state;
    pill.querySelector('span').textContent = STATE[state] || state;
    this.$('.scene-state').textContent = snapshot.machine_phase_label || '双台并行光刻';
    this.$('.scene-caption').hidden = state !== 'ready';
    this._reflectToggle('lighting', Boolean(snapshot.web?.lighting));
    this._reflectToggle('follow', snapshot.web?.follow !== false);
    this._reflectToggle('singleStep', Boolean(snapshot.single_step));
    this.$('.design-name').textContent = design.name || '选择本批芯片设计';
    this.$('.design-meta').textContent = `${design.node || design.class_zh || '教学电路'} · ${design.segments_per_die || 0} 段 / 芯片`;
    const count = snapshot.completed_count || 0;
    const total = snapshot.batch_count || 6;
    this.$('.completed-count').textContent = count;
    this.$('.batch-count').textContent = total;
    this.$('.lot-track i').style.width = `${clamp(count / total) * 100}%`;
    this.$('.results-count').textContent = count;
    const batchInput = this.$('[name=batch]');
    batchInput.disabled = state !== 'ready';
    if (document.activeElement !== batchInput) batchInput.value = total;
    this.$('[data-action=toggle] span').textContent = { ready: '开始光刻', running: '暂停运行', paused: '继续运行', done: '重新开始' }[state] || '开始光刻';
    this.$('[data-action=toggle] svg').outerHTML = icon(state === 'running' ? 'pause' : 'play');
    this.$('.sync-line span').textContent = snapshot.sync_note || '选择设计后自动启动全流程';
    this.$('.sync-line').classList.toggle('is-exchanging', !!snapshot.exchange?.active);
    for (const letter of ['A', 'B']) this._updateStage(letter, snapshot.stages?.[letter] || {}, snapshot);
    this.$('.metric-time').innerHTML = `${Number(snapshot.elapsed_s || 0).toFixed(1)}<small>s</small>`;
    this.$('.metric-cycle').innerHTML = `${snapshot.last_cycle_time_s ? Number(snapshot.last_cycle_time_s).toFixed(1) : '—'}<small>s / 片</small>`;
    this.$('.metric-exchanges').innerHTML = `${snapshot.exchange_count || 0}<small>次</small>`;
    const events = snapshot.events || [];
    const key = `${events.length}:${events.at(-1)?.elapsed_s}:${events.at(-1)?.type}`;
    if (key !== this.lastEventKey) { this.lastEventKey = key; this.$('.event-log').innerHTML = events.length ? events.slice(-4).reverse().map(event => `<li><time>${Number(event.elapsed_s || 0).toFixed(1).padStart(5, '0')}s</time><span>${escape(this._eventText(event))}</span></li>`).join('') : '<li class="empty-event">系统就绪，等待晶圆批次。</li>'; }
    this._drawWafer();
    this._updateMetrology(snapshot.web?.metrology);
    if (this.$('.modal-host').dataset.kind === 'results' && !this.$('.modal-host').hidden && this._resultsCount !== count) this._renderResults();
  }

  _updateMetrology(data) {
    const panel = this.$('.metrology-lesson');
    if (!data || data.source !== 'blender_manifest') { panel.hidden = true; return; }
    panel.hidden = false;
    if (!panel.open) return;
    this.$('.metrology-readings').innerHTML = data.interferometer.map(row => `<div class="${row.hit ? 'locked' : 'lost'}"><span>${row.station === 'measurement' ? '量测位' : '曝光位'} ${row.axis.toUpperCase()}</span><b>${row.hit ? `${(row.displacement_m * 1000).toFixed(3)} mm` : '离开光轴'}</b><small>${row.hit ? `${row.stage} 台 · 光已返回` : '换台时不追光'}</small></div>`).join('');
    this.$('.zero-readings').innerHTML = ['A', 'B'].map(letter => {
      const n = data.zero_module.filter(r => r.stage === letter && r.centered).length;
      const value = data.homing ? `${n} / 3 个光斑居中` : data.zero_calibrated[letter] ? '已记录零位' : '等待归零';
      return `<span class="${n === 3 || data.zero_calibrated[letter] ? 'locked' : ''}">${letter} 台 · ${value}</span>`;
    }).join('');
  }

  _updateStage(letter, stage, snapshot) {
    const card = this.$(`[data-stage=${letter}]`);
    const action = stage.action || 'idle';
    const station = stage.station || (letter === 'A' ? 'measurement' : 'exposure');
    card.dataset.station = snapshot.exchange?.active ? 'exchange' : station;
    card.querySelector('.stage-station').textContent = snapshot.exchange?.active ? '交换中' : stationLabel(station);
    card.querySelector('.stage-wafer').textContent = stage.wafer_id ? `#${String(stage.wafer_id).padStart(2, '0')}` : '空台';
    card.querySelector('.stage-action').textContent = ACTIONS[action] || stage.action_label || action;
    card.querySelector('.stage-progress i').style.width = `${clamp(stage.progress) * 100}%`;
    card.querySelector('.stage-progress-caption b').textContent = `${Math.round(clamp(stage.progress) * 100)}%`;
    card.querySelector('.stage-progress-caption span').textContent = action === 'expose' ? `芯片 ${Math.min((stage.die_index || 0) + 1, 25)} / 25` : stage.wafer_id ? `晶圆 ${String(stage.wafer_id).padStart(2, '0')}` : '等待任务';
    const flow = station === 'measurement' ? FLOW_MEASURE : FLOW_EXPOSE;
    const current = flow.findIndex(([id]) => id === action);
    const flowKey = `${station}:${action}`;
    if (card.dataset.flow !== flowKey) {
      card.dataset.flow = flowKey;
      card.querySelector('.stage-flow').innerHTML = flow.map(([id, label], index) => `<li class="${index === current ? 'current' : index < current ? 'finished' : ''}"><i>${index < current ? '✓' : index === current ? '●' : ''}</i>${label}</li>`).join('');
    }
  }

  _eventText(event) {
    const actor = event.actor ? `${event.actor} 台` : '';
    const wafer = `晶圆 #${event.wafer_id || 0}`;
    const values = { pipeline_started: `批次启动 · ${event.batch_count} 片`, homing_completed: '双台归零校准完成', vacuum_ready: '真空环境建立', wafer_loading: `${actor} 上片 · ${wafer}`, wafer_loaded: `${actor} 上片完成`, wafer_prealigned: `${actor} 预对准完成`, wafer_measured: `${actor} 量测完成 · ${wafer}`, exchange_started: `第 ${event.count} 次双台交换`, exchange_completed: '双台换位完成', exposure_started: `${actor} 曝光 · ${wafer}`, wafer_exposed: `${actor} 曝光完成 · ${wafer}`, unload_started: `${actor} 下片 · ${wafer}`, wafer_unloaded: `${wafer} 已回收`, batch_complete: `批次完成 · ${event.completed} 片` };
    return values[event.type] || event.message || event.type || '';
  }

  _currentWafer() {
    const snapshot = this.snapshot;
    const stages = snapshot.stages || {};
    if (stages[snapshot.exposing_stage]?.action === 'expose') return { ...stages[snapshot.exposing_stage], letter: snapshot.exposing_stage };
    if (stages[snapshot.latent_stage]?.exposed_segments > 0) return { ...stages[snapshot.latent_stage], letter: snapshot.latent_stage };
    if (snapshot.state === 'done' && snapshot.completed?.length) {
      const wafer = snapshot.completed.at(-1);
      return { wafer_id: wafer.wafer_id, wafer_dies: wafer.dies, letter: wafer.stage || '', action: 'done', exposed_segments: (snapshot.design?.segments_per_die || 0) * 25 };
    }
    return {};
  }

  _drawWafer() {
    const canvas = this.$('.wafer-canvas');
    const context = this._canvas(canvas);
    if (!context) return;
    const { ctx, w, h } = context;
    const center = [w / 2, h / 2];
    const radius = Math.min(w, h) * .445;
    const gradient = ctx.createRadialGradient(center[0] - radius * .3, center[1] - radius * .4, 0, ...center, radius);
    gradient.addColorStop(0, '#26364b'); gradient.addColorStop(.6, '#152437'); gradient.addColorStop(1, '#0a1524');
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(...center, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#556477'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.strokeStyle = '#203548'; ctx.beginPath(); ctx.arc(...center, radius - 4, 0, Math.PI * 2); ctx.stroke();
    const wafer = this._currentWafer();
    const design = this.snapshot.design;
    const segments = design ? this._segments(design) : [];
    const perDie = segments.length;
    const exposed = clamp(wafer.exposed_segments, 0, perDie * 25);
    const spacing = radius * .28;
    const fraction = wafer.action === 'expose' ? clamp((wafer.progress || 0) * perDie * 25 - exposed) : 0;
    for (let index = 0; index < 25; index++) {
      const completed = clamp(exposed - index * perDie, 0, perDie);
      const active = wafer.action === 'expose' && perDie > 0 && index === Math.floor(exposed / perDie);
      if (!completed && !(active && fraction > 0)) continue;
      const die = wafer.wafer_dies?.[index] || {};
      const shift = vec(die.shift);
      const at = vec(die_center(index));
      const point = [center[0] + (at[0] + shift[0]) * spacing, center[1] + (at[1] + shift[1]) * spacing];
      const color = completed === perDie ? die.passed === false ? '#f6aa72' : '#72d7bf' : '#c591ff';
      for (let s = 0; s < completed; s++) if (!(die.broken || []).includes(s)) this._trace(ctx, segments[s], point, spacing, color, die.width_scale);
      if (active && segments[completed] && !(die.broken || []).includes(completed)) this._trace(ctx, segments[completed], point, spacing, '#ffffff', die.width_scale, fraction);
    }
    ctx.strokeStyle = '#aabfd5'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(center[0] - 4, center[1] + radius - 1); ctx.lineTo(center[0], center[1] + radius - 5); ctx.lineTo(center[0] + 4, center[1] + radius - 1); ctx.stroke();
    this.$('.wafer-owner').textContent = wafer.wafer_id ? `${wafer.letter} 台 · 晶圆 #${String(wafer.wafer_id).padStart(2, '0')}` : '等待曝光';
    this.$('.die-count').innerHTML = `${String(Math.min(Math.floor(exposed / Math.max(perDie, 1)), 25)).padStart(2, '0')}<small> / 25</small>`;
    this.$('.trace-count').textContent = `走线 ${exposed} / ${perDie * 25}`;
  }

  _segments(design) {
    const key = `${design.id}:${design.seed || 0}`;
    if (this._segmentKey !== key) { this._segmentKey = key; this._segmentCache = segments_for(design); }
    return this._segmentCache || [];
  }

  _canvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, w: rect.width, h: rect.height };
  }

  _trace(ctx, segment, center, scale, color, widthScale = 1, fraction = 1) {
    if (!segment) return;
    const a = vec(segment.a), b = vec(segment.b);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max((segment.w || .01) * scale * widthScale, .65); ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(center[0] + a[0] * scale, center[1] + a[1] * scale);
    ctx.lineTo(center[0] + (a[0] + (b[0] - a[0]) * fraction) * scale, center[1] + (a[1] + (b[1] - a[1]) * fraction) * scale); ctx.stroke();
  }

  _drawPattern(canvas, design, die = {}, color = rgb(design.accent)) {
    const context = this._canvas(canvas);
    if (!context) return;
    const { ctx, w, h } = context;
    const scale = Math.min(w, h) * .86;
    ctx.strokeStyle = '#20394b'; ctx.lineWidth = .5;
    for (let i = 0; i <= 8; i++) { const offset = scale * (i / 8 - .5); ctx.beginPath(); ctx.moveTo(w / 2 + offset, h / 2 - scale / 2); ctx.lineTo(w / 2 + offset, h / 2 + scale / 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(w / 2 - scale / 2, h / 2 + offset); ctx.lineTo(w / 2 + scale / 2, h / 2 + offset); ctx.stroke(); }
    const shift = vec(die.shift);
    const center = [w / 2 + shift[0] * scale, h / 2 + shift[1] * scale];
    segments_for(design).forEach((segment, index) => { if (!(die.broken || []).includes(index)) this._trace(ctx, segment, center, scale, color, die.width_scale || 1); });
  }

  setMode(mode) {
    this.mode = mode;
    this.$('.operator-panel').hidden = mode !== 'game';
    this.$('.structure-panel').hidden = mode !== 'structure';
    this.root.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    this.$('.scene-selection').hidden = mode !== 'structure';
    this.$('.scene-caption').hidden = mode !== 'game' || this.snapshot.state !== 'ready';
    requestAnimationFrame(() => this._drawWafer());
  }

  _renderTree() {
    const query = this.$('.tree-search input').value.trim().toLowerCase();
    const children = new Map();
    for (const [id, part] of this.parts) { const parent = part.parent_id || ''; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(id); }
    const shown = new Set();
    for (const [id, part] of this.parts) {
      if (!query || `${id} ${part.label_zh}`.toLowerCase().includes(query)) {
        let current = id; const walked = new Set();
        while (current && !walked.has(current)) { shown.add(current); walked.add(current); current = this.parts.get(current)?.parent_id; }
      }
    }
    const render = (id, depth = 0) => {
      if (!shown.has(id) || depth > 12) return '';
      const part = this.parts.get(id);
      const kids = children.get(id) || [];
      const row = `<div class="tree-row ${id === this.selectedId ? 'selected' : ''}" data-part="${escape(id)}" style="--depth:${depth}" role="treeitem" aria-selected="${id === this.selectedId}"><input type="checkbox" data-visibility="${escape(id)}" ${this.visibility.get(id) !== false ? 'checked' : ''} aria-label="显示 ${escape(part.label_zh || id)}"><span class="tree-node-dot ${kids.length ? 'branch-dot' : ''}"></span><span class="tree-label" title="${escape(id)}">${escape(part.label_zh || id)}</span>${kids.length ? `<span class="tree-count">${kids.length}</span>` : ''}</div>`;
      return row + kids.map(child => render(child, depth + 1)).join('');
    };
    this.$('.parts-tree').innerHTML = (children.get('') || []).map(id => render(id)).join('') || '<p class="empty-tree">没有匹配的部件</p>';
  }

  setPartVisible(id, visible) {
    this.visibility.set(id, visible);
    for (const input of this.root.querySelectorAll('[data-visibility]')) if (input.dataset.visibility === id) input.checked = visible;
  }

  setSelection(id) {
    this.selectedId = id || 'machine';
    const name = this.parts.get(this.selectedId)?.label_zh || this.selectedId;
    this.$('.selected-part h2').textContent = name;
    this.$('.selected-part code').textContent = this.selectedId;
    this.$('.scene-selection strong').textContent = name;
    this.root.querySelectorAll('[data-part]').forEach(row => { const active = row.dataset.part === this.selectedId; row.classList.toggle('selected', active); row.setAttribute('aria-selected', active); });
  }

  setHover(id, x, y) {
    const tooltip = this.$('.part-tooltip');
    tooltip.hidden = !id;
    if (!id) return;
    tooltip.textContent = this.parts.get(id)?.label_zh || id;
    tooltip.style.left = `${Math.min(x + 16, window.innerWidth - tooltip.offsetWidth - 14)}px`;
    tooltip.style.top = `${Math.min(y + 18, window.innerHeight - 36)}px`;
  }

  showDesignPicker(catalogue = []) {
    const host = this.$('.modal-host');
    host.hidden = false; host.dataset.kind = 'designs';
    host.innerHTML = `<section class="modal design-modal" role="dialog" aria-modal="true" aria-labelledby="design-title"><header class="modal-header"><div><span class="eyebrow">NEW PRODUCTION LOT</span><h2 id="design-title">从一张芯片设计开始</h2><p>选择本批版图，观察双台如何连续完成 ${this.snapshot.batch_count || 6} 片晶圆。</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="关闭设计选择">${icon('close')}</button></header><div class="design-grid"></div><footer class="modal-footer"><span><i class="status-dot"></i>随机教学版图 · 点击设计立即开工</span><button data-action="refreshDesigns">${icon('refresh')}换一批设计</button></footer></section>`;
    const grid = host.querySelector('.design-grid');
    catalogue.forEach((design, index) => {
      const button = document.createElement('button');
      button.className = 'design-card'; button.style.setProperty('--accent', rgb(design.accent));
      button.innerHTML = `<div class="design-card-top"><span>${escape(design.type || design.family || 'LOGIC')}</span><small>${String(index + 1).padStart(2, '0')}</small></div><canvas aria-label="${escape(design.name)}电路版图"></canvas><strong>${escape(design.name)}</strong><span class="design-spec">${escape(design.node || design.class_zh || '教学版图')}<b>${segments_for(design).length} 段</b></span><span class="design-card-go">选择并启动 ↗</span>`;
      button.addEventListener('click', () => { this.closeModal(); this.onAction('design', design); });
      grid.appendChild(button);
      requestAnimationFrame(() => this._drawPattern(button.querySelector('canvas'), design));
    });
    requestAnimationFrame(() => grid.querySelector('button')?.focus({ preventScroll: true }));
  }

  showResults(snapshot = this.snapshot) {
    this.snapshot = snapshot;
    this.resultWafer = Math.max((snapshot.completed || []).length - 1, 0);
    this.resultDie = 0;
    this.$('.modal-host').hidden = false;
    this.$('.modal-host').dataset.kind = 'results';
    this._renderResults();
  }

  _renderResults() {
    const host = this.$('.modal-host');
    const snapshot = this.snapshot;
    const completed = snapshot.completed || [];
    this._resultsCount = completed.length;
    const lot = snapshot.lot || {};
    const design = snapshot.design || {};
    this.resultWafer = clamp(this.resultWafer, 0, Math.max(completed.length - 1, 0));
    const wafer = completed[this.resultWafer];
    host.innerHTML = `<section class="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title"><header class="modal-header"><div><span class="eyebrow">WAFER INSPECTION</span><h2 id="result-title">晶圆与芯片盘</h2><p>${escape(design.name || '本批设计')} · ${completed.length} 片晶圆已完成下片</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="关闭芯片盘">${icon('close')}</button></header>${wafer ? `<div class="result-overview"><div><span>完成晶圆</span><strong>${completed.length}<small>片</small></strong></div><div><span>芯片总数</span><strong>${lot.dies_total || completed.length * 25}<small>颗</small></strong></div><div><span>图形在窗</span><strong>${lot.dies_passed || 0}<small>颗</small></strong></div><div><span>教学良率</span><strong>${Number(lot.yield_pct || 0).toFixed(1)}<small>%</small></strong></div></div><nav class="wafer-tabs" aria-label="选择已完成晶圆">${completed.map((entry, i) => `<button data-wafer-index="${i}" class="${i === this.resultWafer ? 'active' : ''}">晶圆 #${String(entry.wafer_id).padStart(2, '0')}<small>${entry.pass_count ?? entry.dies?.filter(d => d.passed).length ?? 0} / ${entry.die_total || 25}</small></button>`).join('')}</nav><div class="result-columns"><div><div class="section-title"><span>5 × 5 芯片盘</span><span>点击任意芯片查看</span></div><div class="die-grid"></div></div><section class="die-inspection"><div class="section-title"><span>版图对比</span><span class="inspected-die"></span></div><div class="comparison"><div><span>目标设计</span><canvas class="target-pattern" aria-label="目标设计图"></canvas></div><div><span>实际图形</span><canvas class="actual-pattern" aria-label="实际芯片图"></canvas></div></div><div class="defect-detail"></div></section></div>` : `<div class="empty-results">${icon('chip')}<h3>第一片晶圆还在加工中</h3><p>晶圆完成曝光并在量测端下片后，<br>这里会显示每颗芯片的图形与判定。</p><button data-action="close-modal">返回设备现场 →</button></div>`}<footer class="modal-footer"><span>教学图形 / 潜像示意 · 非真实晶圆成品良率</span><button data-action="close-modal">返回现场</button></footer></section>`;
    if (!wafer) return;
    host.querySelectorAll('[data-wafer-index]').forEach(button => button.addEventListener('click', () => { this.resultWafer = Number(button.dataset.waferIndex); this.resultDie = 0; this._renderResults(); }));
    const grid = host.querySelector('.die-grid');
    for (let index = 0; index < 25; index++) {
      const die = wafer.dies?.[index] || {};
      const button = document.createElement('button');
      button.className = `die-cell ${die.passed === false ? 'defective' : ''} ${index === this.resultDie ? 'active' : ''}`;
      button.dataset.dieIndex = index;
      button.innerHTML = `<canvas aria-label="第 ${index + 1} 颗芯片"></canvas><span>${String(index + 1).padStart(2, '0')}</span><i>${die.passed === false ? '!' : '✓'}</i>`;
      button.addEventListener('click', () => { this.resultDie = index; grid.querySelectorAll('button').forEach(b => b.classList.toggle('active', Number(b.dataset.dieIndex) === index)); this._drawDieDetail(wafer, design); });
      grid.appendChild(button);
      requestAnimationFrame(() => this._drawPattern(button.querySelector('canvas'), design, die, die.passed === false ? '#f1a56f' : '#69d7c1'));
    }
    requestAnimationFrame(() => this._drawDieDetail(wafer, design));
  }

  _drawDieDetail(wafer, design) {
    const host = this.$('.modal-host');
    const die = wafer.dies?.[this.resultDie] || {};
    const passed = die.passed !== false;
    host.querySelector('.inspected-die').textContent = `晶圆 #${wafer.wafer_id} · 芯片 ${String(this.resultDie + 1).padStart(2, '0')}`;
    this._drawPattern(host.querySelector('.target-pattern'), design, {}, '#8bcaff');
    this._drawPattern(host.querySelector('.actual-pattern'), design, die, passed ? '#6cdbc0' : '#f4a46b');
    const notes = { none: '套刻、焦距与剂量均落在教学工艺窗口内，图形与设计一致。', overlay: '图形整体发生偏移。套刻对准超出教学窗口，层间互连可能错位。', broken: '部分走线缺失。请对照目标设计观察断开的线路。', dose: '剂量偏差导致线宽变化，相邻走线可能粘连。' };
    host.querySelector('.defect-detail').innerHTML = `<span class="inspection-verdict ${passed ? '' : 'failed'}">${passed ? '✓ 图形在窗' : '！检测到教学缺陷'}</span><h3>${escape(DEFECT_LABELS[die.defect || 'none'] || die.defect)}</h3><p>${notes[die.defect || 'none'] || ''}</p><dl><div><dt>偏移 X / Y</dt><dd>${vec(die.shift).map(n => Number(n).toFixed(3)).join(' / ')}</dd></div><div><dt>线宽系数</dt><dd>${Number(die.width_scale || 1).toFixed(2)} ×</dd></div><div><dt>缺失线段</dt><dd>${die.broken?.length || 0}</dd></div></dl>`;
  }

  closeModal() { this.$('.modal-host').hidden = true; this.$('.modal-host').dataset.kind = ''; }

  showError(message) {
    this.$('.load-screen').hidden = true;
    const toast = this.$('.toast'); toast.hidden = false; toast.textContent = message;
    clearTimeout(this._toastTimer); this._toastTimer = setTimeout(() => { toast.hidden = true; }, 12000);
  }

  destroy() { this._resizeObserver.disconnect(); window.removeEventListener('keydown', this._keyHandler); clearTimeout(this._toastTimer); }
}
