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
    socket.register('applyStatusToTarget', handleGMApplyStatus);
    socket.register('undoStatusApplication', handleGMUndoStatus);
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

  game.settings.register(MODULE_ID, 'publicStatusLog', {
    name: 'Public Status Log',
    hint: 'Post status applications to public chat (undo buttons remain GM-only)',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  if (game.user.isGM) {
    hookIntoActorDamage();
  }

  const waitForDependencies = () => {
    // Wait for both Draw Steel AND SocketLib to be ready
    if (!globalThis.ds?.rolls?.DamageRoll || !socket) {
      setTimeout(waitForDependencies, 100);
      return;
    }

    console.log(`${MODULE_ID}: Found Draw Steel and SocketLib, installing override`);
    console.log(`${MODULE_ID}: Socket available: ${!!socket}`);
    installDamageOverride();
  };

  waitForDependencies();
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

      // Get source actor name and ID from message speaker
      let sourceActorName = 'Unknown Source';
      let sourceActorId = null;
      let sourceItemName = 'Attack';  // Default to 'Attack' if no item found

      // DEBUG: Log the entire message structure to find where ability name is
      console.log(`${MODULE_ID}: DEBUG - Full message object:`, message);
      console.log(`${MODULE_ID}: DEBUG - message.speaker:`, message.speaker);
      console.log(`${MODULE_ID}: DEBUG - message.flags:`, message.flags);
      console.log(`${MODULE_ID}: DEBUG - message.rolls[${rollIndex}]:`, message.rolls[rollIndex]);
      console.log(`${MODULE_ID}: DEBUG - message.system:`, message.system);
      console.log(`${MODULE_ID}: DEBUG - message.system keys:`, Object.keys(message.system || {}));
      console.log(`${MODULE_ID}: DEBUG - message.flavor:`, message.flavor);
      console.log(`${MODULE_ID}: DEBUG - message.data:`, message.data);
      if (message.system?.ability) {
        console.log(`${MODULE_ID}: DEBUG - message.system.ability:`, message.system.ability);
        console.log(`${MODULE_ID}: DEBUG - ability keys:`, Object.keys(message.system.ability || {}));
      }

      if (message.speaker?.actor) {
        const sourceActor = game.actors.get(message.speaker.actor);
        if (sourceActor) {
          sourceActorName = sourceActor.name;
          sourceActorId = sourceActor.id;

          // Try to get the actual ability/weapon name from the message
          // The message speaker.item might contain the item being used
          if (message.speaker?.item) {
            const sourceItem = sourceActor.items.get(message.speaker.item);
            if (sourceItem) {
              sourceItemName = sourceItem.name;
              console.log(`${MODULE_ID}: Found source item: ${sourceItemName}`);
            }
          } else if (message.system?.uuid) {
            // Draw Steel stores ability UUID in message.system.uuid
            try {
              const sourceItem = await fromUuid(message.system.uuid);
              if (sourceItem) {
                sourceItemName = sourceItem.name;
                console.log(`${MODULE_ID}: Found source item from UUID: ${sourceItemName}`);
              }
            } catch (e) {
              console.warn(`${MODULE_ID}: Could not load item from UUID: ${message.system.uuid}`, e);
            }
          }
        }
      }

      console.log(`${MODULE_ID}: sourceActorName=${sourceActorName}, sourceItemName=${sourceItemName}`);

      // Always use socket handlers for consistent logging
      if (socket) {
        console.log(`${MODULE_ID}: Redirecting to GM via socket (source: ${sourceActorName}, ability: ${sourceItemName})`);
        await applyDamageViaSocket(targets, roll, amount, sourceActorName, sourceActorId, sourceItemName);
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
async function applyDamageViaSocket(targets, roll, amount, sourceActorName, sourceActorId, sourceItemName) {
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
          sourceActorId: sourceActorId,
          sourceItemName: sourceItemName,
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
          sourceActorId: sourceActorId,
          sourceItemName: sourceItemName,
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
async function handleGMDamageApplication({ tokenId, amount, type, ignoredImmunities, sourceActorName, sourceActorId, sourceItemName, sourcePlayerName, sourceItemId, eventId }) {
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
        sourceActorId: sourceActorId || game.user.id, // Use actual source actor ID or fall back to GM user ID
        sourceActorName: sourceActorName,
        sourceItemName: sourceItemName,
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
async function handleGMHealApplication({ tokenId, amount, type, sourceActorName, sourceActorId, sourceItemName, sourcePlayerName, sourceItemId, eventId }) {
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
        sourceActorId: sourceActorId || game.user.id, // Use actual source actor ID or fall back to GM user ID
        sourceActorName: sourceActorName,
        sourceItemName: sourceItemName,
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
 * Log status application to chat (public or private based on setting)
 */
async function logStatusToChat(entry) {
  try {
    console.log(`${MODULE_ID}: logStatusToChat called with:`, entry);

    const icon = entry.type === 'apply' ? '✓' : '✗';
    const sourceLabel = entry.source === 'socket' ? `via ${entry.sourcePlayerName}` : 'direct GM action';

    // Private GM message with undo button
    const privateContent = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'apply' ? '#4CAF50' : '#f44336'};">
        <div style="margin-bottom: 8px;">
          <strong>${icon} ${entry.type === 'apply' ? 'STATUS APPLIED' : 'STATUS REMOVED'}</strong>
          <span style="font-size: 0.8em; color: #aaa;">${sourceLabel}</span>
        </div>
        <div style="margin-bottom: 4px;">
          <strong>${entry.statusName}</strong> applied to <strong>${entry.targetName}</strong>
        </div>
        <div style="margin-bottom: 4px;">
          Source: ${entry.sourceActorName} (${entry.sourceItemName})
        </div>
        ${entry.type === 'apply' ? `
          <div style="margin-top: 8px;">
            <button class="status-undo-btn"
              data-target-token="${entry.targetTokenId}"
              data-target-actor="${entry.targetActorId}"
              data-effect-id="${entry.effectId}"
              data-status-name="${entry.statusName}"
              data-event-id="${entry.eventId}"
              style="background: #f44336; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-weight: bold; font-size: 0.9em;">
              Undo
            </button>
          </div>
        ` : ''}
      </div>
    `;

    const isPublic = game.settings.get(MODULE_ID, 'publicStatusLog') ?? false;

    let message;
    if (isPublic) {
      // Public message (no undo button, no whisper)
      const publicContent = `
        <div style="font-family: monospace; padding: 8px; border-left: 3px solid ${entry.type === 'apply' ? '#4CAF50' : '#f44336'};">
          <div style="margin-bottom: 8px;">
            <strong>${icon} ${entry.type === 'apply' ? 'STATUS APPLIED' : 'STATUS REMOVED'}</strong>
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

    console.log(`${MODULE_ID}: Logged status to chat for ${entry.targetName}`);

  } catch (error) {
    console.error(`${MODULE_ID}: logStatusToChat ERROR`, error);
  }
}

/**
 * Extract ability data from a chat message for status application
 */
async function extractAbilityDataFromMessage(message) {
  try {
    // Try to get the source actor from the message author
    let sourceActorId = null;
    let sourceActor = null;

    if (message.author?.character) {
      sourceActor = message.author.character;
      sourceActorId = sourceActor.id;
    } else if (message.author?.isGM && game.user.character) {
      sourceActor = game.user.character;
      sourceActorId = sourceActor.id;
    }

    // For now, create a minimal ability data structure
    // In a full implementation, this would parse the message content to extract
    // the actual ability data that generated the status buttons
    const abilityData = {
      sourceActorId: sourceActorId,
      itemId: null, // Would be extracted from message in full implementation
      itemName: 'Unknown Ability', // Would be extracted from message
      ability: {
        name: 'Unknown Ability',
        img: 'icons/svg/status.svg',
        system: {
          effects: [] // Would contain the effect definitions
        }
      }
    };

    console.log(`${MODULE_ID}: Extracted ability data:`, abilityData);
    return abilityData;
  } catch (error) {
    console.error(`${MODULE_ID}: Error extracting ability data from message:`, error);
    return null;
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
      sourceItemName: entry.sourceItemName || 'Attack',  // Add source item name with default
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

// Hook status button clicks in chat (Draw Steel status application buttons)
Hooks.on('renderChatMessageHTML', (message, html) => {
  if (!(html instanceof HTMLElement)) {
    console.warn(`${MODULE_ID}: html is not an HTMLElement, skipping status handler`);
    return;
  }

  // DEBUG: Log ALL buttons in the message to see what we're working with
  const allButtons = html.querySelectorAll('button');
  if (allButtons.length > 0) {
    console.log(`${MODULE_ID}: Found ${allButtons.length} total buttons in message`);
    allButtons.forEach((btn, index) => {
      const dataset = {...btn.dataset};
      console.log(`${MODULE_ID}: Button ${index}:`, {
        text: btn.textContent.trim(),
        dataset: dataset,
        className: btn.className
      });
    });
  }

  // Find all status application buttons (data-type="status" from Draw Steel)
  const statusButtons = html.querySelectorAll('button[data-type="status"]');

  if (statusButtons.length > 0) {
    console.log(`${MODULE_ID}: Found ${statusButtons.length} status buttons in message`);
  } else {
    // Try alternative selectors in case Draw Steel uses different attributes
    const altButtons1 = html.querySelectorAll('button[data-effect-id]');
    const altButtons2 = html.querySelectorAll('button[data-status]');
    const altButtons3 = html.querySelectorAll('button[data-uuid]');

    console.log(`${MODULE_ID}: No status buttons found with main selector`);
    console.log(`${MODULE_ID}: Alternative selectors:`, {
      'data-effect-id': altButtons1.length,
      'data-status': altButtons2.length,
      'data-uuid': altButtons3.length
    });
  }

  statusButtons.forEach((btn, index) => {

    btn.addEventListener('click', async (event) => {
      event.preventDefault();

      try {
        console.log(`${MODULE_ID}: ===== STATUS BUTTON CLICKED =====`);

        // Extract status info from button data attributes
        const statusId = btn.dataset.effectId;           // e.g. "slowed"
        const statusUuid = btn.dataset.uuid;             // Actor.xxx.Item.xxx.PowerRollEffect.xxx
        const statusName = btn.textContent.trim();       // e.g. "Slowed"

        console.log(`${MODULE_ID}: Status button clicked: ${statusName}`, { statusId, statusUuid });

        // Get currently selected targets (user must have them selected, just like damage)
        const targets = Array.from(game.user.targets);
        console.log(`${MODULE_ID}: Current targets:`, targets.map(t => `${t.name} (${t.id})`));

        if (!targets.length) {
          console.warn(`${MODULE_ID}: No targets selected`);
          ui.notifications.warn("Select a target to apply status");
          return;
        }

        console.log(`${MODULE_ID}: Applying status ${statusName} to ${targets.length} target(s)`);

        // Check if socket is available
        if (!socket) {
          console.error(`${MODULE_ID}: Socket not available, cannot apply status`);
          ui.notifications.error("Socket not available");
          return;
        }

        // Create minimal ability data for now
        const abilityData = {
          sourceActorId: game.user.character?.id || game.user.id,
          itemId: null,
          itemName: 'Status Effect',
          ability: {
            name: 'Status Effect',
            img: 'icons/svg/status.svg',
            system: {
              effects: [{
                name: statusName,
                id: statusId
              }]
            }
          }
        };

        console.log(`${MODULE_ID}: Using ability data:`, abilityData);

        for (const target of targets) {
          try {
            console.log(`${MODULE_ID}: Applying to target: ${target.name} (${target.id})`);

            const result = await socket.executeAsGM('applyStatusToTarget', {
              tokenId: target.id,
              statusName: statusName,
              statusId: statusId,
              statusUuid: statusUuid,
              sourceActorId: abilityData.sourceActorId,
              sourceItemId: abilityData.itemId,
              sourceItemName: abilityData.itemName,
              sourcePlayerName: game.user.name,
              ability: abilityData.ability,
              timestamp: Date.now()
            });

            console.log(`${MODULE_ID}: Socket result for ${target.name}:`, result);

            if (result.success) {
              ui.notifications.info(`Applied ${statusName} to ${target.name}`);
            } else {
              console.error(`${MODULE_ID}: Failed to apply status:`, result.error);
              ui.notifications.error(`Failed to apply ${statusName}: ${result.error}`);
            }
          } catch (error) {
            console.error(`${MODULE_ID}: Socket error applying status to ${target.name}`, error);
            ui.notifications.error(`Error applying ${statusName} to ${target.name}`);
          }
        }
      } catch (error) {
        console.error(`${MODULE_ID}: Error handling status button click`, error);
        ui.notifications.error("Error applying status");
      }
    });
  });

  // Handle status undo button clicks in chat
  const statusUndoBtn = html.querySelector('.status-undo-btn');
  if (!statusUndoBtn) return;

  statusUndoBtn.addEventListener('click', async (e) => {
    e.preventDefault();

    const tokenId = statusUndoBtn.dataset.targetToken;
    const actorId = statusUndoBtn.dataset.targetActor;
    const effectId = statusUndoBtn.dataset.effectId;
    const statusName = statusUndoBtn.dataset.statusName;
    const eventId = statusUndoBtn.dataset.eventId ?? null;

    if (!game.user.isGM) {
      ui.notifications.error('Only GM can undo status');
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

/**
 * GM handler – Apply a status effect to a target based on ability effect definition
 */
async function handleGMApplyStatus({
  tokenId,
  statusName,
  statusId = null,
  statusUuid = null,
  sourceActorId,
  sourceItemId,
  sourceItemName,
  sourcePlayerName,
  ability = null,
  timestamp,
  eventId = null
}) {
  console.log(`${MODULE_ID}: GM applying status "${statusName}" to token ${tokenId}`);

  if (!game.user.isGM) {
    console.error(`${MODULE_ID}: Not authorized - user is not GM`);
    return { success: false, error: "Unauthorized" };
  }

  try {
    const token = canvas.tokens.get(tokenId);
    if (!token) {
      console.error(`${MODULE_ID}: Token not found: ${tokenId}`);
      return { success: false, error: "Token not found" };
    }

    const actor = token.actor;
    if (!actor) {
      console.error(`${MODULE_ID}: Actor not found for token: ${tokenId}`);
      return { success: false, error: "Actor not found" };
    }

    console.log(`${MODULE_ID}: Applying status "${statusName}" to ${actor.name}`);

    // Build the Active Effect from the ability's effect definition
    let effectData = buildActiveEffectFromAbility(ability, statusName, statusId, statusUuid, sourceActorId, sourceItemId);

    if (!effectData) {
      return { success: false, error: "Could not build effect data" };
    }

    // Create the Active Effect on the target actor
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);

    if (!created.length) {
      return { success: false, error: "Failed to create effect" };
    }

    const effectId = created[0].id;
    console.log(`${MODULE_ID}: Status effect created on ${actor.name}:`, effectId);

    // Generate unique eventId if not provided
    const generatedEventId = eventId || `status-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Log to chat
    try {
      await logStatusToChat({
        type: "apply",
        statusName: statusName,
        statusId: statusId,
        statusUuid: statusUuid,
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
      console.error(`${MODULE_ID}: Error logging status to chat`, logError);
    }

    // Fire hook for animation system
    try {
      Hooks.callAll("ds-quick-strikeStatusApplied", {
        actorId: actor.id,
        tokenId: token.id,
        statusName: statusName,
        statusId: statusId,
        statusUuid: statusUuid,
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
      console.error(`${MODULE_ID}: Error firing ds-quick-strikeStatusApplied hook`, hookError);
    }

    return { success: true, effectId: effectId, statusName: statusName };

  } catch (error) {
    console.error(`${MODULE_ID}: GM apply status error`, error);
    return { success: false, error: error.message };
  }
}

/**
 * GM handler – Undo a status effect application
 */
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

    console.log(`${MODULE_ID}: GM undoing status "${statusName}" on ${actor.name}`);

    // Delete the effect
    const effect = actor.effects.get(effectId);
    if (!effect) {
      return { success: false, error: "Effect not found" };
    }

    await effect.delete();

    // Log undo to chat
    const undoTime = new Date().toLocaleTimeString();
    const undoMessage = `
      <div style="font-family: monospace; padding: 8px; border-left: 3px solid #2196F3; opacity: 0.7;">
        <div style="margin-bottom: 4px;">
          <strong>↶ UNDO</strong> <span style="font-size: 0.8em; color: #666;">${undoTime}</span>
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
      console.error(`${MODULE_ID}: Error firing ds-quick-strikeStatusUndone hook`, hookError);
    }

    return { success: true };

  } catch (error) {
    console.error(`${MODULE_ID}: GM undo status error`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Build Active Effect from ability data
 */
function buildActiveEffectFromAbility(
  ability,
  statusName,
  statusId,
  statusUuid = null,
  sourceActorId,
  sourceItemId
) {
  if (!ability) {
    console.log(`${MODULE_ID}: No ability provided, creating minimal effect for ${statusName}`);
    // Create a minimal effect structure for testing
    const minimalEffect = {
      name: statusName,
      icon: "icons/svg/status.svg",
      origin: `Actor.${sourceActorId}.Item.${sourceItemId}`,
      duration: { rounds: 1, startRound: 0, startTurn: 0 },
      disabled: false,
      flags: {
        ds: {
          statusName: statusName,
          statusId: statusId,
          statusUuid: statusUuid,
          sourceItemId: sourceItemId,
          sourceItemName: 'Status Effect',
          enrich: `@ds/status[${statusName.toLowerCase().replace(/ /g, "-")}]`
        }
      },
      changes: []
    };

    return minimalEffect;
  }

  // Find the effect in the ability's effects array that matches the status name or ID
  const effectDef = ability.system?.effects?.find(e =>
    e.name === statusName || e.id === statusId
  );

  if (!effectDef) {
    console.log(`${MODULE_ID}: Effect "${statusName}" not found in ability, creating minimal effect`);
    // Create a minimal effect structure for testing
    const minimalEffect = {
      name: statusName,
      icon: ability.img || "icons/svg/status.svg",
      origin: `Actor.${sourceActorId}.Item.${sourceItemId}`,
      duration: { rounds: 1, startRound: 0, startTurn: 0 },
      disabled: false,
      flags: {
        ds: {
          statusName: statusName,
          statusId: statusId,
          statusUuid: statusUuid,
          sourceItemId: sourceItemId,
          sourceItemName: ability.name || 'Status Effect',
          enrich: `@ds/status[${statusName.toLowerCase().replace(/ /g, "-")}]`
        }
      },
      changes: []
    };

    return minimalEffect;
  }

  console.log(`${MODULE_ID}: Building effect from definition for ${statusName}`);

  // Determine duration from the effect (Draw Steel uses "save ends" etc.)
  let duration = { rounds: 1, startRound: 0, startTurn: 0 };

  // TODO: Parse Draw Steel effect tier structure to determine correct duration
  // For now, assume single round or use the ability's documented duration

  // Build the Active Effect document
  const effectData = {
    name: statusName,
    icon: ability.img || "icons/svg/status.svg",
    origin: `Actor.${sourceActorId}.Item.${sourceItemId}`,
    duration: duration,
    disabled: false,

    // Use Draw Steel flags for enricher support
    flags: {
      ds: {
        statusName: statusName,
        statusId: statusId,
        statusUuid: statusUuid, // Store the original UUID
        sourceItemId: sourceItemId,
        sourceItemName: ability.name,
        // Store the enricher reference so it renders properly in tooltips
        enrich: `@ds/status[${statusName.toLowerCase().replace(/ /g, "-")}]`
      }
    },

    // You can add changes array if you want to modify actor stats
    // For statuses like "Slowed", you might reduce action economy:
    changes: [
      // Example: slowed reduces actions per turn
      // {
      //   key: "system.combat.actions",
      //   mode: CONST.ACTIVE_EFFECT_MODES.MULTIPLY,
      //   value: 0.5
      // }
    ]
  };

  return effectData;
}
