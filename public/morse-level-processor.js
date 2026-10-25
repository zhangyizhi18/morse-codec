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
 * 在 worklet（音频渲染线程）内完成：
 *  1. RMS 包络（1ms 窗）
 *  2. 迟滞判决找边沿
 *  3. 段长的**采样点计数**（不依赖时间戳，不受消息丢失影响）
 *
 * 主线程只接收「已完成的段」，即使丢消息也只是少了整段，
 * 而不会让后续所有段的长度错位。
 *
 * ## 协议
 *
 * worklet -> 主线程: { type: 'run', on: boolean, samples: number }
 *                  on=true 表示一段信号；on=false 表示一段静音
 *                  samples 为该段的采样点数
 */
class MorseLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /**
     * 包络窗：0.5ms
     *
     * 高速率时（40+ WPM）点只有 20~27ms，1ms 窗的判决误差达 5%，
     * 足以把点误判为划。0.5ms 窗把误差减半。
     */
    this.envWin = Math.max(1, Math.round(sampleRate * 0.0005));
    /** 累积缓冲：收集一个窗的样本 */
    this.buf = new Float32Array(this.envWin);
    this.bufIndex = 0;
    this.sumSquares = 0;

    /** 当前段状态 */
    this.signalOn = false;
    this.runSamples = 0;
    /** 阈值相关 */
    this.peak = 0.05;
    this.noiseFloor = 0.005;
    this.onRatio = 0.35;
    this.offRatio = 0.6;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'config') {
        if (typeof msg.onRatio === 'number') this.onRatio = msg.onRatio;
        if (typeof msg.offRatio === 'number') this.offRatio = msg.offRatio;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      this.sumSquares += v * v;
      this.buf[this.bufIndex++] = v;
      this.runSamples++;

      if (this.bufIndex >= this.envWin) {
        // 一个包络窗算完
        const rms = Math.sqrt(this.sumSquares / this.bufIndex);
        this.sumSquares = 0;
        this.bufIndex = 0;

        // 自适应阈值
        if (rms > this.peak) this.peak = rms;
        this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
        const thr = Math.max(
          0.02,
          Math.min(
            0.6,
            Math.max(this.noiseFloor * 2.5, this.peak * this.onRatio),
          ),
        );

        // 定期上报电平（每 10 个窗约 10ms）
        this.levelCounter = (this.levelCounter || 0) + 1;
        if (this.levelCounter % 10 === 0) {
          this.port.postMessage({ type: 'level', rms });
        }

        const wasOn = this.signalOn;
        if (!wasOn && rms > thr) {
          // 上升沿：结束静音段
          this.signalOn = true;
          if (this.runSamples > 0) {
            this.port.postMessage({
              type: 'run',
              on: false,
              samples: this.runSamples,
            });
          }
          this.runSamples = 0;
        } else if (wasOn && rms < thr * this.offRatio) {
          // 下降沿：结束信号段
          this.signalOn = false;
          if (this.runSamples > 0) {
            this.port.postMessage({
              type: 'run',
              on: true,
              samples: this.runSamples,
            });
          }
          this.runSamples = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('morse-level-processor', MorseLevelProcessor);
