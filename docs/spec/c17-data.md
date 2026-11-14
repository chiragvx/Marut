# C-17A Globemaster III: flight-model and mission data pack

This is a research pack, not a spec module. It collects sourced numbers for a player-flyable Boeing C-17A
in this sim's flight model, plus what three missions need: (a) a Ladakh troop lift, (b) airdrops, and
(c) a Tejas-escorted C-17 under SAM threat. It follows the approach used by `src/aircraft/tejasEngineTables.ts`
(published ratings plus a published lapse model, with the method in a header comment) and
`src/aircraft/tejasAeroTables.ts` (tables indexed by alpha and Mach, each value justified). Section 10
gives targets in the shape of `tools/lib/perfTargets.ts`.

**Confidence tags**, used on every number:

| Tag | Meaning |
|---|---|
| **[P]** | Primary: a USAF, Boeing, NASA, FAA/ICAO, FAI or DSCA document, or a peer-reviewed or AIAA paper. |
| **[S]** | Secondary: reputable press, Wikipedia citing Jane's, or a university course deck that cites AIAA papers. |
| **[U]** | Unofficial: crew study flashcards that quote T.O. 1C-17A-1 Section 5, a forum, or a pilot interview. These numbers look right, but there is no controlled copy to check them against. |
| **[E]** | Estimate or derivation. The method is shown next to it. |

**Access note (2026-11-14).** af.mil, amc.af.mil, e-publishing.af.mil, dtic.mil, gao.gov and fai.org all returned
HTTP 403 to automated fetches. Where a USAF fact-sheet or FAI value is quoted, the wording comes from
search-engine excerpts of those pages or their mirrors. Re-check them in a normal browser before shipping. No
part of the C-17 flight manual (T.O. 1C-17A-1) is legitimately public. The [U] limits in section 4.4 come
from crew flashcards that quote it.

---

## 0. Source key

