/*
 * Sons du jeu (Web Audio, aucune librairie).
 *
 * Reprend la logique de final.py :
 *   - un son par niveau, coupé au début (TRIM_SILENCE) pour être plus réactif ;
 *   - hauteur selon la taille : cerise = aigu ... pastèque = grave, en rééchantillonnant
 *     (playbackRate : plus c'est grave, plus c'est long, comme un vinyle ralenti) ;
 *   - un seul « canal » : un spawn ne joue que si rien n'est en cours ; une fusion coupe
 *     le son en cours, sauf le son d'une fusion plus grosse (le son d'une grosse patate
 *     n'est donc pas coupé par les petites fusions des patates qui continuent de tomber).
 */
(function () {
  "use strict";

  class Voices {
    constructor(options) {
      this.opts = Object.assign({
        enabled: true,
        volume: 1.0,
        trimSilence: true,
        pitchEnabled: true,
        pitchSmall: +9,
        pitchBig: -12,
      }, options || {});
      this.ctx = null;
      this.gain = null;
      this.buffers = [];
      this.current = null;       // source en cours (canal unique)
      this.currentMerge = -1;    // niveau du son de fusion en cours (-1 : aucun, ou un spawn)
      this.loadToken = 0;
      this.muted = false;
    }

    /** À appeler dans un geste utilisateur (clic) : les navigateurs bloquent l'audio avant. */
    unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) {
        this.ctx = new AC();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.opts.volume;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
    }

    pitchForLevel(level, count) {
      const last = count - 1;
      const t = last > 0 ? level / last : 0;
      return this.opts.pitchSmall + (this.opts.pitchBig - this.opts.pitchSmall) * t;
    }

    /** urls[i] = URL du son du niveau i (ou null). Les erreurs donnent « pas de son ». */
    async load(urls) {
      const token = ++this.loadToken;
      this.stop();
      this.buffers = urls.map(() => null);
      if (!this.ctx) return;
      await Promise.all(urls.map(async (url, i) => {
        if (!url) return;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.arrayBuffer();
          if (data.byteLength === 0) throw new Error("fichier vide");
          let buffer = await this.ctx.decodeAudioData(data);
          if (this.opts.trimSilence) buffer = this.trim(buffer);
          if (token === this.loadToken) this.buffers[i] = buffer;
        } catch (err) {
          console.info(`[son] niveau ${i + 1} : pas de son (${err.message || err})`);
        }
      }));
    }

    /** Coupe le silence du début (seuil = 1,5 % du pic), en gardant 5 ms d'attaque. */
    trim(buffer) {
      const channels = [];
      let peak = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        channels.push(data);
        for (let j = 0; j < data.length; j++) {
          const v = Math.abs(data[j]);
          if (v > peak) peak = v;
        }
      }
      if (peak === 0) return buffer;              // son entièrement silencieux : tel quel
      const threshold = 0.015 * peak;
      let first = buffer.length;
      for (const data of channels) {
        for (let j = 0; j < first; j++) {
          if (Math.abs(data[j]) > threshold) { first = j; break; }
        }
      }
      first = Math.max(0, first - Math.floor(0.005 * buffer.sampleRate));
      if (first <= 0 || first >= buffer.length) return buffer;
      const out = this.ctx.createBuffer(buffer.numberOfChannels, buffer.length - first, buffer.sampleRate);
      channels.forEach((data, c) => out.copyToChannel(data.subarray(first), c));
      return out;
    }

    get busy() {
      return this.current !== null;
    }

    stop() {
      if (this.current) {
        try { this.current.stop(); } catch (_) { /* déjà fini */ }
        this.current = null;
      }
      this.currentMerge = -1;
    }

    /** Joue le son du niveau.
     *  merge=false (spawn) : seulement si le canal est libre.
     *  merge=true (fusion) : coupe le son en cours, sauf celui d'une fusion plus grosse. */
    play(level, merge = true) {
      if (!this.opts.enabled || this.muted || !this.ctx || this.ctx.state !== "running") return;
      const buffer = this.buffers[level];
      if (!buffer) return;
      if (this.busy && (!merge || level < this.currentMerge)) return;
      this.stop();
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      if (this.opts.pitchEnabled) {
        src.playbackRate.value = Math.pow(2, this.pitchForLevel(level, this.buffers.length) / 12);
      }
      src.connect(this.gain);
      src.onended = () => {
        if (this.current === src) { this.current = null; this.currentMerge = -1; }
      };
      this.current = src;
      this.currentMerge = merge ? level : -1;
      src.start();
    }
  }

  window.PatateVoices = Voices;
})();
