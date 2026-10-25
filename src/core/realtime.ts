/**
 * 实时摩斯解码器（边沿检测 + 增量解析）。
 *
 * 适用于麦克风实时输入：不断喂入电平样本，累积点/划与间隔，
 * 按 ITU 时序规则（点=1u, 划=3u, 码内=1u, 字符=3u, 词=7u）实时出字。
 *
 * 与离线解码的核心差别：
 *  - 离线：先拿到完整音频，再统一做阈值/游程/查表
 *  - 实时：逐个边沿处理，边收边出字
 *
 * ## 单位（unit）估计的关键
 *
 * 摩斯时序中所有时长都是单位的整数倍：
 *   点 = 1u, 划 = 3u, 码内间隔 = 1u, 字符间隔 = 3u, 词间隔 = 7u
 *
 * 因此「单位」可以直接从所有时长（信号段 + 间隔段）的低分位数估计：
 * 码内间隔恒为 1u，在任何时刻都存在大量 1u 样本，
 * 所以取 20 分位数比任何单点估计都稳健得多。
 *
 * 这解决了「初始 dot 时长猜错导致点划误判」的经典问题
 * （例如 10 WPM 时 dot=120ms，若初值按 18 WPM 取 60ms，点会被误判为划）。
 */
import type { Codebook } from './types';
import { gapsOf } from './encoder';

export interface RealtimeOptions {
  /** 自适应阈值下限 */
  minThreshold?: number;
  /** 自适应阈值上限 */
  maxThreshold?: number;
  /** 判定「有信号」的电平比例（相对峰值） */
  onRatio?: number;
  /** 判定「无信号」的释放比例（滞后，避免抖动） */
  offRatio?: number;
  /** 空闲多久后重置单位估计（ms） */
  resetIdleMs?: number;
  /** 单位初始估计（ms），仅在样本不足时兜底 */
  initialUnitMs?: number;
}

/** 实时解码状态 */
export interface RealtimeState {
  /** 已解码文本 */
  text: string;
  /** 当前累积的码字（点划串） */
  pending: string;
  /** 最近测得的单位时长（ms） */
  unitMs: number;
  /** 是否已锁定（单位估计可信） */
  locked: boolean;
  /** 置信度 0~1 */
  confidence: number;
  /** 收到的符号数 */
  symbolCount: number;
  /** 未识别数 */
  unknownCount: number;
}

/**
 * 单位（1u）的绝对下限（毫秒）。
 *
 * 真实 1u 至少 15ms（60 WPM 的点为 33ms）。
 * 小于该值的段是采集链路的伪影（如块边界处丢样本产生的 1~5ms 短段），
 * 必须在单位估计中排除。
 */
const MIN_UNIT_MS = 15;

/** 数字的摩斯码（用于中文电码等数字体系） */
const MORSE_DIGIT_CODES: Record<string, string> = {
  '-----': '0',
  '.----': '1',
  '..---': '2',
  '...--': '3',
  '....-': '4',
  '.....': '5',
  '-....': '6',
  '--...': '7',
  '---..': '8',
  '----.': '9',
};

/**
 * 实时摩斯解码器（可复用实例）。
 */
export class RealtimeDecoder {
  private book: Codebook;
  private opts: Required<RealtimeOptions>;

  // 电平跟踪
  private peak = 0.1;
  private noiseFloor = 0.005;

  // 边沿状态
  private signalOn = false;
  private lastEdgeAt = 0;
  private markStart = 0;
  /** 最近一次收到样本的时刻 */
  private lastSampleAt = 0;

  // 码字累积
  private pending = '';

  // 时长样本（信号段 + 间隔段），用于估计单位
  private timings: number[] = [];
  private unitMs: number;


  // 输出
  private outText = '';
  private symbolCount = 0;
  private unknownCount = 0;

  // 数字电码缓冲
  private digitBuffer = '';

