## What this changes

<!-- One or two sentences. Link the issue: Closes #123 -->

## How you tested it

<!-- Commands you ran, the OS, and what you saw. A screenshot or short recording helps for anything visible. -->

## Checklist

- [ ] One change per pull request.
- [ ] Tests or a note on why none are needed.
- [ ] Nothing new leaves the machine, or the README's "Where your data goes" table says what does.
- [ ] No telemetry, analytics or calls to a Clipy service.
- [ ] If this touches `plugins/`, `npx @clipy/cli` pins still match
      (`pnpm test:plugins`) and each changed plugin's `version` in
      `plugin.json` is bumped if its behaviour or usage changed.
