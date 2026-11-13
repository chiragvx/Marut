"""
tools/promo/promoSfx.py - synthesises the promo B-roll's sound effects from the cues
(.scratch/promo/audio/<clip>.json, written by promoAudio.mjs). Everything is synthesised (no samples).

Per clip, 48 kHz stereo:
  - each jet: broadband roar (Doppler-shifted, duller with distance, stronger from behind), turbine
    whine (from the front), afterburner rumble and crackle;
  - wind on a moving camera; a quiet ground ambience on a still one;
  - missiles: ignition crack and a crackling motor roar for the burn, carried with the missile;
  - gun: every round (57/s makes the GSh-23's buzz); flares: pop and hiss; bombs: the ejector clunk;
  - explosions: crack, body, sub drop, rolling rumble, debris; ground impacts add dirt.
Slow motion (the clip's speed ramp) lowers the pitch. Writes promo/audio/<clip>.wav and the joined cut
promo/audio/promo-broll-sfx.wav (clips with inCut false left out; order from cut.mjs via --order).

  python tools/promo/promoSfx.py 01-scramble 02-weapons-close ...   # clips in cut order
"""
import json
import sys
import os
import numpy as np
from scipy.signal import butter, lfilter, sosfilt
from scipy.io import wavfile

SR = 48000
C = 343.0
SRC = '.scratch/promo/audio'
OUT = 'promo/audio'


def lp(x, fc, order=2):
    return sosfilt(butter(order, min(fc, SR * 0.45) / (SR / 2), output='sos'), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc / (SR / 2), btype='high', output='sos'), x)


def bp(x, f1, f2, order=2):
    return sosfilt(butter(order, [f1 / (SR / 2), min(f2, SR * 0.45) / (SR / 2)], btype='band', output='sos'), x)


