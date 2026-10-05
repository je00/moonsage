# Local visual review

Use a Python environment with the dependencies in `web/requirements.txt`:

```sh
python tests/run_web_preview.py
```

Open <http://127.0.0.1:8765/__preview__/>.
Sign in with **preview / Preview-only-2026!**. A read-only account, **viewer**,
uses the same demo password. These are local demo credentials only.

The index lists every main page, all service details, eight task states and
thirteen confirmation variants. Fixtures include long names, port ranges,
IPv6, disabled nodes, errors, empty lists and rollback countdowns.

```sh
python tests/run_web_preview.py --check
python tests/run_web_preview.py --port 8766 --scenario empty
python tests/run_web_preview.py --port 8767 --scenario error
python tests/run_web_preview.py --port 8768 --scenario pending
python -m unittest discover -s tests -p test_web_preview.py
```

Optional repeatable browser audit (install Playwright and Chromium in a local
development environment, not on the VPS):

```sh
node tests/run_web_visual_audit.cjs http://127.0.0.1:8765/
node tests/run_network_button_layout_ui.cjs http://127.0.0.1:8765/
node tests/run_service_buttons_ui.cjs http://127.0.0.1:8765/
node tests/run_management_layout_ui.cjs http://127.0.0.1:8765/
node tests/run_mobile_render_ui.cjs http://127.0.0.1:8765/
node tests/run_login_ui.cjs http://127.0.0.1:8765/
node tests/run_exit_edit_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_ui.cjs http://127.0.0.1:8765/
node tests/run_telemetry_ui.cjs http://127.0.0.1:8765/
node tests/run_subscription_rules_ui.cjs http://127.0.0.1:8765/
```

It signs in with the demo account, captures the preview route inventory at 320, 390, 768 and
1440 pixels, checks page overflow, headings and button bounds, and writes PNGs plus `report.json`
to a new temporary directory. All non-preview-origin requests are blocked.
Inspect screenshots too: automated checks cannot judge visual hierarchy.

The custom-rule suite checks the standalone **直连与 DNS** page, desktop/mobile
navigation, read-only access, batch save/delete, draft cancellation and same-page
completion in Chromium and WebKit. Rule data and tasks are synthetic and in-memory.

The three button-layout suites also use WebKit and expanded forms. They cover
confirmation pages, task states, rollback previews and short-screen dialogs,
including scrolling controls into view and checking their actual click targets.
Run them sequentially or on separate preview ports: service and management
suites switch synthetic scenarios. They never execute management tasks.
The management suite needs the Python dependencies above; set
`MANAGEMENT_TEST_PYTHON` if that Python is not the default `python3`.

The mobile rendering regression also needs WebKit. It checks each theme button
against its own container (not just page overflow), distinguishes the current
page from an expanded More menu, and exercises short viewports, menu scrolling,
theme changes, and the login theme picker. Fixtures and screenshots stay local.

The login regression uses Chromium and WebKit: normal and deep-link login,
duplicate submits, stale tabs after CSRF rotation, and safe GET-only recovery.
Anonymous, cross-origin and non-login invalid forms must still return 403.
It records synthetic screenshots and cookie-change booleans, never cookie values.

The exit-editor regression uses Chromium and WebKit at 320, 390 and 1440 pixels.
It checks rename-only saves, on-demand authentication, lossless SOCKS5 editing,
advanced YAML, draft cancellation, late-response races, credential clearing and
same-page task completion. Use a dedicated preview port: each case resets the
synthetic scenario. Revealed configurations and credentials are synthetic; the
fake agent never retains submitted proxy credentials. Add `--races-only` to
repeat the concurrency, lossless-input, retained-card and pagehide cases alone.

The topology audit checks every node on one canvas: a quiet VPS overview first,
then one node's incoming or outgoing permissions with complete ports in the
inspector. It covers leaf dragging, fixed-center rotation, search, keyboard selection, and stale
or failed responses. Realistic 12-node fixtures check readability alongside
dense-graph performance. Layout changes stay in the browser; no network
settings are changed. All fixtures are synthetic; enabled is not proven online.

The spatial view is now 3D only: the VPS stays centered at native scale 1.
Removed 2D, pan, fit and zoom tests are replaced by explicit absence checks,
ignored wheel/Ctrl-wheel/+/-/pinch inputs, immutable VPS position, leaf-only
pointer/Alt-key movement, orbit keys and one-click auto-arrange. Direction-arrow
buttons are absent; shared visual helpers use actual keyboard input. The old
permission, full port scopes, arrow direction, failed/stale request, cancellation,
read-only and mobile page-scroll assertions remain active.

