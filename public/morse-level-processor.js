/**
 * AudioWorklet：把麦克风音频的「信号段」传给主线程。
 *
 * ## 为什么在 worklet 内部做判决
 *
 * Android WebView 的 AudioWorklet 消息队列会丢弃部分消息
 * （实测 375 次/秒时丢 12.7%，即使降到 11.7 次/秒仍丢 3.3%）。
 *
 * 若主线程靠「按块累加帧数」还原信号时长，丢失的数据会让
 * 块边界与真实音频错位，跨块累加出的段长完全失真 ——
 * 实测 67ms 的点被算成 172ms，导致点划判定全错。
 *
 * ## 解决方式
 *
 * 在 worklet（音频渲染线程）内完成判决，段长用**采样点计数**。
 * 主线程只接收「已完成的段」，即使丢消息也只是少了整段，
 * 而不会让后续所有段的长度错位。
 *
 * ## 真实麦克风的三道关键处理
 *
 * ### 1. 与相位无关的包络
 *
 * 早期版本用 0.5ms 窗做 RMS。600Hz 的周期是 1.67ms，窗长不足一个周期，
 * 算出的 RMS 随相位剧烈起伏 —— 一个 200ms 的划可能在中途掉到门限以下，
 * 被切成几段。改用「对 x² 做一极点平滑再开方」，天然跨多个周期平均。
 *
 * ### 2. 峰值必须能衰减
 *
 * 早期版本 `peak` 只升不降。真实环境里一次突发噪声（放下手机、关门、
 * 咳嗽）就能把 peak 顶到接近满幅，之后门限永久过高，**彻底听不见**。
 * 现在 peak 以 1.2 秒时间常数衰减，且不低于当前包络。
 *
 * ### 3. 门限必须是相对量
 *
 * 早期版本有绝对下限 0.02。手机离音箱稍远时收到的 RMS 可能只有 0.01，
 * 永远低于门限，什么都检测不到。现在门限完全由
 * `[噪声底, 信号峰]` 这段动态范围按比例插值得到，
 * 与绝对音量无关。
 *
 * ## 去抖
 *
 * 上升/下降沿都要「持续 minConfirm 毫秒」才确认，且边沿时刻记为
 * **首次穿越时刻**（不是确认时刻），因此不会引入系统性时长偏差。
 * 任何短于 6ms 的噪声毛刺都会被丢弃。
 *
 * ## 协议
 *
 * worklet -> 主线程:
 *   { type: 'run', on: boolean, samples: number }
 *   { type: 'level', rms, noise, peak, thr, usable }
 */
class MorseLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;

    // ── 包络检波：对 x² 做一极点平滑，与信号相位无关 ──
    // 攻击与释放都用 1.5ms：释放过快会让一个划在内部被噪声切断，
    // 过慢则码内间隔（1u，18WPM 下 67ms）测出来偏短。
    // 实测 4ms 释放会让 67ms 的间隔测成 57ms（偏短 15%），
    // 进而把单位估计拉低；1.5ms 释放测得 69ms，误差降到 4%。
    this.attackCoef = Math.exp(-1 / (sr * 0.0015));
    this.releaseCoef = Math.exp(-1 / (sr * 0.0015));
    this.power = 0;
    this.primed = false;

    // ── 阈值跟踪 ──
    //
    // noise 用「快速下降 / 缓慢上升」的非对称跟踪：
    // 遇到更安静的时刻立刻跟下去（约 8ms），
    // 遇到较响的声音则极慢地抬升（0.35 秒）。
    // 这样即使开局正好在信号中间，也会在第一个符号间隙内
    // 迅速落到真实噪声底，不会被开头的信号段永久污染。
    this.noise = -1; // -1 表示尚未初始化
    this.peak = 0; // 信号峰（快升慢降）
    this.noiseUpCoef = Math.exp(-1 / (sr * 0.35));
    this.noiseDownCoef = Math.exp(-1 / (sr * 0.008));
    this.peakDecayCoef = Math.exp(-1 / (sr * 1.2));

    // 启动参数。
    //
    // 实测教训：早期版本用「开头 40~120ms 窗口内的最小包络」作为
    // 初始噪声底。若开局正好在信号中间（非常常见：用户点「开始监听」
    // 时对方已经在发报），这个最小值是正弦波在窗口内碰巧遇到的低点
    // （实测 0.5186），远高于真实噪声底（0.0002）。
    // 后果是 onThr 被推到 0.75，而信号峰值只有 0.73 —— 永远触发不了，
    // 整个实时监听「几乎无法解码」。
    //
    // 现在改为：噪声底从 0 起步，完全依赖非对称跟踪
    // （遇安静处 8ms 内跟下去、遇响处 0.35s 才抬升）自行收敛。
    // 峰值从 0 起步，靠「快升慢降」跟踪。
    this.warmup = 0;
    this.warmCount = 0;

    // 迟滞：在 [noise, peak] 区间内的相对位置
    this.onPos = 0.45;
    this.offPos = 0.22;

    // ── 判决状态 ──
    this.on = false;
    this.runStart = 0;
    this.total = 0;
    this.cand = -1;
    this.minConfirm = Math.round(sr * 0.003); // 3ms

    /** 已观测到的最长正常符号时长（毫秒），用于识别噪声爆发 */
    this.longestMarkMs = 0;
    /**
     * 单位时长（1u）的在线估计，单位毫秒。
     *
     * 用「最短的正常信号段」近似 1u（点 = 1u）。
     * 0 表示尚未建立，此时噪声判定退化为「见过的最长段」。
     */
    this.unitHintMs = 0;
    /** 当前段是否已被判定为噪声爆发 */
    this.emitOverload = false;

    // 判决步长 1.33ms：足以分辨最快摩斯符号（40WPM 的点约 20ms）
    this.step = Math.max(1, Math.round(sr * 0.00133));
    this.acc = 0;
    this.levelTick = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'config') {
        if (typeof m.onPos === 'number') this.onPos = m.onPos;
        if (typeof m.offPos === 'number') this.offPos = m.offPos;
      } else if (m.type === 'flush') {
        // 主线程要停止监听：把当前未完成的段发出去，
        // 否则末尾字符会丢（实测最后那个 "E" 就是这样消失的）。
        if (this.runStart < this.total) {
          this.emit(this.on, this.total - this.runStart);
          this.runStart = this.total;
        }
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const p = v * v;
      const c = p > this.power ? this.attackCoef : this.releaseCoef;
      this.power = p + (this.power - p) * c;

      this.acc++;
      if (this.acc >= this.step) {
        this.total += this.acc;
        this.acc = 0;
        this.judge(Math.sqrt(this.power));
      }
    }
    return true;
  }

  /** 一次判决 */
  judge(env) {
    // 首帧初始化
    if (!this.primed) {
      this.noise = 0;
      this.peak = env;
      this.primed = true;
      this.runStart = this.total;
    }

    // 峰值：快升慢降，且不低于当前包络。
    // 「不低于 env」保证一个长划期间 peak 稳定在信号幅度上。
    this.peak = Math.max(env, this.peak * this.peakDecayCoef);

    // 噪声底：只在判定为静音时跟踪。
    // 若在信号期间也更新，长划会把噪声底抬上去，门限随之升高，
    // 划就可能在中途掉出判定。
    if (!this.on) {
      if (env < this.noise) {
        this.noise = env + (this.noise - env) * this.noiseDownCoef;
      } else {
        this.noise = env + (this.noise - env) * this.noiseUpCoef;
      }
    }

    if (this.peak < this.noise) this.peak = this.noise;

    const range = this.peak - this.noise;
    // 动态范围太小时认为「没有可用信号」，避免纯噪声被反复触发
    const usable = range > Math.max(this.noise * 0.75, 0.0015);

    const onThr = this.noise + range * this.onPos;
    const offThr = this.noise + range * this.offPos;

    // 电平上报（约 10ms 一次）
    this.levelTick++;
    if (this.levelTick >= 8) {
      this.levelTick = 0;
      this.port.postMessage({
        type: 'level',
        rms: env,
        noise: this.noise,
        peak: this.peak,
        thr: onThr,
        usable,
      });
    }

    // ── 过载检测 ──
    //
    // 真实环境里一次突发噪声（关门、放下手机）会把相邻两个划之间的
    // 间隔填满，合并出一个远超正常划长度的段（实测 435ms vs 正常 200ms）。
    // 这里用「当前 ON 段已持续的时间」对照「已知的划长度」判断：
    // 若已超过正常划的 2.2 倍，认定是噪声爆发，把它整段丢弃。
    //
    // 判据依赖 peak/noise 的稳定性，因此在跟踪器收敛后才生效。
    if (this.on && this.peak > 0 && this.noise >= 0) {
      const span = this.peak - this.noise;
      if (span > 0) {
        // 用当前段长度粗略换算成「单位数」：正常划 ≈ 3u，
        // 3u 对应的毫秒数约为 (peak 归一化后) 无法直接得到，
        // 因此改用「段长 / 已观测到的最长正常符号」的比例。
        const durMs = ((this.total - this.runStart) / sampleRate) * 1000;
        if (this.longestMarkMs > 0 && durMs > this.longestMarkMs * 1.8) {
          // 噪声爆发：强制结束该段并标记为无效
          this.emitOverload = true;
        }
      }
    }

    if (!usable) {
      // 动态范围不足：强制回到静音态
      if (this.on) {
        this.emit(true, this.total - this.runStart);
        this.on = false;
        this.runStart = this.total;
      }
      this.cand = -1;
      return;
    }

    if (!this.on) {
      if (env > onThr) {
        if (this.cand < 0) this.cand = this.total;
        if (this.total - this.cand >= this.minConfirm) {
          this.emit(false, this.cand - this.runStart);
          this.on = true;
          this.runStart = this.cand;
          this.cand = -1;
        }
      } else {
        this.cand = -1;
      }
    } else {
      if (env < offThr) {
        if (this.cand < 0) this.cand = this.total;
        if (this.total - this.cand >= this.minConfirm) {
          this.emit(true, this.cand - this.runStart);
          this.on = false;
          this.runStart = this.cand;
          this.cand = -1;
        }
      } else {
        this.cand = -1;
      }
    }
  }

  emit(on, samples) {
    if (samples <= 0) return;
    const ms = (samples / sampleRate) * 1000;

    if (on) {
      // 记录正常符号长度，用于后续噪声爆发判定。
      //
      // 关键：基准必须是**划**（3u），不能用点（1u）。
      // 早期版本用「见过的最大值」，第一个点就把基准定成 1u，
      // 于是正常划（3u = 基准的 3 倍）被误判成噪声爆发整段丢弃，
      // 数字串会全部解不出来。
      //
      // 因此只在段长 >= 2u 时更新基准（即认定是划），
      // 且基准不超过 4u（超过就是噪声了）。
      // 在线更新 1u 估计：取「最短的合理信号段」。
      // 合理 = 大于 8ms（低于此值是采集伪影）。
      if (ms > 8 && (this.unitHintMs === 0 || ms < this.unitHintMs)) {
        // 只在明显是短符号时更新，避免把一个划误当 1u
        if (this.unitHintMs === 0 || ms < this.unitHintMs * 1.5) {
          this.unitHintMs = ms;
        }
      }

      const estUnitMs = this.unitHintMs;
      if (!this.emitOverload) {
        if (estUnitMs > 0) {
          if (ms >= estUnitMs * 2 && ms < estUnitMs * 4.5) {
            this.longestMarkMs = Math.max(this.longestMarkMs, ms);
          }
        } else if (ms > this.longestMarkMs) {
          this.longestMarkMs = ms;
        }
      }
      if (this.emitOverload) {
        // 噪声爆发：不发送该段（主线程自然把它当作静音），
        // 并通知主线程丢弃当前累积的码字
        this.port.postMessage({ type: 'noise', ms });
        this.emitOverload = false;
        return;
      }
    }
    this.port.postMessage({ type: 'run', on, samples });
  }
}

registerProcessor('morse-level-processor', MorseLevelProcessor);
