/**
 * 浏览器侧音频工具层。
 *
 * 使用 Web Audio API —— Electron (Chromium) 与 Android WebView 均原生支持，
 * 无需任何第三方音频库。
 */
import {
  encodeWav,
  renderTimeline,
  type TimedElement,
} from '@core/index';
import {
  getMicrophoneStream,
  type MicrophoneDiagnostic,
} from './microphone';
import { describeMicrophoneError } from './microphone';

/** 音频上下文（懒创建，兼容用户手势前不能启动的限制） */
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    // latencyHint: 'interactive' —— 申请最小输出缓冲，
    // 显著降低按键发声的延迟（默认 'balanced' 会有更大的缓冲）
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      ctx = new Ctor();
    }
  }
  return ctx;
}

/** 恢复音频上下文（浏览器要求用户手势后调用） */
export async function resumeAudio(): Promise<void> {
  const c = getAudioContext();
  if (c.state === 'suspended') await c.resume();
}

/** 当前播放的节点（用于停止） */
let currentSource: AudioBufferSourceNode | null = null;

/** 播放状态回调 */
type PlayState = 'idle' | 'playing' | 'stopped';
let playState: PlayState = 'idle';
const stateListeners = new Set<(s: PlayState) => void>();

export function onPlayState(fn: (s: PlayState) => void): () => void {
  stateListeners.add(fn);
  fn(playState);
  return () => stateListeners.delete(fn);
}

function setPlayState(s: PlayState) {
  playState = s;
  stateListeners.forEach((fn) => fn(s));
}

export function getPlayState(): PlayState {
  return playState;
}

/**
 * 离线渲染摩斯时序为 AudioBuffer。
 */
export async function renderToBuffer(
  timeline: TimedElement[],
  opts: {
    frequency: number;
    volume: number;
    waveform?: 'sine' | 'square' | 'triangle';
    sampleRate?: number;
  },
): Promise<AudioBuffer> {
  const c = getAudioContext();
  const sampleRate = opts.sampleRate ?? c.sampleRate;

  // 用离线上下文精确渲染
  const durationMs = timeline.reduce((a, e) => a + e.durationMs, 0);
  const frames = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate));
  const offline = new OfflineAudioContext(1, frames, sampleRate);

  // 用共享渲染器生成波形数据（比逐节点调度更精确、更快）
  const samples = renderTimeline(timeline, {
    sampleRate,
    frequency: opts.frequency,
    volume: opts.volume,
    waveform: opts.waveform ?? 'sine',
  });

  const buffer = offline.createBuffer(1, samples.length, sampleRate);
  // copyToChannel 需要 Float32Array<ArrayBuffer>，此处显式复制
  const copy = new Float32Array(samples.length);
  copy.set(samples);
  buffer.copyToChannel(copy, 0);
  return buffer;
}

/**
 * 播放一段摩斯音频。
 *
 * @returns 播放结束的 Promise
 */
export async function playTimeline(
  timeline: TimedElement[],
  opts: {
    frequency: number;
    volume: number;
    waveform?: 'sine' | 'square' | 'triangle';
    onProgress?: (ratio: number) => void;
  },
): Promise<void> {
  await resumeAudio();
  stopPlayback();

  const c = getAudioContext();
  const buffer = await renderToBuffer(timeline, opts);

  const src = c.createBufferSource();
  src.buffer = buffer;
  const gain = c.createGain();
  gain.gain.value = 1;
  src.connect(gain);
  gain.connect(c.destination);

  const startedAt = c.currentTime;
  const duration = buffer.duration;

  src.onended = () => {
    if (currentSource === src) currentSource = null;
    setPlayState('idle');
    opts.onProgress?.(1);
  };

  currentSource = src;
  setPlayState('playing');
  src.start();

  // 进度回调
  const tick = () => {
    if (currentSource !== src) return;
    const ratio = Math.min(1, (c.currentTime - startedAt) / duration);
    opts.onProgress?.(ratio);
    if (ratio < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return new Promise((resolve) => {
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      setPlayState('idle');
      opts.onProgress?.(1);
      resolve();
    };
  });
}

/** 停止播放 */
export function stopPlayback(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* 已停止 */
    }
    currentSource = null;
  }
  setPlayState('stopped');
}

