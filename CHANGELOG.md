# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.4] - 2025-12-12

### Added
- **Enhanced Debug Logging**: Added additional debug logging for message.system, message.flavor, and message.ability to help locate where Draw Steel stores ability names

## [1.6.3] - 2025-12-12

### Added
- **Debug Logging**: Added extensive debug logging to trace message structure and locate ability names

## [1.6.2] - 2025-12-12

### Added
- **Source Item Name**: Now captures and passes the actual ability/weapon name in hook payload
- Enhanced hook payload includes `sourceItemName` for better animation selection

### Fixed
- Dependencies properly structured under `relationships.requires` in module.json

## [1.6.0] - 2025-12-11

### Added
- **Animation Hook System**: Complete hook infrastructure for external animation modules
- New `ds-quick-strike:damageApplied` hook fires with comprehensive payload data including:
  - Source and target tokens (IDs and UUIDs)
  - Source item information and keywords
  - Damage type, amount, and metadata
  - Unique eventId for correlation
- New `ds-quick-strike:damageUndone` hook fires when damage is undone with matching eventId
- **Source Item Tracking**: Optional capture of sourceItemId through damage pipeline
- **Keyword Extraction**: Semantic keywords extracted from Draw Steel abilities for animation selection
- **UUID Support**: Full UUID support for cross-scene token resolution
- **Robust Token Helpers**: New `getSourceToken()` and `getTargetToken()` functions with comprehensive error handling
- **Event Correlation**: Unique eventId system pairs damage applications with undo events

### Improved
- **Backward Compatibility**: All changes are additive - existing functionality unchanged
- **Error Handling**: Hook errors logged but don't interrupt damage flow
- **Socket Consistency**: Source data preserved through both direct and socket-based damage applications
- **Performance**: Minimal overhead - hooks fire once per damage application

### Technical Details
- Hook payload schema explicitly documented for third-party module compatibility
- Keywords are animation-agnostic (e.g., ["melee", "slash", "fire"] vs ["jb2a-sword-slash-01"])
- Graceful handling of missing source items and tokens
- Comprehensive test coverage for edge cases and error scenarios

### Example Usage
```javascript
// Listen to damage events for animations
Hooks.on('ds-quick-strike:damageApplied', (payload) => {
  console.log(`Damage applied: ${payload.amount} ${payload.damageType}`);
  console.log(`Keywords: ${payload.keywords.join(', ')}`);
  console.log(`Event ID: ${payload.eventId}`);
});
```

## [1.5.1] - 2025-12-10

### Added
- **Rich Compact Undo Messages**: Enhanced GM undo messages in public mode with full context
- Color-coded undo buttons (red for damage, green for healing)
- Horizontal layout showing: target name, damage/healing amount, and stamina change
- Complete information in single line: `🔴 Undo **Target** −5 (Perm: 17→12)`

### Improved
- GM now sees full context at a glance when using public damage log mode
- Better visual distinction between damage and healing actions
- Reduced chat clutter while maintaining complete information
- Consistent stamina formatting across public and private messages

## [1.5.0] - 2025-12-10

### Added
- **Public Damage Log Setting**: New module setting that allows damage and healing events to be posted to public chat for all players to see
- When Public Damage Log is enabled, creates two separate messages:
  - Public message visible to all players (without undo buttons)
  - Private GM-only message with undo functionality
- Undo audit trail that logs undo actions with timestamps to GM chat
- Setting persists across world reloads using Foundry's game.settings API

### Changed
- Maintained backward compatibility - defaults to private (GM-only) logging
- Undo buttons remain GM-only regardless of public setting

## [1.4.1] - Previous Release

### Fixed
- Cleaned up socket registration code
- Improved error handling for damage application

## [1.4.0] - Previous Release

### Added
- Initial collaborative damage application system
- Socket-based communication for player damage requests
- GM notification system with undo capabilities
- Self-damage warnings for players
- Integration with Draw Steel damage system