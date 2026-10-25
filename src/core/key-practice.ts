/**
 * 手键（电键）练习判定器。
 *
 * ## 与麦克风解码的区别
 *
 * 麦克风解码面对的是未知 WPM、含噪声的音频，需要包络检波 + 阈值判决。
 * 手键练习则是**精确的按键事件**：按下/松开的时刻由 UI 直接给出，
 * 没有噪声、没有包络模糊，因此可以做得更准。
 *
 * 难点在于：**用户自己的发报速度是未知的**，且刚开始练时节奏不稳。
 * 因此这里在线学习「点」的时长，用它作为 1u 基准。
 *
 * ## 判定规则（ITU-R M.1677-1）
 *
 *   点 = 1u，划 = 3u
 *   码内间隔 = 1u，字符间隔 = 3u，词间隔 = 7u
 *
 * 判点/划的分界取 2u（点与划的几何中点）。
 *
 * ## 单位学习策略
 *
 * 手键的难点是「第一下按键时还没有 1u 基准」。策略：
 *
 *  1. 第一个按键**不判定**，直接记为 1u 初值（用户的第一下通常是点）
 *  2. 之后每次按键与当前 1u 比较，落在 [0.6u, 1.6u] 视为点、
 *     [2.4u, 4.0u] 视为划，两者都用真实时长微调 1u
 *  3. 若某次按键落在「模糊区」（1.6u ~ 2.4u），标记为「节奏不稳」，
 *     不更新 1u，但仍按最近一侧给出猜测
 *
 * 这样即使起步不准，几次按键后也能收敛到用户自己的节奏。
 */

/** 一次按键的判定结果 */
export interface KeyStroke {
  /** 按压时长（毫秒） */
  durationMs: number;
  /** 判定结果：点 / 划 */
  mark: '.' | '-';
  /**
   * 准确度评级。
   *  - good  : 时长落在该符号的标准区间中心附近
   *  - ok    : 落在标准区间内，但偏离中心
   *  - shaky : 落在模糊区，可能是点也可能是划
   */
  quality: 'good' | 'ok' | 'shaky';
  /** 相对于标准值的偏差比例（0.2 表示偏离 20%） */
  deviation: number;
  /** 判定时使用的单位时长 */
  unitMs: number;
}

/** 一次「字符完成」事件 */
export interface KeyChar {
  /** 该字符的摩斯码 */
  code: string;
  /** 解出的字符（查表失败时为 '?'） */
  char: string;
  /** 组成本字符的各次按键 */
  strokes: KeyStroke[];
}

/** 判定器状态（供 UI 渲染） */
export interface KeyPracticeState {
  /** 当前正在累积的码字（点划串） */
  pending: string;
  /** 已完成的字符 */
  chars: KeyChar[];
  /** 最近一次按键 */
  lastStroke: KeyStroke | null;
  /** 当前学到的单位时长（ms），0 表示还没学到 */
  unitMs: number;
  /** 由单位时长反推的 WPM */
  wpm: number;
  /** 已判定的按键总数 */
  strokeCount: number;
  /** 其中「节奏不稳」的数量 */
  shakyCount: number;
}

/** 判点/划的分界（单位倍数） */
const DASH_THRESHOLD = 2.0;

/** 「点」的合理区间（单位倍数） */
const DOT_MIN = 0.6;
const DOT_MAX = 1.6;
/** 「划」的合理区间（单位倍数） */
const DASH_MIN = 2.4;
const DASH_MAX = 4.0;

/** 单位估计的平滑系数（越大越跟手） */
const UNIT_ALPHA = 0.35;

/**
 * 起步校准所需的样本数。
 *
 * 一段发报里必然至少有一个点（1u），因此取前 N 段的最小值作 1u。
 * N 取 4：太少容易被单次抖动骗到（若 4 段全是划，最小值 = 3u），
 * 太多则起步太慢、用户看不到反馈。
 */
const CALIBRATE_SAMPLES = 4;

/** 单位时长的合理范围（ms）。低于 20ms 或高于 400ms 都不像人手发报 */
const UNIT_MIN_MS = 20;
const UNIT_MAX_MS = 400;

/**
 * 手键判定器。
 *
 * 用法：
 * ```ts
 * const kp = new KeyPracticer(book);
 * kp.pressDown(now);           // 按下
 * const stroke = kp.pressUp(now); // 松开，返回本次判定
 * kp.idle(now);                // 可选：周期性调用，用于自动切分字符
 * ```
 */
export class KeyPracticer {
  /** 当前学到的单位时长（ms），0 表示未初始化 */
  private unitMs = 0;
  private pending = '';
  private strokes: KeyStroke[] = [];
  private chars: KeyChar[] = [];
  private strokeCount = 0;
  private shakyCount = 0;
  private lastStroke: KeyStroke | null = null;

