(function () {
  'use strict';

  const COLORS = ['#ffd700', '#ff9c4a', '#fb7299', '#ff5f5f', '#7ec8ff', '#ffffff', '#ffe9a8'];

  let canvas = null;
  let ctx = null;
  let particles = [];
  let raf = null;
  let burstQueue = [];
  let audioCtx = null;

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function init() {
    canvas = document.getElementById('fxCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function spawnBurst(x, y, count) {
    const angleBase = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i += 1) {
      const angle = angleBase + (Math.random() - 0.5) * 1.2;
      const speed = 2 + Math.random() * 9;
      const round = Math.random() > 0.5;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        size: 3 + Math.random() * 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        round: round,
        life: 90 + Math.random() * 60,
        maxLife: 150
      });
    }
  }

  function tick() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (burstQueue.length > 0) {
      const b = burstQueue.shift();
      spawnBurst(b.x, b.y, b.count);
    }

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.vy += 0.22;
      p.vx *= 0.992;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 1;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      const alpha = Math.min(1, p.life / 30);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }
      ctx.restore();
    }

    if (particles.length > 0 || burstQueue.length > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  }

  function startLoop() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function celebrate() {
    if (!canvas) init();
    const w = canvas.width;
    const h = canvas.height;
    for (let i = 0; i < 8; i += 1) {
      burstQueue.push({
        x: w * (0.15 + Math.random() * 0.7),
        y: h * (0.25 + Math.random() * 0.45),
        count: 60 + Math.floor(Math.random() * 60)
      });
    }
    startLoop();
  }

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function tone(freq, start, dur, gainPeak) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, audioCtx.currentTime + start);
    gain.gain.linearRampToValueAtTime(gainPeak, audioCtx.currentTime + start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + start + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + start);
    osc.stop(audioCtx.currentTime + start + dur + 0.05);
  }

  function chime() {
    const ctx = ensureAudio();
    if (!ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((f, i) => tone(f, i * 0.13, 0.9, 0.18));
    tone(261.63, 0.65, 1.6, 0.12);
  }

  const Effects = {
    init: init,
    celebrate: celebrate,
    chime: chime
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Effects;
  }
  if (typeof window !== 'undefined') {
    window.Effects = Effects;
  }
})();
