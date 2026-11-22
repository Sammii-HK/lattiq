# Lattiq local writing-room verification

20 November 2026. Local product presentation from `dbe3f98` plus icon guard `879ac9d`, reviewed at the new origin `http://127.0.0.1:4828`. These captures show unreleased local views, not a deployment. System dark appearance was retained.

## Actual browser checks

- Desktop viewport 1144px and phone viewport 390 by 844px. Writing room, scratch pad and reading shelf had no document-level horizontal overflow. All eleven phone formatting buttons measured at least 44 by 44px and wrapped across two rows.
- Opened the scratch pad from the writing-room navigation. Entered a visibly labelled synthetic review sample, reloaded, and verified all sample paragraphs persisted in the editor. Applied Heading 1 through the real formatting toolbar; the first paragraph became an actual heading in the rendered document.
- Tabbing from the final Link toolbar control reached the editable Document field. Back navigation returned to All documents. The reading-shelf link reached `#library`; its decorative arrow is `lucide-arrow-up-right`.
- Opened The Yellow Wallpaper from the shelf and confirmed its shipped public-domain seed populated the editable document. No private documents were read.
- This production preview was built with an empty `NEXT_PUBLIC_WS_URL`. It correctly showed device-only storage and “Saved on this device”, with no connected collaboration server or other users. No account, database, model provider or WebSocket server was started.
- Temporary phone viewport was reset and desktop width 1144px confirmed before browser handoff.

## Captures

Files are in `.codex-artifacts/` and intentionally not release assets:

- `lattiq-writing-room-desktop.jpg`, `lattiq-writing-room-phone.jpg`: actual local writing-room introduction.
- `lattiq-editor-desktop.jpg`, `lattiq-editor-phone.jpg`: actual editor with clearly labelled synthetic sample writing.
- `lattiq-reading-shelf-desktop.jpg`, `lattiq-reading-shelf-phone.jpg`: actual public-domain reading shelf.

## Limits

This pass does not re-certify multi-client collaboration, offline reconnect merging, benchmark timing, accessibility across assistive technologies, or browsers other than Chrome. Browser persistence is not a backup guarantee. The synthetic fixture exists only on the new local origin. Earlier benchmark receipts remain separate evidence.

## Dependency repair and final checks

The initial audit reported 88 findings, including three critical findings. Updated within the existing Next 15 / React 19 lines to Next 15.5.29, matching ESLint config and React 19.2.5, plus the compatible WebSocket update. Scoped transitive overrides cover the audited vulnerable ranges, including the ESLint parser's minimatch 9 dependency using the supported named API from minimatch 11. The existing pinned lib0 collaboration compatibility version remains unchanged. The final full dependency audit reports zero findings.

The initial dependency setup had a `.pnpm` symlink to an older worktree. Its local module directory was preserved in `/tmp`, and this worktree now has its own complete dependency tree. No tracked source in that older worktree was changed.

Final normal lint (including the shared source icon guard), all 11 guard regressions, TypeScript validation through the production build and the normal production build pass. The existing anonymous-default ESLint configuration warning was resolved without suppressing rules. No product component source changed in this batch.

After the dependency update, the final production preview on 4828 was browser-smoked again. The synthetic sample and heading survived a reload; selected-text heading formatting worked; phone width and scroll width both measured 390px. Both editor screenshots were refreshed from this final build. The writing-room and shelf screenshots retain the unchanged pre-update component presentation. The viewport was reset to 1144px and browser ownership released.
