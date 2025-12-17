<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# exactly correct. Minor adjustments.  There should be status message applications in chat (like we currently have for damage) and replicate the GM undo feature. And there should be added new AA ontoken animation from JB2A_DND5e for most of the common status indicators. So [DS] Dazed, [DS] Bleeding, etc.

Perfect. Let me refine this to include:

1. **Chat logging** for status applications (like damage)
2. **GM undo functionality** for statuses (mirroring the damage undo)
3. **Pre-populated AA onToken animations** from JB2A_DND5e for common statuses

***

## Revised: Status Application with Chat Logging, Undo, and Animations

### 1. Chat Message Logging for Status (in `damage-fix.mjs`)

Add this after your `logDamageToChat` function:

```js
// Log status application to chat (public or private based on setting)
async function logStatusToChat(entry) {
  try {
    console.log(MODULEID, "logStatusToChat called with", entry);

    const icon = entry.type === "apply" ? "✓" : "✗";
    const sourceLabel = entry.source === "socket" ? `via ${entry.sourcePlayerName}` : "direct GM action";

    // Private GM message with undo button
    const privateContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === "apply" ? "4CAF50" : "f44336"};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === "apply" ? "STATUS APPLIED" : "STATUS REMOVED"}</strong>
          <span style="font-size: 0.8em; color: aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.statusName}</strong> applied to <strong>${entry.targetName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          Source: ${entry.sourceActorName} (${entry.sourceItemName})
        </div>
        ${entry.type === "apply" ? `
          <div style="margin-top: 8px;">
            <button class="status-undo-btn" 
              data-target-token="${entry.targetTokenId}" 
              data-target-actor="${entry.targetActorId}"
              data-effect-id="${entry.effectId}" 
              data-status-name="${entry.statusName}"
              data-event-id="${entry.eventId}"
              style="background: f44336; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 0.9em;">
              Undo
            </button>
          </div>
        ` : ""}
      </div>
    `;

    const isPublic = game.settings.get(MODULEID, "publicStatusLog") ?? false;

    let message;
    if (isPublic) {
      // Public message (no undo button, no whisper)
      const publicContent = `
        <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === "apply" ? "4CAF50" : "f44336"};">
          <div style="margin-bottom: 8px;">
            <strong>${icon} ${entry.type === "apply" ? "STATUS APPLIED" : "STATUS REMOVED"}</strong>
          </div>
          <div style="margin-bottom: 4px;">
            <strong>${entry.statusName}</strong> → <strong>${entry.targetName}</strong>
          </div>
        </div>
      `;

      message = await ChatMessage.create({
        content: publicContent,
        whisper: [] // Broadcast to all
      });

      // Send undo button to GMs only
      const gmUsers = game.users
        .filter(u => u.isGM && u.active)
        .map(u => u.id);

      await ChatMessage.create({
        content: privateContent,
        whisper: gmUsers
      });
    } else {
      // Private mode (only send to GMs with full content)
      const gmUsers = game.users
        .filter(u => u.isGM && u.active)
        .map(u => u.id);

      message = await ChatMessage.create({
        content: privateContent,
        whisper: gmUsers
      });
    }

    // Store in history for potential tracking
    damageHistory.push({
      ...entry,
      messageId: message.id,
      timestamp: Date.now()
    });

    console.log(MODULEID, `Logged status to chat for ${entry.targetName}`);

  } catch (error) {
    console.error(MODULEID, "logStatusToChat ERROR", error);
  }
}
```


### 2. Add Setting for Public Status Log

In your settings registration:

```js
game.settings.register(MODULEID, "publicStatusLog", {
  name: "Public Status Log",
  hint: "Post status applications to public chat (undo buttons remain GM-only)",
  scope: "world",
  config: true,
  type: Boolean,
  default: false
});
```


### 3. Updated GM Handler with Chat Logging + Undo

Replace the previous `handleGMApplyStatus`:

```js
// GM handler – Apply a status effect to a target based on ability effect definition
async function handleGMApplyStatus({ 
  tokenId, 
  statusName, 
  statusId = null,
  sourceActorId,
  sourceItemId,
  sourceItemName,
  sourcePlayerName,
  abilityId,
  ability = null,
  timestamp,
  eventId = null
}) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    console.log(MODULEID, `GM applying status "${statusName}" to ${actor.name}`);

    // Build the Active Effect from the ability's effect definition
    let effectData = buildActiveEffectFromAbility(ability, statusName, statusId, sourceActorId, sourceItemId);

    if (!effectData) {
      return { success: false, error: "Could not build effect data" };
    }

    // Create the Active Effect on the target actor
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);

    if (!created.length) {
      return { success: false, error: "Failed to create effect" };
    }

    const effectId = created[0].id;
    console.log(MODULEID, `Status effect created on ${actor.name}:`, effectId);

    // Generate unique eventId if not provided
    const generatedEventId = eventId || `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Log to chat
    try {
      await logStatusToChat({
        type: "apply",
        statusName: statusName,
        statusId: statusId,
        targetName: actor.name,
        targetTokenId: token.id,
        targetActorId: actor.id,
        sourceActorId: sourceActorId,
        sourceActorName: game.actors.get(sourceActorId)?.name ?? "Unknown",
        sourceItemId: sourceItemId,
        sourceItemName: sourceItemName,
        sourcePlayerName: sourcePlayerName,
        source: "socket",
        effectId: effectId,
        eventId: generatedEventId,
        timestamp: timestamp
      });
    } catch (logError) {
      console.error(MODULEID, "Error logging status to chat", logError);
    }

    // Fire hook for animation system
    try {
      Hooks.callAll("ds-quick-strikeStatusApplied", {
        actorId: actor.id,
        tokenId: token.id,
        statusName: statusName,
        statusId: statusId,
        effectId: effectId,
        sourceActorId: sourceActorId,
        sourceItemId: sourceItemId,
        sourceItemName: sourceItemName,
        sourcePlayerName: sourcePlayerName,
        ability: ability,
        eventId: generatedEventId,
        timestamp: timestamp
      });
    } catch (hookError) {
      console.error(MODULEID, "Error firing ds-quick-strikeStatusApplied hook", hookError);
    }

    return { success: true, effectId: effectId, statusName: statusName };

  } catch (error) {
    console.error(MODULEID, "GM apply status error", error);
    return { success: false, error: error.message };
  }
}
```