  constructor(book: Codebook, options: RealtimeOptions = {}) {
    this.book = book;
    this.opts = {
      minThreshold: options.minThreshold ?? 0.06,
      maxThreshold: options.maxThreshold ?? 0.5,
      onRatio: options.onRatio ?? 0.35,
      offRatio: options.offRatio ?? 0.6,
      resetIdleMs: options.resetIdleMs ?? 4000,
      initialUnitMs: options.initialUnitMs ?? 60,
    };
    this.unitMs = this.opts.initialUnitMs;
  }

  /** 更换码表 */
  setCodebook(book: Codebook): void {
    this.book = book;
  }

  /** 清空输出 */
  reset(): void {
    this.outText = '';
    this.pending = '';
    this.symbolCount = 0;
    this.unknownCount = 0;
    this.timings = [];
    this.unitMs = this.opts.initialUnitMs;
    this.peak = 0.1;
    this.noiseFloor = 0.005;
    this.digitBuffer = '';
    this.runQueue = [];
    this.unitLocked = false;
  }

  /** 当前状态快照 */
  getState(): RealtimeState {
    return {
      text: this.outText,
      pending: this.pending,
      unitMs: this.unitMs,
      locked: this.timings.length >= 4,
      confidence: this.computeConfidence(),
      symbolCount: this.symbolCount,
      unknownCount: this.unknownCount,
    };
  }

  /**
   * 喂入一段音频采样（推荐方式）。
   *
   * 与 push(level, now) 的本质区别：这里处理的是**真实音频波形**，
   * 边沿检测在采样级精度上进行（每个采样点都参与判定），
   * 而非依赖定时器/轮询的时间戳。因此能准确还原点划边界。
   *
   * 实现：先做 RMS 包络（细窗），再在包络上做迟滞判决找边沿，
   * 每个块的时长用采样数精确换算。
   *
   * @param samples Float32 单声道采样
   * @param sampleRate 采样率
   */
  pushBlock(samples: Float32Array, sampleRate: number): RealtimeState {
    if (samples.length === 0) return this.getState();

    // 1) 细粒度 RMS 包络（窗长取 2ms，保证能分辨 67ms 的点）
    const win = Math.max(1, Math.round((sampleRate * 0.002) / 1));
    const env: number[] = [];
    for (let i = 0; i < samples.length; i += win) {
      const end = Math.min(i + win, samples.length);
      let sum = 0;
      for (let j = i; j < end; j++) {
        const v = samples[j];
        sum += v * v;
      }
      env.push(Math.sqrt(sum / (end - i)));
    }
    const frameMs = (win / sampleRate) * 1000;

    // 2) 逐帧做迟滞判决，产出 (on, 持续帧数) 游程
    const thr = this.blockThreshold(env);

    let on = this.blockSignalOn;
    let runLen = this.blockRunFrames; // 跨块延续的段长
    const runs: { on: boolean; frames: number }[] = [];

    for (let i = 0; i < env.length; i++) {
      const v = env[i];
      if (on) {
        if (v < thr * this.opts.offRatio) {
          // 下降沿
          runs.push({ on: true, frames: runLen });
          runLen = 0;
          on = false;
        } else {
          runLen++;
        }
      } else {
        if (v > thr) {
          // 上升沿
          if (runLen > 0) {
            runs.push({ on: false, frames: runLen });
            runLen = 0;
          }
          on = true;
          runLen = 1;
        } else {
          runLen++;
        }
      }
    }

    // 关键：保存跨块状态。若块结束时仍处于信号中，
    // 该段尚未结束，必须留到下一块继续累积 ——
    // 否则每个 42.7ms 的块边界都会把一个 64ms 的点切成两半。
    this.blockSignalOn = on;
    this.blockRunFrames = runLen;

    // 3) 把游程交给时序判定
    //
    // 单位估计需要足够样本才可信（同一簇至少 3 个样本）。
    // 在此之前把游程排入队列，等校准完成后按顺序一次性处理 ——
    // 若边收边判定，早期会用未校准的单位做出错误判断且无法挽回。
    for (const r of runs) {
      const dur = r.frames * frameMs;
      this.runQueue.push({ on: r.on, ms: dur });
      this.addTiming(dur);
    }

    // 尝试处理队列（单位就绪后才会真正输出）
    this.drainRunQueue();

    return this.getState();
  }

