# 摩斯电码调制解调 App — 技术分析报告

> 生成时间：2026-10-23
> 工作目录：`D:\DSH\莫斯电码调制解调`
> 状态：**可行性分析完成，所有关键构建链路已实测通过**

---

## 一、需求拆解

| # | 需求 | 关键点 | 难度 |
|---|------|--------|------|
| 1 | 输入文字 → 生成音频 | 文本→码表→时序包络→音频波形 | 中 |
| 2 | 导入音频 → 翻译出文字 | 音频解码→包络→游程→码表→文本 | **高** |
| 3 | 支持多种语言 | 每种语言一套字符↔电码映射表 | 中（数据量大） |
| 4 | PC 端 | Windows 桌面应用 | 中 |
| 5 | 安卓端 | APK，可安装 | 中 |

**核心难点是 #2**：音频反解不是"查表反转"，需要真正的信号处理（包络提取、阈值判决、游程解析）。#3 的难点不在编码逻辑，而在**码表数据的获取与组织**。

---

## 二、环境探测结果（已实测）

### ✅ 可用组件

| 组件 | 版本 | 状态 | 备注 |
|------|------|------|------|
| Node.js | v25.2.1 | ✅ | |
| npm | 11.6.2 | ✅ | |
| pnpm | 11.28.5 | ✅ | DSH 内置 |
| JDK 17 | 17.0.12 | ✅ | `C:\Program Files\Java\jdk-17` |
| **JDK 21** | 21.0.10 | ✅ | **Android Studio 自带 JBR**，Capacitor 8 必需 |
| Android SDK | platform 34 / 36 / 36.1 | ✅ | 需补装 platform-36 |
| Android Build-Tools | 34.0.0 / 36.0.0 | ✅ | |
| Android cmdline-tools | 23.0 | ⚠️ **原本损坏** | 缺 `lib/` 目录，已修复重装 |
| Rust | 1.98.1 | ✅ | 备用方案（备选） |
| MSVC | VS 2022 Community + 18 BuildTools | ✅ | |
| WebView2 Runtime | 135.0.3179.54 | ✅ | Electron 依赖 |
| Python | 3.9.13 | ✅ | 辅助工具 |

### ❌ 不可用 / 受限

| 资源 | 问题 | 应对 |
|------|------|------|
| `services.gradle.org` | 超时 | 改用 `mirrors.cloud.tencent.com/gradle` ✅ |
| `raw.githubusercontent.com` | 超时 | 改用 `cdn.jsdelivr.net/gh` ✅ |
| `github.com/.../releases/download` | 直连超时 | 改用 `registry.npmmirror.com/-/binary` ✅ |
| Wikipedia（zh/en/ja） | 全部超时 | 改用 npm / GitHub API / jsdelivr ✅ |
| `dl.google.com/dl/android/maven2` 根路径 | 404（正常，路径需精确） | 精确路径 200 ✅ |
| crates.io 根路径 curl | 403（正常） | `cargo fetch` 正常 ✅ |
| Flutter / Gradle CLI | 未安装 | 用 Gradle Wrapper ✅ |
| Android 模拟器 AVD | 未创建 | 需 `system-images` 才能建 AVD（可选） |
| NDK | 未安装 | **Capacitor 纯 WebView 方案不需要** |

---

## 三、构建链路实测（全部已验证）

### 3.1 PC 端 — Electron ✅

```
npm i electron@45           → 需 ELECTRON_MIRROR=npmmirror（直连 GitHub 超时）
npx electron-builder --win  → ✅ dist/win-unpacked/etest.exe  (打包成功)
```
- electron-builder 需 `ELECTRON_BUILDER_BINARIES_MIRROR`（nsis 打包阶段）
- 直接出 `.exe`（绿色版）；NSIS 安装包需验证

### 3.2 安卓端 — Capacitor 8 ✅

```
npx cap add android                → ✅
./gradlew assembleDebug            → ✅ BUILD SUCCESSFUL
                                     app-debug.apk (4.1 MB)
```
验证细节：
- APK 属性：`minSdkVersion 24` / `targetSdkVersion 36` / `compileSdk 36`
- **必须用 JDK 21**，JDK 17 会报 `无效的目标发行版: 21`
- Gradle wrapper 必须改指腾讯镜像，否则超时
- Maven 依赖走 `maven.aliyun.com` 镜像（写入 `~/.gradle/init.gradle`）

### 3.3 核心 DSP — 摩斯编解码往返 ✅

