# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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