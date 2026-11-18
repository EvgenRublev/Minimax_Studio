// Tessera: context-sensitive widget visibility.
// Hides widgets that other settings make irrelevant, so each node reads as
// the small set of decisions that actually apply:
//   Tiled Refine V2:
//     - `plan` input wired   -> the tiling/hero geometry group hidden
//     - no hero_mask wired   -> hero widgets hidden
//     - temporal_tile off    -> temporal_overlap hidden
//     - temporal_tile!=custom -> temporal_size hidden
//     - no clip wired        -> prompt hidden (per-tile text encode off)
//   Refine Extra Options:
//     - guide_noise 0        -> guide_noise_band / guide_noise_t hidden
//     - motion_adapt off     -> motion_max_sigma hidden
//   Tile Plan V2:
//     - tile_auto on         -> tile_width / tile_height hidden
//     - no hero_mask wired   -> hero widgets hidden
import { app } from "../../scripts/app.js";

function setHidden(node, name, hidden) {
  const w = node.widgets?.find((x) => x.name === name);
  if (!w) return false;
  const was = !!w._ltxHidden;
  if (hidden && !was) {
    w._ltxHidden = true;
    w._ltxOrigType = w.type;
    w._ltxOrigComputeSize = w.computeSize;
    w.type = "hidden";
    w.hidden = true;
    w.computeSize = () => [0, -4];
    return true;
  }
  if (!hidden && was) {
    w._ltxHidden = false;
    w.type = w._ltxOrigType;
    w.hidden = false;
    w.computeSize = w._ltxOrigComputeSize;
    return true;
  }
  return false;
}

function val(node, name) {
  return node.widgets?.find((x) => x.name === name)?.value;
}

function inputWired(node, name) {
  const inp = node.inputs?.find((i) => i.name === name);
  return !!(inp && inp.link != null);
}

const GEOM = ["spatial_tile", "tile_width", "tile_height",
              "context_border", "hero_min", "hero_fit"];
const HERO = ["hero_min", "hero_fit"];

function refreshRefine(node) {
  let changed = false;
  const planWired = inputWired(node, "plan");
  const heroWired = inputWired(node, "hero_mask");
  for (const n of GEOM) changed |= setHidden(node, n, planWired);
  if (!planWired) {
    const auto = val(node, "spatial_tile") !== "custom";
    changed |= setHidden(node, "tile_width", auto);
    changed |= setHidden(node, "tile_height", auto);
  }
  for (const n of HERO)
    changed |= setHidden(node, n, planWired || !heroWired);
  const tt = val(node, "temporal_tile");
  changed |= setHidden(node, "temporal_overlap", tt === "off");
  changed |= setHidden(node, "temporal_size", tt !== "custom");
  changed |= setHidden(node, "prompt", !inputWired(node, "clip"));
  if (changed) {
    node.setSize(node.computeSize());
    node.setDirtyCanvas(true, true);
  }
}

function refreshArgs(node) {
  let changed = false;
  const gn = val(node, "guide_noise") > 0;
  changed |= setHidden(node, "guide_noise_band", !gn);
  changed |= setHidden(node, "guide_noise_t", !gn);
  changed |= setHidden(node, "motion_release_floor",
                       !val(node, "motion_adapt"));
  if (changed) {
    node.setSize(node.computeSize());
    node.setDirtyCanvas(true, true);
  }
}

function refreshPlan(node) {
  let changed = false;
  const heroWired = inputWired(node, "hero_mask");
  const auto = val(node, "spatial_tile") !== "custom";
  changed |= setHidden(node, "tile_width", auto);
  changed |= setHidden(node, "tile_height", auto);
  const tt = val(node, "temporal_tile");
  changed |= setHidden(node, "temporal_overlap", tt === "off");
  changed |= setHidden(node, "temporal_size", tt !== "custom");
  for (const n of ["hero_min", "hero_fit"])
    changed |= setHidden(node, n, !heroWired);
  if (changed) {
    node.setSize(node.computeSize());
    node.setDirtyCanvas(true, true);
  }
}

const REFRESH = {
  TesseraRefine: refreshRefine,
  TesseraArgs: refreshArgs,
  TesseraPlan: refreshPlan,
  // legacy ids (pre-Tessera workflows)
  LTXTiledRefineV2: refreshRefine,
  LTXRefineArgs: refreshArgs,
  LTXTilePlanV2: refreshPlan,
};

app.registerExtension({
  name: "tessera.widget_visibility",
  nodeCreated(node) {
    const refresh = REFRESH[node.comfyClass];
    if (!refresh) return;
    for (const w of node.widgets ?? []) {
      const orig = w.callback;
      w.callback = function (...args) {
        const r = orig?.apply(this, args);
        refresh(node);
        return r;
      };
    }
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const r = origConn?.apply(this, args);
      refresh(node);
      return r;
    };
    // initial state (after the graph finishes configuring the node)
    setTimeout(() => refresh(node), 0);
    const origConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
      const r = origConfigure?.apply(this, args);
      setTimeout(() => refresh(node), 0);
      return r;
    };
  },
});
