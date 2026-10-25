#!/usr/bin/env python3
"""Local Japanese text -> custom voice -> WAV. Standard-library adapter."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent


class Failure(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def request(url, body=None, timeout=180):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:1000]
        raise Failure(502, "engine_error", f"Engine returned {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Failure(503, "engine_unavailable", str(exc)) from exc


class Pipeline:
    def __init__(self, config):
        self.config = config
        self.engine = (ROOT / config["engine_dir"]).resolve()
        self.output = (ROOT / config["output_dir"]).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.base = f'http://127.0.0.1:{config["engine_port"]}/api/'
        self.model_file = f'model_assets/{config["voice"]}/{config["checkpoint"]}'
        self.lock = threading.Lock()
        self.child = None
        self.log = None

    def ready(self):
        models = json.loads(request(self.base + "models_info", timeout=3))
        return any(m["name"] == self.config["voice"] and
                   any(Path(f).name == self.config["checkpoint"] for f in m["files"])
                   and "Neutral" in m["styles"] for m in models)

    def start(self):
        try:
            if self.ready():
                return
            raise Failure(503, "model_missing", "The running engine does not contain the configured voice/checkpoint.")
        except Failure as exc:
            if exc.code != "engine_unavailable":
                raise
        python = Path(self.config["python"]).expanduser()
        if not python.is_file() or not (self.engine / "server_editor.py").is_file():
            raise Failure(503, "setup_required", "Set engine_dir and python in config.json to your installed engine/runtime.")
        if self.child is None or self.child.poll() is not None:
            if self.log:
                self.log.close()
            self.log = (self.output.parent / "companion-engine.log").open("ab")
            self.child = subprocess.Popen(
                [str(python), "-u", "server_editor.py", "--device", "cpu", "--port",
                 str(self.config["engine_port"]), "--skip_static_files"],
                cwd=self.engine, stdout=self.log, stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            if self.child.poll() is not None:
                raise Failure(503, "startup_failed", "Engine stopped. See engine.log.")
            try:
                if self.ready():
                    return
            except Failure:
                pass
            time.sleep(1)
        raise Failure(503, "startup_timeout", "Engine did not become ready in 240 seconds. See engine.log.")

    def close(self):
        # Only stop a process launched by this adapter, never a user's existing Web UI.
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        if self.log:
            self.log.close()

    def fingerprint(self):
        model = self.engine / self.model_file
        files = [model, model.parent / "config.json", model.parent / "style_vectors.npy"]
        files += sorted((self.engine / "dict_data").glob("*.json"))
        return [(str(p.relative_to(self.engine)), p.stat().st_size, p.stat().st_mtime_ns) for p in files]

    def speak(self, body):
        if not isinstance(body, dict) or set(body) - {"text", "speed", "cache"}:
            raise Failure(400, "invalid_input", "Expected {text, speed?, cache?}.")
        text = body.get("text")
        speed, cache = body.get("speed", 1.0), body.get("cache", True)
        if not isinstance(text, str) or not text.strip() or len(text) > 500:
            raise Failure(400, "invalid_text", "text must contain 1–500 characters.")
        if type(speed) not in (int, float) or not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
            raise Failure(400, "invalid_speed", "speed must be a number from 0.5 to 2.0.")
        if type(cache) is not bool:
            raise Failure(400, "invalid_cache", "cache must be true or false.")
        if not self.lock.acquire(blocking=False):
            raise Failure(429, "busy", "Another sentence is being generated. Retry after it finishes.")
        try:
            canonical = {"text": text.strip(), "speed": float(speed), "voice": self.config["voice"],
                         "version": 1, "model": self.fingerprint()}
            key = hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            target = self.output / (key + ".wav")
            cached = cache and target.is_file()
            if not cached:
                self.start()
                normalized = json.loads(request(self.base + "normalize", {"text": text.strip()}))
                tones = json.loads(request(self.base + "g2p", {"text": normalized}))
                data = request(self.base + "synthesis", {
                    "model": self.config["voice"], "modelFile": self.model_file,
                    "text": normalized, "moraToneList": tones, "speed": float(speed),
                    "style": "Neutral", "language": "JP",
                })
                # Validate the audio before atomically publishing it.
                with wave.open(io.BytesIO(data), "rb") as wav:
                    if wav.getnframes() == 0:
                        raise Failure(502, "empty_audio", "Engine returned empty audio.")
                temporary = target.with_suffix(".tmp")
                temporary.write_bytes(data)
                temporary.replace(target)
            with wave.open(str(target), "rb") as wav:
                return {"audio_path": str(target), "audio_url": f"/v1/audio/{key}.wav",
                        "format": "wav", "sample_rate": wav.getframerate(),
                        "channels": wav.getnchannels(), "duration_seconds": round(wav.getnframes()/wav.getframerate(), 3),
                        "voice": self.config["voice"], "cached": cached}
        finally:
            self.lock.release()


def serve(config):
    pipeline = Pipeline(config)

    class Handler(BaseHTTPRequestHandler):
        def send(self, status, data, content_type="application/json"):
            if content_type == "application/json":
                data = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def error(self, exc):
            self.send(exc.status, {"error": {"code": exc.code, "message": exc.message}})

        def do_GET(self):
            if self.path == "/health":
                try:
                    ready = pipeline.ready()
                    self.send(200 if ready else 503, {"ready": ready, "voice": config["voice"], "api_version": 1})
                except Failure as exc:
                    self.error(exc)
            elif re.fullmatch(r"/v1/audio/[0-9a-f]{64}\.wav", self.path):
                path = pipeline.output / self.path.rsplit("/", 1)[1]
                if path.is_file():
                    self.send(200, path.read_bytes(), "audio/wav")
                else:
                    self.error(Failure(404, "not_found", "Audio not found."))
            else:
                self.error(Failure(404, "not_found", "Use /health or POST /v1/speech."))

        def do_POST(self):
            if self.path != "/v1/speech":
                return self.error(Failure(404, "not_found", "Unknown endpoint."))
            # Intended for the companion's main/backend process, not cross-origin webpages.
            if self.headers.get("Origin"):
                return self.error(Failure(403, "origin_not_allowed", "Call this API from your app's main process."))
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise Failure(413, "invalid_size", "JSON body must be 1–16384 bytes.")
                self.connection.settimeout(15)
                body = json.loads(self.rfile.read(length))
                self.send(200, pipeline.speak(body))
            except Failure as exc:
                self.error(exc)
            except (ValueError, UnicodeError) as exc:
                self.error(Failure(400, "invalid_json", str(exc)))
            except Exception as exc:
                print(f"TTS error: {exc}", file=sys.stderr, flush=True)
                self.error(Failure(500, "generation_failed", str(exc)))

    server = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    try:
        pipeline.start()
        print(f'Ready: http://127.0.0.1:{config["port"]} | voice={config["voice"]}', flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        pipeline.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["serve", "speak", "health"])
    parser.add_argument("--text")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "config.json").read_text())
    def shutdown(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, shutdown)
    try:
        if args.command == "serve":
            serve(config)
        else:
            base = f'http://127.0.0.1:{config["port"]}'
            data = request(base + "/health") if args.command == "health" else request(
                base + "/v1/speech", {"text": args.text, "speed": args.speed, "cache": not args.no_cache}, timeout=420)
            print(data.decode())
    except KeyboardInterrupt:
        pass
    except Failure as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.message}}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