已用真实 DSP 管线验证（`Otsu 阈值 + 中值滤波 + 游程解析`）：

| 测试维度 | 结果 |
|---------|------|
| WPM 8 / 12 / 18 / 25 / 35 / 45 | ✅ 全通过 |
| 音高 400 / 600 / 800 / 1000 / 1400 Hz | ✅ 全通过 |
| 采样率 8k / 11.025k / 16k / 22.05k / 44.1k | ✅ 全通过 |
| 噪声 5% → 65% | ✅ 全通过 |
| 幅值 0.9 → 0.01 | ✅ 全通过 |
| 组合场景（噪声+低幅值） | ⚠️ 极端组合失败（超实用范围） |

**总通过率 15/18 (83%)，纯音/单因素场景 100%。**

### ⚠️ 开发过程中实测发现的 3 个真实 Bug（已修正，务必避免重犯）

1. **游程检测丢失 OFF 段** → 只解出 "E"。修复：必须同时记录 ON 和 OFF 游程，否则无法区分「码内间隔(1单位)」「字符间隔(3单位)」「词间隔(7单位)」。
2. **游程收尾逻辑写错** → `on && !cur` 分支后未把段推入数组，首个 ON 被跳过。
3. **固定阈值 0.15** → 低音量/高噪声全废。修复：改用 **Otsu 双峰阈值 + 中值滤波(窗口3)**，这是决定性改进（噪声 25%→65% 全过）。

---

## 四、多语言码表数据源（关键结论）

### ✅ 已确认可用

| 语言 | 数据源 | 规模 | 授权 |
|------|--------|------|------|
| **中文（大陆）** | npm `chinese-telegraph-code` → `data/cn.csv` | 7,078 字 | MIT（源自 Unicode Unihan `kMainlandTelegraph`） |
| **中文（台/港）** | 同上 → `data/tw.csv` | 9,024 字 | MIT（`kTaiwanTelegraph`） |
| 英/拉丁/数字/标点 | 内建 ITU 标准表 | 26+10+18 | 公开 |
| 俄语（西里尔） | 需自建 | ~33 | 公开标准 |
| 日语（和文电码） | 需自建 | ~90 | 公开标准 |

**已实测**：`npm pack chinese-telegraph-code` 成功，`cn.csv` 7079 行、格式 `code,character,codepoint`。

### ⚠️ 重要发现

- npm 上 `@ozdemirburak/morse-code-translator` **只支持拉丁字母**（实测 `characters()` 仅 12 个 ASCII 键），**不可用于多语言**
- Wikipedia / raw.githubusercontent 在本网络不可达 → 数据需通过 npm、jsdelivr 或 GitHub API 获取
- 参考实现：`manh2303code/morsedesk`（架构优秀：`lm/alphabet.py` 码表抽象、`lm/langid.py` 语言识别、`lm/ngram.py` 纠错），可作为设计参考

### 补充数据获取路径（已验证连通）
```
npm pack chinese-telegraph-code              → ✅
https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>  → ✅
https://api.github.com/search/repositories   → ✅
https://registry.npmmirror.com               → ✅
https://mirrors.cloud.tencent.com/gradle     → ✅
https://maven.aliyun.com/repository/...     → ✅
```

---

## 五、技术架构建议

### 5.1 总体选型

```
┌─────────────────────────────────────────────┐
│  共享核心层 (TypeScript, 纯逻辑, 零平台依赖)  │
│  ├─ codes/          多语言码表 (JSON)         │
│  ├─ morse-encode.ts 文本 → 时序包络            │
│  ├─ morse-decode.ts 包络 → 文本 (Otsu+游程)   │
│  ├─ audio-io.ts     WAV 编解码 / 音频转换      │
│  └─ langid.ts       语言自动识别               │
└──────────────┬──────────────────┬───────────┘
               │                  │
     ┌─────────▼────────┐  ┌──────▼──────────┐
     │  PC: Electron    │  │ Android: Capacitor│
     │  React + Vite    │  │ React + Vite      │
     │  桌面壳          │  │ WebView 壳 + APK   │
     └──────────────────┘  └──────────────────┘
```

**核心层用纯 TypeScript 实现，PC/安卓共享同一份代码** —— 这是降低工作量与保证两端一致性的关键。

### 5.2 关键设计决策

