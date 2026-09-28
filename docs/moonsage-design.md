# moonsage homepage

The entry page uses the console's colors, type and controls. A small native SVG keeps the moonrise motif without a large photographic background or slogan.

| Route | Purpose |
| --- | --- |
| `/` | Brand home; fixed content, no management-agent calls |
| `/?lang=en` | English home only; the console remains Chinese |
| `/overview/` | Existing authenticated console |

Repository, CLI, service names, authentication, private-network access and proxy/DNS configuration remain unchanged. The eight lights are decorative, not live node status. Existing console deep links still work.

## Current design

- [Shared theme tokens](../web/static/moonsage/theme.css): one color/font source for home, login and console.
- [Inline SVG scene](../web/templates/dashboard/_moon_scene.html): crisp at any display density; four sky nodes and four water nodes, no blur filters.
- One primary action, **Open console**, with **Get started** alongside it; three existing feature links below.
- One sky-blue palette with **Light / Dark** modes. `theme.js` shares the `server-kit-theme` preference and migrates the old `sky` choice to `light`. Chinese/English navigation works without JavaScript; the default is light. Status colors retain their meaning.
- No polling, external fonts, analytics, image hosts or raster background downloads.

All assets use the existing locally served, hashed static-asset pipeline. The repository, CLI and service identifiers are unchanged.

## Archived photographic design

The earlier imagegen backgrounds below are kept for design history. **Home and login no longer load them.**

| Asset | Size | Composition |
| --- | --- | --- |
| [Desktop](../web/static/moonsage/hero-sea.webp) | 1672 × 941 · 147 KB | Landscape |
| [Phone](../web/static/moonsage/hero-sea-mobile.webp) | 941 × 1672 · 200 KB | Portrait, up to 3:4 |
| [Tablet](../web/static/moonsage/hero-sea-tablet.webp) | 1254 × 1254 · 211 KB | Square, up to 5:4 |

## Local checks

Use synthetic data only:

```bash
python3 tests/run_web_preview.py --port 8873
node tests/run_home_ui.cjs http://127.0.0.1:8873/
node tests/run_login_ui.cjs http://127.0.0.1:8873/
node tests/run_web_visual_audit.cjs http://127.0.0.1:8873/
```

The browser scripts need Playwright and its Chromium/WebKit browsers. Dependencies and preview details: [preview guide](../tests/preview_README.md).

## Archived image prompts

<details>
<summary>Desktop · remove baked-in UI from the approved image</summary>

```text
Use case: precise-object-edit
Asset type: clean image background for the approved moonsage homepage.
Input image 1: edit target, an approved web mockup. It is NOT a style reference to reimagine.
Primary request: remove ONLY the overlaid website interface: upper-left crescent/network logo and 'moonsage' wordmark; upper-right language label, outlined button and its text; bottom row of all three small icons and all three text captions. Reconstruct seamless underlying night sky in the header areas and natural continuous ocean wave texture in the footer areas. Output a clean full-bleed scene without any interface.
Invariants: keep the original exact widescreen framing, perspective, horizon at the middle, the very large centered full moon with its bottom touching the sea horizon, all cloud formations, navy palette, moonlight reflection path, detailed natural waves, and all EIGHT luminous nodes in their original positions and sizes. Exactly FOUR soft sky points and FOUR medium-size clean white cores directly half-submerged in the sea with their original broken water reflections. The four sea cores must remain smooth light nodes, not textured planets, with no poles, rods, supports or levitation gaps. Do not shrink, enlarge, move, add or remove the moon or any of the eight scene nodes.
Constraints: no text, no logos, no icons, no buttons, no outlines, no UI, no connection lines, no watermark. Do not redesign or recolor the image. Keep high visual clarity and natural atmospheric softness; no global blur, no jagged sharpening, no crunchy cloud/water edges. Change only the existing UI overlay pixels and immediate background repair around those pixels.
```

</details>

<details>
<summary>Phone · portrait companion</summary>

```text
Use case: precise-object-edit
Asset type: portrait mobile responsive companion background to the supplied approved desktop moonsage hero.
Input Image 1: edit target, approved clean seascape. Reframe/recompose to a VERTICAL 9:16 aspect ratio, not a simple center crop: retain all elements in a portrait composition.
Primary request: make the same dark navy, photorealistic moonrise ocean scene suitable for a phone while preserving its exact calm visual language. Full moon centered horizontally, diameter approximately 22% of image width; its lower edge touches and is slightly hidden behind the ocean horizon at 48% image height. Keep natural large side clouds and a physically coherent moonlight path coming toward camera.
Count and scale: exactly FOUR softly glowing small sky nodes and exactly FOUR medium-sized clean white luminous sea nodes, all fully visible inside the portrait frame. Irregular positions, different heights and depth, not aligned or symmetrical. Sky node positions roughly x22% y19%, x76% y25%, x38% y32%, x83% y40%, gently integrated into atmospheric clouds. Water nodes in irregular depth, roughly x25% y61%, x74% y68%, x39% y79%, x79% y84%. Their luminous core diameters range 2% to 3.3% of image width by distance, clearly visible yet smaller than the moon. Each water core directly floats ON the surface, its lower part naturally occluded by a wave, with subtle fragmented realistic reflections in surrounding water. Smooth clean white light, not patterned spheres or planets. No rods, no supports, no stakes, no floating above the surface, no vertical gap.
Layout constraint: the top 12% remains spacious dark sky suitable for real webpage navigation; bottom 12% remains uninterrupted dark ocean suitable for real navigation. This image itself must have absolutely NO UI, text, icons, logos, lines or buttons.
Invariants: preserve original navy palette, natural moon/cloud/wave lighting and smooth detail; no artificial jagged sharpness, no global blur. The scene must unmistakably express the moon rising out of the sea, not a small moon high overhead.
Avoid: boat, people, extra moons, extra stars, extra light nodes, support poles, water planets, constellation connection lines, ornamental graphics, interface, labels, watermark.
```

</details>

<details>
<summary>Tablet · square companion</summary>

```text
Use case: precise-object-edit. Asset type: square responsive tablet companion background for the approved moonsage homepage. Input image 1 is the edit target, an approved portrait ocean moonrise scene. Recompose ONLY the aspect ratio to SQUARE 1:1 while keeping its dark navy photographic style, natural moon, atmospheric clouds, ocean wave details and coherent reflection lighting. Full moon centered with diameter 18% of image width, bottom edge touches and is slightly hidden by the sea horizon at 48% of frame height; unmistakably moon rising from the ocean. Exactly FOUR softly glowing sky nodes, and exactly FOUR medium smooth white light nodes directly drifting partly submerged on sea surface. Distribute asymmetrically inside x18% to x82% so all remain visible if modestly cropped for tablet. Sky points around (20%,22%),(40%,30%),(72%,17%),(80%,37%); water points around (22%,61%),(65%,57%),(42%,75%),(78%,72%). Sea nodes sizes 1.6%-2.7% of frame width and naturally broken moonlit reflections; no planets, textures, rods, vertical supports, hovering gaps. Top 13% and bottom 14% clear for real webpage navigation. Do not add any text, logo, lines, labels, UI, people, boat, watermark or extra stars/nodes. High clarity but smooth naturally lit water and sky, no jagged sharpening or whole image blur. Same visual world as reference, only responsive composition.
```

</details>
