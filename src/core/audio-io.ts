import type { TimedElement } from './types';

/** 音频渲染参数 */
export interface RenderOptions {
  sampleRate: number;
  frequency: number;
  volume: number;
  /** 波形类型 */
  waveform?: 'sine' | 'square' | 'triangle';
  /** 淡入淡出（ms），避免爆音 */
  fadeMs?: number;
}

/**
 * 将摩斯时序渲染为 PCM 采样。
 *
 * 使用方波/正弦波 + 矩形包络，每段信号首尾做淡入淡出防止爆音。
 */
export function renderTimeline(
  timeline: TimedElement[],
  options: RenderOptions,
): Float32Array {
  const sr = options.sampleRate;
  const fadeMs = options.fadeMs ?? 5;
  const fadeSamples = Math.max(1, Math.round((sr * fadeMs) / 1000));

  const total = Math.ceil(
    timeline.reduce((a, e) => a + e.durationMs, 0) / 1000 * sr,
  );
  const out = new Float32Array(total);

  let pos = 0;
  for (const el of timeline) {
    const n = Math.max(0, Math.round((el.durationMs / 1000) * sr));

    if (el.kind !== 'gap' && n > 0) {
      const end = Math.min(pos + n, out.length);
      const len = end - pos;
      const phase = (2 * Math.PI * options.frequency) / sr;

      for (let i = 0; i < len; i++) {
        const t = pos + i;
        let s: number;
        switch (options.waveform ?? 'sine') {
          case 'square':
            s = Math.sin(phase * t) >= 0 ? 1 : -1;
            break;
          case 'triangle':
            s = (2 / Math.PI) * Math.asin(Math.sin(phase * t));
            break;
          default:
            s = Math.sin(phase * t);
        }
        // 淡入淡出
        let env = 1;
        if (i < fadeSamples) env = i / fadeSamples;
        else if (len - i <= fadeSamples) env = Math.max(0, (len - i) / fadeSamples);
        out[t] = s * env * options.volume;
      }
    }
    pos += n;
  }

  return out;
}

/**
 * 将 Float32 采样编码为 WAV（PCM 16-bit 单声道）。
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/**
 * 从 WAV 文件解析出单声道 Float32 采样。
 *
 * 支持 PCM 8/16/24/32-bit。32-bit float 格式（format code 3）也支持。
 */
export function decodeWav(buffer: ArrayBuffer): {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
} {
  const view = new DataView(buffer);
  const readStr = (off: number, len: number) =>
    String.fromCharCode(
      ...Array.from({ length: len }, (_, i) => view.getUint8(off + i)),
    );

  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }

  let pos = 12;
  let fmt: {
    format: number;
    channels: number;
    sampleRate: number;
    bits: number;
  } | null = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= view.byteLength) {
    const id = readStr(pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;

    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }

  if (!fmt) throw new Error('WAV 缺少 fmt 块');
  if (dataOffset < 0) throw new Error('WAV 缺少 data 块');

  const { channels, sampleRate, bits, format } = fmt;
  const bytesPerSample = bits / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));

  // 多声道取平均
  const out = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataOffset + (i * channels + c) * bytesPerSample;
      let v = 0;
      if (format === 3 && bits === 32) {
        v = view.getFloat32(off, true);
      } else if (bits === 8) {
        v = (view.getUint8(off) - 128) / 128;
      } else if (bits === 16) {
        v = view.getInt16(off, true) / 32768;
      } else if (bits === 24) {
        const b0 = view.getUint8(off);
        const b1 = view.getUint8(off + 1);
        const b2 = view.getInt8(off + 2);
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      } else if (bits === 32) {
        v = view.getInt32(off, true) / 2147483648;
      }
      acc += v;
    }
    out[i] = acc / channels;
  }

  return {
    samples: out,
    sampleRate,
    durationMs: (frameCount / sampleRate) * 1000,
  };
}

/**
 * 线性重采样（用于统一到目标采样率）。
 */
export function resample(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * 混合到单声道。
 */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (const ch of channels) acc += ch[i] ?? 0;
    out[i] = acc / channels.length;
  }
  return out;
}
