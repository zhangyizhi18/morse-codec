import { describe, it, expect } from 'vitest';
import {
  encodeText,
  decodeAudio,
  renderTimeline,
  getCodebook,
  buildUnits,
  RealtimeDecoder,
  MORSE_MIXED,
  validateCodebook,
  type EncodeOptions,
  type Codebook,
} from '../src/core';

const mixed = getCodebook('mixed-zh-en')!;
const baseOpts: EncodeOptions = { wpm: 18, frequency: 600, volume: 0.9 };

/** 编码 -> 渲染 -> 离线解码 */
function roundTrip(
  text: string,
  book: Codebook = mixed,
  opts: EncodeOptions = baseOpts,
) {
  const enc = encodeText(text, book, opts);
  const samples = renderTimeline(enc.timeline, {
    sampleRate: 8000,
    frequency: opts.frequency,
    volume: opts.volume,
  });
  const dec = decodeAudio(samples, 8000, book);
  return { enc, dec };
}

/**
 * 模拟 AudioWorklet 段式输出，喂给实时解码器。
 *
 * 用 1ms 窗的 RMS + 迟滞判决，与真实采集链路一致。
 */
function realtimeDecode(
  text: string,
  book: Codebook = mixed,
  opts: EncodeOptions = baseOpts,
  sampleRate = 48000,
) {
  const enc = encodeText(text, book, opts);
  const samples = renderTimeline(enc.timeline, {
    sampleRate,
    frequency: opts.frequency,
    volume: opts.volume,
  });

  const win = Math.max(1, Math.round(sampleRate * 0.001));
  const runs: { on: boolean; samples: number }[] = [];
  let peak = 0.05;
  let noiseFloor = 0.005;
  let signalOn = false;
  let runSamples = 0;

  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(i + win, samples.length);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (end - i));
    runSamples += end - i;

    if (rms > peak) peak = rms;
    noiseFloor = noiseFloor * 0.999 + rms * 0.001;
    const thr = Math.max(
      0.02,
      Math.min(0.6, Math.max(noiseFloor * 2.5, peak * 0.35)),
    );

    if (!signalOn && rms > thr) {
      signalOn = true;
      if (runSamples > 0) runs.push({ on: false, samples: runSamples });
      runSamples = 0;
    } else if (signalOn && rms < thr * 0.6) {
      signalOn = false;
      if (runSamples > 0) runs.push({ on: true, samples: runSamples });
      runSamples = 0;
    }
  }
  if (runSamples > 0) runs.push({ on: signalOn, samples: runSamples });

  const dec = new RealtimeDecoder(book);
  for (const r of runs) dec.pushRun(r.on, r.samples, sampleRate);
  return dec.flushRun();
}

describe('中英混合码表 - 数据完整性', () => {
  it('码表通过校验', () => {
    expect(validateCodebook(MORSE_MIXED)).toEqual([]);
  });

  it('同时收录拉丁字母与汉字', () => {
    expect(MORSE_MIXED.entries['A']).toBe('.-');
    expect(MORSE_MIXED.entries['中']).toBe('0022');
    expect(MORSE_MIXED.entries['国']).toBe('0948');
  });

  it('拉丁条目数量与原表一致', () => {
    const en = getCodebook('en')!;
    const latinCount = Object.keys(en.entries).length;
    for (const ch of Object.keys(en.entries)) {
      expect(MORSE_MIXED.entries[ch], `缺少 ${ch}`).toBe(en.entries[ch]);
    }
    expect(latinCount).toBe(62);
  });

  it('汉字条目数量与原表一致', () => {
    const cn = getCodebook('zh-CN')!;
    for (const [ch, code] of Object.entries(cn.entries)) {
      expect(MORSE_MIXED.entries[ch], `缺少 ${ch}`).toBe(code);
    }
  });

  it('两表无字符冲突', () => {
    const en = getCodebook('en')!;
    const cn = getCodebook('zh-CN')!;
    const both = Object.keys(en.entries).filter((c) => c in cn.entries);
    expect(both).toEqual([]);
  });
});

describe('中英混合 - 编码', () => {
  it('汉字编成 4 位数字，字母编成点划', () => {
    const { units } = buildUnits('中A', mixed);
    // 中 = 0022 -> 数字 0,0,2,2；A = ".-"
    // 数字码：0=----- 1=.---- 2=..--- 3=...-- ...
    expect(units.length).toBe(5);
    expect(units[0].morse).toBe('-----'); // 0
    expect(units[1].morse).toBe('-----'); // 0
    expect(units[2].morse).toBe('..---'); // 2
    expect(units[3].morse).toBe('..---'); // 2
    expect(units[4].morse).toBe('.-'); // A
  });

  it('中文码组之后是 group 间隔，字母之后是 char 间隔', () => {
    const { units } = buildUnits('中A', mixed);
    // 前 3 位数字后跟 char（组内）
    expect(units[0].sepAfter).toBe('char');
    expect(units[1].sepAfter).toBe('char');
    expect(units[2].sepAfter).toBe('char');
    // 第 4 位之后是 group（标记中文码组结束）
    expect(units[3].sepAfter).toBe('group');
    // 字母 A 是最后一个单元
    expect(units[4].sepAfter).toBeUndefined();
  });

  it('纯英文的间隔结构与原表一致', () => {
    const mixedUnits = buildUnits('SOS', mixed).units;
    const enUnits = buildUnits('SOS', getCodebook('en')!).units;
    expect(mixedUnits).toEqual(enUnits);
  });

  it('纯中文的间隔结构与中文表一致', () => {
    const mixedUnits = buildUnits('中国', mixed).units;
    const cnUnits = buildUnits('中国', getCodebook('zh-CN')!).units;
    expect(mixedUnits).toEqual(cnUnits);
  });
});

describe('中英混合 - 离线解码往返', () => {
  it('纯英文', () => {
    const { dec } = roundTrip('SOS');
    expect(dec.text.trim()).toBe('SOS');
  });

  it('纯中文', () => {
    const { dec } = roundTrip('中国');
    expect(dec.text.trim()).toBe('中国');
  });

  it('中文 + 英文混排', () => {
    const { dec } = roundTrip('中A');
    expect(dec.text.trim()).toBe('中A');
  });

  it('英文 + 中文混排', () => {
    const { dec } = roundTrip('CQ中国');
    expect(dec.text.trim()).toBe('CQ中国');
  });

  it('多词中英混排', () => {
    const { dec } = roundTrip('HELLO 世界');
    expect(dec.text.trim()).toBe('HELLO 世界');
  });

  it('通联风格混排', () => {
    const { dec } = roundTrip('CQ DE 张三');
    expect(dec.text.trim()).toBe('CQ DE 张三');
  });
});

describe('中英混合 - 实时解码往返', () => {
  it('纯英文', () => {
    expect(realtimeDecode('SOS').text.trim()).toBe('SOS');
  });

  it('纯中文', () => {
    expect(realtimeDecode('中国').text.trim()).toBe('中国');
  });

  it('中文 + 英文混排', () => {
    expect(realtimeDecode('中A').text.trim()).toBe('中A');
  });

  it('英文 + 中文混排', () => {
    expect(realtimeDecode('CQ中国').text.trim()).toBe('CQ中国');
  });

  it('通联风格混排', () => {
    expect(realtimeDecode('CQ DE 张三').text.trim()).toBe('CQ DE 张三');
  });
});
