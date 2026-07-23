// input.js — keyboard + pointer-lock mouse state (from the web-slinger reference).
export class Input {
  constructor(domElement) {
    this.keys = new Set();
    this.yaw = Math.PI;
    this.pitch = -0.12;
    this.sensitivity = 0.0023;
    this.locked = false;
    this.rmb = false;
    this.justPressed = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;            // OS auto-repeat would spam jumps/webs
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.25, Math.min(1.35, this.pitch));
    });
    domElement.addEventListener('mousedown', (e) => {
      if (e.button === 2) { this.rmb = true; this.justPressed.add('RMB'); }
      if (e.button === 0) this.justPressed.add('LMB');
    });
    domElement.addEventListener('mouseup', (e) => { if (e.button === 2) this.rmb = false; });
    domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement !== null;
      if (!this.locked) this.keys.clear();
    });
  }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.justPressed.has(code); }
  endFrame() { this.justPressed.clear(); }

  // camera-relative movement vector from WASD, on the XZ plane
  moveVector(out) {
    let x = 0, z = 0;
    if (this.down('KeyW')) z += 1;
    if (this.down('KeyS')) z -= 1;
    if (this.down('KeyA')) x -= 1;
    if (this.down('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) { x /= len; z /= len; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    out.set(-sin * z + cos * x, 0, -cos * z - sin * x);
    return out;
  }
}