  /**
   * 处理游程队列。
   *
   * 单位未校准时只累积不输出；校准完成后用**冻结的单位**一次性处理，
   * 保证同一批游程的判定标准一致。
   */
  private drainRunQueue(): void {
    if (this.runQueue.length === 0) return;

    // 单位一旦校准就**锁定**，此后不再重新评估。
    // 若每次都重新计算，timings 里后续混入的异常段（如音频起始的
    // 31ms 静音）会让单位在 66ms 与 31ms 之间跳变，
    // 同一个 mark 用不同单位判定，输出就会变成满屏乱码。
    //
    // 锁定后也**不再要求 unitReady** —— 单位已可信，
    // 没必要因为后续样本变化而停下（那会导致末尾字符丢失）。
    if (!this.unitLocked) {
      if (!this.unitReady()) return;
      const frozen = this.pickUnitCandidate(this.timings);
      if (frozen > 0) {
        this.unitMs = frozen;
        this.unitLocked = true;
      }
    }

    const queued = this.runQueue;
    this.runQueue = [];
    for (const q of queued) {
      if (q.on) this.handleMark(q.ms, 0);
      else this.handleGap(q.ms, 0);
    }
  }

  /** 块模式下的信号状态（跨块保持） */
  private blockSignalOn = false;
  /** 块模式下的当前段长度（跨块保持，帧数） */
  private blockRunFrames = 0;
  /** 待处理的游程队列（单位校准后统一处理） */
  private runQueue: { on: boolean; ms: number }[] = [];
  /** 单位是否已锁定（锁定后不再随新样本变化） */
  private unitLocked = false;

  /**
   * 基于当前块的包络计算阈值。
   *
   * 用「峰值的一定比例」而非绝对值，以适应不同录音音量。
   */
  private blockThreshold(env: number[]): number {
    let peak = 0;
    for (const v of env) if (v > peak) peak = v;
    if (peak <= 0) return this.opts.minThreshold;

    // 峰值跟踪（带衰减），使阈值能跟随信号强度变化
    this.peak = Math.max(peak, this.peak * 0.999);
    return Math.max(
      this.opts.minThreshold,
      Math.min(this.opts.maxThreshold, this.peak * this.opts.onRatio),
    );
  }

  /**
   * 喂入一个电平样本。
   *
   * @param level 当前电平（RMS，0~1）
   * @param now 当前时间戳（ms）
   */
  push(level: number, now: number): RealtimeState {    this.lastSampleAt = now;
    if (level > this.peak) this.peak = level;
    this.noiseFloor = this.noiseFloor * 0.999 + level * 0.001;

    // 空闲超时：重置单位估计
    if (
      this.lastEdgeAt > 0 &&
      now - this.lastEdgeAt > this.opts.resetIdleMs &&
      this.signalOn === false
    ) {
      this.timings = [];
      this.unitMs = this.opts.initialUnitMs;
    }

    const thr = this.threshold();

    if (!this.signalOn) {
      if (level >= thr) {
        // 上升沿：静音段结束
        if (this.lastEdgeAt > 0) {
          this.queueRun(false, now - this.lastEdgeAt);
        }
        this.signalOn = true;
        this.lastEdgeAt = now;
        this.markStart = now;
      }
    } else {
      if (level < thr * this.opts.offRatio) {
        // 下降沿：信号段结束
        this.queueRun(true, now - this.markStart);
        this.signalOn = false;
        this.lastEdgeAt = now;
      }
    }

    return this.getState();
  }

  /**
   * 结束输入（用户停止监听时调用），冲刷未完成的码字。
   *
   * 关键：若信号仍在持续（末字符的点尚未被下降沿关闭），
   * 需要用「最后一次样本时刻」作为 mark 的结束点，
   * 而不是调用 flush 的时刻（那会把最后一个点误判为划）。
   */
  flush(now: number): RealtimeState {
    if (this.signalOn) {
      // 用最后收到的样本时刻作为信号结束点
      const end = Math.max(this.markStart, this.lastSampleAt);
      this.queueRun(true, end - this.markStart);
      this.signalOn = false;
      this.lastEdgeAt = now;
    }
    this.flushPending();
    return this.getState();
  }