  /** 上次松开的时刻（用于判断字符/词间隔） */
  private lastUpAt = 0;
  /** 是否处于按下状态 */
  private down = false;
  /** 本次按下的起始时刻 */
  private downAt = 0;
  /** 当前字符的起始时刻（第一次按键按下时） */
  private charStartAt = 0;
  /** 起步校准缓存（基准确定前的时长样本） */
  private calibBuf: number[] = [];
  /**
   * 连续「偏短」按键计数。
   *
   * 用于从错误的初始基准中自愈：若第一下是划（3u）被当成 1u，
   * 基准会偏大 3 倍，之后所有正常按键都显得「太短」而落在模糊区。
   * 连续多次出现这种情形时强制把基准拉回实测值。
   */
  private shortStreak = 0;

  constructor(
    /** 用于查表的码表（morse 体系） */
    private book?: { reverse: Record<string, string> },
  ) {}

  /** 设置/更换码表 */
  setBook(book: { reverse: Record<string, string> }): void {
    this.book = book;
  }

  /** 按下 */
  pressDown(now: number): void {
    if (this.down) return; // 重复按下忽略
    this.down = true;
    this.downAt = now;

    // 若是新字符的第一个按键，记录字符起点
    if (this.pending === '') this.charStartAt = now;
  }

  /**
   * 松开，返回本次按键的判定。
   *
   * @returns 判定结果；若这次按下无效（时长为 0）则返回 null
   */
  pressUp(now: number): KeyStroke | null {
    if (!this.down) return null;
    this.down = false;

    const durationMs = Math.max(0, now - this.downAt);
    if (durationMs < 1) return null;

    // classify 内部负责全部副作用（累积 pending、计数、起步校准重算），
    // 这里只取回最终判定结果。
    const stroke = this.classify(durationMs);
    this.lastUpAt = now;
    return stroke;
  }

  /**
   * 判定一次按压时长。
   *
   * 同时在线更新单位估计。
   */
  private classify(durationMs: number): KeyStroke {
    // ── 起步校准：先缓存前几段，不急着定基准 ──
    //
    // ## 为什么不能「第一下就当 1u」
    //
    // 无法预知第一下是点还是划。实测教训：
    // 若第一下是划（3u）被当成 1u，基准放大 3 倍，
    // 之后所有划都恰好等于 1.0u → 被判成「good 的点」，
    // 于是整段全是点，且因为 ratio≈1 落在正常区间，自愈逻辑也救不回来。
    //
    // ## 做法：缓存到够样本再定基准
    //
    // 收集前 CALIBRATE_SAMPLES 段，用其中的**最小值**作为 1u ——
    // 一段发报里必然至少有一个点（1u），最小值就是 1u。
    // 期间先按「暂定基准」给个粗略判定，等基准定下后统一重算。
    if (this.unitMs === 0) {
      this.calibBuf.push(durationMs);
      if (this.calibBuf.length < CALIBRATE_SAMPLES) {
        // 校准期：先给一个占位结果，等基准定下后重算
        const placeholder: KeyStroke = {
          durationMs,
          mark: '.',
          quality: 'ok',
          deviation: 0,
          unitMs: 0,
        };
        this.lastStroke = placeholder;
        this.strokeCount++;
        this.pending += '.';
        this.strokes.push(placeholder);
        return placeholder;
      }
      // 样本够了：用最小值作 1u（一段发报里必然至少有一个点）
      const min = Math.min(...this.calibBuf);
      this.unitMs = Math.min(UNIT_MAX_MS, Math.max(UNIT_MIN_MS, min));
      const buf = this.calibBuf;
      this.calibBuf = [];

      // 清掉校准期的占位累积，再用真实基准重算
      this.pending = '';
      this.strokes = [];
      this.strokeCount = 0;
      this.shakyCount = 0;

      for (const d of buf) {
        const r = this.classifyWithUnit(d);
        this.pending += r.mark;
        this.strokes.push(r);
        this.lastStroke = r;
        this.strokeCount++;
        if (r.quality === 'shaky') this.shakyCount++;
      }
      return this.lastStroke!;
    }

    const r = this.classifyWithUnit(durationMs);
    this.pending += r.mark;
    this.strokes.push(r);
    this.lastStroke = r;
    this.strokeCount++;
    if (r.quality === 'shaky') this.shakyCount++;
    return r;
  }

