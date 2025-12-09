# Draw Steel Damage Fix - Implementation Summary

## Problem Statement
Players in Foundry VTT using the Draw Steel system cannot apply damage to NPC tokens they don't own. When a player clicks a damage button in chat, the damage always applies to their own selected token rather than their targeted enemy token.

## Root Cause Analysis

### 1. Draw Steel's Damage Application Mechanism
- Draw Steel bypasses Foundry's standard damage application hooks
- Uses a custom `DamageRoll.applyDamageCallback` method
- This method applies damage to `canvas.tokens.controlled` (selected tokens), not `game.user.targets` (targeted tokens)
- Players cannot select enemy tokens they don't own, but they can target them

### 2. Why Standard Hooks Fail
- `preDamageToken` and `preApplyDamage` hooks don't fire because Draw Steel doesn't use Foundry's damage flow
- Hook-based approaches are insufficient to intercept Draw Steel's custom damage application

### 3. Event Handling Issues
- Initial attempts using jQuery event handlers in `renderChatMessage` hook failed
- `renderChatMessage` hook is deprecated in Foundry v13
- Switching to `renderChatMessageHTML` and native DOM events had attachment problems

## Solution Evolution

### Attempt 1: Hook-Based Approach
- Used `preDamageToken` and `preApplyDamage` hooks
- Failed because Draw Steel bypasses these hooks entirely

### Attempt 2: SocketLib with setTimeout
- Used setTimeout to wait for SocketLib initialization
- Unreliable timing caused registration failures

### Attempt 3: renderChatMessage Hook with jQuery
- Intercepted chat message rendering to replace button handlers
- jQuery event handling didn't work properly in Foundry context
- Hook is deprecated in v13

### Attempt 4: renderChatMessageHTML with Native DOM
- Updated to use the correct v13 hook
- Switched from jQuery to native DOM event handling
- Used named function for proper event listener removal
- Event handlers still weren't being triggered consistently

### Attempt 5: Direct Override Approach (Current)
- Override Draw Steel's `DamageRoll.applyDamageCallback` directly
- Intercept damage application at the source
- Check if user has targeted tokens they don't own
- Redirect via SocketLib to GM for proper application
- Keep button handlers as fallback with extensive logging

## Current Implementation

### Key Components

#### 1. SocketLib Initialization
```javascript
Hooks.once('socketlib.ready', () => {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register('applyDamageToTarget', handleGMDamageApplication);
    socket.register('applyHealToTarget', handleGMHealApplication);
});
```

#### 2. Direct Override
```javascript
Hooks.once('ready', () => {
    const checkDrawSteel = () => {
        if (globalThis.ds?.rolls?.DamageRoll) {
            const DamageRoll = globalThis.ds.rolls.DamageRoll;
            const originalApplyDamageCallback = DamageRoll.applyDamageCallback;

            DamageRoll.applyDamageCallback = async function(event) {
                const targets = Array.from(game.user.targets);
                const needsRedirection = targets.length > 0 && targets.some(t => !t.isOwner);

                if (needsRedirection) {
                    await applyDamageToTargetsViaSocket(event, targets);
                } else {
                    await originalApplyDamageCallback.call(this, event);
                }
            };
        }
    };
    checkDrawSteel();
});
```

#### 3. GM Relay Handlers
- `handleGMDamageApplication`: Applies damage as GM with full permissions
- `handleGMHealApplication`: Applies healing as GM

#### 4. Socket Communication
- `applyDamageToTargetsViaSocket`: Called from override, sends damage data to GM
- Uses `socket.executeAsGM()` for secure relay

### Redirection Logic
1. Player clicks damage button
2. Override intercepts the call
3. Checks if player has targeted tokens they don't own
4. If yes: Extracts damage data and sends via socket to GM
5. GM receives request, applies damage with full permissions
6. Returns success/failure status to player

## What We Hope This Solves

### 1. Reliability
- Direct override ensures interception regardless of event handling issues
- No dependency on DOM manipulation or event attachment timing
- Works at the Draw Steel system level where damage originates

### 2. Permission Handling
- GM relay ensures damage is applied with proper permissions
- Players can affect tokens they don't own through controlled GM process
- No security bypass - damage still applied by authorized GM

### 3. User Experience
- Seamless damage redirection without player effort
- Clear notifications for successful/failed applications
- No fallback logic that applies damage to wrong targets

## Challenges and Debugging

### 1. Timing Issues
- Draw Steel system might not be loaded when module initializes
- Solution: Recursive setTimeout to retry until system is ready

### 2. Event Handler Attachment
- Multiple attempts with different approaches (jQuery → native DOM)
- Added extensive logging to track handler attachment
- Implemented delegate event handling as backup

### 3. SocketLib Registration
- Proper initialization pattern using `socketlib.ready` hook
- Consistent module ID usage across registration and usage

## Testing Strategy

### Setup
- GM account loads module
- Player account (John) with owned token (Pyre)
- Target an enemy token (bugbear channeler2)

### Expected Behavior
1. Module loads and initializes successfully
2. Override applies when Draw Steel is detected
3. Player selects damage button
4. Damage goes to targeted enemy, not player's token
5. Success notification appears

### Debug Logs
- Module initialization messages
- SocketLib registration confirmation
- Draw Steel detection and override application
- Damage button click interception
- Target detection and redirection decision
- Socket communication success/failure

## Files Modified

### C:\Users\steve\code\ds-socket\scripts\damage-safe.mjs
- Main module implementation
- Dual approach: direct override + button handlers
- Extensive logging for debugging
- Socket-based GM relay implementation

### C:\Users\steve\code\ds-socket\module.json
- Module manifest configuration
- Proper Foundry v13 compatibility
- SocketLib dependency declaration

### C:\Users\steve\code\ds-socket\scripts\constants.mjs
- Simple module ID export

## Next Steps

1. **Testing**: Reload Foundry and verify damage redirection works
2. **Verification**: Check console logs for override application and socket communication
3. **Iterate**: If issues persist, analyze logs to identify failure points
4. **Cleanup**: Remove extensive logging once functionality is confirmed

## Key Insights

1. **Draw Steel's Custom Implementation**: The core issue is Draw Steel's non-standard damage application that bypasses Foundry's hooks
2. **Timing is Critical**: Module initialization must wait for both SocketLib and Draw Steel to be ready
3. **Multiple Safeguards**: Implementing both override and hook approaches provides redundancy
4. **Extensive Logging**: Crucial for debugging complex timing and event handling issues

## Success Criteria

- ✅ Module loads without errors
- ✅ SocketLib initializes successfully
- ✅ Draw Steel override applies
- ⏳ Player damage redirects to targeted enemy
- ⏳ GM receives socket request and applies damage
- ⏳ Player receives confirmation notification
- ⏳ No damage applied to wrong target

This implementation represents the most robust approach after multiple iterations and debugging attempts. The direct override method should finally solve the core redirection issue by intercepting damage at its source.