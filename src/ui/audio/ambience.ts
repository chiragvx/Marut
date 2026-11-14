/**
 * src/ui/audio/ambience.ts — the sound of the jet, synthesised (no recorded sound):
 *
 * - the engine (src/ui/audio/engineModel.ts, engineVoice.ts): its RPM following the sim's spool,
 *   the fan's whine, the buzz-saw at high power, the jet's roar, the afterburner lighting with a
 *   thump; muffled in the cockpit, where the air conditioning's steady rush is louder (the
 *   loudest thing in a Tejas cockpit, its test pilots say);
 * - a multi-engine aircraft (AircraftDefinition.engines, e.g. the C-17) instead gets one big
 *   high-bypass turbofan voice per engine (src/ui/audio/heavyEngineModel.ts, heavyEngineVoice.ts),
 *   each driven by its own N1 and reverser and placed at its engine, louder and heard further;
 * - the wind rising with the airspeed (more with the airbrake out or the gear down);
 * - all of it placed in 3D (src/ui/audio/spatial.ts): the whine at the intakes, the roar and
 *   rumble at the nozzle, the air conditioning at the vents either side of the pilot, the wind
 *   over the canopy, heard from the camera; in the cockpit, in the cockpit's own small room;
 * - the gun (src/ui/audio/gunSound.ts): the GSh-23's hard ~57-shot-a-second "brrrrt", a thump of
 *   the airframe under each crack in the cockpit, a ripping report outside, duller further off;
 * - one-shots from the sim's events: a store's release thump, a missile's motor, chaff and
 *   flares, the gear's motor and its lock, touchdown, hits on you, and explosions near you (heard
 *   after the sound's travel time);
 * - the sonic boom (src/ui/audio/sonicBoom.ts): from a camera standing still outside (the flyby
 *   view), a supersonic jet comes in silence, the boom cracks as its Mach cone sweeps over, then
 *   the roar.
 *
 * `ambienceLevels` (pure, tested) maps the flight state to the air conditioning's and wind's levels.
 */
import type { SimEvent, Vec3Like } from '../../contracts/core';
import type { AircraftDefinition } from '../../contracts/aircraft';
import { createHeavyEngineStates, createHeavyVoiceParams, heavyEngineParams, heavyEngineProfile, stepHeavyEngine, type HeavyEngineProfile, type HeavyEngineState } from './heavyEngineModel';
import { createHeavyEngineRig, type HeavyEngineRig } from './heavyEngineVoice';
import { TargetParam } from './targetParam';
import { AudioChannel, type AudioBus } from './audioBus';
import { createEngineSoundState, engineVoiceParams, stepEngineSound, type EngineSoundEvents, type EngineVoiceParams } from './engineModel';
import { createEngineVoice, type EngineVoice } from './engineVoice';
import { createGunVoice, type GunVoice } from './gunSound';
import { boomGain, createBoomBuffer, machConeState, soundSpeedAt } from './sonicBoom';
import { createCockpitRoom, createEmitter, multiplyQuat, rotate, rotateInverse, type Airframe, type Emitter, type Listener } from './spatial';
import { COCKPIT_EYE_OFFSET_BODY_M, type CameraState } from '../../contracts/render';

export interface AmbienceInputs {
  alive: boolean;
  /** The sim's spooled throttle (0..1), afterburner lit, and fuel left (none: the engine runs down). */
  throttle: number;
  afterburner: boolean;
  fuelKg: number;
  iasMps: number;
  /** Gear position 0 up .. 1 down. */
  gearPos: number;
  airbrake: boolean;
  /** Listening from the cockpit (else from outside the jet). */
  inCockpit: boolean;
  /** Multi-engine aircraft: each engine's N1 and reverser position (SnapshotEntity.ENGINES). */
  engineN1?: readonly number[];
  engineRev?: readonly number[];
}

export interface AmbienceLevels {
  aircon: number;
  wind: number;
  windHz: number;
}

