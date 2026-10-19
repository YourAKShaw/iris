## What changed and why?

<!-- Describe the problem and the resulting behavior. Link related issues; use "Closes #123" only when this PR resolves the issue. -->

## Verification

<!-- List the commands you ran and their results. If you ran Iris against a live provider or website, say which (no keys). Explain any check you did not run. -->

## Risks or compatibility

<!-- Changes to prompts, schemas, the result JSON, configuration or security controls. Write "None identified" when appropriate. -->

## Checklist

- [ ] The change is focused, and docs (`.github/README.md`, `.env.example`) match the new behavior.
- [ ] `npm run check` passes (type-check, lint, tests) and `npm run build` succeeds.
- [ ] New behavior has tests at the boundary it changes (fetching, verification, drafting, HTTP).
- [ ] Prompt or model changes were tried on at least one real website, and the result is described above.
- [ ] No secrets, private URLs or personal data in code, fixtures, screenshots or this description.
