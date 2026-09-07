# Plan

What is deferred and why, so it survives the conversation it came out of.
Nothing here is committed to — it is a list of things worth doing when the
reason for doing them arrives.

Ordered roughly by when they are likely to matter, not by size.

---

## Fixed formats and durations

Replace the free Width / Height boxes on the poster page with a fixed menu, and
the same for duration. Client work needs quotable, comparable outputs — "10
seconds, at these five sizes" — which free numbers cannot give you.

The auto-fit already reads the poster's shape, so it picks the nearest offered
format instead of computing an arbitrary one. The operator does not choose; the
artwork does, with an override.

Starting point, all on the 32-grid H3 needs and inside its pixel budget:

| Ratio | Size | For |
|---|---|---|
| 16:9 | 1344 x 768 | screens, in-venue displays |
| 9:16 | 768 x 1344 | phone, stories, tower signage |
| 1:1 | 1024 x 1024 | social feed |
| 21:9 | 1792 x 768 | wide banners, LED strips |

All on a 768 short edge. 1344x768 is what MiniMax's node ships with and what
their hosted service means by "768P", so it is the shape H3 was built around —
which settles the earlier question of whether to use it or a truer 16:9 at
1536x864. Play to the model's default and upscale afterwards where a delivery
needs 1080p.

The four ratios are ones MiniMax's own service offers. 4:5 was dropped as not
needed; their portrait option is 3:4 if one is ever wanted.

Durations 5s and 10s, which land on 124 and 243 frames — H3 counts in 17n+5 at
24fps and cannot hit exact seconds.

**Open:** whether that is the right set, whether the venues need the very wide
strips (1920x172 came up), and whether an operator may override at all.

## Keep / Reject on a result

One click on a result you are already looking at, writing a line per run: the
poster, the prompt, the seed, the size, the output, the verdict, and a note.

The point is the verdict. Everything else can be reconstructed from disk in six
months; whether a clip was any good cannot. If the eventual goal is a locally
trained model, this is the dataset, collected as a by-product of doing the work
rather than as a project of its own.

## Text compositing

Draw boxes over the text areas of the poster; after the render, those regions
are restored from the original artwork with ffmpeg. Everything outside the boxes
is animated, everything inside is pixel-perfect.

Needs no layered file from the designer — rectangles on a flat JPEG are enough.

This is the only version of text handling that is *safe rather than likely*,
which matters for a one-button service where nobody checks before it goes out.
Worth building when frozen or animated type proves too unreliable, not before.

## Preview pass

A button that runs the current setup at 8 steps with the seed pinned, leaving
everything ready for the full render.

The manual version works today: fix the seed, drop the steps, and turn off
"Clear GPU first" while iterating — that unload and reload of 19.5 GB costs more
than the steps do. A low-step pass reliably shows cutaways, how much movement
there is, and whether the composition holds. It does not show fine detail or
small-print legibility, so do not reject a prompt on those at 8 steps.

## Describe the poster automatically

The presets carry a `[describe the artwork here]` slot because naming the
specific poster anchors the model. A client pressing ANIMATE will never fill it
in, so for the one-button version it has to be filled automatically.

The box has no captioning node installed — checked. Would need a model added.
H3's own text encoder is a vision-language model and does see the poster as
frame one, which is why one-button is plausible at all; the description helps it
prioritise rather than informs it.

## http-proxy-middleware v4

v4 replaces the `http-proxy` dependency with a maintained rewrite, which removes
the `util._extend` deprecation warning at startup. Needs Node 22.15+, and the
box is on 24.19.

Cosmetic, and the package is the most fragile thing in the app: the Origin
stripping that fixed uploads, the websocket upgrade that carries progress, the
disabled timeouts that stopped runs hanging, and the body-parser ordering are
all its API. A major bump could change any of them quietly. Do it when nothing
is due, and verify all four afterwards.

## Portal service

The eventual goal: clients upload a poster and press ANIMATE, no prompting.

Not blocked by anything in the current build — the compile-and-submit path
already runs headless (`scripts/run-stack.ts`), so a portal endpoint is calling
the same code, not a rewrite. What it would need:

- **A locked set of 8-10 prompts** that work on artwork they were not written
  for. Earned one at a time as real posters come through, not designed up front.
  They should differ by what the poster *is* — photographic or flat, people or
  product, dark or light — since that is the split the model responds to, and
  the split a service could pick automatically.
- **Failing safely.** With nobody checking before it goes out, a prompt that is
  brilliant four times in five and mangles a headline the fifth is worse than
  one that is consistently decent. This is the argument for text compositing.
- **A queue.** ComfyUI runs one job at a time; two clients pressing go at once
  needs some notion of whose job is whose.
- **Accounts and access control.** Stack UI has none and assumes one trusted
  person on a LAN.
