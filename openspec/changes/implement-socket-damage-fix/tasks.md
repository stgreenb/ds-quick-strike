## 1. Scaffolding
- [x] 1.1 Create the `scripts/` directory for the module's JavaScript files.

## 2. Implementation
- [x] 2.1 Create the main module logic in `scripts/damage-fix.mjs` with:
  - Socket listener for damage requests
  - Session-based validation
  - Optional GM approval system
  - Smart confirmation dialogs (self-damage, hostile healing, multi-target)
  - Audit logging functionality
  - Configuration settings UI
- [x] 2.2 Create the Foundry VTT manifest file `module.json` with:
  - Module metadata and dependencies
  - Default configuration values
- [x] 2.3 Create a `README.md` with:
  - Installation instructions
  - Configuration options explanation
  - Usage examples
  - Security considerations
  - Troubleshooting guide
- [x] 2.4 Create an MIT `LICENSE` file.
- [x] 2.5 Create a `.gitignore` file.
- [x] 2.6 Create module settings template for configuration UI.

## 3. Code Review Fixes
- [x] 3.1 Fix critical typo in settings registration (config: handling → config: true)
- [x] 3.2 Add timestamp validation (reject requests older than 30 seconds)
- [x] 3.3 Add damage bounds validation (prevent absurd damage values > 1000)
- [x] 3.4 Improve error handling with try/catch blocks around socket operations
- [x] 3.5 Fix async dialog handling to properly await user input
- [x] 3.6 Add null/undefined checks for game.user.character and canvas

## 4. Testing
- [x] 4.1 Ensure all files are created correctly.
- [ ] 4.2 [Manual] Add module code to Foundry server and restart if needed.
- [ ] 4.3 Test basic damage application to owned tokens.
- [ ] 4.4 Test damage requests to unowned NPC tokens.
- [ ] 4.5 Test GM approval mode (both auto-apply and manual approval).
- [ ] 4.6 Test confirmation dialogs:
  - Multi-target damage (2+ targets)
  - Self-damage warning
  - Hostile healing warning
- [ ] 4.7 Test audit logging functionality.
- [ ] 4.8 Test configuration settings persistence.
- [ ] 4.9 [Playwright MCP] Automated browser testing:
  - Log in as player and test damage requests
  - Log in as GM and test approval workflow
  - Verify socket communications and UI responses
  - Test edge cases and error handling
- [ ] 4.10 [Manual] Full integration test as per the testing checklist in `Draw-Steel-Socket-Implementation.md`.