| Key | Source |
|---|---|
| AF | USAF fact sheet "C-17 Globemaster III", https://www.af.mil/About-Us/Fact-Sheets/Display/Article/1529726/c-17-globemaster-iii/ (and the AMC copy https://www.amc.af.mil/About-Us/Fact-Sheets/Display/Article/977489/c-17-globemaster-iii/, 315 AW copy https://www.315aw.afrc.af.mil/About-Us/Fact-Sheets/Display/Article/3049154). 2012 archive: https://webarchive.library.unt.edu/web/20120915090657/http://www.af.mil/information/factsheets/factsheet.asp?fsID=86 |
| FAS | Federation of American Scientists, "C-17 Globemaster III", https://man.fas.org/dod-101/sys/ac/c-17.htm |
| BOE | Boeing, "C-17 Globemaster III" product page, https://www.boeing.com/defense/tankers-and-transports/c-17-globemaster |
| BCA | Boeing Canada C-17 page, https://boeing.ca/products-and-services/defense-space-security/c-17-globemaster-iii (404 on direct fetch; figures from search excerpt) |
| WIKI | Wikipedia, "Boeing C-17 Globemaster III", Specifications (C-17A) (cites Jane's), https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III |
| VT07 | Smithey, Wagner, White, "C-17 Globemaster III", Virginia Tech AOE course slides, 2007, https://archive.aoe.vt.edu/mason/Mason_f/C17PresS07.pdf |
| VT09 | Aarons, Riopelle, Tanious, "The C-17 Globemaster III", Virginia Tech AOE slides, 2009 (cites AIAA-92-1262, AIAA-96-3784), https://archive.aoe.vt.edu/mason/Mason_f/C-17Spr09.pdf |
| SP4519 | J. Chambers, *Partners in Freedom: Contributions of the Langley Research Center to U.S. Military Aircraft of the 1990s*, NASA SP-2000-4519, C-17 chapter pp. 21–28, https://www.nasa.gov/wp-content/uploads/2023/04/sp-4519.pdf |
| D6058 | Parlett, Freeman, Smith, "Wind-Tunnel Investigation of a Jet Transport Airplane Configuration With High Thrust-Weight Ratio and an External-Flow Jet Flap", NASA TN D-6058, 1970, https://ntrs.nasa.gov/api/citations/19710001021/downloads/19710001021.pdf |
| CR2144 | Heffley & Jewell, "Aircraft Handling Qualities Data", NASA CR-2144, 1972 (C-5A section X, B-747 section IX), https://ntrs.nasa.gov/citations/19730003312 ; scan: https://www.robertheffley.com/docs/Data/NASA%20CR-2144--Heffley--Aircraft%20Handling%20Qualities%20Data.pdf |
| NEL | R. C. Nelson, *Flight Stability and Automatic Control*, 2nd ed., Appendix B (B-747 data, same as CR2144) |
| RKM | J. Roskam, *Airplane Design Part V* / *Airplane Flight Dynamics Part I*: non-dimensional radii of gyration, jet airliner 4-engine Rx 0.322, Ry 0.339, Rz 0.464. Table reproduced at https://eng-tips.com/viewthread.cfm?qid=138370 and https://www.avsim.com/forums/topic/277462-moments-of-inertia-moi-values/ |
| EDB | ICAO Aircraft Engine Emissions Databank (EASA), PW2040 UID 4PW073, https://www.easa.europa.eu/en/downloads/131424/en |
| JNK | Jenkinson, Simpkin, Rhodes, *Civil Jet Aircraft Design*, Engine data file, Pratt & Whitney, https://booksite.elsevier.com/9780340741528/appendices/data-b/table-3/default.htm |
| AC | Aircraft Commerce No. 59, "PW2000 & RB211-535 specifications", https://aircraft-commerce.com/wp-content/uploads/aircraft-commerce-docs1/Aircraft%20guides/RB211%20&%20PW2000/ISSUE59_RB211_PW2000SPECS.pdf |
| SCH | O. Schulz, "Assessment of Numerical Models for Thrust and Specific Fuel Consumption for Turbofan Engines", HAW Hamburg (reproduces Bartel & Young, J. Aircraft 45(4), 2008, doi:10.2514/1.35589, and Howe 2000), https://www.fzt.haw-hamburg.de/pers/Scholz/arbeiten/TextSchulzDipl.pdf |
| CFR33 / CFR25 | 14 CFR 33.73 (power or thrust response), https://www.law.cornell.edu/cfr/text/14/33.73 ; 14 CFR 25.119, https://www.law.cornell.edu/cfr/text/14/25.119 |
| LANG | L. Langston, "C-17 Globemaster Jet Engine Thrust Reversers", *As The Turbine Turns* #55, 2024, https://ctcase.org/wp-content/uploads/2024/04/Langston-GGTN-042433.pdf |
| TWZ | The War Zone, "Watch This C-17 Engage Its Thrust Reversers In Mid-Air…", https://www.twz.com/41823/watch-this-c-17-engage-its-thrust-reverses-in-mid-air-to-make-an-extremely-rapid-descent |
| AGC | Aviation Geek Club, interview with John Tringali (ex-USAF C-17 instructor), https://theaviationgeekclub.com/former-c-17-instructor-explains-what-happens-if-the-aircraft-thrust-reversers-are-accidentally-deployed-during-aerial-refueling/ |
| SW | Shweyk & Weltz (Boeing), "Design and Validation of Flight Control Law Changes Intended to Minimize Pilot-Induced Oscillations in a Large Transport Aircraft", AIAA (ACGSC copy), https://acgsc.org/Meetings/Meeting_96/Subcommitte%20D/6.4.pdf |
| KOWAL | Kowal, Scherz, Quinlivan, "C-17 flight control system", 11th DASC, 1992, doi:10.1109/DASC.1992.282191 (abstract) |
| FC1 | [U] Brainscape "-1 Section 5" (C-17 limits), https://www.brainscape.com/flashcards/8084406/packs/12650831 |
| FC2 | [U] Brainscape "C-17 MQF April 2016 Instructor", https://www.brainscape.com/flashcards/c-17-mqf-april-2016-instructor-2883796/packs/4752572 |
| FC3 | [U] Brainscape "C-17 by the Numbers", https://www.brainscape.com/flashcards/c-17-by-the-numbers-2692201/packs/4646668 (and https://www.brainscape.com/flashcards/c-17-by-the-s-flash-19402388/packs/23021554) |
| FAI | FAI records 720–724 (C-17, sub-class C-1q, 150–200 t, Edwards AFB, Aug 1993), https://fai.org/record/722 , /723, /724, /720, /721; STOL record https://www.fai.org/record/1540 |
| NASAEX | Ray & Varela, "Inflation of Unreefed and Reefed Extraction Parachutes", AIAA, NTRS 20150003467, https://ntrs.nasa.gov/api/citations/20150003467/downloads/20150003467.pdf |
| FM338 | US Army FM 3-21.38, *Pathfinder Operations*, ch. 6, https://www.globalsecurity.org/military/library/policy/army/fm/3-21-38/ch6.htm |
| SBA | GlobalSecurity, "C-17 Strategic Brigade Airdrop", https://www.globalsecurity.org/military/systems/aircraft/c-17-sba.htm |
| AFA11 | Air & Space Forces Magazine, "C-17 Sets Airdrop Record in Test", 22 Jul 2011, https://www.airandspaceforces.com/c-17setsairdroprecordintest |
| DOTE | DOT&E FY2009 Annual Report, LAIRCM, https://www.globalsecurity.org/military/library/budget/fy2009/dot-e/af/2009laircm.pdf |
| DSCA | DSCA Transmittal 10-08 (India, 10 C-17), https://webarchive.library.unt.edu/web/20121019163009/http:/www.dsca.osd.mil/PressReleases/36-b/2010/India_10-08.pdf ; Federal Register 2017-15006 (11th aircraft), https://www.govinfo.gov/content/pkg/FR-2017-07-18/html/2017-15006.htm |
| GAO | GAO/NSIAD-93-288R, "C-17 Takeoff and Landing Distances", 7 Sep 1993, https://gao.gov/products/NSIAD-93-288R |
| AVN | The Aviationist, "The Flexible C-17 Globemaster III has Impressive STOL Capabilities", 13 Jul 2025, https://theaviationist.com/2025/07/13/c-17-globemaster-iii-impressive-stol/ |

The Ladakh sources are listed in section 8.

---

## 1. Geometry and mass

### 1.1 Geometry

| Item | Value | SI | Source |
|---|---|---|---|
| Length | 173 ft 11 in / 174 ft | 53.04 m | [P] AF, FAS |
| Span, to winglet tips | 169 ft 9.6 in (fact sheet: 169 ft 10 in) | 51.755 m | [S] WIKI; [P] AF |
| Span, without winglets | 165 ft | 50.29 m | [S] VT09 |
| Height | 55 ft 1 in | 16.79 m | [P] AF |
| Wing reference area S | 3,800 ft² | **353.0 m²** | [S] WIKI, VT07, VT09 |
| Aspect ratio | 7.165 (b²/S, no winglets: 50.29²/353 = 7.164 [E]) | — | [S] WIKI |
| Effective AR with winglets (for induced drag) | 7.673 | — | [S] VT07 (student estimate) |
| MAC | 25.35 ft | **7.727 m** | [S] VT09 (course vortex-lattice model; LE of MAC at x = 15.40 ft, y = 31.61 ft from the wing apex) |
| Quarter-chord sweep | 25° | — | [S] VT07, VT09 |
| Taper ratio | ≈ 0.29 | — | [E] solved from MAC/mean-chord = 7.727/7.02 = 1.101 = (4/3)(1+λ+λ²)/(1+λ)² |
| Half-chord sweep | ≈ 21.3° | — | [E] tanΛc/2 = tanΛc/4 − (4/A)(0.25)(1−λ)/(1+λ) |
| Airfoils | DLBA 142 (root), DLBA 147 (tip), supercritical | — | [S] WIKI |
| Dihedral | anhedral (high wing). The NASA analogue model used −3.5° | — | [P] D6058 (analogue) |
| Winglet height / area | 8.92 ft / 35.85 ft² total | 2.72 m / 3.33 m² | [S] VT07, VT09 |
| Horizontal tail area / span | 845 ft² / 65 ft | 78.5 m² / 19.8 m | [S] VT07, VT09 |
| Vertical tail area | 685 ft² | 63.6 m² | [S] VT07 |
| Fuselage diameter (max) | 33.67 ft (this is probably width over the gear sponsons, not the circular section) | 10.3 m | [S] VT07 |
| Cargo box (fact sheet) | 88 ft L (incl. ramp) × 18 ft W × 12 ft 4 in H | 26.82 × 5.49 × 3.76 m | [P] AF |
| Cargo box (FAS) | 85 ft 2 in L; height 12 ft 4 in fwd of wing, 13 ft 6 in aft of wing | 26.0 m; 3.76 / 4.11 m | [P] FAS |
| Ramp length | 19 ft 10 in | 6.05 m | [S] VT09 |

**Control-surface geometry** [S] VT09, citing AIAA-92-1262 (Tavernetti, "The C-17: Modern Airlift Technology"):

| Surface | Count | Span | Avg chord | Location |
|---|---|---|---|---|
| Spoilers | 8 (4/side) | 48.2 ft per wing | 5 ft | 15–68% semispan, 65.5–81% local chord |
| Ailerons | 2 | 21.1 ft each | 3.09 ft | 70% semispan to winglet, hinge at 80% chord |
| Elevators | 4 (2/side) | 28.5 ft per side | 5.4 ft | hinge at 70% HT chord |
| Rudder | 2 sections (tandem/upper-lower) | 31.5 ft | 8 ft | 0–85% fin span, hinge at 64% chord |
| Stabilizer | trimmable | — | — | — |
| Flaps / slats | 4 flaps, 8 slats | — | — | flaps double-slotted, externally blown |

### 1.2 Mass and fuel

| Item | lb | kg | Source |
|---|---|---|---|
| Empty (basic/operating) | 282,500 | 128,140 | [S] WIKI |
| Operating empty (alt.) | 276,500 | 125,418 | [S] VT09 (from AIAA-92-1262) |
| **Max take-off (max peacetime)** | 585,000 | 265,352 | [P] AF, FAS |
| Max ramp (static) / taxi | 615,000 / 586,000 | 278,959 / 265,806 | [U] FC1, FC3 |
| Max landing, ¾ flap, prepared field | 585,000 | 265,352 | [U] FC1 |
| Max landing, full flap | 502,100 | 227,749 | [U] FC1, FC3 |
| Design landing weight (sink-rate break) | 435,800 | 197,676 | [U] FC3 |
| Max zero fuel | 447,400 | 202,937 | [U] FC1, FC3 |
| Semi-prepared field take-off/landing | 486,000 | 220,446 | [U] FC3 |
| **Max payload** | 170,900 | 77,519 | [P] AF, FAS; [S] VT09 |
| Max fuel, original (non-ER) | 180,800 (VT09: 180,806) | 82,010 | [U] FC3; [S] VT09 |
| Max fuel, extended-range (ER) centre-wing tanks | 244,600 | 110,949 | [U] FC3 |
| Fuel volume (ER) | 35,546 US gal | 134,560 L | [S] WIKI. At 6.7 lb/gal JP-8 that is 238,000 lb [E], consistent with the ER figure |
| Max fuel for a semi-prepared field | 92,000 | 41,730 | [U] FC1 |
| Wing fuel imbalance limit | 8,000 | 3,629 | [U] FC1 |

IAF aircraft were delivered from 2013 onward, after the ER tanks became standard on new builds. Model the IAF
aircraft as **ER, about 110,900 kg of usable fuel** [E].

**Mission weights used below** [E]:
- **Ladakh lift:** OEW 128 t + 102 troops with kit (102 × 120 kg ≈ 12 t) + fuel. Section 8.5 gives fuel and payload limits.
- **Heavy airdrop:** one 60,000 lb (27.2 t) platform at about 200 t AUW.

### 1.3 CG range

Not public. The only figure is a student vortex-lattice estimate: neutral point 73.0 ft from the nose, at 65% MAC,
with a "10% static longitudinal stability" design point [S] VT07. The 65% MAC value uses that deck's own MAC
datum, so do not use it as-is.

**Recommended model** [E]:
- Neutral point (stick-fixed, power-off, clean) at 0.45 c̄.
- CG range 0.20–0.40 c̄, giving a static margin of 5–25%. This is a typical T-tail transport envelope (Roskam Part V).
- Nominal CG 0.30 c̄ (static margin about 15%).
- The C-5A power-approach Cmα/CLα = −0.827/6.08 implies a static margin of 0.136 [P] CR2144 table X-I. The 10–15% range is consistent with that.

### 1.4 Moments of inertia [E]

No C-17 inertia data is public. The estimate uses Roskam's radii-of-gyration method [RKM]:

```
Ixx = m (b Rx / 2)^2,   Iyy = m (L Ry / 2)^2,   Izz = m ((b+L)/2 · Rz / 2)^2
Rx = 0.322, Ry = 0.339, Rz = 0.464 (4-engine jet transport)
b = 51.755 m, L = 53.04 m
```

**Validation of the method** against the B-747 at 636,636 lb (CR2144/NEL):

| Axis | Roskam method | Published | Difference |
|---|---|---|---|
| Ixx | 2.66e7 kg·m² | 1.82e7 slug·ft² = 2.47e7 kg·m² | +8% |
| Iyy | 4.14e7 kg·m² | 3.31e7 slug·ft² = 4.49e7 kg·m² | −8% |
| Izz | 6.60e7 kg·m² | 4.97e7 slug·ft² = 6.74e7 kg·m² | −2% |

| Mass | Ixx (kg·m²) | Iyy (kg·m²) | Izz (kg·m²) |
|---|---|---|---|
| 128,140 kg (empty) | 8.90e6 | 1.04e7 | 1.89e7 |
| 180,000 kg | 1.25e7 | 1.46e7 | 2.66e7 |
| 226,800 kg | 1.58e7 | 1.83e7 | 3.35e7 |
| 265,352 kg (MTOW) | 1.84e7 | 2.15e7 | 3.92e7 |

**Refinements:**
- Fuel is in the wing, so it raises Ixx and Izz much more than Iyy. Cargo is on the centreline, near the CG, so it adds mostly to Iyy and Izz. If the sim tracks fuel and cargo, use OEW inertia plus point/strip masses: wing fuel as a strip from 3–20 m span, cargo as boxes along the floor.
- Ixz: set to 0 at first. For the 747, Ixz is about 2% of Izz [CR2144], which is negligible for a game.
- The contract's `inertiaBodyKgM2` is fixed. If mass varies a lot (airdrop, fuel), the contract needs a mass-scaled inertia hook (see section 11).

---

## 2. Engines: 4 × Pratt & Whitney F117-PW-100 (PW2040)

### 2.1 Ratings and cycle

| Item | Value | Source |
|---|---|---|
| Rated SLS thrust | **40,440 lbf (179.9 kN) per engine** | [P] AF, BOE ("PW2040 (military designation F117-PW-100)"); [S] WIKI |
| Other quoted ratings | 40,900 lbf [P] FAS; PW2040 182.02 kN [P] EDB; "up to 41,700 lbf" [S] AC. **Use 40,440.** | |
| Bypass ratio | 5.9 [S] VT09 (from AIAA-92-1262); 6.0 [S] AC; 5.54 [P] EDB | |
| Overall pressure ratio | 30.8 [S] VT09; 29.4 [P] EDB | |
| Fan diameter | 78.5 in (1.99 m); fan area ≈ 3.12 m² [E] | [S] AC |
| Mass flow (PW2037) | 1,210 lb/s (549 kg/s) | [S] JNK |
| Engine weight (PW2037) | 7,160 lb | [S] JNK |
| SLS TSFC at take-off | **0.340 lb/(lbf·h)** [E], from EDB fuel flow 1.752 kg/s ÷ 182.02 kN. PW2037: 0.330 [S] JNK | [P] EDB |
| Cruise TSFC | **≈ 0.58 lb/(lbf·h)** at 35 kft, M0.85 (PW2037 proxy; no PW2040 figure published) | [S] JNK |
| Idle | ICAO LTO idle point is 7% of rated thrust: 12.6 kN, 0.159 kg/s fuel per engine | [P] EDB |
| Real ground idle | ≈ 3–5% of rated thrust | [E] typical high-bypass |

### 2.2 Thrust lapse [E]: Bartel & Young model

This plays the role Mattingly's model plays in `tejasEngineTables.ts`. The model is the Bartel & Young
two-shaft high-bypass model as reproduced in [SCH] eq. 2.8. It is stated accurate to ±1% up to M0.4 against
engine-deck data. With δ = p/p₀ and BPR λ = 5.9, G = 1.1 (high-BPR gas-generator function):

```
F/F_TO = A − 0.377(1+λ)/sqrt((1+0.82λ)G) · Z·δ·M + (0.23 + 0.19·sqrt(λ)) · X·δ·M²
A = −0.4327δ² + 1.3855δ + 0.0472
Z =  0.9106δ² − 1.7736δ + 1.8697
X =  0.1377δ² − 0.4374δ + 1.3003
```

**Cross-checks:**
- The model gives 0.184 at 35 kft and M0.8. The PW2037 maximum-cruise lapse is 0.170 at 35 kft, M0.85 [S] JNK. The model is therefore read as **maximum climb / MCT** at altitude. That is acceptable for a "throttle = 1" table.
- At FL280, M0.76, the model gives 45.3 kN per engine. Estimated cruise drag at 585,000 lb is 44.7 kN per engine (section 3.1). So a heavy C-17 can only just cruise at FL280, which is exactly the fact sheet's "initial cruise altitude of 28,000 ft" [P] AF. This match is the strongest check on the engine and drag tables together.

**Temperature correction** for hot or high fields: thrust × (1 − 0.0075·ΔT_ISA[K]) above the flat-rate temperature ([SCH], citing Raymer). The flat-rate temperature is unpublished; assume ISA+15 °C [E].

**TSFC model** [E]: TSFC = 0.34·(1 + 1.21·M)·sqrt(θ) lb/(lbf·h). The 1.21 slope is calibrated so that M0.8 at 35 kft gives 0.58 ([JNK]). Fuel flow (kg/s per engine) = T[N] × TSFC / 3600 / g.

**Thrust per engine at throttle = 1 (TOGA below 3 km, MCT/max climb above), kN** [E]
(`militaryThrustN` layout: xs = Mach, ys = altitude m. Multiply by 4 for the aircraft.)

| Mach \ alt (m) | 0 | 3000 | 6000 | 9000 | 11000 | 13000 |
|---|---|---|---|---|---|---|
| 0.0 | 179.9 | 143.7 | 107.7 | 76.9 | 60.3 | 47.0 |
| 0.2 | 147.7 | 119.8 | 88.9 | 62.9 | 49.1 | 38.4 |
| 0.4 | 125.5 | 103.2 | 75.4 | 52.4 | 40.6 | 31.7 |
| 0.6 | 113.2 | 94.0 | 67.1 | 45.4 | 34.8 | 27.1 |
| 0.7 | 110.8 | 92.1 | 64.9 | 43.3 | 32.9 | 25.5 |
| 0.8 | 110.8 | 92.0 | 64.0 | 42.0 | 31.7 | 24.4 |
| 0.85 | 111.8 | 92.7 | 64.1 | 41.7 | 31.3 | 24.0 |

The M ≥ 0.6 cells at sea level and 3 km lie outside the airframe's envelope (Vmo is 350 KCAS ≈ M0.53 at sea level).
The model flattens there; leave those cells as they are.

**Fuel flow per engine at throttle = 1, kg/s** [E]

| Mach \ alt (m) | 0 | 3000 | 6000 | 9000 | 11000 | 13000 |
|---|---|---|---|---|---|---|
| 0.0 | 1.733 | 1.336 | 0.964 | 0.662 | 0.503 | 0.393 |
| 0.2 | 1.767 | 1.383 | 0.989 | 0.671 | 0.509 | 0.398 |
| 0.4 | 1.793 | 1.424 | 1.002 | 0.668 | 0.503 | 0.393 |
| 0.6 | 1.881 | 1.508 | 1.038 | 0.674 | 0.501 | 0.390 |
| 0.7 | 1.970 | 1.582 | 1.074 | 0.687 | 0.507 | 0.393 |
| 0.8 | 2.101 | 1.684 | 1.129 | 0.711 | 0.520 | 0.401 |
| 0.85 | 2.184 | 1.749 | 1.164 | 0.728 | 0.530 | 0.407 |

The SLS cell is 1.733 kg/s. EDB gives 1.752 kg/s at 182 kN [P], so the table is within 1% at the anchor point.

**Part throttle:** TSFC rises at low thrust. A simple fit: TSFC(part) = TSFC(max) × (1 + 0.3·(1 − T/Tmax)²) [E].
This gives idle at about 7% thrust with TSFC ≈ 0.44 at sea level, matching EDB's idle point (0.159 kg/s at 12.6 kN) [P].

The contract has no afterburner here. Set `afterburnerThrustN` equal to `militaryThrustN`, or add an
`hasAfterburner: false` flag.

### 2.3 Spool response

| Item | Value | Source |
|---|---|---|
| Certification requirement | Flight idle → 95% rated take-off thrust in ≤ 5 s | [P] CFR33 §33.73(b) |
| Go-around thrust availability | go-around thrust available 8 s after the throttle moves from flight idle | [P] CFR25 §25.119 |
| Model, first-order | τ ≈ 1.7 s gives 7% → 95% in 5.0 s: e^(−5/τ) = 0.054 | [E] |
| Model, recommended | Rate-limit N1 acceleration slower below about 60% N1: τ = 2.5 s below 60%, 1.2 s above. This reproduces the slow initial spool that makes go-arounds and assault approaches feel right. Spool-down τ ≈ 1.5 s | [E] |

The contract has a single `spoolTimeConstantSec`. Use **1.8 s** if only one value is possible [E].

### 2.4 Thrust reversers

| Item | Value | Source |
|---|---|---|
| Type | directed-flow cascades; efflux up and forward, away from the ground, to avoid FOD | [S] VT09 (from AIAA-92-1262); [P] AF ("backing") |
| Which streams | VT09: "fully reversible: core and bypass redirected". LANG: fan (cold) stream only, through the upper half of the nacelle. **Conflict, unresolved.** | [S] VT09, LANG |
| Ground use | full reverse to stop; **backs a fully loaded aircraft up a 2° slope** (VT07 says "2%") | [S] LANG, VT09 |
| Ground reverser speed limit | 182 KCAS max | [U] FC1, FC3 |
| **In-flight use** | allowed, **idle reverse only, all four engines**. Engine logic holds reverse idle and will not rev beyond it | [U] AGC (Tringali, ex-USAF C-17 IP); [S] TWZ; WIKI: "used in flight at idle-reverse for added drag in maximum-rate descents" |
| In-flight reverser limit | 350 KCAS / M0.825. Not permitted with slats extended (except on the landing roll or a rejected take-off). Clean reverse-thrust push-over limit: 0 g | [U] FC1 |
| Technique | "Idle, slow down, configure, idle reverse"; speed held with pitch; speedbrakes added for more descent rate | [S] TWZ (A. Netherwood, ex-RAF) |
| Descent achieved | "deck angle −20° at .8 Mach to 320 knots", 15–18,000 ft/min [U] AGC. 30,000 → 5,000 ft in about 2 min (≈ 12,500 ft/min average, "not even close to max") [S] TWZ. Max rate-of-descent limit 20,000 ft/min [U] FC1 | |
| Reverse thrust fraction, ground | **0.40 of forward thrust at the same N1** | [E] typical cascade reverser; not published |
| In-flight idle-reverse drag | D_rev ≈ c·ρ·V²·A_fan per engine, c ≈ 0.7, A_fan = 3.12 m² | [E] see below |

**Derivation of the in-flight reverse drag** [E]. The observed 15–18 kft/min at 320 KCAS (≈ 206 m/s TAS at
15,000 ft) is a flight-path angle of about 22°, so sinγ ≈ 0.37. Write sinγ = (D − T)/W:
- Clean aircraft: D/W ≈ 0.07.
- Speedbrakes: about +0.05.
- That leaves about 0.25 W, roughly 120 kN per engine at 200 t, for the reversers.

At reverse idle the inlet still swallows a large ram mass flow and spills it forward, so the force is mostly ram
drag, about ṁ·V. ρV²A_fan at 15 kft and 206 m/s is 102 kN; c = 0.7–1.2 brackets the requirement. Use c = 0.8 and
tune against the 15,000 ft/min target in section 10.

### 2.5 Engine positions (for the engine-out yaw moment)

No source publishes the engine positions. Two estimates [E]:

| Engine | y from centreline | x of fan face | z |
|---|---|---|---|
| Inboard (2, 3) | **±7.0 m** (±1 m) | ≈ 2.5 m ahead of local wing LE | ≈ 1.8 m below wing chord plane |
| Outboard (1, 4) | **±13.5 m** (±1 m) | ≈ 2.5 m ahead of local wing LE | ≈ 1.8 m below wing chord plane |

1. Scaled from the user's imported C-17 model (`tools/models/source/c17/scene.gltf`, Blender bounding boxes):
   - The model span is 44.9 m against a real 51.755 m, so scale factor ≈ 0.87.
   - Engine-nacelle bounds give inboard and outboard centres at about 27% and 54% of the 25.1 m semispan.
   - So y ≈ ±6.8 m and ±13.5 m. This is the basis for the table above; check it against a scaled 3-view.
2. The NASA EBF analogue model put its engines at 22% and 42% semispan [P] D6058. Applied to the C-17 that gives ±5.5 / ±10.6 m. This is treated as a lower bound, because on the real aircraft the inboard nacelle clearly sits outside the fuselage-plus-sponson width.

**Engine-out yawing moment** at TOGA = 179.9 kN × 13.5 m = 2.43 MN·m for an outboard engine.
- The C-5A analogue rudder power, Cnδr = −0.106/rad [P] CR2144, gives this rudder authority: q·S·b·Cnδr·δr. At V_MCA-type speeds (≈ 110 KCAS, q ≈ 1,960 Pa) with δr = 30° that is 1,960·353·51.8·0.106·0.524 ≈ 2.0 MN·m [E].
- So V_MCA with an outboard engine out lands around 115–125 KCAS. That is plausible: "Vertical tail and rudder sized for engine out conditions" [S] VT07.
- EBF adds a second effect: losing an outboard engine at high Cμ also removes blown lift on that wing. D6058 measured a rolling-moment coefficient of about 0.20 and a CL loss of about 1.0 at Cμ = 2.9 [P]. Model this with the per-side ΔCL_EBF in section 3.3, computed from each wing's own engine thrust.

---

## 3. Aerodynamics

### 3.1 Clean configuration

| Item | Value | Source / method |
|---|---|---|
| CLα (aircraft) | 4.9/rad at M0.2, 5.3 at 0.5, 5.9 at 0.7, 6.3 at 0.78, 6.8 at 0.85 | [E] DATCOM/Helmbold wing value (A = 7.165, Λc/2 = 21.3°, κ = 0.95) × 1.11 for body+tail. C-5A PA: 6.08/rad (flaps down) [P] CR2144 |
| CL at α = 0 (fuselage reference) | 0.20 | [E] wing incidence + supercritical camber. Gives cruise CL 0.43–0.56 at α ≈ 2–3° |
| CLmax clean (slats in) | 1.40 at M0.2 → 1.30 (M0.5) → 1.10 (0.7) → 0.95 (0.78) → 0.80 (0.85) | [E] 25° swept supercritical transport; high-Mach values = buffet boundary |
| CD0 clean | **0.021** | [E] Raymer equivalent-skin-friction: Cfe = 0.0035 (military cargo, upswept aft fuselage) × Swet/Sref ≈ 6.0. Swet ≈ 2,130 m²: fuselage 910, wing 650, HT 157, VT 127, nacelles 200, fairings/sponsons 80. The VT07 cruise build-up (friction 0.0051 + form 0.0011) is wing-only and too low |
| Oswald e | 0.80 on effective AR 7.67 → k = 1/(π·7.67·0.80) = 0.0519 | [E]. VT07 computed e = 1.01 on AR 7.67 with winglets; that is ideal span loading only, so do not use it |
| Cruise check | FL280, 450 KTAS (M0.757): CL 0.43–0.56 for 450–585 klb → L/D 13.5–14.5, drag 37–45 kN per engine, fuel 20,000–24,000 lb/h at TSFC 0.60 | [E]. Matches the ~18–22,000 lb/h forum figures [U] (https://www.flyingsquadron.com/forums/topic/272-fuel-burn-rates/) and the JB Charleston "100 tons for a nine-hour mission" (≈ 22,000 lb/h mission average) [P] (https://www.jbcharleston.jb.mil/News/Features/Display/Article/238889/more-missions-using-less-fuel-but-how/) |
| VT07 cruise CL | 0.578 at 585 klb, M0.76 | [S] |
| Drag-divergence Mach | **Mdd ≈ 0.83 at CL 0.5; 0.856 at CL 0.3** | [E] Korn: Mdd = κ/cosΛ − (t/c)/cos²Λ − CL/(10cos³Λ), κ = 0.95 (supercritical), t/c = 0.125 (assumed mean), Λ = 25° |
| Wave drag | CD_w = 20·(M − Mcr)⁴, Mcr = Mdd − 0.108 | [E] Lock's rule (Raymer). Gives ΔCD ≈ 0.0012 at M0.80, 0.0027 at 0.82, 0.0053 at 0.84 |
| Mmo / Vmo | **M0.825 / 350 KCAS**. 300 KCAS below 16,000 lb fuel; 330 KCAS with fuel < 40,000 lb and payload > 124,000 lb | [U] FC1, FC3 |
| Cruise | 450 kt at 28,000 ft, M0.74 [P] AF (the 2013 version says M0.76); M0.77 [P] FAS, [S] VT09 | |

**Estimated clean tables** [E]
(`tejasAeroTables.ts` layout. Alpha in degrees here; convert to rad. Mach columns 0.2 / 0.5 / 0.7 / 0.78 / 0.85.)

CL:

| α° | M0.2 | M0.5 | M0.7 | M0.78 | M0.85 |
|---|---|---|---|---|---|
| −6 | −0.313 | −0.355 | −0.419 | −0.462 | −0.514 |
| −3 | −0.057 | −0.077 | −0.110 | −0.131 | −0.157 |
| 0 | 0.200 | 0.200 | 0.200 | 0.200 | 0.200 |
| 3 | 0.457 | 0.477 | 0.510 | 0.531 | 0.557 |
| 6 | 0.713 | 0.755 | 0.819 | 0.862 | 0.774 |
| 9 | 0.970 | 1.032 | 1.090 | 0.880 | 0.694 |
| 12 | 1.226 | 1.296 | 0.980 | 0.785 | 0.640 |
| 14 | 1.397 | 1.209 | 0.906 | 0.760 | 0.640 |
| 16 | 1.308 | 1.122 | 0.880 | 0.760 | 0.640 |
| 18 | 1.215 | 1.040 | 0.880 | 0.760 | 0.640 |
| 22 | 1.120 | 1.040 | 0.880 | 0.760 | 0.640 |
| 30 | 1.120 | 1.040 | 0.880 | 0.760 | 0.640 |
| 40 | 1.120 | 1.040 | 0.880 | 0.760 | 0.640 |

CD (CD0 0.021 + kCL² + wave + post-stall 0.6·sin²α):

| α° | M0.2 | M0.5 | M0.7 | M0.78 | M0.85 |
|---|---|---|---|---|---|
| −6 | 0.0261 | 0.0275 | 0.0301 | 0.0322 | 0.0405 |
| −3 | 0.0212 | 0.0213 | 0.0216 | 0.0219 | 0.0232 |
| 0 | 0.0231 | 0.0231 | 0.0231 | 0.0231 | 0.0243 |
| 3 | 0.0318 | 0.0328 | 0.0345 | 0.0359 | 0.0440 |
| 6 | 0.0474 | 0.0506 | 0.0558 | 0.0622 | 0.0737 |
| 9 | 0.0698 | 0.0762 | 0.0975 | 0.0788 | 0.0722 |
| 12 | 0.0990 | 0.1341 | 0.0968 | 0.0807 | 0.0777 |
| 14 | 0.1222 | 0.1319 | 0.0987 | 0.0876 | 0.0869 |
| 16 | 0.1553 | 0.1319 | 0.1068 | 0.0981 | 0.0973 |
| 18 | 0.1549 | 0.1344 | 0.1185 | 0.1098 | 0.1091 |
| 22 | 0.1703 | 0.1613 | 0.1454 | 0.1367 | 0.1360 |
| 30 | 0.2361 | 0.2271 | 0.2112 | 0.2025 | 0.2018 |
| 40 | 0.3340 | 0.3250 | 0.3091 | 0.3004 | 0.2997 |

Cm about 0.30 c̄, elevator neutral. Static margin 10% → Cmα = −0.10·CLα. **T-tail pitch-up** after the stall:
+0.30 over 8° past the stall, held to 30°, then restoring at −0.035 per degree beyond 32°. The result is a stable
deep-stall trim near 35–40°, the failure the AoA limiter exists to prevent (section 3.6):

| α° | M0.2 | M0.5 | M0.7 | M0.78 | M0.85 |
|---|---|---|---|---|---|
| −6 | 0.071 | 0.075 | 0.082 | 0.086 | 0.091 |
| −3 | 0.046 | 0.048 | 0.051 | 0.053 | 0.056 |
| 0 | 0.020 | 0.020 | 0.020 | 0.020 | 0.020 |
| 3 | −0.006 | −0.008 | −0.011 | −0.013 | −0.016 |
| 6 | −0.031 | −0.035 | −0.042 | −0.046 | −0.001 |
| 9 | −0.057 | −0.063 | −0.059 | 0.035 | 0.119 |
| 12 | −0.083 | −0.086 | 0.065 | 0.157 | 0.237 |
| 14 | −0.100 | −0.002 | 0.147 | 0.234 | 0.276 |
| 16 | −0.017 | 0.082 | 0.225 | 0.264 | 0.276 |
| 18 | 0.067 | 0.165 | 0.252 | 0.264 | 0.276 |
| 22 | 0.227 | 0.236 | 0.252 | 0.264 | 0.276 |
| 30 | 0.228 | 0.236 | 0.252 | 0.264 | 0.276 |
| 40 | −0.052 | −0.044 | −0.028 | −0.016 | −0.004 |

**Shape basis:**
- The pitch-up shape is qualitative. It comes from the documented C-17 deep-stall potential and the limiter retrofit [S] VT09, citing Iloputaife AIAA-96-3784, and from NASA's statement that the FBW "provides automatic limiting of angle of attack" to prevent "an uncontrollable deep stall" [P] SP4519 p.28.
- The magnitudes are typical T-tail values, not C-17 data.
- **Regenerating:** apply the formulas above (the tables were produced by a throwaway script that applied exactly these formulas).

### 3.2 High-lift system: slats and flaps

Lever detents and placard speeds. All are [U] FC1/FC3 except where noted:

| Detent | Slats | Flaps | Max KCAS / Mach | Use |
|---|---|---|---|---|
| UP / RET | in | 0 | 350 / 0.825 | cruise |
| SLATS (EXT) | out | 0 | extend 280, retract 270 / 0.62 | holding, tactical descent with speedbrakes (525 ft/NM at 230 KCAS with slats and speedbrakes [U] FC2) |
| FLAPS ½ | out | ½ | 250 / 0.62 | take-off. Rejected-take-off/door cards also cite a "20°" flap hold [U] |
| FLAPS ¾ | out | ¾ | 190 / 0.62 | **normal landing**. "Normal (¾) flaps or assault (full) flaps" [P] SW |
| FULL | out | full | 175 / 0.62 | **assault / steep approach.** Max full-flap landing weight 502,100 lb. Full-flap steep and assault landings are prohibited above 165,000 lb fuel unless the ER tanks hold < 4,000 lb [U] FC1 |

**Flap angles are not public.** The flaps are 2-segment double-slotted ("fixed-vane, double-slotted, simple-hinged" in a Boeing excerpt [S]) over most of the span. YC-15: double-slotted flaps over 75% of span [P] SP4519 p.25.

Estimates [E], from the NASA EBF analogue (flaps 30°/60° two-segment = landing) [P] D6058 and the YC-15 lineage:

| Detent | Flap (vane/aft) ° | ΔCL0 unpowered | ΔCLmax unpowered | ΔCD0 | ΔCm0 (about 0.30 c̄, before trim) |
|---|---|---|---|---|---|
| SLATS | 0 | 0 | +0.45 (stall α +5°) | +0.004 | 0 |
| ½ | 15/25 | +0.45 | +0.85 → CLmax 2.25 | +0.020 | −0.08 |
| ¾ | 25/40 | +0.80 | +1.15 → CLmax 2.55 | +0.045 | −0.15 |
| FULL | 30/60 | +1.00 | +1.30 → CLmax 2.70 | +0.080 | −0.22 |

The unpowered CLmax values are checked against D6058, which measured CLmax ≈ 2.1 at Cμ = 0 with flaps 30/60,
tail off and no slat [P]. Slats add about 0.4–0.6 [E].

### 3.3 Externally blown flap (EBF) powered lift

**Mechanism.** Engine exhaust strikes the slotted flaps and is turned down. "Lift can be as much as twice the value for a conventional aircraft"; the T-tail is placed to escape the large downwash [P] SP4519 pp.22–24. The VT07 headline "CLmax 7.2" is uncited [S, low confidence]; it lies within D6058's measured range at very high Cμ.

**Thrust coefficient.** Cμ = T_gross/(q·S), summed over the engines. Compute it per wing half (2 engines, S/2) so that an engine-out gives asymmetric lift.

**Measured EBF data, analogue model** [P] D6058. The model is AR 7.75, 24–25° sweep, −3.5° dihedral, four pylon
turbofans, double-slotted flaps 30°/60°, tail off. Values are read from figures, ±0.15:

| Cμ | CL at α = 0 | CLmax (untrimmed) | α at CLmax | Cm(α = 0) about 0.446 c̄ |
|---|---|---|---|---|
| 0 | 1.2 | ≈ 2.1 | 17–20° | −0.15 |
| 0.5 | 3.0 | — | — | — |
| 0.97 | ≈ 4.0 | ≈ 5.5 | 17° | −0.6 |
| 1.94 | ≈ 5.1 | ≈ 6.9 | 21° | −0.95 |
| 2.90 | ≈ 6.0 | ≈ 8.2 | 21° | −1.3 |
| 3.50 | 6.8 | 8.3 | 22° | −1.3 |

Further D6058 findings [P]:
- "High lift coefficients are accompanied by large nose-down moments because of the rearward location of the flap loads."
- "Longitudinal instability was encountered at high thrust coefficients because of adverse downwash."
- Outboard engine out at Cμ = 2.9: rolling moment ≈ 0.20, CL loss ≈ 1.0, and a further ≈ 1.0 loss if spoilers are used to trim the roll.

**C-17 operating point.** The C-17 flies the approach at **low Cμ**:
- At 115 KCAS, sea level, q·S = 2,144 Pa × 353 m² = 0.757 MN.
- Approach thrust is about 25–35% of 4 × 180 kN (≈ 180–250 kN), so **Cμ ≈ 0.25–0.35** [E].
- At TOGA, 115 KCAS, Cμ ≈ 0.80 (4 × 150 kN / 0.757 MN) [E].
- These are ~1/5 of D6058's maximum values. The C-17 therefore gets a powered-lift *increment* of order +0.5–1.2, not CL 7. This matches the "about twice conventional" description: CL ≈ 2.3–2.6 on approach versus about 1.3 for a conventional transport.

**Recommended model** [E]:

```
ΔCL_EBF(α, Cμ, flap) = η_flap · F(Cμ)          (added to the unpowered CL; also raises CLmax)
F(Cμ) from D6058 column "CL at α = 0" minus 1.2:
  Cμ:   0    0.25   0.5   1.0   2.0
  F :   0    1.0    1.8   2.8   3.9
η_flap = 0 (UP/SLATS), 0.25 (½), 0.35 (¾), 0.40 (FULL)
ΔCLmax_EBF = 1.1 · ΔCL_EBF;  α_stall increases by 0 to +3° (D6058: 17 → 21°)
ΔCm_EBF    = −0.16 · ΔCL_EBF   (about 0.446 c̄, tail off; D6058 ratio −0.45/2.8)
ΔCD_EBF    = −0.6 · Cμ · cos(δ_flap,eff)  (the thrust component not turned shows up as negative drag;
             simplest is to rotate the thrust vector of the 2 engines down by the effective turning angle
             θ_turn ≈ 0.35·δ_aft-flap and NOT add ΔCD)
```

- η_flap carries most of the uncertainty. It accounts for the C-17 flap covering only part of each jet and for
  the full-scale versus model jet-spreading difference.
- **Calibration target:** at 160 t, full flaps, approach thrust (Cμ ≈ 0.3), the aircraft must trim at ≈ 115 KCAS
  with power-on CLmax ≥ 1.25× the approach CL (section 5.2).
- **Ground effect for EBF:** powered-lift configurations lose lift near the ground at high Cμ (jet impingement).
  Scale `groundEffectMaxDeltaCL` down linearly to 0 at Cμ = 0.8 [E, qualitative from the NASA EBF ground-effect
  literature; no C-17 number].

### 3.4 Spoilers, speedbrakes, lift dump

8 panels, 15–68% semispan [S] VT09. Uses: roll augmentation (with the ailerons), in-flight speedbrake, and ground lift dump. "Full speedbrakes: VL/ML" (no lower limit) [U] FC1.

| Function | ΔCL | ΔCD | ΔCm | Source |
|---|---|---|---|---|
| Speedbrake, full (in flight, ≈ 30–40°) | −0.10 (clean) | +0.025 | +0.02 | [E] Roskam spoiler charts for spoilers covering 53% of semispan |
| Ground lift dump (all panels, 60°) | −0.8 with flaps ¾/FULL, −0.4 clean | +0.06 | +0.05 | [E] |
| Roll spoiler, one side full | per-side ΔCL −0.25 → Cl ≈ 0.04 | +0.010 | — | [E] |

KC-135 crews note that "about 60% of roll authority comes from spoilers" (KC-135 deck, https://brainscape.com/flashcards/flight-controls-1756888/packs/3325675) [U, analogue]. Use a similar split for the C-17 at low speed.

### 3.5 Gear, ramp, other increments

| Item | ΔCD | Other | Source |
|---|---|---|---|
| Gear down | **+0.015** | 1 nose gear (2 wheels) and 4 main legs (3 wheels each) in fuselage sponsons | [E] Torenbeek gear-drag build-up for a podded tandem main gear: ≈ 0.012–0.018 on S = 353 m² |
| Cargo door + ramp open | **+0.009** | ΔCm ≈ +0.01 (nose up, from aft drag below the CG) | [E] aperture ≈ 5.5 m × 4.1 m ≈ 22 m², base-drag Cd ≈ 0.15 → 0.15·22/353 |
| Paratroop doors + air deflectors open | +0.002 | — | [E] |
| Ramp/door limits | 250 KCAS / M0.62 open/opening/closing; M0.74 with slats retracted; 0 to +1.6 g while moving, 0 to +2.0 g steady when open | — | [U] FC1 |

No measured ramp-open data were found. The pitch effect is small next to the cargo CG motion during a drop (section 6.3).

### 3.6 Stall behaviour and AoA protection

- **Natural behaviour:** a T-tail with a high wing and deep-stall potential. Model the pitch-up of section 3.1. The original design had no AoA limiter; a limiter was later "designed and installed" to meet the air-vehicle specification [S] VT09, citing AIAA-96-3784.
- **ALS (Angle-of-attack Limiting System):** active in all flight modes [P] SW. It limits nose-up command; the FBW automatically limits AoA [P] SP4519.
- **No stick pusher** is documented. The ALS acts through the elevator command [S/P].
- **Warning:** stick shaker plus aural "STALL" at 1.05–1.15 Vs [U] FC2.
- **Accident evidence:** Elmendorf, 28 Jul 2010. During a low-altitude steep turn the stall warning came on and the pilot did not recover; the aircraft pulled about 2.4 g. Executive summary: https://documents.theblackvault.com/documents/accidents/c17crash06282010.pdf [P]. The detail figures (warning at 199 kt, about 6 kt below stall) are from a secondary summary [S] (https://fearoflanding.com/accidents/accident-reports/dangerous-aerobatics-c-17-crash-at-elmendorf-2010/). The lesson for the sim: the limiter **does not make the aircraft unstallable** in an aggressive turn at low speed. The warning margin is small, and the pilot must unload.
- **Model** [E]:
  - α_limit = 0.9 × α_stall(config, Mach, Cμ), soft limiter starting at 0.8 × α_stall.
  - Shaker at α for 1.10 Vs.
  - Allow α to overshoot the limit by up to 2° under abrupt pull, and let it stall if the pilot holds full aft stick with energy decaying. This reproduces the accident lesson.

### 3.7 Stability and control derivatives

There are no C-17 derivatives in public. Use the **C-5A** (also a high-wing, T-tail, 4-turbofan logistics
transport) from NASA CR-2144 table X-I. This is the power-approach case at sea level, VTO = 247 ft/s (146 kt),
CL = 1.29, flexible aircraft, stability axes, spoiler effects included [P] CR2144.

**These values were OCR'd from a 1972 scan; re-read them from the PDF before use.**

| Derivative | C-5A PA | Recommended C-17 starting value | Note |
|---|---|---|---|
| CLα | 6.08/rad | config tables | flaps-down value |
| CDα | 0.622/rad | from polar | |
| Cmα | −0.827/rad | −0.10·CLα (SM 10%) | C-5A SM ≈ 13.6% |
| Cmα̇ | ≈ −3/rad (OCR unclear) | −4/rad | [E] |
| Cmq | −23.2/rad | **−25/rad** | [E] the larger HT (845 ft² vs C-5A 970 ft²) is offset by a shorter arm |
| CLδe | 0.385/rad | 0.38/rad | |
| Cmδe | −1.6/rad | **−1.5/rad** | [E] |
| CYβ | −0.77/rad | −0.80/rad | |
| Clβ | −0.123/rad | −0.12/rad (anhedral high wing) | |
| Cnβ | 0.075/rad | 0.10/rad | [E] the C-17 fin is sized for engine-out [S] VT07 |
| Clp | −0.458/rad | −0.45/rad | |
| Cnp | −0.098/rad | −0.08/rad | |
| Clr | 0.290/rad | 0.25/rad | |
| Cnr | −0.293/rad | −0.30/rad | |
| Clδa (incl. spoilers) | 0.089/rad | 0.09/rad | |
| Cnδa | 0.0091/rad | 0.005/rad | |
| CYδr | 0.211/rad | 0.21/rad | |
| Clδr | 0.0209/rad | 0.02/rad | |
| Cnδr | −0.106/rad | **−0.11/rad** | sign per CR2144 convention; map to the contract's sign rule |

Rates are non-dimensional with b/2V (lateral) and c̄/2V (longitudinal), as in the contract's `Cl_p`, `Cm_q`, etc.
For cruise Mach, scale CLα by the Helmbold ratio in section 3.1 and Cmδe by the same ratio [E].

**Ground effect** [E]:
- Wing height at touchdown is about 4.5–5 m, so h/b ≈ 0.09.
- McCormick: φ = (16h/b)²/(1 + (16h/b)²) = 0.67, so induced drag is cut about 33% at touchdown.
- Lift increment: `groundEffectMaxDeltaCL` = 0.10 unpowered, reduced with Cμ (section 3.3).

---

## 4. Flight controls and FCS

### 4.1 Architecture

- "Quadruple-redundant electronic flight control with mechanical backup system" [P] BOE.
- 4 flight-control computers, 3 three-axis rate sensors, 3 three-axis accelerometers, and a quad sensor on each rudder pedal [S] VT09, from AIAA-92-1262.
- Designed to 1×10⁻⁹ catastrophic failure. Design drivers: deep-stall avoidance, loss of control, control with all engines out, and safe go-around [P] KOWAL (abstract).
- **Inceptors:** centre-type control sticks, not yokes [P] SW ("roll stick"/"control stick").
- **Mechanical mode (MECH):** a cable backup. Which surfaces it drives is not confirmed in public (plausibly elevator, aileron, rudder and stab trim). "Routine operation of any flight control axis in mechanical mode is not allowed" [U] FC1.
- Above 43 °C OAT on take-off the EFCS "may revert to FROZEN GAINS" [U] FC3. Model: gain scheduling stops updating, and handling becomes heavier and less damped.

### 4.2 Control laws [P] SW

| Axis | Mode | When |
|---|---|---|
| Pitch | **Pitch-rate command / attitude hold (PRC/AH)** | up-and-away |
| Pitch | **Pitch-attitude command / attitude hold** | approach and landing |
| Pitch | Aerial-refuelling mode | AR |
| Roll | Roll-rate command | all |
| Yaw | Sideslip command | all |
| All | ALS (AoA limiting) active | all modes |
| Ground | rate-damping modes on all three axes | on ground |

- Software surface-rate limits were 60°/s; the A4.2 software change removed them for the spoilers and ailerons to cure roll PIO [P] SW.
- **Roll PIO:** about 2 rad/s at ¾ and full flaps with heavy wing fuel [P] SW. This is a useful "do not over-tune the roll gain" note.

**Implementation sketch for this contract** [E]:
- Pitch: map stick to a pitch-rate command (max ≈ 5°/s at full stick) with attitude hold at zero stick. Below 1,000 ft AGL with flaps ≥ ¾, switch to attitude command (±1 stick = ±10° θ).
- Add g limiting (section 4.3) and the ALS α clamp (`alphaLimitGain`).
- Roll: rate command, max 15°/s, reduced to 10°/s beyond 60° bank [U] FC1.
- Yaw: β command from the pedals, plus turn coordination. Yaw damper always on.
- Auto stab-trim: integrate elevator to zero over about 5 s.

### 4.3 Load-factor, bank and pitch limits

| Item | Value | Source |
|---|---|---|
| Flaps/slats extended | 0 to +2.0 g; abrupt rolling pull-out +0.4 to +1.6 g | [U] FC1 |
| Clean, symmetric | **+2.5 / −1.0 g** (not found) | [E] standard MIL transport category |
| Above VH/MH | min 0.75 g; push-overs to 0 g | [U] FC1 |
| Gear moving | 2.25 g | [U] FC1 |
| Single-axle cargo > 27,000 lb | 2.5 g | [U] FC1 |
| Door/ramp moving / open | 0 to 1.6 g / 0 to 2.0 g | [U] FC1 |
| Bank | max 70° (characteristics not validated beyond; HUD cannot display beyond). Performance data stops at 60°. Training limit 45° | [U] FC1; [S] Elmendorf summary |
| Roll rate beyond 60° bank | ≤ 10°/s | [U] FC1 |
| Pitch | no published attitude limit. Use +25°/−15° θ in the FCS [E]. The −20° deck angle in tactical descents is a technique [U] AGC | |

`FcsLimits` [E]:
- maxGLoadPos 2.5 clean / 2.0 flaps, maxGLoadNeg −1.0 clean / 0 flaps.
- maxRollRateRadS 0.26 (15°/s).
- maxElevonRad 0.44 (25°), maxRudderRad 0.52 (30°).
- Surface rates 0.7 rad/s (40°/s; the old FCS rate limit was 60°/s [P] SW).
- Deflection limits are **not published**; the values above are typical transport limits.

### 4.4 Other systems

- **HUD:** "2 full-time all-function head-up displays" plus 4 multifunction LCDs [P] BOE. NASA credits Langley for C-17 HUD technology [P] SP4519 p.28. Show a flight-path marker with a glide-path reference line (assault approaches are flown on the flight-path marker) [E].
- **Autothrottle:** fitted, but no public description of its modes. Model it as speed hold (CAS) with a ±0.1 throttle/s rate, disconnecting on reverse or manual override [E].
- **Autopilot:** integrated with the FBW [P] KOWAL. The 2011 35,000 ft drop used "Mode 5 Plus" avionics, which held altitude within 100 ft through extraction [P] AFA11.

---

## 5. Performance targets for verification

### 5.1 Field performance

| Case | Value | Source |
|---|---|---|
| Take-off run at MTOW (585 klb) | 8,200 ft (2,499 m) | [S] WIKI (Jane's) |
| Take-off field length at max gross | 7,740 ft (2,359 m) | [S] BCA excerpt; [S] VT09 "Takeoff field length 7,740 ft" |
| Take-off run at 395,000 lb (179.2 t) | 3,000 ft (914 m) | [S] WIKI |
| Take-off at about 75 t payload | from 7,600 ft | [S] CLAWS (section 8) |
| Shortest take-off / landing, unloaded | 3,700 ft / 2,300 ft | [S] VT09 |
| STOL record | < 1,400 ft take-off and landing with 44,000 lb payload | [S] AVN. FAI STOL class: 19,997 kg to 2,000 m, 3 Jun 1994, Edwards [P] FAI 1540 |
| Landing field length | **3,000 ft (914 m) with 160,000 lb cargo** | [S] BCA excerpt; [S] VT09 "Landing field length 3,000 ft" |
| Runway minimum | "as short as 3,500 ft (1,064 m) and as narrow as 90 ft (27.4 m)" (older/FAS wording: 3,000 ft) | [P] AF, FAS |
| Ops minimum | 3,500 ft or as required (CFL, landing distance, ground roll + 500 ft); 90 ft wide; star turn needs 90 ft | [U] FC3 |
| Ground turn | turns around in < 80 ft (three-point star turn using reverse) | [S] AVN |
| Early program caveat | the flight-manual safety supplement specified longer distances than contractor predictions until testing completed | [P] GAO |

**Model check** [E]. A point-mass take-off simulation:
- Engine table from section 2.2, μ = 0.02, CD = 0.075, CL_ground = 0.9.
- V_LOF = 1.15·Vs with CLmax_TO = 2.2 (flaps ½ unpowered). Powered-lift CLmax ≈ 2.6 shown in brackets.

| Mass | Ground roll | V_LOF |
|---|---|---|
| 265 t | 1,894 m (1,555) | 165 kt |
| 227 t | 1,325 m | — |
| 179 t | 786 m (651) | 136 kt |
| 160 t | 615 m | — |

The model sits about 15–25% short of the Jane's runs, which is within tolerance. The published runs probably include a rotation delay and use less than TOGA.

### 5.2 Speeds

| Item | Value | Source |
|---|---|---|
| Approach speed (headline) | **115 kt** | [S] VT09 (from AIAA-92-1262). No weight given. The derivation below places it at ≈ 160 t, full flaps, power on |
| Airdrop speed range | 115–250 KCAS | [S] VT09 |
| V-speeds (V1, VR, V2, VREF) | **not public** | — |
| Vmo / Mmo | 350 KCAS / 0.825 | [U] FC1 |
| Gear | extend 250, retract 225 (may not retract above 200), down 250 | [U] FC1 |
| RAT min speed | 130 KCAS | [U] FC1 |
| Pilot window | 205 KCAS | [U] FC1 |
| Taxi | 40 kt max (prepared surface) | [U] FC3 |
| Winds | crosswind 30 kt, headwind 40, tailwind 10 | [U] FC1, FC3 |

**Estimated reference speeds** [E]. Vs = sqrt(2W/(ρS·CLmax)), VREF = 1.25·Vs (power-on, approach Cμ ≈ 0.3),
VR ≈ 1.05·Vs_TO, V2 ≈ 1.2·Vs_TO, sea level, KCAS:

| Mass | Vs clean (1.40) | Vs ½ (2.25) | V2 flaps ½ | Vs FULL power-off (2.70) | Vs FULL power-on (≈ 3.2) | VREF FULL | VREF ¾ (power-on ≈ 2.9) |
|---|---|---|---|---|---|---|---|
| 140 t | 131 | 103 | 124 | 94 | 87 | 108 | 114 |
| 160 t | 140 | 110 | 132 | 101 | 93 | **116** | 122 |
| 200 t | 156 | 123 | 148 | 113 | 103 | 129 | 136 |
| 228 t | 167 | 132 | 158 | 120 | 110 | 138 | 145 |
| 265 t | 180 | 142 | 171 | — (full-flap limit 228 t) | — | — | 157 |

### 5.3 Climb, ceiling, cruise, range

| Item | Value | Source |
|---|---|---|
| Service ceiling | 45,000 ft at cruise speed | [P] AF, FAS |
| Time to climb (C-1q class, 150–200 t, 5,000 kg payload, 25 Aug 1993, Edwards) | 3,000 m in **3 min 55 s**; 6,000 m in **7 min 31 s**; 9,000 m in **14 min 32 s** | [P] FAI 722, 723, 724 |
| → average climb rates | 0–3 km 12.8 m/s (incl. take-off roll); 3–6 km 13.9 m/s; 6–9 km 7.5 m/s | [E] arithmetic |
| Altitude with payload | 12,870 m (FAI 721); 11,284 m with 2,000 kg (FAI 720) | [P] FAI |
| Climb rate (spec-sheet figures) | 1,500–2,500 ft/min (aggregators; unreliable) | [S] |
| Model SL climb at 250 KEAS, max thrust, clean | 35 m/s @150 t, 25 m/s @200 t, 17 m/s @265 t; at 4.5 km: 25 / 17 / 10 m/s | [E] section 2/3 tables |
| Cruise | 450 kt at 28,000 ft (M0.74–0.77) | [P] AF |
| Range | ≈ 2,400 nm with 164,900 lb payload, initial cruise at 28,000 ft [P] AF (Dover); 2,420 nm with 157,000 lb [S] WIKI; 5,200 nm with 130,000 lb (FAS) [P]; 4,700 nm empty [S] AVN; ferry 6,230 nm [S] WIKI | |
| Range-payload (VT09) | 2,240 nm @160,000 lb; 4,200 nm @40,000 lb | [S] VT09 |
| Cruise fuel | 18,000 (light) to 22,000 (heavy) lb/h at high cruise [U]; mission average ≈ 22,000 lb/h (100 tons in 9 h, JB Charleston) [P]; carrying 10,000 lb more fuel costs 300 lb/h [P] JB Charleston | |
| Model cruise fuel at FL280, 450 KTAS | 8.5 t/h at 400 klb, 9.1 t/h at 450 klb, 10.9 t/h at 585 klb (TSFC 0.60) | [E] section 3.1 |

The FAI climb records are slower than the clean-climb model (13.9 m/s average between 3 and 6 km at ≤ 200 t,
versus 17–25 m/s modelled). Possible causes:
- The record profile probably accelerated through the band.
- The 1993 test aircraft and engines may have been rated differently. The record lists "PW2643"; that may be a database artefact.
- The model's high-altitude thrust or drag may be off.

Treat the FAI values as a **lower bound** and the model as an upper bound. A climb target of 20 ± 6 m/s at 200 t, sea level, is defensible (section 10).

**Model Vmax** [E]: at 9,000 m, 200 t, thrust equals drag at about **M0.83 (≈ 252 m/s TAS)**, consistent with
Mmo 0.825. At sea level Vmax is Vmo-limited (350 KCAS = 180 m/s), not thrust-limited.

### 5.4 Steep / assault approach and descents

| Item | Value | Source |
|---|---|---|
| Assault landing zone | 3,500 ft × 90 ft (Altus, Lakehurst training strips) | [P] https://www.altus.af.mil/News/Article-Display/Article/619945/landing-zone-cameras-mean-major-improvements-in-c-17-training/ |
| Touchdown sink-rate limits | 600 ft/min > 502,100 lb; 660 ft/min 435,800–502,100 lb; 750 ft/min < 435,800 lb | [U] FC3 |
| Assault callouts | 300 ft and 50 ft AGL | [U] FC2 |
| Glide-path angle, steep approach | **not public**. "Steep, low-speed final approach" [S] BCA; "precision-approach path control" [P] SP4519 | — |
| Recommended steep approach | **5° (assault) / 3° (normal)** | [E] at 115 KCAS (≈ 120 KTAS at Leh, ≈ 140 KTAS at DBO), a 5° path gives a sink of 1,060 / 1,240 ft/min. Normal 3°: 640–740 ft/min. The 5° value is chosen so that the flare still reduces sink to the 600–750 ft/min touchdown limits. EBF lets the aircraft hold the path with thrust (high Cμ) without large speed changes |
| Tactical descent | idle + idle reverse (+ speedbrakes), −20° deck, M0.8→320 KCAS, 15–18 kft/min [U] AGC; level off about 2,000 ft above target altitude [U] FC3; max 20,000 ft/min [U] FC1 | |
| Emergency descent (no reverse) | idle, speedbrakes; slats + speedbrakes at 230 KCAS ≈ 525 ft/NM | [U] FC2 |
| Brake limits | caution 651–750 °C, red ≥ 751 °C; training ALZ landings 150 °C max | [U] FC1, FC3 |
| Gear cooling | after 4 consecutive landings: 10 min gear down / 20 min gear up | [U] FC1 |

**Landing-roll model** [E]: V_td²/(2·a), with reversers plus max braking at a = 0.30–0.35 g.

| Mass | V_td | Ground roll |
|---|---|---|
| 181 t | 115 kt | 510–595 m |
| 210 t | 125 kt | 600–700 m |
| 228 t | 135 kt | 700–820 m |

Add the air distance from 50 ft: ≈ 220 m on a 4° path plus about 100 m of flare. The 210 t case then totals ≈ 900 m, which matches the 3,000 ft / 160,000 lb-payload claim (OEW 128 t + 72.6 t payload + ≈ 9 t reserve fuel = 210 t).

---

## 6. Cargo bay and airdrop

### 6.1 Capacity

| Item | Value | Source |
|---|---|---|
| Troops / paratroops | **102** (54 sidewall + 48 centreline) | [P] AF; [P] BOE |
| Aeromedical | 36 litter + 54 ambulatory (fact sheet); FAS: 48 litter + 54 ambulatory. Plus 5 medical crew | [P] AF, FAS |
| Pallets | 18 × 463L, ≤ 10,000 lb each | [P] AF; [S] AVN |
| Crew | 3 (2 pilots + loadmaster) | [P] AF |
| Ramp load | blowdown may fail with > 20,750 lb on the ramp; 18 t ramp capacity (Indian source) | [U] FC2; [S] CLAWS |

### 6.2 Airdrop speeds and altitudes

| Method | Speed | Altitude (AGL unless noted) | Source |
|---|---|---|---|
| Speed envelope | 115–250 KCAS | — | [S] VT09 |
| Personnel, static line | 130–135 KIAS (C-5/C-130/C-141 row; C-17 by inference) | 800 ft tactical training, 1,250 ft basic trainees | [P] FM338 Tables 6-1, 6-3 |
| CDS (C-5/C-17/C-141) | **150 KIAS** | G-12 chutes 400–550 ft; G-14 300–400 ft | [P] FM338 |
| CDS per sortie | about 40 bundles | — | [P] AMC, "First C-17 combat screamer airdrop", https://www.amc.af.mil/News/Article/148023/first-c-17-combat-screamer-airdrop/ |
| Dual Row Airdrop (DRAS) | 130–150 kt | 750–1,200 ft; ≤ 17 kt surface wind; ≤ 14,500 lb platform; 8 platforms | [S] SBA |
| Heavy equipment | 130–150 kt (FM338 equipment row; C-17 by inference). High-altitude tests: 145 KIAS (31–32 klb, 25 kft), 150–175 KIAS (48–86 klb, 25 kft), **190 KIAS at 35 kft (no flaps)** | G-11A 900–1,300 ft; G-11B 700–1,300 ft; G-11C ×8 1,300 ft; extraction > 25,000 ft MSL only on the C-17 with extra certification | [P] FM338; [P] NASAEX |
| Max single platform | 60,000 lb | — | [P] BOE |
| Max sequential load | 110,000 lb (search excerpt only; re-verify) | — | [S] BOE |
| Record drop | 60,000 lb from **35,000 ft** MSL, 24 Jun 2011 (10,000 ft above the approved altitude) | — | [P] AFA11 |
| HALO / HAHO | open ≥ 2,500 ft AGL (HALO minimum opening); exit typically up to 25,000 ft MSL (oxygen; FL350 shown possible for cargo) | — | [P] FM338 (opening). Exit altitude [E] |
| Static-line wind limit | ≤ 13 kt surface | — | [P] FM338 |
| Formation spacing | element leads 32,000 ft apart for personnel drops (was 40,000 ft) because of C-17 wake | — | [S] SBA |
| Forward throw / point of impact | personnel forward throw 229 m. CDS PI from DZ leading edge 206 m day / 251 m night. Heavy equipment 457 / 503 m | — | [P] FM338 |
| Ramp/door | open below 250 KCAS (M0.62; M0.74 slats in) | — | [U] FC1 |
| Door times | **not published** | — | Use 20 s (cargo door + ramp to airdrop position), 8 s (paratroop doors + deflectors) [E] |

### 6.3 Extraction sequence and aircraft response

Sequence. Standard US heavy-drop practice; extraction details from [P] NASAEX:
1. Slow to drop speed and configure: flaps ½ at low altitude, or clean at 35,000 ft [P] NASAEX. The ramp/door go to airdrop position at around 10 min to go [E]. Air deflectors are used for personnel.
2. Set the deck angle for level flight at the drop speed: 3.5–5° at 25,000 ft, 5–7° (nominally 6°) at 35,000 ft [P] NASAEX.
3. At the computed air release point, the extraction parachute is deployed: a standard 28 ft canopy, reefed for high-altitude drops [P] NASAEX.
4. The chute force transfers to the platform, the rail locks release, and the load rolls aft and out over the ramp. Release takes 3–4 s; the 2011 record took 3.8 s ([S] AFMC Edwards article, https://www.afmc.af.mil/News/Article/153867/418-flts-testers-record-highest-cargo-airdrop, via search excerpt).
5. **Aircraft response:**
   - The pitch rate peaks at about 2°/s (versus about 10°/s on a C-130). Crews are told **not to fight the pitch rate** during extraction [P] NASAEX.
   - After release the aircraft can pitch up and climb 200–300 ft ([S] same AFMC excerpt). The autopilot / "Mode 5 Plus" held altitude within 100 ft on the record drop [P] AFA11.

**CG excursion** [E, method]. Take a 27.2 t (60,000 lb) platform on a 200 t aircraft, starting near the aircraft
CG. Where Δx is the platform's distance aft of its start point:

```
x_cg(t) = x_cg0 + (m_load / m_total) · Δx(t)
```

- At the ramp hinge (Δx ≈ 13 m), the CG has moved aft by 27.2·13/200 = 1.8 m = **0.23 c̄**. That pushes the CG past the neutral point in the final second: the nose-up pitch the crew lets happen.
- When the load leaves, mass drops 13.6% and the CG returns to x_cg0 (the load came from near the CG).
- The lighter aircraft is now trimmed at too high an α, so it balloons and climbs 200–300 ft.
- The extraction drag itself (28 ft chute, peak ≈ 0.3–0.5 × platform weight ≈ 80–135 kN for 27 t, applied at the ramp below the CG) adds a nose-up moment and a deceleration of about 0.04–0.07 g [E].

**Sim implementation** [E]. Model the platform as a moving point mass on the floor:
- Rail friction μ ≈ 0.05.
- Extraction force F_ex(t) from a reefed-chute inflation curve (NASAEX gives the inflation shapes), peak ≈ 0.3–0.5 × platform weight [E sizing assumption].
- Apply its reaction force at the ramp hinge until separation, then remove the mass.
- Update mass, CG and inertia (Iyy loses m_load·Δx² at release).

### 6.4 Crew technique (summary)

- Hold the deck angle set before release.
- Do not counter the pitch-up during the 3–4 s extraction.
- Recapture altitude afterwards.
- For CDS (gravity drop), the aircraft is flown at a slight nose-up deck angle so bundles roll aft [E]. The CG shift is distributed over about 40 bundles, so the pitch effect is gentler and more sustained.

---

## 7. Defensive systems (escort mission)

| Item | Value | Source |
|---|---|---|
| USAF C-17 | LAIRCM (AN/AAQ-24(V)): AAR-54 UV missile warning + IR laser jammer. Used in "take-off and landing, assault landings, tactical descents, air drops, low-level flight, and aerial refueling" | [P] DOTE |
| **IAF C-17** | 10 aircraft with **AN/ALE-47** countermeasure dispensers, **AN/AAR-47** missile warning, and flares (2010). The 11th aircraft added 1 AAR-47 + 1 ALE-47 (2017). **No LAIRCM listed** | [P] DSCA, FR 2017-15006 |
| Flare count | not published | [E] model 120 flares in 4 aft/side dispensers; 2 flares per salvo, 6 salvos per MWS event |
| Laser-hazard zone (LAIRCM) | 187–200 ft | [U] FC2 |

**Threat-phase tactics** [E, based on DOTE's list of LAIRCM-relevant phases plus press]:
- **Tactical arrival:** stay high (above the MANPADS envelope, ≈ 15,000 ft AGL) until overhead. Then make an idle-reverse spiral or tactical descent (section 5.4) at 15–18 kft/min inside the airfield's protected circle, level about 2,000 ft above pattern height, and fly a short assault final.
- **Tactical departure:** max-thrust steep climb-out with a tight spiral over the field. Use the ALS α as the limit and accept a low speed (V2 + 10).
- **Under SAM / radar threat** (the Tejas escort mission):
  - Terrain masking at low level (500 ft AGL in valleys).
  - Notch the SAM radar: turn the threat to the beam, at ≤ 30° bank with heavy cargo and ≤ 45° otherwise, within the 2.5 g clean limit.
  - Chaff is not in the IAF package; the escort's jammer and chaff carry the radar-threat burden.
  - Flares on an AAR-47 warning.
  - A C-17 cannot out-turn a missile. AI evasion should be: flares + turn to put the missile at 3–9 o'clock + descend.
- **AI C-17 behaviour targets:** bank ≤ 45°, ≤ 2.0 g sustained, roll rate ≤ 15°/s, speed band 250–350 KCAS at low level, M0.74–0.77 at cruise.

---

## 8. Ladakh airfields

Primary aerodrome data (AAI eAIP AD 2) was unreachable from this environment. **Verify every runway number against
the AIP or military charts before relying on it.** The table uses the best available secondary sources.

### 8.1 Airfield data

| Field | Elevation | Coordinates | Runway | Surface | Notes |
|---|---|---|---|---|---|
| **Leh (VILH / IXL), Kushok Bakula Rimpochee, joint civil–IAF** | **10,682 ft / 3,256 m** | 34°08′09″N 77°32′47″E | **07/25, 9,028 ft (2,752 m)** (other listings 9,040 ft / 2,755 m) × 150 ft (46 m) | asphalt | **One-way:** land 07, take off 25 (terrain higher to the east). Approach via LELAX then LH01–LH06, join left downwind at LH03, visual circle-to-land 07; specially certified crews only. Flights in the morning only (afternoon winds and mountain waves). Civil temperature limit 32 °C: 16 flights cancelled 27–30 Jul 2024 at ≥ 36 °C |
| **Thoise (Nubra valley), IAF** | ≈ 10,070 ft / 3,070 m (10,046–10,062 ft also published) | ≈ 34°39′N 77°23′E | 10/28, ≈ 3,048 × 44 m (other listing 3,038 × 45 m) | asphalt | No ICAO code ("VI57" is a database ID). ≈ 160 km from Leh |
| **Nyoma (Mudh-Nyoma AFS)** | **≈ 13,700 ft / 4,176 m** (13,629 ft / 4,154 m also reported) | ≈ 33°10′N 78°43′E | **2.7 km × 46 m**, new paved runway (BRO, ≈ ₹214–218 crore) | paved | Previously an earth strip for C-130J and helicopters. An-32 landing 18 Sep 2009. **Operationalised 12 Nov 2025** (CAS landed in a C-130J). IL-76MD landing reported Nov 2026. 23–35 km from the LAC |
| **Daulat Beg Oldi (DBO)** | **16,614 ft / 5,065 m** (IAF statement; 16,730 / 16,200 ft elsewhere) | ≈ 35°23′N 77°55′E (locality) | length **not published** | gravel/compacted earth | Depsang plains; Karakoram Pass ≈ 8 km N. Reopened by An-32 on 31 May 2008. **C-130J-30 landing 20 Aug 2013** |

**Terrain near Leh:**
- Stok Kangri, 6,153 m (20,187 ft), ≈ 15 km SW.
- Khardung La, 5,359 m (17,582 ft) measured, N of Leh.
- The Indus valley approach is flanked by 5,000–6,000 m ridges.

Sources:
- Leh data: https://www.indiaairport.com/airports/leh/tech_info.htm ; https://airport-data.com/world-airports/VILH-IXL ; https://lfs.aero/flight-support/india/VILH ; Airways Magazine "Challenging airports" https://airwaysmag.com/legacy-posts/p-192901 ; STAWA heat-wave note https://stawa.org/?p=1847
- Thoise: https://en.wikipedia.org/wiki/Thoise_Air_Force_Station ; https://sprinkle.com/airport/VI57 ; https://airports4xp.info/airport/VI57 (low confidence)
- Nyoma: https://en.wikipedia.org/wiki/Mudh-Nyoma_Air_Force_Station ; Tribune https://www.tribuneindia.com/news/top-headlines/nyoma-airbase-near-lac-now-operational ; The Statesman https://www.thestatesman.com/india/mudh-nyoma-airbase-in-ladakh-operationalised-with-air-force-chief-landing-aboard-c-130j-1503511373.html ; Airpower Asia https://airpowerasia.com/2026/01/14/nyoma-airfield-in-ladakh-operational-status-and-strategic-significance/ ; Gulf News (IL-76) https://gulfnews.com/world/asia/india/indian-air-force-makes-history-with-worlds-highest-il-76-landing-at-nyoma-airbase-near-china-border-1.500739453
- DBO: GlobalSecurity/IRNA 20 Aug 2013 https://www.globalsecurity.org/wmd/library/news/india/2013/india-130820-irna01.htm ; https://en.wikipedia.org/wiki/Daulat_Beg_Oldi
- Terrain: https://en.wikipedia.org/wiki/Stok_Kangri ; https://en.wikipedia.org/wiki/Khardung_La

### 8.2 IAF C-17 (No. 81 Sqn "Skylords") operations

| Item | Value | Source |
|---|---|---|
| Fleet | 11 C-17 (10 contracted 15 Jun 2011; 11th delivered Aug 2019) | [P] Boeing India https://www.boeing.co.in/news/2019/boeing-delivers-11th-c-17-globemaster-iii-to-the-indian-air-force ; [S] IDR https://indiandefencereview.com/boeing-c-17-adds-strategic-airlift-capability/ |
| Squadron | No. 81 "Skylords", formed 1 Sep 2013, Hindan (Western Air Command); inducted 2 Sep 2013 | [S] https://en.wikipedia.org/wiki/No._81_Squadron_IAF ; GlobalSecurity/IRNA https://www.globalsecurity.org/wmd/library/news/india/2013/india-130902-irna01.htm |
| Leh trial, June 2010 (pre-purchase) | landed and took off at Leh **with 30 t**; the IL-76 was "considerably restricted" in the same conditions | [S] P. Bhalla, CLAWS *Scholar Warrior* 2013 https://archive.claws.co.in/images/journals_doc/15-%20C-17-Enhancing%20Indias%20Strategic%20Airlift%20Capability.pdf ; Ajai Shukla https://www.ajaishukla.com/2013/06/iaf-gets-its-first-c-17-globemaster-iii.html (dates it 20 Jun 2010) |
| Ex. Bahubali, 18 Dec 2018 | 16 aircraft (≈ 7–8 C-17) moved 463 t Chandigarh → Leh/DZs in < 6 h | [S] Tribune https://www.tribuneindia.com/news/archive/nation/airlifting-463-tonnes-to-leh-in-one-go-iaf-sets-new-record-700324 |
| 2020 eastern-Ladakh build-up | C-17 the only IAF type able to lift a T-90 (≈ 46 t). High-altitude fields "further restrict" the load. After Galwan, > 68,000 troops, ≈ 90 tanks and ≈ 330 BMPs were airlifted (all types) | [S] Tribune 29 Jun 2020 https://www.tribuneindia.com/news/nation/behind-massive-build-up-at-lac-is-the-iafs-never-seen-before-airlift-capability-106054 ; Tribune 14 Aug 2023 https://www.tribuneindia.com/news/nation/after-galwan-clash-68-000-troops-were-airlifted-to-ladakh-534819 |
| Leh, 10 Oct 2020 | C-17 lands supplies | [S] ANI https://www.aninews.in/videos/national/watch-iafs-c-17-globemaster-transport-aircraft-lands-at-leh-airbase-with-supplies-for-troops/ |
| Leh, 16 May 2023 | C-17 with a technical snag blocks the runway | [S] EurAsian Times https://www.eurasiantimes.com/gigantic-c-17-globemaster-blocks-the-entire-airport-near-india-china-border-iaf-works-to-move-the-heavy-lifter/ |
| Kargil (≈ 9,700 ft), Mar 2025 | first C-17 landing; **≈ 35 t** carried versus 60–70 t normally | [S] ThePrint https://theprint.in/defence/a-c-17-landed-in-kargil-shrouded-in-secrecy-heres-why-this-is-significant/2536857 |
| Thoise / Nyoma / DBO | **no documented C-17 landing found** | — |

**Mission design implication:** Leh is the documented C-17 destination. Thoise is plausible: a 3 km runway at
about Leh's elevation. Nyoma's new 2.7 km runway is a plausible "first C-17 landing" story mission. DBO is
**C-130J-only** in the record and should be gated (see 8.4).

### 8.3 Leh temperatures

IMD Leh normals (2011–2024 table): mean daily maximum 27.8 °C in July and August, 23.3 °C in June. Recorded
extremes 34.6 °C (11 Jul 2018) and 34.7 °C (Aug 1978) [P] IMD https://mausam.imd.gov.in/leh/mcdata/City.pdf
(the column labels in that file look inconsistent; the extremes are reliable).

### 8.4 Density-altitude effects [E]

σ = (p/p₀)·(288.15/T). The take-off ground roll is from the section 5.1 model at 4 engines with thrust lapse from
section 2.2 (δ dependence) plus the −0.75%/K temperature correction. V_LOF is in KTAS. Landing roll at 0.30 g,
VREF scaled with sqrt(m) from 125 KCAS at 180 t and converted to TAS:

| Field / OAT | σ | Density alt | TO roll 150 t | 170 t | 190 t | 210 t | Land roll 150 / 180 t |
|---|---|---|---|---|---|---|---|
| Leh / 0 °C | 0.706 | ≈ 11,400 ft | 1,065 m | 1,412 | 1,811 | 2,284 | 829 / 995 m |
| Leh / 15 °C | 0.670 | ≈ 13,100 ft | 1,300 | 1,725 | 2,226 | 2,812 | 875 / 1,049 |
| Leh / 28 °C | 0.641 | ≈ 14,400 ft | 1,568 | 2,092 | 2,708 | 3,441 | 914 / 1,097 |
| Thoise / 25 °C | 0.663 | ≈ 13,400 ft | 1,412 | 1,880 | 2,431 | 3,076 | 884 / 1,060 |
| Nyoma / 0 °C | 0.627 | ≈ 15,100 ft | 1,417 | 1,880 | 2,431 | 3,076 | 934 / 1,121 |
| Nyoma / 15 °C | 0.595 | ≈ 16,700 ft | 1,745 | 2,326 | 3,026 | 3,847 | 985 / 1,182 |
| DBO / −10 °C | 0.579 | ≈ 17,600 ft | 1,652 | 2,202 | 2,854 | 3,624 | 1,012 / 1,214 |
| DBO / 0 °C | 0.558 | ≈ 18,650 ft | 1,893 | 2,530 | 3,292 | 4,193 | 1,050 / 1,261 |
| DBO / 15 °C | 0.529 | ≈ 20,100 ft | 2,367 | 3,182 | 4,168 | 5,351 | 1,108 / 1,330 |

**Rule of thumb:** ground roll ∝ W²/(σ·T·CLmax), and T ∝ about σ^0.7–1 at fixed Mach, so the roll scales between σ^−1.7 and σ^−2. At Leh in summer the take-off roll is 2.2–2.5× the sea-level roll at the same weight.

**Cross-checks against the record:**
- **Leh, June 2010:** 30 t payload. Take-off mass is about 128 t OEW + 30 t + ≈ 25 t fuel (round trip to the plains) ≈ 183 t. The model roll at 15–28 °C is 2,000–2,500 m, inside the 2,752 m runway but with little margin. That is consistent with a "30 t" demonstration rather than a full load.
- **Kargil, 2025:** 35 t reported, against 60–70 t normal.
- **Engine-out climb gradient:** this, not runway length, is usually the binding limit in a valley departure. The FAR 25 second-segment gradient for 4-engine aircraft is 3.0%. It is not modelled here. Leh departures turn in the Indus valley, so a mission should check 3-engine climb at the take-off weight.

**Mission guidance** [E]:

| Field | Max take-off mass | Approach and landing |
|---|---|---|
| Leh / Thoise (summer morning, ≈ 15 °C) | ≈ 185 t (102 troops + ≈ 45 t fuel/cargo). Leave within the 32 °C limit | flaps FULL, ≈ 125 KCAS at 150–170 t. TAS is ≈ 22% higher than CAS, so groundspeed is ≈ 150 kt |
| Nyoma | ≈ 165 t at 15 °C | landing roll ≈ 1,000–1,200 m |
| DBO (gravel, unknown length) | ≤ 150 t on a cold morning; the take-off roll is still ≈ 1.7–1.9 km. Flag DBO as a "stretch / fictional" C-17 mission, or set it in deep winter | assume a 2,000 m strip [E] |

Gravel at DBO: μ_roll ≈ 0.04–0.05, braking μ ≈ 0.3 [E].

---

## 9. Contract fit notes (for whoever builds `c17Definition.ts`)

The pack plugs into `contracts/aircraft.ts` with these gaps:

1. **High-lift configuration:** `AeroTables` has one CL/CD/Cm table. The C-17 needs per-detent increments (section 3.2) and the EBF term (section 3.3), keyed on flap detent and Cμ. The Tejas header already calls out the missing landing-configuration state. The C-17 cannot be flown realistically without it.
2. **Engines:** one `EngineTables` for one engine. The C-17 needs 4 engine instances (positions in section 2.5), each with its own throttle state, failure flag, and a **reverse** state: a ground fraction of 0.40, and in-flight idle-reverse drag (section 2.4). Afterburner fields: set equal to dry, or make them optional.
3. **Idle thrust:** `EngineTables` has `idleFuelFlowKgS` but no idle thrust. Add idle thrust ≈ 7% (flight idle) or ≈ 4% (ground idle) of rated thrust.
4. **Gear:** contract says exactly 3 legs. Use 3 equivalent legs:
   - Nose (2 wheels).
   - Left/right main, each lumping 2 legs × 3 wheels.
   - Main track ≈ 10 m and wheelbase ≈ 20 m. Both estimated from the 33.67 ft sponson width [S] VT07 and the GLB model [E]. Verify against a 3-view.
5. **Mass changes:** cargo drops and fuel need a time-varying mass, CG and inertia (section 6.3).
6. **Control naming:** "elevon" fields map to elevator (pitch) and aileron+spoiler (roll). A separate spoiler/speedbrake/lift-dump deflection is needed (section 3.4).
7. **FCS modes:** PRC/AH up-and-away, attitude command on approach, MECH reversion (section 4.2).

---

## 10. Proposed performance targets (shape of `tools/lib/perfTargets.ts`)

`PERF_TARGET_AIRCRAFT_ID = 'c17a'`. All targets are ISA, zero wind, and use the tables in this pack.

```ts
export const C17_PERFORMANCE_TARGETS: readonly PerformanceTarget[] = [
  {
    id: 'vmax_9000', kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 9000 m, max continuous thrust, clean.',
    altitudeM: 9000, massKg: 200000, configNote: 'MCT, clean, 200 t',
    targetValue: 252, unit: 'm/s', toleranceRel: 0.06,
    sourceNote: 'M0.83 at 9 km (a=303.8 m/s). Model estimate (c17-data.md 5.3): thrust=drag near M0.83 with Mdd 0.82-0.83; consistent with Mmo 0.825 [FC1, unofficial T.O. 1C-17A-1 extract]. Real aircraft is Mmo-limited; this checks drag rise + engine lapse together',
  },
  {
    id: 'cruise_thrust_fl280_mtow', kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 8534 m (FL280) at MTOW, max climb thrust, clean.',
    altitudeM: 8534, massKg: 265352, configNote: 'MCT, clean, 265 t',
    targetValue: 231, unit: 'm/s', toleranceRel: 0.06,
    sourceNote: 'USAF fact sheet: cruise ~450 kt TAS (231 m/s, M0.74-0.76) with initial cruise altitude 28,000 ft at heavy weight. At MTOW the model is just thrust-limited there (45 kN avail vs 44.7 kN drag per engine), so Vmax ~ cruise speed. A model that cannot hold 450 KTAS at FL280 at MTOW has too much drag or too little thrust',
  },
  {
    id: 'climb_sl_200t', kind: PerformanceTargetKind.ClimbRateMps,
    description: 'Sea-level climb rate, max thrust, clean, 250 KEAS.',
    altitudeM: 0, massKg: 200000, configNote: 'TOGA/MCT, clean, 250 KEAS, 200 t',
    targetValue: 20, unit: 'm/s', toleranceRel: 0.30,
    sourceNote: 'No official figure. FAI records 722-724 (C-1q, 150-200 t, 1993) give 12.8 m/s mean 0-3 km incl. take-off and 13.9 m/s mean 3-6 km (lower bound); clean-climb model gives 25 m/s (upper bound). Widest tolerance in the table',
  },
  {
    id: 'stall_clean_200t', kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Clean (slats in) 1-g stall speed at sea level.',
    altitudeM: 0, massKg: 200000, configNote: 'clean, gear up, 200 t',
    targetValue: 80.5, unit: 'm/s', toleranceRel: 0.12,
    sourceNote: 'computed sqrt(2mg/(rho0*S*CLmax)), S=353.0 m^2 [WIKI/VT09], CLmax clean 1.40 (estimate, 25-deg swept supercritical transport)',
  },
  {
    id: 'stall_full_flap_160t', kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Full-flap, gear-down, power-off stall speed at sea level.',
    altitudeM: 0, massKg: 160000, configNote: 'flaps FULL, slats, gear down, idle, 160 t',
    targetValue: 53.0, unit: 'm/s', toleranceRel: 0.12,
    sourceNote: 'CLmax power-off 2.70 (estimate from NASA TN D-6058 CLmax 2.1 at Cmu=0, flaps 30/60, + slats). Power-on (Cmu~0.3) Vs ~49 m/s; 1.25 x that = 115-119 kt, the published 115-kt approach speed [VT09 from AIAA-92-1262]',
  },
  {
    id: 'takeoff_roll_mtow', kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll to lift-off at MTOW, TOGA, flaps 1/2.',
    altitudeM: 0, massKg: 265352, configNote: 'TOGA, flaps 1/2, 265 t',
    targetValue: 2300, unit: 'm', toleranceRel: 0.20,
    sourceNote: 'Jane\'s/Wikipedia take-off run 8,200 ft (2,499 m) at MTOW; Boeing take-off field length 7,740 ft (2,359 m). Model estimate 1,900 m sits at the low edge',
  },
  {
    id: 'takeoff_roll_179t', kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll to lift-off at 395,000 lb, TOGA, flaps 1/2.',
    altitudeM: 0, massKg: 179170, configNote: 'TOGA, flaps 1/2, 179 t',
    targetValue: 914, unit: 'm', toleranceRel: 0.25,
    sourceNote: 'Jane\'s/Wikipedia: take-off run 3,000 ft at 395,000 lb. Model estimate 650-790 m',
  },
  {
    id: 'takeoff_roll_leh_183t', kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll at Leh (3256 m), ISA (field 15C is ~ISA+22; harness is ISA-only), TOGA, flaps 1/2.',
    altitudeM: 3256, massKg: 183000, configNote: 'TOGA, flaps 1/2, 183 t (30 t payload + return fuel)',
    targetValue: 1600, unit: 'm', toleranceRel: 0.30,
    sourceNote: 'C-17 took off from Leh (2,752 m runway) with 30 t in June 2010 trials [CLAWS]. Model: ~1,600 m ISA, ~2,000-2,500 m at 15-28 C. Fails if > 2,752 m at ISA',
  },
  {
    id: 'landing_roll_210t', kind: PerformanceTargetKind.LandingRollM,
    description: 'Touchdown-to-stop ground roll, flaps FULL, max reverse + max braking.',
    altitudeM: 0, massKg: 210000, configNote: 'flaps FULL, reversers, max brakes, 210 t',
    targetValue: 650, unit: 'm', toleranceRel: 0.30,
    sourceNote: 'Boeing: landing field length 3,000 ft (914 m) with 160,000 lb payload (=~210 t with OEW 128 t + reserve). Minus ~250-320 m air distance from 50 ft on a 4-deg path = ~600-700 m ground roll',
  },
  {
    id: 'landing_roll_leh_160t', kind: PerformanceTargetKind.LandingRollM,
    description: 'Ground roll at Leh (3256 m, ISA), flaps FULL, reversers + brakes.',
    altitudeM: 3256, massKg: 160000, configNote: 'flaps FULL, reversers, brakes, 160 t',
    targetValue: 850, unit: 'm', toleranceRel: 0.30,
    sourceNote: 'derived: TAS = CAS/sqrt(sigma) (sigma 0.72 ISA) so roll ~1.4x sea level; c17-data.md 8.4',
  },
];
```

**Extra checks** that the current `PerformanceTargetKind` cannot express. Add these as new kinds or as scenario tests:

| Check | Target | Source |
|---|---|---|
| Idle-reverse tactical descent, −20° deck, 320 KCAS, 15,000 ft, 200 t | 15,000 ft/min (76 m/s) ± 20% | [U] AGC; [S] TWZ |
| Cruise fuel flow, FL280, 450 KTAS, 200 t | 8.5–9.5 t/h total | [E] / [U] forum; [P] JB Charleston average |
| Time to climb 3 → 6 km at 160 t | ≤ 216 s (FAI: 3:36) | [P] FAI 722/723 |
| V_MCA (outboard engine out, TOGA, flaps ½) | 110–125 KCAS | [E] section 2.5 |
| Approach trim, FULL, 160 t, 3° path | 115 ± 8 KCAS at Cμ 0.25–0.35 | [S] VT09 |
| Heavy-drop pitch response, 27 t platform at 200 t | peak q ≈ 2°/s, ≤ 300 ft balloon | [P] NASAEX; [S] AFMC |
| Engine spool, flight idle → 95% | ≤ 5 s | [P] CFR33 |

---

## 11. Biggest data gaps and how to estimate each

| # | Gap | Impact | Estimation method |
|---|---|---|---|
| 1 | **EBF lift vs Cμ for the actual C-17 flap** (η_flap in section 3.3) | Approach speed, assault landing, engine-out roll | Start from the D6058 curves. Tune η_flap per detent so that (a) FULL at 160 t trims at 115 KCAS with Cμ ≈ 0.3, and (b) the 3,000 ft / 160,000 lb landing and 914 m / 179 t take-off targets pass. If a copy of AIAA-92-1262 (Tavernetti) or the NASA Langley C-17 full-scale-tunnel reports become available, replace the curves outright |
| 2 | **Flap/slat deflection angles and per-detent CLmax/CD0** | Approach attitude (deck angle), drag on approach | Pick angles from the D6058/YC-15 lineage (section 3.2). Calibrate ΔCD0 so that a 3° approach at VREF needs ≈ 30% thrust (high-drag powered-lift approach), and the FULL-flap 5° path needs ≈ 15–20% |
| 3 | **Stability derivatives and control power** | Handling feel, engine-out, PIO | C-5A CR-2144 values (section 3.7), scaled by tail-volume ratios. C-17 HT 78.5 m² vs C-5A ≈ 90 m², similar arm-to-MAC ratio. Validate qualitatively: short-period ≈ 0.25–0.35 Hz with ζ ≈ 0.7 (closed loop); Dutch roll damped by the yaw damper |
| 4 | **Moments of inertia, CG range** | Pitch response to airdrop, roll rate | Roskam radii (section 1.4, validated ±8% on the 747); build up wing fuel and cargo as point masses; CG 20–40% MAC |
| 5 | **Surface deflection limits and EFCS gains** | FCS tuning | Typical transport limits (elevator ±25°, aileron ±20°, rudder ±30°, spoilers 0–60°). Tune gains to the PRC/AH response: 0.1 s pure delay, pitch-rate rise ≈ 1 s, no overshoot > 20% |
| 6 | **In-flight reverse drag and ground reverse fraction** | Tactical descent, landing roll | Ram-drag model D = 0.8ρV²A_fan per engine, tuned to 15–18 kft/min at −20° deck. Ground fraction 0.40 tuned to the 2° back-up slope at MTOW: reverse thrust > m·g·sin2° + rolling resistance ≈ 0.035·m·g + 0.015·m·g → at 265 t, ≥ 130 kN total (≥ 33 kN per engine at reverse power; 0.40 × 180 = 72 kN, so OK) |
| 7 | **Engine positions and the high-altitude lapse at climb Mach** | Engine-out yaw, climb | Scale positions from a 3-view (section 2.5). Climb: reconcile the Bartel–Young lapse with the FAI 3–6 km record by allowing a climb rating below TOGA (e.g. MCT = 0.90 × TOGA) |
| 8 | **Airdrop speeds/altitudes per method for the C-17 specifically; door timing** | Mission scripting | AFMAN 11-231 and AFMAN 11-2C-17V3 (e-publishing.af.mil) hold these; they are public but blocked to scripted fetches. Fetch them manually in a browser. Until then use FM 3-21.38 (section 6.2) and 20 s / 8 s door times |
| 9 | **Ladakh runway data from the AIP; DBO strip length** | Mission geometry | AAI eAIP AD 2 VILH (manual download); for DBO use satellite imagery measurement (strip ≈ 1.5–2 km is a guess [E]) |
| 10 | **Flare load and IAF self-protection details** | Escort mission | DSCA confirms ALE-47/AAR-47/flares only. Size the flare load from ALE-47 magazine capacity (30 × 1×1 in or equivalent per magazine) × an assumed 4 dispensers = 120 [E] |
