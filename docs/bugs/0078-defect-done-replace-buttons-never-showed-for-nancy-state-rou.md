## Defect Done/Replace buttons never showed for Nancy — state-routing read the wrong payload path [high]

**Symptom** - owner, 2026-08-11, logged in as Nancy on a Pulau Pinang defect (SETIA SPICE CONVENTION CENTRE): the Done / Replace buttons did not appear, even though her My Pending correctly listed that event.

**Root cause (traced)** - the state-based reviewer split (PR #2050) made the frontend `canReview` read the project state from `detail.data.state` (desktop) / `data.state` (mobile), but the project detail nests the project under `detail.data.project` (`getProjectDetail` does `SELECT p.*`; the component already does `const p = detail.data.project`). So `state` was always `undefined` -> `inRegion` always false -> Nancy (`isNancy && inRegion`) never qualified, and Shukor (`isShukor && !inRegion`) even qualified on Penang. The BACKEND My Pending routing was correct (it filters on `p.state` in SQL, validated on prod), which is why Nancy saw the event but couldn't act.

**Fix** - read `detail.data.project.state` (desktop) / `data.project.state` (mobile). Two-token path fix on both surfaces.

**The class** - a nested payload field read one level too shallow returns `undefined`, not an error, and `region.has("")` is a quiet false, not a crash. When a new gate reads detail data, verify the shape (`detail.data.project.X`, not `detail.data.X`).

**Ref** - `fix/defect-review-state-path` 2026-08-11.
