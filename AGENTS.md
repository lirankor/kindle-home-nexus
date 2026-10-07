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
- Soft keys: the bridge delivers the Kindle's four bottom buttons as keyboard keys `F1`..`F4` (Back, Keyboard, Menu, Home, left to right). The footer (`DeviceActions`) always has four slots mapped 1:1 to them in every context, main tabs and modals alike. Pressing `F1`..`F4` runs the footer action of that slot (`pressSoftKey`); unused slots are blank disabled buttons so positions stay stable. Footer buttons stay focusable and clickable. Keep the footer in sync with the key handler: one `actions` array feeds both.
- Keys: PageUp/PageDown switch tabs, arrows move focus, Enter activates, Escape closes. While a modal is open the arrows and PageUp/PageDown stop navigating and act on the modal instead (light modal: Up/Right/PageDown = brightness +10, Down/Left/PageUp = -10; pickers: arrows move the selection and apply it immediately, Enter closes).
- Light modals (`src/components/light-modals.tsx`) are full 600x800 pages with no backdrop, in German: the light modal (Enter on a light card; footer Schließen, Farbe / Weiß, Ein / Aus, Warm / Kalt) and the Weißton / Farbe pickers (footer Schließen, Zurück). Action payloads keep the English HA names. Every modal closes after 30 s without a key press and when the screensaver starts.
- E-ink refresh hint: `requestFullRefresh()` in `src/lib/eink.ts` sets `<html data-eink-refresh="full">` for about 1.5 s, then back to `partial`; the bridge reads it after each screenshot and the Kindle then does a flashing full refresh. Call it (or `useFullRefresh(key)`) for page-like changes: tab change, modal open/close/switch, screensaver on/off and each screensaver picture. Small toggles and brightness steps stay partial to avoid flashing.
- Share a four-slot action footer across device tabs, with a central physical-controller gap, so actions maintain consistent hardware alignment.
- Keep device action definitions separate from their shared footer rendering and use dedicated device icons, so hardware layout remains consistent across views.