const SOUND_MPS = 340;
/** Explosions further than this are not heard. */
const HEAR_EXPLOSION_M = 6000;

export function ambienceLevels(inp: AmbienceInputs, out: AmbienceLevels): AmbienceLevels {
  if (!inp.alive) {
    out.aircon = out.wind = 0;
    return out;
  }
  const q = Math.min(1, (inp.iasMps / 300) ** 2);
  const drag = 1 + (inp.airbrake ? 0.5 : 0) + inp.gearPos * 0.35;
  out.aircon = inp.inCockpit ? 0.05 : 0;
  out.wind = Math.min(inp.inCockpit ? 0.16 : 0.12, (inp.inCockpit ? 0.11 : 0.07) * q * drag);
  out.windHz = 350 + inp.iasMps * 4;
  return out;
}

export interface Ambience {
  /** The aircraft flown (its engines' sound follows its data). */
  setAircraft(def: AircraftDefinition): void;
  update(inp: AmbienceInputs, dtSec: number): void;
  /** The sim's events (only the ones about you, or near you, sound). */
  event(ev: SimEvent, playerId: number, playerPos: Vec3Like): void;
  /** Each rendered frame: where the camera is (3D sound). `pilotsEars`: hear from the pilot's seat whatever the camera shows (the pod view). */
  listen(camera: CameraState, pilotsEars: boolean): void;
  silence(): void;
}

/** Where the sounds are on the airframe (body frame, m: +X nose, +Y canopy, +Z right). */
const INTAKE_BODY = { x: 2.0, y: -0.5, z: 0 };
const NOZZLE_BODY = { x: -6.3, y: 0, z: 0 };
const VENT_BODY = (side: number) => ({ x: 3.9, y: 0.55, z: 0.35 * side });
const CANOPY_BODY = (side: number) => ({ x: 3.5, y: 1.2, z: 0.55 * side });
/** The heavy engines' voices are updated this often, s (their params glide in between). */
const HEAVY_UPDATE_SEC = 1 / 15;
/** The camera looking along the nose (three.js camera -Z onto body +X): a -90 deg turn about +Y. */
const NOSE_LOOK = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

interface Loop {
  gain: GainNode;
  filter: BiquadFilterNode;
  osc?: OscillatorNode;
}

