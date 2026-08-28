## The default compartment picture lived only in the screen that showed it [high]

**Symptom.** After two fixes the owner was still looking at the drawn schematic
on a printed Purchase Order — 2026-08-28: 「还是一样的问题啊」. He had already
answered the obvious objection himself: 「Sofa compartment 有啊，怎么会没照片呢？」
and he was right — the Maintenance list shows a thumbnail for every compartment.

**Both observations were true, and that is the whole bug.**
`seedCompartmentMeta` in `frontend/src/pages/scm-v2/Products.tsx` supplies the
default `imageKey` — `sofa-modules/<id>.svg` — **client-side, at render time**.
`resolveCompartmentMeta` merges the stored override ON TOP of that seed. So the
screen shows a picture for every compartment while `sofaCompartmentMeta` in the
database holds **nothing** for the defaults.

The print path read the STORED value and processed only entries that carried an
`imageKey`. There were none. Every default compartment was skipped and the engine
drew its schematic. Pictures on screen, drawings on paper, and no error anywhere.

**One default, two places, and only one of them had it.** This is the third time
the same class bit this one feature in a day: first the loader knew one of three
key shapes (`0553`), then four of five print buttons forgot to pass the map
(`0556`), now the default itself lived in a component. Each fix was correct and
none of them could reach this one.

**Fix — derive the default from the CODE.** A compartment's code IS the name of
its artwork, so `loadSofaCompartmentArtForPrint(codes)` takes the codes the sheet
actually needs and falls back to `sofa-modules/<code>` when the config has no
override. The config is now consulted ONLY for an override — an uploaded photo or
a typed URL — so a missing or empty config is a non-event instead of the
difference between a picture and a drawing.

It also stops walking the config to decide WHAT to draw, which was the deeper
mistake: the sheet knows which compartments are on it; the config never did.

**Checked RED:** removing the `sofa-modules/${code}` fallback fails the test.

**Still worth doing (not here):** `seedCompartmentMeta` remains a second
declaration of the same default. It should move to the shared library both
surfaces import, so the Maintenance list and the print path cannot disagree about
what a compartment looks like. Today they agree by construction only because both
end up at `sofa-modules/<code>`.

**Ref.** feat/a-brand-new-po-line-can-carry-photos → renamed
fix/the-default-compartment-picture, 2026-08-28.
