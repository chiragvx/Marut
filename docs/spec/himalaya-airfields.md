# Himalaya theatre: three airfields to build (Ngari Gunsa, Simikot, Fukche)

Status: research only. No code has been changed. This document sits next to `himalaya-theatre.md`
(read its sections 0, 2 and 3 first) and goes deeper on three airfields for the C-17 and Tejas campaign.

**Positions are allowed to move.** We can shift an airfield a little so it fits the compressed map. So
this document cares most about each field's **character**: runway size, surface and slope, elevation,
the shape of the layout (taxiways, aprons, shelters, buildings) and the terrain around it. Exact
coordinates are given where they came free with the data. They are a starting point, not a constraint.

**Tags used on every value**

| Tag | Meaning |
|---|---|
| **[S]** | Sourced: a published figure, with a link in that airfield's source list |
| **[M]** | Measured by me: from OpenStreetMap (OSM) geometry, an SRTM elevation sample, or a visual measurement on Esri World Imagery tiles (about 1 m per pixel at Ngari, 0.5 m at Simikot, 2 m at Fukche) |
| **[E]** | Estimated or invented for the game: a judgement, a generic value, or game design |

**How the JSON blocks work.** `bhisiana-afs.json` stores **absolute world coordinates**. Every point
is `worldX` (east) and `worldZ` (south) in metres, and `referenceWorldX/Z` holds the base's world
position. Headings are compass radians (0 = north, π/2 = east, clockwise; `docs/spec/00-architecture.md`
§3.1). The blocks below use the same schema with **`referenceWorldX = referenceWorldZ = 0`**. Every
point is therefore metres from the airfield's reference point (the runway midpoint), x east, z south,
true north up, at real size. To place one in the world, add `geo(lat, lon)` of the pad (terrain-lab
`layout.ts`) to every `worldX/worldZ`, `thresholdWorldX/Z` and `centerWorldX/Z`, and set
`referenceWorldX/Z` to that offset. Do not rotate or compress anything. All three blocks pass the
repo's own `loadAirportLayout` (`src/airport/validator.ts`, run on 2026-11-14) with **no errors and no
warnings**.

**Two limits of the current format.** Both affect these fields; section 4 has the detail.
1. A runway is flat. The validator requires each threshold's `elevationM` to match its flatten zone
   within 1 m, so it cannot express Simikot's slope of about 4%.
2. `surface` is only `asphalt | concrete`. Fukche is gravel.

---

## 1. Ngari Gunsa (ZUAL / NGQ), Tibet: the hostile base and the finale

### 1.1 Character in one paragraph

Ngari Gunsa is a **4.5 km concrete runway on a dead-flat, 11 km wide valley floor at 4,274 m**, with
a **full-length straight parallel taxiway 168 m to the NE**. All the development sits on the NE side
of the runway:
- the small civil terminal with 4 stands at mid-field;
- a long military apron at the NW end, with a row of 12 shelters and 4 more set at an angle;
- a walled compound of 6 bermed hardened shelters behind it;
- maintenance hangars and a dense cantonment.

The SW side is empty, apart from a large graded area beyond the NW end. The ground is grey-brown
gravel steppe with braided river channels. The walls rise 1,300–1,800 m within 6–16 km on both sides
(theatre spec §3.4). It looks like a big, open, exposed airfield in a moonscape.

### 1.2 Runway

