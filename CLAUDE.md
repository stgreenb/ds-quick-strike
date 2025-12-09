<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# Important Development Notes

## UPLOAD REQUIREMENT
**ALWAYS REMEMBER**: After making any code changes, the user must manually upload the updated files to the Foundry server. The server runs on a separate machine at `\\192.168.1.196\hdd500g\foundry\data\Data\modules\ds-socket`. Never assume code changes are live - always ask the user to upload when modifications are made.