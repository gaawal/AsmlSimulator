import { DESIGNS, FAMILY_POOL, DIE_COUNT, find, segments_for, wafer_dies, wafer_yield } from './designs.js';

/** Pure-data port of scripts/simulation/dual_stage_pipeline.gd (schema 4).
 * Durations are compressed teaching times, not real equipment throughput.
 * Stage station ownership never changes during unload/load; only exchange
 * swaps stations. Rendering and camera state must not modify this model.
 */
export const ACTION_LABELS = {
  idle:'空台待机',homing:'双台归零 · 光栅尺与掩模核验',pump:'装载锁抽真空',
  load:'上片 · 装载锁送入',unload:'下片 · 回收晶圆',prealign:'预对准',
  measure:'精对准 · 调平量测',expose:'扫描曝光',wait:'等待交换（同步点）',
  exchange:'双台交换',done:'待机 · 无后续任务',
};
export const ACTION_DURATIONS = Object.freeze({load:4.5,unload:4,prealign:3,measure:4.5,expose:16});
export const MACHINE_PHASE_LABELS = {standby:'待机 · 等待启动',pump:'抽真空 · 建立工作真空',homing:'双台归零 · 光栅尺与掩模核验',pipeline:'稳态流水 · 量测 ‖ 曝光',exchange:'双台交换 · 同步点',complete:'批次完成'};
export const HOMING_DURATION=5, PUMP_DURATION=4, EXCHANGE_DURATION=4;
const EPS=1e-9, SUBSTEP=.05, clone=v=>structuredClone(v), rounded=v=>Math.round(v*1000)/1000;
const other = letter => letter==='A'?'B':'A';
const ready = stage => ['wait','idle','done'].includes(stage.action);