| Item | Value | Tag |
|---|---|---|
| Designation | 15/33 | [S] OSM `ref`, Wikipedia |
| Threshold 33 (SE end) | 32.08200 N, 80.06422 E. SRTM 4,274 m | [M] OSM node 1669201757 |
| Threshold 15 (NW end) | 32.11785 N, 80.04195 E. SRTM 4,260 m | [M] OSM node 1669202275 |
| Runway midpoint (reference point used below) | 32.09993 N, 80.05309 E | [M] |
| True heading | 332.1° (33) / 152.1° (15) | [M] |
| Length | 4,486 m between threshold nodes; 4,500 m published | [M] / [S] Wikipedia, OSM `length=4500` |
| Width | 45 m (OSM `width`). **Paved width ≈ 60 m** including shoulders of about 7.5 m that look like the main surface on imagery. | [S] OSM / [M] imagery cross-section |
| Surface | Concrete (rigid panels visible on imagery); OSM says "paved" | [M] |
| Elevation | 4,274 m (14,022 ft) aerodrome; SRTM slope ≈ 14 m down to the NW (−0.3%) | [S] Wikipedia / [M] |
| Markings seen on imagery (15 end) | Piano-key threshold bars, the designator "15", white edge lines, a turning pad at the end, and a ≈60 × 60 m **blast pad with yellow chevrons** beyond the threshold | [M] imagery |
| Lighting | PAPI mapped at both ends (OSM nodes 2237733777, 2237733786, ≈315–330 m in from each threshold and ≈50 m off the centreline; both on the landing pilot's left). Edge and threshold lights assumed. **No published ILS or approach lighting system** (aggregators disagree, and the CAAC AIP is not free to access). | [M] OSM / [E] |

### 1.3 Taxiways

There are 8 OSM ways and no width tags. **Measured paved width of the parallel taxiway: 38–42 m**
(Esri imagery cross-sections at 6 points, ~1 m/px, threshold at the 75th brightness percentile). I read
that as a **23 m taxiway plus 7.5 m shoulders**: ICAO code E, which is the same total as the runway
shoulders. [M] width, [E] interpretation.

**This matters for the finale.** The pavement a C-17 can roll on may be about 38 m wide, not 23 m. The
theatre spec §3.3 margin of 6.4 m each side assumed 23 m. With 38 m of usable concrete the margin is
≈14 m each side. Recommendation: draw 23 m taxiway markings and edge lights, but set the "gear off
pavement" fail line at the **38 m paved edge**. The edge lights inside the wing sweep stay the hazard.

All taxiways are on the NE side. Points are lat/lon, simplified to within 1.5 m of the OSM line. "Along"
is metres from threshold 33 toward 15; "cross" is metres NE of the centreline.

| Id | Points (lat, lon) | Along / cross | Length | Width | Notes |
|---|---|---|---|---|---|
| TWY-PARALLEL | 32.11839,80.04365 → 32.08319,80.06549 → 32.08295,80.06549 → 32.08275,80.06536 → 32.08234,80.06450 → 32.08233,80.06440 → 32.08234,80.06424 → 32.08241,80.06403 → 32.08248,80.06392 | 4,464/169 → 60/168 → curve onto the runway at 60/0 | 4,607 m | 23 [E] (38–42 paved [M]) | Dead straight 4.4 km. Joins the runway at the 33 end. |
| TWY-RET-S (angled link) | 32.09277,80.05753 → 32.09234,80.05796 → 32.09214,80.05822 → 32.09093,80.06009 → 32.09075,80.06043 → 32.09055,80.06074 → 32.09027,80.06109 | runway 1,348 → parallel 946 | 437 m | 23 [E] | Rapid-exit geometry for landings on 15 |
| TWY-RET-N (angled link) | 32.10733,80.04848 → 32.10833,80.04834 → 32.10989,80.04831 → 32.11065,80.04827 → 32.11102,80.04818 → 32.11127,80.04807 | runway 3,170 → parallel 3,573 | 439 m | 23 [E] | Rapid exit for landings on 33 |
| TWY-CIVIL | 32.10303,80.05115 → 32.10284,80.05131 → 32.10277,80.05142 → 32.10272,80.05168 → 32.10277,80.05191 → 32.10409,80.05483 | runway 2,632 → apron 2,573/361 | 399 m | 23 [E] | Crosses the parallel at right angles. Plus a 69 m fillet (OSM 837808383). |
| TWY-HOLD-S | 32.09116,80.05973 → 32.09125,80.06013 → 32.09162,80.06026 | parallel 1,115 → 1,093/100 | 84 m | 23 [E] | Dead-end stub ending 100 m from the centreline: a holding bay or an arming/ORP pad |
| TWY-HOLD-N | 32.10960,80.04909 → 32.10975,80.04882 → 32.10975,80.04856 → 32.10943,80.04831 | parallel 3,365 → 3,383/95 | 100 m | 23 [E] | Same, at the other end |
| TWY-N-END | 32.11735,80.04226 → 32.11780,80.04237 → 32.11822,80.04330 → 32.11822,80.04355 → 32.11809,80.04384 | runway 4,423 → parallel 4,426/169 | 208 m | 23 [E] | End link at threshold 15 |

The C-17 finale segments (A–D) from theatre spec §3.2 still hold. Segment B (along 1,115 → 2,573, ≈1,460 m)
runs between TWY-HOLD-S and TWY-CIVIL.

### 1.4 Aprons and parking

| Id | Polygon (lat, lon) | Size | Tag |
|---|---|---|---|
| APRON-CIVIL | 32.10316,80.05660; 32.10301,80.05626; 32.10224,80.05454; 32.10472,80.05301; 32.10546,80.05469; 32.10631,80.05417; 32.10647,80.05453 | ≈310 × 180 m plus a 105 × 38 m nib, 71,500 m², concrete | [M] OSM 154378705 |
| Civil stands 1–4 + one unnumbered | Taxi-in loops, mapped as `parking_position` lines. Centres along 2,450–2,690, cross 260–400. | 4 narrow-body stands (A319 class) | [M] OSM / [E] class |
| APRON-NORTH-MIL | 32.11908,80.04520; 32.11613,80.04703; 32.11460,80.04794; 32.11469,80.04821; 32.11136,80.05029; 32.11065,80.04878; 32.11040,80.04810; 32.11086,80.04801; 32.11125,80.04783; 32.11790,80.04373; 32.11798,80.04335; 32.11837,80.04312; 32.11875,80.04289; 32.11927,80.04305; 32.12035,80.04385; 32.11957,80.04535; 32.11914,80.04504; 32.11904,80.04505 | ≈1,170 × 210 m (along 3,481–4,647, cross 123–373), 222,600 m² | [M] OSM 1157053351 |
| Graded area SW and NW of the 15 end | Fenced, unpaved-looking grey surface. Edge markers on its runway side. About 0.5 × 0.9 km, centred near 32.120 N 80.040 E. | Purpose unknown: possibly ground prepared during the 2020– expansion | [M] imagery, ±50 m / [E] |

### 1.5 Military side: shelters, hangars, munitions, fuel, SAM

**What public reporting says**
- 2020: large-scale earthwork beside the runway from April 2020, described as a "second taxi-track or a
  secondary tarmac". That is the parallel taxiway now in OSM. [S] Swarajya, NDTV via Swarajya.
- Feb 2021 imagery (OSINT analyst @detresfa_): **at least 12 hardened shelters under construction**.
  [S] Swarajya. TWZ (Planet Labs imagery, 2021) said the same, and added "an active deployment of
  surface-to-air missiles within the air base", "munitions storage facilities", "a dedicated air
  maintenance and support area" and "new hangars". TWZ said no new runways. [S]
- Oct 2021: two UAVs (probably CH-4) and fighters, with a J-11/J-16 detachment since Dec 2019. [S]
  Swarajya.
- 2023: Hindustan Times (Planet Labs comparison) reported "new runways, hardened shelters" at
  western-border bases including Ngari. The "new runways" claim is not visible in OSM or in the imagery
  I checked. [S, unconfirmed]
- **No public source gives SAM site positions, counts or types for Ngari.** Indian outlets list Ngari
  among Tibetan airports with "permanent SAM emplacements" for HQ-9 / HQ-22 / HQ-17, without
  coordinates. [S, low specificity] The separate SAM site at Mansarovar (ThePrint, Aug 2020) is a
  different place, about 160 km SE.

**What OSM and imagery show** (measured; my interpretation of what each thing is)

| Feature | Where (lat, lon; along/cross) | Count and size | Tag |
|---|---|---|---|
| **Apron shelter row** | 12 in a continuous row along the NE side of the north apron, 32.11636,80.04585 → 32.11850,80.04455 (along 4,168–4,435, cross 248). Centres 22–26 m apart. | 12 × ≈22–30 m wide × 36–38 m deep (OSM outlines overlap; the JSON caps them at 22 m wide). Height ≈9 m [E]. **These match the "at least 12 shelters" of 2021.** On imagery they read as arched, enclosed shelters with their openings toward the apron (SW) and fighters parked in front. | [M] OSM ways 1156184657–1156184672 / [E] height and door side |
| **Angled shelters** | 4 at the NW corner of the apron, 32.11930,80.04452 → 32.11963,80.04385 (along 4,514–4,577), turned about 30° | 4 × ≈22–30 × 35–37 m | [M] OSM 1156184674–77 |
| **HAS compound** | Walled rectangle NE of the apron, along 3,680–4,270, cross 436–571 (corners ≈ 32.11794,80.04713 / 32.11853,80.04836 / 32.11380,80.05131 / 32.11335,80.05008). Entry from the apron at its NW end. | **6 large arched hardened shelters in earth-bermed bays**, centres 32.11794,80.04799; 32.11747,80.04825; 32.11598,80.04911; 32.11558,80.04941; 32.11458,80.05005; 32.11412,80.05035 (cross ≈505). Shelter ≈26 × 36 m, bay ≈40 × 75 m, height ≈11 m [E]. Small bermed blocks between pairs: probably ready-use stores. Only 2 of the 6 are in OSM (as 35 × 77 m outlines). | [M] imagery ±10 m / [E] |
| Maintenance hangars | 4 light-roofed sheds in two pairs between the apron and the HAS compound, cross ≈380, along 3,995–4,303 | 4 × ≈25 × 51–66 m, height ≈12 m [E] | [M] OSM 1156182759/60, 1156184655/56 |
| Civil terminal | 32.10460 N 80.05603 E, at the back of the civil apron | 49 × 97 m footprint; height ≈14 m [E] (single-storey Tibetan-style hall) | [M] OSM 154378624 |
| Control tower | Not mapped. Placed generically beside the terminal. | 9 × 9 × 28 m | [E] |
| Cantonment and support | ≈580 mapped buildings on the NE side between cross 250 and 850 (fenced to cross 840), and two clusters 1–2 km SE of threshold 33 (long sheds 110–130 m: probably vehicle parks or stores) | Typically 10 × 15 to 35 × 95 m; 1–3 storeys [E] | [M] OSM (no `height` or `building:levels` tags anywhere) |
| Probable **fuel farm** | Walled double compound ≈3.8 km W of the runway, 32.1100 N 80.0140 E, on the road north-west | ≈390 × 300 m: 2 large circular earth-covered tank mounds (≈45 m across), pump and admin buildings, a fenced helipad-like square | [M] imagery / [E] identification |
| Munitions storage | TWZ (2021) reports it, but no location is identifiable on the imagery I had. The JSON places 4 generic igloos NE of the fence (along 3,000–3,270, cross 1,000). | — | [S] existence / [E] position |
| SAM sites | **No public location.** Game design, fictional: an HQ-9 battery on open ground ≈6 km SW across the valley (good field of view, but the SW wall masks the low-level approach from the Indian side); HQ-22/LY-80 ≈3 km NE beyond the cantonment; HQ-17/FM-90 and 35 mm guns ringing the north apron. That matches theatre spec §7. | — | [E] |

### 1.6 Terrain and approaches (summary of theatre spec §3.4)

- Flat valley floor 4,240–4,300 m, about 11 km wide (−7 to +4 km across the runway).
- Walls reach 5,600–6,076 m within 10–16 km on both sides.
- **From the SE (landing 33):** gentle rise of +100 m 20 km out. This is the planned finale approach.
- **From the NW (landing 15):** flat for 28 km, then rising to 4,950 m at 38 km.
- A west or south-west wind puts the field in the lee of the 6,000 m SW ridge: mountain waves and rotor.

**terrain-lab note.** `layout.ts` places the `ngari` pad at 32.1086 N 80.0528 E. That is the Wikipedia
aerodrome reference point, **≈0.97 km NNW of the runway midpoint**. Use 32.0999 N 80.0531 E so that
the OSM layout lines up. The pad also has to cover the NE development out to cross ≈+850 m. Today it
covers only the runway and the parallel taxiway.

### 1.7 Ready-to-use layout (`ngari-gunsa.json`)

Reference point: runway midpoint 32.09993 N 80.05309 E, 4,274 m. Contents:
- 2 runway ends;
- 9 taxiways (8 from OSM plus the HAS compound lane [E]);
- 8 paved areas (2 aprons from OSM, 6 HAS pads [E]);
- 26 parking spots (4 civil stands, 16 apron-shelter spots, 6 HAS spots);
- 39 structures: 16 apron shelters, 6 HAS, 4 hangars, terminal, tower, the 7 largest buildings
  inside the fence, and 4 generic magazines;
- 5 flatten discs along the runway, offset 250 m to the NE.

Heights and door directions are [E]. `side` is `hostile`.

```json
{
 "id": "ngari-gunsa",
 "name": "Ngari Gunsa (Ali Kunsha) Airport, PLAAF",
 "side": "hostile",
 "attribution": "Base layout from OpenStreetMap data, (c) OpenStreetMap contributors (ODbL); shelter compound, door directions, tower and magazines are interpretation or generic.",
 "referenceWorldX": 0,
 "referenceWorldZ": 0,
 "elevationM": 4274,
 "flattenZones": [
  {"centerWorldX": 1271.0, "centerWorldZ": 1865.0, "elevationM": 4274, "flatRadiusM": 900, "blendRadiusM": 700},
  {"centerWorldX": 732.6, "centerWorldZ": 848.8, "elevationM": 4274, "flatRadiusM": 900, "blendRadiusM": 700},
  {"centerWorldX": 194.2, "centerWorldZ": -167.4, "elevationM": 4274, "flatRadiusM": 900, "blendRadiusM": 700},
  {"centerWorldX": -344.1, "centerWorldZ": -1183.6, "elevationM": 4274, "flatRadiusM": 900, "blendRadiusM": 700},
  {"centerWorldX": -882.5, "centerWorldZ": -2199.8, "elevationM": 4274, "flatRadiusM": 900, "blendRadiusM": 700}
 ],
 "runways": [
  {"id": "33", "thresholdWorldX": 1050.0, "thresholdWorldZ": 1982.0, "elevationM": 4274, "headingRad": 5.795997, "lengthM": 4486.0, "widthM": 45.0, "surface": "concrete", "reciprocalId": "15", "lights": {"edgeLights": true, "thresholdLights": true, "approachLights": false, "papi": true}},
  {"id": "15", "thresholdWorldX": -1050.0, "thresholdWorldZ": -1982.0, "elevationM": 4274, "headingRad": 2.654404, "lengthM": 4486.0, "widthM": 45.0, "surface": "concrete", "reciprocalId": "33", "lights": {"edgeLights": true, "thresholdLights": true, "approachLights": false, "papi": true}}
 ],
 "taxiways": [
  {"id": "TWY-PARALLEL", "widthM": 23, "points": [{"worldX": -890.0, "worldZ": -2041.5}, {"worldX": 1170.0, "worldZ": 1850.4}, {"worldX": 1169.8, "worldZ": 1876.5}, {"worldX": 1157.1, "worldZ": 1898.9}, {"worldX": 1076.2, "worldZ": 1943.9}, {"worldX": 1066.8, "worldZ": 1945.9}, {"worldX": 1052.4, "worldZ": 1943.9}, {"worldX": 1031.9, "worldZ": 1936.3}, {"worldX": 1021.5, "worldZ": 1928.8}]},
  {"id": "TWY-RET-S", "widthM": 23, "points": [{"worldX": 418.8, "worldZ": 791.0}, {"worldX": 460.0, "worldZ": 839.2}, {"worldX": 484.3, "worldZ": 861.2}, {"worldX": 660.2, "worldZ": 994.4}, {"worldX": 692.5, "worldZ": 1014.6}, {"worldX": 721.9, "worldZ": 1037.0}, {"worldX": 755.2, "worldZ": 1067.2}]},
  {"id": "TWY-RET-N", "widthM": 23, "points": [{"worldX": -434.0, "worldZ": -818.8}, {"worldX": -447.8, "worldZ": -928.8}, {"worldX": -450.7, "worldZ": -1102.2}, {"worldX": -454.3, "worldZ": -1185.9}, {"worldX": -462.7, "worldZ": -1227.2}, {"worldX": -473.3, "worldZ": -1254.2}]},
  {"id": "TWY-CIVIL", "widthM": 23, "points": [{"worldX": -182.2, "worldZ": -343.5}, {"worldX": -167.4, "worldZ": -322.4}, {"worldX": -157.0, "worldZ": -314.6}, {"worldX": -132.2, "worldZ": -309.2}, {"worldX": -110.9, "worldZ": -314.1}, {"worldX": 164.6, "worldZ": -461.0}]},
  {"id": "TWY-CIVIL-FILLET", "widthM": 23, "points": [{"worldX": -110.9, "worldZ": -314.1}, {"worldX": -121.4, "worldZ": -305.0}, {"worldX": -133.5, "worldZ": -286.4}, {"worldX": -136.1, "worldZ": -269.7}, {"worldX": -134.5, "worldZ": -253.6}]},
  {"id": "TWY-HOLD-S", "widthM": 23, "points": [{"worldX": 626.7, "worldZ": 968.9}, {"worldX": 638.5, "worldZ": 969.7}, {"worldX": 664.1, "worldZ": 959.0}, {"worldX": 671.3, "worldZ": 951.5}, {"worldX": 674.6, "worldZ": 943.1}, {"worldX": 677.0, "worldZ": 933.6}, {"worldX": 676.2, "worldZ": 918.2}]},
  {"id": "TWY-HOLD-N", "widthM": 23, "points": [{"worldX": -450.0, "worldZ": -1051.3}, {"worldX": -447.0, "worldZ": -1063.9}, {"worldX": -440.7, "worldZ": -1075.4}, {"worldX": -426.3, "worldZ": -1086.0}, {"worldX": -401.7, "worldZ": -1086.7}, {"worldX": -385.3, "worldZ": -1080.2}, {"worldX": -376.7, "worldZ": -1070.3}]},
  {"id": "TWY-N-END", "widthM": 23, "points": [{"worldX": -1020.8, "worldZ": -1926.4}, {"worldX": -1022.2, "worldZ": -1955.1}, {"worldX": -1018.7, "worldZ": -1964.7}, {"worldX": -1010.1, "worldZ": -1976.7}, {"worldX": -999.4, "worldZ": -1984.3}, {"worldX": -922.5, "worldZ": -2023.5}, {"worldX": -898.8, "worldZ": -2023.2}, {"worldX": -888.1, "worldZ": -2019.2}, {"worldX": -872.3, "worldZ": -2008.1}]},
  {"id": "TWY-HAS-LANE", "widthM": 15, "points": [{"worldX": -280.0, "worldZ": -1500.5}, {"worldX": -537.5, "worldZ": -1986.5}, {"worldX": -634.2, "worldZ": -1991.8}]}
 ],
 "aprons": [
  {"id": "APRON-CIVIL", "kind": "apron", "points": [{"worldX": 331.1, "worldZ": -358.1}, {"worldX": 299.4, "worldZ": -341.3}, {"worldX": 137.2, "worldZ": -255.8}, {"worldX": -7.1, "worldZ": -529.7}, {"worldX": 151.8, "worldZ": -612.4}, {"worldX": 102.3, "worldZ": -706.0}, {"worldX": 136.0, "worldZ": -723.3}]},
  {"id": "APRON-NORTH-MIL", "kind": "apron", "points": [{"worldX": -743.8, "worldZ": -2117.8}, {"worldX": -571.3, "worldZ": -1792.0}, {"worldX": -485.2, "worldZ": -1622.7}, {"worldX": -460.0, "worldZ": -1632.6}, {"worldX": -263.8, "worldZ": -1264.2}, {"worldX": -406.0, "worldZ": -1186.0}, {"worldX": -470.5, "worldZ": -1158.4}, {"worldX": -478.4, "worldZ": -1209.5}, {"worldX": -495.2, "worldZ": -1252.2}, {"worldX": -882.4, "worldZ": -1987.9}, {"worldX": -918.2, "worldZ": -1996.5}, {"worldX": -939.9, "worldZ": -2040.0}, {"worldX": -961.8, "worldZ": -2081.5}, {"worldX": -945.9, "worldZ": -2138.8}, {"worldX": -871.2, "worldZ": -2258.7}, {"worldX": -729.5, "worldZ": -2172.3}, {"worldX": -759.0, "worldZ": -2124.9}, {"worldX": -757.4, "worldZ": -2113.9}]},
  {"id": "HAS-PAD-1", "kind": "shelter_pad", "points": [{"worldX": -455.2, "worldZ": -1987.1}, {"worldX": -470.2, "worldZ": -2015.4}, {"worldX": -527.6, "worldZ": -1984.9}, {"worldX": -512.6, "worldZ": -1956.7}]},
  {"id": "HAS-PAD-2", "kind": "shelter_pad", "points": [{"worldX": -430.7, "worldZ": -1934.4}, {"worldX": -445.7, "worldZ": -1962.7}, {"worldX": -503.1, "worldZ": -1932.3}, {"worldX": -488.1, "worldZ": -1904.0}]},
  {"id": "HAS-PAD-3", "kind": "shelter_pad", "points": [{"worldX": -349.9, "worldZ": -1771.3}, {"worldX": -364.9, "worldZ": -1799.5}, {"worldX": -422.3, "worldZ": -1769.1}, {"worldX": -407.4, "worldZ": -1740.8}]},
  {"id": "HAS-PAD-4", "kind": "shelter_pad", "points": [{"worldX": -321.1, "worldZ": -1725.4}, {"worldX": -336.1, "worldZ": -1753.7}, {"worldX": -393.5, "worldZ": -1723.3}, {"worldX": -378.5, "worldZ": -1695.0}]},
  {"id": "HAS-PAD-5", "kind": "shelter_pad", "points": [{"worldX": -261.7, "worldZ": -1615.4}, {"worldX": -276.7, "worldZ": -1643.7}, {"worldX": -334.1, "worldZ": -1613.3}, {"worldX": -319.1, "worldZ": -1585.0}]},
  {"id": "HAS-PAD-6", "kind": "shelter_pad", "points": [{"worldX": -232.8, "worldZ": -1565.1}, {"worldX": -247.8, "worldZ": -1593.4}, {"worldX": -305.2, "worldZ": -1563.0}, {"worldX": -290.2, "worldZ": -1534.7}]}
 ],
 "parkingSpots": [
  {"id": "STAND-1", "worldX": 94.8, "worldZ": -524.5, "headingRad": 4.2252, "type": "transport"},
  {"id": "STAND-2", "worldX": 157.6, "worldZ": -498.0, "headingRad": 4.2252, "type": "transport"},
  {"id": "STAND-3", "worldX": 143.8, "worldZ": -413.4, "headingRad": 4.2252, "type": "transport"},
  {"id": "STAND-4", "worldX": 177.1, "worldZ": -359.1, "headingRad": 4.2252, "type": "transport"},
  {"id": "AS-1", "worldX": -682.3, "worldZ": -1817.2, "headingRad": 4.2214, "type": "fighter"},
  {"id": "AS-2", "worldX": -695.3, "worldZ": -1841.7, "headingRad": 4.2711, "type": "fighter"},
  {"id": "AS-3", "worldX": -706.9, "worldZ": -1863.7, "headingRad": 4.2826, "type": "fighter"},
  {"id": "AS-4", "worldX": -716.7, "worldZ": -1882.7, "headingRad": 4.2452, "type": "fighter"},
  {"id": "AS-5", "worldX": -727.6, "worldZ": -1903.0, "headingRad": 4.2339, "type": "fighter"},
  {"id": "AS-6", "worldX": -738.5, "worldZ": -1924.7, "headingRad": 4.2628, "type": "fighter"},
  {"id": "AS-7", "worldX": -749.9, "worldZ": -1947.3, "headingRad": 4.2706, "type": "fighter"},
  {"id": "AS-8", "worldX": -764.0, "worldZ": -1969.2, "headingRad": 4.2518, "type": "fighter"},
  {"id": "AS-9", "worldX": -775.1, "worldZ": -1989.6, "headingRad": 4.2665, "type": "fighter"},
  {"id": "AS-10", "worldX": -784.3, "worldZ": -2009.3, "headingRad": 4.2711, "type": "fighter"},
  {"id": "AS-11", "worldX": -794.3, "worldZ": -2030.3, "headingRad": 4.2702, "type": "fighter"},
  {"id": "AS-12", "worldX": -804.8, "worldZ": -2053.8, "headingRad": 4.2702, "type": "fighter"},
  {"id": "AS-13", "worldX": -808.0, "worldZ": -2142.0, "headingRad": 3.6618, "type": "fighter"},
  {"id": "AS-14", "worldX": -831.6, "worldZ": -2156.3, "headingRad": 3.6618, "type": "fighter"},
  {"id": "AS-15", "worldX": -851.0, "worldZ": -2166.6, "headingRad": 3.7616, "type": "fighter"},
  {"id": "AS-16", "worldX": -871.0, "worldZ": -2179.4, "headingRad": 3.7243, "type": "fighter"},
  {"id": "HAS-1", "worldX": -480.4, "worldZ": -1991.9, "headingRad": 4.2252, "type": "fighter"},
  {"id": "HAS-2", "worldX": -455.9, "worldZ": -1939.2, "headingRad": 4.2252, "type": "fighter"},
  {"id": "HAS-3", "worldX": -375.1, "worldZ": -1776.0, "headingRad": 4.2252, "type": "fighter"},
  {"id": "HAS-4", "worldX": -346.3, "worldZ": -1730.2, "headingRad": 4.2252, "type": "fighter"},
  {"id": "HAS-5", "worldX": -286.9, "worldZ": -1620.2, "headingRad": 4.2252, "type": "fighter"},
  {"id": "HAS-6", "worldX": -257.9, "worldZ": -1569.9, "headingRad": 4.2252, "type": "fighter"}
 ],
 "structures": [
  {"id": "APRON-SHELTER-1", "kind": "shelter", "worldX": -682.3, "worldZ": -1817.2, "headingRad": 4.2214, "widthM": 22.0, "lengthM": 38.4, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-2", "kind": "shelter", "worldX": -695.3, "worldZ": -1841.7, "headingRad": 4.2711, "widthM": 22.0, "lengthM": 37.2, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-3", "kind": "shelter", "worldX": -706.9, "worldZ": -1863.7, "headingRad": 4.2826, "widthM": 22.0, "lengthM": 37.5, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-4", "kind": "shelter", "worldX": -716.7, "worldZ": -1882.7, "headingRad": 4.2452, "widthM": 22.0, "lengthM": 37.5, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-5", "kind": "shelter", "worldX": -727.6, "worldZ": -1903.0, "headingRad": 4.2339, "widthM": 22.0, "lengthM": 38.2, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-6", "kind": "shelter", "worldX": -738.5, "worldZ": -1924.7, "headingRad": 4.2628, "widthM": 22.0, "lengthM": 38.2, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-7", "kind": "shelter", "worldX": -749.9, "worldZ": -1947.3, "headingRad": 4.2706, "widthM": 22.0, "lengthM": 38.9, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-8", "kind": "shelter", "worldX": -764.0, "worldZ": -1969.2, "headingRad": 4.2518, "widthM": 22.0, "lengthM": 38.1, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-9", "kind": "shelter", "worldX": -775.1, "worldZ": -1989.6, "headingRad": 4.2665, "widthM": 22.0, "lengthM": 36.1, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-10", "kind": "shelter", "worldX": -784.3, "worldZ": -2009.3, "headingRad": 4.2711, "widthM": 21.3, "lengthM": 35.8, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-11", "kind": "shelter", "worldX": -794.3, "worldZ": -2030.3, "headingRad": 4.2702, "widthM": 22.0, "lengthM": 36.4, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-12", "kind": "shelter", "worldX": -804.8, "worldZ": -2053.8, "headingRad": 4.2702, "widthM": 22.0, "lengthM": 37.6, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-13", "kind": "shelter", "worldX": -808.0, "worldZ": -2142.0, "headingRad": 3.6618, "widthM": 22.0, "lengthM": 36.1, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-14", "kind": "shelter", "worldX": -831.6, "worldZ": -2156.3, "headingRad": 3.6618, "widthM": 22.0, "lengthM": 34.6, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-15", "kind": "shelter", "worldX": -851.0, "worldZ": -2166.6, "headingRad": 3.7616, "widthM": 22.0, "lengthM": 36.8, "heightM": 9, "group": "apron-shelters"},
  {"id": "APRON-SHELTER-16", "kind": "shelter", "worldX": -871.0, "worldZ": -2179.4, "headingRad": 3.7243, "widthM": 22.0, "lengthM": 35.4, "heightM": 9, "group": "apron-shelters"},
  {"id": "HAS-1", "kind": "shelter", "worldX": -480.4, "worldZ": -1991.9, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HAS-2", "kind": "shelter", "worldX": -455.9, "worldZ": -1939.2, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HAS-3", "kind": "shelter", "worldX": -375.1, "worldZ": -1776.0, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HAS-4", "kind": "shelter", "worldX": -346.3, "worldZ": -1730.2, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HAS-5", "kind": "shelter", "worldX": -286.9, "worldZ": -1620.2, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HAS-6", "kind": "shelter", "worldX": -257.9, "worldZ": -1569.9, "headingRad": 4.2252, "widthM": 26, "lengthM": 36, "heightM": 11, "group": "has-compound"},
  {"id": "HANGAR-1", "kind": "hangar", "worldX": -484.0, "worldZ": -1725.6, "headingRad": 4.2252, "widthM": 65.6, "lengthM": 24.6, "heightM": 12, "group": "maintenance"},
  {"id": "HANGAR-2", "kind": "hangar", "worldX": -520.9, "worldZ": -1801.8, "headingRad": 4.2252, "widthM": 65.7, "lengthM": 24.0, "heightM": 12, "group": "maintenance"},
  {"id": "HANGAR-3", "kind": "hangar", "worldX": -589.2, "worldZ": -1931.0, "headingRad": 4.2252, "widthM": 51.1, "lengthM": 25.3, "heightM": 12, "group": "maintenance"},
  {"id": "HANGAR-4", "kind": "hangar", "worldX": -626.2, "worldZ": -1999.1, "headingRad": 4.2252, "widthM": 64.3, "lengthM": 25.5, "heightM": 12, "group": "maintenance"},
  {"id": "TERMINAL", "kind": "building", "worldX": 277.8, "worldZ": -516.7, "headingRad": 2.6501, "widthM": 48.7, "lengthM": 97.4, "heightM": 14, "group": "terminal"},
  {"id": "TOWER", "kind": "control_tower", "worldX": 333.2, "worldZ": -535.2, "headingRad": 4.2252, "widthM": 9, "lengthM": 9, "heightM": 28, "group": "atc"},
  {"id": "BUILDING-1", "kind": "building", "worldX": 708.7, "worldZ": 23.9, "headingRad": 1.0502, "widthM": 19.3, "lengthM": 93.4, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-2", "kind": "building", "worldX": 33.0, "worldZ": -1022.9, "headingRad": 2.6502, "widthM": 24.9, "lengthM": 94.5, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-3", "kind": "building", "worldX": -250.4, "worldZ": -1156.5, "headingRad": 5.8278, "widthM": 34.8, "lengthM": 71.7, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-4", "kind": "building", "worldX": -13.9, "worldZ": -1436.5, "headingRad": 5.7741, "widthM": 38.8, "lengthM": 98.0, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-5", "kind": "building", "worldX": -68.4, "worldZ": -1554.1, "headingRad": 1.1109, "widthM": 29.6, "lengthM": 86.6, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-6", "kind": "building", "worldX": -118.5, "worldZ": -1357.3, "headingRad": 2.6337, "widthM": 49.8, "lengthM": 58.7, "heightM": 8, "group": "base-support"},
  {"id": "BUILDING-7", "kind": "building", "worldX": -42.9, "worldZ": -1505.6, "headingRad": 1.0731, "widthM": 27.0, "lengthM": 88.0, "heightM": 8, "group": "base-support"},
  {"id": "MAG-1", "kind": "magazine", "worldX": 529.3, "worldZ": -1137.1, "headingRad": 4.2252, "widthM": 14, "lengthM": 24, "heightM": 6, "group": "munitions-generic"},
  {"id": "MAG-2", "kind": "magazine", "worldX": 487.1, "worldZ": -1216.6, "headingRad": 4.2252, "widthM": 14, "lengthM": 24, "heightM": 6, "group": "munitions-generic"},
  {"id": "MAG-3", "kind": "magazine", "worldX": 445.0, "worldZ": -1296.1, "headingRad": 4.2252, "widthM": 14, "lengthM": 24, "heightM": 6, "group": "munitions-generic"},
  {"id": "MAG-4", "kind": "magazine", "worldX": 402.9, "worldZ": -1375.6, "headingRad": 4.2252, "widthM": 14, "lengthM": 24, "heightM": 6, "group": "munitions-generic"}
 ]
}
```

### 1.8 Sources (Ngari)

- [Ngari Gunsa Airport, Wikipedia](https://en.wikipedia.org/wiki/Ngari_Gunsa_Airport): elevation, runway 4,500 m, opened 2010, J-11/J-16
- OpenStreetMap (© OpenStreetMap contributors, ODbL), Overpass API extract 2026-11-14, bbox 32.05–32.17 N, 79.98–80.13 E: runway 154378695, taxiways, aprons 154378705 and 1157053351, stands, terminal, aerodrome fence 154378691, shelter outlines 1156184657–77, hangars, ≈780 buildings
- [TWZ: Tracking China's sudden airpower expansion along its western border (2021, Planet Labs imagery)](https://www.twz.com/41065/tracking-chinas-sudden-airpower-expansion-along-its-western-border): ≥12 HAS, SAM deployment within the base, munitions storage, maintenance area, hangars, no new runway
- [Swarajya, March 2021: hardened shelters at Ngari (Feb 2021 imagery, @detresfa_)](https://swarajyamag.com/amp/story/news-brief/satellite-images-show-china-is-expanding-its-airbase-near-ladakh-building-hardened-shelters-for-fighter-jets): ≥12 shelters, 2020 earthwork, "second taxi-track"
- [Swarajya, Oct 2021: UAVs and fighters at Ngari Gunsa](https://swarajyamag.com/amp/story/defence/new-satellite-imagery-shows-china-has-deployed-uavs-fighter-jets-at-ngari-gunsa-airbase-close-to-lac)
- [Hindustan Times via PressReader, 1 Jun 2023: Planet Labs comparison](https://www.pressreader.com/india/hindustan-times-lucknow/20230601/281492165699737) (paywalled; claims taken from the search summary)
- [ThePrint, Aug 2020: SAM site at Mansarovar](https://theprint.in/defence/satellite-images-reveal-china-is-building-surface-to-air-missile-site-at-mansarovar-lake/486091) (a different site)
- Esri World Imagery tiles, z15–z17, used only for visual measurement and identification (not redistributed). Image date unknown; it looks post-2021, with the shelters complete.
- SRTM elevations via [OpenTopoData](https://www.opentopodata.org/) (theatre spec §3.4)

---

## 2. Nepal: the friendly forward strip

### 2.1 Which strip, and why: **Simikot (VNST)**

| | **Simikot (VNST)** | Rara / Talcha (VNRR) | Bajhang (VNBG) | Darchula (VNDL) |
|---|---|---|---|---|
| Position | 29.971 N 81.819 E, Humla | 29.517 N 82.150 E, Mugu | 29.538 N 81.183 E | 29.669 N 80.548 E |
| In the box? | Yes (E side, 50 km from the edge) | Yes, but 12 km from the S edge and 25 km from the E edge | Yes, 15 km from the S edge | Yes |
| Elevation [S] AIP | **2,971 m** | 2,720 m | ≈1,260 m | 676 m |
| Runway [S] AIP | **650 × 20 m, asphalt concrete, 10/28**, in operation | 570 × 20 m AC, 18/36, "land 18 / take off 36", 6.5% slope (AIP row layout ambiguous) | 630 × 20 m, in operation | 590 × 30 m **earthen, not in operation** |
| Distance to China | **≈30 km to Hilsa** (Nepal–Tibet border on the Humla Karnali), on the valley route from Purang | ≈60 km | ≈70 km | On the India border (Mahakali), 60 km from Tibet |
| Story fit | The Chinese axis Purang → Hilsa → Simikot down the Karnali is exactly the invasion route. It is the district HQ. A high, sloped, one-way STOL strip on a shelf above a gorge suits a Twin Otter, Dornier or helicopter set-piece. The shelf next to it makes a hard C-17 airdrop DZ. | Dramatic, but off the invasion axis | Low and far from the front | Not operating and low. Better as an India–Nepal river-crossing landmark. |

**Choice: Simikot.** It is on the invasion axis, high, hard to fly into, and already the airdrop DZ in
the theatre spec. Rara is the only one with comparable drama, but it sits off to the side.

### 2.2 Character in one paragraph

Simikot is a **650 m × 20 m asphalt strip on a narrow shelf at ≈2,970 m**. It sits **600 m above the
Humla Karnali gorge**, with a mountainside rising straight up behind it. The town (tin roofs, mostly
blue, with stone and mud houses) wraps the **north** side of the strip right up to the fence. The
small apron and a two-spot helipad are on the north side at mid-strip. Fields and scrub run along the
south side, then the ground drops away into the gorge. The strip **slopes up to the west by ≈4%**
(SRTM), so in practice it is one-way: **land 28 uphill (westbound), take off 10 downhill toward the
gorge.** The AIP lights only runway 28: a flashing white threshold identification light (RTIL) and
red end lights. There is no edge lighting.

### 2.3 Runway

| Item | Value | Tag |
|---|---|---|
| Designation | 10/28 | [S] AIP, OSM |
| ARP | 29°58′16″N 081°49′08″E | [S] CAAN AIP AFIS AD 2-4 (AMDT 02/2026) |
| Threshold 10 (W end) | 29.97117 N, 81.81585 E (OSM way ends, re-centred to the AIP 650 m) | [M] |
| Threshold 28 (E end) | 29.96978 N, 81.82240 E | [M] |
| True heading | 103.6° / 283.6° | [M] OSM |
| Length | **650 m** (AIP). 636 m between the OSM way ends. Wikipedia text: 549 m (older). | [S] / [M] |
| Width | **20 m** (AIP). 18.6–19 m between the painted edge lines on imagery. | [S] / [M] |
| Surface | Asphalt concrete ("AC" in the AIP; OSM `surface=asphalt`) | [S] |
| Elevation | **2,971 m (9,751 ft)** AIP. Wikipedia and OSM `ele` say 2,818 m (old value). | [S] |
| **Slope** | SRTM 30 m along the centreline, W → E: 2,985, 2,977, 2,968, 2,969, 2,964, 2,961, 2,963, 2,958, 2,961, 2,961, 2,958 m. So **≈27 m over 636 m ≈ 4.2%, up toward the west**. SRTM at 30 m is noisy: treat it as **3–5%**. The AIP gives no Simikot slope. | [M] |
| Lighting | 28: RTIL flashing white, red end lights. 10: none. No edge lights. | [S] AIP AFIS AD 2-6 |
| Operations | AFIS, 122.5 MHz, daylight hours only (0015–0630 UTC in summer). Rescue and fire: small fire vehicle. | [S] AIP |
| Markings seen on imagery | Threshold bars at the 28 end, centreline dashes, edge lines, painted fillets at the apron link | [M] |

### 2.4 Taxiway, apron, helipad, buildings

| Item | Where | Size | Tag |
|---|---|---|---|
| Apron | North of the runway at mid-strip, centred ≈29.9709 N 81.8186 E. OSM mis-tags it as `aeroway=runway`, `area=yes` (way 512334045). | ≈100 × 40 m, 3,540 m², asphalt. Stand loops are painted on it. | [M] |
| Taxiway | Four short OSM ways (976566008–11): one stub of ≈40 m from the runway with painted lead-in loops on the apron | Width ≈10 m | [M] / [E] width |
| Helipad pad | West of the apron, 29.9710–29.9714 N, 81.8177–81.8181 E, with **two "H" circles** | ≈45 × 55 m paved | [M] imagery, OSM 1239956739 |
| Big paved square | NW of the helipad, 29.9712–29.9718 N, ≈81.8160–81.8176 E | ≈150 × 70 m. Use it as an army helipad, parade ground or DZ marshalling area. | [M] imagery / [E] use |
| Airport buildings | 5 small buildings inside the fence and in the first row north of the apron (AFIS office, terminal shed, stores) | 4–21 m footprints, 1–2 storeys (≈6 m) | [M] OSM / [E] height |
| Town | ≈700 mapped buildings (houses, hospital, schools, bank, hotel) packed to within 30–50 m of the strip on the north and east | 1–3 storeys | [M] OSM |

### 2.5 Terrain, approach and go-around

SRTM 30 m. The axis runs from the runway midpoint (+ = east, toward the 28 approach). "Across" is + = north.

| km along | −15 | −10 | −7 | −5 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +5 | +7 | +10 | +15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 4,686 | 4,069 | 3,499 | 2,718 | 2,510 | 3,013 | **3,191** | 2,961 | 2,779 | 2,618 | 3,150 | 2,529 | 2,354 | 2,704 | 3,062 |

| km across | −15 | −10 | −7 | −5 | −3 | −2 | −1 | 0 | +1 | +2 | +3 | +5 | +7 | +10 | +15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 4,195 | 4,456 | 4,275 | 3,625 | 2,940 | 2,490 | 2,492 | 2,961 | 3,159 | 3,292 | **3,982** | 3,966 | 3,674 | 3,173 | 4,280 |

- **The west end is blocked.** The ground rises ≈230 m within 1 km past threshold 10. Landing 10 would
  mean landing downhill toward the town and a hill, so landing is 28 only. [M]
- **Approach to 28** is from the east, out of the gorge. The ground drops to ≈2,600 m 2 km east (a
  300 m "cliff" before the threshold). The opposite gorge wall reaches ≈3,150 m 3 km east. The
  approach is curved, along the Karnali, with a short final over the drop-off. **There is no go-around
  after short final.** Treat the commit point as ≈1 km out. [M] / [E]
- **South:** 500 m drop to the Karnali (≈2,490 m) within 1–2 km. **North:** the slope climbs
  ~1,000 m in 3 km (3,982 m).
- **Wind:** the up-valley afternoon wind in the Humla Karnali runs NW, up the gorge, past the town. Fly
  missions in the morning.

### 2.6 The C-17 airdrop (game design)

- No part of the shelf gives a full-size personnel DZ. A **container (CDS) drop** onto the strip plus
  the big paved square fits (≈650 × 200 m usable).
- Run in from the east up the gorge, heading ≈284°, at ≥ 3,400 m (about 450 m above the strip).
  Release over threshold 28. Then turn hard right (north is higher; south over the gorge is the escape).
- Score on DZ hit. For pass/fail, size the box from USAF AFI 13-217 CDS tables; I did not verify them,
  so check before tuning. [E]

### 2.7 Ready-to-use layout (`simikot.json`)

Reference point: runway midpoint 29.97047 N 81.81912 E. `elevationM` is 2,971 for the whole field,
because the format cannot slope a runway (section 4).
- Runway: the AIP length and width on the OSM centreline. Lights for 28 only (`thresholdLights` = the
  RTIL).
- 4 taxiway segments from OSM at 10 m wide [E].
- Apron and helipad pad from OSM.
- 3 light-transport stands and 1 helicopter spot [E].
- 5 OSM buildings at 6 m [E].
- One 360 m flatten disc.

```json
{
 "id": "simikot",
 "name": "Simikot Airport (VNST), Humla",
 "side": "friendly",
 "attribution": "Base layout from OpenStreetMap data, (c) OpenStreetMap contributors (ODbL); runway size from the CAAN AIP; stands and building heights generic.",
 "referenceWorldX": 0,
 "referenceWorldZ": 0,
 "elevationM": 2971,
 "flattenZones": [
  {"centerWorldX": 0, "centerWorldZ": 0, "elevationM": 2971, "flatRadiusM": 360, "blendRadiusM": 250}
 ],
 "runways": [
  {"id": "10", "thresholdWorldX": -315.9, "thresholdWorldZ": -76.5, "elevationM": 2971, "headingRad": 1.808486, "lengthM": 650.0, "widthM": 20.0, "surface": "asphalt", "reciprocalId": "28", "lights": {"edgeLights": false, "thresholdLights": false, "approachLights": false, "papi": false}},
  {"id": "28", "thresholdWorldX": 315.9, "thresholdWorldZ": 76.5, "elevationM": 2971, "headingRad": 4.950078, "lengthM": 650.0, "widthM": 20.0, "surface": "asphalt", "reciprocalId": "10", "lights": {"edgeLights": false, "thresholdLights": true, "approachLights": false, "papi": false}}
 ],
 "taxiways": [
  {"id": "TWY-1", "widthM": 10, "points": [{"worldX": -52.9, "worldZ": -12.8}, {"worldX": -43.6, "worldZ": -15.6}, {"worldX": -39.6, "worldZ": -18.8}, {"worldX": -37.7, "worldZ": -22.6}, {"worldX": -32.6, "worldZ": -42.9}, {"worldX": -32.9, "worldZ": -46.1}, {"worldX": -37.6, "worldZ": -51.5}, {"worldX": -49.7, "worldZ": -55.2}, {"worldX": -52.0, "worldZ": -57.4}, {"worldX": -53.1, "worldZ": -60.3}, {"worldX": -53.6, "worldZ": -64.8}, {"worldX": -51.7, "worldZ": -67.6}, {"worldX": -48.2, "worldZ": -70.3}, {"worldX": -41.6, "worldZ": -69.2}]},
  {"id": "TWY-2", "widthM": 10, "points": [{"worldX": -49.7, "worldZ": -55.2}, {"worldX": -77.6, "worldZ": -61.8}, {"worldX": -81.9, "worldZ": -65.3}, {"worldX": -82.8, "worldZ": -69.1}, {"worldX": -81.9, "worldZ": -73.7}, {"worldX": -78.9, "worldZ": -76.9}, {"worldX": -74.9, "worldZ": -78.0}, {"worldX": -70.1, "worldZ": -77.3}]},
  {"id": "TWY-3", "widthM": 10, "points": [{"worldX": -37.7, "worldZ": -22.6}, {"worldX": -36.6, "worldZ": -17.2}, {"worldX": -34.4, "worldZ": -13.1}, {"worldX": -31.4, "worldZ": -10.4}, {"worldX": -23.7, "worldZ": -5.7}]},
  {"id": "TWY-4", "widthM": 10, "points": [{"worldX": -32.6, "worldZ": -42.9}, {"worldX": -27.3, "worldZ": -47.8}, {"worldX": -23.1, "worldZ": -48.0}, {"worldX": -11.6, "worldZ": -45.9}, {"worldX": -8.7, "worldZ": -46.6}, {"worldX": -6.2, "worldZ": -48.6}, {"worldX": -4.8, "worldZ": -51.3}, {"worldX": -4.3, "worldZ": -55.3}, {"worldX": -5.7, "worldZ": -58.4}, {"worldX": -8.1, "worldZ": -60.8}, {"worldX": -12.7, "worldZ": -62.7}]}
 ],
 "aprons": [
  {"id": "APRON", "kind": "apron", "points": [{"worldX": -88.5, "worldZ": -91.9}, {"worldX": -95.7, "worldZ": -60.5}, {"worldX": -48.1, "worldZ": -49.2}, {"worldX": -41.7, "worldZ": -39.4}, {"worldX": -23.5, "worldZ": -35.8}, {"worldX": -19.2, "worldZ": -40.0}, {"worldX": 2.3, "worldZ": -33.3}, {"worldX": 9.0, "worldZ": -69.5}, {"worldX": -52.3, "worldZ": -83.6}]},
  {"id": "HELI-PAD", "kind": "apron", "points": [{"worldX": -110.6, "worldZ": -55.2}, {"worldX": -138.8, "worldZ": -61.1}, {"worldX": -130.5, "worldZ": -100.3}, {"worldX": -102.2, "worldZ": -94.4}]}
 ],
 "parkingSpots": [
  {"id": "STAND-1", "worldX": -14.3, "worldZ": -54.0, "headingRad": 3.3793, "type": "transport"},
  {"id": "STAND-2", "worldX": -43.5, "worldZ": -60.7, "headingRad": 3.3793, "type": "transport"},
  {"id": "STAND-3", "worldX": -72.8, "worldZ": -67.4, "headingRad": 3.3793, "type": "transport"},
  {"id": "HELI-1", "worldX": -120.5, "worldZ": -77.8, "headingRad": 1.8085, "type": "helicopter"}
 ],
 "structures": [
  {"id": "BUILDING-1", "kind": "building", "worldX": -49.6, "worldZ": -109.8, "headingRad": 4.7407, "widthM": 8.6, "lengthM": 18.4, "heightM": 6, "group": "airport"},
  {"id": "BUILDING-2", "kind": "building", "worldX": -106.2, "worldZ": -141.8, "headingRad": 4.9315, "widthM": 12.8, "lengthM": 19.0, "heightM": 6, "group": "airport"},
  {"id": "BUILDING-3", "kind": "building", "worldX": -80.2, "worldZ": -146.2, "headingRad": 3.2822, "widthM": 3.6, "lengthM": 4.7, "heightM": 6, "group": "airport"},
  {"id": "BUILDING-4", "kind": "building", "worldX": -24.6, "worldZ": -142.4, "headingRad": 5.0823, "widthM": 8.3, "lengthM": 16.3, "heightM": 6, "group": "airport"},
  {"id": "BUILDING-5", "kind": "building", "worldX": -14.8, "worldZ": -124.1, "headingRad": 4.9213, "widthM": 14.0, "lengthM": 20.7, "heightM": 6, "group": "airport"}
 ]
}
```

### 2.8 Sources (Simikot)

- [CAAN AIP Nepal, AFIS AD 2-1 to 2-6 (STOL aerodromes), AMDT 02/2026, 30 Apr 2026](https://e-aip.caanepal.gov.np/_uploads/_pdf/65fb48908bc7ff5116bd3c969c91471b.pdf): ARP, 2,971 m, 650 × 20 m AC, AFIS 122.5 MHz, RTIL on 28. The same table covers Rara, Bajhang and Darchula. Some rows in the text extraction are shuffled, so the Rara slope and runway headings are flagged.
- [Simikot Airport, Wikipedia](https://en.wikipedia.org/wiki/Simikot_Airport): older 2,818 m and 549 m figures
- OpenStreetMap (© OpenStreetMap contributors, ODbL), Overpass 2026-11-14: runway 331449425, apron 512334045, taxiways 976566008–11, helipads, aerodrome 331449510, buildings
- Esri World Imagery z18 tiles (≈0.5 m/px), measurement only
- SRTM 30 m via [OpenTopoData](https://www.opentopodata.org/), 2026-11-14

---

## 3. Fukche Advanced Landing Ground (IAF), Ladakh

### 3.1 Character in one paragraph

Fukche is a **2.6 km unpaved gravel strip at ≈4,170 m** on a broad, nearly flat gravel fan. The fan is
in the Koyul Lungpa valley in the Demchok sector, about **2.5 km from the LAC**. There is no proper
taxiway system:
- a graded patch on the SW side at about two-thirds length serves as dispersal and parking;
- a small army camp of 20-odd low huts sits ≈1.3 km SSW of the runway's middle;
- helipads lie at the camp and further SE.

The strip is barely distinguishable from the fan on imagery: a slightly lighter, smoother band with a
track beside it. Ridges of 4,400–4,800 m stand 3–10 km away on both sides, with a 5,700 m massif
15 km SW. The upstream valley rises gently to the SE (+0.7% along the strip). It is a forward,
austere, high and dusty field. It was **not** upgraded (see 3.3).

### 3.2 Runway

| Item | Value | Tag |
|---|---|---|
| NW end | 32.94549 N, 79.20431 E. SRTM 4,165 m | [M] OSM way 60136276 |
| SE end | 32.92837 N, 79.22329 E. SRTM 4,184 m | [M] |
| Midpoint (reference point) | 32.93693 N, 79.21380 E. Wikipedia gives 32°56′15″N 79°12′48″E. | [M] / [S] |
| True heading | 136.8° / 316.8° | [M] OSM |
| Designation | Not published. "14/32" is used here (magnetic ≈135°, a toss-up between 13 and 14). | [E] |
| Length | **2,594 m** between the OSM centreline ends; the OSM area polygon is 2,614 m. Published: "2 miles" (Wikipedia) and "3.2 km" (SP's). The 3.2 km figure probably includes graded overruns. | [M] / [S] |
| Width | OSM area polygon 51 m. On imagery the lighter band is ≈30–35 m wide (low contrast at 2 m/px). Use **45 m graded** in the game. | [M] / [E] |
| Surface | **Unpaved, gravel** ("unpaved gravelly runway") | [S] Wikipedia, SP's, OSM `surface=gravel` |
| Elevation | OSM `elevation=4176`. Wikipedia 13,700 ft (4,200 m). Tribune 14,300 ft (probably the camp or a high point). | [S] |
| Slope | +19 m NW → SE over 2.6 km ≈ **+0.7%, up toward the SE** | [M] SRTM 30 m |
| Lighting | None known. Use portable lights or flare-path for night missions. | [E] |

### 3.3 History and upgrades: checking the facts

| Claim | Finding | Tag |
|---|---|---|
| Built | 1961, the sixth ALG in Ladakh. Fell out of use after 1962. | [S] Wikipedia, SP's |
| Reactivated | **4 Nov 2008, by an IAF An-32 landing** | [S] Wikipedia, SP's, ThePrint |
| "Upgraded for C-130J / fighters" | **Not true for Fukche.** The MoD studied DBO, Nyoma and Fukche for fighter operations. Fukche's room to expand was limited, so **Nyoma** was chosen: 2.7 km concrete runway, 45 m wide, BRO tender Jan 2023, inaugurated Nov 2025 with a C-130J; an IL-76 has landed since. BRO had "no plans to also upgrade the Fukche ALG", partly because of how close it is to the LAC. ThePrint says it "lost its relevance" once Nyoma was built. The C-130J "first" landings in Ladakh were at **DBO (Aug 2013)** and **Kargil (night, Jan 2024)**, not Fukche. | [S] SP's MAI; ThePrint; Tribune; Wikipedia |
| What has landed | An-32 (2008). Helicopters (helipads mapped). No public record of a C-130J, IL-76 or fighter at Fukche. | [S] / unknown |
| Recent activity | Roads only: the Chushul–Dungti–Fukche–Demchok road (to NH standard, target Dec 2025) and the Likaru–Mig La–Fukche road (reported complete in 2025) | [S] Wikipedia |
| 2013 | During the Depsang stand-off, China demanded that bunker construction at Fukche stop; India refused | [S] Wikipedia |

**Game read.** Fukche is a rough-field strip. Today it would take Dornier 228, An-32 or C-130J-class
traffic. A **C-17 on gravel** is a stretch: published semi-prepared figures for the C-17 are ≈6,200 ft
(1,890 m) on dirt (theatre spec sources). At 4,170 m it is fiction, but the 2.6 km length makes it
believable. **Tejas on gravel: no.**

### 3.4 Layout (thin by nature)

| Item | Where | Size | Tag |
|---|---|---|---|
| Dispersal / parking | SW side, ≈1,870 m from the NW end, centred 32.9324 N 79.2171 E. Disturbed, graded ground with vehicles visible. | ≈160 × 110 m | [M] imagery / [E] extent |
| Link | Straight, runway → dispersal | ≈70 m × 18 m | [E] |
| Army camp | 32.9230–32.9254 N, 79.2129–79.2146 E, ≈1.3 km SSW of the midpoint | 21 huts, 5–11 × 9–32 m; 1 storey (≈4 m) | [M] OSM 931452094–114 / [E] height |
| Helipads | 32.9072 N 79.2015 E (24 × 32 m, by "Fukche camp" 32.905 N 79.2005 E) and 32.8684 N 79.2905 E (15 × 23 m) | — | [M] OSM |
| Aerodrome boundary | OSM way 1420734388: a narrow polygon round the strip, widening at the dispersal | ≈430 × 2,830 m | [M] |

### 3.5 Terrain (SRTM 30 m)

Along the axis (km from the midpoint, + = SE):

| km | −20 | −15 | −10 | −7 | −5 | −3 | −2 | 0 | +2 | +3 | +5 | +7 | +10 | +15 | +20 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 4,536 | 4,391 | 4,207 | 4,162 | 4,164 | 4,163 | 4,165 | 4,175 | 4,182 | 4,178 | 4,235 | 4,237 | 4,268 | 4,290 | 4,267 |

Across (+ = NE, toward the LAC and the Indus):

| km | −20 | −15 | −10 | −7 | −5 | −3 | −2 | 0 | +2 | +3 | +5 | +7 | +10 | +15 | +20 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m | 4,867 | **5,744** | 4,772 | 4,412 | 4,309 | 4,379 | 4,420 | 4,175 | 4,166 | 4,222 | 4,162 | 4,285 | 4,751 | 4,631 | 5,103 |

Both approaches are open and gentle along the valley: within ±100 m of field elevation for 7 km each
way. The NE side is low for 5 km, toward the Indus and the LAC; the SW side rises 250–600 m within
2–10 km. **Approaches along the axis are easy. Anything that strays NE crosses the LAC within
seconds.**

### 3.6 Where it falls relative to the box, and what to do

Real geometry:

| Item | Value |
|---|---|
| Fukche → Ngari (runway mid) | **122 km at 140° true** (Ngari → Fukche 320°). The Fukche runway heading (137°) points almost straight at Ngari. |
| Fukche → Demchok / Nyoma / Shiquanhe | 35 km at 141° / 55 km at 301° / 96 km at 120° |
| Fukche → Naini Saini / Simikot | 385 km / 412 km |
| North of the theatre box | **71 km** north of the 32.30 N edge (the box's west edge, 79.07 E, is 13 km further west) |
| In today's game frame (0.6 compression, origin 30.85 N 80.745 E) | x ≈ −88 km, z ≈ −139 km: **39 km beyond the north edge** of the 200 km world (Ngari's runway is at x −39.7, z −83.4 km, only 16.6 km from that edge) |
| To the LAC | ≈2.5 km (Wikipedia: the LAC runs along the Indus here) |

**Primary recommendation: a fictional placement inside the current box.**

| Item | Value |
|---|---|
| Pad position | **32.17 N 79.35 E**: world x ≈ **−80.0 km**, z ≈ **−88.1 km** |
| Edge margins | 11.9 km to the north edge and 20 km to the west edge of the world. That is enough for a straight-in on either runway: 14 km of axis toward the NW at 137°/317° stays inside, because the axis runs diagonally. |
| Relation to Ngari | **40.6 km (world) at 277°** from Ngari: due west, up the "Indus" valley. The real relation is NW at 122 km. Keeping a NW bearing is impossible because Ngari sits only 16.6 km from the north edge. Due west keeps the story: same valley system, Fukche "upstream", an Indian strip facing the Chinese base. |
| Runway | Keep **137°/317° true, 2,600 × 45 m gravel, 4,176 m**, with +0.7% rise to the SE (flat for now) |
| Pad entry for `layout.ts` | `{ id: 'fukche', name: 'Fukche ALG', lat: 32.17, lon: 79.35, headingDeg: 137, lengthM: 2600, widthM: 45, elev: 4176 }` |
| Basin entry | `{ id: 'koyul', lat: 32.17, lon: 79.35, rx: 7000, rz: 3500, rot: 47, level: 4176 }` gives a valley floor about 14 × 7 km along the runway. Ridge relief comes from the existing control points (4,400–4,500 m base, 1,500 m relief), which fits the real 4,400–5,700 m ridges. |
| LAC (fictional line) | NW–SE, **≈3 km NE of the runway** and parallel to it, between Fukche and Ngari. Ngari then sits ≈37 km beyond it. |

**Alternative: extend the box.** This keeps true distances, only rescaled.
- A square box that holds Naini Saini (home base, 29.59 N) and real Fukche (32.94 N), with margins,
  needs ≈3.75° of latitude, which is **≈417 km**.
  - At the current 0.6 compression that is a **250 km world**: `TERRAIN_WORLD_EXTENT_M` from 200,000 to
    250,000, with a matching quadtree depth.
  - To stay in a **200 km world**, the compression must drop to **0.48**.
- Box at 0.48: **29.40–33.15 N, 78.56–82.94 E**, centre 31.275 N 80.75 E. World positions (km, x/z):

  | Place | x | z |
  |---|---|---|
  | Fukche | −70.2 | −88.7 |
  | Ngari | −31.8 | −44.0 |
  | Naini Saini | −23.3 | +89.9 |
  | Burang | +17.7 | +46.8 |
  | Simikot | +48.8 | +69.6 |

- At 0.5 the box (29.47–33.07 N) leaves Fukche only 7 km from the north edge, which is too tight.
- Cost: every horizontal distance shrinks 20% more (valleys narrow, flight times shorten), and the
  whole layout gets re-baked. **I would not do this just for Fukche.**

### 3.7 Mission-design notes

- **Fukche ↔ Ngari is the short leg of the theatre:** 122 km real (≈40 km world in the fictional
  placement), and the same valley system. That makes it the natural Indian forward strip for a Tejas
  detachment, or for C-17 / C-130J resupply under the Ngari SAM umbrella.
- In the fiction, Fukche is the **staging base for the finale troops**. The C-17 comes up from Naini
  Saini, lands on gravel at Fukche, then flies the 40 km leg to Ngari's taxiway. A **gravel landing at
  4,176 m** is a good mid-campaign training mission before the finale.
- Being 2.5–3 km from the LAC means anything that turns NE after take-off from 32 (heading 317°) is
  over the line within seconds. Departures from 14 head SE, straight toward Ngari.

### 3.8 Ready-to-use layout (`fukche-alg.json`)

Reference point: runway midpoint (real 32.93693 N 79.21380 E; place it at the fictional pad).
- Runway 2,594 × 45 m with no lights. `surface` is `"concrete"` only because the format has no gravel
  value; **it needs a `gravel` value** (section 4).
- Dispersal apron, one link, 2 transport stands and 1 helicopter spot [E].
- 21 camp huts from OSM.
- 3 flatten discs: a 1,450 m disc at mid-runway, which covers the camp, and 700 m discs at the ends.

```json
{
 "id": "fukche-alg",
 "name": "Fukche Advanced Landing Ground (IAF)",
 "side": "friendly",
 "attribution": "Runway from OpenStreetMap data, (c) OpenStreetMap contributors (ODbL); dispersal, camp and stands are interpretation or generic.",
 "referenceWorldX": 0,
 "referenceWorldZ": 0,
 "elevationM": 4176,
 "flattenZones": [
  {"centerWorldX": -730.3, "centerWorldZ": -559.7, "elevationM": 4176, "flatRadiusM": 700, "blendRadiusM": 600},
  {"centerWorldX": -109.4, "centerWorldZ": 102.6, "elevationM": 4176, "flatRadiusM": 1450, "blendRadiusM": 600},
  {"centerWorldX": 511.5, "centerWorldZ": 764.9, "elevationM": 4176, "flatRadiusM": 700, "blendRadiusM": 600}
 ],
 "runways": [
  {"id": "14", "thresholdWorldX": -887.0, "thresholdWorldZ": -946.1, "elevationM": 4176, "headingRad": 2.388437, "lengthM": 2593.8, "widthM": 45.0, "surface": "concrete", "reciprocalId": "32", "lights": {"edgeLights": false, "thresholdLights": false, "approachLights": false, "papi": false}},
  {"id": "32", "thresholdWorldX": 887.0, "thresholdWorldZ": 946.1, "elevationM": 4176, "headingRad": 5.53003, "lengthM": 2593.8, "widthM": 45.0, "surface": "concrete", "reciprocalId": "14", "lights": {"edgeLights": false, "thresholdLights": false, "approachLights": false, "papi": false}}
 ],
 "taxiways": [
  {"id": "TWY-DISPERSAL", "widthM": 18, "points": [{"worldX": 394.1, "worldZ": 420.4}, {"worldX": 344.8, "worldZ": 466.6}]}
 ],
 "aprons": [
  {"id": "DISPERSAL", "kind": "apron", "points": [{"worldX": 290.1, "worldZ": 408.3}, {"worldX": 399.5, "worldZ": 525.0}, {"worldX": 319.3, "worldZ": 600.2}, {"worldX": 209.8, "worldZ": 483.5}]}
 ],
 "parkingSpots": [
  {"id": "STAND-1", "worldX": 262.9, "worldZ": 481.7, "headingRad": 0.8176, "type": "transport"},
  {"id": "STAND-2", "worldX": 293.7, "worldZ": 514.5, "headingRad": 0.8176, "type": "transport"},
  {"id": "STAND-3", "worldX": 324.5, "worldZ": 547.4, "headingRad": 0.8176, "type": "helicopter"}
 ],
 "structures": [
  {"id": "CAMP-1", "kind": "building", "worldX": -56.9, "worldZ": 1285.2, "headingRad": 3.8007, "widthM": 7.6, "lengthM": 19.2, "heightM": 4, "group": "camp"},
  {"id": "CAMP-2", "kind": "building", "worldX": -35.4, "worldZ": 1277.5, "headingRad": 5.3646, "widthM": 7.5, "lengthM": 18.4, "heightM": 4, "group": "camp"},
  {"id": "CAMP-3", "kind": "building", "worldX": -14.4, "worldZ": 1318.5, "headingRad": 3.9729, "widthM": 7.5, "lengthM": 19.6, "heightM": 4, "group": "camp"},
  {"id": "CAMP-4", "kind": "building", "worldX": -34.4, "worldZ": 1325.5, "headingRad": 2.2912, "widthM": 5.9, "lengthM": 22.6, "heightM": 4, "group": "camp"},
  {"id": "CAMP-5", "kind": "building", "worldX": -24.4, "worldZ": 1306.6, "headingRad": 3.823, "widthM": 7.2, "lengthM": 21.7, "heightM": 4, "group": "camp"},
  {"id": "CAMP-6", "kind": "building", "worldX": -10.2, "worldZ": 1331.1, "headingRad": 5.3714, "widthM": 6.5, "lengthM": 9.3, "heightM": 4, "group": "camp"},
  {"id": "CAMP-7", "kind": "building", "worldX": -10.1, "worldZ": 1346.9, "headingRad": 5.452, "widthM": 7.2, "lengthM": 31.6, "heightM": 4, "group": "camp"},
  {"id": "CAMP-8", "kind": "building", "worldX": 11.8, "worldZ": 1315.0, "headingRad": 2.3314, "widthM": 7.9, "lengthM": 22.5, "heightM": 4, "group": "camp"},
  {"id": "CAMP-9", "kind": "building", "worldX": 23.8, "worldZ": 1356.0, "headingRad": 4.0158, "widthM": 10.5, "lengthM": 30.9, "heightM": 4, "group": "camp"},
  {"id": "CAMP-10", "kind": "building", "worldX": 42.8, "worldZ": 1447.0, "headingRad": 5.5972, "widthM": 10.8, "lengthM": 19.3, "heightM": 4, "group": "camp"},
  {"id": "CAMP-11", "kind": "building", "worldX": 61.8, "worldZ": 1461.6, "headingRad": 4.0135, "widthM": 9.7, "lengthM": 16.9, "heightM": 4, "group": "camp"},
  {"id": "CAMP-12", "kind": "building", "worldX": 73.8, "worldZ": 1475.3, "headingRad": 3.9877, "widthM": 9.1, "lengthM": 17.0, "heightM": 4, "group": "camp"},
  {"id": "CAMP-13", "kind": "building", "worldX": -77.0, "worldZ": 1489.2, "headingRad": 5.3933, "widthM": 10.4, "lengthM": 18.5, "heightM": 4, "group": "camp"},
  {"id": "CAMP-14", "kind": "building", "worldX": -58.0, "worldZ": 1479.5, "headingRad": 5.4919, "widthM": 10.1, "lengthM": 23.9, "heightM": 4, "group": "camp"},
  {"id": "CAMP-15", "kind": "building", "worldX": -49.3, "worldZ": 1460.2, "headingRad": 3.9593, "widthM": 10.1, "lengthM": 11.0, "heightM": 4, "group": "camp"},
  {"id": "CAMP-16", "kind": "building", "worldX": -34.8, "worldZ": 1476.3, "headingRad": 0.8108, "widthM": 9.6, "lengthM": 10.1, "heightM": 4, "group": "camp"},
  {"id": "CAMP-17", "kind": "building", "worldX": -13.1, "worldZ": 1497.7, "headingRad": 2.3663, "widthM": 8.8, "lengthM": 11.1, "heightM": 4, "group": "camp"},
  {"id": "CAMP-18", "kind": "building", "worldX": 7.8, "worldZ": 1519.2, "headingRad": 2.434, "widthM": 8.9, "lengthM": 11.9, "heightM": 4, "group": "camp"},
  {"id": "CAMP-19", "kind": "building", "worldX": 43.7, "worldZ": 1535.0, "headingRad": 0.8289, "widthM": 5.0, "lengthM": 6.6, "heightM": 4, "group": "camp"},
  {"id": "CAMP-20", "kind": "building", "worldX": 28.5, "worldZ": 1538.9, "headingRad": 3.9564, "widthM": 8.3, "lengthM": 11.7, "heightM": 4, "group": "camp"},
  {"id": "CAMP-21", "kind": "building", "worldX": 53.0, "worldZ": 1515.0, "headingRad": 0.7911, "widthM": 10.2, "lengthM": 19.1, "heightM": 4, "group": "camp"}
 ]
}
```

### 3.9 Sources (Fukche)

- [Fukche, Wikipedia](https://en.wikipedia.org/wiki/Fukche): coordinates, 13,700 ft, "unpaved gravelly runway of 2 miles", 1961, An-32 on 4 Nov 2008, 2.5 km from the LAC, 2013 bunker demand, roads
- [SP's MAI: Ladakh ALGs](https://www.spsmai.com/experts-speak/?id=1281): "unpaved gravelly runway of 3.2 km", no BRO plan to upgrade Fukche; Nyoma 2.7 km × 45 m
- [ThePrint: Nyoma upgrade begins](https://theprint.in/defence/upgradation-of-eastern-ladakhs-nyoma-airfield-begins-to-facilitate-fighter-jet-operations-along-lac/1712180) (Fukche "lost its relevance")
- [Tribune: IAF chief inaugurates Mudh-Nyoma](https://www.tribuneindia.com/news/india/iaf-chief-inaugurates-mudh-nyoma-airbase-near-lac-in-ladakh/amp); [Tribune: Nyoma vulnerabilities](https://www.tribuneindia.com/news/defence/nyoma-airbase-to-boost-operational-logistical-capability-in-ladakh-but-vulnerabilities-persist) (Fukche among the unpaved ALGs, 14,300 ft)
- [Tribune, Sep 2025: MoD to revive Chushul and Anini](https://www.tribuneindia.com/news/j-k/eye-on-china-mod-to-revive-2-airstrips-in-ladakh-arunachal) (not Fukche)
- [ThePrint: C-130J night landing at Kargil, Jan 2024](https://theprint.in/defence/iaf-pulls-off-night-landing-at-kargil-advanced-landing-ground-with-terrain-masking-what-this-means/1913708)
- OpenStreetMap (© OpenStreetMap contributors, ODbL), Overpass 2026-11-14: runway 60136276 (`surface=gravel`, `elevation=4176`), runway area 165620562, aerodrome 1420734388, camp buildings 931452094–114, helipads, "Fukche camp" node
- Esri World Imagery z16 (≈2 m/px), measurement only; SRTM 30 m via OpenTopoData

---

## 4. Format gaps these fields expose

| Gap | Where it bites | Suggested change |
|---|---|---|
| **Sloped runways** | Simikot (≈4%), Fukche (+0.7%), Ngari (−0.3%, ignorable) | Add optional `RunwayDef.farEndElevationM`. The validator would then check each threshold against its own zone, and the flatten shape would become a tilted oriented rectangle (theatre spec §6.3 already asks for oriented rectangles). Until then, build them flat. |
| **Gravel / dirt surface** | Fukche | Add `RunwaySurface.Gravel` (render: no paint, a dust trail; physics: friction μ ≈ 0.3–0.4 dry, rolling resistance ≈ 0.03–0.05) |
| One elevation per layout | Simikot's town and apron sit at slightly different heights | Acceptable for now |
| Paved shoulders | Ngari runway (45 m + shoulders = 60 m) and taxiway (23 + shoulders = 38–42 m) | Add an optional `shoulderM` on runways and taxiways, or draw the shoulders as `apron` strips. It matters for the C-17 lateral-limit check. |
| Circle-only flatten zones | Ngari needs 5 discs; Fukche 3 | Oriented rectangles (theatre spec §0, §6.3) |

## 5. Licence and credit

| Data | Licence | What to do |
|---|---|---|
| OpenStreetMap geometry (all three layouts) | **ODbL 1.0** | Keep the `attribution` string in each layout JSON ("© OpenStreetMap contributors"), as `bhisiana-afs.json` does, and show it in the game credits. The layouts are a derived database. If they are shipped, ODbL share-alike applies to the database itself (the extracted layout data), not to the game code. |
| Esri World Imagery | Esri terms of use | Used only to look and measure. **Nothing from the tiles is shipped or traced as geometry** (the HAS positions are read-off points ±10 m, like a sketch). No credit is needed if no imagery is shipped. Do not ship screenshots of it. |
| SRTM (via OpenTopoData) | Public domain (NASA/USGS) | Credit is courteous, not required |
| CAAN AIP Nepal | Government publication | Facts only (runway figures); cite in docs, no credit in game needed |
| Wikipedia, news and OSINT reports | CC BY-SA (Wikipedia) / copyright (news) | Only facts are used, and facts are not copyrightable. No text or images were copied, so no credit is needed in the game. Keep the source lists here. |
| Planet Labs / Maxar imagery shown in news | Copyright | Not used directly; claims only |

## 6. Biggest unknowns

1. **Ngari SAM sites:** existence is reported (2021), but there are no positions, count or type in any
   public source. The placements here are fiction.
2. **Ngari munitions storage:** reported, but I could not locate it. The igloos are generic.
3. **Ngari parallel taxiway width:** 38–42 m of pavement measured on imagery of unknown date; how much
   of it is structural taxiway and how much is shoulder is unknown. The same goes for the purpose of the
   large graded area at the NW end, and the "new runways" claim from 2023, which I could not confirm.
4. **Simikot slope:** SRTM-derived (≈4%), not published. Elevation 2,971 m (AIP) vs 2,818 m (older sources).
5. **Fukche length and width:** 2.6 km (OSM) vs 3.2 km (press). The usable width is unclear on 2 m imagery.
6. **Building heights:** no OSM height or level tags at any of the three fields. Every height is [E].
7. **Imagery date:** the Esri tiles carry no date. Ngari may have changed since they were taken.
