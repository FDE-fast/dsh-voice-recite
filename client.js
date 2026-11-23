/**
 * DSH-人声朗诵 browser half.
 *
 * Registers a left-sidebar panel entry (`sidebar.panellist`) plus its page in the
 * layout's root `main` keyed slot. Served verbatim by the client module loader.
 *
 * The page is a two-column layout (form | result) so the preview player is always
 * beside the form, and the root scrolls if the window is short.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-recite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL = 'dsh-voice-recite'
    const ROUTE = '/dsh-voice-recite'

    const MUTED = 'rgba(127,127,127,0.85)'
    const FAINT = 'rgba(127,127,127,0.55)'
    const LINE = '1px solid rgba(127,127,127,0.26)'
    const BLUE = '#4d6bfe'
    const CARD = { border: LINE, borderRadius: 14, padding: 16, background: 'rgba(127,127,127,0.05)' }
    const INPUT = {
      background: 'rgba(127,127,127,0.10)',
      color: 'inherit',
      border: LINE,
      borderRadius: 8,
      padding: '6px 9px',
      font: 'inherit',
      fontSize: 13,
      width: '100%',
      boxSizing: 'border-box',
      outline: 'none',
    }
    const LABEL = { fontSize: 12, color: MUTED, marginBottom: 4, display: 'block' }

    /** Fire-and-forget telemetry so the host can report what the page did. */
    const reportNote = note => {
      try { fetch(ROUTE + '/pulse?from=client&note=' + encodeURIComponent(note)).catch(() => {}) } catch { /* ignore */ }
    }

    function PanelIcon({ size }) {
      const s = size || 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 9, y: 2.6, width: 6, height: 10.4, rx: 3 }),
      h('path', { d: 'M5.4 11.2a6.6 6.6 0 0 0 13.2 0' }),
      h('path', { d: 'M12 17.8V21' }),
      h('path', { d: 'M8.6 21h6.8' }))
    }

    function Field(props) {
      return h('label', { style: { display: 'block', marginBottom: 11, minWidth: 0 } },
        h('span', { style: LABEL }, props.label),
        props.children,
        props.hint
          ? h('span', { style: { display: 'block', fontSize: 11, color: FAINT, marginTop: 3 } }, props.hint)
          : null)
    }

    const PRESET = {
      rate: '-25%',
      pitch: '+18Hz',
      tailVibrato: 9,
      tailFall: 12,
      dragText: '大',
      elongate: 1.4,
      vibratoText: '',
      vibrato: 0,
    }

    function RecitePage() {
      const [voices, setVoices] = React.useState([])
      const [form, setForm] = React.useState({
        text: '老大，我摔倒了。',
        voice: 'zh-CN-XiaoyiNeural',
        startTime: '5.14',
        endTime: '8.13',
        outputDir: '',
        focusText: '',
        dragText: '大',
        vibratoText: '',
        elongate: 1.4,
        dragSeconds: 0,
        vibrato: 0,
        rate: '-25%',
        pitch: '+18Hz',
        tailVibrato: 9,
        tailFall: 12,
        filename: 'recite',
      })
      const [busy, setBusy] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [error, setError] = React.useState('')
      const [preview, setPreview] = React.useState(null)
      const [committed, setCommitted] = React.useState(null)
      const [dirty, setDirty] = React.useState(true)
      const [audioUrl, setAudioUrl] = React.useState('')
      const audioRef = React.useRef(null)
      const previewRef = React.useRef(null)

      React.useEffect(() => {
        fetch(ROUTE + '/voices')
          .then(r => r.json())
          .then(data => {
            setVoices(data.voices || [])
            setForm(f => {
              if (f.outputDir) return f
              let remembered = ''
              try { remembered = window.localStorage.getItem('dsh-voice-recite.outputDir') || '' } catch { /* ignore */ }
              return { ...f, outputDir: remembered || data.outputDir || '' }
            })
          })
          .catch(() => setError('无法连接宿主服务，请确认 DSH 已重启'))
      }, [])

      // Load the preview through fetch and hand the element a Blob URL: this keeps
      // playback working even when the page's media loader cannot reach the host route.
      React.useEffect(() => {
        if (!preview) { setAudioUrl(''); return undefined }
        let alive = true
        let created = ''
        fetch(ROUTE + '/audio?path=' + encodeURIComponent(preview.wav))
          .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.arrayBuffer()
          })
          .then(buffer => {
            if (!alive) return
            created = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
            setAudioUrl(created)
            reportNote('audio-loaded:' + buffer.byteLength)
          })
          .catch(err => {
            reportNote('audio-fetch-fail:' + ((err && err.message) || err))
            setError('试听音频加载失败：' + ((err && err.message) || err))
          })
        return () => {
          alive = false
          if (created) URL.revokeObjectURL(created)
        }
      }, [preview])

      React.useEffect(() => {
        if (!audioUrl) return
        const el = audioRef.current
        if (!el) return
        try {
          el.currentTime = 0
          const played = el.play()
          if (played && typeof played.catch === 'function') played.catch(() => { /* autoplay blocked, use ▶ */ })
        } catch { /* ignore */ }
      }, [audioUrl])

      const set = key => event => {
        const value = event && event.target ? event.target.value : event
        setForm(f => ({ ...f, [key]: value }))
        if (key !== 'filename' && key !== 'outputDir') {
          setDirty(true)
          setCommitted(null)
        }
      }

      async function pickDir() {
        setPicking(true)
        setError('')
        try {
          const response = await fetch(ROUTE + '/pick')
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '无法打开目录选择器')
          if (data.path) {
            setForm(f => ({ ...f, outputDir: data.path }))
            setCommitted(null)
          }
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setPicking(false)
        }
      }

      async function previewTake() {
        setBusy(true)
        setError('')
        setPreview(null)
        setCommitted(null)
        try {
          const response = await fetch(ROUTE + '/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...form,
              startTime: Number(form.startTime) || 0,
              endTime: Number(form.endTime) || 0,
              elongate: Number(form.elongate) || 1,
              dragSeconds: Number(form.dragSeconds) || 0,
              vibrato: Number(form.vibrato) || 0,
              tailVibrato: Number(form.tailVibrato) || 0,
              tailFall: Number(form.tailFall) || 0,
            }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '试听生成失败')
          setPreview(data)
          setDirty(false)
          reportNote('preview-ok')
        } catch (err) {
          reportNote('preview-fail:' + ((err && err.message) || err))
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      async function commitTake() {
        if (!preview) return
        setBusy(true)
        setError('')
        try {
          const response = await fetch(ROUTE + '/commit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              wav: preview.wav,
              mp3: preview.mp3,
              outputDir: form.outputDir,
              filename: form.filename,
            }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error || '输出失败')
          setCommitted({ ...preview, wav: data.wav, mp3: data.mp3 })
          reportNote('commit-ok')
          try { window.localStorage.setItem('dsh-voice-recite.outputDir', form.outputDir) } catch { /* ignore */ }
        } catch (err) {
          reportNote('commit-fail:' + ((err && err.message) || err))
          setError(String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      const duration = (Number(form.endTime) - Number(form.startTime)).toFixed(2)
      const ready = Boolean(preview) && !dirty

      const formCard = h('div', { style: CARD },
        h(Field, { label: '文本' },
          h('textarea', {
            value: form.text, onChange: set('text'), rows: 3,
            style: { ...INPUT, resize: 'vertical', lineHeight: 1.55 },
          })),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)', gap: 10 } },
          h(Field, { label: '音色' },
            h('select', { value: form.voice, onChange: set('voice'), style: INPUT },
              voices.length
                ? voices.map(v => h('option', { key: v.id, value: v.id }, v.label))
                : h('option', { value: form.voice }, '小艺 · 少女感'))),
          h(Field, { label: '语速' },
            h('select', { value: form.rate, onChange: set('rate'), style: INPUT },
              ['-10%', '-20%', '-25%', '-30%', '-35%', '-40%'].map(v => h('option', { key: v, value: v }, v)))),
          h(Field, { label: '音调' },
            h('select', { value: form.pitch, onChange: set('pitch'), style: INPUT },
              ['+0Hz', '+8Hz', '+14Hz', '+18Hz', '+24Hz'].map(v => h('option', { key: v, value: v }, v))))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 } },
          h(Field, { label: '开始时间（秒）' },
            h('input', { value: form.startTime, onChange: set('startTime'), style: INPUT })),
          h(Field, { label: '截止时间（秒）' },
            h('input', { value: form.endTime, onChange: set('endTime'), style: INPUT }))),
        h('div', { style: { fontSize: 12, color: MUTED, margin: '-4px 0 11px' } },
          '音频时长 = 截止 − 开始 ＝ ', h('strong', { style: { color: 'inherit' } }, duration + ' 秒')),
        h(Field, { label: '输出位置（目录）', hint: '点「浏览」直接选文件夹；确认输出时才写入' },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', { value: form.outputDir, onChange: set('outputDir'), style: { ...INPUT, flex: 1 } }),
            h('button', {
              type: 'button', onClick: pickDir, disabled: picking,
              style: {
                flex: '0 0 auto', padding: '6px 14px', borderRadius: 8, border: LINE,
                background: 'rgba(127,127,127,0.14)', color: 'inherit',
                font: 'inherit', fontSize: 13, cursor: picking ? 'default' : 'pointer', whiteSpace: 'nowrap',
              },
            }, picking ? '选择中…' : '浏览…'))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 } },
          h(Field, { label: '拖音文字', hint: '要拖长的字，如「大」' },
            h('input', { value: form.dragText, onChange: set('dragText'), style: INPUT })),
          h(Field, { label: '颤音文字', hint: '要加颤音的字，可与拖音不同，如「了」' },
            h('input', { value: form.vibratoText, onChange: set('vibratoText'), style: INPUT }))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10 } },
          h(Field, { label: '拖音倍数 ' + Number(form.elongate).toFixed(2) + '×' },
            h('input', {
              type: 'range', min: 1, max: 4, step: 0.05, value: form.elongate,
              onChange: set('elongate'), style: { width: '100%' },
            })),
          h(Field, { label: '拖音秒数（0 = 用倍数）', hint: '如 0.6 表示该字多拖 0.6 秒' },
            h('input', {
              type: 'number', min: 0, max: 3, step: 0.1, value: form.dragSeconds,
              onChange: set('dragSeconds'), style: INPUT,
            })),
          h(Field, { label: '颤音深度 ' + form.vibrato + ' 音分' },
            h('input', {
              type: 'range', min: 0, max: 30, step: 1, value: form.vibrato,
              onChange: set('vibrato'), style: { width: '100%' },
            }))),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 10 } },
          h(Field, { label: '文件名（不含扩展名）' },
            h('input', { value: form.filename, onChange: set('filename'), style: INPUT })),
          h(Field, { label: '句尾颤音 ' + form.tailVibrato + ' 音分' },
            h('input', {
              type: 'range', min: 0, max: 20, step: 1, value: form.tailVibrato,
              onChange: set('tailVibrato'), style: { width: '100%' },
            })),
          h(Field, { label: '句尾下坠 ' + form.tailFall + ' 音分' },
            h('input', {
              type: 'range', min: 0, max: 20, step: 1, value: form.tailFall,
              onChange: set('tailFall'), style: { width: '100%' },
            }))),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 11, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            onClick: () => {
              setForm(f => ({ ...f, ...PRESET }))
              setDirty(true)
              setCommitted(null)
            },
            style: {
              padding: '5px 12px', borderRadius: 8, border: LINE, background: 'rgba(127,127,127,0.10)',
              color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer',
            },
          }, '套用「最初那版」参数'),
          h('span', { style: { fontSize: 11, color: FAINT } },
            '慢速 −25% / 音调 +18Hz / 句尾 9 音分颤音 + 12 音分下坠')),
        h('div', { style: { display: 'flex', gap: 10 } },
          h('button', {
            type: 'button', onClick: previewTake, disabled: busy,
            style: {
              flex: '1 1 60%', padding: '10px 0', borderRadius: 10, border: 'none',
              background: busy ? 'rgba(127,127,127,0.35)' : BLUE, color: '#fff',
              font: 'inherit', fontSize: 13.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
            },
          }, busy ? '正在生成…' : '试听（先不写入目录）'),
          h('button', {
            type: 'button', onClick: commitTake, disabled: busy || !ready,
            title: !preview ? '先试听' : (dirty ? '参数已改动，请重新试听' : '写入所选目录'),
            style: {
              flex: '1 1 40%', padding: '10px 0', borderRadius: 10, border: LINE,
              background: ready ? 'rgba(77,107,254,0.14)' : 'transparent',
              color: ready ? BLUE : FAINT,
              font: 'inherit', fontSize: 13.5, fontWeight: ready ? 600 : 400,
              cursor: ready && !busy ? 'pointer' : 'default',
            },
          }, '确认输出')))

      const resultCard = preview
        ? h('div', { ref: previewRef, style: { ...CARD, borderColor: 'rgba(77,107,254,0.5)' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 } },
            h('strong', { style: { fontSize: 14 } }, dirty ? '试听 · 参数已改动' : '试听已生成'),
            h('span', { style: { fontSize: 11.5, color: MUTED } },
              'WAV ' + preview.wavSeconds + 's')),
          h('button', {
            type: 'button',
            onClick: () => {
              const el = audioRef.current
              if (!el) return
              el.currentTime = 0
              const played = el.play()
              if (played && typeof played.catch === 'function') played.catch(err => setError('播放失败：' + ((err && err.message) || err)))
            },
            style: {
              width: '100%', padding: '10px 0', marginBottom: 10, borderRadius: 10, border: 'none',
              background: BLUE, color: '#fff', font: 'inherit', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(77,107,254,0.35)',
            },
          }, '▶ 播放试听 / 重播'),
          h('audio', {
            ref: audioRef,
            controls: true,
            preload: 'auto',
            style: { width: '100%' },
            src: audioUrl || undefined,
            onPlay: () => reportNote('audio-play'),
            onError: () => {
              reportNote('audio-error')
              setError('试听音频加载失败：宿主音频接口不可达（' + ROUTE + '/audio）')
            },
          }),
          h('div', { style: { fontSize: 11.5, color: FAINT, marginTop: 6 } },
            '实际时长 ' + preview.wavSeconds + ' 秒（' + Math.round(preview.wavSeconds * 24000) + ' 个采样点）；',
            '播放器上显示 0:02 是截断显示，不是时长变短。'),
          h('div', { style: { fontSize: 11.5, color: FAINT, marginTop: 4, lineHeight: 1.6 } },
            '试听文件只在系统临时目录，点「确认输出」才写入：', h('br'), form.outputDir),
          preview.focusMatched
            ? h('div', { style: { fontSize: 11.5, color: FAINT, marginTop: 6, lineHeight: 1.7 } },
              preview.dragMatched
                ? h('div', null,
                  '拖音命中 ' + preview.dragRegionStart + 's–' + preview.dragRegionEnd + 's（×' + preview.elongate
                  + (preview.dragAdded ? '，多出 ' + preview.dragAdded + ' 秒' : '') + '）')
                : null,
              preview.vibratoMatched
                ? h('div', null, '颤音命中 ' + preview.vibratoRegionStart + 's–' + preview.vibratoRegionEnd + 's（' + preview.vibrato + ' 音分）')
                : null)
            : null,
          preview.note
            ? h('div', { style: { fontSize: 11.5, color: '#e5484d', marginTop: 6, lineHeight: 1.6 } }, preview.note)
            : null)
        : committed
          ? null
          : h('div', { style: { ...CARD, borderStyle: 'dashed' } },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '试听区'),
            h('div', { style: { fontSize: 12, color: MUTED, lineHeight: 1.7 } },
              '填好左边参数，点「试听（先不写入目录）」，这里会生成播放器和「确认输出」按钮。',
              h('br'), h('br'),
              '试听不写任何文件到你的目录；确认后才复制 WAV 与 MP3 过去。'))

      const committedCard = committed
        ? h('div', { style: { ...CARD, borderColor: 'rgba(46,160,67,0.45)' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 } },
            h('strong', { style: { fontSize: 14, color: '#2ea043' } }, '✓ 已输出'),
            h('span', { style: { fontSize: 11.5, color: MUTED } }, 'WAV 精确 ' + committed.wavSeconds + 's')),
          h('audio', {
            controls: true, preload: 'none', style: { width: '100%', marginBottom: 8 },
            src: ROUTE + '/audio?path=' + encodeURIComponent(committed.wav),
          }),
          h('div', { style: { fontSize: 11.5, color: MUTED, wordBreak: 'break-all', lineHeight: 1.7 } },
            committed.wav, h('br'), committed.mp3))
        : null

      return h('div', {
        style: {
          height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          padding: '20px 24px 28px', color: 'inherit',
        },
      },
      h('div', { style: { maxWidth: 1200, margin: '0 auto' } },
        h('div', { style: { marginBottom: 16 } },
          h('h1', { style: { fontSize: 19, margin: '0 0 4px', fontWeight: 600 } }, 'DSH-人声朗诵'),
          h('p', { style: { margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.5 } },
            '输入文本 → 选音色 → 定开始/截止时间 → 试听 → 确认输出（WAV + MP3）。')),
        h('div', {
          style: {
            display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(280px,360px)',
            gap: 16, alignItems: 'start',
          },
        },
        formCard,
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 } },
          resultCard,
          committedCard,
          h('div', { style: { ...CARD, fontSize: 11.5, color: FAINT, lineHeight: 1.75 } },
            h('div', { style: { fontSize: 12, color: MUTED, fontWeight: 600, marginBottom: 4 } }, '关于时长精度'),
            'WAV 版对时间把握更精确：时长精确到采样点（2.99 秒 = 71760 个采样点）。',
            h('br'),
            'MP3 受帧长限制（32 kHz 下每帧 36 ms），只能落在最近的一帧网格上（2.988 秒）。',
            h('br'),
            '对时间要求严格时请用 WAV。')))))
    }

    return {
      name: 'dsh-voice-recite',
      inject: ['slots'],
      apply(ctx) {
        reportNote('boot')

        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL,
            order: 6,
            label: () => '人声朗诵',
          }, PanelIcon))
          reportNote('panellist-ok')
        } catch (err) {
          reportNote('panellist-fail: ' + ((err && err.message) || err))
          console.warn('[dsh-voice-recite] panellist registration failed', err)
        }

        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL,
          }, RecitePage))
          reportNote('main-ok')
        } catch (err) {
          reportNote('main-fail: ' + ((err && err.message) || err))
          console.warn('[dsh-voice-recite] main panel registration failed', err)
        }
      },
    }
  },
})