def tv_lp(x, fc, block=256):
    """Low-pass with a cutoff varying per sample (applied per block, state carried)."""
    y = np.empty_like(x)
    zi = np.zeros(2)
    for i in range(0, len(x), block):
        f = float(np.clip(fc[min(i + block // 2, len(x) - 1)], 40, SR * 0.45))
        b, a = butter(2, f / (SR / 2))
        y[i:i + block], zi = lfilter(b, a, x[i:i + block], zi=zi * 1.0)
    return y


def pan2(x, pan):
    pan = np.clip(pan, -1, 1) * 0.75
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


def env(n, attack, decay):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t / decay)


class Clip:
    def __init__(self, cue, seed):
        self.cue = cue
        self.rng = np.random.default_rng(seed)
        self.N = int(round(cue['dur'] * SR))
        self.mix = np.zeros((self.N, 2))
        fr = cue['frames']
        self.ft = np.arange(len(fr)) / cue['rate']
        self.t = np.arange(self.N) / SR
        shot = np.array(cue['shotT'], dtype=float)
        shot = shot + np.arange(len(shot)) * 1e-7  # strictly increasing
        self.shot = shot
        self.rate = np.clip(np.gradient(shot, self.ft), 0.05, 3)
        self.cam = np.array([f['cam'] for f in fr])
        look = np.array([f['look'] for f in fr])
        up = np.array([f['up'] for f in fr])
        fwd = look - self.cam
        fwd /= np.linalg.norm(fwd, axis=1, keepdims=True) + 1e-9
        right = np.cross(fwd, up)
        self.right = right / (np.linalg.norm(right, axis=1, keepdims=True) + 1e-9)
        self.camSpeed = np.linalg.norm(np.gradient(self.cam, shot, axis=0), axis=1)

    def at(self, series):
        """A per-frame series sampled per audio sample."""
        return np.interp(self.t, self.ft, series)

    def frame_at(self, out_t):
        return int(np.clip(round(out_t * self.cue['rate']), 0, len(self.ft) - 1))

    def geometry(self, pos):
        """Per frame: distance, pan, Doppler factor for a source at pos (frames x 3)."""
        rel = pos - self.cam
        d = np.linalg.norm(rel, axis=1) + 1e-6
        pan = np.sum(rel / d[:, None] * self.right, axis=1)
        dd = np.gradient(d, self.shot)  # m per shot second (< 0 approaching)
        dop = np.clip(C / (C + np.clip(dd, -300, 300)), 0.55, 2.2)
        return d, pan, dop

    def noise(self, n=None):
        return self.rng.standard_normal(self.N if n is None else n)

    def add(self, x, pan, start=0):
        """Adds a mono signal (pan per sample or a constant) at sample `start`."""
        if start < 0:
            x = x[-start:]
            if not np.isscalar(pan):
                pan = pan[-start:]
            start = 0
        n = min(len(x), self.N - start)
        if n <= 0:
            return
        p = pan if np.isscalar(pan) else pan[:n]
        self.mix[start:start + n] += pan2(x[:n], p)

    def pitch(self, out_t):
        """Pitch factor at an output time: slow motion is lower."""
        r = self.rate[self.frame_at(out_t)]
        return float(np.clip(r, 0.3, 1.3) ** 0.35)

    def stretch(self, x, s):
        """Plays x at speed s (s < 1: lower and longer)."""
        if abs(s - 1) < 0.02:
            return x
        n = int(len(x) / s)
        return np.interp(np.arange(n) * s, np.arange(len(x)), x)

    # --- beds -----------------------------------------------------------------
    def wind(self):
        sp = self.at(self.camSpeed)
        lvl = np.clip(sp / 230, 0, 1.3)
        n = self.noise()
        mod = 1 + 0.35 * lp(self.noise(), 0.7, 1) * 25
        w = bp(n, 250, 1800) * 0.9 + lp(n, 220) * 1.6
        w = w * np.clip(mod, 0.4, 1.8) * lvl * 0.10
        self.add(w * 0.9, -0.3)
        self.add(bp(self.noise(), 300, 2200) * lvl * np.clip(mod[::-1], 0.4, 1.8) * 0.08, 0.3)
        still = np.clip(1 - sp / 40, 0, 1)
        amb = lp(self.noise(), 300) * 0.02 * still
        self.add(amb, 0)

    def jet(self, a_frames, idx):
        pos = np.array([a['pos'] for a in a_frames])
        fwd = np.array([a['fwd'] for a in a_frames])
        ab = np.array([a['ab'] for a in a_frames], dtype=float)
        thr = np.array([a['thr'] for a in a_frames], dtype=float)
        d, pan, dop = self.geometry(pos)
        toCam = (self.cam - pos) / d[:, None]
        behind = np.clip(np.sum(-fwd * toCam, axis=1), 0, 1)
        front = np.clip(np.sum(fwd * toCam, axis=1), 0, 1)
        sp = np.clip(self.rate, 0.3, 1.3) ** 0.35
        # Distant jets keep a low rumble (cinematic: a jet on screen is never silent).
        g = np.maximum(1 / (1 + d / 14), 0.06)
        absorb = np.maximum(15000 / (1 + d / 250), 700)
        D, P, DOP, B, F, AB, THR, SP, G, ABS = (self.at(x) for x in (d, pan, dop, behind, front, ab, thr, sp, g, absorb))
        # Roar: broadband, Doppler and distance on the cutoff.
        n = self.noise()
        brown = np.cumsum(n) * 0.02
        brown = hp(brown, 25)
        roar = tv_lp(n * 0.6 + brown, np.minimum(ABS, 2600 * DOP * SP * (0.6 + 0.4 * THR)))
        roar *= G * (0.5 + 0.9 * B) * (0.5 + 0.5 * THR) * 0.55
        # Turbine whine, from the front.
        f0 = 2350 * (0.7 + 0.3 * THR) * DOP * SP
        ph = np.cumsum(2 * np.pi * f0 / SR)
        jitter = 1 + 0.15 * lp(self.noise(), 3, 1) * 20
        whine = (np.sin(ph) + 0.5 * np.sin(1.51 * ph) + 0.25 * np.sin(3.02 * ph)) * jitter
        whine *= G * (0.15 + 0.85 * F) * 0.05 * (ABS > f0)
        # Afterburner: low rumble with a slow flutter, and crackle.
        rum = lp(self.noise(), 170 * DOP.mean() * SP.mean(), 2) * 3.0
        rum *= 1 + 0.5 * np.clip(lp(self.noise(), 9, 1) * 15, -1, 1)
        rum *= G * AB * (0.4 + 1.2 * B) * 0.5
        cr = (self.rng.random(self.N) < 70 / SR) * self.rng.standard_normal(self.N) * 6
        cr = tv_lp(hp(cr, 300), np.minimum(ABS, 4000 * DOP)) * G * AB * (0.3 + B) * 0.35
        self.add(roar + whine + rum + cr, P)
        # Fly-bys: a fast pass close to the camera gets a whoosh swelling into the closest point.
        closing = -np.gradient(d, self.shot)
        for i in range(1, len(d) - 1):
            if d[i] <= d[i - 1] and d[i] < d[i + 1] and d[i] < 90 and closing[max(i - 12, 0)] > 100:
                t0 = i / self.cue['rate']
                w = 0.35 / max(0.3, float(self.rate[i]))  # wider in slow motion
                e = np.exp(-0.5 * ((self.t - t0) / w) ** 2) * np.where(self.t > t0, np.exp(-(self.t - t0) / (2 * w)), 1)
                sweep = 3500 * np.clip(DOP, 0.6, 1.6)
                wh = tv_lp(self.noise(), sweep) * 1.4 + lp(self.noise(), 120, 2) * 3.0
                self.add(wh * e * min(1, 30 / d[i]) * 0.8, P)

    # --- events ---------------------------------------------------------------
    def dist_at(self, p, out_t):
        i = self.frame_at(max(out_t, 0))
        if isinstance(p, dict):
            p = [p['x'], p['y'], p['z']]
        rel = np.array(p, dtype=float) - self.cam[i]
        d = float(np.linalg.norm(rel)) + 1e-6
        return d, float(np.dot(rel / d, self.right[i]))

    def place(self, x, out_t, p, floor, ref=20):
        d, pan = self.dist_at(p, out_t)
        g = max(1 / (1 + d / ref), floor)
        x = self.stretch(x, self.pitch(max(out_t, 0)))
        if d > 150:
            x = lp(x, max(900, 14000 / (1 + d / 300)))
        self.add(x * g, pan, int(round(out_t * SR)))

    def gun_round(self):
        n = int(0.06 * SR)
        x = self.noise(n)
        crack = hp(x, 1500) * env(n, 0.0002, 0.0025) * 1.2
        bark = bp(x, 400, 2500) * env(n, 0.0005, 0.008) * 1.4
        t = np.arange(n) / SR
        thump = np.sin(2 * np.pi * 85 * t) * env(n, 0.001, 0.02) * 0.9
        return crack + bark + thump

    def flare(self):
        n = int(1.0 * SR)
        x = self.noise(n)
        t = np.arange(n) / SR
        pop = hp(x, 800) * env(n, 0.0003, 0.004) * 1.5 + np.sin(2 * np.pi * 140 * t) * env(n, 0.001, 0.03) * 0.8
        hiss = bp(x, 1800, 7000) * env(n, 0.03, 0.35) * 0.35
        return pop + hiss

    def clunk(self):
        n = int(0.5 * SR)
        t = np.arange(n) / SR
        x = self.noise(n)
        ring = (np.sin(2 * np.pi * 310 * t) + 0.6 * np.sin(2 * np.pi * 870 * t) + 0.3 * np.sin(2 * np.pi * 1630 * t)) * env(n, 0.0005, 0.05)
        return ring * 0.8 + bp(x, 200, 3000) * env(n, 0.0005, 0.01) * 1.5 + np.sin(2 * np.pi * 60 * t) * env(n, 0.002, 0.06)

    def boom(self, size, ground=False):
        n = int((4.5 + 1.5 * size) * SR)
        t = np.arange(n) / SR
        x = self.noise(n)
        crack = hp(x, 1200) * env(n, 0.0005, 0.02) * 1.6
        body = lp(x, 900) * env(n, 0.004, 0.35 * size) * 2.2
        f = 28 + 40 * np.exp(-t / 0.25)
        sub = np.sin(np.cumsum(2 * np.pi * f / SR)) * env(n, 0.006, 0.9 * size) * 1.6
        roll = lp(self.noise(n), 160, 2) * env(n, 0.15, 1.6 * size) * 4.0
        roll *= 1 + 0.6 * np.clip(lp(self.noise(n), 4, 1) * 25, -1, 1)
        deb = (self.rng.random(n) < 30 / SR) * self.rng.standard_normal(n)
        deb = bp(deb, 500, 4000) * env(n, 0.3, 0.9) * 2.0 * (t > 0.15)
        out = crack + body + sub + roll + deb
        if ground:
            dirt = bp(self.noise(n), 150, 1200) * env(n, 0.05, 1.2) * 1.5
            out += dirt
        return out

    def motor(self, sid, launch_out, burn):
        """A missile's motor: ignition, then a crackling roar carried with it for the burn."""
        fr = self.cue['frames']
        pos = np.full((len(fr), 3), np.nan)
        for i, f in enumerate(fr):
            for s in f['st']:
                if s['id'] == sid:
                    pos[i] = s['pos']
        ok = ~np.isnan(pos[:, 0])
        if not ok.any():
            return
        first = int(np.argmax(ok))
        pos[:first] = pos[first]
        last = len(fr) - 1 - int(np.argmax(ok[::-1]))
        pos[last + 1:] = pos[last]
        d, pan, dop = self.geometry(pos)
        sp = np.clip(self.rate, 0.3, 1.3) ** 0.35
        D, P, DOP, SP = (self.at(x) for x in (d, pan, dop, sp))
        # Burning while shot time is within burn s of the launch.
        lshot = np.interp(max(launch_out, 0), self.ft, self.shot) if launch_out >= 0 else self.shot[0] + launch_out
        sh = self.at(self.shot)
        on = np.clip((sh - lshot) / 0.03, 0, 1) * np.clip((lshot + burn - sh) / 0.25, 0, 1)
        g = 0.45 / (1 + D / 30)
        n = self.noise()
        roar = tv_lp(n, np.minimum(16000 / (1 + D / 300), 5200 * DOP * SP))
        crack = (self.rng.random(self.N) < 400 / SR) * self.rng.standard_normal(self.N) * 4
        crack = tv_lp(hp(crack, 400), np.minimum(16000 / (1 + D / 300), 7000 * DOP * SP))
        low = lp(self.noise(), 220, 2) * 3
        self.add((roar * 0.6 + crack * 0.5 + low * 0.5) * g * on * 0.9, P)
        # Ignition.
        if launch_out >= 0:
            m = int(0.8 * SR)
            x = self.noise(m)
            ign = hp(x, 600) * env(m, 0.0005, 0.03) * 0.9 + lp(x, 300) * env(m, 0.002, 0.25) * 1.2
            self.place(ign, launch_out, pos[self.frame_at(launch_out)], 0.15)

    def render(self):
        cue = self.cue
        fr = cue['frames']
        self.wind()
        ids = sorted({a['id'] for f in fr for a in f['ac']})
        for k, aid in enumerate(ids):
            seq = []
            for f in fr:
                a = next((a for a in f['ac'] if a['id'] == aid), None)
                seq.append(a if a else seq[-1])
            self.jet(seq, k)
        launched = {}
        for e in cue['events']:
            ev, t = e['ev'], e['out']
            ty = ev['type']
            if ty == 'gunFire':
                if t >= -0.1:
                    self.place(self.gun_round(), t, ev['pos'], 0.25)
            elif ty == 'countermeasure':
                if t >= -1:
                    self.place(self.flare(), t, ev['pos'], 0.10)
            elif ty == 'explosion':
                if t >= -3:
                    size = float(np.clip(ev.get('radiusM', 10) / 12, 0.7, 1.6))
                    self.place(self.boom(size), t, ev['pos'], 0.7, ref=60)
            elif ty == 'groundImpact':
                if t >= -3:
                    self.place(self.boom(1.2, ground=True) * 0.6, t + 0.02, ev['pos'], 0.5, ref=60)
            elif ty == 'missileLaunch':
                w = ev.get('weapon', '')
                burn = 2.6 if 'ir' in w and 'radar' not in w else 5.5
                launched[ev['missileId']] = True
                self.motor(ev['missileId'], t, burn)
        # Bombs (stores never launched as missiles): the ejector clunk as each appears.
        seen = set()
        for i, f in enumerate(fr):
            for s in f['st']:
                if s['id'] in seen or s['id'] in launched:
                    continue
                seen.add(s['id'])
                if i > 0:
                    self.place(self.clunk(), i / cue['rate'], s['pos'], 0.25)
        # Edges: 8 ms fades (no clicks at the cuts).
        f = int(0.008 * SR)
        ramp = np.linspace(0, 1, f)[:, None]
        self.mix[:f] *= ramp
        self.mix[-f:] *= ramp[::-1]
        return self.mix


def main():
    os.makedirs(OUT, exist_ok=True)
    names = sys.argv[1:]
    clips = []
    for k, name in enumerate(names):
        cue = json.load(open(os.path.join(SRC, name + '.json')))
        mix = Clip(cue, 1000 + k).render()
        clips.append((name, mix))
        print(name, f'peak {np.abs(mix).max():.2f} rms {np.sqrt((mix ** 2).mean()):.3f}')
    # One gain for the whole cut (clips keep their relative levels), a soft limiter, 16-bit.
    allm = np.concatenate([m for _, m in clips])
    gain = 0.18 / (np.sqrt((allm ** 2).mean()) + 1e-9)

    def finish(m):
        # Look-ahead peak limiter (no clipping): the gain needed to keep peaks at -1 dBFS, held over
        # 100 ms around each peak and ramped over 50 ms.
        from scipy.ndimage import minimum_filter1d, uniform_filter1d
        y = m * gain
        ceil = 0.89
        need = np.minimum(1, ceil / (np.abs(y).max(axis=1) + 1e-9))
        g = uniform_filter1d(minimum_filter1d(need, int(0.1 * SR)), int(0.05 * SR))
        return np.clip(y * g[:, None], -ceil, ceil)

    for name, m in clips:
        wavfile.write(os.path.join(OUT, name + '.wav'), SR, (finish(m) * 32767).astype(np.int16))
    wavfile.write(os.path.join(OUT, 'promo-broll-sfx.wav'), SR, (finish(allm) * 32767).astype(np.int16))
    print('gain', round(gain, 3))


if __name__ == '__main__':
    main()
