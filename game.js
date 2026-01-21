/*
  Juego web emocional interactivo (offline)
  - HTML/CSS/JS puro
  - Animaciones con requestAnimationFrame (sin setInterval)
  - Progreso por descubrimiento (localStorage)
  - Audio con manejo de restricciones de autoplay

  Arquitectura interna (en un solo archivo):
  - GameState
  - SceneManager
  - ParticleSystem
  - InteractiveObject
  - MessageSystem
  - AudioManager
  - StorageManager
*/

(() => {
  "use strict";

  /** @typedef {"intro" | "world" | "final"} SceneName */

  // ----------------------------
  // Utilidades
  // ----------------------------

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const nowMs = () => performance.now();

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // ----------------------------
  // Haptics (Vibration API)
  // ----------------------------

  function haptic(pattern) {
    try {
      if (prefersReducedMotion()) return;
      // @ts-ignore
      if (!navigator || typeof navigator.vibrate !== "function") return;
      if (document.visibilityState && document.visibilityState !== "visible") return;
      // @ts-ignore
      navigator.vibrate(pattern);
    } catch {
      // Silencioso: no todos los navegadores soportan vibración.
    }
  }

  // ----------------------------
  // StorageManager
  // ----------------------------

  class StorageManager {
    constructor(storageKey) {
      this.storageKey = storageKey;
    }

    load() {
      try {
        // Wipe progress exactly once for everyone on this release.
        // This intentionally does NOT repeat on subsequent loads.
        const resetOnceKey = `${this.storageKey}__reset_once_2026_01`;
        if (!localStorage.getItem(resetOnceKey)) {
          // Mark first, then wipe everything else (so it won't repeat).
          localStorage.setItem(resetOnceKey, "1");

          /** @type {string[]} */
          const keysToRemove = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k === resetOnceKey) continue;
            keysToRemove.push(k);
          }
          for (const k of keysToRemove) {
            localStorage.removeItem(k);
          }
        }

        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return { discoveredIds: [], muted: false, volume: 1, assignedPhrases: {}, unlockedOrder: [], seenFinal: false };
        const parsed = JSON.parse(raw);
        return {
          discoveredIds: Array.isArray(parsed.discoveredIds) ? parsed.discoveredIds : [],
          muted: !!parsed.muted,
          volume: typeof parsed.volume === "number" ? clamp01(parsed.volume) : 1,
          assignedPhrases: parsed && typeof parsed.assignedPhrases === "object" && parsed.assignedPhrases
            ? parsed.assignedPhrases
            : {},
          unlockedOrder: Array.isArray(parsed.unlockedOrder) ? parsed.unlockedOrder : [],
          seenFinal: !!parsed.seenFinal,
        };
      } catch {
        return { discoveredIds: [], muted: false, volume: 1, assignedPhrases: {}, unlockedOrder: [], seenFinal: false };
      }
    }

    save(state) {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(state));
      } catch {
        // Si localStorage falla (modo privado raro), simplemente no persistimos.
      }
    }
  }

  // ----------------------------
  // AudioManager
  // ----------------------------

  class AudioManager {
    constructor({ ambientEl, finalEl }) {
      this.ambient = ambientEl;
      this.final = finalEl;

      this.enabled = false; // se activa tras gesto del usuario
      this.muted = false;

      this.masterVolume = 1;
      this._base = { ambient: 0, final: 0 };

      // Volúmenes bajos: acompañan, no dominan.
      this._targetAmbient = 0.14;
      this._targetFinal = 0.18;

      /** @type {{ambient: {from:number,to:number,start:number,dur:number,active:boolean}, final: {from:number,to:number,start:number,dur:number,active:boolean}}} */
      this._fades = {
        ambient: { from: 0, to: 0, start: 0, dur: 0, active: false },
        final: { from: 0, to: 0, start: 0, dur: 0, active: false },
      };

      this._fadeRaf = 0;

      // Preconfig
      this.ambient.loop = true;
      this.final.loop = true;
      this.ambient.volume = 0;
      this.final.volume = 0;

      // SFX opcional (WebAudio): se habilita tras gesto.
      this._ctx = null;
    }

    setMuted(muted) {
      this.muted = muted;
      if (muted) {
        this._fades.ambient.active = false;
        this._fades.final.active = false;
        if (this._fadeRaf) {
          cancelAnimationFrame(this._fadeRaf);
          this._fadeRaf = 0;
        }
        this.ambient.volume = 0;
        this.final.volume = 0;

        // Pausar para ahorrar batería/CPU.
        try { this.ambient.pause(); } catch {}
        try { this.final.pause(); } catch {}
      }
    }

    setMasterVolume(v) {
      this.masterVolume = clamp01(v);
      if (!this.enabled) return;
      if (this.muted) return;
      this.ambient.volume = clamp01(this._base.ambient * this.masterVolume);
      this.final.volume = clamp01(this._base.final * this.masterVolume);
    }

    _getBase(which) {
      if (this.masterVolume > 0.0001) {
        const cur = which === "ambient" ? this.ambient.volume : this.final.volume;
        return clamp01(cur / this.masterVolume);
      }
      return this._base[which] || 0;
    }

    /**
     * Debe llamarse solo tras interacción del usuario (click/touch).
     */
    async unlockAndStartAmbient() {
      if (this.enabled) return true;
      this.enabled = true;

      this._ensureAudioContext();

      if (this.muted) return;

      try {
        this.ambient.muted = false;
        await this.ambient.play();
        this._startFade("ambient", 0, this._targetAmbient, 2000);
        return true;
      } catch {
        // Si el navegador bloquea (raro tras gesto), no hacemos nada.
        this.enabled = false;
        return false;
      }
    }

    /**
     * Debe llamarse solo tras interacción del usuario.
     * Útil si el usuario abre el juego ya completo (escena final).
     */
    async unlockAndStartFinal() {
      if (this.enabled) return true;
      this.enabled = true;

      this._ensureAudioContext();

      if (this.muted) return;

      try {
        this.final.muted = false;
        await this.final.play();
        this._startFade("final", 0, this._targetFinal, 2400);
        return true;
      } catch {
        // Si falla, no hacemos nada.
        this.enabled = false;
        return false;
      }
    }

    /** Cambia a la canción final con crossfade suave. */
    async switchToFinal() {
      if (!this.enabled || this.muted) return;

      // Inicia final
      try {
        if (this.final.paused) {
          await this.final.play();
        }
      } catch {
        // Si falla, mantenemos ambiente.
        return;
      }

      // Crossfade: bajar ambiente, subir final
      this._startFade("ambient", this._getBase("ambient"), 0.0, 2600);
      this._startFade("final", this._getBase("final"), this._targetFinal, 2600);
    }

    /** Vuelve al ambiente con crossfade suave. */
    async switchToAmbient() {
      if (!this.enabled || this.muted) return;

      try {
        if (this.ambient.paused) {
          await this.ambient.play();
        }
      } catch {
        return;
      }

      this._startFade("final", this._getBase("final"), 0.0, 2200);
      this._startFade("ambient", this._getBase("ambient"), this._targetAmbient, 2200);
    }

    _startFade(which, from, to, dur) {
      this._fades[which] = { from, to, start: nowMs(), dur, active: true };
      this._ensureFadeTicker();
    }

    _ensureFadeTicker() {
      if (this._fadeRaf) return;
      const tick = () => {
        this._fadeRaf = 0;
        this.update();
        if (this._fades.ambient.active || this._fades.final.active) {
          this._fadeRaf = requestAnimationFrame(tick);
        }
      };
      this._fadeRaf = requestAnimationFrame(tick);
    }

    update() {
      if (!this.enabled) return;
      if (this.muted) return;
      const tNow = nowMs();

      const upd = (which) => {
        const f = this._fades[which];
        if (!f.active) return;
        const t = clamp01((tNow - f.start) / f.dur);
        const base = lerp(f.from, f.to, easeInOut(t));
        this._base[which] = base;
        const applied = clamp01(base * this.masterVolume);
        if (which === "ambient") this.ambient.volume = applied;
        if (which === "final") this.final.volume = applied;

        if (t >= 1) {
          f.active = false;
          // Silenciar de verdad el ambiente cuando termina su fade-out.
          if (which === "ambient" && f.to <= 0.0001) {
            try { this.ambient.pause(); } catch {}
          }
          if (which === "final" && f.to <= 0.0001) {
            try { this.final.pause(); } catch {}
          }
        }
      };

      upd("ambient");
      upd("final");
    }

    /**
     * Chrome móvil a veces pausa el audio (power saver / glitches). Reintentamos
     * reanudar de forma silenciosa si debería estar sonando.
     */
    ensurePlayback() {
      if (!this.enabled) return;
      if (this.muted) return;
      if (this.masterVolume <= 0.0001) return;

      const needAmbient = (this._base.ambient * this.masterVolume) > 0.0005 || (this._fades.ambient.active && this._fades.ambient.to > 0.0005);
      const needFinal = (this._base.final * this.masterVolume) > 0.0005 || (this._fades.final.active && this._fades.final.to > 0.0005);

      if (needAmbient && this.ambient.paused) {
        this.ambient.play().catch(() => {});
      }
      if (needFinal && this.final.paused) {
        this.final.play().catch(() => {});
      }
    }

    _ensureAudioContext() {
      if (this._ctx) return;
      try {
        // @ts-ignore
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) this._ctx = new Ctx();
      } catch {
        this._ctx = null;
      }
    }

    /** Sonido corto y muy suave al desbloquear una frase. */
    playChime() {
      if (!this.enabled || this.muted) return;
      if (!this._ctx) return;

      const ctx = this._ctx;
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const t0 = ctx.currentTime;
      const gain = ctx.createGain();
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();

      oscA.type = "sine";
      oscB.type = "sine";

      oscA.frequency.setValueAtTime(587.33, t0); // D5
      oscB.frequency.setValueAtTime(880.0, t0); // A5

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.05, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);

      oscA.connect(gain);
      oscB.connect(gain);
      gain.connect(ctx.destination);

      oscA.start(t0);
      oscB.start(t0 + 0.01);
      oscA.stop(t0 + 0.58);
      oscB.stop(t0 + 0.58);
    }
  }

  // ----------------------------
  // DiarySystem (páginas con frases desbloqueadas)
  // ----------------------------

  class DiarySystem {
    constructor({ screenEl, textEl, metaEl, prevBtn, nextBtn, closeBtn, backdropEl }) {
      this.screenEl = screenEl;
      this.textEl = textEl;
      this.metaEl = metaEl;
      this.prevBtn = prevBtn;
      this.nextBtn = nextBtn;
      this.closeBtn = closeBtn;
      this.backdropEl = backdropEl;

      this._phrases = [];
      this._index = 0;
      this._open = false;

      this.prevBtn.addEventListener("click", () => {
        haptic(8);
        this.prev();
      });
      this.nextBtn.addEventListener("click", () => {
        haptic(8);
        this.next();
      });
      this.closeBtn.addEventListener("click", () => {
        haptic(10);
        this.close();
      });
      this.backdropEl.addEventListener("click", () => {
        haptic(10);
        this.close();
      });
    }

    setPhrases(phrases) {
      this._phrases = Array.isArray(phrases) ? phrases.slice() : [];
      if (this._index >= this._phrases.length) this._index = Math.max(0, this._phrases.length - 1);
      this._render();
    }

    open() {
      this._open = true;
      this.screenEl.classList.remove("hidden");
      this._render();
    }

    close() {
      this._open = false;
      this.screenEl.classList.add("hidden");
    }

    isOpen() {
      return this._open;
    }

    prev() {
      if (this._phrases.length <= 0) return;
      this._index = Math.max(0, this._index - 1);
      this._swapToCurrent();
    }

    next() {
      if (this._phrases.length <= 0) return;
      this._index = Math.min(this._phrases.length - 1, this._index + 1);
      this._swapToCurrent();
    }

    _swapToCurrent() {
      this.textEl.classList.add("swapOut");
      const start = nowMs();
      const step = () => {
        if (nowMs() - start >= 260) {
          this.textEl.classList.remove("swapOut");
          this._render();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    _render() {
      const total = this._phrases.length;
      if (total <= 0) {
        this.metaEl.textContent = "Página 0 / 0";
        this.textEl.textContent = "Aún no has desbloqueado frases. Vuelve al mapa y toca un objeto.";
        this.prevBtn.disabled = true;
        this.nextBtn.disabled = true;
        return;
      }

      const i = this._index;
      this.metaEl.textContent = `Página ${i + 1} / ${total}`;
      this.textEl.textContent = this._phrases[i];
      this.prevBtn.disabled = i <= 0;
      this.nextBtn.disabled = i >= total - 1;
    }
  }

  // ----------------------------
  // MiniGame system (muy simple, sin "gamificar")
  // ----------------------------

  class MiniGameManager {
    constructor({ screenEl, titleEl, hintEl, areaEl, closeBtn, backdropEl }) {
      this.screenEl = screenEl;
      this.titleEl = titleEl;
      this.hintEl = hintEl;
      this.areaEl = areaEl;
      this.closeBtn = closeBtn;
      this.backdropEl = backdropEl;

      this._active = null;
      this._resolve = null;
      this._openedAt = 0;

      const cancel = () => {
        // Evita que el mismo tap que abre el mini-juego lo cierre inmediatamente.
        if (this._openedAt && nowMs() - this._openedAt < 280) return;
        haptic(10);
        this._finish(false);
      };

      this.closeBtn.addEventListener("click", cancel);
      this.backdropEl.addEventListener("click", cancel);
    }

    isOpen() {
      return !!this._active;
    }

    open(game) {
      this.close();

      this._active = game;
      this._openedAt = nowMs();
      this.titleEl.textContent = game.title;
      this.hintEl.textContent = game.hint;

      // Permite que el mini-juego actualice el hint dinámicamente (p.ej. "Ahora tú").
      const ui = {
        setHint: (text) => {
          this.hintEl.textContent = String(text);
        },
      };
      if (typeof game.bindUi === "function") {
        try { game.bindUi(ui); } catch {}
      }

      this.areaEl.innerHTML = "";
      this.screenEl.classList.remove("hidden");
      game.mount(this.areaEl);

      return new Promise((resolve) => {
        this._resolve = resolve;
        game.onComplete = () => this._finish(true);
        game.onCancel = () => this._finish(false);
      });
    }

    _finish(ok) {
      if (this._resolve) {
        const r = this._resolve;
        this._resolve = null;
        this.close();
        r(ok);
      } else {
        this.close();
      }
    }

    close() {
      if (this._active) {
        try { this._active.unmount(); } catch {}
      }
      this._active = null;
      this._openedAt = 0;
      this.screenEl.classList.add("hidden");
      this.areaEl.innerHTML = "";
    }

    update(t) {
      if (!this._active) return;
      this._active.update(t);
    }
  }

  class HoldMiniGame {
    constructor() {
      this.title = "Un segundo";
      this.hint = "Mantén presionado. Suelta cuando quieras.";
      this.onComplete = null;
      this.onCancel = null;

      this._mounted = false;
      this._holding = false;
      this._holdStart = 0;
      this._requiredMs = 2100;
      this._orb = null;
    }

    mount(areaEl) {
      this._mounted = true;
      this._holding = false;
      this._holdStart = 0;

      const orb = document.createElement("div");
      orb.className = "holdOrb";
      orb.style.setProperty("--p", "0");

      const label = document.createElement("div");
      label.className = "holdLabel";
      label.textContent = "Mantén aquí\n(un momento)";
      orb.appendChild(label);

      const down = (e) => {
        try { e.preventDefault?.(); } catch {}
        this._holding = true;
        this._holdStart = nowMs();
        haptic(8);
      };
      const up = (e) => {
        try { e.preventDefault?.(); } catch {}
        this._holding = false;
      };

      // Pointer (moderno)
      orb.addEventListener("pointerdown", down);
      orb.addEventListener("pointerup", up);
      orb.addEventListener("pointercancel", up);
      orb.addEventListener("pointerleave", up);

      // Fallbacks (Safari / navegadores raros)
      orb.addEventListener("touchstart", down, { passive: false });
      orb.addEventListener("touchend", up, { passive: false });
      orb.addEventListener("touchcancel", up, { passive: false });
      orb.addEventListener("mousedown", down);
      orb.addEventListener("mouseup", up);
      orb.addEventListener("mouseleave", up);

      areaEl.appendChild(orb);
      this._orb = orb;
    }

    unmount() {
      this._mounted = false;
      this._orb = null;
    }

    update(t) {
      if (!this._mounted || !this._orb) return;

      let p = 0;
      if (this._holding) {
        p = clamp01((t - this._holdStart) / this._requiredMs);
        if (p >= 1) {
          this.onComplete?.();
          return;
        }
      }

      // Respiración suave
      const breathe = 1 + Math.sin(t / 1100) * 0.012;
      this._orb.style.transform = `translate(-50%, -50%) scale(${breathe})`;
      this._orb.style.setProperty("--p", String(p));
    }
  }

  class SequenceMiniGame {
    constructor() {
      this.title = "Un ritmo pequeño";
      this.hint = "Toca las luces en el orden en que aparecen.";
      this.onComplete = null;
      this.onCancel = null;

      this._mounted = false;
      this._nodes = [];
      this._order = [];
      this._progress = 0;
      this._showing = true;
      this._phaseStart = nowMs();
      this._readyAt = 0;
      /** @type {Map<number, number>} */
      this._flashUntil = new Map();
      this._lastPressAt = 0;

      this._ui = null;
    }

    bindUi(ui) {
      this._ui = ui;
    }

    mount(areaEl) {
      this._mounted = true;
      const rect = areaEl.getBoundingClientRect();
      const w = Math.max(320, rect.width);
      const h = Math.max(260, rect.height);

      const positions = [
        { x: 0.22, y: 0.36 },
        { x: 0.52, y: 0.26 },
        { x: 0.78, y: 0.54 },
        { x: 0.36, y: 0.72 },
      ];

      const indices = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 3);
      this._order = indices.slice();
      this._progress = 0;
      this._showing = true;
      // Pausa previa para que el patrón sea más claro.
      this._phaseStart = nowMs() + 1300;
      this._readyAt = 0;
      this._flashUntil.clear();
      this._lastPressAt = 0;

      // Restablecer hint por si se reabre.
      this._ui?.setHint?.(this.hint);
      this._nodes = [];

      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        const p = positions[idx];
        const el = document.createElement("div");
        el.className = "node";
        el.style.left = `${Math.round(p.x * w)}px`;
        el.style.top = `${Math.round(p.y * h)}px`;
        el.style.transform = "translate(-50%, -50%)";
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", "Luz");

        const onPress = (e) => {
          try { e.preventDefault?.(); } catch {}
          if (!this._mounted) return;
          if (this._showing) return;
          const tNow = nowMs();
          if (tNow < this._readyAt) return;

          // Evita doble disparo (touchstart + click, etc.).
          if (tNow - this._lastPressAt < 240) return;
          this._lastPressAt = tNow;

          haptic(8);

          // Feedback visual: iluminar al tocar.
          this._flashUntil.set(idx, tNow + 260);

          const expected = this._order[this._progress];
          if (idx === expected) {
            this._progress++;
            if (this._progress >= this._order.length) {
              this.onComplete?.();
            }
          } else {
            // Reinicio suave.
            this._progress = 0;
          }
        };

        // Evita que el mismo toque dispare dos veces en móvil.
        if ("PointerEvent" in window) {
          el.addEventListener("pointerdown", onPress);
        } else {
          el.addEventListener("touchstart", onPress, { passive: false });
          el.addEventListener("click", onPress);
        }

        areaEl.appendChild(el);
        this._nodes.push({ idx, el });
      }
    }

    unmount() {
      this._mounted = false;
    }

    update(t) {
      if (!this._mounted) return;

      if (this._showing) {
        // Pre-start: mantener todo apagado.
        if (t < this._phaseStart) {
          for (const n of this._nodes) n.el.classList.remove("on");
          return;
        }
        // Más lento y legible: encendido un rato + pausa.
        const onMs = 980;
        const gapMs = 620;
        const stepMs = onMs + gapMs;
        const elapsed = t - this._phaseStart;
        const step = Math.floor(elapsed / stepMs);

        for (const n of this._nodes) n.el.classList.remove("on");

        if (step < this._order.length) {
          const within = elapsed - step * stepMs;
          if (within <= onMs) {
            const target = this._order[step];
            const node = this._nodes.find((n) => n.idx === target);
            if (node) node.el.classList.add("on");
          }
        } else {
          this._showing = false;
          this._phaseStart = t;
          // Pequeña pausa antes de permitir input.
          this._readyAt = t + 1500;
          this._flashUntil.clear();
          for (const n of this._nodes) n.el.classList.remove("on");

          this._ui?.setHint?.("Ahora tú. Repite el patrón.");
        }
        return;
      }

      // Estado interactivo: por defecto apagadas; se encienden brevemente al tocar.
      for (const n of this._nodes) {
        const until = this._flashUntil.get(n.idx) || 0;
        if (until > t) n.el.classList.add("on");
        else n.el.classList.remove("on");
      }

      const pulse = 0.5 + 0.5 * Math.sin(t / 1000);
      for (const n of this._nodes) {
        const s = 1 + pulse * 0.018;
        n.el.style.transform = `translate(-50%, -50%) scale(${s})`;
      }
    }
  }

  class CatchMiniGame {
    constructor() {
      this.title = "Mariposas";
      this.hint = "Toca tres mariposas con calma.";
      this.onComplete = null;
      this.onCancel = null;

      this._mounted = false;
      this._butterflies = [];
      this._caught = 0;
      this._target = 3;
      this._w = 0;
      this._h = 0;
    }

    mount(areaEl) {
      this._mounted = true;
      const rect = areaEl.getBoundingClientRect();
      this._w = Math.max(320, rect.width);
      this._h = Math.max(260, rect.height);
      this._caught = 0;
      this._butterflies = [];

      const count = 5;
      for (let i = 0; i < count; i++) {
        const el = document.createElement("div");
        el.className = "butterfly";
        el.textContent = "❀";

        const b = {
          el,
          x: Math.random() * (this._w - 80) + 40,
          y: Math.random() * (this._h - 80) + 40,
          vx: (Math.random() - 0.5) * 14,
          vy: (Math.random() - 0.5) * 14,
          phase: Math.random() * Math.PI * 2,
          alive: true,
        };

        // Posición inicial (por si el primer frame tarda)
        el.style.left = `${b.x}px`;
        el.style.top = `${b.y}px`;
        el.style.transform = `translate(-50%, -50%) scale(1)`;

        const onCatch = (e) => {
          try { e.preventDefault?.(); } catch {}
          if (!this._mounted) return;
          if (!b.alive) return;

          haptic(8);

          b.alive = false;
          this._caught++;
          el.classList.add("gone");
          if (this._caught >= this._target) {
            this.onComplete?.();
          }
        };

        el.addEventListener("pointerdown", onCatch);
        el.addEventListener("touchstart", onCatch, { passive: false });
        el.addEventListener("click", onCatch);

        areaEl.appendChild(el);
        this._butterflies.push(b);
      }
    }

    unmount() {
      this._mounted = false;
    }

    update(t) {
      if (!this._mounted) return;

      const dt = 1 / 60;
      for (const b of this._butterflies) {
        if (!b.alive) continue;
        b.phase += dt;

        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.x += Math.sin(t / 1400 + b.phase) * 0.10;
        b.y += Math.cos(t / 1600 + b.phase) * 0.10;

        if (b.x < 28 || b.x > this._w - 28) b.vx *= -1;
        if (b.y < 28 || b.y > this._h - 28) b.vy *= -1;

        const floatY = Math.sin(t / 980 + b.phase) * 2.0;
        const s = 1 + Math.sin(t / 1200 + b.phase) * 0.02;
        b.el.style.left = `${b.x}px`;
        b.el.style.top = `${b.y + floatY}px`;
        b.el.style.transform = `translate(-50%, -50%) scale(${s})`;
      }
    }
  }

  // ----------------------------
  // MessageSystem (no modal, no bloquea)
  // ----------------------------

  class MessageSystem {
    constructor({ boxEl, textEl }) {
      this.boxEl = boxEl;
      this.textEl = textEl;

      this._phase = /** @type {"idle" | "in" | "hold" | "out"} */ ("idle");
      this._t0 = 0;
      this._durIn = 520;
      this._durHold = 2400;
      this._durOut = 900;
      this._current = "";

      // Estado visual inicial
      this._applyVisual(0, 10);
    }

    show(text, opts = {}) {
      const { holdMs = this._durHold } = opts;

      this._current = text;
      this.textEl.textContent = text;

      this._durHold = holdMs;
      this._phase = "in";
      this._t0 = nowMs();
    }

    update() {
      if (this._phase === "idle") return;

      const t = nowMs() - this._t0;

      if (this._phase === "in") {
        const p = clamp01(t / this._durIn);
        const e = easeInOut(p);
        this._applyVisual(e, lerp(10, 0, e));
        if (p >= 1) {
          this._phase = "hold";
          this._t0 = nowMs();
        }
        return;
      }

      if (this._phase === "hold") {
        this._applyVisual(1, 0);
        if (t >= this._durHold) {
          this._phase = "out";
          this._t0 = nowMs();
        }
        return;
      }

      if (this._phase === "out") {
        const p = clamp01(t / this._durOut);
        const e = easeInOut(p);
        this._applyVisual(lerp(1, 0, e), lerp(0, 10, e));
        if (p >= 1) {
          this._phase = "idle";
          this._applyVisual(0, 10);
        }
      }
    }

    _applyVisual(opacity, translateY) {
      this.boxEl.style.opacity = String(opacity);
      this.boxEl.style.transform = `translateY(${translateY}px)`;
    }
  }

  // ----------------------------
  // ParticleSystem (canvas background)
  // ----------------------------

  class ParticleSystem {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = /** @type {CanvasRenderingContext2D | null} */ (canvas.getContext("2d", { alpha: true }));
      this.disabled = !this.ctx;

      this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      this.w = 0;
      this.h = 0;

      this.particles = [];
      this.maxParticles = prefersReducedMotion() ? 40 : 90;

      this._last = nowMs();
      if (!this.disabled) {
        this._seed();
        this.resize();
        window.addEventListener("resize", () => this.resize(), { passive: true });
      }
    }

    resize() {
      if (this.disabled || !this.ctx) return;
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, Math.floor(rect.width));
      this.h = Math.max(1, Math.floor(rect.height));
      this.canvas.width = Math.floor(this.w * this.dpr);
      this.canvas.height = Math.floor(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // Ajuste suave de cantidad
      this._seed();
    }

    _seed() {
      const target = this.maxParticles;
      while (this.particles.length < target) this.particles.push(this._makeParticle(true));
      while (this.particles.length > target) this.particles.pop();
    }

    _makeParticle(randomY) {
      // Estrellas/pétalos abstractos: puntitos y rombos suaves
      const x = Math.random() * this.w;
      const y = randomY ? Math.random() * this.h : this.h + 20 + Math.random() * 60;
      const r = 0.6 + Math.random() * 2.4;
      const speed = 2.2 + Math.random() * 6.8;
      const drift = (Math.random() - 0.5) * 5.5;
      const tw = 0.35 + Math.random() * 0.65;
      const phase = Math.random() * Math.PI * 2;

      // Paleta (morados / azul noche / rosa suave)
      const colors = [
        "rgba(231, 181, 255, 0.65)",
        "rgba(170, 195, 255, 0.55)",
        "rgba(255, 188, 214, 0.50)",
        "rgba(255, 255, 255, 0.32)",
      ];
      const color = colors[Math.floor(Math.random() * colors.length)];

      return {
        x,
        y,
        r,
        speed,
        drift,
        tw,
        phase,
        color,
        shape: Math.random() < 0.22 ? "diamond" : "dot",
      };
    }

    updateAndDraw() {
      if (this.disabled || !this.ctx) return;
      const t = nowMs();
      const dt = Math.min(0.05, (t - this._last) / 1000);
      this._last = t;

      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      // Velo suave para dar profundidad
      ctx.fillStyle = "rgba(7, 8, 22, 0.06)";
      ctx.fillRect(0, 0, this.w, this.h);

      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];

        p.y -= p.speed * dt;
        p.x += (p.drift * dt) * 0.6;

        // Wrap
        if (p.y < -30) {
          const np = this._makeParticle(false);
          this.particles[i] = np;
          continue;
        }
        if (p.x < -40) p.x = this.w + 40;
        if (p.x > this.w + 40) p.x = -40;

        const pulse = 0.55 + 0.45 * Math.sin(t / 900 + p.phase);
        const alpha = clamp01(0.12 + 0.42 * pulse * p.tw);

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.fillStyle = p.color.replace(/0\.[0-9]+\)/, `${alpha})`);

        if (p.shape === "diamond") {
          ctx.rotate(0.65);
          const s = p.r * 2.2;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.lineTo(s, 0);
          ctx.lineTo(0, s);
          ctx.lineTo(-s, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  // ----------------------------
  // InteractiveObject
  // ----------------------------

  class InteractiveObject {
    /**
     * @param {object} cfg
     * @param {string} cfg.id
     * @param {HTMLElement} cfg.el
     * @param {string} cfg.message
     * @param {number} cfg.idleSeed
     */
    constructor({ id, el, message, idleSeed }) {
      this.id = id;
      this.el = el;
      this.message = message;
      this.idleSeed = idleSeed;

      this.discovered = false;
      this._pulse = 0;
      this._clickAnim = { active: false, t0: 0 };

      this.el.addEventListener("click", (e) => {
        e.preventDefault();
        this.onInteract?.();
      });

      // Accesibilidad: permitir activar con Enter/Espacio.
      this.el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.onInteract?.();
        }
      });
    }

    setDiscovered(value) {
      this.discovered = value;
      this.el.classList.toggle("discovered", value);
      this.el.setAttribute("aria-pressed", value ? "true" : "false");
    }

    playInteractAnim() {
      this._clickAnim = { active: true, t0: nowMs() };
    }

    update(t) {
      // Idle (flotar / balancear) con rAF
      const s = this.idleSeed;
      const floatY = Math.sin(t / 1900 + s) * 4.2;
      const sway = Math.sin(t / 2400 + s * 2.1) * 1.4;
      const breathe = 1 + Math.sin(t / 2800 + s * 3.2) * 0.016;

      // Pequeña diferencia visual si ya está descubierto
      const glow = this.discovered ? 1.0 : 0.55;

      // Animación de interacción (tap)
      let tapScale = 1;
      if (this._clickAnim.active) {
        const p = clamp01((t - this._clickAnim.t0) / 620);
        const e = easeInOut(p);
        tapScale = 1 + Math.sin(e * Math.PI) * 0.05;
        if (p >= 1) this._clickAnim.active = false;
      }

      this.el.style.transform = `translate3d(0, ${floatY}px, 0) rotate(${sway}deg) scale(${breathe * tapScale})`;
      this.el.style.opacity = String(0.92 + 0.08 * glow);
    }
  }

  // ----------------------------
  // GameState
  // ----------------------------

  class GameState {
    constructor(totalMemories) {
      this.totalMemories = totalMemories;
      /** @type {Set<string>} */
      this.discovered = new Set();
      /** @type {SceneName} */
      this.scene = "intro";
      this.audioMuted = false;
      this.audioUnlocked = false;
    }

    discoveredCount() {
      return this.discovered.size;
    }

    isComplete() {
      return this.discovered.size >= this.totalMemories;
    }
  }

  // ----------------------------
  // SceneManager
  // ----------------------------

  class SceneManager {
    constructor({ introEl, worldEl, finalEl, fadeEl, darknessEl }) {
      this.introEl = introEl;
      this.worldEl = worldEl;
      this.finalEl = finalEl;
      this.fadeEl = fadeEl;
      this.darknessEl = darknessEl;
    }

    show(scene) {
      this.introEl.classList.toggle("hidden", scene !== "intro");
      this.worldEl.classList.toggle("hidden", scene !== "world");
      this.finalEl.classList.toggle("hidden", scene !== "final");
    }

    async transitionTo(scene) {
      this.fadeEl.classList.add("on");
      await waitMs(1150);
      this.show(scene);
      await waitMs(140);
      this.fadeEl.classList.remove("on");
    }

    setDarkness(on) {
      this.darknessEl.classList.toggle("on", on);
    }
  }

  // Espera basada en requestAnimationFrame (sin setTimeout).
  function waitMs(ms) {
    return new Promise((resolve) => {
      const start = nowMs();
      const step = () => {
        if (nowMs() - start >= ms) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // ----------------------------
  // App principal
  // ----------------------------

  class App {
    constructor() {
      // DOM
      this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("bg"));

      this.introScreen = /** @type {HTMLElement} */ (document.getElementById("introScreen"));
      this.worldScreen = /** @type {HTMLElement} */ (document.getElementById("worldScreen"));
      this.finalScreen = /** @type {HTMLElement} */ (document.getElementById("finalScreen"));

      this.fadeOverlay = /** @type {HTMLElement} */ (document.getElementById("fade"));
      this.darkness = /** @type {HTMLElement} */ (document.getElementById("darkness"));

      this.startBtn = /** @type {HTMLButtonElement} */ (document.getElementById("startBtn"));
      this.muteBtn = /** @type {HTMLButtonElement} */ (document.getElementById("muteBtn"));
      this.muteBtnFinal = /** @type {HTMLButtonElement} */ (document.getElementById("muteBtnFinal"));
      this.volumeSlider = /** @type {HTMLInputElement | null} */ (document.getElementById("volumeSlider"));
      this.volumeSliderFinal = /** @type {HTMLInputElement | null} */ (document.getElementById("volumeSliderFinal"));
      this.diaryBtn = /** @type {HTMLButtonElement} */ (document.getElementById("diaryBtn"));
      this.finalBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("finalBtn"));
      this.progressText = /** @type {HTMLElement} */ (document.getElementById("progressText"));

      this.messageBox = /** @type {HTMLElement} */ (document.getElementById("messageBox"));
      this.messageText = /** @type {HTMLElement} */ (document.getElementById("messageText"));

      this.finalParagraphs = /** @type {HTMLElement} */ (document.querySelector("#finalParagraphs"));

      this.finalCloseBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("finalCloseBtn"));

      // Player UI (final)
      this.playerTitle = /** @type {HTMLElement | null} */ (document.getElementById("playerTitle"));
      this.playerArtist = /** @type {HTMLElement | null} */ (document.getElementById("playerArtist"));
      this.playerPlayBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("playerPlay"));
      this.playerSeek = /** @type {HTMLInputElement | null} */ (document.getElementById("playerSeek"));
      this.playerTime = /** @type {HTMLElement | null} */ (document.getElementById("playerTime"));
      this.playerDur = /** @type {HTMLElement | null} */ (document.getElementById("playerDur"));

      this.playerArt = /** @type {HTMLElement | null} */ (document.querySelector(".playerArt"));
      this.playerArtImg = /** @type {HTMLImageElement | null} */ (document.getElementById("playerArtImg"));
      this.playerEl = /** @type {HTMLElement | null} */ (document.querySelector(".player"));

      /** @type {string[]} */
      this._artCandidates = [];
      this._artCandidateIndex = 0;

      /** @type {"final" | "world" | null} */
      this._artScene = null;

      this._playerRaf = 0;
      this._isSeeking = false;

      this._audioWatchdogAt = 0;

      this.audioAmbient = /** @type {HTMLAudioElement} */ (document.getElementById("audioAmbient"));
      this.audioFinal = /** @type {HTMLAudioElement} */ (document.getElementById("audioFinal"));

      // Diary DOM
      this.diaryScreen = /** @type {HTMLElement} */ (document.getElementById("diaryScreen"));
      this.diaryText = /** @type {HTMLElement} */ (document.getElementById("diaryText"));
      this.diaryMeta = /** @type {HTMLElement} */ (document.getElementById("diaryMeta"));
      this.diaryPrevBtn = /** @type {HTMLButtonElement} */ (document.getElementById("diaryPrevBtn"));
      this.diaryNextBtn = /** @type {HTMLButtonElement} */ (document.getElementById("diaryNextBtn"));
      this.diaryCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("diaryCloseBtn"));
      this.diaryBackdrop = /** @type {HTMLElement} */ (this.diaryScreen.querySelector(".overlayBackdrop"));

      // Mini-game DOM
      this.miniGameScreen = /** @type {HTMLElement} */ (document.getElementById("miniGameScreen"));
      this.miniGameTitle = /** @type {HTMLElement} */ (document.getElementById("miniGameTitle"));
      this.miniGameHint = /** @type {HTMLElement} */ (document.getElementById("miniGameHint"));
      this.miniGameArea = /** @type {HTMLElement} */ (document.getElementById("miniGameArea"));
      this.miniGameCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("miniGameCloseBtn"));
      this.miniGameBackdrop = /** @type {HTMLElement} */ (this.miniGameScreen.querySelector(".overlayBackdrop"));

      // Completion DOM
      this.completeScreen = /** @type {HTMLElement} */ (document.getElementById("completeScreen"));
      this.completeGoBtn = /** @type {HTMLButtonElement} */ (document.getElementById("completeGoBtn"));
      this.completeStayBtn = /** @type {HTMLButtonElement} */ (document.getElementById("completeStayBtn"));
      this.completeCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("completeCloseBtn"));
      this.completeBackdrop = /** @type {HTMLElement} */ (this.completeScreen.querySelector(".overlayBackdrop"));

      // Managers
      this.storage = new StorageManager("beautiful_emotional_game_v1");
      this.state = new GameState(9);

      /** @type {Map<string, string>} */
      this.assignedPhrases = new Map();

      /** @type {string[]} */
      this.unlockedOrder = [];

      this.seenFinal = false;

      this.sceneManager = new SceneManager({
        introEl: this.introScreen,
        worldEl: this.worldScreen,
        finalEl: this.finalScreen,
        fadeEl: this.fadeOverlay,
        darknessEl: this.darkness,
      });

      this.particles = new ParticleSystem(this.canvas);
      this.messages = new MessageSystem({ boxEl: this.messageBox, textEl: this.messageText });
      this.audio = new AudioManager({ ambientEl: this.audioAmbient, finalEl: this.audioFinal });

      this.diary = new DiarySystem({
        screenEl: this.diaryScreen,
        textEl: this.diaryText,
        metaEl: this.diaryMeta,
        prevBtn: this.diaryPrevBtn,
        nextBtn: this.diaryNextBtn,
        closeBtn: this.diaryCloseBtn,
        backdropEl: this.diaryBackdrop,
      });

      this.miniGames = new MiniGameManager({
        screenEl: this.miniGameScreen,
        titleEl: this.miniGameTitle,
        hintEl: this.miniGameHint,
        areaEl: this.miniGameArea,
        closeBtn: this.miniGameCloseBtn,
        backdropEl: this.miniGameBackdrop,
      });

      /** @type {InteractiveObject[]} */
      this.objects = [];

      this._running = false;
      this._raf = 0;

      this._finalTimeline = null;

      this._initObjects();
      this._restore();
      this._wire();

      // Importante: siempre arrancamos en la intro al recargar.
      // El progreso se mantiene, pero nunca saltamos directo al final.
      this.state.scene = "intro";
      this.sceneManager.setDarkness(false);
      this.sceneManager.show("intro");
      this._applyMuteUi();
      this._updateProgressUi();
      this._updateDiaryUi();
      this._updateFinalBtnUi();
      this._initPlayerUi();

      this.start();
    }

    _wire() {
      // Gesto de usuario: desbloquea audio (autoplay restrictions)
      const unlock = async () => {
        let ok = false;
        if (this.state.scene === "final") {
          ok = await this.audio.unlockAndStartFinal();
        } else {
          ok = await this.audio.unlockAndStartAmbient();
        }
        this.state.audioUnlocked = !!ok;
      };

      this.startBtn.addEventListener("click", async () => {
        haptic(12);
        await unlock();
        await this.sceneManager.transitionTo("world");
        this.state.scene = "world";

        if (this.state.isComplete()) this._openCompletion();
      });

      // Tap en la intro también cuenta como gesto de audio.
      this.introScreen.addEventListener("pointerdown", () => {
        if (!this.state.audioUnlocked) unlock();
      }, { passive: true });

      // Cualquier tap en el mundo también desbloquea audio si aún no.
      this.worldScreen.addEventListener("pointerdown", () => {
        if (!this.state.audioUnlocked) unlock();
      }, { passive: true });

      const nudgeAudio = () => {
        if (!this.state.audioUnlocked) return;
        if (this.state.audioMuted) return;
        this.audio.ensurePlayback();
      };

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") nudgeAudio();
      });
      window.addEventListener("focus", nudgeAudio);
      window.addEventListener("pageshow", nudgeAudio);

      const toggleMute = async () => {
        haptic(10);
        // si aún no se desbloqueó, el click del botón cuenta como gesto.
        if (!this.state.audioUnlocked) {
          await unlock();
        }

        this.state.audioMuted = !this.state.audioMuted;
        this.audio.setMuted(this.state.audioMuted);
        this._applyMuteUi();
        this._persist();

        // Si se desmutea después, reanudamos según escena.
        if (!this.state.audioMuted) {
          if (this.state.scene === "final") {
            // Si ya estaba habilitado, pasar a final (o reanudar).
            if (!this.audio.enabled) {
              await this.audio.unlockAndStartFinal();
            } else {
              await this.audio.switchToFinal();
            }
          } else {
            if (!this.audio.enabled) {
              await this.audio.unlockAndStartAmbient();
            } else {
              // Reanudar ambiente si estaba pausado.
              try { await this.audio.ambient.play(); } catch {}
            }
          }
        }
      };

      this.muteBtn.addEventListener("click", toggleMute);
      this.muteBtnFinal.addEventListener("click", toggleMute);

      const applyVolumeFrom = (el) => {
        if (!el) return;
        const v = clamp01((Number(el.value) || 0) / 100);
        this.audio.setMasterVolume(v);
        if (this.volumeSlider && this.volumeSlider !== el) this.volumeSlider.value = String(Math.round(v * 100));
        if (this.volumeSliderFinal && this.volumeSliderFinal !== el) this.volumeSliderFinal.value = String(Math.round(v * 100));
        this._persist();
      };

      this.volumeSlider?.addEventListener("input", () => applyVolumeFrom(this.volumeSlider));
      this.volumeSliderFinal?.addEventListener("input", () => applyVolumeFrom(this.volumeSliderFinal));

      // Haptic only on commit/release (avoid vibrating continuously while sliding).
      this.volumeSlider?.addEventListener("change", () => haptic(8));
      this.volumeSliderFinal?.addEventListener("change", () => haptic(8));
      this.volumeSlider?.addEventListener("pointerdown", () => haptic(8), { passive: true });
      this.volumeSliderFinal?.addEventListener("pointerdown", () => haptic(8), { passive: true });

      this.diaryBtn.addEventListener("click", async () => {
        if (!this.state.audioUnlocked) {
          await unlock();
        }
        haptic(10);
        this.diary.open();
      });

      this.finalBtn?.addEventListener("click", () => {
        if (this.state.scene !== "world") return;
        if (!this.state.isComplete()) return;
        haptic(10);
        this._openCompletion();
      });

      const closeCompletion = () => {
        haptic(10);
        this._closeCompletion();
      };
      this.completeBackdrop.addEventListener("click", closeCompletion);
      this.completeCloseBtn.addEventListener("click", closeCompletion);
      this.completeStayBtn.addEventListener("click", closeCompletion);

      this.completeGoBtn.addEventListener("click", async () => {
        // El botón cuenta como gesto, por si el usuario estaba con audio bloqueado.
        if (!this.state.audioUnlocked) {
          await unlock();
        }

        haptic([16, 22, 16]);

        this.seenFinal = true;
        this._persist();
        this._closeCompletion();
        await this._beginFinal(true);
      });

      this.finalCloseBtn?.addEventListener("click", async () => {
        if (this.state.scene !== "final") return;

        haptic(10);

        this.sceneManager.setDarkness(false);
        await this.sceneManager.transitionTo("world");
        this.state.scene = "world";

        if (!this.state.audioMuted) {
          if (!this.audio.enabled) {
            if (this.state.audioUnlocked) await this.audio.unlockAndStartAmbient();
          } else {
            await this.audio.switchToAmbient();
          }
        }

        this._stopPlayerLoop();
      });

      // Player controls
      this.playerPlayBtn?.addEventListener("click", async () => {
        haptic(10);
        const el = this.state.scene === "final" ? this.audioFinal : this.audioAmbient;

        // Cuenta como gesto para audio.
        if (!this.state.audioUnlocked) {
          await unlock();
        }

        if (this.state.audioMuted) return;

        try {
          if (el.paused) await el.play();
          else el.pause();
        } catch {
          // ignore
        }

        this._syncPlayerOnce();
        this._startPlayerLoop();
      });

      this.playerSeek?.addEventListener("input", () => {
        this._isSeeking = true;
        this._syncPlayerOnce();
      });

      this.playerSeek?.addEventListener("change", () => {
        haptic(8);
        const el = this.state.scene === "final" ? this.audioFinal : this.audioAmbient;
        const dur = Number.isFinite(el.duration) ? el.duration : 0;
        const v = this.playerSeek ? Number(this.playerSeek.value) : 0;
        if (dur > 0) {
          try { el.currentTime = (v / 100) * dur; } catch {}
        }
        this._isSeeking = false;
      });
    }

    _initPlayerUi() {
      // Cover art (optional). Drop files next to index.html.
      // - cover-final.(jpg|png|webp)
      // - cover-world.(jpg|png|webp)
      if (this.playerArtImg && this.playerArt) {
        this.playerArtImg.addEventListener("load", () => {
          this.playerArt?.classList.add("hasImg");
          const src = this.playerArtImg?.getAttribute("src") || "";
          this._setPlayerBackdrop(src);
        });
        this.playerArtImg.addEventListener("error", () => {
          this.playerArt?.classList.remove("hasImg");
          this._setPlayerBackdrop("");
          this._tryNextArtCandidate();
        });

        // If the browser already has it cached/loaded, ensure visibility.
        if (this.playerArtImg.complete && this.playerArtImg.naturalWidth > 0) {
          this.playerArt.classList.add("hasImg");
          const src = this.playerArtImg.getAttribute("src") || "";
          this._setPlayerBackdrop(src);
        }
      }

      // Metadata (simple, local)
      this._setPlayerMetaForScene("final");

      // Keep UI in sync when audio state changes
      const onChange = () => {
        this._syncPlayerOnce();
        this._startPlayerLoop();
      };
      this.audioFinal.addEventListener("play", onChange);
      this.audioFinal.addEventListener("pause", onChange);
      this.audioFinal.addEventListener("durationchange", onChange);
      this.audioFinal.addEventListener("timeupdate", () => {
        if (!this._isSeeking) this._syncPlayerOnce();
      });
    }

    _setPlayerMetaForScene(scene) {
      // Puedes cambiar estos textos si quieres.
      if (!this.playerTitle || !this.playerArtist) return;
      if (scene === "final") {
        this.playerTitle.textContent = "Beautiful";
        this.playerArtist.textContent = "BTS";
      } else {
        this.playerTitle.textContent = "4 O'Clock";
        this.playerArtist.textContent = "Instrumental";
      }

      this._setPlayerArtForScene(scene);
    }

    _setPlayerArtForScene(scene) {
      if (!this.playerArtImg || !this.playerArt) return;

      /** @type {"final" | "world"} */
      const artScene = scene === "final" ? "final" : "world";

      // Fast path: if we're still on the same scene and the image is already loaded,
      // don't reset classes or src (otherwise we'd hide it permanently).
      if (this._artScene === artScene) {
        if (this.playerArtImg.complete && this.playerArtImg.naturalWidth > 0) {
          this.playerArt.classList.add("hasImg");
        }
        return;
      }

      this._artScene = artScene;

      const base = artScene === "final" ? "cover-final" : "cover-world";
      const candidates = [];

      // If the user drops a specifically named file, accept it.
      if (scene === "final") {
        candidates.push("BeautifulArt.jpg", "BeautifulArt.png", "BeautifulArt.webp");
      }

      // Scene-specific names.
      candidates.push(`${base}.jpg`, `${base}.png`, `${base}.webp`);

      // Generic fallback (single cover for everything).
      candidates.push("cover.jpg", "cover.png", "cover.webp");

      this._artCandidates = candidates;
      this._artCandidateIndex = 0;

      // Reset visibility until load confirms.
      this.playerArt.classList.remove("hasImg");
      this._applyArtCandidate(this._artCandidates[this._artCandidateIndex]);
    }

    _applyArtCandidate(src) {
      if (!this.playerArtImg) return;
      // Avoid reloading same src unnecessarily.
      if (this.playerArtImg.getAttribute("src") === src) {
        // If it's already available, ensure it's visible.
        if (this.playerArt && this.playerArtImg.complete && this.playerArtImg.naturalWidth > 0) {
          this.playerArt.classList.add("hasImg");
          this._setPlayerBackdrop(src);
        }
        return;
      }
      this.playerArtImg.setAttribute("src", src);
    }

    _tryNextArtCandidate() {
      if (!this.playerArtImg || !this.playerArt) return;
      if (!this._artCandidates.length) return;

      this._artCandidateIndex += 1;
      if (this._artCandidateIndex >= this._artCandidates.length) {
        // No cover found; fall back to gradient tile.
        this.playerArtImg.removeAttribute("src");
        this._setPlayerBackdrop("");
        return;
      }
      this._applyArtCandidate(this._artCandidates[this._artCandidateIndex]);
    }

    _setPlayerBackdrop(src) {
      if (!this.playerEl) return;
      if (!src) {
        this.playerEl.style.setProperty("--player-art", "none");
        return;
      }
      // Use a CSS var so CSS can blur it smoothly.
      this.playerEl.style.setProperty("--player-art", `url(\"${src}\")`);
    }

    _fmtTime(sec) {
      if (!Number.isFinite(sec) || sec < 0) return "0:00";
      const s = Math.floor(sec % 60);
      const m = Math.floor(sec / 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    _syncPlayerOnce() {
      const el = this.state.scene === "final" ? this.audioFinal : this.audioAmbient;
      this._setPlayerMetaForScene(this.state.scene);

      const dur = Number.isFinite(el.duration) ? el.duration : 0;
      const cur = Number.isFinite(el.currentTime) ? el.currentTime : 0;

      if (this.playerDur) this.playerDur.textContent = this._fmtTime(dur);
      if (this.playerTime) {
        const shown = this._isSeeking && this.playerSeek && dur > 0
          ? (Number(this.playerSeek.value) / 100) * dur
          : cur;
        this.playerTime.textContent = this._fmtTime(shown);
      }

      if (this.playerSeek && dur > 0 && !this._isSeeking) {
        this.playerSeek.value = String((cur / dur) * 100);
      }

      if (this.playerPlayBtn) {
        const playing = !el.paused && !el.ended;
        this.playerPlayBtn.textContent = playing ? "⏸" : "▶";
        this.playerPlayBtn.setAttribute("aria-pressed", playing ? "true" : "false");
      }
    }

    _startPlayerLoop() {
      if (this._playerRaf) return;
      const loop = () => {
        this._playerRaf = 0;
        if (this.state.scene !== "final") return;
        this._syncPlayerOnce();
        this._playerRaf = requestAnimationFrame(loop);
      };
      this._playerRaf = requestAnimationFrame(loop);
    }

    _stopPlayerLoop() {
      if (!this._playerRaf) return;
      cancelAnimationFrame(this._playerRaf);
      this._playerRaf = 0;
    }

    _initObjects() {
      const data = getMemories();
      for (const item of data) {
        const el = /** @type {HTMLElement} */ (document.querySelector(`[data-obj='${item.id}']`));
        if (!el) continue;

        const obj = new InteractiveObject({
          id: item.id,
          el,
          message: item.message,
          idleSeed: item.idleSeed,
        });

        obj.onInteract = () => this._handleInteract(obj);
        this.objects.push(obj);
      }
    }

    async _handleInteract(obj) {
      if (this.state.scene !== "world") return;
      if (this.state.isComplete()) return;
      if (this.diary.isOpen() || this.miniGames.isOpen()) return;
      if (!this.completeScreen.classList.contains("hidden")) return;

      // Feedback sutil al tocar un objeto.
      haptic(10);

      obj.playInteractAnim();

      if (!obj.discovered) {
        const ok = await this._runMiniGameFor(obj.id);
        if (!ok) return;

        obj.setDiscovered(true);
        this.state.discovered.add(obj.id);

        const phrase = this._getOrAssignPhrase(obj.id);
        if (!this.unlockedOrder.includes(obj.id)) this.unlockedOrder.push(obj.id);

        this._persist();
        this.audio.playChime();

        // Feedback de éxito al desbloquear.
        haptic([18, 26, 18]);

        this.messages.show(phrase, { holdMs: 2800 });
        this._updateProgressUi();
        this._updateDiaryUi();
        this._updateFinalBtnUi();

        if (this.state.isComplete()) {
          haptic([26, 40, 26, 60, 26]);
          this._openCompletion();
        }
      } else {
        // No repetimos el recuerdo; solo un susurro breve.
        this.messages.show("Ya lo tocaste antes. No hace falta repetirlo.", { holdMs: 1500 });
      }
    }

    async _runMiniGameFor(objectId) {
      let game;
      // Variación intencional (3 tipos), sin volverse "juego".
      if (objectId === "butterfly" || objectId === "star") game = new CatchMiniGame();
      else if (objectId === "letter" || objectId === "light") game = new HoldMiniGame();
      else game = new SequenceMiniGame();
      return await this.miniGames.open(game);
    }

    _updateProgressUi() {
      const c = this.state.discoveredCount();
      const t = this.state.totalMemories;
      this.progressText.textContent = `Has descubierto ${c} de ${t} recuerdos`;
    }

    _applyMuteUi() {
      const muted = this.state.audioMuted;
      this.muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
      this.muteBtn.setAttribute("title", muted ? "Activar sonido" : "Silenciar");
      this.muteBtn.textContent = muted ? "🔇" : "🔈";

      this.muteBtnFinal.setAttribute("aria-pressed", muted ? "true" : "false");
      this.muteBtnFinal.setAttribute("title", muted ? "Activar sonido" : "Silenciar");
      this.muteBtnFinal.textContent = muted ? "🔇" : "🔈";
    }

    _persist() {
      const assignedPhrases = {};
      for (const [id, phrase] of this.assignedPhrases.entries()) {
        assignedPhrases[id] = phrase;
      }

      this.storage.save({
        discoveredIds: Array.from(this.state.discovered),
        muted: this.state.audioMuted,
        volume: this.audio.masterVolume,
        assignedPhrases,
        unlockedOrder: this.unlockedOrder.slice(),
        seenFinal: this.seenFinal,
      });
    }

    _restore() {
      const saved = this.storage.load();
      this.state.audioMuted = saved.muted;
      this.audio.setMuted(this.state.audioMuted);

      this.audio.setMasterVolume(typeof saved.volume === "number" ? saved.volume : 1);
      const volUi = String(Math.round(this.audio.masterVolume * 100));
      if (this.volumeSlider) this.volumeSlider.value = volUi;
      if (this.volumeSliderFinal) this.volumeSliderFinal.value = volUi;

      // Restaurar asignación de frases por objeto (para no cambiar con recargas).
      if (saved.assignedPhrases && typeof saved.assignedPhrases === "object") {
        for (const [id, phrase] of Object.entries(saved.assignedPhrases)) {
          if (typeof phrase === "string") this.assignedPhrases.set(String(id), phrase);
        }
      }

      if (Array.isArray(saved.unlockedOrder)) {
        this.unlockedOrder = saved.unlockedOrder.map((v) => String(v));
      }

      this.seenFinal = !!saved.seenFinal;

      for (const id of saved.discoveredIds) {
        this.state.discovered.add(String(id));
      }

      // Compat: si ya había descubrimientos pero no frases asignadas (save antiguo), las asignamos ahora.
      for (const id of this.state.discovered) {
        this._getOrAssignPhrase(id);
      }

      for (const obj of this.objects) {
        obj.setDiscovered(this.state.discovered.has(obj.id));
      }

      // Compat: si hay descubiertos pero no hay orden guardado, construimos uno estable.
      if (this.unlockedOrder.length === 0 && this.state.discovered.size > 0) {
        for (const obj of this.objects) {
          if (this.state.discovered.has(obj.id)) this.unlockedOrder.push(obj.id);
        }
      }

      // Nota: aquí no cambiamos escenas. Solo restauramos progreso/estado.
    }

    _openCompletion() {
      this.completeScreen.classList.remove("hidden");
    }

    _closeCompletion() {
      this.completeScreen.classList.add("hidden");
    }

    _updateFinalBtnUi() {
      if (!this.finalBtn) return;
      this.finalBtn.classList.toggle("hidden", !this.state.isComplete());
    }

    _getOrAssignPhrase(objectId) {
      const existing = this.assignedPhrases.get(objectId);
      if (existing) return existing;

      const pool = getInteractionPhrases();
      const used = new Set(this.assignedPhrases.values());
      const available = pool.filter((p) => !used.has(p));

      const pickFrom = available.length > 0 ? available : pool;
      const chosen = pickFrom[Math.floor(Math.random() * pickFrom.length)];

      this.assignedPhrases.set(objectId, chosen);
      return chosen;
    }

    _updateDiaryUi() {
      const phrases = [];
      for (const id of this.unlockedOrder) {
        const p = this.assignedPhrases.get(id);
        if (p) phrases.push(p);
      }
      this.diary.setPhrases(phrases);
    }

    async _beginFinal(fromButton = false) {
      // Bloquear interacciones normales y oscurecer suave
      this.sceneManager.setDarkness(true);

      // Dar tiempo a que la oscuridad se sienta (más narrativo)
      await waitMs(1100);

      // Cambiar a escena final con fade
      await this.sceneManager.transitionTo("final");
      this.state.scene = "final";

      // Cambiar música (Beautiful solo aquí). Si aún no estaba habilitado, iniciamos directo final.
      if (!this.audio.enabled) {
        await this.audio.unlockAndStartFinal();
      } else {
        // Asegura que 4 O'Clock se silencie y Beautiful entre suave.
        await this.audio.switchToFinal();
      }

      // Texto final por párrafos (lento, por partes)
      this._setupFinalText();
      this._startFinalTimeline();

      this._syncPlayerOnce();
      this._startPlayerLoop();

      this._updateFinalBtnUi();
    }

    _setupFinalText() {
      this.finalParagraphs.innerHTML = "";
      for (const p of getFinalMessageParagraphs()) {
        const el = document.createElement("p");
        el.className = "finalParagraph";
        el.textContent = p;
        this.finalParagraphs.appendChild(el);
      }
    }

    _startFinalTimeline() {
      /**
       * Timeline con rAF (sin setInterval). Revela un párrafo cada cierto tiempo.
       */
      const nodes = Array.from(this.finalParagraphs.querySelectorAll(".finalParagraph"));
      // Empieza más pronto para que se sienta "vivo" al entrar.
      const baseDelay = prefersReducedMotion() ? 500 : 900;
      const stepDelay = prefersReducedMotion() ? 900 : 2100;

      this._finalTimeline = {
        start: nowMs(),
        revealed: 0,
        baseDelay,
        stepDelay,
        nodes,
      };
    }

    start() {
      if (this._running) return;
      this._running = true;
      const tick = () => {
        const t = nowMs();
        try {
          // Fondo (siempre)
          this.particles.updateAndDraw();

          // Objetos del mundo
          if (this.state.scene === "world") {
            for (const obj of this.objects) obj.update(t);
          }

          // Mensajes
          this.messages.update();

          // Audio
          this.audio.update();

          // Watchdog: reintenta audio si Chrome lo pausa.
          if (this.state.audioUnlocked && !this.state.audioMuted) {
            if (t - this._audioWatchdogAt > 2500) {
              this._audioWatchdogAt = t;
              this.audio.ensurePlayback();
            }
          }

          // Mini-games
          this.miniGames.update(t);

          // Final timeline
          if (this.state.scene === "final" && this._finalTimeline) {
            this._updateFinalTimeline(t);
          }
        } catch (err) {
          // No matamos el loop si algo falla; ayuda a depurar.
          console.error("Tick error:", err);
        } finally {
          this._raf = requestAnimationFrame(tick);
        }
      };
      this._raf = requestAnimationFrame(tick);
    }

    _updateFinalTimeline(t) {
      const tl = this._finalTimeline;
      if (!tl) return;

      const elapsed = t - tl.start;
      const nextIndex = tl.revealed;
      if (nextIndex >= tl.nodes.length) return;

      const due = tl.baseDelay + nextIndex * tl.stepDelay;
      if (elapsed >= due) {
        tl.nodes[nextIndex].classList.add("on");
        tl.revealed++;
      }
    }
  }

  // ----------------------------
  // Contenido (recuerdos)
  // ----------------------------

  function getMemories() {
    // 9 recuerdos únicos, cortos y suaves.
    return [
      {
        id: "flower",
        idleSeed: 0.7,
        message: "",
      },
      {
        id: "star",
        idleSeed: 1.8,
        message: "",
      },
      {
        id: "letter",
        idleSeed: 2.6,
        message: "",
      },
      {
        id: "light",
        idleSeed: 3.1,
        message: "",
      },
      {
        id: "butterfly",
        idleSeed: 4.2,
        message: "",
      },
      {
        id: "moon",
        idleSeed: 5.3,
        message: "",
      },
      {
        id: "ribbon",
        idleSeed: 6.2,
        message: "",
      },
      {
        id: "spark",
        idleSeed: 7.1,
        message: "",
      },
      {
        id: "seal",
        idleSeed: 8.0,
        message: "",
      },
    ];
  }

  function getInteractionPhrases() {
    return [
      "Hay momentos simples que contigo se vuelven mis favoritos.",
      "A veces pienso que nos encontramos justo cuando más lo necesitábamos.",
      "Me gusta la forma en que el tiempo se desordena cuando estamos juntos.",
      "A veces tu recuerdo es todo lo que necesito para sentirme bien.",
      "Me gusta cómo el tiempo se desordena cuando estamos juntos.",
      "Algunas cosas sólo tienen sentido contigo, incluso en silencio.",
      "Es curioso cómo un simple pensamiento tuyo puede acompañarme todo el día.",
      "No todo tiene que ser especial para ser importante.",
      "No importa qué estemos haciendo, contigo siempre se siente mejor.",
      "Si algo quiero repetir muchas veces, es esto que tenemos sin forzarlo.",
    ];
  }

  function getFinalMessageParagraphs() {
    return [
      "Siempre hay algo que se siente diferente, incluso en los días más comunes.",
      "Hay noches que no quiero que se terminen solo porque estás ahí.",
      "No todo necesita explicación; algunas sensaciones se entienden sin palabras.",
      "Hay algo tuyo que me da fuerza cuando siento que no puedo más.",
      "Gracias por estar en lugares donde no caben las palabras, solo el silencio y la presencia.",
      "Al final, lo más importante es sentir que ciertos momentos valen la pena, y tú eres uno de ellos.",
    ];
  }

  // ----------------------------
  // Bootstrap
  // ----------------------------

  window.addEventListener("DOMContentLoaded", () => {
    // Evitar selección accidental en móvil
    document.body.style.webkitUserSelect = "none";

    new App();
  });
})();
