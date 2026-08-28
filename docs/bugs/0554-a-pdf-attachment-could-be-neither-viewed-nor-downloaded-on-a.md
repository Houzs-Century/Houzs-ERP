## A PDF attachment could be neither viewed nor downloaded on a phone [high]

**Symptom.** 2026-08-27: Lucas (Sales Executive, Sales Department) could not view
or download the Unfilled floorplan on mobile. Tapping the tile opened a black
box; the Download button did nothing at all. No error appeared anywhere.

**Not a permission problem — that was ruled out first, against his live record.**
`isSalesStaff` is true from BOTH his department (`Sales Department`) and his
position (`Sales Executive`), so `cohort5` is true, `cohortOps` false, and
`hidePlanTiles` false — the tile renders. `hideFilledPlan` is crew-only. His
position policy grants `projects: view`, his role carries `projects.read` +
`projects.write`, his company (HOUZS) matches the project's, and the attachment
stream route `GET /api/projects/attachments/:key` carries **no** permission gate
beyond being signed in. Every gate admitted him.

**Root cause — the file was a PDF, and three separate things break on a PDF.**
His Sarawak project's Blank Floorplan was uploaded 2026-08-24 as
`application/pdf`; the other two projects he is PIC of hold JPEGs and worked.

1. **View.** `MediaLightbox` rendered a PDF into an `<iframe src={blobUrl}>`.
   iOS Safari and Android Chrome both refuse to render a PDF in an iframe, so
   the viewer was a blank box.
2. **Download.** The button called `api.downloadFile`, which **awaits** a fetch
   and only then creates an `<a download>` and clicks it. That await breaks the
   user-gesture chain mobile browsers require before starting a download, so
   nothing happened. This is the SAME gesture rule `MobilePMS.tsx:3701` already
   documents — *"mobile browsers popup-block window.open once an await has
   broken the user-gesture chain, which made these tiles dead on phones"*. That
   note was written when VIEW was moved onto the lightbox; DOWNLOAD kept the
   broken shape.
3. **Silence.** Both failure paths ended in `.catch(() => {})`, and the loading
   box said `Loading…` whether the fetch was in flight or already dead. There
   was no error for the user to report, which is why it arrived as "I tap it and
   nothing happens".

A fourth, cosmetic: the tile thumbnail renders only for `image/*`, so a PDF
showed an empty grey box that reads as "no file".

**Scale — this is not one user or one file.** `project_checklist_attachments`
holds **995 PDFs against 1240 images**: 44% of every checklist attachment in the
system. Every one of them was unviewable and undownloadable on a phone.

**Fix** (`frontend/src/components/MediaLightbox.tsx`):

- The PDF iframe is now desktop-only, gated on `matchMedia("(pointer: coarse)")`
  — POINTER, not viewport width, so a narrowed desktop window keeps the inline
  viewer. Touch devices fall through to the existing document card, whose `Open`
  link hands the blob to the OS PDF viewer.
- The Download button is a real `<a href={blobUrl} download>` over the blob
  already in state, not a fetch-then-synthesise-a-click. No await in front of
  the gesture. It renders only once the blob has arrived.
- `downloadName` replaces the Content-Disposition read the re-fetch used to do.
  A caption is used only when it carries an extension (the defect tiles put a
  free-text remark in `caption`), else the R2 key basename.
- A `loadErr` state replaces both silent catches; one `fallbackBox` says
  "Could not load this file" instead of `Loading…` for ever, and the document
  card says so too rather than showing a filename with no control.

And in `frontend/src/mobile/MobilePMS.tsx`: a non-image floorplan tile prints
its format (`PDF`) instead of an empty placeholder.

**Not verified by a run.** `node` is not installed on the machine this was
authored on — `npm run typecheck`, `lint` and `vitest` were NOT executed, and
`MediaLightbox` has no test today. The gates and the file's MIME were verified
by querying the live database; the TypeScript was not compiled. **Run
`npm --prefix frontend run typecheck && npm --prefix frontend test` before
merge.** Worth adding: a test that a coarse-pointer lightbox does not mount an
`<iframe>` for a PDF, and that the Download control is an anchor carrying an
`href`, not a button.

**Ref.** 2026-08-27, `MediaLightbox.tsx` + `mobile/MobilePMS.tsx` floorplan tile.