  /**
   * 块模式下的收尾。
   *
   * 处理块末尾仍在持续的段：
   *  - 若为信号段（on=true），把它作为一个完整的 mark 判定
   *  - 若为静音段（on=false），作为一个 gap 判定
   * 之后冲刷累积的码字。
   */
  flushBlock(sampleRate = 48000): RealtimeState {
    // 把块末尾仍在持续的段排入队列
    if (this.blockRunFrames > 0) {
      const win = Math.max(1, Math.round((sampleRate * 0.002) / 1));
      const frameMs = (win / sampleRate) * 1000;
      const dur = this.blockRunFrames * frameMs;
      this.runQueue.push({ on: this.blockSignalOn, ms: dur });
      this.addTiming(dur);
      this.blockRunFrames = 0;
      this.blockSignalOn = false;
    }
    // 处理队列剩余部分
    this.drainRunQueue();
    this.flushPending();
    return this.getState();
  }

  /** 自适应阈值 */
  private threshold(): number {
    const floor = this.noiseFloor * 2.5;
    const byPeak = this.peak * this.opts.onRatio;
    return Math.max(
      this.opts.minThreshold,
      Math.min(this.opts.maxThreshold, Math.max(floor, byPeak)),
    );
  }

  /**
   * 记录一个时长样本（供单位估计使用）。
   *
   * 不做固定阈值过滤 —— 异常短值由聚类算法排除，
   * 硬过滤反而可能把真实的快速信号（高 WPM）滤掉。
   *
   * 注意：这里不更新 unitMs。单位在 drainRunQueue 中统一冻结，
   * 避免同批游程用不同单位判定。
   */
  private addTiming(durationMs: number): void {
    if (durationMs <= 0) return;
    this.timings.push(durationMs);
    if (this.timings.length > 64) this.timings.shift();
  }

  /**
   * 排入一个游程并尝试处理队列。
   *
   * 两种输入源（块模式的真实音频、时间戳模式的电平轮询）
   * 走同一条判定路径，保证行为一致。
   */
  private queueRun(on: boolean, ms: number): void {
    if (ms <= 0) return;
    this.runQueue.push({ on, ms });
    this.addTiming(ms);
    this.drainRunQueue();
  }

  /**
   * 喂入一个已完成的段（推荐方式）。
   *
   * 段长以**采样点数**给出，由采集端（AudioWorklet）在音频渲染线程
   * 精确计数，不受消息队列丢包影响 —— 这是实时解码可靠的关键。
   *
   * @param on true = 信号段（点/划），false = 静音段（间隔）
   * @param samples 该段的采样点数
   * @param sampleRate 采样率
   */
  /**
   * 通知解码器「刚发生了一次噪声爆发」。
   *
   * 采集端检测到异常长的信号段（远超正常划）时调用。
   * 此时当前累积的码字不可信，直接丢弃 ——
   * 宁可少一个字符，也不要输出错误字符。
   */
  rejectNoise(): RealtimeState {
    this.pending = '';
    this.unknownCount++;
    return this.getState();
  }

  pushRun(on: boolean, samples: number, sampleRate: number): RealtimeState {
    const ms = (samples / sampleRate) * 1000;
    this.queueRun(on, ms);
    return this.getState();
  }

  /**
   * 段模式的收尾：冲刷累积的码字。
   *
   * 段模式下最后一段（信号段）可能还没结束（用户仍在发报），
   * 此时调用方应主动调本方法把已收到的内容输出。
   */
  flushRun(): RealtimeState {
    this.drainRunQueue();
    this.flushPending();
    return this.getState();
  }

