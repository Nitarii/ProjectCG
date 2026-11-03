'use strict';

class SpatialHash {
  constructor(cellSize = 720) {
    this.cellSize = Math.max(64, Number(cellSize) || 720);
    this.cells = new Map();
    this.entityCell = new Map();
  }
  _key(gx, gy) { return `${gx},${gy}`; }
  _coord(v) { return Math.floor(v / this.cellSize); }
  clear() { this.cells.clear(); this.entityCell.clear(); }
  insert(entity) {
    if (!entity || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    const gx = this._coord(entity.x), gy = this._coord(entity.y), key = this._key(gx, gy);
    let bucket = this.cells.get(key);
    if (!bucket) this.cells.set(key, bucket = []);
    bucket.push(entity);
    if (entity.id != null) this.entityCell.set(entity.id, key);
  }
  rebuild(iterable) {
    this.clear();
    for (const entity of iterable) this.insert(entity);
  }
  queryBounds(minX, minY, maxX, maxY) {
    const out = [];
    const x0 = this._coord(minX), x1 = this._coord(maxX), y0 = this._coord(minY), y1 = this._coord(maxY);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const bucket = this.cells.get(this._key(gx, gy));
      if (!bucket) continue;
      for (const entity of bucket) if (entity.x >= minX && entity.x <= maxX && entity.y >= minY && entity.y <= maxY) out.push(entity);
    }
    return out;
  }
  queryCircle(x, y, radius) {
    const r = Math.max(0, radius || 0), r2 = r * r;
    const out = [];
    for (const entity of this.queryBounds(x-r, y-r, x+r, y+r)) {
      const dx = entity.x-x, dy = entity.y-y;
      if (dx*dx + dy*dy <= r2) out.push(entity);
    }
    return out;
  }
}

module.exports = { SpatialHash };
