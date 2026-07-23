// Procedural combat audio. Everything is synthesized at runtime so the game
// has no extra audio downloads, decode stalls, missing-file risk or cache skew.
export class GameAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.lastHitAt = -1;
    this.warned = false;
  }

  unlock() {
    let context;
    try {
      context = this.ensureContext();
    } catch (error) {
      this.warnOnce(error);
      return Promise.resolve(false);
    }
    if (!context) return Promise.resolve(false);
    if (context.state === 'running') return Promise.resolve(true);
    return Promise.resolve(context.resume()).then(
      () => context.state === 'running',
      error => {
        this.warnOnce(error);
        return false;
      });
  }

  ensureContext() {
    if (this.context) return this.context;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;

    const context = new AudioContextClass({ latencyHint: 'interactive' });
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    master.gain.value = 0.24;
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;
    master.connect(compressor);
    compressor.connect(context.destination);
    this.context = context;
    this.master = master;
    return context;
  }

  run(effect) {
    try {
      const context = this.ensureContext();
      if (!context) return;
      if (context.state === 'suspended')
        Promise.resolve(context.resume()).catch(error => this.warnOnce(error));
      effect(context, context.currentTime);
    } catch (error) {
      this.warnOnce(error);
    }
  }

  warnOnce(error) {
    if (this.warned) return;
    this.warned = true;
    console.warn('[audio] combat sound unavailable:', error?.name || error?.message || error);
  }

  createNoiseBuffer(context) {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === context.sampleRate)
      return this.noiseBuffer;
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      data[i] = white * 0.62 + last * 0.38;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  tone(context, now, options) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = options.type || 'sine';
    oscillator.frequency.setValueAtTime(Math.max(1, options.from), now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, options.to ?? options.from), now + options.duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(options.gain, now + (options.attack || 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + options.duration + 0.02);
  }

  noise(context, now, options) {
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = this.createNoiseBuffer(context);
    filter.type = options.filter || 'bandpass';
    filter.frequency.setValueAtTime(Math.max(20, options.from), now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(20, options.to ?? options.from), now + options.duration);
    filter.Q.value = options.q ?? 0.8;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(options.gain, now + (options.attack || 0.006));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
    source.stop(now + options.duration + 0.02);
  }

  playBladeSwing() {
    this.run((context, now) => {
      this.noise(context, now, {
        filter: 'bandpass', from: 1750, to: 320, q: 0.72, duration: 0.19, gain: 0.24,
      });
      this.tone(context, now, {
        type: 'triangle', from: 260, to: 82, duration: 0.16, gain: 0.07,
      });
    });
  }

  playDash() {
    this.run((context, now) => {
      this.noise(context, now, {
        filter: 'highpass', from: 380, to: 1850, q: 0.5, duration: 0.29, gain: 0.30,
      });
      this.tone(context, now, {
        type: 'sawtooth', from: 105, to: 560, duration: 0.22, gain: 0.10,
      });
      this.tone(context, now + 0.045, {
        type: 'triangle', from: 620, to: 150, duration: 0.20, gain: 0.07,
      });
    });
  }

  playSpin() {
    this.run((context, now) => {
      this.noise(context, now, {
        filter: 'bandpass', from: 430, to: 2100, q: 0.68, duration: 0.54, gain: 0.28,
        attack: 0.025,
      });
      this.tone(context, now, {
        type: 'sawtooth', from: 135, to: 310, duration: 0.48, gain: 0.075,
        attack: 0.025,
      });
      this.tone(context, now + 0.18, {
        type: 'triangle', from: 720, to: 170, duration: 0.28, gain: 0.055,
      });
    });
  }

  playSlamStart() {
    this.run((context, now) => {
      this.tone(context, now, {
        type: 'sawtooth', from: 310, to: 48, duration: 0.38, gain: 0.13,
      });
      this.noise(context, now, {
        filter: 'lowpass', from: 1100, to: 180, q: 0.7, duration: 0.32, gain: 0.15,
      });
    });
  }

  playSlamImpact() {
    this.run((context, now) => {
      this.tone(context, now, {
        type: 'sine', from: 94, to: 26, duration: 0.62, gain: 0.38,
        attack: 0.003,
      });
      this.tone(context, now, {
        type: 'square', from: 170, to: 54, duration: 0.18, gain: 0.08,
      });
      this.noise(context, now, {
        filter: 'lowpass', from: 2100, to: 120, q: 0.58, duration: 0.44, gain: 0.34,
      });
    });
  }

  playWaveCast() {
    this.run((context, now) => {
      this.tone(context, now, {
        type: 'sawtooth', from: 210, to: 980, duration: 0.31, gain: 0.105,
      });
      this.tone(context, now + 0.035, {
        type: 'sine', from: 620, to: 1280, duration: 0.27, gain: 0.065,
      });
      this.noise(context, now, {
        filter: 'bandpass', from: 760, to: 2800, q: 1.1, duration: 0.32, gain: 0.20,
      });
    });
  }

  playHit(label = '') {
    this.run((context, now) => {
      // Multi-target radial skills can report several hits in one frame. One
      // impact transient is clearer and avoids summing into a clipped burst.
      if (now - this.lastHitAt < 0.045) return;
      this.lastHitAt = now;
      const wave = label.includes('能量波');
      this.tone(context, now, {
        type: wave ? 'triangle' : 'square',
        from: wave ? 920 : 150,
        to: wave ? 230 : 46,
        duration: wave ? 0.19 : 0.16,
        gain: wave ? 0.12 : 0.15,
      });
      this.noise(context, now, {
        filter: wave ? 'bandpass' : 'lowpass',
        from: wave ? 2600 : 1250,
        to: wave ? 520 : 150,
        q: wave ? 1.4 : 0.65,
        duration: wave ? 0.22 : 0.18,
        gain: wave ? 0.19 : 0.24,
      });
    });
  }
}
