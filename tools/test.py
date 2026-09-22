"""
Benchmark ALL free-endpoint NVIDIA NIM chat models on latency and
generation speed using a single complex, in-character reasoning task.

Requirements:
    pip install openai

Usage:
    export NVIDIA_API_KEY="nvapi-xxxxxxxx"
    python -m venv venv
    source venv/bin/activate   # or venv\\Scripts\\activate.bat on Windows
    pip install openai
    python benchmark_nim_models.py
"""

import os
import csv
import time
import signal
import platform
from datetime import datetime
from openai import OpenAI

client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key=os.environ.get("NVIDIA_API_KEY", "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"),
)

# -----------------------------------------------------------------------
# Full list of Free Endpoint models on build.nvidia.com (as of Sep 2026)
# -----------------------------------------------------------------------
# Chat/completions-compatible text (or multimodal-text) models -> tested
# Non-chat models (embedding, TTS, translation, safety classifiers,
# vision-only detection, autonomous-driving perception, video-gen) are
# listed for reference but SKIPPED since they don't use the chat
# completions endpoint this script benchmarks.

ALL_FREE_ENDPOINT_MODELS = {
    "google/diffusiongemma-26b-a4b-it": "chat",
    "meta/llama-3.2-11b-vision-instruct": "chat",
}

# Only benchmark the chat-completions-compatible models
MODELS = [m for m, kind in ALL_FREE_ENDPOINT_MODELS.items() if kind == "chat"]

REQUEST_TIMEOUT_SEC = 30  # hard timeout per model call

SYSTEM_PROMPT = (
    "You are Aria, a veteran starship engineer aboard a damaged colony ship. "
    "You are calm under pressure, slightly sarcastic, and speak in short, "
    "technical sentences. Stay strictly in character. Never break the fourth "
    "wall or mention you are an AI."
)

TASK_PROMPT = """
Situation report:
- The colony ship "Meridian" lost 40% of hull integrity after a micrometeor storm.
- Life support has 6 hours of oxygen left for 312 passengers at current consumption.
- Engine core is stable but the coolant line feeding it has a slow leak (est. 5 hours to critical failure).
- You have three repair drones, but only enough charge to fully power two tasks:
  (a) patch the hull breach, (b) reroute coolant to stop the leak, (c) restart the
  secondary oxygen scrubber, which would extend life support to 14 hours.
- The ship's captain is unconscious in medbay, and the first officer is asking you
  over comms, in a panicked tone, what you recommend doing RIGHT NOW, in order,
  and why. She needs your answer in under 30 seconds of real time.

Respond as Aria: give a clear ordered action plan (which two tasks to prioritize
and why), acknowledge the tradeoff you're accepting, and reassure the crew in your
characteristic dry, technical tone. Keep the total response between 120-180 words.
"""

CSV_PATH = "benchmark_results.csv"
CSV_FIELDS = [
    "timestamp", "session_id", "model", "run",
    "ttft_sec", "total_time_sec", "word_count", "words_per_sec",
    "timed_out", "full_response",
]


class TimeoutError_(Exception):
    pass


def _raise_timeout(signum, frame):
    raise TimeoutError_("Request exceeded timeout")


def run_with_timeout(model_name: str, timeout_sec: int = REQUEST_TIMEOUT_SEC):
    """Call a model with a streaming request, enforcing a hard timeout.

    Uses SIGALRM on Unix/macOS. On Windows (no SIGALRM), falls back to a
    soft timeout check inside the streaming loop instead.
    """
    use_signal = platform.system() != "Windows" and hasattr(signal, "SIGALRM")

    start = time.perf_counter()
    first_token_time = None
    full_text = []
    timed_out = False

    if use_signal:
        old_handler = signal.signal(signal.SIGALRM, _raise_timeout)
        signal.alarm(timeout_sec)

    try:
        stream = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": TASK_PROMPT},
            ],
            temperature=0.8,
            top_p=0.9,
            max_tokens=400,
            stream=True,
        )

        for chunk in stream:
            if not use_signal and (time.perf_counter() - start) > timeout_sec:
                timed_out = True
                break

            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta:
                if first_token_time is None:
                    first_token_time = time.perf_counter()
                full_text.append(delta)

    except TimeoutError_:
        timed_out = True
    except Exception as e:
        full_text.append(f"[ERROR: {e}]")
    finally:
        if use_signal:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)

    end = time.perf_counter()
    text = "".join(full_text)
    word_count = max(1, len(text.split())) if text else 0

    ttft = (first_token_time - start) if first_token_time else None
    total_time = end - start
    wps = word_count / total_time if total_time > 0 and not timed_out else None

    return {
        "ttft_sec": round(ttft, 3) if ttft else None,
        "total_time_sec": round(total_time, 3),
        "word_count": word_count,
        "words_per_sec": round(wps, 2) if wps else None,
        "timed_out": timed_out,
        "full_response": text,
    }


def append_results_to_csv(rows, path=CSV_PATH):
    """Append rows to CSV, creating the file with a header if it doesn't exist yet.

    Safe to call across multiple separate runs of the script -- results
    accumulate rather than overwrite, so you can compare runs over time.
    """
    file_exists = os.path.isfile(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if not file_exists:
            writer.writeheader()
        writer.writerows(rows)


def main():
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"Session ID: {session_id}")
    print(f"Testing {len(MODELS)} free-endpoint chat models "
          f"(timeout={REQUEST_TIMEOUT_SEC}s each):")
    for m in MODELS:
        print(f"  - {m}")
    print()

    rows = []
    for model in MODELS:
        print(f"--- {model} ---")
        result = run_with_timeout(model)

        status = "TIMED OUT" if result["timed_out"] else "OK"
        print(f"[{status}] TTFT={result['ttft_sec']}s | "
              f"total={result['total_time_sec']}s | "
              f"words={result['word_count']} | "
              f"wps={result['words_per_sec']}")
        print("Full response:")
        print(result["full_response"] if result["full_response"] else "(empty)")
        print()

        rows.append({
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "session_id": session_id,
            "model": model,
            "run": 1,
            **result,
        })

    append_results_to_csv(rows)
    print(f"Appended {len(rows)} results to {CSV_PATH} "
          f"(existing rows preserved).")


if __name__ == "__main__":
    main()
