import * as THREE from 'three';

const vec = a => new THREE.Vector3(...a);
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const shown = node => { for (let p = node; p; p = p.parent) if (!p.visible) return false; return !!node; };

/** Optical teaching layer for authored Blender hardware. Fixed rays intersect
 * finite, moving mirror surfaces. It does not steer beams or drive the process.
 * This is a two-axis single-return interferometer illustration, not an ASML
 * servo reconstruction or a six-DOF observability model. */
export class StageMetrology {
  constructor(host) {
    this.host = host;
    this.spec = host.manifest.education_metrology;
    this.group = new THREE.Group();
    this.group.name = 'AuthoredMetrologyOpticalEffects';
    host.scene.add(this.group);
    this.geometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    this.dotGeometry = new THREE.SphereGeometry(.004, 10, 6);
    this.references = new Map();
    this.channels = new Map();
    this.zeroChannels = new Map();
    this.calibrated = { A: false, B: false };
    this.lastElapsed = 0;
    this.fixedAtRest = new Map();
    for (const head of this.spec.heads) {
      this.channels.set(head.part_id, this._channel('#ff6860', '#ffc389'));
      this.fixedAtRest.set(head.part_id, this._point(head.part_id, head.point_local));
      // Compare against the same station and axis, independent of A/B ownership.
      const letter = head.station === 'measurement' ? 'A' : 'B';
      const mirror = this.spec.stages[letter].mirrors[head.axis];
      const target = this._point(mirror.part_id, mirror.point_local);
      const origin = this._point(head.part_id, head.point_local);
      const direction = this._direction(head.part_id, head.direction_local);
      this.references.set(head.part_id, target.clone().sub(origin).dot(direction));
    }
    for (const sensor of this.spec.zero_sensors) {
      this.zeroChannels.set(sensor.part_id, this._channel('#f3b746', '#66ffe1'));
      this.fixedAtRest.set(sensor.part_id, this._point(sensor.part_id, sensor.receiver_local));
    }
    this.encoder = this._channel('#81d6ff', '#c9f3ff');
    this.records = []; this.zeroRecords = [];
  }

  _point(id, point) {
    const node = this.host.operations.get(id) || this.host.nodes.get(id);
    if (!node) throw new Error(`计量资产缺少部件 ${id}`);
    node.updateWorldMatrix(true, false);
    return node.localToWorld(vec(point));
  }

  _direction(id, direction) {
    const node = this.host.operations.get(id) || this.host.nodes.get(id);
    node.updateWorldMatrix(true, false);
    return vec(direction).transformDirection(node.matrixWorld);
  }

