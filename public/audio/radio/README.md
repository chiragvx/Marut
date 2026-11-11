# Radio calls

The scripted missions' radio (src/script): the AEW&C controller "Netra" and the strike calls.
Generated with Microsoft's Indian English neural voice en-IN-PrabhatNeural (edge-tts, rate +8%),
silence trimmed and loudness normalised with ffmpeg, by `node tools/audio/genRadio.mjs` from the
line table `src/script/radioLines.json` (one file per line id). The radio sound (band-pass, drive,
hiss, squelch) is added in the game by src/script/radioPlayer.ts, so the files are clean.

Numbers are separate clips (`n0`..`n9` said digit by digit, `niner` for 9; `w9`..`w19`, `t20`..`t90`
and `hundred` for ranges and altitudes) so the calls can carry live bearings, ranges, altitudes and
coordinates.

For a public release, regenerate through Azure Speech (same voice, licensed output).
