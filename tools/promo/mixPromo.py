"""
tools/promo/mixPromo.py - the promo's final mix: the music under the sound effects, onto the cut.

The music starts so that its drop (DROP s into the track) lands on the cut into the clip DROP_CLIP;
it fades out at the end. Music and effects are limited separately (the music never moves with the
effects: no ducking, no limiter on the sum), with ceilings that keep their sum from clipping.
Writes, in promo/:
  promo-final.mp4           the cut with music + effects (AAC 320k)
  promo-broll-cut.mp4       the cut with effects only
  audio/promo-music.wav     the music as placed (stem), audio/promo-broll-sfx.wav (from promoSfx.py)

  python tools/promo/mixPromo.py "Lutt Le Gaya Dhurandhar 128 Kbps.mp3"
"""
import os
import re
import subprocess
import sys

MUSIC = sys.argv[1]
DROP = float(os.environ.get('DROP', 13.78))  # the drop in this track, s
DROP_CLIP = os.environ.get('DROP_CLIP', '04-afterburner')
MUSIC_DB = float(os.environ.get('MUSIC_DB', 2))
SFX_DB = float(os.environ.get('SFX_DB', -4))  # the effects under the music, final mix only
MUSIC_CEIL = float(os.environ.get('MUSIC_CEIL', 0.6))  # each one's own peak ceiling (sum < 1)
SFX_CEIL = float(os.environ.get('SFX_CEIL', 0.3))
FADE = float(os.environ.get('FADE', 0.4))  # the music's fade at the end, s
OUT = 'promo'


def dur(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).decode().strip())


cut = open('tools/promo/cut.mjs', encoding='utf-8').read()
clips = [m.group(1) for m in re.finditer(r"\{ name: '([^']+)', shot: [^,]+(, inCut: false)?", cut) if not m.group(2)]
start = 0.0
for c in clips:
    if c == DROP_CLIP:
        break
    start += dur(os.path.join(OUT, c + '.mp4'))
delay = start - DROP
if abs(delay) < 0.05:  # within a frame or so: the music starts with the picture
    delay = 0.0
video = os.path.join(OUT, 'promo-broll-cut.mp4')
total = sum(dur(os.path.join(OUT, c + '.mp4')) for c in clips)
sfx = os.path.join(OUT, 'audio', 'promo-broll-sfx.wav')
print(f'{len(clips)} clips, {total:.2f} s; drop at {start:.2f} s; music offset {delay:+.2f} s')

# The music, placed: delayed (or trimmed) so the drop lands on the cut, faded out over the last 2 s.
lead = f'adelay={int(delay * 1000)}:all=1,' if delay > 0 else (f'atrim=start={-delay},asetpts=PTS-STARTPTS,' if delay < 0 else '')
music_f = f'[0:a]aresample=48000,{lead}atrim=duration={total},afade=t=out:st={total - FADE}:d={FADE},volume={MUSIC_DB}dB'
music_wav = os.path.join(OUT, 'audio', 'promo-music.wav')
subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-i', MUSIC, '-filter_complex', music_f + '[m]', '-map', '[m]', '-ac', '2', music_wav])

# Effects-only cut (the video stream copied).
silent = os.path.join(OUT, '.cut-video.mp4')
# capturePromo.mjs writes the cut silent: keep that as the picture (a cut that already has sound was made here).
has_audio = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', video]).strip()
if not has_audio:
    os.replace(video, silent)
subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', sfx, '-filter_complex', '[1:a]aresample=192000,alimiter=limit=0.7:attack=2:release=80:level=false,aresample=48000[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', video])

# Final: each limited on its own (4x oversampled, true peaks), then simply added.
lim = 'aresample=192000,alimiter=limit={}:attack=2:release=80:level=false,aresample=48000'
mix = (f'[1:a]volume={SFX_DB}dB,{lim.format(SFX_CEIL)}[s];'
       f'[2:a]{lim.format(MUSIC_CEIL)}[m];'
       '[m][s]amix=inputs=2:normalize=0,volume=0.44dB[a]')  # static output gain (+25% on the old -1.5 dB trim; AAC overshoot kept under 0 dBTP)
subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', sfx, '-i', music_wav, '-filter_complex', mix, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', os.path.join(OUT, 'promo-final.mp4')])
print('wrote', os.path.join(OUT, 'promo-final.mp4'), 'and', video)
