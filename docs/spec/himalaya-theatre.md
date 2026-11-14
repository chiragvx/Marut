# Himalaya theatre: tri-junction campaign spec (fiction)

Status: analysis and proposal only. No code has been changed. Everything below is for a fictional
campaign in Marut. The sources are public: Wikipedia, OpenStreetMap, open DEMs, news reports and
published research. Base layouts stop at runway, taxiway and apron geometry and general facility
areas.

**Story in one paragraph.** From Ngari Gunsa (Tibet), China moves troops to invade Nepal. India sends
Tejas fighters and a player-flown C-17 Globemaster III to lift troops and munitions to Indian and
Nepalese forward bases in the tri-junction belt: Kailash–Mansarovar, Purang (Burang), Lipulekh,
Kalapani, Humla and far-west Nepal. The finale: Tejas strikes disable Ngari's runway. Then a C-17
lands on Ngari's parallel taxiway, stops short and puts Indian troops on the ground. The story ends there.

**How "nowhere to land" is read here.** There are no diversion airfields. Each C-17 sortie has one
destination (a forward strip, a drop zone, or Ngari itself) and one way home: the base it came from.
A missed approach in a dead-end valley therefore becomes a fuel and terrain problem, not a
"divert to the next airport" problem.

---

## 0. How the game builds a theatre today (what this proposal has to fit)

| Item | Today (file) | What the Himalaya needs |
|---|---|---|
| World size | `TERRAIN_WORLD_EXTENT_M = 200_000`, square, quadtree `MAX_QUADTREE_DEPTH = 8` (781 m reference chunk) (`src/contracts/terrain.ts`) | **320 km** square. Either set `MAX_QUADTREE_DEPTH = 9`, which gives a 625 m reference chunk, or keep depth 8 and accept 1,250 m chunks at the finest LOD. `chunkKeyHash` stays valid (cx < 512 < 1000). |
| Height range | Global `TERRAIN_MIN/MAX_HEIGHT_M` −200…2,100 m; per-theatre `heightBoundsM` | `heightBoundsM: { minM: 300, maxM: 7900 }`. The global constant is documented as the bound for flatten zones and must be raised too, or the per-theatre bound used everywhere. |
| Height field | Analytic and procedural: `createRawTerrainHeight` → `buildShapedHeight` (`coast`, `plains`) from fbm, ridged noise and domain warp (`theatreShapes.ts`, `terrainHeight.ts`) | A new `TerrainShape` kind `'dem'`: a baked elevation grid sampled bilinearly or bicubically, with the existing fbm used as a slope-scaled detail layer. See section 6. |
| Airports | `AirportLayout` JSON (`src/airport/layouts/bhisiana-afs.json`): runways (threshold x/z, heading, length, width), taxiway polylines, aprons, parking, structures, `flattenZones` (circle flat radius + blend radius). Layouts are already built from OSM (ODbL attribution in the file). | The same format. Ngari and Burang have usable OSM geometry (section 3). Use **oriented-rectangle** flatten zones, or several circles along the runway: a 2.2 km circle on a 4.5 km runway in a valley would flatten the valley walls. |
| Water | One global `waterLevelM` | Mansarovar (≈4,590 m) and Rakshastal (≈4,575 m) sit at different levels, and rivers drop 3,000 m across the box. Needs a list of water bodies with their own levels (polygon + level), plus river polylines drawn on the DEM. |
| Atmosphere | `isaAtmosphereInto(alt)` is plain ISA with **no temperature offset** (`src/core/atmosphere.ts`, `src/physics/atmosphere.ts`) | Add `WeatherConfig.isaDeviationK`. Hot-and-high is the whole point of this theatre: today Ngari would always be −12.8 °C (ISA at 4,274 m). |
| Wind | One world-frame vector per tick: `windWorldMps` + gust (2 s target, 1.5 s low-pass) + white jitter × `turbulence` (`src/core/wind.ts`). It is copied into every aircraft's `env.windWorldMps` (`world.ts` ~L988). A second, unused-in-loop `sampleWind` sits in `src/physics/wind.ts`. | Per-aircraft `windAt(pos, t)` with terrain terms. See section 5. |
| Aircraft | Tejas plus aggressor types (`src/aircraft/`). **No C-17 exists.** | A C-17 definition is a prerequisite. Its landing model needs reverse thrust, spoilers, anti-skid brakes and brake energy. |
| Missions and menus | `catalogue.ts`: `BaseId`, `BASES`, `MISSIONS`, mission JSON with `weather {windWorldMps, gustMps, turbulence}` and objectives (`land`, `reach_waypoint`, `destroy_*`, `close_runway`, …) | A new base (`naini`), 6 mission entries, new objective kinds: `land_in_box` (touchdown zone + stop-by distance), `airdrop` (DZ hit). |

---

## 1. Geography of the theatre box

### 1.1 The proposed box

| Item | Value |
|---|---|
| Centre (game origin) | **30.850° N, 80.745° E** (just south-west of Gurla Mandhata, over the Kali–Karnali divide) |
| Bounds | **29.40–32.30° N, 79.07–82.42° E** |
| Size | **320 km × 320 km** (102,400 km²), game x ∈ [−160, +160] km east, z ∈ [−160, +160] km south |
| Projection | Local azimuthal-equidistant (or UTM 44N, which covers 78–84° E, then offset to the centre). Scale error under 0.1% across the box. |
| Contains | Ngari Gunsa (21 km in from the north edge), Burang airport, Kailash, Mansarovar, Rakshastal, Gurla Mandhata, Lipulekh, Kalapani, Gunji, Api, Saipal, Humla Karnali and Simikot, Nanda Devi, Kamet, Mana and Niti passes, the Sutlej (Zanda/Tholing) valley, Pithoragarh (Naini Saini), Darchula, Bajhang |
| Outside (off-map references, "air start at the edge") | Leh, Thoise, Nyoma (≈250–350 km NW), Bareilly, Hindon, Nepalgunj, Dhangadhi, Mahendranagar, Surkhet, Chinyalisaur/Dharasu (78.32° E, 70 km west of the edge), Shiquanhe town (44 km N of Ngari) |
| DEM-sampled range (SRTM 90 m, 0.1° grid) | ≈440 m (SW foothills) to 7,771 m (Nanda Devi cell). Published summit max: Nanda Devi 7,816 m. |

Game coordinates of key points in that frame (x east, z south, km; ±0.5 km):

| Place | x | z | Place | x | z |
|---|---|---|---|---|---|
| Ngari Gunsa (runway mid) | −65.2 | −139.2 | Naini Saini (Pithoragarh) | −48.8 | +139.8 |
| Burang airport | +37.8 | +50.2 | Gunji | +11.4 | +74.5 |
| Kailash | +54.0 | −24.3 | Lipulekh | +27.3 | +68.5 |
| Mansarovar (centre) | +67.4 | +22.0 | Simikot | +103.4 | +97.2 |
| Rakshastal (centre) | +48.3 | +18.8 | Nanda Devi | −74.3 | +52.5 |
| Gurla Mandhata | +52.9 | +45.7 | Tholing (Zanda) | −89.8 | −70.9 |

Key distances: Naini Saini → Ngari 279 km. Naini Saini → Gunji 89 km. Naini Saini → Burang 125 km.
Naini Saini → Simikot 158 km. Burang → Ngari 216 km.

**Alternative:** a 360 km world (depth 9, 703 m chunks) gives Ngari a 40 km margin to the north edge for
north-western approaches. The 320 km box already covers the approach from the south-east, which is
the one the missions use.

### 1.2 Peaks, valleys, lakes and passes

Elevations are published values (Wikipedia). "DEM" is the SRTM-90 m sample at the listed point, as a
check. A 90 m cell sits below a sharp summit, so the DEM figure reads low.

