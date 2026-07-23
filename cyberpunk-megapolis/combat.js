import * as THREE from 'three';

const MAX_HP = 100;
const DRONE_HEIGHT = 1.55;
const HIT_RADIUS = 1.08;
const RESPAWN_SECONDS = 4;

const _segment = new THREE.Vector3();
const _toPoint = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _away = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

function pointSegmentDistanceSq(point, start, end) {
  _segment.subVectors(end, start);
  const lengthSq = _segment.lengthSq();
  if (lengthSq < 1e-6) return point.distanceToSquared(start);
  const t = THREE.MathUtils.clamp(_toPoint.subVectors(point, start).dot(_segment) / lengthSq, 0, 1);
  _closest.copy(start).addScaledVector(_segment, t);
  return _closest.distanceToSquared(point);
}

export class CombatSystem {
  constructor(scene, groundAt, ui = {}) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.ui = ui;
    this.active = false;
    this.spawned = false;
    this.targets = [];
    this.effects = [];
    this.meshEffects = [];
    this.waves = [];
    this.hitMarkerTimer = 0;

    this.bodyGeometry = new THREE.OctahedronGeometry(0.62, 1);
    this.shellGeometry = new THREE.IcosahedronGeometry(0.78, 1);
    this.ringGeometry = new THREE.TorusGeometry(0.82, 0.035, 6, 28);
    this.wingGeometry = new THREE.BoxGeometry(0.72, 0.12, 0.28);
    this.eyeGeometry = new THREE.SphereGeometry(0.13, 12, 8);
    this.barBackgroundGeometry = new THREE.PlaneGeometry(1.5, 0.15);
    this.barFillGeometry = new THREE.PlaneGeometry(1.38, 0.075);
  }

  activate() {
    this.active = true;
    this.ui.root?.classList.add('on');
    if (this.ui.status) this.ui.status.textContent = '落地后部署训练目标';
  }

  update(dt, player, camera) {
    if (!this.active) return;
    if (!this.spawned && player?.mode === 'ground') this.spawnTargets(player.position, player.yaw);

    for (const target of this.targets) {
      if (!target.alive) {
        target.respawn -= dt;
        if (target.respawn <= 0) this.respawnTarget(target);
        continue;
      }

      target.time += dt;
      target.group.rotation.y += dt * (0.65 + target.index * 0.08);
      target.recoil.multiplyScalar(Math.exp(-8 * dt));
      target.group.position.copy(target.basePosition)
        .add(target.recoil);
      target.group.position.y += Math.sin(target.time * 2.4 + target.index) * 0.12;
      target.ring.rotation.x += dt * 1.6;
      target.ring.rotation.z -= dt * 1.2;

      target.hitFlash = Math.max(0, target.hitFlash - dt);
      target.body.material.emissiveIntensity = target.hitFlash > 0 ? 4.5 : 1.15;
      target.body.scale.setScalar(1 + target.hitFlash * 1.6);

      target.health.position.copy(target.group.position);
      target.health.position.y += 1.18;
      target.health.quaternion.copy(camera.quaternion);
    }

    this.updateWaves(dt);
    this.updateEffects(dt);
    this.updateMeshEffects(dt);
    if (this.hitMarkerTimer > 0) {
      this.hitMarkerTimer -= dt;
      if (this.hitMarkerTimer <= 0 && this.ui.hitMarker) this.ui.hitMarker.classList.remove('show');
    }
  }

  spawnTargets(playerPosition, yaw) {
    this.spawned = true;
    _forward.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    _right.set(_forward.z, 0, -_forward.x).normalize();
    const offsets = [
      [2.45, 0],
      [3.65, 2.15],
      [3.65, -2.15],
    ];

    offsets.forEach(([forward, side], index) => {
      const x = playerPosition.x + _forward.x * forward + _right.x * side;
      const z = playerPosition.z + _forward.z * forward + _right.z * side;
      const sampled = this.groundAt(x, z, playerPosition.y + 3, playerPosition.y);
      const ground = sampled !== null && Math.abs(sampled - playerPosition.y) < 2.2
        ? sampled
        : playerPosition.y;
      this.targets.push(this.createTarget(index, new THREE.Vector3(x, ground + DRONE_HEIGHT, z)));
    });

    if (this.ui.status) this.ui.status.textContent = `训练无人机 · ${MAX_HP} HP × ${this.targets.length}`;
    this.ui.onMessage?.('战斗训练目标已部署 · F / 鼠标左键攻击', 2.4);
  }

  createTarget(index, position) {
    const group = new THREE.Group();
    group.position.copy(position);
    this.scene.add(group);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a1735,
      roughness: 0.28,
      metalness: 0.72,
      emissive: index % 2 ? 0xff335f : 0xff2fcf,
      emissiveIntensity: 1.15,
    });
    const body = new THREE.Mesh(this.bodyGeometry, bodyMaterial);
    group.add(body);

    const shell = new THREE.Mesh(this.shellGeometry, new THREE.MeshBasicMaterial({
      color: 0xff5fca,
      wireframe: true,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    group.add(shell);

    const ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({
      color: 0xff4d8d,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    const wingMaterial = new THREE.MeshStandardMaterial({
      color: 0x111a28, metalness: 0.88, roughness: 0.3,
      emissive: 0x2d0f31, emissiveIntensity: 0.9,
    });
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(this.wingGeometry, wingMaterial);
      wing.position.x = side * 0.76;
      wing.rotation.z = side * 0.18;
      group.add(wing);
    }

    const eye = new THREE.Mesh(this.eyeGeometry, new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false,
    }));
    eye.position.set(0, 0.04, 0.58);
    group.add(eye);

    const health = new THREE.Group();
    const healthBg = new THREE.Mesh(this.barBackgroundGeometry, new THREE.MeshBasicMaterial({
      color: 0x080b14, transparent: true, opacity: 0.86, depthTest: false,
    }));
    const healthFill = new THREE.Mesh(this.barFillGeometry, new THREE.MeshBasicMaterial({
      color: 0x48f4ff, toneMapped: false, depthTest: false,
    }));
    healthFill.position.z = 0.01;
    health.add(healthBg, healthFill);
    health.renderOrder = 50;
    health.traverse(o => { if (o.isMesh) o.renderOrder = 50; });
    this.scene.add(health);

    return {
      index,
      group,
      body,
      ring,
      health,
      healthFill,
      basePosition: position.clone(),
      recoil: new THREE.Vector3(),
      hp: MAX_HP,
      maxHp: MAX_HP,
      alive: true,
      hitFlash: 0,
      respawn: 0,
      time: Math.random() * 3,
    };
  }

  strike(attack) {
    if (!this.active || !this.spawned) {
      this.ui.onMessage?.('落地后将自动部署战斗训练目标', 1.5);
      return 0;
    }

    let hits = 0;
    for (const target of this.targets) {
      if (!target.alive) continue;
      if (target.group.position.distanceToSquared(attack.playerPosition) > 16) continue;
      if (pointSegmentDistanceSq(target.group.position, attack.start, attack.end) >
          (attack.radius || HIT_RADIUS) ** 2)
        continue;

      hits++;
      this.damageTarget(target, attack.damage, attack.direction, attack.playerPosition, '能量刃');
    }

    if (hits === 0 && this.ui.status) this.ui.status.textContent = '未命中 · 靠近目标后再次挥砍';
    else this.refreshStatus();
    return hits;
  }

  sweepStrike(attack) {
    if (!this.active || !this.spawned) {
      this.ui.onMessage?.('落地后将自动部署战斗训练目标', 1.5);
      return 0;
    }
    let hits = 0;
    const radiusSq = (attack.radius || 1.1) ** 2;
    for (const target of this.targets) {
      if (!target.alive) continue;
      if (pointSegmentDistanceSq(target.group.position, attack.start, attack.end) > radiusSq) continue;
      hits++;
      this.damageTarget(
        target, attack.damage, attack.direction, attack.playerPosition, attack.label || '技能');
    }
    if (hits === 0 && this.ui.status) this.ui.status.textContent = `${attack.label || '技能'}未命中`;
    else this.refreshStatus();
    return hits;
  }

  radialStrike(attack) {
    this.spawnShockwave(attack.center, attack.radius, attack.color || 0x58f5ff);
    if (!this.active || !this.spawned) {
      this.ui.onMessage?.('落地后将自动部署战斗训练目标', 1.5);
      return 0;
    }
    let hits = 0;
    const radiusSq = attack.radius ** 2;
    for (const target of this.targets) {
      if (!target.alive || target.group.position.distanceToSquared(attack.center) > radiusSq) continue;
      hits++;
      this.damageTarget(
        target, attack.damage, attack.direction, attack.playerPosition, attack.label || '范围技能');
    }
    if (hits === 0 && this.ui.status) this.ui.status.textContent = `${attack.label || '范围技能'}未命中`;
    else this.refreshStatus();
    return hits;
  }

  damageTarget(target, damage, direction, origin, label) {
    target.hp = Math.max(0, target.hp - damage);
    target.hitFlash = 0.16;
    _away.subVectors(target.group.position, origin).setY(0);
    if (_away.lengthSq() < 1e-4) _away.copy(direction).setY(0);
    if (_away.lengthSq() < 1e-4) _away.set(0, 0, 1);
    target.recoil.add(_away.normalize().multiplyScalar(0.42));
    this.updateHealthBar(target);
    this.spawnSparks(target.group.position, target.hp > 0 ? 0x54f4ff : 0xff4fa9,
      target.hp > 0 ? 20 : 42);
    this.showHitMarker();

    if (target.hp <= 0) {
      target.alive = false;
      target.respawn = RESPAWN_SECONDS;
      target.group.visible = false;
      target.health.visible = false;
      this.ui.onMessage?.(
        `${label}击毁无人机 ${target.index + 1} · ${RESPAWN_SECONDS}秒后重构`, 2);
    } else {
      this.ui.onMessage?.(
        `${label} ${damage} · 无人机 ${target.index + 1} 剩余 ${target.hp} HP`, 1.1);
    }
  }

  launchWave(origin, direction, damage) {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: 0x59f7ff,
      transparent: true,
      opacity: 0.86,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.08, 6, 28), material);
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.48, 24), material.clone());
    core.material.opacity = 0.18;
    group.add(ring, core);
    group.position.copy(origin);
    _forward.copy(direction).normalize();
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _forward);
    group.scale.set(0.42, 1.3, 1);
    this.scene.add(group);
    this.waves.push({
      group,
      direction: _forward.clone(),
      previous: origin.clone(),
      damage,
      speed: 31,
      life: 0.95,
      maxLife: 0.95,
      hit: new Set(),
    });
  }

  updateWaves(dt) {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      wave.life -= dt;
      wave.previous.copy(wave.group.position);
      wave.group.position.addScaledVector(wave.direction, wave.speed * dt);
      wave.group.rotation.z += dt * 5;
      const fade = Math.max(0, wave.life / wave.maxLife);
      wave.group.children[0].material.opacity = 0.86 * fade;
      wave.group.children[1].material.opacity = 0.18 * fade;

      if (this.active && this.spawned) {
        for (const target of this.targets) {
          if (!target.alive || wave.hit.has(target.index)) continue;
          if (pointSegmentDistanceSq(
            target.group.position, wave.previous, wave.group.position) > 1.35 ** 2) continue;
          wave.hit.add(target.index);
          this.damageTarget(target, wave.damage, wave.direction, wave.previous, '能量波');
          this.refreshStatus();
        }
      }

      if (wave.life <= 0) {
        this.scene.remove(wave.group);
        wave.group.traverse(object => {
          if (!object.isMesh) return;
          object.geometry.dispose();
          object.material.dispose();
        });
        this.waves.splice(i, 1);
      }
    }
  }

  spawnShockwave(position, radius, color) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.82, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
    mesh.position.copy(position);
    mesh.position.y += 0.05;
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.setScalar(0.25);
    this.scene.add(mesh);
    this.meshEffects.push({
      mesh,
      life: 0.52,
      maxLife: 0.52,
      maxScale: Math.max(1, radius / 0.82),
      kind: 'shockwave',
    });
    this.spawnSparks(position, color, Math.round(18 + radius * 5));
  }

  spawnDashTrace(start, end) {
    _segment.subVectors(end, start);
    const length = _segment.length();
    if (length < 0.05) return;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.38, length, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x67f6ff,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
    mesh.position.copy(start).addScaledVector(_segment, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _segment.normalize());
    this.scene.add(mesh);
    this.meshEffects.push({
      mesh,
      life: 0.24,
      maxLife: 0.24,
      maxScale: 1,
      kind: 'fade',
    });
  }

  updateHealthBar(target) {
    const ratio = target.hp / target.maxHp;
    target.healthFill.scale.x = Math.max(0.001, ratio);
    target.healthFill.position.x = -0.69 * (1 - ratio);
    target.healthFill.material.color.set(ratio > 0.5 ? 0x48f4ff : ratio > 0.2 ? 0xffc447 : 0xff416d);
  }

  refreshStatus() {
    if (!this.ui.status) return;
    const alive = this.targets.filter(target => target.alive);
    if (!alive.length) {
      this.ui.status.textContent = '全部目标已击毁 · 正在重构';
      return;
    }
    const nearestDamage = Math.min(...alive.map(target => target.hp));
    this.ui.status.textContent = `目标 ${alive.length} · 最低生命 ${nearestDamage} HP`;
  }

  respawnTarget(target) {
    target.hp = target.maxHp;
    target.alive = true;
    target.hitFlash = 0;
    target.recoil.set(0, 0, 0);
    target.group.position.copy(target.basePosition);
    target.group.scale.setScalar(1);
    target.body.scale.setScalar(1);
    target.group.visible = true;
    target.health.visible = true;
    this.updateHealthBar(target);
    this.spawnSparks(target.basePosition, 0x53f5ff, 24);
    this.refreshStatus();
  }

  showHitMarker() {
    this.hitMarkerTimer = 0.16;
    if (this.ui.hitMarker) {
      this.ui.hitMarker.classList.remove('show');
      void this.ui.hitMarker.offsetWidth;
      this.ui.hitMarker.classList.add('show');
    }
  }

  spawnSparks(position, color, count) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      const velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        Math.random() * 5.5 - 0.4,
        (Math.random() - 0.5) * 6);
      velocities.push(velocity);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color,
      size: count > 25 ? 0.18 : 0.12,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.position.copy(position);
    points.frustumCulled = false;
    this.scene.add(points);
    this.effects.push({ points, velocities, life: count > 25 ? 0.72 : 0.48, maxLife: count > 25 ? 0.72 : 0.48 });
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.life -= dt;
      const positions = effect.points.geometry.attributes.position.array;
      for (let p = 0; p < effect.velocities.length; p++) {
        const velocity = effect.velocities[p];
        velocity.y -= 7.5 * dt;
        positions[p * 3] += velocity.x * dt;
        positions[p * 3 + 1] += velocity.y * dt;
        positions[p * 3 + 2] += velocity.z * dt;
      }
      effect.points.geometry.attributes.position.needsUpdate = true;
      effect.points.material.opacity = Math.max(0, effect.life / effect.maxLife);
      if (effect.life <= 0) {
        this.scene.remove(effect.points);
        effect.points.geometry.dispose();
        effect.points.material.dispose();
        this.effects.splice(i, 1);
      }
    }
  }

  updateMeshEffects(dt) {
    for (let i = this.meshEffects.length - 1; i >= 0; i--) {
      const effect = this.meshEffects[i];
      effect.life -= dt;
      const progress = 1 - Math.max(0, effect.life / effect.maxLife);
      if (effect.kind === 'shockwave') {
        const scale = THREE.MathUtils.lerp(0.25, effect.maxScale, 1 - (1 - progress) ** 3);
        effect.mesh.scale.setScalar(scale);
      }
      effect.mesh.material.opacity = Math.max(0, 1 - progress) *
        (effect.kind === 'shockwave' ? 0.82 : 0.34);
      if (effect.life <= 0) {
        this.scene.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        effect.mesh.material.dispose();
        this.meshEffects.splice(i, 1);
      }
    }
  }
}
