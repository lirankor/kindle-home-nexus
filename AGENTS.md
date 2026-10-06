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
- Device actions are clearly labeled demo state until a real Home Assistant connection is configured; never imply successful remote control.
- The photo screensaver wakes on the first input without activating an underlying control; sample imagery is labeled until Immich is connected.
