// player.js — character visual layer: Survivors skin + animation state mapping
// driven by the Controller, plus the bezier web rope. All physics lives in
// controller.js (adapted from the web-slinger reference).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const dracoLoader = new DRACOLoader().setDecoderPath('./vendor/draco/');

// Keep only rotation tracks (+ pelvis position): scale tracks and the other
// constant rest-offset position tracks fight the rig.
function cleanClip(clip) {
  clip.tracks = clip.tracks.filter(tr => {
    const dot = tr.name.lastIndexOf('.');
    const bone = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
    if (prop === 'scale') return false;
    if (prop === 'position' && bone !== 'pelvis') return false;
    return true;
  });
  return clip;
}

const TRAVERSAL_CLIPS = {
  idle: 'Movement_Idle',
  walk: 'Movement_Walk_Forward',
  run: 'Movement_Run_Forward',
  jumpRun: 'Movement_Jump_fromRun_toRun',
  jumpLoop: 'Movement_Jump_InPlace_Loop',
  landSoft: 'Movement_Jump_InPlace_Landing',
  landRoll: 'Movement_Landing_Roll_toRun',
  fall: 'BarSwing_ForwardAcross_SwingJump_FallingLoop',
  swing: 'BarSwing_ForwardAcross_SwingLoop',
  swingJump: 'BarSwing_ForwardAcross_SwingJump',
};
const STRIP_PELVIS_POS = new Set(['swing', 'fall', 'jumpLoop', 'landRoll']);
const BLADE_UP = new THREE.Vector3(0, 1, 0);
const TRAIL_INNER_COLOR = new THREE.Color(0x159bb2);
const TRAIL_TIP_COLOR = new THREE.Color(0xd5ffff);
const TRAIL_SAMPLES = 11;
const ATTACK_PROFILES = {
  basic: { duration: 0.42, lockout: 0.48, impact: 0.40, damage: 40, emitImpact: true },
  dash: { duration: 0.36, lockout: 0.42, impact: 0.28, damage: 60, emitImpact: false },
  spin: { duration: 0.62, lockout: 0.66, impact: 0.34, damage: 45, emitImpact: false },
  wave: { duration: 0.42, lockout: 0.46, impact: 0.32, damage: 50, emitImpact: false },
};

function createBladeShape() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.045, 0.20);
  shape.lineTo(-0.020, 1.46);
  shape.quadraticCurveTo(0.015, 1.70, 0.125, 1.91);
  shape.quadraticCurveTo(0.145, 1.68, 0.105, 1.49);
  shape.lineTo(0.065, 0.20);
  shape.closePath();
  return shape;
}

export class Player {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mixer = null;
    this.actions = {};
    this.cur = null;
    this.yaw = Math.PI;
    this.bones = {};
    this.landTimer = 0;
    this.loaded = false;
    this.enabled = true;
    this.attackActive = false;
    this.attackKind = 'basic';
    this.attackProfile = ATTACK_PROFILES.basic;
    this.attackElapsed = 0;
    this.attackDuration = 0.42;
    this.attackCooldown = 0;
    this.attackImpactSent = false;
    this.pendingAttackImpact = null;
    this.bladePose = null;

    this._bladeHand = new THREE.Vector3();
    this._bladeDir = new THREE.Vector3();
    this._bladeForward = new THREE.Vector3();
    this._bladeRight = new THREE.Vector3();
    this._bladeBase = new THREE.Vector3();
    this._bladeTip = new THREE.Vector3();
    this._bladeQuat = new THREE.Quaternion();
    this._trailSamples = [];

    this.createEnergyBlade();

