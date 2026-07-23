import * as THREE from 'three';

const SKILLS = [
  { id: 'dash', key: 'KeyQ', label: '瞬步斩', cooldown: 2.6, damage: 60 },
  { id: 'spin', key: 'KeyC', label: '回旋斩', cooldown: 4.0, damage: 45 },
  { id: 'slam', key: 'KeyX', label: '空中坠击', cooldown: 5.0, damage: 70 },
  { id: 'wave', key: 'KeyV', label: '能量波', cooldown: 3.2, damage: 50 },
];

const _direction = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _end = new THREE.Vector3();

export class SkillSystem {
  constructor(combat, ui = {}) {
    this.combat = combat;
    this.ui = ui;
    this.active = false;
    this.cooldowns = Object.fromEntries(SKILLS.map(skill => [skill.id, 0]));
    this.slots = new Map();
    this.dash = null;
    this.spin = null;
    this.slam = null;
    this.wave = null;

    for (const element of ui.root?.querySelectorAll('[data-skill]') || []) {
      this.slots.set(element.dataset.skill, {
        element,
        fill: element.querySelector('.skill-fill'),
        cooldown: element.querySelector('.skill-cd'),
      });
    }
    this.updateHud();
  }

  activate() {
    this.active = true;
    this.ui.root?.classList.add('on');
    this.updateHud();
  }

  resetTransient(player) {
    this.dash = null;
    this.spin = null;
    this.slam = null;
    this.wave = null;
    player?.setBladePose(null);
  }

  beforePhysics(dt, input, player, ctrl, cameraDirection) {
    if (!this.active) return;

    for (const skill of SKILLS)
      this.cooldowns[skill.id] = Math.max(0, this.cooldowns[skill.id] - dt);

    this.getDirection(cameraDirection, player, _direction);
    for (const skill of SKILLS) {
      if (input.pressed(skill.key)) this.tryUse(skill, player, ctrl, _direction);
    }

    if (this.dash) {
      ctrl.vel.x = this.dash.direction.x * 30;
      ctrl.vel.z = this.dash.direction.z * 30;
      ctrl.vel.y = Math.max(ctrl.vel.y, this.dash.startedOnGround ? 0 : -2);
    }
    if (this.slam && ctrl.mode !== 'ground') {
      ctrl.vel.y = Math.min(ctrl.vel.y, -42);
      ctrl.vel.x *= Math.max(0, 1 - 2.8 * dt);
      ctrl.vel.z *= Math.max(0, 1 - 2.8 * dt);
    }
    this.updateHud();
  }

  afterPhysics(dt, player, ctrl) {
    if (!this.active) return;

    if (this.dash) {
      this.dash.elapsed += dt;
      if (!this.dash.hitSent && this.dash.elapsed >= 0.09) {
        this.dash.hitSent = true;
        _origin.copy(this.dash.start);
        _origin.y += 1.0;
        _end.copy(ctrl.pos).addScaledVector(this.dash.direction, 2.15);
        _end.y += 1.0;
        this.combat.sweepStrike({
          start: _origin.clone(),
          end: _end.clone(),
          playerPosition: ctrl.pos.clone(),
          direction: this.dash.direction.clone(),
          radius: 1.25,
          damage: this.dash.damage,
          label: '瞬步斩',
        });
        this.combat.spawnDashTrace(_origin, _end);
      }
      if (this.dash.elapsed >= 0.24) this.dash = null;
    }

    if (this.spin) {
      this.spin.elapsed += dt;
      if (!this.spin.hitSent && this.spin.elapsed >= 0.20) {
        this.spin.hitSent = true;
        _origin.copy(ctrl.pos);
        _origin.y += 0.95;
        this.combat.radialStrike({
          center: _origin.clone(),
          playerPosition: ctrl.pos.clone(),
          direction: this.spin.direction.clone(),
          radius: 3.25,
          damage: this.spin.damage,
          label: '回旋斩',
          color: 0x59f6ff,
        });
      }
      if (this.spin.elapsed >= 0.62) this.spin = null;
    }

    if (this.wave) {
      this.wave.elapsed += dt;
      if (!this.wave.launched && this.wave.elapsed >= 0.12) {
        this.wave.launched = true;
        _origin.copy(ctrl.pos).addScaledVector(this.wave.direction, 1.1);
        _origin.y += 1.15;
        this.combat.launchWave(_origin, this.wave.direction, this.wave.damage);
      }
      if (this.wave.elapsed >= 0.42) this.wave = null;
    }

    if (this.slam) {
      this.slam.elapsed += dt;
      if (ctrl.mode === 'ground') {
        _origin.copy(ctrl.pos);
        _origin.y += 0.25;
        this.combat.radialStrike({
          center: _origin.clone(),
          playerPosition: ctrl.pos.clone(),
          direction: this.slam.direction.clone(),
          radius: 4.5,
          damage: this.slam.damage,
          label: '空中坠击',
          color: 0x8a7dff,
        });
        this.ui.audio?.playSlamImpact();
        this.slam = null;
        player.setBladePose(null);
      } else if (this.slam.elapsed > 12) {
        this.slam = null;
        player.setBladePose(null);
      }
    }
    this.updateHud();
  }

