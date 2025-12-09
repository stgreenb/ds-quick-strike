# Change: Implement Socket-Based Damage Fix

## Why
The Draw Steel system currently prevents players from applying damage to NPC tokens they do not own, which limits collaborative gameplay. This change introduces a GM relay mechanism with smart validation to solve this permission issue while adding helpful safeguards.

## What Changes
- Adds a new capability: `draw-steel-damage-fix`.
- Introduces a socket-based communication channel for players to request damage application from the GM.
- Provides an **optional GM approval system** - GM can configure whether damage is applied automatically or requires explicit approval.
- Overrides the default damage application callback to use this new socket system.
- Adds intelligent confirmation dialogs:
  - Multi-target damage confirmation to prevent user error
  - Self-damage confirmation: "Are you sure you want to damage yourself?"
  - Hostile healing confirmation: "Are you sure you want to heal this hostile target?"
- Implements simple security measures:
  - Session-based request validation
  - Basic ownership/permission checks
  - Audit logging for transparency

## Configuration Options
- **GM Approval Mode**: Auto-apply vs Require approval (default: auto-apply)
- **Confirmation Thresholds**: Always confirm for N+ targets (default: 2+)
- **Smart Prompts**: Enable/disable self-damage and hostile healing warnings (default: enabled)
- **Audit Logging**: Enable/disable damage request logs (default: enabled)

## Testing Infrastructure
- **Playwright MCP Server**: Available for automated browser testing
  - Can manually log into Foundry as either player or GM role
  - Enables end-to-end testing of damage application workflows
  - Allows verification of UI dialogs and socket communications

## Installation Requirements
- **Manual Code Addition**: Module code must be manually added to the Foundry server
  - No automated deployment - requires direct file placement
  - Server restart may be required after code installation

## Impact
- **Affected specs:** This introduces a new capability, `draw-steel-damage-fix`, and does not modify existing specs.
- **Affected code:** This will add a new module with the following files:
  - `scripts/damage-fix.mjs`
  - `module.json`
  - `README.md`
  - `LICENSE`