    // web rope: 6-segment cylinder chain (bezier with slack sag)
    this.webGroup = new THREE.Group();
    this.webGroup.visible = false;
    scene.add(this.webGroup);
    this.webMat = new THREE.MeshStandardMaterial({
      color: 0xeaeae6, roughness: 0.5, metalness: 0,
      emissive: 0x555552, emissiveIntensity: 0.5,
    });
    this.webSegs = [];
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 5), this.webMat);
      this.webGroup.add(seg);
      this.webSegs.push(seg);
    }
  }

  createEnergyBlade() {
    this.bladeRoot = new THREE.Group();
    this.bladeRoot.visible = false;
    this.scene.add(this.bladeRoot);

    const hiltMat = new THREE.MeshStandardMaterial({
      color: 0x101725, metalness: 0.94, roughness: 0.22,
      emissive: 0x092438, emissiveIntensity: 0.48,
    });
    const edgeMat = new THREE.MeshStandardMaterial({
      color: 0x34455a, metalness: 0.98, roughness: 0.17,
      emissive: 0x14364b, emissiveIntensity: 0.7,
    });
    const gripMat = new THREE.MeshStandardMaterial({
      color: 0x03060b, metalness: 0.44, roughness: 0.64,
    });
    const emitterMat = new THREE.MeshBasicMaterial({
      color: 0x9cffff, toneMapped: false,
    });

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.34, 10), gripMat);
    grip.position.y = -0.015;
    this.bladeRoot.add(grip);

    for (let i = 0; i < 6; i++) {
      const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.054, 0.0065, 4, 10), edgeMat);
      wrap.position.y = -0.155 + i * 0.055;
      wrap.rotation.x = Math.PI / 2;
      this.bladeRoot.add(wrap);
    }

    const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.052, 0.085, 8), edgeMat);
    pommel.position.y = -0.235;
    this.bladeRoot.add(pommel);

    const pommelCap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.058, 0.07, 8), hiltMat);
    pommelCap.position.y = -0.315;
    this.bladeRoot.add(pommelCap);

    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.055, 0.07), hiltMat);
    guard.position.y = 0.205;
    this.bladeRoot.add(guard);

    for (const side of [-1, 1]) {
      const prong = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.034, 0.16, 6), edgeMat);
      prong.position.set(side * 0.145, 0.245, 0);
      prong.rotation.z = side * -1.02;
      this.bladeRoot.add(prong);

      const node = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), emitterMat);
      node.position.set(side * 0.205, 0.288, 0);
      this.bladeRoot.add(node);
    }

    const emitter = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.115, 10), edgeMat);
    emitter.position.y = 0.285;
    this.bladeRoot.add(emitter);

    const emitterRing = new THREE.Mesh(new THREE.TorusGeometry(0.061, 0.01, 6, 16), emitterMat);
    emitterRing.position.y = 0.35;
    emitterRing.rotation.x = Math.PI / 2;
    this.bladeRoot.add(emitterRing);
    this.bladeEmitterMat = emitterMat;

    const bladeShape = createBladeShape();
    const coreGeometry = new THREE.ExtrudeGeometry(bladeShape, {
      depth: 0.034,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.012,
      bevelThickness: 0.012,
    });
    coreGeometry.translate(0, 0, -0.017);
    this.bladeCore = new THREE.Mesh(coreGeometry, new THREE.MeshBasicMaterial({
      color: 0xcaffff,
      toneMapped: false,
    }));
    this.bladeCore.renderOrder = 8;
    this.bladeRoot.add(this.bladeCore);

    const bladePlaneGeometry = new THREE.ShapeGeometry(bladeShape, 16);
    this.bladeGlowLayers = [];
    for (const [rotation, scale, opacity, color] of [
      [0, 1.42, 0.34, 0x26eaff],
      [Math.PI / 2, 1.15, 0.22, 0x56f6ff],
      [0, 2.18, 0.11, 0x18c9ff],
      [Math.PI / 2, 1.76, 0.08, 0x18c9ff],
    ]) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const layer = new THREE.Mesh(bladePlaneGeometry, material);
      layer.rotation.y = rotation;
      layer.scale.x = scale;
      layer.userData.baseScale = scale;
      layer.userData.baseOpacity = opacity;
      layer.renderOrder = 7;
      this.bladeRoot.add(layer);
      this.bladeGlowLayers.push(layer);
    }

    this.bladeLight = new THREE.PointLight(0x31eaff, 2.0, 5.8, 2);
    this.bladeLight.position.y = 1.02;
    this.bladeRoot.add(this.bladeLight);

    this.bladeTrailGeo = new THREE.BufferGeometry();
    this.bladeTrailPos = new Float32Array((TRAIL_SAMPLES - 1) * 6 * 3);
    this.bladeTrailColors = new Float32Array((TRAIL_SAMPLES - 1) * 6 * 3);
    this.bladeTrailGeo.setAttribute(
      'position', new THREE.BufferAttribute(this.bladeTrailPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.bladeTrailGeo.setAttribute(
      'color', new THREE.BufferAttribute(this.bladeTrailColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.bladeTrailGeo.setDrawRange(0, 0);
    this.bladeTrail = new THREE.Mesh(this.bladeTrailGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    this.bladeTrail.frustumCulled = false;
    this.bladeTrail.visible = false;
    this.scene.add(this.bladeTrail);

    this.bladeEdgeTrailGeo = new THREE.BufferGeometry();
    this.bladeEdgeTrailPos = new Float32Array((TRAIL_SAMPLES - 1) * 2 * 3);
    this.bladeEdgeTrailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.bladeEdgeTrailPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.bladeEdgeTrailGeo.setDrawRange(0, 0);
    this.bladeEdgeTrail = new THREE.LineSegments(
      this.bladeEdgeTrailGeo,
      new THREE.LineBasicMaterial({
        color: 0xd8ffff,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
    this.bladeEdgeTrail.frustumCulled = false;
    this.bladeEdgeTrail.visible = false;
    this.scene.add(this.bladeEdgeTrail);
  }

  async load(gender, matFactory, manager) {
    const loader = new GLTFLoader(manager || undefined).setDRACOLoader(dracoLoader);
    const gltf = await loader.loadAsync(`./chars/glb/${gender}.glb`);
    this.model = gltf.scene;
    this.model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.material = matFactory(o.material?.name);
        o.frustumCulled = false;
      }
      if (o.isBone) this.bones[o.name] = o;
    });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);

    const clips = {};
    for (const [key, file] of Object.entries(TRAVERSAL_CLIPS)) {
      const g = await loader.loadAsync(`./chars/anims/${file}.glb`);
      const clip = g.animations[0];
      if (!clip) { console.warn('no anim in', file); continue; }
      cleanClip(clip);
      if (STRIP_PELVIS_POS.has(key))
        clip.tracks = clip.tracks.filter(t => t.name !== 'pelvis.position');
      clips[key] = clip;
    }
    // sprint = the run clip at a higher tempo. The pack has no UE4-native
    // sprint; the MovementAnimsetPro one is on a Mixamo rig whose joint
    // frames don't match this skeleton — a name-only track remap tilts and
    // deforms the body (true retargeting needs bind-pose deltas).
    if (clips.run) {
      const c = clips.run.clone();
      c.name = 'SprintFromRun';
      clips.sprint = c;
    }
    for (const [key, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.clampWhenFinished = true;
      if (key === 'sprint') a.timeScale = 1.3;   // 11 m/s stride cadence -> ~14 m/s
      this.actions[key] = a;
    }
    this.play('idle', 0);
    this.loaded = true;
    this.bladeRoot.visible = this.enabled;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.group.visible = enabled;
    this.bladeRoot.visible = enabled && this.loaded;
    if (!enabled) {
      this.webGroup.visible = false;
      this.bladeTrail.visible = false;
      this.bladeEdgeTrail.visible = false;
      this._trailSamples.length = 0;
    }
  }

  startAttack(kind = 'basic') {
    if (!this.loaded || !this.enabled || this.attackActive || this.attackCooldown > 0 ||
        this.bladePose === 'slam') return false;
    const profile = ATTACK_PROFILES[kind] || ATTACK_PROFILES.basic;
    this.attackActive = true;
    this.attackKind = kind;
    this.attackProfile = profile;
    this.attackElapsed = 0;
    this.attackDuration = profile.duration;
    this.attackImpactSent = false;
    this.pendingAttackImpact = null;
    this.attackCooldown = profile.lockout;
    this._trailSamples.length = 0;
    return true;
  }

  setBladePose(pose) {
    this.bladePose = pose;
  }

  consumeAttackImpact() {
    const impact = this.pendingAttackImpact;
    this.pendingAttackImpact = null;
    return impact;
  }

  updateMenu(dt) {
    this.mixer?.update(dt);
    this.updateEnergyBlade(dt);
  }

  play(key, fade = 0.25, loop = true) {
    const a = this.actions[key];
    if (!a || this.cur === a) return;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (this.cur && fade > 0) this.cur.crossFadeTo(a, fade, false);
    a.play();
    this.cur = a;
  }

  onLand(impact) {
    if (impact > 15) {
      this.play('landRoll', 0.08, false);
      this.landTimer = 1.15;
    } else if (impact > 5) {
      this.play('landSoft', 0.1, false);
      this.landTimer = 0.45;
    }
  }

  // ---------- visual update driven by controller ----------
  update(ctx) {
    const { dt, mode, pos, vel } = ctx;
    this.group.position.copy(pos);

    // facing: along horizontal velocity (smoothed)
    const hsp = Math.hypot(vel.x, vel.z);
    if (hsp > 1.2) {
      const target = Math.atan2(vel.x, vel.z);
      let d = (target - this.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * 10);
    }
    this.group.rotation.y = this.yaw;

    // animation mapping
    if (this.landTimer > 0) {
      this.landTimer -= dt;
    } else if (mode === 'ground') {
      this.play(hsp < 0.6 ? 'idle' : hsp < 6 ? 'walk' : hsp < 11 ? 'run' : 'sprint');
    } else if (mode === 'air') {
      this.play(vel.y > 1.5 ? 'jumpLoop' : 'fall', 0.3);
    } else if (mode === 'swing') {
      this.play('swing', 0.2);
    } else {
      this.play('fall', 0.3);   // wallrun / zip
    }
    this.mixer.update(dt);

    this.updateEnergyBlade(dt);

    // web rope
    this.updateWeb(ctx);
  }

  updateEnergyBlade(dt) {
    if (!this.loaded || !this.enabled) return;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    const hand = this.bones.hand_r || this.model;
    hand.getWorldPosition(this._bladeHand);
    this._bladeForward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    this._bladeRight.set(this._bladeForward.z, 0, -this._bladeForward.x).normalize();

    let progress = 0;
    if (this.attackActive) {
      this.attackElapsed += dt;
      progress = Math.min(1, this.attackElapsed / this.attackDuration);
      const eased = progress * progress * (3 - 2 * progress);
      if (this.attackKind === 'spin') {
        const angle = -0.35 * Math.PI + progress * Math.PI * 2.35;
        this._bladeDir.copy(this._bladeRight).multiplyScalar(Math.cos(angle))
          .addScaledVector(this._bladeForward, Math.sin(angle))
          .addScaledVector(BLADE_UP, 0.14 + Math.sin(progress * Math.PI) * 0.18)
          .normalize();
      } else if (this.attackKind === 'wave') {
        this._bladeDir.copy(this._bladeForward).multiplyScalar(0.62)
          .addScaledVector(this._bladeRight, 1.5 * (1 - 2 * eased))
          .addScaledVector(BLADE_UP, 0.18 - 0.12 * eased)
          .normalize();
      } else if (this.attackKind === 'dash') {
        this._bladeDir.copy(this._bladeForward).multiplyScalar(1.25)
          .addScaledVector(this._bladeRight, 0.9 * (1 - 2 * eased))
          .addScaledVector(BLADE_UP, 0.45 - 0.75 * eased)
          .normalize();
      } else {
        this._bladeDir.copy(this._bladeForward).multiplyScalar(1.05)
          .addScaledVector(this._bladeRight, 1.15 * (1 - 2 * eased))
          .addScaledVector(BLADE_UP, 0.78 - 1.12 * eased)
          .normalize();
      }
    } else if (this.bladePose === 'slam') {
      this._bladeDir.copy(BLADE_UP).multiplyScalar(-1)
        .addScaledVector(this._bladeForward, 0.22)
        .normalize();
    } else {
      this._bladeDir.copy(BLADE_UP).multiplyScalar(-0.46)
        .addScaledVector(this._bladeForward, 0.64)
        .addScaledVector(this._bladeRight, -0.50)
        .normalize();
    }

    this.bladeRoot.position.copy(this._bladeHand);
    this.bladeRoot.quaternion.copy(
      this._bladeQuat.setFromUnitVectors(BLADE_UP, this._bladeDir));
    // During the peak of Q the follow camera briefly passes very close to the
    // moving hand. Suppress the solid blade for that split second so it reads
    // as a speed cut instead of filling the view with near-plane geometry.
    const dashGhost = this.attackActive && this.attackKind === 'dash' &&
      progress > 0.12 && progress < 0.82;
    this.bladeRoot.visible = !dashGhost;

    const pulse = 1 + Math.sin(performance.now() * 0.018) * 0.045;
    const attackBoost = this.attackActive ? 1.28 : 1;
    for (const layer of this.bladeGlowLayers) {
      layer.scale.x = layer.userData.baseScale * pulse;
      layer.material.opacity = layer.userData.baseOpacity * attackBoost *
        (0.94 + Math.sin(performance.now() * 0.024) * 0.06);
    }
    this.bladeEmitterMat.color.setHex(this.attackActive ? 0xeaffff : 0x9cffff);
    this.bladeLight.intensity = this.attackActive ? 3.35 : 2.0;

    this._bladeBase.copy(this._bladeHand).addScaledVector(this._bladeDir, 0.22);
    this._bladeTip.copy(this._bladeHand).addScaledVector(this._bladeDir, 1.90);

    // Q translates the whole character several metres in a fraction of a
    // second. Connecting those world-space blade samples would create a giant
    // opaque sheet, so the dash uses its own controlled speed-line effect.
    if (this.attackActive && this.attackKind === 'dash') {
      this._trailSamples.length = 0;
    } else if (this.attackActive && progress >= 0.08 && progress <= 0.96) {
      this._trailSamples.unshift({
        inner: this._bladeBase.clone().lerp(this._bladeTip, 0.60),
        tip: this._bladeTip.clone(),
        life: this.attackKind === 'spin' ? 0.24 : 0.16,
      });
      if (this._trailSamples.length > TRAIL_SAMPLES) this._trailSamples.length = TRAIL_SAMPLES;
    }
    for (const sample of this._trailSamples) sample.life -= dt;
    this._trailSamples = this._trailSamples.filter(sample => sample.life > 0);
    this.updateBladeTrail();

    if (this.attackActive && this.attackProfile.emitImpact &&
        !this.attackImpactSent && progress >= this.attackProfile.impact) {
      this.attackImpactSent = true;
      this.pendingAttackImpact = {
        start: this._bladeBase.clone(),
        end: this._bladeTip.clone(),
        direction: this._bladeDir.clone(),
        playerPosition: this.group.position.clone(),
        damage: this.attackProfile.damage,
      };
    }
    if (this.attackActive && progress >= 1) {
      this.attackActive = false;
      this.attackKind = 'basic';
      this.attackProfile = ATTACK_PROFILES.basic;
    }
  }

  updateBladeTrail() {
    const samples = this._trailSamples;
    let cursor = 0;
    let edgeCursor = 0;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      const vertices = [
        [a.inner, TRAIL_INNER_COLOR], [a.tip, TRAIL_TIP_COLOR], [b.tip, TRAIL_TIP_COLOR],
        [a.inner, TRAIL_INNER_COLOR], [b.tip, TRAIL_TIP_COLOR], [b.inner, TRAIL_INNER_COLOR],
      ];
      for (const [v, color] of vertices) {
        this.bladeTrailPos[cursor++] = v.x;
        this.bladeTrailPos[cursor++] = v.y;
        this.bladeTrailPos[cursor++] = v.z;
        const colorCursor = cursor - 3;
        this.bladeTrailColors[colorCursor] = color.r;
        this.bladeTrailColors[colorCursor + 1] = color.g;
        this.bladeTrailColors[colorCursor + 2] = color.b;
      }
      for (const v of [a.tip, b.tip]) {
        this.bladeEdgeTrailPos[edgeCursor++] = v.x;
        this.bladeEdgeTrailPos[edgeCursor++] = v.y;
        this.bladeEdgeTrailPos[edgeCursor++] = v.z;
      }
    }
    this.bladeTrailGeo.setDrawRange(0, cursor / 3);
    this.bladeTrailGeo.attributes.position.needsUpdate = true;
    this.bladeTrailGeo.attributes.color.needsUpdate = true;
    this.bladeTrail.visible = cursor > 0;
    this.bladeEdgeTrailGeo.setDrawRange(0, edgeCursor / 3);
    this.bladeEdgeTrailGeo.attributes.position.needsUpdate = true;
    this.bladeEdgeTrail.visible = edgeCursor > 0;
  }

  updateWeb(ctx) {
    this.webGroup.visible = !!ctx.webOn;
    if (!ctx.webOn) return;
    const handName = ctx.webHand === 'L' ? 'hand_l' : 'hand_r';
    const hand = this.bones[handName] || this.model;
    const from = new THREE.Vector3();
    hand.getWorldPosition(from);
    const to = ctx.anchor;
    const slack = ctx.ropeSlack ?? 0;
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    mid.y -= 0.6 + slack * 14;              // catenary-ish sag
    // quadratic bezier through 7 points
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6, u = 1 - t;
      pts.push(new THREE.Vector3(
        u * u * from.x + 2 * u * t * mid.x + t * t * to.x,
        u * u * from.y + 2 * u * t * mid.y + t * t * to.y,
        u * u * from.z + 2 * u * t * mid.z + t * t * to.z));
    }
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 6; i++) {
      const a = pts[i], b = pts[i + 1];
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = Math.max(dir.length(), 1e-4);
      const seg = this.webSegs[i];
      seg.position.copy(a).addScaledVector(dir, 0.5);
      seg.quaternion.setFromUnitVectors(up, dir.multiplyScalar(1 / len));
      seg.scale.set(1, len, 1);
      seg.visible = true;
    }
  }
}