  /**
   * 用当前基准判定一次时长（不含单位更新逻辑）。
   */
  private classifyWithUnit(durationMs: number): KeyStroke {
    const ratio = durationMs / this.unitMs;
    const isDash = ratio >= DASH_THRESHOLD;
    const mark: '.' | '-' = isDash ? '-' : '.';

    // 计算偏差与评级
    const targetRatio = isDash ? 3 : 1;
    const deviation = Math.abs(ratio - targetRatio) / targetRatio;

    let quality: KeyStroke['quality'];
    if (isDash) {
      if (ratio >= DASH_MIN && ratio <= DASH_MAX) {
        quality = deviation <= 0.2 ? 'good' : 'ok';
      } else {
        quality = 'shaky';
      }
    } else {
      if (ratio >= DOT_MIN && ratio <= DOT_MAX) {
        quality = deviation <= 0.2 ? 'good' : 'ok';
      } else {
        quality = 'shaky';
      }
    }

    // ── 从错误基准中自愈 ──
    //
    // 若连续 3 次按键都明显短于当前基准（ratio < DOT_MIN），
    // 说明基准本身偏大（典型场景：第一下是划被当成了 1u）。
    // 此时直接把基准拉向实测值，而不是继续拒绝更新。
    if (ratio < DOT_MIN) {
      this.shortStreak++;
      if (this.shortStreak >= 3) {
        this.unitMs = durationMs;
        this.shortStreak = 0;
        return {
          durationMs,
          mark: '.',
          quality: 'shaky',
          deviation,
          unitMs: this.unitMs,
        };
      }
    } else {
      this.shortStreak = 0;
    }

    // 更新单位估计：只用「可信」的按键，且按符号类型折算回 1u
    if (quality !== 'shaky') {
      const observedUnit = durationMs / targetRatio;
      if (observedUnit >= UNIT_MIN_MS && observedUnit <= UNIT_MAX_MS) {
        this.unitMs = this.unitMs * (1 - UNIT_ALPHA) + observedUnit * UNIT_ALPHA;
      }
    }

    return {
      durationMs,
      mark,
      quality,
      deviation,
      unitMs: this.unitMs,
    };
  }

  /**
   * 周期性调用：根据「距上次松开的时间」自动切分字符/词。
   *
   * 手键没有「字符结束」事件，只能靠停顿长度推断：
   *  - 停顿 >= 3u  → 字符结束
   *  - 停顿 >= 7u  → 词结束（额外输出空格）
   *
   * @returns 若发生了切分，返回本次完成的字符；否则 null
   */
  idle(now: number): KeyChar | null {
    if (this.down || this.pending === '' || this.unitMs === 0) return null;

    const gap = now - this.lastUpAt;
    const gapUnits = gap / this.unitMs;

    if (gapUnits >= 3) {
      return this.flushChar();
    }
    return null;
  }

  /** 强制结束当前字符（用户点「完成」或切换面板时） */
  flush(now?: number): KeyChar | null {
    // 先结算「仍在按住」的那一次按键。
    //
    // 注意顺序：不能先判断 pending 为空就返回 ——
    // 用户刚开始按下时 pending 还是空的，若提前返回，
    // 这次按键就永远丢了（实测 flush 在按下状态返回 null）。
    if (now !== undefined && this.down) {
      this.pressUp(now);
    }
    return this.flushChar();
  }

  private flushChar(): KeyChar | null {
    if (this.pending === '') return null;
    const code = this.pending;
    const ch = this.book?.reverse[code];
    const result: KeyChar = {
      code,
      char: ch ?? '?',
      strokes: this.strokes,
    };
    this.chars.push(result);
    this.pending = '';
    this.strokes = [];
    return result;
  }

  /** 清空全部状态 */
  reset(): void {
    this.unitMs = 0;
    this.pending = '';
    this.strokes = [];
    this.chars = [];
    this.strokeCount = 0;
    this.shakyCount = 0;
    this.lastStroke = null;
    this.lastUpAt = 0;
    this.down = false;
    this.downAt = 0;
    this.charStartAt = 0;
    this.shortStreak = 0;
    this.calibBuf = [];
  }

  /** 只清空已输出的字符（保留学到的单位） */
  clearOutput(): void {
    this.pending = '';
    this.strokes = [];
    this.chars = [];
    this.strokeCount = 0;
    this.shakyCount = 0;
    this.lastStroke = null;
    this.shortStreak = 0;
  }

  getState(): KeyPracticeState {
    // 由单位时长反推 WPM：1u = 1.2/WPM*1000 → WPM = 1200/1u
    const wpm = this.unitMs > 0 ? 1200 / this.unitMs : 0;
    return {
      pending: this.pending,
      chars: this.chars,
      lastStroke: this.lastStroke,
      unitMs: this.unitMs,
      wpm,
      strokeCount: this.strokeCount,
      shakyCount: this.shakyCount,
    };
  }
}
