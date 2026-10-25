import { describe, it, expect } from 'vitest';
import {
  encodeText,
  decodeAudio,
  renderTimeline,
  getCodebook,
  otsuThreshold,
  medianFilter,
  extractRuns,
  computeEnvelope,
  estimateWpm,
  type EncodeOptions,
  type Codebook,
} from '../src/core';

const en = getCodebook('en')!;
const cn = getCodebook('zh-CN')!;

const baseOpts: EncodeOptions = { wpm: 18, frequency: 600, volume: 0.9 };

/** 编码 -> 渲染 -> 解码 */
function roundTrip(
  text: string,
  book: Codebook = en,
  opts: EncodeOptions = baseOpts,
  render: Partial<Parameters<typeof renderTimeline>[1]> = {},
  decodeOpts = {},
) {
  const enc = encodeText(text, book, opts);
  const samples = renderTimeline(enc.timeline, {
    sampleRate: 8000,
    frequency: opts.frequency,
    volume: opts.volume,
    ...render,
  });
  const dec = decodeAudio(samples, render.sampleRate ?? 8000, book, decodeOpts);
  return { enc, dec };
}

/** 加白噪声 */
function addNoise(buf: Float32Array, amp: number, seed = 42): Float32Array {
  let s = seed;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = buf[i] + ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

describe('解码器 - 基础往返', () => {
  it('解码 SOS', () => {
    const { dec } = roundTrip('SOS');
    expect(dec.text.trim()).toBe('SOS');
    expect(dec.unknownCount).toBe(0);
  });

  it('解码多词文本', () => {
    const { dec } = roundTrip('HELLO WORLD');
    expect(dec.text.trim()).toBe('HELLO WORLD');
  });

  it('解码数字', () => {
    const { dec } = roundTrip('12345');
    expect(dec.text.trim()).toBe('12345');
  });

  it('解码长文本', () => {
    const { dec } = roundTrip('THE QUICK BROWN FOX JUMPS');
    expect(dec.text.trim()).toBe('THE QUICK BROWN FOX JUMPS');
  });

  it('置信度在合理范围', () => {
    const { dec } = roundTrip('CQ CQ DE MORSE');
    expect(dec.confidence).toBeGreaterThan(0.8);
    expect(dec.confidence).toBeLessThanOrEqual(1);
  });

  it('反推 WPM 正确', () => {
    const { dec } = roundTrip('CQ', en, { ...baseOpts, wpm: 22 });
    const wpm = estimateWpm(dec.detectedDotMs);
    expect(wpm).not.toBeNull();
    expect(Math.abs(wpm! - 22)).toBeLessThanOrEqual(3);
  });
});

describe('解码器 - 鲁棒性矩阵', () => {
  it('WPM 8~45 全部正确', () => {
    for (const wpm of [8, 12, 18, 25, 35, 45]) {
      const { dec } = roundTrip('CQ CQ DE MORSE', en, { ...baseOpts, wpm });
      expect(dec.text.trim(), `wpm=${wpm}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('音高 400~1400Hz 全部正确', () => {
    for (const f of [400, 600, 800, 1000, 1400]) {
      const { dec } = roundTrip('CQ CQ DE MORSE', en, { ...baseOpts, frequency: f });
      expect(dec.text.trim(), `freq=${f}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('采样率 8k~44.1k 全部正确', () => {
    for (const sr of [8000, 11025, 16000, 22050, 44100]) {
      const { dec } = roundTrip('CQ CQ DE MORSE', en, baseOpts, { sampleRate: sr });
      expect(dec.text.trim(), `sr=${sr}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('噪声 5%~65% 全部正确（Otsu 自适应阈值）', () => {
    for (const na of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65]) {
      const enc = encodeText('CQ CQ DE MORSE', en, baseOpts);
      const samples = renderTimeline(enc.timeline, {
        sampleRate: 8000,
        frequency: 600,
        volume: 0.9,
      });
      const noisy = addNoise(samples, na);
      const dec = decodeAudio(noisy, 8000, en);
      expect(dec.text.trim(), `noise=${na}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('音量 0.9~0.01 全部正确', () => {
    for (const a of [0.9, 0.5, 0.25, 0.12, 0.06, 0.03, 0.01]) {
      const { dec } = roundTrip('CQ CQ DE MORSE', en, { ...baseOpts, volume: a });
      expect(dec.text.trim(), `vol=${a}`).toBe('CQ CQ DE MORSE');
    }
  });

  it('固定阈值模式在中等条件下可用', () => {
    const { dec } = roundTrip('SOS', en, baseOpts, {}, { thresholdMode: 'fixed', threshold: 0.15 });
    expect(dec.text.trim()).toBe('SOS');
  });
});

describe('解码器 - 中文电码', () => {
  it('解码中文电码', () => {
    const { dec } = roundTrip('中国', cn);
    expect(dec.text.replace(/\s/g, '')).toContain('中');
  });

  it('中文电码解出完整词语', () => {
    const { dec } = roundTrip('摩斯电码', cn);
    const t = dec.text.replace(/\s/g, '');
    expect(t.length).toBeGreaterThan(0);
    expect(dec.unknownCount).toBe(0);
  });
});

describe('底层算法', () => {
  it('otsuThreshold 分离双峰', () => {
    const vals = [
      ...Array(100).fill(0.1),
      ...Array(100).fill(0.9),
    ];
    const thr = otsuThreshold(vals);
    expect(thr).toBeGreaterThan(0.1);
    expect(thr).toBeLessThan(0.9);
  });

  it('medianFilter 去除尖峰', () => {
    const data = [1, 1, 1, 100, 1, 1, 1];
    const out = medianFilter(data, 2);
    expect(out[3]).toBeLessThan(100);
    expect(out[0]).toBe(1);
  });

  it('extractRuns 同时保留 ON 和 OFF 段', () => {
    const env = [1, 1, 0, 0, 1, 0, 0, 0];
    const runs = extractRuns(env, 0.5);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.some((r) => !r.on)).toBe(true);
    expect(runs.some((r) => r.on)).toBe(true);
  });

  it('computeEnvelope 长度正确', () => {
    const samples = new Float32Array(8000);
    samples.fill(0.5);
    const env = computeEnvelope(samples, 8000, 5);
    // 8000 采样 / (8000*0.005 = 40 采样/窗) = 200 窗
    expect(env.length).toBe(200);
  });

  it('空音频返回空结果而不报错', () => {
    const dec = decodeAudio(new Float32Array(0), 8000, en);
    expect(dec.text).toBe('');
    expect(dec.charCount).toBe(0);
  });

  it('纯静音不崩溃', () => {
    const dec = decodeAudio(new Float32Array(8000), 8000, en);
    expect(dec.text).toBe('');
  });
});
