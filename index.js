/**
 * DSH-人声朗诵 host half.
 *
 * Registers:
 *  - the model-facing tool `recite` (Edge TTS + per-word elongation/vibrato + exact duration)
 *  - a small HTTP surface the browser half uses (voices, picker, generate, audio preview)
 *
 * No Harness package is imported, so the bundle resolves from the profile alone.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.join(HERE, 'engine', 'recite.py')
const VENDOR = path.join(HERE, 'engine', 'vendor')
const ROUTE = '/dsh-voice-recite'
/** Previews land in the OS temp directory so the user's folder stays clean until confirmed. */
const PREVIEW_DIR = path.join(os.tmpdir(), 'dsh-voice-recite-preview')

export const name = 'dsh-voice-recite'

export const inject = ['tools', 'webServer']

/** Curated Edge voices; values are the service short names. */
const VOICES = [
  { id: 'zh-CN-XiaoyiNeural', label: '小艺 · 少女感（推荐）', note: 'Cartoon/Lively，适合小女孩、活泼角色' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', note: 'Warm，适合旁白、温柔叙述' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 小男孩', note: 'Cute，适合儿童角色' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 青年男声', note: 'Lively/Sunshine' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 浑厚男声', note: 'Passion，适合解说' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声', note: 'Professional' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声', note: 'Dialect' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声', note: 'Dialect' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声', note: '粤语' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声', note: '台湾国语' },
]

const VOICE_IDS = VOICES.map(v => v.id)

function resolvePython(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.DSH_RECITE_PYTHON) candidates.push(process.env.DSH_RECITE_PYTHON)
  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const dir of readdirSync(runtimes)) {
      candidates.push(path.join(runtimes, dir, 'dependencies', 'python', 'python.exe'))
    }
  } catch { /* no runtimes dir */ }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Run the engine; resolves the parsed JSON report. */
function runEngine(cfg, pythonOverride, signal) {
  return new Promise((resolve, reject) => {
    const python = resolvePython(pythonOverride)
    const outDir = cfg.outputDir
    mkdirSync(outDir, { recursive: true })
    const cfgPath = path.join(outDir, `.dsh-recite-${process.pid}-${Date.now()}.json`)
    writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8')
    const env = { ...process.env, PYTHONPATH: VENDOR, PYTHONIOENCODING: 'utf-8' }
    const child = spawn(python, [ENGINE, '--config', cfgPath], { env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const cleanup = () => { try { unlinkSync(cfgPath) } catch { /* ignore */ } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 180000)
    const onAbort = () => { try { child.kill() } catch { /* ignore */ } }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', err => { clearTimeout(timer); cleanup(); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      cleanup()
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
      if (!line) {
        reject(new Error(`语音引擎没有输出（exit ${code}）${stderr ? ': ' + stderr.slice(-400) : ''}`))
        return
      }
      let parsed
      try { parsed = JSON.parse(line) } catch {
        reject(new Error(`语音引擎输出无法解析: ${line.slice(0, 300)}`))
        return
      }
      if (!parsed.ok) { reject(new Error(parsed.error || '语音生成失败')); return }
      resolve(parsed)
    })
  })
}

function describe(report) {
  const lines = [
    `已生成：${report.wav}`,
    `已生成：${report.mp3}`,
    `WAV 时长 ${report.wavSeconds}s，MP3 时长 ${report.mp3Seconds}s（音色 ${report.voice}）`,
  ]
  if (report.dragMatched) {
    lines.push(`拖音命中 ${report.dragRegionStart}s–${report.dragRegionEnd}s，多出 ${report.dragAdded}s（×${report.elongate}）`)
  }
  if (report.vibratoMatched) {
    lines.push(`颤音命中 ${report.vibratoRegionStart}s–${report.vibratoRegionEnd}s，深度 ${report.vibrato} 音分`)
  }
  if (!report.focusMatched && report.focusRequested) {
    lines.push('未在朗读文本中找到要处理的文字片段，已按原速生成')
  }
  return lines.join('\n')
}

/** Fallback folder chooser for Windows hosts whose picker capability is browse-only. */
function pickWithWindowsDialog() {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop';",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$d.ShowNewFolderButton = $true;',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join(' ')
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    const child = spawn(shell, ['-NoProfile', '-STA', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => { out += d })
    child.on('error', reject)
    child.on('close', () => resolve(out.trim() || null))
  })
}

