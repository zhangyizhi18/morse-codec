import { describe, it, expect } from 'vitest';
import { RealtimeDecoder, getCodebook, encodeText, renderTimeline } from '../src/core';

/**
 * 真实麦克风场景下的实时解码测试。
 *
 * ## 为什么需要这组测试
 *
 * 原有的 realtime-run 测试用「合成音频 + 理想判决」，全部通过，
 * 但真机上「几乎无法解码」。根因是 worklet 的判决逻辑在真实信号下
 * 有三个致命问题，这组测试专门覆盖它们：
 *
 *  1. 开局在信号中间 → 用「窗口最小包络」当噪声底会得到 0.52，
 *     远高于真实静音 0.0002，导致永远触发不了
 *  2. peak 只升不降 → 一次突发噪声后永久失聪
 *  3. 绝对门限 0.02 → 手机离音箱稍远就什么都检测不到
 *
 * ## 模拟方式
 *
 * 用与 `public/morse-level-processor.js` **完全一致**的算法处理
 * 合成音频，包括：相位无关包络、非对称噪声跟踪、去抖边沿、
 * 噪声爆发抑制、停止时 flush。
 */

const SR = 48000;
const en = getCodebook('en')!;

const FULL_MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

/** 合成摩斯音频（不经过 encoder，避免引入编码端假设） */
function synth(text: string, wpm: number, amp: number, freq = 600) {
  const dot = 1200 / wpm;
  const dash = dot * 3;
  const seq: { on: boolean; ms: number }[] = [];
  const words = text.split(' ');

  words.forEach((w, wi) => {
    [...w].forEach((ch, ci) => {
      const code = FULL_MORSE[ch];
      if (!code) return;
      [...code].forEach((m, mi) => {
        seq.push({ on: true, ms: m === '.' ? dot : dash });
        if (mi < code.length - 1) seq.push({ on: false, ms: dot });
      });
      if (ci < w.length - 1) seq.push({ on: false, ms: dot * 3 });
    });
    if (wi < words.length - 1) seq.push({ on: false, ms: dot * 7 });
  });

  const totalMs = seq.reduce((a, s) => a + s.ms, 0);
  const n = Math.ceil((totalMs / 1000) * SR);
  const buf = new Float32Array(n);
  let pos = 0;
  for (const s of seq) {
    const len = Math.round((s.ms / 1000) * SR);
    if (s.on) {
      for (let i = 0; i < len && pos + i < n; i++) {
        buf[pos + i] = amp * Math.sin((2 * Math.PI * freq * (pos + i)) / SR);
      }
    }
    pos += len;
  }
  return buf;
}

function addNoise(buf: Float32Array, amp: number, seed = 1) {
  let s = seed;
  const o = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    o[i] = buf[i] + ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return o;
}

function addBurst(buf: Float32Array, atMs: number, durMs: number, amp: number) {
  const o = new Float32Array(buf);
  const start = Math.round((atMs / 1000) * SR);
  const len = Math.round((durMs / 1000) * SR);
  for (let i = 0; i < len && start + i < o.length; i++) {
    o[start + i] += amp * Math.sin((2 * Math.PI * 300 * i) / SR);
  }
  return o;
}

/**
 * 复刻 worklet 的判决算法，输出段序列。
 * 与 public/morse-level-processor.js 逐行对应。
 */
function workletRuns(buf: Float32Array, unitHint = 0) {
  const attackCoef = Math.exp(-1 / (SR * 0.0015));
  const releaseCoef = Math.exp(-1 / (SR * 0.0015));
  const noiseUpCoef = Math.exp(-1 / (SR * 0.35));
  const noiseDownCoef = Math.exp(-1 / (SR * 0.008));
  const peakDecayCoef = Math.exp(-1 / (SR * 1.2));
  const onPos = 0.45;
  const offPos = 0.22;
  const minConfirm = Math.round(SR * 0.003);
  const step = Math.max(1, Math.round(SR * 0.00133));

  let power = 0;
  let primed = false;
  let noise = 0;
  let peak = 0;
  let on = false;
  let runStart = 0;
  let total = 0;
  let cand = -1;
  let acc = 0;
  let longestMarkMs = 0;
  let emitOverload = false;
  // 单位时长的在线估计（与 worklet 一致）
  let unitHintMs = unitHint;

  const runs: { on: boolean; samples: number; noise?: boolean }[] = [];

  const emit = (isOn: boolean, samples: number) => {
    if (samples <= 0) return;
    const ms = (samples / SR) * 1000;
    if (isOn) {
      if (ms > 8 && (unitHintMs === 0 || ms < unitHintMs)) {
        if (unitHintMs === 0 || ms < unitHintMs * 1.5) unitHintMs = ms;
      }
      // 基准只在「划」量级（>=2u 且 <4.5u）更新，
      // 避免第一个点把基准定得过低，导致正常划被误判为噪声。
      if (!emitOverload) {
        if (unitHintMs > 0) {
          if (ms >= unitHintMs * 2 && ms < unitHintMs * 4.5) {
            longestMarkMs = Math.max(longestMarkMs, ms);
          }
        } else if (ms > longestMarkMs) {
          longestMarkMs = ms;
        }
      }
      if (emitOverload) {
        runs.push({ on: false, samples: 0, noise: true });
        emitOverload = false;
        return;
      }
    }
    runs.push({ on: isOn, samples });
  };

  const judge = (env: number) => {
    if (!primed) {
      noise = 0;
      peak = env;
      primed = true;
      runStart = total;
    }
    peak = Math.max(env, peak * peakDecayCoef);
    if (!on) {
      if (env < noise) noise = env + (noise - env) * noiseDownCoef;
      else noise = env + (noise - env) * noiseUpCoef;
    }
    if (peak < noise) peak = noise;

    const range = peak - noise;
    const usable = range > Math.max(noise * 0.75, 0.0015);
    const onThr = noise + range * onPos;
    const offThr = noise + range * offPos;

    if (on && longestMarkMs > 0) {
      const durMs = ((total - runStart) / SR) * 1000;
      if (durMs > longestMarkMs * 1.8) emitOverload = true;
    }

    if (!usable) {
      if (on) {
        emit(true, total - runStart);
        on = false;
        runStart = total;
      }
      cand = -1;
      return;
    }

    if (!on) {
      if (env > onThr) {
        if (cand < 0) cand = total;
        if (total - cand >= minConfirm) {
          emit(false, cand - runStart);
          on = true;
          runStart = cand;
          cand = -1;
        }
      } else cand = -1;
    } else {
      if (env < offThr) {
        if (cand < 0) cand = total;
        if (total - cand >= minConfirm) {
          emit(true, cand - runStart);
          on = false;
          runStart = cand;
          cand = -1;
        }
      } else cand = -1;
    }
  };

  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const p = v * v;
    const c = p > power ? attackCoef : releaseCoef;
    power = p + (power - p) * c;
    acc++;
    if (acc >= step) {
      total += acc;
      acc = 0;
      judge(Math.sqrt(power));
    }
  }

  // 主线程停止时发送 flush，把未完成的段发出来
  if (runStart < total) emit(on, total - runStart);

  return runs;
}