| Feature | Kind | Lat, lon | Elevation (published) | DEM sample |
|---|---|---|---|---|
| Kailash | Peak | 31.068, 81.312 | 6,638 m | 6,394 |
| Gurla Mandhata (Naimona'nyi) | Peak | 30.438, 81.297 | 7,694 m | 7,554 |
| Api | Peak | 30.007, 80.933 | 7,132 m | 6,894 |
| Saipal | Peak | 29.893, 81.502 | 7,031 m | 6,874 |
| Nanda Devi | Peak | 30.376, 79.971 | 7,816 m | 7,771 |
| Kamet | Peak | 30.920, 79.592 | 7,756 m | 7,674 |
| Panchachuli | Peak group | 30.215, 80.428 | 6,904 m | 6,684 |
| Manasarovar | Lake (≈320 km²) | 30.65, 81.45 | ≈4,590 m | 4,585 |
| Rakshastal | Lake (≈250 km²) | 30.68, 81.25 | ≈4,575 m | 4,570 |
| Lipulekh | Pass (India–China, Kali valley ↔ Purang) | 30.234, 81.029 | ≈5,334 m | 5,102 |
| Mana | Pass (Uttarakhand ↔ Zanda) | 31.07, 79.42 | ≈5,600 m | 5,540 |
| Niti | Pass | 30.97, 79.88 | ≈5,070 m | 4,948 |
| Kalapani | Kali headwater area | 30.21, 80.99 | 3,600 m (camp, valley) | 4,618 (point on slope) |
| Gunji | Kali valley village | 30.18, 80.86 | ≈3,200 m | 3,231 (floor 3,160) |
| Hilsa | Humla Karnali at the Nepal–China border | 30.15, 81.34 | ≈3,650 m | 3,647 |
| Purang (Taklakot) town | Karnali (Mapchu Tsangpo) valley | 30.30, 81.18 | ≈3,900 m | 3,897 |
| Tholing (Zanda) | Sutlej valley | 31.48, 79.80 | ≈3,700 m | 3,723 |

**Valleys (the flying corridors):**

| Valley | Course in the box | Character |
|---|---|---|
| **Kali / Mahakali** (India–Nepal border) | Lipulekh/Kalapani → Gunji (3,200 m) → Dharchula → Jhulaghat (≈550 m) → plains | Deep V-gorge. At Gunji the floor is ≈3 km wide with walls to 4,500–5,500 m within 3–6 km (DEM cross-section, section 2.4). It is the natural Indian approach to Lipulekh. |
| **Humla Karnali** | Enters Nepal from Purang at Hilsa (3,650 m) → past Simikot (gorge ≈2,300 m, town on a shelf at ≈2,950 m) → SE | Narrow gorge. Simikot sits 600 m above the river. The only fixed-wing access is a 550 m STOL strip. |
| **Karnali / Mapchu Tsangpo (Purang basin)** | Rises near Mansarovar, flows S past Purang and Burang airport to Hilsa | An open basin at 4,000–4,300 m, several km wide. The Nalakankar ridges to the SW reach 5,300–6,300 m within 8–12 km of Burang airport. |
| **Sutlej (Langqen Zangbo)** | From Rakshastal NW through the Zanda canyonlands (Tholing 3,700 m) toward Shipki La (west of the box) | Wide eroded badland canyon, a classic low-level route NW toward Ngari. |
| **Gar / Sengge Zangbo (Indus)** | NW–SE valley holding Ngari Gunsa | Floor 4,240–4,300 m, ≈11 km wide, nearly flat for 30 km. Walls reach 5,600–6,076 m within 10–16 km on both sides (section 3.4). |
| **Gori / Darma / Dhauliganga** (Uttarakhand) | N–S valleys from Munsiyari/Dharchula up to the Tibet passes | Tight, glaciated headwalls: masking routes for Tejas. |

### 1.3 Why this box makes good flying

- **Every altitude regime is in one map.** It runs from 500 m sub-tropical gorges (Kali at Jhulaghat) to
  4,300 m plateau airfields and 7,800 m summits. A Tejas can drop into a 600 m deep gorge and pop up
  onto a plateau. A C-17 starts at 1,500 m and ends at 4,274 m.
- **Valleys are both the corridors and the traps.** Kali, Humla Karnali and the Sutlej give terrain
  masking against plateau radars, but they dead-end at passes above 5,000 m. Turning back requires
  planning: TAS is 20–30% higher than IAS, so turn radius grows with it.
- **Two very different airfields as set pieces.** Ngari sits in a wide, flat valley, so the approach
  is easy, but a cross-valley wind there can produce mountain waves and rotor. Burang sits in an open
  basin under Gurla Mandhata.
- **Weather with a daily rhythm.** Calm, cold, dense mornings and windy, turbulent, hot-and-high
  afternoons let the same mission be easy at dawn and hard at 15:00 (section 5).
- **Landmarks you can navigate by.** The Kailash pyramid, the twin lakes, Gurla's ice face and the
  Api–Saipal wall are visible from 100+ km in clear air, so players can navigate by eye.

---

## 2. Airfields (public data)

**C-17 rule of thumb used below.** The USAF and Boeing quote 3,500 ft × 90 ft (1,067 m × 27.4 m) as the
minimum runway at sea level. The 3,000 ft (914 m) "landing field length" is tied to a 160,000 lb payload.
A 1997 GAO report said 5,000 ft is needed on a wet runway with full payload. Pavement strength (PCN)
is the usual real limiter on small strips and is rarely published. "C-17: yes" means it is long, wide,
strong and reported in use.

### 2.1 Chinese

| Airfield | Coords | Elevation | Runway | Surface | C-17? | Notes |
|---|---|---|---|---|---|---|
| **Ngari Gunsa (ZUAL/NGQ)** | 32°06′31″N 80°03′10″E | 4,274 m (14,022 ft) | **15/33, 4,500 m** (OSM: 4,486 m, 45 m wide, true 332°/152°) | Asphalt/paved | Geometrically yes on the runway | Opened 1 Jul 2010. Dual-use. J-11/J-16 reported since 2017. ≥12 hardened shelters, munitions storage and SAM deployment reported in 2021 imagery. |
| **Ngari Burang / Purang (Pulan)** | 30°23′51″N 81°08′19″E | 4,250 m | 15/33, 4,500 m per Wikipedia. OSM: 4,945 m × 50 m, true 329°, concrete. Full-length parallel taxiway. | Concrete | Geometrically yes | Approved Apr 2021, opened 27 Dec 2023. 12 km from Burang town, ≈17 km from Lipulekh. Wikipedia and OSM disagree on the length (unknown). |

### 2.2 Indian

| Airfield | Coords | Elevation | Runway | C-17? | Notes |
|---|---|---|---|---|---|
| Leh (Kushok Bakula Rimpochee, VILH) | 34.14 N 77.55 E | 3,256 m | 07/25, 2,752–2,754 m × 45 m, asphalt | **Yes, real** (No. 81 Sqn flies there regularly) | Off-map. One-way approach, rising terrain at the east end. Flights run in the morning because of afternoon mountain winds. |
| Thoise (Nubra) | 34.65 N 77.38 E | ≈3,070 m | Not published (unknown) | **Yes, real** (Wikipedia: Skylords fly to Leh and Thoise) | Off-map |
| Nyoma / Mudh-Nyoma AFS | ≈33.2 N 78.7 E | ≈4,180 m (13,700 ft) | ≈2.7 km paved, fighter-capable | Reported capable. C-130J landing at the Nov 2025 inauguration, IL-76 since. | Off-map, 23–50 km from the LAC |
| **Pithoragarh / Naini Saini** | 29°35′29″N 80°14′24″E | ≈1,500 m (DEM 1,496) | 14/32, 1,600 m × 30 m, asphalt | **No** (C-130J demonstrated; pavement and approaches unsuited) | Inside the box. IAF to co-operate the field. ₹450 crore expansion cleared. Saur valley bowl: hills to 1,860–2,120 m within 1–3 km NE. |
| Chinyalisaur / Dharasu ALG | 30°34′58″N 78°19′24″E | 909 m | 16/34, 1,001 m, concrete | No | Off-map (west). C-130J demonstrated. The same field as "Dharasu". |
| Gauchar ALG (Chamoli) | ≈30.28 N 79.16 E | ≈800 m | Short strip (length not confirmed) | No | Inside the box, SW corner |
| Bareilly AFS | 28.42 N 79.45 E | ≈180 m | ≈2.7 km class (unverified) | Probably | Off-map (south). A plausible rear base. |
| Hindon AFS | Delhi NCR | ≈210 m | Long | **Yes, real**: home of all IAF C-17s (No. 81 Sqn) | Off-map |

### 2.3 Nepalese

The Wikipedia list gives one figure per domestic airport. It matches the published runway lengths, so it
is read as runway length here. Elevations are SRTM-90 samples.

| Airfield | ICAO | Coords | Elevation | Runway | In box? | C-17? |
|---|---|---|---|---|---|---|
| Simikot | VNST | 29°58′16″N 81°49′08″E | 2,818 m (Wikipedia) / 2,970 (DEM) | 10/28, 549 m (body text) or 650 m (table), asphalt | Yes | No (STOL only) |
| Bajhang | VNBG | 29°32′N 81°11′E | ≈1,210 m | 654 m | Yes (S edge) | No |
| Bajura | VNBR | 29°30′N 81°40′E | ≈1,390 m | 520 m | Yes (S edge) | No |
| Darchula | VNDL | 29°40′N 80°33′E | ≈680 m | Earthen, length not listed | Yes | No |
| Doti (Dipayal) | VNDT | 29°16′N 80°56′E | ≈580 m | 490 m | No | No |
| Sanfebagar | VNSR | 29°14′N 81°13′E | ≈590 m | 530 m | No | No |
| Jumla | VNJL | 29°16′N 82°11′E | ≈2,370 m | 670 m | No | No |
| Rara (Talcha) | VNRR | 29°31′N 82°09′E | ≈2,700 m | 570 m | Just outside (E) | No |
| Mahendranagar | VNMN | 28°58′N 80°09′E | ≈220 m | 884 m | No | No |
| Dhangadhi | VNDH | 28°45′N 80°35′E | ≈190 m | 1,800 m | No | Marginal: length OK, pavement unknown |
| Surkhet | VNSK | 28°35′N 81°38′E | ≈680 m | 1,255 m | No | Marginal |
| Nepalgunj | VNNG | 28°06′N 81°40′E | ≈160 m | 1,700 m | No | Marginal: length OK, pavement unknown |

### 2.4 Friendly forward bases for the campaign

**No real airfield inside the box can take a C-17.** The proposal therefore uses one real-but-upgraded
home base, one fictional ALG and one airdrop zone:

| Role | Base | Status | Spec for the game |
|---|---|---|---|
| **Home base** (C-17 and Tejas detachment), `BaseId 'naini'` | **Naini Saini, Pithoragarh: "extended"** | **FICTIONAL UPGRADE** of a real field. Plausible given the cleared expansion and IAF co-use. | Runway 14/32 extended to **2,400 m × 45 m**, strengthened pavement, parallel taxiway, a two-bay C-17 apron and a small Tejas ORP. Elevation 1,500 m. The DEM along the runway axis stays at 1,480–1,540 m for ±2.5 km, so the cut-and-fill is believable. Terrain rises 350–600 m within 1–3 km NE: a curved, one-sided circuit. |
| **Forward base 1** (Indian Army, Kali valley) | **Gunji ALG** | **FICTIONAL** | Gravel/PSP-matting strip of **1,450 m × 30 m** on the Kali terrace near Gunji, ≈3,250 m. **One-way**: land up-valley (≈NE), take off down-valley. The valley floor is ≈3 km wide, walls 4,000–5,500 m within 3–6 km. 17 km from Lipulekh. Go-around only before a published commit point. |
| **Forward base 2** (Nepal Army, Humla) | **Simikot DZ** | Real place, fictional use | No landing possible (549 m strip on a shelf). C-17 **airdrop** of paratroops and CDS bundles on a marked DZ beside the strip, ≈2,950 m. Run-in up the Humla Karnali gorge. |
| Off-map rear | Bareilly / Hindon | Real | Briefing only, or an air start at the south edge |

---

## 3. Ngari Gunsa geometry for the finale

Source: OpenStreetMap ways in bbox 80.00–80.11 E, 32.07–32.15 N, downloaded 2026-11-14 (ODbL), projected
into a runway-aligned frame by a scratch script. Along is measured in metres from threshold 33 (the
south end) toward threshold 15. Cross is metres to the right of a 332° heading (positive = NE side).
Elevations are SRTM-90 m samples.

### 3.1 Runway

| Item | Value |
|---|---|
| Designation | 15/33 |
| True heading | **332.1° / 152.1°** (magnetic variation ≈ +1° E, so the numbers fit) |
| Length / width | **4,486 m (OSM) / 4,500 m (Wikipedia); 45 m** |
| Thresholds | 33: 32.08200 N 80.06422 E (DEM 4,274 m). 15: 32.11785 N 80.04195 E (DEM 4,260 m). |
| Slope | ≈14 m down toward the NW over 4.5 km (−0.3%) |
| Lighting | PAPI mapped at both ends (OSM) |

### 3.2 Taxiways and aprons (from OSM)

| Element | Along (m from thr 33) | Cross (m) | Length | Notes |
|---|---|---|---|---|
| **Parallel taxiway** | 21 → 4,463 | **+168 to +170 (NE side)** | **4,607 m** polyline | **Dead straight at 152°/332° end to end.** Individual OSM segments are 853, 208, 792, 463, 995, 169 and 886 m, all at the same heading. |
| South-end link | 0 → 60 | 0 → 168 | ≈200 m | Curved turn-off at threshold 33 |
| Angled link (rapid-exit style) | Runway 1,348 → parallel 946 | 0 → 168 | ≈437 m | |
| Short stub | ≈1,090–1,115 | 100 → 168 | ≈84 m | Probably a holding bay |
| Civil apron link | 2,530–2,632 | 0 → 362 | ≈400 m | Crosses the parallel to the civil apron |
| Civil apron + terminal | 2,404–2,819 | +241 to +512 | ≈415 × 220 m apron | 4–5 stands. Terminal at cross +463–512. |
| Angled link | Runway 3,170 → parallel 3,573 | 0 → 169 | ≈439 m | |
| Short stub | ≈3,365–3,402 | 95 → 168 | ≈100 m | |
| North-end link | ≈4,423–4,464 | 0 → 169 | ≈208 m | |
| North apron | 3,481–4,647 | +123 to +373 | ≈1,170 × 250 m | Large apron off the north end of the parallel. Use it in the game as a generic "military apron / support area". Shelter detail is deliberately not modelled from imagery. |

News reports from 2020 mention a "secondary tarmac / taxi-track built alongside the runway". That fits
this full-length parallel at 168 m separation.

**Straight, unobstructed parallel-taxiway segments between junctions** (where a C-17 could land
without crossing another paved junction):

| Segment | Along from → to | Length |
|---|---|---|
| A | 60 → 946 | ≈890 m |
| **B** | **1,115 → 2,573** | **≈1,460 m** |
| C | 2,632 → 3,365 | ≈730 m |
| D | 3,402 → 4,423 | ≈1,020 m |

The **whole parallel is one 4.4 km straight**, so geometry alone does not force a 1 km stop. The short
stop has to come from the story. The Tejas strike craters the runway and the taxiway junctions; in the
game, crater markers or barricades set the usable length (section 4.4). Segment B is the natural box:
a real ≈1,460 m straight between two junctions, ending next to the civil apron link, where the troops
deploy.

### 3.3 Taxiway width and the C-17's main-gear track

| Item | Value | Source / confidence |
|---|---|---|
| Ngari parallel taxiway width | **Not published; no `width` tag in OSM.** Assume **23 m** (ICAO standard width for code D/E aircraft with an outer main gear wheel span of 9–15 m; the usual value on Chinese 4D/4E airfields). It could be 18–25 m. | Assumption; measure from imagery before building the layout |
| C-17 outer main-gear wheel span | **≈10.26 m (33.7 ft)** outside to outside | Secondary source (blog), consistent with drawings |
| Margin each side on a 23 m taxiway | (23 − 10.26) / 2 ≈ **6.4 m** | |
| Margin each side on an 18 m taxiway | ≈ **3.9 m** | |
| C-17 minimum runway width | 90 ft (27.4 m) | USAF / Boeing |
| C-17 wingspan | 51.77 m. On a 23 m taxiway each wing overhangs the pavement edge by ≈14 m. | Wikipedia |

Implication: the taxiway is narrower than the C-17's published minimum runway width. Even on 23 m
there is only about 6 m between the outer main wheels and the edge. A touchdown drift of 2–3 m from a
crosswind, or a decrab late, puts a gear truck in the gravel. Edge lights and signs inside the wing
sweep become strike hazards. That is the right "hard" feel for the finale.

### 3.4 Terrain around the approaches (SRTM 90 m)

Along the runway axis (km from the runway mid-point; + toward the NW, beyond threshold 15):

| km | −40 | −30 | −20 | −10 | −4 | 0 | +4 | +10 | +20 | +28 | +32 | +36 | +38 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 4,468 | 4,530 | 4,364 | 4,333 | 4,278 | 4,267 | 4,259 | 4,249 | 4,242 | 4,241 | 4,428 | 4,763 | 4,952 |

Across the runway (km; + = NE):

| km | −24 | −16 | −10 | −8 | −6 | −2 | 0 | +2 | +4 | +6 | +10 | +14 | +18 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 5,668 | **6,076** | 5,232 | 4,474 | 4,311 | 4,267 | 4,267 | 4,268 | 4,338 | 4,825 | 5,629 | 5,675 | 5,269 |

- **Approach from the SE (landing 332°):** a gentle rise of +100 m at 20 km out and +260 m at 30 km.
  The obstacle-free final runs straight down the valley. This is the planned finale approach.
- **Approach from the NW (landing 152°):** the valley floor is flat for 28 km, then the ground climbs
  to 4,950 m at 38 km. A straight-in from the NW needs to descend steeply after crossing that ridge.
- **Valley width:** flat floor ≈11 km (−7 to +4 km). The walls climb **1,300–1,800 m above the field
  within 6–16 km** on both sides. With a SW or W wind (the prevailing upper wind; the valley axis runs
  NW–SE, so a westerly blows almost across it), the field sits in the **lee of a 6,000 m ridge 16 km
  upwind**. That is classic lee-wave and rotor geometry (section 5).

---

## 4. Feasibility of the taxiway landing

> **Recommendation (the coordinator asked for this; 1 km is kept as a data point).**
> The finale should use a **1,200 m usable taxiway segment**: a crater line at the start and a block at
> the end, inside segment B. The landing weight should be **340,000 lb** with **about 10 kt of headwind
> at dawn**. A modelled C-17 then stops in **≈670 m of ground roll** (calibrated) or ≈1,020 m from a
> 50 ft crossing at the crater line. The player must cross the crater line low, touch down in the first
> **≈250 m** and use full reverse, spoilers and maximum braking. Floating, or being 5 kt fast, will
> overrun. That is hard but achievable. **1,000 m** works as an expert or "Legend" band. It needs a
> lighter jet (≤ 300,000 lb), ≥ 10 kt of headwind, a cold morning and a touchdown in the first 100 m.
> **1,450 m** (the full segment B) is the easy band.

### 4.1 Published C-17 data and assumptions

| Item | Value | Source |
|---|---|---|
| MTOW / max payload | 585,000 lb / 170,900 lb | Wikipedia |
| Empty / operating empty weight | 282,500 lb (some sources 276,500–277,000) | aerocorner; Virginia Tech slides |
| Wing area | 3,800 ft² (353 m²) | aerocorner; Virginia Tech |
| Engines | 4 × F117-PW-100, 40,400–40,440 lbf. Reversers usable down to backing on the ground. | Wikipedia |
| Landing field length | **3,000 ft (914 m) with a 160,000 lb payload, including reversers** | Boeing; Virginia Tech slides |
| Runway minimum | 3,500 ft × 90 ft | USAF/Boeing via Wikipedia |
| Approach speed | **115 kt** (most sources); about 130 kt in one article | Virginia Tech; aerocorner; migflug |
| Max landing weight | **Not found publicly** | Unknown |
| Troops | 102 paratroopers with equipment | Wikipedia |

### 4.2 Model

`roll.py` in the scratchpad: a time-stepped ground roll.

- **Approach speed (CAS)** is taken as `Vref·√(W/400,000 lb)`. Touchdown is 5 kt below that, as in an
  assault landing with no float.
  - Nominal case: Vref = 115 kt at 400,000 lb.
  - **Calibrated (conservative) case: Vref = 130 kt at 400,000 lb.**
- **Ground speed** = TAS − headwind, where TAS = CAS/√σ.
- **Decelerating forces:**
  - a 2 s transition at constant speed (spoilers out, brakes and reverse coming on);
  - brakes μ = 0.35 on (W − lift), with lift dumped;
  - reverse = 30% of static thrust × δ, reduced a further 0.8%/K above ISA;
  - aero drag C_D = 0.10 on 353 m².
- **Air distance** is measured from a 50 ft crossing on a 3.5° assault glide with no flare, plus a 1.5 s float.

**Calibration check (sea level, ISA, 400,000 lb).** The conservative case gives a 553 m roll and 334 m in
the air, ≈ **887 m ≈ 2,910 ft**. That matches the published 3,000 ft landing field length. **The
conservative column is therefore the one to trust and to tune the game's C-17 against.** The nominal
column is optimistic.

Density altitude at Ngari, 4,274 m. ISA temperature there is −12.8 °C; Shiquanhe normals are from CMA
1991–2020.

| Case | OAT | ISA dev. | Density altitude | σ | TAS / CAS |
|---|---|---|---|---|---|
| January dawn (mean min −19.3) | −18.8 °C | −6 | 13,300 ft | 0.67 | 1.22 |
| **October dawn (mean min −7.0)** | −6.8 °C | +6 | **14,700 ft** | 0.64 | 1.25 |
| October afternoon (mean max 8.8) | 9.2 °C | +22 | 16,500 ft | 0.60 | 1.29 |
| July afternoon (mean max 22.0) | 22.2 °C | +35 | 17,900 ft | 0.57 | 1.33 |

The headline effect: at the same CAS, TAS is 22–33% higher, so kinetic energy and ground roll are
**≈1.5–1.8× the sea-level figure**. Reverse thrust also drops to about 0.58× (pressure ratio δ). Wheel
braking does not fall off with density: it scales with weight on the wheels. That is why the roll
grows by less than V² alone would suggest.

### 4.3 Results at Ngari (ground roll from touchdown; "from 50 ft" uses the calibrated case)

| Landing weight (lb) | Conditions | DA (ft) | KCAS at touchdown | KTAS | Headwind (kt) | Roll, nominal (m) | **Roll, calibrated (m)** | From 50 ft, calibrated (m) | Brake KE (MJ) |
|---|---|---|---|---|---|---|---|---|---|
| 300,000 | Jan dawn | 13,300 | 95 | 116 | 10 | 436 | **552** | 895 | 202 |
| 300,000 | Oct dawn | 14,700 | 95 | 119 | 0 | 536 | **668** | 1,021 | 254 |
| 300,000 | Oct dawn | 14,700 | 95 | 119 | 10 | 458 | **581** | 927 | 213 |
| 300,000 | Oct dawn | 14,700 | 95 | 119 | 20 | 386 | **500** | 838 | 175 |
| 300,000 | Jul afternoon | 17,900 | 95 | 125 | 10 | 525 | **667** | 1,018 | 238 |
| **340,000** | **Oct dawn** | **14,700** | **101** | **127** | **10** | **529** | **671** | **1,024** | **278** |
| 340,000 | Oct dawn | 14,700 | 101 | 127 | 0 | 613 | **765** | 1,125 | 328 |
| 340,000 | Oct dawn | 14,700 | 101 | 127 | −5 (tail) | 658 | **815** | 1,179 | 354 |
| 340,000 | Oct dawn | 14,700 | 101 | 127 | 20 | 451 | **583** | 928 | 233 |
| 340,000 | Oct afternoon | 16,500 | 101 | 131 | 10 | 570 | **723** | 1,079 | 297 |
| 340,000 | Jul afternoon | 17,900 | 101 | 134 | 10 | 605 | **768** | 1,127 | 311 |
| 370,000 | Oct dawn | 14,700 | 106 | 133 | 10 | 583 | **739** | 1,097 | 333 |
| 370,000 | Oct afternoon | 16,500 | 106 | 136 | 0 | 721 | **900** | 1,269 | 414 |
| 400,000 | Oct dawn | 14,700 | 110 | 138 | 10 | 637 | **807** | 1,170 | 394 |
| 400,000 | Oct afternoon | 16,500 | 110 | 142 | −5 (tail) | 834 | **1,035** | 1,413 | 520 |
| 400,000 | Jul afternoon | 17,900 | 110 | 145 | 0 | 827 | **1,034** | 1,410 | 507 |
| *ref: 400,000* | *Sea level ISA* | *0* | *110 / 125* | *110 / 125* | *0* | *446* | *553* | *887* | *291 / 375* |

Sensitivity at 340,000 lb, ISA+13 and 10 kt headwind (nominal model, base roll 528 m):

| Change | Ground roll |
|---|---|
| μ 0.25 (dust or patched pavement) | 646 m (+22%) |
| μ 0.45 | 454 m (−14%) |
| 1 s transition | 469 m (−11%) |
| No reverse | 614 m (+16%) |

### 4.4 Stop-distance options for the finale

All of these are measured from the start of the usable segment (the crater line). The player crosses
it at ≤ 50 ft.

| Usable segment | What it takes (calibrated model) | Verdict |
|---|---|---|
| **1,000 m** (original brief) | 300,000 lb, Oct or Jan dawn, ≥ 10 kt headwind: 895–927 m from 50 ft, so a 70–100 m margin. At 340,000 lb it needs ≥ 20 kt of headwind (928 m) or a near-perfect touchdown in the first 100 m. | Expert band only. One small error means an overrun. |
| **1,200 m (recommended)** | 340,000 lb, Oct dawn, 10 kt: 1,024 m, so ≈180 m margin (about 1.5 s of float or 5 kt fast). Still OK at 370,000 lb with 10 kt (1,097 m). Fails on a hot afternoon with no wind at 370,000 lb (1,269 m). | Hard but achievable. Rewards weight planning and choosing dawn. |
| **1,450 m** (all of segment B) | Fits every case in the table except 400,000 lb on a hot afternoon. | Easy or story mode |

### 4.5 Difficulty levers

| Lever | Easy | **Normal (recommended)** | Hard | Legend |
|---|---|---|---|---|
| Usable taxiway length | 1,450 m | **1,200 m** | 1,100 m | 1,000 m |
| Max mission landing weight (troops, kit, fuel) | 370,000 lb | **340,000 lb** (≈100 troops and kit ≈ 32,000 lb + ≈25,000 lb fuel over a 282,500 lb OEW) | 360,000 lb (adds two light vehicles) | 340,000 lb |
| Time and temperature | Jan dawn (ISA−6) | **Oct dawn (ISA+6)** | Oct mid-morning (ISA+15) | Oct afternoon (ISA+22) |
| Wind (down the taxiway) | 15 kt head | **10 kt head, gust 5** | 5 kt head, 8 kt cross, light mountain-wave turbulence | Calm or 5 kt tail, rotor gusts |
| Overrun area past the block | 300 m graded dirt (counts as a "rough stop": survivable, low score) | **150 m dirt, then a barricade** | 50 m | None: crater or wall |
| Touchdown box | First 400 m | **First 300 m** | First 250 m | First 150 m |
| Lateral tolerance (gear off pavement) | ±8 m | **±5 m** | ±4 m | ±3 m |
| Assist | Speed and aim-point cues, auto-reverse | **Speed cue, manual reverse** | No cues | No cues, SAM pressure on the approach |

**Scoring bands** (Normal: stop point measured from the crater line):

| Band | Condition |
|---|---|
| Gold | ≤ 950 m, centreline ±2 m, sink ≤ 2.5 m/s |
| Silver | ≤ 1,100 m |
| Bronze | ≤ 1,200 m (inside the segment) |
| Rough stop | Into the overrun area, aircraft intact. Mission passes with a penalty. |
| Fail | Past the barricade, any gear off the pavement above 30 kt, sink > 4 m/s (gear collapse), wingtip strike, or brake fire from KE above the limit |

**Brake energy as a lever.** KE at Ngari is 1.0–1.8× the sea-level value at the same weight. Model brake
temperature with a fuse-plug or brake-fire threshold around **450 MJ**. That makes heavy, hot, tailwind
landings fail even when the length suffices.

---

## 5. Atmosphere and weather

### 5.1 What the region does

| Phenomenon | Typical behaviour | Source / confidence |
|---|---|---|
| **Winds aloft** | Oct–May: the subtropical westerly jet sits over or just south of the Himalaya and Tibet, core at 200–250 hPa (≈11–12 km), commonly 40–70 m/s (one Feb 2023 case reached 70 m/s). Jun–Sep: the jet shifts north of the plateau, with weak easterlies over it and the Tibetan anticyclone overhead. At the 500 hPa level (≈5.5 km, ridge height) winter westerlies are ≈15–30 m/s. | Frontiers 2025 case study; Penn State METEO 3; general climatology |
| **Mountain waves** | Strong, ridge-normal flow (> ≈15 m/s at ridge height) with a stable layer above produces lee waves downwind of the Great Himalaya and the Ladakh and Kailash ranges. Wavelength λ ≈ 2πU/N, about **6–15 km**. Vertical speeds of 5–10 m/s, and more in severe cases. The plateau edges and the Himalaya are the turbulence-prone parts of the region. | General mountain meteorology; turbli blog (low authority) |
| **Rotors** | Under the first one or two wave crests, below about ridge height, at 0.5–1.5 λ downwind of the ridge. Reversed low-level flow and moderate-to-severe turbulence. At Ngari this is the classic danger with a SW–W wind over the 6,000 m SW wall. | General meteorology |
| **Valley winds (daily cycle)** | Up-valley winds build from late morning and peak mid-afternoon. They are very strong in deep Himalayan gorges: the Kali Gandaki (Nepal) flow is reported at **15–20 m/s**. Down-valley or katabatic drainage at night and early morning is weak, ≈2–5 m/s and a few hundred metres deep. Leh schedules flights for the morning because of the afternoon winds. | Egger et al. 2000; Zängl et al. 2001 (MWR); NJPS (secondary); Leh airport page |
| **Katabatic flows** | Cold drainage off glaciers (Gurla, Api–Saipal, Nanda Devi), strongest before dawn and pooling on valley floors and lakes. Temperature inversions trap haze. | General |
| **Plateau afternoon winds and dust** | Western Tibet is very dry (Shiquanhe 70.6 mm/yr). Spring (Mar–May) afternoons are gusty, with blowing dust and sand in the Gar, Sutlej and Purang basins, so visibility can drop to a few km. | CMA normals (via Wikipedia); general |
| **Thermals** | Strong insolation (≈3,500 h of sunshine a year at Shiquanhe). Dry thermals on sunlit slopes from late morning, with moderate low-level chop. | CMA normals |
| **Temperatures** | Ngari: Jan −19 / −4 °C (min / max), Jul +8.5 / +22 °C. Records −36.7 and +32.1. Naini Saini (1,500 m) is temperate, ≈0–30 °C over the year. | CMA 1991–2020 |
| **Hot and high vs winter** | Summer afternoons give DA ≈ 18,000 ft at Ngari, with long rolls and weak climb. Winter mornings give DA ≈ 13,000 ft but snow, ice and very cold soak. | Section 4 |
| **Icing** | In cloud with western disturbances (Dec–Mar snow on the Indian side) and in the monsoon (Jul–Sep, south slopes). The freezing level is ≈5 km in summer and drops to ≈2–3 km in winter storms south of the crest. North of the crest the air is mostly dry, so icing is rare. | General |
| **Visibility and cloud** | South of the crest: monsoon cloud, rain and valley fog (Jul–Sep). North of the crest (rain shadow): usually unlimited, except for dust. Western-disturbance snow and cloud close the passes in winter. Best flying: **October–November**, which is clear, calm-ish, cold and has low DA. | General; CMA |

**Campaign season:** set the campaign in **October**. That gives clear skies and fewer western
disturbances, dawn DA ≈ 14,700 ft at Ngari, afternoon winds as the hazard, and the westerly jet
starting to return, which brings mountain waves.

### 5.2 How to model it in the game

What exists today (`src/core/wind.ts`): one global wind vector, a filtered random gust redrawn every 2 s,
and white jitter scaled by `turbulence`. Every aircraft gets the same vector each tick. There is no
temperature deviation in the atmosphere. What is needed:

| New term | Model | Data needed | Cost |
|---|---|---|---|
| **ISA deviation** | `WeatherConfig.isaDeviationK`, and optionally a daily curve `isaDevAtHour(h)`. The atmosphere becomes T = T_ISA(h) + ΔT, with p from the ISA pressure (hydrostatic offset ignored) and ρ = p/(R·T). | Per mission | Trivial. **Do this first.** It also changes engine thrust and the Tejas's performance. |
| **Wind profile with height** | `U(z) = U_ridge·f(AGL)`, using a log or power law in the lowest 300 m over the DEM ground, then a linear blend to a `windsAloft[]` table (5.5 km, 9 km, 12 km) | Per mission: 2–3 levels | Low |
| **Per-aircraft sampling** | Replace the single `windWorldMpsScratch` with `windAt(pos, tick)` per aircraft. `rec.env.windWorldMps` already exists per aircraft. Bombs and jettisoned stores should sample at their own position too. | | Low |
| **Valley channelling** | Precompute from the DEM (smoothed at 2–5 km) a valley-axis field and a "depth below the surrounding ridge" field. Below ridge level, rotate the wind onto the valley axis and scale it: `U_valley = |U·axis|·k` plus a daily **thermal valley wind**: up-valley `+V_up·s(hour)` (peaks 14–16 h, 5–15 m/s, deeper gorges stronger) and down-valley `−V_down` at night (2–4 m/s). | Baked 2D textures: axis (2 floats), depth (1) | Medium (offline bake) |
| **Mountain-wave field** | Offline bake, per mission wind direction and speed, of linear-theory vertical velocity w(x, z) on a 1 km grid (Smith 1980 FFT solution on the smoothed DEM, N ≈ 0.01–0.012 s⁻¹). It gives lee-wave crests and troughs with λ = 2πU/N. At runtime: `w = W_bake(x, z)·cos(phase(alt))·decay(alt)`, with a horizontal perturbation from continuity. | One 2D field per mission (≈320 × 320 floats, 400 kB) | Medium (offline), cheap at runtime |
| **Lee-side downdrafts** | Where `dot(∇h, Û) < 0` (lee slope) and the aircraft is within ≈2× ridge relief downwind and below ridge top: `w_lee = −c·U_ridge·|∇h·Û|`, with c ≈ 0.5–1. Simple rule; can stand in for the wave bake on low settings. | DEM gradient | Low |
| **Rotor zones** | A rotor mask: lee side, 0.5–1.5 λ downwind of a major ridge, AGL below ridge relief, and U_ridge above ≈12 m/s. Inside it: reversed low-level flow (`−0.3 U`), turbulence intensity 0.6–1.0 and short length scale. | Derived from the wave bake | Low |
| **Spatially coherent turbulence** | Replace the white jitter with frozen 3D simplex noise advected by the mean wind (Taylor hypothesis). σ_u = I·U with intensity `I = I_base + I_rough·roughness(x, z) + I_rotor + I_thermal(hour, slope-sun)`, and length scale L ≈ max(AGL, 50 m) up to ≈500 m (Dryden or von Kármán shape). Two aircraft flying the same spot feel the same bump, which suits formation flying and AI fairness. | `roughness` = std dev of DEM in a 2 km window (baked) | Medium |
| **Thermals** | Afternoon updraft cells of 1–3 m/s on sun-facing slopes (slope·sun direction), with sinking air between them | DEM normals + sun | Low |
| **Visibility and dust** | Afternoon dust haze in the Gar, Purang and Sutlej basins (the render fog colour and density already exist as weather presets) | Per mission | Low |

**Determinism:** everything stays seeded and evaluated in the core worker, as now. The baked fields ship
with the theatre, and the per-mission wave bake can happen at load time (an FFT on 320×320 cells takes
well under 1 s).

**Turbulence intensity guide** (for `I` above):

| Regime | Intensity |
|---|---|
| Light (plateau morning) | 0.05 |
| Moderate (afternoon valley, thermals) | 0.15–0.25 |
| Severe (rotor) | 0.4–0.6 |

---

## 6. Terrain data pipeline

### 6.1 DEM sources

| DEM | Resolution | Licence | Notes for the Himalaya |
|---|---|---|---|
| **Copernicus GLO-30** (recommended) | 1 arc-second (≈30 m). Tiles are 1° × 1°, 3,600 × 3,600 below 50° lat, Cloud-Optimised GeoTIFF float32. | **Free and open for GLO-30 public.** Attribution: "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA". Check the current licence text (the AWS readme links an older one). | Best quality in steep terrain, with few voids. It is a DSM, but above the tree line DSM ≈ DTM. Glacier surfaces date from about 2011–2015. |
| SRTM / NASADEM | 1″ (30 m) | Public domain (NASA) | Voids and spikes on Himalayan steep faces in SRTM v3. NASADEM fills most of them. A good fallback. |
| ALOS AW3D30 (JAXA) | 1″ | Free with attribution (JAXA terms) | Good in steep terrain. Usable as a void filler. |

Access: `s3://copernicus-dem-30m/` (eu-central-1, `--no-sign-request`). Tiles are named
`Copernicus_DSM_COG_10_N32_00_E080_00_DEM`. **Measured tile sizes: 35.6–43.7 MB** (HEAD requests,
2026-11-14).

### 6.2 Data volume for the box (29.40–32.30 N, 79.07–82.42 E)

| Item | Size |
|---|---|
| Source tiles | 4 rows (N29–N32) × 4 columns (E079–E082) = **16 tiles ≈ 0.6 GB** download |
| Box at 30 m | 10,667² ≈ 114 M samples: int16 ≈ **228 MB** raw. Too big to ship to a browser. |
| Box at 60 m | 5,333² ≈ 28 M samples, int16 ≈ 57 MB raw, ≈ 25–35 MB compressed |
| **Box at 90 m (recommended base)** | 3,556² ≈ 12.6 M samples, int16 (1 m step) ≈ **25 MB raw, ≈ 10–14 MB brotli** |
| 30 m detail patches | 20 × 20 km each at Ngari, Burang, Naini Saini, Gunji and Simikot (≈0.9 MB each raw) plus a 6 km-wide strip along the Kali and Humla Karnali corridors (≈6 MB) → ≈ **11 MB raw, ≈ 5 MB compressed** |
| Baked wind fields (section 5.2) | Valley axis and depth, roughness, at 1 km ≈ 1.6 MB |
| **Ship total** | **≈ 15–20 MB** |

### 6.3 How to bake it into the existing terrain system

1. **Offline tool** (`tools/terrain/bakeDem.mjs` or Python):
   - mosaic the 16 tiles;
   - reproject to the game frame (azimuthal-equidistant about 30.85 N 80.745 E, or UTM 44N plus an
     offset), with x east and z south;
   - resample to 90 m with a cubic filter, plus the 30 m patches;
   - fill voids and despike;
   - quantise to int16 metres;
   - cut into **quadtree-aligned tiles** (for example 256 × 256 samples per tile, matching `ChunkKey`
     at a chosen depth), so the terrain worker streams them with the chunks they belong to;
   - store each tile as a raw `.bin` with brotli compression (or 16-bit PNG or Terrarium-encoded WebP)
     plus an index JSON. Attribution goes into the theatre metadata, as the airport JSON already does
     for OSM.
2. **New shape kind** in `contracts/terrain.ts`:
   `{ kind: 'dem', url, sampleSpacingM: 90, patches: [...], detail: { ampM, slopeGain } }`.
   `buildShapedHeight` gets a `buildDem` branch that returns
   `h = bicubic(grid, x, z) + detailAmp·fbmN(x, z)·slopeFactor`. The existing fbm and ridged noise
   (normalised, as in `theatreShapes.ts`) add 5–15 m of sub-cell texture on slopes, scaled down on
   flat valley floors and to zero inside airport flatten zones.
3. **Same height everywhere.** Physics, AI terrain avoidance, radar and line of sight, GCAS and
   placement all call `HeightSampler.heightAt` synchronously in the core worker. The terrain worker
   builds meshes from the same function. Both workers therefore need the grid:
   - 25 MB int16 each, or one `SharedArrayBuffer` (this needs COOP/COEP headers on the host);
   - or load the coarse 90 m grid fully, and fetch 30 m patches on demand, with a fallback to 90 m
     until a patch arrives (the physics ground must match the rendered mesh).
4. **Normals.** `normalAt` uses central differences with ε = 1 m. On a bilinear grid that gives faceted
   normals, so use bicubic sampling, or ε ≈ half the sample spacing on the coarse grid.
5. **Airports.** Keep `flattenZones`, but add **oriented rectangles**: a 2.2 km circle would flatten
   valley walls at Naini Saini and Gunji. Ngari's DEM is already flat (−0.3% along the runway), so a
   small blend is enough.
6. **Water.** Lakes become polygons with their own levels (from OSM `natural=water`, or from DEM
   flat-region detection). Rivers are drawn from OSM polylines rather than `riverMath`'s procedural
   meanders.
7. **LOD and bounds.** Set `heightBoundsM` to {300, 7,900}. The vertical AABB term in
   `distanceToChunk` grows, so check LOD switching distances with a real 7 km relief: ridges must not
   pop at 30 km.
8. **Scenery.** The road network and towns can stay procedural. A short `towns[]` list (Purang,
   Darchula, Dharchula, Gunji, Simikot, Pithoragarh, Zanda) and the real roads (Lipulekh road, G219)
   are anchored by coordinates, as the Punjab and Konkan theatres already do.

**Effort ranking (cheapest first):**

1. ISA deviation;
2. the DEM shape kind with a 90 m grid;
3. oriented flatten zones;
4. lakes;
5. 30 m patches;
6. wind fields.

---

## 7. Threat environment (generic, game level)

Public encyclopedic knowledge only. Site placement is fictional game design, not derived from imagery.
2021 reports say only that "a SAM deployment" exists at Ngari.

| Layer | Generic type (public names) | Game equivalent today | Role at a forward plateau base |
|---|---|---|---|
| Long range | HQ-9 family | `HQ-9` already used at Shahbaz | One battery covering Ngari: forces the Tejas strike low or stand-off (SAAW) |
| Medium range | HQ-16 (export: LY-80) | `LY-80` | Point defence of Ngari and Burang |
| Short range | HQ-17 (Tor-class) / HQ-7 (export: FM-90) | `FM-90` | Close-in cover of the runway and aprons |
| Guns | 35 mm towed or SP (e.g. PGZ-07 class) | 35 mm AAA | Ring the aprons |
| MANPADS | QW / FN-series | MANPADS | Valley ambush along the Purang–Lipulekh road |
| Early warning | Generic surveillance radars on ridges | EW radar | Cues the batteries. A ridge-top radar sees into valleys only where line of sight exists. |
| Fighters | J-11 / J-16 at Ngari (reported) | Use the existing aggressor framework; add J-11/J-16 types | CAP over Mansarovar, intercepting the C-17 route |

**Terrain masking gameplay.** This is the theatre's core loop.

- **Radar line of sight is already terrain-aware** (`src/combat/lineOfSight.ts`, `radarModel.ts` use
  `heightAt`). With 5,000–6,000 m valley walls, a plateau radar at 4,300 m cannot see into the Kali
  or Humla gorges below ≈4,500–5,000 m. Corridors become safe lanes, and passes become exposure gates.
- **Pop-up geometry:** Tejas missions cross a pass (Lipulekh 5,334 m, Mana ≈5,600 m) or a ridge, are
  exposed for N seconds, then drop into the next basin. A per-pass "exposure time" teaches
  ridge-crossing technique: roll inverted and pull, keep the speed up.
- **The C-17 cannot hide on the plateau.** Its Ngari final is a 20 km straight-in across a flat valley,
  so the finale requires the SAM and fighter threat to be suppressed first (missions 4 and 5). That
  gives the arc a reason.
- **Thin air cuts both ways.** SAM kinematics are better at altitude (lower drag), and the player's
  turn radius is larger (higher TAS). Out-turning a missile in a gorge is harder than over Punjab.
- **Engine plumes and cold.** IR contrast is high against cold rock and snow at dawn. Flares matter
  more, and a hot-afternoon ground clutter variant could reduce IR contrast.

---

## 8. Mission arc (6 missions)

Home base for every mission: **Naini Saini (extended, fictional)**, elevation 1,500 m. Season:
October.

| # | Title | Aircraft | Route | Objective | Skill taught | Failure conditions |
|---|---|---|---|---|---|---|
| 1 | **First Lift** | C-17 | Naini Saini → NE over the Kali valley via Dharchula → **Gunji ALG** (fictional, 3,250 m, one-way 1,450 m strip) → back to Naini Saini (89 km each way) | Land at Gunji with 60 troops and a pallet of munitions, offload (timed), take off down-valley, return | Heavy-aircraft handling. Valley approach with a **commit point** and no go-around after it. Effect of density altitude on TAS (≈+20%). One-way strip discipline. | CFIT; stopping beyond the strip end; touching down past the touchdown box; sink > 4 m/s; landing above the strip's weight limit (fuel planning); missing the commit gate and continuing; running out of fuel on the return |
| 2 | **Humla Drop** | C-17 | Naini Saini → E along the Seti/Bajhang valleys → into the **Humla Karnali gorge** → drop run on **Simikot DZ** (2,950 m) → climb out over the 4,000–4,400 m ridges → home (158 km each way) | Airdrop Nepalese Army supplies (CDS) and a para team on the DZ. One pass; a second pass is allowed with a score penalty. | Low-level valley flying in a 50 m wingspan aircraft. Slow flight at drop speed in thin air. Timing the green light. **Climb planning out of a gorge** (rate of climb falls with δ). | Drop CEP beyond 300 m (fail beyond 800 m); stall; terrain warning held > 5 s; ridge strike on the climb-out; entering the Purang SAM zone (Hilsa side) above ridge height |
| 3 | **Lipulekh Watch** | Tejas | Naini Saini → Kali valley low → **pop-up over Lipulekh (5,334 m)** → Purang basin → home | Destroy a PLA column on the road from Purang toward the pass (trucks, light armour). The Burang airport SAM (LY-80-type) is active. | **Terrain masking**, ridge crossing, pop-up attack, egress through the gorge. TAS turn radius at altitude. | Shot down; road column more than 50% intact when it reaches the pass; crossing into Nepal's Humla airspace too high (diplomatic fail, story flavour) |
| 4 | **Kailash Sweep** | Tejas | Naini Saini → Gunji → Lipulekh → north past Gurla Mandhata → **Mansarovar/Rakshastal** CAP box → home | Shoot down a J-11/J-16 pair on CAP over the lakes and cover a (scripted) second C-17 lift into Gunji | Air combat over a plateau. Energy management in thin air. Radar look-down against snow and lakes. Hiding the escorted aircraft behind terrain. | Escorted C-17 shot down; player shot down; bingo fuel not respected (no diversion airfield) |
| 5 | **Lights Out** | Tejas (×2 player flights, or one with an AI wingman) | Naini Saini → **Sutlej / Zanda canyon** low level NW → IP in the Gar valley SE of Ngari → attack → egress SE | **Disable Ngari Gunsa**: cut the runway at 2–3 points (SAAW glide bombs from stand-off, or low-level HSLD), destroy the SAM radar and fuel. **Leave the parallel taxiway intact** in segment B: story-scripted craters at the junctions define the finale's usable length. | Long low-level navigation through canyons, **mountain-wave and rotor turbulence** over the Gar valley SW wall, stand-off weapon release, precision on a defended target | Shot down; runway not closed (fighters launch: a mission fail that branches to a retry); **hitting the parallel taxiway in segment B** (finale impossible: mission fail with "taxiway cratered") |
| 6 | **Taxiway** (finale) | C-17 | Naini Saini → over Lipulekh at height (SAMs suppressed) → Purang basin → **Sutlej valley NW** → descend into the Gar valley from the SE → **straight-in 20 km final on the parallel taxiway, landing 332°** | Land on the **1,200 m usable segment** (Normal), stop, lower the ramp, deploy troops. The story ends with the troops running onto the civil apron. | Everything: weight planning (340,000 lb max), dawn timing (DA 14,700 ft), **assault approach** (3.5° glide, no flare, touchdown box), **max braking + reverse + spoilers**, a **narrow-surface touchdown** (6 m gear margin), crosswind decrab | Section 4.5: overrun past the barricade; gear off the pavement above 30 kt; sink > 4 m/s; wingtip strike; brake fire; touchdown beyond the box (or a go-around: allowed once, fuel permitting); shot down by a surviving SAM if mission 5 scored badly |

**Arc logic and teaching curve:**

| Mission | What it adds |
|---|---|
| 1 | Short field at 3,250 m |
| 2 | Narrow valleys and slow flight without landing |
| 3 | Fighter masking |
| 4 | Plateau air combat |
| 5 | Shapes the finale: how cleanly the runway and SAMs were hit sets the finale's threat level and the crater positions |
| 6 | Combines everything from mission 1 at 4,274 m with a 30% higher TAS |

---

## 9. Biggest unknowns

| Unknown | Why it matters | How to resolve |
|---|---|---|
| Ngari parallel taxiway **width** (no OSM tag) | The gear margin is 6 m at 23 m wide but only 4 m at 18 m | Measure on imagery (Bing/Esri, which the OSM ways were traced from) |
| C-17 **max landing weight**, charted assault-landing ground roll vs weight, and reverse-thrust fraction | The finale numbers rest on a model calibrated to one published point (3,000 ft at 160,000 lb payload) | Tune the game's C-17 flight model to reproduce the 3,000 ft point and the 3,500 ft minimum, then re-run section 4 |
| Approach speed (115 vs 130 kt in sources) | A ±15% change in speed gives ±30% in roll | Keep the calibrated (130 kt) column |
| Burang runway length (4,500 m Wikipedia vs 4,945 m OSM) and width | Layout accuracy only | Imagery |
| Thoise runway length; Bareilly C-17 suitability | Off-map, so only flavour | |
| Copernicus GLO-30 current licence wording | Attribution text in the game | Read the current licence PDF before shipping |
| Real 3D wind behaviour at Ngari (no public station wind climatology found) | The wave and rotor tuning is generic | Use typical mountain-meteorology values and tune for gameplay |

---

## Sources

- [Ngari Gunsa Airport, Wikipedia](https://en.wikipedia.org/wiki/Ngari_Gunsa_Airport): coordinates, elevation, runway 15/33 4,500 m, J-11/J-16
- [Ngari Burang Airport, Wikipedia](https://en.wikipedia.org/wiki/Ngari_Burang_Airport): coordinates, 4,250 m, opened 27 Dec 2023
- OpenStreetMap ways for both airports (© OpenStreetMap contributors, ODbL), via `api.openstreetmap.org/api/0.6/map`, 2026-11-14
- [TWZ: Tracking China's sudden airpower expansion along its western border](https://www.twz.com/41065/tracking-chinas-sudden-airpower-expansion-along-its-western-border): ≥12 shelters, SAM deployment, support areas
- [Swarajya: satellite imagery of Ngari Gunsa](https://swarajyamag.com/defence/new-satellite-imagery-shows-china-has-deployed-uavs-fighter-jets-at-ngari-gunsa-airbase-close-to-lac); [GreatGameIndia summary](https://greatgameindia.com/satellite-images-show-expanding-chinese-airbase-near-ladakh/): secondary taxi-track (2020)
- [Boeing C-17 Globemaster III, Wikipedia](https://en.wikipedia.org/wiki/Boeing_C-17_Globemaster_III): MTOW, payload, thrust, 3,500 × 90 ft, IAF No. 81 Sqn at Leh and Thoise
- [Boeing Canada C-17 page](https://boeing.ca/products-and-services/defense-space-security/c-17-globemaster-iii): landing field length 3,000 ft with 160,000 lb
- [Virginia Tech C-17 slides (Mason)](https://archive.aoe.vt.edu/mason/Mason_f/C-17Spr09.pdf): 3,000 ft LFL incl. TRs, 115 kt approach, OEW
- [aerocorner C-17](https://aerocorner.com/aircraft/c-17-globemaster/): 115 kt approach, empty weight, wing area
- [migflug: C-17 semi-prepared operations](https://migflug.com/afterburner/c-17-globemaster-dirt-runway-semi-prepared-operations/): ≈130 kt approach, 4,500 ft concrete vs 6,200 ft dirt
- [C-17 Wikipedia fandom mirror (GAO 1997 note)](https://military-history.fandom.com/wiki/C-17A_Globemaster_III)
- [C-17 gear dimensions (blog, low authority)](https://aircraftshow.blogspot.com/2009/04/c-17-globemaster-iii.html): 33.7 ft main gear width
- [Kushok Bakula Rimpochee Airport (Leh), Wikipedia](https://en.wikipedia.org/wiki/Kushok_Bakula_Rimpochee_Airport): 3,256 m, 2,754 m runway, afternoon winds
- [Mudh-Nyoma AFS, Wikipedia](https://en.wikipedia.org/wiki/Mudh-Nyoma_Air_Force_Station); [Tribune: IAF chief inaugurates Nyoma](https://www.tribuneindia.com/news/india/iaf-chief-inaugurates-mudh-nyoma-airbase-near-lac-in-ladakh); [Airpower Asia, Jan 2026](https://airpowerasia.com/2026/01/14/nyoma-airfield-in-ladakh-operational-status-and-strategic-significance/)
- [Thoise AFS (Wikiwand)](https://www.wikiwand.com/en/Thoise_Air_Force_Station): ≈3,070 m
- [Pithoragarh Airport, Wikipedia](https://en.wikipedia.org/wiki/Pithoragarh_Airport): 14/32, 1,600 × 30 m, C-130J, expansion
- [Chinyalisaur Airport, Wikipedia](https://en.wikipedia.org/wiki/Chinyalisaur_Airport): 909 m, 1,001 m, aka Dharasu
- [List of airports in Nepal, Wikipedia](https://en.wikipedia.org/wiki/List_of_airports_in_Nepal); [Simikot Airport, Wikipedia](https://en.wikipedia.org/wiki/Simikot_Airport)
- [Shiquanhe, Wikipedia (CMA 1991–2020 climate table)](https://en.wikipedia.org/wiki/Shiquanhe)
- Egger et al. (2000), *Diurnal winds in the Himalayan Kali Gandaki Valley. Part I*, MWR 128: [index](https://scilit.com/publications/b305b1a4379e46c8e365266c9810bd9a); Zängl et al. (2001) Part II, MWR 129; [NJPS secondary (15–20 m/s)](https://nepjol.info/index.php/JNPhysSoc/article/view/17337/14102)
- [Penn State METEO 3: The subtropical jet stream](https://courses.ems.psu.edu/meteo3/node/2160); [Frontiers 2025 Tibetan Plateau CAT case](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2025.1529934/full); [turbli: most turbulent regions (low authority)](https://turbli.com/blog/the-most-turbulent-regions-in-the-world/)
- [Copernicus DEM on AWS Open Data](https://registry.opendata.aws/copernicus-dem/); [bucket readme](https://copernicus-dem-30m.s3.amazonaws.com/readme.html); [licence PDF](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf); [Sentinel Hub forum on the licence update](https://forum.sentinel-hub.com/t/copernicus-dem-license-update-on-aws/3815); [ESA: GLO-30 freely available](https://sentinels.copernicus.eu/-/copernicus-dem-30-metre-dataset-now-freely-available)
- DEM point and profile samples: [OpenTopoData](https://www.opentopodata.org/) SRTM 90 m public API, 2026-11-14
- Peak and lake elevations: the Wikipedia articles for each feature (Mount Kailash, Gurla Mandhata, Api, Saipal, Nanda Devi, Kamet, Panchachuli, Lake Manasarovar, Rakshastal, Lipulekh Pass, Mana Pass, Niti Pass)