```sh
node tests/run_topology_3d_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_permissions_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_crisp_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_style_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_cosmos_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_motion_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_moon_ui.cjs
node tests/run_topology_selection_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_portrait_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_refinement_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_badges_ui.cjs http://127.0.0.1:8765/
node tests/run_topology_touch_ui.cjs http://127.0.0.1:8765/
node tests/run_theme_default_ui.cjs http://127.0.0.1:8765/
```

These use Chromium/WebKit and synthetic 6/12/41-node models; the cosmos matrix
captures 36 size/theme/count scenes (108 images). It requires `pngjs` alongside
Playwright to sample actual painted text, moon, target-frame and route contrast.
Native browser accessibility pinch zoom remains allowed; scene scale must not
change. True touch injection uses Chromium CDP; WebKit checks the pointer
lifecycle/CSS contract without claiming synthetic events are native gestures.
The theme audit verifies dark defaults without a saved preference, preserves
explicit choices, and checks fallback with JavaScript or storage unavailable.

Motion checks require normal-motion contexts: a recent desktop canvas drag or
horizontal touch swipe coasts briefly, with bounded decay and no idle animation loop. New interaction,
cancellation, hidden pages and reduced-motion changes stop it immediately.
Slow/medium/fast mouse tracks must increase both release speed and stopping
time; 8/16/33 ms input cadence must describe the same physical motion.
Incoming-source arrows separately mark the path through the VPS, never a new
VPS permission. `run_topology_ui.cjs --arrow-smoke` isolates direction checks.
Blue lines/arrows mean leaf → VPS; amber means VPS → leaf, independent of node
type. VPS selection opens confirmed incoming permissions. Its outgoing list
shows every real status, including unknown, without inventing allowed peers.
The focused refinement audit checks the two-entry legend above the canvas,
accessible hidden hints, retained detail caveats, lunar rim and short ripples;
it keeps 4.5:1 text and 3:1 flow/contour contrast on desktop and phone.
The badge audit checks full-width titles without extra card height, leaf tabs
within 6 px of the top edge, unchanged lunar labels, and no own-arrow collision.
Chromium/WebKit cover 1440/390/320 px, both themes, real tab click/drag,
rotation bounds and native Chromium phone scrolling. Both focused audits use
page-scoped synthetic JSON and never reset a shared preview fixture.
The focused touch suite covers 320/390 px in both engines and themes. Vertical
canvas/VPS swipes scroll; clear horizontal swipes rotate yaw only. Ambiguous
diagonal gestures never switch to rotation midway. Editing unlocks leaf dragging.
It checks intent before capture, multi-touch cancellation, reduced motion,
tap selection and desktop two-axis dragging without resetting the fixture.
Blank clicks/taps clear selection, URL and details without changing the layout;
drag releases, scrolling and cancelled/multi-touch gestures must not clear it.
The selection suite also rejects late requests after clearing or reselection.
The portrait suite checks 320/390/768 px, 6/12/41 nodes, native text sizes,
compact height limits, full port scopes, rotation bounds and saved dragging.
An optional `--baseline-ref <local-revision> --measure-only` compares identical
fixtures against an explicitly selected local revision, without checking it out.
Moon geometry tests verify spherical orientation, near/far clipping and exact
360-degree closure in both engines. All node states use real camera depth;
actual hit tests prove that front leaves cover the VPS and rear leaves do not.
Contrast audits keep 4.5:1 text and 3:1 frame/route thresholds, record samples
occluded by nearer opaque nodes, and test all remaining visible samples.

The telemetry audit checks AWG and VLESS rates, unavailable labels, expiry,
single-flight polling, hidden-page suspension and configuration-cache races in
Chromium and WebKit. Rates are synthetic; no production collector is invoked.

The default rich scenario renders 42 review routes. Use the index to reset or
switch scenarios; this resets every tab attached to that instance, so use a
separate port for simultaneous reviews. Static files and templates reflect
edits on reload. Restart the preview to pick up Python code changes.

Safety boundaries:

- Binds only `127.0.0.1`; no configurable external listener.
- Creates a new private temporary SQLite database, upload area and fake-agent
  socket; inherited production state/socket/secret paths are overridden.
- Uses synthetic `example` domains, documentation addresses and in-memory
  task results. Never imports a host command runner or contacts a VPS.
- Unknown agent actions fail closed. Confirming a form only changes fixtures
  in memory; account and upload actions affect temporary preview state only.
- Fixture routes are selected only by this launcher, not production settings.
- Temporary state is removed on normal exit. Do not enter real credentials
  or upload real sensitive files in a demo environment.