export class DualStagePipeline {
  constructor() {
    this.batch_count=6;
    this.design_data=find('flagship_soc');
    this.design_id=this.design_data.id;
    this.seed_value=20260913;
    this.single_step=false;
    this._segments=segments_for(this.design_data);
    this.reset();
  }
  _new_stage(station) {
    return {station,action:'idle',progress:0,wafer_id:0,wafer_state:'empty',exposed_segments:0,die_index:0,segment_index:0,wafer_dies:[],wafer_yield:{passed:0,total:DIE_COUNT,yield_pct:100}};
  }
  reset() {
    this.state='ready'; this.machine_phase='standby'; this.elapsed_s=0; this.next_wafer_id=1;
    this.exchange_progress=0; this.homing_progress=0; this.pump_progress=0;
    this.completed=[]; this.events=[]; this.last_cycle_time_s=0; this.exchange_count=0;
    this.lot_dies_total=0; this.lot_dies_passed=0; this._last_unload_s=-1;
    this.stages={A:this._new_stage('measurement'),B:this._new_stage('exposure')};
    this.step_waiting=false; this._boundary_revision=0;
  }
  set_batch_count(value) {
    if(this.state!=='ready'||!Number.isInteger(value)||value<1||value>12)return false;
    this.batch_count=value; return true;
  }
  set_design(value) {
    if(this.state!=='ready')return false;
    let entry;
    if(typeof value==='string') {
      if(!DESIGNS.some(d=>d.id===value))return false;
      entry=find(value);
    } else if(value && typeof value==='object' && !Array.isArray(value)) {
      if(!value.id || (!FAMILY_POOL.includes(value.family) && !Array.isArray(value.segments)))return false;
      entry=clone(value);
    } else return false;
    const traces=segments_for(entry);
    if(!traces.length || !traces.every(s=>Array.isArray(s.a)&&Array.isArray(s.b)&&s.a.length===2&&s.b.length===2&&[...s.a,...s.b,s.w].every(Number.isFinite)&&s.w>0))return false;
    this.design_data=entry; this.design_id=String(entry.id); this._segments=traces;
    return true;
  }
  set_seed(value) {
    if(this.state!=='ready'||!Number.isSafeInteger(value))return false;
    this.seed_value=value; return true;
  }
  design() { return clone(this.design_data); }
  segments_per_die() { return this._segments.length; }
  total_segments_per_wafer() { return this.segments_per_die()*DIE_COUNT; }
  set_single_step(enabled) { this.single_step=Boolean(enabled); if(!this.single_step)this.step_waiting=false; return true; }
  step() {
    this.single_step=true;
    if(this.state==='ready')return this.start();
    if(this.state==='paused')return this.resume();
    return this.state==='running';
  }
  start() {
    if(this.state!=='ready')return false;
    this.state='running'; this.machine_phase='pump'; this.pump_progress=0; this.step_waiting=false;
    for(const stage of Object.values(this.stages)){stage.action='pump';stage.progress=0;}
    this._event('pipeline_started','',{batch_count:this.batch_count});return true;
  }
  pause() { if(this.state!=='running')return false;this.state='paused';this.step_waiting=false;return true; }
  resume() { if(this.state!=='paused')return false;this.state='running';this.step_waiting=false;return true; }
  tick(delta) {
    if(this.state!=='running'||!Number.isFinite(delta)||delta<=0)return;
    let remaining=delta;
    while(remaining>0&&this.state==='running') {
      const step=Math.min(remaining,SUBSTEP,this._time_to_next_boundary()), revision=this._boundary_revision;
      this._advance(step); remaining-=step;
      if(this.single_step&&this._boundary_revision!==revision&&this.state==='running') {this.state='paused';this.step_waiting=true;}
    }
  }
  _time_to_next_boundary() {
    if(this.machine_phase==='homing')return Math.max((1-this.homing_progress)*HOMING_DURATION,0);
    if(this.machine_phase==='pump')return Math.max((1-this.pump_progress)*PUMP_DURATION,0);
    if(this.machine_phase==='exchange')return Math.max((1-this.exchange_progress)*EXCHANGE_DURATION,0);
    let duration=SUBSTEP;
    if(this.machine_phase==='pipeline')for(const stage of Object.values(this.stages))if(ACTION_DURATIONS[stage.action])duration=Math.min(duration,Math.max((1-stage.progress)*ACTION_DURATIONS[stage.action],0));
    return duration;
  }
  _advance_progress(progress,delta,duration) { return (1-progress)*duration<=delta+EPS?1:progress+delta/duration; }
  _advance(delta) {
    this.elapsed_s+=delta;
    switch(this.machine_phase) {
      // 启动顺序：先建立工作真空，再做系统归零校准。
      // 工件台与激光干涉仪都在真空腔内工作，腔体未抽到工作真空前，量测基准
      // （空气折射率、振动、气流）都不稳定，归零与寻零结果不可信——所以真空先行。
      case 'pump': {
        this.pump_progress=this._advance_progress(this.pump_progress,delta,PUMP_DURATION);
        for(const stage of Object.values(this.stages))stage.progress=this.pump_progress;
        if(this.pump_progress>=1) {
          this._boundary_revision++;this.machine_phase='homing';this.homing_progress=0;
          for(const stage of Object.values(this.stages)){stage.action='homing';stage.progress=0;}
          this._event('vacuum_ready');
        }
        break;
      }
      case 'homing': {
        this.homing_progress=this._advance_progress(this.homing_progress,delta,HOMING_DURATION);
        for(const stage of Object.values(this.stages))stage.progress=this.homing_progress;
        if(this.homing_progress>=1) {
          this._boundary_revision++;this.machine_phase='pipeline';
          for(const stage of Object.values(this.stages)){stage.action='idle';stage.progress=0;}
          this._event('homing_completed');this._begin_load('A');
        }
        break;
      }
      case 'exchange': {
        this.exchange_progress=this._advance_progress(this.exchange_progress,delta,EXCHANGE_DURATION);
        for(const stage of Object.values(this.stages))stage.progress=this.exchange_progress;
        if(this.exchange_progress>=1){this._boundary_revision++;this._finish_exchange();}
        break;
      }
      case 'pipeline': this._advance_stage('A',delta);this._advance_stage('B',delta);this._check_sync();break;
      case 'complete':this.state='done';break;
    }
  }
  _advance_stage(letter,delta) {
    const stage=this.stages[letter],action=stage.action,duration=ACTION_DURATIONS[action];
    if(!duration)return;
    stage.progress=this._advance_progress(stage.progress,delta,duration);
    if(action==='expose') {
      const total=Math.max(this.total_segments_per_wafer(),1),target=Math.min(total,Math.floor(stage.progress*total+EPS));
      if(target>stage.exposed_segments) {
        stage.exposed_segments=target;const per=this.segments_per_die();
        stage.die_index=Math.min(Math.floor(target/per),DIE_COUNT-1);stage.segment_index=target%per;
      }
    }
    if(stage.progress>=1){this._boundary_revision++;this._complete_action(letter);}
  }
  _complete_action(letter) {
    const stage=this.stages[letter];
    switch(stage.action) {
      case 'load':stage.wafer_state='loaded';stage.action='prealign';stage.progress=0;this._event('wafer_loaded',letter,{wafer_id:stage.wafer_id});break;
      case 'prealign':stage.action='measure';stage.progress=0;this._event('wafer_prealigned',letter,{wafer_id:stage.wafer_id});break;
      case 'measure':stage.wafer_state='measured';stage.action='wait';stage.progress=1;this._event('wafer_measured',letter,{wafer_id:stage.wafer_id});break;
      case 'expose':
        stage.wafer_state='exposed';stage.exposed_segments=this.total_segments_per_wafer();stage.action='wait';stage.progress=1;
        this._event('wafer_exposed',letter,{wafer_id:stage.wafer_id,pass_count:stage.wafer_yield.passed,total:stage.wafer_yield.total});break;
      case 'unload': {
        const result=stage.wafer_yield;
        this.last_cycle_time_s=this._last_unload_s>=0?this.elapsed_s-this._last_unload_s:this.elapsed_s;this._last_unload_s=this.elapsed_s;
        this.lot_dies_total+=result.total;this.lot_dies_passed+=result.passed;
        this.completed.push({wafer_id:stage.wafer_id,stage:letter,pass_count:result.passed,die_total:result.total,yield_pct:result.yield_pct,design_id:this.design_id,dies:clone(stage.wafer_dies),finished_s:rounded(this.elapsed_s)});
        this._event('wafer_unloaded',letter,{wafer_id:stage.wafer_id,pass_count:result.passed,total:result.total});
        stage.wafer_id=0;stage.wafer_state='empty';stage.exposed_segments=0;stage.die_index=0;stage.segment_index=0;stage.wafer_dies=[];
        if(this.next_wafer_id<=this.batch_count)this._begin_load(letter);
        else {stage.action='done';stage.progress=1;this._check_batch_complete();}
        break;
      }
    }
  }
  _begin_load(letter) {
    const stage=this.stages[letter];
    stage.wafer_id=this.next_wafer_id++;stage.wafer_state='loading';stage.action='load';stage.progress=0;
    stage.exposed_segments=0;stage.die_index=0;stage.segment_index=0;stage.wafer_dies=[];stage.wafer_yield={passed:0,total:DIE_COUNT,yield_pct:100};
    this._event('wafer_loading',letter,{wafer_id:stage.wafer_id});
  }
  _check_sync() {
    if(this.machine_phase!=='pipeline')return;
    if(Object.values(this.stages).every(ready)) {
      this.machine_phase='exchange';this.exchange_progress=0;this.exchange_count++;
      for(const stage of Object.values(this.stages)){stage.action='exchange';stage.progress=0;}
      this._event('exchange_started','',{count:this.exchange_count});
    }
  }
  _finish_exchange() {
    for(const stage of Object.values(this.stages))stage.station=stage.station==='measurement'?'exposure':'measurement';
    for(const [letter,stage] of Object.entries(this.stages)) {
      if(stage.station==='exposure') {
        if(stage.wafer_state==='measured') {
          stage.action='expose';stage.progress=0;stage.wafer_state='exposing';stage.exposed_segments=0;stage.die_index=0;stage.segment_index=0;
          stage.wafer_dies=wafer_dies(this.seed_value,stage.wafer_id,this.design_data.fatigue??1);stage.wafer_yield=wafer_yield(stage.wafer_dies);
          this._event('exposure_started',letter,{wafer_id:stage.wafer_id,design_id:this.design_id,total:stage.wafer_yield.total});
        } else {stage.action='idle';stage.progress=0;}
      } else if(stage.wafer_state==='exposed') {stage.action='unload';stage.progress=0;this._event('unload_started',letter,{wafer_id:stage.wafer_id});}
      else if(stage.wafer_id===0) {
        if(this.next_wafer_id<=this.batch_count)this._begin_load(letter);
        else {stage.action='done';stage.progress=1;}
      }
    }
    this.machine_phase='pipeline';this._event('exchange_completed','',{count:this.exchange_count,stations:{A:this.stages.A.station,B:this.stages.B.station}});
  }
  _check_batch_complete() {
    if(this.machine_phase==='complete')return;
    if(this.next_wafer_id>this.batch_count&&this.stages.A.wafer_id===0&&this.stages.B.wafer_id===0) {
      this.machine_phase='complete';this.state='done';this._event('batch_complete','',{completed:this.completed.length,elapsed_s:rounded(this.elapsed_s)});
    }
  }
  measuring_stage() {return this.stages.A.station==='measurement'?'A':'B';}
  exposing_stage() {return Object.keys(this.stages).find(k=>this.stages[k].action==='expose')??'';}
  latent_stage() {return Object.keys(this.stages).find(k=>this.stages[k].exposed_segments>0)??'';}
  die_results(wafer_id) {const dies=wafer_dies(this.seed_value,wafer_id,this.design_data.fatigue??1);return {...wafer_yield(dies),wafer_id,dies};}
  lot_yield() {return {passed:this.lot_dies_passed,total:this.lot_dies_total,yield_pct:100*this.lot_dies_passed/Math.max(this.lot_dies_total,1)};}
  sync_note() {
    if(this.machine_phase==='standby')return '待机 · 点击「启动流水线」开始双台并行演示';
    if(this.machine_phase==='pump')return '建立工作真空 · 腔体抽气到位后再做归零校准';
    if(this.machine_phase==='homing')return '系统归零校准中 · 光栅尺寻零与掩模核验';
    if(this.machine_phase==='exchange')return `双台交换中 ${Math.round(this.exchange_progress*100)}% —— 两台同时到达同步点后快速换位`;
    if(this.machine_phase==='complete')return '批次完成 · 双台回到待机';
    const letter=this.measuring_stage(),m=this.stages[letter],e=this.stages[other(letter)];
    if(ready(e)&&ready(m))return '两台均已就绪 · 即将交换';
    if(ready(e))return `曝光端已就绪 · 等待 ${letter} 台完成「${ACTION_LABELS[m.action]??m.action}」`;
    if(ready(m))return `量测端已就绪 · 等待曝光端描完第 ${Math.min(e.die_index+1,DIE_COUNT)} / ${DIE_COUNT} 颗芯片`;
    return `并行作业中 · 量测端 ${letter} 台「${ACTION_LABELS[m.action]??m.action}」 ‖ 曝光端 第 ${Math.min(e.die_index+1,DIE_COUNT)} / ${DIE_COUNT} 颗 · 第 ${e.segment_index+1} / ${this.segments_per_die()} 段走线`;
  }
  snapshot() {
    const exposing=this.exposing_stage(),latent=this.latent_stage(),d=this.design_data,per=this.segments_per_die();
    const arm={task:'',stage:'',progress:0};
    for(const [letter,stage] of Object.entries(this.stages))if(['load','unload'].includes(stage.action))Object.assign(arm,{task:stage.action,stage:letter,progress:stage.progress});
    const current=latent?this.stages[latent]:null;
    return clone({
      schema_version:4,state:this.state,machine_phase:this.machine_phase,machine_phase_label:MACHINE_PHASE_LABELS[this.machine_phase],elapsed_s:this.elapsed_s,
      batch_count:this.batch_count,completed_count:this.completed.length,next_wafer_id:this.next_wafer_id,exchange_count:this.exchange_count,
      homing:{active:this.machine_phase==='homing',progress:this.homing_progress},pump:{active:this.machine_phase==='pump',progress:this.pump_progress},exchange:{active:this.machine_phase==='exchange',progress:this.exchange_progress},
      stages:Object.fromEntries(Object.entries(this.stages).map(([k,v])=>[k,{...v,action_label:ACTION_LABELS[v.action]??v.action}])),
      exposing_stage:exposing,latent_stage:latent,arm,sync_note:this.sync_note(),last_cycle_time_s:this.last_cycle_time_s,throughput_per_hour:this.completed.length/Math.max(this.elapsed_s,1)*3600,
      completed:this.completed,events:this.events,
      design:{id:this.design_id,name:d.name??this.design_id,type:d.type??'',vendor:d.vendor??'',node:d.node??'',class_zh:d.class_zh??'',hint:d.hint??'',family:d.family??'',seed:d.seed??1,accent:d.accent??[.7,.8,.9],segments_per_die:per,total_segments:this.total_segments_per_wafer(),die_count:DIE_COUNT,...(d.segments?{segments:d.segments}:{})},
      seed_value:this.seed_value,lot:{dies_total:this.lot_dies_total,dies_passed:this.lot_dies_passed,yield_pct:100*this.lot_dies_passed/Math.max(this.lot_dies_total,1),wafers_done:this.completed.length},
      exposure_progress:{stage:latent,die_index:current?.die_index??0,segment_index:current?.segment_index??0,exposed_segments:current?.exposed_segments??0,segments_per_die:per,total_segments:this.total_segments_per_wafer(),die_count:DIE_COUNT,active:!!latent},
      wafer_dies:current?.wafer_dies??[],phase:exposing?'expose':'',single_step:this.single_step,step_waiting:this.step_waiting,
    });
  }
  _event(type,actor='',extra={}) {
    this.events.push({type,actor,elapsed_s:rounded(this.elapsed_s),...clone(extra)});
    if(this.events.length>240)this.events=this.events.slice(-240);
  }
}
