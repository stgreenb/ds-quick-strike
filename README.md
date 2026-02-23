# Draw Steel Quick Strike

A Foundry VTT module that enables collaborative damage application in the Draw Steel system through a secure GM relay mechanism.

## Overview

Foundry, by default, prevents players from applying damage to tokens they don't own. This module solves that limitation by:

- Providing a socket-based communication channel for damage requests to tokens they've "targeted"
- Notifications (via PM) to GM/Director with undo capabilities for damage
- Quick reminders to players if they accidentally target themselves for damage
- **Full GM/Director support**: Chat logging, undo buttons, and animation hooks work for both player-relayed and direct GM actions

<img title="" src="images/ds-quick-strike-demo.png" alt="Draw Steel Quick Strike in action" width="176" height="185" data-align="center">

## Requirements

* SocketLib
* A GM must be logged in
* Draw Steel 0.10.0+ (for v2.x) or Draw Steel 0.9.x (for v1.8.1)
* Optional: [ds-aa-bridge](https://github.com/stgreenb/ds-aa-bridge) - To add animations.

## Supported Draw Steel Enrichers

| Enricher | Hooked | Notes |
|----------|--------|-------|
| `[[/damage]]` | ✅ | Routes through GM relay for unowned tokens |
| `[[/heal]]` | ✅ | Includes temporary stamina (uses higher of current/new) |
| `[[/apply]]` | ✅ | Status effects via GM relay |
| `[[/surge]]` | ❌ | Native DS handler (applies to source) |
| `[[/gain]]` | ❌ | Native DS handler |

**Note:** `[[/surge]]` and `[[/gain]]` may be hooked in a future version to fix target routing.

## Settings

The module includes the following configurable settings:

- **Public Damage Log**: When enabled, damage and healing events are posted to public chat for all players to see. Undo buttons remain private to the GM regardless of this setting. Defaults to private (GM-only) messages.

## Stuff I might add (mostly inspired by MIDI QOL)

- Batch Damage (Multiple Targets Summary)
- Damage History Log
- Additional configuration options