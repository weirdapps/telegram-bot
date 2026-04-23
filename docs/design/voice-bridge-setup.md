# Voice Bridge — Operator Setup Guide

**Status**: One-time setup, ~5 minutes at the keyboard.
**When to follow**: After plan-002 implementation is merged. The code is fully built and tested; this guide handles the live-cloud wiring.
**Spec**: `docs/design/voice-bridge-design.md`

---

## Why a service-account key (and not ADC)

The bridge process also runs the Anthropic Agent SDK in Vertex mode for Claude. The Anthropic SDK reads `GOOGLE_APPLICATION_CREDENTIALS` from process.env to authenticate against Vertex AI. If we used ADC (`gcloud auth application-default login`) for the personal Google account on this Mac, the credential would override the NBG Vertex auth and every Claude turn would fail with `aiplatform.endpoints.predict denied`.

Workaround: use a **service-account key** scoped to the personal GCP project for STT/TTS, expose it through a bridge-namespaced env var (`VOICE_BRIDGE_GCP_KEY_PATH`), and pass the path explicitly to the Speech and TTS client constructors as `keyFilename`. The Anthropic SDK then never sees the bridge's credential and falls back to ADC (NBG) as designed.

---

## Prerequisites

- The voice bridge code is already implemented (plan-002 completed 2026-04-23, hardened 2026-04-24).
- You have a personal Google account (e.g. `plessasdimitrios@gmail.com`) with a personal GCP project you own (e.g. `gen-lang-client-0063450259` "claude code").
- You're at the Mac with browser access (only Step 1 requires interactive OAuth).

---

## Step 1 — Add the personal Google account to gcloud (interactive)

This is `gcloud auth login`, NOT `gcloud auth application-default login`. It writes to `~/.config/gcloud/credentials.db` and does NOT touch ADC at `~/.config/gcloud/application_default_credentials.json`. Your existing NBG Vertex auth is unaffected.

```bash
gcloud auth login --account=plessasdimitrios@gmail.com
```

A browser opens. **Carefully select `plessasdimitrios@gmail.com` in the picker** — if your browser is signed into both NBG and personal accounts, the picker may default to the wrong one. Use Incognito or sign out of `dimitrios.plessas@nbg.gr` first if unsure. The command prints `You are now logged in as [plessasdimitrios@gmail.com]` on success.

Verify:

```bash
gcloud auth list --format="value(account)"
# Expected: at least one row showing plessasdimitrios@gmail.com
```

---

## Step 2 — Enable the two Cloud APIs on the personal project

```bash
gcloud --account=plessasdimitrios@gmail.com \
  --project=gen-lang-client-0063450259 \
  services enable speech.googleapis.com texttospeech.googleapis.com
```

Both APIs have generous free tiers (60 min/month STT, ~1M chars/month TTS for Chirp 3 voices) — daily driving conversations will not exceed them.

---

## Step 3 — Create the service account, grant roles, download key

```bash
# Create the SA
gcloud --account=plessasdimitrios@gmail.com \
  --project=gen-lang-client-0063450259 \
  iam service-accounts create telegram-voice-bridge \
  --display-name="Telegram Voice Bridge" \
  --description="STT/TTS for the Telegram→Claude voice bridge"

# Grant roles (TWO are required — see WARNING below)
SA="serviceAccount:telegram-voice-bridge@gen-lang-client-0063450259.iam.gserviceaccount.com"
gcloud --account=plessasdimitrios@gmail.com \
  projects add-iam-policy-binding gen-lang-client-0063450259 \
  --member="$SA" --role=roles/serviceusage.serviceUsageConsumer --condition=None
gcloud --account=plessasdimitrios@gmail.com \
  projects add-iam-policy-binding gen-lang-client-0063450259 \
  --member="$SA" --role=roles/speech.client --condition=None

# Download key with mode 0600
gcloud --account=plessasdimitrios@gmail.com \
  iam service-accounts keys create \
  /Users/plessas/.config/gcloud/voice-bridge-sa.json \
  --iam-account=telegram-voice-bridge@gen-lang-client-0063450259.iam.gserviceaccount.com
chmod 600 /Users/plessas/.config/gcloud/voice-bridge-sa.json
```

**WARNING — both roles are required**:
- `roles/serviceusage.serviceUsageConsumer` lets the SA bill the project for API usage.
- `roles/speech.client` grants `speech.recognizers.recognize`, which Speech v2's recognizer-based API requires. The first role alone is sufficient for TTS but Speech v2 will reject every recognize() with `IAM_PERMISSION_DENIED` until the second is granted.

After granting, IAM propagation can take 10–60 s.

---

## Step 4 — Verify with the smoke test

```bash
cd ~/SourceCode/telegram-bot   # (or your CloudStorage-mirrored path)
GOOGLE_APPLICATION_CREDENTIALS=/Users/plessas/.config/gcloud/voice-bridge-sa.json \
  GOOGLE_CLOUD_PROJECT=gen-lang-client-0063450259 \
  npx tsx test_scripts/google-cloud-smoke.ts
```

Expected output ends with `ALL OK`. If TTS reports `ok` and lists Chirp3-HD voices, you're set.

> The smoke test is intentionally narrow: it verifies the SDK can construct clients and list voices, but does NOT call Speech v2 `recognize()`. To prove end-to-end recognize() works, send a real voice note to the bridge after Step 6.