  /**
   * 把时长样本聚类。
   *
   * 合并判据用「与簇内中位数相差 25% 以内」，
   * 而不是「与簇内最小值相差 25% 以内」——
   * 后者会让一串递增的小值（2.0, 2.1, 2.2, ...）被并成一个大簇，
   * 反而把伪影放大。
   */
  private clusterTimings(values: number[]): { min: number; count: number }[] {
    const sorted = [...values].sort((a, b) => a - b);
    const clusters: { min: number; max: number; count: number }[] = [];

    for (const t of sorted) {
      const last = clusters[clusters.length - 1];
      if (last) {
        const mid = (last.min + last.max) / 2;
        if (t <= mid * 1.25) {
          last.max = t;
          last.count++;
        } else {
          clusters.push({ min: t, max: t, count: 1 });
        }
      } else {
        clusters.push({ min: t, max: t, count: 1 });
      }
    }

    return clusters.map((c) => ({ min: c.min, count: c.count }));
  }

  /**
   * 从时长样本中选出 1u 候选。
   *
   * 规则：
   *  1. 先用绝对下限剔除采集伪影（< 15ms）。
   *     采集链路在音频起始处会丢一小段，产生 1~5ms 的短段；
   *     这种伪影在每块开头都会出现（多个），靠「样本数」无法排除。
   *     真实 1u 至少 15ms（60 WPM 的点为 33ms），故 15ms 是安全下限。
   *  2. 再取**最小的、样本数 ≥ 2 的簇**。
   */
  private pickUnitCandidate(values: number[]): number {
    if (values.length === 0) return 0;

    // 绝对下限：剔除块边界伪影
    const valid = values.filter((v) => v >= MIN_UNIT_MS);
    if (valid.length === 0) return 0;

    const sorted = [...valid].sort((a, b) => a - b);
    const clusters = this.clusterTimings(sorted);

    // 1u 必然是最小的簇（码内间隔恒为 1u），
    // 因此**取最小簇**，而不是「样本数达标」的簇。
    //
    // 为什么不能要求 count >= 3：中文电码（数字体系）里
    // 1u 簇是「位间隔」，早期只攒到 2 个样本，
    // 而 3u 簇（划）先攒到 3 个 —— 若按 count 筛选会错误地
    // 跳过 1u 簇、选中 3u 簇，把点全判成划。
    //
    // 最小簇 count==1 的情形（孤立短脉冲伪影）：
    // 若第二簇样本充足，则用第二簇；否则仍用最小簇。
    let chosen = clusters[0];
    if (chosen.count < 2 && clusters.length > 1 && clusters[1].count >= 3) {
      chosen = clusters[1];
    }

    for (const c of [chosen]) {
      {
        // 取簇内的 25 分位数。
        //
        // 1u 簇里同时包含「点」和「码内间隔」（两者等长，都是 1u），
        // 但点因起始淡入通常略短（实测 37ms vs 间隔 43ms）。
        // 取最小值会被个别偏短测量拉低，取中位数又可能偏到间隔上，
        // 25 分位数能稳定落在两者之间。
        const members = sorted.filter((v) => v >= c.min && v <= c.min * 1.25);
        if (members.length === 0) return c.min;
        const idx = Math.floor((members.length - 1) * 0.25);
        return members[idx];
      }
    }
    return sorted[0];
  }

  /**
   * 重新估计单位时长。
   *
   * 摩斯时序中所有时长都是 1u 的整数倍：
   *   点=1u 划=3u 码内间隔=1u 字符间隔=3u 词间隔=7u
   *
   * ## 为什么不���众数簇
   *
   * 众数簇可能是 3u 簇（划/字符间隔出现得比点/码内间隔多时），
   * 导致 1u 被估成 3u，所有点被误判为划。
   *
   * ## 为什么不直接取最小值
   *
   * 采集链路（Android WebView 的 AudioWorklet 消息队列）可能在音频
   * 起始处丢掉一小段，产生比真实 1u 更短的伪影
   * （实测 2ms vs 真实 64ms），直接取最小值会把 1u 拉到 2ms。
   *
   * 因此用「最小的有效簇」（样本数 ≥ 2）。
   */
  private recomputeUnit(): void {
    if (this.timings.length < 3) return;

    const candidate = this.pickUnitCandidate(this.timings);
    if (candidate <= 0) return;

    // 平滑更新（单位估计变化要快，避免前几个符号误判）
    const alpha = this.timings.length < 6 ? 0.8 : 0.45;
    this.unitMs = this.unitMs * (1 - alpha) + candidate * alpha;
  }