  _line(color) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .83, toneMapped: false, depthWrite: false });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  _channel(out, back) {
    const forward = this._line(out), returned = this._line(back);
    const dot = new THREE.Mesh(this.dotGeometry, new THREE.MeshBasicMaterial({color: back, toneMapped: false}));
    dot.visible = false;
    this.group.add(dot);
    return { forward, returned, dot };
  }

  _stretch(mesh, from, to, radius=.0014) {
    const delta=to.clone().sub(from);
    mesh.visible=delta.length()>1e-6;
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(UP,delta.clone().normalize());
    mesh.scale.set(radius,delta.length(),radius);
  }

  _hide(channel) { channel.forward.visible=channel.returned.visible=channel.dot.visible=false; }

  _mirrorHit(head, letter) {
    const mirror=this.spec.stages[letter].mirrors[head.axis];
    if(!shown(this.host.nodes.get(mirror.part_id)))return null;
    const origin=this._point(head.part_id,head.point_local);
    const direction=this._direction(head.part_id,head.direction_local);
    const center=this._point(mirror.part_id,mirror.point_local);
    const normal=this._direction(mirror.part_id,mirror.normal_local);
    const tangent=this._direction(mirror.part_id,mirror.tangent_local);
    const vertical=new THREE.Vector3().crossVectors(normal,tangent).normalize();
    const incidence=direction.dot(normal);
    if(incidence>-.98)return null; // back face or angularly out of this simple sensor
    const length=center.clone().sub(origin).dot(normal)/incidence;
    if(length<.025)return null;
    const point=origin.clone().addScaledVector(direction,length);
    const delta=point.clone().sub(center);
    if(Math.abs(delta.dot(tangent))>mirror.half_length_m || Math.abs(delta.dot(vertical))>mirror.half_height_m)return null;
    const reflected=direction.clone().reflect(normal);
    if(reflected.dot(direction)>-.999)return null;
    return { letter, mirror, origin, direction, point, length, reflected };
  }

  update(snapshot={}) {
    const elapsed=Number(snapshot.elapsed_s||0);
    if(elapsed < this.lastElapsed || snapshot.state==='ready') this.calibrated={A:false,B:false};
    this.lastElapsed=elapsed;
    this.homing=Boolean(snapshot.homing?.active || snapshot.machine_phase==='homing');
    this.group.visible=this.host.explodeAmount===0;
    this.records=[];
    for(const head of this.spec.heads) {
      const channel=this.channels.get(head.part_id); this._hide(channel);
      let candidate=null;
      if(shown(this.host.nodes.get(head.part_id)) && this.group.visible) for(const letter of ['A','B']) {
        const hit=this._mirrorHit(head,letter);
        if(hit && (!candidate || hit.length<candidate.length))candidate=hit;
      }
      if(!candidate) {
        this.records.push({assembly:head.part_id,axis:head.axis,station:head.station,stage:null,hit:false,reason:'移动镜面离开固定光轴'});
        continue;
      }
      const {origin,point,length,direction,letter,reflected}=candidate;
      // Separation of the two colored paths is enlarged 2 mm for readability;
      // metrology below uses the exact, single-return center-line distance.
      const separation=new THREE.Vector3().crossVectors(direction,UP).multiplyScalar(.002);
      this._stretch(channel.forward,origin,point);
      this._stretch(channel.returned,point.clone().add(separation),origin.clone().add(separation));
      const cycle=(elapsed*.85)%1;
      channel.dot.visible=true;
      channel.dot.position.copy(origin).lerp(point, cycle<.5?cycle*2:(1-cycle)*2);
      const displacement=length-this.references.get(head.part_id);
      const phase=4*Math.PI*displacement/this.spec.wavelength_m;
      this.records.push({assembly:head.part_id,axis:head.axis,station:head.station,stage:letter,hit:true,
        from:origin.toArray(),to:point.toArray(),direction:direction.toArray(),return_direction:reflected.toArray(),length_m:length,
        displacement_m:displacement,phase_rad:phase,phase_wrapped_rad:((phase%TAU)+TAU)%TAU,
        fringe_count:phase/TAU,position_from_phase_m:phase*this.spec.wavelength_m/(4*Math.PI)});
    }
    this.zeroRecords=[];
    for(const sensor of this.spec.zero_sensors) {
      const channel=this.zeroChannels.get(sensor.part_id); this._hide(channel);
      const receiver=this._point(sensor.part_id,sensor.receiver_local);
      let closest=null;
      for(const letter of ['A','B']) {
        const cubeSpec=this.spec.stages[letter].corner_cubes[sensor.index];
        const cube=this._point(cubeSpec.part_id,cubeSpec.point_local);
        const lateral=new THREE.Vector2(cube.x-receiver.x,cube.z-receiver.z);
        if(cube.y<=receiver.y || !shown(this.host.nodes.get(cubeSpec.part_id)))continue;
        if(!closest || lateral.length()<closest.error)closest={letter,cube,error:lateral.length(),lateral};
      }
      const capture=!!closest && closest.error<=sensor.capture_radius_m;
      const returned=!!closest && Math.abs(closest.lateral.x*2)<=.007 && Math.abs(closest.lateral.y*2)<=.007;
      const centered=capture && returned && closest.error<=this.spec.zero_tolerance_m;
      if(this.homing && capture && this.group.visible && shown(this.host.nodes.get(sensor.part_id))) {
        // A separate diode and splitter illuminate upward. PSD itself receives.
        const entry=new THREE.Vector3(receiver.x,closest.cube.y,receiver.z);
        const exit=new THREE.Vector3(2*closest.cube.x-receiver.x,closest.cube.y,2*closest.cube.z-receiver.z);
        const spot=new THREE.Vector3(exit.x,receiver.y,exit.z);
        this._stretch(channel.forward,receiver,entry,.0010);
        this._stretch(channel.returned,exit,spot,.0010);
        channel.dot.visible=true;channel.dot.position.copy(spot);
        channel.dot.material.color.set(centered?'#62ffb0':'#ffaf43');
      }
      this.zeroRecords.push({id:sensor.part_id,station:sensor.station,stage:closest?.letter||null,hit:this.homing&&returned&&capture,
        centered:this.homing&&centered,captured:capture,error_m:closest?.error??null,
        spot_offset_m:closest?[2*closest.lateral.x,2*closest.lateral.y]:null,receiver:receiver.toArray(),cube:closest?.cube.toArray()||null});
    }
    for(const letter of ['A','B']) if(this.homing && this.zeroRecords.filter(r=>r.stage===letter && r.centered).length===3)this.calibrated[letter]=true;
    this._updateEncoder();
  }

  _updateEncoder() {
    this._hide(this.encoder);
    const scale=this.host.operations.get('reticle_grating_scale'),readhead=this.host.operations.get('reticle_grating_readhead');
    if(!scale || !readhead)return;
    const origin=readhead.getWorldPosition(new THREE.Vector3());
    const center=scale.getWorldPosition(new THREE.Vector3());
    this.encoderOnScale=Math.abs(origin.x-center.x)<.7;
    this.readheadWorld=origin;
    if(!this.encoderOnScale || !shown(scale) || !shown(readhead))return;
    const target=new THREE.Vector3(origin.x,center.y,center.z);
    this._stretch(this.encoder.forward,origin,target,.0010);
    this.encoder.dot.visible=true;this.encoder.dot.position.copy(target);
  }

  debugState() {
    let drift=0;
    for(const [id,reference] of this.fixedAtRest) {
      const head=this.spec.heads.find(h=>h.part_id===id);
      const point=head?.point_local || this.spec.zero_sensors.find(s=>s.part_id===id).receiver_local;
      drift=Math.max(drift,this._point(id,point).distanceTo(reference));
    }
    return {source:'blender_manifest',homing:this.homing,hardware:{interferometers:4,plane_mirrors:4,corner_cubes:6,psd_receivers:6},
      wavelength_m:this.spec.wavelength_m,phase_model:'single_return_4pi_displacement_over_wavelength',
      axes:['x','y'],six_dof:false,fixed_drift_m:drift,interferometer:this.records,zero_module:this.zeroRecords,
      zero_calibrated:{...this.calibrated},zero_tolerance_m:this.spec.zero_tolerance_m,
      encoder:{on_scale:this.encoderOnScale},readhead_world:this.readheadWorld?.toArray()||null};
  }

  dispose(){this.group.removeFromParent();this.group.traverse(n=>n.material?.dispose());this.geometry.dispose();this.dotGeometry.dispose();}
}