If you see `PERMISSION_DENIED`, recheck both role bindings from Step 3 and wait another minute for propagation.

---

## Step 5 — Add the env vars to `.env`

Append to `~/SourceCode/telegram-bot/.env`:

```bash
# --- Voice Bridge (plan-002) ---
# NOTE: bridge-namespaced var, NOT GOOGLE_APPLICATION_CREDENTIALS — see voice-bridge-design.md §5
VOICE_BRIDGE_GCP_KEY_PATH=/Users/plessas/.config/gcloud/voice-bridge-sa.json
GOOGLE_CLOUD_PROJECT=gen-lang-client-0063450259
VOICE_BRIDGE_TTS_VOICE_EL=el-GR-Chirp3-HD-Aoede
VOICE_BRIDGE_TTS_VOICE_EN=en-US-Chirp3-HD-Aoede
VOICE_BRIDGE_MAX_AUDIO_SECONDS=60
VOICE_BRIDGE_REJECT_ABOVE_SECONDS=300
VOICE_BRIDGE_KEEP_AUDIO_FILES=false
```

Pick different Chirp 3 HD voices if you prefer. List them with:

```bash
gcloud --account=plessasdimitrios@gmail.com \
  --project=gen-lang-client-0063450259 \
  ml language list-voices \
  --filter="languageCodes=el-GR AND name:Chirp3-HD" --format="value(name)"
```

(Same for `en-US`.) Common picks: `Aoede` (warm female), `Charon` (calm male), `Puck` (energetic), `Sage` (measured).

---

## Step 6 — Restart the bridge

```bash
# If running via LaunchAgent
launchctl kickstart -k gui/$UID/com.weirdapps.telegram-claude-bridge

# Or if running manually in a terminal
# Ctrl+C the existing process, then:
cd ~/SourceCode/telegram-bot && npm run bridge
```

The bridge log on startup should now read `bridge listening (text + voice)` instead of just `bridge listening`. If a `VoiceBridgeConfigError` appears, re-check the env var that's named in the error message.

---

## Step 7 — Send yourself a test voice note

Open Telegram on your phone, hold the microphone in your saved-messages chat (or wherever the bridge is wired to), record:

- "Hello Claude, can you hear me?" → expect English voice reply within ~5 seconds.
- "γεια σου Claude, με ακούς;" → expect Greek voice reply.

Try the slash commands:

- `/voice off` → next voice message gets text-only reply.
- `/voice always` → next text message gets text + voice reply.
- `/voice mirror` → back to default (mirror the input modality).
- `/voice` (bare) → shows current mode + usage.

---

## Key rotation

SA keys do not expire. To rotate:

```bash
# Create the new key first (overwrites the old file)
gcloud --account=plessasdimitrios@gmail.com \
  iam service-accounts keys create /Users/plessas/.config/gcloud/voice-bridge-sa.json \
  --iam-account=telegram-voice-bridge@gen-lang-client-0063450259.iam.gserviceaccount.com
chmod 600 /Users/plessas/.config/gcloud/voice-bridge-sa.json

# Restart bridge (picks up new key on next STT/TTS call)
launchctl kickstart -k gui/$UID/com.weirdapps.telegram-claude-bridge

# List existing keys, pick the OLD key id, delete it
gcloud --account=plessasdimitrios@gmail.com \
  iam service-accounts keys list \
  --iam-account=telegram-voice-bridge@gen-lang-client-0063450259.iam.gserviceaccount.com
gcloud --account=plessasdimitrios@gmail.com \
  iam service-accounts keys delete <OLD_KEY_ID> \
  --iam-account=telegram-voice-bridge@gen-lang-client-0063450259.iam.gserviceaccount.com
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bridge crashes on startup with `VoiceBridgeConfigError: VAR_NAME is not set` | Missing env var | Add to `.env`, restart bridge |
| Voice note replied with `voice transcription failed: ... PERMISSION_DENIED ... speech.recognizers.recognize` | SA missing `roles/speech.client` | Re-run Step 3 grants, wait 60 s for IAM propagation |
| Voice note replied with `voice transcription failed: ... model "chirp_2" does not exist in the location ...` | Code drift back to chirp_2 | Confirm `bridge/src/stt/google.ts` uses `STT_LOCATION='eu'` and `STT_MODEL='long'` |
| Voice note replied with `couldn't make out the voice note` despite clear speech | Confidence-zero transcripts being rejected | Confirm `bridge/src/stt/google.ts` skips zero-confidence in aggregation (the `top.confidence > 0` guard) |
| Claude responses fail with `aiplatform.endpoints.predict denied on resource '//.../projects/nbg-...'` | `GOOGLE_APPLICATION_CREDENTIALS` is set in process env, hijacking Anthropic SDK auth | Confirm `.env` uses `VOICE_BRIDGE_GCP_KEY_PATH` (not `GOOGLE_APPLICATION_CREDENTIALS`); restart bridge |
| Reply arrives as a generic file attachment, not a playable waveform | `voice: true` flag missing — check `sendVoice` in TelegramUserClient.ts | Should not happen with current code; file an issue |
| Voice replies in robotic Greek, not Chirp3-HD | Voice name typo in `VOICE_BRIDGE_TTS_VOICE_EL` | Verify with `gcloud ml language list-voices` |
| Long Greek replies cut off mid-sentence with no tail message | Truncation worked but the tail phrase is missing — check `truncateForSpeech` in replyRouter.ts | Should not happen; tail is always appended |