  /** 处理一个点/划 */
  private handleMark(durationMs: number, now: number): void {
    if (durationMs <= 0) return;
    this.addTiming(durationMs);
    this.classifyMark(durationMs);
  }

  /**
   * 单位估计是否已可信。
   *
   * 需要聚类中出现至少 3 个接近的样本（通常是多个 1u 的点/码内间隔），
   * 才认为单位可靠。在此之前用初值判定会误判首个符号。
   */
  private unitReady(): boolean {
    // 需要足够样本才校准。
    //
    // 样本太少时（实测 < 8）1u 簇里只有几个「偏短的点」，
    // 还没有混进正常的「码内间隔」，估计出的单位会偏小
    // （实测 57ms vs 真实 66.5ms），导致点被误判为划。
    if (this.timings.length < 8) return false;
    const valid = this.timings.filter((v) => v >= MIN_UNIT_MS);
    if (valid.length < 8) return false;
    const clusters = this.clusterTimings(valid);

    // 只要存在一个「样本数 >= 3 且占比 >= 40%」的簇即可校准。
    //
    // 不能要求「最小簇」达标：实测中首个 mark 常因起始淡入而偏短
    // （57ms vs 正常的 66.5ms），它会自成一簇且 count=1，
    // 若因此判定「未校准」就永远解不出东西。
    //
    // 占比要求用于排除伪影簇（如采集链路的 0.5ms 间隔），
    // 它样本数虽多但占比低。
    return clusters.some(
      (c) => c.count >= 3 && c.count / valid.length >= 0.4,
    );
  }

  /** 按当前单位把时长判定为点或划 */
  private classifyMark(durationMs: number): void {
    // 划 = 3u，点 = 1u；阈值取 2u
    const isDash = durationMs > this.unitMs * 1.9;

    // 过长的信号段不可能是有效符号。
    //
    // 摩斯最长的符号是划（3u）。实测真实麦克风下，一次突发噪声
    // （关门、放下手机）会把相邻两个划之间的 1u 间隔填满，
    // 合并出一个 435ms 的段（正常划 200ms）——
    // 若照常判成划，整段文本就乱了。
    //
    // 因此超过 5u 的段直接丢弃并计入未知，宁可少一个符号，
    // 也不要把噪声当成划。
    if (durationMs > this.unitMs * 5) {
      this.unknownCount++;
      return;
    }

    this.pending += isDash ? '-' : '.';
    this.symbolCount++;
  }

  /** 处理一个间隔 */
  private handleGap(durationMs: number, now: number): void {
    if (durationMs <= 0) return;
    this.addTiming(durationMs);
    if (this.pending.length === 0) return;

    const unit = this.unitMs;
    const gaps = gapsOf(this.book);

    // 判定分隔级别
    // 码内间隔 = 1u（不分离）
    // 字符间隔 = 3u
    // 码组间隔 = 5u（telegraph / mixed 体系）
    // 词间隔   = 7u（telegraph / mixed 为 9u）
    if (durationMs >= unit * (gaps.word - 1.5)) {
      this.emitChar();
      this.outText += ' ';
    } else if (gaps.group !== undefined && durationMs >= unit * (gaps.group - 1.2)) {
      // 码组间隔：中文电码的 4 位数字到此结束，整组解析
      this.emitChar();
    } else if (durationMs >= unit * (gaps.char - 1.2)) {
      this.emitChar();
    }
    // 否则是码内间隔，继续累积
  }

