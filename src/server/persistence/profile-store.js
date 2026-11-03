'use strict';

const fs = require('fs');
const path = require('path');

class ProfileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dataDir = path.dirname(filePath);
    this.timer = null;
    this.writing = false;
    this.dirty = false;
    this.lastError = null;
    fs.mkdirSync(this.dataDir, { recursive:true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}', 'utf8');
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      try {
        if (fs.existsSync(this.filePath)) {
          const backup = path.join(this.dataDir, `profiles.corrupt-${Date.now()}.json`);
          fs.copyFileSync(this.filePath, backup);
          console.error(`profiles.json illisible (${e.message}). Copie conservée : ${path.basename(backup)}`);
        }
      } catch {}
      return {};
    }
  }
  schedule(data, delay = 350) {
    this.latest = data;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(()=>{}), delay);
    this.timer.unref?.();
  }
  async flush() {
    if (this.writing) { this.dirty = true; return; }
    if (!this.dirty || !this.latest) return;
    this.writing = true; this.dirty = false;
    const tmp = this.filePath + '.tmp';
    try {
      const json = JSON.stringify(this.latest, null, 2);
      await fs.promises.writeFile(tmp, json, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      this.dirty = true;
      console.error('Sauvegarde progression impossible:', e.message);
    } finally {
      this.writing = false;
      if (this.dirty) this.schedule(this.latest, 100);
    }
  }
  flushSync(data) {
    try {
      clearTimeout(this.timer);
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data || this.latest || {}, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {}
  }
}

module.exports = { ProfileStore };
