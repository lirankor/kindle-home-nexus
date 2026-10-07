<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep the home-control experience in the index route with in-page device tabs, because all four views share a fixed e-ink screen.
- Use semantic grayscale tokens and the eink Button variant for controls, because focus and state must remain visible without color or animation.
- Home Assistant is reached only through server functions in `src/lib/` (`getSnapshot`, `runAction`, `getScreensaver`); the entity map and the optimistic reducer live in `src/lib/home.ts`. HA/Immich env vars are read server-side from `process.env` and must never reach the browser.
- Without `HA_TOKEN` the UI runs on demo data and the status line says "Demo · …"; with it, show the real action result or error ("HA unreachable") and never imply success when HA failed. Optimistic state is reverted on failure.
- The photo screensaver wakes on the first input without activating an underlying control; the bundled sample imagery is labeled until `IMMICH_API_KEY` is set, then a random Immich favorite is shown.
- Light shade and RGB choices use an in-screen dialog with grayscale swatches and named colors, keeping five-way navigation within the open dialog.
- Share a four-slot action footer across device tabs, with a central physical-controller gap, so actions maintain consistent hardware alignment.
- Keep device action definitions separate from their shared footer rendering and use dedicated device icons, so hardware layout remains consistent across views.
