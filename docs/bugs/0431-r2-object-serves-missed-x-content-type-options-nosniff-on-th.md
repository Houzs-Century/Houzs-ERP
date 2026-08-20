## R2 object serves missed `X-Content-Type-Options: nosniff` on three endpoints [low]

<!-- area: Auth, permissions, sessions -->

**白话.** 有三个下载 / 看图的接口（服务单附件、项目附件、用户头像）从 R2 直接把文件
丢回浏览器，但没告诉浏览器「别自作聪明去猜这是什么档」。浏览器猜错时，一个被塞进来的
恶意档可能被当成网页 / SVG 在我们的网址下执行（偷 token）。`mail-center` 的附件接口早就
补了这个头，这三个跟上，保持一致。

**Symptom.** None reported — a defense-in-depth parity gap. `mail-center.ts`'s
attachment serve already sets `X-Content-Type-Options: nosniff` on its
INLINE_SAFE path; three sibling R2 object serves that stream a stored object with
a server-derived content-type did not, so a browser was free to MIME-sniff the
bytes back into html/svg and execute script in the ERP origin.

**Root cause (traced in source).** Each of `routes/assr.ts` (attachment serve,
~:3217), `routes/projects.ts` (project-attachment serve, ~:4592) and
`routes/users.ts` (profile-pic serve, ~:914) built its `Response` with
`Content-Type` + `Cache-Control` only — no `nosniff`. The content-type is
`obj.httpMetadata?.contentType || "application/octet-stream"` (server-derived,
not attacker-supplied per request), so the exposure is lower than the inbound
mail path, but the header is the same cheap belt.

**Fix.** Add `"X-Content-Type-Options": "nosniff"` to all three serve responses,
matching mail-center's path. Header-only; no route/permission/status/field
change, so no module-guide surface moved.

**Ref.** `fix/over-delivery-unlinked-blind-spot`, PR #2522, 2026-08-20.
