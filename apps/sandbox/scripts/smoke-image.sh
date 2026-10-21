#!/usr/bin/env bash
set -euo pipefail
profile="${1:-default}"
node --version
python --version
python3 -c 'import numpy; print("NumPy", numpy.__version__)'
google-chrome --version
log=$(mktemp)
COHUB_SPACE_ID=smoke-test SANDBOX_RPC_TOKEN=smoke-test-token COHUB_SEARCH_ENABLED=false \
  /opt/cohub/internal/cohub-sandbox >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; cat "$log"; rm -f "$log"' EXIT
for _ in $(seq 1 30); do
  kill -0 "$pid" 2>/dev/null || exit 1
  if curl -fsS http://localhost:8788/healthz >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://localhost:8788/healthz >/dev/null
if [[ "$profile" == game ]]; then
  godot --version
  cmake --version
  xvfb-run -a glxinfo -B
  work=$(mktemp -d)
  printf '[application]\nconfig/name="Sandbox smoke"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n' > "$work/project.godot"
  godot --headless --path "$work" --editor --import --quit
  xvfb-run -a godot --path "$work" --editor --rendering-method gl_compatibility --quit-after 5
  blender --background --factory-startup --python-exit-code 1 --python-expr "import bpy; scene=bpy.context.scene; scene.render.engine='CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=1; scene.cycles.use_denoising=False; scene.render.resolution_x=32; scene.render.resolution_y=32; scene.render.resolution_percentage=100; scene.render.image_settings.file_format='PNG'; scene.render.filepath='$work/smoke.png'; bpy.ops.wm.save_as_mainfile(filepath='$work/smoke.blend'); bpy.ops.render.render(write_still=True); bpy.ops.export_scene.gltf(filepath='$work/smoke.glb', export_format='GLB')"
  test -s "$work/smoke.blend"
  test -s "$work/smoke.png"
  test -s "$work/smoke.glb"
fi
