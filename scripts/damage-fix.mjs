const MODULE_ID = 'ds-quick-strike';

let socket;
let damageHistory = [];
const originalTakeDamageMap = new Map();

/**
 * Initialize when SocketLib is ready
 * CRITICAL: Don't access game.user here - it's null during socketlib.ready!
 */
Hooks.once('socketlib.ready', () => {
  try {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register('applyDamageToTarget', handleGMDamageApplication);
    socket.register('applyHealToTarget', handleGMHealApplication);
    socket.register('undoLastDamage', handleGMUndoDamage);
    console.log(`${MODULE_ID}: SocketLib registered successfully`);
  } catch (error) {
    console.error(`${MODULE_ID}: Failed to register socketlib:`, error);
  }
});

/**
 * Setup damage override when ready
 * NOW game.user is available
 */
Hooks.once('ready', () => {
  console.log(`${MODULE_ID}: Ready hook fired`);
  console.log(`${MODULE_ID}: User is GM: ${game.user.isGM}`);
  console.log(`${MODULE_ID}: Socket available: ${!!socket}`);

  // Register module settings
  game.settings.register(MODULE_ID, 'publicDamageLog', {
    name: 'Public Damage Log',
    hint: 'Post damage and healing to public chat (undo buttons remain private)',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  if (game.user.isGM) {
    hookIntoActorDamage();
  }

  const waitForDrawSteel = () => {
    if (!globalThis.ds?.rolls?.DamageRoll) {
      setTimeout(waitForDrawSteel, 100);
      return;
    }

    console.log(`${MODULE_ID}: Found Draw Steel, installing override`);
    installDamageOverride();
  };

  waitForDrawSteel();
});

/**
 * Hook into ALL actor damage/healing to capture direct GM actions
 */
function hookIntoActorDamage() {
  Hooks.on('createActor', (actor) => {
    wrapActorTakeDamage(actor);
  });

  game.actors.forEach(actor => {
    wrapActorTakeDamage(actor);
  });

  console.log(`${MODULE_ID}: Actor damage hooks installed`);
}

/**
 * Wrap an actor's takeDamage method to log damage
 */
function wrapActorTakeDamage(actor) {
  if (!actor.system.takeDamage) return;
  
  if (originalTakeDamageMap.has(actor.id)) return;

  const originalTakeDamage = actor.system.takeDamage.bind(actor.system);
  originalTakeDamageMap.set(actor.id, originalTakeDamage);

  actor.system.takeDamage = async function(amount, options = {}) {
    const preStamina = getStaminaSnapshot(actor);

    const result = await originalTakeDamage(amount, options);

    const postStamina = getStaminaSnapshot(actor);
    const damageType = options.type || 'untyped';

    const caller = new Error().stack;
    const isSocketCall = caller.includes('handleGMDamageApplication') ||
                         caller.includes('handleGMHealApplication');

    // Extract optional sourceItemId for animation tracking
    const sourceItemId = options.sourceItemId || null;

    // Generate unique eventId for damage-undo correlation
    const eventId = `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Get source actor ID (try character first, then user ID)
    const sourceActorId = game.user.character?.id || game.user.id;

    // Log damage ONLY if NOT coming from socket (to avoid double-logging)
    if (!isSocketCall && amount > 0) {
      await logDamageToChat({
        type: 'damage',
        amount: amount,
        damageType: damageType,
        targetName: actor.name,
        targetTokenId: actor.getActiveTokens()[0]?.id || null,
        targetActorId: actor.id,
        originalStamina: preStamina,
        newStamina: postStamina,
        sourceActorId: sourceActorId,
        sourcePlayerName: game.user.name,
        source: 'direct',
        sourceItemId: sourceItemId,
        eventId: eventId,
        timestamp: Date.now()
      });
    }

    return result;
  };

  console.log(`${MODULE_ID}: Wrapped takeDamage for ${actor.name}`);
}

/**
 * Install the damage callback override
 */
function installDamageOverride() {
  const OriginalDamageRoll = globalThis.ds.rolls.DamageRoll;
  const originalCallback = OriginalDamageRoll.applyDamageCallback;

  OriginalDamageRoll.applyDamageCallback = async function(event) {
    try {
      console.log(`${MODULE_ID}: Damage button clicked`);

      const li = event.currentTarget.closest("[data-message-id]");
      if (!li) {
        console.warn(`${MODULE_ID}: Could not find message element`);
        return;
      }

      const message = game.messages.get(li.dataset.messageId);
      if (!message) {
        console.warn(`${MODULE_ID}: Could not find message`);
        return;
      }

      const rollIndex = event.currentTarget.dataset.index;
      const roll = message.rolls[rollIndex];
      if (!roll) {
        console.warn(`${MODULE_ID}: Could not find roll at index ${rollIndex}`);
        return;
      }

      let amount = roll.total;
      if (event.shiftKey) {
        amount = Math.floor(amount / 2);
      }

      console.log(`${MODULE_ID}: Damage amount: ${amount}`);

      const targets = Array.from(game.user.targets);
      console.log(`${MODULE_ID}: User has ${targets.length} targets`, targets.map(t => t.name));

      // Check for self-damage and warn player
      const proceedWithDamage = await checkForSelfDamage(targets, amount, roll.isHeal, MODULE_ID);
      if (!proceedWithDamage) {
        return; // User cancelled self-damage
      }

      // Get source actor name from message speaker
      let sourceActorName = 'Unknown Source';
      if (message.speaker?.actor) {
        const sourceActor = game.actors.get(message.speaker.actor);
        if (sourceActor) {
          sourceActorName = sourceActor.name;
        }
      }

      // Always use socket handlers for consistent logging
      if (socket) {
        console.log(`${MODULE_ID}: Redirecting to GM via socket (source: ${sourceActorName})`);
        await applyDamageViaSocket(targets, roll, amount, sourceActorName);
      } else {
        console.log(`${MODULE_ID}: No socket available, using original damage application`);
        await originalCallback.call(this, event);
      }
    } catch (error) {
      console.error(`${MODULE_ID}:`, error);
      ui.notifications.error("Failed to apply damage");
    }
  };

  console.log(`${MODULE_ID}: Override installed successfully`);
}

/**
 * Check for self-damage and warn player before applying
 */
async function checkForSelfDamage(targets, amount, isHeal, moduleId) {
  const playerCharacter = game.user.character;
  if (!playerCharacter) return true; // No player character, continue
  
  const selfDamageTargets = targets.filter(t => t.actor.id === playerCharacter.id);
  
  // Only warn on damage, not healing
  if (selfDamageTargets.length > 0 && !isHeal) {
    const targetName = selfDamageTargets[0].name;
    console.log(`${moduleId}: Self-damage detected - ${targetName}, ${amount} damage`);
    
    return new Promise(resolve => {
      const dialog = new Dialog({
        title: "⚠️ Self-Damage Warning",
        content: `<div style="text-align: center; padding: 12px;">
                    <p style="margin: 0 0 12px 0; font-size: 16px;">
                      You're about to deal <strong>${amount}</strong> damage to yourself!
                    </p>
                    <p style="margin: 0; color: #666; font-size: 14px;">
                      <strong>${targetName}</strong>
                    </p>
                  </div>`,
        buttons: {
          confirm: {
            label: "Confirm",
            callback: () => {
              console.log(`${moduleId}: Player confirmed self-damage`);
              resolve(true);
            }
          },
          cancel: {
            label: "Cancel",
            callback: () => {
              console.log(`${moduleId}: Player cancelled self-damage`);
              ui.notifications.warn(`Damage to ${targetName} cancelled`);
              resolve(false);
            }
          }
        },
        default: "cancel"
      });
      dialog.render(true);
    });
  }
  
  return true; // No self-damage, continue normally
}

/**
 * Send damage request to GM via socket
 */
async function applyDamageViaSocket(targets, roll, amount, sourceActorName) {
  try {
    for (const target of targets) {
      console.log(`${MODULE_ID}: Sending damage request for ${target.name}`);

      // Generate eventId for this damage application
      const eventId = `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      if (roll.isHeal) {
        const result = await socket.executeAsGM('applyHealToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          sourceActorName: sourceActorName,
          sourcePlayerName: game.user.name,
          sourceItemId: roll.sourceItemId || null,
          eventId: eventId
        });

        if (result.success) {
          ui.notifications.info(`Healed ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to heal ${target.name}: ${result.error}`);
        }
      } else {
        const result = await socket.executeAsGM('applyDamageToTarget', {
          tokenId: target.id,
          amount: amount,
          type: roll.type,
          ignoredImmunities: roll.ignoredImmunities || [],
          sourceActorName: sourceActorName,
          sourcePlayerName: game.user.name,
          sourceItemId: roll.sourceItemId || null,
          eventId: eventId
        });

        if (result.success) {
          ui.notifications.info(`Damaged ${target.name} for ${amount}`);
        } else {
          ui.notifications.error(`Failed to damage ${target.name}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error(`${MODULE_ID}: Socket error:`, error);
    ui.notifications.error("Socket communication failed");
  }
}

/**
 * Get stamina snapshot
 */
function getStaminaSnapshot(actor) {
  const permanent = actor.system?.stamina?.value ?? 0;
  const temporary = actor.system?.stamina?.temporary ?? 0;
  
  return { permanent, temporary };
}

/**
 * Check if actor is a Hero character
 */
function isHero(actor) {
  const type = actor.type || actor.system?.type;
  console.log(`${MODULE_ID}: ${actor.name} type is '${type}'`);
  return type === 'character' || type === 'hero';
}

/**
 * Apply stamina bounds based on actor type
 */
function applyStaminaBounds(actor, staminaSnapshot) {
  const max = actor.system?.stamina?.max || 0;
  const min = actor.system?.stamina?.min || 0;
  
  let permanent = staminaSnapshot.permanent;
  
  if (isHero(actor)) {
    permanent = Math.max(min, Math.min(max, permanent));
  } else {
    permanent = Math.max(0, Math.min(max, permanent));
  }
  
  return {
    permanent,
    temporary: staminaSnapshot.temporary
  };
}

/**
 * GM handler: Apply damage to a target
 */
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities, sourceActorName, sourcePlayerName, sourceItemId, eventId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      console.warn(`${MODULE_ID}: Token not found: ${tokenId}`);
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      console.warn(`${MODULE_ID}: Actor not found for token: ${tokenId}`);
      return { success: false, error: "Actor not found" };
    }

    const originalStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} damage to ${actor.name} (source: ${sourceActorName}, player: ${sourcePlayerName}). Pre-damage stamina: Perm=${originalStamina.permanent}, Temp=${originalStamina.temporary}. Is Hero: ${isHero(actor)}`);

    await actor.system.takeDamage(amount, {
      type: type,
      ignoredImmunities: ignoredImmunities || [],
      sourceItemId: sourceItemId
    });

    let newStamina = getStaminaSnapshot(actor);
    newStamina = applyStaminaBounds(actor, newStamina);

    if (newStamina.permanent !== getStaminaSnapshot(actor).permanent) {
      console.log(`${MODULE_ID}: Applying stamina bounds: ${getStaminaSnapshot(actor).permanent} → ${newStamina.permanent}`);
      await actor.update({'system.stamina.value': newStamina.permanent});
    }

    console.log(`${MODULE_ID}: Post-damage stamina: Perm=${newStamina.permanent}, Temp=${newStamina.temporary}`);

    console.log(`${MODULE_ID}: About to log damage to chat: ${actor.name} (Perm: ${originalStamina.permanent}→${newStamina.permanent}, Temp: ${originalStamina.temporary}→${newStamina.temporary})`);
    try {
      await logDamageToChat({
        type: 'damage',
        amount: amount,
        damageType: type,
        targetName: actor.name,
        targetTokenId: token.id,
        targetActorId: actor.id,
        originalStamina: originalStamina,
        newStamina: newStamina,
        sourceActorId: game.user.id, // Use GM user ID as source actor
        sourceActorName: sourceActorName,
        sourcePlayerName: sourcePlayerName,
        source: 'socket',
        sourceItemId: sourceItemId,
        eventId: eventId,
        timestamp: Date.now()
      });
      console.log(`${MODULE_ID}: Successfully logged damage to chat`);
    } catch (logError) {
      console.error(`${MODULE_ID}: Error logging damage to chat:`, logError);
    }

    return {
      success: true,
      tokenName: token.name,
      damageApplied: amount
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM damage error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * GM handler: Apply healing to a target
 */
async function handleGMHealApplication({ tokenId, amount, type, sourceActorName, sourcePlayerName, sourceItemId, eventId }) {
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

    const originalStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: GM applying ${amount} healing to ${actor.name} (source: ${sourceActorName}, player: ${sourcePlayerName}). Pre-heal stamina: Perm=${originalStamina.permanent}, Temp=${originalStamina.temporary}`);

    const isTemp = type !== "value";
    const currentTemp = actor.system.stamina?.temporary || 0;

    if (isTemp && amount > currentTemp) {
      console.warn(`${MODULE_ID}: Temporary stamina capped for ${actor.name}`);
    }

    await actor.modifyTokenAttribute(
      isTemp ? "stamina.temporary" : "stamina.value",
      amount,
      !isTemp,
      !isTemp
    );

    let newStamina = getStaminaSnapshot(actor);
    
    const max = actor.system?.stamina?.max || 0;
    newStamina.permanent = Math.min(newStamina.permanent, max);
    
    if (newStamina.permanent !== getStaminaSnapshot(actor).permanent) {
      await actor.update({'system.stamina.value': newStamina.permanent});
    }
    
    console.log(`${MODULE_ID}: Post-heal stamina: Perm=${newStamina.permanent}, Temp=${newStamina.temporary}`);

    try {
      await logDamageToChat({
        type: "heal",
        amount: amount,
        damageType: type,
        targetName: actor.name,
        targetTokenId: token.id,
        targetActorId: actor.id,
        originalStamina: originalStamina,
        newStamina: newStamina,
        sourceActorId: game.user.id, // Use GM user ID as source actor
        sourceActorName: sourceActorName,
        sourcePlayerName: sourcePlayerName,
        source: 'socket',
        sourceItemId: sourceItemId,
        eventId: eventId,
        timestamp: Date.now()
      });
    } catch (logError) {
      console.error(`${MODULE_ID}: Error logging heal to chat:`, logError);
    }

    return {
      success: true,
      tokenName: token.name,
      healingApplied: amount
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM healing error:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Log damage/healing to chat (public or private based on setting)
 */
async function logDamageToChat(entry) {
  try {
    console.log(`${MODULE_ID}: logDamageToChat called with:`, entry);

    const icon = entry.type === 'damage' ? '⚔️' : '✨';
    const sourceLabel = entry.source === 'socket' ? `(via ${entry.sourcePlayerName})` : '(direct GM action)';

    let staminaDisplay = `${entry.originalStamina.permanent} → ${entry.newStamina.permanent}`;
    if (entry.originalStamina.temporary > 0 || entry.newStamina.temporary > 0) {
      staminaDisplay = `Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent} | Temp: ${entry.originalStamina.temporary}→${entry.newStamina.temporary}`;
    }

    const isPublic = game.settings.get(MODULE_ID, 'publicDamageLog');
    console.log(`${MODULE_ID}: Public damage log setting: ${isPublic}`);

    // Extract source data and prepare hook payload
    const hookPayload = await prepareHookPayload(entry);

    // Public message content (no undo button)
    const publicContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${entry.amount} ${entry.damageType}
          (Stamina: ${staminaDisplay})
        </div>
      </div>
    `;

    // Private GM message content (with undo button)
    const privateContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'damage' ? '#e76f51' : '#2a9d8f'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'damage' ? 'DAMAGE' : 'HEALING'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.targetName}</strong> hit by <strong>${entry.sourceActorName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          ${entry.amount} ${entry.damageType}
          (Stamina: ${staminaDisplay})
        </div>
        <div style="margin-top: 8px;">
          <button
            class="damage-undo-btn"
            data-target-token="${entry.targetTokenId}"
            data-original-perm="${entry.originalStamina.permanent}"
            data-original-temp="${entry.originalStamina.temporary}"
            data-target-name="${entry.targetName}"
            data-event-id="${entry.eventId || ''}"
            style="
              background: #e76f51;
              color: white;
              border: none;
              padding: 4px 8px;
              border-radius: 3px;
              cursor: pointer;
              font-weight: bold;
              font-size: 0.9em;
            "
          >
            ↶ Undo
          </button>
        </div>
      </div>
    `;

    // Rich compact undo for public mode (GM only) - shows damage amount and stamina change
    const damageSymbol = entry.type === 'damage' ? '−' : '+';
    const undoColor = entry.type === 'damage' ? '#e76f51' : '#2a9d8f';

    const compactUndoContent = `
      <div style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 11px;">
        <button
          class="damage-undo-btn"
          data-target-token="${entry.targetTokenId}"
          data-original-perm="${entry.originalStamina.permanent}"
          data-original-temp="${entry.originalStamina.temporary}"
          data-target-name="${entry.targetName}"
          data-event-id="${entry.eventId || ''}"
          style="
            background: ${undoColor};
            color: white;
            border: none;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-weight: bold;
            font-size: 10px;
            white-space: nowrap;
            flex-shrink: 0;
          "
        >
          ↶ Undo
        </button>
        <span style="color: #333; font-weight: 600;">${entry.targetName}</span>
        <span style="color: #999;">${damageSymbol}${entry.amount} (Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent})</span>
      </div>
    `;

    let message;
    if (isPublic) {
      // Create public message first (no whisper = broadcast to all)
      console.log(`${MODULE_ID}: Creating public chat message`);
      const publicMessage = await ChatMessage.create({
        content: publicContent,
        whisper: [] // Empty array = broadcast to all players
      });

      // Then create compact undo button (GM only)
      const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);
      console.log(`${MODULE_ID}: GM users to whisper to:`, gmUsers);

      message = await ChatMessage.create({
        content: compactUndoContent,
        whisper: gmUsers
      });
    } else {
      // Private mode: only send to GMs with full content
      const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);
      console.log(`${MODULE_ID}: GM users to whisper to:`, gmUsers);

      const messageData = {
        content: privateContent,
        whisper: gmUsers
      };

      console.log(`${MODULE_ID}: Creating private chat message with data:`, messageData);
      message = await ChatMessage.create(messageData);
    }

    console.log(`${MODULE_ID}: Chat message created:`, message.id);

    await message.setFlag(MODULE_ID, 'damageEntry', {
      ...entry,
      messageId: message.id
    });

    damageHistory.push({
      ...entry,
      messageId: message.id
    });

    // Fire animation hook after chat message is created
    if (hookPayload) {
      try {
        Hooks.callAll('ds-quick-strike:damageApplied', hookPayload);
        console.log(`${MODULE_ID}: Fired ds-quick-strike:damageApplied hook with eventId: ${hookPayload.eventId}`);
      } catch (hookError) {
        console.error(`${MODULE_ID}: Error firing damageApplied hook:`, hookError);
        // Continue without breaking the damage flow
      }
    }

    console.log(`${MODULE_ID}: Logged to chat: ${entry.targetName} ${entry.type} (Perm: ${entry.originalStamina.permanent}→${entry.newStamina.permanent}) from ${entry.sourceActorName}`);
  } catch (error) {
    console.error(`${MODULE_ID}: logDamageToChat ERROR:`, error);
    console.error(`${MODULE_ID}: Stack trace:`, error.stack);
  }
}

/**
 * Prepare hook payload with all required data for animation modules
 */
async function prepareHookPayload(entry) {
  try {
    // Get source actor and item data
    let sourceActor = null;
    let sourceItem = null;
    let keywords = [];

    if (entry.sourceItemId) {
      // Try to get source actor first
      if (entry.sourceActorId) {
        sourceActor = game.actors.get(entry.sourceActorId);
      }

      // Get source item and extract keywords
      if (sourceActor && entry.sourceItemId) {
        sourceItem = sourceActor.items.get(entry.sourceItemId);
        if (sourceItem?.system?.keywords) {
          keywords = sourceItem.system.keywords;
        }
      }
    } else {
      // Even without sourceItemId, try to get source actor from entry
      if (entry.sourceActorId) {
        sourceActor = game.actors.get(entry.sourceActorId);
      }
    }

    // Get source token data
    const sourceTokenData = sourceActor ? getSourceToken(sourceActor) : null;

    // Get target actor and token data
    const targetActor = game.actors.get(entry.targetActorId);
    const targetTokenData = getTargetToken(entry.targetTokenId);

    // Sanitize damage type - default to 'damage' if empty
    const damageType = entry.damageType || 'damage';

    // Build the hook payload without circular references
    const payload = {
      // Core damage data
      type: entry.type,
      amount: entry.amount,
      damageType: damageType,

      // Source information
      sourceActorId: entry.sourceActorId || null,
      sourceActorUuid: sourceActor?.uuid || null,
      sourceTokenId: sourceTokenData?.id || null,
      sourceTokenUuid: sourceTokenData?.uuid || null,
      sourceItemId: entry.sourceItemId || null,
      sourceItemUuid: sourceItem?.uuid || null,
      sourceItem: sourceItem ? {
        id: sourceItem.id,
        name: sourceItem.name,
        type: sourceItem.type,
        img: sourceItem.img
      } : null,

      // Target information (without circular token reference)
      targetActorId: entry.targetActorId,
      targetActorUuid: targetActor?.uuid || null,
      targetTokenId: targetTokenData?.id || null,
      targetTokenUuid: targetTokenData?.uuid || null,
      targetActor: targetActor ? {
        id: targetActor.id,
        name: targetActor.name,
        type: targetActor.type,
        img: targetActor.img
      } : null,

      // Animation data
      keywords: keywords,

      // Metadata
      eventId: entry.eventId || `damage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: entry.timestamp || Date.now(),
      isCritical: entry.isCritical || false,
      isHealing: entry.type === 'heal',
      isApplied: true
    };

    return payload;
  } catch (error) {
    console.error(`${MODULE_ID}: Error preparing hook payload:`, error);
    return null;
  }
}

/**
 * Get source token from actor with UUID support
 * @param {Actor} actor - The source actor
 * @returns {Object|null} Token object with id and uuid, or null if not found
 */
function getSourceToken(actor) {
  if (!actor) return null;

  const token = actor.getActiveTokens()?.[0] || null;
  if (!token) return null;

  return {
    id: token.id,
    uuid: token.document?.uuid || null,
    token: token
  };
}

/**
 * Get target token from canvas with UUID support
 * @param {string|null} tokenId - The token ID
 * @returns {Object|null} Token object with id and uuid, or null if not found
 */
function getTargetToken(tokenId) {
  if (!tokenId) return null;

  const token = canvas.tokens.get(tokenId) || null;
  if (!token) return null;

  return {
    id: token.id,
    uuid: token.document?.uuid || null,
    token: token
  };
}

/**
 * Handle undo button clicks in chat
 */
Hooks.on('renderChatMessageHTML', (message, html) => {
  if (!(html instanceof HTMLElement)) {
    console.warn(`${MODULE_ID}: html is not an HTMLElement, skipping undo handler`);
    return;
  }

  const undoBtn = html.querySelector('.damage-undo-btn');
  if (!undoBtn) return;

  undoBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const targetTokenId = undoBtn.dataset.targetToken;
    const originalPerm = parseInt(undoBtn.dataset.originalPerm);
    const originalTemp = parseInt(undoBtn.dataset.originalTemp);
    const targetName = undoBtn.dataset.targetName;
    const eventId = undoBtn.dataset.eventId || null;

    if (!game.user.isGM) {
      ui.notifications.error("Only GM can undo damage");
      return;
    }

    const result = await handleGMUndoDamage({
      targetTokenId,
      originalPerm,
      originalTemp,
      targetName,
      messageId: message.id,
      eventId: eventId
    });

    if (result.success) {
      const entry = await message.getFlag(MODULE_ID, 'damageEntry');
      if (entry) {
        const undoTime = new Date().toLocaleTimeString();
        const updatedContent = `
          <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2a9d8f; opacity: 0.6;">
            <div style="margin-bottom: 8px;">
              <strong>✅ UNDONE</strong>
              <span style="font-size: 0.8em; color: #666;">${undoTime}</span>
            </div>
            <div style="margin-bottom: 4px;">
              <strong>${targetName}:</strong> Stamina restored
            </div>
          </div>
        `;
        await message.update({ content: updatedContent });
      }
      ui.notifications.info(`Undo successful - ${targetName} stamina restored`);
    } else {
      ui.notifications.error(`Undo failed: ${result.error}`);
    }
  });
});

