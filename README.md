# 摩斯电码 · 调制解调

> 输入文字生成音频，导入音频翻译出文字。
> 支持多语言码表，同时提供 **Windows 桌面版** 与 **Android APK**。

![version](https://img.shields.io/badge/version-1.0.0-blue) ![tests](https://img.shields.io/badge/tests-63%20passed-green) ![verify](https://img.shields.io/badge/verify-71%2F71-green)

---

## 功能

| 页面 | 能力 |
|------|------|
| **调制** | 输入文字 → 摩斯码 → 音频。可调 WPM(5–40)、音高(300–1400Hz)、音量、波形（正弦/方波/三角）。实时播放 + 导出 WAV。信号带可视化。 |
| **解调** | 导入音频（wav/mp3/ogg/m4a/flac）→ 摩斯码 → 文字。自适应 Otsu 阈值抗噪，显示置信度、实测 WPM、点长、信号游程。 |
| **实时** | 麦克风实时监听并边收边出字；或录制一段音频后解码。含电键练习器。 |
| **码表** | 浏览/搜索每张码表，查看字符↔电码对应关系、来源与授权。 |

## 支持的码表（9 种）

| 码表 | 字符数 | 体系 | 数据来源 |
|------|--------|------|----------|
| 国际摩斯（拉丁） | 62 | 点划 | ITU-R M.1677-1 |
| **中英混合** | **7,140** | 点划 + 4 位数字 | 拉丁表 + 大陆中文电码合并 |
| **中文电码（大陆）** | **7,078** | 4 位数字 | Unicode Unihan `kMainlandTelegraph` |
| **中文电码（台湾/香港）** | **9,024** | 4 位数字 | Unicode Unihan `kTaiwanTelegraph` |
| 俄语摩斯（西里尔） | 32 | 点划 | ГОСТ 2.619-72 |
| 日语和文电码 | 50 | 点划 | 旧电信省「和文電信符号表」 |
| 德语摩斯 | 56 | 点划 | ITU-R M.1677-1 欧洲扩展 |
| 法语摩斯 | 58 | 点划 | ITU-R M.1677-1 欧洲扩展 |
| 西班牙语摩斯 | 56 | 点划 | ITU-R M.1677-1 欧洲扩展 |

> **中文电码 ≠ 摩斯电码**：中文电码是 4 位十进制商业电码（如「中」= `0022`），
> 发报时每个数字用标准摩斯点划发出，与汉字直接对应的摩斯码是两套体系。

### 中英混合模式

实际通联里中英混排很常见（`CQ DE 张三`、`QRZ 上海`），
不必再在两种码表之间来回切换 —— 选「中英混合」即可直接输入混排文本。

**区分机制**：拉丁字母直接发点划（1~4 个符号），汉字发 4 位电码数字
（每位数字 5 个符号，共 20 个符号）。三类间隔把它们分开：

```
码内 1u │ 字母之间 / 数字之间 3u │ 中文码组结束 5u │ 词间 9u
                                └─ 这个 5u 就是「中文标记」
```

编码端在每个中文码组之后固定发 **5u 的码组间隔**，解码端据此把 4 个数字
聚成一组查表得到汉字；字母之间只有 3u，因此不会被误聚。

| 输入 | 发出的摩斯 | 说明 |
|------|-----------|------|
| `CQ DE 张三` | `-.-./--.- \| -../. \| .----/--.../..---/---../-----/-----/-----/.....` | 张=1727 三=0005 |
| `中A` | `-----/-----/..---/..---/.-` | 中=0022 + A |
| `HELLO 世界` | `...././.-../.-../--- \| -----/-----/.----/...--/...--/----./...../....-` | 世=4431 界=0964 |

> 数字与字母码长不同（数字恒 5 符号、字母最多 4 符号），加上 5u 码组间隔，
> 两者在结构上不会混淆。实测两表零字符冲突、零码值冲突。

---

## 快速开始

```bash
npm install

npm run dev          # 开发服务器
npm test             # 单元测试（63 项）
npm run verify       # 完整验证矩阵（71 项）
npm run typecheck    # 类型检查
```

### 打包 Windows 桌面版

```bash
npm run electron:dist
# 产物：release/MorseCodec-1.0.0-setup.exe   （NSIS 安装包）
#       release/win-unpacked/MorseCodec.exe  （绿色版）
```

### 打包 Android APK

```bash
npm run android:apk
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

> **构建环境要求**
> - JDK **21**（Capacitor 8 要求；JDK 17 会报「无效的目标发行版: 21」）
>   本机可用 `C:\Program Files\Android\Studio\jbr`
> - Android SDK platform 36 / build-tools 36
> - **国内网络**需把 Gradle 分发包与 Maven 依赖指向镜像（已配好，见下）

## 安卓端麦克风权限（实时监听）

Android 6.0+ 需要**运行时权限**，且 WebView 媒体请求还有第二道锁。三处都已处理：

| 环节 | 实现 |
|------|------|
| Manifest 声明 | `RECORD_AUDIO` + `uses-feature microphone`（非必需） |
| 运行时申请 | 自定义原生插件 `MorsePermissions`（`PermissionPlugin.java`），进入页面即检查 + 申请 |
| WebView 媒体请求 | 覆写 `onPermissionRequest`，只校验 `RECORD_AUDIO` |

### 为什么不直接用官方 Permissions 插件

Capacitor 8 **移除了** `@capacitor/permissions`（npm 上无 v8 版本），
因此用原生 API 自行实现了最小可用的权限查询/申请能力。

### MODIFY_AUDIO_SETTINGS 是必需的

Android 录音除了 `RECORD_AUDIO`（运行时权限），还需要
`MODIFY_AUDIO_SETTINGS`（normal 保护级别，**在 Manifest 声明即可**）。

缺少它时 `AudioRecord.start()` 抛 `SecurityException`，
WebView 把它表现为 `getUserMedia` 的 **`NotReadableError`** ——
即使运行时权限已授予、`permissionState` 显示 `granted` 也一样。

> 这正是真机上「提示麦克风被占用或设备无音频输入」的原因。

### 为什么需要覆写 onPermissionRequest

Capacitor 8 的 `BridgeWebChromeClient.onPermissionRequest` 在申请音频采集时会同时请求
`MODIFY_AUDIO_SETTINGS`。该权限属于 **normal 保护级别**，不是运行时权限，
系统既不会授予也不在可请求列表中。而 Capacitor 的回调逻辑是
「所有请求项都必须 granted」，于是 `MODIFY_AUDIO_SETTINGS` 永远返回 `false`，
触发 `request.deny()` —— **即使用户已授权麦克风，`getUserMedia` 仍抛 `NotAllowedError`**。

`MainActivity` 中通过 `webView.setWebChromeClient(...)` 覆写该方法，只检查
真正需要运行时授权的 `RECORD_AUDIO`。

### 采集策略与诊断

`getUserMedia` 采用多级回退，兼容不同 ROM 的挑剔要求：

1. `{ audio: true }`
2. 关闭 `echoCancellation` / `noiseSuppression` / `autoGainControl`
3. 显式指定 `sampleRate: 44100, channelCount: 1`
4. 枚举设备后逐个用 `deviceId` 指定

实时页还提供 **「🔍 麦克风诊断」** 按钮，输出平台、安全上下文、权限状态、
输入设备列表等信息，便于快速定位真机问题。

---

## 安卓端电键练习

手键面板使用 **Pointer Events** 为主、**传统 TouchEvent** 为辅的双事件方案：

- `touch-action: none` —— 消除安卓的 300ms 点击延迟与滚动干扰
- `-webkit-touch-callout: none` + `user-select: none` —— 防止长按弹出文本选择菜单
- `setPointerCapture` —— 手指滑出面板也能正确释放（不会卡在发声状态）
- 同步标志位 `keyActiveRef` —— 防止 `press()` 异步等待期被连点穿透

面板实时显示**按压时长**（如「发送中 826 ms」），短按=点、长按=划。

### 点划判定与实时反馈

光有按压时长，用户并不知道自己按的**到底是点还是划、节奏准不准**。
因此每次松手立即给出判定：

| 反馈项 | 说明 |
|--------|------|
| 点 / 划符号 | 大号 `·` 或 `—`，配文字「点」「划」 |
| 准确度评级 | **准确**（偏差 ≤20%）/ **基本正确** / **节奏不稳**（落在模糊区） |
| 实测 vs 标准 | 如「398 ms · 标准 400ms · 偏差 1%」 |
| 当前码字 | 累积的点划串，如 `-.-.` |
| 已解出字符 | 每个字符下方标注其码字，如 `C` / `-.-.` |
| 统计 | 速度 WPM、单位时长、按键次数、不稳次数 |

判定逻辑在 `src/core/key-practice.ts`（`KeyPracticer`），与麦克风解码器分开 ——
手键是精确的按键事件，没有噪声与包络模糊，可以做得更准。

**难点是用户自己的发报速度未知**，因此在线学习 1 单位：

1. 前 **4 段**样本取**最小值**作 1u（一段发报里必然至少有一个点）
2. 之后每次按键按符号类型折算回 1u，用 0.35 的平滑系数跟踪

> **为什么必须缓冲前 4 段**：早期版本「第一下就当 1u」，若第一下是划（3u），
> 基准被放大 3 倍，之后所有划都恰好等于 1.0u，被判成「准确的点」，
> 整段全错 —— 且因为 `ratio ≈ 1` 落在正常区间，自愈逻辑也救不回来。

停顿 **3u** 自动切分字符；停顿不足则继续累积。实测 ±12% 人手抖动下
仍能完整还原 `CQTEST`。

### 延迟优化

实测（Android WebView）：首次 `new AudioContext()` 需 **130~290 ms**。
若等到「按下」时才创建，这段延迟会让按键手感非常迟钝。

优化措施：

| 措施 | 效果 |
|------|------|
| 页面加载后**预热**音频管线（建 AudioContext + 常驻振荡器） | 把 130~290ms 挪到页面加载期 |
| 常驻振荡器，按键只改 `gain` | 按键路径 **0 ms**（实测 0.0~0.3ms） |
| `latencyHint: 'interactive'` | 申请最小输出缓冲 |
| `pressNow()` 同步接口 | 预热完成后完全同步，不经过 Promise 微任务 |
| 首次交互（pointerdown/touchstart）时再次预热 | 兼容需手势才能启动 AudioContext 的 WebView |

> 实测（真实 ADB 触摸）：`按下 → 状态生效` 延迟 **5.3ms → 1.7ms → 1.5ms**；
> 音频增益启动延迟 **0.0~0.3ms**。

**关于无法消除的部分**：Android WebView 的音频输出有系统级固有延迟
（实测 `baseLatency` ≈ 90ms、`outputLatency` ≈ 200ms）。
这是 WebView 音频栈的行为，任何纯 WebView 应用都无法突破；
若要进一步降低需改用原生 `AudioTrack`（放弃跨端共享）。

---

### 实时接收的技术要点

实时解码在 Android WebView 上有一系列特殊约束，实现时都做了处理：

| 问题 | 实测数据 | 解决 |
|------|---------|------|
| `requestAnimationFrame` 被降频 | 模拟器仅 **1 Hz**（真机 ~60Hz） | 改用 AudioWorklet 固定速率采样 |
| ScriptProcessor 回调块不连续 | 1.2 秒音频只收到 51200/57600 样本 | 改用 AudioWorklet |
| AudioWorklet 消息队列丢包 | 375 次/秒时丢 **12.7%**，降到 11.7 次/秒仍丢 3.3% | **在 worklet 内部完成判决**，只发送「已完成的段」 |
| 丢包导致块边界错位 | 67ms 的点被算成 **172ms** | 段长用**采样点计数**，不依赖时间戳 |
| `MODIFY_AUDIO_SETTINGS` 未声明 | `NotReadableError` | Manifest 补声明（normal 权限） |
| Capacitor `onPermissionRequest` 请求了 normal 权限 | 权限已授予仍 `NotAllowedError` | 覆写该方法，只校验 `RECORD_AUDIO` |
| 首个 mark 因起始淡入偏短 | 57ms vs 正常 66.5ms | 单位估计用**簇内 25 分位数**，且需 ≥8 个样本才校准 |
| 单位估计被异常段污染 | 单位在 66ms 与 31ms 间跳变 | 单位**校准后锁定**，不再随新样本变化 |
| 数字电码的 3u 簇样本更多 | 1u 簇 count=2、3u 簇 count=3 | 单位取**最小簇**（1u 必然最小），不按 count 筛选 |

### 真机麦克风的额外三个坑

上面那些修完之后，模拟器上全对，但**真机仍然几乎无法解码**。继续排查发现是
worklet 判决逻辑对真实信号的三个错误假设：

| 错误假设 | 真机实测后果 | 修复 |
|---------|-------------|------|
| 开头是静音，可用「窗口最小包络」当噪声底 | 点「开始监听」时对方已在发报，取到 0.5186（真实静音 0.0002）→ 门限 0.75 高于信号峰值 0.73 → **完全失聪** | 噪声底从 0 起步，靠「快降慢升」非对称跟踪自行收敛 |
| `peak` 只升不降 | 一次突发噪声（关门/放下手机）后门限永久过高 | `peak` 以 1.2s 时间常数衰减，且不低于当前包络 |
| 门限有绝对下限 0.02 | 手机离音箱稍远，信号 RMS 仅 0.01 → 永远低于门限 | 门限完全由 `[噪声底, 信号峰]` 动态范围按比例插值 |

另外两处：

- **包络窗不能短于一个音频周期**。原来用 0.5ms 窗，而 600Hz 周期是 1.67ms，
  RMS 随相位剧烈起伏，一个划会在中途掉到门限下被切成几段。
  改为对 `x²` 做一极点平滑（攻击/释放各 1.5ms），天然跨多个周期平均。
- **突发噪声会合并相邻符号**。300ms 的噪声把两个划之间的 1u 间隔填满，
  合并出一个 435ms 的段（正常划 200ms）。现在 worklet 检测「段长远超正常划」
  时整段丢弃并发 `noise` 消息，主线程随之丢弃当前码字 —— **宁可少字符，不要乱码**。

**真机验证**（Android 9 / API 28，WebView 内实测）：

```
worklet 段输出:  ON:204 off:63 ON:71 off:63 ON:204 off:63 ON:71 off:196 ...
                 ↑划   ↑间隔 ↑点   ↑间隔  ↑划          ↑点   ↑字符间隔
期望值:          200    67     67    67     200          67    200
```

音量低至 0.012、背景噪声 0.05、突发噪声、12~25 WPM 均能正常解码。

**最终验证**（Android 模拟器 API 34，WebView 内实测）：

```
worklet 段输出:  off:31 ON:57 off:66.5 ON:200 off:67 ON:199.5 ...
单位估计:        66.5 ms（= 18 WPM，精确）
解码码字:        .--.  .-  .-.  ..   ← P A R I，完全正确
```

> **40+ WPM 属已知限制**：此时点仅 20~22ms，与码内间隔几乎等长，
> 超出 0.5ms 包络窗的判决能力。10~35 WPM（实际通联的全部范围）均正常。

---

## 音频导出位置

| 平台 | 位置 | 说明 |
|------|------|------|
| **Windows** | 原生「另存为」对话框选定的位置 | 菜单 `文件 → 导出 WAV…`（Ctrl+S） |
| **Android** | 应用缓存目录 `cache/morse-<码表>-<随机>.wav` | 导出后自动调起**系统分享面板**，可保存到「下载 / 音乐 / 文件」或直接发送 |

Android 端通过 Capacitor 原生插件（`@capacitor/filesystem` + `@capacitor/share`）实现：
写入应用私有缓存目录 → 生成 `content://` URI → 调起系统分享面板。
用户选择目标位置后文件即落到「下载」等公共目录。

> 实测（Android 模拟器 API 34）：文件真实落盘 825,646 字节，
> WAV 头为标准 `RIFF/WAVE/fmt /data`，PCM 44.1kHz 单声道 16-bit。

---

```
src/
  core/                     纯逻辑核心层（零平台依赖，PC/安卓共享）
    types.ts                类型定义
    codebook.ts             码表构建与查表
    encoder.ts              文本 → 摩斯时序
    decoder.ts              音频 → 文本（离线 DSP）
    realtime.ts             实时边沿解码器
    audio-io.ts             波形渲染 / WAV 编解码 / 重采样
    codebooks/              各语言码表
      generated/            由 scripts/build-codes.ts 生成（中文电码）
  ui/                       React 界面
    App.tsx                 主框架与设置持久化
    panels/                 调制 / 解调 / 实时 / 码表
    components/             摩斯码渲染、波形图
    platform/
      web-audio.ts          Web Audio 封装（播放/录音/解码）
      desktop-bridge.ts     Electron 原生能力桥接
electron/
  main.cjs                  Electron 主进程（菜单、文件对话框）
  preload.cjs               预加载（contextBridge 暴露最小能力）
scripts/
  verify.ts                 验证矩阵脚本
  build-codes.ts            中文电码表构建脚本
tests/                      vitest 单元测试
```

---

## 技术要点

### 解码流水线（离线）

```
音频 → decodeAudioData → RMS 包络(5ms窗)
     → 中值滤波(窗口3) → Otsu 双峰阈值
     → ON/OFF 游程提取 → 亚帧边界插值
     → 点划判定 → 字符/码组/词三级分隔
     → 码表反查 → 文本
```

**实测鲁棒性**（`npm run verify` 全部通过）：

| 维度 | 范围 | 结果 |
|------|------|------|
| 速度 | 8 / 12 / 18 / 25 / 35 / 45 WPM | ✅ |
| 音高 | 400 – 1400 Hz | ✅ |
| 采样率 | 8k / 11.025k / 16k / 22.05k / 44.1k | ✅ |
| 白噪声 | 5% – 65% | ✅ |
| 音量 | 0.9 – 0.01 | ✅ |
| 波形 | 正弦 / 方波 / 三角 | ✅ |

### 实时解码

边沿检测 + 增量解析。关键设计：

- **单位（unit）估计**取所有时长的低分位数（码内间隔恒为 1u，数量充足），
  比任何单点估计稳健
- **首个 mark 缓存**：单位校准前不判定点/划，避免 10 WPM 时点被误判为划
- **亚帧精度**：用原始采样在局部阈值处二次定位边界，消除包络窗量化误差

---

## 国内网络构建配置

已内置镜像配置，克隆后可直接构建：

**Gradle 分发包**（`android/gradle/wrapper/gradle-wrapper.properties`）
```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip
```

**Maven 依赖**（`android/build.gradle` + `android/settings.gradle`）
```groovy
maven { url 'https://maven.aliyun.com/repository/google' }
maven { url 'https://maven.aliyun.com/repository/public' }
```

**Electron 二进制**
```bash
export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
```

**非 ASCII 路径**（`android/gradle.properties`）
```properties
android.overridePathCheck=true
```

---

## 许可与数据来源

- 核心代码：MIT
- 中文电码数据：Unicode Unihan（Unicode License），经 npm 包
  [`chinese-telegraph-code`](https://www.npmjs.com/package/chinese-telegraph-code)（MIT）分发
- 日语和文码表：旧日本电信省「和文電信符号表」（公有领域），
  经 [jg1eic/morse_quiz](https://github.com/jg1eic/morse_quiz) 权威位编码表交叉验证
- 俄语码表：ГОСТ 2.619-72，与 `morse-decoder` 包交叉验证（31/32 一致）