### 4. GM Handler for Status Undo

Add this new handler:

```js
// GM handler – Undo a status effect application
async function handleGMUndoStatus({ 
  tokenId, 
  actorId, 
  effectId, 
  statusName, 
  eventId = null 
}) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = tokenId ? canvas.tokens.get(tokenId) : null;
    const actor = actorId ? game.actors.get(actorId) : token?.actor;

    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    console.log(MODULEID, `GM undoing status "${statusName}" on ${actor.name}`);

    // Delete the effect
    const effect = actor.effects.get(effectId);
    if (!effect) {
      return { success: false, error: "Effect not found" };
    }

    await effect.delete();

    // Log undo to chat
    const undoTime = new Date().toLocaleTimeString();
    const undoMessage = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid 2196F3; opacity: 0.7;">
        <div style="margin-bottom: 4px;">
          <strong>↶ UNDO</strong> <span style="font-size: 0.8em; color: 666;">${undoTime}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${statusName}</strong> removed from <strong>${actor.name}</strong>
        </div>
      </div>
    `;

    const gmUsers = game.users
      .filter(u => u.isGM && u.active)
      .map(u => u.id);

    await ChatMessage.create({
      content: undoMessage,
      whisper: gmUsers
    });

    // Fire undo hook for animation system
    try {
      Hooks.callAll("ds-quick-strikeStatusUndone", {
        actorId: actor.id,
        tokenId: token?.id ?? null,
        statusName: statusName,
        effectId: effectId,
        eventId: eventId,
        timestamp: Date.now()
      });
    } catch (hookError) {
      console.error(MODULEID, "Error firing ds-quick-strikeStatusUndone hook", hookError);
    }

    return { success: true };

  } catch (error) {
    console.error(MODULEID, "GM undo status error", error);
    return { success: false, error: error.message };
  }
}
```


### 5. Register Handlers with SocketLib

```js
socket.register("applyStatusToTarget", handleGMApplyStatus);
socket.register("undoStatusApplication", handleGMUndoStatus);
```


### 6. Hook Undo Button Clicks in Chat

After your existing damage undo button handler, add:

```js
// Handle status undo button clicks in chat
Hooks.on("renderChatMessage", (message, html, data) => {
  if (!(html instanceof HTMLElement)) {
    console.warn(MODULEID, "html is not an HTMLElement, skipping status undo handler");
    return;
  }

  const undoBtn = html.querySelector(".status-undo-btn");
  if (!undoBtn) return;

  undoBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    const tokenId = undoBtn.dataset.targetToken;
    const actorId = undoBtn.dataset.targetActor;
    const effectId = undoBtn.dataset.effectId;
    const statusName = undoBtn.dataset.statusName;
    const eventId = undoBtn.dataset.eventId ?? null;

    if (!game.user.isGM) {
      ui.notifications.error("Only GM can undo status");
      return;
    }

    const result = await handleGMUndoStatus({ tokenId, actorId, effectId, statusName, eventId });

    if (result.success) {
      ui.notifications.info(`Undo successful - ${statusName} removed`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});
```


***

## For `ds-aa-bridge.bundle.mjs` – Add OnToken Status Animations

### 1. Add Status → JB2A Animation Mapping

In `hooks/draw-steel-hook.js`, add a constant mapping:

```js
const STATUS_ANIMATION_MAP = {
  // Status Name → JB2A OnToken animation name
  "Dazed": "jb2a.dnd5e.condition.dazed",
  "Slowed": "jb2a.dnd5e.condition.slow",
  "Bleeding": "jb2a.dnd5e.condition.bleeding",
  "Blinded": "jb2a.dnd5e.condition.blinded",
  "Charmed": "jb2a.dnd5e.condition.charmed",
  "Deafened": "jb2a.dnd5e.condition.deafened",
  "Frightened": "jb2a.dnd5e.condition.frightened",
  "Grappled": "jb2a.dnd5e.condition.grappled",
  "Incapacitated": "jb2a.dnd5e.condition.incapacitated",
  "Invisible": "jb2a.dnd5e.condition.invisible",
  "Paralyzed": "jb2a.dnd5e.condition.paralyzed",
  "Petrified": "jb2a.dnd5e.condition.petrified",
  "Poisoned": "jb2a.dnd5e.condition.poisoned",
  "Prone": "jb2a.dnd5e.condition.prone",
  "Restrained": "jb2a.dnd5e.condition.restrained",
  "Stunned": "jb2a.dnd5e.condition.stunned",
  "Unconscious": "jb2a.dnd5e.condition.unconscious",
  "Exhaustion": "jb2a.dnd5e.condition.exhaustion",
  // Add more Draw Steel statuses as needed
};
```


### 2. Add Hook Handler for Status Animations

In the same file, add:

```js
// Listen for status applications and play animations
Hooks.on("ds-quick-strikeStatusApplied", async (payload) => {
  try {
    debugLog(`DS-STATUS-APPLIED: Received status applied hook for ${payload.statusName}`);

    // Skip if no animation configured for this status
    const animationKey = STATUS_ANIMATION_MAP[payload.statusName];
    if (!animationKey) {
      debugLog(`No animation configured for status: ${payload.statusName}`);
      return;
    }

    // Get the target token
    const targetToken = canvas.tokens.get(payload.targetTokenId);
    if (!targetToken) {
      console.warn(MODULEID, "Target token not found for status animation", payload.targetTokenId);
      return;
    }

    debugLog(`Playing status animation: ${animationKey} on ${targetToken.name}`);

    // Use Sequencer to play the onToken animation
    if (typeof Sequence !== "undefined") {
      const sequence = new Sequence();
      sequence
        .effect()
        .file(animationKey)
        .atLocation(targetToken);

      await sequence.play();
    } else {
      console.warn(MODULEID, "Sequencer not available for status animation");
    }

  } catch (error) {
    console.error(MODULEID, "Error playing status animation", error);
  }
});

// Listen for status removals (optional: play removal animation or visual indicator)
Hooks.on("ds-quick-strikeStatusUndone", async (payload) => {
  try {
    debugLog(`DS-STATUS-UNDONE: Status ${payload.statusName} was removed`);

    // Optional: Play a removal animation or visual effect
    // For now, just log it
  } catch (error) {
    console.error(MODULEID, "Error in status undo hook", error);
  }
});
```


### 3. Create AA Fallback Entries (Optional but Recommended)

If you want to provide fallback AA database entries for users who don't have JB2A, you can seed them via AA's database. In the module initialization (after AA is ready), add:

```js
// Optional: seed AA database with DS status animations
async function seedAAStatusAnimations() {
  if (!game.user.isGM) return;
  
  try {
    const onTokenSetting = game.settings.get("autoanimations", "aaAutorec-ontoken");
    
    const dsStatusAnimations = [
      { label: "[DS] Dazed", animation: "jb2a.dnd5e.condition.dazed" },
      { label: "[DS] Slowed", animation: "jb2a.dnd5e.condition.slow" },
      { label: "[DS] Bleeding", animation: "jb2a.dnd5e.condition.bleeding" },
      { label: "[DS] Blinded", animation: "jb2a.dnd5e.condition.blinded" },
      { label: "[DS] Charmed", animation: "jb2a.dnd5e.condition.charmed" },
      { label: "[DS] Deafened", animation: "jb2a.dnd5e.condition.deafened" },
      { label: "[DS] Frightened", animation: "jb2a.dnd5e.condition.frightened" },
      { label: "[DS] Grappled", animation: "jb2a.dnd5e.condition.grappled" },
      { label: "[DS] Incapacitated", animation: "jb2a.dnd5e.condition.incapacitated" },
      { label: "[DS] Invisible", animation: "jb2a.dnd5e.condition.invisible" },
      { label: "[DS] Paralyzed", animation: "jb2a.dnd5e.condition.paralyzed" },
      { label: "[DS] Petrified", animation: "jb2a.dnd5e.condition.petrified" },
      { label: "[DS] Poisoned", animation: "jb2a.dnd5e.condition.poisoned" },
      { label: "[DS] Prone", animation: "jb2a.dnd5e.condition.prone" },
      { label: "[DS] Restrained", animation: "jb2a.dnd5e.condition.restrained" },
      { label: "[DS] Stunned", animation: "jb2a.dnd5e.condition.stunned" },
      { label: "[DS] Unconscious", animation: "jb2a.dnd5e.condition.unconscious" },
      { label: "[DS] Exhaustion", animation: "jb2a.dnd5e.condition.exhaustion" }
    ];

    // Merge with existing entries (avoid duplicates)
    const merged = [...onTokenSetting];
    for (const entry of dsStatusAnimations) {
      if (!merged.find(e => e.label === entry.label)) {
        merged.push(entry);
      }
    }

    await game.settings.set("autoanimations", "aaAutorec-ontoken", merged);
    console.log(MODULEID, "Seeded AA database with DS status animations");

  } catch (error) {
    console.error(MODULEID, "Error seeding AA animations", error);
  }
}

// Call after AA is ready
Hooks.once("automatedAnimationsReady", () => {
  seedAAStatusAnimations();
});
```


***

## Summary: Complete Flow

1. **User clicks "Slowed" button** in Draw Steel chat message
2. **DOM handler** → calls socket `applyStatusToTarget`
3. **GM handler**:
    - Creates Active Effect on target
    - **Logs to chat** (public or GM-only with undo button)
    - Fires `ds-quick-strikeStatusApplied` hook
4. **AA Bridge hook listener** → plays `[DS] Slowed` animation on target via Sequencer
5. **Undo button in chat** → calls socket `undoStatusApplication` → logs removal → fires `ds-quick-strikeStatusUndone` hook

All statuses now have visual feedback, chat logging, and undo capability!

