// cameraRig.js — third-person cinematic camera (from the web-slinger reference):
// orbit, speed-reactive FOV/distance, velocity look-ahead, swing auto-yaw + banking,
// AABB occlusion pull-in.
import * as THREE from 'three';
import { segmentAABB } from './cityBoxes.js?v=9';

const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lat = new THREE.Vector3();

export class CameraRig {
  constructor(camera, boxWorld) {
    this.camera = camera;
    this.bw = boxWorld;
    this.smoothLook = new THREE.Vector3();
    this.dist = 5;
    this.collT = 1;
    this.fov = camera.fov;
    this.roll = 0;
    this.initialized = false;

    // cinematic hand-off: blend from an external camera pose (the aerial menu
    // shot) into the rig's own framing over a short window
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.blendT = 0;
    this.blendDur = 1;
  }

  blendFrom(camera, dur = 1.5) {
    this.fromPos.copy(camera.position);
    this.fromQuat.copy(camera.quaternion);
    this.blendT = this.blendDur = dur;
  }

  forward(out, input) {
    const cp = Math.cos(input.pitch), sp = Math.sin(input.pitch);
    const cy = Math.cos(input.yaw), sy = Math.sin(input.yaw);
    return out.set(-sy * cp, sp, -cy * cp);
  }

  update(dt, input, ctrl) {
    const cam = this.camera;
    const speed = ctrl.vel.length();
    const speedN = Math.min(1, speed / 52);

    // gentle auto-yaw toward travel direction while swinging/zipping
    if (ctrl.mode === 'swing' || ctrl.mode === 'zip') {
      const hsp = Math.hypot(ctrl.vel.x, ctrl.vel.z);
      if (hsp > 6) {
        const travelYaw = Math.atan2(-ctrl.vel.x, -ctrl.vel.z);
        let dy = travelYaw - input.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        input.yaw += dy * Math.min(1, 1.1 * dt);
      }
    }

    _look.copy(ctrl.pos);
    _look.y += 1.35;
    _lat.copy(ctrl.vel).multiplyScalar(0.16);
    if (_lat.length() > 4.5) _lat.setLength(4.5);
    _look.add(_lat);
    if (!this.initialized) {
      this.smoothLook.copy(_look);
      this.initialized = true;
    }
    this.smoothLook.lerp(_look, 1 - Math.exp(-11 * dt));

    this.forward(_dir, input);

    let targetDist = 4.2 + speedN * 3.6 + (ctrl.mode === 'swing' ? 1.1 : 0);
    this.dist += (targetDist - this.dist) * (1 - Math.exp(-4 * dt));

    _desired.copy(this.smoothLook).addScaledVector(_dir, -this.dist);

    // occlusion: snap in, ease back out
    let t = 1;
    const ids = this.bw.queryNearby(this.smoothLook.x, this.smoothLook.z, this.dist + 12);
    for (const idx of ids) {
      const b = this.bw.aabbs[idx];
      if (!b.collide) continue;
      const hit = segmentAABB(this.smoothLook, _desired, b, 0.28);
      if (hit < t) t = hit;
    }
    if (t < this.collT) this.collT = t;
    else this.collT += (t - this.collT) * (1 - Math.exp(-3.5 * dt));
    const boom = Math.max(1.7, this.dist * this.collT * 0.97);
    _desired.copy(this.smoothLook).addScaledVector(_dir, -boom);
    if (_desired.y < 0.6) _desired.y = 0.6;
    cam.position.copy(_desired);

    cam.lookAt(this.smoothLook);

    let targetRoll = 0;
    if (ctrl.mode === 'swing' || ctrl.mode === 'air' || ctrl.mode === 'zip') {
      const rightX = Math.cos(input.yaw), rightZ = -Math.sin(input.yaw);
      const lat = ctrl.vel.x * rightX + ctrl.vel.z * rightZ;
      targetRoll = THREE.MathUtils.clamp(-lat * 0.0035, -0.10, 0.10);
    }
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-5 * dt));
    cam.rotateZ(this.roll);

    const targetFov = 62 + speedN * 17 + (ctrl.diving ? 6 : 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-4.5 * dt));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // menu → dive hand-off: ease from the stored pose into the rig's framing
    if (this.blendT > 0) {
      this.blendT = Math.max(0, this.blendT - dt);
      const k = this.blendT / this.blendDur;       // 1 → 0
      const e = k * k * (3 - 2 * k);               // smooth both ends
      cam.position.lerp(this.fromPos, e);
      cam.quaternion.slerp(this.fromQuat, e);
    }
  }
}