  /** 输出当前累积的码字 */
  private emitChar(): void {
    if (this.pending.length === 0) return;
    const code = this.pending;
    this.pending = '';

    // ── 混合体系 ──
    //
    // 中文电码的每位数字是 5 个符号，4 位一组共 20 个符号。
    // 编码端在每个码组之后发 group 间隔（5u），因此：
    //  - 收到数字码时先暂存到 digitBuffer，等 group 间隔时整组解析
    //  - 收到非数字码（拉丁字母）时立即输出
    if (this.book.system === 'mixed') {
      const digit = MORSE_DIGIT_CODES[code];
      if (digit !== undefined) {
        // 数字：可能是中文电码的一部分，暂存
        this.digitBuffer += digit;
        const groupLen = this.book.codeLengths?.[0] ?? 4;
        // 攒够一组就尝试解析（group 间隔到来时也会触发这里的补全）
        if (this.digitBuffer.length >= groupLen) {
          this.flushDigitGroup();
        }
        return;
      }

      // 非数字码：先把暂存的数字按「纯数字」输出，再输出这个字母
      if (this.digitBuffer.length > 0) this.flushDigitGroupAsDigits();
      const ch = this.book.reverse[code];
      if (ch === undefined) {
        this.unknownCount++;
        this.outText += '?';
      } else {
        this.outText += ch;
      }
      return;
    }

    if (this.book.system === 'telegraph') {
      // 数字电码：每个符号是 1 位数字，4 位组成一个汉字
      const digit = MORSE_DIGIT_CODES[code];
      if (digit === undefined) {
        this.unknownCount++;
        return;
      }
      this.digitBuffer += digit;
      // 码长由码表决定（中文电码 4 位）
      const groupLen = this.book.codeLengths?.[0] ?? 4;
      while (this.digitBuffer.length >= groupLen) {
        const group = this.digitBuffer.slice(0, groupLen);
        this.digitBuffer = this.digitBuffer.slice(groupLen);
        const ch = this.book.reverse[group];
        if (ch === undefined) {
          this.unknownCount++;
          this.outText += '?';
        } else {
          this.outText += ch;
        }
      }
      return;
    }

    const ch = this.book.reverse[code];
    if (ch === undefined) {
      this.unknownCount++;
      this.outText += '?';
    } else {
      this.outText += ch;
    }
  }

  /**
   * 把暂存的数字按一组中文电码解析。
   *
   * 若该 4 位码不在中文表里，退回「逐位数字」输出 ——
   * 因为用户可能真的在发数字（如 "5555"）。
   */
  private flushDigitGroup(): void {
    const groupLen = this.book.codeLengths?.[0] ?? 4;
    while (this.digitBuffer.length >= groupLen) {
      const group = this.digitBuffer.slice(0, groupLen);
      const ch = this.book.reverse[group];
      if (ch !== undefined) {
        this.digitBuffer = this.digitBuffer.slice(groupLen);
        this.outText += ch;
      } else {
        // 不是有效中文码：按数字输出，避免卡住
        break;
      }
    }
  }

  /** 把暂存的数字逐位输出（当它们不是有效中文码时） */
  private flushDigitGroupAsDigits(): void {
    if (this.digitBuffer.length === 0) return;
    this.outText += this.digitBuffer;
    this.digitBuffer = '';
  }

  /** 冲刷残留 */
  private flushPending(): void {
    if (this.pending.length > 0) {
      this.emitChar();
    }
    if (this.book.system === 'telegraph' && this.digitBuffer.length > 0) {
      // 数字电码：若还有不足一组的多余数字，视为残缺
      this.unknownCount++;
      this.digitBuffer = '';
    } else if (this.book.system === 'mixed' && this.digitBuffer.length > 0) {
      // 混合体系：不足一组的数字按原样输出（用户可能真的在发数字）
      this.flushDigitGroupAsDigits();
    }
  }

  private computeConfidence(): number {
    if (this.symbolCount === 0) return 0;
    const unknownPenalty = this.unknownCount / this.symbolCount;
    const lockBonus = this.timings.length >= 4 ? 1 : 0.4;
    return Math.max(0, Math.min(1, (1 - unknownPenalty) * lockBonus));
  }
}
