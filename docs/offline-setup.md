# Clipy Local Edition: Fully Offline & Air-Gapped Setup Guide

Clipy Local Edition is engineered to run in completely offline and air-gapped environments. It requires zero cloud access, collects no telemetry, and can transcribe audio and plan key moments locally on-device.

---

## 1. Prerequisites

### Node.js & FFmpeg
- **Node.js**: Version 20 or newer (`node -v`).
- **FFmpeg**: Version 6 or newer (`ffmpeg -version`):
  - **Windows**: Install via `winget install Gyan.FFmpeg` or extract a static build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) and add `bin` to your `PATH`.
  - **macOS**: Install via Homebrew: `brew install ffmpeg`.
  - **Linux (Debian/Ubuntu)**: Install via `sudo apt update && sudo apt install -y ffmpeg`.

---

## 2. On-Device Speech Transcription

Clipy uses Sherpa-ONNX with quantized on-device models for high-speed local transcription without external network requests.

### Available On-Device Models
1. **English Fast** (`english-fast`):
   - Model: NeMo Parakeet TDT-CTC 110M
   - Download Archive: `sherpa-onnx-nemo-parakeet-tdt-ctc-110m-en-3000hrs-int8.tar.bz2`
   - Archive Size: ~99.5 MB
2. **Multilingual** (`multilingual`):
   - Model: OpenAI Whisper base
   - Download Archive: `sherpa-onnx-whisper-base.tar.bz2`
   - Archive Size: ~153.2 MB

### Model Storage Directories
To install models offline, transfer the unpacked model directories to the platform-specific data folder:

| Platform | Default Model Directory |
| :--- | :--- |
| **Windows** | `%LOCALAPPDATA%\clipy-local\models` (e.g. `C:\Users\<username>\AppData\Local\clipy-local\models`) |
| **macOS** | `~/Library/Application Support/clipy-local/models` |
| **Linux** | `~/.local/share/clipy-local/models` (or `$XDG_DATA_HOME/clipy-local/models`) |

Verify the installed status of local models using the transcription example:
```bash
node examples/transcribe-file.mjs
```

---

## 3. Offline Moment Planning

Clipy automatically identifies screenshots and key moments through interaction cues:

### 1. Pure Rules-Based Planner (Default)
- **Zero Configuration**: Operates 100% offline out-of-the-box.
- **Signals Detected**:
  - Hold-to-highlight flares (`Control` key hold).
  - Pen drawings and annotations.
  - Mouse click clusters and dwells.
  - Pointer rests.
- No remote LLM or local model server needed.

### 2. Local LLM for Spoken Cues (Optional)
If you wish to detect spoken cues (e.g., "click here", "look at this button") using local models:
- **Ollama**:
  ```bash
  ollama run llama3.2
  ```
  Default endpoint: `http://127.0.0.1:11434/v1`
- **LM Studio**:
  Start the local inference server (default port `1234`).
  Default endpoint: `http://127.0.0.1:1234/v1`

Configure your `config.json` (located at `%APPDATA%\clipy-local\config.json` on Windows, `~/.config/clipy-local/config.json` on Linux, or `~/Library/Application Support/clipy-local/config.json` on macOS):
```json
{
  "version": 1,
  "model": {
    "preset": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://127.0.0.1:11434/v1"
  },
  "transcription": {
    "kind": "local",
    "model": "english-fast"
  }
}
```

---

## 4. Screen & Interaction Capture

- **Linux**: Supports virtual headless displays via `Xvfb` with private Xauthority cookie security:
  ```bash
  sudo apt install -y xvfb xauth
  ```
- **macOS**: Grant Screen & System Audio Recording permissions in `System Settings > Privacy & Security`.
- **Windows**: Uses high-performance Desktop Duplication API (DXGI / GDI) with DPI awareness.

---

## 5. Security & Privacy Guarantees

- **No Telemetry**: Clipy Local Edition hardcodes telemetry to `false` and makes no analytics requests.
- **Air-Gapped Operation**: When configured with `model: null` (or local Ollama/LM Studio) and `transcription: { kind: "local" }`, no data or packets leave your local loopback interface (`127.0.0.1`).
