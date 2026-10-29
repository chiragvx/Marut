# Voice warnings

One file per line, named exactly as below (`.mp3`, mono, 44.1 or 48 kHz, silence trimmed, all
peaking around -1 dBFS). A missing file is spoken by the browser's own voice instead, so lines can
be added one at a time. Each file is a single utterance: the game repeats the lines that repeat.
The triggers and priorities are in `src/ui/audio/voiceWarnings.ts` (VOICE_LINES).

| File | Says | When |
|---|---|---|
| pull_up.mp3 | Pull up | Ground collision warning (repeats) |
| engine_fire.mp3 | Engine fire | Engine fire (repeats) |
| missile_launch.mp3 | Missile launch | A missile guided at you (repeats) |
| stall.mp3 | Angle of attack | Stall (repeats) |
| over_g.mp3 | Over G | Over-G |
| overspeed.mp3 | Overspeed | Overspeed |
| gear.mp3 | Gear | Gear up, low and slow |
| configuration.mp3 | Configuration | Gear or flaps wrong for the speed |
| radar_lock.mp3 | Radar lock | A hostile radar locks on |
| fuel_low.mp3 | Fuel low | Low fuel |
| bingo.mp3 | Bingo fuel | 15% of the fullest the tanks have been |
| autopilot_off.mp3 | Autopilot disengaged | Autopilot disconnects |
| chaff_low.mp3 | Chaff low | A quarter of the chaff left |
| chaff_out.mp3 | Chaff out | No chaff left |
| flare_low.mp3 | Flare low | A quarter of the flares left |
| flare_out.mp3 | Flare out | No flares left |
| warning.mp3 | Warning | Spare (not used yet) |
