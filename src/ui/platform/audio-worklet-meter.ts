/**
 * 基于 AudioWorklet 的麦克风采集。
 *
 * ## 为什么必须用 AudioWorklet
 *
 * 实测（Android WebView）：ScriptProcessor 的回调块**不连续** ——
 * 1.2 秒音频只收到 51200/57600 样本（丢失约 7 块），
 * 且块边界存在明显跳变。丢失的音频会切断连续的摩斯信号，
 * 导致点划边界误判、解码结果乱码。
 *
 * ## 关键设计：判决在 worklet 内完成
 *
 * AudioWorklet 的消息队列也会丢消息（实测 375 次/秒时丢 12.7%，
 * 降到 11.7 次/秒仍丢 3.3%）。
 * 若主线程按「块累加帧数」还原信号时长，丢失的数据会让块边界
 * 与真实音频错位 —— 实测 67ms 的点被算成 172ms，点划判定全错。
 *
 * 因此 worklet 内部就完成 RMS 包络与迟滞判决，
 * 只把「已完成的段」（含采样点数）发给主线程。
 * 即使丢消息，也只是少了整段，不会让后续段长度错位。
 */
import { getMicrophoneStream } from './microphone';

/** 采集到的一个段 */
export interface AudioRun {
  /** true = 信号段，false = 静音段 */
  on: boolean;
  /** 采样点数 */
  samples: number;
}

/** 采集器接口 */
export interface AudioCollector {
  start(
    onRun: (run: AudioRun, sampleRate: number) => void,
    onLevel?: (level: number) => void,
  ): Promise<void>;
  stop(): void;
}

/** AudioWorklet 处理器脚本的 URL（由 Vite 打包时注入） */
let workletUrl: string | null = null;

/**
 * 设置 worklet 模块 URL。
 *
 * 传入相对路径时会基于页面地址解析为绝对地址 ——
 * `audioWorklet.addModule()` 要求同源绝对 URL。
 */
export function setWorkletUrl(url: string): void {
  try {
    workletUrl = new URL(url, window.location.href).href;
  } catch {
    workletUrl = url;
  }
}

/** 加载 worklet 模块（幂等） */
let workletLoadPromise: Promise<void> | null = null;

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (!workletUrl) {
    throw new Error('worklet URL 未设置');
  }
  if (!workletLoadPromise) {
    workletLoadPromise = ctx.audioWorklet
      .addModule(workletUrl)
      .catch((e) => {
        workletLoadPromise = null;
        throw e;
      });
  }
  return workletLoadPromise;
}

/**
 * AudioWorklet 采集器（推荐）。
 */
class WorkletCollector implements AudioCollector {
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private sink: GainNode | null = null;
  private level = 0;

  async start(
    onRun: (run: AudioRun, sampleRate: number) => void,
    onLevel?: (level: number) => void,
  ): Promise<void> {
    this.stream = await getMicrophoneStream();
    const ctx = getCtx();
    await ensureWorklet(ctx);

    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'morse-level-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.node.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;

      if (msg.type === 'run') {
        onRun(
          { on: msg.on as boolean, samples: msg.samples as number },
          ctx.sampleRate,
        );
      } else if (msg.type === 'level' && onLevel) {
        onLevel(msg.rms as number);
      }
    };

    // 连接到 destination 才会被处理（用静音增益避免自己听到）
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;

    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  stop(): void {
    if (this.node?.port) this.node.port.onmessage = null;
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* 已断开 */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
  }
}

/**
 * ScriptProcessor 降级采集器。
 *
 * 注意：Android WebView 上此路径会丢块，且段长需靠主线程推算，
 * 解码精度明显下降。仅在 AudioWorklet 不可用时使用。
 */
class ScriptProcessorCollector implements AudioCollector {
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private sink: GainNode | null = null;
  private signalOn = false;
  private runSamples = 0;
  private peak = 0.05;
  private noiseFloor = 0.005;

  async start(
    onRun: (run: AudioRun, sampleRate: number) => void,
    onLevel?: (level: number) => void,
  ): Promise<void> {
    this.stream = await getMicrophoneStream();
    const ctx = getCtx();

    this.processor = ctx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);

      // 主线程做判决（降级路径，精度有限）
      const win = Math.max(1, Math.round(ctx.sampleRate * 0.002));
      for (let i = 0; i < input.length; i++) {
        const v = input[i];
        output[i] = v;
        this.runSamples++;

        if ((i + 1) % win === 0) {
          let sum = 0;
          for (let j = i - win + 1; j <= i; j++) sum += input[j] * input[j];
          const rms = Math.sqrt(sum / win);
          if (rms > this.peak) this.peak = rms;
          this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
          const thr = Math.max(
            0.02,
            Math.min(
              0.6,
              Math.max(this.noiseFloor * 2.5, this.peak * 0.35),
            ),
          );
          if (onLevel) onLevel(rms);

          if (!this.signalOn && rms > thr) {
            this.signalOn = true;
            if (this.runSamples > 0)
              onRun({ on: false, samples: this.runSamples }, ctx.sampleRate);
            this.runSamples = 0;
          } else if (this.signalOn && rms < thr * 0.6) {
            this.signalOn = false;
            if (this.runSamples > 0)
              onRun({ on: true, samples: this.runSamples }, ctx.sampleRate);
            this.runSamples = 0;
          }
        }
      }
    };

    this.source = ctx.createMediaStreamSource(this.stream);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  stop(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
  }
}

/** 取得 AudioContext（延迟创建） */
let ctxRef: AudioContext | null = null;
function getCtx(): AudioContext {
  if (!ctxRef) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    try {
      ctxRef = new Ctor({ latencyHint: 'interactive' });
    } catch {
      ctxRef = new Ctor();
    }
  }
  return ctxRef;
}

/**
 * 是否支持 AudioWorklet。
 *
 * 注意：不能写 `AudioContext.prototype.audioWorklet` ——
 * `audioWorklet` 是 getter，在 prototype 上访问时 this 不是实例，
 * 会抛 "TypeError: Illegal invocation"（WebIDL 规范要求正确的接收者）。
 * 必须用实例访问，或直接检查 AudioWorkletNode 构造器是否存在。
 */
export function supportsAudioWorklet(): boolean {
  if (typeof AudioWorkletNode === 'undefined') return false;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return false;
    // 用实例检查（getter 需要正确的接收者）
    const ctx = getCtx();
    return !!ctx.audioWorklet;
  } catch {
    return false;
  }
}

/**
 * 创建最佳可用的采集器。
 *
 * 优先 AudioWorklet（判决在音频线程，段长精确）；
 * 不可用时回退 ScriptProcessor（可能丢块，精度下降）。
 */
export async function createCollector(): Promise<{
  collector: AudioCollector;
  continuous: boolean;
}> {
  if (supportsAudioWorklet()) {
    try {
      const c = new WorkletCollector();
      // 试加载一次，确保可用
      const ctx = getCtx();
      await ensureWorklet(ctx);
      return { collector: c, continuous: true };
    } catch (e) {
      console.warn('AudioWorklet 不可用，回退 ScriptProcessor:', e);
    }
  }
  return { collector: new ScriptProcessorCollector(), continuous: false };
}