/**
 * 把 AudioBuffer 编码为 WAV Blob。
 */
export function bufferToWavBlob(buffer: AudioBuffer): Blob {
  const ch0 = buffer.getChannelData(0);
  const wav = encodeWav(ch0, buffer.sampleRate);
  return new Blob([wav], { type: 'audio/wav' });
}

/**
 * 解析音频文件为单声道 Float32 采样。
 *
 * 使用 decodeAudioData，支持浏览器能解码的所有格式（wav/mp3/ogg/m4a/flac 等）。
 */
export async function decodeAudioFile(file: File | Blob): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}> {
  const arrayBuf = await file.arrayBuffer();
  const c = getAudioContext();

  // decodeAudioData 会 detach ArrayBuffer，故先复制
  const copy = arrayBuf.slice(0);
  const audioBuffer = await c.decodeAudioData(copy);

  // 混合到单声道
  const channels: Float32Array[] = [];
  for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }
  const len = audioBuffer.length;
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (const ch of channels) acc += ch[i] ?? 0;
    samples[i] = acc / channels.length;
  }

  return {
    samples,
    sampleRate: audioBuffer.sampleRate,
    durationMs: (len / audioBuffer.sampleRate) * 1000,
  };
}

/**
 * 采集麦克风诊断信息。
 *
 * 真机上「无法访问麦克风」的原因很多（权限/占用/ROM 限制/安全上下文），
 * 这个函数把关键状态一次性收集出来，便于定位。
 */
export async function diagnoseMicrophone(): Promise<MicrophoneDiagnostic> {
  const md = navigator.mediaDevices;
  const diag: MicrophoneDiagnostic = {
    platform:
      (window as unknown as { Capacitor?: { getPlatform?: () => string } })
        .Capacitor?.getPlatform?.() ?? 'web',
    hasMediaDevices: !!md,
    secureContext: window.isSecureContext,
    permissionState: 'unknown',
    inputDevices: [],
  };

  if (!md) return diag;

  try {
    const { checkMicrophonePermission } = await import('./permission-bridge');
    diag.permissionState = await checkMicrophonePermission();
  } catch {
    /* 忽略 */
  }

  try {
    const devices = await md.enumerateDevices.call(md);
    diag.inputDevices = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || '(未授权)' }));
  } catch (e) {
    diag.lastError = `enumerateDevices: ${(e as Error).message}`;
  }

  return diag;
}

/**
 * 实时录音（用于接收外部摩斯信号）。
 */
export class AudioRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;

  /** 开始录音 */
  async start(): Promise<void> {
    this.stream = await getMicrophoneStream();

    // 选择浏览器支持的 mime
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m));

    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(100);
  }

  /** 停止录音并返回音频 Blob */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('未在录音'));
        return;
      }
      this.recorder.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.recorder = null;
        resolve(new Blob(this.chunks, { type: 'audio/webm' }));
      };
      this.recorder.stop();
    });
  }

  /** 是否正在录音 */
  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }
}

/**
 * 实时监听麦克风（电键监听 / 电平表 / 实时解码）。
 *
 * 内部使用 AudioWorklet 保证音频块连续（ScriptProcessor 在 Android WebView
 * 上会丢块，导致摩斯信号被切断、解码乱码）。
 */
export { createCollector, supportsAudioWorklet, setWorkletUrl } from './audio-worklet-meter';
export type { AudioCollector } from './audio-worklet-meter';

/**
 * 播放电键音（用于手动发报练习）。
 */
