# C-17 Globemaster III: Indian Air Force livery

What the game's C-17 (public/models/c17.glb) wears and why. The paint is built procedurally by
`tools/models/livery_c17.py` (run inside `tools/models/build_c17.py`). No photographs are in the repo.

## The real aircraft (from public photographs)

The IAF operates 11 C-17A Globemaster IIIs, CB-8001 to CB-8011, with No. 81 Squadron "Skylords" at
Hindon (AFS Hindan, Ghaziabad). The squadron formed on 1 Sep 2013, and CB-8011 was delivered in 2019.

| Item | Real aircraft | Game |
|---|---|---|
| Overall colour | One medium grey all over, the standard C-17 paint (FS 36173 "AMC Gray"). No camouflage, no antiglare panel. | `PAINT_IAF` (112, 120, 127) ~ #70787F, the FS 595 chip value, hue-matched over the source's slate blue (`repaint`) |
| Radome | Grey like the fuselage | The source's dark blue radome recoloured to the grey |
| Engine nacelles | Grey, with bare-metal inlet lips | Unchanged (already repainted grey) |
| Hindi title | "भारतीय वायु सेना" in black on the **left** forward fuselage, from ~4.4 m behind the nose, level with the flight-deck windows, ~7.3 m long | Nirmala UI Bold, 6.8 m x 0.84 m ink box at x 15.5..22.3, z 6.1..7.0 (shortened to clear this model's wing-root fairing) |
| English title | "INDIAN AIR FORCE" in black sans-serif capitals on the **right** forward fuselage, ending ~4.6 m behind the nose, ~6.4 m long, ~0.5 m caps | Bahnschrift SemiBold (a DIN face), 6.4 m x 0.52 m at x 15.4..21.8, z 6.4..6.9 |
| Yellow strip under each title, aft fuselage, fin | The formation lights | Kept from the source |
| Fuselage roundel | Saffron / white / green, aft of the wing, a little above mid-height, both sides, ~1.35 m | 1.35 m at x -10.9, z 6.45 (over the source's old insignia ring, which is erased) |
| Wing roundels | Small roundel on the upper surface of each outer wing | 1.3 m at x 1.4, \|y\| 17.5 (the source's wing-tip insignia ring is erased). Undersides: not confirmed by the photos used, so none |
| Fin flash | Vertical tricolour, **green at the leading edge**, white, saffron aft, on both sides, ~1.2 x 0.8 m, low on the fin forward of the yellow rudder-hinge dashes | 1.2 x 0.8 m at x -15.4, z 10.66, green forward on both sides |
| Serial | "CB-80xx" in black, high on the fin forward of the rudder, both sides, ~0.45 m characters | "CB-8002", Bahnschrift SemiBold, 2.1 x 0.45 m at x -19.1, z 14.1 |
| Squadron badge | None seen on the fin or the nose | None |
| Stencils, walkways | Small technical stencils and wing walkway lines | The source's generic ones kept; its "AIR FORCE" nose titles (which read mirrored on the left) and its national-insignia rings erased |

Coordinates are the built model's (Blender axes): x forward from the centre, y left, z up from the
wheel bottoms, in metres. The model is 53.04 m long, so the nose is at x 26.44.

**Roundel proportions.** The IAF roundel is three concentric discs in the national colours: saffron outside,
then white, then a green centre. Sources disagree on the ring widths (1:1:1:1:1 vs 1:1:2:1:1 across the
diameter). The photos fit equal ring widths best, so the diameters are 1 : 2/3 : 1/3. Colours are India
saffron #FF9933, white and India green #138808.

**Fin flash orientation.** Flags of the World describes the post-1948 IAF flash as "green-white-saffron
vertically divided, green at front", in a 2:3 ratio. The photos confirm green leads on both sides. Bharat
Rakshak's "saffron towards the leading edge" describes the 1947–48 Chakra-era markings.

## How it is painted (tools/models/livery_c17.py)

- Each marking is a 2D shape (text drawn with PIL, roundel and flash computed per sample) placed on
  the model in metres. The painter rasterises the airframe's triangles in texture space. For each
  texel it computes the 3D point (4x4 supersampled) and projects it onto the marking's plane (sideways
  for the fuselage and fin, down for the wings). Curvature, UV rotation, UV scale and mirroring are
  handled by that projection, not by hand.
- **Mirrored UVs.** The source maps the left side onto the right side's texture, with every island shared and
  mirrored. Symmetric marks (roundels, and the fin flash with green forward on both sides) are painted
  once into the shared texture and appear correctly on both sides. The titles and serials differ by side.
  `blender_c17.py` (`livery_cut`) bisects each one's patch of skin out of the shared island along a box
  around the text (0.22 m margin), on that side only. `livery_atlas` then moves each patch's UV islands,
  uniformly scaled, into the spare atlas rect (3072, 2560, 1024 x 512 base-colour px) at about 76 px/m.
  The native density there is 31–44 px/m. Before painting, the painter copies the texture under each
  island's old rect to its new one, for all three maps, so the patch is seamless. The normal map keeps
  its tangent frame because the move is a translation and a uniform scale. Normals of the cut faces are
  restored from the uncut surface, as for the rudder and elevator cuts.
- **Devanagari.** Pillow on this machine has no libraqm, so text uses basic layout. "भारतीय वायु सेना" needs no
  reordering (no pre-base ि) and no conjuncts. Its matras (ा ी ु े) are mark or spacing glyphs that
  Nirmala UI positions correctly without GPOS, as checked in the renders. A different text with ि or
  conjuncts would need a shaping engine.
- The build is reproducible. Two runs give the same GLB hash.

## Gaps

- Underwing roundels and the small nose-gear-door serial are not painted (not confirmed by the photos used).
- The titles' and serials' texture is ~76 px/m: sharp at normal viewing distances, a little soft in
  close-ups. More would need more free atlas space.
- In the game the whole C-17 still renders darker than the photos under some lighting. That is the
  shader's look for this model (an open item from before), not the paint value.

## Sources

- Wikimedia Commons, [Category: Boeing C-17 Globemaster III of the Indian Air Force](https://commons.wikimedia.org/wiki/Category:Boeing_C-17_Globemaster_III_of_the_Indian_Air_Force).
  Used: CB-8002 (left side, Bordeaux), CB-8001 nose and tail close-ups (Long Beach), CB-8001 left side,
  CB-8008 left three-quarter (RAF Waddington), CB-8010 right side (Stansted), CB-8004 and CB-8006 left
  side, and "IAF-C-17 touchdown" (Edwards AFB, first delivery). Viewed for measurement only.
- AirHistory.net, [CB-8001](https://www.airhistory.net/registration/CB-8001): serial range CB-8001..CB-8010
  (first batch), operated by 81 Sqn "Skylords", Hindon.
- Edwards AFB, [Air Force delivers last C-17 to India](https://www.edwards.af.mil/News/Article/1945802/air-force-delivers-last-c-17-to-india/).
- Joint Base Charleston, [Indian Air Force receives first C-17](https://www.jbcharleston.jb.mil/News/Article/233136/indian-air-force-receives-first-c-17).
- Bharat Rakshak, [Roundels (Independence and Chakra)](https://www.bharat-rakshak.com/IAF/heraldry/roundels/roundels47/):
  the 1947–48 markings and the saffron-white-green roundel that replaced them.
- Flags of the World, [Indian Air Force](https://crwflags.com/fotw/Flags/in^af.html): roundel ring
  proportions, and the fin flash "green-white-saffron vertically divided, green at front", 2:3.
- FS 36173 colour value: [hextoral FS 595c 36173 (#70787F)](https://hextoral.com/hex-color/70787f/federal-std-595c/).
  Federal Standard tables call 36173 "AMC Gray", the Air Mobility Command transport grey.