/**
 * GM handler: Undo damage/healing
 */
async function handleGMUndoDamage({ targetTokenId, originalPerm, originalTemp, targetName, messageId, eventId }) {
  if (!game.user.isGM) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(targetTokenId);
    if (!token) {
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      return { success: false, error: "Actor not found" };
    }

    console.log(`${MODULE_ID}: GM undoing damage to ${actor.name}, restoring Stamina to Perm=${originalPerm}, Temp=${originalTemp}`);

    const currentStamina = getStaminaSnapshot(actor);
    console.log(`${MODULE_ID}: Current Stamina: Perm=${currentStamina.permanent}, Temp=${currentStamina.temporary}`);

    const boundedStamina = applyStaminaBounds(actor, { permanent: originalPerm, temporary: originalTemp });

    await actor.update({
      'system.stamina.value': boundedStamina.permanent,
      'system.stamina.temporary': boundedStamina.temporary
    });

    // Log undo audit trail
    const undoTime = new Date().toLocaleTimeString();
    const undoMessage = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2a9d8f;">
        <div style="margin-bottom: 4px;">
          <strong>✅ Undo applied:</strong> ${targetName} stamina restored
          (was ${currentStamina.permanent}→${boundedStamina.permanent}) at ${undoTime}
        </div>
      </div>
    `;

    const gmUsers = game.users.filter(u => u.isGM && u.active).map(u => u.id);
    await ChatMessage.create({
      content: undoMessage,
      whisper: gmUsers
    });

    // Store undoTime in damageHistory for tracking
    const historyEntry = damageHistory.find(h => h.messageId === messageId);
    if (historyEntry) {
      historyEntry.undoTime = undoTime;
    }

    // Fire animation undo hook
    if (eventId) {
      try {
        const targetTokenData = getTargetToken(targetTokenId);
        const undoPayload = {
          // Correlation data
          eventId: eventId,

          // Target information
          targetName: targetName,
          targetTokenId: targetTokenData?.id || null,
          targetTokenUuid: targetTokenData?.uuid || null,
          targetToken: targetTokenData?.token || null,

          // Damage data being undone
          amount: Math.abs(boundedStamina.permanent - currentStamina.permanent),
          damageType: historyEntry?.damageType || 'untyped',

          // Original entry
          entry: historyEntry || null
        };

        Hooks.callAll('ds-quick-strike:damageUndone', undoPayload);
        console.log(`${MODULE_ID}: Fired ds-quick-strike:damageUndone hook with eventId: ${eventId}`);
      } catch (hookError) {
        console.error(`${MODULE_ID}: Error firing damageUndone hook:`, hookError);
        // Continue without breaking the undo flow
      }
    }

    return {
      success: true,
      tokenName: actor.name,
      restoredStamina: boundedStamina
    };
  } catch (error) {
    console.error(`${MODULE_ID}: GM undo error:`, error);
    return { success: false, error: error.message };
  }
}
