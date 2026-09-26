# Airbase layouts from OpenStreetMap

`osm_to_layout.py` turns the OpenStreetMap extracts in `osm/` into the game's airport layouts
(`src/airport/layouts/bhisiana-afs.json`, `src/airport/layouts/pafb-shahbaz.json`):

    python tools/airbases/osm_to_layout.py            # both bases
    python tools/airbases/osm_to_layout.py shahbaz    # one

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0,
https://www.openstreetmap.org/copyright). The layouts carry that credit in their `attribution` field.

## Reference bases

| | Bhisiana AFS (Bathinda), friendly | PAF Base Shahbaz (Jacobabad), hostile |
|---|---|---|
| Real location | 30.270 N 74.756 E, 202 m | 28.284 N 68.450 E, ~57 m |
| Runways (from the map) | 13/31, 2,739 m x 46 m, 366 m blast pads both ends | 15R/33L 3,041 m x 50 m and 15L/33R 2,991 m x 45 m, 150 m apart; stopways |
| Taxiways | 82 mapped segments (15-16 m), two dispersal loops, a parallel taxiway | 41 mapped segments; spurs to shelters generated |
| Hardened shelters | 23, ~30-43 m footprints (with berms) | 38, 17 x 24 m, mostly in pairs |
| Hangars / buildings | 10 hangars (up to 86 x 89 m), control building, civil terminal, water tower | 67 cantonment buildings east of the runways |
| Generated (generic) | fuel depot, 4 extra magazines, radar | control tower, fuel depot, 6 magazines, radar |

In the game both sit on the "border" map at 190 m elevation, 65 km apart on their real relative
bearing (Shahbaz WSW of Bhisiana); the real distance (~650 km) is compressed. Each base keeps its
real shape and orientation.

## What is generated, and how

- Shelter door: the end of the shelter's long axis nearer the taxi network. A concrete pad covers
  the shelter floor and 30 m in front of the door; a 15 m spur joins it to the nearest taxiway if
  the map has none; a fighter parking spot sits inside, nose to the door.
- Fuel depot: four 16 m tanks in a 70 x 70 m earth bund and a pump house, 700 m from the main
  apron on its side of the runway, clear of everything else.
- Magazines: earth-covered igloos near any mapped bunkers, else across the runway from the apron.
- Control tower (if not mapped): beside the main apron. Radar: on open ground inside the base.
- Flatten zone: one disc covering every surface and structure.
