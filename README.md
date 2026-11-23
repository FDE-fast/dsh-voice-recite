# DSH-人声朗诵 (dsh-voice-recite)

给 DeepSeek Harness 用的「人声朗诵」插件：把一段文字合成为带情绪的语音，**按时间轴精确控制时长**，能对指定文字**单独拖音、单独加颤音**，一次输出 WAV 与 MP3。

- 左侧栏独立面板，表单式操作（文本 / 音色 / 起止时间 / 输出目录 / 拖音颤音）
- 同时注册 Agent 工具 `recite`，可以直接让 Agent 合成
- 先试听、确认后再写入目标目录
- 时长精确到采样点（WAV），MP3 受帧长限制约 36 ms

## 安装

### 方式一：插件市场（推荐）

在 DSH 的 **插件 → 发现** 里搜索 `人声朗诵` / `dsh-voice-recite` 安装。

### 方式二：从 npm

```bash
dsh plugin --profile <profile> add dsh-voice-recite
```

### 方式三：本地目录

下载仓库后，在 **插件 → 添加插件** 选择 `package` 目录，或：

```bash
dsh plugin --profile <profile> add /path/to/dsh-voice-recite
```

## 使用

1. 左侧栏点「人声朗诵」。
2. 填文本，选音色与语速/音调。
3. 「开始时间」「截止时间」填秒数（可带两位小数），**音频时长 = 截止 − 开始**，例如 `5.14` 与 `8.13` 得到 2.99 秒。
4. 输出位置可直接点「浏览…」选文件夹。
5. 「拖音文字」填要拖长的字（如 `大`），「拖音秒数」填 0.6 表示多拖 0.6 秒（填 0 则用倍数滑杆）；「颤音文字」可填另一个字（如 `了`）并调颤音深度。
6. 点「试听」先听，满意后点「确认输出」才写入目录。

Agent 调用示例：

```js
recite({
  text: "老大，我摔倒了。",
  voice: "zh-CN-XiaoyiNeural",
  startTime: 5.14, endTime: 8.13,
  outputDir: "C:\\Users\\me\\Desktop\\out",
  dragText: "大", dragSeconds: 0.6,
  vibratoText: "了", vibrato: 12,
})
```

## 参数

| 参数 | 说明 |
|---|---|
| `text` | 要朗读的文本 |
| `voice` | Edge 音色短名，默认 `zh-CN-XiaoyiNeural` |
| `startTime` / `endTime` | 秒；时长 = end − start |
| `outputDir` | 输出目录（绝对路径） |
| `dragText` / `elongate` / `dragSeconds` | 要拖长的文字；倍数或「多拖几秒」，`dragSeconds>0` 时优先 |
| `vibratoText` / `vibrato` | 要加颤音的文字与深度（音分） |
| `tailVibrato` / `tailFall` | 整句句尾的颤音与音高下坠 |
| `rate` / `pitch` | 语速与音调，默认 `-25%` / `+18Hz` |
| `filename` | 输出文件名（不含扩展名） |

## 工作原理

1. 用微软 Edge 神经语音（edge-tts）合成，取回 MP3 与词边界时间戳。
2. 按文字定位到具体音节，只拉伸**元音核心**（不拉辅音、不拉停顿），拖音更长也更自然。
3. 句尾做轻颤与音高下坠，模拟「委屈」的语气收尾。
4. 整体按目标时长收口：优先回收首尾留白，必要时轻微变速。
5. WAV 直接写 24 kHz PCM（精确到采样点）；MP3 用 LAME 编码到最近的一帧（32 kHz / 128 kbps）。

## 依赖与限制

- **需要联网**：合成走微软 Edge 在线语音服务。
- **需要 Python 3.10+**：插件自带 Windows/Python 3.12 的依赖；其它平台首次运行会用 `pip` 把 `engine/requirements.txt` 装到用户缓存目录。
- Edge 音色属于微软服务，使用需遵守其条款；本仓库只包含调用代码。
- MP3 帧长 36 ms，无法做到采样级精确；对时间严格的项目请用 WAV。

## 许可

MIT
