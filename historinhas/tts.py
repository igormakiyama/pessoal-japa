"""Narração em áudio com Piper TTS (código aberto, roda na CPU do VPS, grátis)."""

import logging
import shutil
import subprocess
import wave
from pathlib import Path

import httpx

from .config import settings

log = logging.getLogger(__name__)

VOICES_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

_voice_cache = {}


def _voice_files(voice: str) -> tuple[Path, Path]:
    model = settings.voices_dir / f"{voice}.onnx"
    return model, model.with_suffix(".onnx.json")


def ensure_voice(voice: str | None = None) -> Path:
    """Baixa a voz do Piper (uma vez só) para data/voices."""
    voice = voice or settings.piper_voice
    model, config = _voice_files(voice)
    if model.exists() and config.exists():
        return model
    # pt_BR-faber-medium -> pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx
    locale, speaker, quality = voice.split("-", 2)
    base = f"{VOICES_URL}/{locale.split('_')[0]}/{locale}/{speaker}/{quality}/{voice}"
    settings.voices_dir.mkdir(parents=True, exist_ok=True)
    for url, dest in ((f"{base}.onnx.json", config), (f"{base}.onnx", model)):
        log.info("Baixando voz %s", url)
        tmp = dest.with_suffix(dest.suffix + ".part")
        with httpx.stream("GET", url, follow_redirects=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_bytes():
                    fh.write(chunk)
        tmp.rename(dest)
    return model


def _load_voice():
    from piper import PiperVoice

    model = ensure_voice()
    if model not in _voice_cache:
        _voice_cache[model] = PiperVoice.load(str(model))
    return _voice_cache[model]


def narrate(text: str, out_mp3: Path) -> Path | None:
    """Gera o áudio da história. Devolve o arquivo gerado (mp3, ou wav sem ffmpeg) ou None."""
    if not settings.tts_enabled:
        return None
    try:
        from piper import SynthesisConfig
    except ImportError:
        log.warning("piper-tts não instalado; história sairá sem áudio.")
        return None

    voice = _load_voice()
    wav_path = out_mp3.with_suffix(".wav")
    with wave.open(str(wav_path), "wb") as wav:
        voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=settings.piper_length_scale))

    if not shutil.which("ffmpeg"):
        return wav_path
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav_path), "-codec:a", "libmp3lame", "-b:a", "64k", str(out_mp3)],
        check=True,
    )
    wav_path.unlink(missing_ok=True)
    return out_mp3
