// cityBoxes.js — AABB world built from the city's InstancedMeshes.
// Feeds controller collisions, web anchors, line-of-sight and camera occlusion.
import * as THREE from 'three';

const CELL = 100;

export function buildCityBoxes(world) {
  const aabbs = [];
  const _m = new THREE.Matrix4();
  const _c = new THREE.Vector3();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());

  for (const im of world.children) {
    if (!im.isInstancedMesh) continue;
    if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox;
    const { min, max } = bb;
    let ci = 0;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z])
      corners[ci++].set(x, y, z);
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, _m);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const c of corners) {
        _c.copy(c).applyMatrix4(_m);
        if (_c.x < x0) x0 = _c.x; if (_c.x > x1) x1 = _c.x;
        if (_c.y < y0) y0 = _c.y; if (_c.y > y1) y1 = _c.y;
        if (_c.z < z0) z0 = _c.z; if (_c.z > z1) z1 = _c.z;
      }
      // yaw-only city: AABBs are tight. skip near-flat decals (<0.4m tall, big footprint)
      const fp = Math.max(x1 - x0, z1 - z0);
      aabbs.push({
        x0, y0, z0, x1, y1, z1,
        collide: fp <= 80,            // giant merged districts (slums 400m) only block anchors/LOS
        tall: y1 - y0 > 9,
      });
    }
  }

  // spatial hash
  const cells = new Map();
  const key = (cx, cz) => cx * 100000 + cz;
  aabbs.forEach((b, i) => {
    const cx0 = Math.floor(b.x0 / CELL), cx1 = Math.floor(b.x1 / CELL);
    const cz0 = Math.floor(b.z0 / CELL), cz1 = Math.floor(b.z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = key(cx, cz);
        (cells.get(k) ?? cells.set(k, []).get(k)).push(i);
      }
  });

  const _seen = new Set();
  function queryNearby(x, z, r) {
    _seen.clear();
    const out = [];
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = cells.get(key(cx, cz));
        if (!arr) continue;
        for (const i of arr) if (!_seen.has(i)) { _seen.add(i); out.push(i); }
      }
    return out;
  }

  return { aabbs, queryNearby };
}

// slab method: first intersection t∈[0,1] of segment p0→p1 with box (padded), 1 = no hit
export function segmentAABB(p0, p1, b, pad = 0) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  let t0 = 0, t1 = 1;
  for (const [o, d, mn, mx] of [
    [p0.x, dx, b.x0 - pad, b.x1 + pad],
    [p0.y, dy, b.y0 - pad, b.y1 + pad],
    [p0.z, dz, b.z0 - pad, b.z1 + pad],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return 1;
    } else {
      let a = (mn - o) / d, c = (mx - o) / d;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) return 1;
    }
  }
  return t0;
}
