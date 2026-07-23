// controller.js — movement + web physics, adapted from the web-slinger reference.
// Semi-implicit Euler; swing = true pendulum with a SPEED-LIMITED rope correction
// (no energy pumping), pump/steer/reel, raycast ground, zip. Walls: AABB broad
// phase, but every push/anchor/zip is VERIFIED against real geometry via castFn
// (boxes are per-material bounds and can cover open air — L-shaped towers,
// spanning props). Modes: ground | air | swing | wallrun | zip.
import * as THREE from 'three';

const G_AIR = 30, G_SWING = 26;
const WALK = 8.5, SPRINT = 14;
const JUMP_V = 13;
const AIR_ACCEL = 14, AIR_MAX = 17;
const PUMP = 16, STEER = 9, REEL = 12;   // stronger pump/reel = higher arcs
const ZIP_SPEED = 40;
const MAX_SPEED = 68;
const R = 0.42, BODY_H = 1.7;
const STEP_H = 0.5;                 // ledges lower than this step up via ground snap

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _move = new THREE.Vector3();
const _o = new THREE.Vector3();     // ray origin scratch
const _rdir = new THREE.Vector3();  // ray direction scratch
const DOWN = new THREE.Vector3(0, -1, 0);

export class Controller {
  constructor(boxWorld, groundFn, castFn, events = {}) {
    this.bw = boxWorld;              // {aabbs, queryNearby}
    this.groundFn = groundFn;        // (x, z, yFrom) => groundY|null   (raycast on real geometry)
    this.castFn = castFn;            // (origin, dir, far) => {point, normal, distance}|null
    this.events = events;
    this.pos = new THREE.Vector3();
    this.prevY = 0;
    this.vel = new THREE.Vector3();
    this.mode = 'air';

    this.anchor = new THREE.Vector3();
    this.webOn = false;
    this.ropeLen = 0;
    this.webHand = 'R';
    this.attachCooldown = 0;

    this.zipTarget = new THREE.Vector3();
    this.zipTimer = 0;

    this.wallNormal = new THREE.Vector3();
    this.wallrunTime = 0;

    this.coyote = 0;
    this.flipT = 0;
    this.steer = 0;
    this.diving = false;
    this.airTime = 0;

    // last spot we stood on solid ground for a while — void-fall rescue target
    this.lastSafe = new THREE.Vector3();
    this.hasSafe = false;
    this.safeTimer = 0;
  }

  rescueTo(p) {
    this.pos.set(p.x, p.y + 0.5, p.z);
    this.prevY = this.pos.y;
    this.vel.set(0, 0, 0);
    this.mode = 'air';
    this.webOn = false;
    this.airTime = 0;
    this.attachCooldown = 0;
  }

  diveFrom(p, v) {
    this.pos.copy(p);
    this.prevY = p.y;
    this.vel.copy(v);
    this.mode = 'air';
    this.webOn = false;
    this.airTime = 0;
    this.attachCooldown = 0;
  }

  groundY() {
    return this.groundFn(this.pos.x, this.pos.z, this.pos.y + 3, this.pos.y);
  }

  hasSupport() {
    // real geometry only — groundFn multi-probes around the feet, which also
    // covers box-top standing (roofs are geometry too)
    const gh = this.groundY();
    return gh !== null && Math.abs(this.pos.y - gh) < 0.3;
  }

