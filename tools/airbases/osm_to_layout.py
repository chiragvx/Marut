"""
tools/airbases/osm_to_layout.py — build an airport layout JSON (src/airport/layouts/*.json) from an
OpenStreetMap extract of a real airbase, plus generic facilities the map does not show.

    python tools/airbases/osm_to_layout.py bathinda
    python tools/airbases/osm_to_layout.py shahbaz

From the map (tools/airbases/osm/<key>.json, an Overpass `out geom` extract; © OpenStreetMap
contributors, ODbL): runways (ends, width), taxiway centrelines, aprons, blast pads, stopways,
hardened aircraft shelters, hangars, the control building and on-base buildings.

Generated where the map is silent (clearly "generic", placed by rule): the concrete pad in front of
every shelter and the short spur taxiway to it if none is mapped, a parking spot inside each
shelter, the fuel depot (tanks in an earth bund), munitions magazines, a control tower if none is
mapped, and a surveillance radar.

The base keeps its real shape and orientation; the config below places it in the game world
(the distance between the two bases is compressed for the game).
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

CONFIG = {
    "bathinda": {
        "id": "bhisiana-afs",
        "name": "Bhisiana Air Force Station (Bathinda)",
        "side": "friendly",
        "worldX": 30500, "worldZ": -11000, "elevationM": 190,
        "runwayWidthM": 46, "taxiwayWidthM": 16,
        "ils": {"31": 110.3, "13": 109.5},
        "approachLights": True,
        "shelterHeightM": 10, "tower": None,
    },
    "shahbaz": {
        "id": "pafb-shahbaz",
        "name": "PAF Base Shahbaz (Jacobabad)",
        "side": "hostile",
        "worldX": -30500, "worldZ": 11000, "elevationM": 190,
        "runwayWidthM": 45, "taxiwayWidthM": 18,
        "ils": {},
        "approachLights": False,
        "shelterHeightM": 8.5, "tower": "generate",
    },
}

ATTRIBUTION = "Base layout from OpenStreetMap data, © OpenStreetMap contributors (ODbL); facilities not on the map are generic."


def main(key):
    cfg = CONFIG[key]
    raw = json.load(open(os.path.join(HERE, "osm", f"{key}.json")))
    els = raw["elements"]
    ways = [e for e in els if e["type"] == "way" and len(e.get("geometry", [])) >= 2]

    # --- local projection about the runways' centre (x east, z south, metres) -------------------
    rwy_ways = [w for w in ways if w.get("tags", {}).get("aeroway") == "runway"]
    pts = [p for w in rwy_ways for p in w["geometry"]]
    lat0 = sum(p["lat"] for p in pts) / len(pts)
    lon0 = sum(p["lon"] for p in pts) / len(pts)
    KX = 111320 * math.cos(math.radians(lat0))
    KZ = 110574

    def xz(p):
        return ((p["lon"] - lon0) * KX + cfg["worldX"], -(p["lat"] - lat0) * KZ + cfg["worldZ"])

    def poly(w):
        q = [xz(p) for p in w["geometry"]]
        if len(q) > 2 and math.dist(q[0], q[-1]) < 0.5:
            q = q[:-1]
        return q

    def heading(ax, az, bx, bz):
        return math.atan2(bx - ax, -(bz - az)) % (2 * math.pi)

    def r2(v):
        return round(v, 2)

    elev = cfg["elevationM"]
    out = {
        "id": cfg["id"], "name": cfg["name"], "side": cfg["side"], "attribution": ATTRIBUTION,
        "referenceWorldX": cfg["worldX"], "referenceWorldZ": cfg["worldZ"], "elevationM": elev,
        "flattenZones": [], "runways": [], "taxiways": [], "aprons": [], "parkingSpots": [], "structures": [],
    }

    # --- runways ---------------------------------------------------------------------------------
    runway_rects = []
    for w in rwy_ways:
        t = w.get("tags", {})
        q = poly(w)
        a, b = q[0], q[-1]
        hdg = heading(a[0], a[1], b[0], b[1])
        L = math.dist(a, b)
        width = float(t.get("width", cfg["runwayWidthM"]))
        ref = t.get("ref", "")
        parts = ref.split("/") if "/" in ref else []
        num_ab = round(math.degrees(hdg) / 10) % 36 or 36
        # The designator of the direction a->b is the part whose number is closest to hdg/10.
        def num(s):
            return int("".join(c for c in s if c.isdigit()) or 0)
        if len(parts) == 2:
            d0 = min(abs(num(parts[0]) - num_ab), 36 - abs(num(parts[0]) - num_ab))
            d1 = min(abs(num(parts[1]) - num_ab), 36 - abs(num(parts[1]) - num_ab))
            id_ab, id_ba = (parts[0], parts[1]) if d0 <= d1 else (parts[1], parts[0])
        else:
            id_ab, id_ba = f"{num_ab:02d}", f"{((num_ab + 17) % 36) + 1:02d}"
        for rid, recip, (sx, sz), h in ((id_ab, id_ba, a, hdg), (id_ba, id_ab, b, (hdg + math.pi) % (2 * math.pi))):
            r = {
                "id": rid, "thresholdWorldX": r2(sx), "thresholdWorldZ": r2(sz), "elevationM": elev,
                "headingRad": round(h, 6), "lengthM": r2(L), "widthM": width, "surface": "asphalt", "reciprocalId": recip,
                "lights": {"edgeLights": True, "thresholdLights": True, "approachLights": cfg["approachLights"], "papi": cfg["approachLights"]},
            }
            if rid in cfg["ils"]:
                r["ils"] = {"frequencyMhz": cfg["ils"][rid]}
            out["runways"].append(r)
        runway_rects.append((a, b, width))

    def dist_to_runway(x, z):
        best = 1e9
        for a, b, wdt in runway_rects:
            ux, uz = b[0] - a[0], b[1] - a[1]
            L = math.hypot(ux, uz)
            ux, uz = ux / L, uz / L
            s = max(0, min(L, (x - a[0]) * ux + (z - a[1]) * uz))
            px, pz = a[0] + ux * s, a[1] + uz * s
            best = min(best, math.hypot(x - px, z - pz) - wdt / 2)
        return best

    # --- taxiways -------------------------------------------------------------------------------
    def simplify(q, eps=0.75):
        if len(q) < 3:
            return q
        a, b = q[0], q[-1]
        L = math.dist(a, b) or 1e-9
        dmax, imax = 0, 0
        for i in range(1, len(q) - 1):
            d = abs((b[0] - a[0]) * (a[1] - q[i][1]) - (a[0] - q[i][0]) * (b[1] - a[1])) / L
            if d > dmax:
                dmax, imax = d, i
        if dmax <= eps:
            return [a, b]
        return simplify(q[: imax + 1], eps)[:-1] + simplify(q[imax:], eps)

    taxi_lines = []
    n = 0
    for w in ways:
        t = w.get("tags", {})
        if t.get("aeroway") not in ("taxiway", "taxilane"):
            continue
        q = simplify(poly(w))
        if len(q) < 2:
            continue
        n += 1
        try:
            width = float(t.get("width", cfg["taxiwayWidthM"]))
        except ValueError:
            width = cfg["taxiwayWidthM"]
        width = max(8.0, min(width, 30.0))
        out["taxiways"].append({"id": f"TWY-{n}" + (f"-{t['ref']}" if t.get("ref") else ""), "widthM": width, "points": [{"worldX": r2(x), "worldZ": r2(z)} for x, z in q]})
        taxi_lines.append(q)

    def nearest_on_taxiways(x, z):
        best = (1e9, None)
        for q in taxi_lines:
            for i in range(len(q) - 1):
                ax, az = q[i]
                bx, bz = q[i + 1]
                ux, uz = bx - ax, bz - az
                L2 = ux * ux + uz * uz or 1e-9
                s = max(0, min(1, ((x - ax) * ux + (z - az) * uz) / L2))
                px, pz = ax + ux * s, az + uz * s
                d = math.hypot(x - px, z - pz)
                if d < best[0]:
                    best = (d, (px, pz))
        return best

    # --- paved polygons -------------------------------------------------------------------------
    paved_polys = []
    for w in ways:
        t = w.get("tags", {})
        kind = {"apron": "apron", "blast_pad": "blast_pad", "stopway": "stopway"}.get(t.get("aeroway"))
        if not kind:
            continue
        q = poly(w)
        if len(q) >= 3 and math.dist(xz(w["geometry"][0]), xz(w["geometry"][-1])) < 0.5:
            pts_ = q
        else:
            # A line (e.g. a stopway drawn as a centreline): pave it as a strip the runway's width.
            a, b = q[0], q[-1]
            ux, uz = b[0] - a[0], b[1] - a[1]
            L = math.hypot(ux, uz) or 1
            nx, nz = -uz / L * cfg["runwayWidthM"] / 2, ux / L * cfg["runwayWidthM"] / 2
            pts_ = [(a[0] + nx, a[1] + nz), (b[0] + nx, b[1] + nz), (b[0] - nx, b[1] - nz), (a[0] - nx, a[1] - nz)]
        out["aprons"].append({"id": f"{kind.upper().replace('_', '-')}-{len(out['aprons']) + 1}", "kind": kind, "points": [{"worldX": r2(x), "worldZ": r2(z)} for x, z in pts_]})
        paved_polys.append(pts_)

    # --- oriented boxes of mapped buildings ------------------------------------------------------
    def obb(q):
        best = None
        for i in range(len(q)):
            ax, az = q[i]
            bx, bz = q[(i + 1) % len(q)]
            L = math.hypot(bx - ax, bz - az)
            if L < 1e-6:
                continue
            ux, uz = (bx - ax) / L, (bz - az) / L
            us = [x * ux + z * uz for x, z in q]
            vs = [-x * uz + z * ux for x, z in q]
            area = (max(us) - min(us)) * (max(vs) - min(vs))
            if best is None or area < best[0]:
                cu, cv = (max(us) + min(us)) / 2, (max(vs) + min(vs)) / 2
                cx, cz = cu * ux - cv * uz, cu * uz + cv * ux
                du, dv = max(us) - min(us), max(vs) - min(vs)
                # Long axis direction (lengthM runs along it).
                lx, lz = (ux, uz) if du >= dv else (-uz, ux)
                best = (area, cx, cz, min(du, dv), max(du, dv), lx, lz)
        return best[1:]

    structures = out["structures"]
    shelters = []

    def add_structure(kind, x, z, hdg, w, l, h, group=None, prefix=None):
        s = {"id": f"{(prefix or kind).upper().replace('_', '-')}-{len(structures) + 1}", "kind": kind, "worldX": r2(x), "worldZ": r2(z),
             "headingRad": round(hdg % (2 * math.pi), 5), "widthM": r2(w), "lengthM": r2(l), "heightM": r2(h)}
        if group:
            s["group"] = group
        structures.append(s)
        return s

    def facing_taxiway(cx, cz, lx, lz, l):
        """Heading of the long-axis end nearer the taxi network (a shelter's or hangar's doors)."""
        d_plus = nearest_on_taxiways(cx + lx * l / 2, cz + lz * l / 2)[0]
        d_minus = nearest_on_taxiways(cx - lx * l / 2, cz - lz * l / 2)[0]
        sx, sz = (lx, lz) if d_plus <= d_minus else (-lx, -lz)
        return heading(0, 0, sx, sz), sx, sz

    used = set()
    for w in ways:
        t = w.get("tags", {})
        q = poly(w)
        if len(q) < 3:
            continue
        is_has = t.get("bunker_type") == "hardened_aircraft_shelter" or t.get("building") == "hardened_aircraft_shelter" or (key == "shahbaz" and t.get("building") == "hangar")
        if is_has:
            cx, cz, wd, ln, lx, lz = obb(q)
            hdg, sx, sz = facing_taxiway(cx, cz, lx, lz, ln)
            shelters.append((cx, cz, wd, ln, hdg, sx, sz))
            used.add(w["id"])
        elif t.get("bunker_type") == "pillbox" or t.get("military") == "bunker":
            cx, cz, wd, ln, lx, lz = obb(q)
            hdg, _, _ = facing_taxiway(cx, cz, lx, lz, ln)
            add_structure("magazine", cx, cz, hdg, wd, ln, 6, "munitions")
            used.add(w["id"])
        elif t.get("aeroway") == "hangar":
            cx, cz, wd, ln, lx, lz = obb(q)
            if wd >= 25:
                # Hangar doors on a long side facing the taxi network: widthM along the doors.
                ax, az = -lz, lx
                d1 = nearest_on_taxiways(cx + ax * wd / 2, cz + az * wd / 2)[0]
                d2 = nearest_on_taxiways(cx - ax * wd / 2, cz - az * wd / 2)[0]
                fx, fz = (ax, az) if d1 <= d2 else (-ax, -az)
                add_structure("hangar", cx, cz, heading(0, 0, fx, fz), ln, wd, max(10, min(18, 7 + wd * 0.12)), "technical")
            else:
                add_structure("building", cx, cz, heading(0, 0, lx, lz), wd, ln, 7, "technical")
            used.add(w["id"])
        elif t.get("aeroway") == "tower":
            cx, cz, wd, ln, lx, lz = obb(q)
            add_structure("building", cx, cz, heading(0, 0, lx, lz), wd, ln, 8, "atc")
            add_structure("control_tower", cx + lx * (ln / 2 - 5), cz + lz * (ln / 2 - 5), heading(0, 0, lx, lz), 8, 8, 24, "atc")
            used.add(w["id"])
        elif t.get("aeroway") == "terminal":
            cx, cz, wd, ln, lx, lz = obb(q)
            add_structure("building", cx, cz, heading(0, 0, lx, lz), wd, ln, 10, "terminal")
            used.add(w["id"])
        elif t.get("man_made") == "water_tower":
            cx, cz, wd, ln, lx, lz = obb(q)
            add_structure("water_tower", cx, cz, 0, max(wd, 8), max(wd, 8), 22, "utilities")
            used.add(w["id"])

    # --- the base boundary: the aerodrome / military area around the runways ---------------------
    def point_in(q, x, z):
        inside = False
        for i in range(len(q)):
            ax, az = q[i]
            bx, bz = q[i - 1]
            if (az > z) != (bz > z) and x < (bx - ax) * (z - az) / (bz - az) + ax:
                inside = not inside
        return inside

    cx0 = sum(x for a, b, _ in runway_rects for x in (a[0], b[0])) / (2 * len(runway_rects))
    cz0 = sum(z for a, b, _ in runway_rects for z in (a[1], b[1])) / (2 * len(runway_rects))
    boundary = None
    for w in ways:
        t = w.get("tags", {})
        if t.get("aeroway") == "aerodrome" or t.get("landuse") == "military":
            q = poly(w)
            if len(q) >= 3 and point_in(q, cx0, cz0):
                if boundary is None or len(q) > len(boundary):
                    boundary = q

    # On-base buildings (cantonment, messes, stores): inside the boundary, not paved, not near runways.
    for w in ways:
        t = w.get("tags", {})
        if w["id"] in used or not t.get("building") or t.get("aeroway"):
            continue
        q = poly(w)
        if len(q) < 3:
            continue
        cx, cz, wd, ln, lx, lz = obb(q)
        if wd * ln < 40 or (boundary and not point_in(boundary, cx, cz)) or dist_to_runway(cx, cz) < 150:
            continue
        add_structure("building", cx, cz, heading(0, 0, lx, lz), max(wd, 5), max(ln, 5), 9 if wd * ln > 1500 else 6, "cantonment")

    # --- shelters: the shelter, its pad, a spur taxiway if the map has none, a parking spot -------
    for i, (cx, cz, wd, ln, hdg, sx, sz) in enumerate(shelters):
        grp = "dispersal"
        s = add_structure("shelter", cx, cz, hdg, wd, ln, cfg["shelterHeightM"], grp, "has")
        door_x, door_z = cx + sx * ln / 2, cz + sz * ln / 2
        # Pad: under the shelter and 30 m out in front of the door.
        px, pz = -sz, sx
        hw = wd / 2 + 3
        back_x, back_z = cx - sx * ln / 2, cz - sz * ln / 2
        front_x, front_z = door_x + sx * 30, door_z + sz * 30
        pad = [(back_x + px * hw, back_z + pz * hw), (front_x + px * hw, front_z + pz * hw), (front_x - px * hw, front_z - pz * hw), (back_x - px * hw, back_z - pz * hw)]
        out["aprons"].append({"id": f"SHELTER-PAD-{i + 1}", "kind": "shelter_pad", "points": [{"worldX": r2(x), "worldZ": r2(z)} for x, z in pad]})
        d, near = nearest_on_taxiways(front_x, front_z)
        if near is not None and 8 < d < 350:
            out["taxiways"].append({"id": f"TWY-HAS-{i + 1}", "widthM": 15, "points": [{"worldX": r2(front_x - sx * 5), "worldZ": r2(front_z - sz * 5)}, {"worldX": r2(near[0]), "worldZ": r2(near[1])}]})
        out["parkingSpots"].append({"id": f"HAS-{i + 1}", "worldX": r2(cx), "worldZ": r2(cz), "headingRad": round(hdg, 5), "type": "fighter"})

    # --- generic facilities ---------------------------------------------------------------------
    occupied = []  # (x, z, radius)
    for s in structures:
        occupied.append((s["worldX"], s["worldZ"], max(s["widthM"], s["lengthM"]) * 0.6))
    for q in paved_polys:
        mx = sum(x for x, _ in q) / len(q)
        mz = sum(z for _, z in q) / len(q)
        occupied.append((mx, mz, max(math.dist((mx, mz), p) for p in q)))

    def clear_spot(radius, prefer_x, prefer_z, min_runway=300, max_from=2200):
        """The free spot nearest the preferred point (inside the base, off every surface and structure)."""
        best = None
        for gz in range(-60, 61):
            for gx in range(-60, 61):
                x, z = cx0 + gx * 40, cz0 + gz * 40
                if math.hypot(x - cx0, z - cz0) > max_from:
                    continue
                if boundary and not point_in(boundary, x, z):
                    continue
                if dist_to_runway(x, z) < min_runway + radius:
                    continue
                if nearest_on_taxiways(x, z)[0] < radius + 40:
                    continue
                if any(math.hypot(x - ox, z - oz) < radius + orad + 25 for ox, oz, orad in occupied):
                    continue
                d = math.hypot(x - prefer_x, z - prefer_z)
                if best is None or d < best[0]:
                    best = (d, x, z)
        if best is None:
            raise SystemExit(f"no clear spot of radius {radius}")
        occupied.append((best[1], best[2], radius))
        return best[1], best[2]

    rwy_hdg = out["runways"][0]["headingRad"]
    main_apron = max((a for a in out["aprons"] if a["kind"] == "apron"), key=lambda a: len(a["points"]) and abs(
        sum(p["worldX"] * q["worldZ"] - q["worldX"] * p["worldZ"] for p, q in zip(a["points"], a["points"][1:] + a["points"][:1])) / 2), default=None)
    ax_, az_ = (sum(p["worldX"] for p in main_apron["points"]) / len(main_apron["points"]), sum(p["worldZ"] for p in main_apron["points"]) / len(main_apron["points"])) if main_apron else (cx0, cz0)
    # Which side of the runway the apron is on: facilities go further out on that side.
    side_x, side_z = math.cos(rwy_hdg), math.sin(rwy_hdg)
    if (ax_ - cx0) * side_x + (az_ - cz0) * side_z < 0:
        side_x, side_z = -side_x, -side_z

    # Control tower (generated where the map has none): beside the main apron, away from the runway.
    if cfg["tower"] == "generate":
        tx, tz = clear_spot(12, ax_ + side_x * 180, az_ + side_z * 180, min_runway=200)
        add_structure("control_tower", tx, tz, rwy_hdg, 8, 8, 24, "atc")
        add_structure("building", tx + side_x * 20, tz + side_z * 20, rwy_hdg, 14, 30, 7, "atc")

    # Fuel depot: four tanks in an earth bund, a pump house.
    fx, fz = clear_spot(55, ax_ + side_x * 700, az_ + side_z * 700, min_runway=450)
    add_structure("fuel_bund", fx, fz, rwy_hdg, 70, 70, 2.5, "fuel-depot")
    ux, uz = math.sin(rwy_hdg), -math.cos(rwy_hdg)
    for i, (a, b) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        add_structure("fuel_tank", fx + (a * ux + b * side_x) * 15, fz + (a * uz + b * side_z) * 15, 0, 16, 16, 11, "fuel-depot")
    add_structure("building", fx + side_x * 55, fz + side_z * 55, rwy_hdg, 10, 16, 5, "fuel-depot")

    # Munitions: earth-covered magazines in two staggered rows, well away from everything else.
    mags = [s for s in structures if s["kind"] == "magazine"]
    mx0, mz0 = (mags[0]["worldX"], mags[0]["worldZ"]) if mags else (cx0 - side_x * 1100, cz0 - side_z * 1100)
    for i in range(6 if not mags else 4):
        x, z = clear_spot(22, mx0 + (i % 3) * 90 * ux, mz0 + (i % 3) * 90 * uz + (i // 3) * 90, min_runway=500)
        add_structure("magazine", x, z, rwy_hdg, 14, 24, 6, "munitions")

    # Surveillance radar.
    rx, rz = clear_spot(15, cx0 + side_x * 1200 + ux * 900, cz0 + side_z * 1200 + uz * 900, min_runway=400)
    add_structure("radar", rx, rz, 0, 8, 8, 14, "radar")

    # --- flatten zone covering everything ---------------------------------------------------------
    far = 0
    for s in structures:
        far = max(far, math.hypot(s["worldX"] - cx0, s["worldZ"] - cz0) + max(s["widthM"], s["lengthM"]))
    for r in out["runways"]:
        far = max(far, math.hypot(r["thresholdWorldX"] - cx0, r["thresholdWorldZ"] - cz0) + 400)
    for a in out["aprons"] + out["taxiways"]:
        for p in a["points"]:
            far = max(far, math.hypot(p["worldX"] - cx0, p["worldZ"] - cz0) + 30)
    out["flattenZones"] = [{"centerWorldX": r2(cx0), "centerWorldZ": r2(cz0), "elevationM": elev, "flatRadiusM": round(far + 50), "blendRadiusM": 900}]

    path = os.path.join(ROOT, "src", "airport", "layouts", f"{cfg['id']}.json")
    json.dump(out, open(path, "w"), indent=1)
    kinds = {}
    for s in structures:
        kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
    print(f"{cfg['id']}: {len(out['runways'])} runway ends, {len(out['taxiways'])} taxiways, {len(out['aprons'])} paved areas, "
          f"{len(out['parkingSpots'])} shelter spots, structures {kinds}, flat radius {out['flattenZones'][0]['flatRadiusM']} m -> {path}")


if __name__ == "__main__":
    for k in sys.argv[1:] or list(CONFIG):
        main(k)
