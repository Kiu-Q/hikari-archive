# Chinese captions, Japanese custom voice

Hikari's OpenClaw HTTP system prompt now requests both fields:

```json
{
  "text": "老師，早晨！",
  "text_ja": "先生、おはよう！",
  "animation": { "file": "wave_fast.vrma", "timing": "during" },
  "expression": { "name": "neutral" }
}
```

`text` retains the original Traditional Chinese/Cantonese response for the
bubble and chat history. Only `text_ja` is sent to the Japanese custom voice.
The two fields must express the same meaning and tone. The Japanese translation
is limited to 500 characters. Desktop-awareness reactions use the same fields;
`{"react":false}` remains silent. Existing replies without a valid `text_ja`
remain visible but are not spoken by the Japanese model.

## Run on this Mac

Run the app normally with `npm run dev`. Restart it after changing Electron main
or preload code. Speech uses the existing local service on port 8010, or starts
the bundled adapter in `tools/companion-tts` if that service is absent. The
adapter reuses/starts the Style-Bert-VITS2 editor engine on port 8000.

`tools/companion-tts/config.json` points to this Mac's installed trained model
and Python runtime. These large dependencies are external to the app. Update
those paths when moving to another machine; a packaged app still requires them.
`HIKARI_TTS_TOOL_DIR` overrides the adapter folder, and `HIKARI_TTS_PYTHON`
overrides the Python executable used to start the adapter.

The app sends a narrow request through preload IPC to its main process. The main
process fetches WAV bytes and passes them back to the renderer. Generation is
serialized and repeated sentences use the adapter's cache. If the voice service
fails, the Chinese reply remains in history and a voice-unavailable status is
shown. No Chinese audio is substituted.

## Mouth and animation timing

The mouth reads the actual audio waveform through Web Audio: it opens for sound
and closes during silence. This is audio-driven mouth opening, not phoneme-aligned
Japanese vowel prediction. The model stays in its speaking state while preparing
and playing audio; `after` animations await the real playback completion promise.
Stop cancels playback and prevents a late generation result from playing. Audio
URLs and audio contexts are released after completion, errors, or cancellation.

The reply is staged before presentation: generate the WAV, prepare the animation
clip without playing it, then start playback. The audio's actual `playing` event
reveals the Chinese bubble/history, starts the prepared animation, and applies
the expression together. No new reply text or response animation is shown while
TTS is still generating. If speech cannot be generated, the Chinese reply is
shown as a text-only fallback.

## Checks

```sh
node --test test/*.test.js
node_modules/.bin/electron test/japanese-voice.smoke.mjs
```

The Electron smoke check uses the installed custom model, real preload IPC, and
Chromium audio playback in a muted hidden window. It verifies Chinese captions,
Japanese-only synthesis input, audio-driven mouth movement, and neutral mouth at
the end. It does not send a new conversation to OpenClaw.

Verified both with an already-running adapter and with automatic adapter startup.
The real Electron check displayed `老師，早晨！`, synthesized `先生、おはよう。`,
detected mouth opening and closing from the audio, and finished with a neutral mouth.
Requests and replies are kept in their existing queues; a new message waits for
the current response. Closing/reloading the renderer cancels its current audio.