  update(dt, input, camYaw, camDir) {
    const { bw } = this;
    this.attachCooldown = Math.max(0, this.attachCooldown - dt);
    this.flipT = Math.max(0, this.flipT - dt);
    if (this.mode !== 'ground') this.safeTimer = 0;
    if (input.pressed('KeyR')) this.events.onReset?.();

    input.moveVector(_move);
    const space = input.down('Space');
    const spaceTap = input.pressed('Space');
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    const fwdHeld = input.down('KeyW');
    this.diving = false;
    this.steer = 0;

    _fwd.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));

    // ------------------------------------------------ ground
    if (this.mode === 'ground') {
      this.wallrunTime = 0;
      this.airTime = 0;
      this.safeTimer += dt;
      if (this.safeTimer > 0.5) {          // stood here a while — remember as rescue point
        this.lastSafe.copy(this.pos);
        this.hasSafe = true;
        this.safeTimer = 0;
      }
      const maxSp = shift ? SPRINT : WALK;
      const hsp = Math.hypot(this.vel.x, this.vel.z);
      const rate = hsp > SPRINT + 1 ? 2.2 : 10;      // preserve landing momentum
      const k = 1 - Math.exp(-rate * dt);
      this.vel.x += (_move.x * maxSp - this.vel.x) * k;
      this.vel.z += (_move.z * maxSp - this.vel.z) * k;
      this.vel.y = 0;

      if (spaceTap) {
        this.vel.y = JUMP_V + (shift ? 1.5 : 0);
        this.vel.x *= 1.06; this.vel.z *= 1.06;
        this.mode = 'air';
        this.coyote = 0;
        this.events.onJump?.();
      } else if (!this.hasSupport()) {
        this.coyote += dt;
        if (this.coyote > 0.12) this.mode = 'air';
      } else {
        this.coyote = 0;
      }
    }

    // ------------------------------------------------ air
    if (this.mode === 'air') {
      this.airTime += dt;
      if (space && !this.webOn && this.attachCooldown <= 0 && this.airTime > 0.18) {
        this.tryAttach(camDir);
      }
      if (input.pressed('KeyE') || input.pressed('RMB')) this.tryZip(camDir);

      this.diving = input.down('KeyS') && this.vel.y < 5;
      const g = this.diving ? 38 : G_AIR;
      this.vel.y -= g * dt;

      const hsp = Math.hypot(this.vel.x, this.vel.z);
      if (_move.lengthSq() > 0) {
        const cap = Math.max(AIR_MAX, hsp);
        this.vel.x += _move.x * AIR_ACCEL * dt;
        this.vel.z += _move.z * AIR_ACCEL * dt;
        const nh = Math.hypot(this.vel.x, this.vel.z);
        if (nh > cap) { const s = cap / nh; this.vel.x *= s; this.vel.z *= s; }
      }
      const sp = this.vel.length();
      const drag = (this.diving ? 0.3 : 1) * (0.015 + 0.0016 * sp);
      this.vel.multiplyScalar(Math.max(0, 1 - drag * dt * 3));
    }

    // ------------------------------------------------ swing
    if (this.mode === 'swing') {
      if (!space) {
        this.detach();
        if (this.vel.y > 0) this.vel.y = Math.min(this.vel.y * 1.22, 34);   // release reward
        this.vel.x *= 1.045; this.vel.z *= 1.045;
        if (this.vel.length() > 15) this.flipT = 0.62;
      } else {
        this.vel.y -= G_SWING * dt;
        _d.copy(this.pos).sub(this.anchor);
        const dist = _d.length();
        const n = _d.divideScalar(Math.max(dist, 1e-6));
        const bottom = THREE.MathUtils.clamp(-n.y, 0, 1);

        if (fwdHeld) {
          _v.copy(this.vel); _v.y = 0;
          if (_v.lengthSq() > 1) _v.normalize();
          else _v.copy(_fwd);
          this.vel.addScaledVector(_v, PUMP * (0.35 + 0.65 * bottom) * dt);
        }
        const right = _v2.set(-_fwd.z, 0, _fwd.x);
        if (input.down('KeyA')) { this.vel.addScaledVector(right, -STEER * dt); this.steer = -1; }
        if (input.down('KeyD')) { this.vel.addScaledVector(right, STEER * dt); this.steer = 1; }
        if (shift) this.ropeLen = Math.max(3.5, this.ropeLen - REEL * dt);
        if (input.pressed('KeyE') || input.pressed('RMB')) { this.detach(); this.tryZip(camDir); }

        const ssp = this.vel.length();
        const sdrag = 0.006 + 0.0008 * ssp;   // keep more energy in the arc
        this.vel.multiplyScalar(Math.max(0, 1 - sdrag * dt * 3));
      }
    }

    // ------------------------------------------------ wallrun
    if (this.mode === 'wallrun') {
      this.wallrunTime += dt;
      this.vel.y -= 17 * dt;
      this.vel.x *= Math.max(0, 1 - 4 * dt);
      this.vel.z *= Math.max(0, 1 - 4 * dt);
      this.vel.addScaledVector(this.wallNormal, -2 * dt);
      const intoWall = _move.dot(this.wallNormal) < -0.3;
      if (spaceTap) {
        this.vel.copy(this.wallNormal).multiplyScalar(11);
        this.vel.y = 11.5;
        this.vel.addScaledVector(_fwd, 4);
        this.mode = 'air';
        this.flipT = 0.4;
        this.events.onJump?.();
      } else if (!intoWall || this.vel.y < -4 || this.wallrunTime > 1.15) {
        this.mode = 'air';
        this.vel.addScaledVector(this.wallNormal, 1.5);
      }
    }

    // ------------------------------------------------ zip
    if (this.mode === 'zip') {
      this.zipTimer -= dt;
      _d.copy(this.zipTarget).sub(this.pos);
      const dist = _d.length();
      if (dist < 3 || this.zipTimer <= 0) {
        this.mode = 'air';
        this.webOn = false;
        this.vel.multiplyScalar(0.5);
        this.vel.y = Math.max(this.vel.y, 4.5);
      } else {
        _d.divideScalar(dist);
        const sp = Math.max(ZIP_SPEED, this.vel.length());
        this.vel.lerp(_v.copy(_d).multiplyScalar(sp), Math.min(1, 14 * dt));
      }
    }

    const sp = this.vel.length();
    if (sp > MAX_SPEED) this.vel.multiplyScalar(MAX_SPEED / sp);

    // ------------------------------------------------ integrate
    this.prevY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);

    // rope constraint AFTER integration: hard sphere, but the positional correction
    // is SPEED-LIMITED — a clamped rope reels smoothly instead of teleporting
    // (which would pump energy into the pendulum)
    if (this.mode === 'swing' && this.webOn) {
      _d.copy(this.pos).sub(this.anchor);
      const dist = _d.length();
      if (dist > this.ropeLen) {
        const n = _d.divideScalar(dist);
        const excess = dist - this.ropeLen;
        const corr = Math.min(excess, 28 * dt);
        this.pos.addScaledVector(n, -corr);
        const vn = this.vel.dot(n);
        if (vn > 0) this.vel.addScaledVector(n, -vn);
      }
    }

    this.resolveCollisions(dt);
  }

  // ------------------------------------------------ attach / detach / zip

  tryAttach(camDir) {
    const speed = this.vel.length();
    const aimUp = Math.max(0, camDir.y);   // vertical aim intent — captured BEFORE flattening
    _fwd.copy(camDir);
    if (speed > 8) {                 // blend camera dir with travel direction
      _v.copy(this.vel).normalize();
      _fwd.lerp(_v, 0.45).normalize();
    }
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.01) return;
    _fwd.normalize();

    const anchor = this.findAnchor(_fwd, speed, aimUp);
    if (!anchor) return;

    this.anchor.copy(anchor);
    this.webOn = true;
    this.mode = 'swing';
    let len = this.pos.distanceTo(anchor) * 0.96;
    len = Math.min(len, this.anchor.y - 3.2);      // street clearance at arc bottom
    this.ropeLen = Math.max(3.5, len);
    const cross = (anchor.x - this.pos.x) * _fwd.z - (anchor.z - this.pos.z) * _fwd.x;
    this.webHand = cross > 0 ? 'L' : 'R';
    this.attachCooldown = 0.15;
    this.events.onThwip?.();
  }

  detach() {
    this.webOn = false;
    this.mode = 'air';
    this.attachCooldown = 0.12;
    this.events.onRelease?.();
  }

  findAnchor(fwd, speed, up = 0) {
    const { aabbs, queryNearby } = this.bw;
    const ids = queryNearby(this.pos.x, this.pos.z, 110);
    // anchor ceiling: speed raises it a little, AIMING UP raises it a lot —
    // look at a tower and the web goes high (level aim keeps the old feel,
    // and steep rays clear the low street clutter that intercepts flat shots)
    const AH = THREE.MathUtils.clamp(16 + speed * 0.55 + up * 75, 18, 88);
    const px = this.pos.x + fwd.x * 30;
    const pz = this.pos.z + fwd.z * 30;

    // broad phase: score candidate facade points on nearby boxes
    const cands = [];
    for (const idx of ids) {
      const b = aabbs[idx];
      if (b.y1 < this.pos.y + 9) continue;
      const ay = Math.min(b.y1 - 1, this.pos.y + AH);
      if (ay < this.pos.y + 8) continue;

      let ax = THREE.MathUtils.clamp(px, b.x0, b.x1);
      let az = THREE.MathUtils.clamp(pz, b.z0, b.z1);
      const dx0 = ax - b.x0, dx1 = b.x1 - ax, dz0 = az - b.z0, dz1 = b.z1 - az;
      const m = Math.min(dx0, dx1, dz0, dz1);
      if (m === dx0) ax = b.x0; else if (m === dx1) ax = b.x1;
      else if (m === dz0) az = b.z0; else az = b.z1;

      const dx = ax - this.pos.x, dy = ay - this.pos.y, dz = az - this.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 7 || dist > 110) continue;
      const dh = Math.hypot(dx, dz);
      const f = dh > 0.5 ? (dx * fwd.x + dz * fwd.z) / dh : 0;
      if (f < -0.05) continue;

      cands.push({ score: 2.0 * dy + 55 * f - 0.7 * Math.abs(dist - 34), x: ax, y: ay, z: az });
    }
    cands.sort((a, b) => b.score - a.score);

    // narrow phase: the web must END ON REAL GEOMETRY. Cast toward each
    // candidate and take the first surface the strand actually meets — this
    // both snaps the anchor onto the facade (boxes overhang open air) and
    // doubles as the line-of-sight check.
    _o.copy(this.pos); _o.y += 1.6;
    for (let i = 0; i < cands.length && i < 10; i++) {
      const c = cands[i];
      _rdir.set(c.x - _o.x, c.y - _o.y, c.z - _o.z);
      const dist = _rdir.length();
      _rdir.divideScalar(dist);
      const hit = this.castFn(_o, _rdir, Math.min(dist * 1.45 + 12, 150));
      if (!hit || hit.distance < 6) continue;          // nothing there / face in your face
      if (hit.point.y < this.pos.y + 7) continue;      // too low to swing from
      return hit.point;
    }
    return null;
  }

  tryZip(camDir) {
    const { aabbs, queryNearby } = this.bw;
    const ids = queryNearby(this.pos.x, this.pos.z, 115);
    _o.copy(this.pos); _o.y += 1.5;

    // broad phase: score box-top edge points in the camera direction
    const cands = [];
    for (const idx of ids) {
      const b = aabbs[idx];
      if (b.y1 < this.pos.y - 4) continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const pts = [
        [b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1],
        [cx, b.z0], [cx, b.z1], [b.x0, cz], [b.x1, cz],
      ];
      for (const [x, z] of pts) {
        const dx = x - _o.x, dy = b.y1 + 0.5 - _o.y, dz = z - _o.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 6 || dist > 115) continue;
        const align = (dx * camDir.x + dy * camDir.y + dz * camDir.z) / dist;
        if (align < 0.80) continue;
        cands.push({ score: align * 120 + dy * 0.4 - dist * 0.12, x, z, cx, cz, y1: b.y1 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    // narrow phase: the corner must have REAL ROOF under it (box tops of
    // spire-topped towers float above the actual roof) and a clear path
    for (let i = 0; i < cands.length && i < 8; i++) {
      const c = cands[i];
      // probe slightly inboard so a roof-edge point still finds the roof
      let ix = c.cx - c.x, iz = c.cz - c.z;
      const il = Math.hypot(ix, iz) || 1;
      const px = c.x + (ix / il) * 0.35, pz = c.z + (iz / il) * 0.35;
      const roof = this.castFn(_v.set(px, c.y1 + 2.5, pz), DOWN, 8);
      if (!roof) continue;
      const ty = roof.point.y + 0.5;
      _rdir.set(px - _o.x, ty - _o.y, pz - _o.z);
      const dist = _rdir.length();
      if (dist < 6) continue;
      _rdir.divideScalar(dist);
      if (this.castFn(_o, _rdir, dist - 1.5)) continue;   // path blocked
      this.zipTarget.set(px, ty, pz);
      this.zipTimer = 1.6;
      this.mode = 'zip';
      this.webOn = true;
      this.anchor.copy(this.zipTarget);
      this.webHand = 'R';
      this.events.onThwip?.();
      return;
    }
  }

  // ------------------------------------------------ collisions

  land(supportY) {
    const impact = -this.vel.y;
    this.pos.y = supportY;
    this.vel.y = 0;
    if (this.mode !== 'ground') {
      const hsp = Math.hypot(this.vel.x, this.vel.z);
      if (impact > 15 && hsp > 9) { this.vel.x *= 0.8; this.vel.z *= 0.8; }
      else if (impact > 15) { this.vel.x *= 0.35; this.vel.z *= 0.35; }
      if (this.webOn) this.detach();
      this.mode = 'ground';
      this.events.onLand?.(impact);
    }
  }

  resolveCollisions(dt) {
    // raycast ground (real geometry — streets, cars, slums, metro floors,
    // roofs; groundFn multi-probes so tile seams can't swallow the player).
    // Cast from the pre-integration height so a fast fall can't tunnel a roof.
    // high-altitude fast falls: if the last query found nothing, skip 2 frames
    // (ray reaches 11 m below the feet; worst-case advance between checks at
    // 68 m/s / 60 fps is ~3.4 m — plenty of margin, big saving during the dive)
    if (this._groundSkip > 0 && this.vel.y < -20 && this.pos.y > 40) {
      this._groundSkip--;
      return this.resolveWalls(dt);
    }
    const gh = this.groundFn(this.pos.x, this.pos.z,
                             Math.max(this.pos.y + 3, this.prevY + 0.3), this.pos.y);
    this._groundSkip = (gh === null && this.vel.y < -20 && this.pos.y > 40) ? 2 : 0;
    // land only when we actually crossed the surface from above this frame, or
    // it's a small step-up — otherwise walking/swinging UNDER a low canopy or
    // walkway teleports you onto its roof (the down-ray sees its top as "ground")
    if (gh !== null && this.pos.y < gh && this.vel.y <= 0 &&
        (this.prevY + 0.3 >= gh || gh - this.pos.y < 0.55)) {
      this.land(gh);
    }

    this.resolveWalls(dt);
  }

  resolveWalls(dt) {
    // swept rays along horizontal motion: real-geometry walls the boxes can't
    // represent (slum shacks, interior walls) + anti-tunneling at high speed.
    // THREE heights — a single chest ray let low rails and high beams clip
    const hsp = Math.hypot(this.vel.x, this.vel.z);
    if (hsp > 0.5 && dt > 0) {
      _rdir.set(this.vel.x / hsp, 0, this.vel.z / hsp);
      let hit = null;
      // chest ray EVERY frame (anti-tunneling); knee/head rays alternate frames
      // (rails & beams move slowly relative to us — 30 Hz coverage is plenty,
      // and tripling every-frame rays measurably hurt the step time)
      this._sweepPhase = !this._sweepPhase;
      const heights = this._sweepPhase ? [0.95, 0.35] : [0.95, 1.5];
      for (const hy of heights) {
        _o.set(this.pos.x - this.vel.x * dt, this.pos.y + hy, this.pos.z - this.vel.z * dt);
        const h = this.castFn(_o, _rdir, hsp * dt + R + 0.12);
        if (h && h.normal && (!hit || h.distance < hit.distance)) hit = h;
      }
      _o.set(this.pos.x - this.vel.x * dt, 0, this.pos.z - this.vel.z * dt);   // xz reference for pushback
      if (hit && hit.normal) {
        let nx = hit.normal.x, nz = hit.normal.z;
        const nh = Math.hypot(nx, nz);
        if (nh > 0.35) {                              // wall-ish, not a ramp/floor
          nx /= nh; nz /= nh;
          if (nx * _rdir.x + nz * _rdir.z > 0) { nx = -nx; nz = -nz; }
          const back = Math.max(0, hit.distance - R);
          this.pos.x = _o.x + _rdir.x * back;
          this.pos.z = _o.z + _rdir.z * back;
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; }
        }
      }
    }

    // AABB broad phase; every push is VERIFIED against real geometry, so an
    // oversized box (L-shaped tower, spanning prop) can't become an air wall
    const ids = this.bw.queryNearby(this.pos.x, this.pos.z, 3);
    for (const idx of ids) {
      const b = this.bw.aabbs[idx];
      if (!b.collide) continue;
      if (b.y1 - this.pos.y < STEP_H) continue;       // steppable — ground snap raises us
      if (this.pos.y + BODY_H <= b.y0) continue;
      const inX = this.pos.x > b.x0 - R && this.pos.x < b.x1 + R;
      const inZ = this.pos.z > b.z0 - R && this.pos.z < b.z1 + R;
      if (!inX || !inZ) continue;

      const px0 = this.pos.x - (b.x0 - R);
      const px1 = (b.x1 + R) - this.pos.x;
      const pz0 = this.pos.z - (b.z0 - R);
      const pz1 = (b.z1 + R) - this.pos.z;
      const m = Math.min(px0, px1, pz0, pz1);
      let nx = 0, nz = 0;
      if (m === px0) nx = -1;
      else if (m === px1) nx = 1;
      else if (m === pz0) nz = -1;
      else nz = 1;

      // verify the face is real: probe INTO the box at two heights; if neither
      // ray meets geometry within arm's reach, the box is hollow here — pass
      let real = false;
      for (const dy of [0.35, 1.35]) {
        const ry = THREE.MathUtils.clamp(this.pos.y + dy, b.y0 + 0.05, Math.max(b.y0 + 0.05, b.y1 - 0.05));
        _o.set(this.pos.x, ry, this.pos.z);
        _rdir.set(-nx, 0, -nz);
        if (this.castFn(_o, _rdir, R + 0.8)) { real = true; break; }
      }
      if (!real) continue;

      if (nx < 0) this.pos.x = b.x0 - R;
      else if (nx > 0) this.pos.x = b.x1 + R;
      else if (nz < 0) this.pos.z = b.z0 - R;
      else this.pos.z = b.z1 + R;

      const vin = -(this.vel.x * nx + this.vel.z * nz);
      if (this.mode === 'air' && vin > 3.5 &&
          _move.x * nx + _move.z * nz < -0.35 &&
          this.vel.y > -14 && this.wallrunTime < 1.15) {
        this.wallNormal.set(nx, 0, nz);
        this.mode = 'wallrun';
        if (this.webOn) this.detach();
        this.vel.y = Math.max(this.vel.y * 0.4 + 8, 9);
        this.events.onWallrun?.();
      }

      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; }
    }
  }
}