export async function playTone(
  frequency: number,
  durationMs: number,
  volume = 0.9,
): Promise<void> {
  await resumeAudio();
  const c = getAudioContext();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  const t = c.currentTime;
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.005);
  gain.gain.setValueAtTime(volume, t + dur - 0.005);
  gain.gain.linearRampToValueAtTime(0, t + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur);
}

/**
 * 持续按键音（手键 / 电键练习）。
 *
 * 与 playTone 的区别：按下即开始持续发报，松开才停止 ——
 * 真实的摩斯电键行为。用于练习时，长按代表长划，短按代表点。
 */
export class KeyTone {
  private active = false;
  private frequency: number;
  private volume: number;

  /** 常驻振荡器（预建，按键时只改 gain，零延迟） */
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  /** 常驻振荡器是否已启动（音频管线就绪） */
  private ready = false;
  /** 初始化中（避免并发重复初始化） */
  private initPromise: Promise<void> | null = null;

  constructor(frequency = 600, volume = 0.9) {
    this.frequency = frequency;
    this.volume = volume;
  }

  /** 是否正在发报 */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * 预热音频管线。
   *
   * 实测（Android WebView）：首次 `new AudioContext()` 需 130~290ms，
   * 这段延迟若发生在「按下」瞬间，手感会非常迟钝。
   * 因此在页面加载后提前把 AudioContext 与常驻振荡器准备好，
   * 按键时就只剩改 gain 这一步（实测 0ms）。
   */
  async warmup(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const c = getAudioContext();
        await resumeAudio();

        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = this.frequency;
        // 初始静音，振荡器常驻运行
        gain.gain.value = 0;

        osc.connect(gain);
        gain.connect(c.destination);
        osc.start();

        this.osc = osc;
        this.gain = gain;
        this.ready = true;
      } catch (e) {
        console.warn('音频管线预热失败:', e);
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * 按下：开始持续发报（同步版本）。
   *
   * 音频管线已预热时完全同步，零延迟；
   * 未预热时退化为异步预热。
   *
   * @returns 是否已同步发声
   */
  pressNow(): boolean {
    if (this.active) return true;
    if (!this.ready) {
      // 未预热：异步走一遍，并立即返回 false
      void this.press().catch(() => undefined);
      return false;
    }

    const c = getAudioContext();
    const gain = this.gain;
    if (!gain) return false;

    const t = c.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(this.volume, t + 0.004);

    this.active = true;
    return true;
  }

  /**
   * 按下：开始持续发报。
   *
   * 若已预热则同步发声（0 延迟）；
   * 否则先 await 预热（首次会有一次不可避免的延迟）。
   */
  async press(): Promise<void> {
    if (this.active) return;

    if (!this.ready) {
      await this.warmup();
      if (!this.ready) return;
    }

    const c = getAudioContext();
    const gain = this.gain;
    if (!gain) return;

    // 极短的淡入，消除爆音（4ms）
    const t = c.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(this.volume, t + 0.004);

    this.active = true;
  }

  /**
   * 松开：停止发报。
   */
  release(): void {
    if (!this.active || !this.gain) return;

    const c = getAudioContext();
    const t = c.currentTime;
    // 极短的淡出，避免咔哒声
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(this.gain.gain.value, t);
      this.gain.gain.linearRampToValueAtTime(0, t + 0.006);
    } catch {
      /* 已停止 */
    }

    this.active = false;
  }

  /**
   * 释放常驻振荡器（页面卸载时）。
   */
  dispose(): void {
    try {
      this.osc?.stop();
    } catch {
      /* 已停止 */
    }
    this.osc = null;
    this.gain = null;
    this.ready = false;
    this.initPromise = null;
  }

  /** 修改频率（如跟随 UI 的音高滑块） */
  setFrequency(frequency: number): void {
    this.frequency = frequency;
    if (this.osc) {
      this.osc.frequency.value = frequency;
    }
  }

  /** 修改音量 */
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain && !this.active) {
      this.gain.gain.value = volume;
    }
  }
}