| 决策 | 理由 |
|------|------|
| **不用 Tauri** | Rust 需 NDK + Android 交叉编译链（本机 NDK 缺失，sdkmanager 新版 CLI 行为不稳）；Electron/Capacitor 已全程验证通过 |
| **纯前端 DSP，不依赖 WASM** | 算法已实测 83% 通过率，零依赖、零体积、易移植 |
| **Web Audio API** | `OfflineAudioContext` 渲染 + `decodeAudioData` 解码，Electron 与 Android WebView **原生支持**，无需 lamejs 等库 |
| **Capacitor 8** | 需 JDK 21；API 36 / minSdk 24，覆盖 99%+ 设备 |
| **Electron 45** | 打包链路已实测通过 |
| **码表 JSON 自建** | 现成 npm 包不支持多语言；需自建统一 schema |

### 5.3 码表统一 Schema（建议）

```jsonc
{
  "id": "zh-CN",
  "name": "中文电码（大陆）",
  "type": "telegraph",      // telegraph | morse | wabun
  "direction": "bidirectional",
  "version": "1.0.0",
  "source": "Unicode Unihan kMainlandTelegraph",
  "license": "MIT",
  "entries": {
    "中": "0022",
    "国": "0948",
    "人": "0086"
  },
  "reverse": { "0022": "中", "0948": "国", "0086": "人" }
}
```

对摩斯码表，`entries` 的值为 `.--.` 这样的点划串；对中文电码，为 4 位数字。

---

## 六、音频处理流水线

### 编码（文本 → 音频）
```
文本 → 码表映射 → 摩斯时序 (dot=1u, dash=3u, 码内1u, 字符3u, 词7u)
     → 离线渲染 OfflineAudioContext(正弦波 + 包络)
     → WAV(PCM 16bit) / MP3 / OGG 导出
```
- 建议导出 **WAV（保真、无损）+ MP3（体积）** 双格式
- 可调参数：WPM(5–40)、音高(400–1200Hz)、音量、波形(正弦/方波)

### 解码（音频 → 文本）
```
导入音频 → decodeAudioData → 重采样至 16k
   → RMS 包络 (5ms 窗) → 中值滤波(窗口3) → Otsu 阈值
   → ON/OFF 游程提取 → 点划判定(短/长) → 字符/词分隔
   → 码表反查 → 文本
```
**实测通过的鲁棒性**：WPM 8–45、频率 400–1400Hz、采样率 8k–44.1k、噪声至 65%、幅值至 0.01。

---

## 七、待办与风险

### 🟡 需在实现阶段处理

1. **MP3 导出**：`@breezystack/lamejs`（ESM 导入可用，实测输出 1044 字节有效 MP3）；`lamejs@1.2.1` 原版有 `MPEGMode is not defined` bug，**必须用前者**
2. **录音功能（可选）**：Android 需 `RECORD_AUDIO` 权限 + `capacitor-voice-recorder`
3. **文件导入**：PC 用 `<input type=file>`；Android 用 `@capawesome/capacitor-file-picker`（v8.1.1）
4. **WebView2 运行时**：PC 端需确认目标机器已装（当前机器 135.0.3179.54 ✅）
5. **安装包（NSIS）**：未实测，需 `ELECTRON_BUILDER_BINARIES_MIRROR`
6. **中文电码 ↔ 摩斯码的区别**：中文电码是 4 位数字商业码，不是摩斯点划；UI 需明确区分两种编码体系

### 🟢 无重大风险

- 两端构建链路已全程实测打通
- 核心 DSP 已验证可行
- 中文码表数据已确认可获取（7078 + 9024 字）

---

## 八、建议实施顺序

```
阶段 1  核心库 + 单元测试（编码/解码往返 + 鲁棒性矩阵）
阶段 2  CLI/Node 验证脚本（快速迭代，不涉及 UI）
阶段 3  React UI + 码表管理（语言切换、参数调节）
阶段 4  Electron 打包（PC 可用）
阶段 5  Capacitor 打包（APK 可安装）
阶段 6  多语言码表扩充（日/俄等）
阶段 7  打磨：实时收发、录音、UI 体验
```

---

## 附：本次分析产出的可复用资产

在临时目录中已验证可用的代码/配置（可迁移至正式项目）：
- `dsp` 核心算法（encode/render/decode + Otsu + median）→ 15/18 通过
- `~/.gradle/init.gradle` → 国内 Maven 镜像配置
- Gradle wrapper 腾讯镜像改法
- `chinese-telegraph-code` 码表数据（cn.csv / tw.csv）