export function createAmbience(bus: AudioBus): Ambience {
  let loops: { airconL: Loop; airconR: Loop; windL: Loop; windR: Loop; gearMotor: Loop } | null = null;
  let engine: EngineVoice | null = null;
  let emitters: Emitter[] = [];
  let engineOuts: { front: AudioNode; rear: AudioNode } | null = null;
  let engineEmitters: Emitter[] = [];
  let cockpitRoom: AudioNode | null = null;
  // A multi-engine aircraft's engines: built on first use, one emitter and voice per engine.
  let heavyProfile: HeavyEngineProfile | null = null;
  let heavyId = '';
  let heavy: { rig: HeavyEngineRig; emitters: Emitter[]; states: HeavyEngineState[] } | null = null;
  let heavyAccum = 0;
  let heavyFresh = true;
  /** Where the listener is round the aircraft: +1 ahead .. -1 behind (outside only). */
  let aspect = 0;
  const heavyParams = createHeavyVoiceParams();
  const toEar = { x: 0, y: 0, z: 0 };
  let fighterQuiet = false;
  let inside = true;
  const listener: Listener = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } };
  const jet: Airframe = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } };
  const eyeWorld = { x: 0, y: 0, z: 0 };
  const engineState = createEngineSoundState();
  const engineEv: EngineSoundEvents = { abLit: false, abOut: false };
  const engineParams: EngineVoiceParams = { whineHz: 0, whine: 0, shaftHz: 0, buzz: 0, jet: 0, jetHz: 0, rumble: 0, ab: 0, crackle: 0, muffleHz: 0 };
  let gearWas = -1;
  let gun: GunVoice | null = null;
  let live = false;
  const lv: AmbienceLevels = { aircon: 0, wind: 0, windHz: 0 };
  // The sonic boom: the jet's sound outside goes through `hush` (silent ahead of the Mach cone).
  let hush: GainNode | null = null;
  let hushLevel: TargetParam | null = null;
  let coneWas: 'subsonic' | 'outside' | 'inside' | null = null;
  let boomPrevMs = -1;
  const prevJet = { x: 0, y: 0, z: 0 };
  const prevEar = { x: 0, y: 0, z: 0 };
  const jetVel = { x: 0, y: 0, z: 0 };
  const relBoom = { x: 0, y: 0, z: 0 };

  const build = (): typeof loops => {
    const ac = bus.context();
    const amb = bus.channel(AudioChannel.Ambience);
    const fx = bus.channel(AudioChannel.Effects);
    const noise = bus.noise();
    if (!ac || !amb || !fx || !noise) return null;
    const room = createCockpitRoom(ac, amb);
    gun = createGunVoice(ac, fx);
    hush = ac.createGain();
    hush.connect(amb);
    hushLevel = new TargetParam(hush.gain, 1e-4);
    const place = (body: Vec3Like, cone?: Parameters<typeof createEmitter>[4]): AudioNode => {
      const e = createEmitter(ac, hush!, room, body, cone);
      emitters.push(e);
      return e.input;
    };
    engineOuts = {
      front: place(INTAKE_BODY, { cone: { dir: { x: 1, y: 0, z: 0 }, innerDeg: 100, outerDeg: 260, outerGain: 0.4 } }),
      rear: place(NOZZLE_BODY, { cone: { dir: { x: -1, y: 0, z: 0 }, innerDeg: 120, outerDeg: 300, outerGain: 0.55 } }),
    };
    engineEmitters = [emitters[0]!, emitters[1]!];
    cockpitRoom = room;
    const noiseLoop = (type: BiquadFilterType, hz: number, q: number, dest: AudioNode): Loop => {
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      // Each loop starts at a different place in the buffer, so they never beat together.
      src.start(0, Math.random() * 1.9);
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = hz;
      filter.Q.value = q;
      const gain = ac.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(dest);
      return { gain, filter };
    };
    const oscLoop = (type: OscillatorType, hz: number, filterType: BiquadFilterType, fhz: number, q: number, dest: AudioNode): Loop => {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      osc.start();
      const filter = ac.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = fhz;
      filter.Q.value = q;
      const gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(dest);
      return { gain, filter, osc };
    };
    return {
      airconL: noiseLoop('highpass', 2200, 0.5, place(VENT_BODY(-1))),
      airconR: noiseLoop('highpass', 2200, 0.5, place(VENT_BODY(1))),
      windL: noiseLoop('bandpass', 800, 0.6, place(CANOPY_BODY(-1))),
      windR: noiseLoop('bandpass', 800, 0.6, place(CANOPY_BODY(1))),
      gearMotor: oscLoop('sawtooth', 110, 'lowpass', 500, 1, fx),
    };
  };

  /** A short burst: a falling tone under filtered noise. */
  const thump = (opts: { hz: number; toHz: number; sec: number; gain: number; noise?: number; noiseHz?: number; delaySec?: number }): void => {
    const ac = bus.context();
    const fx = bus.channel(AudioChannel.Effects);
    const noise = bus.noise();
    if (!ac || !fx || !noise) return;
    const t0 = ac.currentTime + 0.005 + (opts.delaySec ?? 0);
    const end = t0 + opts.sec;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.hz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.toHz), end);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(fx);
    osc.start(t0);
    osc.stop(end + 0.02);
    if (opts.noise) {
      const src = ac.createBufferSource();
      src.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.noiseHz ?? 1200;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0, t0);
      ng.gain.linearRampToValueAtTime(opts.noise, t0 + 0.01);
      ng.gain.exponentialRampToValueAtTime(0.0001, end);
      src.connect(f).connect(ng).connect(fx);
      src.start(t0, Math.random());
      src.stop(end + 0.02);
    }
  };

  /** The boom, from the direction of the jet (listener frame x: right), at `distM` from it. */
  const boom = (distM: number, panX: number): void => {
    const ac = bus.context();
    const fx = bus.channel(AudioChannel.Effects);
    if (!ac || !fx) return;
    const src = ac.createBufferSource();
    src.buffer = createBoomBuffer(ac, distM);
    const g = ac.createGain();
    g.gain.value = boomGain(distM);
    const pan = ac.createStereoPanner();
    pan.pan.value = Math.max(-0.6, Math.min(0.6, panX));
    src.connect(g).connect(pan).connect(fx);
    src.start();
  };

  /** The Mach cone against a listener standing still outside: silence ahead of it, the boom as it passes. */
  const machCone = (nowMs: number, fixedEar: boolean): void => {
    const ac = bus.context();
    if (!ac || !hush) return;
    const dt = (nowMs - boomPrevMs) / 1000;
    const ok = boomPrevMs >= 0 && dt > 1e-3 && dt < 0.25;
    let state: typeof coneWas = null;
    if (ok) {
      const k = 1 - Math.exp(-dt / 0.1);
      jetVel.x += ((jet.pos.x - prevJet.x) / dt - jetVel.x) * k;
      jetVel.y += ((jet.pos.y - prevJet.y) / dt - jetVel.y) * k;
      jetVel.z += ((jet.pos.z - prevJet.z) / dt - jetVel.z) * k;
      // Only a listener standing still (the flyby camera): one riding along (chase) or jumping to
      // a new place (a view change) does not count.
      const earMove = Math.hypot(listener.pos.x - prevEar.x, listener.pos.y - prevEar.y, listener.pos.z - prevEar.z);
      if (fixedEar && earMove < 40 * dt + 0.5) {
        relBoom.x = jet.pos.x - listener.pos.x;
        relBoom.y = jet.pos.y - listener.pos.y;
        relBoom.z = jet.pos.z - listener.pos.z;
        state = machConeState(relBoom, jetVel, soundSpeedAt(jet.pos.y));
      }
    } else jetVel.x = jetVel.y = jetVel.z = 0;
    if (state === 'inside' && coneWas === 'outside') {
      const dist = Math.hypot(relBoom.x, relBoom.y, relBoom.z);
      if (dist < 15000) {
        rotateInverse(listener.rot, relBoom, relBoom);
        boom(dist, relBoom.x / Math.max(1, dist));
      }
    }
    // Ahead of the cone the jet is not heard yet; once it has passed, its roar comes in.
    if (state === 'outside') hushLevel?.to(0, ac.currentTime, 0.15);
    // (A one-frame jump of the flyby camera to its next place keeps what it had.)
    else if (state !== null || !fixedEar || !ok) hushLevel?.to(1, ac.currentTime, state === 'inside' && coneWas === 'outside' ? 0.12 : 0.05);
    coneWas = state;
    boomPrevMs = nowMs;
    Object.assign(prevJet, jet.pos);
    Object.assign(prevEar, listener.pos);
  };

  // The air conditioning's, wind's and gear motor's levels: only real changes are sent.
  const loopParams = new Map<AudioParam, TargetParam>();
  const setLoop = (p: AudioParam, v: number, tc: number, relEps = 2e-3): void => {
    const ac = bus.context();
    if (!ac) return;
    let tp = loopParams.get(p);
    if (!tp) loopParams.set(p, (tp = new TargetParam(p, 1e-5, relEps)));
    tp.to(v, ac.currentTime, tc);
  };

  const disposeHeavy = (): void => {
    if (!heavy) return;
    heavy.rig.dispose();
    for (const e of heavy.emitters) e.dispose();
    heavy = null;
  };
  const buildHeavy = (ac: BaseAudioContext, prof: HeavyEngineProfile): typeof heavy => {
    if (!hush) return null;
    const ems = prof.positions.map((p) => createEmitter(ac, hush!, cockpitRoom, p, { range: { hearM: prof.hearM, refM: prof.refM }, panning: 'equalpower' }));
    return {
      rig: createHeavyEngineRig(ac, ems.map((e) => e.input), prof.blades),
      emitters: ems,
      states: createHeavyEngineStates(prof.count),
    };
  };

  return {
    setAircraft(def) {
      if (def.id === heavyId) return;
      heavyId = def.id;
      heavyProfile = heavyEngineProfile(def);
      disposeHeavy();
      heavyFresh = true;
      engineState.initialised = false;
    },
    update(inp, dt) {
      if (!loops) loops = build();
      if (!loops) return;
      const ac = bus.context()!;
      if (!engine) engine = createEngineVoice(ac, engineOuts!);
      live = true;
      inside = inp.inCockpit;
      const ear = inp.inCockpit ? 'cockpit' : 'outside';
      if (heavyProfile) {
        if (!heavy) {
          heavy = buildHeavy(ac, heavyProfile);
          heavyFresh = true;
        }
        if (!fighterQuiet) {
          engine.silence();
          fighterQuiet = true;
        }
        if (heavy) {
          for (let i = 0; i < heavy.states.length; i++) stepHeavyEngine(heavy.states[i]!, inp.engineN1?.[i] ?? 0, inp.engineRev?.[i] ?? 0, inp.alive, dt);
          // A modest update rate; the params glide between updates.
          heavyAccum += dt;
          if (heavyFresh || heavyAccum >= HEAVY_UPDATE_SEC) {
            heavyAccum = 0;
            const tc = heavyFresh ? 0.02 : HEAVY_UPDATE_SEC * 1.2;
            heavyFresh = false;
            for (let i = 0; i < heavy.states.length; i++) heavy.rig.set(i, heavyEngineParams(heavyProfile, i, heavy.states[i]!, ear, inp.inCockpit ? 0 : aspect, heavyParams), tc);
            heavy.rig.setMuffle(heavyParams.muffleHz);
          }
        }
      } else {
        fighterQuiet = false;
        stepEngineSound(engineState, { throttle: inp.throttle, afterburner: inp.afterburner, running: inp.alive && inp.fuelKg > 0, iasMps: inp.iasMps }, dt, engineEv);
        engine.set(engineVoiceParams(engineState, ear, engineParams));
        if (engineEv.abLit) engine.thump(inp.inCockpit ? 0.12 : 0.3);
      }
      ambienceLevels(inp, lv);
      for (const l of [loops.airconL, loops.airconR]) setLoop(l.gain.gain, lv.aircon * 0.7, 0.3);
      for (const l of [loops.windL, loops.windR]) {
        setLoop(l.gain.gain, lv.wind * 0.7, 0.08);
        setLoop(l.filter.frequency, lv.windHz, 0.08, 5e-3);
      }
      gun?.update(inp.inCockpit, inp.alive);
      // The gear: its motor while it moves, a clunk as it locks.
      const moving = gearWas >= 0 && Math.abs(inp.gearPos - gearWas) > 1e-4;
      setLoop(loops.gearMotor.gain.gain, moving && inp.alive ? 0.035 : 0, 0.05);
      if (gearWas >= 0 && gearWas > 0 && gearWas < 1 && (inp.gearPos <= 0 || inp.gearPos >= 1)) thump({ hz: 140, toHz: 60, sec: 0.18, gain: 0.25, noise: 0.15, noiseHz: 900 });
      gearWas = inp.gearPos;
    },
    event(ev, playerId, pos) {
      const ac = bus.context();
      if (!ac || !live) return;
      switch (ev.type) {
        case 'gunFire':
          if (ev.shooterId === playerId) gun?.fire();
          break;
        case 'missileLaunch':
          if (ev.shooterId !== playerId) break;
          // The ejector's thump; a missile's or rocket's motor roars past as it goes.
          thump({ hz: 110, toHz: 45, sec: 0.25, gain: 0.35, noise: 0.12, noiseHz: 700 });
          if (ev.weapon !== 'bomb' && ev.weapon !== 'guided_bomb') thump({ hz: 300, toHz: 120, sec: 1.1, gain: 0.04, noise: 0.25, noiseHz: 2500, delaySec: 0.05 });
          break;
        case 'countermeasure':
          if (ev.entityId === playerId) thump({ hz: 900, toHz: 300, sec: 0.06, gain: 0.08, noise: 0.18, noiseHz: 4000 });
          break;
        case 'touchdown':
          if (ev.entityId === playerId) thump({ hz: 90, toHz: 40, sec: 0.3, gain: Math.min(0.5, 0.12 + ev.vspeedMps * 0.08), noise: 0.2, noiseHz: 2000 });
          break;
        case 'hit':
          if (ev.targetId === playerId) thump({ hz: 160, toHz: 50, sec: 0.35, gain: 0.5, noise: 0.45, noiseHz: 3000 });
          break;
        case 'explosion': {
          const d = Math.hypot(ev.pos.x - pos.x, ev.pos.y - pos.y, ev.pos.z - pos.z);
          if (d > HEAR_EXPLOSION_M) break;
          const g = Math.min(0.6, 0.6 / (1 + d / 400)) * Math.min(1, 0.4 + ev.radiusM / 40);
          thump({ hz: 70, toHz: 25, sec: 1.2, gain: g, noise: g * 0.8, noiseHz: Math.max(250, 1500 - d * 0.25), delaySec: d / SOUND_MPS });
          break;
        }
        default:
          break;
      }
    },
    listen(cam, pilotsEars) {
      if (!loops || !cam.subjectPos || !cam.subjectRot) return;
      Object.assign(jet.pos, cam.subjectPos);
      Object.assign(jet.rot, cam.subjectRot);
      if (pilotsEars || !cam.worldRot) {
        // The pilot's seat, looking along the nose.
        rotate(jet.rot, COCKPIT_EYE_OFFSET_BODY_M, eyeWorld);
        listener.pos.x = jet.pos.x + eyeWorld.x;
        listener.pos.y = jet.pos.y + eyeWorld.y;
        listener.pos.z = jet.pos.z + eyeWorld.z;
        multiplyQuat(jet.rot, NOSE_LOOK, listener.rot);
      } else {
        Object.assign(listener.pos, cam.worldPos);
        Object.assign(listener.rot, cam.worldRot);
      }
      const heavyOn = heavy !== null;
      for (const e of emitters) if (!heavyOn || !engineEmitters.includes(e)) e.place(listener, jet, inside);
      if (heavy) {
        for (const e of heavy.emitters) e.place(listener, jet, inside);
        // Where the listener is round the aircraft (the fan's whine ahead, the roar behind).
        toEar.x = listener.pos.x - jet.pos.x;
        toEar.y = listener.pos.y - jet.pos.y;
        toEar.z = listener.pos.z - jet.pos.z;
        rotateInverse(jet.rot, toEar, toEar);
        const r = Math.hypot(toEar.x, toEar.y, toEar.z);
        aspect = r > 1 ? toEar.x / r : 0;
      }
      gun?.distance(inside ? 0 : Math.hypot(listener.pos.x - jet.pos.x, listener.pos.y - jet.pos.y, listener.pos.z - jet.pos.z));
      machCone(performance.now(), !pilotsEars && !inside && !!cam.worldRot);
    },
    silence() {
      if (!loops) return;
      live = false;
      gun?.silence();
      gearWas = -1;
      for (const l of Object.values(loops)) setLoop(l.gain.gain, 0, 0.05);
      engine?.silence();
      engineState.initialised = false;
      if (heavy) {
        heavy.rig.silence();
        for (const st of heavy.states) st.initialised = false;
        heavyFresh = true;
      }
      coneWas = null;
      boomPrevMs = -1;
      hushLevel?.to(1, bus.context()?.currentTime ?? 0, 0.05);
    },
  };
}
