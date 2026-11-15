# Mission intro sound

The campaign missions' war-room intros (src/briefing) play their narration clean (no radio
sound) and, where they have one, a music score under it, through src/briefing/briefingAudio.ts.
Both are mixed live in the game (the score ducked about 9 dB under the voice, lifted after it,
faded out at the end or on a skip), so the files here stay raw and can be swapped.

## Simikot Lifeline

- `simikot_narration.mp3`: the whole narration in one take (ElevenLabs, 53.7 s, mono 128 kbps,
  as delivered). Its text, with the delivery tags it was generated from (`[serious]`,
  `[short pause]`, `[inhales deeply]`, `[thoughtful]`, `[firmly]`), is the lines table
  `src/briefing/lines.json`, `br_ska_01` .. `br_ska_12`, one entry a subtitle cue.
- `score_silent_advance.mp3`: "Silent Advance" (Suno), the first 74 s of it with a 5 s fade
  at the end, 128 kbps stereo. The intro uses 70 s of it.

The intro (`src/briefing/scripts/simikotLifeline.ts`) starts the score at 0 s and the narration at
`NARRATION_AT` (4 s). `SIMIKOT_NARRATION_CUES` gives each line's start and end in the recording,
read from its silences:

    ffmpeg -i simikot_narration.mp3 -af silencedetect=n=-38dB:d=0.22 -f null -

The subtitles show the cue's words (its text in lines.json without the tags), and the pins,
arrows, cuts and cards are timed from the cues, so they stay on the words.

### A new take

1. Generate it from `lines.json` (paste the lines in order, tags and all).
2. Save it as `public/audio/briefing/simikot_narration.mp3`, replacing the file here (mp3,
   constant bit rate 96-128 kbps, no silence at the start).
3. Measure its silences (the command above) and update `SIMIKOT_NARRATION_CUES` to the new
   times. If its length changes a lot, move the beats in the script with it (they are written as
   `v(<seconds into the recording>)`) and `durationSec`.
4. If the words change, change the line in `lines.json` (the subtitle follows it).
5. Run `npx vitest run tests/briefing`: it checks the files exist, the cues are in order and
   inside the recording, and the pins, arrows and mission card sit on their lines.

## Other intros

An intro can instead play one clip a line (`line` beats, `public/audio/briefing/<id>.mp3`). A
placeholder for such a line can be rendered with edge-tts (en-IN-PrabhatNeural, slower and
lower, tags stripped), named explicitly:

    ONLY=br_xyz_01,br_xyz_02 FORCE=1 node tools/audio/genRadio.mjs

Pin ticks (and, in an intro without a score, the room tone, distant chatter and low hits) are
made in code (Web Audio), not files.