/** 用真实 worklet 段跑应用解码器 */
function decode(text: string, opts: { wpm?: number; amp?: number; noise?: number; burst?: [number, number, number] } = {}) {
  const wpm = opts.wpm ?? 18;
  let buf = synth(text, wpm, opts.amp ?? 0.9);
  if (opts.noise) buf = addNoise(buf, opts.noise);
  if (opts.burst) buf = addBurst(buf, opts.burst[0], opts.burst[1], opts.burst[2]);

  const runs = workletRuns(buf, 1200 / wpm);
  const dec = new RealtimeDecoder(en);
  for (const r of runs) {
    if (r.noise) dec.rejectNoise();
    else dec.pushRun(r.on, r.samples, SR);
  }
  return dec.flushRun();
}

describe('真实麦克风场景', () => {
  it('理想信号', () => {
    const st = decode('CQ CQ DE MORSE');
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('小音量（0.05）', () => {
    const st = decode('CQ CQ DE MORSE', { amp: 0.05 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('极小音量（0.012）—— 手机离音箱较远', () => {
    const st = decode('CQ CQ DE MORSE', { amp: 0.012 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('背景噪声 0.02', () => {
    const st = decode('CQ CQ DE MORSE', { amp: 0.3, noise: 0.02 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('背景噪声 0.05', () => {
    const st = decode('CQ CQ DE MORSE', { amp: 0.3, noise: 0.05 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('开局就在信号中间（不能假设起始是静音）', () => {
    // 音频直接从划开始，没有前置静音 —— 这是点「开始监听」时
    // 对方已经在发报的常见情况。早期版本会因此完全失聪。
    const st = decode('CQ CQ DE MORSE', { amp: 0.5 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('12 WPM 慢速', () => {
    const st = decode('CQ CQ DE MORSE', { wpm: 12, amp: 0.3, noise: 0.01 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('25 WPM 快速', () => {
    const st = decode('CQ CQ DE MORSE', { wpm: 25, amp: 0.3, noise: 0.01 });
    expect(st.text.trim()).toBe('CQ CQ DE MORSE');
  });

  it('突发噪声后不产生乱码字符', () => {
    // 300ms 的强噪声会毁掉那一段，但不应输出错误字符 ——
    // 宁可少字符，也不要乱码。
    const st = decode('CQ CQ DE MORSE', {
      amp: 0.3,
      noise: 0.01,
      burst: [1200, 300, 0.9],
    });
    expect(st.text).toMatch(/^[A-Z ]*$/);
    expect(st.text.replace(/\s/g, '').length).toBeGreaterThanOrEqual(2);
  });

  it('大音量 + 突发噪声后仍能继续解码', () => {
    const st = decode('CQ CQ DE MORSE', {
      amp: 0.9,
      noise: 0.02,
      burst: [1500, 400, 0.95],
    });
    expect(st.text).toMatch(/^[A-Z ]*$/);
    // 噪声之后的 MORSE 应能还原
    expect(st.text).toContain('MORSE');
  });

  it('数字', () => {
    // 单位校准需要 8 个以上时长样本，因此用稍长的数字串。
    // 纯 5 位数字（25 个符号）在慢速下仍偏短，属已知限制。
    const st = decode('12345678', { amp: 0.3, noise: 0.01 });
    expect(st.text.trim()).toBe('12345678');
  });

  it('长文本', () => {
    const st = decode('THE QUICK BROWN FOX', { amp: 0.3, noise: 0.01 });
    expect(st.text.trim()).toBe('THE QUICK BROWN FOX');
  });
});
