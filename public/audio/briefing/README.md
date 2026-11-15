# Mission intro narration

The narrator of the campaign missions' war-room intros (src/briefing). One file per line,
`<id>.mp3`, the id and its text from the lines table `src/briefing/lines.json`. Played clean (no
radio sound) by src/briefing/briefingAudio.ts, under subtitles taken from the intro's script
(src/briefing/scripts/*.ts).

The files here are placeholders rendered with Microsoft's en-IN-PrabhatNeural through edge-tts
(rate -6%, pitch -12 Hz, silence trimmed, a quarter second of air at the end, loudness -18 LUFS):

    ONLY=br_ska_01,br_ska_02 FORCE=1 node tools/audio/genRadio.mjs

## Swapping in recorded voice (ElevenLabs, CereProc, an actor)

1. Record each line in `src/briefing/lines.json` (Simikot Lifeline: `br_ska_01` .. `br_ska_08`).
2. Save each as `public/audio/briefing/<id>.mp3` with the same name, replacing the file here: mono
   or stereo, 44.1 or 48 kHz, constant bit rate (96-128 kbps), silence trimmed at the start,
   about -18 LUFS. Nothing else changes: the game loads them by id.
3. Run `npx vitest run tests/briefing`. It checks every line has its file and that each recording
   ends before the next line starts. If a take runs longer, move that line's `t` (and the beats
   after it) in its script, `src/briefing/scripts/simikotLifeline.ts`.
4. If a take changes the words, change the line's text in `lines.json` and its `subtitle` in the
   script to match.

Room tone, distant radio chatter, pin ticks and the low hits are made in code (Web Audio), not
files.