  tryUse(skill, player, ctrl, direction) {
    if (this.cooldowns[skill.id] > 0) {
      this.ui.onMessage?.(`${skill.label}冷却中 · ${this.cooldowns[skill.id].toFixed(1)}秒`, 1);
      return false;
    }

    if (skill.id === 'slam') {
      if (ctrl.mode === 'ground') {
        this.ui.onMessage?.('空中坠击只能在空中发动', 1.3);
        return false;
      }
      if (player.attackActive || player.attackCooldown > 0) {
        this.ui.onMessage?.('能量刃动作尚未完成', 1);
        return false;
      }
      this.cancelWebMovement(ctrl);
      this.slam = { elapsed: 0, direction: direction.clone(), damage: skill.damage };
      player.setBladePose('slam');
      this.ui.audio?.playSlamStart();
      this.startCooldown(skill);
      this.ui.onMessage?.('空中坠击', 0.9);
      return true;
    }

    const attackKind = skill.id === 'dash' ? 'dash' : skill.id === 'spin' ? 'spin' : 'wave';
    if (!player.startAttack(attackKind)) {
      this.ui.onMessage?.('能量刃动作尚未完成', 1);
      return false;
    }

    if (skill.id === 'dash') {
      this.cancelWebMovement(ctrl);
      this.dash = {
        elapsed: 0,
        hitSent: false,
        start: ctrl.pos.clone(),
        direction: direction.clone(),
        startedOnGround: ctrl.mode === 'ground',
        damage: skill.damage,
      };
      this.ui.audio?.playDash();
      this.ui.onMessage?.('瞬步斩 · 60 DMG', 0.9);
    } else if (skill.id === 'spin') {
      this.spin = {
        elapsed: 0,
        hitSent: false,
        direction: direction.clone(),
        damage: skill.damage,
      };
      this.ui.audio?.playSpin();
      this.ui.onMessage?.('回旋斩 · 范围攻击', 0.9);
    } else {
      this.wave = {
        elapsed: 0,
        launched: false,
        direction: direction.clone(),
        damage: skill.damage,
      };
      this.ui.audio?.playWaveCast();
      this.ui.onMessage?.('能量波 · 50 DMG', 0.9);
    }
    this.startCooldown(skill);
    return true;
  }

  cancelWebMovement(ctrl) {
    if (ctrl.webOn && typeof ctrl.detach === 'function') ctrl.detach();
    else if (ctrl.mode === 'zip' || ctrl.mode === 'wallrun') ctrl.mode = 'air';
  }

  startCooldown(skill) {
    this.cooldowns[skill.id] = skill.cooldown;
    this.updateHud();
  }

  getDirection(cameraDirection, player, out) {
    out.copy(cameraDirection).setY(0);
    if (out.lengthSq() < 1e-4)
      out.set(Math.sin(player?.yaw || 0), 0, Math.cos(player?.yaw || 0));
    return out.normalize();
  }

  updateHud() {
    for (const skill of SKILLS) {
      const slot = this.slots.get(skill.id);
      if (!slot) continue;
      const left = this.cooldowns[skill.id];
      const ratio = THREE.MathUtils.clamp(left / skill.cooldown, 0, 1);
      slot.fill?.style.setProperty('height', `${Math.round(ratio * 100)}%`);
      if (slot.cooldown) slot.cooldown.textContent = left > 0.05 ? left.toFixed(1) : 'READY';
      slot.element.classList.toggle('ready', left <= 0.05);
    }
  }
}
