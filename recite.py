"""DSH 人声朗诵 engine: Edge TTS + per-word elongation / vibrato + exact-duration WAV/MP3.

Reads one JSON object from stdin, writes one JSON object to stdout.
"""
import asyncio
import json
import os
import struct
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _cache_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache")
    return os.path.join(base, "dsh-voice-recite", "pylibs")


def _try_import():
    try:
        import edge_tts  # noqa: F401
        import lameenc  # noqa: F401
        import miniaudio  # noqa: F401
        import numpy  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _ensure_deps():
    """Bundled wheel directory, then a bundled zip, then pip — first one that works."""
    vendor = os.path.join(HERE, "vendor")
    cache = _cache_dir()
    for path in (vendor, cache):
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)
    if _try_import():
        return

    archive = os.path.join(HERE, "vendor.zip")
    if os.path.isfile(archive):
        os.makedirs(cache, exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(cache)
        if cache not in sys.path:
            sys.path.insert(0, cache)
        if _try_import():
            return

    requirements = os.path.join(HERE, "requirements.txt")
    os.makedirs(cache, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--target", cache, "-r", requirements],
        check=True,
    )
    if cache not in sys.path:
        sys.path.insert(0, cache)


_ensure_deps()

import lameenc  # noqa: E402
import miniaudio  # noqa: E402
import numpy as np  # noqa: E402
import edge_tts  # noqa: E402

SR = 24000
SPF = 1152  # MPEG-1 layer III samples per frame
WIN = 1024
HOP = 256


# ---------------------------------------------------------------- audio utils
def envelope(a, win=240):
    k = np.ones(win, dtype=np.float32) / win
    return np.convolve(np.abs(a), k, mode="same")


def speech_bounds(a, thresh_db=-45.0):
    env = envelope(a)
    peak = float(env.max()) if len(env) else 0.0
    if peak <= 0:
        return 0, 0
    thr = 10 ** (thresh_db / 20.0) * peak
    idx = np.where(env > thr)[0]
    if not len(idx):
        return 0, 0
    return int(idx[0]), int(idx[-1])


def wsola(x, out_len, frame=WIN, hop=HOP):
    """Pitch-preserving time stretch to out_len samples."""
    n = len(x)
    if n == 0:
        return np.zeros(max(0, out_len), dtype=np.float32)
    frame = min(frame, max(64, n))
    if frame % 2:
        frame += 1
    hop = min(hop, frame // 2)
    rate = out_len / n
    half = frame // 2
    win = np.hanning(frame).astype(np.float32)
    out = np.zeros(out_len + frame, dtype=np.float32)
    wsum = np.zeros(out_len + frame, dtype=np.float32)
    pad = np.concatenate([np.zeros(half, dtype=np.float32), x, np.zeros(half + 2 * frame, dtype=np.float32)])
    max_start = len(pad) - frame

    def grab(pos):
        pos = max(0, min(pos, max_start))
        return pad[pos : pos + frame]

    ref = grab(0).copy()
    pos_out = 0
    search = min(192, hop)
    while pos_out < out_len:
        target = min(max_start, max(0, int(round(pos_out / rate))))
        lo, hi = max(0, target - search), min(max_start, target + search)
        r = ref - ref.mean()
        best, best_score = target, -1e30
        for cand in range(lo, hi + 1, 4):
            seg = grab(cand)
            score = float(np.dot(seg - seg.mean(), r))
            if score > best_score:
                best_score, best = score, cand
        seg = grab(best) * win
        out[pos_out : pos_out + frame] += seg
        wsum[pos_out : pos_out + frame] += win
        ref = grab(best + hop).copy()
        pos_out += hop
    wsum[wsum < 1e-3] = 1.0
    return (out / wsum)[:out_len]


def crossfade_splice(a, i0, i1, replacement, fade):
    """Replace a[i0:i1] by `replacement`, crossfading at both seams."""
    fade = max(1, min(fade, len(replacement) // 2, (i1 - i0) // 2))
    head = a[:i0].copy()
    tail = a[i1:].copy()
    rep = replacement.copy()
    if fade > 0 and len(head) >= fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        rep[:fade] *= ramp
        rep[:fade] += head[-fade:] * (1.0 - ramp)
        head = head[:-fade]
    if fade > 0 and len(tail) >= fade:
        ramp = np.linspace(1.0, 0.0, fade, dtype=np.float32)
        rep[-fade:] *= ramp
        rep[-fade:] += tail[:fade] * (1.0 - ramp)
        tail = tail[fade:]
    return np.concatenate([head, rep, tail]).astype(np.float32)


def pitch_warp(x, sr, depth_cents, freq, fade_ms=60):
    n = len(x)
    if n < 64 or depth_cents == 0:
        return x
    t = np.arange(n) / sr
    env = np.minimum(t / (fade_ms / 1000.0), 1.0)
    dev = depth_cents * np.sin(2 * np.pi * freq * t) * env
    ratio = np.power(2.0, dev / 1200.0)
    pos = np.cumsum(ratio) - ratio[0]
    pos = np.clip(pos, 0, n - 1)
    return np.interp(pos, np.arange(n), x).astype(np.float32)


def pitch_warp_dev(x, dev):
    """Warp pitch with an explicit per-sample deviation curve (cents)."""
    n = len(x)
    if n < 64 or not np.any(dev):
        return x
    ratio = np.power(2.0, dev / 1200.0)
    pos = np.cumsum(ratio) - ratio[0]
    pos = np.clip(pos, 0, n - 1)
    return np.interp(pos, np.arange(n), x).astype(np.float32)


def shape_tail(x, sr, vibrato, freq, fall, portion):
    """Tearful ending: a light tremble plus a small downward pitch fall."""
    n = len(x)
    if n < 64 or (not vibrato and not fall):
        return x
    portion = min(0.95, max(0.05, portion))
    start = int(n * (1.0 - portion))
    t = np.arange(n) / sr
    dev = np.zeros(n, dtype=np.float64)
    tt = t[start:] - t[start]
    env = np.minimum(tt / 0.08, 1.0)
    dev[start:] = vibrato * np.sin(2 * np.pi * freq * tt) * env
    if fall:
        span = max(1e-6, tt[-1])
        dev[start:] -= fall * (tt / span) ** 2
    return pitch_warp_dev(x, dev)


def fade_edges(x, sr, fade_in=0.008, fade_out=0.03):
    n = len(x)
    a, b = int(fade_in * sr), int(fade_out * sr)
    if a > 1:
        x[:a] *= np.linspace(0, 1, a, dtype=np.float32) ** 1.5
    if b > 1:
        x[-b:] *= np.linspace(1, 0, b, dtype=np.float32) ** 1.5
    return x


def write_wav(path, x, sr=SR):
    y = np.clip(x, -1.0, 1.0)
    pcm = (y * 32767.0).astype("<i2").tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
    hdr += struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(pcm))
    with open(path, "wb") as f:
        f.write(hdr + pcm)


def read_wav(path):
    with open(path, "rb") as f:
        data = f.read()
    d = miniaudio.decode(data, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=SR)
    return np.frombuffer(d.samples, dtype=np.int16).astype(np.float32) / 32768.0


def mp3_frames(data):
    i = 0
    if data[:3] == b"ID3":
        i = 10 + ((data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9])
    frames = 0
    while i + 4 <= len(data):
        if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
            b1, b2 = data[i + 1], data[i + 2]
            ver = (b1 >> 3) & 3
            br_idx = (b2 >> 4) & 0xF
            sr_idx = (b2 >> 2) & 3
            pad = (b2 >> 1) & 1
            if ver == 3 and sr_idx != 3 and br_idx != 0:
                br = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][br_idx] * 1000
                srate = [44100, 48000, 32000][sr_idx]
                i += int(144 * br / srate) + pad
                frames += 1
                continue
        i += 1
    return frames


# ---------------------------------------------------------------- synthesis
async def synth(text, voice, rate, pitch):
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    audio = bytearray()
    words = []
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append(
                {
                    "text": str(chunk.get("text", "")),
                    "start": float(chunk.get("offset", 0)) / 1e7,
                    "end": float(chunk.get("offset", 0) + chunk.get("duration", 0)) / 1e7,
                }
            )
    return bytes(audio), words


def decode_mp3(data, sr=SR):
    d = miniaudio.decode(data, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=sr)
    return np.frombuffer(d.samples, dtype=np.int16).astype(np.float32) / 32768.0


def locate(words, focus):
    """Map a piece of the spoken text onto a [start_sample, end_sample] region."""
    if not focus or not words:
        return None
    joined = "".join(w["text"] for w in words)
    pos = joined.find(focus)
    if pos < 0:
        # try without punctuation
        stripped = [(i, w["text"]) for i, w in enumerate(words)]
        joined2 = "".join(t for _, t in stripped)
        pos = joined2.find(focus)
        if pos < 0:
            return None
        joined = joined2
    end_pos = pos + len(focus)

    spans = []
    cursor = 0
    for w in words:
        spans.append((cursor, cursor + len(w["text"]), w))
        cursor += len(w["text"])

    def sample_at(char_index, is_end):
        for c0, c1, w in spans:
            if c0 <= char_index < c1 or (is_end and c0 < char_index <= c1):
                frac = (char_index - c0) / max(1, (c1 - c0))
                frac = min(1.0, max(0.0, frac))
                t = w["start"] + (w["end"] - w["start"]) * frac
                return int(round(t * SR))
        return None

    s = sample_at(pos, False)
    e = sample_at(end_pos, True)
    if s is None and spans:
        s = int(round(spans[0][2]["start"] * SR))
    if e is None and spans:
        e = int(round(spans[-1][2]["end"] * SR))
    return s, e


def snap_to_dip(a, idx, radius=0.05):
    """Move a splice point to the quietest nearby sample."""
    r = int(radius * SR)
    lo, hi = max(0, idx - r), min(len(a), idx + r)
    if hi <= lo:
        return idx
    seg = np.abs(a[lo:hi])
    k = max(1, int(0.004 * SR))
    smooth = np.convolve(seg, np.ones(k) / k, mode="same")
    return lo + int(np.argmin(smooth))


def elongate_region(a, i0, i1, factor, sr=SR, extra_samples=0):
    """Stretch a word by its vowel core only.

    Stretching the whole syllable also stretches the consonant onset and its
    closure, which reads as a stutter or a gap instead of a sustained vowel.
    The loud, periodic core is the part a listener hears as "拖音".

    `extra_samples` (when positive) wins over `factor`: it names how many extra
    samples the sustained vowel should gain, i.e. "拖音多长" in seconds.
    """
    seg = a[i0:i1].copy()

    def target(length):
        if extra_samples > 0:
            return max(1, int(length) + int(extra_samples))
        return max(1, int(round(length * factor)))

    whole = wsola(seg, target(len(seg)))
    if len(seg) < int(0.05 * sr):
        return whole, 0, len(seg)
    hop = max(1, int(0.01 * sr))
    frames = len(seg) // hop
    if frames < 3:
        return whole, 0, len(seg)
    energy = np.array(
        [np.sqrt(np.mean(seg[k * hop : (k + 1) * hop] ** 2)) for k in range(frames)],
        dtype=np.float32,
    )
    peak = float(energy.max())
    if peak <= 0:
        return whole, 0, len(seg)
    loud = np.where(energy > 0.22 * peak)[0]
    if len(loud) < 2:
        return whole, 0, len(seg)
    c0 = max(0, (int(loud[0]) - 1) * hop)
    c1 = min(len(seg), (int(loud[-1]) + 2) * hop)
    if c1 - c0 < int(0.03 * sr):
        return whole, 0, len(seg)

    core = seg[c0:c1]
    stretched = wsola(core, target(len(core)))
    fade = int(0.006 * sr)

    head = seg[:c0].copy()
    if len(head) > fade and len(stretched) > fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        blend = head[-fade:] * (1.0 - ramp) + stretched[:fade] * ramp
        out = np.concatenate([head[:-fade], blend, stretched[fade:]])
    else:
        out = np.concatenate([head, stretched])

    tail = seg[c1:].copy()
    if len(tail) > fade and len(out) > fade:
        ramp = np.linspace(1.0, 0.0, fade, dtype=np.float32)
        blend = out[-fade:] * ramp + tail[:fade] * (1.0 - ramp)
        out = np.concatenate([out[:-fade], blend, tail[fade:]])
    else:
        out = np.concatenate([out, tail])
    return out.astype(np.float32), c0, c1


def build_pcm(pcm, words, cfg):
    a = pcm.copy()
    a -= float(np.mean(a))

    # 拖音与颤音各自独立：可以指向同一段文字，也可以分别指向不同的字。
    legacy = (cfg.get("focusText") or "").strip()
    drag_text = (cfg.get("dragText") or "").strip() or legacy
    vib_text = (cfg.get("vibratoText") or "").strip() or legacy
    factor = float(cfg.get("elongate", 1.0) or 1.0)
    extra_seconds = float(cfg.get("dragSeconds", 0.0) or 0.0)
    extra_samples = int(round(extra_seconds * SR)) if extra_seconds > 0 else 0
    vib = float(cfg.get("vibrato", 0.0) or 0.0)
    vib_freq = float(cfg.get("vibratoFreq", 5.5) or 5.5)
    snap = bool(cfg.get("snap", True))

    report = {"focusMatched": False}

    def region_bounds(text):
        found = locate(words, text) if text else None
        if not found:
            return None
        i0, i1 = found
        i0 = max(0, min(len(a) - 1, i0))
        i1 = max(i0 + int(0.05 * SR), min(len(a), i1))
        if snap:
            i0 = snap_to_dip(a, i0)
            i1 = snap_to_dip(a, i1)
        if i1 - i0 < int(0.04 * SR):
            i1 = min(len(a), i0 + int(0.04 * SR))
        return i0, i1

    if drag_text and (abs(factor - 1.0) > 1e-3 or extra_samples > 0):
        bounds = region_bounds(drag_text)
        if bounds:
            i0, i1 = bounds
            seg, _, _ = elongate_region(a, i0, i1, factor, extra_samples=extra_samples)
            a = crossfade_splice(a, i0, i1, seg, int(0.01 * SR))
            delta = (len(seg) - (i1 - i0)) / SR
            for w in words:
                if w["start"] >= i1 / SR - 1e-6:
                    w["start"] += delta
                    w["end"] += delta
            actual = len(seg) / max(1, i1 - i0)
            report.update(
                {
                    "focusMatched": True,
                    "dragMatched": True,
                    "dragRegionStart": round(i0 / SR, 3),
                    "dragRegionEnd": round((i0 + len(seg)) / SR, 3),
                    "elongate": round(actual, 3),
                    "dragAdded": round(delta, 3),
                }
            )

    if vib_text and vib:
        bounds = region_bounds(vib_text)
        if bounds:
            i0, i1 = bounds
            seg = pitch_warp(a[i0:i1].copy(), SR, vib, vib_freq)
            a = crossfade_splice(a, i0, i1, seg, int(0.012 * SR))
            report.update(
                {
                    "focusMatched": True,
                    "vibratoMatched": True,
                    "vibratoRegionStart": round(i0 / SR, 3),
                    "vibratoRegionEnd": round(i1 / SR, 3),
                    "vibrato": vib,
                }
            )

    s, e = speech_bounds(a)
    if e <= s:
        raise RuntimeError("no speech detected in synthesized audio")
    speech = a[max(0, s - int(0.02 * SR)) : min(len(a), e + int(0.02 * SR))].copy()
    speech = shape_tail(
        speech,
        SR,
        float(cfg.get("tailVibrato", 0.0) or 0.0),
        float(cfg.get("tailVibratoFreq", 5.2) or 5.2),
        float(cfg.get("tailFall", 0.0) or 0.0),
        float(cfg.get("tailPortion", 0.35) or 0.35),
    )
    speech = fade_edges(speech, SR, 0.005, 0.035)

    target = float(cfg["endTime"]) - float(cfg["startTime"])
    if target <= 0.05:
        raise RuntimeError("endTime must be greater than startTime")
    head = float(cfg.get("headPad", 0.12))
    tail = float(cfg.get("tailPad", 0.28))
    if head + tail > target * 0.6:
        head = target * 0.2
        tail = target * 0.2
    budget = int(round((target - head - tail) * SR))
    # A stretched word must not be cancelled by compressing the whole take: give
    # back the leading/trailing padding before squeezing the speech.
    if len(speech) > budget:
        need = len(speech) - budget
        give = min(need, int(max(0.0, tail - 0.10) * SR))
        tail -= give / SR
        need -= give
        if need > 0:
            give = min(need, int(max(0.0, head - 0.06) * SR))
            head -= give / SR
            need -= give
        budget = int(round((target - head - tail) * SR))
    if budget < int(0.05 * SR):
        raise RuntimeError("target duration is too short")
    # Fill the timeline without over-stretching: a modest stretch tops up the slot,
    # and whatever is left becomes a natural trailing pause instead of dead air in
    # the middle of the phrase.
    if len(speech) < budget:
        cap = int(round(len(speech) * 1.12))
        speech = wsola(speech, min(budget, max(cap, len(speech))))
    elif len(speech) > budget:
        ratio = budget / float(len(speech))
        report["compression"] = round(ratio, 3)
        if ratio < 0.92:
            report["note"] = "目标时长放不下这么长的拖音，整句被压缩到 %.0f%%，拖音也会相应变短。" % (ratio * 100)
        speech = wsola(speech, budget)

    total = int(round(target * SR))
    out = np.zeros(total, dtype=np.float32)
    h = int(round(head * SR))
    out[h : h + len(speech)] = speech[: max(0, total - h)]

    peak = float(np.abs(out).max())
    if peak > 0:
        out *= (10 ** (-1.0 / 20.0)) / peak
    report.update({"speechSeconds": round(len(speech) / SR, 3), "duration": round(total / SR, 4)})
    return out, report


def encode_mp3(pcm, path, target_seconds, bitrate=128):
    sr = 32000
    # resample 24k -> 32k with miniaudio through a temporary wav
    tmp = path + ".tmp.wav"
    write_wav(tmp, pcm, SR)
    d = miniaudio.decode(
        open(tmp, "rb").read(),
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=sr,
    )
    base = np.frombuffer(d.samples, dtype=np.int16).copy()
    os.remove(tmp)

    want = max(1, int(round(target_seconds * sr / SPF)))
    n = len(base)
    data = b""
    for _ in range(4):
        enc = lameenc.Encoder()
        enc.set_bit_rate(bitrate)
        enc.set_in_sample_rate(sr)
        enc.set_channels(1)
        enc.set_quality(2)
        buf = enc.encode(base[:n].tobytes()) + enc.flush()
        frames = mp3_frames(buf)
        if frames == want:
            data = bytes(buf)
            break
        data = bytes(buf)
        diff = (want - frames) * SPF
        n = max(SPF, min(len(base), n + diff))
        if n >= len(base) and diff > 0:
            pad = np.zeros(diff, dtype=np.int16)
            base = np.concatenate([base, pad])
            n = len(base)
            data = bytes(buf)
    with open(path, "wb") as f:
        f.write(data)
    return sr, mp3_frames(data) * SPF / sr


def main():
    if "--config" in sys.argv:
        with open(sys.argv[sys.argv.index("--config") + 1], "r", encoding="utf-8") as f:
            cfg = json.load(f)
    else:
        raw = sys.stdin.buffer.read().decode("utf-8")
        cfg = json.loads(raw or "{}")
    text = (cfg.get("text") or "").strip()
    if not text:
        raise RuntimeError("text is required")
    voice = cfg.get("voice") or "zh-CN-XiaoyiNeural"
    rate = cfg.get("rate") or "-20%"
    pitch = cfg.get("pitch") or "+0Hz"

    audio_bytes, words = asyncio.run(synth(text, voice, rate, pitch))
    pcm = decode_mp3(audio_bytes)
    out, report = build_pcm(pcm, words, cfg)

    out_dir = cfg.get("outputDir") or os.getcwd()
    os.makedirs(out_dir, exist_ok=True)
    base = cfg.get("basename") or "recite"
    wav_path = os.path.join(out_dir, base + ".wav")
    mp3_path = os.path.join(out_dir, base + ".mp3")
    write_wav(wav_path, out, SR)
    sr, mp3_dur = encode_mp3(out, mp3_path, len(out) / SR)

    report.update(
        {
            "ok": True,
            "wav": wav_path,
            "mp3": mp3_path,
            "wavSeconds": round(len(out) / SR, 4),
            "mp3Seconds": round(mp3_dur, 4),
            "voice": voice,
            "rate": rate,
            "pitch": pitch,
            "words": words,
        }
    )
    emit(report)


def emit(payload):
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": str(exc)})
        sys.exit(1)
