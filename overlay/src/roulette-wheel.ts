/**
 * Animated spinning roulette wheel component using Canvas.
 * Displays candidates as colored segments with avatars, spins with
 * smooth easing animation, and reveals the winner.
 */

export interface RouletteCandidate {
  id: string;
  displayName: string;
  avatarUrl?: string;
  color: string;
}

export interface RouletteWheelConfig {
  candidates: RouletteCandidate[];
  spinDurationMs?: number;
  onResult?: (winnerId: string) => void;
}

const DEFAULT_SPIN_DURATION_MS = 5000;
const TAU = Math.PI * 2;

export function winnerRotation(current: number, index: number, count: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Invalid server winner.');
  const desired = -(index + 0.5) * TAU / count;
  const delta = ((desired - current) % TAU + TAU) % TAU;
  return current + 6 * TAU + delta;
}

// Cached avatar images
const avatarCache = new Map<string, HTMLImageElement>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = avatarCache.get(url);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      avatarCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => resolve(img); // Fallback to broken image
    img.src = url;
  });
}

// More dramatic ease-out for realistic wheel spin
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export class RouletteWheel {
  private container: HTMLElement;
  private config: Required<RouletteWheelConfig>;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentRotation = 0;
  private isSpinning = false;
  private animationId: number | null = null;
  private loadedAvatars = new Map<string, HTMLImageElement>();
  private audioContext: AudioContext | null = null;
  private lastTickAngle = 0;

  constructor(container: HTMLElement, config: RouletteWheelConfig) {
    this.container = container;
    this.config = {
      candidates: config.candidates,
      spinDurationMs: config.spinDurationMs ?? DEFAULT_SPIN_DURATION_MS,
      onResult: config.onResult ?? (() => {}),
    };

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'roulette-wheel';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    // Preload avatars
    this.preloadAvatars();
  }

  private async preloadAvatars(): Promise<void> {
    const promises = this.config.candidates
      .filter((c) => c.avatarUrl)
      .map(async (c) => {
        const img = await loadImage(c.avatarUrl!);
        this.loadedAvatars.set(c.id, img);
      });
    await Promise.all(promises);
    // Re-render after avatars load
    if (!this.isSpinning) this.draw();
  }

  render(): void {
    this.container.innerHTML = '';
    this.container.classList.add('roulette-wheel-container');

    // Create wrapper for wheel and pointer
    const wrapper = document.createElement('div');
    wrapper.className = 'roulette-wheel-wrapper';

    // Create pointer
    const pointer = document.createElement('div');
    pointer.className = 'roulette-pointer';

    // Size canvas
    const size = Math.min(this.container.clientWidth || 400, this.container.clientHeight || 400, 500);
    this.canvas.width = size * window.devicePixelRatio;
    this.canvas.height = size * window.devicePixelRatio;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    wrapper.appendChild(this.canvas);
    wrapper.appendChild(pointer);
    this.container.appendChild(wrapper);

    this.draw();
  }

  private draw(): void {
    const { candidates } = this.config;
    const ctx = this.ctx;
    const size = this.canvas.width / window.devicePixelRatio;
    const center = size / 2;
    const radius = center - 10;
    const segmentAngle = TAU / candidates.length;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(this.currentRotation);

    // Draw segments
    candidates.forEach((candidate, i) => {
      const startAngle = i * segmentAngle - Math.PI / 2;
      const endAngle = startAngle + segmentAngle;

      // Segment fill
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = candidate.color;
      ctx.fill();

      // Segment border
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw avatar or initial in segment
      ctx.save();
      const midAngle = startAngle + segmentAngle / 2;
      const avatarDist = radius * 0.6;
      const avatarX = Math.cos(midAngle) * avatarDist;
      const avatarY = Math.sin(midAngle) * avatarDist;
      ctx.translate(avatarX, avatarY);
      ctx.rotate(midAngle + Math.PI / 2);

      const avatarSize = Math.min(40, radius * 0.25);
      const avatar = this.loadedAvatars.get(candidate.id);

      // Draw circular avatar area
      ctx.beginPath();
      ctx.arc(0, 0, avatarSize / 2, 0, TAU);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();

      if (avatar && avatar.complete && avatar.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, avatarSize / 2 - 2, 0, TAU);
        ctx.clip();
        ctx.drawImage(avatar, -avatarSize / 2 + 2, -avatarSize / 2 + 2, avatarSize - 4, avatarSize - 4);
        ctx.restore();
      } else {
        // Draw initial
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${avatarSize * 0.5}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(candidate.displayName.charAt(0).toUpperCase(), 0, 0);
      }

      // Draw name below avatar
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, radius * 0.08)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 4;
      const name = candidate.displayName.length > 10 ? candidate.displayName.slice(0, 9) + '…' : candidate.displayName;
      ctx.fillText(name, 0, avatarSize / 2 + 4);
      ctx.shadowBlur = 0;

      ctx.restore();
    });

    // Center hub
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.15, 0, TAU);
    ctx.fillStyle = '#1a1a2e';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner hub highlight
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.1, 0, TAU);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.1);
    gradient.addColorStop(0, '#4a4a6e');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.restore();
  }

  async spin(winnerId: string): Promise<void> {
    if (this.isSpinning) return;
    if (this.config.candidates.length === 0) throw new Error('A server-selected winner requires candidates.');

    const winner = this.config.candidates.find((candidate) => candidate.id === winnerId);
    if (!winner) throw new Error('The server winner is not in this wheel.');
    this.isSpinning = true;

    const winnerIndex = this.config.candidates.indexOf(winner);
    // The pointer is at twelve o'clock; use whole turns plus the exact winning angle.
    const targetRotation = winnerRotation(this.currentRotation, winnerIndex, this.config.candidates.length);

    const startRotation = this.currentRotation;
    const startTime = performance.now();
    const duration = this.config.spinDurationMs;

    // Initialize audio for tick sound
    this.initAudio();
    this.lastTickAngle = this.currentRotation;

    return new Promise((resolve) => {
      const animate = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeOutExpo(progress);

        this.currentRotation = startRotation + (targetRotation - startRotation) * easedProgress;

        // Play tick sound when passing segment boundaries
        this.maybePlayTick();

        this.draw();

        if (progress < 1) {
          this.animationId = requestAnimationFrame(animate);
        } else {
          this.isSpinning = false;
          this.animationId = null;

          // Trigger winner reveal
          this.highlightWinner(winner);
          this.config.onResult(winner.id);
          resolve();
        }
      };

      this.animationId = requestAnimationFrame(animate);
    });
  }

  private initAudio(): void {
    if (this.audioContext) return;
    try {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      // Audio not available
    }
  }

  private maybePlayTick(): void {
    if (!this.audioContext) return;

    const segmentAngle = TAU / this.config.candidates.length;
    const passedSegments = Math.floor((this.currentRotation - this.lastTickAngle) / segmentAngle);

    if (passedSegments > 0) {
      this.lastTickAngle += passedSegments * segmentAngle;
      this.playTickSound();
    }
  }

  private playTickSound(): void {
    if (!this.audioContext) return;

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    osc.connect(gain);
    gain.connect(this.audioContext.destination);

    osc.frequency.value = 800 + Math.random() * 200;
    osc.type = 'sine';

    gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.05);

    osc.start(this.audioContext.currentTime);
    osc.stop(this.audioContext.currentTime + 0.05);
  }

  private highlightWinner(winner: RouletteCandidate): void {
    // Add winner highlight effect
    const wrapper = this.container.querySelector('.roulette-wheel-wrapper');
    if (wrapper) {
      wrapper.classList.add('winner-revealed');

      // Create winner announcement
      const announcement = document.createElement('div');
      announcement.className = 'roulette-winner-announcement';
      const glow = document.createElement('div');
      glow.className = 'winner-glow';
      const text = document.createElement('div');
      text.className = 'winner-text';
      const label = document.createElement('span');
      label.className = 'winner-label';
      label.textContent = 'Winner!';
      const name = document.createElement('span');
      name.className = 'winner-name';
      name.textContent = winner.displayName;
      text.append(label, name);
      announcement.append(glow, text);
      this.container.appendChild(announcement);

      // Trigger animation
      requestAnimationFrame(() => {
        announcement.classList.add('visible');
      });
    }
  }

  destroy(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.container.innerHTML = '';
    this.container.classList.remove('roulette-wheel-container');
    this.loadedAvatars.clear();
  }
}

/**
 * Factory function to create a RouletteWheel instance.
 */
export function createRouletteWheel(container: HTMLElement, config: RouletteWheelConfig): RouletteWheel {
  const wheel = new RouletteWheel(container, config);
  wheel.render();
  return wheel;
}
