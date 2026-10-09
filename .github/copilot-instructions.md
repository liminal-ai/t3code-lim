# Copilot code review instructions

Your lane: a fast first pass. See `.github/REVIEW_RULES.md`. Bugbot, Codex and Macroscope run deeper reviews.

- Flag only clear bugs, incorrect API usage, and violations of rules in `AGENTS.md`. At most 5 inline comments.
- Don't comment on style, naming, formatting, or anything a linter/typechecker catches.
- Don't restate the PR description, and don't post praise.
- Skip vendored/generated paths: `.repos/**`, `vendor/**`, `**/dist/**`, `**/_generated/**`, lockfiles.
- Prefer GitHub suggested-change blocks for one-line fixes.
- (Copilot findings are untagged, so review-gate treats them as non-blocking. The author still replies to each one.)