function makeConfig(args, defaults) {
  const start = Number.isFinite(args.startTime) ? args.startTime : 0
  const end = Number.isFinite(args.endTime) ? args.endTime : 0
  return {
    text: args.text,
    voice: args.voice || 'zh-CN-XiaoyiNeural',
    rate: args.rate || '-25%',
    pitch: args.pitch || '+18Hz',
    startTime: start,
    endTime: end,
    focusText: args.focusText || '',
    dragText: args.dragText || '',
    vibratoText: args.vibratoText || '',
    elongate: Number.isFinite(args.elongate) ? args.elongate : 1.6,
    dragSeconds: Number.isFinite(args.dragSeconds) ? args.dragSeconds : 0,
    vibrato: Number.isFinite(args.vibrato) ? args.vibrato : 0,
    tailVibrato: Number.isFinite(args.tailVibrato) ? args.tailVibrato : 9,
    tailFall: Number.isFinite(args.tailFall) ? args.tailFall : 12,
    outputDir: args.outputDir || defaults.outputDir,
    basename: args.filename || 'recite',
  }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx, config = {}) {
  const defaults = {
    outputDir: config.outputDir || path.join(os.homedir(), 'Desktop', '人声朗诵'),
    pythonPath: config.pythonPath,
  }

  let pulses = 0
  let lastPulseAt = null
  let lastNote = null
  let lastRequest = null
  let picking = false

  /** Remember the last generation request so /pulse can report what the page sent. */
  const recordRequest = (cfg, report) => {
    lastRequest = {
      at: new Date().toISOString(),
      start: cfg.startTime,
      end: cfg.endTime,
      dragText: cfg.dragText,
      vibratoText: cfg.vibratoText,
      elongate: cfg.elongate,
      dragSeconds: cfg.dragSeconds,
      vibrato: cfg.vibrato,
      tailVibrato: cfg.tailVibrato,
      tailFall: cfg.tailFall,
      rate: cfg.rate,
      pitch: cfg.pitch,
      wavSeconds: report ? report.wavSeconds : null,
    }
  }

  // The directory picker is optional: a nested inject keeps this plugin active in
  // compositions without it. Its interface is a discriminated capability —
  // native exposes pick(), browse exposes list/createDirectory for an in-app browser.
  let pickerCtx = null
  ctx.inject(['directoryPicker'], (picker) => {
    pickerCtx = picker
    picker.effect(() => () => { pickerCtx = null })
  })

  ctx.tools.register({
    name: 'recite',
    description:
      '把一段文字合成为“人声朗诵”音频（微软神经网络音色），输出 WAV 与 MP3 两份文件。'
      + '总时长由截止时间减开始时间决定；可指定其中一段文字做拖音、颤音处理。'
      + 'WAV 的时长精确到采样点，MP3 受帧长限制存在不超过一帧（约 36 ms）的偏差。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'endTime'],
      properties: {
        text: { type: 'string', description: '要朗读的文本' },
        voice: { type: 'string', enum: VOICE_IDS, description: '音色；默认 zh-CN-XiaoyiNeural（少女感）' },
        startTime: { type: 'number', description: '开始时间（秒），默认 0；仅用于计算时长，可带小数，如 5.14' },
        endTime: { type: 'number', description: '截止时间（秒），必须大于开始时间；音频时长 = 截止 − 开始，如 8.13' },
        outputDir: { type: 'string', description: '输出目录（绝对路径）；省略时用插件默认目录' },
        focusText: { type: 'string', description: '旧参数：同一段文字同时用于拖音和颤音；优先用 dragText / vibratoText' },
        dragText: { type: 'string', description: '要拖音的文字片段，须出现在 text 中，如“大”' },
        vibratoText: { type: 'string', description: '要加颤音的文字片段，可与 dragText 不同，如“了”' },
        elongate: { type: 'number', description: 'dragText 的拖音倍数，1 为不变，1.3–2 为明显拖长' },
        dragSeconds: { type: 'number', description: '按秒指定拖音时长（大于 0 时覆盖 elongate），例如 0.6 表示把该字多拖 0.6 秒' },
        vibrato: { type: 'number', description: 'vibratoText 的颤音深度（音分，约 6–20 自然）' },
        rate: { type: 'string', description: '语速，如 -25%；默认 -25%（慢速更委屈）' },
        pitch: { type: 'string', description: '音调，如 +18Hz；默认 +18Hz（偏高更像小孩）' },
        tailVibrato: { type: 'number', description: '句尾整体颤音深度（音分，0–20，默认 9）' },
        tailFall: { type: 'number', description: '句尾音高下坠（音分，0–20，默认 12）' },
        filename: { type: 'string', description: '输出文件名（不含扩展名），默认 recite' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          wav: { type: 'string' },
          mp3: { type: 'string' },
          wavSeconds: { type: 'number' },
          mp3Seconds: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    async execute(args, exec) {
      const cfg = makeConfig(args, defaults)
      if (!(cfg.endTime > cfg.startTime)) throw new Error('截止时间必须大于开始时间')
      cfg.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
      const report = await runEngine(cfg, defaults.pythonPath, exec.signal)
      report.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
      return report
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const rest = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')
      try {
        if (req.method === 'GET' && rest === 'voices') {
          sendJson(res, 200, { voices: VOICES, outputDir: defaults.outputDir })
          return
        }
        if (req.method === 'GET' && rest === 'audio') {
          const target = url.searchParams.get('path') || ''
          const ext = path.extname(target).toLowerCase()
          if (!target || !['.wav', '.mp3'].includes(ext) || !existsSync(target) || !statSync(target).isFile()) {
            sendJson(res, 404, { error: 'not found' })
            return
          }
          const type = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav'
          res.writeHead(200, {
            'content-type': type,
            'content-length': statSync(target).size,
            'cache-control': 'no-store',
          })
          createReadStream(target).pipe(res)
          return
        }
        if (req.method === 'GET' && rest === 'pick') {
          if (picking) { sendJson(res, 429, { error: '已经有一个选择窗口打开了' }); return }
          picking = true
          try {
            let capability = null
            try { capability = pickerCtx ? pickerCtx.directoryPicker.capability() : null } catch { capability = null }
            if (url.searchParams.get('dry') === '1') {
              sendJson(res, 200, {
                capability: capability ? capability.kind : null,
                methods: capability ? Object.keys(capability) : [],
              })
              return
            }
            if (capability && capability.kind === 'native') {
              const chosen = await capability.pick(new AbortController().signal)
              sendJson(res, 200, { path: chosen || null, source: 'native' })
              return
            }
            if (process.platform === 'win32') {
              const chosen = await pickWithWindowsDialog()
              sendJson(res, 200, { path: chosen || null, source: 'windows-dialog' })
              return
            }
            sendJson(res, 501, { error: '当前组合只有浏览式选择器，只能手填路径' })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          } finally {
            picking = false
          }
          return
        }
        if (req.method === 'GET' && rest === 'pulse') {
          if (url.searchParams.get('from') === 'client') {
            pulses += 1
            lastPulseAt = new Date().toISOString()
            const note = url.searchParams.get('note')
            if (note) lastNote = note
          }
          sendJson(res, 200, { pulses, lastPulseAt, lastNote, lastRequest })
          return
        }
        if (req.method === 'POST' && rest === 'preview') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const cfg = makeConfig(body, defaults)
          if (!(cfg.endTime > cfg.startTime)) {
            sendJson(res, 400, { error: '截止时间必须大于开始时间' })
            return
          }
          cfg.outputDir = PREVIEW_DIR
          cfg.basename = 'preview'
          cfg.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
          const report = await runEngine(cfg, defaults.pythonPath)
          recordRequest(cfg, report)
          report.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
          report.preview = true
          sendJson(res, 200, report)
          return
        }
        if (req.method === 'POST' && rest === 'commit') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const wav = typeof body.wav === 'string' ? body.wav : ''
          const mp3 = typeof body.mp3 === 'string' ? body.mp3 : ''
          const inside = file => {
            const dir = path.dirname(path.resolve(file))
            return dir === path.resolve(PREVIEW_DIR)
          }
          if (!wav || !mp3 || !inside(wav) || !inside(mp3) || !existsSync(wav) || !existsSync(mp3)) {
            sendJson(res, 400, { error: '预听文件不存在，请重新试听' })
            return
          }
          const outDir = body.outputDir || defaults.outputDir
          const base = String(body.filename || 'recite').replace(/[\\/:*?"<>|]/g, '_').trim() || 'recite'
          mkdirSync(outDir, { recursive: true })
          const finalWav = path.join(outDir, base + '.wav')
          const finalMp3 = path.join(outDir, base + '.mp3')
          copyFileSync(wav, finalWav)
          copyFileSync(mp3, finalMp3)
          sendJson(res, 200, { wav: finalWav, mp3: finalMp3 })
          return
        }
        if (req.method === 'POST' && rest === 'generate') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const cfg = makeConfig(body, defaults)
          if (!(cfg.endTime > cfg.startTime)) {
            sendJson(res, 400, { error: '截止时间必须大于开始时间' })
            return
          }
          cfg.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
          const report = await runEngine(cfg, defaults.pythonPath)
          recordRequest(cfg, report)
          report.focusRequested = Boolean(cfg.dragText || cfg.vibratoText || cfg.focusText)
          sendJson(res, 200, report)
          return
        }
        sendJson(res, 404, { error: 'unknown route' })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-voice-recite: http surface')
}

export { VOICES }
